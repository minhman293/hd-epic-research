export function getDataUrl(mode = "smart") {
  const urls = {
    smart: "outputs/graphs/dashboard_P08_R01_smart.json",
    full: "outputs/graphs/dashboard_P08_R01.json",
    abstracted: "outputs/graphs/dashboard_P08_R01_abstracted.json",
  };
  return urls[mode] || urls.smart;
}

export const DEFAULT_DATA_MODE = "smart";

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

// Phase colors for abstracted graph
export const PHASE_COLORS = {
  "task-ops": "#6B7280",
  "prep-machine": "#F59E0B",
  measure: "#06B6D4",
  tamp: "#EF4444",
  "extract-coffee": "#b34800",
  "handle-cup": "#8B5CF6",
  dispense: "#F97316",
  "clean-machine": "#10B981"
};

// Mapping from raw actions to abstract task phases
export const ACTION_TO_PHASE = {
  "move(scale)": "measure",
  "turn-on(scale)": "measure",
  "adjust(scale)": "measure",
  "take(can)": "extract-coffee",
  "open(can)": "extract-coffee",
  "close(can)": "extract-coffee",
  "put(can)": "extract-coffee",
  "pour(coffee)": "dispense",
  "take(maker:coffee)": "prep-machine",
  "open(cap)": "prep-machine",
  "take(spoon)": "prep-machine",
  "scoop(coffee)": "prep-machine",
  "put(coffee)": "prep-machine",
  "search(rack:drying)": "prep-machine",
  "pat(maker:coffee)": "tamp",
  "mix(coffee)": "tamp",
  "crush(coffee)": "tamp",
  "press(coffee)": "tamp",
  "put(presser)": "tamp",
  "take(cup)": "handle-cup",
  "put(cup)": "handle-cup",
  "screw(cup)": "handle-cup",
  "squeeze(cup)": "handle-cup",
  "carry(cup)": "handle-cup",
  "turn-on(machine:washing)": "clean-machine",
  "wait(machine:washing)": "clean-machine",
  "finish(machine:washing)": "clean-machine",
  "turn-off(machine:washing)": "clean-machine",
  "check(coffee)": "clean-machine",
  "open(drawer)": "clean-machine",
  "take(plate)": "clean-machine",
  "slide(phone)": "task-ops",
  "open(phone)": "task-ops",
  "write(coffee)": "task-ops",
  "carry(phone)": "task-ops",
  "move(phone)": "task-ops",
};

export const DEFAULT_COLOR_ENCODE_MODE = "category";

export function getLegendItems(colorMode = "category", sizeMode = "frequency") {
  const nodeColorItems = colorMode === "phase"
    ? [
      { type: "dot", color: PHASE_COLORS.measure, label: "measure" },
      { type: "dot", color: PHASE_COLORS["extract-coffee"], label: "extract-coffee" },
      { type: "dot", color: PHASE_COLORS["prep-machine"], label: "prep-machine" },
      { type: "dot", color: PHASE_COLORS.tamp, label: "tamp" },
      { type: "dot", color: PHASE_COLORS["handle-cup"], label: "handle-cup" },
      { type: "dot", color: PHASE_COLORS.dispense, label: "dispense" },
      { type: "dot", color: PHASE_COLORS["clean-machine"], label: "clean-machine" },
      { type: "dot", color: PHASE_COLORS["task-ops"], label: "task-ops" },
    ]
    : colorMode === "duration"
      ? [{ type: "gradient", label: "Node color: mean duration" }]
      : [
        { type: "dot", color: "#3B82F6", label: "take / carry / move" },
        { type: "dot", color: "#8B5CF6", label: "put / place" },
        { type: "dot", color: "#F97316", label: "pour / scoop / mix" },
        { type: "dot", color: "#EF4444", label: "press / crush" },
        { type: "dot", color: "#06B6D4", label: "open / close" },
        { type: "dot", color: "#10B981", label: "machine ops" },
        { type: "dot", color: "#F59E0B", label: "screw / pat" },
        { type: "dot", color: "#6B7280", label: "wait / check" },
      ];

  const nodeSizeLabel = sizeMode === "duration"
    ? "Node size: mean duration"
    : sizeMode === "variance"
      ? "Node size: duration variance"
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
