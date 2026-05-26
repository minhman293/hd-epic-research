"""
Step 6: Export single-recipe dashboard data for D3 (Coffee P08_R01)
Generates three versions: full raw, smart-merged, and abstracted task phases.

Each action is tagged with `step_id` and `is_primary` based on whether its
time range overlaps any annotated `step_times` window in the recipe.
This replaces the previous manual ACTION_TO_PHASE lane-assignment table.
"""

import json
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

from utils import get_action_name, load_hd_epic_data


RECIPE_ID = "P08_R01"
VIDEO_ID = "P08-20240613-122900"
VIDEO_RELATIVE_PATH = "raw-video/P08-20240613-122900.mp4"

# ─────────────────────────────────────────────────────────────────────────────
# STEP_WINDOW_BUFFER_S: seconds to extend each step_times window on each side.
#
# HD-EPIC step_times annotate only the *core moments* of each recipe step, not
# the full preparation around them. A buffer of 0 means an action like
# scoop(coffee) at t=30s gets classified as secondary if it sits between two
# narrow annotated windows. Increasing the buffer is a methodological choice
# to be documented in the paper.
#
# Recommended starting values:
#   0    — strict: only annotated moments count as primary (sparse lane)
#   15   — light: catches immediate setup/wrap-up around each step
#   30   — moderate: most recipe-adjacent actions classified as primary
#   60   — generous: nearly everything in the recipe time range is primary
# ─────────────────────────────────────────────────────────────────────────────
STEP_WINDOW_BUFFER_S = 0


def load_recipe_context(outputs_dir="../outputs", recipe_id=RECIPE_ID):
    outputs_path = Path(outputs_dir)
    selected_path = outputs_path / f"selected_recipe_{recipe_id}.json"
    narrations_path = outputs_path / f"recipe_narrations_{recipe_id}.pkl"

    if not selected_path.exists():
        raise FileNotFoundError(
            f"Missing {selected_path}. Run 2_recipe_selector.py first."
        )
    if not narrations_path.exists():
        raise FileNotFoundError(
            f"Missing {narrations_path}. Run 2_recipe_selector.py first."
        )

    with open(selected_path, "r", encoding="utf-8") as f:
        selected_recipe = json.load(f)

    return selected_recipe, narrations_path


# ─────────────────────────────────────────────────────────────────────────────
# STEP-COVERAGE TAGGING (replaces manual ACTION_TO_PHASE for lane assignment)
# ─────────────────────────────────────────────────────────────────────────────

def collect_step_windows(recipe_data, video_id, buffer_s=STEP_WINDOW_BUFFER_S):
    """
    Pull all (start, end, step_id) tuples for the given video out of the
    recipe's `step_times` annotations. Each window is extended by `buffer_s`
    seconds on each side (clamped to 0 on the lower bound).

    Each recipe entry in complete_recipes.json has a `captures` list, and each
    capture has a `step_times` dict mapping step_id -> [{video, start, end}, ...].
    A single step can span multiple disjoint time windows in the same video.

    HD-EPIC annotators marked only the *core moments* of each step, so a
    buffer of a few tens of seconds is usually needed to capture immediate
    setup and wrap-up actions around each step. The buffer value is a tuning
    parameter (see STEP_WINDOW_BUFFER_S at the top of this file).
    """
    windows = []
    for capture in recipe_data.get("captures", []):
        for step_id, time_entries in capture.get("step_times", {}).items():
            for entry in time_entries:
                if entry.get("video") == video_id:
                    raw_start = float(entry["start"])
                    raw_end = float(entry["end"])
                    windows.append((
                        max(0.0, raw_start - buffer_s),
                        raw_end + buffer_s,
                        step_id,
                    ))
    windows.sort(key=lambda w: w[0])
    return windows


def find_overlapping_step(action_start, action_end, step_windows):
    """
    Return the step_id whose time window has the largest temporal overlap
    with this action. Returns None if the action overlaps no step window.

    We pick max-overlap rather than first-overlap because step windows can
    overlap each other (annotators sometimes mark a transition as belonging
    to both steps), and we want the action assigned to the step it spent
    the most time inside.
    """
    best_step = None
    best_overlap = 0.0

    for w_start, w_end, step_id in step_windows:
        # Compute overlap length
        overlap_start = max(action_start, w_start)
        overlap_end = min(action_end, w_end)
        overlap = overlap_end - overlap_start

        if overlap > best_overlap:
            best_overlap = overlap
            best_step = step_id

    return best_step


def tag_actions_with_step_coverage(action_items, recipe_data, video_id):
    """
    Mutates action_items in place to add:
      - step_id:    str or None — which recipe step the action falls inside
      - is_primary: bool        — True iff step_id is not None
    """
    step_windows = collect_step_windows(recipe_data, video_id)

    if not step_windows:
        # No step annotations for this video; mark everything as primary
        # so we don't accidentally hide the entire graph. This is a graceful
        # fallback — log it so the researcher knows.
        print(
            f"  ⚠ No step_times found for video {video_id}. "
            "All actions will be classified as primary."
        )
        for item in action_items:
            item["step_id"] = None
            item["is_primary"] = True
        return action_items

    for item in action_items:
        matched_step = find_overlapping_step(
            item["start"], item["end"], step_windows
        )
        item["step_id"] = matched_step
        item["is_primary"] = matched_step is not None

    # Report coverage so the researcher can sanity-check
    primary_count = sum(1 for a in action_items if a["is_primary"])
    secondary_count = len(action_items) - primary_count
    print(
        f"  Step-coverage tagging: "
        f"{primary_count} primary, {secondary_count} secondary "
        f"({100 * secondary_count / len(action_items):.1f}% secondary)"
    )

    return action_items


def compute_node_primary_majority(sequence):
    """
    A node represents one action label (e.g. 'take(cup)'), but the same action
    may occur both inside and outside step windows. Decide the node's lane by
    majority vote across its occurrences. Ties go to primary (conservative).

    Returns: dict[action_label -> bool is_primary]
    """
    primary_votes = defaultdict(lambda: [0, 0])  # action -> [primary, secondary]
    for item in sequence:
        action = item["action"]
        if item.get("is_primary"):
            primary_votes[action][0] += 1
        else:
            primary_votes[action][1] += 1

    result = {}
    for action, (p, s) in primary_votes.items():
        result[action] = p >= s  # tie -> primary
    return result


# ─────────────────────────────────────────────────────────────────────────────
# FULL RAW VERSION
# ─────────────────────────────────────────────────────────────────────────────

def build_dashboard_payload(data, selected_recipe, narrations_df):
    verb_classes = data["verb_classes"]
    noun_classes = data["noun_classes"]

    recipe_meta = selected_recipe.get("recipe_data", {})
    available_videos = selected_recipe.get("video_ids", [])
    if VIDEO_ID not in available_videos:
        raise ValueError(
            f"Configured VIDEO_ID {VIDEO_ID} not found in recipe outputs: {available_videos}"
        )

    video_rows = narrations_df[narrations_df["video_id"] == VIDEO_ID].copy()
    if video_rows.empty:
        raise ValueError(f"No narration rows found for {VIDEO_ID}")

    video_rows = video_rows.sort_values("start_timestamp")

    action_items = []
    for _, row in video_rows.iterrows():
        main_classes = row.get("main_action_classes", [])
        if not main_classes:
            continue

        verb_class, noun_class = main_classes[0]
        action_name = get_action_name(verb_class, noun_class, verb_classes, noun_classes)

        action_items.append(
            {
                "action": action_name,
                "verb_class": int(verb_class),
                "noun_class": int(noun_class),
                "start": float(row["start_timestamp"]),
                "end": float(row["end_timestamp"]),
                "duration": float(row["end_timestamp"] - row["start_timestamp"]),
            }
        )

    if len(action_items) < 2:
        raise ValueError("Need at least 2 actions to build transitions")

    # NEW: tag each action with step coverage
    tag_actions_with_step_coverage(action_items, recipe_meta, VIDEO_ID)

    node_counts = Counter(item["action"] for item in action_items)

    edge_counts = Counter()
    edge_occurrences = defaultdict(list)
    sequence = []

    for idx, item in enumerate(action_items):
        current_action = item["action"]
        next_action = action_items[idx + 1]["action"] if idx < len(action_items) - 1 else None

        edge_key = None
        if next_action:
            edge_tuple = (current_action, next_action)
            edge_counts[edge_tuple] += 1
            edge_key = f"{current_action}|||{next_action}"
            edge_occurrences[edge_key].append(idx)

        sequence.append(
            {
                "index": idx,
                "action": current_action,
                "start": item["start"],
                "end": item["end"],
                "duration": item["duration"],
                "next_action": next_action,
                "edge_key": edge_key,
                # NEW fields from step-coverage tagging
                "step_id": item.get("step_id"),
                "is_primary": item.get("is_primary", True),
            }
        )

    # NEW: decide each node's lane via majority vote of its occurrences
    node_primary = compute_node_primary_majority(sequence)

    nodes = [
        {
            "id": action,
            "count": int(count),
            "is_primary": bool(node_primary.get(action, True)),
        }
        for action, count in sorted(node_counts.items(), key=lambda x: (-x[1], x[0]))
    ]

    links = [
        {
            "source": src,
            "target": dst,
            "count": int(count),
            "key": f"{src}|||{dst}",
            "occurrences": edge_occurrences[f"{src}|||{dst}"],
        }
        for (src, dst), count in sorted(edge_counts.items(), key=lambda x: (-x[1], x[0][0], x[0][1]))
    ]

    step_text = [
        {
            "id": step_id,
            "text": text.strip(),
        }
        for step_id, text in recipe_meta.get("steps", {}).items()
    ]

    return {
        "recipe": {
            "id": RECIPE_ID,
            "name": recipe_meta.get("name", "Coffee"),
            "video_id": VIDEO_ID,
            "video_path": VIDEO_RELATIVE_PATH,
            "narration_count": len(sequence),
        },
        "steps": step_text,
        "sequence": sequence,
        "graph": {
            "nodes": nodes,
            "links": links,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# SMART-MERGED VERSION: Group by verb, preserve object details
# ─────────────────────────────────────────────────────────────────────────────

def create_smart_merged_graph(payload):
    """
    Merge nodes by verb (first part before parenthesis).
    Objects are tracked in node metadata and shown in tooltips.
    is_primary is propagated via majority vote of underlying occurrences.
    """
    def extract_verb(action_name):
        return action_name.split("(")[0] if "(" in action_name else action_name

    def extract_noun(action_name):
        match = action_name[len(extract_verb(action_name)):]
        return match[1:-1] if match.startswith("(") and match.endswith(")") else ""

    merged_sequence = []
    verb_objects = defaultdict(Counter)

    for seq_item in payload["sequence"]:
        action = seq_item["action"]
        verb = extract_verb(action)
        noun = extract_noun(action)

        if noun:
            verb_objects[verb][noun] += 1

        merged_item = seq_item.copy()
        merged_item["action"] = verb  # collapsed label
        # step_id and is_primary carry over unchanged
        merged_sequence.append(merged_item)

    node_counts = Counter(item["action"] for item in merged_sequence)

    edge_counts = Counter()
    edge_occurrences = defaultdict(list)

    for idx, item in enumerate(merged_sequence):
        current_action = item["action"]
        next_action = merged_sequence[idx + 1]["action"] if idx < len(merged_sequence) - 1 else None

        if next_action:
            edge_tuple = (current_action, next_action)
            edge_counts[edge_tuple] += 1
            edge_key = f"{current_action}|||{next_action}"
            edge_occurrences[edge_key].append(idx)

    # Recompute majority vote at the merged-verb level
    node_primary = compute_node_primary_majority(merged_sequence)

    nodes = []
    for action, count in sorted(node_counts.items(), key=lambda x: (-x[1], x[0])):
        nodes.append({
            "id": action,
            "count": int(count),
            "is_primary": bool(node_primary.get(action, True)),
            "objects": dict(verb_objects[action]) if action in verb_objects else {},
        })

    links = [
        {
            "source": src,
            "target": dst,
            "count": int(count),
            "key": f"{src}|||{dst}",
            "occurrences": edge_occurrences[f"{src}|||{dst}"],
        }
        for (src, dst), count in sorted(edge_counts.items(), key=lambda x: (-x[1], x[0][0], x[0][1]))
    ]

    result = payload.copy()
    result["sequence"] = merged_sequence
    result["graph"] = {"nodes": nodes, "links": links}
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ABSTRACTED VERSION: Group into task phases
# ─────────────────────────────────────────────────────────────────────────────
#
# NOTE: ACTION_TO_PHASE here is preserved ONLY for the Task Phases view, which
# is a manually-curated semantic abstraction for visualization purposes. It is
# no longer used for lane assignment — the is_primary flag (from step_times)
# now handles that universally across all recipes.
# ─────────────────────────────────────────────────────────────────────────────

ACTION_TO_PHASE = {
    # Phase 1: Measurement Setup
    "move(scale)": "measure",
    "turn-on(scale)": "measure",
    "adjust(scale)": "measure",

    # Phase 2: Coffee Extraction
    "take(can)": "extract-coffee",
    "open(can)": "extract-coffee",
    "close(can)": "extract-coffee",
    "put(can)": "extract-coffee",
    "pour(coffee)": "dispense",

    # Phase 3: Machine Assembly & Prep
    "take(maker:coffee)": "prep-machine",
    "open(cap)": "prep-machine",
    "take(spoon)": "prep-machine",
    "scoop(coffee)": "prep-machine",
    "put(coffee)": "prep-machine",
    "search(rack:drying)": "prep-machine",

    # Phase 4: Tamping & Pressing
    "pat(maker:coffee)": "tamp",
    "mix(coffee)": "tamp",
    "crush(coffee)": "tamp",
    "press(coffee)": "tamp",
    "put(presser)": "tamp",
    "put(spoon)": "tamp",
    "pat(cup)": "tamp",

    # Phase 5: Cup Handling
    "take(cup)": "handle-cup",
    "put(cup)": "handle-cup",
    "screw(cup)": "handle-cup",
    "squeeze(cup)": "handle-cup",
    "carry(cup)": "handle-cup",

    # Phase 7: Machine Cleaning & Finale
    "turn-on(machine:washing)": "clean-machine",
    "wait(machine:washing)": "clean-machine",
    "finish(machine:washing)": "clean-machine",
    "turn-off(machine:washing)": "clean-machine",
    "check(coffee)": "clean-machine",
    "open(drawer)": "clean-machine",
    "take(plate)": "clean-machine",
    "put(machine:washing)": "clean-machine",

    # Phase 8: Task/Phone Ops (semantic label only — does NOT decide lane)
    "slide(phone)": "task-ops",
    "open(phone)": "task-ops",
    "write(coffee)": "task-ops",
    "carry(phone)": "task-ops",
    "move(phone)": "task-ops",
}

PHASE_ORDER = [
    "measure",
    "extract-coffee",
    "prep-machine",
    "tamp",
    "handle-cup",
    "dispense",
    "clean-machine",
    "task-ops",
]


def create_abstracted_graph(payload):
    abstracted_sequence = []
    for seq_item in payload["sequence"]:
        action = seq_item["action"]
        phase = ACTION_TO_PHASE.get(action, "other")

        abstracted_item = seq_item.copy()
        abstracted_item["action"] = phase
        abstracted_item["raw_action"] = action
        # is_primary carries over from underlying action
        abstracted_sequence.append(abstracted_item)

    node_counts = Counter(item["action"] for item in abstracted_sequence)

    edge_counts = Counter()
    edge_occurrences = defaultdict(list)

    for idx, item in enumerate(abstracted_sequence):
        current_action = item["action"]
        next_action = abstracted_sequence[idx + 1]["action"] if idx < len(abstracted_sequence) - 1 else None

        if next_action:
            edge_tuple = (current_action, next_action)
            edge_counts[edge_tuple] += 1
            edge_key = f"{current_action}|||{next_action}"
            edge_occurrences[edge_key].append(idx)

    # For phases, the lane is determined by majority is_primary of the
    # underlying actions that fell into that phase.
    node_primary = compute_node_primary_majority(abstracted_sequence)

    nodes = []
    for phase in PHASE_ORDER:
        if phase in node_counts:
            nodes.append({
                "id": phase,
                "count": int(node_counts[phase]),
                "is_primary": bool(node_primary.get(phase, True)),
            })

    links = [
        {
            "source": src,
            "target": dst,
            "count": int(count),
            "key": f"{src}|||{dst}",
            "occurrences": edge_occurrences[f"{src}|||{dst}"],
        }
        for (src, dst), count in sorted(edge_counts.items(), key=lambda x: (-x[1], x[0][0], x[0][1]))
    ]

    result = payload.copy()
    result["sequence"] = abstracted_sequence
    result["graph"] = {"nodes": nodes, "links": links}
    return result


def main():
    selected_recipe, narrations_path = load_recipe_context()
    data = load_hd_epic_data("..")

    recipe_narrations = pd.read_pickle(narrations_path)

    payload_full = build_dashboard_payload(data, selected_recipe, recipe_narrations)
    payload_smart = create_smart_merged_graph(payload_full)
    payload_abstracted = create_abstracted_graph(payload_full)

    output_dir = Path("../outputs/graphs/")
    output_dir.mkdir(parents=True, exist_ok=True)

    versions = [
        ("dashboard_P08_R01.json", payload_full, "Full Raw"),
        ("dashboard_P08_R01_smart.json", payload_smart, "Smart-Merged"),
        ("dashboard_P08_R01_abstracted.json", payload_abstracted, "Abstracted"),
    ]

    for filename, payload, label in versions:
        output_path = output_dir / filename
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)

        primary_n = sum(1 for n in payload["graph"]["nodes"] if n.get("is_primary"))
        secondary_n = len(payload["graph"]["nodes"]) - primary_n
        print(f"\n✓ {label}: {output_path}")
        print(f"  Actions: {len(payload['sequence'])}")
        print(f"  Nodes: {len(payload['graph']['nodes'])} "
              f"({primary_n} primary, {secondary_n} secondary)")
        print(f"  Transitions: {len(payload['graph']['links'])}")


if __name__ == "__main__":
    main()