import networkx as nx

# --- Configuration ---
# In your final version, this should be loaded per recipe from complete_recipes.json
CRITICAL_STEPS = [
    'turn-on(stove)',
    'add(water)',
    'close(fridge)',
    'insert(capsule)'  # Added for your Nespresso deep-dive
]

def detect_oscillation(action_history):
    """
    Detects A-B-A pattern.
    Logic: User repeats an action after exactly one intervening action.
    """
    if len(action_history) < 3:
        return False
    
    # Simple check: Is current action same as 2 steps ago?
    # e.g., open(drawer) -> close(drawer) -> open(drawer)
    if action_history[-1] == action_history[-3]:
        return True 
    return False

def is_rare_transition(prev_action, current_action, recipe_graph, rarity_threshold=0.8):
    """
    Check if the transition from A to B is rare in the population.
    """
    if not recipe_graph.has_edge(prev_action, current_action):
        return True # It's never been seen before = extremely rare
    
    # Get all observed next actions after prev_action
    expected_next = list(recipe_graph.successors(prev_action))
    
    # Calculate transition probability
    transition_weight = recipe_graph[prev_action][current_action].get('weight', 1)
    total_weight = sum(recipe_graph[prev_action][n].get('weight', 1) for n in expected_next)
    
    probability = transition_weight / total_weight
    rarity = 1 - probability
    
    return rarity > rarity_threshold

def check_for_skipped_step(action_history, recipe_template):
    """
    Improved: Checks if a 'Critical Step' was missed.
    Instead of checking index i vs i, we check if the user has moved 
    passed a critical requirement without doing it.
    """
    if not action_history or not recipe_template:
        return False

    current_action = action_history[-1]
    
    # Find where we are in the recipe template
    try:
        current_step_idx = recipe_template.index(current_action)
    except ValueError:
        return False # User is doing a 'background' action not in template

    # Look at all steps that should have happened BEFORE this one
    prior_steps = recipe_template[:current_step_idx]
    
    for step in prior_steps:
        if step in CRITICAL_STEPS and step not in action_history:
            return True # Found a critical step that was never performed
            
    return False

def count_recent_repetitions(action_history, action_type, window=10):
    """
    Counts occurrences of the current action in the recent window.
    """
    recent_window = action_history[-window:]
    return sum(1 for a in recent_window if a == action_type)

def detect_intervention_need(action_history, recipe_graph, recipe_template, median_counts):
    """
    The Central Logic Hub.
    Combines signals to decide if the robot should speak up.
    """
    if not action_history:
        return {'intervene': False, 'signals': []}

    current_action = action_history[-1]
    intervention_signals = []
    
    # 1. Oscillation (Priority: HIGH)
    if detect_oscillation(action_history):
        intervention_signals.append({
            'type': 'oscillation',
            'priority': 'HIGH',
            'message': f'Repetitive search detected: {current_action}'
        })
    
    # 2. Unexpected Transition (Priority: MEDIUM)
    if len(action_history) >= 2:
        prev_action = action_history[-2]
        if is_rare_transition(prev_action, current_action, recipe_graph):
            intervention_signals.append({
                'type': 'unexpected_transition',
                'priority': 'MEDIUM',
                'message': 'Unusual path detected'
            })
    
    # 3. Excessive Repetition (Priority: MEDIUM)
    # Note: median_counts should be a dict {action_label: median_value}
    action_count = count_recent_repetitions(action_history, current_action)
    median_val = median_counts.get(current_action, 2) # Default to 2 if unknown
    if action_count > median_val * 2:
        intervention_signals.append({
            'type': 'excessive_repetition',
            'priority': 'MEDIUM',
            'message': f'Struggle detected with {current_action}'
        })
    
    # 4. Skipped Critical Step (Priority: HIGH)
    if check_for_skipped_step(action_history, recipe_template):
        intervention_signals.append({
            'type': 'skipped_step',
            'priority': 'HIGH',
            'message': 'Critical step omitted'
        })
    
    # Decision Logic
    should_intervene = any(s['priority'] == 'HIGH' for s in intervention_signals) or \
                       len(intervention_signals) >= 2
                       
    urgency = 'HIGH' if any(s['priority'] == 'HIGH' for s in intervention_signals) else 'MEDIUM'

    return {
        'intervene': should_intervene,
        'urgency': urgency if should_intervene else 'NONE',
        'signals': intervention_signals
    }