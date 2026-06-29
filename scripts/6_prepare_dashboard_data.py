"""
6_prepare_dashboard_data.py

Step 6: Export dashboard data for D3 — one session per CAPTURE, stitching
all videos of a multi-video capture onto a unified capture timeline.

Each action carries:
  - start, end        — unified capture timeline (sums of preceding video durations)
  - video_id          — which source video this action came from
  - video_start, end  — within-video timestamps (= unified − offset_of_that_video)
  - step_id           — recipe step whose stitched window this action overlaps
  - is_primary        — True iff step_id is set

The payload also contains a "videos" array listing each video's offset and
duration on the unified timeline, so the frontend can map any unified
timestamp back to {video_id, within_video_offset} and drive the player.

Usage:
  python 6_prepare_dashboard_data.py P01_R01
  python 6_prepare_dashboard_data.py P05_R01

Output layout:
  outputs/graphs/{recipe_id}/session_{N}_smart.json
  outputs/graphs/{recipe_id}/session_{N}_full.json
  outputs/graphs/{recipe_id}/session_{N}_abstracted.json
"""

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

from utils import get_action_name, load_hd_epic_data


# ─────────────────────────────────────────────────────────────────────────────
# Tuning parameter — see earlier research notes on step-window buffering.
# 0 = strict (only annotated step moments count as primary)
# 10–30 = moderate (catches immediate setup/wrap-up around each step)
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


def collect_step_windows_stitched(capture, video_layout, buffer_s=STEP_WINDOW_BUFFER_S):
    """
    Returns step windows on the unified capture timeline. Each entry:
        (unified_start, unified_end, step_id, video_id, video_start, video_end)

    Step entries whose 'video' field doesn't match any video in this capture
    are silently skipped (they belong to a different capture).
    """
    offsets = {v["video_id"]: v["offset_s"] for v in video_layout}
    windows = []
    for step_id, time_entries in capture.get("step_times", {}).items():
        for entry in time_entries:
            vid = entry.get("video")
            if vid not in offsets:
                continue
            off = offsets[vid]
            v_start = float(entry["start"])
            v_end = float(entry["end"])
            u_start = max(0.0, v_start + off - buffer_s)
            u_end = v_end + off + buffer_s
            windows.append((u_start, u_end, step_id, vid, v_start, v_end))
    windows.sort(key=lambda w: w[0])
    return windows


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

    A capture is skipped only if NONE of its videos appear in the narration
    data; videos that are listed in the capture but have no narrations are
    kept (they'll show up as gaps in the timeline).
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

    # 1. Compute the unified-timeline layout for all videos in this capture
    video_layout = compute_video_layout(videos, durations_map, narrations_df)
    total_capture_duration = sum(v["duration_s"] for v in video_layout)

    # 2. Stitch narrations from all videos in this capture onto a unified timeline
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
                "start": v_start + off,        # unified
                "end": v_end + off,            # unified
                "duration": v_end - v_start,
                "video_id": vid,
                "video_start": v_start,        # within-video
                "video_end": v_end,            # within-video
            })

    # Sort by unified start. Within each video the rows were already sorted,
    # and videos were appended in playback order, so this is effectively a
    # stability check.
    action_items.sort(key=lambda r: r["start"])

    if len(action_items) < 2:
        raise ValueError(f"Session {session['index']} has <2 actions")

    # 3. Build step windows on the unified timeline
    step_windows = collect_step_windows_stitched(capture, video_layout)

    # 4. Tag each action with its overlapping step
    if not step_windows:
        print(f"    ⚠ No step_times for capture {session['index']}. All actions → primary.")
        for item in action_items:
            item["step_id"] = None
            item["is_primary"] = True
    else:
        for item in action_items:
            sid = find_overlapping_step(item["start"], item["end"], step_windows)
            item["step_id"] = sid
            item["is_primary"] = sid is not None
        primary = sum(1 for a in action_items if a["is_primary"])
        secondary = len(action_items) - primary
        print(
            f"    Step-coverage: {primary} primary, {secondary} secondary "
            f"({100 * secondary / len(action_items):.1f}% secondary)"
        )

    # 5. Build node/edge counts and the sequence array
    node_counts = Counter(item["action"] for item in action_items)
    edge_counts = Counter()
    edge_occurrences = defaultdict(list)
    sequence = []
    for idx, item in enumerate(action_items):
        current = item["action"]
        next_action = action_items[idx + 1]["action"] if idx < len(action_items) - 1 else None
        edge_key = None
        if next_action:
            edge_counts[(current, next_action)] += 1
            edge_key = f"{current}|||{next_action}"
            edge_occurrences[edge_key].append(idx)
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
            # Per-video provenance — frontend uses these to drive playback.
            "video_id": item["video_id"],
            "video_start": item["video_start"],
            "video_end": item["video_end"],
        })

    node_primary = compute_node_primary_majority(sequence)
    nodes = [
        {"id": a, "count": int(c), "is_primary": bool(node_primary.get(a, True))}
        for a, c in sorted(node_counts.items(), key=lambda x: (-x[1], x[0]))
    ]
    links = [
        {"source": src, "target": dst, "count": int(c),
         "key": f"{src}|||{dst}",
         "occurrences": edge_occurrences[f"{src}|||{dst}"]}
        for (src, dst), c in sorted(edge_counts.items(), key=lambda x: (-x[1], x[0][0], x[0][1]))
    ]
    step_text = [
        {
            "id": sid,
            "text": text.strip(),
            "label": step_labels.get(sid),
        }
        for sid, text in recipe_meta.get("steps", {}).items()
    ]

    # 6. Per-video payload block: tells the frontend how to drive the <video> element
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
            # Legacy fields point to the FIRST video so older frontends that
            # haven't been updated yet don't blow up — they just see video 1.
            # New frontends should use the "videos" array below instead.
            "video_id": first_video,
            "video_path": f"{video_relative_dir}/{first_video}.mp4" if first_video else None,
            "narration_count": len(sequence),
            "n_videos": len(video_layout),
            "total_capture_duration_s": total_capture_duration,
        },
        "videos": videos_payload,
        "steps": step_text,
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
        m = seq_item.copy()  # preserves video_id, video_start, video_end
        m["raw_action"] = seq_item["action"]
        m["action"] = verb
        merged_sequence.append(m)

    node_counts = Counter(item["action"] for item in merged_sequence)
    edge_counts = Counter()
    edge_occurrences = defaultdict(list)
    for idx, item in enumerate(merged_sequence):
        current = item["action"]
        next_action = merged_sequence[idx + 1]["action"] if idx < len(merged_sequence) - 1 else None
        if next_action:
            edge_counts[(current, next_action)] += 1
            edge_occurrences[f"{current}|||{next_action}"].append(idx)

    node_primary = compute_node_primary_majority(merged_sequence)
    nodes = [
        {"id": a, "count": int(c),
         "is_primary": bool(node_primary.get(a, True)),
         "objects": dict(verb_objects[a]) if a in verb_objects else {}}
        for a, c in sorted(node_counts.items(), key=lambda x: (-x[1], x[0]))
    ]
    links = [
        {"source": src, "target": dst, "count": int(c),
         "key": f"{src}|||{dst}",
         "occurrences": edge_occurrences[f"{src}|||{dst}"]}
        for (src, dst), c in sorted(edge_counts.items(), key=lambda x: (-x[1], x[0][0], x[0][1]))
    ]

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
        m = seq_item.copy()  # preserves video_id, video_start, video_end
        m["action"] = display
        m["raw_action"] = seq_item["action"]
        m["raw_step_id"] = raw_step
        abstracted_sequence.append(m)

    node_counts = Counter(item["action"] for item in abstracted_sequence)
    edge_counts = Counter()
    edge_occurrences = defaultdict(list)
    step_actions = defaultdict(Counter)
    for idx, item in enumerate(abstracted_sequence):
        step_actions[item["action"]][item["raw_action"]] += 1
        current = item["action"]
        next_action = abstracted_sequence[idx + 1]["action"] if idx < len(abstracted_sequence) - 1 else None
        if next_action:
            edge_counts[(current, next_action)] += 1
            edge_occurrences[f"{current}|||{next_action}"].append(idx)

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

    links = [
        {"source": src, "target": dst, "count": int(c),
         "key": f"{src}|||{dst}",
         "occurrences": edge_occurrences[f"{src}|||{dst}"]}
        for (src, dst), c in sorted(edge_counts.items(), key=lambda x: (-x[1], x[0][0], x[0][1]))
    ]

    result = payload.copy()
    result["sequence"] = abstracted_sequence
    result["graph"] = {"nodes": nodes, "links": links}
    return result


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

    for s in sessions:
        print(f"\n[Session {s['index']}]")
        payload_full = build_full_payload(
            data, recipe_id, recipe_meta, s, recipe_narrations,
            step_labels=step_labels,
            video_relative_dir=args.video_relative_dir,
        )
        payload_smart = create_smart_merged_graph(payload_full)
        payload_abstracted = create_abstracted_graph(payload_full)

        for filename, payload, label in [
            (f"session_{s['index']}_full.json", payload_full, "Full Raw"),
            (f"session_{s['index']}_smart.json", payload_smart, "Smart-Merged"),
            (f"session_{s['index']}_abstracted.json", payload_abstracted, "Abstracted"),
        ]:
            out_path = output_dir / filename
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            n = len(payload["graph"]["nodes"])
            pri = sum(1 for x in payload["graph"]["nodes"] if x.get("is_primary"))
            print(f"  ✓ {label:<14} {out_path.name}  "
                  f"({len(payload['sequence'])} actions, {n} nodes, {pri} primary)")

    print("\n" + "=" * 80)
    print(f"DONE → {output_dir}/")
    print("Next: run `python 7_build_manifest.py` to refresh the manifest.")
    print("=" * 80)


if __name__ == "__main__":
    main()