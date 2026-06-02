// config.js
//
// Configuration constants + data URL builders.
//
// Phase 1 change: URL helpers are now parameterized by recipe ID + session
// index instead of hardcoded to P08_R01. The frontend loads a manifest at
// startup that tells it which recipes and sessions are available.

// ─────────────────────────────────────────────────────────────────────────────
// Manifest + per-session URL builders
// ─────────────────────────────────────────────────────────────────────────────

const GRAPHS_BASE = "outputs/graphs";

export function getManifestUrl() {
  return `${GRAPHS_BASE}/manifest.json`;
}

/**
 * Build the URL for one session's JSON file at a given detail level.
 *   mode ∈ { "smart", "full", "abstracted" }
 */
export function getSessionDataUrl(recipeId, sessionIndex, mode = "smart") {
  return `${GRAPHS_BASE}/${recipeId}/session_${sessionIndex}_${mode}.json`;
}

// Legacy alias retained so any leftover callers don't crash. New code should
// use getSessionDataUrl instead.
export function getDataUrl(mode = "smart", recipeId = null, sessionIndex = 0) {
  if (!recipeId) {
    console.warn(
      "getDataUrl called without a recipeId. The hardcoded P08_R01 fallback " +
      "has been removed in Phase 1. Pass a recipe ID explicitly."
    );
    return getSessionDataUrl("P08_R01", 0, mode);
  }
  return getSessionDataUrl(recipeId, sessionIndex, mode);
}

export const DEFAULT_DATA_MODE = "smart";
export const DEFAULT_COLOR_ENCODE_MODE = "category";

// ─────────────────────────────────────────────────────────────────────────────
// VERB_COLORS — category palette (recipe-portable)
// ─────────────────────────────────────────────────────────────────────────────

export const VERB_COLORS = {
  take: "#3B82F6",
  carry: "#3B82F6",
  move: "#3B82F6",
  slide: "#3B82F6",
  put: "#8B5CF6",
  pour: "#F97316",
  scoop: "#F97316",
  mix: "#F97316",
  press: "#EF4444",
  crush: "#EF4444",
  squeeze: "#EF4444",
  open: "#06B6D4",
  close: "#06B6D4",
  "turn-on": "#10B981",
  "turn-off": "#10B981",
  finish: "#10B981",
  wait: "#6B7280",
  check: "#6B7280",
  search: "#6B7280",
  write: "#6B7280",
  adjust: "#6B7280",
  screw: "#F59E0B",
  pat: "#F59E0B",
};

export const DEFAULT_NODE_COLOR = "#94A3B8";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE COLORS — Path B uses recipe steps as phases (S01, S02, ...). We use a
// fixed sequential palette indexed by step ordinal, plus a neutral gray for
// the "unassigned" node (actions outside any annotated step).
//
// d3.schemeTableau10 equivalents are hard-coded so the dashboard doesn't
// re-import d3 at config time.
// ─────────────────────────────────────────────────────────────────────────────

export const STEP_PHASE_PALETTE = [
  "#4E79A7", // S01
  "#F28E2B", // S02
  "#E15759", // S03
  "#76B7B2", // S04
  "#59A14F", // S05
  "#EDC948", // S06
  "#B07AA1", // S07
  "#FF9DA7", // S08
  "#9C755F", // S09
  "#BAB0AC", // S10
];

export const UNASSIGNED_PHASE_COLOR = "#94A3B8";

/**
 * Get the color for a step phase by its display label (e.g. "S01", "S02").
 * Returns the neutral gray for "unassigned".
 */
export function getStepPhaseColor(stepLabel) {
  if (!stepLabel || stepLabel === "unassigned") {
    return UNASSIGNED_PHASE_COLOR;
  }
  const match = stepLabel.match(/^S(\d+)$/);
  if (match) {
    const stepNum = parseInt(match[1], 10);
    return STEP_PHASE_PALETTE[(stepNum - 1) % STEP_PHASE_PALETTE.length];
  }
  return UNASSIGNED_PHASE_COLOR;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE_COLORS — kept for backward compatibility. Old code (before Path B)
// looked up phase names like "tamp", "extract-coffee" here. Path B uses
// getStepPhaseColor() instead. Leaving the map populated so any stale
// references don't crash.
// ─────────────────────────────────────────────────────────────────────────────

export const PHASE_COLORS = {
  "task-ops": "#6B7280",
  "prep-machine": "#F59E0B",
  measure: "#06B6D4",
  tamp: "#EF4444",
  "extract-coffee": "#b34800",
  "handle-cup": "#8B5CF6",
  dispense: "#F97316",
  "clean-machine": "#10B981",
};

// ─────────────────────────────────────────────────────────────────────────────
// Cluster centers for category-grouped layout (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

export const CATEGORY_CLUSTER_CENTERS = {
  take: { cx: 0, cy: -280 },
  carry: { cx: 0, cy: -280 },
  move: { cx: 0, cy: -280 },
  slide: { cx: 0, cy: -280 },
  put: { cx: 198, cy: -198 },
  pour: { cx: 280, cy: 0 },
  scoop: { cx: 280, cy: 0 },
  mix: { cx: 280, cy: 0 },
  press: { cx: 198, cy: 198 },
  crush: { cx: 198, cy: 198 },
  squeeze: { cx: 198, cy: 198 },
  open: { cx: 0, cy: 280 },
  close: { cx: 0, cy: 280 },
  "turn-on": { cx: -198, cy: 198 },
  "turn-off": { cx: -198, cy: 198 },
  finish: { cx: -198, cy: 198 },
  wait: { cx: -280, cy: 0 },
  check: { cx: -280, cy: 0 },
  search: { cx: -280, cy: 0 },
  write: { cx: -280, cy: 0 },
  adjust: { cx: -280, cy: 0 },
  screw: { cx: -198, cy: -198 },
  pat: { cx: -198, cy: -198 },
};

// For Task Phases (abstracted) view in category layout: arrange steps in a
// rough ring by ordinal. Up to 10 positions; falls back to (0,0) for extras.
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

// Legacy export kept for compatibility (graph.js may still reference it).
// Path B doesn't use phase names like "tamp" anymore, so this is mostly dead.
export const PHASE_CLUSTER_CENTERS = STEP_CLUSTER_CENTERS;

// ─────────────────────────────────────────────────────────────────────────────
// ACTION_TO_PHASE — DEPRECATED. Kept for any stale references in graph.js.
// Path B reads `step_id` from the data instead.
// ─────────────────────────────────────────────────────────────────────────────

export const ACTION_TO_PHASE = {};

// ─────────────────────────────────────────────────────────────────────────────
// Legend items
// ─────────────────────────────────────────────────────────────────────────────

export function getLegendItems(colorMode = "category", sizeMode = "frequency", graphMode = "smart") {
  let nodeColorItems;

  if (colorMode === "phase") {
    // Path B: show step palette swatches
    const items = [];
    for (let i = 1; i <= 6; i++) {
      // Show first 6 steps as legend examples — most recipes have ≤6 steps
      const label = `S${String(i).padStart(2, "0")}`;
      items.push({ type: "dot", color: getStepPhaseColor(label), label });
    }
    items.push({ type: "dot", color: UNASSIGNED_PHASE_COLOR, label: "outside recipe step" });
    nodeColorItems = items;
  } else if (colorMode === "duration") {
    nodeColorItems = [{ type: "gradient", label: "Node color: mean duration" }];
  } else {
    // category
    nodeColorItems = [
      { type: "dot", color: "#3B82F6", label: "take / carry / move" },
      { type: "dot", color: "#8B5CF6", label: "put / place" },
      { type: "dot", color: "#F97316", label: "pour / scoop / mix" },
      { type: "dot", color: "#EF4444", label: "press / crush" },
      { type: "dot", color: "#06B6D4", label: "open / close" },
      { type: "dot", color: "#10B981", label: "machine ops" },
      { type: "dot", color: "#F59E0B", label: "screw / pat" },
      { type: "dot", color: "#6B7280", label: "wait / check" },
    ];
  }

  const nodeSizeLabel =
    sizeMode === "frequency" ? "Node size: action frequency"
      : sizeMode === "duration" && graphMode === "abstracted"
        ? "Node size: total step duration"
        : sizeMode === "duration"
          ? "Node size: mean duration"
          : "Node size: action frequency";

  return {
    node: [
      ...nodeColorItems,
      { type: "badge", dashed: false, label: nodeSizeLabel },
      { type: "badge1", label: "Top-left badge: backward connection count" },
      { type: "ring", label: "Top-right ring: self-loop" },
      { type: "label", label: "Inside label: action" },
    ],
    edge: [
      { type: "line", dashed: false, label: "Solid line: transition" },
      { type: "line", dashed: true, label: "Dashed line: transition while video plays" },
      { type: "arrow", label: "Bidirectional arrow: two-way transition" },
    ],
  };
}