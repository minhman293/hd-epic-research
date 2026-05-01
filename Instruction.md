### **What It Represents**
This is the **Nespresso Motion Dashboard (P08_R01)**, an interactive visualization that maps the **temporal sequence of actions** performed during a Nespresso coffee machine operation (recipe). It shows:
- **Nodes** = individual actions taken (e.g., "pour(water)", "press(button)")
- **Directed Edges** = transitions between actions (showing how actions flow into each other)
- The graph is synchronized with video playback, so you see which action is occurring at any moment

---

### **Main Areas of the Dashboard**

#### **1. Left Panel: Motion Graph**
The core visualization showing the flow of actions as a directed graph. Spatially organized to reveal temporal patterns.

#### **2. Right Panel: Video Player + Metadata**
- Plays the actual video synchronized with the graph
- Shows current recipe name, video ID, elapsed time, and current action being performed
- Status bar shows: Idle, Playing, Paused, or Ended

#### **3. Bottom Panel: Timeline Table**
Lists all actions in chronological order with:
- Action number
- Action name
- Start and end times (in seconds)
- Duration

---

### **Control Elements & Interactions**

#### **Detail Level Dropdown** (Top of graph)
Three options to show different levels of abstraction:

1. **Smart-Merged (Clear)** — Default view. Merges redundant edges intelligently to reduce visual clutter while preserving the essential flow structure.

2. **Full Raw (Complete)** — Shows every single recorded transition, no merging. Most detailed but can be visually dense. When video plays, the graph automatically **zooms to highlight the current transition** occurring in the video.

3. **Task Phases (Overview)** — Highest abstraction level. Groups individual actions into higher-level task phases (e.g., "measure," "extract-coffee," "clean-machine"). Provides a bird's-eye view of the overall task structure.

#### **Min. Transition Count Slider**
Filters edges by minimum frequency:
- Value = **1**: Show all transitions (even single occurrences)
- Value = **2–10**: Hide transitions that occur fewer times than the threshold
- **Effect**: Removes rare/anomalous transitions, highlighting the most common action pathways
- Nodes that lose all their edges automatically disappear from the graph

---

### **Node Positioning**

#### **Horizontal Position (Left to Right)**
Represents **temporal occurrence** in the sequence:
- **Left side** = actions that occur early in the task
- **Right side** = actions that occur late in the task
- Specifically: nodes are placed in columns based on the **median time** they occur, divided into 20 columns across the timeline

#### **Vertical Position (Top to Bottom)**
Resolves conflicts within the same time window:
- Actions occurring at similar times are stacked vertically to avoid overlap
- Stacking order is determined by their first occurrence within that temporal cluster
- No inherent meaning—purely for layout clarity

---

### **Node Visual Encoding**

#### **Node Size**
Represents **action frequency**:
- **Larger nodes** = actions that occur more frequently
- **Smaller nodes** = rare actions
- Size is proportional to the square root of the count (so visual area is more balanced)
- Range: 18–36 pixels in radius (minimum/maximum)

#### **Node Color**
Encodes the **primary action verb**. Color scheme:

| Color | Actions |
|-------|---------|
| 🔵 Blue | take, carry, move, slide (locomotion) |
| 🟣 Purple | put, place (positioning) |
| 🟠 Orange | pour, scoop, mix (handling liquids/materials) |
| 🔴 Red | press, crush, squeeze (force application) |
| 🔷 Cyan | open, close (state changes) |
| 🟢 Green | turn-on, turn-off, finish, machine ops |
| 🟡 Yellow | screw, pat (mechanical adjustments) |
| ⚫ Gray | wait, check, search, write, adjust (utility/monitoring) |
| ⚪ Light Gray | START and END nodes (special) |

Colors remain consistent across all detail levels (except Task Phases mode, which uses phase-specific colors).

---

### **Node Annotations**

#### **Badges on Nodes**

1. **Top-Left Badge (Small Circle)**
   - Shows a **count** of backward edges pointing to this node
   - **Meaning**: How many different actions can lead back to this action
   - Example: If "pour(water)" has a badge showing "3", it means 3 different actions can transition back to pouring
   - Useful for identifying cyclic or repeatable sub-tasks

2. **Top-Right Badge (⟳ Glyph)**
   - Indicates a **self-loop** (an action that can repeat itself)
   - Example: "mix(coffee)" might loop back to itself multiple times
   - Shows the count of self-repetitions on hover

3. **Inside Text**
   - **Top line**: Abbreviated action name (e.g., "pour" from "pour(water)")
   - **Bottom line (gray)**: Parameter details in parentheses (e.g., "water", "button")
   - Shrinks when the node is small to maintain readability

---

### **Edge Visual Encoding**

#### **Edge Width**
Represents **transition frequency**:
- **Thicker edges** = transitions that occur more frequently
- **Thinner edges** = rare transitions
- Width is proportional to the square root of count (2–5 pixels typically)

#### **Edge Opacity**
Also represents **frequency**, but inverted for subtle visual layering:
- **More opaque** = frequent transitions (up to 85% opacity)
- **More transparent** = infrequent transitions (down to 15% opacity)
- Helps de-emphasize rare pathways while keeping them visible

#### **Edge Types**

1. **Unidirectional Edges** (arrows at one end)
   - Normal transitions flowing forward in time or backward
   - Arrow points to the **target action**

2. **Bidirectional Edges** (arrows at both ends)
   - Indicates two-way transitions: A→B AND B→A
   - Both directions are equally common enough to be highlighted

3. **Self-Loops** (⟳ symbol above node)
   - Not rendered as edges, but as indicators
   - Shows an action repeating consecutively

#### **Edge Coloring During Hover**
- **Normal**: Gray (`#94a3b8`)
- **On hover**: Turns bright orange (`#ea580c`)
- **Adjacent edges to hovered node**: Show count and percentage in tooltip

---

### **Edge Annotations & Tooltips**

When you **hover over an edge**, a tooltip appears showing:

```
source → target
Count: X (Y% of outgoing)
[Optional detail breakdown]
```

#### **What Each Part Means:**

1. **Count: X**
   - How many times this transition occurs in the video

2. **Y% of outgoing**
   - **Percentage calculation**: `(transition_count / total_outgoing_transitions_from_source) × 100`
   - Example: If "pour(water)" has 10 total outgoing transitions, and 4 go to "mix(coffee)", then that edge shows "4 (40% of outgoing)"
   - Helps you understand: *Of all actions after "pour," how likely is this specific transition?*

3. **Detail Breakdown** (in Smart/Abstracted modes)
   - Shows the underlying **raw action pairs** that were merged
   - Example: `pour(water) -> mix(coffee): 3` means this merged edge represents 3 individual occurrences of that specific transition
   - Helps you trace back from the abstracted graph to what actually happened

---

### **Interactive Behaviors**

#### **Hovering Over a Node**
- **Current node**: Remains at full opacity, highlighted with a glow
- **Connected edges**: Brighten to orange, show increased thickness, and display counts
- **Neighbor nodes**: Remain visible (90% opacity)
- **Other nodes**: Fade to 20% opacity
- **Edges not connected**: Fade to 5% opacity
- **Effect**: Creates a "focus+context" view so you can trace the action's dependencies

#### **Hovering Over an Edge**
- Tooltip appears with source → target, count, and percentage
- In non-full modes, shows breakdown of raw action pairs that compose this edge

#### **Clicking on Timeline Entries**
- Selects the action, which highlights it in the graph

---

### **Video Playback & Animation Behavior**

#### **When Video Plays:**

1. **In Full Raw Mode:**
   - The **graph automatically zooms** to focus on the **current transition** occurring in the video
   - Smooth camera movement centers both the source and target nodes in the viewport
   - Updates continuously as the video plays
   - When paused/stopped, graph zooms back out to full view
   - **Purpose**: Keeps you focused on what's currently happening

2. **In Smart/Task Phases Modes:**
   - The **graph zooms to the current action node**
   - Smooth camera movement to center that node
   - **Purpose**: Simpler focus on what action is active right now

#### **Transition Animation:**
- The graph automatically highlights (`active` class):
  - The **source node** of the transition (bright fill)
  - The **target node** of the transition (bright fill)
  - The **edge itself** (orange arrow)
  - The current action node gets highlighted (e.g., a ring or glow effect)

#### **Synchronization:**
- Video time and graph highlighting are **perfectly synchronized**
- The timeline table also highlights the row of the current action
- Visual feedback on all three panels (graph, video, timeline) keeps you oriented

---

### **Summary Statistics (Top-Right Pill)**
Shows three key numbers:
- **X nodes** — Total number of actions/phases in the current view
- **Y transitions** — Total number of edges (action pairs)
- **Z actions** — Total action occurrences in the video sequence

---

### **Visual Design Principles**

1. **Temporal Flow**: Left-to-right layout mirrors the progression of time
2. **Frequency Encoding**: Size, width, and opacity all represent how often something occurs
3. **Color Semantics**: Action verbs have consistent colors across views, making action types instantly recognizable
4. **Progressive Disclosure**: Three detail levels let you zoom from "what are the main phases?" to "what's every micro-action?"
5. **Interactive Highlighting**: Hovering reveals structural relationships without permanently cluttering the view
6. **Synchronized Multi-View**: Graph, video, and timeline stay in lockstep, giving you multiple perspectives on the same data
