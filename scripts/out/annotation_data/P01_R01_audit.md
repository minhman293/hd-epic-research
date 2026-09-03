# Data audit - P01_R01 (Nespresso)

Generated 2026-09-03 14:30 by build_annotation_data.py

Parameters: `min_sessions=2`, `node_definition=verb key + noun category`, `transitions=contract`, `segment_weights=uniform`, `llm=gemini-3.5-flash-lite`

## 1. Scoping to the recipe

| session | videos | actions in video | kept in recipe | dropped |
|---|---|---|---|---|
| 1 | P01-20240202-110250 | 224 | 40 | 184 |
| 2 | P01-20240203-093333 | 68 | 68 | 0 |
| 3 | P01-20240204-095114 | 81 | 52 | 29 |

Narrations with more than one main action (only the first is used): 0. Class ids missing from the vocab: 0.

## 2. Node identity

Measured distinct type counts on the scoped data:

| node definition | types |
|---|---|
| verb key + noun key | 81 |
| verb key + noun category | 63  **<- used** |
| verb category + noun category | 49 |
| verb key alone | 26 |
| verb category alone | 10 |

## 3. Recurrence threshold

| appears in >= N sessions | types kept | instances covered | coverage |
|---|---|---|---|
| 1 | 63 | 160 | 100% |
| 2 | 27 | 121 | 76%  **<- used** |
| 3 | 12 | 69 | 43% |

## 4. Graph

- nodes drawn: **27**
- core edges (>= 2 sessions): **24**
- backbone edges (kept only to prevent a sink): **14**
- hidden transitions (not drawn, carried as residual mass): **42**
- self-loops: **7**
- largest residual on any node: **80%**
- one-off actions stepped over to keep the flow connected: **39**

Connectivity check passed: every node has a visible successor (or terminal mass) and a visible predecessor (or start mass).

## 5. Milestone alignment

6 display segments. Boundaries at [0.0, 0.16666666666666666, 0.3333333333333333, 0.5, 0.6666666666666666, 0.8333333333333334, 1.0].

| session | step | issue |
|---|---|---|
| 1 | P01_R01_S02 | 2 occurrences, used last end |
| 1 | - | 1 zero-length segment(s) from out-of-order or revisited steps |
| 2 | P01_R01_S02 | 3 occurrences, used last end |
| 2 | - | 1 zero-length segment(s) from out-of-order or revisited steps |
| 3 | P01_R01_S02 | 2 occurrences, used last end |
| 3 | - | 1 zero-length segment(s) from out-of-order or revisited steps |

## 6. Display labels

The LLM only renames. It cannot change which nodes exist, how they merge, or where they sit. `rule` is what the deterministic fallback produces; run with `--no-llm` to use it.

| node key | rule | llm | used (verb / object) |
|---|---|---|---|
| `take crockery` | take / cup | pick up / mug | **pick up / mug** |
| `lift cookware` | lift / cookware | lift / handle | **lift / handle** |
| `turn crockery` | turn / cup | turn / mug | **turn / mug** |
| `put crockery` | put / crockery | put down / mug | **put down / mug** |
| `take drinks` | take / coffee | pick up / coffee pod | **pick up / coffee pod** |
| `open storage` | open / cupboard | open / cupboard | **open / cupboard** |
| `open furniture` | open / drawer | open / compartment | **open / compartment** |
| `put drinks` | put / coffee | insert / coffee pod | **insert / coffee pod** |
| `take containers` | take / bottle | pick up / milk bottle | **pick up / milk bottle** |
| `close containers` | close / containers | close / lid | **close / lid** |
| `put containers` | put / bottle | put down / milk bottle | **put down / milk bottle** |
| `turn-on dairy and eggs` | turn on / milk | turn on / milk frother | **turn on / milk frother** |
| `open containers` | open / containers | open / milk bottle | **open / milk bottle** |
| `lift containers` | lift / lid | lift / lid | **lift / lid** |
| `press appliances` | press / button | press / button | **press / button** |
| `close appliances` | close / appliances | close / fridge | **close / fridge** |
| `open appliances` | open / fridge | open / fridge | **open / fridge** |
| `pour dairy and eggs` | pour / milk | pour / milk | **pour / milk** |
| `take dairy and eggs` | take / milk | pick up / milk frother | **pick up / milk frother** |
| `pat dairy and eggs` | pat / milk | tap / milk frother | **tap / milk frother** |
| `lift dairy and eggs` | lift / milk | tilt / milk frother | **tilt / milk frother** |
| `put dairy and eggs` | put / milk | put down / milk frother | **put down / milk frother** |
| `wash dairy and eggs` | wash / milk | wash / milk frother | **wash / milk frother** |
| `mix drinks` | mix / coffee | stir / coffee | **stir / coffee** |
| `shake cutlery` | shake / spoon | shake / stirrer | **shake / stirrer** |
| `throw cutlery` | throw / spoon | throw away / stirrer | **throw away / stirrer** |
| `close rubbish` | close / bin | close / bin | **close / bin** |
