# Motion-Graph Dashboard for Meal-Prep Robotics — Project Summary

A research project exploring how to visualize and analyze human cooking action sequences from egocentric kitchen video, with the long-term goal of informing meal-preparation robotics for elderly users.

This document covers three things:
1. **The dataset** (HD-EPIC) — its structure and the challenges it poses for visualization
2. **The research insights** we want to surface, mapped to professor-driven research directions
3. **The current dashboard** — every component, its tech stack, and what it does

---

## Part 1 — The Dataset

### 1.1 What HD-EPIC is

HD-EPIC (Perrett et al., CVPR 2025) is a high-definition egocentric kitchen video dataset. Participants wore a head-mounted camera in their own kitchen and followed a recipe. Every video is first-person. The dataset provides raw video, time-stamped action narrations, action-class labels, recipe-step annotations, and ingredient timestamps. The design intent is to capture naturalistic cooking in real home kitchens, not lab settings.

The project's working data file is `complete_recipes.json`, the structured recipe metadata layer (recipes, steps, capture sessions, time windows, ingredients).

### 1.2 Structural hierarchy

Three levels of structure, often confused:

- **Recipe** — a labeled task (e.g., "Nespresso", "Coffee", "Sfesiha")
- **Capture** — one execution of the recipe by a participant. Sometimes called a "session" in the dashboard UI.
- **Video** — one continuous recording file. A capture can span multiple videos if the recording was paused.

So: a recipe can have multiple captures; a capture can span multiple videos.

### 1.3 Headline numbers

| Property | Value |
|---|---|
| Recipe entries (recipe × participant) | 69 |
| Unique participants | 9 (P01–P09) |
| Total captures | 80 |
| Recipes with 1 capture | 64 |
| Recipes with 2+ captures | 5 |
| Multi-video captures | 34 of 80 |
| Single-video captures | 46 of 80 |
| Steps per recipe | 2–18 (median 6) |
| Session duration | 25s to 74 min |
| Verb classes | 106 (across 13 categories) |
| Noun classes | 303 (across 21 categories) |

### 1.4 Recipe-level fields

Each entry in `complete_recipes.json` is keyed `{participantID}_{recipeID}` (e.g., `P01_R01`). Fields:

| Field | Meaning |
|---|---|
| `participant` | P01–P09 |
| `name` | Recipe name |
| `type` | `adapted` / `modified` / `online` / `own` |
| `source` | URL if from the web |
| `steps` | Ordered dict: step ID → step text |
| `captures` | List of capture sessions |

### 1.5 Capture-level fields

Each capture has:

| Field | Meaning |
|---|---|
| `videos` | Video file IDs in this capture |
| `step_times` | Per-step list of `{video, start, end}` windows — when the step was being **executed** |
| `prep_times` | Per-step list of `{video, start, end}` windows — when the participant was **preparing** for the step |
| `ingredients` | Per-ingredient dict with name, amount, calorie data, weighing timestamps, add-to-dish timestamps |

### 1.6 Verb classes — 13 categories

The verb taxonomy from `HD_EPIC_verb_classes.csv`. Each verb belongs to one category. Categories are universal across all 69 recipes, which makes them the most defensible basis for color encoding.

| Category | Verb count | Example verbs |
|---|---|---|
| manipulate | 32 | shake, squeeze, press, flip, turn, pull, hold, cook |
| monitor | 11 | adjust, check, look, search, measure, wait, scan |
| split | 10 | cut, peel, break, crush, divide, grate |
| access | 8 | open, turn-on, unscrew, uncover, unwrap, switch |
| leave | 7 | put, insert, throw, hang, drop, let-go, serve |
| clean | 7 | wash, dry, scrape, scrub, rub, soak, brush |
| retrieve | 6 | take, remove, scoop, lift, gather, choose |
| merge | 6 | pour, mix, fill, add, attach, coat |
| block | 5 | close, turn-off, wrap, roll, lock |
| sense | 5 | pat, eat, feel, drink, smell |
| distribute | 4 | apply, sprinkle, spray, season |
| transition | 3 | move, transition, carry |
| order | 2 | fold, sort |

### 1.7 Multi-capture recipes (for comparison)

Only 5 recipes have multiple captures. Of those, only one (P01_R01) has all single-video captures, which is the only "clean" case for the dashboard's comparison view.

| Recipe | Name | Captures | Notes |
|---|---|---|---|
| P01_R01 | Nespresso | 3 | All single-video — clean case |
| P02_R03 | Squash | 4 | All single-video, highly variable (25s–916s) |
| P03_R03 | Drip Coffee | 4 | All single-video, all ~12–14 min |
| P05_R02 | Porridge | 3 | Every capture spans multiple videos |
| P09_R03 | Hibiscus Drink | 2 | Second capture spans 2 videos |

### 1.8 The four challenges that constrain visualization

These are the dataset's defining difficulties. The current motion graph design predates this analysis and does not handle them well.

#### Challenge 1 — Step order is not followed linearly

**63% of captures (50 of 80)** have at least one step whose first occurrence precedes the previous nominal step.

Example: In all three Nespresso captures, P01 presses the coffee button (S02) before fully inserting the capsule (S01). In Sfesiha (P01_R04), S07 fires at 16s while S01 fires at 25s — a later step begins before the first.

**Implication:** Step number (S01, S02, ...) is not a reliable proxy for time. Any visualization that places steps left-to-right by step number will contradict the video evidence.

#### Challenge 2 — Step revisitation

**341 of 504 annotated step instances have more than one time window.** Steps are not atomic — people return to the same activity repeatedly.

Extreme cases: Cacio e Pepe (P01_R03) S03 has 20 separate time windows. Sfesiha S01 has 13 windows scattered across the session.

**Implication:** An action represented as a single node in a graph hides this temporal distribution. A "stir" node with 20 occurrences across the session looks the same as one with all 20 occurrences clustered consecutively.

#### Challenge 3 — Temporal overlap between steps

**25 overlapping pairs across 12 of 80 captures** are flagged by the detector (`5_dataset_challenges.py`). The detection is restricted to same-video pairs: if two step windows overlap across a pause/resume boundary, they are not currently flagged. The 25 figure is therefore a lower bound on intra-capture overlap; cross-video overlap is not detected.

**Verification (June 2026).** Of the 12 candidate captures, 11 were verified manually by watching the videos at the overlap timestamps. Results:

- **9 confirmed annotation errors** — typically off-by-a-few-frames at action transitions, where the end of one annotation extends slightly past the start of the next. Spread across multiple participants (P09_R05, P05_R01, P09_R02, P01_R07, P02_R02, P05_R03, P08_R03, P08_R09, P08_R02).
- **2 confirmed real overlaps** — genuine simultaneous activity:
  - P09_R04 (Mangsho Bhuna): stirring food in the pan while closing a box.
  - P06_R03 (Kadhai Paneer): holding a bowl while stirring onions in the pan.
- **1 ambiguous** (P06_R01): pouring powder from a bowl into the pan — could be one action or two depending on annotation granularity.

The two confirmed real overlaps are the analytically interesting cases — exactly the simultaneous-action data that supports the parallel-collaboration insight. They are kept in the data; the 9 errors are not currently corrected but their prevalence is small enough to not distort downstream analysis.

To support verification, the detector now writes `overlap_pairs.csv` (one row per pair: recipe, capture, video, step_a, step_b, timestamps, overlap duration, blank `verdict` column for manual labeling).

**Implication:** A directed sequence graph structurally assumes one action follows another. It cannot represent two steps active in the same time span. For simple recipes (Nespresso) this is moot. For the few real-overlap cases it underrepresents the structure; analysis of those moments is deferred to a future view.

#### Challenge 4 — Step window duration heterogeneity

- 4.7% of windows are under 1s (likely annotation artifacts)
- 1.5% are over 2 minutes
- Median: 9.8s, mean: 18.5s

**Implication:** Step windows cannot be treated as uniform-duration slots. A temporal barcode colored by step has some steps as slivers, others as wide blocks. 41 step+capture combinations have zero time windows (missing annotation).

### 1.9 What the dataset can and cannot support

**Can:**
- Within-person analysis (one person making one recipe in detail)
- Within-person consistency (same person, repeated attempts) — limited to 5 recipes, clean for 1
- Measure the gap between idealized recipe and actual execution
- Identify candidate intervention points from that gap

**Cannot:**
- Cross-person generalization (63 of 69 recipes are single-participant)
- Anything elderly-specific (no elderly participants)
- Anything robot-related (human-only data; needs WoZ study or new collection)
- Statistical significance claims (sample sizes too small)

---

## Part 2 — Research Insights We Want to Visualize

### 2.1 Research goal and constraints

**Long-term goal:** support meal-preparation robotics for elderly users.

**Immediate scope:** establish a method for analyzing the structure of human cooking actions in a way that supports comparison, deviation detection, and eventual human-robot task allocation.

The project sits between two advisor interests:

- **Prof. Lin:** transition-probability modeling; deviation detection; LLM-based extraction of structural rules; concern that the visualization must not falsely encode time or importance.
- **Prof. Yen:** multi-session comparison; treating secondary (non-recipe) actions as a separate category; eventual Wizard-of-Oz study for robot anticipation; parallel views with color barcodes; identifying collaboration moments where a robot could share or take over work; parallel vs sequential collaboration modes; intervention-point framing.

### 2.2 The shared interest

Across all: **identify, from real human cooking video, where and how a robot could take over or share work, and represent human and (eventually) robot activity together.** Two collaboration modes have been named:

- **Parallel collaboration:** human and robot act simultaneously, possibly on different sub-tasks
- **Sequential / predictive collaboration:** robot anticipates the next human action

### 2.3 Insights already revealed by the dashboard

Honest accounting of what the dashboard surfaces today:

| Insight | Status | How it's revealed |
|---|---|---|
| Action frequency | Full | Node size in graph; segment density in barcode |
| Action category | Full | 13-color encoding consistent across views; combined with HRC-role |
| Action duration | Full | Barcode stack |
| Within-person consistency | Full | Merged graph view + Min support |
| Transition structure | Partial | Graph edges; time-axis encoding is misleading (columns issue) |
| Self-loops (consecutive repetition) | Partial | ⟳ glyph — captures only consecutive repeats, not full revisitation |

### 2.4 The intervention-point insights — not yet revealed

The four insights that map to the collaboration research goal and that the dataset directly supports. None are currently revealed.

#### Insight A — Deviations from recipe order

The gap between the recipe's nominal step order and the order steps actually fired. Reveals where the person diverges from the recipe — the moments a robot following the recipe rigidly would desync with the human.

**Data source:** compare `step_times[step_id][0].start` across step IDs to nominal step order.
**Dataset prevalence:** 63% of captures (50 of 80).

#### Insight B — Revisitation hotspots

Which steps the person returns to repeatedly across the session — attention-heavy mechanical sub-tasks that are strong robot-delegation candidates.

**Data source:** count `len(step_times[step_id])` per step.
**Dataset prevalence:** 341 of 504 annotated step instances have >1 window.

#### Insight C — Parallel overlaps

Where two steps run simultaneously in the same capture — the natural parallelization points where a robot taking one track wouldn't disrupt the human's flow. Maps directly to Prof. Yen's parallel collaboration mode.

**Data source:** find pairs of `step_times` windows from different steps that overlap.
**Dataset prevalence:** 25 overlapping pairs across 12 of 80 captures.
**Verification status:** Of the 12 captures the detector flags, manual review found 2 genuine overlaps and 9 annotation errors (see Section 1.8 Challenge 3). The 2 real cases are kept in the data; the detector remains the entry point for surfacing this signal, but downstream views should be cautious about treating raw overlap counts as evidence of multitasking without verification.

#### Insight D — Prep-vs-execution gaps

The time gap between when the participant prepared for a step (`prep_times`) and when they actually executed it (`step_times`). Long gaps are candidate windows where a robot could bridge — pre-position a tool during prep, then the human executes when ready.

**Data source:** `prep_times[step_id][0].start` vs `step_times[step_id][0].start`.
**Dataset prevalence:** present in most captures; `prep_times` is currently unused in the dashboard.

### 2.5 Honest scope statement

The dashboard's current value is not its findings — it's the demonstration that the method *can* surface patterns that would be invisible in raw video. For the elderly-care research goal, the immediate next step is identifying or collecting a dataset that includes older adults. The current work establishes the analytical pipeline.

---

## Part 3 — Current Dashboard

### 3.1 Tech stack

| Layer | Technology |
|---|---|
| Visualization rendering | D3.js v7 |
| Frontend logic | Vanilla JavaScript (ES modules) |
| Markup / styling | HTML, CSS |
| Build process | None — direct ES module loading |
| Hosting | GitHub Pages |
| Video hosting | Dropbox (currently — load slow; alternatives under evaluation) |
| Data preparation | Python (4 scripts) |
| Data interchange | JSON |

No frameworks (React/Vue/etc), no build step (webpack/vite/etc), no backend at runtime.

### 3.2 File structure

```
scripts/
  2_recipe_selector.py              Cache recipe data for a chosen recipe
  5_dataset_challenges.py           Per-recipe challenge analysis + overlap CSV export
  6_prepare_dashboard_data.py       Generate per-session graph JSONs (3 detail modes)
  7_build_manifest.py               Scan outputs, build the dashboard's index
  8_aggregate_sessions.py           Aggregate multi-session into merged JSONs

outputs/
  graphs/
    manifest.json                   Frontend reads this first
    {recipe_id}/
      session_{N}_full.json         Per-session detailed graph
      session_{N}_smart.json        Per-session smart-merged graph
      session_{N}_abstracted.json   Per-session task-phase graph
      merged_{mode}.json            Cross-session aggregated graph (3 files)
  figures/
    overlap_pairs.csv               One row per detected overlap, for verification
  raw-video/
    {video_id}.mp4

index.html
assets/nespresso-dashboard/
  css/
    dashboard.css                   
  js/
    app.js                          Main controller, routes between views
    config.js                       Constants, URL builders, color palette
    graph.js                        Main motion graph renderer
    thumbnailGraph.js               Simplified renderer for small multiples
    barcodeStack.js                 Stacked color barcodes
    videoQueue.js                   Thumbnail queue (no longer owns main video)
    captureController.js            Multi-video capture timeline controller
    legend.js                       Legend rendering
    annotationTimeline.js           Single-session annotation strip
    timeline.js                     Bottom-of-page action table
    swimlane.js                     Step-by-step swimlane view
    utils.js                        Shared helpers
```

### 3.3 Pipeline

```
HD-EPIC raw data
    ↓ (script 2: recipe selection)
selected_recipe_{recipe_id}.json + recipe_narrations.pkl
    ↓ (script 6: per-session preparation)
session_{N}_{mode}.json (3 files per session)
    ↓ (script 8: aggregation if multi-session)
merged_{mode}.json (3 merged files)
    ↓ (script 7: manifest build)
manifest.json
```

### 3.3.1 Multi-video capture stitching

A capture in HD-EPIC may span multiple video files when the participant paused recording mid-cook. Each video starts its own timestamps at t=0, so the raw annotations live on per-video timelines, not on a unified "capture time" axis. The original pipeline used only the first video of every multi-video capture and silently dropped the rest — a limitation found to drop **589 of 1937 step-windows across the dataset (30.4%)**, affecting **31 of 80 captures**. For P05_R01 (one capture, four videos) this meant steps S06 through S12 vanished from the dashboard entirely.

**Fix (June 2026).** The pipeline now stitches all videos of a capture onto a unified timeline.

- A new input file `HD_EPIC_YouTube_URLs.csv` (columns: `video_id`, `youtube_url`, `duration`) provides exact per-video durations from the HD-EPIC YouTube metadata. The loader (`load_video_durations` in `utils.py`) returns `{video_id: duration_seconds}`.
- `compute_video_layout` walks the capture's videos in order, assigning each one a cumulative `offset_s` on the unified timeline. If a video is missing from the CSV, the pipeline falls back to "max narration end timestamp" with a warning.
- `collect_step_windows_stitched` re-stamps every `step_times` entry onto the unified timeline by adding its video's offset.
- The build step iterates over every video in the capture, not just the first.

**New JSON schema.** Each session JSON gains a top-level `videos` array and per-action provenance fields. Aggregates in the `recipe` block also gain `n_videos` and `total_capture_duration_s`. The legacy `recipe.video_id` and `recipe.video_path` are retained but now point to the first video only — they're for back-compat with anything that hasn't been updated; new code reads `data.videos` instead.

```json
{
  "recipe": { "id": "P05_R01", "n_videos": 4, "total_capture_duration_s": 2788.97, ... },
  "videos": [
    { "video_id": "P05-20240423-170021", "offset_s": 0.0,    "duration_s": 1169.77, "video_path": "..." },
    { "video_id": "P05-20240423-172243", "offset_s": 1169.77, "duration_s": 345.80, "video_path": "..." }
  ],
  "sequence": [
    { "index": 250, "action": "...", "start": 1200.50, "end": 1202.00,
      "video_id": "P05-20240423-172243", "video_start": 30.73, "video_end": 32.23,
      "step_id": "P05_R01_S06", "is_primary": true }
  ]
}
```

For single-video captures, the schema degrades cleanly: `videos` has one entry with `offset_s=0`, and every sequence item's `start`/`end` equals its `video_start`/`video_end`.

**Frontend.** A new module `captureController.js` wraps the `<video>` element. It accepts the `videos` array, watches the timeline cursor, and swaps the `<video>` element's `src` when the cursor crosses a video boundary. Auto-advances when one video ends. All seek operations in the dashboard now route through `captureCtrl.seekUnified(unifiedTime)` instead of writing `video.currentTime` directly. `videoQueue.js` no longer manages the main video element; it just renders thumbnails and delegates session switching back to `app.js` via the `onActiveChange` callback.

**Result for P05_R01.** Narrations per session went from 415 (just video 1) to 963 (all 4 videos). Steps S06 through S12 are now visible in the swimlane with actions tagged correctly.

**Remaining issues** (separate from the multi-video fix, not yet addressed):
- **S03 nested-window problem in P05_R01.** S03 has a window inside the first video (1077.93–1080.23s), but that window is fully nested inside an S02 window (1077.82–1081.96s). The current step-tagging rule picks the step with maximum overlap, so S02 always wins for actions in the nested region and S03 receives no actions. This is a tagging-logic issue, not a stitching issue.
- **Annotation-layer gap.** Across the dataset, 18 of 1937 step-windows (0.9%) are annotated as "doing this step" but have zero atomic-action narrations underneath them. The step-time annotations and the verb-noun narrations were created independently with different granularities; they don't always agree on what counts as activity. P08_R03 is an outlier with 5 of 22 step-windows empty (23%). These are kept in the data; the dashboard may render them as visible-but-empty step windows.

### 3.4 Detail-level modes

Each per-session JSON exists in three modes representing different abstraction levels:

- **Full Raw** (`*_full.json`) — every action with its full verb-noun label (`take(cup)`, `pour(milk)`). Most nodes, finest detail.
- **Smart-Merged** (`*_smart.json`) — actions grouped by verb. `take(cup)` and `take(spoon)` become one `take` node with object info in a side map.
- **Task Phases** (`*_abstracted.json`) — nodes are recipe steps. Each action is assigned to the step whose time window contains it.

#### Step labels

Each step node carries a short **diagnostic label** (e.g., "insert capsule", "froth milk", "stir cappuccino") in addition to its raw step ID (`S01`). The labels are generated offline by an LLM-assisted pipeline (`9_generate_step_labels.py`) and hand-reviewed for recipe-recognizability: reading a recipe's labels in order should make the dish identifiable without watching the video. 

Labels live in `outputs/step_labels.json` keyed by full step ID (`P01_R01_S01`), and ride the pipeline into each payload's `steps[].label` and onto abstracted nodes' `step_label`. The frontend (`config.js`'s `resolveStepLabel`) falls back gracefully to the raw step ID if a label is missing, so the view never breaks. Labels are generated once and committed — no LLM call at render time, which keeps the dashboard deterministic for demos.

### 3.5 Primary vs Secondary action lanes

A key design decision based on `step_times` coverage:

- An action is **primary** if its time range overlaps any step's time window
- An action is **secondary** if it does not (phone-checking, cleanup between steps, etc.)

Primary actions sit in a top "Recipe actions" lane in the motion graph; secondary actions sit in a bottom "Secondary actions" lane with a visual gap. This implements Prof. Yen's request to keep secondary actions visible but distinct.

### 3.6 Per-component description

#### `index.html` — entry point

Hosts: header, recipe dropdown, session-picker tab row, shared encoding-controls row (Detail Level / Color encodes / Node size / Layout), and two view containers (single-session view and comparison view) that toggle based on the current mode.

#### `app.js` — main controller

Responsibilities:
- Load manifest at startup
- Populate recipe dropdown and session-picker tabs
- Route between single-session view and comparison view
- Fetch session and merged JSONs on selection
- Wire all UI controls to data refetch and rerender
- Manage two graph controllers (one for single-session graph, one for merged graph)
- Maintain comparison view state (active session, sub-mode, barcode/queue API instances)
- Build a step-label lookup per loaded payload (via `buildStepLabelLookup`) and pass it to legend rendering so the phase legend shows readable labels rather than raw step IDs

#### `config.js` — constants and color system

Exports:
- URL builders for manifest, per-session JSONs, and merged JSONs
- `CATEGORY_COLORS` — 13 verb-category colors (HD-EPIC canonical, set in Delivery 6)
- `VERB_TO_CATEGORY` — full map of all 106 verbs to their canonical category
- `getVerbColor()`, `getVerbCategory()` — helpers
- `STEP_PHASE_PALETTE`, `getStepPhaseColor()` — colors for the Task Phases mode
- `SESSION_PALETTE` — distinct hues per session index
- `buildStepLabelLookup()`, `resolveStepLabel()` — step-label resolution from the offline-generated `step_labels.json`, with graceful fallback to raw step IDs when a label is missing
- `getLegendItems()` — legend descriptor that adapts to current encoding settings, including the step-label lookup so the phase legend reads "insert capsule" instead of "S01" and shows exactly the step count for the active recipe (no phantom S06 on a 5-step recipe)

#### `graph.js` — main motion graph renderer

The largest single file. Handles:
- Single-session graphs (in the single view)
- Merged motion graph (in comparison view's "Merged graph" sub-mode)
- Three layout modes: temporal (by mean onset, with primary/secondary lanes), category (by verb-category cluster), HRI (by inferred robot/collab/human role)
- Node encoding: size by frequency / duration / support; color by category / phase / duration
- Edge encoding: width and opacity by count (single-session) or support (merged)
- Self-loop indicators (⟳ glyph)
- Back-edge count badges (top-left)
- Hover tooltips with action stats, including the step's readable label when available
- Click-to-seek and click-to-cycle-occurrences
- Drag to reposition; pan and zoom
- Auto-zoom to active node during video playback
- START / END synthetic nodes for single-session
- Support filter for merged graph

**Node text in Task Phases mode** comes from `node.step_label || node.id` — the LLM-assisted diagnostic label if present, falling back to the raw step ID. This is what makes the Task Phases view recognizable as a recipe rather than a generic numbered sequence.

**HRI-role percentages** in the HRI-category layout are computed from the *duration budget* of the sequence (summed seconds per role), not the node count. This makes the percentages invariant across detail levels (Full Raw / Smart-Merged / Task Phases all show the same numbers, because the underlying sequence of action-time is the same). Percentages are rounded by largest-remainder so they always sum to exactly 100.

#### `thumbnailGraph.js` — small multiples renderer

A separate, simpler renderer used in comparison view's "Small multiples" sub-mode. Static (no drag, no auto-zoom). Uses CSS class `.thumb-node` so it doesn't collide with the main graph. Each instance has unique SVG marker IDs to prevent arrow conflicts when three thumbnails render side by side.

#### `barcodeStack.js` — stacked color barcodes

Renders one horizontal color strip per session. Each strip uses normalized time [0,1] so sessions of different durations align. Colors come from the active "Color encodes" setting (category / phase / duration). Active session's strip has a thicker blue border. A playhead (vertical line) moves with video playback. Clicking a segment seeks; clicking a segment from a non-active session switches the main video first.

#### `captureController.js` — multi-video capture playback driver

Wraps a single `<video>` element to play back a multi-video capture as one continuous timeline. Constructed with the session JSON's `videos` array and exposes:
- `seekUnified(unifiedTime)` — picks the right underlying video, swaps `src` if needed, seeks within it.
- `getUnifiedTime()` — returns the current playback position on the unified capture timeline.
- `load(newVideos)` — rebinds the controller to a different capture's video layout (used when comparison mode switches active session).
- `destroy()` — detaches event listeners and releases the video source.

For single-video captures the controller is effectively a pass-through (no source switching, `getUnifiedTime()` returns `videoEl.currentTime`). For multi-video captures it auto-advances on the `ended` event so playback continues seamlessly across pause/resume boundaries.

A single controller instance per `<video>` element. The dashboard creates two: `captureCtrl` for the single-session player, `cmpCaptureCtrl` for the comparison-mode player.

#### `videoQueue.js` — thumbnail queue (revised)

Renders N-1 thumbnail tiles for the inactive captures in comparison mode. Clicking a thumbnail fires `onActiveChange(sessionIndex)` and `app.js` responds by calling `cmpCaptureCtrl.load(newSession.videos)`. The queue no longer touches the main `<video>` element directly — that responsibility moved to `captureController.js`. Thumbnail src uses the first video of each capture's `videos` array.

#### `legend.js` — legend rendering

Builds a two-column legend strip from a descriptor returned by `getLegendItems()`. The phase-color legend uses `resolveStepLabel()` so each swatch is labeled with the readable step label ("insert capsule") and the legend lists exactly the steps present in the active recipe — derived from the loaded payload's steps, not a hardcoded range.

#### `annotationTimeline.js` — single-session annotation strip

A thin horizontal strip below the single-session video. Shows every action as a colored segment with a playhead. Clicking a segment seeks the video. Independent from the barcode stack which is used in comparison view.

#### `timeline.js` — bottom action table

A simple table at the bottom of the single-session view. One row per action: index, action name, step ID, start time, end time, duration. The currently active row is highlighted as the video plays.

#### `utils.js` — shared helpers

`nodeColor()` (delegates to `getVerbColor()` from config), `currentSequenceItem()` (find which sequence item contains the current time), `formatSeconds()` (display formatting), `renderDataError()` (error UI).

#### `9_generate_step_labels.py` — offline step labeling

Standalone script that produces `outputs/step_labels.json`. Reads each recipe's step text from `complete_recipes.json`, sends it to an LLM (Gemini Flash-Lite via REST, with `.env`-based key loading) under a prompt that asks for a 1–3 word diagnostic label, and writes the result. Includes a heuristic fallback for dry-runs and tolerant UTF-8 / cp1252 reading so curly apostrophes in step text don't break the loader. Labels are hand-reviewed and a final pass ensures each recipe's set reads as the dish ("load coffee capsule → brew espresso → froth milk → pour foam in coffee → stir cappuccino"). 

### 3.7 Views

#### Single-session view (default)

Two-column layout:
- Left: motion graph with encoding controls above it, Min. Transition Count slider, the graph itself with zoom buttons, then the legend
- Right: video player, annotation timeline strip, recipe metadata panel
- Bottom: action timeline table

#### Comparison view (P01_R01 only — accessed via the "Merged" session tab)

Two-column layout:
- Left: motion graph area with a sub-mode toggle ("Merged graph" vs "Small multiples"), support filter slider, then the graph or three stacked thumbnails, then the legend
- Right: main video, thumbnail queue of inactive sessions, three stacked barcodes, comparison metadata panel

### 3.8 Controls

**Shared across both views (in the encoding-controls row):**
- Recipe dropdown
- Session picker (tab buttons: "Session 1", "Session 2", "Session 3", "Merged")
- Detail Level dropdown (Smart-Merged / Full Raw / Task Phases)
- Color encodes dropdown (Action category / Task phase / Mean duration)
  - The "Action category" option is automatically disabled when Detail Level is Task Phases, since step labels aren't verbs
- Node size dropdown (Frequency / Duration)
- Layout dropdown (Temporal / Category groups) — hidden in comparison view since the merged graph is always temporal

**Single-session only:**
- Min. Transition Count slider — filter out low-count edges

**Comparison only:**
- Sub-mode toggle: Merged graph / Small multiples
- Min. support slider — hide nodes appearing in fewer than N sessions (Merged graph sub-mode only)

### 3.9 Interactions

- **Click a node in motion graph** → seek video to that action's start; repeated clicks cycle through the action's occurrences
- **Click a barcode segment** → seek video; if it's from a non-active session, switch the main video first
- **Click a thumbnail in the video queue** → swap into main video slot
- **Drag a node** → reposition (single-session); reset button restores layout
- **Scroll on graph** → zoom; drag empty space → pan
- **Hover a node** → tooltip with count, support, duration stats, object map
- **Hover an edge** → tooltip with transition count and source/target

### 3.10 Known limitations

- **Time-axis honesty problem.** The temporal layout buckets nodes into ~90px columns based on mean onset across occurrences. This creates a misleading visual where nodes in the same column appear to happen at the same time when they don't. For actions that recur, the mean is a fabricated timestamp.
- **Step-tagging picks one step per action even when step windows are nested.** When an action overlaps two step windows (e.g., S03 nested inside S02 in P05_R01), the rule picks the step with maximum overlap. The narrower step receives no actions. This is a design choice — one step per action keeps the swimlane unambiguous — but it can hide annotated step boundaries in a few specific captures.
- **Annotation-layer gap.** Step-time annotations and atomic-action narrations were created independently and don't always agree on what counts as activity. About 0.9% of step-windows across the dataset have zero underlying narrations; P08_R03 has 23% (5 of 22). The dashboard renders these as visible-but-empty step windows.
- **Cross-video overlap not detected.** The overlap detector (P3) only flags pairs within the same video file. If two step windows span a pause/resume boundary, they are not flagged. Adding cross-video overlap detection would require offset-aware time math; deferred.
- **Cross-person comparison structurally impossible** with available data (63 of 69 recipes are single-participant).
- **Zero of four intervention insights are surfaced.** The dashboard reveals frequency, transition structure, and consistency well. It does not reveal deviations from recipe order, revisitation hotspots, parallel overlaps, or prep-vs-execution gaps — which are the four insights that map to the collaboration research goal.

---

## Part 4 — Document Status

**Coverage of the project:**
- Dataset structure and challenges: complete
- Research insights and direction: complete as of current understanding
- Current dashboard components and tech: complete
- Multi-video capture stitching architecture and the new JSON schema: complete

**Not covered here:**
- Detailed development history (delivery-by-delivery patch log)
- Code-level API documentation
- The proposed timeline/intervention view designs (covered separately)

**Verification recommended before sharing externally:**
- Exact numbers from `complete_recipes.json` analysis (verified against actual JSON during this work)
- The "5 multi-capture recipes" list (verified)
- The "63% of captures have out-of-order execution" number (verified)
- The "25 same-video overlap pairs in 12 of 80 captures" number (verified)
- The "30.4% of step-windows" multi-video data-loss figure and the per-recipe distribution (verified)
- The "9 errors, 2 real, 1 ambiguous" overlap verification breakdown (manual verification)

---

## Part 5 — Proposed Designs for the Missing Intervention Insights

The four insights in Section 2.4 (deviations from order, revisitation hotspots, parallel overlaps, prep-vs-execution gaps) are not currently revealed by the dashboard. This section sketches an interactive view for each. The principle throughout: each design is not one fixed chart but an explorable view with controls that let users filter, sort, drill in, and switch encodings.

### 5.1 Design 1 — Deviations from recipe order

**Research question:** Where does the participant diverge from the recipe's nominal step order, and why?

**View structure:** Two parallel horizontal rows per capture.
- **Top row** — the recipe's nominal order. Steps S01, S02, S03, … evenly spaced left to right. This is the "ideal."
- **Bottom row** — the actual first-occurrence order along real time. Each step placed at its first time-window start.
- **Connecting lines** between the same step in both rows. When two lines cross, that's a deviation. The crossing is the visual signal.

A per-capture **disorder score** (count of crossings) lets users rank multiple captures by how non-linear they were.

**Interactive controls:**
- Toggle the bottom-row x-axis between **real time** and **rank order** — rank removes duration distortion; time shows how far apart the deviations are in seconds
- Toggle **"first occurrence only"** vs **"all occurrences"** — a step with 20 windows shows 20 ticks on the bottom row instead of one
- Click any crossing line → seek video to that moment so users can see *why* the person went out of order
- Sort multiple captures by disorder score to find the most non-linear ones

**Data source:** for each step ID, `min(w.start for w in step_times[step_id])`.

**Dataset prevalence:** 63% of captures (50 of 80) have at least one out-of-order step.

**What users discover:** which steps get reordered, how consistently the same person does it across sessions, and by watching the video at crossings, why.

### 5.2 Design 2 — Revisitation hotspots

**Research question:** Which steps does the participant return to repeatedly across the session? Which are one-and-done?

**View structure:** One horizontal strip per step.
- Each strip spans the full session timeline (real time or normalized)
- Each time window for that step is drawn as a **vertical tick** at its true position
- A step done once = one tick. A step revisited 20 times = 20 ticks scattered across the strip.

The eye immediately sees which steps are "busy" (dense ticks) versus "one-and-done" (single tick). Each strip is labeled with its revisitation count, color-coded (red for high, yellow for medium, green for low).

**Interactive controls:**
- Sort steps **by revisitation count** (hotspots float to top) or **by recipe order** (preserve structural reading)
- **Density heat-bar view** as an alternative — instead of discrete ticks, a continuous bar darkened where the step recurs most densely
- **Brush a time region** → reverse lookup: which steps were active in that window
- **Filter slider:** "show only steps revisited more than N times" — isolates the hotspots
- Click any tick → seek video to that specific revisit

**Data source:** for each step ID, `len(step_times[step_id])` and the time windows themselves.

**Dataset prevalence:** 341 of 504 annotated step instances have more than one window. Extreme cases: Cacio e Pepe S03 with 20 windows; Sfesiha S01 with 13.

**What users discover:** which steps are attention-heavy mechanical loops — strong candidates for robot delegation, since a step revisited 20 times is a repetitive sub-task ripe to offload.

### 5.3 Design 3 — Parallel overlaps (Gantt / swimlane)

This is the view the current motion graph fundamentally cannot produce. It directly serves Prof. Yen's "robot holds the machine while person brushes hair" vision and Prof. Grace's parallel collaboration mode.

**Research question:** Where does the participant already run two tasks at once?

**View structure:** A Gantt-style swimlane.
- **X-axis = real elapsed time** (no bucketing, no mean — actual seconds)
- Each step gets its **own horizontal lane**
- Each time window is a **bar at its true `[start, end]`** with width proportional to true duration
- **Vertical highlight bands** mark columns where two or more steps were simultaneously active — the overlap regions

When two bars in different lanes occupy the same x-range, the steps overlapped. The vertical alignment is the visual signal.

**Interactive controls:**
- Switch lane grouping: **by step**, **by verb category**, or **by primary/secondary**
- Toggle **"show overlaps only"** — dims non-overlapping bars so the 214 simultaneity points pop
- **Minimum overlap duration slider** — ignore <1s incidental overlaps, keep meaningful ones
- Toggle x-axis between **absolute seconds** and **normalized 0–100%** (to compare across sessions)
- Click any bar → seek video; click an overlap band → see both actions at that moment in the video

**Data source:** all pairs of `step_times` windows from different steps in the same capture where `max(start1, start2) < min(end1, end2)`.

**Dataset prevalence:** 25 overlapping pairs across 12 of 80 captures. Cacio e Pepe S01 ∩ S03; Sfesiha dough-rest ∩ filling-prep.

**What users discover:** natural parallelization points where a robot taking one track wouldn't disrupt the human's flow. These are pre-existing demonstrations that the human's workflow already supports parallel execution at these specific moments.

**Why this is the highest-value design:** it answers the question Prof. Yen raised that the meeting couldn't resolve, it serves Prof. Grace's parallel collaboration mode directly, and it provides the honest temporal representation Prof. Lin demanded. It also forces the timeline foundation that Designs 1, 2, and 4 can reuse.

### 5.4 Design 4 — Prep-vs-execution gaps

**Research question:** How long is the window between preparing for a step and actually executing it? Long gaps are candidate intervention windows where a robot could bridge.

**View structure:** One row per step, sorted by gap length.
- A **green marker** where `prep_times` begins (prep starts)
- A **blue marker** where `step_times` begins (execution starts)
- A **yellow bar** connecting them — the gap

A long yellow bar means the person prepared early then did other things before executing. The bar literally is the intervention window. Each row is labeled with the gap duration, color-coded by length (red for very long, yellow for medium, green for short).

**Interactive controls:**
- Sort by **gap length** (longest at top — biggest opportunity windows) or **by recipe order**
- Toggle **"show prep without execution"** — surfaces annotation gaps where prep was annotated but execution wasn't
- **Overlay option:** show what *other* actions happened inside the gap — what was the person doing instead of executing?
- Click the gap bar → play video across that span to see what filled the time

**Data source:** `prep_times[step_id][0].start` vs `step_times[step_id][0].start`. Currently `prep_times` is unused in the dashboard and would need to be added to the pipeline.

**Dataset prevalence:** present in most captures. Example: P01_R01 S04 — prep starts at 9.5s, execution at 136s, gap of 127s.

**What users discover:** windows where preparation and execution are temporally separated — candidate moments for a robot to pre-position a tool during the human's prep, then hand off when the human is ready to execute.

### 5.5 How the four views fit together

These should not be built as four separate pages. The unifying structure: **all four are time-based views of the same capture, sharing one video and one timeline cursor.**

The natural architecture is a single **"Intervention Explorer"** panel with:

- One shared `<video>` element at the top
- One shared timeline cursor that moves across all four views as the video plays
- A **view-mode switcher**: Order alignment · Revisitation · Overlaps · Prep-gaps
- Shared controls that persist across views: session picker, real-time vs normalized, click-to-seek
- Each view answers one of the four questions, but they all illuminate the same underlying video moments

This is genuinely interactive in the sense that matters — users explore by switching views, filtering, sorting, and clicking into the video, rather than reading a fixed chart.

The two collaboration framings from Section 2.2 map cleanly onto these:

- **Parallel collaboration mode** → Design 3 (overlaps)
- **Sequential/predictive collaboration mode** → Designs 1 (deviations) and 4 (prep-gaps)
- Design 2 (revisitation) identifies the *targets* for either mode — actions worth delegating

### 5.6 Relationship to the current motion graph

The current motion graph is a node-link diagram with a misleading temporal layout. The dataset analysis in Part 1 makes clear it cannot honestly represent the three structural realities of HD-EPIC cooking:

- Out-of-order step execution (50/80 captures) — a left-to-right node layout asserts an order the data doesn't have.
- Step revisitation (341 of 504 step-instances have >1 window) — aggregating into a single node hides temporal distribution.
- Temporal overlap (25 same-video pairs in 12 captures) — a directed sequence graph structurally cannot represent two steps active simultaneously.

These are not framing issues; the motion graph's representation is wrong for this data.

**The swimlane (Design 3 generalized) is the appropriate primary view for one recipe.** Time on the x-axis, one lane per recipe step in nominal order, every step window as a bar at its true position with width = duration. The three structural realities become *visible features* of the data rather than problems to work around: revisitation appears as multiple bars in the same lane, overlap appears as vertical alignment across lanes, and out-of-order execution appears as bars whose chronological order doesn't match their lane order. With LLM step labels as lane headings ("load capsule", "brew espresso", "froth milk", ...) the swimlane is also recipe-recognizable without watching the video.

**The motion graph is not eliminated; it is demoted to a complementary role.** Its honest jobs are showing *what kinds* of action exist and how they cluster by HRI role — questions where time is not the primary concern. The merged motion graph for cross-session aggregation retains its purpose (showing transition support across sessions).

**Resulting three-view architecture:**

| View | Question it answers | Position in dashboard |
|---|---|---|
| Swimlane (single session) | When does each action happen, how long, in what order? | Primary single-session view |
| Motion graph (single session) | What kinds of action exist, in what role groupings? | Complementary, explicitly non-temporal |
| Merged motion graph (cross-session) | What reliably follows what across sessions? | Comparison view |

Each view makes one honest claim instead of one view making a confused one (Baldonado et al. 2000, *Guidelines for using multiple views in information visualization*).

### 5.7 What the swimlane delivers against the insight list

Coverage of the insights tracked in sections 2.3 and 2.4:

| Insight | Swimlane delivers? |
|---|---|
| Action frequency (2.3) | Yes — bar count per lane |
| Action category (2.3) | Yes — bar fill color, same 13-category palette |
| Action duration (2.3) | Yes — bar width on a real time axis |
| Within-person consistency (2.3) | Yes — stack one swimlane per session, time-aligned |
| Transition structure (2.3) | Partial — order visible, but no probabilities |
| Self-loops / consecutive repetition (2.3) | Yes — adjacent bars in same lane |
| Insight A · Deviations from recipe order (2.4) | Yes — bars firing out of lane order are visible deviations |
| Insight B · Revisitation hotspots (2.4) | Yes — dense lanes are visually obvious |
| Insight C · Parallel overlaps (2.4) | Yes — vertical alignment across lanes |
| Insight D · Prep-vs-execution gaps (2.4) | Yes — render prep as outline bar, execution as filled bar, in the same lane; the empty gap between them is the intervention window |

Six insights fully delivered, two existing insights partially delivered, no insight made worse. This is a net coverage gain across the dashboard.

**Encoding choices, settled:**

- **Lane order** = recipe order (S01 top, last step bottom). Any other order forfeits the deviation signal that out-of-order lanes provide for free.
- **Prep vs execution** = outline-only bar for prep, filled bar for execution, both in the same verb-category color, in the same lane. The empty space between an outline-bar's end and a filled-bar's start *is* the prep–execution gap (Aigner et al. 2011 on layered time intervals).
- **Lane labels** = LLM step labels from `step_labels.json` ("load capsule", "brew espresso", ...), with the raw step ID as fallback. This is what makes the swimlane recipe-recognizable.

**One signal the swimlane does NOT deliver:** transition probability across sessions (which Prof. Lin's Markov direction needs). That signal lives in a transition matrix, not a timeline. The merged motion graph already partly serves this; a true transition matrix would serve it better and remains a candidate for a future complementary view.

**Bar fill — sub-segmented:**

Each step bar contains multiple atomic actions inside its time window (e.g., S02 "brew espresso" at 18.9–19.2s contains `take`, `open`, `press`, `close`). Rendering option:

- **Sub-segmented** (each atomic action is its own colored slice within the bar, widths from real timestamps) — matches the existing barcode encoding for consistency, but short atomic actions become invisible slivers at normal zoom.

### 5.8 Implementation order, revised

The original section 5.7 order (Design 3 → Design 1 → Design 2 → Design 4) assumed four parallel designs. With the swimlane recast as the primary view, the order is:

1. **Build the swimlane as the primary single-session view.** Reuses the existing detail-level pipeline (Task Phases gives clean lanes; Smart-Merged and Full Raw use the existing `step_id` field for lane assignment). LLM step labels become lane labels. This single build delivers Insights B, C, and partial A.
2. **Layer `prep_times` onto the swimlane** (outline bars). This delivers Insight D. Requires adding `prep_times` to the pipeline output, which is independent groundwork.
3. **Add lane-order deviation cues** (e.g., a small marker or color tint when a bar's chronological order doesn't match its lane order). This sharpens Insight A from partial to full.
4. **Demote the motion graph to a non-temporal topology view** (HRI / category clusters only, no time axis). Resolves the column-confusion problem by removing time from the view that can't honestly represent it.

Before step 2, verify `prep_times` coverage across the corpus — if only a minority of captures have usable prep windows, Insight D works for case studies but not corpus-wide, and the swimlane's prep layer should be presented accordingly.