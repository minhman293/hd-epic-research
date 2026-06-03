// config.js
//
// Configuration constants + data URL builders.
//
// Phase 3 additions:
//   - getMergedDataUrl()  for comparison view
//   - SESSION_PALETTE     consistent colors per session index
//   - supportToOpacity()  visual encoding for merged nodes

const GRAPHS_BASE = "outputs/graphs";

export function getManifestUrl() {
  return `${GRAPHS_BASE}/manifest.json`;
}

export function getSessionDataUrl(recipeId, sessionIndex, mode = "smart") {
  return `${GRAPHS_BASE}/${recipeId}/session_${sessionIndex}_${mode}.json`;
}

export function getMergedDataUrl(recipeId, mode = "smart") {
  return `${GRAPHS_BASE}/${recipeId}/merged_${mode}.json`;
}

// Legacy alias
export function getDataUrl(mode = "smart", recipeId = null, sessionIndex = 0) {
  if (!recipeId) {
    console.warn("getDataUrl called without recipeId; defaulting to P08_R01.");
    return getSessionDataUrl("P08_R01", 0, mode);
  }
  return getSessionDataUrl(recipeId, sessionIndex, mode);
}

export const DEFAULT_DATA_MODE = "smart";
export const DEFAULT_COLOR_ENCODE_MODE = "category";

// ─────────────────────────────────────────────────────────────────────────────
// Per-session palette — distinct hues for the active-session indicator and
// for small-multiples row borders. Order = session index.
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_PALETTE = [
  "#2563EB", // session 1 (idx 0) — blue
  "#16A34A", // session 2 (idx 1) — green
  "#DC2626", // session 3 (idx 2) — red
  "#9333EA", // session 4 (idx 3) — purple
  "#EA580C", // session 5 (idx 4) — orange
  "#0891B2", // session 6+ — cyan
];

export function getSessionColor(sessionIndex) {
  return SESSION_PALETTE[sessionIndex % SESSION_PALETTE.length];
}

// ─────────────────────────────────────────────────────────────────────────────
// Support → opacity mapping for the merged motion graph. Nodes appearing in
// all sessions render at full opacity; nodes in fewer sessions fade.
// Floor at 0.35 so support=1 nodes don't disappear.
// ─────────────────────────────────────────────────────────────────────────────

export function supportToOpacity(support, nSessions) {
  if (!nSessions) return 1;
  const fraction = support / nSessions;
  return 0.35 + 0.65 * fraction;
}

// ─────────────────────────────────────────────────────────────────────────────
// VERB_COLORS
// ─────────────────────────────────────────────────────────────────────────────

export const VERB_COLORS = {
  take: "#3B82F6", carry: "#3B82F6", move: "#3B82F6", slide: "#3B82F6",
  put: "#8B5CF6",
  pour: "#F97316", scoop: "#F97316", mix: "#F97316",
  press: "#EF4444", crush: "#EF4444", squeeze: "#EF4444",
  open: "#06B6D4", close: "#06B6D4",
  "turn-on": "#10B981", "turn-off": "#10B981", finish: "#10B981",
  wait: "#6B7280", check: "#6B7280", search: "#6B7280",
  write: "#6B7280", adjust: "#6B7280",
  screw: "#F59E0B", pat: "#F59E0B",
};

export const DEFAULT_NODE_COLOR = "#94A3B8";

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

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compat exports kept stable from Phase 1
// ─────────────────────────────────────────────────────────────────────────────

export const PHASE_COLORS = {
  "task-ops": "#6B7280", "prep-machine": "#F59E0B",
  measure: "#06B6D4", tamp: "#EF4444",
  "extract-coffee": "#b34800", "handle-cup": "#8B5CF6",
  dispense: "#F97316", "clean-machine": "#10B981",
};

export const CATEGORY_CLUSTER_CENTERS = {
  take: { cx: 0, cy: -280 }, carry: { cx: 0, cy: -280 },
  move: { cx: 0, cy: -280 }, slide: { cx: 0, cy: -280 },
  put: { cx: 198, cy: -198 },
  pour: { cx: 280, cy: 0 }, scoop: { cx: 280, cy: 0 }, mix: { cx: 280, cy: 0 },
  press: { cx: 198, cy: 198 }, crush: { cx: 198, cy: 198 }, squeeze: { cx: 198, cy: 198 },
  open: { cx: 0, cy: 280 }, close: { cx: 0, cy: 280 },
  "turn-on": { cx: -198, cy: 198 }, "turn-off": { cx: -198, cy: 198 }, finish: { cx: -198, cy: 198 },
  wait: { cx: -280, cy: 0 }, check: { cx: -280, cy: 0 }, search: { cx: -280, cy: 0 },
  write: { cx: -280, cy: 0 }, adjust: { cx: -280, cy: 0 },
  screw: { cx: -198, cy: -198 }, pat: { cx: -198, cy: -198 },
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
// ─────────────────────────────────────────────────────────────────────────────

export function getLegendItems(colorMode = "category", sizeMode = "frequency", graphMode = "smart") {
  let nodeColorItems;

  if (colorMode === "phase") {
    const items = [];
    for (let i = 1; i <= 6; i++) {
      const label = `S${String(i).padStart(2, "0")}`;
      items.push({ type: "dot", color: getStepPhaseColor(label), label });
    }
    items.push({ type: "dot", color: UNASSIGNED_PHASE_COLOR, label: "outside recipe step" });
    nodeColorItems = items;
  } else if (colorMode === "duration") {
    nodeColorItems = [{ type: "gradient", label: "Node color: mean duration" }];
  } else {
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