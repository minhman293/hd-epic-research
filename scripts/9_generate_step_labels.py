#!/usr/bin/env python3
"""
9_generate_step_labels.py

OFFLINE preprocessing: generate a short, diagnostic 1-2 word label for each
recipe step, so the dashboard can show "insert capsule" instead of "S01".

WHY OFFLINE (run once, commit the output):
  - Deterministic demos: the dashboard reads a static JSON, never calls an LLM
    at render time. No latency, no rate limits, no run-to-run drift.
  - Human-reviewable: you eyeball labels before they ship. These labels are
    load-bearing for the "recognize the recipe at a glance" requirement, so a
    human pass is mandatory, especially for the ~52 long multi-clause steps.
  - Cheap iteration: change the prompt, re-run, review the diff.

PIPELINE POSITION:
  complete_recipes.json  --(this script)-->  step_labels.json
  step_labels.json is then read by 2_recipe_selector.py (or 6_prepare_dashboard_data.py)
  and the label rides the existing data pipeline to the frontend.

USAGE:
  # 1. Dry run — see what WOULD be sent, no API calls, uses a heuristic fallback:
  python 9_generate_step_labels.py --recipes complete_recipes.json --dry-run

  # 2. Real run (after setting your API key as an env var):
  python 9_generate_step_labels.py --recipes complete_recipes.json --out step_labels.json

  # 3. Review step_labels.json BY HAND, edit any bad labels directly in the file.

  # 4. Re-running will SKIP steps already present in step_labels.json unless
  #    --overwrite is passed, so your hand edits are preserved.

OUTPUT FORMAT (step_labels.json):
  {
    "P01_R01_S01": {"label": "insert capsule", "source": "llm", "raw": "Put one capsule into the coffee machine."},
    "P01_R01_S02": {"label": "press button",   "source": "llm", "raw": "Press the long coffee button"},
    ...
  }
  - "source" is "llm", "heuristic", or "human" so you can track provenance.
  - "raw" is kept so a reviewer can compare label against original without
    opening the recipes file.

CHOOSING YOUR PROVIDER:
  Implement ONE function: call_llm(prompt) -> str. Two stubs are provided below
  (Anthropic and a generic HTTP example). Pick one, fill in the key handling,
  delete the other. Do NOT hardcode API keys — read from an environment variable.
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path


# ---------------------------------------------------------------------------
# The prompt. This is the most important part to get right.
# ---------------------------------------------------------------------------

SYSTEM_INSTRUCTION = """You label cooking recipe steps for a visualization. \
Given the full text of one recipe step, output a SHORT label of 1-3 words that \
captures the single most DIAGNOSTIC action of that step — the action that would \
let someone recognize which recipe this is, distinct from generic actions like \
"take", "put", "open", "close" that occur in every recipe.

Rules:
- 1 to 3 words, lowercase, no punctuation.
- Prefer a verb + key noun ("toast pepper", "froth milk", "knead dough").
- If the step is a single simple action, just shorten it ("Stir" -> "stir").
- Choose the DISTINCTIVE action, not the most time-consuming setup. For a step
  about toasting peppercorns in butter, "toast pepper" beats "melt butter".
- Output ONLY the label. No quotes, no explanation, no trailing period."""

PROMPT_TEMPLATE = """Recipe: {recipe_name}
Step text: {step_text}

Label:"""


# ---------------------------------------------------------------------------
# Provider injection point. Implement exactly ONE of these.
# ---------------------------------------------------------------------------

# Which Gemini model to use. Flash-Lite is the cheapest/fastest and is plenty
# for 1-3 word labels. Override with the --model flag if you like.
GEMINI_MODEL = "gemini-2.5-flash-lite"


def load_env(env_path=".env"):
    """
    Minimal .env loader so GEMINI_API_KEY is available without extra packages.
    Reads KEY=VALUE lines into os.environ (does not overwrite existing vars).
    If python-dotenv is installed you could use that instead, but this keeps
    the script dependency-light.
    """
    p = Path(env_path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


def call_llm(prompt: str) -> str:
    """
    Call Gemini's generateContent endpoint and return the raw text label.
    Reads GEMINI_API_KEY from the environment (loaded from .env by load_env()).
    """
    import requests  # pip install requests

    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError(
            "GEMINI_API_KEY not set. Put it in a .env file next to this script "
            "as GEMINI_API_KEY=your_key, or export it in your shell."
        )

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent"
    )
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": key,  # key in header, not URL — keeps it out of logs
    }
    body = {
        "system_instruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.0,      # deterministic — same step always same label
            "maxOutputTokens": 20,   # labels are tiny
        },
    }

    r = requests.post(url, headers=headers, json=body, timeout=30)
    r.raise_for_status()
    data = r.json()

    # Defensive extraction: candidates[0].content.parts[0].text
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as exc:
        raise RuntimeError(f"Unexpected Gemini response shape: {data}") from exc


# ---------------------------------------------------------------------------
# Heuristic fallback (used in --dry-run, or when --use-heuristic is passed).
# Not as good as the LLM, but lets you test the whole pipeline with zero API cost.
# ---------------------------------------------------------------------------

# Generic verbs that DON'T help recognize a recipe — deprioritize these.
GENERIC_VERBS = {
    "take", "put", "place", "add", "get", "grab", "hold", "move", "open",
    "close", "set", "leave", "continue", "start", "make", "use", "keep",
}


def heuristic_label(step_text: str) -> str:
    """Cheap fallback: grab the first informative verb + following noun-ish word."""
    words = re.findall(r"[a-zA-Z]+", step_text.lower())
    if not words:
        return "step"
    # find first non-generic verb-like word
    for i, w in enumerate(words):
        if w not in GENERIC_VERBS and len(w) > 2:
            # take this word plus the next informative word as the noun
            label = [w]
            for nxt in words[i + 1:]:
                if len(nxt) > 2 and nxt not in {"the", "and", "with", "into", "your", "until", "over"}:
                    label.append(nxt)
                    break
            return " ".join(label)
    # everything was generic — just return first two words
    return " ".join(words[:2])


# ---------------------------------------------------------------------------
# Label cleanup — enforce the format rules regardless of provider.
# ---------------------------------------------------------------------------

def clean_label(raw: str) -> str:
    """Enforce: lowercase, no punctuation, max 3 words."""
    s = raw.strip().lower()
    s = re.sub(r"[^a-z0-9 ]+", "", s)        # strip punctuation/quotes
    s = re.sub(r"\s+", " ", s).strip()
    words = s.split()
    return " ".join(words[:3]) if words else "step"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global GEMINI_MODEL
    ap = argparse.ArgumentParser(
        description="Generate short diagnostic labels for recipe steps (offline).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("--recipes", type=Path, required=True,
                    help="Path to complete_recipes.json")
    ap.add_argument("--out", type=Path, default=Path("step_labels.json"),
                    help="Output path (default: step_labels.json)")
    ap.add_argument("--dry-run", action="store_true",
                    help="No API calls; use heuristic fallback. For testing the pipeline.")
    ap.add_argument("--use-heuristic", action="store_true",
                    help="Force heuristic even outside dry-run (no API cost).")
    ap.add_argument("--overwrite", action="store_true",
                    help="Re-label steps already in the output file (default: skip them, "
                         "preserving any human edits).")
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="Seconds to sleep between API calls (rate-limit politeness).")
    ap.add_argument("--model", type=str, default=None,
                    help=f"Gemini model id (default: {GEMINI_MODEL})")
    ap.add_argument("--env", type=Path, default=Path(".env"),
                    help="Path to .env file holding GEMINI_API_KEY (default: ./.env)")
    args = ap.parse_args()

    # Load GEMINI_API_KEY from .env so call_llm() can read it.
    load_env(args.env)
    if args.model:
        GEMINI_MODEL = args.model

    if not args.recipes.exists():
        print(f"ERROR: {args.recipes} not found", file=sys.stderr)
        sys.exit(1)

    with open(args.recipes) as f:
        recipes = json.load(f)

    # Load existing labels so we can skip / preserve human edits.
    existing = {}
    if args.out.exists():
        # Read defensively in case an earlier run (or a hand edit on Windows)
        # wrote the file as cp1252 rather than UTF-8.
        for enc in ("utf-8", "utf-8-sig", "cp1252"):
            try:
                with open(args.out, encoding=enc) as f:
                    existing = json.load(f)
                break
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
        print(f"Loaded {len(existing)} existing labels from {args.out}")

    results = dict(existing)
    use_heuristic = args.dry_run or args.use_heuristic
    n_new = n_skip = 0

    for rid, r in recipes.items():
        recipe_name = r.get("name", rid)
        for sid, step_text in r.get("steps", {}).items():
            # skip already-labeled unless overwriting; never clobber human edits
            if sid in results and not args.overwrite:
                if results[sid].get("source") == "human":
                    n_skip += 1
                    continue
                if not args.overwrite:
                    n_skip += 1
                    continue

            if use_heuristic:
                label = clean_label(heuristic_label(step_text))
                source = "heuristic"
            else:
                prompt = PROMPT_TEMPLATE.format(recipe_name=recipe_name, step_text=step_text)
                try:
                    label = clean_label(call_llm(prompt))
                    source = "llm"
                    time.sleep(args.sleep)
                except Exception as exc:
                    print(f"  [warn] LLM failed for {sid}: {exc} — using heuristic", file=sys.stderr)
                    label = clean_label(heuristic_label(step_text))
                    source = "heuristic"

            results[sid] = {"label": label, "source": source, "raw": step_text}
            n_new += 1
            print(f"  {sid:16s} [{source:9s}] {label:20s}  <- {step_text[:50]}")

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    print(f"\nDone. {n_new} labeled, {n_skip} skipped. Wrote {len(results)} labels to {args.out}")
    if use_heuristic:
        print("NOTE: heuristic labels are placeholders. Re-run without --dry-run "
              "(and with call_llm implemented) for real labels.")
    print("NEXT: open step_labels.json, review every label, fix bad ones by hand, "
          "and set their \"source\" to \"human\" so future runs preserve them.")


if __name__ == "__main__":
    main()