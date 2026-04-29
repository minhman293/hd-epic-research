"""
Step 6: Export single-recipe dashboard data for D3 (Nespresso P08_R01)
Generates three versions: full raw, smart-merged, and abstracted task phases.
"""

import json
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

from utils import get_action_name, load_hd_epic_data


RECIPE_ID = "P08_R01"
VIDEO_ID = "P08-20240613-122900"
VIDEO_RELATIVE_PATH = "raw-video/P08-20240613-122900.mp4"


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
            }
        )

    nodes = [
        {
            "id": action,
            "count": int(count),
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
            "name": recipe_meta.get("name", "Nespresso"),
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
    """
    def extract_verb(action_name):
        """Extract verb from 'verb(noun)' format."""
        return action_name.split('(')[0] if '(' in action_name else action_name

    def extract_noun(action_name):
        """Extract noun from 'verb(noun)' format."""
        match = action_name[len(extract_verb(action_name)):]  # e.g., "(cup)"
        return match[1:-1] if match.startswith('(') and match.endswith(')') else ""

    # Build merged sequence and track object occurrences
    merged_sequence = []
    verb_objects = defaultdict(Counter)  # verb -> {noun: count}

    for seq_item in payload["sequence"]:
        action = seq_item["action"]
        verb = extract_verb(action)
        noun = extract_noun(action)

        if noun:
            verb_objects[verb][noun] += 1

        merged_item = seq_item.copy()
        merged_item["action"] = verb
        merged_sequence.append(merged_item)

    # Build merged graph
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

    nodes = []
    for action, count in sorted(node_counts.items(), key=lambda x: (-x[1], x[0])):
        node = {
            "id": action,
            "count": int(count),
            "objects": dict(verb_objects[action]) if action in verb_objects else {},
        }
        nodes.append(node)

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

# Mapping from raw actions to abstract task phases
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
    "pour(coffee)": "dispense",  # First occurrences typically go to extract or dispense

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

    # Phase 5: Cup Handling
    "take(cup)": "handle-cup",
    "put(cup)": "handle-cup",
    "screw(cup)": "handle-cup",
    "squeeze(cup)": "handle-cup",
    "carry(cup)": "handle-cup",

    # Phase 6: Espresso Dispensing
    # "pour(coffee)" can map here too depending on context

    # Phase 7: Machine Cleaning & Finale
    "turn-on(machine:washing)": "clean-machine",
    "wait(machine:washing)": "clean-machine",
    "finish(machine:washing)": "clean-machine",
    "turn-off(machine:washing)": "clean-machine",
    "check(coffee)": "clean-machine",
    "open(drawer)": "clean-machine",
    "take(plate)": "clean-machine",

    # Phase 8: Task/Phone Ops (Secondary)
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
    """
    Group actions into high-level task phases.
    """
    # Map each raw action to its phase
    abstracted_sequence = []
    for seq_item in payload["sequence"]:
        action = seq_item["action"]
        phase = ACTION_TO_PHASE.get(action, "other")

        abstracted_item = seq_item.copy()
        abstracted_item["action"] = phase
        abstracted_item["raw_action"] = action  # Keep reference
        abstracted_sequence.append(abstracted_item)

    # Build abstracted graph
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

    # Sort phases by defined order
    nodes = []
    for phase in PHASE_ORDER:
        if phase in node_counts:
            nodes.append({
                "id": phase,
                "count": int(node_counts[phase]),
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

    # Read recipe-specific narrations from the selector output.
    recipe_narrations = pd.read_pickle(narrations_path)

    # Build full raw graph
    payload_full = build_dashboard_payload(data, selected_recipe, recipe_narrations)

    # Generate derived versions
    payload_smart = create_smart_merged_graph(payload_full)
    payload_abstracted = create_abstracted_graph(payload_full)

    output_dir = Path("../outputs/graphs/")
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save all three versions
    versions = [
        ("dashboard_P08_R01.json", payload_full, "Full Raw"),
        ("dashboard_P08_R01_smart.json", payload_smart, "Smart-Merged"),
        ("dashboard_P08_R01_abstracted.json", payload_abstracted, "Abstracted"),
    ]

    for filename, payload, label in versions:
        output_path = output_dir / filename
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)

        print(f"\n✓ {label}: {output_path}")
        print(f"  Actions: {len(payload['sequence'])}")
        print(f"  Nodes: {len(payload['graph']['nodes'])}")
        print(f"  Transitions: {len(payload['graph']['links'])}")


if __name__ == "__main__":
    main()