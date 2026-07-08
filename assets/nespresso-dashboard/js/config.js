// config.js
//
// Configuration constants + data URL builders.
//
// Delivery 6 update:
//   - VERB_COLORS replaced by HD-EPIC canonical verb category system.
//     Every verb in HD_EPIC_verb_classes.csv is mapped to one of 13 categories.
//     Each category has one perceptually distinct color. This is now universal
//     across every recipe in the dataset — no per-recipe hand-curation needed.
//   - getLegendItems() updated: "Action category" legend now shows 13 category
//     swatches with the canonical HD-EPIC category names.
//
// Step-label update:
//   - buildStepLabelLookup() / resolveStepLabel(): map a step id ("S01" or
//     "P01_R01_S01") to its short diagnostic label from step_labels.json
//     (carried on payload.steps[].label). Falls back to the raw id so the UI
//     never shows a blank. getLegendItems() now accepts a stepLabelLookup so the
//     phase legend shows readable labels.

const GRAPHS_BASE = "outputs/graphs";

export function getManifestUrl() {
  return `${GRAPHS_BASE}/manifest.json`;
}

export function getSessionDataUrl(recipeId, sessionIndex, mode = "hybrid") {
  return `${GRAPHS_BASE}/${recipeId}/session_${sessionIndex}_${mode}.json`;
}

export function getMergedDataUrl(recipeId, mode = "hybrid") {
  return `${GRAPHS_BASE}/${recipeId}/merged_${mode}.json`;
}

// Legacy alias
export function getDataUrl(mode = "hybrid", recipeId = null, sessionIndex = 0) {
  if (!recipeId) {
    console.warn("getDataUrl called without recipeId; defaulting to P08_R01.");
    return getSessionDataUrl("P08_R01", 0, mode);
  }
  return getSessionDataUrl(recipeId, sessionIndex, mode);
}

export const DEFAULT_DATA_MODE = "hybrid";
export const DEFAULT_COLOR_ENCODE_MODE = "category";

// ─────────────────────────────────────────────────────────────────────────────
// Per-session palette — distinct hues for the active-session indicator and
// for small-multiples row borders.
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_PALETTE = [
  "#2563EB",  // session 1 (idx 0) — blue
  "#16A34A",  // session 2 (idx 1) — green
  "#DC2626",  // session 3 (idx 2) — red
  "#9333EA",  // session 4 (idx 3) — purple
  "#EA580C",  // session 5 (idx 4) — orange
  "#0891B2",  // session 6+ — cyan
];

export function getSessionColor(sessionIndex) {
  return SESSION_PALETTE[sessionIndex % SESSION_PALETTE.length];
}

// ─────────────────────────────────────────────────────────────────────────────
// Support → opacity mapping for the merged motion graph.
// ─────────────────────────────────────────────────────────────────────────────

export function supportToOpacity(support, nSessions) {
  if (!nSessions) return 1;
  const fraction = support / nSessions;
  return 0.35 + 0.65 * fraction;
}

// ─────────────────────────────────────────────────────────────────────────────
// HD-EPIC VERB CATEGORY SYSTEM
//
// Source: HD_EPIC_verb_classes.csv  (column: category)
// 106 verbs across 13 categories.
// Each category gets one color. This replaces the old manual VERB_COLORS map.
//
// Category colors chosen for:
//   - Perceptual discriminability (no two adjacent categories share a hue)
//   - Semantic looseness (colors have rough associations: blue=retrieval,
//     orange=combining, red=breaking, teal=cleaning, etc.)
//   - ColorBrewer / Tableau-derived palette to follow data visualization
//     best practice (Brewer 2003; Munzner 2014 ch. 10)
// ─────────────────────────────────────────────────────────────────────────────

export const CATEGORY_COLORS = {
  retrieve:    "#4E79A7",  // blue     — take, remove, scoop, lift, gather, choose
  leave:       "#8B5CF6",  // purple   — put, insert, throw, hang, drop, let-go, serve
  transition:  "#94A3B8",  // gray     — move, transition, carry
  merge:       "#F97316",  // orange   — pour, mix, fill, add, attach, coat
  split:       "#E15759",  // red      — cut, peel, empty, break, filter, rip, crush, grate, stab, divide
  clean:       "#76B7B2",  // teal     — wash, dry, scrape, scrub, rub, soak, brush
  access:      "#06B6D4",  // cyan     — open, turn-on, unroll, unscrew, uncover, unwrap, switch, unlock
  block:       "#0891B2",  // dark cyan — close, turn-off, wrap, roll, lock
  manipulate:  "#F28E2B",  // amber    — shake, squeeze, press, flip, turn, pull, hold, cook, ... (32 verbs)
  distribute:  "#59A14F",  // green    — apply, sprinkle, spray, season
  monitor:     "#6B7280",  // gray-blue — adjust, check, look, search, turn-down, measure, wait, ...
  order:       "#9C755F",  // brown    — fold, sort
  sense:       "#B07AA1",  // mauve    — pat, eat, feel, drink, smell
};

export const DEFAULT_NODE_COLOR = "#94A3B8";

// ─────────────────────────────────────────────────────────────────────────────
// VERB_TO_CATEGORY
//
// Complete mapping from every HD-EPIC verb key to its canonical category.
// Built directly from HD_EPIC_verb_classes.csv. Used by nodeColor() in
// utils.js to color any action string in any recipe.
// ─────────────────────────────────────────────────────────────────────────────



/**
 * Get the HD-EPIC category for a verb key.
 * Returns the category name, or "unknown" if not found.
 */
export function getVerbCategory(verbKey) {
  return VERB_TO_CATEGORY[verbKey] || "unknown";
}

/**
 * Get the color for a verb key via its HD-EPIC category.
 * Accepts either the raw verb string ("take") or a full action string
 * ("take(cup)") — the verb is extracted automatically.
 */

// ─────────────────────────────────────────────────────────────────────────────
// VERB_TO_CATEGORY & VERB_COLORS (Dynamic Load)
//
// Dynamically populated from HD_EPIC_verb_classes.csv.
// ─────────────────────────────────────────────────────────────────────────────

export const VERB_TO_CATEGORY = {};
export const VERB_COLORS = {}; // Kept for backward compatibility

/**
 * Fetches and parses the HD-EPIC verb classes CSV to dynamically configure 
 * color mappings and categories for the dashboard.
 * * @param {string} csvUrl - Path to your HD_EPIC_verb_classes.csv file
 */
export async function loadVerbCategories(csvUrl = 'narrations-and-action-segments/HD_EPIC_verb_classes.csv') {
  try {
    const response = await fetch(csvUrl);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const text = await response.text();

    let inQuotes = false;
    let currentRow = [];
    let currentCell = '';

    // Robust CSV parsing to handle line breaks inside the 'instances' strings
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        currentRow.push(currentCell);
        currentCell = '';
      } else if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && text[i + 1] === '\n') i++; // Skip carriage return
        currentRow.push(currentCell);
        processRow(currentRow);
        currentRow = [];
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    
    // Catch the final row if no trailing newline
    if (currentRow.length > 0 || currentCell !== '') {
      currentRow.push(currentCell);
      processRow(currentRow);
    }

    function processRow(row) {
      // Ensure row is valid and skip the header
      if (row.length < 4 || row[0].trim() === 'id') return;

      const key = row[1].trim();
      const instancesStr = row[2].trim();
      const category = row[3].trim();

      // 1. Map the primary key (e.g., 'take' -> 'retrieve')
      VERB_TO_CATEGORY[key] = category;
      // Also map the category name to itself, so callers in categorical
      // mode can pass either a verb key OR a category name.
      VERB_TO_CATEGORY[category] = category;

      // 2. Extract and map all synonym instances securely
      // This catches verbs like 'collect-from' inside the array string
      const matches = instancesStr.match(/'([^']+)'/g);
      if (matches) {
        matches.forEach(m => {
          const inst = m.replace(/'/g, ''); // Remove single quotes
          VERB_TO_CATEGORY[inst] = category;
        });
      }

      // 3. Maintain legacy VERB_COLORS compatibility
      VERB_COLORS[key] = CATEGORY_COLORS[category] || DEFAULT_NODE_COLOR;
    }

    console.log(`[Config] Successfully loaded and mapped HD-EPIC verb categories.`);
  } catch (error) {
    console.error("[Config] Failed to load verb classes CSV. Check the path.", error);
  }
}


/**
 * Get the color for a verb key via its HD-EPIC category.
 */
export function getVerbColor(verbOrAction) {
  if (!verbOrAction) return DEFAULT_NODE_COLOR;
  const verb = verbOrAction.includes("(")
    ? verbOrAction.split("(")[0]
    : verbOrAction;
  const category = VERB_TO_CATEGORY[verb];
  return category ? CATEGORY_COLORS[category] : DEFAULT_NODE_COLOR;
}

// ─────────────────────────────────────────────────────────────────────────────
// VERB_COLORS — DEPRECATED
//
// Kept for backward compatibility in case any code references it directly.
// New code should use getVerbColor() or VERB_TO_CATEGORY + CATEGORY_COLORS.
// Rebuilt from the HD-EPIC categories so it stays consistent.
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// Step phase palette (Path B)
// ─────────────────────────────────────────────────────────────────────────────

export const STEP_PHASE_PALETTE = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
];

export const UNASSIGNED_PHASE_COLOR = "#94A3B8";

export function getStepPhaseColor(stepLabel) {
  if (!stepLabel || stepLabel === "unassigned") return UNASSIGNED_PHASE_COLOR;
  const match = stepLabel.match(/^S(\d+)$/);
  if (match) {
    const stepNum = parseInt(match[1], 10);
    return STEP_PHASE_PALETTE[(stepNum - 1) % STEP_PHASE_PALETTE.length];
  }
  return UNASSIGNED_PHASE_COLOR;
}
// Determine the sorted list of step local-ids ("S01", "S02", ...) that actually
// exist for the current recipe. Tries the label lookup first (keys include
// local ids), then the sequence's step_ids. Returns a de-duplicated, sorted
// list so the legend shows exactly the recipe's steps — no phantom S06.
function collectStepLocals(stepLabelLookup, sequence) {
  const set = new Set();

  // 1. from the label lookup keys (e.g. "S01", and full ids "P01_R01_S01")
  if (stepLabelLookup) {
    Object.keys(stepLabelLookup).forEach((k) => {
      const m = String(k).match(/S\d{2}$/);
      if (m) set.add(m[0]);
    });
  }

  // 2. from the sequence's step_ids (covers cases where lookup was empty)
  if (set.size === 0 && Array.isArray(sequence)) {
    sequence.forEach((item) => {
      const sid = item.step_id;
      if (!sid) return;
      const m = String(sid).match(/S\d{2}$/);
      if (m) set.add(m[0]);
    });
  }

  // 3. last-resort fallback so the legend isn't empty before data loads
  if (set.size === 0) {
    for (let i = 1; i <= 5; i++) set.add(`S${String(i).padStart(2, "0")}`);
  }

  return [...set].sort();  // "S01" < "S02" < ... lexical sort works for zero-padded
}
// ─────────────────────────────────────────────────────────────────────────────
// Step label resolver (LLM/human labels from step_labels.json)
//
// Labels ride on each payload's `steps[].label` (and on abstracted nodes'
// `step_label`). These helpers map a step id — full ("P01_R01_S01") or local
// ("S01") — to its short diagnostic label, falling back to the local id if no
// label is present so the UI never shows a blank node.
//
// Build the lookup ONCE when a payload loads:
//     const stepLabelLookup = buildStepLabelLookup(payload.steps);
// then pass it wherever a step id is shown to the user.
// ─────────────────────────────────────────────────────────────────────────────

export function buildStepLabelLookup(steps) {
  const lookup = {};
  (steps || []).forEach((s) => {
    if (!s || !s.id) return;
    const label = s.label || null;
    lookup[s.id] = label;                 // full id  ("P01_R01_S01")
    const local = String(s.id).split("_").pop();
    if (local) lookup[local] = label;     // local id ("S01")
  });
  return lookup;
}

export function resolveStepLabel(stepIdOrLocal, lookup) {
  if (!stepIdOrLocal) return stepIdOrLocal;
  if (lookup) {
    if (lookup[stepIdOrLocal]) return lookup[stepIdOrLocal];
    const local = String(stepIdOrLocal).split("_").pop();
    if (lookup[local]) return lookup[local];
    return local || stepIdOrLocal;        // graceful fallback to the id itself
  }
  // no lookup available → just return the local part of the id
  return String(stepIdOrLocal).split("_").pop() || stepIdOrLocal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compat exports (legacy phase system, kept stable)
// ─────────────────────────────────────────────────────────────────────────────

export const PHASE_COLORS = {
  "task-ops": "#6B7280", "prep-machine": "#F59E0B",
  measure: "#06B6D4", tamp: "#EF4444",
  "extract-coffee": "#b34800", "handle-cup": "#8B5CF6",
  dispense: "#F97316", "clean-machine": "#10B981",
};

export const CATEGORY_CLUSTER_CENTERS = {
  // HD-EPIC category cluster positions for category-group layout
  // (retained but based on original verb groupings — update if needed)
  take: { cx: 0, cy: -280 }, remove: { cx: 0, cy: -280 },
  scoop: { cx: 0, cy: -280 }, lift: { cx: 0, cy: -280 },
  gather: { cx: 0, cy: -280 }, choose: { cx: 0, cy: -280 },
  put: { cx: 198, cy: -198 }, insert: { cx: 198, cy: -198 },
  hang: { cx: 198, cy: -198 }, drop: { cx: 198, cy: -198 },
  serve: { cx: 198, cy: -198 }, throw: { cx: 198, cy: -198 },
  "let-go": { cx: 198, cy: -198 },
  pour: { cx: 280, cy: 0 }, mix: { cx: 280, cy: 0 },
  fill: { cx: 280, cy: 0 }, add: { cx: 280, cy: 0 },
  attach: { cx: 280, cy: 0 }, coat: { cx: 280, cy: 0 },
  press: { cx: 198, cy: 198 }, squeeze: { cx: 198, cy: 198 },
  shake: { cx: 198, cy: 198 }, flip: { cx: 198, cy: 198 },
  turn: { cx: 198, cy: 198 }, pull: { cx: 198, cy: 198 },
  hold: { cx: 198, cy: 198 }, cook: { cx: 198, cy: 198 },
  open: { cx: 0, cy: 280 }, "turn-on": { cx: 0, cy: 280 },
  unscrew: { cx: 0, cy: 280 }, uncover: { cx: 0, cy: 280 },
  unwrap: { cx: 0, cy: 280 }, switch: { cx: 0, cy: 280 },
  close: { cx: -198, cy: 198 }, "turn-off": { cx: -198, cy: 198 },
  wrap: { cx: -198, cy: 198 }, roll: { cx: -198, cy: 198 },
  lock: { cx: -198, cy: 198 },
  wait: { cx: -280, cy: 0 }, check: { cx: -280, cy: 0 },
  search: { cx: -280, cy: 0 }, look: { cx: -280, cy: 0 },
  adjust: { cx: -280, cy: 0 }, measure: { cx: -280, cy: 0 },
  scan: { cx: -280, cy: 0 },
  move: { cx: -198, cy: -198 }, carry: { cx: -198, cy: -198 },
  slide: { cx: -198, cy: -198 }, transition: { cx: -198, cy: -198 },
  wash: { cx: 90, cy: -260 }, dry: { cx: 90, cy: -260 },
  scrape: { cx: 90, cy: -260 }, scrub: { cx: 90, cy: -260 },
  rub: { cx: 90, cy: -260 }, soak: { cx: 90, cy: -260 },
  brush: { cx: 90, cy: -260 },
  cut: { cx: 260, cy: -90 }, peel: { cx: 260, cy: -90 },
  break: { cx: 260, cy: -90 }, crush: { cx: 260, cy: -90 },
  grate: { cx: 260, cy: -90 }, divide: { cx: 260, cy: -90 },
  pat: { cx: -90, cy: 260 }, eat: { cx: -90, cy: 260 },
  feel: { cx: -90, cy: 260 }, drink: { cx: -90, cy: 260 },
  smell: { cx: -90, cy: 260 },
  apply: { cx: -260, cy: 90 }, sprinkle: { cx: -260, cy: 90 },
  spray: { cx: -260, cy: 90 }, season: { cx: -260, cy: 90 },
  fold: { cx: -260, cy: -90 }, sort: { cx: -260, cy: -90 },
};

export const STEP_CLUSTER_CENTERS = (() => {
  const radius = 280;
  const out = {};
  for (let i = 1; i <= 10; i++) {
    const label = `S${String(i).padStart(2, "0")}`;
    const angle = (i - 1) * (2 * Math.PI / 10) - Math.PI / 2;
    out[label] = {
      cx: Math.round(Math.cos(angle) * radius),
      cy: Math.round(Math.sin(angle) * radius),
    };
  }
  out["unassigned"] = { cx: 0, cy: 0 };
  return out;
})();

export const PHASE_CLUSTER_CENTERS = STEP_CLUSTER_CENTERS;
export const ACTION_TO_PHASE = {};

// ─────────────────────────────────────────────────────────────────────────────
// Legend
//
// "Action category" now shows 13 HD-EPIC canonical categories with their
// colors and the verbs they contain. This replaces the old 8 hand-grouped
// legend entries.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Legend (Dynamically Filtered)
//
// `stepLabelLookup` (optional): pass the result of buildStepLabelLookup(steps)
// so the phase legend shows readable labels ("insert capsule") instead of S01.
// ─────────────────────────────────────────────────────────────────────────────

export function getLegendItems(
  colorMode = "category",
  sizeMode = "frequency",
  graphMode = "hybrid",
  sequence = [],          // active sequence (used to filter categories)
  stepLabelLookup = null  // NEW: optional {stepId -> label} for the phase legend
) {
  let nodeColorItems;

  if (colorMode === "phase") {
    const items = [];

    // Determine which steps actually exist for this recipe, rather than
    // hardcoding S01..S06. Prefer the label lookup (built from payload.steps);
    // fall back to scanning the sequence's step_ids; finally fall back to a
    // small default range so the legend is never empty.
    const stepLocals = collectStepLocals(stepLabelLookup, sequence);

    stepLocals.forEach((local) => {
      const resolved = resolveStepLabel(local, stepLabelLookup);
      const label = (resolved && resolved !== local) ? local + " \u2013 " + resolved : local;
      items.push({
        type: "dot",
        color: getStepPhaseColor(local),
        label: label,
      });
    });
    items.push({ type: "dot", color: UNASSIGNED_PHASE_COLOR, label: "outside recipe step" });
    nodeColorItems = items;

  } else if (colorMode === "duration") {
    nodeColorItems = [{ type: "gradient", label: "Node color: mean duration" }];

  } else {
    // "category" mode
    
    // 1. Scan the sequence to see which categories actually exist
    const activeCategories = new Set();
    if (sequence && sequence.length > 0) {
      sequence.forEach(item => {
        const verb = item.action.includes("(") ? item.action.split("(")[0] : item.action;
        const category = VERB_TO_CATEGORY[verb] || "unknown";
        activeCategories.add(category);
      });
    }

    // 2. The master list of all 13 canonical categories
    const allCategoryItems = [
      { type: "dot", category: "retrieve",   color: CATEGORY_COLORS.retrieve,   label: "retrieve — take, remove, scoop" },
      { type: "dot", category: "leave",      color: CATEGORY_COLORS.leave,      label: "leave — put, insert, serve" },
      { type: "dot", category: "manipulate", color: CATEGORY_COLORS.manipulate, label: "manipulate — press, squeeze, shake" },
      { type: "dot", category: "merge",      color: CATEGORY_COLORS.merge,      label: "merge — pour, mix, add, fill" },
      { type: "dot", category: "split",      color: CATEGORY_COLORS.split,      label: "split — cut, peel, break, crush" },
      { type: "dot", category: "access",     color: CATEGORY_COLORS.access,     label: "access — open, turn-on, unscrew" },
      { type: "dot", category: "block",      color: CATEGORY_COLORS.block,      label: "block — close, turn-off, wrap" },
      { type: "dot", category: "clean",      color: CATEGORY_COLORS.clean,      label: "clean — wash, dry, scrub" },
      { type: "dot", category: "distribute", color: CATEGORY_COLORS.distribute, label: "distribute — pour, sprinkle, spray" },
      { type: "dot", category: "monitor",    color: CATEGORY_COLORS.monitor,    label: "monitor — check, wait, measure" },
      { type: "dot", category: "transition", color: CATEGORY_COLORS.transition, label: "transition — move, carry" },
      { type: "dot", category: "sense",      color: CATEGORY_COLORS.sense,      label: "sense — eat, drink, smell, pat" },
      { type: "dot", category: "order",      color: CATEGORY_COLORS.order,      label: "order — fold, sort" },
    ];

    // 3. Filter the master list (fallback to all if no sequence is loaded yet)
    if (sequence && sequence.length > 0) {
      nodeColorItems = allCategoryItems.filter(item => activeCategories.has(item.category));
    } else {
      nodeColorItems = allCategoryItems;
    }
  }

  const nodeSizeLabel =
    sizeMode === "support"
      ? "Node size: session support (merged view)"
      : sizeMode === "frequency"
        ? "Node size: action frequency"
        : sizeMode === "duration" && graphMode === "abstracted"
          ? "Node size: total step duration"
          : "Node size: mean duration";

  return {
    node: [
      ...nodeColorItems,
      { type: "badge",  dashed: false, label: nodeSizeLabel },
      { type: "badge1", label: "Top-left badge: backward connection count" },
      { type: "label",  label: "Inside label: action" },
    ],
    edge: [
      { type: "line",  dashed: false, label: "Solid line: transition" },
      { type: "line",  dashed: true,  label: "Dashed line: transition while video plays" },
    ],
  };
}

// HRI Role Mapping
// Groups the 13 HD-EPIC categories into three collaborative roles
export const HRI_ROLES = {
  // Robot-led: Retrieval, transport
  retrieve: "robot",
  leave: "robot",
  transition: "robot",
  order: "robot",
  
  // Collaborative: State changes, monitoring, sensing
  monitor: "collab",
  access: "collab",
  block: "collab",
  
  // Human-led: Dexterous manipulation, judgment, complex combination
  manipulate: "human",
  merge: "human",
  split: "human",
  distribute: "human",
  sense: "human",
   clean: "human",
};

export const HRI_CENTERS = {
  robot:  { id: "robot", x: -350, y: 0, title: "Robot-led", subtitle: "(Retrieve, Transport)" },
  collab: { id: "collab", x: 0,    y: 0, title: "Collaborative", subtitle: "(Monitor, State Change)" },
  human:  { id: "human", x: 350,  y: 0, title: "Human-led", subtitle: "(Dexterous, Judgment)" }
};