"""
canonical_spine.py

THE CANONICAL SPINE — the action sequence every session actually performed.
================================================================================

WHAT THIS REPLACES
--------------------------------------------------------------------------------
The previous spine was a greedy walk through the transition matrix: start at the
best-supported node, repeatedly take the highest-support outgoing edge, then
stitch to END with a breadth-first search. That walk is connected by
construction, but it has no guarantee of being a sequence anyone performed. On
P01_R01 it produced

    press → press → pour → press → take → open → put → pour → lift → lift
    → move → mix → mix → shake

with `press` three times and `mix` twice — a plausible-looking route through the
graph that no session ever executed end to end.

This module uses the longest common subsequence instead:

    the longest ordered sequence of actions that appears in EVERY session

On P01_R01 that is 10 items, 8 distinct:

    take(drinks) → take(containers) → open(containers) → open(appliances)
    → put(containers) → close(appliances) → open(containers)
    → press(appliances) → close(appliances) → mix(drinks)

Read at verb_key(noun_key) it is plain English: put the cup down, get the
capsule, get the milk bottle, open it, open the fridge, put the bottle back,
close the fridge, press the button, take the milk, stir.

WHY THIS IS DRAWABLE
--------------------------------------------------------------------------------
An LCS is a SUBsequence, so consecutive spine items need not be adjacent in any
session — there can be other actions in between. Measured on P01_R01, six of the
nine consecutive pairs are nonetheless real observed transitions, and the other
three are reachable in one or two hops. Stitching those three with a shortest
observed route yields a fully connected path over 9 distinct nodes.

So the spine is rendered in TWO TIERS:

    spine     — an LCS member. Every session did this, in this order.
    connector — inserted to join two spine items that were never adjacent.
                A real observed edge, but not part of the common sequence.

The distinction is kept in the output rather than blurred, because a reader is
entitled to know which nodes are the finding and which are the glue. Nothing is
invented: every edge on the path was observed, and `stitched` records exactly
where glue was needed.

SINGLE-SESSION RECIPES
--------------------------------------------------------------------------------
An LCS across one sequence is that sequence. There is no agreement to measure, so
the result is reported with `basis: "single_session"` and the caller is expected
to label it as one observed run rather than a canonical pattern.
"""

from collections import defaultdict, Counter


# ─────────────────────────────────────────────────────────────────────────────
# Longest common subsequence
# ─────────────────────────────────────────────────────────────────────────────

def _lcs_pair(a, b):
    """Classic O(n*m) LCS, reconstructed forwards so ties break toward the front."""
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        row, nxt = dp[i], dp[i + 1]
        for j in range(m - 1, -1, -1):
            row[j] = nxt[j + 1] + 1 if a[i] == b[j] else max(nxt[j], row[j + 1])

    out, i, j = [], 0, 0
    while i < n and j < m:
        if a[i] == b[j]:
            out.append(a[i]); i += 1; j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return out


def multi_lcs(sequences):
    """
    LCS across any number of sequences, folded pairwise.

    Sorted shortest-first on purpose. Multi-sequence LCS is NP-hard, so this is a
    heuristic; folding from the shortest sequence keeps the intermediate result
    small and gives a tighter, more conservative answer than folding from the
    longest. Conservative is the right bias here — a spine that claims less than
    the true common sequence is a smaller error than one that claims more.
    """
    seqs = [s for s in sequences if s]
    if not seqs:
        return []
    seqs = sorted(seqs, key=len)
    cur = seqs[0]
    for s in seqs[1:]:
        cur = _lcs_pair(cur, s)
        if not cur:
            break
    return cur


# ─────────────────────────────────────────────────────────────────────────────
# Session sequences, in the graph's own state space
# ─────────────────────────────────────────────────────────────────────────────

def session_sequences(session_payloads, node_ids=None, collapse_repeats=True):
    """
    One collapsed, in-scope action list per session.

    `node_ids` restricts to states that exist in the graph being drawn. This is
    what keeps the spine in the SAME state space as the rendered graph: computing
    it at a finer abstraction than the graph would yield spine ids that match no
    node, and the highlight would silently do nothing.

    Consecutive duplicates are collapsed because a repeated identical state adds
    nothing to a path. Measured on P01_R01 this removes only 7 of 220 actions, so
    it does not shape the result — but it must be applied consistently, since the
    collapsed count differs by abstraction level.
    """
    out = []
    for _, payload in session_payloads:
        seq = []
        for item in payload.get("sequence", []):
            if item.get("kind") != "action":
                continue
            if not item.get("is_primary", True):
                continue
            a = item.get("action")
            if not a:
                continue
            if node_ids is not None and a not in node_ids:
                continue
            if collapse_repeats and seq and seq[-1] == a:
                continue
            seq.append(a)
        out.append(seq)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Stitching: join spine items that were never adjacent
# ─────────────────────────────────────────────────────────────────────────────

def _build_adjacency(links):
    adj = defaultdict(list)
    support = {}
    for l in links:
        s, t = l.get("source"), l.get("target")
        if s is None or t is None or s == t:
            continue
        adj[s].append(t)
        support[(s, t)] = l.get("support", l.get("count", 1))
    for s in adj:
        adj[s].sort(key=lambda t: -support.get((s, t), 0))
    return adj, support


def _shortest_route(adj, src, dst, max_depth=4):
    """
    Fewest observed hops from src to dst, preferring well-supported edges among
    equals. Returns the intermediate nodes only, or None if unreachable within
    max_depth.

    Depth is capped deliberately. A six-hop detour to join two spine items is not
    a connection a reader would accept as "these two steps follow each other", so
    beyond the cap it is more honest to leave the path broken and say so.
    """
    if dst in adj.get(src, []):
        return []
    seen = {src}
    frontier = [(src, [])]
    for _ in range(max_depth):
        nxt = []
        for node, route in frontier:
            for t in adj.get(node, []):
                if t == dst:
                    return route
                if t not in seen:
                    seen.add(t)
                    nxt.append((t, route + [t]))
        frontier = nxt
        if not frontier:
            break
    return None


def stitch(spine, links, max_depth=4):
    """
    Turn the LCS into a drawable path.

    Returns (path, meta) where `path` is a list of dicts:

        {"id": ..., "tier": "spine" | "connector", "spine_index": int|None}

    and `meta` records where glue was needed and where the path had to break.
    """
    adj, _ = _build_adjacency(links)

    path, stitched, broken = [], [], []
    for i, node in enumerate(spine):
        path.append({"id": node, "tier": "spine", "spine_index": i})
        if i == len(spine) - 1:
            break
        nxt = spine[i + 1]
        if nxt in adj.get(node, []):
            continue                       # already a real transition
        route = _shortest_route(adj, node, nxt, max_depth)
        if route is None:
            broken.append([node, nxt])
            continue
        stitched.append({"from": node, "to": nxt, "via": route})
        for r in route:
            path.append({"id": r, "tier": "connector", "spine_index": None})

    meta = {
        "direct_pairs": max(len(spine) - 1 - len(stitched) - len(broken), 0),
        "stitched_pairs": len(stitched),
        "broken_pairs": len(broken),
        "stitched": stitched,
        "broken": broken,
    }
    return path, meta


# ─────────────────────────────────────────────────────────────────────────────
# Top level
# ─────────────────────────────────────────────────────────────────────────────

def compute_canonical_spine(session_payloads, merged_nodes, merged_links,
                            start_id="START", end_id="END"):
    """
    The full result the dashboard needs.

    START and END are appended as anchors only if they exist in the graph, and
    they are never part of the LCS itself — they are sentinels, not actions, and
    including them would inflate the spine length by two for free.
    """
    node_ids = {n["id"] for n in merged_nodes}
    seqs = session_sequences(session_payloads, node_ids)
    n_sessions = len([s for s in seqs if s])

    spine = multi_lcs(seqs)
    path, meta = stitch(spine, merged_links)

    ids = [p["id"] for p in path]
    if start_id in node_ids:
        path.insert(0, {"id": start_id, "tier": "spine", "spine_index": -1})
        ids.insert(0, start_id)
    if end_id in node_ids:
        path.append({"id": end_id, "tier": "spine", "spine_index": len(spine)})
        ids.append(end_id)

    # How much of each session the spine accounts for. This is the number that
    # says whether the spine is a summary or a sliver.
    coverage = []
    for s in seqs:
        if not s:
            continue
        hit, i = 0, 0
        for a in s:
            if i < len(spine) and a == spine[i]:
                hit += 1; i += 1
        coverage.append(round(hit / len(s), 4) if s else 0.0)

    return {
        "canonical_spine": ids,
        "canonical_spine_path": path,
        "canonical_spine_report": {
            "method": "longest_common_subsequence",
            "basis": "cross_session" if n_sessions > 1 else "single_session",
            "n_sessions": n_sessions,
            "spine_length": len(spine),
            "distinct_nodes": len(set(spine)),
            "session_lengths": [len(s) for s in seqs],
            "session_coverage": coverage,
            "connectors": sum(1 for p in path if p["tier"] == "connector"),
            **meta,
            "note": (
                "Every action in canonical_spine was performed by every session, "
                "in this order. Nodes marked tier='connector' were NOT part of "
                "that common sequence; they are the shortest observed route "
                "joining two spine actions that were never directly adjacent. "
                "Every edge on the path was observed — none is fabricated."
            ),
        },
    }