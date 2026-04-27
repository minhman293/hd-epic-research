"""
Step 6: Export single-recipe dashboard data for D3 (Nespresso P08_R01)
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


def main():
    selected_recipe, narrations_path = load_recipe_context()
    data = load_hd_epic_data("..")

    # Read recipe-specific narrations from the selector output.
    recipe_narrations = pd.read_pickle(narrations_path)

    payload = build_dashboard_payload(data, selected_recipe, recipe_narrations)

    output_path = Path("../outputs/graphs/dashboard_P08_R01.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(f"Saved dashboard data: {output_path}")
    print(f"Actions: {len(payload['sequence'])}")
    print(f"Nodes: {len(payload['graph']['nodes'])}")
    print(f"Transitions: {len(payload['graph']['links'])}")


if __name__ == "__main__":
    main()