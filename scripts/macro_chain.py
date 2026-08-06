"""
macro_chain.py

MACRO-STATE MOTION GRAPH — spine nodes, bridge edges.
================================================================================

WHY THIS EXISTS
--------------------------------------------------------------------------------
The verb_key(noun_category) graph is faithful but unreadable: 42 nodes carrying
410 transitions for P03_R03. Every density technique tried so far (rollup,
top-k edge detail, support emphasis) shrinks the drawing without shrinking the
PROBLEM, because the problem is that more than half of all annotated actions are
logistics. Measured on P01_R01 session 0: retrieve + leave + access account for
128 of 224 actions (57%). Those actions are real, they must not be deleted, and
they are not what a reader is looking for when they ask "what does this recipe
do?".

So this module does not delete them. It COLLAPSES them.

    spine action  ──[ bridge: 8 logistics actions, 24.3 s ]──▶  spine action

The bridge travels with the edge as payload. Nothing is dropped, the chain is
never cut, and clicking the edge can unfold the hidden run.

WHY NOT THE exec/prep SPLIT
--------------------------------------------------------------------------------
HD-EPIC's own step_times annotation is the obvious source of a primary/secondary
split, and it is the wrong one for this purpose. Measured on the same files:

    split              spine actions   bridge edges   largest bridge
    exec vs prep        16 / 224 (7%)        7          137 actions
    process vs transfer 65 / 224 (29%)      49           11 actions

Under exec/prep a single edge swallows 137 consecutive actions — 61% of the
video — because step_times coverage is thin, not because the person stopped
cooking. Expanding that edge returns the original hairball. The verb-category
split is evenly distributed and needs no step annotation at all, so it also
works on captures that have none. SPINE_MODE defaults to "process" for that
reason; "exec" is kept so the two can be compared rather than argued about.

THE PROBABILITY IS A DIFFERENT NUMBER — THIS IS THE PART THAT MATTERS
--------------------------------------------------------------------------------
markov_links() in 6_prepare_dashboard_data.py answers "what does the hand do
next?". The macro chain answers "what is the next main step?". These are two
different questions over two different state spaces, so the old number CANNOT be
carried onto a collapsed edge. It is recomputed here from scratch:

    P(spine_next | spine_current) = count(current -> next, no spine action in
                                          between) / out_degree(current)

Three honesty constraints are enforced in the output rather than left to the
reader's goodwill:

1.  This is the EMBEDDED JUMP CHAIN of a semi-Markov process, and it is only a
    FIRST-ORDER APPROXIMATION of the underlying process. Lumping a Markov chain
    is not guaranteed to be Markov (Kemeny & Snell, lumpability condition); the
    hidden bridge carries information — "washed a knife" predicts differently
    from "fetched a pan". Every macro payload is stamped
    `"model": "embedded_jump_chain"` and `"markov_assumption": "first_order_
    approximation"` so no downstream reader can quietly assume exactness.

2.  A probability without its sample size is a lie in this dataset. 93% of macro
    edges in P01_R01 are observed exactly ONCE, and 39% therefore read P = 1.00.
    Every link carries `n`, `n_out`, a Wilson 95% interval and an `evidence`
    grade. The dashboard is expected to render `n`, never a bare probability.

3.  Semi-Markov means jump chain PLUS holding time. The jump chain alone is not
    semi-Markov and must not be called that. Each link therefore also carries the
    bridge duration distribution (`gap_s_*`), which is the holding time, and
    which is the number a collaborative robot actually needs: "how long until the
    human is ready for the next step".

FAITHFULNESS
--------------------------------------------------------------------------------
_scope_comparison() in the main pipeline defines a fabricated edge as a pair
absent from the raw adjacency set. That test is correct for the micro graph and
WRONG for this one: every bridged edge trips it by design. The macro graph gets
its own test instead (`verify_macro_faithfulness`):

    - a macro edge is legal iff the two spine actions were consecutive IN THE
      SPINE, with everything between them recorded on the edge;
    - a macro edge with an EMPTY bridge is a direct transition and must also
      appear in the raw adjacency set. Any that does not is a real bug and is
      reported as `direct_edges_not_in_raw`.

Under this definition the macro graph fabricates nothing, and the report says so
with a number rather than a promise.
"""

import math
from collections import Counter, defaultdict

# ─────────────────────────────────────────────────────────────────────────────
# Which HD-EPIC verb categories are SPINE (state-changing) actions.
#
# The 13 categories split into two groups by whether the action changes the food
# or merely changes where things are:
#
#   spine  (process) : manipulate, split, merge, clean
#   bridge (transfer): retrieve, leave, access, block, transition,
#                      sense, monitor, order, distribute
#
# `distribute` (apply, sprinkle, spray, season) is arguably a state change. It
# sits on the bridge side because in HD-EPIC it is rare and almost always
# adjacent to a merge, so promoting it adds nodes without adding structure.
# Move it if your recipes are seasoning-heavy — it is one line.
# ─────────────────────────────────────────────────────────────────────────────

SPINE_VERB_CATEGORIES = {"manipulate", "split", "merge"}

# "process" -> spine = SPINE_VERB_CATEGORIES  (recommended; needs no annotation)
# "exec"    -> spine = actions whose phase is "exec" (HD-EPIC step_times)
SPINE_MODE = "process"

# Wilson interval z for 95%.
Z_95 = 1.959963985

# An edge seen this many times or fewer is graded "weak": the dashboard should
# show n and the interval instead of leaning on the point estimate.
WEAK_EVIDENCE_MAX_N = 1
MODERATE_EVIDENCE_MAX_N = 3


# ─────────────────────────────────────────────────────────────────────────────
# Small statistics helpers
# ─────────────────────────────────────────────────────────────────────────────

def _median(values):
    vals = sorted(values)
    if not vals:
        return 0.0
    mid = len(vals) // 2
    if len(vals) % 2:
        return float(vals[mid])
    return (vals[mid - 1] + vals[mid]) / 2.0


def _mean(values):
    return (sum(values) / len(values)) if values else 0.0


def wilson_interval(k, n, z=Z_95):
    """
    95% confidence interval for a proportion, Wilson score method.

    Why not the naive normal interval: with k = n = 1 the naive interval is
    [1.00, 1.00], which is exactly the false certainty this whole module exists
    to prevent. Wilson gives roughly [0.21, 1.00] instead, which is honest — one
    observation tells you very little.
    """
    if n <= 0:
        return (0.0, 1.0)
    p = k / n
    denom = 1.0 + (z * z) / n
    centre = p + (z * z) / (2.0 * n)
    margin = z * math.sqrt((p * (1.0 - p) / n) + (z * z) / (4.0 * n * n))
    return (max(0.0, (centre - margin) / denom),
            min(1.0, (centre + margin) / denom))


def grade_evidence(n):
    if n <= WEAK_EVIDENCE_MAX_N:
        return "weak"
    if n <= MODERATE_EVIDENCE_MAX_N:
        return "moderate"
    return "strong"


# ─────────────────────────────────────────────────────────────────────────────
# Spine / bridge classification
# ─────────────────────────────────────────────────────────────────────────────

def spine_role(item, verb_id_to_cat, mode=None):
    """
    "spine" or "bridge" for one sequence item.

    START and END are always spine: they are the graph's anchors, and burying
    them inside a bridge would leave the drawing with no entry or exit.
    """
    mode = mode or SPINE_MODE
    if item.get("kind") in ("start", "end"):
        return "spine"

    if mode == "exec":
        return "spine" if item.get("phase") == "exec" else "bridge"

    v_id = item.get("verb_class", -1)
    cat = verb_id_to_cat.get(v_id) if v_id is not None and v_id >= 0 else None
    return "spine" if cat in SPINE_VERB_CATEGORIES else "bridge"


def tag_spine_roles(sequence, verb_id_to_cat, mode=None):
    """
    Stamp `spine_role` onto every item, in place.

    Deliberately a SEPARATE field from `is_primary`. `is_primary` already means
    "inside the task span" (scope). Overloading it with "is a main action" would
    make filter_report and the scope ledger unreadable, and the two ideas are
    genuinely independent: an action can be in scope and still be logistics.
    """
    for item in sequence:
        item["spine_role"] = spine_role(item, verb_id_to_cat, mode)
    return sequence


def split_spine_and_bridges(sequence, verb_id_to_cat, mode=None):
    """
    Walk the sequence once and separate it into the spine and the runs between.

    Returns (spine, bridges) with the invariant:

        len(bridges) == max(len(spine) - 1, 0)
        bridges[i] is the list of bridge items between spine[i] and spine[i+1]

    Nothing is discarded: every input item is either in `spine` or in exactly one
    bridge, EXCEPT a trailing run after the final spine action. Because the
    hybrid sequence always ends with the END sentinel (which is spine), that
    trailing run is empty in normal operation; it is returned as `tail` anyway so
    a caller can assert on it rather than lose data silently.
    """
    spine, bridges, buf, lead_in = [], [], [], []

    for item in sequence:
        if spine_role(item, verb_id_to_cat, mode) == "spine":
            if spine:
                bridges.append(buf)
            else:
                lead_in = buf          # anything before the first spine action
            spine.append(item)
            buf = []
        else:
            buf.append(item)

    return spine, bridges, buf, lead_in


# ─────────────────────────────────────────────────────────────────────────────
# The macro chain itself
# ─────────────────────────────────────────────────────────────────────────────

def macro_markov_links(spine, bridges, max_samples_per_edge=6):
    """
    Transition probabilities over the SPINE state space, with the collapsed run
    attached to each edge as payload.

    Core logic, stated precisely because the wording matters:

        count(A -> B) = number of times spine action B was the NEXT SPINE ACTION
                        after A, with NO other spine action in between.

    One occurrence of A contributes exactly ONE count. The loose phrasing
    "A eventually reaches B" would let one occurrence of A contribute to every
    later spine action, and the outgoing probabilities would then not sum to 1.

    Every edge also carries:
      n, n_out        raw evidence, so the probability is never shown alone
      ci_low/ci_high  Wilson 95% interval
      p_laplace       add-one smoothed estimate, so a single observation cannot
                      reach exactly 1.00
      gap_s_*         holding-time distribution = the semi-Markov half
      bridge_*        what is hidden under the edge, and samples to unfold
    """
    counts = Counter()
    out_degree = Counter()
    out_targets = defaultdict(set)
    occurrences = defaultdict(list)
    bridge_records = defaultdict(list)

    for i in range(len(spine) - 1):
        src = spine[i]["action"]
        dst = spine[i + 1]["action"]
        run = bridges[i] if i < len(bridges) else []

        counts[(src, dst)] += 1
        out_degree[src] += 1
        out_targets[src].add(dst)
        occurrences[(src, dst)].append(i)

        gap = max(0.0, float(spine[i + 1].get("start", 0.0))
                       - float(spine[i].get("end", 0.0)))
        bridge_records[(src, dst)].append({
            "spine_index": i,
            "n_actions": len(run),
            "gap_s": round(gap, 3),
            "start": round(float(spine[i].get("end", 0.0)), 3),
            "end": round(float(spine[i + 1].get("start", 0.0)), 3),
            "session_index": spine[i].get("session_index"),
            # Both labels are kept: `actions` is the abstracted state the graph
            # would draw if this run were expanded, `raw_actions` is what the
            # annotator actually wrote. The tooltip wants the second.
            "actions": [b.get("action") for b in run],
            "raw_actions": [b.get("raw_action", b.get("action")) for b in run],
            "starts": [round(float(b.get("start", 0.0)), 3) for b in run],
            "ends": [round(float(b.get("end", 0.0)), 3) for b in run],
        })

    links = []
    for (src, dst), k in sorted(counts.items(),
                                key=lambda x: (-x[1], x[0][0], x[0][1])):
        n_out = out_degree[src]
        n_targets = max(len(out_targets[src]), 1)
        recs = bridge_records[(src, dst)]

        lengths = [r["n_actions"] for r in recs]
        gaps = [r["gap_s"] for r in recs]

        hidden = Counter()
        hidden_raw = Counter()
        for r in recs:
            hidden.update(a for a in r["actions"] if a)
            hidden_raw.update(a for a in r["raw_actions"] if a)

        lo, hi = wilson_interval(k, n_out)

        links.append({
            "source": src,
            "target": dst,
            "key": f"{src}|||{dst}",
            "count": int(k),
            "occurrences": occurrences[(src, dst)],

            # ── the probability, and everything needed to read it honestly ──
            "probability": round(k / n_out, 4) if n_out else 0.0,
            "n": int(k),
            "n_out": int(n_out),
            "ci_low": round(lo, 4),
            "ci_high": round(hi, 4),
            "p_laplace": round((k + 1) / (n_out + n_targets), 4),
            "evidence": grade_evidence(k),

            # ── holding time: the semi-Markov half ──
            "gap_s_mean": round(_mean(gaps), 2),
            "gap_s_median": round(_median(gaps), 2),
            "gap_s_min": round(min(gaps), 2) if gaps else 0.0,
            "gap_s_max": round(max(gaps), 2) if gaps else 0.0,

            # ── what is collapsed under this edge ──
            "is_bridged": any(l > 0 for l in lengths),
            "bridge_len_mean": round(_mean(lengths), 2),
            "bridge_len_median": round(_median(lengths), 2),
            "bridge_len_min": int(min(lengths)) if lengths else 0,
            "bridge_len_max": int(max(lengths)) if lengths else 0,
            "bridge_actions": dict(hidden.most_common(12)),
            "bridge_raw_actions": dict(hidden_raw.most_common(12)),
            "bridge_samples": recs[:max_samples_per_edge],
            "bridge_total_actions": int(sum(lengths)),
        })

    return links


def spine_node_timing(spine, links):
    """
    Per-node holding statistics: how long the spine action itself takes, and how
    long the person spends in transit before the next spine action.

    `mean_gap_out_s` is what makes the graph useful for hand-over timing — it is
    the answer to "after this step finishes, how long do I have?".
    """
    dur = defaultdict(list)
    for item in spine:
        if item.get("kind") in ("start", "end"):
            continue
        dur[item["action"]].append(float(item.get("duration", 0.0)))

    gaps_out = defaultdict(list)
    bridge_out = defaultdict(list)
    for l in links:
        for r in l["bridge_samples"]:
            gaps_out[l["source"]].append(r["gap_s"])
            bridge_out[l["source"]].append(r["n_actions"])

    stats = {}
    for action in set(list(dur) + list(gaps_out)):
        stats[action] = {
            "mean_duration_s": round(_mean(dur.get(action, [])), 2),
            "median_duration_s": round(_median(dur.get(action, [])), 2),
            "mean_gap_out_s": round(_mean(gaps_out.get(action, [])), 2),
            "median_gap_out_s": round(_median(gaps_out.get(action, [])), 2),
            "mean_bridge_out_actions": round(_mean(bridge_out.get(action, [])), 2),
        }
    return stats


# ─────────────────────────────────────────────────────────────────────────────
# Faithfulness — the macro graph's own test, NOT the micro one
# ─────────────────────────────────────────────────────────────────────────────

def verify_macro_faithfulness(spine, bridges, full_sequence):
    """
    Two checks, both of which should come back clean:

    1. DIRECT EDGES. A macro edge whose bridge is empty claims the two spine
       actions really were adjacent. That claim is checkable against the raw
       adjacency set. Anything listed in `direct_edges_not_in_raw` is a genuine
       bug in the collapse, not a modelling choice.

    2. ACCOUNTING. Every input item must land in the spine or in exactly one
       bridge. `items_unaccounted` is the number that did not, and must be 0.

    Note what is deliberately NOT tested: whether a BRIDGED edge appears in the
    raw adjacency set. It does not, by construction, and that is the whole point
    — the micro fabrication test would flag every one of them.
    """
    raw_adjacency = {
        (a["action"], b["action"])
        for a, b in zip(full_sequence[:-1], full_sequence[1:])
    }

    direct_missing = []
    n_direct = 0
    for i in range(len(spine) - 1):
        run = bridges[i] if i < len(bridges) else []
        if run:
            continue
        n_direct += 1
        pair = (spine[i]["action"], spine[i + 1]["action"])
        if pair not in raw_adjacency:
            direct_missing.append(f"{pair[0]}|||{pair[1]}")

    accounted = len(spine) + sum(len(b) for b in bridges)

    return {
        "direct_edges": n_direct,
        "direct_edges_not_in_raw": sorted(set(direct_missing)),
        "items_in": len(full_sequence),
        "items_accounted": accounted,
        "items_unaccounted": len(full_sequence) - accounted,
        "fabricated_edges": len(set(direct_missing)),
        "rule": (
            "A macro edge is legal iff the two spine actions were consecutive in "
            "the spine, with every action between them recorded on the edge. An "
            "edge with an empty bridge is a direct transition and must also occur "
            "in the raw adjacency set. Bridged edges are NOT expected in the raw "
            "adjacency set — testing them with the micro fabrication rule would "
            "flag every one of them by design."
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Top-level builder
# ─────────────────────────────────────────────────────────────────────────────

def build_macro_graph(sequence, verb_id_to_cat, build_nodes_fn,
                      tag_returns_fn, mode=None, evidence_basis="single_session",
                      n_sessions=1):
    """
    Build the macro graph from an already state-mapped sequence.

    `build_nodes_fn` and `tag_returns_fn` are injected rather than imported so
    that the macro nodes are compiled by the SAME code that compiles the micro
    nodes (_build_nodes / tag_return_transitions in the main pipeline). Running
    one compiler over two different sequences is what keeps the two graphs
    comparable — only the input changes, never the identity function.

    Expected `sequence`: the in-scope hybrid sequence (START ... END), i.e. the
    same `primary_sequence` the micro graph is built from. Scope and collapse
    then compose cleanly: scope decides WHICH actions exist, collapse decides
    which of those get drawn as nodes.
    """
    mode = mode or SPINE_MODE
    tag_spine_roles(sequence, verb_id_to_cat, mode)

    spine, bridges, tail, lead_in = split_spine_and_bridges(
        sequence, verb_id_to_cat, mode
    )

    if len(spine) < 2:
        return {
            "graph": {"nodes": [], "links": []},
            "spine_sequence": [],
            "report": {
                "usable": False,
                "reason": "fewer than two spine actions in scope",
                "spine_mode": mode,
            },
        }

    links = macro_markov_links(spine, bridges)

    # Re-index the spine so `occurrences` on each link points at spine_sequence
    # positions. The frontend uses these to seek the video, so they must refer to
    # the array it is actually holding.
    spine_sequence = []
    for i, item in enumerate(spine):
        copy = dict(item)
        copy["index"] = i
        copy["spine_role"] = "spine"
        copy["next_action"] = spine[i + 1]["action"] if i < len(spine) - 1 else None
        copy["edge_key"] = (f'{item["action"]}|||{spine[i + 1]["action"]}'
                            if i < len(spine) - 1 else None)
        copy["bridge_after"] = ([b.get("raw_action", b.get("action"))
                                 for b in bridges[i]] if i < len(bridges) else [])
        spine_sequence.append(copy)

    nodes, median_ranks = build_nodes_fn(spine_sequence, force_primary=True)
    links = tag_returns_fn(links, median_ranks)

    timing = spine_node_timing(spine_sequence, links)
    for n in nodes:
        n["role"] = "spine"
        n.update(timing.get(n["id"], {}))

    faithfulness = verify_macro_faithfulness(spine, bridges, sequence)

    lengths = [len(b) for b in bridges]
    n_weak = sum(1 for l in links if l["evidence"] == "weak")
    n_bridged = sum(1 for l in links if l["is_bridged"])

    report = {
        "usable": True,
        "model": "embedded_jump_chain",
        "markov_assumption": "first_order_approximation",
        "semi_markov": "jump chain + bridge holding time (gap_s_*) per edge",
        "note": (
            "P(next spine | current spine) is recomputed over the spine state "
            "space. It is NOT the micro P(next action | current action) and the "
            "two must never be shown on the same edge. Lumping a Markov chain is "
            "not guaranteed to preserve the Markov property (Kemeny & Snell), so "
            "this is a first-order approximation of the induced process, not an "
            "exact rewrite of the original chain."
        ),
        "spine_mode": mode,
        "spine_categories": sorted(SPINE_VERB_CATEGORIES) if mode == "process" else ["phase == exec"],
        "evidence_basis": evidence_basis,
        "n_sessions": n_sessions,
        "actions": {
            "in_scope": len(sequence),
            "spine": len(spine),
            "bridge": sum(lengths),
            "spine_fraction": round(len(spine) / len(sequence), 4) if sequence else 0.0,
            "lead_in_dropped": len(lead_in),
            "tail_dropped": len(tail),
        },
        "bridges": {
            "count": len(bridges),
            "mean_len": round(_mean(lengths), 2),
            "median_len": round(_median(lengths), 2),
            "max_len": int(max(lengths)) if lengths else 0,
            "empty": sum(1 for l in lengths if l == 0),
            "largest_bridges": sorted(lengths, reverse=True)[:8],
        },
        "edges": {
            "count": len(links),
            "bridged": n_bridged,
            "direct": len(links) - n_bridged,
            "weak_evidence": n_weak,
            "weak_evidence_fraction": round(n_weak / len(links), 4) if links else 0.0,
            "p_equals_one": sum(1 for l in links if l["probability"] >= 1.0),
            "p_equals_one_with_n1": sum(
                1 for l in links if l["probability"] >= 1.0 and l["n"] <= 1
            ),
        },
        "faithfulness": faithfulness,
    }

    return {
        "graph": {"nodes": nodes, "links": links},
        "spine_sequence": spine_sequence,
        "report": report,
    }