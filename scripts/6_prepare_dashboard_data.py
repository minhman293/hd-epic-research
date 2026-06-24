"""
6_prepare_dashboard_data.py

Step 6: Export dashboard data for D3 — parameterized by recipe ID, loops over
every capture (session) of that recipe, emits one set of JSON files per session.

Each action is tagged with `step_id` and `is_primary` based on whether its
time range overlaps any annotated `step_times` window in the recipe.

The "abstracted" (Task Phases) view now uses step_id as the phase identifier
(Path B), so it works universally across recipes without per-recipe hand-curation.

UPDATE (step labels): if outputs/step_labels.json exists (produced by
9_generate_step_labels.py), each step's short diagnostic label is attached to
the payload's `steps[].label` and to abstracted nodes' `step_label`. Missing
labels are non-fatal — the frontend falls back to the raw step id.

Usage:
  python 6_prepare_dashboard_data.py P01_R01
  python 6_prepare_dashboard_data.py P08_R01

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
    """
    Load the offline-generated step labels (9_generate_step_labels.py).
    Returns {step_id: label}. Missing file is non-fatal — we just fall back
    to step ids downstream, so the dashboard degrades gracefully.
    """
    labels_path = Path(outputs_dir) / "step_labels.json"
    if not labels_path.exists():
        # also try repo-root / current dir as a convenience
        for alt in (Path("step_labels.json"), Path("../step_labels.json")):
            if alt.exists():
                labels_path = alt
                break
    if not labels_path.exists():
        print("  ⚠ step_labels.json not found — steps will show raw ids (S01...).")
        return {}
    # Read defensively: the file may have been written with Windows-1252 smart
    # quotes (byte 0x92 etc.) rather than UTF-8. Try UTF-8 first, then fall back
    # to cp1252 so a curly apostrophe in a step's `raw` text can't crash us.
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
        print("  ⚠ Could not decode step_labels.json in any known encoding — "
              "steps will show raw ids (S01...).")
        return {}
    # accept either {sid: {"label": ...}} or {sid: "label"}
    out = {}
    for sid, val in raw.items():
        out[sid] = val["label"] if isinstance(val, dict) else val
    print(f"  ✓ Loaded {len(out)} step labels from {labels_path}")
    return out


def discover_sessions(recipe_meta, available_video_ids):
    """
    Each capture in the recipe metadata = one session. Returns:
        [{ "index": N, "video_id": ..., "capture": ... }, ...]
    Multi-video captures use only their first video for now.
    """
    captures = recipe_meta.get("captures", [])
    sessions = []
    available_set = set(available_video_ids)

    for ci, cap in enumerate(captures):
        videos = cap.get("videos", [])
        usable = [v for v in videos if v in available_set]
        if not usable:
            print(f"  ⚠ Capture {ci} has no videos available locally — skipping.")
            continue
        if len(videos) > 1:
            print(
                f"  ⚠ Capture {ci} spans {len(videos)} videos; "
                f"using only the first ({usable[0]}). "
                "Multi-video concatenation is deferred."
            )
        sessions.append({"index": ci, "video_id": usable[0], "capture": cap})
    return sessions


def collect_step_windows(capture, video_id, buffer_s=STEP_WINDOW_BUFFER_S):
    windows = []
    for step_id, time_entries in capture.get("step_times", {}).items():
        for entry in time_entries:
            if entry.get("video") == video_id:
                rs = float(entry["start"])
                re = float(entry["end"])
                windows.append((max(0.0, rs - buffer_s), re + buffer_s, step_id))
    windows.sort(key=lambda w: w[0])
    return windows


def find_overlapping_step(a_start, a_end, step_windows):
    best_step = None
    best_overlap = 0.0
    for w_start, w_end, sid in step_windows:
        overlap = min(a_end, w_end) - max(a_start, w_start)
        if overlap > best_overlap:
            best_overlap = overlap
            best_step = sid
    return best_step


def tag_actions_with_step_coverage(action_items, capture, video_id):
    step_windows = collect_step_windows(capture, video_id)
    if not step_windows:
        print(
            f"    ⚠ No step_times for {video_id}. All actions → primary."
        )
        for item in action_items:
            item["step_id"] = None
            item["is_primary"] = True
        return action_items

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
    return action_items


def compute_node_primary_majority(sequence):
    votes = defaultdict(lambda: [0, 0])
    for item in sequence:
        if item.get("is_primary"):
            votes[item["action"]][0] += 1
        else:
            votes[item["action"]][1] += 1
    return {a: p >= s for a, (p, s) in votes.items()}


def build_full_payload(data, recipe_id, recipe_meta, session, narrations_df,
                       step_labels=None, video_relative_dir="raw-video"):
    step_labels = step_labels or {}
    verb_classes = data["verb_classes"]
    noun_classes = data["noun_classes"]
    video_id = session["video_id"]
    capture = session["capture"]

    video_rows = narrations_df[narrations_df["video_id"] == video_id].copy()
    if video_rows.empty:
        raise ValueError(f"No narration rows for {video_id}")
    video_rows = video_rows.sort_values("start_timestamp")

    action_items = []
    for _, row in video_rows.iterrows():
        main_classes = row.get("main_action_classes", [])
        if not main_classes:
            continue
        v, n = main_classes[0]
        action_items.append({
            "action": get_action_name(v, n, verb_classes, noun_classes),
            "verb_class": int(v),
            "noun_class": int(n),
            "start": float(row["start_timestamp"]),
            "end": float(row["end_timestamp"]),
            "duration": float(row["end_timestamp"] - row["start_timestamp"]),
        })

    if len(action_items) < 2:
        raise ValueError(f"Session {session['index']} has <2 actions")

    tag_actions_with_step_coverage(action_items, capture, video_id)

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
            "label": step_labels.get(sid),   # may be None → frontend falls back
        }
        for sid, text in recipe_meta.get("steps", {}).items()
    ]

    return {
        "recipe": {
            "id": recipe_id,
            "name": recipe_meta.get("name", recipe_id),
            "session_index": session["index"],
            "video_id": video_id,
            "video_path": f"{video_relative_dir}/{video_id}.mp4",
            "narration_count": len(sequence),
        },
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
        m = seq_item.copy()
        # preserve the original verb-noun so downstream consumers (e.g. the HRI
        # duration budget) can recover the underlying action if needed.
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
    """
    Path B: phase = recipe step (step_id). Display label = local part only (S01).
    Actions outside any step → 'unassigned' node so they remain visible.
    """
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
            "step_label": step_label_lookup.get(raw_step),  # NEW: LLM/human label
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
        description="Build dashboard JSON files for one recipe, all its sessions."
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
        print(f"  Session {s['index']}: {s['video_id']}")

    output_dir = Path(args.outputs_dir) / "graphs" / recipe_id
    output_dir.mkdir(parents=True, exist_ok=True)

    for s in sessions:
        print(f"\n[Session {s['index']}: {s['video_id']}]")
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