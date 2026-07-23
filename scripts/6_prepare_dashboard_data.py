"""
6_prepare_dashboard_data.py

Step 6: Export dashboard data for D3 — one session per CAPTURE, stitching
all videos of a multi-video capture onto a unified capture timeline.

Detail-level modes produced per session (a granularity ladder):
  full         verb(noun) atomic nodes            (~40-420 nodes)
  smart        verb nodes, objects as attribute   (~30-80 nodes)
  hybrid       verb_key(noun_category) on primary (~15-40 nodes)  <- Markov view
               actions only (filters noise), with 
               explicit Start/End session anchors.
  categorical  verb-category nodes                (10-13 nodes)
  abstracted   recipe-step nodes                  (3-16 nodes)

Usage:
  python 6_prepare_dashboard_data.py P01_R01

Output layout:
  outputs/graphs/{recipe_id}/session_{N}_full.json
  outputs/graphs/{recipe_id}/session_{N}_smart.json
  outputs/graphs/{recipe_id}/session_{N}_abstracted.json
  outputs/graphs/{recipe_id}/session_{N}_categorical.json
  outputs/graphs/{recipe_id}/session_{N}_hybrid.json
"""

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

from utils import get_action_name, load_hd_epic_data


# ─────────────────────────────────────────────────────────────────────────────
# Tuning parameters
# ─────────────────────────────────────────────────────────────────────────────

STEP_WINDOW_BUFFER_S = 0

def load_recipe_context(recipe_id, outputs_dir="../outputs"):
    outputs_path = Path(outputs_dir)
    selected_path = outputs_path / f"selected_recipe_{recipe_id}.json"
    narrations_path = outputs_path / f"recipe_narrations_{recipe_id}.pkl"
    if not selected_path.exists():
        raise FileNotFoundError(
            f"Missing {selected_path}. "
            f"Run `python 2_recipe_selector.py {recipe_id}` first."
        )
    if not narrations_path.exists():
        raise FileNotFoundError(
            f"Missing {narrations_path}. "
            f"Run `python 2_recipe_selector.py {recipe_id}` first."
        )
    with open(selected_path, "r", encoding="utf-8") as f:
        selected_recipe = json.load(f)
    return selected_recipe, narrations_path


def load_step_labels(outputs_dir="../outputs"):
    labels_path = Path(outputs_dir) / "step_labels.json"
    if not labels_path.exists():
        for alt in (Path("step_labels.json"), Path("../step_labels.json")):
            if alt.exists():
                labels_path = alt
                break
    if not labels_path.exists():
        print("  ⚠ step_labels.json not found — steps will show raw ids (S01...).")
        return {}
    raw = None
    for enc in ("utf-8", "utf-8-sig", "cp1252"):
        try:
            with open(labels_path, "r", encoding=enc) as f:
                raw = json.load(f)
            if enc != "utf-8":
                print(f"  ⚠ step_labels.json was not UTF-8; read it as {enc}. "
                      f"Consider re-saving it as UTF-8.")
            break
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    if raw is None:
        print("  ⚠ Could not decode step_labels.json — falling back to raw ids.")
        return {}
    out = {}
    for sid, val in raw.items():
        out[sid] = val["label"] if isinstance(val, dict) else val
    print(f"  ✓ Loaded {len(out)} step labels from {labels_path}")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Multi-video stitching helpers
# ─────────────────────────────────────────────────────────────────────────────

def get_video_duration(vid, durations_map, narrations_df):
    """
    Get duration for a single video. Tries the CSV first; falls back to the
    max narration end_timestamp in that video.
    """
    if vid in durations_map:
        return float(durations_map[vid])
    fallback = narrations_df[narrations_df["video_id"] == vid]["end_timestamp"]
    if len(fallback) > 0:
        d = float(fallback.max())
        print(f"    ⚠ No CSV duration for {vid}; using narration-max ({d:.1f}s).")
        return d
    print(f"    ⚠ No duration available for {vid}; treating as 0s (gap).")
    return 0.0


def compute_video_layout(videos, durations_map, narrations_df):
    """
    Compute the unified-timeline layout for a capture's videos.

    Returns: list of dicts in playback order, each:
        {video_id, offset_s, duration_s}
    """
    layout = []
    cumulative = 0.0
    for vid in videos:
        d = get_video_duration(vid, durations_map, narrations_df)
        layout.append({
            "video_id": vid,
            "offset_s": cumulative,
            "duration_s": d,
        })
        cumulative += d
    return layout


def collect_windows_stitched(capture, video_layout, field, buffer_s=STEP_WINDOW_BUFFER_S):
    """Unified-timeline windows for step_times OR prep_times."""
    offsets = {v["video_id"]: v["offset_s"] for v in video_layout}
    windows = []
    for step_id, time_entries in (capture.get(field, {}) or {}).items():
        for entry in time_entries:
            vid = entry.get("video")
            if vid not in offsets:
                continue
            off = offsets[vid]
            u_start = max(0.0, float(entry["start"]) + off - buffer_s)
            u_end = float(entry["end"]) + off + buffer_s
            windows.append((u_start, u_end, step_id, vid,
                            float(entry["start"]), float(entry["end"])))
    windows.sort(key=lambda w: w[0])
    return windows


def collect_step_windows_stitched(capture, video_layout, buffer_s=STEP_WINDOW_BUFFER_S):
    return collect_windows_stitched(capture, video_layout, "step_times", buffer_s)


def find_overlapping_step(a_start, a_end, step_windows):
    best_step = None
    best_overlap = 0.0
    for w_start, w_end, sid, *_ in step_windows:
        overlap = min(a_end, w_end) - max(a_start, w_start)
        if overlap > best_overlap:
            best_overlap = overlap
            best_step = sid
    return best_step


def discover_sessions(recipe_meta, available_video_ids):
    """
    Each capture in the recipe metadata = one session, regardless of how many
    videos it contains. Multi-video captures are stitched downstream.
    """
    captures = recipe_meta.get("captures", [])
    sessions = []
    available_set = set(available_video_ids)

    for ci, cap in enumerate(captures):
        videos = cap.get("videos", [])
        in_narrations = [v for v in videos if v in available_set]
        if not in_narrations:
            print(f"  ⚠ Capture {ci} has no videos with narration data — skipping.")
            continue
        missing = [v for v in videos if v not in available_set]
        if missing:
            print(
                f"  ⚠ Capture {ci} has {len(missing)} video(s) without "
                f"narration data: {missing}. Keeping them as timeline gaps."
            )
        sessions.append({
            "index": ci,
            "videos": videos,
            "capture": cap,
        })
    return sessions


def compute_node_primary_majority(sequence):
    votes = defaultdict(lambda: [0, 0])
    for item in sequence:
        if item.get("is_primary"):
            votes[item["action"]][0] += 1
        else:
            votes[item["action"]][1] += 1
    return {a: p >= s for a, (p, s) in votes.items()}


def markov_links(sequence, key_field="action"):
    """
    Build directed edges with counts AND Markov transition probabilities from
    a sequence of state-mapped items. Self-loops are kept.

    P(B|A) = count(A->B) / out_degree(A); outgoing probabilities per node sum
    to 1.0 (Schodl et al. 2000).
    """
    edge_counts = Counter()
    edge_occurrences = defaultdict(list)
    out_degree = Counter()
    for idx in range(len(sequence)):
        current = sequence[idx][key_field]
        if idx < len(sequence) - 1:
            nxt = sequence[idx + 1][key_field]
            edge_counts[(current, nxt)] += 1
            edge_occurrences[f"{current}|||{nxt}"].append(idx)
            out_degree[current] += 1
    links = [
        {
            "source": src,
            "target": dst,
            "count": int(c),
            "probability": round(c / out_degree[src], 4) if out_degree[src] else 0.0,
            "key": f"{src}|||{dst}",
            "occurrences": edge_occurrences[f"{src}|||{dst}"],
        }
        for (src, dst), c in sorted(edge_counts.items(),
                                    key=lambda x: (-x[1], x[0][0], x[0][1]))
    ]
    return links


# ─────────────────────────────────────────────────────────────────────────────
# Payload builders
# ─────────────────────────────────────────────────────────────────────────────

def build_full_payload(data, recipe_id, recipe_meta, session, narrations_df,
                       step_labels=None, video_relative_dir="raw-video"):
    step_labels = step_labels or {}
    verb_classes = data["verb_classes"]
    noun_classes = data["noun_classes"]
    durations_map = data.get("video_durations", {})

    capture = session["capture"]
    videos = session["videos"]

    # 1. Unified-timeline layout for all videos in this capture
    video_layout = compute_video_layout(videos, durations_map, narrations_df)
    total_capture_duration = sum(v["duration_s"] for v in video_layout)

    # 2. Stitch narrations from all videos onto the unified timeline
    offsets = {v["video_id"]: v["offset_s"] for v in video_layout}

    action_items = []
    for vlayout in video_layout:
        vid = vlayout["video_id"]
        v_rows = narrations_df[narrations_df["video_id"] == vid].copy()
        if v_rows.empty:
            continue
        v_rows = v_rows.sort_values("start_timestamp")
        off = offsets[vid]
        for _, row in v_rows.iterrows():
            main_classes = row.get("main_action_classes", [])
            if not main_classes:
                continue
            cls = main_classes[0]
            if len(cls) >= 2:
                v, n = cls[0], cls[1]
            elif len(cls) == 1:
                v, n = cls[0], ""
            else:
                v, n = "unknown", ""
            v_start = float(row["start_timestamp"])
            v_end = float(row["end_timestamp"])
            action_items.append({
                "action": get_action_name(v, n, verb_classes, noun_classes),
                "verb_class": int(v) if str(v).isdigit() else -1,
                "noun_class": int(n) if str(n).isdigit() else -1,
                "start": v_start + off,
                "end": v_end + off,
                "duration": v_end - v_start,
                "video_id": vid,
                "video_start": v_start,
                "video_end": v_end,
            })

    action_items.sort(key=lambda r: r["start"])

    if len(action_items) < 2:
        raise ValueError(f"Session {session['index']} has <2 actions")

    # 3. Step windows on the unified timeline
    step_windows = collect_step_windows_stitched(capture, video_layout)
    prep_windows = collect_windows_stitched(capture, video_layout, "prep_times")

    # 4. Tag each action with its overlapping step
    if not step_windows and not prep_windows:
        print(f"    ⚠ No step_times for capture {session['index']}. All actions → primary.")
        for item in action_items:
            item["step_id"] = None
            item["is_primary"] = True
            item["phase"] = None
    else:
        for item in action_items:
            sid = find_overlapping_step(item["start"], item["end"], step_windows)
            if sid is not None:
                item["step_id"] = sid
                item["is_primary"] = True
                item["phase"] = "exec"
            else:
                pid = find_overlapping_step(item["start"], item["end"], prep_windows)
                item["step_id"] = pid            # may be None
                item["is_primary"] = False        # UNCHANGED semantics
                item["phase"] = "prep" if pid is not None else None
        primary = sum(1 for a in action_items if a["is_primary"])
        secondary = len(action_items) - primary
        print(
            f"    Step-coverage: {primary} primary, {secondary} secondary "
            f"({100 * secondary / len(action_items):.1f}% secondary)"
        )

    # 5. Nodes/edges + sequence
    node_counts = Counter(item["action"] for item in action_items)
    sequence = []
    for idx, item in enumerate(action_items):
        current = item["action"]
        next_action = action_items[idx + 1]["action"] if idx < len(action_items) - 1 else None
        edge_key = f"{current}|||{next_action}" if next_action else None
        sequence.append({
            "index": idx,
            "action": current,
            "start": item["start"],
            "end": item["end"],
            "duration": item["duration"],
            "next_action": next_action,
            "edge_key": edge_key,
            "step_id": item.get("step_id"),
            "is_primary": item.get("is_primary", True),
            "phase": item.get("phase"),
            "verb_class": item.get("verb_class", -1),
            "noun_class": item.get("noun_class", -1),
            "video_id": item["video_id"],
            "video_start": item["video_start"],
            "video_end": item["video_end"],
        })

    node_primary = compute_node_primary_majority(sequence)
    nodes = [
        {"id": a, "count": int(c), "is_primary": bool(node_primary.get(a, True))}
        for a, c in sorted(node_counts.items(), key=lambda x: (-x[1], x[0]))
    ]
    links = markov_links(sequence)
    step_text = [
        {
            "id": sid,
            "text": text.strip(),
            "label": step_labels.get(sid),
        }
        for sid, text in recipe_meta.get("steps", {}).items()
    ]

    step_ids = {step["id"] for step in step_text}
    prep_gaps_by_step = defaultdict(list)
    exec_windows_by_step = defaultdict(list)
    for s_start, s_end, sid, *_ in step_windows:
        exec_windows_by_step[sid].append((s_start, s_end))
    for p_start, p_end, sid, *_ in prep_windows:
        if sid not in step_ids:
            continue
        future_exec_starts = [s for s, _ in exec_windows_by_step.get(sid, []) if s >= p_end]
        if not future_exec_starts:
            continue
        exec_start = min(future_exec_starts)
        prep_gaps_by_step[sid].append({
            "prep_end": round(p_end, 3),
            "exec_start": round(exec_start, 3),
            "gap": round(exec_start - p_end, 3),
        })

    for step in step_text:
        step["prep_gaps"] = prep_gaps_by_step.get(step["id"], [])

    videos_payload = [
        {
            "video_id": v["video_id"],
            "video_path": f"{video_relative_dir}/{v['video_id']}.mp4",
            "offset_s": v["offset_s"],
            "duration_s": v["duration_s"],
        }
        for v in video_layout
    ]

    first_video = videos[0] if videos else None

    return {
        "recipe": {
            "id": recipe_id,
            "name": recipe_meta.get("name", recipe_id),
            "session_index": session["index"],
            "video_id": first_video,
            "video_path": f"{video_relative_dir}/{first_video}.mp4" if first_video else None,
            "narration_count": len(sequence),
            "n_videos": len(video_layout),
            "total_capture_duration_s": total_capture_duration,
        },
        "videos": videos_payload,
        "steps": step_text,
        "step_windows": (
            [{"step_id": sid, "start": s, "end": e, "phase": "exec"}
             for (s, e, sid, *_ ) in step_windows]
          + [{"step_id": sid, "start": s, "end": e, "phase": "prep"}
             for (s, e, sid, *_ ) in prep_windows]
        ),
        "sequence": sequence,
        "graph": {"nodes": nodes, "links": links},
    }


def create_smart_merged_graph(payload):
    def vof(a): return a.split("(")[0] if "(" in a else a
    def nof(a):
        rest = a[len(vof(a)):]
        return rest[1:-1] if rest.startswith("(") and rest.endswith(")") else ""

    merged_sequence = []
    verb_objects = defaultdict(Counter)
    for seq_item in payload["sequence"]:
        verb = vof(seq_item["action"])
        noun = nof(seq_item["action"])
        if noun:
            verb_objects[verb][noun] += 1
        m = seq_item.copy()
        m["raw_action"] = seq_item["action"]
        m["action"] = verb
        merged_sequence.append(m)

    node_counts = Counter(item["action"] for item in merged_sequence)
    node_primary = compute_node_primary_majority(merged_sequence)
    nodes = [
        {"id": a, "count": int(c),
         "is_primary": bool(node_primary.get(a, True)),
         "objects": dict(verb_objects[a]) if a in verb_objects else {}}
        for a, c in sorted(node_counts.items(), key=lambda x: (-x[1], x[0]))
    ]
    links = markov_links(merged_sequence)

    result = payload.copy()
    result["sequence"] = merged_sequence
    result["graph"] = {"nodes": nodes, "links": links}
    return result


def create_abstracted_graph(payload):
    UNASSIGNED = "unassigned"
    step_text_lookup = {step["id"]: step["text"] for step in payload.get("steps", [])}
    step_label_lookup = {step["id"]: step.get("label") for step in payload.get("steps", [])}

    abstracted_sequence = []
    for seq_item in payload["sequence"]:
        raw_step = seq_item.get("step_id") or UNASSIGNED
        if raw_step == UNASSIGNED:
            display = UNASSIGNED
        else:
            parts = raw_step.rsplit("_", 1)
            display = parts[1] if len(parts) == 2 and parts[1].startswith("S") else raw_step
        m = seq_item.copy()
        m["action"] = display
        m["raw_action"] = seq_item["action"]
        m["raw_step_id"] = raw_step
        abstracted_sequence.append(m)

    node_counts = Counter(item["action"] for item in abstracted_sequence)
    step_actions = defaultdict(Counter)
    for item in abstracted_sequence:
        step_actions[item["action"]][item["raw_action"]] += 1

    node_primary = compute_node_primary_majority(abstracted_sequence)

    def sort_key(node_id):
        return (1, "") if node_id == UNASSIGNED else (0, node_id)

    nodes = []
    for display_step in sorted(node_counts.keys(), key=sort_key):
        raw_step = None
        step_text = None
        for item in abstracted_sequence:
            if item["action"] == display_step:
                raw_step = item["raw_step_id"]
                step_text = step_text_lookup.get(raw_step)
                break
        nodes.append({
            "id": display_step,
            "count": int(node_counts[display_step]),
            "is_primary": bool(node_primary.get(display_step, True)),
            "step_id": raw_step,
            "step_text": step_text,
            "step_label": step_label_lookup.get(raw_step),
            "raw_actions": dict(step_actions[display_step]),
        })

    links = markov_links(abstracted_sequence)

    result = payload.copy()
    result["sequence"] = abstracted_sequence
    result["graph"] = {"nodes": nodes, "links": links}
    return result


def create_categorical_graph(payload, verb_classes, noun_classes):
    """
    Nodes = the 13 HD-EPIC verb categories. Pure observation-driven Markov
    chain; recipe-blind by construction (kept as the "what kind of action?"
    analytical view).
    """
    UNKNOWN = "unknown"
    verb_id_to_cat = dict(zip(verb_classes['id'].astype(int), verb_classes['category']))
    verb_id_to_key = dict(zip(verb_classes['id'].astype(int), verb_classes['key']))
    noun_id_to_cat = dict(zip(noun_classes['id'].astype(int), noun_classes['category']))
    noun_id_to_key = dict(zip(noun_classes['id'].astype(int), noun_classes['key']))

    categorical_sequence = []
    for seq_item in payload["sequence"]:
        v_id = seq_item.get("verb_class", -1)
        category = verb_id_to_cat.get(v_id, UNKNOWN) if v_id >= 0 else UNKNOWN
        m = seq_item.copy()
        m["raw_action"] = seq_item["action"]
        m["action"] = category
        categorical_sequence.append(m)

    node_counts = Counter(item["action"] for item in categorical_sequence)
    node_objects = defaultdict(Counter)
    node_verbs = defaultdict(Counter)
    node_noun_categories = defaultdict(Counter)

    for item in categorical_sequence:
        cat = item["action"]
        v_id = item.get("verb_class", -1)
        n_id = item.get("noun_class", -1)
        if v_id >= 0:
            node_verbs[cat][verb_id_to_key.get(v_id, str(v_id))] += 1
        if n_id >= 0:
            node_objects[cat][noun_id_to_key.get(n_id, str(n_id))] += 1
            node_noun_categories[cat][noun_id_to_cat.get(n_id, UNKNOWN)] += 1

    node_primary = compute_node_primary_majority(categorical_sequence)
    nodes = [
        {
            "id": cat,
            "count": int(c),
            "is_primary": bool(node_primary.get(cat, True)),
            "verb_category": cat,
            "objects": dict(node_objects[cat]),
            "verbs": dict(node_verbs[cat]),
            "noun_categories": dict(node_noun_categories[cat]),
        }
        for cat, c in sorted(node_counts.items(), key=lambda x: (-x[1], x[0]))
    ]
    links = markov_links(categorical_sequence)

    result = payload.copy()
    result["sequence"] = categorical_sequence
    result["graph"] = {"nodes": nodes, "links": links}
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Hybrid mode (verb_key(noun_category) focused on primary recipe steps)
# ─────────────────────────────────────────────────────────────────────────────

def _compute_dead_end_scores(hybrid_sequence, nodes):
    """
    Video Textures analog of 'anticipated future cost' at the semantic level.
    dead_end_score(n) = 1 - max P(n -> t) for t not being an END token.
    High score  =  most transitions out of n lead to termination.
    """
    trans = Counter()
    out_total = Counter()
    for a, b in zip(hybrid_sequence[:-1], hybrid_sequence[1:]):
        s, t = a["action"], b["action"]
        trans[(s, t)] += 1
        out_total[s] += 1

    per_node = {}
    for n in nodes:
        nid = n["id"]
        max_non_end = 0.0
        for (s, t), c in trans.items():
            if s != nid:
                continue
            if t.startswith("End:"):
                continue
            p = c / out_total[s] if out_total[s] else 0.0
            if p > max_non_end:
                max_non_end = p
        per_node[nid] = round(1.0 - max_non_end, 3) if out_total[nid] else 1.0
    return per_node


def _find_self_loops(hybrid_sequence):
    """Nodes where two consecutive sequence items land on the same identity."""
    loops = Counter()
    for a, b in zip(hybrid_sequence[:-1], hybrid_sequence[1:]):
        if a["action"] == b["action"]:
            loops[a["action"]] += 1
    return dict(loops)


def create_hybrid_graph(payload, recipe_meta, verb_classes, noun_classes, use_category_for_verb=False):
    UNKNOWN = "unknown"
    
    if use_category_for_verb:
        verb_mapping = dict(zip(verb_classes["id"].astype(int), verb_classes["category"]))
    else:
        verb_mapping = dict(zip(verb_classes["id"].astype(int), verb_classes["key"]))
        
    noun_id_to_cat = dict(zip(noun_classes["id"].astype(int), noun_classes["category"]))

    hybrid_sequence = []
    
    # ── Pipeline 1: Full Sequence (For Swimlane/Barcode) ────────────────
    for seq_item in payload["sequence"]:
        v_id = seq_item.get("verb_class", -1)
        n_id = seq_item.get("noun_class", -1)
        
        v_str = verb_mapping.get(v_id, UNKNOWN) if v_id >= 0 else UNKNOWN
        n_cat = noun_id_to_cat.get(n_id, UNKNOWN) if n_id >= 0 else UNKNOWN 
        
        state = f"{v_str}({n_cat})"
        
        m = seq_item.copy()
        m["raw_action"] = seq_item["action"]
        m["action"] = state
        m["salient"] = True
        m["kind"] = "action"
        hybrid_sequence.append(m)

    # Inject pure START and END into the FULL sequence
    if hybrid_sequence:
        t0 = hybrid_sequence[0]["start"]
        t1 = hybrid_sequence[-1]["end"]
        
        start_item = {
            "action": "START", "raw_action": "START",
            "start": max(0.0, t0 - 0.001), "end": t0, "duration": 0.0,
            "step_id": None, "is_primary": True, "phase": None,
            "verb_class": -1, "noun_class": -1,
            "video_id": hybrid_sequence[0].get("video_id"),
            "video_start": 0.0, "video_end": 0.0,
            "salient": False, "kind": "start",
        }
        end_item = {
            "action": "END", "raw_action": "END",
            "start": t1, "end": t1 + 0.001, "duration": 0.0,
            "step_id": None, "is_primary": True, "phase": None,
            "verb_class": -1, "noun_class": -1,
            "video_id": hybrid_sequence[-1].get("video_id"),
            "video_start": 0.0, "video_end": 0.0,
            "salient": False, "kind": "end",
        }
        
        hybrid_sequence = [start_item] + hybrid_sequence + [end_item]
        
        for i in range(len(hybrid_sequence)):
            hybrid_sequence[i]["index"] = i
            if i < len(hybrid_sequence) - 1:
                hybrid_sequence[i]["next_action"] = hybrid_sequence[i+1]["action"]
                hybrid_sequence[i]["edge_key"] = f'{hybrid_sequence[i]["action"]}|||{hybrid_sequence[i+1]["action"]}'
            else:
                hybrid_sequence[i]["next_action"] = None
                hybrid_sequence[i]["edge_key"] = None

    # ── Pipeline 2: Primary Sequence (For Motion Graph) ─────────────────
    primary_sequence = [item.copy() for item in hybrid_sequence if item.get("is_primary", True)]
    
    for i in range(len(primary_sequence)):
        if i < len(primary_sequence) - 1:
            primary_sequence[i]["next_action"] = primary_sequence[i+1]["action"]
            primary_sequence[i]["edge_key"] = f'{primary_sequence[i]["action"]}|||{primary_sequence[i+1]["action"]}'
        else:
            primary_sequence[i]["next_action"] = None
            primary_sequence[i]["edge_key"] = None

    node_counts = Counter(item["action"] for item in primary_sequence)
    node_objects = defaultdict(Counter)
    node_verbs = defaultdict(Counter)
    node_kind = {item["action"]: item.get("kind", "action") for item in primary_sequence}

    noun_id_to_key = dict(zip(noun_classes["id"].astype(int), noun_classes["key"]))
    verb_id_to_key = dict(zip(verb_classes["id"].astype(int), verb_classes["key"]))
    
    for item in primary_sequence:
        state = item["action"]
        if state == "START" or state == "END":
            continue
        v_id = item.get("verb_class", -1)
        n_id = item.get("noun_class", -1)
        if v_id >= 0:
            node_verbs[state][verb_id_to_key.get(v_id, str(v_id))] += 1
        if n_id >= 0:
            node_objects[state][noun_id_to_key.get(n_id, str(n_id))] += 1

    nodes = []
    for state, c in sorted(node_counts.items(), key=lambda x: (-x[1], x[0])):
        kind = node_kind.get(state, "action")
        nodes.append({
            "id": state, "count": int(c), "is_primary": True,
            "salient": True if kind == "action" else False,
            "objects": dict(node_objects.get(state, {})),
            "verbs": dict(node_verbs.get(state, {})),
            "kind": kind, "is_start": kind == "start", "is_end": kind == "end",
        })

    dead_scores = _compute_dead_end_scores(primary_sequence, nodes)
    for n in nodes:
        n["dead_end_score"] = dead_scores.get(n["id"], 0.0)
        
    self_loops = _find_self_loops(primary_sequence)
    links = markov_links(primary_sequence)

    result = payload.copy()
    result["sequence"] = hybrid_sequence
    result["graph"] = {"nodes": nodes, "links": links}
    result["analysis"] = {
        "dead_ends": [{"id": n["id"], "score": n["dead_end_score"]} for n in sorted(nodes, key=lambda x: -x["dead_end_score"]) if n["kind"] == "action" and n["dead_end_score"] >= 0.5][:10],
        "self_loops": [{"id": nid, "count": c} for nid, c in sorted(self_loops.items(), key=lambda x: -x[1])],
        "start_id": "START" if primary_sequence else None,
        "end_id": "END" if primary_sequence else None,
    }
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Build dashboard JSON files for one recipe, one session per capture."
    )
    parser.add_argument("recipe_id", help="Recipe ID (e.g. P01_R01)")
    parser.add_argument("--outputs-dir", default="../outputs")
    parser.add_argument("--video-relative-dir", default="raw-video")
    args = parser.parse_args()

    recipe_id = args.recipe_id
    print("=" * 80)
    print(f"BUILDING DASHBOARD DATA FOR {recipe_id}")
    print("=" * 80)

    selected_recipe, narrations_path = load_recipe_context(recipe_id, args.outputs_dir)
    data = load_hd_epic_data("..")
    step_labels = load_step_labels(args.outputs_dir)
    recipe_narrations = pd.read_pickle(narrations_path)

    recipe_meta = selected_recipe.get("recipe_data", {})
    available_videos = selected_recipe.get("video_ids", [])
    sessions = discover_sessions(recipe_meta, available_videos)
    if not sessions:
        raise RuntimeError(f"No usable sessions for {recipe_id}")

    print(f"\nFound {len(sessions)} session(s):")
    for s in sessions:
        n_vids = len(s["videos"])
        if n_vids == 1:
            print(f"  Session {s['index']}: 1 video — {s['videos'][0]}")
        else:
            print(f"  Session {s['index']}: {n_vids} videos — {s['videos']}")

    output_dir = Path(args.outputs_dir) / "graphs" / recipe_id
    output_dir.mkdir(parents=True, exist_ok=True)

    # Phase 1: full payloads for every session
    payload_fulls = []
    for s in sessions:
        print(f"\n[Session {s['index']}] building full payload")
        payload_fulls.append(build_full_payload(
            data, recipe_id, recipe_meta, s, recipe_narrations,
            step_labels=step_labels, video_relative_dir=args.video_relative_dir,
        ))

    # Phase 2: per-session mode files
    for s, payload_full in zip(sessions, payload_fulls):
        print(f"\n[Session {s['index']}]")
        payload_smart = create_smart_merged_graph(payload_full)
        payload_abstracted = create_abstracted_graph(payload_full)
        payload_categorical = create_categorical_graph(
            payload_full, data["verb_classes"], data["noun_classes"]
        )
        payload_hybrid = create_hybrid_graph(
            payload_full, recipe_meta,
            data["verb_classes"], data["noun_classes"], use_category_for_verb=False
        )
        payload_hybrid_cat = create_hybrid_graph(
            payload_full, recipe_meta,
            data["verb_classes"], data["noun_classes"], use_category_for_verb=True
        )

        for filename, payload, label in [
            (f"session_{s['index']}_full.json", payload_full, "Full Raw"),
            (f"session_{s['index']}_smart.json", payload_smart, "Smart-Merged"),
            (f"session_{s['index']}_abstracted.json", payload_abstracted, "Abstracted"),
            (f"session_{s['index']}_categorical.json", payload_categorical, "Categorical"),
            (f"session_{s['index']}_hybrid.json", payload_hybrid, "Hybrid (verb_key)"),
            (f"session_{s['index']}_hybrid_cat.json", payload_hybrid_cat, "Hybrid (verb_cat)"),
        ]:
            out_path = output_dir / filename
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            n = len(payload["graph"]["nodes"])
            pri = sum(1 for x in payload["graph"]["nodes"] if x.get("is_primary"))
            print(f"  ✓ {label:<16} {out_path.name}  "
                  f"({len(payload['sequence'])} actions, {n} nodes, {pri} primary)")

    print("\n" + "=" * 80)
    print(f"DONE → {output_dir}/")
    print("Next: run `python 7_build_manifest.py` to refresh the manifest.")
    print("=" * 80)


if __name__ == "__main__":
    main()