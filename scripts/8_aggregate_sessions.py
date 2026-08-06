"""
8_aggregate_sessions.py

Reads the per-session JSON files produced by 6_prepare_dashboard_data.py and
emits aggregated "merged" files representing all sessions of a recipe at once.

For each recipe with N>=2 sessions, produces three new files:
  outputs/graphs/{recipe_id}/merged_full.json
  outputs/graphs/{recipe_id}/merged_smart.json
  outputs/graphs/{recipe_id}/merged_abstracted.json
"""

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from macro_chain import wilson_interval, grade_evidence, _median
from canonical_spine import compute_canonical_spine


# ─────────────────────────────────────────────────────────────────────────────
# Normalization Helper (Fixes Multiple Start/End Nodes)
# ─────────────────────────────────────────────────────────────────────────────
def normalize_special_nodes(action_str):
    """
    Forces any variation of a start or end node into a single, unified identity.
    This guarantees that all sessions merge cleanly at the root and tail of the graph.
    """
    if not action_str:
        return action_str
    act_upper = str(action_str).upper()
    if act_upper.startswith("START::") or act_upper.startswith("START:") or act_upper == "START":
        return "START"
    if act_upper.startswith("END::") or act_upper.startswith("END:") or act_upper == "END":
        return "END"
    return action_str


# ─────────────────────────────────────────────────────────────────────────────
# Load per-session JSONs for a recipe
# ─────────────────────────────────────────────────────────────────────────────

def load_session_files(recipe_dir, mode):
    pattern = re.compile(rf"^session_(\d+)_{re.escape(mode)}\.json$")
    sessions = []
    for f in sorted(recipe_dir.iterdir()):
        m = pattern.match(f.name)
        if not m:
            continue
        session_idx = int(m.group(1))
        with open(f, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        sessions.append((session_idx, payload))
    sessions.sort(key=lambda x: x[0])
    return sessions


# ─────────────────────────────────────────────────────────────────────────────
# Aggregation helpers
# ─────────────────────────────────────────────────────────────────────────────

def majority_vote(values, tie_breaker=None):
    non_none = [v for v in values if v is not None]
    if not non_none:
        return None
    counts = Counter(non_none)
    max_count = max(counts.values())
    candidates = [v for v, c in counts.items() if c == max_count]
    if len(candidates) == 1:
        return candidates[0]
    if tie_breaker:
        return min(candidates, key=tie_breaker)
    return sorted(candidates)[0]


def majority_vote_bool_with_ties_primary(values):
    if not values:
        return True
    true_count = sum(1 for v in values if v)
    false_count = len(values) - true_count
    return true_count >= false_count


def aggregate_nodes(session_payloads):
    session_indices = [si for si, _ in session_payloads]
    n_sessions = len(session_payloads)
    session_payload_by_idx = {si: p for si, p in session_payloads}

    session_durations = {}
    for si, payload in session_payloads:
        seq = payload.get("sequence", [])
        session_durations[si] = seq[-1]["end"] if seq else 1.0

    per_session_node_counts = defaultdict(dict)  
    per_session_node_primary = defaultdict(dict)  
    per_session_node_step = defaultdict(dict)     
    per_session_node_objects = defaultdict(lambda: defaultdict(Counter))  
    per_session_node_verbs = defaultdict(lambda: defaultdict(Counter))
    per_session_node_salient = defaultdict(list)
    per_session_node_durations = defaultdict(lambda: defaultdict(list))  
    raw_onsets_by_action = defaultdict(list)      
    normalized_onsets_by_action = defaultdict(list)  
    per_session_median_rank = defaultdict(list)

    for si, payload in session_payloads:
        nodes = payload.get("graph", {}).get("nodes", [])
        for n in nodes:
            action = normalize_special_nodes(n["id"])
            
            per_session_node_counts[action][si] = per_session_node_counts[action].get(si, 0) + n.get("count", 0)

            if n.get("median_rank") is not None:
                per_session_median_rank[action].append(float(n["median_rank"]))
            
            # If multiple nodes merge into one, prefer is_primary = True if any of them were primary
            if action not in per_session_node_primary or not per_session_node_primary[action].get(si, False):
                per_session_node_primary[action][si] = bool(n.get("is_primary", True))

            if "objects" in n and isinstance(n["objects"], dict):
                for obj, c in n["objects"].items():
                    per_session_node_objects[action][si][obj] += c
            if "verbs" in n and isinstance(n["verbs"], dict):
                for vkey, c in n["verbs"].items():
                    per_session_node_verbs[action][si][vkey] += c
            if "salient" in n:
                per_session_node_salient[action].append(bool(n["salient"]))

    for si, payload in session_payloads:
        # The graph is compiled from the PRIMARY subsequence, so node onset and
        # duration statistics must be drawn from the same population. Iterating
        # the full sequence here would pool secondary actions into stats for
        # nodes whose counts never included them.
        seq = [
            item for item in payload.get("sequence", [])
            if item.get("is_primary", True)
        ]
        duration = session_durations.get(si, 1.0) or 1.0
        for item in seq:
            action = normalize_special_nodes(item["action"])
            raw_onsets_by_action[action].append(item["start"])
            normalized_onsets_by_action[action].append(item["start"] / duration)
            per_session_node_durations[action][si].append(item.get("duration", 0.0))
            sid = item.get("step_id")
            if sid is not None:
                if si not in per_session_node_step[action]:
                    per_session_node_step[action][si] = []
                if not isinstance(per_session_node_step[action][si], list):
                    per_session_node_step[action][si] = []
                per_session_node_step[action][si].append(sid)

    resolved_per_session_step = defaultdict(dict)
    for action, by_session in per_session_node_step.items():
        for si, sid_list in by_session.items():
            if isinstance(sid_list, list) and sid_list:
                resolved_per_session_step[action][si] = Counter(sid_list).most_common(1)[0][0]
            elif sid_list is not None:
                resolved_per_session_step[action][si] = sid_list

    all_actions = set(per_session_node_counts.keys())
    merged_nodes = []
    
    for action in sorted(all_actions, key=lambda a: (-sum(per_session_node_counts[a].values()), a)):
        per_counts = [per_session_node_counts[action].get(si, 0) for si in session_indices]
        total_count = sum(per_counts)
        support = sum(1 for c in per_counts if c > 0)

        primary_votes = [
            per_session_node_primary[action][si]
            for si in session_indices
            if si in per_session_node_primary[action]
        ]
        is_primary = majority_vote_bool_with_ties_primary(primary_votes)

        step_votes = [resolved_per_session_step[action].get(si) for si in session_indices]
        merged_step = majority_vote(step_votes)

        raw_onsets = raw_onsets_by_action[action]
        norm_onsets = normalized_onsets_by_action[action]
        mean_norm_onset = sum(norm_onsets) / len(norm_onsets) if norm_onsets else 0.0

        union_objects = Counter()
        for si in session_indices:
            for obj, c in per_session_node_objects[action].get(si, {}).items():
                union_objects[obj] += c

        union_verbs = Counter()
        for c in per_session_node_verbs[action].values():
            union_verbs.update(c)

        all_durations = []
        for si in session_indices:
            all_durations.extend(per_session_node_durations[action].get(si, []))
        if all_durations:
            mean_duration = sum(all_durations) / len(all_durations)
            min_duration = min(all_durations)
            max_duration = max(all_durations)
        else:
            mean_duration = min_duration = max_duration = 0.0

        node = {
            "id": action,
            "count": total_count,
            "total_count": total_count,
            "per_session_counts": per_counts,
            "support": support,
            "support_fraction": round(support / n_sessions, 3),
            "n_sessions": n_sessions,
            "is_primary": is_primary,
            "is_mandatory": bool(support == n_sessions and action != "START" and action != "END"),
            "merged_step_id": merged_step,
            "per_session_step_ids": step_votes,
            "mean_normalized_onset": round(mean_norm_onset, 4),
            "raw_onsets": [round(t, 2) for t in raw_onsets],
            "mean_duration": round(mean_duration, 3),
            "min_duration": round(min_duration, 3),
            "max_duration": round(max_duration, 3),
        }

        # Median rank is what return-transition classification runs on.
        mr = per_session_median_rank.get(action, [])
        if mr:
            ordered = sorted(mr)
            mid = len(ordered) // 2
            node["median_rank"] = round(
                ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2.0,
                5,
            )
        if union_objects:
            node["objects"] = dict(union_objects)
        if union_verbs:
            node["verbs"] = dict(union_verbs)
        if per_session_node_salient[action]:
            node["salient"] = any(per_session_node_salient[action])

        merged_nodes.append(node)

    return merged_nodes, session_indices, session_durations


def collect_fabricated_keys(session_payloads):
    """
    Union of edges each session's filter invented — pairs that never occurred
    consecutively in that session's raw sequence. Under span scoping this is
    empty by construction; it is kept as a permanent instrument, because any
    future filtering scheme can fabricate and the graph must be able to say so.
    """
    keys, per_session = set(), {}
    for si, payload in session_payloads:
        fr = payload.get("filter_report") or {}
        sc = (fr.get("scope_comparison") or {}).get(fr.get("scope_mode", "window"), {})
        k = set(sc.get("fabricated_keys", []))
        per_session[si] = sorted(k)
        keys |= k
    return keys, per_session


def aggregate_edges(session_payloads, session_indices, n_sessions,
                    median_ranks=None, fabricated_keys=None):
    median_ranks = median_ranks or {}
    fabricated_keys = fabricated_keys or set()
    per_session_edge_counts = defaultdict(dict)
    per_session_edge_occurrences = defaultdict(lambda: defaultdict(list))
    per_session_edge_return = defaultdict(dict)

    for si, payload in session_payloads:
        links = payload.get("graph", {}).get("links", [])
        for link in links:
            src = normalize_special_nodes(link["source"])
            dst = normalize_special_nodes(link["target"])
            key = (src, dst)
            per_session_edge_counts[key][si] = per_session_edge_counts[key].get(si, 0) + link.get("count", 0)
            per_session_edge_occurrences[key][si].extend(link.get("occurrences", []))
            if "is_return" in link:
                per_session_edge_return[key][si] = bool(link["is_return"])

    out_totals = Counter()
    for (src, dst), by_session in per_session_edge_counts.items():
        out_totals[src] += sum(by_session.values())

    merged_links = []
    for (src, dst), by_session in per_session_edge_counts.items():
        per_counts = [by_session.get(si, 0) for si in session_indices]
        total_count = sum(per_counts)
        support = sum(1 for c in per_counts if c > 0)

        per_session_occ = {
            si: per_session_edge_occurrences[(src, dst)].get(si, [])
            for si in session_indices
        }

        # Re-derive direction from the MERGED median ranks rather than voting on
        # the per-session flags: a transition can be a return in one session and
        # not in another, and the merged graph needs one consistent answer.
        r_src = median_ranks.get(src, 0.5)
        r_dst = median_ranks.get(dst, 0.5)
        delta = round(r_dst - r_src, 5)
        is_self_loop = (src == dst)

        merged_links.append({
            "source": src,
            "target": dst,
            "count": total_count,
            "total_count": total_count,
            "per_session_counts": per_counts,
            "support": support,
            "support_fraction": round(support / n_sessions, 3),
            "n_sessions": n_sessions,
            "key": f"{src}|||{dst}",
            "per_session_occurrences": per_session_occ,
            "probability": round(total_count / out_totals[src], 4) if out_totals[src] else 0.0,
            "is_self_loop": is_self_loop,
            "is_return": bool(delta < 0) and not is_self_loop,
            "rank_delta": delta,
            "is_introduced": f"{src}|||{dst}" in fabricated_keys,
            "per_session_is_return": [
                per_session_edge_return[(src, dst)].get(si) for si in session_indices
            ],
        })

    merged_links.sort(key=lambda l: (-l["total_count"], l["source"], l["target"]))
    return merged_links

from collections import defaultdict


# ─────────────────────────────────────────────────────────────────────────────
# MACRO GRAPH AGGREGATION
#
# The macro chain is a second model with its own state space, so it cannot ride
# along inside aggregate_edges() — that function normalises probabilities over
# the MICRO out-degree. Pooling has to happen on the macro counts and the
# interval has to be recomputed on the pooled n, otherwise the merged view would
# inherit each session's n=1 certainty and multiply it.
#
# The trick used here: present each session's macro graph to the EXISTING
# aggregate_nodes / aggregate_edges by swapping `graph` and `sequence`, so node
# pooling, support counting and return-direction logic stay in one place and
# stay tested. Only the probability, the interval and the bridge payload are
# recomputed afterwards, because only those are macro-specific.
# ─────────────────────────────────────────────────────────────────────────────

def _macro_view(payload):
    """A shallow payload whose `graph`/`sequence` are the macro ones."""
    view = dict(payload)
    view["graph"] = payload.get("graph_macro") or {"nodes": [], "links": []}
    view["sequence"] = payload.get("macro_sequence") or []
    return view


def aggregate_macro_graph(session_payloads):
    """
    Merge the per-session macro graphs into one, pooling evidence properly.

    Returns (graph, report) or (None, None) when no session carries a macro
    graph — which happens for JSONs produced before this pipeline existed.
    """
    usable = [(si, p) for si, p in session_payloads if p.get("graph_macro")]
    if not usable:
        return None, None

    macro_payloads = [(si, _macro_view(p)) for si, p in usable]

    merged_nodes, session_indices, _ = aggregate_nodes(macro_payloads)

    median_ranks = {n["id"]: n.get("median_rank", 0.5) for n in merged_nodes}
    median_ranks["START"] = 0.0
    median_ranks["END"] = 1.0
    for n in merged_nodes:
        if n["id"] in ("START", "END"):
            n["median_rank"] = median_ranks[n["id"]]
        n["role"] = "spine"

    merged_links = aggregate_edges(
        macro_payloads, session_indices, len(macro_payloads), median_ranks, set()
    )

    # ── Recompute the probability on the POOLED counts ───────────────────────
    # aggregate_edges already normalises by pooled out-degree, so `probability`
    # is correct. What it cannot know is the interval, the smoothing or the
    # evidence grade, all of which depend on the macro n.
    out_total = defaultdict(int)
    out_targets = defaultdict(set)
    for l in merged_links:
        out_total[l["source"]] += l["count"]
        out_targets[l["source"]].add(l["target"])

    # ── Pool the bridge payload across sessions ──────────────────────────────
    bridge_samples = defaultdict(list)
    hidden = defaultdict(Counter)
    hidden_raw = defaultdict(Counter)
    gaps = defaultdict(list)
    lengths = defaultdict(list)

    for si, payload in usable:
        for l in payload["graph_macro"]["links"]:
            key = (normalize_special_nodes(l["source"]),
                   normalize_special_nodes(l["target"]))
            for r in l.get("bridge_samples", []):
                rec = dict(r)
                rec["session_index"] = si
                bridge_samples[key].append(rec)
                gaps[key].append(r.get("gap_s", 0.0))
                lengths[key].append(r.get("n_actions", 0))
            hidden[key].update(l.get("bridge_actions", {}))
            hidden_raw[key].update(l.get("bridge_raw_actions", {}))

    for l in merged_links:
        key = (l["source"], l["target"])
        n = l["count"]
        n_out = out_total[l["source"]] or 1
        n_targets = max(len(out_targets[l["source"]]), 1)
        lo, hi = wilson_interval(n, n_out)

        l["n"] = n
        l["n_out"] = n_out
        l["ci_low"] = round(lo, 4)
        l["ci_high"] = round(hi, 4)
        l["p_laplace"] = round((n + 1) / (n_out + n_targets), 4)
        l["evidence"] = grade_evidence(n)

        g, ln = gaps.get(key, []), lengths.get(key, [])
        l["gap_s_mean"] = round(sum(g) / len(g), 2) if g else 0.0
        l["gap_s_median"] = round(_median(g), 2)
        l["gap_s_min"] = round(min(g), 2) if g else 0.0
        l["gap_s_max"] = round(max(g), 2) if g else 0.0
        l["bridge_len_mean"] = round(sum(ln) / len(ln), 2) if ln else 0.0
        l["bridge_len_median"] = round(_median(ln), 2)
        l["bridge_len_min"] = int(min(ln)) if ln else 0
        l["bridge_len_max"] = int(max(ln)) if ln else 0
        l["is_bridged"] = any(x > 0 for x in ln)
        l["bridge_total_actions"] = int(sum(ln))
        l["bridge_actions"] = dict(hidden[key].most_common(12))
        l["bridge_raw_actions"] = dict(hidden_raw[key].most_common(12))
        l["bridge_samples"] = bridge_samples.get(key, [])[:8]
        # Macro edges are legal by construction; the micro fabrication flag is
        # meaningless here and is forced off so the on-canvas ledger cannot
        # report a fabrication that did not happen.
        l["is_introduced"] = False

    n_weak = sum(1 for l in merged_links if l["evidence"] == "weak")
    per_session = [p.get("macro_report") for _, p in usable if p.get("macro_report")]

    report = {
        "usable": True,
        "model": "embedded_jump_chain",
        "markov_assumption": "first_order_approximation",
        "evidence_basis": "cross_session" if len(usable) > 1 else "single_session",
        "n_sessions": len(usable),
        "spine_mode": per_session[0].get("spine_mode") if per_session else None,
        "nodes": len(merged_nodes),
        "edges": {
            "count": len(merged_links),
            "bridged": sum(1 for l in merged_links if l["is_bridged"]),
            "weak_evidence": n_weak,
            "weak_evidence_fraction": round(n_weak / len(merged_links), 4) if merged_links else 0.0,
            "p_equals_one": sum(1 for l in merged_links if l["probability"] >= 1.0),
            "p_equals_one_with_n1": sum(
                1 for l in merged_links if l["probability"] >= 1.0 and l["n"] <= 1
            ),
        },
        "faithfulness": {
            "fabricated_edges": sum(
                r["faithfulness"]["fabricated_edges"] for r in per_session
            ),
            "items_unaccounted": sum(
                r["faithfulness"]["items_unaccounted"] for r in per_session
            ),
        },
        "per_session": per_session,
    }

    return {"nodes": merged_nodes, "links": merged_links}, report


# ─────────────────────────────────────────────────────────────────────────────
# Helpers — merged-graph analysis
# ─────────────────────────────────────────────────────────────────────────────
 
def _edit_distance(a, b):
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[lb]
 
 
def compute_merged_analysis(merged_nodes, merged_links, session_payloads):
    n_sessions = len(session_payloads)
 
    mandatory = [
        n["id"] for n in merged_nodes
        if n["id"] != "START"
        and n["id"] != "END"
        and n.get("support", 0) == n_sessions
    ]
 
    dead_ends = []
    for n in merged_nodes:
        if n["id"] == "END" or n["id"] == "START":
            continue
        score = n.get("dead_end_score", 0.0)
        if isinstance(score, (int, float)) and score >= 0.6:
            dead_ends.append({"id": n["id"], "score": round(score, 3)})
    dead_ends.sort(key=lambda x: -x["score"])
    dead_ends = dead_ends[:10]
 
    prob = {(l["source"], l["target"]): l.get("probability", 0.0) for l in merged_links}
    support = {(l["source"], l["target"]): l.get("support", 0) for l in merged_links}
    successors = defaultdict(list)
    for l in merged_links:
        successors[l["source"]].append(l["target"])
 
    # starts = [n["id"] for n in merged_nodes if n["id"] == "START"]
    # starts.sort(key=lambda s: -next((n["count"] for n in merged_nodes if n["id"] == s), 0))
 
    # best_path, best_score = [], -1.0
    # for start in starts or [None]:
    #     if start is None:
    #         break
    #     path, visited = [start], {start}
    #     cur, score = start, 0.0
    #     for _ in range(200):
    #         cands = [
    #             (t, support.get((cur, t), 0), prob.get((cur, t), 0.0))
    #             for t in successors.get(cur, [])
    #             if t not in visited
    #         ]
    #         if not cands:
    #             break
    #         cands.sort(key=lambda x: (-x[1], -x[2]))
    #         nxt = cands[0][0]
    #         path.append(nxt)
    #         visited.add(nxt)
    #         score += cands[0][2]
    #         cur = nxt
    #         if cur == "END":
    #             break
    #     if score > best_score:
    #         best_path, best_score = path, score
    
    starts = [n["id"] for n in merged_nodes if n["id"] == "START"]
    starts.sort(key=lambda s: -next((n["count"] for n in merged_nodes if n["id"] == s), 0))
 
    # Create lookups for Node Support and Node Count to use as tie-breakers
    node_support = {n["id"]: n.get("support", 0) for n in merged_nodes}
    node_count = {n["id"]: n.get("count", 0) for n in merged_nodes}

    best_path, best_score = [], -1.0
    for start in starts or [None]:
        if start is None:
            break
        path = [start]
        visited_edges = set() # Track edges to prevent infinite loops
        cur, score = start, 0.0
        for _ in range(200):
            cands = [
                (
                    t, 
                    support.get((cur, t), 0),   # Edge Support
                    prob.get((cur, t), 0.0),    # Edge Probability
                    node_support.get(t, 0),     # Target Node Support
                    node_count.get(t, 0)        # Target Node Count
                )
                for t in successors.get(cur, [])
                if (cur, t) not in visited_edges
            ]
            if not cands:
                break
                
            # Sort order (all descending):
            #   1. Edge Support -> 2. Edge Probability -> 3. Node Support -> 4. Node Count
            #
            # Probability was first. It is out-degree-normalised, so a node with
            # a single exit scores 1.00 automatically and always beat a well-
            # travelled hub offering 0.50. The walk therefore preferred the
            # thinnest parts of the graph: ten of fifteen spine transitions came
            # from one session, and a node occurring once in the whole dataset
            # sat on the "canonical" path. Support answers "how many sessions
            # agree", which is what canonical is supposed to mean.
            cands.sort(key=lambda x: (-x[1], -x[2], -x[3], -x[4]))
            
            nxt = cands[0][0]
            path.append(nxt)
            visited_edges.add((cur, nxt))
            # Score by support so the best-of-all-starts comparison rewards the
            # path with the most cross-session agreement, not the most 1.00s.
            score += cands[0][1]
            cur = nxt
            if cur == "END":
                break

        # A canonical pattern has to describe a complete execution, so it must
        # terminate at END. The greedy walk often cannot: every session finishes
        # on a different action, so each edge into END carries support 1 and
        # loses to any support-2 edge elsewhere. The walk then wanders among
        # well-supported states until it runs out of unvisited edges and stops
        # mid-recipe — which is why the highlighted path had no arrow to END.
        #
        # Close it with a shortest path to END (breadth-first, so the join is
        # the fewest additional states), preferring higher-support edges among
        # equals. Nothing is invented: every appended edge exists in the graph.
        if path and path[-1] != "END" and "END" in {n["id"] for n in merged_nodes}:
            frontier = [(path[-1], [])]
            seen_bfs = {path[-1]}
            tail = None
            while frontier and tail is None:
                nxt_frontier = []
                for node, route in frontier:
                    nbrs = sorted(successors.get(node, []),
                                  key=lambda t: -support.get((node, t), 0))
                    for t in nbrs:
                        if t in seen_bfs:
                            continue
                        new_route = route + [t]
                        if t == "END":
                            tail = new_route
                            break
                        seen_bfs.add(t)
                        nxt_frontier.append((t, new_route))
                    if tail is not None:
                        break
                frontier = nxt_frontier
            if tail:
                for step in tail:
                    score += support.get((path[-1], step), 0)
                    path.append(step)

        if score > best_score:
            best_path, best_score = path, score
            
    seqs = []
    for si, payload in session_payloads:
        s = [normalize_special_nodes(item.get("action")) for item in payload.get("sequence", [])]
        s = [a for a in s if a != "START" and a != "END"]
        seqs.append((si, s))
    
    similarity = []
    for i, (_, si_seq) in enumerate(seqs):
        row = []
        for j, (_, sj_seq) in enumerate(seqs):
            if i == j:
                row.append(1.0)
                continue
            d = _edit_distance(si_seq, sj_seq)
            m = max(len(si_seq), len(sj_seq), 1)
            row.append(round(1.0 - d / m, 3))
        similarity.append(row)
 
    shared_prefix, shared_suffix = [], []
    if seqs:
        min_len = min(len(s) for _, s in seqs)
        for k in range(min_len):
            col = {s[k] for _, s in seqs}
            if len(col) == 1:
                shared_prefix.append(next(iter(col)))
            else:
                break
        for k in range(1, min_len + 1):
            col = {s[-k] for _, s in seqs}
            if len(col) == 1:
                shared_suffix.append(next(iter(col)))
            else:
                break
        shared_suffix.reverse()
 
    strong = {(l["source"], l["target"]) for l in merged_links
              if l.get("support", 0) >= 2 and l["source"] != l["target"]}
    succ2 = defaultdict(list)
    for a, b in strong:
        succ2[a].append(b)
    cycles, seen = [], set()
    for start in list(succ2):
        stack = [(start, [start])]
        while stack:
            node, path = stack.pop()
            if len(path) > 5:
                continue
            for nxt in succ2.get(node, []):
                if nxt == start and len(path) >= 2:
                    canonical = tuple(sorted(path))
                    if canonical not in seen:
                        seen.add(canonical)
                        cycles.append(path + [start])
                elif nxt not in path:
                    stack.append((nxt, path + [nxt]))
 
    isolated = [n["id"] for n in merged_nodes if n.get("support", 0) == 1
                and n["id"] != "START"
                and n["id"] != "END"]
 
    return {
        "mandatory_nodes": mandatory,
        # The greedy walk is kept under a different key. It is connected by
        # construction but has no guarantee of being a sequence any session
        # performed — on P01_R01 it emitted press three times and mix twice.
        # The LCS spine below replaces it as the headline result; the walk stays
        # so the two can be compared rather than argued about.
        "modal_walk": best_path,
        "modal_walk_score": round(best_score, 3),
        **compute_canonical_spine(session_payloads, merged_nodes, merged_links),
        "dead_ends": dead_ends,
        "session_similarity": similarity,
        "session_shared_prefix": shared_prefix,
        "session_shared_suffix": shared_suffix,
        "loops": cycles[:20],
        "session_singleton_nodes": isolated,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Build merged payload for one mode
# ─────────────────────────────────────────────────────────────────────────────

def build_merged_payload(recipe_id, mode, session_payloads):
    n_sessions = len(session_payloads)
    if n_sessions < 2:
        raise ValueError(
            f"Aggregation requires ≥2 sessions; {recipe_id} has {n_sessions}."
        )

    merged_nodes, session_indices, session_durations = aggregate_nodes(session_payloads)

    median_ranks = {n["id"]: n.get("median_rank", 0.5) for n in merged_nodes}
    median_ranks["START"] = 0.0
    median_ranks["END"] = 1.0
    for n in merged_nodes:
        if n["id"] in ("START", "END"):
            n["median_rank"] = median_ranks[n["id"]]

    fabricated_keys, fabricated_per_session = collect_fabricated_keys(session_payloads)
    merged_links = aggregate_edges(
        session_payloads, session_indices, n_sessions, median_ranks, fabricated_keys
    )

    multi_sequence = []
    for si, payload in session_payloads:
        seq = payload.get("sequence", [])
        L = max(len(seq) - 1, 1)
        for j, item in enumerate(seq):
            tagged = dict(item)
            
            tagged["action"] = normalize_special_nodes(item.get("action"))
            if tagged.get("next_action"):
                tagged["next_action"] = normalize_special_nodes(tagged["next_action"])
            if tagged.get("edge_key") and "|||" in tagged["edge_key"]:
                src, dst = tagged["edge_key"].split("|||")
                tagged["edge_key"] = f"{normalize_special_nodes(src)}|||{normalize_special_nodes(dst)}"
                
            tagged["session_index"] = si
            tagged["normalized_rank"] = round(j / L, 5)
            multi_sequence.append(tagged)

    first_recipe_meta = session_payloads[0][1].get("recipe", {})
    steps = session_payloads[0][1].get("steps", [])

    session_info = []
    for si, payload in session_payloads:
        rinfo = payload.get("recipe", {})
        seq = payload.get("sequence", [])
        session_info.append({
            "index": si,
            "video_id": rinfo.get("video_id", ""),
            "video_path": rinfo.get("video_path", ""),
            "action_count": len(seq),
            "duration_s": round(session_durations.get(si, 0.0), 2),
        })

    analysis = compute_merged_analysis(merged_nodes, merged_links, session_payloads)

    # Roll the per-session filter ledgers up so the merged view can state, in
    # one line, how much of the raw data the motion graph is standing on.
    per_session_reports = [
        {"session_index": si, **payload["filter_report"]}
        for si, payload in session_payloads
        if payload.get("filter_report")
    ]
    filter_report = None
    if per_session_reports:
        before = sum(r["actions"]["before"] for r in per_session_reports)
        after = sum(r["actions"]["after"] for r in per_session_reports)
        scope_mode = per_session_reports[0].get("scope_mode", "window")
        scope_totals = {}
        for name in ("window", "span"):
            rows = [r["scope_comparison"][name] for r in per_session_reports
                    if r.get("scope_comparison", {}).get(name)]
            if rows:
                kept = sum(r["actions_kept"] for r in rows)
                tot = sum(r["actions_total"] for r in rows)
                edges = sum(r["edges"] for r in rows)
                fab = sum(r["fabricated_edges"] for r in rows)
                scope_totals[name] = {
                    "actions_kept": kept,
                    "actions_total": tot,
                    "kept_fraction": round(kept / tot, 4) if tot else 0.0,
                    "edges": edges,
                    "fabricated_edges": fab,
                    "fabricated_fraction": round(fab / edges, 4) if edges else 0.0,
                }

        filter_report = {
            "identity": per_session_reports[0]["identity"],
            "rule": per_session_reports[0]["rule"],
            "scope_mode": scope_mode,
            "scope_comparison": scope_totals,
            "fabricated_edges_in_merged": sum(
                1 for l in merged_links if l.get("is_introduced")
            ),
            "fabricated_per_session": fabricated_per_session,
            "actions": {
                "before": before,
                "after": after,
                "removed": before - after,
                "removed_fraction": round(1 - after / before, 4) if before else 0.0,
            },
            "merged_nodes": len(merged_nodes),
            "merged_links": len(merged_links),
            "return_transitions": {
                "count": sum(1 for l in merged_links if l.get("is_return")),
                "keys": [l["key"] for l in merged_links if l.get("is_return")],
            },
            "self_loops": {
                "count": sum(1 for l in merged_links if l.get("is_self_loop")),
                "keys": [l["key"] for l in merged_links if l.get("is_self_loop")],
            },
            "per_session": per_session_reports,
        }

    macro_graph, macro_report = aggregate_macro_graph(session_payloads)

    return {
        "recipe": {
            "id": recipe_id,
            "name": first_recipe_meta.get("name", recipe_id),
            "merged": True,
            "n_sessions": n_sessions,
            "session_indices": session_indices,
            "narration_count_total": len(multi_sequence),
        },
        "sessions": session_info,
        "steps": steps,
        "sequence": multi_sequence,
        "graph": {"nodes": merged_nodes, "links": merged_links},
        "graph_macro": macro_graph,
        "macro_report": macro_report,
        "analysis": analysis,
        "filter_report": filter_report,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

MODES = ["full", "smart", "abstracted", "categorical", "hybrid", "hybrid_cat"]

def main():
    parser = argparse.ArgumentParser(
        description="Aggregate per-session JSONs into merged-session JSONs."
    )
    parser.add_argument("recipe_id", help="Recipe ID (e.g. P01_R01)")
    parser.add_argument("--outputs-dir", default="../outputs")
    args = parser.parse_args()

    recipe_id = args.recipe_id
    recipe_dir = Path(args.outputs_dir) / "graphs" / recipe_id

    if not recipe_dir.exists():
        raise FileNotFoundError(
            f"{recipe_dir} not found. "
            f"Run `python 6_prepare_dashboard_data.py {recipe_id}` first."
        )

    print("=" * 80)
    print(f"AGGREGATING SESSIONS FOR {recipe_id}")
    print("=" * 80)

    for mode in MODES:
        sessions = load_session_files(recipe_dir, mode)
        if len(sessions) < 2:
            print(f"\n[{mode}] Only {len(sessions)} session(s) found — skipping merge.")
            continue

        print(f"\n[{mode}] Aggregating {len(sessions)} sessions: "
              f"{[si for si, _ in sessions]}")

        merged = build_merged_payload(recipe_id, mode, sessions)
        out_path = recipe_dir / f"merged_{mode}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2)

        n_nodes = len(merged["graph"]["nodes"])
        n_links = len(merged["graph"]["links"])
        support_3 = sum(1 for n in merged["graph"]["nodes"] if n["support"] == len(sessions))
        support_1 = sum(1 for n in merged["graph"]["nodes"] if n["support"] == 1)
        n_return = sum(1 for l in merged["graph"]["links"] if l.get("is_return"))
        n_loop = sum(1 for l in merged["graph"]["links"] if l.get("is_self_loop"))
        print(f"  ✓ {out_path.name}")
        print(f"    {n_nodes} nodes ({support_3} in all sessions, "
              f"{support_1} in only one)")
        print(f"    {n_links} links ({n_return} return, {n_loop} self-loop, "
              f"{n_links - n_return - n_loop} forward)")
        fr = merged.get("filter_report")
        if fr:
            a = fr["actions"]
            print(f"    filter ledger: {a['before']} → {a['after']} actions "
                  f"(−{a['removed']}, {a['removed_fraction']:.1%}) across all sessions")
            for name, c in (fr.get("scope_comparison") or {}).items():
                mark = " <-- active" if name == fr.get("scope_mode") else ""
                print(f"      scope [{name:<6}]  kept {c['actions_kept']:>3}/"
                      f"{c['actions_total']:<3} ({c['kept_fraction']:.0%})  "
                      f"edges {c['edges']:>3}  fabricated {c['fabricated_edges']:>2} "
                      f"({c['fabricated_fraction']:.0%}){mark}")
            print(f"    merged links flagged is_introduced: "
                  f"{fr.get('fabricated_edges_in_merged', 0)} of {n_links}")

        mr = merged.get("macro_report")
        if mr and mr.get("usable"):
            e = mr["edges"]
            print(f"    macro [{mr['spine_mode']}]: {mr['nodes']} nodes · "
                  f"{e['count']} edges ({e['bridged']} bridged) · "
                  f"basis {mr['evidence_basis']}")
            print(f"      evidence: {e['weak_evidence']}/{e['count']} edges seen "
                  f"once ({e['weak_evidence_fraction']:.0%}) · "
                  f"{e['p_equals_one_with_n1']} of {e['p_equals_one']} P=1.00 "
                  f"edges rest on n=1")

    print("\n" + "=" * 80)
    print(f"DONE → {recipe_dir}/merged_*.json")
    print("Next: re-run `python 7_build_manifest.py` so the dashboard sees merged files.")
    print("=" * 80)

if __name__ == "__main__":
    main()