"""
5_dataset_challenges.py

Visualize the four structural challenges of HD-EPIC across all 69 recipes
and 80 captures. Produces figures that help choose which recipes to visualize
next in the dashboard, by showing which ones exhibit the most interesting
non-linear cooking behavior.

Challenges analyzed:
  1. Out-of-order step execution (50/80 captures)
  2. Step revisitation (341/463 non-empty step-instances have >1 window)
  3. Temporal overlap between steps (25 same-video pairs in 12/80 captures)
  4. Window duration heterogeneity (median 9.8s, range <1s to >2min)

Usage:
  python 5_dataset_challenges.py

Outputs (saved to ../outputs/figures/):
  - dataset_challenge_overview.png   — per-recipe challenge profile (the main figure)
  - dataset_challenge_distributions.png — histograms of each challenge metric
  - dataset_recipe_recommendation.png  — top candidate recipes to visualize next
"""

import json
import os
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from collections import defaultdict

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

RECIPES_PATH = os.path.join(os.path.dirname(__file__), 'high-level', 'complete_recipes.json')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), 'outputs', 'figures')

# ─────────────────────────────────────────────────────────────────────────────
# Data loading
# ─────────────────────────────────────────────────────────────────────────────

def load_recipes(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


# ─────────────────────────────────────────────────────────────────────────────
# Per-capture analysis
# ─────────────────────────────────────────────────────────────────────────────

def analyze_capture(recipe_entry, capture_idx, capture):
    """Compute all challenge metrics for one capture."""
    steps = recipe_entry.get('steps', {})
    step_order = list(steps.keys())
    st = capture.get('step_times', {})

    # ── 1. Out-of-order ──────────────────────────────────────────────────
    onsets = {}
    for sid, windows in st.items():
        if windows:
            onsets[sid] = min(w['start'] for w in windows)

    ordered_present = [s for s in step_order if s in onsets]
    out_of_order = False
    for i in range(1, len(ordered_present)):
        if onsets[ordered_present[i]] < onsets[ordered_present[i - 1]]:
            out_of_order = True
            break

    # ── 2. Revisitation ──────────────────────────────────────────────────
    window_counts = []
    for sid, windows in st.items():
        if windows:
            window_counts.append(len(windows))
    total_windows = sum(window_counts)
    multi_window_steps = sum(1 for c in window_counts if c > 1)
    max_windows = max(window_counts) if window_counts else 0

    # ── 3. Same-video overlap ────────────────────────────────────────────
    flat = []
    for sid, windows in st.items():
        for w in windows:
            flat.append((sid, w['start'], w['end'], w.get('video', '')))

    overlap_pairs = 0
    for i in range(len(flat)):
        for j in range(i + 1, len(flat)):
            s1, a1, b1, v1 = flat[i]
            s2, a2, b2, v2 = flat[j]
            if s1 == s2:
                continue
            if v1 != v2:
                continue
            if a1 < b2 and a2 < b1:
                overlap_pairs += 1

    # ── 4. Duration stats ────────────────────────────────────────────────
    durations = []
    for sid, windows in st.items():
        for w in windows:
            durations.append(w['end'] - w['start'])

    return {
        'out_of_order': out_of_order,
        'total_windows': total_windows,
        'multi_window_steps': multi_window_steps,
        'max_windows_per_step': max_windows,
        'overlap_pairs': overlap_pairs,
        'durations': durations,
        'n_steps_with_data': len(window_counts),
    }


def analyze_all(recipes):
    """Analyze every capture in the dataset."""
    per_recipe = []
    all_durations = []
    all_window_counts_per_step = []

    for rid, r in recipes.items():
        n_steps = len(r.get('steps', {}))
        captures = r.get('captures', [])

        recipe_out_of_order = False
        recipe_max_revisit = 0
        recipe_total_overlap = 0
        recipe_total_windows = 0
        recipe_durations = []

        for ci, cap in enumerate(captures):
            res = analyze_capture(r, ci, cap)
            if res['out_of_order']:
                recipe_out_of_order = True
            recipe_max_revisit = max(recipe_max_revisit, res['max_windows_per_step'])
            recipe_total_overlap += res['overlap_pairs']
            recipe_total_windows += res['total_windows']
            recipe_durations.extend(res['durations'])
            all_durations.extend(res['durations'])

            # per-step window counts
            for sid, windows in cap.get('step_times', {}).items():
                if windows:
                    all_window_counts_per_step.append(len(windows))

        dur_range = (min(recipe_durations), max(recipe_durations)) if recipe_durations else (0, 0)
        dur_median = float(np.median(recipe_durations)) if recipe_durations else 0

        per_recipe.append({
            'id': rid,
            'name': r.get('name', rid),
            'n_steps': n_steps,
            'n_captures': len(captures),
            'out_of_order': recipe_out_of_order,
            'max_revisit': recipe_max_revisit,
            'overlap_pairs': recipe_total_overlap,
            'total_windows': recipe_total_windows,
            'dur_min': dur_range[0],
            'dur_max': dur_range[1],
            'dur_median': dur_median,
            'durations': recipe_durations,
        })

    # Sort by challenge "interestingness" — recipes with more challenges first
    per_recipe.sort(key=lambda x: (
        x['overlap_pairs'] > 0,       # has overlap
        x['out_of_order'],             # has reordering
        x['max_revisit'],              # revisitation depth
        x['n_steps'],                  # complexity
    ), reverse=True)

    return per_recipe, all_durations, all_window_counts_per_step


# ─────────────────────────────────────────────────────────────────────────────
# Figure 1: Per-recipe challenge profile (main figure)
# ─────────────────────────────────────────────────────────────────────────────

def plot_overview(per_recipe):
    """One row per recipe. Columns: steps, windows, reorder, revisit, overlap."""
    n = len(per_recipe)
    fig, axes = plt.subplots(1, 5, figsize=(22, max(12, n * 0.28)),
                             gridspec_kw={'width_ratios': [1.2, 1.5, 0.6, 1.2, 0.8]})

    labels = [f"{r['name'][:18]} ({r['id']})" for r in per_recipe]
    y = np.arange(n)

    # Colors
    C_BLUE = '#4E79A7'
    C_AMBER = '#F28E2B'
    C_RED = '#E15759'
    C_TEAL = '#76B7B2'
    C_GREEN = '#59A14F'
    C_GRAY = '#BAB0AC'

    # ── Col 1: Step count ────────────────────────────────────────────────
    ax = axes[0]
    steps = [r['n_steps'] for r in per_recipe]
    ax.barh(y, steps, color=C_BLUE, edgecolor='white', linewidth=0.3)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=7)
    ax.set_xlabel('Steps', fontsize=9, fontweight='bold')
    ax.set_title('Recipe steps', fontsize=10, fontweight='bold')
    ax.invert_yaxis()
    ax.grid(axis='x', alpha=0.2)
    ax.set_xticks(range(0, max(steps) + 5, 5))

    # ── Col 2: Total windows ────────────────────────────────────────────
    ax = axes[1]
    windows = [r['total_windows'] for r in per_recipe]
    ax.barh(y, windows, color=C_AMBER, edgecolor='white', linewidth=0.3)
    ax.set_yticks([])
    ax.set_xlabel('Total windows', fontsize=9, fontweight='bold')
    ax.set_title('Step-time windows', fontsize=10, fontweight='bold')
    ax.invert_yaxis()
    ax.grid(axis='x', alpha=0.2)

    # ── Col 3: Out-of-order (boolean dot) ────────────────────────────────
    ax = axes[2]
    for i, r in enumerate(per_recipe):
        color = C_RED if r['out_of_order'] else C_GRAY
        marker = '●' if r['out_of_order'] else '○'
        ax.text(0.5, i, marker, ha='center', va='center', fontsize=11,
                color=color, fontweight='bold')
    ax.set_xlim(0, 1)
    ax.set_ylim(-0.5, n - 0.5)
    ax.set_yticks([])
    ax.set_xticks([])
    ax.set_title('Out of\norder?', fontsize=10, fontweight='bold')
    ax.invert_yaxis()

    # ── Col 4: Max revisitation depth ────────────────────────────────────
    ax = axes[3]
    revisits = [r['max_revisit'] for r in per_recipe]
    colors = [C_RED if v >= 10 else C_AMBER if v >= 5 else C_TEAL for v in revisits]
    ax.barh(y, revisits, color=colors, edgecolor='white', linewidth=0.3)
    ax.set_yticks([])
    ax.set_xlabel('Max windows/step', fontsize=9, fontweight='bold')
    ax.set_title('Revisitation depth', fontsize=10, fontweight='bold')
    ax.invert_yaxis()
    ax.grid(axis='x', alpha=0.2)

    # ── Col 5: Overlap pairs ────────────────────────────────────────────
    ax = axes[4]
    overlaps = [r['overlap_pairs'] for r in per_recipe]
    colors_ov = [C_RED if v > 0 else C_GRAY for v in overlaps]
    ax.barh(y, overlaps, color=colors_ov, edgecolor='white', linewidth=0.3)
    ax.set_yticks([])
    ax.set_xlabel('Pairs', fontsize=9, fontweight='bold')
    ax.set_title('Step\noverlap', fontsize=10, fontweight='bold')
    ax.invert_yaxis()
    ax.grid(axis='x', alpha=0.2)

    fig.suptitle('HD-EPIC Dataset — Per-Recipe Challenge Profile',
                 fontsize=14, fontweight='bold', y=1.01)
    fig.tight_layout()
    return fig


# ─────────────────────────────────────────────────────────────────────────────
# Figure 2: Challenge distribution histograms
# ─────────────────────────────────────────────────────────────────────────────

def plot_distributions(per_recipe, all_durations, all_window_counts):
    fig, axes = plt.subplots(2, 2, figsize=(14, 10))

    C_BLUE = '#4E79A7'
    C_AMBER = '#F28E2B'
    C_RED = '#E15759'
    C_TEAL = '#76B7B2'

    # ── 2a: Steps per recipe ─────────────────────────────────────────────
    ax = axes[0, 0]
    steps = [r['n_steps'] for r in per_recipe]
    ax.hist(steps, bins=range(1, max(steps) + 2), color=C_BLUE, edgecolor='white',
            align='left')
    ax.axvline(np.median(steps), color=C_RED, linestyle='--', linewidth=1.5,
               label=f'Median = {np.median(steps):.0f}')
    ax.set_xlabel('Steps per recipe')
    ax.set_ylabel('Count')
    ax.set_title('Recipe complexity (step count)', fontweight='bold')
    ax.legend()
    ax.grid(axis='y', alpha=0.2)

    # ── 2b: Windows per step (revisitation) ──────────────────────────────
    ax = axes[0, 1]
    bins_wc = list(range(1, min(max(all_window_counts) + 2, 22)))
    ax.hist(all_window_counts, bins=bins_wc, color=C_AMBER, edgecolor='white',
            align='left')
    single = sum(1 for c in all_window_counts if c == 1)
    multi = sum(1 for c in all_window_counts if c > 1)
    ax.set_xlabel('Windows per step-instance')
    ax.set_ylabel('Count')
    ax.set_title(f'Step revisitation (1 window: {single}, >1: {multi})',
                 fontweight='bold')
    ax.grid(axis='y', alpha=0.2)

    # ── 2c: Window durations ─────────────────────────────────────────────
    ax = axes[1, 0]
    # Clip at 120s for visibility, note the outliers
    clipped = [min(d, 120) for d in all_durations]
    ax.hist(clipped, bins=60, color=C_TEAL, edgecolor='white')
    ax.axvline(np.median(all_durations), color=C_RED, linestyle='--', linewidth=1.5,
               label=f'Median = {np.median(all_durations):.1f}s')
    sub1 = sum(1 for d in all_durations if d < 1)
    over120 = sum(1 for d in all_durations if d > 120)
    ax.set_xlabel('Window duration (seconds, clipped at 120s)')
    ax.set_ylabel('Count')
    ax.set_title(f'Duration heterogeneity (sub-1s: {sub1}, >2min: {over120})',
                 fontweight='bold')
    ax.legend()
    ax.grid(axis='y', alpha=0.2)

    # ── 2d: Challenge co-occurrence ──────────────────────────────────────
    ax = axes[1, 1]
    # For each recipe, count how many of the 3 boolean challenges it has
    categories = {
        'None': 0,
        'Reorder only': 0,
        'Revisit only (>5)': 0,
        'Overlap only': 0,
        'Reorder + Revisit': 0,
        'Reorder + Overlap': 0,
        'All three': 0,
        'Other combo': 0,
    }
    for r in per_recipe:
        has_reorder = r['out_of_order']
        has_revisit = r['max_revisit'] >= 5
        has_overlap = r['overlap_pairs'] > 0

        if has_reorder and has_revisit and has_overlap:
            categories['All three'] += 1
        elif has_reorder and has_overlap:
            categories['Reorder + Overlap'] += 1
        elif has_reorder and has_revisit:
            categories['Reorder + Revisit'] += 1
        elif has_reorder:
            categories['Reorder only'] += 1
        elif has_revisit:
            categories['Revisit only (>5)'] += 1
        elif has_overlap:
            categories['Overlap only'] += 1
        elif not has_reorder and not has_revisit and not has_overlap:
            categories['None'] += 1
        else:
            categories['Other combo'] += 1

    # Filter out zero categories
    cats = {k: v for k, v in categories.items() if v > 0}
    colors_pie = ['#BAB0AC', '#4E79A7', '#F28E2B', '#76B7B2',
                  '#E15759', '#8B5CF6', '#F97316', '#59A14F']
    ax.bar(range(len(cats)), list(cats.values()),
           color=colors_pie[:len(cats)], edgecolor='white')
    ax.set_xticks(range(len(cats)))
    ax.set_xticklabels(list(cats.keys()), rotation=35, ha='right', fontsize=8)
    ax.set_ylabel('Recipe count')
    ax.set_title('Challenge co-occurrence across 69 recipes', fontweight='bold')
    ax.grid(axis='y', alpha=0.2)

    fig.suptitle('HD-EPIC Dataset — Challenge Distributions',
                 fontsize=14, fontweight='bold')
    fig.tight_layout()
    return fig


# ─────────────────────────────────────────────────────────────────────────────
# Figure 3: Recipe recommendation — top candidates for next visualization
# ─────────────────────────────────────────────────────────────────────────────

def plot_recommendation(per_recipe):
    """Scatter: x = steps, y = max revisitation, size = windows, color = overlap."""

    fig, ax = plt.subplots(figsize=(14, 9))

    C_RED = '#E15759'
    C_TEAL = '#76B7B2'
    C_GRAY = '#D1D5DB'

    already_visualized = {'P01_R01', 'P08_R01'}

    for r in per_recipe:
        x = r['n_steps']
        y = r['max_revisit']
        s = max(r['total_windows'] * 3, 30)

        if r['id'] in already_visualized:
            color = '#2563EB'
            edge = '#1e40af'
            zorder = 10
        elif r['overlap_pairs'] > 0:
            color = C_RED
            edge = '#991b1b'
            zorder = 5
        elif r['out_of_order']:
            color = '#F28E2B'
            edge = '#92400e'
            zorder = 4
        else:
            color = C_GRAY
            edge = '#9ca3af'
            zorder = 2

        ax.scatter(x, y, s=s, c=color, edgecolors=edge, linewidth=0.8,
                   alpha=0.8, zorder=zorder)

        # Label interesting recipes
        is_interesting = (r['overlap_pairs'] > 0
                          or r['max_revisit'] >= 10
                          or r['n_steps'] >= 10
                          or r['id'] in already_visualized)
        if is_interesting:
            label = f"{r['name'][:16]}\n({r['id']})"
            ax.annotate(label, (x, y),
                        textcoords='offset points', xytext=(8, 6),
                        fontsize=6.5, color='#374151',
                        arrowprops=dict(arrowstyle='-', color='#9ca3af',
                                        lw=0.4))

    ax.set_xlabel('Number of recipe steps', fontsize=11, fontweight='bold')
    ax.set_ylabel('Max revisitation depth (windows per step)', fontsize=11,
                  fontweight='bold')
    ax.set_title('Recipe Candidates for Dashboard Visualization',
                 fontsize=13, fontweight='bold', pad=12)
    ax.grid(True, alpha=0.15)

    # Legend
    legend_elements = [
        mpatches.Patch(facecolor='#2563EB', edgecolor='#1e40af',
                       label='Already visualized (P01_R01, P08_R01)'),
        mpatches.Patch(facecolor=C_RED, edgecolor='#991b1b',
                       label='Has step overlap (parallel execution)'),
        mpatches.Patch(facecolor='#F28E2B', edgecolor='#92400e',
                       label='Has out-of-order execution'),
        mpatches.Patch(facecolor=C_GRAY, edgecolor='#9ca3af',
                       label='No major challenges'),
    ]
    ax.legend(handles=legend_elements, loc='upper left', fontsize=9,
              framealpha=0.9)

    # Annotation: top-right = most complex + most revisited
    ax.text(0.97, 0.97,
            'Upper-right = most complex\n(many steps + deep revisitation)',
            transform=ax.transAxes, ha='right', va='top', fontsize=8,
            color='#6b7280', style='italic')

    fig.tight_layout()
    return fig


# ─────────────────────────────────────────────────────────────────────────────
# Figure 4: Per-recipe duration boxplots for the top-20 most complex
# ─────────────────────────────────────────────────────────────────────────────

def plot_duration_boxplots(per_recipe, top_n=20):
    """Show duration heterogeneity per recipe for the most complex ones."""
    # Sort by total windows descending
    by_windows = sorted(per_recipe, key=lambda r: r['total_windows'], reverse=True)
    subset = [r for r in by_windows if len(r['durations']) >= 5][:top_n]

    fig, ax = plt.subplots(figsize=(14, 8))

    data = [r['durations'] for r in subset]
    labels = [f"{r['name'][:16]} ({r['id']})" for r in subset]

    bp = ax.boxplot(data, vert=False, patch_artist=True,
                    widths=0.6,
                    boxprops=dict(facecolor='#E0F2FE', edgecolor='#4E79A7'),
                    medianprops=dict(color='#E15759', linewidth=1.5),
                    whiskerprops=dict(color='#4E79A7'),
                    capprops=dict(color='#4E79A7'),
                    flierprops=dict(marker='o', markersize=3, alpha=0.4,
                                    markerfacecolor='#F28E2B'))

    ax.set_yticklabels(labels, fontsize=8)
    ax.set_xlabel('Window duration (seconds)', fontsize=11, fontweight='bold')
    ax.set_title(f'Duration Heterogeneity — Top {top_n} Recipes by Window Count',
                 fontsize=13, fontweight='bold')
    ax.grid(axis='x', alpha=0.2)

    # Reference lines
    ax.axvline(1, color='#E15759', linestyle=':', linewidth=1, alpha=0.5,
               label='1s (annotation artifact threshold)')
    ax.axvline(120, color='#E15759', linestyle='--', linewidth=1, alpha=0.5,
               label='120s (2-minute long window)')
    ax.legend(fontsize=8, loc='lower right')

    fig.tight_layout()
    return fig


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    # Resolve paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    recipes_path = os.path.join(script_dir, '..', 'high-level', 'complete_recipes.json')
    output_dir = os.path.join(script_dir, '..', 'outputs', 'figures')
    os.makedirs(output_dir, exist_ok=True)

    print('Loading complete_recipes.json ...')
    recipes = load_recipes(recipes_path)
    print(f'  {len(recipes)} recipe entries loaded.')

    print('Analyzing challenges across all captures ...')
    per_recipe, all_durations, all_window_counts = analyze_all(recipes)

    # Summary
    n_reorder = sum(1 for r in per_recipe if r['out_of_order'])
    n_overlap = sum(1 for r in per_recipe if r['overlap_pairs'] > 0)
    n_heavy_revisit = sum(1 for r in per_recipe if r['max_revisit'] >= 5)
    print(f'\n  Out-of-order recipes:      {n_reorder} / {len(per_recipe)}')
    print(f'  Deep revisitation (>=5):   {n_heavy_revisit} / {len(per_recipe)}')
    print(f'  Recipes with overlap:      {n_overlap} / {len(per_recipe)}')
    print(f'  Total step-time windows:   {len(all_durations)}')
    print(f'  Median window duration:    {np.median(all_durations):.1f}s')

    # ── Figure 1 ─────────────────────────────────────────────────────────
    print('\nGenerating Figure 1: Per-recipe challenge profile ...')
    fig1 = plot_overview(per_recipe)
    path1 = os.path.join(output_dir, 'dataset_challenge_overview.png')
    fig1.savefig(path1, dpi=200, bbox_inches='tight')
    plt.close(fig1)
    print(f'  Saved: {path1}')

    # ── Figure 2 ─────────────────────────────────────────────────────────
    print('Generating Figure 2: Challenge distributions ...')
    fig2 = plot_distributions(per_recipe, all_durations, all_window_counts)
    path2 = os.path.join(output_dir, 'dataset_challenge_distributions.png')
    fig2.savefig(path2, dpi=200, bbox_inches='tight')
    plt.close(fig2)
    print(f'  Saved: {path2}')

    # ── Figure 3 ─────────────────────────────────────────────────────────
    print('Generating Figure 3: Recipe recommendation scatter ...')
    fig3 = plot_recommendation(per_recipe)
    path3 = os.path.join(output_dir, 'dataset_recipe_recommendation.png')
    fig3.savefig(path3, dpi=200, bbox_inches='tight')
    plt.close(fig3)
    print(f'  Saved: {path3}')

    # ── Figure 4 ─────────────────────────────────────────────────────────
    print('Generating Figure 4: Duration boxplots ...')
    fig4 = plot_duration_boxplots(per_recipe)
    path4 = os.path.join(output_dir, 'dataset_challenge_durations.png')
    fig4.savefig(path4, dpi=200, bbox_inches='tight')
    plt.close(fig4)
    print(f'  Saved: {path4}')

    # ── Print top candidates ─────────────────────────────────────────────
    print('\n' + '=' * 70)
    print('TOP RECIPE CANDIDATES TO VISUALIZE NEXT')
    print('=' * 70)
    print(f'{"Rank":<5} {"ID":<12} {"Name":<22} {"Steps":<6} '
          f'{"Wins":<6} {"Reord":<6} {"MaxRev":<7} {"Overlap":<8}')
    print('-' * 70)

    already = {'P01_R01', 'P08_R01'}
    rank = 0
    for r in per_recipe:
        if r['id'] in already:
            continue
        rank += 1
        if rank > 15:
            break
        print(f'{rank:<5} {r["id"]:<12} {r["name"][:20]:<22} '
              f'{r["n_steps"]:<6} {r["total_windows"]:<6} '
              f'{"yes" if r["out_of_order"] else "no":<6} '
              f'{r["max_revisit"]:<7} {r["overlap_pairs"]:<8}')

    print('\nDone. All figures saved to:', output_dir)


if __name__ == '__main__':
    main()