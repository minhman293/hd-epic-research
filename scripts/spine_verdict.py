"""
spine_verdict.py

Does this recipe HAVE a shared pattern? Answer honestly, including "no".

Why this module exists
--------------------------------------------------------------------------------
canonical_spine.py computes the longest common subsequence — the ordered run of
actions every session performed. It is correct, and it already reports
`session_coverage`, the fraction of each session the spine accounts for.

What was missing is the reading of that number. On P03_R03 the episode-layer LCS
came back with 2 items and coverage of 3-6%. Two responses were available:

    (a) relax the rule to "seen in 3 of 4 sessions" until a longer spine appears
    (b) report that these four sessions share almost no common order

(a) manufactures a pattern by lowering the standard until something passes. (b)
is a finding: it says this participant does not repeat themselves at this level
of detail. This module implements (b).

The k-of-n subsequence is still computed, but it is reported under
`partial_pattern` and never substituted for the spine. A reader can see both:
what everyone did, and what most people did. They are different claims and are
labelled differently.

Verdicts
--------------------------------------------------------------------------------
    single_session      only one recording — agreement cannot be measured at all
    shared_pattern      the spine explains at least half of every session
    partial_pattern     the spine is real but thin (20-50%)
    no_shared_pattern   no meaningful common order exists

The thresholds are stated in the output under `criteria`, so a reader can
disagree with them without having to read the code.
"""

from collections import defaultdict

from canonical_spine import multi_lcs, stitch, session_sequences


# ─────────────────────────────────────────────────────────────────────────────
# Thresholds — stated in the output, not hidden here
# ─────────────────────────────────────────────────────────────────────────────

SHARED_MIN_COVERAGE = 0.50      # spine explains >= half of every session
PARTIAL_MIN_COVERAGE = 0.20     # spine is real but thin
MIN_SPINE_LENGTH = 2            # one action in common is not an order


def _coverage(seq, spine):
    """Fraction of `seq` consumed by walking `spine` through it in order."""
    if not seq:
        return 0.0
    i = 0
    for a in seq:
        if i < len(spine) and a == spine[i]:
            i += 1
    return round(i / len(seq), 4)


def _k_of_n_subsequence(seqs, k):
    """Longest ordered run present in at least k of the sequences.

    Heuristic: take the LCS of every k-subset is too expensive, so we take the
    best LCS over the k longest-agreeing group found by greedy leave-one-out.
    This is a DIAGNOSTIC, never the spine.
    """
    if k >= len(seqs):
        return multi_lcs(seqs)
    best = []
    for drop in range(len(seqs)):
        subset = [s for i, s in enumerate(seqs) if i != drop]
        cand = _k_of_n_subsequence(subset, k) if len(subset) > k else multi_lcs(subset)
        if len(cand) > len(best):
            best = cand
    return best


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def spine_with_verdict(session_payloads, nodes, links, layer="episode"):
    """Compute the spine and say plainly whether one exists.

    Returns a dict ready to merge into the payload. The front end should read
    `verdict` and `headline` and display them; it should not re-derive them.
    """
    node_ids = {n["id"] for n in nodes}
    seqs = [s for s in session_sequences(session_payloads, node_ids) if s]
    n = len(seqs)

    spine = multi_lcs(seqs)
    coverage = [_coverage(s, spine) for s in seqs]
    min_cov = min(coverage) if coverage else 0.0

    # ---- the verdict -------------------------------------------------------
    if n < 2:
        verdict = "single_session"
        headline = ("Only one recording. This is one observed run, "
                    "not a shared pattern.")
    elif len(spine) < MIN_SPINE_LENGTH or min_cov < PARTIAL_MIN_COVERAGE:
        verdict = "no_shared_pattern"
        headline = (f"No shared pattern. Across {n} sessions the longest common "
                    f"sequence is {len(spine)} step(s), covering as little as "
                    f"{min_cov:.0%} of a session. These runs do not follow a "
                    f"common order at the {layer} level.")
    elif min_cov >= SHARED_MIN_COVERAGE:
        verdict = "shared_pattern"
        headline = (f"Shared pattern found: {len(spine)} steps performed by all "
                    f"{n} sessions in the same order, covering "
                    f"{min_cov:.0%}-{max(coverage):.0%} of each run.")
    else:
        verdict = "partial_pattern"
        headline = (f"Partial pattern: {len(spine)} steps are common to all {n} "
                    f"sessions, but they explain only "
                    f"{min_cov:.0%}-{max(coverage):.0%} of each run. Most of "
                    f"what happens is not shared.")

    # ---- diagnostic only: what MOST sessions did ---------------------------
    partial = []
    if n >= 3 and verdict in ("no_shared_pattern", "partial_pattern"):
        partial = _k_of_n_subsequence(seqs, n - 1)

    path, meta = stitch(spine, links) if spine else ([], {
        "direct_pairs": 0, "stitched_pairs": 0, "broken_pairs": 0,
        "stitched": [], "broken": []})

    # START and END are anchors, not part of the LCS. Attach them only if the
    # sessions actually began (or ended) at the spine — on P01_R01's step layer
    # the spine starts at `brew espresso`, but the three sessions began with
    # three DIFFERENT steps, so no START -> brew espresso edge exists and the
    # highlight drew START floating on its own. The spine is a SUBsequence: it
    # need not begin at the beginning, and that itself is worth reporting.
    edge_set = {(l["source"], l["target"]) for l in links}
    ids = [p["id"] for p in path]
    same_start = bool(spine) and ("START", spine[0]) in edge_set
    same_end = bool(spine) and (spine[-1], "END") in edge_set
    if same_start and "START" in node_ids:
        path.insert(0, {"id": "START", "tier": "spine", "spine_index": -1})
        ids.insert(0, "START")
    if same_end and "END" in node_ids:
        path.append({"id": "END", "tier": "spine", "spine_index": len(spine)})
        ids.append("END")

    if spine and not same_start:
        headline += (" The sessions did not all begin the same way, so the "
                     "pattern starts partway in.")
    if spine and not same_end:
        headline += (" They did not all finish the same way either.")

    return {
        "canonical_spine": ids,
        "canonical_spine_path": path,
        "canonical_spine_report": {
            "method": "longest_common_subsequence",
            "layer": layer,
            "verdict": verdict,
            "headline": headline,
            "starts_at_start": same_start,
            "ends_at_end": same_end,
            "basis": "cross_session" if n > 1 else "single_session",
            "n_sessions": n,
            "spine_length": len(spine),
            "distinct_nodes": len(set(spine)),
            "session_lengths": [len(s) for s in seqs],
            "session_coverage": coverage,
            "min_coverage": min_cov,
            "connectors": sum(1 for p in path if p["tier"] == "connector"),
            **meta,
            # A weaker claim, clearly separated. NEVER drawn as the spine.
            "partial_pattern": {
                "sequence": partial,
                "length": len(partial),
                "seen_in_at_least": max(n - 1, 0),
                "note": ("Present in most sessions but not all. Shown for "
                         "context only — it is not the canonical spine and "
                         "must not be highlighted as one."),
            } if partial else None,
            "criteria": {
                "shared_pattern": f"min session coverage >= {SHARED_MIN_COVERAGE:.0%}",
                "partial_pattern": f"min session coverage >= {PARTIAL_MIN_COVERAGE:.0%}",
                "min_spine_length": MIN_SPINE_LENGTH,
            },
            "note": ("Every action in canonical_spine was performed by every "
                     "session, in this order. tier='connector' nodes are the "
                     "shortest observed route joining two spine actions that "
                     "were never adjacent. No edge is fabricated."),
        },
    }


def compare_layers(results):
    """Given {layer: report}, describe what the difference between layers means.

    A recipe can have no pattern in HOW people work but a clear pattern in WHAT
    they do. That contrast is a finding, so it is written out rather than left
    for the reader to infer.
    """
    ep = results.get("episode", {}).get("verdict")
    st = results.get("step", {}).get("verdict")
    if ep is None or st is None:
        return None
    if st == "shared_pattern" and ep in ("no_shared_pattern", "partial_pattern"):
        return ("Same recipe, different execution: the sessions agree on the "
                "recipe steps but not on the detailed actions used to perform "
                "them.")
    if st == "shared_pattern" and ep == "shared_pattern":
        return "The sessions agree at both the step and the action level."
    if st in ("no_shared_pattern", "partial_pattern"):
        return ("The sessions do not even agree on step order. Check whether "
                "the step annotations are complete before reading further.")
    return None