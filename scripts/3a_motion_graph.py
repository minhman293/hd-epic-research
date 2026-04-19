"""
Step 3: Build motion graph from recipe actions
"""

import pandas as pd
import numpy as np
import networkx as nx
import matplotlib.pyplot as plt
import json
import pickle
import sys
from collections import Counter, defaultdict
from pathlib import Path
from utils import (load_hd_epic_data, get_verb_name, get_noun_name, 
                   get_action_name, calculate_pause)
from visualize_motion_graph import visualize_motion_graph_v3


def load_selected_recipe_files(outputs_dir='../outputs', recipe_id=None):
    """Load recipe-specific selection files from outputs directory.

    If recipe_id is provided, load exact files for that recipe.
    Otherwise, load the most recently modified selected_recipe_*.json.
    """
    outputs_path = Path(outputs_dir)

    if recipe_id:
        recipe_json_path = outputs_path / f'selected_recipe_{recipe_id}.json'
        if not recipe_json_path.exists():
            raise FileNotFoundError(
                f"Missing selection file: {recipe_json_path}. "
                "Run 2_recipe_selector.py for this recipe first."
            )
    else:
        recipe_json_candidates = sorted(
            outputs_path.glob('selected_recipe_*.json'),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not recipe_json_candidates:
            raise FileNotFoundError(
                "No selection file found. Run 2_recipe_selector.py first "
                "to create selected_recipe_<recipe_id>.json"
            )
        recipe_json_path = recipe_json_candidates[0]

    with open(recipe_json_path, 'r') as f:
        recipe_info = json.load(f)

    resolved_recipe_id = recipe_info['recipe_id']
    recipe_narrations_path = outputs_path / f'recipe_narrations_{resolved_recipe_id}.pkl'
    if not recipe_narrations_path.exists():
        raise FileNotFoundError(
            f"Missing narration file: {recipe_narrations_path}. "
            "Run 2_recipe_selector.py again to regenerate outputs."
        )

    recipe_narrations = pd.read_pickle(recipe_narrations_path)

    print(f"Using selection file: {recipe_json_path.name}")
    print(f"Using narrations file: {recipe_narrations_path.name}")

    return recipe_info, recipe_narrations


def extract_ordered_actions(narrations_df, verb_classes_df, noun_classes_df, video_id=None):
    """Extract ordered action sequence and stats for one video (or first available video)."""
    if narrations_df.empty:
        return None, [], Counter(), Counter(), {}

    if video_id is None:
        video_id = narrations_df['video_id'].iloc[0]

    video_actions = narrations_df[narrations_df['video_id'] == video_id].sort_values('start_timestamp')
    if video_actions.empty:
        return video_id, [], Counter(), Counter(), {}

    video_actions = video_actions.copy()
    video_actions['pause_after'] = calculate_pause(video_actions)

    ordered_steps = []
    action_pause_accum = defaultdict(list)

    for _, row in video_actions.iterrows():
        if row['main_action_classes'] and len(row['main_action_classes']) > 0:
            verb_class, noun_class = row['main_action_classes'][0]
            action_name = get_action_name(verb_class, noun_class, verb_classes_df, noun_classes_df)
            pause_after = float(row.get('pause_after', 0.0))
            ordered_steps.append({'action': action_name, 'pause_after': pause_after})
            action_pause_accum[action_name].append(pause_after)

    actions = [s['action'] for s in ordered_steps]
    node_counts = Counter(actions)
    transition_counts = Counter(zip(actions[:-1], actions[1:]))
    node_avg_pause = {
        action: float(np.mean(pauses)) if pauses else 0.0
        for action, pauses in action_pause_accum.items()
    }

    return video_id, ordered_steps, node_counts, transition_counts, node_avg_pause

def build_motion_graph(narrations_df, verb_classes_df, noun_classes_df):
    """
    Build motion graph where:
    - Nodes = Actions (verb-noun pairs)
    - Edges = Consecutive actions  
    - Edge attributes = frequency and pause statistics
    """
    
    G = nx.MultiDiGraph()
    
    print("\n" + "="*80)
    print("BUILDING MOTION GRAPH")
    print("="*80)
    
    # Process each video separately
    for video_id in narrations_df['video_id'].unique():
        video_actions = narrations_df[narrations_df['video_id'] == video_id].sort_values('start_timestamp')
        
        if len(video_actions) < 2:
            continue
        
        # Calculate pauses
        video_actions['pause_after'] = calculate_pause(video_actions)
        
        # Extract main actions (verb_class, noun_class from main_action_classes)
        actions = []
        times_start = []
        times_end = []
        pauses = []
        
        for idx, row in video_actions.iterrows():
            # Get main action (first pair)
            if row['main_action_classes'] and len(row['main_action_classes']) > 0:
                verb_class, noun_class = row['main_action_classes'][0]
                
                action_name = get_action_name(verb_class, noun_class, 
                                              verb_classes_df, noun_classes_df)
                
                actions.append(action_name)
                times_start.append(row['start_timestamp'])
                times_end.append(row['end_timestamp'])
                pauses.append(row['pause_after'])
        
        # Build edges
        for i in range(len(actions) - 1):
            action_a = actions[i]
            action_b = actions[i + 1]
            pause = pauses[i]
            
            # Add edge
            if G.has_edge(action_a, action_b):
                # Find existing edge with same endpoints
                edge_key = list(G[action_a][action_b].keys())[0]
                G[action_a][action_b][edge_key]['weight'] += 1
                G[action_a][action_b][edge_key]['pauses'].append(pause)
            else:
                G.add_edge(action_a, action_b, weight=1, pauses=[pause])
    
    # Calculate statistics for each edge
    for u, v, key, data in G.edges(data=True, keys=True):
        pauses = data['pauses']
        data['avg_pause'] = np.mean(pauses)
        data['max_pause'] = np.max(pauses)
        data['min_pause'] = np.min(pauses)
        data['std_pause'] = np.std(pauses)
    
    print(f"\nGraph statistics:")
    print(f"  Nodes (unique actions): {G.number_of_nodes()}")
    print(f"  Edges (transitions): {G.number_of_edges()}")
    print(f"  Videos analyzed: {narrations_df['video_id'].nunique()}")
    
    return G

def compute_topological_layout(G, narrations_df, verb_classes_df, noun_classes_df):
    """
    Assign x-position based on median sequence index across all observed videos.
    Nodes that consistently appear early go left; late-appearing nodes go right.
    Nodes at the same x are spread vertically to avoid overlap.
    """
    from collections import defaultdict
    import numpy as np

    # Step 1: collect each node's sequence positions across all videos
    node_positions_in_sequence = defaultdict(list)

    for video_id in narrations_df['video_id'].unique():
        video_actions = narrations_df[
            narrations_df['video_id'] == video_id
        ].sort_values('start_timestamp')

        action_sequence = []
        for _, row in video_actions.iterrows():
            if row['main_action_classes'] and len(row['main_action_classes']) > 0:
                verb_class, noun_class = row['main_action_classes'][0]
                action_name = get_action_name(
                    verb_class, noun_class, verb_classes_df, noun_classes_df
                )
                action_sequence.append(action_name)

        total = len(action_sequence)
        for idx, action in enumerate(action_sequence):
            # normalize to [0, 1] so videos of different lengths are comparable
            node_positions_in_sequence[action].append(idx / max(total - 1, 1))

    # Step 2: assign x = median normalized position for each node
    node_x = {}
    for node in G.nodes():
        positions = node_positions_in_sequence.get(node, [0.5])
        node_x[node] = float(np.median(positions))

    # Step 3: group nodes by similar x, spread them vertically
    # Bin nodes into columns (tolerance = 0.05)
    from collections import defaultdict
    x_bins = defaultdict(list)
    for node, x in node_x.items():
        bin_key = round(x / 0.05) * 0.05  # snap to nearest 0.05
        x_bins[bin_key].append(node)

    pos = {}
    for bin_x, nodes_in_bin in x_bins.items():
        n = len(nodes_in_bin)
        for i, node in enumerate(nodes_in_bin):
            # center the column vertically, spread by 1.0 unit spacing
            y = (i - (n - 1) / 2.0)
            pos[node] = (bin_x * 20, y)  # scale x by 20 for readability

    return pos

def visualize_motion_graph(
    G,
    recipe_id,
    recipe_name,
    narrations_df,
    verb_classes_df,
    noun_classes_df,
    output_path='../outputs/figures/motion_graph.png'
):
    """
    Visualize motion graph like Figure 10 example
    """
    
    print("\n" + "="*80)
    print("VISUALIZING MOTION GRAPH")
    print("="*80)
    
    fig, ax = plt.subplots(figsize=(24, 20))
    
    # Layout - spring for better node distribution
    print("Computing layout...")
    # pos = nx.spring_layout(G, k=3, iterations=50, seed=42)
    pos = compute_topological_layout(G, narrations_df, verb_classes_df, noun_classes_df)
    
    # Node sizes based on degree (frequency)
    print("Calculating node sizes...")
    node_degrees = dict(G.degree(weight='weight'))
    max_degree = max(node_degrees.values()) if node_degrees else 1
    node_sizes = [node_degrees.get(node, 1) / max_degree * 2000 for node in G.nodes()]
    
    # Draw nodes
    print("Drawing nodes...")
    nx.draw_networkx_nodes(G, pos,
                          node_size=node_sizes,
                          node_color='lightblue',
                          alpha=0.8,
                          edgecolors='black',
                          linewidths=2,
                          ax=ax)
    
    # Prepare edges
    print("Processing edges...")
    edge_data = []
    for u, v, key, data in G.edges(data=True, keys=True):
        edge_data.append({
            'u': u,
            'v': v,
            'weight': data['weight'],
            'avg_pause': data['avg_pause']
        })
    
    # Normalize edge widths
    max_weight = max([e['weight'] for e in edge_data]) if edge_data else 1
    
    # Draw edges by pause category
    print("Drawing edges...")
    # for edge in edge_data:
    #     width = (edge['weight'] / max_weight) * 8
        
    #     # Color by pause duration
    #     if edge['avg_pause'] > 30:
    #         color = 'red'
    #     elif edge['avg_pause'] > 10:
    #         color = 'orange'
    #     else:
    #         color = 'green'
        
    #     nx.draw_networkx_edges(G, pos,
    #                           edgelist=[(edge['u'], edge['v'])],
    #                           width=width,
    #                           edge_color=color,
    #                           alpha=0.6,
    #                           arrows=True,
    #                           arrowsize=20,
    #                           arrowstyle='->',
    #                           connectionstyle='arc3,rad=0.1',
    #                           ax=ax)
    # Draw in three passes so red (struggle) edges appear on top
    for color, min_pause, max_pause, alpha, width_multiplier in [
        ('green',  0,   10,  0.4, 0.6),   # background layer
        ('orange', 10,  30,  0.7, 1.0),   # middle layer  
        ('red',    30, 999,  1.0, 2.0),   # foreground — always on top
    ]:
        edges_in_category = [
            (e['u'], e['v'])
            for e in edge_data
            if min_pause <= e['avg_pause'] < max_pause
        ]
        if not edges_in_category:
            continue
        widths = [
            (next(e['weight'] for e in edge_data if e['u'] == u and e['v'] == v)
            / max_weight) * 8 * width_multiplier
            for u, v in edges_in_category
        ]
        nx.draw_networkx_edges(G, pos,
            edgelist=edges_in_category,
            width=widths,
            edge_color=color,
            alpha=alpha,
            arrows=True,
            arrowsize=20,
            connectionstyle='arc3,rad=0.1',
            ax=ax)
    
    # Draw labels
    print("Drawing labels...")
    # Truncate long labels
    labels = {node: node[:20] + '...' if len(node) > 20 else node 
             for node in G.nodes()}
    
    nx.draw_networkx_labels(G, pos, labels,
                           font_size=8,
                           font_weight='bold',
                           ax=ax)
    
    ax.set_title(
        f'Recipe Motion Graph: {recipe_name} ({recipe_id})\nAction Flow with Pause Indicators',
        fontsize=20,
        fontweight='bold',
        pad=20,
    )
    ax.axis('off')
    
    # Legend
    from matplotlib.lines import Line2D
    legend_elements = [
        Line2D([0], [0], color='green', linewidth=4, 
               label='Fast transition (<10s pause)'),
        Line2D([0], [0], color='orange', linewidth=4,
               label='Medium pause (10-30s)'),
        Line2D([0], [0], color='red', linewidth=4,
               label='Long pause (>30s) - Struggle point')
    ]
    ax.legend(handles=legend_elements, loc='upper right', fontsize=14)
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    print(f"\n✓ Motion graph saved to {output_path}")
    
    plt.close()


def visualize_linear_flow(
    ordered_steps,
    video_id,
    recipe_id,
    recipe_name,
    node_counts,
    transition_counts,
    node_avg_pause,
    output_path='../outputs/figures/motion_graph_linear.png',
    columns=8
):
    """
    Visualize one ordered action sequence in linear reading order (left-to-right, top-to-bottom).
    Each node is indexed to make action order explicit.
    """
    print("\n" + "="*80)
    print("VISUALIZING LINEAR FLOW")
    print("="*80)

    if not ordered_steps:
        print("⚠️  No actions available for linear flow visualization")
        return

    actions = [s['action'] for s in ordered_steps]
    edge_pauses = [float(s['pause_after']) for s in ordered_steps[:-1]]

    num_actions = len(actions)
    columns = max(4, columns)
    rows = int(np.ceil(num_actions / columns))

    fig_width = min(26, max(14, columns * 2.8))
    fig_height = min(24, max(8, rows * 2.5))
    fig, ax = plt.subplots(figsize=(fig_width, fig_height))

    positions = {}
    for idx in range(num_actions):
        row = idx // columns
        col = idx % columns
        x = col
        y = -row
        positions[idx] = (x, y)

    max_transition_freq = max(transition_counts.values()) if transition_counts else 1

    # Draw arrows following sequence order
    for idx in range(num_actions - 1):
        x1, y1 = positions[idx]
        x2, y2 = positions[idx + 1]
        src = actions[idx]
        dst = actions[idx + 1]
        pause = edge_pauses[idx] if idx < len(edge_pauses) else 0.0
        freq = transition_counts.get((src, dst), 1)

        edge_width = 1.2 + 3.8 * (freq / max_transition_freq)
        if pause > 30:
            edge_color = '#DC2626'
        elif pause > 10:
            edge_color = '#F59E0B'
        else:
            edge_color = '#16A34A'

        ax.annotate(
            "",
            xy=(x2, y2),
            xytext=(x1, y1),
            arrowprops=dict(arrowstyle="->", color=edge_color, lw=edge_width, alpha=0.85),
        )

    max_node_freq = max(node_counts.values()) if node_counts else 1
    max_node_pause = max(node_avg_pause.values()) if node_avg_pause else 1.0
    if max_node_pause <= 0:
        max_node_pause = 1.0

    # Draw numbered nodes and labels
    for idx, action in enumerate(actions):
        x, y = positions[idx]
        freq = node_counts.get(action, 1)
        avg_pause = node_avg_pause.get(action, 0.0)
        node_size = 300 + 700 * (freq / max_node_freq)

        ax.scatter(
            [x],
            [y],
            s=node_size,
            c=[avg_pause],
            cmap='YlOrRd',
            vmin=0,
            vmax=max_node_pause,
            edgecolors="#1D4ED8",
            linewidths=1.4,
            zorder=3
        )
        ax.text(x, y, str(idx + 1), ha='center', va='center', fontsize=8, fontweight='bold', color='#0F172A', zorder=4)

        short_action = action if len(action) <= 34 else action[:31] + '...'
        ax.text(x, y - 0.28, short_action, ha='center', va='top', fontsize=7.5, color='#111827')

    ax.set_title(
        f'Linear Action Flow (Indexed): {recipe_name} ({recipe_id}) | {video_id}\n'
        f'Left-to-right, then top-to-bottom',
        fontsize=15,
        fontweight='bold',
        pad=18,
    )

    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_xlim(-0.6, columns - 0.4)
    ax.set_ylim(-rows + 0.4, 0.8)
    ax.set_frame_on(False)

    # Legends for report clarity
    from matplotlib.lines import Line2D
    edge_legend = [
        Line2D([0], [0], color='#16A34A', lw=3, label='Edge color: fast transition (<10s pause)'),
        Line2D([0], [0], color='#F59E0B', lw=3, label='Edge color: medium pause (10-30s)'),
        Line2D([0], [0], color='#DC2626', lw=3, label='Edge color: long pause (>30s)'),
        Line2D([0], [0], color='#334155', lw=5, label='Edge width: transition frequency'),
        Line2D([0], [0], marker='o', color='w', markerfacecolor='#93C5FD', markeredgecolor='#1D4ED8', markersize=12, label='Node size: action frequency')
    ]
    ax.legend(handles=edge_legend, loc='upper right', fontsize=8, frameon=True)

    # Colorbar for node color encoding
    sm = plt.cm.ScalarMappable(cmap='YlOrRd', norm=plt.Normalize(vmin=0, vmax=max_node_pause))
    sm.set_array([])
    cbar = plt.colorbar(sm, ax=ax, fraction=0.02, pad=0.01)
    cbar.set_label('Node color: avg post-action pause (s)', fontsize=8)

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    print(f"✓ Linear flow saved to {output_path}")
    plt.close()


def save_graph_data(G, output_path='../outputs/graphs/motion_graph.pkl'):
    """Save graph object for later use"""
    with open(output_path, 'wb') as f:
        pickle.dump(G, f)
    print(f"✓ Graph data saved to {output_path}")


def main():
    # Optional CLI usage:
    #   python 3a_motion_graph.py P08_R01
    # If omitted, most recent selected_recipe_*.json is used.
    recipe_id_arg = sys.argv[1].strip() if len(sys.argv) > 1 else None

    # Load data
    data = load_hd_epic_data('..')
    
    # Load recipe selection outputs
    recipe_info, recipe_narrations = load_selected_recipe_files('../outputs', recipe_id_arg)
    recipe_id = recipe_info['recipe_id']
    recipe_name = recipe_info.get('recipe_data', {}).get('name', 'Unknown Recipe')
    
    print(f"\nAnalyzing recipe: {recipe_id} ({recipe_name})")
    print(f"Videos: {len(recipe_info['video_ids'])}")
    print(f"Actions: {recipe_info['narrations_count']}")

    motion_graph_img = f'../outputs/figures/motion_graph_{recipe_id}_new2.png'
    linear_flow_img = f'../outputs/figures/motion_graph_linear_{recipe_id}_new2.png'
    
    # Build graph
    G = build_motion_graph(
        recipe_narrations,
        data['verb_classes'],
        data['noun_classes']
    )
    
    # Visualize
    # visualize_motion_graph(
    #     G,
    #     recipe_id,
    #     recipe_name,
    #     recipe_narrations,
    #     data['verb_classes'],
    #     data['noun_classes'],
    #     output_path=motion_graph_img
    # )
    visualize_motion_graph_v3(
        G,
        recipe_id,
        recipe_name,
        narrations_df=recipe_narrations,       # your existing df
        verb_classes_df=data['verb_classes'],
        noun_classes_df=data['noun_classes'],
        get_action_name_fn=get_action_name,    # your existing utility
        output_path=motion_graph_img,
    )

    # Also create a sequence-first view for reports
    sequence_video_id, ordered_steps, node_counts, transition_counts, node_avg_pause = extract_ordered_actions(
        recipe_narrations,
        data['verb_classes'],
        data['noun_classes']
    )
    visualize_linear_flow(
        ordered_steps,
        sequence_video_id,
        recipe_id,
        recipe_name,
        node_counts,
        transition_counts,
        node_avg_pause,
        output_path=linear_flow_img
    )
    
    # Save
    save_graph_data(G)
    
    print("\n" + "="*80)
    print("MOTION GRAPH COMPLETE")
    print("="*80)
    print("\nNext step: Run 4_visualize_flow_maps.py for flow map analysis")

if __name__ == "__main__":
    main()