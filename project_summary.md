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

### 1.8 The challenges that constrain visualization

These are the dataset's defining difficulties. The current motion graph design predates this analysis and does not handle them well.

#### Challenge 1 — Step order is not followed linearly

**63% of captures (50 of 80)** have at least one step whose first occurrence precedes the previous nominal step.

Example: In all three Nespresso captures, P01 presses the coffee button (S02) before fully inserting the capsule (S01). In Sfesiha (P01_R04), S07 fires at 16s while S01 fires at 25s — a later step begins before the first.

**Implication:** Step number (S01, S02, ...) is not a reliable proxy for time. Any visualization that places steps left-to-right by step number will contradict the video evidence.

#### Challenge 2 — Step revisitation (This is not a challenge. This is normal behavior in cooking)

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

Across all: **identify where and how a robot could take over or share work, and represent human and (eventually) robot activity together.** Two collaboration modes have been named:

- **Parallel collaboration:** human and robot act simultaneously, possibly on different sub-tasks
- **Sequential / predictive collaboration:** robot anticipates the next human action

### 2.3 Insights already revealed by the dashboard

Honest accounting of what the dashboard surfaces today:

| Insight | Status | How it's revealed |
|---|---|---|
| Action frequency | Full | Node size in graph; segment density in barcode and swimlane |
| Action category | Full | 13-color encoding consistent across views; combined with HRC-role |
| Action duration | Full | Swimlane |
| Within-person consistency | Partial | Barcode |
| Transition structure | Partial | Graph edges. Still have issues on how to represent the transition: backward transitions |
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

**Data source:** `prep_times[step_id][*].end` paired with the first future `step_times[step_id][*].start` on the unified capture timeline. As of the July 2026 pipeline update, `prep_times` is stitched onto the unified timeline alongside `step_times`, and per-step gap pairs (`prep_end`, `exec_start`, `gap`) are pre-computed into each session payload as `steps[].prep_gaps`. Every sequence item also carries a `phase` field (`exec` / `prep` / `None`). Frontend rendering of prep windows in the swimlane is the remaining piece.
**Dataset prevalence:** present in most captures.

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
| Video hosting | Lab's Server + TryCloudflare + Caddy |
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
      session_{N}_full.json         Full Raw (verb(noun) atomic)
      session_{N}_smart.json        Smart-Merged (verb-only)
      session_{N}_abstracted.json   Recipe-step nodes (generated, not in UI)
      session_{N}_categorical.json  13 verb-category nodes
      session_{N}_hybrid.json       verb_key(noun_category), Markov view
      merged_{mode}.json            Cross-session aggregated graph (up to 5 files)
  figures/
    overlap_pairs.csv               One row per detected overlap, for verification
  https://controversial-sophisticated-dozen-quit.trycloudflare.com/hd_epic_videos/
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
session_{N}_{mode}.json (5 files per session: full, smart, abstracted, categorical, hybrid)
    ↓ (script 8: aggregation if multi-session)
merged_{mode}.json (up to 5 merged files, one per mode)
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

### 3.3.2 Merged-graph aggregation (8_aggregate_sessions.py)

Prof. Lin's requirement: the motion graph should summarize action occurrences and frequencies ACROSS trials. Three statistical requirements were implemented:

1. **Shared state space** — the categorical (13 verb-category) and hybrid (`verb_key(noun_category)`) modes both use fixed identity functions that produce identical alphabets across sessions by construction (§3.4.2). Pooling counts across sessions therefore does not mix incommensurable alphabets.
2. **Pooled probabilities** — merged edge probability is the pooled MLE: P(B|A) = Σ_sessions count(A→B) / Σ_sessions out-degree(A) (Anderson & Goodman 1957). Explicitly NOT the average of per-session probabilities (average-of-ratios weights a 2-transition session equally with a 40-transition one; Simpson-style bias, Blyth 1972). Example: 8/10 and 1/2 pool to 9/12 = 0.75, not (0.8+0.5)/2 = 0.65.
3. **Session-respecting ranks** — each merged sequence item carries `normalized_rank` (index within its OWN session / session length), so the rank layout doesn't misread concatenation order as temporal order.

**Sentinel unification.** `normalize_special_nodes` coerces any variant of a start or end identity (`START`, `START:`, `START::…`, `END`, `END:…`) into the canonical `START` / `END` tokens before pooling, so all sessions merge cleanly at the root and tail of the graph. Applied consistently to node ids, sequence `action`, sequence `next_action`, `edge_key`, and link `source` / `target`.

**Propagated fields.** `salient` flag, `verbs` distribution, and `objects` distribution survive merging (unions across sessions). `MODES` covers one per-session mode: `["hybrid"]`. The existing `support` / `support_fraction` fields (in how many sessions a node/edge appears) are retained — support is the cross-trial consistency signal (habitual vs. idiosyncratic transitions), directly relevant to what an anticipatory robot should rely on.

**Additional merged-node fields.** Every merged node carries `total_count`, `per_session_counts`, `is_mandatory` (support == n_sessions, excluding START/END), `merged_step_id` (majority-vote across sessions), `per_session_step_ids`, `mean_normalized_onset`, `raw_onsets` (list across all sessions for downstream distribution plots), and `mean_duration` / `min_duration` / `max_duration`. Every merged link carries `per_session_counts`, `per_session_occurrences`, and the pooled `probability`.

**Merged-graph analysis (`compute_merged_analysis`).** New in the July 2026 revision. Each merged JSON now ships an `analysis` block containing:

- `mandatory_nodes` — actions present in every session; the operational core of the recipe.
- `canonical_spine` and `canonical_spine_score` — a greedy walk from `START` choosing, at each step, the successor with highest support (breaking ties by highest pooled probability). This is a habit-weighted "most likely path" through the merged chain and is useful as an anticipatory-robot baseline: the plan a robot would follow if it always bet on what the person usually did.

- `session_similarity` — pairwise (1 − normalized Levenshtein) matrix on the START/END-stripped action sequences; a first-order handle on within-participant consistency.
- `session_shared_prefix` and `session_shared_suffix` — the initial and final action runs identical across all sessions in the same positions. Structural signal for openings/closings that are stable across trials.
- `loops` — up to 20 cycles (length ≤ 5) discovered in the strong-edge subgraph (support ≥ 2, non-self-loop). Structural signal for recurring behavioral motifs.
- `session_singleton_nodes` — actions that appear in only one session (idiosyncratic behavior).

### 3.4 Detail-level modes

The pipeline produces **five** per-session JSONs, each at a different granularity:

- **Full Raw** (`session_{N}_full.json`) — every atomic action is a separate node, identified by `verb(noun)`. Node counts range from 39 (P08_R01 Coffee) to 424 (P03_R03 Drip Coffee). Useful for inspecting exact action sequences but visually dense.
- **Smart-Merged** (`session_{N}_smart.json`) — nodes are specific verbs (the 32 verb keys from HD-EPIC), object information collapsed into a per-node `objects` distribution. ~30–80 nodes per recipe. Mid-granularity view.
- **Categorical** (`session_{N}_categorical.json`) — nodes are the 13 HD-EPIC verb categories (`retrieve`, `leave`, `manipulate`, `access`, `block`, `clean`, `merge`, `transition`, `sense`, `split`, `monitor`, `distribute`, `order`). 10–13 nodes per recipe consistently. **This is the Markov-chain view in the Video Textures sense** — each state is a self-contained observable label, transitions count between consecutive observed states, and edge weights carry both raw `count` and Markov `probability` (outgoing probabilities sum to 1.0 per node). Each node carries `objects` (specific-noun frequency), `verbs` (specific-verb frequency), and `noun_categories` (frequency across noun categories) so the hover tooltip can surface object detail without putting it in the node identity.
- **Hybrid** (`session_{N}_hybrid.json`) — the primary Markov view. State identity is the fixed function `verb_key(noun_category)` (e.g. `pour(beverage)`, `press(button)`, `open(container)`). A dedicated two-pipeline architecture produces (a) a *full sequence* — every atomic action with `verb_key(noun_category)` identity plus injected `START` / `END` sentinel items — that feeds the swimlane and barcode views, and (b) a *primary sequence* — the same identity function applied to only the `is_primary=True` subset — that drives the motion graph's nodes and edges. Filtering the graph to primary actions makes the Markov chain about recipe execution rather than about the interleaved noise of drawer-opening, phone-checking, and cleanup. Node counts fall in the ~15–40 range in practice. Edges carry `count` and Markov `probability` (P(B|A) = count/out-degree, Σ = 1 per node, self-loops kept; Schödl et al. 2000). See §3.4.2.
- **Abstracted** (`session_{N}_abstracted.json`) — nodes are recipe steps (S01, S02, …). 3–16 nodes per recipe. Still generated by the pipeline for downstream reuse. **Removed from the dashboard UI** in the June 2026 revision — the swimlane covers step structure and duplicate views fragment attention.



#### Step labels

Each step node carries a short **diagnostic label** (e.g., "insert capsule", "froth milk", "stir cappuccino") in addition to its raw step ID (`S01`). The labels are generated offline by an LLM-assisted pipeline (`9_generate_step_labels.py`) and hand-reviewed for recipe-recognizability: reading a recipe's labels in order should make the dish identifiable without watching the video. 

Labels live in `outputs/step_labels.json` keyed by full step ID (`P01_R01_S01`), and ride the pipeline into each payload's `steps[].label` and onto abstracted nodes' `step_label`. The frontend (`config.js`'s `resolveStepLabel`) falls back gracefully to the raw step ID if a label is missing, so the view never breaks. Labels are generated once and committed — no LLM call at render time, which keeps the dashboard deterministic for demos.


### 3.4.2 Hybrid mode — design (revised July 2026)

**Problem.** The Categorical mode (§3.4.1) hits the node-count target but has two limits: (1) it is recipe-blind — `retrieve → block → leave` reads identically for coffee, curry, or salad — and (2) it treats atomic-action noise (drawer-opening, phone-checking, cleanup) as equivalent to recipe-relevant activity. Prof. Lin's twin requirements — a proper Markov chain AND recipe-recognizability — need a state definition that carries more information than the verb category alone AND a mechanism that lets the graph focus on execution.

**Design: fixed identity function + two-pipeline architecture.** The revised hybrid mode uses a deterministic state definition and separates the sequence that drives the UI from the sequence that drives the graph.

1. **Identity function (fixed, no per-recipe tuning).** Every atomic action's state is `verb_key(noun_category)` — the specific HD-EPIC verb (32 keys) crossed with the noun's high-level category (21 categories, e.g. `container`, `beverage`, `appliance`). Examples: `pour(beverage)`, `press(button)`, `open(container)`, `stir(container)`. This is authored by construction, not by lexical matching against the recipe text: no LLM, no vocabulary file, no `--salient-k`, no `match_report`. The pipeline runs identically on any recipe.

   Why `verb_key × noun_category` rather than `verb_key × noun` or `verb_category × noun`? The verb key preserves the distinction between semantically distinct actions inside one category (`retrieve` covers both `take` and `remove`; `manipulate` covers `press` vs `flip`). The noun category preserves a stable, recipe-comparable object handle without exploding the alphabet the way individual nouns do (28–124 nodes at `verb_cat × noun_cat`, §3.4.1). The trade-off is deliberate: recipe identity now lives less in the node labels themselves (a coffee capsule and a tea bag can both surface as `container`) and more in the transition structure over primary actions, plus the per-node `objects` and `verbs` distributions surfaced in tooltips.

2. **Two pipelines from the same tagged sequence.**

    - **Pipeline 1 — Full Sequence (drives swimlane / barcode).** Every atomic action gets its `verb_key(noun_category)` identity. Two synthetic sentinel items are then inserted at the head and tail: `START` at `t = max(0, first_action.start − 0.001)` and `END` at `t = last_action.end + 0.001`, both flagged `is_primary=True` (so they survive Pipeline 2's filter) and `kind` set to `start` / `end` for the renderer. Consecutive-item `next_action` and `edge_key` fields are re-linked. This is what feeds the swimlane, barcode, and any UI element that needs to walk the full behavioral timeline. Nothing is dropped from Pipeline 1.

    - **Pipeline 2 — Primary Sequence (drives the motion graph).** A copy of the full sequence is filtered to `is_primary=True` items only. `next_action` and `edge_key` are re-linked so edges skip over the removed secondary items — a stir-in-the-pot that used to be followed by a phone-glance and then another stir now connects stir → stir directly. Node counts, per-node `objects` / `verbs` / `kind`, edges, and Markov probabilities are compiled from this primary-only stream. The motion graph therefore represents the recipe-execution Markov chain rather than the interleaved noise of the whole capture.

    Both sequences are shipped in the payload: `result["sequence"]` = full sequence (for the UI's timeline uses), `result["graph"]` = nodes + links derived from primary sequence (for the motion graph). The two-pipeline design is documented on the payload itself as `salient_config = {"identity_rule": "verb_key(noun_category). Graph filtered for primary actions. Sequence keeps all actions."}`.

3. **Per-session analysis fields.** Every hybrid payload also carries an `analysis` block:
    - `self_loops` — actions where two consecutive primary-sequence items land on the same identity (`stir → stir`, `pour → pour`), with count. These are the honest consecutive-repetition signal at the primary level.
    - `start_id` / `end_id` — the sentinel identities, so the renderer can locate the graph's root and tail deterministically.



**HRI framing (preserved).** The `is_primary` / `is_secondary` split remains collaboration-relevant. Primary actions are the recipe-critical work the human is doing when they are visibly on-recipe; secondary actions (retrieve-a-cloth, check-a-phone, open-a-drawer between steps) are the repetitive delegable activity a robot could absorb (anticipatory-support framing, Hoffman & Breazeal 2007). The two-pipeline split makes this explicit at the data-model level: the graph represents what a robot would need to anticipate; the full sequence represents everything actually happening.

**Known contamination caveat (still open).** Narration files span whole videos, so recipes sharing videos with other dishes carry inflated secondary counts. Scoping narrations to the recipe's time span via the per-participant activity-timestamps CSVs remains a pending pipeline task.

### 3.5 Primary vs Secondary action lanes (stil need these two action categories. but they're not showed in the graph anymore)

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

#### Hybrid-mode rendering in graph.js (Markov rank layout)

**No time axis.** A Markov chain is memoryless; its states have no temporal coordinates. Positioning states on an absolute-time axis asserts facts the abstraction doesn't contain — an expressiveness violation (Mackinlay 1986). In hybrid mode the temporal layout is replaced by a **rank layout**: nodes ordered left-to-right by the median normalized rank of their occurrences (relative order, per Prof. Lin), the process-map convention from process mining (directly-follows graphs; van der Aalst 2016).

**Data-model note.** The renderer reads nodes from `payload.graph` (built from Pipeline 2 — primary-only) and reads the timeline from `payload.sequence` (built from Pipeline 1 — full sequence, including sentinel `START` / `END` items with `kind = "start" | "end"`). The graph is therefore a Markov chain over recipe execution, while playback and time-based views walk every atomic action. Nodes carry `kind`, `is_start`, `is_end`, `dead_end_score`, and their `objects` / `verbs` distributions from the primary sequence.

**Layout mechanics:** ordinal spacing (evenly spaced rank order, START/END pinned to the extremes), salient band above / background band below, deterministic 3-level vertical stagger (−90/0/+90), then constrained force relaxation — x pinned by `forceX(0.9)`, y relaxed under `forceY(0.05)` + collision (constrained-layout family, Dwyer et al. 2006). Deterministic seeding (no random jitter) so identical data renders identically across reloads — required for cross-meeting screenshot comparability. Fit-to-view was retuned after diagnosing a width-bound fit (scale = min(W/gw, H/gh); the wide strip layout bound on width): radius-aware padding, fit factor 0.9→0.97, SPACING reduced so collision converts horizontal compression into vertical spread.

**Edge encoding:** width = Markov probability (linear [0,1]→[0.8,6]); curved quadratic paths disambiguate overlapping collinear edges (arrowheads retained for direction — curvature alone conveys direction poorly, Holten & van Wijk 2009); low-probability edges (P < 0.08, START/END exempt) hidden with an on-canvas count caption — significance filtering per the Fuzzy Miner (Günther & van der Aalst 2007), with the caption keeping the filtering honest. Self-loops are real arcs with probability labels, drawn **inside each node group in node-local coordinates** so they inherit the node transform and follow drags (fixes a stale-geometry bug where zoomGroup-level arcs ignored dragging).

**Node encoding:** action nodes (`kind == "action"`, `salient == true` by construction under the new hybrid model) get a dark ring; sentinel `START` / `END` nodes are rendered distinctly via their `kind` field. Labels are never truncated in hybrid mode (the 7-char `slice` rule is bypassed), rendered as two lines (verb / noun-category) with a label-fit radius floor; the count badge preserves exact frequency since radius now partially encodes label size (area is a low-accuracy channel anyway; Cleveland & McGill 1984). Node tooltip surfaces `Objects:` (specific-noun distribution), `Verbs:` (specific-verb distribution — collapsed to 1 element under the new identity function but still informative in Categorical mode which reuses this renderer path), and `dead_end_score`; edge tooltip adds `P(target | source)`.

#### Marker id namespacing (bug fix, all modes)

The single-session and merged views are two `createGraphController` instances whose `<defs>` both defined markers with identical ids (`#arrow` etc.) — invalid duplicate ids (WHATWG HTML §3.2.6). `url(#arrow)` resolves to the FIRST id in document order; when the Merged tab hides the single-session view (`display:none`), Chromium does not paint markers referenced from hidden subtrees (Chromium issue 109212), so merged-view arrowheads silently vanished. Fix: marker ids are namespaced per controller instance (`arrow-graphSvg`, `arrow-mergedGraphSvg`) via `markerId()`/`markerUrl()` helpers — the same pattern `thumbnailGraph.js` already used. Regression guard: `grep 'url(#arrow' graph.js` must return zero unnamespaced hits.

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

#### Categorical-mode rendering — additions to `config.js` and `graph.js`

- **`config.js`** — `loadVerbCategories()` now maps each category name to itself (in addition to mapping verb keys → categories). This lets `getVerbColor("retrieve")` resolve correctly when the node identity is a category name rather than a verb key. Without this, categorical-mode nodes would fall back to the default color.
- **`graph.js`** — the node-hover tooltip gained a `Verbs:` block (top 8 specific verbs in this category) and the `Objects:` block now sorts by frequency and caps at top-10 so the tooltip stays readable in categorical mode (where a single node like `retrieve` can aggregate 30+ distinct nouns). The duration-stats block has a `categorical` case mirroring the `smart` case.
- **`index.html`** — the `<select id="graphModeSelect">` element gained a fourth option (`<option value="categorical">Categorical (by verb category)</option>`).

No new module was needed; the categorical mode plugs into the existing detail-mode infrastructure via the URL pattern `session_{N}_categorical.json` and reuses the same renderer.

#### `9_generate_step_labels.py` — offline step labeling

Standalone script that produces `outputs/step_labels.json`. Reads each recipe's step text from `complete_recipes.json`, sends it to an LLM (Gemini Flash-Lite via REST, with `.env`-based key loading) under a prompt that asks for a 1–3 word diagnostic label, and writes the result. Includes a heuristic fallback for dry-runs and tolerant UTF-8 / cp1252 reading so curly apostrophes in step text don't break the loader. Labels are hand-reviewed and a final pass ensures each recipe's set reads as the dish ("load coffee capsule → brew espresso → froth milk → pour foam in coffee → stir cappuccino"). 

### 3.7 Views

#### Single-session view

Two-column layout:
- Left: motion graph with encoding controls above it,  the graph itself with zoom buttons, then the legend
- Right: video player, annotation timeline strip, recipe metadata panel
- Bottom: action timeline table

#### Comparison view (default)

Two-column layout:
- Left: The merged graph is always the primary graph; session tabs act as highlights on it, not view switches
- Right: main video, thumbnail queue of inactive sessions, [n] stacked barcodes, comparison metadata panel

### 3.8 Controls

**Shared Top-Row Controls (Encoding & View Filters):**
- **Recipe dropdown:** Selects the target recipe payload (e.g., P01_R01, P03_R03).
- **Highlight View tabs:** Session picker containing "All Sessions" (loads merged global topology) alongside individual "Session 1", "Session 2", etc. tabs. Toggling tabs dynamically shifts path opacities to spotlight specific participant workflows without tearing down the layout.
- **Detail Level dropdown:** Selects the abstraction mode:
  - *Hybrid (verb_key):* Primary Markov view using `verb_key(noun_category)` states.
  - *Hybrid (verb_cat):* High-level Markov view using `verb_category(noun_category)` states.
- **Color encodes dropdown:** Node fill encoding (Action category / Task phase / Mean duration).
- **Node size dropdown:** Circle area encoding (Frequency / Duration).
- **Layout dropdown:** Spatial positioning mode (Process Flow / HRC roles).
- **Highlight Canonical Spine button:** Dynamic toggle that darkens and thickens the greedy highest-probability walk from `START` to `END`.

**Dynamic Panel Controls (Context-Aware):**
- **Single Session Focus (when an individual session tab is selected):**
  - Displays the single Annotation Timeline Strip above the Swimlane.
  - Swimlane maps actions back to absolute elapsed time, showing primary execution bars alongside secondary background activity.
- **All Sessions / Merged View (when "All Sessions" tab is selected):**
  - Displays the Stacked Barcodes and Video Thumbnail Queue in the right panel.
  - Filters out single-session swimlanes to emphasize cross-trial comparison.
### 3.9 Interactions

- **Click a node in motion graph** → seek video to that action's start; repeated clicks cycle through the action's occurrences
- **Click a barcode segment** → seek video; if it's from a non-active session, switch the main video first
- **Click a thumbnail in the video queue** → swap into main video slot
- **Drag a node** → reposition (single-session); reset button restores layout
- **Scroll on graph** → zoom; drag empty space → pan
- **Hover a node** → tooltip with count, support, duration stats, object map
- **Hover an edge** → tooltip with transition count and source/target

### 3.10 Known limitations
- **Step-tagging picks one step per action even when step windows are nested.** When an action overlaps two step windows (e.g., S03 nested inside S02 in P05_R01), the rule picks the step with maximum overlap. The narrower step receives no actions. This is a design choice — one step per action keeps the swimlane unambiguous — but it can hide annotated step boundaries in a few specific captures.
- **Annotation-layer gap.** Step-time annotations and atomic-action narrations were created independently and don't always agree on what counts as activity. About 0.9% of step-windows across the dataset have zero underlying narrations; P08_R03 has 23% (5 of 22). The dashboard renders these as visible-but-empty step windows.
- **Cross-video overlap not detected.** The overlap detector (P3) only flags pairs within the same video file. If two step windows span a pause/resume boundary, they are not flagged. Adding cross-video overlap detection would require offset-aware time math; deferred.
- **Cross-person comparison structurally impossible** with available data (63 of 69 recipes are single-participant).
- **Intervention insights: data available, UI pending.** The dashboard reveals frequency, transition structure, and consistency well. As of July 2026 the pipeline emits the underlying data for all four intervention insights (per-step time-window arrays for A/B/C; `step_windows` with `phase` and `steps[].prep_gaps` for D), but the frontend does not yet render dedicated views for any of them. The four proposed views in Part 5 are what closes this gap.
- **Lexical salience matching has recall misses.** Synonym gaps are not recoverable by any lexical rule (e.g., P01_R01's frother matches no HD-EPIC key token). The `match_report` in `salient_config` makes each recipe's matches auditable; a per-recipe scan against step text is recommended when adding new recipes.
- **Drag geometry lacks a single source of truth.** Node positions, edges, and self-loops are updated by separate code paths; two stale-geometry bugs have already occurred (START rank, self-loop arcs). A consolidated `updatePositions()` re-deriving all position-dependent geometry is the durable fix (standard D3 idiom); deferred.