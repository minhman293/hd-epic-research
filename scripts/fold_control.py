"""
fold_control.py — is the D_nofold gain real, or survivorship?

THE PROBLEM
--------------------------------------------------------------------------------
The ablation showed that removing `fold_one_offs` raises internal consistency in
every recipe (+0.105, +0.027, +0.024) and object purity in every recipe. That
looks like a finding. But it may be an artefact of how the measure is defined.

Internal consistency is only computed over labels that occur TWO OR MORE times.
Folding merges rare labels into their neighbours, so switching it off roughly
triples the number of labels (10 -> 29 on P01_R01). The labels that still repeat
in that larger, thinner vocabulary are, by selection, the naturally repeatable
ones. The mean over "labels that repeat" can therefore rise even if not one
episode became more consistent.

This is the same class of error as the synthetic-anchor claim in Part 6, where a
rule was blamed for the difficulty of the cases it was handed.

THE CONTROL
--------------------------------------------------------------------------------
Recompute consistency for both conditions over the SAME set of labels — those
that occur at least twice in both. If the gain survives on the common set, the
episodes genuinely got more coherent. If it collapses toward zero, the gain was
the vocabulary changing underneath the measure.

A second control is reported alongside it, because episode size also changes
(7.8 -> 4.1 actions). Normalised edit distance is not size-neutral, so the mean
member count of the compared labels is printed for both conditions. If they
differ a lot, the comparison is still not clean and should be said so.

USAGE
--------------------------------------------------------------------------------
    python fold_control.py P01_R01 P03_R03 P05_R02
"""

import argparse
import collections
import csv
import json
from pathlib import Path

from episodes import (Config, segment, apply_rollup, fold_one_offs)


def load_taxonomy(narr_dir):
    def rd(fn):
        with open(Path(narr_dir) / fn, encoding="utf-8") as f:
            return {int(r["id"]): (r["key"], r["category"])
                    for r in csv.DictReader(f)}
    return rd("HD_EPIC_verb_classes.csv"), rd("HD_EPIC_noun_classes.csv")


def task_span(actions, payload):
    marks = [(a["start"], a["end"]) for a in actions if a.get("step_id")]
    marks += [(w["start"], w["end"]) for w in (payload.get("step_windows") or [])]
    if not marks:
        return actions
    lo = min(m[0] for m in marks)
    hi = max(m[1] for m in marks)
    return [a for a in actions if a["end"] >= lo and a["start"] <= hi]


def load_sessions(recipe_id, graphs_dir):
    rdir = Path(graphs_dir) / recipe_id
    files = sorted(rdir.glob("session_*_full.json"),
                   key=lambda p: int(p.stem.split("_")[1]))
    if not files:
        raise SystemExit(f"no session_*_full.json in {rdir}")
    per = {}
    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        acts = [a for a in d["sequence"]
                if a.get("kind", "action") == "action" and a.get("start") is not None]
        per[int(f.stem.split("_")[1])] = task_span(acts, d)
    return per


def _edit(a, b):
    """Normalised Levenshtein — identical to episodes.episode_structure."""
    if not a and not b:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1] / max(len(a), len(b))


def per_label_consistency(sessions):
    """{label: (consistency, occurrences, mean_size)} for labels seen 2+ times."""
    by_label = collections.defaultdict(list)
    for eps in sessions.values():
        for e in eps:
            if e.members:
                by_label[e.label].append([m["_vcat"] for m in e.members])
    out = {}
    for lab, seqs in by_label.items():
        if len(seqs) < 2:
            continue
        ds = [_edit(seqs[i], seqs[j])
              for i in range(len(seqs)) for j in range(i + 1, len(seqs))]
        out[lab] = (1 - sum(ds) / len(ds), len(seqs),
                    sum(len(s) for s in seqs) / len(seqs))
    return out


def build(per, vmap, nmap, cfg):
    ses = {s: segment(list(a), vmap, nmap, cfg, session=s) for s, a in per.items()}
    ses = apply_rollup(ses, cfg)
    return fold_one_offs(ses, cfg)


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recipe_ids", nargs="+")
    ap.add_argument("--graphs-dir", default="../outputs/graphs")
    ap.add_argument("--narrations-dir", default="../narrations-and-action-segments")
    ap.add_argument("--out-dir", default="../outputs")
    a = ap.parse_args()

    vmap, nmap = load_taxonomy(a.narrations_dir)
    rows, md = [], ["# Control: is the fold_one_offs gain real?\n",
                    "Consistency recomputed over the labels that repeat in BOTH "
                    "conditions, so the vocabulary cannot change underneath the "
                    "measure.\n"]

    for rid in a.recipe_ids:
        per = load_sessions(rid, a.graphs_dir)
        base = per_label_consistency(build(per, vmap, nmap, Config()))
        nofold = per_label_consistency(build(per, vmap, nmap, Config(use_fold=False)))
        common = sorted(set(base) & set(nofold))

        b_all, n_all = mean([v[0] for v in base.values()]), mean([v[0] for v in nofold.values()])
        b_com, n_com = mean([base[l][0] for l in common]), mean([nofold[l][0] for l in common])
        b_sz, n_sz = mean([base[l][2] for l in common]), mean([nofold[l][2] for l in common])

        gain_all, gain_com = n_all - b_all, n_com - b_com
        survives = gain_com > 0.5 * gain_all if gain_all > 0 else False

        print("=" * 74)
        print(f"{rid}")
        print("=" * 74)
        print(f"  labels repeating: baseline {len(base)}, no-fold {len(nofold)}, "
              f"in both {len(common)}")
        print(f"  all repeated labels   baseline {b_all:.3f}  no-fold {n_all:.3f}"
              f"   gain {gain_all:+.3f}")
        print(f"  COMMON labels only    baseline {b_com:.3f}  no-fold {n_com:.3f}"
              f"   gain {gain_com:+.3f}")
        print(f"  mean members on those labels: {b_sz:.1f} -> {n_sz:.1f}")
        if not common:
            print("  ! no shared labels — the two vocabularies do not overlap, "
                  "so the conditions are not comparable at all")
        elif survives:
            print(f"  => REAL. Most of the gain survives when the label set is "
                  f"held fixed.")
        else:
            print(f"  => SURVIVORSHIP. The gain mostly disappears on a fixed "
                  f"label set, so it came from the vocabulary changing, not "
                  f"from better grouping.")
        if abs(b_sz - n_sz) > 1.5:
            print(f"  ! episode size still differs by {abs(b_sz-n_sz):.1f} "
                  f"members on the common labels — normalised edit distance is "
                  f"not size-neutral, so even this comparison is imperfect.")
        print()

        rows.append({"recipe": rid, "labels_baseline": len(base),
                     "labels_nofold": len(nofold), "labels_common": len(common),
                     "cons_all_baseline": round(b_all, 3),
                     "cons_all_nofold": round(n_all, 3),
                     "cons_common_baseline": round(b_com, 3),
                     "cons_common_nofold": round(n_com, 3),
                     "gain_all": round(gain_all, 3),
                     "gain_common": round(gain_com, 3),
                     "verdict": "real" if survives else "survivorship"})

        md.append(f"\n## {rid}\n")
        md.append("| label set | baseline | no-fold | gain |")
        md.append("|---|---|---|---|")
        md.append(f"| all repeated | {b_all:.3f} | {n_all:.3f} | {gain_all:+.3f} |")
        md.append(f"| **common only** | {b_com:.3f} | {n_com:.3f} | **{gain_com:+.3f}** |")
        md.append(f"\nLabels repeating: {len(base)} baseline, {len(nofold)} "
                  f"no-fold, {len(common)} in both. "
                  f"Verdict: **{'real' if survives else 'survivorship'}**.\n")

    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "fold_control.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    (out / "fold_control.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print(f"✓ {out/'fold_control.csv'}\n✓ {out/'fold_control.md'}")


if __name__ == "__main__":
    main()