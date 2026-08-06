"""
likely_path.py

Two additions to the episode payload:

  1. likely_path  — the most probable route through the Markov chain
  2. expansion    — for every node, the raw actions inside it, as a subgraph

WHY A SECOND KIND OF PATTERN
--------------------------------------------------------------------------------
The canonical spine answers "what did every session do?". It is strict: one
session skipping one step removes that step. On P01_R01 it returns two nodes.

The most likely path answers a different question: "at each state, what is the
usual next move?" It walks the chain always taking the best-supported outgoing
edge. That is the quantity a robot planner actually consumes, and it is the
quantity Prof. Lien's paper approximates with a uniform prior.

They can disagree, and the disagreement is informative rather than a defect:

    spine   = an ordered run everyone performed
    likely  = a route assembled from locally common choices

A route made of locally common choices can be a route nobody performed end to
end, because probability composes over single edges, not over whole runs. So
`observed_in_full` records whether any session actually executed the path as a
contiguous run. If it is false, the path is a model, not an observation, and
must be labelled that way on the canvas.

WHY EXPANSION IS PRECOMPUTED
--------------------------------------------------------------------------------
Clicking a merged node should show the raw actions it stands for. Building that
subgraph in the browser would mean re-deriving the grouping at render time,
which is how the two layers drift apart. It is computed once, here, from the
same episode objects that produced the node.
"""

import collections


# ─────────────────────────────────────────────────────────────────────────────
# 1. Most likely path
# ─────────────────────────────────────────────────────────────────────────────

def most_likely_path(nodes, links, start="START", end="END", beam=250):
    """The highest-probability simple path from START to END.

    A greedy walk is the obvious approach and it fails here: taking the best
    edge at every step walks into a corner where every successor has already
    been used, and the route stops in the middle of the recipe. On P01_R01 that
    produced a three-node path that never reached END.

    So this is a beam search over log-probability instead. It keeps the best
    `beam` partial paths at each depth, forbids revisiting a node — a route
    that loops is not "the usual way" — and only accepts candidates that reach
    END. Log-space because multiplying 30 probabilities underflows.
    """
    import math

    ids = {n["id"] for n in nodes}
    if start not in ids or end not in ids:
        return {"path": [], "edge_probabilities": [],
                "report": {"reason": "graph has no START/END"}}

    out = collections.defaultdict(list)
    for l in links:
        if l["source"] == l["target"]:
            continue                       # a self-loop is a repeat, not a move
        p = l.get("probability", 0.0)
        if p > 0:
            out[l["source"]].append((l["target"], p))
    for s in out:
        out[s].sort(key=lambda t: -t[1])

    # (log-probability, path, edge probabilities)
    frontier = [(0.0, [start], [])]
    finished = []
    for _ in range(len(ids) + 2):
        nxt = []
        for lp, path, probs in frontier:
            node = path[-1]
            if node == end:
                finished.append((lp, path, probs))
                continue
            seen = set(path)
            for tgt, p in out.get(node, []):
                if tgt in seen:
                    continue
                nxt.append((lp + math.log(p), path + [tgt], probs + [p]))
        if not nxt:
            break
        nxt.sort(key=lambda t: -t[0])
        frontier = nxt[:beam]
    finished += [f for f in frontier if f[1][-1] == end]

    if not finished:
        return {"path": [], "edge_probabilities": [],
                "report": {"method": "beam_search_max_probability",
                           "reached_end": False,
                           "reason": "no route from START to END without revisiting a node"}}

    # Rank by average per-step probability, not by the product. The product
    # always prefers the shortest route, which would report "START -> END" as
    # the most likely way to make coffee.
    best = max(finished, key=lambda t: t[0] / max(1, len(t[2])))
    lp, path, probs = best
    joint = math.exp(lp)
    mean_p = math.exp(lp / len(probs)) if probs else 0.0

    return {
        "path": path,
        "edge_probabilities": [round(p, 4) for p in probs],
        "report": {
            "method": "beam_search_max_probability",
            "length": len(path),
            "reached_end": True,
            "joint_probability": round(joint, 8),
            "mean_step_probability": round(mean_p, 4),
            "weakest_edge": round(min(probs), 4) if probs else None,
            "candidates_considered": len(finished),
            "note": ("Each step is a common next move from that state. The "
                     "route as a whole is a model, not necessarily a run "
                     "anyone performed."),
        },
    }


def path_observed_in_full(path, sessions, start="START", end="END"):
    """Did any session perform this path as a contiguous run?

    This is the honesty check on the greedy walk. A route can be locally
    optimal at every step and still never have happened.
    """
    core = [p for p in path if p not in (start, end)]
    if not core:
        return {"observed_in_full": False, "sessions": [], "longest_run": 0}

    hits, longest = [], 0
    for s, eps in sessions.items():
        seq = [e.label for e in eps]
        run = 0
        for i in range(len(seq)):
            k = 0
            while k < len(core) and i + k < len(seq) and seq[i + k] == core[k]:
                k += 1
            run = max(run, k)
        longest = max(longest, run)
        if run == len(core):
            hits.append(s)
    return {
        "observed_in_full": bool(hits),
        "sessions": hits,
        "longest_run": longest,
        "path_length": len(core),
    }


def likely_path_block(nodes, links, sessions):
    """The full block to merge into the payload."""
    res = most_likely_path(nodes, links)
    obs = path_observed_in_full(res["path"], sessions)
    res["report"].update(obs)

    if obs["observed_in_full"]:
        headline = (f"Most likely route — {len(res['path']) - 2} steps. "
                    f"Session(s) {', '.join(str(s + 1) for s in obs['sessions'])} "
                    f"performed exactly this run.")
    elif obs["longest_run"] >= 2:
        headline = (f"Most likely route — {len(res['path']) - 2} steps. "
                    f"No session performed the whole route; the longest part "
                    f"anyone did in one go was {obs['longest_run']} steps.")
    else:
        headline = (f"Most likely route — {len(res['path']) - 2} steps, "
                    f"assembled step by step. No session performed more than "
                    f"one step of it in a row.")
    res["report"]["headline"] = headline
    return {"likely_path": res["path"],
            "likely_path_report": res["report"],
            "likely_path_edges": res["edge_probabilities"]}


# ─────────────────────────────────────────────────────────────────────────────
# 2. Expansion — what is inside a merged node
# ─────────────────────────────────────────────────────────────────────────────

def build_expansions(sessions, max_nodes=40):
    """For each episode label, the subgraph of the raw actions it contains.

    Nodes are raw `verb(object)` actions. Edges are the transitions that were
    absorbed when the episode was formed — the ones the merged graph removed.
    Showing them is the answer to "what did you merge, and why".
    """
    per_label = collections.defaultdict(list)      # label -> [episode, ...]
    for s, eps in sessions.items():
        for e in eps:
            per_label[e.label].append((s, e))

    out = {}
    for label, items in per_label.items():
        counts = collections.Counter()
        edges = collections.Counter()
        edge_sess = collections.defaultdict(set)
        occurrences = []

        for s, e in items:
            raw = [(m.get("action") or m.get("raw_action") or
                    f"{m['_vkey']}({m['_nkey']})") for m in e.members]
            for a in raw:
                counts[a] += 1
            for x, y in zip(raw, raw[1:]):
                edges[(x, y)] += 1
                edge_sess[(x, y)].add(s)
            occurrences.append({
                "session": s,
                "start": round(e.start, 2),
                "end": round(e.end, 2),
                "video_id": e.members[0].get("video_id"),
                "n_actions": len(e.members),
                "actions": raw,
            })

        keep = counts.most_common(max_nodes)
        kept_ids = {k for k, _ in keep}
        sub_nodes = [{
            "id": a,
            "count": n,
            "verb": a.split("(")[0],
            "isSpecial": False,
        } for a, n in keep]
        sub_links = [{
            "source": x, "target": y, "count": n,
            "support": len(edge_sess[(x, y)]),
            "probability": round(n / max(1, sum(v for (a, b), v in edges.items()
                                                if a == x)), 4),
        } for (x, y), n in edges.items() if x in kept_ids and y in kept_ids]

        out[label] = {
            "nodes": sub_nodes,
            "links": sub_links,
            "n_raw_actions": sum(counts.values()),
            "n_distinct_actions": len(counts),
            "hidden_actions": max(0, len(counts) - len(keep)),
            "occurrences": occurrences,
            "head_action": items[0][1].head.get("action")
                           or items[0][1].head.get("raw_action"),
            "synthetic": bool(getattr(items[0][1], "synthetic", False)),
            "rolled_up": bool(getattr(items[0][1], "rolled_up", False)),
            "variants": sorted({v for _, e in items
                                for v in getattr(e, "variants", [])}),
        }
    return out