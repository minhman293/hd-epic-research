"""
visualize_motion_graph_v3.py

Drop-in replacement for the visualize_motion_graph() function.
Target style: Image 3 (Gemini reference) — process flow graph with:
  - Strict left-to-right temporal layout (Sugiyama/hierarchical)
  - START and END sentinel nodes
  - Explicit cycle arcs (self-loops + back-edges drawn as curved arcs above the flow)
    - Uniform edge style (no pause-based color encoding)
    - Dashed cycle/back edges to distinguish reverse direction
  - Node color encodes action category (verb-based)
  - Readable node labels, no label truncation overlap

Dependencies: networkx, matplotlib, numpy
No pygraphviz required.
"""

import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.patheffects as pe
import networkx as nx
from collections import defaultdict


# ─────────────────────────────────────────────────────────────────────────────
# STEP 1: Compute a left-to-right hierarchical layout
# ─────────────────────────────────────────────────────────────────────────────

def compute_hierarchical_layout(G, narrations_df, get_action_name_fn,
                                 verb_classes_df, noun_classes_df):
    """
    Assign x-position = median normalized sequence index across all observed videos.
    y-position = spread nodes at the same x-rank vertically with no overlap.

    Returns: dict {node: (x, y)}
    """
    node_seq_positions = defaultdict(list)

    for video_id in narrations_df['video_id'].unique():
        video_df = narrations_df[
            narrations_df['video_id'] == video_id
        ].sort_values('start_timestamp')

        seq = []
        for _, row in video_df.iterrows():
            if row['main_action_classes'] and len(row['main_action_classes']) > 0:
                vc, nc = row['main_action_classes'][0]
                name = get_action_name_fn(vc, nc, verb_classes_df, noun_classes_df)
                seq.append(name)

        n = max(len(seq) - 1, 1)
        for i, action in enumerate(seq):
            node_seq_positions[action].append(i / n)

    # Median normalized position → x rank
    node_median_x = {}
    for node in G.nodes():
        if node in ('START', 'END'):
            continue
        positions = node_seq_positions.get(node, [0.5])
        node_median_x[node] = float(np.median(positions))

    # Snap to discrete columns (20 columns across 0→1)
    N_COLS = 20
    col_buckets = defaultdict(list)
    for node, x in node_median_x.items():
        col = round(x * (N_COLS - 1))
        col_buckets[col].append(node)

    pos = {}
    X_SCALE = 3.0   # horizontal spacing between columns
    Y_SCALE = 1.8   # vertical spacing within a column

    for col, nodes_in_col in col_buckets.items():
        n = len(nodes_in_col)
        for i, node in enumerate(sorted(nodes_in_col)):
            y = (i - (n - 1) / 2.0) * Y_SCALE
            pos[node] = (col * X_SCALE, y)

    # Place START far left, END far right
    all_x = [p[0] for p in pos.values()] if pos else [0]
    pos['START'] = (min(all_x) - X_SCALE * 2, 0)
    pos['END']   = (max(all_x) + X_SCALE * 2, 0)

    return pos


# ─────────────────────────────────────────────────────────────────────────────
# STEP 2: Classify edges into forward / backward (cycle) / self-loop
# ─────────────────────────────────────────────────────────────────────────────

def classify_edges(G, pos):
    """
    Returns three lists:
      forward_edges  — edges where target.x > source.x  (main flow)
      back_edges     — edges where target.x <= source.x (cycles / backward jumps)
      self_loops     — edges where source == target
    """
    forward, back, loops = [], [], []
    for u, v, data in G.edges(data=True):
        if u == v:
            loops.append((u, v, data))
        elif pos[v][0] > pos[u][0]:
            forward.append((u, v, data))
        else:
            back.append((u, v, data))
    return forward, back, loops


# ─────────────────────────────────────────────────────────────────────────────
# STEP 3: Determine edge visual properties
# ─────────────────────────────────────────────────────────────────────────────

def edge_style():
    """Return a uniform edge style (no pause-based encoding)."""
    return '#64748B', 1.8, 0.85


# ─────────────────────────────────────────────────────────────────────────────
# STEP 4: Determine node visual properties
# ─────────────────────────────────────────────────────────────────────────────

# Verb-to-color category mapping (extend as needed)
VERB_COLORS = {
    'take':     '#3B82F6',   # blue  — acquire
    'put':      '#8B5CF6',   # purple — place
    'open':     '#06B6D4',   # cyan  — open/close
    'close':    '#06B6D4',
    'pour':     '#F97316',   # orange — pour/scoop
    'scoop':    '#F97316',
    'mix':      '#F97316',
    'press':    '#EF4444',   # red   — apply force
    'crush':    '#EF4444',
    'turn-on':  '#10B981',   # green — machine ops
    'turn-off': '#10B981',
    'wait':     '#6B7280',   # gray  — idle
    'check':    '#6B7280',
    'carry':    '#3B82F6',
    'move':     '#3B82F6',
    'slide':    '#3B82F6',
    'search':   '#6B7280',
    'write':    '#6B7280',
    'adjust':   '#6B7280',
    'finish':   '#10B981',
}
DEFAULT_NODE_COLOR = '#94A3B8'  # slate — unknown verb


def get_node_color(node_name):
    """Extract verb from 'verb(noun)' format and map to color."""
    if node_name in ('START', 'END'):
        return '#1F2937'
    verb = node_name.split('(')[0].lower().strip()
    return VERB_COLORS.get(verb, DEFAULT_NODE_COLOR)


# ─────────────────────────────────────────────────────────────────────────────
# STEP 5: Main visualization function (drop-in replacement)
# ─────────────────────────────────────────────────────────────────────────────

def visualize_motion_graph_v3(G, recipe_id, recipe_name,
                               narrations_df, verb_classes_df, noun_classes_df,
                               get_action_name_fn,
                               output_path='../outputs/figures/motion_graph.png'):
    """
    Visualize a motion graph in process-flow style (Image 3 reference).

    Parameters
    ----------
    G                  : nx.DiGraph — the motion graph (already built)
    recipe_id          : str
    recipe_name        : str
    narrations_df      : pd.DataFrame — used to compute topological layout
    verb_classes_df    : pd.DataFrame
    noun_classes_df    : pd.DataFrame
    get_action_name_fn : callable — your existing get_action_name() utility
    output_path        : str
    """

    print("\n" + "=" * 80)
    print("VISUALIZING MOTION GRAPH (v3 — process flow style)")
    print("=" * 80)

    # ── 5a. Add START / END sentinels ────────────────────────────────────────
    # Find first and last actions across all observed sequences
    G = G.copy()   # don't mutate the original

    first_actions = []
    last_actions  = []
    for video_id in narrations_df['video_id'].unique():
        video_df = narrations_df[
            narrations_df['video_id'] == video_id
        ].sort_values('start_timestamp')
        seq = []
        for _, row in video_df.iterrows():
            if row['main_action_classes'] and len(row['main_action_classes']) > 0:
                vc, nc = row['main_action_classes'][0]
                seq.append(get_action_name_fn(vc, nc, verb_classes_df, noun_classes_df))
        if seq:
            first_actions.append(seq[0])
            last_actions.append(seq[-1])

    G.add_node('START')
    G.add_node('END')
    for action in set(first_actions):
        G.add_edge('START', action, weight=first_actions.count(action))
    for action in set(last_actions):
        G.add_edge(action, 'END', weight=last_actions.count(action))

    # ── 5b. Layout ────────────────────────────────────────────────────────────
    print("Computing hierarchical layout...")
    pos = compute_hierarchical_layout(
        G, narrations_df, get_action_name_fn, verb_classes_df, noun_classes_df
    )
    # Make sure START/END are in pos (added above)
    # (compute_hierarchical_layout already handles START/END)

    # ── 5c. Classify edges ────────────────────────────────────────────────────
    forward_edges, back_edges, self_loop_edges = classify_edges(G, pos)

    # ── 5d. Figure setup ──────────────────────────────────────────────────────
    fig, ax = plt.subplots(figsize=(28, 16))
    ax.set_facecolor('white')
    fig.patch.set_facecolor('white')

    # ── 5e. Draw forward edges (main flow) ────────────────────────────────────
    print("Drawing forward edges (main flow)...")
    for u, v, data in forward_edges:
        color, lw, alpha = edge_style()
        # Use a slight upward curve for forward edges to avoid label overlap
        nx.draw_networkx_edges(
            G, pos,
            edgelist=[(u, v)],
            width=lw,
            edge_color=color,
            alpha=alpha,
            arrows=True,
            arrowsize=18,
            arrowstyle='->',
            connectionstyle='arc3,rad=-0.05',
            ax=ax,
            min_source_margin=22,
            min_target_margin=22,
        )

    # ── 5f. Draw back-edges (cycles) as arcs above the graph ─────────────────
    print("Drawing cycle edges (back-edges)...")
    for u, v, data in back_edges:
        color, lw, alpha = edge_style()
        # Large positive rad = arc curves strongly upward → clearly visible as cycle
        rad = 0.5 + 0.3 * min(
            abs(pos[u][0] - pos[v][0]) / (max(pos[n][0] for n in pos) + 1),
            0.8
        )
        nx.draw_networkx_edges(
            G, pos,
            edgelist=[(u, v)],
            width=lw,
            edge_color=color,
            alpha=alpha,
            arrows=True,
            arrowsize=16,
            arrowstyle='->',
            connectionstyle=f'arc3,rad={rad}',
            ax=ax,
            min_source_margin=22,
            min_target_margin=22,
            style='dashed',    # dashed = visual distinction for cycles (Image 3 convention)
        )

    # ── 5g. Draw self-loops ───────────────────────────────────────────────────
    for u, v, data in self_loop_edges:
        color, lw, alpha = edge_style()
        x, y = pos[u]
        loop = mpatches.FancyArrowPatch(
            posA=(x - 0.3, y + 0.5),
            posB=(x + 0.3, y + 0.5),
            arrowstyle=mpatches.ArrowStyle('Simple', head_width=6, head_length=6),
            connectionstyle='arc3,rad=-1.2',
            color=color,
            linewidth=lw,
            alpha=alpha,
            linestyle='dashed',
            zorder=2,
        )
        ax.add_patch(loop)
        ax.text(x, y + 1.1, '↻', fontsize=10, color=color,
                ha='center', va='center', fontweight='bold')

    # ── 5h. Draw nodes ────────────────────────────────────────────────────────
    print("Drawing nodes...")
    node_degrees = dict(G.degree(weight='weight'))
    max_deg = max(node_degrees.values()) if node_degrees else 1

    for node in G.nodes():
        x, y = pos[node]
        deg = node_degrees.get(node, 1)

        if node in ('START', 'END'):
            # Sentinel nodes: dark circle, white text
            circle = plt.Circle((x, y), 0.55, color='#1F2937', zorder=4)
            ax.add_patch(circle)
            ax.text(x, y, node, fontsize=9, fontweight='bold',
                    color='white', ha='center', va='center', zorder=5)
        else:
            # Regular nodes: colored circle sized by degree
            size_r = 0.35 + 0.45 * (deg / max_deg)
            color = get_node_color(node)
            circle = plt.Circle((x, y), size_r, color=color,
                                  ec='#1e293b', linewidth=1.2, zorder=4)
            ax.add_patch(circle)

            # Short label inside node (verb only) + full label below
            verb = node.split('(')[0]
            noun_part = node[len(verb):]  # e.g. "(cup)"
            ax.text(x, y, verb, fontsize=7, fontweight='bold',
                    color='white', ha='center', va='center', zorder=5,
                    path_effects=[pe.withStroke(linewidth=1.5, foreground=color)])
            ax.text(x, y - size_r - 0.18, noun_part,
                    fontsize=6.5, color='#334155',
                    ha='center', va='top', zorder=5,
                    path_effects=[pe.withStroke(linewidth=2, foreground='white')])

    # ── 5i. Legend ────────────────────────────────────────────────────────────
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch

    edge_legend = [
         Line2D([0], [0], color='#64748B', lw=2.5, label='Forward transition'),
         Line2D([0], [0], color='#64748B', lw=2.5, linestyle='dashed',
             label='Cycle / back-edge / self-loop'),
         Line2D([0], [0], color='#1F2937', lw=0, marker='>', markersize=7,
             label='Arrow direction = temporal direction'),
    ]
    node_legend = [
        Patch(color='#3B82F6', label='Take / carry / move'),
        Patch(color='#8B5CF6', label='Put / place'),
        Patch(color='#F97316', label='Pour / scoop / mix'),
        Patch(color='#EF4444', label='Press / crush'),
        Patch(color='#06B6D4', label='Open / close'),
        Patch(color='#10B981', label='Machine ops / finish'),
        Patch(color='#6B7280', label='Wait / check / search'),
        Patch(color='#94A3B8', label='Other'),
    ]

    leg1 = ax.legend(handles=edge_legend, loc='upper left',
                     fontsize=9, title='Edge encoding', title_fontsize=10,
                     framealpha=0.95, edgecolor='#CBD5E1')
    ax.add_artist(leg1)
    ax.legend(handles=node_legend, loc='lower left',
              fontsize=9, title='Node color = verb category', title_fontsize=10,
              framealpha=0.95, edgecolor='#CBD5E1')

    # ── 5j. Title and axis ────────────────────────────────────────────────────
    n_videos = narrations_df['video_id'].nunique()
    ax.set_title(
        f'Recipe Motion Graph: {recipe_name} ({recipe_id})\n'
        f'{G.number_of_nodes() - 2} action states  ·  '
        f'{G.number_of_edges()} transitions  ·  '
        f'{n_videos} video{"s" if n_videos != 1 else ""}',
        fontsize=16, fontweight='bold', pad=16,
    )
    ax.axis('off')

    # Tight bounds
    all_x = [p[0] for p in pos.values()]
    all_y = [p[1] for p in pos.values()]
    ax.set_xlim(min(all_x) - 3, max(all_x) + 3)
    ax.set_ylim(min(all_y) - 2.5, max(all_y) + 2.5)

    plt.tight_layout()
    plt.savefig(output_path, dpi=200, bbox_inches='tight',
                facecolor='white', edgecolor='none')
    print(f"✓ Motion graph (v3) saved to {output_path}")
    plt.close()