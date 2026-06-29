"""
Utility functions for HD-EPIC motion graph analysis
"""

import pandas as pd
import numpy as np
import json
import pickle
from pathlib import Path


def load_video_durations(csv_path):
    """
    Load per-video durations from the dataset's video metadata CSV.

    Expected columns: video_id, youtube_url, duration (seconds).
    The youtube_url column is ignored; only video_id and duration are used.

    Returns:
        dict {video_id: duration_seconds}. Returns {} if the file is missing
        or malformed — callers should fall back to estimating duration from
        the latest narration end-timestamp in that video.
    """
    csv_path = Path(csv_path)
    if not csv_path.exists():
        print(f"  ⚠ Video durations CSV not found at {csv_path}.")
        print(f"     Pipeline will fall back to annotation-max estimates.")
        return {}
    df = pd.read_csv(csv_path)
    if 'video_id' not in df.columns or 'duration' not in df.columns:
        print(f"  ⚠ {csv_path} is missing required columns 'video_id' and 'duration'.")
        return {}
    return dict(zip(df['video_id'].astype(str), df['duration'].astype(float)))


def load_hd_epic_data(data_dir='..', video_durations_csv=None):
    """
    Load all necessary HD-EPIC files.

    Args:
        data_dir: Path to the dataset root.
        video_durations_csv: Optional explicit path to the video-durations CSV.
            Defaults to `<data_dir>/video_durations.csv`.

    Returns:
        dict with keys: narrations, verb_classes, noun_classes, recipes,
        recipe_timestamps, video_durations.
    """
    data_dir = Path(data_dir)

    print("="*80)
    print("LOADING HD-EPIC DATASET")
    print("="*80)

    # Load narrations
    print("Loading narrations...")
    with open(data_dir / 'narrations-and-action-segments' / 'HD_EPIC_Narrations.pkl', 'rb') as f:
        narrations = pickle.load(f)
    narrations = pd.DataFrame(narrations)
    print(f"✓ Narrations loaded: {len(narrations)} actions")

    # Load verb classes
    print("Loading verb classes...")
    verb_classes = pd.read_csv(data_dir / 'narrations-and-action-segments' / 'HD_EPIC_verb_classes.csv')
    print(f"✓ Verb classes loaded: {len(verb_classes)} verbs")

    # Load noun classes
    print("Loading noun classes...")
    noun_classes = pd.read_csv(data_dir / 'narrations-and-action-segments' / 'HD_EPIC_noun_classes.csv')
    print(f"✓ Noun classes loaded: {len(noun_classes)} nouns")

    # Load recipes
    print("Loading recipes...")
    with open(data_dir / 'high-level' / 'complete_recipes.json', 'r') as f:
        recipes = json.load(f)
    print(f"✓ Recipes loaded: {len(recipes)} recipes")

    # Load all recipe timestamps
    print("Loading recipe timestamps...")
    recipe_timestamps = []
    activities_dir = data_dir / 'high-level' / 'activities'

    for csv_file in activities_dir.glob('P*_recipe_timestamps.csv'):
        df = pd.read_csv(csv_file)
        recipe_timestamps.append(df)

    recipe_timestamps = pd.concat(recipe_timestamps, ignore_index=True)
    print(f"✓ Recipe timestamps loaded: {len(recipe_timestamps)} entries")

    # Load video durations
    print("Loading video durations...")
    if video_durations_csv is None:
        video_durations_csv = data_dir / 'youtube-links' / 'HD_EPIC_YouTube_URLs.csv'
    video_durations = load_video_durations(video_durations_csv)
    print(f"✓ Video durations loaded: {len(video_durations)} videos")

    print("="*80)
    print("DATASET LOADED SUCCESSFULLY")
    print("="*80)

    return {
        'narrations': narrations,
        'verb_classes': verb_classes,
        'noun_classes': noun_classes,
        'recipes': recipes,
        'recipe_timestamps': recipe_timestamps,
        'video_durations': video_durations,
    }


def get_verb_name(verb_class_id, verb_classes_df):
    """Get verb name from verb class ID"""
    row = verb_classes_df[verb_classes_df['id'] == verb_class_id]
    if len(row) > 0:
        return row.iloc[0]['key']
    return f"verb_{verb_class_id}"


def get_noun_name(noun_class_id, noun_classes_df):
    """Get noun name from noun class ID"""
    row = noun_classes_df[noun_classes_df['id'] == noun_class_id]
    if len(row) > 0:
        return row.iloc[0]['key']
    return f"noun_{noun_class_id}"


def get_action_name(verb_class_id, noun_class_id, verb_classes_df, noun_classes_df):
    """Get full action name (verb + noun)"""
    verb = get_verb_name(verb_class_id, verb_classes_df)
    noun = get_noun_name(noun_class_id, noun_classes_df)
    return f"{verb}({noun})"


def count_loops(actions_series):
    """
    Count A → B → A oscillation patterns in action sequence

    Args:
        actions_series: pandas Series of action labels

    Returns:
        int: number of oscillation loops found
    """
    actions = actions_series.tolist()
    loop_count = 0

    for i in range(len(actions) - 2):
        if actions[i] == actions[i+2] and actions[i] != actions[i+1]:
            loop_count += 1

    return loop_count


def calculate_pause(narrations_df):
    """
    Calculate pause duration between consecutive actions

    Args:
        narrations_df: DataFrame with start_timestamp and end_timestamp columns

    Returns:
        Series with pause durations in seconds
    """
    df = narrations_df.sort_values('start_timestamp').copy()
    pauses = []
    for i in range(len(df) - 1):
        end_time = df.iloc[i]['end_timestamp']
        next_start = df.iloc[i+1]['start_timestamp']
        pause = next_start - end_time
        pauses.append(max(0, pause))
    pauses.append(0)
    return pd.Series(pauses, index=df.index)


def create_output_dirs():
    """Create output directories if they don't exist"""
    Path('../outputs/graphs').mkdir(parents=True, exist_ok=True)
    Path('../outputs/tables').mkdir(parents=True, exist_ok=True)
    Path('../outputs/figures').mkdir(parents=True, exist_ok=True)