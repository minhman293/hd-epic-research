"""
ablation.py — the experiment that decides whether the episode layer is kept.

THE QUESTION
--------------------------------------------------------------------------------
Internal consistency of the episode layer is 0.31-0.34: when the same label
occurs twice, it holds substantially different contents. Two readings fit that
number equally well.

    Reading 1  the person really did it differently each time, and the layer is
               correctly reporting real variation.
    Reading 2  the segmentation rule cuts in a different place each time, and
               the layer is measuring its own instability.

They have opposite consequences — keep the layer versus rebuild it — and no
amount of re-reading the number will separate them. But turning each suspect
rule OFF will. If consistency rises when a rule is disabled, that rule was
manufacturing the disagreement (Reading 2). If it stays flat under every
condition, the variation is in the kitchen, not in the code (Reading 1).

THE FIVE CONDITIONS
--------------------------------------------------------------------------------
    baseline    the current pipeline
    A_object    12-second reach window -> object continuity
    B_nocap     the 8-member cap removed
    C_nosynth   synthetic anchors removed
    D_nofold    fold_one_offs removed

D is worth watching. fold_one_offs glues a one-off episode onto whichever
episode happens to precede it, with no test of meaning at all. That is exactly
the operation that would put unlike contents under one name, and it is the one
rule the write-up never mentioned.

WRITE THE DECISION RULE DOWN BEFORE YOU READ THE OUTPUT
--------------------------------------------------------------------------------
    consistency > 0.60 in any condition  -> the layer represents skills
    consistency < 0.45 in every condition -> it describes variation, not skills

Choosing the threshold after seeing the numbers is how a project talks itself
into whatever it already believed.

USAGE
--------------------------------------------------------------------------------
    python ablation.py P01_R01 P03_R03 P05_R02
    python ablation.py P01_R01 --conditions baseline D_nofold
"""

import argparse
import csv
import json
import sys
from pathlib import Path

from episodes import (Config, segment, apply_rollup, fold_one_offs,
                      label_faithfulness, episode_structure, build_graph)

# The decision rule. Stated here, in code, before any run happens.
KEEP_ABOVE = 0.60
DROP_BELOW = 0.45


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


CONDITIONS = {
    "baseline":  (Config(), "current pipeline"),
    "A_object":  (Config(reach_mode="object"), "reach by object, not by 12 s"),
    "B_nocap":   (Config(use_cap=False), "8-member cap removed"),
    "C_nosynth": (Config(use_synthetic=False), "synthetic anchors removed"),
    "D_nofold":  (Config(use_fold=False), "one-off folding removed"),
}


def load_sessions(recipe_id, graphs_dir):
    rdir = Path(graphs_dir) / recipe_id
    files = sorted(rdir.glob("session_*_full.json"),
                   key=lambda p: int(p.stem.split("_")[1]))
    if not files:
        raise SystemExit(f"no session_*_full.json in {rdir} — run 6_ first")
    per = {}
    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        acts = [a for a in d["sequence"]
                if a.get("kind", "action") == "action" and a.get("start") is not None]
        per[int(f.stem.split("_")[1])] = task_span(acts, d)
    return per


def run_one(per, vmap, nmap, cfg):
    """One condition, one recipe. Returns the row for the table."""
    ses = {s: segment(list(a), vmap, nmap, cfg, session=s) for s, a in per.items()}
    ses = apply_rollup(ses, cfg)
    ses = fold_one_offs(ses, cfg)

    fa = label_faithfulness(ses)
    st = episode_structure(ses)
    g = build_graph(ses, cfg)

    # Coverage must stay at 1.00 in every condition. If a change to the rule
    # loses actions, its consistency score is not comparable to the others —
    # it improved by dropping the hard cases rather than by grouping better.
    covered = sum(len(e.members) for eps in ses.values() for e in eps)
    total = sum(len(a) for a in per.values())

    return {
        "internal_consistency": st.get("internal_consistency"),
        "object_purity": fa.get("object_purity"),
        "verb_purity": fa.get("verb_purity"),
        "head_is_modal": st.get("head_is_modal_verb"),
        "anchor_pos_sd": st.get("anchor_position_sd"),
        "states": sum(1 for n in g["nodes"] if n["id"] not in ("START", "END")),
        "episodes": fa.get("n_episodes"),
        "mean_size": fa.get("mean_episode_size"),
        "singletons": fa.get("singleton_fraction"),
        "repeated_labels": st.get("n_repeated_labels"),
        "coverage": round(covered / total, 4) if total else None,
        "least_consistent": [d["label"] for d in st.get("least_consistent", [])][-3:],
    }


def verdict(rows):
    """Apply the pre-registered rule to the numbers, without interpretation."""
    vals = [r["internal_consistency"] for r in rows
            if r.get("internal_consistency") is not None]
    if not vals:
        return "no repeated labels — consistency undefined"
    best, base = max(vals), rows[0].get("internal_consistency")
    if best > KEEP_ABOVE:
        return (f"KEEP / REBUILD — best condition reaches {best:.2f} > {KEEP_ABOVE}. "
                f"The rule was manufacturing the disagreement (Reading 2). "
                f"Adopt the winning condition.")
    if best < DROP_BELOW:
        return (f"REFRAME — no condition exceeds {best:.2f} < {DROP_BELOW}. "
                f"The variation is in the behaviour, not the rule (Reading 1). "
                f"The layer describes variation and must not be called a skill "
                f"representation.")
    return (f"UNDECIDED — best {best:.2f}, baseline {base}. Between "
            f"{DROP_BELOW} and {KEEP_ABOVE}. Report it as unresolved; do not "
            f"round it into whichever story is more convenient.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recipe_ids", nargs="+")
    ap.add_argument("--graphs-dir", default="../outputs/graphs")
    ap.add_argument("--narrations-dir", default="../narrations-and-action-segments")
    ap.add_argument("--out-dir", default="../outputs")
    ap.add_argument("--conditions", nargs="*", default=list(CONDITIONS))
    a = ap.parse_args()

    vmap, nmap = load_taxonomy(a.narrations_dir)
    out_rows, md = [], []

    md.append("# Episode-layer ablation\n")
    md.append(f"Decision rule fixed before the run: keep if any condition "
              f"exceeds **{KEEP_ABOVE}**, reframe if none reaches "
              f"**{DROP_BELOW}**.\n")

    for rid in a.recipe_ids:
        per = load_sessions(rid, a.graphs_dir)
        print("=" * 74)
        print(f"{rid} — {len(per)} sessions, "
              f"{sum(len(v) for v in per.values())} actions in span")
        print("=" * 74)
        print(f"{'condition':<11}{'consist':>9}{'obj pur':>9}{'modal':>8}"
              f"{'states':>8}{'eps':>6}{'size':>7}{'cover':>7}")

        rows = []
        for name in a.conditions:
            cfg, why = CONDITIONS[name]
            r = run_one(per, vmap, nmap, cfg)
            r.update({"recipe": rid, "condition": name, "why": why})
            rows.append(r)
            out_rows.append(r)
            ic = r["internal_consistency"]
            print(f"{name:<11}{(f'{ic:.3f}' if ic is not None else '—'):>9}"
                  f"{r['object_purity']:>9.3f}{r['head_is_modal']:>8.3f}"
                  f"{r['states']:>8}{r['episodes']:>6}{r['mean_size']:>7.1f}"
                  f"{r['coverage']:>7.2f}")
            if r["coverage"] is not None and abs(r["coverage"] - 1.0) > 1e-6:
                print(f"    ! coverage {r['coverage']:.2f} — this condition "
                      f"loses actions, so its score is not comparable")

        v = verdict(rows)
        print(f"\n  VERDICT  {v}\n")

        md.append(f"\n## {rid}\n")
        md.append("| condition | what changed | consistency | object purity | "
                  "head modal | states | mean size | coverage |")
        md.append("|---|---|---|---|---|---|---|---|")
        for r in rows:
            ic = r["internal_consistency"]
            md.append(f"| `{r['condition']}` | {r['why']} | "
                      f"**{ic:.3f}** | {r['object_purity']:.3f} | "
                      f"{r['head_is_modal']:.3f} | {r['states']} | "
                      f"{r['mean_size']:.1f} | {r['coverage']:.2f} |"
                      if ic is not None else
                      f"| `{r['condition']}` | {r['why']} | — | "
                      f"{r['object_purity']:.3f} | {r['head_is_modal']:.3f} | "
                      f"{r['states']} | {r['mean_size']:.1f} | {r['coverage']:.2f} |")
        md.append(f"\n**Verdict:** {v}\n")

    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    keys = ["recipe", "condition", "why", "internal_consistency", "object_purity",
            "verb_purity", "head_is_modal", "anchor_pos_sd", "states", "episodes",
            "mean_size", "singletons", "repeated_labels", "coverage"]
    with open(out / "ablation.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(out_rows)
    (out / "ablation.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    (out / "ablation.json").write_text(json.dumps(out_rows, indent=1),
                                       encoding="utf-8")
    print(f"✓ {out/'ablation.csv'}\n✓ {out/'ablation.md'}\n✓ {out/'ablation.json'}")


if __name__ == "__main__":
    main()