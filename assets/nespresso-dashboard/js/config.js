export const DATA_URL = "outputs/graphs/dashboard_P08_R01.json";

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

export const LEGEND_ITEMS = [
  { type: "dot", color: "#3B82F6", label: "Take / carry / move" },
  { type: "dot", color: "#8B5CF6", label: "Put / place" },
  { type: "dot", color: "#F97316", label: "Pour / scoop / mix" },
  { type: "dot", color: "#EF4444", label: "Press / crush" },
  { type: "dot", color: "#06B6D4", label: "Open / close" },
  { type: "dot", color: "#10B981", label: "Machine ops" },
  { type: "dot", color: "#F59E0B", label: "Screw / pat" },
  { type: "dot", color: "#6B7280", label: "Wait / check" },
  { type: "line", dashed: false, label: "Forward edge" },
  { type: "line", dashed: true, label: "Back edge (cycle)" },
];
