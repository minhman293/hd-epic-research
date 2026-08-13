"""
collect_figures.py — one source of truth for every number in the write-up.

WHY THIS EXISTS
--------------------------------------------------------------------------------
The August audit found seven figures in explained_pipeline.md that came from an
older run of the pipeline: a Level 2 state count of 26 measured under the old
`window` scope with edge thinning on, sitting in the same document as 124
measured without either. Numbers copied by hand go stale silently. Numbers read
from a file go stale loudly.

So nothing in the write-up should be typed from memory again. This script reads
the JSON the pipeline actually produced and emits:

    outputs/figures.json   machine-readable, one entry per recipe per layer
    outputs/figures.md     the same thing as tables you can paste

WHAT IT REPORTS, AND THE ONE DISTINCTION THAT MATTERS
--------------------------------------------------------------------------------
Levels 1 and 2 only change labels, so they are naturally counted over every
annotated action in the recording. Level 3 is built inside the task span. Those
are two different denominators, and mixing them is what made 379 events and 29
episodes look comparable when they are not.

This script therefore reports BOTH for the raw and hybrid layers:

    events_all / states_all     over the whole recording
    events_span / states_span   inside the task span only

Quote whichever you like, but say which one, and never put them in one row.

USAGE
--------------------------------------------------------------------------------
    python collect_figures.py P01_R01 P03_R03 P05_R02
    python collect_figures.py --all
"""

import argparse
import json
from pathlib import Path

LAYERS = ["full", "hybrid", "episode", "step"]
LAYER_NAMES = {
    "full":    "Level 1 - every distinct action",
    "hybrid":  "Level 2 - verb + object category",
    "episode": "Level 3 - episodes",
    "step":    "Level 4 - recipe steps",
}
SPECIAL = {"START", "END"}


# ─────────────────────────────────────────────────────────────────────────────
# Task span — the same definition 9_build_episode_graphs.py uses.
#
# Duplicated here on purpose rather than imported: this script must be runnable
# on its own, and the definition is three lines. If it ever changes there,
# change it here too — the docstring of that function is the reference.
# ─────────────────────────────────────────────────────────────────────────────

def task_span(actions, payload):
    marks = [(a["start"], a["end"]) for a in actions if a.get("step_id")]
    marks += [(w["start"], w["end"]) for w in (payload.get("step_windows") or [])]
    if not marks:
        return actions, None
    lo = min(m[0] for m in marks)
    hi = max(m[1] for m in marks)
    return [a for a in actions if a["end"] >= lo and a["start"] <= hi], (lo, hi)


def _load(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return None


def _real_nodes(graph):
    """Node count excluding START and END.

    START and END are bookkeeping, not states of the recipe. Counting them
    inflates every layer by exactly 2, which matters most at the step layer
    where 7 nodes are really 5 steps.
    """
    if not graph:
        return None
    return sum(1 for n in graph.get("nodes", []) if n.get("id") not in SPECIAL)


def _actions_of(payload):
    return [a for a in payload.get("sequence", [])
            if a.get("kind", "action") == "action" and a.get("start") is not None]


# ─────────────────────────────────────────────────────────────────────────────
# Raw / hybrid: state counts over both denominators
# ─────────────────────────────────────────────────────────────────────────────

def label_counts(rdir, mode):
    """Distinct labels and event totals, whole-recording and task-span.

    Read from the per-session files rather than the merged one, because the
    merged file's `sequence` holds only one session's rows while its `graph`
    holds all of them — a trap worth avoiding.
    """
    files = sorted(rdir.glob(f"session_*_{mode}.json"),
                   key=lambda p: int(p.stem.split("_")[1]))
    if not files:
        return None

    all_labels, span_labels = set(), set()
    n_all = n_span = 0
    for f in files:
        d = _load(f)
        if not d:
            continue
        acts = _actions_of(d)
        scoped, _ = task_span(acts, d)
        for a in acts:
            all_labels.add(a.get("action"))
        for a in scoped:
            span_labels.add(a.get("action"))
        n_all += len(acts)
        n_span += len(scoped)

    return {
        "sessions": len(files),
        "events_all": n_all,
        "states_all": len(all_labels),
        "events_span": n_span,
        "states_span": len(span_labels),
        "span_fraction": round(n_span / n_all, 4) if n_all else None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# One recipe
# ─────────────────────────────────────────────────────────────────────────────

def collect_recipe(recipe_id, graphs_dir):
    rdir = Path(graphs_dir) / recipe_id
    if not rdir.exists():
        return {"recipe": recipe_id, "error": f"{rdir} not found"}

    out = {"recipe": recipe_id, "layers": {}, "warnings": []}

    for mode in LAYERS:
        merged = _load(rdir / f"merged_{mode}.json")
        entry = {"name": LAYER_NAMES[mode], "file": f"merged_{mode}.json"}

        if merged is None:
            sess = sorted(rdir.glob(f"session_*_{mode}.json"))
            entry["present"] = bool(sess)
            if not sess:
                entry["note"] = "not built"
                out["layers"][mode] = entry
                continue
            entry["note"] = "per-session only (single-session recipe)"
        else:
            entry["present"] = True
            g = merged.get("graph") or {}
            entry["states"] = _real_nodes(g)
            entry["states_incl_start_end"] = len(g.get("nodes", []))
            entry["links"] = len(g.get("links", []))
            entry["n_sessions"] = (merged.get("n_sessions")
                                   or (merged.get("recipe") or {}).get("n_sessions"))

            # Probability sanity check. With thinning off, every state's
            # outgoing probabilities must sum to 1.00. If they do not, either
            # thinning is back on or the denominator bug has returned.
            sums = {}
            for l in g.get("links", []):
                sums[l["source"]] = sums.get(l["source"], 0.0) + (l.get("probability") or 0.0)
            bad = {k: round(v, 3) for k, v in sums.items() if abs(v - 1.0) > 0.02}
            entry["prob_sums_to_one"] = not bad
            if bad:
                entry["prob_offenders"] = dict(list(bad.items())[:5])
                out["warnings"].append(
                    f"[{mode}] {len(bad)} states whose outgoing probabilities "
                    f"do not sum to 1.00 — thinning on, or the denominator bug is back")

        if mode in ("full", "hybrid"):
            lc = label_counts(rdir, mode)
            if lc:
                entry.update(lc)

        if mode == "episode" and merged:
            aud = merged.get("label_audit") or {}
            st = merged.get("episode_structure") or {}
            entry["audit"] = {
                "verb_purity": aud.get("verb_purity"),
                "object_purity": aud.get("object_purity"),
                "mean_episode_size": aud.get("mean_episode_size"),
                "singleton_fraction": aud.get("singleton_fraction"),
                "n_episodes": aud.get("n_episodes"),
                "head_is_modal_verb": st.get("head_is_modal_verb"),
                "anchor_position_mean": st.get("anchor_position_mean"),
                "anchor_position_sd": st.get("anchor_position_sd"),
                "internal_consistency": st.get("internal_consistency"),
                "n_repeated_labels": st.get("n_repeated_labels"),
            }

        if merged and merged.get("canonical_spine_report"):
            r = merged["canonical_spine_report"]
            entry["pattern"] = {"verdict": r.get("verdict"),
                                "length": r.get("length"),
                                "coverage": r.get("coverage")}
        if merged and merged.get("likely_path_report"):
            r = merged["likely_path_report"]
            entry["likely_path"] = {"length": r.get("length"),
                                    "observed_in_full": r.get("observed_in_full"),
                                    "longest_run": r.get("longest_run")}

        out["layers"][mode] = entry

    # ---- cross-layer consistency checks ------------------------------------
    L = out["layers"]

    ep = L.get("episode", {})
    if ep.get("audit", {}).get("mean_episode_size") and ep.get("audit", {}).get("n_episodes"):
        modelled = ep["audit"]["mean_episode_size"] * ep["audit"]["n_episodes"]
        span = (L.get("full") or {}).get("events_span")
        if span and abs(modelled - span) > 0.05 * span:
            out["warnings"].append(
                f"episodes x mean size = {modelled:.0f} but the task span holds "
                f"{span} actions — coverage is not 100%")

    hy, fu = L.get("hybrid", {}), L.get("full", {})
    if hy.get("states_all") and fu.get("states_all"):
        out["hybrid_reduction_all"] = round(1 - hy["states_all"] / fu["states_all"], 3)
    if hy.get("states_span") and fu.get("states_span"):
        out["hybrid_reduction_span"] = round(1 - hy["states_span"] / fu["states_span"], 3)

    if hy.get("states") and hy.get("states_all") and hy["states"] + 2 != hy["states_all"]:
        out["warnings"].append(
            f"merged_hybrid graph has {hy['states']} states but the sessions "
            f"contain {hy['states_all']} distinct labels over the whole recording "
            f"and {hy.get('states_span')} inside the span — the graph is scoped, "
            f"so quote the scoped figure")

    return out


# ─────────────────────────────────────────────────────────────────────────────
# Markdown
# ─────────────────────────────────────────────────────────────────────────────

def _f(v, nd=2):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def to_markdown(results):
    L = []
    L.append("# Pipeline figures\n")
    L.append("Generated by `collect_figures.py`. Every number in the write-up "
             "should be copied from here, not typed from memory.\n")

    L.append("\n## States per layer\n")
    L.append("| Recipe | Sessions | L1 raw | L2 hybrid | L3 episodes | L4 steps |")
    L.append("|---|---|---|---|---|---|")
    for r in results:
        if r.get("error"):
            continue
        lay = r["layers"]
        ns = (lay.get("episode") or {}).get("n_sessions") or \
             (lay.get("full") or {}).get("sessions")
        L.append(f"| {r['recipe']} | {_f(ns)} | "
                 f"{_f(lay.get('full', {}).get('states'))} | "
                 f"{_f(lay.get('hybrid', {}).get('states'))} | "
                 f"{_f(lay.get('episode', {}).get('states'))} | "
                 f"{_f(lay.get('step', {}).get('states'))} |")
    L.append("\nStart and End are excluded. A step layer showing 5 here is a "
             "7-node graph.\n")

    L.append("\n## Two denominators for Levels 1 and 2\n")
    L.append("| Recipe | Layer | Events (all) | States (all) | Events (span) | States (span) | Span share |")
    L.append("|---|---|---|---|---|---|---|")
    for r in results:
        if r.get("error"):
            continue
        for mode in ("full", "hybrid"):
            e = r["layers"].get(mode, {})
            if "events_all" not in e:
                continue
            L.append(f"| {r['recipe']} | {mode} | {e['events_all']} | "
                     f"{e['states_all']} | {e['events_span']} | "
                     f"{e['states_span']} | {_f(e.get('span_fraction'))} |")
    L.append("\nNever put an all-recording figure and a task-span figure in the "
             "same comparison.\n")

    L.append("\n## Episode layer audit\n")
    L.append("| Recipe | verb purity | object purity | head modal | goal pos | internal consistency | mean size | singletons |")
    L.append("|---|---|---|---|---|---|---|---|")
    for r in results:
        a = (r.get("layers", {}).get("episode") or {}).get("audit")
        if not a:
            continue
        pos = (f"{_f(a.get('anchor_position_mean'))} ± "
               f"{_f(a.get('anchor_position_sd'))}"
               if a.get("anchor_position_mean") is not None else "—")
        L.append(f"| {r['recipe']} | {_f(a.get('verb_purity'))} | "
                 f"{_f(a.get('object_purity'))} | {_f(a.get('head_is_modal_verb'))} | "
                 f"{pos} | **{_f(a.get('internal_consistency'))}** | "
                 f"{_f(a.get('mean_episode_size'), 1)} | "
                 f"{_f(a.get('singleton_fraction'))} |")

    warn = [(r["recipe"], w) for r in results for w in r.get("warnings", [])]
    L.append("\n## Warnings\n")
    if warn:
        for rec, w in warn:
            L.append(f"- **{rec}** — {w}")
    else:
        L.append("None. Every layer is internally consistent.")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recipe_ids", nargs="*")
    ap.add_argument("--graphs-dir", default="../outputs/graphs")
    ap.add_argument("--out-dir", default="../outputs")
    ap.add_argument("--all", action="store_true",
                    help="every recipe directory that has a merged_full.json")
    a = ap.parse_args()

    ids = list(a.recipe_ids)
    if a.all or not ids:
        ids = sorted(p.name for p in Path(a.graphs_dir).iterdir()
                     if p.is_dir() and (p / "merged_full.json").exists())
        print(f"discovered {len(ids)} multi-session recipes: {', '.join(ids)}")

    results = [collect_recipe(r, a.graphs_dir) for r in ids]

    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "figures.json").write_text(
        json.dumps({"recipes": results}, indent=1), encoding="utf-8")
    (out_dir / "figures.md").write_text(to_markdown(results), encoding="utf-8")

    print(f"\n✓ {out_dir/'figures.json'}")
    print(f"✓ {out_dir/'figures.md'}\n")
    print(to_markdown(results))

    n_warn = sum(len(r.get("warnings", [])) for r in results)
    if n_warn:
        print(f"\n!! {n_warn} warning(s) above. Resolve them before quoting "
              f"any of these numbers.")


if __name__ == "__main__":
    main()