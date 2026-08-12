# The Motion Graph: How the Data Is Built and How the Picture Is Drawn

*A complete explanation, assuming no knowledge of the code.*

---

## Part 0 — What is in the dataset

Everything starts from **HD-EPIC**, a dataset of head-mounted camera recordings of
people cooking in their own kitchens.

**The recordings.** 156 videos. Each video is one continuous session in one
kitchen. A person may cook the same recipe on several different days, so one
recipe can have several sessions.

**The annotations.** Every video is annotated with a long list of very short
actions. Across the dataset there are **59,454 annotated actions**. Each action
has four things we care about:

| Field | Meaning | Example |
|---|---|---|
| start, end | when it happened, in seconds | 12.4 → 13.2 |
| verb | what the hands did | *take* |
| noun | what was touched | *cup* |
| step id | which recipe step it belongs to (often blank) | `P01_R01_S02` |

**Two important facts about these actions:**

1. **They are extremely short.** The median action lasts **0.84 seconds**, and
   60% last under one second. These are hand movements, not recipe steps.
2. **Most of them are logistics, not cooking.** Roughly 59% of all actions are
   *fetching*, *putting down*, and *opening/closing* — moving objects around
   rather than changing food.

**The vocabulary.** Actions are labelled from a fixed vocabulary, organised at
two levels of detail:

|  | fine level | coarse level |
|---|---|---|
| verbs | **106 verb keys** (*press, pour, stir, wash…*) | **13 verb categories** |
| nouns | **303 noun keys** (*cup, kettle, milk…*) | **21 noun categories** |

The 13 verb categories are: *access, block, clean, distribute, leave,
manipulate, merge, monitor, order, retrieve, sense, split, transition*.

The 21 noun categories include: *appliances, crockery, cutlery, dairy and eggs,
drinks, storage, furniture, vegetables, cleaning equipment*, and so on.

**The recipes.** 69 recipes are annotated, each with a list of named steps
written by the annotator — for example, Nespresso (P01_R01) has five: *load
coffee capsule, brew espresso, froth milk, pour foam in coffee, stir*.

---

## Part 1 — The problem the preprocessing solves

A motion graph is a **state-transition network**: circles are states, arrows are
"after this state, the person went to that state", and each arrow carries a
probability.

The obvious approach is to make every annotated action a state. That fails, and
it is worth seeing exactly how, because everything else follows from it.

Take Nespresso (P01_R01): 3 sessions, 373 annotated actions in total.

- If each distinct action is a state, you get **425 states and 1,329 arrows**
  (measured on the four-session Drip Coffee recipe).
- Almost every arrow is seen **once**. On the first version of this pipeline,
  **84% of arrows had been observed exactly one time.**
- A "probability" computed from one observation is not a probability. It is a
  single event written as a fraction.

There is a second, sharper piece of evidence. If the representation were
capturing the recipe, then three recordings of *the same person making the same
coffee* should look similar. Measured as overlap of the state sets, they scored
**0.25** — three-quarters different. That is not variation in cooking. It is the
representation failing to recognise that these are the same procedure.

**The conclusion:** the unit of analysis was too small. A 0.84-second grab is not
a state of a recipe.

---

## Part 2 — The four levels of preprocessing

The pipeline produces four different views of the same recordings. Each is
stored in its own file. **All four describe 100% of the actions** — they differ
only in what counts as a "state".

### Level 1 — `merged_full.json` : every distinct action

A state is one exact annotated action: *take(cup)*.

*take(cup)* and *take(mug)* are two different states, because the nouns differ.

**Result on Drip Coffee (4 sessions):**

| | actions | distinct states | distinct transitions |
|---|---|---|---|
| Session 1 | 455 | 189 | 402 |
| Session 2 | 391 | 154 | 339 |
| Session 3 | 480 | 194 | 410 |
| Session 4 | 417 | 194 | 373 |
| **Merged** | **1,743** | **425** | **1,329** |

Read the merged row against the sessions. Four sessions with about 180 states
each combine into 425 — if they were describing the same procedure, the merged
figure would be close to 190, not more than double it. The breakdown says why:
of the 425 states, only **45 appear in all four sessions**, while **263 appear in
just one**. And 1,329 transitions over 1,743 actions means the average transition
was seen **1.3 times**.

This level is unusable as a picture, but it is kept because it is the unedited
ground truth and every other level is derived from it.

### Level 2 — `merged_hybrid.json` : keep verbs, merge nouns from the same category

A state is the **fine verb** plus the **coarse noun**: *take(crockery)*.

So *take(cup)* and *take(mug)* become the same state, since a cup and a mug are
both crockery. This is the finest level that still has enough repeated
observations to estimate anything.

**Result on Nespresso:** 26 states, 41 arrows.

This is the level labelled *"Every action"* in the dashboard. That label is
slightly generous: nouns have already been grouped into categories. A more
accurate name would be *"Raw actions (verb + object category)"*.

### Level 3 — `merged_episode.json` : episodes

This is the level this project added, and it is the main contribution.

**An episode is one goal-carrying action together with everything nearby that
served it.**

Consider this run of five annotated actions:

```
open(cupboard) → take(cup) → close(cupboard) → put(cup) → press(button)
```

At Level 2 this is five states and four arrows. But a person would describe it
as one thing: *"put a cup under the machine and press the button"*. The four
arrows are internal traffic, not decisions.

The pipeline finds episodes in two passes:

**Pass 1 — find the anchors.** An action is an *anchor* if its verb category is
one of *merge, split, distribute, clean* (verbs that change the food) or
*manipulate* (stir, press, pour) — and if its object is a real object rather than
a carrier such as *hand* or *rubbish*. Everything else — *retrieve, leave,
access, block, transition* — is logistics and can never be an anchor. Recall that
logistics make up 59% of all actions.

**Pass 2 — attach everything else to an anchor.** Every non-anchor action joins
an anchor. Direction is decided by meaning first, and — importantly — the rules
are written over the **13 verb categories**, never over individual verb keys:

| Verb categories | Rule | Reasoning |
|---|---|---|
| *retrieve, access, transition* | attach **forwards** | fetching, opening, walking to something prepares the next goal |
| *leave, block* | attach **backwards** | putting down and closing up finishes the last one |
| *monitor, order, sense* | nearest anchor in time | checking and waiting belong to whatever is happening |

Because the rules sit at the category level, **all 106 verb keys are covered by
construction.** A new or rare verb still falls into one of the 13 categories and
is handled. There is no list of verbs to keep up to date and no "unhandled verb"
case.

Measured across all four recipes (3,136 actions):

| | share |
|---|---|
| anchors (name their episode) | 22% |
| forward rule | 42% |
| backward rule | 32% |
| nearest-in-time fallback | 4% |

**On the risk of wrong attachment.** This is a fair criticism and worth stating
plainly: the rule can attach an action to the wrong anchor. Fetching the next
ingredient *while* the current one cooks is exactly the case that can go either
way. Three things limit the damage:

1. **An action can only reach 12 seconds** to claim its preferred anchor. Past
   that it falls back to whichever anchor is nearest, so a rule cannot pull an
   action across a long gap.
2. **A wrong attachment moves an action between two neighbouring states.** It
   does not delete it, and it does not create a state that never happened — the
   two episodes involved were both real.
3. **It is auditable.** Double-clicking a state opens the exact list of actions
   inside it, with timestamps and video ids. That is why the expansion view
   exists: the grouping is a claim the reader can check, not a black box.

This is an **assignment**, not a filter. Every action ends up inside exactly one
episode, so nothing is deleted and the chain can never break.

Three tidying rules follow. An episode may not swallow more than 8 actions (or a
long run of fetching with no goal action would become one enormous blob).
Adjacent episodes with the same name are merged. And a name that appears in only
one session is generalised to a broader verb category, so the graph is not full
of one-off labels.

**Naming.** Each episode is named after its anchor: `press(appliances)`,
`pour(dairy and eggs)`. Always two parts — a verb and an object category.

**Result on Nespresso:** 12 states. On Drip Coffee: 43. On the Chickpea Curry:
53.

### Level 4 — `merged_step.json` : recipe steps

Exactly the same machinery as Level 3, but the anchors are the **annotator's
recipe steps** instead of goal verbs. Every action is assigned to its nearest
annotated step.

The names come from the recipe itself: *load coffee capsule, brew espresso,
froth milk, pour foam in coffee, stir*.

**Result:** Nespresso 7 states (5 steps + Start + End). Drip Coffee 8. The
Chickpea Curry — a 12-step, 46-minute recipe — drops from 53 states to 12.

### The four levels side by side

| Level | File | A state is | Nespresso | Drip Coffee | Curry |
|---|---|---|---|---|---|
| Every distinct action | `merged_full` | `take(cup)` | — | 425 | — |
| Verb + object category | `merged_hybrid` | `take(crockery)` | 26 | 43 | — |
| Episodes | `merged_episode` | `press(appliances)` | 12 | 43 | 53 |
| Recipe steps | `merged_step` | `brew espresso` | 7 | 8 | 12 |

### The per-session files

For every level there is also one file per session: `session_0_episode.json`,
`session_1_step.json`, and so on.

These contain **that one session's own sequence**, complete and unthinned. This
matters: a single session's path is a *sequence*, so every state in it
necessarily has a neighbour. There is nothing to average and nothing to
threshold, so no filtering is applied to them at all.

### One thing every file carries twice

Each file stores **two** timelines:

- `sequence` — one row per state, used to draw the graph.
- `raw_sequence` — every original annotated action, untouched, used to draw the
  barcode, the swimlane and the timeline table.

The graph asks *what follows what*, so grouping helps. The time views ask *when
did things happen and for how long*, so grouping only hides detail. They must not
share one timeline.

---

## Part 3 — Which states and arrows appear on screen

### States: all of them, always

Every state that occurred is drawn. Nothing is hidden. If a state exists in the
file, it is on the canvas.

### Arrows: a two-stage rule

**Stage 1 — keep arrows that could be measured.**

An arrow survives if **either**:

- it was seen in **at least 2 different sessions**, or
- it happened **at least twice** in total.

Plus every arrow into or out of Start and End, which are anchors rather than
observations.

The reasoning: an arrow seen once is an event, not a tendency. Its "probability"
carries no information. So the threshold is not about tidiness — it is about
which numbers are meaningful.

**Important exception:** if a recipe has only **one** session, no thinning is
applied at all. Support measures *reproducibility*, and with one recording there
is nothing to reproduce. Thinning would simply delete the person's actual
sequence. This is why the Chickpea Curry and the P08 Coffee keep all their
arrows.

**Stage 2 — three repairs, so the graph remains walkable.**

Thinning can break things that must not be broken. Three checks run afterwards,
and each repair restores **an arrow that was genuinely observed** — nothing is
ever invented.

1. **Every state must be reachable from Start.** Without this check, Nespresso
   ended up with Start able to reach only 9 of its 12 states: every arrival at
   *mix(drinks)* came from a different predecessor, so every one of those arrows
   was a single observation and all were removed. A chain you cannot walk is not
   a chain.
2. **End must be reachable from every state.** The mirror of the same problem.
3. **Every session's own path must stay connected.** In Drip Coffee session 4,
   the transitions *boil kettle → grind beans* and *grind beans → fill v60
   filter* happened only in that session, so both were thinned away. Highlighting
   session 4 then left *grind beans* floating — even though she plainly did it.
   Since a session's path is a sequence, an isolated state there is impossible in
   reality, so this is always a drawing artefact and is always repaired.

### Every arrow records why it is in the graph

Each arrow carries a reason, so the picture never depends on the order the
repairs happened to run:

| Reason | Meaning | Drawn in the all-sessions view? |
|---|---|---|
| `reproducible` | passed the support / repeat threshold | yes, solid |
| `anchor` | a Start or End arrow | yes |
| `connectivity` | restored so the merged chain stays walkable | yes, faint and dashed |
| `session_path` | restored so one session's own path stays whole | only with that session |

**Equal evidence gets equal treatment.** An early version had a real flaw here:
`manipulate(drinks)` has two exits, each seen exactly once, in different
sessions. One was restored by the reachability repair and drawn; the other was
restored by the session repair and hidden. Two identical pieces of evidence,
two different fates, decided by nothing but which repair ran first — and the
reader saw a lone arrow labelled `P = 0.50` with no visible sibling.

Now, whenever connectivity forces one exit from a state to be shown, **every
equally-supported exit from that state is shown with it.** The drawn
probabilities out of that state add up again, and the choice is no longer
arbitrary. This keeps the merged picture honest without inflating it:

| Drip Coffee, episode level | arrows |
|---|---|
| all sessions | 63 |
| session 4 selected | 63 + that session's own 17 = 80 |
| stored in the file | 116 |

### Position of the states on the canvas

**Horizontal position = order in the recipe.** Each state has a *median rank* —
where it typically falls in the sequence, from 0 (first) to 1 (last), averaged
across sessions. Earlier states sit further left.

Two deliberate choices here:

- **No time ruler is drawn.** Prof. Lin's point from the May meeting: an axis
  that does not encode a measured variable invites the reader to believe two
  states in the same column happened at the same moment. Horizontal position here
  is *ordinal* (before/after), not *clock time*, so no ruler is shown.
- **No two states share a column.** Ranks are spread so that every state gets its
  own horizontal position, for the same reason.

**Vertical position = whatever keeps the picture readable.** There is no
meaningful vertical variable. States repel each other and settle into rows, with
the number of rows scaling as the square root of the state count (12 states → 3
rows, 43 states → 7 rows), and the spacing widening when there are more arrows
per state.

**Circle size** = how often the state occurs. **Circle colour** = the verb
category (*merge* orange, *retrieve* blue, and so on), or the recipe step, or the
mean duration, depending on the styling menu.

### Opacity, in plain terms

Opacity always means the same thing: **full strength = part of what you selected;
faded = context.**

| Situation | Full strength | Faded |
|---|---|---|
| Nothing selected | arrows seen often | arrows seen rarely |
| One session selected | that session's states and arrows | everything else (≈22%) |
| A pattern selected | states and arrows on the pattern | everything else (≈22%) |

Faded elements were previously drawn at 5–6% opacity, which was effectively
invisible — and a state whose arrows were all faded looked *isolated* when it was
not. The floor is now high enough that context reads as context.

Arrows that were restored by a repair are drawn dashed, so a reader can tell an
ordinary transition from one that survives only because the graph must stay
connected.

---

## Part 3b — How the number on each arrow is calculated

Every arrow carries two numbers, for example **0.50 (n=2)**.

- **n** is the raw count: how many times that exact transition was observed.
- **P** is the conditional probability: of all the times the person left this
  state, what share went along this arrow.

The formula is simply:

```
P(this arrow) = n(this arrow) / n(all arrows leaving this state)
```

The denominator is **every observed exit from that state**, including exits that
are not currently drawn. That last clause is the source of the confusion in your
screenshot, so it is worth going through the two examples.

### Example 1 — `manipulate(drinks)` shows one arrow at P = 0.50

The full record for that state is:

| exit | n | P | drawn in the all-sessions view? |
|---|---|---|---|
| → `manipulate(dairy and eggs)` | 1 | 0.50 | **yes** |
| → `turn(containers)` | 1 | 0.50 | no — session-specific |
| **total observed exits** | **2** | 1.00 | |

The person left this state twice, and went somewhere different each time. Both
arrows are real and both are stored. The second one was only ever taken by one
session, so it appears only when that session is selected. The visible arrow
still correctly reports that it accounts for half the exits.

### Example 2 — `wash(dairy and eggs)` shows one arrow at P = 0.67

| exit | n | P | drawn? |
|---|---|---|---|
| → `manipulate(dairy and eggs)` | 2 | 0.67 | **yes** |
| → `mix(drinks)` | 1 | 0.33 | no — session-specific |
| **total observed exits** | **3** | 1.00 | |

Two of the three exits went one way, one went the other.

### When several arrows leave a state, they are shown together

Since the sibling rule above, a state whose exits have equal evidence shows all
of them or none. So `manipulate(drinks)` now displays both of its arrows, each
at `0.50 (n=1)`, and they sum to 1.00. A visible shortfall now only happens when
the missing arrows have **less** evidence than the visible ones — that is, when
the hidden exits really were rarer.

### Why not renormalise over the drawn arrows only?

It would make each screen tidy — the visible arrows would always sum to 1.00 —
but the same arrow would then show a different number depending on which view you
were looking at, and none of those numbers would be the measured probability.
Renormalising presents a filtering decision as if it were a property of the
person's behaviour.

So the rule is: **P always describes what actually happened, never what is
currently on screen.** Where visible arrows sum to less than 1, the node's
tooltip now says so explicitly, for example:

> *50% of exits go to session-specific transitions, shown only when that session
> is selected*

### The same rule in each view

| View | Denominator |
|---|---|
| All sessions | every exit from that state, pooled across all sessions |
| One session selected | only that session's exits from that state |

So the numbers change when you select a session, and they should: with session 2
selected, `0.50 (n=1)` may become `1.00 (n=1)`, because within that one session
the person always went the same way. The tooltip states which scope it is
reporting.

### Special cases

- **Start** — probabilities out of Start are the share of sessions that began
  with each state. With three sessions beginning three different ways, each shows
  `0.33 (n=1)`.
- **End** — probabilities into End are the share of sessions that finished there.
- **Self-loops** — an immediate repeat counts as an exit from the state to
  itself, so it takes a share of the probability. In practice these are almost
  absent at the episode level: repetition normally shows up as a return arrow
  through another state.
- **Restored arrows** (drawn dashed) carry their real observed count, exactly as
  any other arrow.

---

## Part 4 — The two patterns

The dashboard offers two ways of highlighting a "typical" path. They answer
**different questions** and can disagree. Showing both is deliberate.

### Pattern A — "Common to every session"

**Question:** *what did every session do, in the same order?*

**Method.** Each session is written out as its list of states. The pattern is the
**longest sequence that appears in all of them, in order** — the longest common
subsequence.

Three properties matter:

1. **Order counts.** *A then B* and *B then A* are different.

   **This is a real limitation, and it is a known one in the literature.** Some
   orderings are required by the recipe (you cannot pour the espresso before you
   brew it) and some are free (fetching the plate before or after cooking makes
   no difference). Treating both the same way makes two identical procedures look
   different.

   Three of the papers in this project say so directly:

   - The **Action-Centric Ontology / Temporal Graphs** paper represents recipes
     as a directed acyclic graph with **partial-order** constraints precisely so
     that it "permits multiple valid execution orderings" and "supports multiple,
     equivalently valid execution plans". Their entire argument is that a linear
     script is the wrong representation.
   - **RecipeScape** reports that they *tried* a sequence representation first
     and abandoned it: a sequence of cooking actions compared with string edit
     distance "did not yield meaningful clusters" and was "highly sensitive to
     the length of the sequences", which is what pushed them to a tree structure.
   - The **HD-EPIC** paper itself notes that "the interleaving of different
     preps/steps is evident in the annotations" — the dataset was built knowing
     that steps overlap.

   **How much does it hurt us here?** Less than it might, for two reasons. First,
   the episode grouping already absorbs most free-order variation: fetching a
   plate is not a state, it is part of whichever episode it served. Second, the
   pattern verdict *reports* the damage rather than hiding it — when order
   disagreement is high, the coverage drops and the verdict says "no shared
   pattern" instead of manufacturing one.

   **The honest next step** would be to relax the pattern from a strict sequence
   to a partial order — allow two states to count as matching when neither
   depends on the other. That is exactly the direction the Temporal Graphs paper
   argues for, and it is the clearest extension of this work.
2. **Gaps are allowed.** Two pattern items need not be neighbours. A session may
   do other things in between. This is what lets people vary while still sharing
   a pattern.
3. **Every session, not most.** One session skipping one state removes it. This
   is strict on purpose.

**Worked example — Nespresso, episode level.**

```
Session 1: turn(crockery) → press(appliances) → manipulate(drinks) → … → mix(drinks) → shake(cutlery)
Session 2: turn(crockery) → press(appliances) → manipulate(drinks) → … → mix(drinks)
Session 3: block(appliances) → pour(dairy and eggs) → press(appliances) → … → mix(drinks) → shake(cutlery)
```

Session 3 never does *turn(crockery)* or *manipulate(drinks)*. *shake(cutlery)* is
in sessions 1 and 3 but not 2. What survives all three, in order, is just
**press(appliances) → mix(drinks)** — 2 states.

**Reporting the truth, including "no".** The pattern is only useful if we also
say how much of each session it explains. Four verdicts:

| Verdict | Condition |
|---|---|
| shared pattern | the pattern covers at least 50% of **every** session |
| partial pattern | it covers 20–50% |
| no shared pattern | fewer than 2 states, or under 20% |
| single session | only one recording — agreement cannot be measured |

Nespresso at episode level is a *partial pattern* (2 states, 20–22% of each run).
At step level it is a *shared pattern* (6 steps, 60–86%). That contrast is itself
a finding:

> **The sessions agree on the recipe steps but not on the detailed actions used
> to perform them.**

Drip Coffee at episode level returns *no shared pattern* — 2 states covering 3%.
That is reported as a result, not hidden.

### Why some patterns run Start-to-End and some do not

This was your question about P01 and P08, and the answer is a property of the
method rather than a fault.

The pattern is a **subsequence**, so it need not begin at the beginning.

**Drip Coffee (P03_R03), step level.** The pattern is
`Start → boil kettle → fill v60 filter → bloom grounds → pour over coffee → End`.
All four sessions began with *boil kettle*, so a *Start → boil kettle* arrow
exists and the path is continuous.

**Nespresso (P01_R01), step level.** The pattern begins at *brew espresso*. But
the three sessions began with three **different** steps:

```
Start → load coffee capsule   (session 1)
Start → pour foam in coffee   (session 2)
Start → froth milk            (session 3)
```

No session began with *brew espresso*, so no such arrow exists and Start is not
attached. The dashboard now says so in words:

> *"The sessions did not all begin the same way, so the pattern starts partway
> in."*

**Single-session recipes (P08_R01, P05_R01)** have no pattern at all. Agreement
needs at least two things to agree. The verdict is *single session*, and the
correct reading is: *this is one observed run, not a pattern.*

### Making a gapped pattern drawable

Because gaps are allowed, two consecutive pattern states may never have been
neighbours. To draw a continuous line, the shortest **observed** route between
them is inserted. Those inserted states are marked **connector**, never
**pattern** — glue, not finding. Every arrow on the drawn path was observed;
none is invented.

### Pattern B — "Most likely route"

**Question:** *at each state, what is the usual next move?*

This is the quantity a robot planner consumes. In Prof. Lien's collaboration
paper the robot begins by assigning **equal probability to all remaining
sub-tasks**; this replaces that uniform guess with measured transition
probabilities.

**Method.** It uses **probability, not frequency** — that is, the share of times a
state was followed by each successor, not the raw count. A transition seen twice
out of two is stronger evidence of "usual" than one seen five times out of
twenty.

**How far ahead does it look?** This is your question about *i+1* versus *i+2*,
and it is the crux of the method.

A simple greedy walk looks **one step ahead**: from the current state, take the
best arrow, repeat. We tried that and it fails — after three states it walks into
a corner where every successor has already been used, and the route stops in the
middle of the recipe.

So the search looks at **the whole route**. It considers many partial routes at
once (keeping the best 250 at each depth), extends all of them, and accepts only
routes that reach End. Formally it maximises the product of the probabilities
along the entire path. In effect it looks **all the way to the end**, not one or
two steps.

Two details worth stating:

- **No state may be visited twice.** A route that loops is not "the usual way".
- **Routes are ranked by average per-step probability, not by the product.** The
  product always favours the shortest route, which would nominate
  *Start → End* as the most likely way to make coffee.

**Worked example — Nespresso, episode level.**

```
Start → turn(crockery) → mix(drinks) → shake(cutlery) → End
   0.67           0.33          0.67          1.00
average per-step probability 0.62
```

Compare with Pattern A on the same graph: `press(appliances) → mix(drinks)`. The
two disagree, and neither is wrong — they answer different questions.

**The honesty check.** A route made of locally common choices can be a route
nobody ever performed, because probability multiplies over single arrows, not
over whole runs. So the pipeline checks whether any session performed the route
as a continuous run, and reports the result:

- Nespresso, episodes: *"Session 1 performed exactly this run."*
- Drip Coffee, steps: *"Sessions 2, 3, 4 performed exactly this run."*
- Drip Coffee, episodes: *"No session performed the whole route; the longest part
  anyone did in one go was 2 steps."*

That third sentence is the important one. It makes visible that a plausible route
is not necessarily an observed one.

---

## Part 5 — How the two patterns behave at each level and scope

### At the episode level, all sessions

Both patterns are computed over episode states. Pattern A is usually short here,
because agreeing on 12–53 detailed states is demanding. Pattern B usually runs
the full width of the graph.

### At the step level, all sessions

Both patterns are computed over recipe steps. Pattern A is usually much stronger
— Nespresso goes from 2 states at episode level to 6 at step level — because
people agree on *what* to do more than on *how*.

### At either level, one session selected

The pattern shown is still the **cross-session** pattern; the selection changes
which parts are drawn at full strength. This is deliberate: the interesting
question is "where does this session's run sit relative to the common pattern?"

Two things change with the numbers when a session is selected:

- Arrow labels switch to **that session's own** count and probability,
  renormalised over that session's outgoing arrows. Showing "seen in 2 of 3
  sessions" while looking at one session answers a question the reader did not
  ask.
- The `session only` arrows for that session appear.

### At either level, single-session recipes

Pattern A is unavailable and reports *single session*. Pattern B is available but
means only "this is the run that happened" — with one recording, the most likely
route and the observed route are the same thing.


---

## Summary in one page

- The dataset gives us very short actions (median 0.84 s), most of which are
  logistics rather than cooking.
- Treating each action as a state produces a graph with more parameters than
  data — 84% of its arrows were seen once.
- **Episodes** group each goal-carrying action with the fetching and putting-down
  that served it. Nothing is deleted; the detail moves inside the state and is
  available on double-click.
- **Recipe steps** use the same machinery with the annotator's steps as anchors,
  giving a readable overview for complex recipes.
- Arrows are kept when they are reproducible, then repaired so the graph can be
  walked from Start to End and so no session's own path is broken.
- **Pattern A** answers *what did everyone do* and is allowed to answer "nothing".
  **Pattern B** answers *what is the usual next move* and says openly whether
  anyone actually performed the whole route.
- Opacity means one thing throughout: full strength is what you selected, faded is
  context.