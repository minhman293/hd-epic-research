#!/usr/bin/env python3
"""
check_interleaving_hypothesis.py

Tests whether task interleaving and fragmentation is the dominant pattern
across all HD-EPIC participants (P01 through P09), using per-participant
recipe_timestamps.csv files.

Hypothesis (from prior analysis of P01 only):
  H1. Most videos contain 2+ high-level activities (P01: 78%)
  H2. Most recipes are fragmented across multiple segments (P01: 8 of 9)
  H3. Non-recipe activity consumes >20% of bounded kitchen time (P01: ~32%)
  H4. A substantive fraction of videos contain 2+ distinct recipes
      occurring concurrently (P01 had R01 + orange-juice in same video)

This script measures each metric per participant, then aggregates across
the corpus. A "CONFIRMED" verdict means the mean across all participants
exceeds the threshold; that's a corpus-level claim that survives reviewer
scrutiny better than P01-only evidence.

USAGE
  python check_interleaving_hypothesis.py --data-dir /path/to/csv_files

OUTPUT
  - Console: per-participant table, aggregates, verdict on each sub-hypothesis
  - File:    interleaving_results.csv with full per-participant metrics

DATA ASSUMPTIONS
  - One file per participant, named PXX_recipe_timestamps.csv
  - Columns: video_id, recipe_id, high_level_activity_label, start_time, end_time
  - recipe_id is NaN for non-recipe activities (e.g., "Clean and clear")
  - end_time can be a number OR the literal string "end" (final segment of a video)

OPERATIONAL CHOICES (be transparent about these in the paper)
  - "Activity" = one row in the timestamps file. Granularity varies across
    participants because annotators differed; this script treats segments as
    given without normalization.
  - "Fragmented recipe" = a recipe_id that appears in 2+ rows. This includes
    cases where the same recipe was continued after a brief interruption AND
    cases where it spans multiple videos.
  - Bounded time = sum of (end - start) for rows where end is numeric. Rows
    with end="end" are excluded from the time budget (we don't know the
    video's true endpoint without the video file itself).
  - "Concurrent recipes in same video" = a video containing 2+ distinct
    non-null recipe_id values. This undercounts true concurrency because
    non-recipe activities (like drinking OJ) don't have recipe_ids.
"""

import argparse
from pathlib import Path
import sys
import pandas as pd
import numpy as np


# ---------------------------------------------------------------------------
# Data loading and cleaning
# ---------------------------------------------------------------------------

def parse_end_time(x):
    """end_time field can be a number or the literal string 'end'. Return float or NaN."""
    try:
        return float(x)
    except (ValueError, TypeError):
        return np.nan


def load_participant(csv_path):
    """Load one participant's recipe_timestamps.csv with defensive parsing."""
    df = pd.read_csv(csv_path)
    required = {'video_id', 'recipe_id', 'high_level_activity_label', 'start_time', 'end_time'}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"{csv_path}: missing columns {missing}")
    df['end_num'] = df['end_time'].apply(parse_end_time)
    df['duration'] = df['end_num'] - df['start_time']
    # Treat comma-separated recipe_ids (e.g., "R08, R07") as recipe activity
    # but split the count: we'll only use them for the boolean "is_recipe" check.
    df['is_recipe'] = df['recipe_id'].notna()
    return df


# ---------------------------------------------------------------------------
# Metric computation
# ---------------------------------------------------------------------------

def compute_metrics(df, participant):
    """Compute interleaving metrics for one participant. Returns a dict."""
    # H1: videos with multiple activities
    segs_per_video = df.groupby('video_id').size()
    n_videos = len(segs_per_video)
    pct_multi = 100.0 * (segs_per_video >= 2).sum() / n_videos if n_videos else 0
    pct_3plus = 100.0 * (segs_per_video >= 3).sum() / n_videos if n_videos else 0

    # H2: recipe fragmentation
    # Group by recipe_id (already unique within a participant). A recipe
    # appearing in 2+ rows is "fragmented" — either resumed after an
    # interruption or spread across multiple videos.
    recipe_rows = df[df['is_recipe'] & df['recipe_id'].notna()]
    # Drop comma-separated edge cases for the fragmentation count, since
    # they would inflate the segment count for an ambiguous recipe
    clean_recipe_rows = recipe_rows[~recipe_rows['recipe_id'].astype(str).str.contains(',')]
    segs_per_recipe = clean_recipe_rows.groupby('recipe_id').size()
    n_recipes = len(segs_per_recipe)
    pct_frag = 100.0 * (segs_per_recipe >= 2).sum() / n_recipes if n_recipes else 0
    mean_segs_per_recipe = segs_per_recipe.mean() if n_recipes else 0
    max_segs_per_recipe = int(segs_per_recipe.max()) if n_recipes else 0

    # H3: time budget
    bounded = df.dropna(subset=['duration'])
    recipe_time = bounded[bounded['is_recipe']]['duration'].sum()
    incidental_time = bounded[~bounded['is_recipe']]['duration'].sum()
    total_bounded = recipe_time + incidental_time
    pct_incidental = 100.0 * incidental_time / total_bounded if total_bounded else 0

    # H4: concurrent recipes in same video
    recipes_per_video = clean_recipe_rows.groupby('video_id')['recipe_id'].nunique()
    n_concurrent = int((recipes_per_video >= 2).sum())
    pct_concurrent = 100.0 * n_concurrent / n_videos if n_videos else 0

    # Interruption count: for each recipe-execution, how many non-recipe
    # activities are interposed between its first and last segment within
    # the same video? This is a stricter test of interleaving.
    interruption_count = 0
    for vid in df['video_id'].unique():
        vid_df = df[df['video_id'] == vid].sort_values('start_time')
        for rid in vid_df[vid_df['is_recipe']]['recipe_id'].dropna().unique():
            if ',' in str(rid):
                continue
            rid_rows = vid_df[vid_df['recipe_id'] == rid]
            if len(rid_rows) < 2:
                continue
            t_min = rid_rows['start_time'].min()
            t_max_end = rid_rows['end_num'].max()
            if pd.isna(t_max_end):
                t_max_end = rid_rows['start_time'].max() + 1
            between = vid_df[
                (vid_df['start_time'] >= t_min)
                & (vid_df['start_time'] < t_max_end)
                & (vid_df['recipe_id'] != rid)
            ]
            interruption_count += len(between)

    return {
        'participant': participant,
        'n_videos': n_videos,
        'n_segments': len(df),
        'n_recipes': n_recipes,
        'pct_videos_multi_activity': pct_multi,             # H1
        'pct_videos_3plus_activity': pct_3plus,             # H1 (strict)
        'mean_segments_per_video': segs_per_video.mean() if n_videos else 0,
        'max_segments_per_video': int(segs_per_video.max()) if n_videos else 0,
        'pct_recipes_fragmented': pct_frag,                 # H2
        'mean_segments_per_recipe': mean_segs_per_recipe,
        'max_segments_per_recipe': max_segs_per_recipe,
        'recipe_time_sec': recipe_time,                     # H3
        'incidental_time_sec': incidental_time,             # H3
        'pct_time_incidental': pct_incidental,              # H3
        'pct_videos_concurrent_recipes': pct_concurrent,    # H4
        'total_interruptions': interruption_count,
    }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def print_per_participant_table(results):
    print()
    print('=' * 90)
    print('PER-PARTICIPANT INTERLEAVING METRICS')
    print('=' * 90)
    display_cols = [
        'participant',
        'n_videos',
        'pct_videos_multi_activity',
        'pct_videos_3plus_activity',
        'pct_recipes_fragmented',
        'pct_time_incidental',
        'pct_videos_concurrent_recipes',
        'total_interruptions',
    ]
    print(results[display_cols].to_string(index=False, float_format='%.1f'))


def print_corpus_aggregates(results):
    print()
    print('=' * 90)
    print('CORPUS-WIDE AGGREGATES (mean across participants)')
    print('=' * 90)
    print(f'Participants analyzed: {len(results)}')
    print(f'Total videos:          {results["n_videos"].sum()}')
    print(f'Total segments:        {results["n_segments"].sum()}')
    print(f'Total recipes:         {results["n_recipes"].sum()}')
    print(f'Total interruptions:   {results["total_interruptions"].sum()}')

    metrics_to_summarize = [
        ('pct_videos_multi_activity', '% videos with 2+ activities (H1)'),
        ('pct_videos_3plus_activity', '% videos with 3+ activities (H1 strict)'),
        ('pct_recipes_fragmented', '% recipes that are fragmented (H2)'),
        ('pct_time_incidental', '% bounded time on non-recipe activity (H3)'),
        ('pct_videos_concurrent_recipes', '% videos with 2+ concurrent recipes (H4)'),
    ]
    print()
    for col, label in metrics_to_summarize:
        vals = results[col]
        print(f'  {label}')
        print(f'    mean={vals.mean():.1f}%  median={vals.median():.1f}%  '
              f'min={vals.min():.1f}%  max={vals.max():.1f}%')


def print_verdict(results):
    print()
    print('=' * 90)
    print('VERDICT (corpus-level claim survives if mean >= threshold AND min isn\'t 0)')
    print('=' * 90)
    checks = [
        ('pct_videos_multi_activity', 50,
         'H1: Most videos contain 2+ activities'),
        ('pct_recipes_fragmented', 50,
         'H2: Most recipes are fragmented'),
        ('pct_time_incidental', 20,
         'H3: Substantial non-recipe time (>20%)'),
        ('pct_videos_concurrent_recipes', 20,
         'H4: Frequent cross-recipe interleaving (>20% of videos)'),
    ]
    for col, threshold, label in checks:
        mean = results[col].mean()
        min_val = results[col].min()
        status = 'CONFIRMED    ' if mean >= threshold and min_val > 0 else 'NOT CONFIRMED'
        print(f'  [{status}]  {label}')
        print(f'                  mean={mean:.1f}%  min={min_val:.1f}%  threshold={threshold}%')


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Test whether task interleaving generalizes beyond P01.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument('--data-dir', type=Path, required=True,
                        help='Directory containing PXX_recipe_timestamps.csv files')
    parser.add_argument('--out', type=Path, default=Path('interleaving_results.csv'),
                        help='Output CSV path (default: interleaving_results.csv)')
    parser.add_argument('--participants', type=str,
                        default='P01,P02,P03,P04,P05,P06,P07,P08,P09',
                        help='Comma-separated participant IDs (default: P01-P09)')
    args = parser.parse_args()

    if not args.data_dir.exists():
        print(f'ERROR: data directory {args.data_dir} does not exist', file=sys.stderr)
        sys.exit(1)

    participants = args.participants.split(',')
    rows = []
    for pid in participants:
        csv_path = args.data_dir / f'{pid}_recipe_timestamps.csv'
        if not csv_path.exists():
            print(f'[skip] {csv_path} not found')
            continue
        try:
            df = load_participant(csv_path)
        except Exception as exc:
            print(f'[error] {csv_path}: {exc}', file=sys.stderr)
            continue
        metrics = compute_metrics(df, pid)
        rows.append(metrics)
        print(f'[done] {pid}: {metrics["n_videos"]} videos, '
              f'{metrics["n_segments"]} segments, '
              f'{metrics["n_recipes"]} recipes')

    if not rows:
        print('ERROR: no participants loaded successfully', file=sys.stderr)
        sys.exit(1)

    results = pd.DataFrame(rows)
    print_per_participant_table(results)
    print_corpus_aggregates(results)
    print_verdict(results)

    results.to_csv(args.out, index=False)
    print(f'\nFull results saved to {args.out}')


if __name__ == '__main__':
    main()