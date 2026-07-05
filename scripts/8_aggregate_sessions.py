"""
8_aggregate_sessions.py

Reads the per-session JSON files produced by 6_prepare_dashboard_data.py and
emits aggregated "merged" files representing all sessions of a recipe at once.

For each recipe with N>=2 sessions, produces three new files:
  outputs/graphs/{recipe_id}/merged_full.json
  outputs/graphs/{recipe_id}/merged_smart.json
  outputs/graphs/{recipe_id}/merged_abstracted.json

Aggregation rules (decisions confirmed with the research team):

  Nodes:
    total_count       = sum of count across sessions where the node appears
    per_session_counts = [c0, c1, c2, ...] aligned to session indices (0 if absent)
    support           = number of sessions containing this node
    support_fraction  = support / N
    mean_normalized_onset = mean of (start / session_duration) across all
                            occurrences in all sessions. Range [0, 1].
    raw_onsets        = flat list of absolute start times across all sessions
    is_primary        = majority vote across per-session is_primary values
    step_id           = majority vote across per-session step_ids (None ties → primary).
                        Stored as 'merged_step_id' so it can't be confused with
                        single-session step_id semantics.

  Edges:
    total_count        = sum of count across sessions where the edge appears
    per_session_counts = [c0, c1, c2, ...] aligned to session indices (0 if absent)
    support            = number of sessions containing this edge
    support_fraction   = support / N

Usage:
  python 8_aggregate_sessions.py P01_R01
"""

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path


# ─────────────────────────────────────────────────────────────────────────────
# Load per-session JSONs for a recipe
# ─────────────────────────────────────────────────────────────────────────────

def load_session_files(recipe_dir, mode):
    """
    Load every session_{N}_{mode}.json file from recipe_dir.
    Returns a list of (session_index, payload) sorted by session_index.
    """
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
    """
    Pick the most common non-None value. If all are None, return None.
    Ties are broken by tie_breaker (a callable mapping value→sort key, lower wins),
    or by Python's natural sort order if not provided.
    """
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
    """For is_primary: tie → True (conservative, matches existing pipeline)."""
    if not values:
        return True
    true_count = sum(1 for v in values if v)
    false_count = len(values) - true_count
    return true_count >= false_count


def aggregate_nodes(session_payloads):
    """
    Build aggregated node list across all sessions.

    session_payloads is list of (session_index, payload) tuples.
    Returns: list of merged-node dicts.
    """
    session_indices = [si for si, _ in session_payloads]
    n_sessions = len(session_payloads)

    # Index sessions by their session_index for lookup
    session_payload_by_idx = {si: p for si, p in session_payloads}

    # For each session, get its total duration (last sequence item's end)
    session_durations = {}
    for si, payload in session_payloads:
        seq = payload.get("sequence", [])
        session_durations[si] = seq[-1]["end"] if seq else 1.0

    # First pass: collect per-session node counts and per-session step_id/primary
    # (from the node objects), then per-occurrence onset times from sequences
    per_session_node_counts = defaultdict(dict)  # action -> {session_idx: count}
    per_session_node_primary = defaultdict(dict)  # action -> {session_idx: bool}
    per_session_node_step = defaultdict(dict)     # action -> {session_idx: step_id or None}
    per_session_node_objects = defaultdict(lambda: defaultdict(Counter))  # action -> session -> Counter
    per_session_node_verbs = defaultdict(lambda: defaultdict(Counter))
    per_session_node_salient = defaultdict(list)
    per_session_node_durations = defaultdict(lambda: defaultdict(list))  # action -> session -> [duration]
    raw_onsets_by_action = defaultdict(list)      # action -> [absolute start times]
    normalized_onsets_by_action = defaultdict(list)  # action -> [start/duration ratios]

    # Collect node-level data from each session's graph.nodes
    for si, payload in session_payloads:
        nodes = payload.get("graph", {}).get("nodes", [])
        for n in nodes:
            action = n["id"]
            per_session_node_counts[action][si] = n.get("count", 0)
            per_session_node_primary[action][si] = bool(n.get("is_primary", True))

            # objects field exists in smart-merged; harmless if missing
            if "objects" in n and isinstance(n["objects"], dict):
                for obj, c in n["objects"].items():
                    per_session_node_objects[action][si][obj] += c
            if "verbs" in n and isinstance(n["verbs"], dict):
                for vkey, c in n["verbs"].items():
                    per_session_node_verbs[action][si][vkey] += c
            if "salient" in n:
                per_session_node_salient[action].append(bool(n["salient"]))

    # Collect per-occurrence data from each session's sequence
    for si, payload in session_payloads:
        seq = payload.get("sequence", [])
        duration = session_durations.get(si, 1.0) or 1.0
        for item in seq:
            action = item["action"]
            raw_onsets_by_action[action].append(item["start"])
            normalized_onsets_by_action[action].append(item["start"] / duration)
            per_session_node_durations[action][si].append(item.get("duration", 0.0))
            sid = item.get("step_id")
            # Record per-session step_id by majority within that session
            # (we'll resolve session-level step later by counting)
            if sid is not None:
                if si not in per_session_node_step[action]:
                    per_session_node_step[action][si] = []
                # store as a list to majority-vote within the session below
                if not isinstance(per_session_node_step[action][si], list):
                    per_session_node_step[action][si] = []
                per_session_node_step[action][si].append(sid)

    # Resolve per-session step_id by intra-session majority vote
    resolved_per_session_step = defaultdict(dict)
    for action, by_session in per_session_node_step.items():
        for si, sid_list in by_session.items():
            if isinstance(sid_list, list) and sid_list:
                resolved_per_session_step[action][si] = Counter(sid_list).most_common(1)[0][0]
            elif sid_list is not None:
                resolved_per_session_step[action][si] = sid_list

    # All action names that appear anywhere
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

        # Object union (only meaningful for smart-merged level)
        union_objects = Counter()
        for si in session_indices:
            for obj, c in per_session_node_objects[action].get(si, {}).items():
                union_objects[obj] += c

        union_verbs = Counter()
        for c in per_session_node_verbs[action].values():
            union_verbs.update(c)

        # Duration stats aggregated across sessions
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
            # `count` keeps the same name so the existing graph.js doesn't break.
            # It represents total across sessions in merged files.
            "count": total_count,
            "total_count": total_count,
            "per_session_counts": per_counts,
            "support": support,
            "support_fraction": round(support / n_sessions, 3),
            "n_sessions": n_sessions,
            "is_primary": is_primary,
            "merged_step_id": merged_step,
            "per_session_step_ids": step_votes,
            "mean_normalized_onset": round(mean_norm_onset, 4),
            "raw_onsets": [round(t, 2) for t in raw_onsets],
            "mean_duration": round(mean_duration, 3),
            "min_duration": round(min_duration, 3),
            "max_duration": round(max_duration, 3),
        }
        if union_objects:
            node["objects"] = dict(union_objects)
        if union_verbs:
            node["verbs"] = dict(union_verbs)
        if per_session_node_salient[action]:
            node["salient"] = any(per_session_node_salient[action])

        merged_nodes.append(node)

    return merged_nodes, session_indices, session_durations


def aggregate_edges(session_payloads, session_indices, n_sessions):
    """Build aggregated edge list across all sessions."""
    per_session_edge_counts = defaultdict(dict)  # (src, dst) -> {si: count}
    per_session_edge_occurrences = defaultdict(lambda: defaultdict(list))  # (src,dst) -> si -> [idx]

    for si, payload in session_payloads:
        links = payload.get("graph", {}).get("links", [])
        for link in links:
            key = (link["source"], link["target"])
            per_session_edge_counts[key][si] = link.get("count", 0)
            per_session_edge_occurrences[key][si] = link.get("occurrences", [])

    # Pooled out-degree per source state, for merged Markov probabilities.
    out_totals = Counter()
    for (src, dst), by_session in per_session_edge_counts.items():
        out_totals[src] += sum(by_session.values())

    merged_links = []
    for (src, dst), by_session in per_session_edge_counts.items():
        per_counts = [by_session.get(si, 0) for si in session_indices]
        total_count = sum(per_counts)
        support = sum(1 for c in per_counts if c > 0)

        # Flatten occurrences across sessions but record which session each came from
        per_session_occ = {
            si: per_session_edge_occurrences[(src, dst)].get(si, [])
            for si in session_indices
        }

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
        })

    # Sort by total count descending, then alphabetical
    merged_links.sort(key=lambda l: (-l["total_count"], l["source"], l["target"]))
    return merged_links


# ─────────────────────────────────────────────────────────────────────────────
# Build merged payload for one mode
# ─────────────────────────────────────────────────────────────────────────────

def build_merged_payload(recipe_id, mode, session_payloads):
    """
    Build the merged JSON payload for one detail level.

    Note: merged files have no playable "sequence" (each session has its own
    timeline; concatenating them would create false transitions). Instead, the
    sequence field holds a flat list of all actions from all sessions, each
    tagged with its source session index. The frontend's small-multiples view
    will re-split by session; the merged-graph view will use only the nodes
    and links.
    """
    n_sessions = len(session_payloads)
    if n_sessions < 2:
        raise ValueError(
            f"Aggregation requires ≥2 sessions; {recipe_id} has {n_sessions}."
        )

    merged_nodes, session_indices, session_durations = aggregate_nodes(session_payloads)
    merged_links = aggregate_edges(session_payloads, session_indices, n_sessions)

    # Build the multi-session sequence (each item tagged with its session)
    multi_sequence = []
    for si, payload in session_payloads:
        seq = payload.get("sequence", [])
        L = max(len(seq) - 1, 1)
        for j, item in enumerate(seq):
            tagged = dict(item)
            tagged["session_index"] = si
            tagged["normalized_rank"] = round(j / L, 5)
            multi_sequence.append(tagged)

    # Recipe metadata — pull from first session, but mark as merged
    first_recipe_meta = session_payloads[0][1].get("recipe", {})
    steps = session_payloads[0][1].get("steps", [])

    # Build a session_info block so the frontend doesn't need to recompute
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
    }


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

MODES = ["full", "smart", "abstracted", "categorical", "hybrid"]


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
        print(f"  ✓ {out_path.name}")
        print(f"    {n_nodes} nodes ({support_3} in all sessions, "
              f"{support_1} in only one)")
        print(f"    {n_links} links")

    print("\n" + "=" * 80)
    print(f"DONE → {recipe_dir}/merged_*.json")
    print("Next: re-run `python 7_build_manifest.py` so the dashboard sees merged files.")
    print("=" * 80)


if __name__ == "__main__":
    main()