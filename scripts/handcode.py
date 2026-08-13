"""
handcode.py — hand-code the rows the string matcher cannot judge.

WHY ONLY SOME ROWS
--------------------------------------------------------------------------------
The auto-coder compares the reader's answer against the hidden label by word
overlap. That works for episode labels, which are `verb(noun_category)` and
share vocabulary with the answers. It does NOT work for the step layer, whose
labels are prose written by the annotator: `load coffee capsule`, `stir reheat`,
`fill v60 filter`. Nothing in "dispense coffee from a machine" overlaps "load
coffee capsule", so a correct reading was coded UNSURE.

That matters because the step layer is the UPPER BOUND. Without it, the episode
score of 42% has no ceiling to be compared against and means very little. There
are only 18 step rows, so hand-coding them costs about fifteen minutes and turns
an uninterpretable number into a comparison.

WHY NOT HAND-CODE EVERYTHING
--------------------------------------------------------------------------------
Deliberately not. You know the hypothesis, so every row you touch is a row a
reader may discount. Hand-code the layer where the automatic method provably
fails, leave the rest machine-coded, and say exactly that in the write-up.

USAGE
--------------------------------------------------------------------------------
    python handcode.py extract --level step
        -> outputs/handcode_step.csv   (edit the `outcome` column in Excel)

    python handcode.py merge --level step
        -> updates outputs/readability_answers.csv, keeps a .bak

    python readability_test.py score

CODES
--------------------------------------------------------------------------------
    MATCH_HEAD    the answer describes what this step/episode is for
    OTHER_MEMBER  it describes a different action inside the group
    NOT_COHERENT  the actions do not belong together at all
    UNSURE        you genuinely cannot tell
"""

import argparse
import csv
import json
import shutil
from collections import Counter
from pathlib import Path

OUTCOMES = ["MATCH_HEAD", "OTHER_MEMBER", "NOT_COHERENT", "UNSURE"]


def _items(out):
    key = json.loads((out / "readability_items.json").read_text(encoding="utf-8"))
    return {i["item_id"]: i for i in key["items"]}


def extract(a):
    out = Path(a.out_dir)
    items = _items(out)
    answers = {r["item_id"]: r for r in
               csv.DictReader((out / "readability_answers.csv")
                              .open(encoding="utf-8"))}

    rows = []
    for iid, it in sorted(items.items()):
        if it["level"] != a.level:
            continue
        r = answers.get(iid, {})
        rows.append({
            "item_id": iid,
            "outcome": r.get("outcome", ""),      # <- edit this column
            "hidden_label": it.get("label") or "",
            "model_goal": r.get("goal", ""),
            "n_actions": it["n_actions"],
            "recipe": it["recipe"],
            "actions": " | ".join(it["actions"]),
        })

    if not rows:
        raise SystemExit(f"no rows at level {a.level!r}")

    p = out / f"handcode_{a.level}.csv"
    with p.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    # Also print them, because reading 18 rows in a terminal is faster than
    # opening a spreadsheet and you can decide as you scroll.
    print(f"{len(rows)} rows at level {a.level}. Codes: {', '.join(OUTCOMES)}\n")
    for r in rows:
        print(f"  {r['item_id']}  [{r['recipe']}]  {r['n_actions']} actions"
              f"   currently {r['outcome'] or '(blank)'}")
        print(f"    label  : {r['hidden_label'] or '(none)'}")
        print(f"    answer : {r['model_goal']}")
        print(f"    actions: {r['actions'][:150]}"
              f"{'...' if len(r['actions']) > 150 else ''}\n")
    print(f"✓ {p}\n  Edit the `outcome` column, save as CSV, then:"
          f"\n    python handcode.py merge --level {a.level}")


def merge(a):
    out = Path(a.out_dir)
    p = out / f"handcode_{a.level}.csv"
    if not p.exists():
        raise SystemExit(f"{p} not found — run extract first")

    fixed = {r["item_id"]: (r.get("outcome") or "").strip().upper()
             for r in csv.DictReader(p.open(encoding="utf-8-sig"))}
    bad = {v for v in fixed.values() if v and v not in OUTCOMES}
    if bad:
        raise SystemExit(f"unknown code(s): {sorted(bad)}")
    blank = [k for k, v in fixed.items() if not v]
    if blank:
        raise SystemExit(f"{len(blank)} row(s) still blank: {', '.join(blank[:8])}")

    target = out / "readability_answers.csv"
    shutil.copy(target, str(target) + ".bak")

    rows = list(csv.DictReader(target.open(encoding="utf-8")))
    changed = 0
    for r in rows:
        new = fixed.get(r["item_id"])
        if new and new != r["outcome"]:
            r["outcome"] = new
            changed += 1

    with target.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    print(f"{changed} of {len(fixed)} {a.level} rows changed  "
          f"(backup at {target.name}.bak)")
    print("new distribution at this level: " +
          "  ".join(f"{k} {v}" for k, v in Counter(fixed.values()).most_common()))
    print("\nNow run:  python readability_test.py score")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("extract", extract), ("merge", merge)):
        p = sub.add_parser(name)
        p.add_argument("--level", default="step",
                       choices=["step", "episode", "full"])
        p.add_argument("--out-dir", default="../outputs")
        p.set_defaults(fn=fn)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()