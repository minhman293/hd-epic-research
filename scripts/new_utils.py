"""
Utility functions for HD-EPIC motion graph analysis
Updated: Removed pause logic, added Duration & Population Baselines
"""

import pandas as pd
import numpy as np
import json
import pickle
from pathlib import Path

def load_hd_epic_data(data_dir='..'):
    """Load all necessary HD-EPIC files and return as a dictionary."""
    data_dir = Path(data_dir)
    print("="*80 + "\nLOADING HD-EPIC DATASET\n" + "="*80)
    
    # Load narrations
    with open(data_dir / 'narrations-and-action-segments' / 'HD_EPIC_Narrations.pkl', 'rb') as f:
        narrations = pd.DataFrame(pickle.load(f))
    print(f"✓ Narrations: {len(narrations)} actions")
    
    verb_classes = pd.read_csv(data_dir / 'narrations-and-action-segments' / 'HD_EPIC_verb_classes.csv')
    noun_classes = pd.read_csv(data_dir / 'narrations-and-action-segments' / 'HD_EPIC_noun_classes.csv')
    
    with open(data_dir / 'high-level' / 'complete_recipes.json', 'r') as f:
        recipes = json.load(f)
    
    # Load all timestamps
    recipe_timestamps = []
    activities_dir = data_dir / 'high-level' / 'activities'
    for csv_file in activities_dir.glob('P*_recipe_timestamps.csv'):
        recipe_timestamps.append(pd.read_csv(csv_file))
    recipe_timestamps = pd.concat(recipe_timestamps, ignore_index=True)
    
    return {
        'narrations': narrations,
        'verb_classes': verb_classes,
        'noun_classes': noun_classes,
        'recipes': recipes,
        'recipe_timestamps': recipe_timestamps
    }

def get_action_name(verb_id, noun_id, verb_classes_df, noun_classes_df):
    """Get full action name (verb + noun) with safety checks."""
    # Handle list inputs if data is in list format
    v_id = verb_id[0] if isinstance(verb_id, (list, np.ndarray)) else verb_id
    n_id = noun_id[0] if isinstance(noun_id, (list, np.ndarray)) else noun_id
    
    verb = verb_classes_df.loc[verb_classes_df['id'] == v_id, 'key'].values
    noun = noun_classes_df.loc[noun_classes_df['id'] == n_id, 'key'].values
    
    v_str = verb[0] if len(verb) > 0 else "idle"
    n_str = noun[0] if len(noun) > 0 else "object"
    return f"{v_str}({n_str})"

def calculate_action_durations(df):
    """
    NEW: Replaces calculate_pause.
    Computes duration as start_time(i+1) - start_time(i).
    """
    df = df.sort_values('start_timestamp').copy()
    # Shift the start_timestamp to get the 'next' start time
    df['next_start'] = df['start_timestamp'].shift(-1)
    # The last action in a video doesn't have a 'next', so we use its own end_timestamp
    df['next_start'] = df['next_start'].fillna(df['end_timestamp'])
    
    df['duration'] = df['next_start'] - df['start_timestamp']
    return df['duration']

def get_population_baselines(narrations_df, verb_classes, noun_classes):
    """
    NEW: Computes the median duration and attempt count for every action 
    across the entire dataset to establish a 'Normal' baseline.
    """
    print("Calculating population baselines (this may take a moment)...")
    
    # 1. Map all actions to labels
    df = narrations_df.copy()
    df['action_label'] = df.apply(
        lambda x: get_action_name(x['verbs'], x['nouns'], verb_classes, noun_classes), axis=1
    )
    
    # 2. Calculate individual durations
    df['duration'] = calculate_action_durations(df)
    
    # 3. Group by label to find medians
    baselines = df.groupby('action_label')['duration'].agg(['median', 'std', 'count']).to_dict('index')
    
    return baselines

def get_recipe_template(recipe_id, recipes_json):
    """
    NEW: Extracts the 'Gold Standard' sequence of steps for a recipe.
    Returns a list of high-level step descriptions.
    """
    if recipe_id not in recipes_json:
        return []
    
    steps_dict = recipes_json[recipe_id].get('steps', {})
    # Sort by step ID (S01, S02...)
    sorted_steps = [steps_dict[k] for k in sorted(steps_dict.keys())]
    return sorted_steps

def count_loops(actions_list):
    """Count A -> B -> A oscillation patterns."""
    loop_count = 0
    for i in range(len(actions_list) - 2):
        if actions_list[i] == actions_list[i+2] and actions_list[i] != actions_list[i+1]:
            loop_count += 1
    return loop_count

def create_output_dirs():
    """Create output directories structure."""
    base = Path('../outputs')
    for sub in ['graphs', 'tables', 'figures', 'baselines']:
        (base / sub).mkdir(parents=True, exist_ok=True)