"""
run_agent.py — put the blind sheet in front of an agent, then propose codes.

WHY A SEPARATE SCRIPT
--------------------------------------------------------------------------------
`readability_test.py make` produces blind prompts. Something has to answer them,
and then something has to turn free text into one of four codes. Doing the
coding by hand for 96 items would take longer than the rest of the day, and
doing it by eye invites the experimenter to see what they hope to see — the
grader knows the hypothesis.

So this script does three things, in order of decreasing trust:

    ask     send each blind prompt to a model, save the raw answers
    code    propose an outcome by string-matching the answer against the
            HIDDEN label and the other members' verbs and nouns
    subset  cut a balanced human sheet, because 96 items is too many to
            hand a labmate

The proposed codes are a draft, not a result. Spot-check at least 20 by hand
before scoring — the auto-coder matches words, and a reader who writes "make the
coffee" for a `press(appliances)` node is right in a way no string match will
see. The `--review` flag prints the ones it is least sure about first.

WHAT THE CODER CAN AND CANNOT DO
--------------------------------------------------------------------------------
It can tell "did they name the head, or a different member". That is the
distinction the result rests on, and it is mechanical. It cannot judge whether a
paraphrase is fair. Every proposed code is written with the evidence beside it
so a human can overturn it in one glance.

WHICH PROVIDER
--------------------------------------------------------------------------------
Anthropic's API is pay-as-you-go; there is no free tier. Google AI Studio has a
free tier covering the Gemini Flash models, which is more than enough for a run
of this size, so `--provider gemini` is the default.

One research caveat: Google's free tier permits prompts to be used for model
training (the paid tier and Vertex AI do not). HD-EPIC labels are public, so
this is normally fine — but do not send an unpublished dataset through a free
tier without asking first.

Free-tier limits are a few requests per minute, so `--rpm` throttles the loop.
Answers are appended to disk as they arrive and the run resumes where it left
off, which matters when a 96-item run takes ten minutes and a 429 can land
anywhere in it.

USAGE
--------------------------------------------------------------------------------
    $env:GEMINI_API_KEY="..."              # from aistudio.google.com/apikey
    python run_agent.py ask
    python run_agent.py code --review 20
    python readability_test.py score

    python run_agent.py ask --provider anthropic   # $env:ANTHROPIC_API_KEY
    python run_agent.py subset --n 18              # sheet for a labmate
    python run_agent.py ask --dry-run              # no API: paste-in file
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
GEMINI_URL = ("https://generativelanguage.googleapis.com/v1beta/"
              "models/{model}:generateContent")

PROVIDERS = {
    # name        env var              default model        free?   safe rpm
    "gemini":    ("GEMINI_API_KEY",    "gemini-2.5-flash",  True,   10),
    "anthropic": ("ANTHROPIC_API_KEY", "claude-sonnet-4-6", False,  50),
}

SYSTEM = (
    "You are reading a list of short kitchen actions and inferring the task. "
    "Answer in exactly three lines:\n"
    "GOAL: <a few words>\n"
    "COMMAND: <one robot command>\n"
    "COHERENT: <yes or no>\n"
    "Say COHERENT: no if the actions do not form one task."
)


def _read_jsonl(p):
    return [json.loads(l) for l in Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]


# ─────────────────────────────────────────────────────────────────────────────
# ask
# ─────────────────────────────────────────────────────────────────────────────

def _build_request(provider, model, prompt, key):
    """One request object per provider. Same prompt, same system message."""
    if provider == "anthropic":
        body = json.dumps({
            "model": model, "max_tokens": 200, "system": SYSTEM,
            "messages": [{"role": "user", "content": prompt}],
        }).encode("utf-8")
        return urllib.request.Request(
            ANTHROPIC_URL, data=body, method="POST", headers={
                "content-type": "application/json",
                "x-api-key": key,
                "anthropic-version": "2023-06-01"})

    body = json.dumps({
        "system_instruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": 300, "temperature": 0},
    }).encode("utf-8")
    return urllib.request.Request(
        GEMINI_URL.format(model=model), data=body, method="POST", headers={
            "content-type": "application/json",
            "x-goog-api-key": key})


def _extract(provider, d):
    if provider == "anthropic":
        return "\n".join(b.get("text", "") for b in d.get("content", [])
                         if b.get("type") == "text").strip()
    cands = d.get("candidates") or []
    if not cands:
        return ""
    parts = (cands[0].get("content") or {}).get("parts") or []
    return "\n".join(p.get("text", "") for p in parts).strip()


def call_model(prompt, key, provider, model, retries=4):
    """Exponential backoff on 429/503. Free tiers return 429 routinely, so a
    retry loop is not optional here — it is the normal path."""
    for attempt in range(retries):
        try:
            req = _build_request(provider, model, prompt, key)
            with urllib.request.urlopen(req, timeout=90) as r:
                d = json.loads(r.read().decode("utf-8"))
            return _extract(provider, d)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:200]
            except Exception:
                pass
            if e.code in (429, 500, 503, 529) and attempt < retries - 1:
                wait = 2 ** attempt * 5
                print(f"    HTTP {e.code}, waiting {wait}s  {detail[:100]}")
                time.sleep(wait)
                continue
            raise SystemExit(f"HTTP {e.code} from {provider}: {detail}")
        except urllib.error.URLError as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt * 5)
                continue
            raise SystemExit(f"network error: {e}")
    return ""


def ask(a):
    out = Path(a.out_dir)
    prompts = _read_jsonl(out / "readability_prompts.jsonl")

    if a.dry_run:
        txt = ["Paste this into any chat model. Answer every item in the format:",
               "  <ITEM_ID>  GOAL: ...  COMMAND: ...  COHERENT: yes/no", ""]
        for p in prompts:
            txt.append(f"===== {p['item_id']} =====")
            txt.append(p["prompt"])
            txt.append("")
        (out / "readability_paste.txt").write_text("\n".join(txt), encoding="utf-8")
        print(f"✓ {out/'readability_paste.txt'} — no API call made")
        return

    env, default_model, is_free, safe_rpm = PROVIDERS[a.provider]
    model = a.model or default_model
    key = os.environ.get(env)
    if not key:
        print(f"{env} is not set. Either set it, or run with --dry-run and "
              f"paste the file into a chat window.", file=sys.stderr)
        if a.provider == "gemini":
            print("Free key: https://aistudio.google.com/apikey", file=sys.stderr)
        sys.exit(1)

    rpm = a.rpm or safe_rpm
    gap = 60.0 / max(1, rpm)
    print(f"provider {a.provider}  model {model}  "
          f"{'free tier' if is_free else 'paid'}  throttled to {rpm} rpm")

    done = {}
    raw_path = out / "readability_raw.jsonl"
    if raw_path.exists() and not a.overwrite:
        done = {r["item_id"]: r for r in _read_jsonl(raw_path)}
        print(f"resuming — {len(done)} already answered")

    with open(raw_path, "a", encoding="utf-8") as f:
        for i, p in enumerate(prompts, 1):
            if p["item_id"] in done:
                continue
            t0 = time.time()
            ans = call_model(p["prompt"], key, a.provider, model)
            f.write(json.dumps({"item_id": p["item_id"], "model": model,
                                "answer": ans}) + "\n")
            f.flush()
            print(f"  [{i}/{len(prompts)}] {p['item_id']}  "
                  f"{ans.splitlines()[0][:60] if ans else '(empty)'}")
            slept = time.time() - t0
            if slept < gap and i < len(prompts):
                time.sleep(gap - slept)
    print(f"✓ {raw_path}")


# ─────────────────────────────────────────────────────────────────────────────
# code
# ─────────────────────────────────────────────────────────────────────────────

def _words(s):
    return set(re.findall(r"[a-z]+", (s or "").lower()))


def _parts(action):
    """`press(appliances)` -> ({'press'}, {'appliances'})"""
    m = re.match(r"\s*([^(]+)\(([^)]*)\)", action or "")
    if not m:
        return _words(action), set()
    return _words(m.group(1)), _words(m.group(2))


def propose(item, answer):
    """Return (code, confidence, evidence)."""
    goal = ""
    for line in (answer or "").splitlines():
        if line.upper().startswith("GOAL:"):
            goal = line.split(":", 1)[1]
    if not goal:
        goal = answer or ""
    said_incoherent = bool(re.search(r"COHERENT:\s*no|NOT_COHERENT",
                                     (answer or ""), re.I))
    w = _words(goal)

    if not w:
        return "UNSURE", "high", "no answer"
    if said_incoherent:
        return "NOT_COHERENT", "high", "reader said the actions do not fit together"

    head = item.get("head_action") or item.get("label") or ""
    hv, hn = _parts(head)
    hit_head = bool(w & hv), bool(w & hn)

    others_v, others_n = set(), set()
    for act in item.get("actions", []):
        v, n = _parts(act)
        others_v |= v
        others_n |= n
    others_v -= hv
    others_n -= hn
    hit_other = bool(w & others_v)

    if hit_head[0]:
        return ("MATCH_HEAD", "high" if hit_head[1] else "medium",
                f"goal contains the head verb from `{head}`")
    if hit_other:
        return ("OTHER_MEMBER", "medium",
                f"goal contains a member verb but not the head verb of `{head}`")
    if hit_head[1]:
        return ("MATCH_HEAD", "low",
                f"goal matches the head object only, not the verb — check this one")
    return ("UNSURE", "low",
            "no word overlap with any member; a fair paraphrase would look like "
            "this too, so read it")


def code(a):
    out = Path(a.out_dir)
    key = json.loads((out / "readability_items.json").read_text(encoding="utf-8"))
    items = {i["item_id"]: i for i in key["items"]}
    raw = {r["item_id"]: r["answer"] for r in _read_jsonl(out / "readability_raw.jsonl")}

    rows, low = [], []
    for iid, it in items.items():
        ans = raw.get(iid, "")
        c, conf, why = propose(it, ans)
        rows.append({"item_id": iid, "outcome": c,
                     "answer": (ans or "").replace("\n", " | ")[:300]})
        if conf != "high":
            low.append((conf, iid, it, ans, c, why))

    with open(out / "readability_answers.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["item_id", "outcome", "answer"])
        w.writeheader()
        w.writerows(rows)

    dist = defaultdict(int)
    for r in rows:
        dist[r["outcome"]] += 1
    print("proposed: " + ", ".join(f"{k} {v}" for k, v in sorted(dist.items())))
    print(f"✓ {out/'readability_answers.csv'} — these are DRAFT codes\n")

    order = {"low": 0, "medium": 1}
    low.sort(key=lambda t: order[t[0]])
    n = min(a.review, len(low))
    if n:
        print(f"Check these {n} by hand before scoring "
              f"({len(low)} were not high-confidence):\n")
        for conf, iid, it, ans, c, why in low[:n]:
            print(f"  {iid}  [{conf}]  proposed {c}")
            print(f"    hidden label : {it.get('label') or '(level 1, no label)'}")
            print(f"    actions      : {', '.join(it['actions'][:8])}")
            print(f"    answer       : {(ans or '').splitlines()[0][:80] if ans else '(empty)'}")
            print(f"    why          : {why}\n")


# ─────────────────────────────────────────────────────────────────────────────
# subset
# ─────────────────────────────────────────────────────────────────────────────

def subset(a):
    """A balanced sheet a person will actually finish."""
    out = Path(a.out_dir)
    key = json.loads((out / "readability_items.json").read_text(encoding="utf-8"))
    items = key["items"]

    by_level = defaultdict(list)
    for it in items:
        by_level[it["level"]].append(it)
    per = max(1, a.n // max(1, len(by_level)))

    picked = []
    for lvl, group in by_level.items():
        picked += group[:per]
    picked = picked[:a.n]

    md = ["# Blind naming test (short form)\n",
          f"{len(picked)} items, about 15 minutes. For each one:\n",
          "1. What is the person trying to do? A few words.\n",
          "2. What single command would you send a robot?\n",
          "3. If the actions do not belong together, write NOT_COHERENT.\n",
          "\nPlease also say afterwards: was the graph readable? What confused you?\n"]
    for it in picked:
        md.append(f"\n---\n\n### {it['item_id']}\n")
        for k, act in enumerate(it["actions"], 1):
            md.append(f"{k}. {act}")
        md.append("\n**Goal:** ______   **Command:** ______\n")
    (out / "readability_sheet_human.md").write_text("\n".join(md) + "\n",
                                                    encoding="utf-8")
    print(f"✓ {out/'readability_sheet_human.md'} — {len(picked)} items, "
          f"{per} per level")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ask")
    p.add_argument("--out-dir", default="../outputs")
    p.add_argument("--provider", choices=list(PROVIDERS), default="gemini")
    p.add_argument("--model", default=None,
                   help="override the provider default, e.g. gemini-2.5-flash-lite")
    p.add_argument("--rpm", type=int, default=None,
                   help="requests per minute; defaults to a safe free-tier rate")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--overwrite", action="store_true")
    p.set_defaults(fn=ask)

    p = sub.add_parser("code")
    p.add_argument("--out-dir", default="../outputs")
    p.add_argument("--review", type=int, default=20)
    p.set_defaults(fn=code)

    p = sub.add_parser("subset")
    p.add_argument("--out-dir", default="../outputs")
    p.add_argument("--n", type=int, default=18)
    p.set_defaults(fn=subset)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()