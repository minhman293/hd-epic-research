"""
readability_test.py — can an agent read a node and know what to do?

WHAT THIS ANSWERS
--------------------------------------------------------------------------------
Prof. Lin asked whether the extracted sequences are meaningful to a robot, and
Part 6 proposed a blind naming test. They are the same experiment, so this runs
it once for both audiences: an LLM agent and a human labmate see exactly the
same sheet.

The ablation established that episodes are *stable enough to be measured* but
not repeatable enough to call skills. It did not establish whether a reader can
tell what an episode is FOR. That is what this measures, and it is the question
that decides whether Level 3 is usable as a planning vocabulary at all.

THE DESIGN
--------------------------------------------------------------------------------
Each item shows the ordered raw actions of one node with the LABEL HIDDEN, and
asks two questions:

    1. What is the person trying to do? (a short goal phrase)
    2. What single command would you send a robot?

The second question matters more than it looks. A reader can often describe a
group of actions loosely while being unable to turn it into one instruction. If
question 1 is easy and question 2 is hard, the node is a description, not a
skill — which is the distinction the whole layer rests on.

Answers are then coded into four outcomes, and each carries a different repair:

    MATCH_HEAD      names the head action  -> the label is right
    OTHER_MEMBER    names a different member -> the HEAD CHOICE is wrong
                    (expected often: head-is-modal is only 0.26-0.38)
    NOT_COHERENT    "these do not belong together" -> the GROUPING is wrong
    UNSURE          cannot tell -> the node is unreadable either way

THREE LEVELS, NOT ONE
--------------------------------------------------------------------------------
The same 20 spans are shown at Level 1 (raw actions), Level 3 (episodes) and
Level 4 (recipe steps). Level 4 is the upper bound — a human wrote those names —
and Level 1 is the floor. Level 3 has to land between them, and where it lands
is the result. Testing Level 3 alone would produce a number with nothing to
compare it against.

Items are SHUFFLED and the level is not shown, so a grader cannot score the
level rather than the item.

USAGE
--------------------------------------------------------------------------------
    python readability_test.py make P01_R01 P03_R03 P05_R02 --n 20
        -> outputs/readability_items.json   (with the answer key)
        -> outputs/readability_sheet.md     (blind, give this to a human)
        -> outputs/readability_prompts.jsonl(blind, one prompt per line)

    ...collect answers into outputs/readability_answers.csv with columns
       item_id,outcome,answer     outcome in MATCH_HEAD/OTHER_MEMBER/
                                  NOT_COHERENT/UNSURE

    python readability_test.py score
        -> outputs/readability_result.md
"""

import argparse
import csv
import json
import random
from collections import Counter, defaultdict
from pathlib import Path

OUTCOMES = ["MATCH_HEAD", "OTHER_MEMBER", "NOT_COHERENT", "UNSURE"]

QUESTION = (
    "Below is a list of short actions a person performed in a kitchen, in order.\n"
    "1. What is the person trying to do? Answer in a few words.\n"
    "2. What single command would you send a robot to achieve it?\n"
    "3. If the actions do not belong together as one task, say NOT_COHERENT.\n"
)


def _load(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Item collection
#
# Level 3 and Level 4 items come from the `expansions` block the pipeline
# already writes: for every label, the raw actions of each occurrence. Level 1
# items are windows of consecutive raw actions with no grouping at all.
# ─────────────────────────────────────────────────────────────────────────────

def items_from_expansions(payload, recipe, level, rng, n):
    exp = (payload or {}).get("expansions") or {}
    pool = []
    for label, blk in exp.items():
        for occ in blk.get("occurrences", []):
            acts = occ.get("actions") or []
            if len(acts) < 2:            # a single action needs no reading
                continue
            pool.append({
                "recipe": recipe, "level": level, "label": label,
                "head_action": blk.get("head_action"),
                "synthetic": bool(blk.get("synthetic")),
                "actions": acts, "n_actions": len(acts),
                "session": occ.get("session"), "start": occ.get("start"),
                "video_id": occ.get("video_id"),
            })
    rng.shuffle(pool)
    return pool[:n]


def _task_span(actions, payload):
    marks = [(a["start"], a["end"]) for a in actions if a.get("step_id")]
    marks += [(w["start"], w["end"]) for w in (payload.get("step_windows") or [])]
    if not marks:
        return actions
    lo, hi = min(m[0] for m in marks), max(m[1] for m in marks)
    return [a for a in actions if a["end"] >= lo and a["start"] <= hi]


def items_from_raw(rdir, recipe, rng, n, window=6, mode="full"):
    """A window of consecutive actions with no grouping applied.

    Used for BOTH Level 1 (`mode="full"`, raw verb+object) and Level 2
    (`mode="hybrid"`, verb + object category). Levels 1 and 2 have no episode
    structure - a node there is a single action - so the blind NAMING test does
    not apply to them. What does apply is the same question asked of episodes:
    given this run of actions, can a reader state the goal and issue one
    command? Windowing both layers the same way makes all four levels
    comparable on one scale.

    Level 2 matters more than it looks. It is better estimated than Level 3
    (9-21 observations per state against 3-4), so if an agent can already act
    on Level 2 labels, the episode layer's contribution is plan length and goal
    structure, not readability. That is a finding either way, and it is the one
    gap the study has not closed.

    BUGFIX. This used to draw from the whole recording. Episode and step items
    come from `expansions`, which the pipeline builds INSIDE the task span, so
    Level 1 was being sampled from a wider pool that includes activity before
    and after the recipe - washing up, eating a banana, tidying. Those windows
    genuinely have no shared goal, so the floor was pushed down by the sampling
    rather than by the absence of grouping, and every level above it looked
    better than it is. All three levels must be drawn from the same span.
    """
    out = []
    for f in sorted(rdir.glob(f"session_*_{mode}.json")):
        d = _load(f)
        if not d:
            continue
        acts = [a for a in d.get("sequence", [])
                if a.get("kind", "action") == "action" and a.get("action")
                and a.get("start") is not None]
        acts = _task_span(acts, d)
        for i in range(0, max(0, len(acts) - window), window):
            chunk = acts[i:i + window]
            out.append({
                "recipe": recipe, "level": mode, "label": None,
                "head_action": None, "synthetic": False,
                "actions": [a["action"] for a in chunk],
                "n_actions": len(chunk),
                "session": int(f.stem.split("_")[1]),
                "start": chunk[0].get("start"), "video_id": chunk[0].get("video_id"),
            })
    rng.shuffle(out)
    return out[:n]


def make(a):
    rng = random.Random(a.seed)
    items = []
    for rid in a.recipe_ids:
        rdir = Path(a.graphs_dir) / rid
        items += items_from_expansions(_load(rdir / "merged_episode.json"),
                                       rid, "episode", rng, a.n)
        items += items_from_expansions(_load(rdir / "merged_step.json"),
                                       rid, "step", rng, max(3, a.n // 3))
        items += items_from_raw(rdir, rid, rng, max(3, a.n // 3), mode="full")
        items += items_from_raw(rdir, rid, rng, max(3, a.n // 3), mode="hybrid")

    rng.shuffle(items)
    for i, it in enumerate(items, 1):
        it["item_id"] = f"I{i:03d}"

    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    # answer key — never show this to a grader
    (out / "readability_items.json").write_text(
        json.dumps({"seed": a.seed, "items": items}, indent=1), encoding="utf-8")

    # blind sheet for a human
    md = ["# Blind naming test\n",
          "For each item, answer the three questions. Do not look at "
          "`readability_items.json` — it holds the answers.\n", QUESTION]
    for it in items:
        md.append(f"\n---\n\n### {it['item_id']}\n")
        for k, act in enumerate(it["actions"], 1):
            md.append(f"{k}. {act}")
        md.append("\n**Goal:** ______   **Robot command:** ______\n")
    (out / "readability_sheet.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    # blind prompts for a model
    with open(out / "readability_prompts.jsonl", "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps({
                "item_id": it["item_id"],
                "prompt": QUESTION + "\nActions:\n" +
                          "\n".join(f"{k}. {x}" for k, x in enumerate(it["actions"], 1)),
            }) + "\n")

    # empty answer sheet, so the columns are never guessed
    with open(out / "readability_answers.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["item_id", "outcome", "answer"])
        for it in items:
            w.writerow([it["item_id"], "", ""])

    by = Counter(i["level"] for i in items)
    print(f"{len(items)} items — " + ", ".join(f"{k}:{v}" for k, v in by.items()))
    print(f"✓ {out/'readability_items.json'}   (answer key — keep closed)")
    print(f"✓ {out/'readability_sheet.md'}     (give to a labmate)")
    print(f"✓ {out/'readability_prompts.jsonl'}(feed to an agent)")
    print(f"✓ {out/'readability_answers.csv'}  (fill in the outcome column)")
    print(f"\nOutcome codes: {', '.join(OUTCOMES)}")


# ─────────────────────────────────────────────────────────────────────────────
# Scoring
# ─────────────────────────────────────────────────────────────────────────────

def score(a):
    out = Path(a.out_dir)
    key = _load(out / "readability_items.json")
    if not key:
        raise SystemExit("run `make` first")
    items = {i["item_id"]: i for i in key["items"]}

    rows = []
    with open(out / "readability_answers.csv", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if (r.get("outcome") or "").strip():
                rows.append(r)
    if not rows:
        raise SystemExit("readability_answers.csv has no filled outcomes yet")

    bad = {r["outcome"] for r in rows} - set(OUTCOMES)
    if bad:
        raise SystemExit(f"unknown outcome code(s): {sorted(bad)}")

    by_level = defaultdict(Counter)
    by_synth = defaultdict(Counter)
    by_size = defaultdict(Counter)
    one_task = defaultdict(Counter)
    SIZES = [(1, 4, "1-4 actions"), (5, 8, "5-8 actions"), (9, 999, "9+ actions")]
    for r in rows:
        it = items.get(r["item_id"])
        if not it:
            continue
        by_level[it["level"]][r["outcome"]] += 1
        if r.get("one_task"):
            one_task[it["level"]][r["one_task"]] += 1
        if it["level"] == "episode":
            by_synth["synthetic" if it["synthetic"] else "real anchor"][r["outcome"]] += 1
            for lo, hi, lab in SIZES:
                if lo <= it["n_actions"] <= hi:
                    by_size[lab][r["outcome"]] += 1

    def table(d, title, first_col):
        L = [f"\n## {title}\n",
             f"| {first_col} | n | readable | head wrong | not coherent | unsure |",
             "|---|---|---|---|---|---|"]
        for k, c in d.items():
            n = sum(c.values())
            if not n:
                continue
            L.append(f"| {k} | {n} | "
                     f"{c['MATCH_HEAD']/n:.0%} | {c['OTHER_MEMBER']/n:.0%} | "
                     f"{c['NOT_COHERENT']/n:.0%} | {c['UNSURE']/n:.0%} |")
        return L

    md = ["# Readability result\n",
          "`readable` = the reader named the same goal the label names. "
          "`head wrong` = they named a different action in the group, so the "
          "grouping held but the name did not. `not coherent` = the grouping "
          "itself failed.\n"]
    md += table(by_level, "By level", "level")
    md += table(by_synth, "Episodes: synthetic vs real anchors", "anchor type")
    md += table(by_size, "Episodes by size", "size")

    # The second dimension: did the reader think it was ONE task at all?
    # Kept separate from the naming code on purpose - an episode can be named
    # correctly and still visibly contain two tasks, which is what interleaving
    # looks like from inside a single action stream.
    if one_task:
        md.append("\n## Judged to be a single task\n")
        md.append("| level | n | one task | two or more |")
        md.append("|---|---|---|---|")
        for lvl, c in one_task.items():
            n = sum(c.values())
            md.append(f"| {lvl} | {n} | {c.get('yes',0)/n:.0%} | "
                      f"{(n-c.get('yes',0))/n:.0%} |")
        md.append("\nA low share here is not necessarily a segmentation "
                  "failure: HD-EPIC annotates side tasks performed during the "
                  "recipe, so an episode can correctly contain more than one "
                  "activity.")

    # How often does one answer serve many different nodes? An answer repeated
    # across several distinct labels is naming the RECIPE, not the state. A
    # planner handed the same phrase for seven states cannot choose between
    # them, so this is a readability failure even when every answer is "right".
    goals = defaultdict(set)
    for r in rows:
        it = items.get(r["item_id"])
        if it and it["level"] == "episode" and r.get("goal"):
            goals[r["goal"].strip().lower()].add(it.get("label"))
    shared = {g: labs for g, labs in goals.items() if len(labs) > 1}
    if shared:
        n_ep = sum(1 for r in rows
                   if items.get(r["item_id"], {}).get("level") == "episode")
        covered = sum(1 for r in rows
                      if items.get(r["item_id"], {}).get("level") == "episode"
                      and r.get("goal", "").strip().lower() in shared)
        md.append("\n## Answers that do not distinguish one node from another\n")
        md.append(f"{covered} of {n_ep} episode answers ({covered/n_ep:.0%}) "
                  f"used a phrase that also described a different node.\n")
        md.append("| answer | distinct labels it was given for |")
        md.append("|---|---|")
        for g, labs in sorted(shared.items(), key=lambda kv: -len(kv[1]))[:6]:
            md.append(f"| \"{g}\" | {len(labs)} — {', '.join(sorted(labs)[:5])} |")
        md.append("\nAn executing agent cannot act on a name shared by several "
                  "states. This is the concrete form of Part 7's first blocker.")

    # SIZE-MATCHED COMPARISON.
    #
    # The level tables above are confounded. Level 1 and Level 2 items are
    # windows of a FIXED 6 actions; episodes run 1-46 and steps 3-116. Within
    # episodes alone, coherence falls from 76% at 1-4 actions to 18% at 9+, so
    # size is a stronger predictor than level. Comparing a 6-action window to a
    # 25-action episode measures chunk size, not representation.
    #
    # Restricting every level to items of 5-8 actions removes that confound.
    # The band is chosen to bracket the fixed window of 6 without being so
    # narrow that nothing survives; small n is reported so the reader can judge.
    LO, HI = 5, 8
    matched = defaultdict(Counter)
    for r in rows:
        it = items.get(r["item_id"])
        if it and LO <= it["n_actions"] <= HI and r.get("one_task"):
            matched[it["level"]][r["one_task"]] += 1
    if len(matched) > 1:
        md.append(f"\n## Single task, size-matched ({LO}-{HI} actions only)\n")
        md.append("| level | n | one task |")
        md.append("|---|---|---|")
        for lvl, c in sorted(matched.items(), key=lambda kv: -sum(kv[1].values())):
            n = sum(c.values())
            md.append(f"| {lvl} | {n} | {c.get('yes', 0)/n:.0%} |")
        md.append("\nThis is the only fair comparison across levels in this "
                  "report. Every other level table mixes items of very "
                  "different sizes, and size predicts coherence more strongly "
                  "than level does. Where n is small, say so rather than "
                  "quoting the percentage alone.")

    ep = by_level.get("episode", Counter())
    st = by_level.get("step", Counter())
    fu = by_level.get("full", Counter())
    hy = by_level.get("hybrid", Counter())

    def rate(c, k="MATCH_HEAD"):
        n = sum(c.values())
        return c[k] / n if n else None

    e, s, r = rate(ep), rate(st), rate(fu)
    md.append("\n## Reading it\n")
    if e is not None and s is not None and r is not None:
        if e >= s:
            md.append(f"- Episodes scored {e:.0%} and steps {s:.0%}. Do NOT "
                      f"report this as episodes beating human labels. Step "
                      f"labels are prose, which the automatic coder cannot "
                      f"match, and step items are far larger. Hand-code the "
                      f"step rows (`handcode.py`) before using this row at all.")
        elif e > r:
            md.append(f"- Episodes ({e:.0%}) sit between raw actions ({r:.0%}) and "
                      f"human steps ({s:.0%}). The grouping adds readability but "
                      f"does not reach the upper bound.")
        else:
            md.append(f"- Episodes ({e:.0%}) are no more readable than ungrouped "
                      f"raw actions ({r:.0%}). The grouping is not buying "
                      f"comprehension, whatever it does to the state count.")
    if sum(hy.values()) and sum(fu.values()):
        h, f_ = rate(hy), rate(fu)
        md.append(f"- Level 2 windows were nameable {h:.0%} of the time against "
                  f"{f_:.0%} for raw Level 1 windows. These two are directly "
                  f"comparable; both are easier questions than the labelled "
                  f"levels, so do not read them against episodes or steps "
                  f"except through the single-task table.")
        if e is not None and h is not None and h >= e:
            md.append("- Level 2 is at least as readable as Level 3 here. If "
                      "that holds up, the episode layer's contribution is plan "
                      "length and goal structure rather than readability, and "
                      "the write-up should say so plainly.")

    n_ep = sum(ep.values())
    if n_ep:
        wrong_name = ep["OTHER_MEMBER"] / n_ep
        broken = ep["NOT_COHERENT"] / n_ep
        md.append(f"- Of the episode items, {wrong_name:.0%} were grouped correctly "
                  f"but named wrongly, and {broken:.0%} were not coherent groups. "
                  f"The first is fixed by the naming rule; only the second "
                  f"requires changing the segmentation.")
        if wrong_name > broken:
            md.append("- Naming is the larger problem, which matches "
                      "head-is-modal of 0.26-0.38. Fix the label before "
                      "touching the boundaries.")

    (out / "readability_result.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n".join(md))
    print(f"\n✓ {out/'readability_result.md'}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("make")
    m.add_argument("recipe_ids", nargs="+")
    m.add_argument("--n", type=int, default=20, help="episode items per recipe")
    m.add_argument("--seed", type=int, default=13)
    m.add_argument("--graphs-dir", default="../outputs/graphs")
    m.add_argument("--out-dir", default="../outputs")
    m.set_defaults(fn=make)

    s = sub.add_parser("score")
    s.add_argument("--out-dir", default="../outputs")
    s.set_defaults(fn=score)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()