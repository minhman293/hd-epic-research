import { nodeColor } from "./utils.js";
import {
  PHASE_COLORS,
  VERB_COLORS,
  CATEGORY_CLUSTER_CENTERS,
  PHASE_CLUSTER_CENTERS,
  getStepPhaseColor,
  getVerbCategory,
  supportToOpacity,
  HRI_ROLES,
  HRI_CENTERS,
} from "./config.js";

const d3 = window.d3;

// ─────────────────────────────────────────────────────────────────────────────
// HRI role time-budget
//
// Computed from the SEQUENCE by summed DURATION, so the role percentages are
// INVARIANT across detail levels (full / smart / abstracted). The previous
// node-count basis drifted when smart-merge collapsed nodes, and broke entirely
// in abstracted mode (node ids are step labels like "S01", not verbs, so every
// node fell through to the "human" default → ~100% human-led). See research
// notes on counting by time, not node count (cf. Hart & Staveland 1988).
//
// Each sequence item carries the real verb-noun action: directly in `action`
// for full/smart, and in `raw_action` for abstracted (where `action` is "S01").
// ─────────────────────────────────────────────────────────────────────────────
function computeHriDurationBudget(sequence) {
  const roleSeconds = { robot: 0, collab: 0, human: 0 };

  (sequence || []).forEach((item) => {
    // Prefer the real verb-noun action; in abstracted mode item.action is "S01"
    // but item.raw_action carries the underlying "verb(noun)".
    const actionStr = item.raw_action || item.action || "";
    if (!actionStr) return;

    const verb = actionStr.includes("(") ? actionStr.split("(")[0] : actionStr;
    const category = getVerbCategory(verb) || "unknown";
    const role = HRI_ROLES[category] || "human";

    // Guard against missing/NaN durations so one bad item can't poison totals.
    const dur = Number.isFinite(item.duration) ? item.duration : 0;
    roleSeconds[role] = (roleSeconds[role] || 0) + dur;
  });

  const total = roleSeconds.robot + roleSeconds.collab + roleSeconds.human;
  return { roleSeconds, total };
}

// Round a {key: percent} object so the integer percents sum to exactly 100.
// Avoids "44 + 36 + 20" sometimes displaying as 99 or 101 from independent
// rounding. Largest-remainder (Hamilton) method.
function largestRemainderRound(pctObj) {
  const entries = Object.entries(pctObj);
  const floors = entries.map(([k, v]) => [k, Math.floor(v), v - Math.floor(v)]);
  const used = floors.reduce((s, [, f]) => s + f, 0);
  const remaining = Math.max(0, 100 - used);
  floors.sort((a, b) => b[2] - a[2]); // largest fractional parts first
  const out = {};
  floors.forEach(([k, f], i) => { out[k] = f + (i < remaining ? 1 : 0); });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lane assignment
// ─────────────────────────────────────────────────────────────────────────────
function isSecondaryNode(node) {
  if (!node) return false;
  if (node.isSpecial) return false;
  if (node.is_primary === undefined) return false;
  return node.is_primary === false;
}

function makeNodeLookup(filteredNodes) {
  const lookup = {};
  filteredNodes.forEach((n) => { lookup[n.id] = n; });
  return lookup;
}

function computeTemporalLayout(nodes, sequence, { maxRadius = 18 } = {}) {
  const nodeLookup = makeNodeLookup(nodes);

  const onsetMap = {};
  sequence.forEach((item) => {
    if (!onsetMap[item.action]) onsetMap[item.action] = [];
    onsetMap[item.action].push(item.start);
  });

  const totalDuration = sequence[sequence.length - 1]?.end || 1;
  const meanOnset = {};
  nodes.forEach((n) => {
    if (n.id === "START") { meanOnset.START = 0; return; }
    if (n.id === "END") { meanOnset.END = totalDuration; return; }
    const times = onsetMap[n.id] || [0];
    meanOnset[n.id] = times.reduce((sum, v) => sum + v, 0) / times.length;
  });

  const CANVAS_WIDTH = 2200;
  const xScale = d3.scaleLinear().domain([0, totalDuration]).range([0, CANVAS_WIDTH]);

  const BUCKET_PX = 90;
  const yStep = Math.max(72, Math.round(maxRadius * 2.4));

  const primaryBuckets = {};
  const secondaryBuckets = {};
  nodes.forEach((n) => {
    const rawX = xScale(meanOnset[n.id] || 0);
    const bucketKey = Math.round(rawX / BUCKET_PX) * BUCKET_PX;
    const targetBuckets = isSecondaryNode(nodeLookup[n.id]) ? secondaryBuckets : primaryBuckets;
    if (!targetBuckets[bucketKey]) targetBuckets[bucketKey] = [];
    targetBuckets[bucketKey].push(n.id);
  });

  const layout = {};
  Object.entries(primaryBuckets).forEach(([k, ids]) => {
    const sorted = [...ids].sort((a, b) => (meanOnset[a] || 0) - (meanOnset[b] || 0));
    sorted.forEach((id, idx) => {
      layout[id] = { x: Number(k), y: (idx - (sorted.length - 1) / 2) * yStep };
    });
  });

  const primaryYs = Object.values(layout).map((p) => p.y);
  const primaryBottom = primaryYs.length > 0 ? Math.max(...primaryYs) : 0;
  const LANE_GAP = 120;
  const secondaryLaneTop = primaryBottom + LANE_GAP;
  Object.entries(secondaryBuckets).forEach(([k, ids]) => {
    const sorted = [...ids].sort((a, b) => (meanOnset[a] || 0) - (meanOnset[b] || 0));
    sorted.forEach((id, idx) => {
      layout[id] = { x: Number(k), y: secondaryLaneTop + idx * yStep };
    });
  });

  const START_X = layout.START?.x || 0;
  const START_R = 18;
  Object.entries(layout).forEach(([id, pos]) => {
    if (id === "START" || id === "END") return;
    const r = 18;
    const MIN_GAP = START_R + r + 60;
    if (Math.abs(pos.x - START_X) < MIN_GAP) pos.x = START_X + MIN_GAP;
  });

  return { layout, totalDuration, xScale, secondaryLaneTop };
}

function computeCategoryLayout(nodes, sequence, graphMode) {
  const nodeLookup = makeNodeLookup(nodes);

  function getClusterCenter(nodeId) {
    if (nodeId === "START") return { cx: -400, cy: 0 };
    if (nodeId === "END") return { cx: 400, cy: 0 };
    if (graphMode === "abstracted") return PHASE_CLUSTER_CENTERS[nodeId] || { cx: 0, cy: 0 };
    if (graphMode === "smart") return CATEGORY_CLUSTER_CENTERS[nodeId.toLowerCase()] || { cx: 0, cy: 0 };
    const verb = nodeId.split("(")[0].toLowerCase();
    return CATEGORY_CLUSTER_CENTERS[verb] || { cx: 0, cy: 0 };
  }

  const primaryNodes = nodes.filter((n) => !isSecondaryNode(nodeLookup[n.id]));
  const secondaryNodes = nodes.filter((n) => isSecondaryNode(nodeLookup[n.id]));

  const clusters = {};
  primaryNodes.forEach((node) => {
    const center = getClusterCenter(node.id);
    const key = `${center.cx},${center.cy}`;
    if (!clusters[key]) clusters[key] = { center, ids: [], isSecondary: false };
    clusters[key].ids.push(node.id);
  });

  const onsetMap = {};
  sequence.forEach((item) => {
    if (!onsetMap[item.action]) onsetMap[item.action] = [];
    onsetMap[item.action].push(item.start);
  });

  const meanOnset = {};
  nodes.forEach((node) => {
    if (node.id === "START") { meanOnset[node.id] = 0; return; }
    if (node.id === "END") { meanOnset[node.id] = sequence[sequence.length - 1]?.end || 0; return; }
    const times = onsetMap[node.id] || [0];
    meanOnset[node.id] = times.reduce((s, v) => s + v, 0) / times.length;
  });

  const layout = {};
  const INNER_SPACING = 55;
  Object.values(clusters).forEach(({ center, ids }) => {
    const sorted = [...ids].sort((a, b) => (meanOnset[a] || 0) - (meanOnset[b] || 0));
    const count = sorted.length;
    if (count === 1) {
      layout[sorted[0]] = { x: center.cx, y: center.cy };
      return;
    }
    const cols = count <= 4 ? count : Math.ceil(count / 2);
    const rows = Math.ceil(count / cols);
    sorted.forEach((id, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = center.cx + (col - (cols - 1) / 2) * INNER_SPACING;
      const y = center.cy + (row - (rows - 1) / 2) * INNER_SPACING;
      layout[id] = { x, y };
    });
  });

  if (secondaryNodes.length > 0) {
    const primaryYs = Object.values(layout).map((p) => p.y);
    const primaryBottom = primaryYs.length > 0 ? Math.max(...primaryYs) : 280;
    const LANE_GAP = 140;
    const secondaryY = primaryBottom + LANE_GAP;
    const sorted = [...secondaryNodes].sort((a, b) => (meanOnset[a.id] || 0) - (meanOnset[b.id] || 0));
    const SECONDARY_SPACING = 110;
    const totalWidth = (sorted.length - 1) * SECONDARY_SPACING;
    const startX = -totalWidth / 2;
    sorted.forEach((node, idx) => {
      layout[node.id] = { x: startX + idx * SECONDARY_SPACING, y: secondaryY };
    });
    clusters["__secondary__"] = {
      center: { cx: 0, cy: secondaryY },
      ids: sorted.map((n) => n.id),
      isSecondary: true,
    };
  }

  return { layout, clusters };
}

function drawClusterHulls(zoomGroup, clusters, layout, radiusMap, graphMode) {
  zoomGroup.selectAll(".cluster-layer").remove();
  const clusterLayer = zoomGroup.insert("g", ":first-child").attr("class", "cluster-layer");
  Object.values(clusters).forEach(({ center, ids, isSecondary }) => {
    if (ids.length === 0) return;
    const repNode = ids.find((id) => id !== "START" && id !== "END");
    if (!repNode) return;
    const clusterColor = isSecondary
      ? "#94A3B8"
      : graphMode === "abstracted"
        ? (PHASE_COLORS[repNode] || "#94A3B8")
        : (() => {
            const verb = repNode.split("(")[0].toLowerCase();
            return VERB_COLORS[verb] || "#94A3B8";
          })();
    const points = [];
    ids.forEach((id) => {
      const p = layout[id];
      const r = (radiusMap[id] || 18) + 12;
      if (!p) return;
      for (let a = 0; a < 8; a++) {
        const angle = (a / 8) * 2 * Math.PI;
        points.push([p.x + Math.cos(angle) * r, p.y + Math.sin(angle) * r]);
      }
    });
    if (points.length < 3) return;
    const hull = d3.polygonHull(points);
    if (!hull) return;
    clusterLayer.append("path")
      .attr("class", "cluster-hull")
      .attr("d", `M${hull.join("L")}Z`)
      .attr("fill", clusterColor)
      .attr("fill-opacity", isSecondary ? 0.04 : 0.08)
      .attr("stroke", clusterColor)
      .attr("stroke-opacity", isSecondary ? 0.25 : 0.35)
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", isSecondary ? "4 4" : "5 3")
      .attr("stroke-linejoin", "round");
    const labelY = Math.min(...ids.map((id) => (layout[id]?.y || 0))) - (radiusMap[ids[0]] || 18) - 18;
    const labelText = isSecondary
      ? "Secondary actions (outside recipe steps)"
      : graphMode === "abstracted" ? repNode : repNode.split("(")[0];
    clusterLayer.append("text")
      .attr("class", "cluster-label")
      .attr("x", center.cx)
      .attr("y", labelY)
      .attr("text-anchor", "middle")
      .attr("font-size", "11px")
      .attr("font-weight", "500")
      .attr("fill", clusterColor)
      .attr("opacity", 0.8)
      .attr("pointer-events", "none")
      .text(labelText);
  });
}

function drawLanes(zoomGroup, filteredNodes, layout, radiusMap) {
  zoomGroup.selectAll(".lane-layer").remove();
  const nodeLookup = makeNodeLookup(filteredNodes);
  const primaryIds = filteredNodes
    .filter((n) => !n.isSpecial && !isSecondaryNode(nodeLookup[n.id])).map((n) => n.id);
  const secondaryIds = filteredNodes
    .filter((n) => !n.isSpecial && isSecondaryNode(nodeLookup[n.id])).map((n) => n.id);
  if (primaryIds.length === 0 || secondaryIds.length === 0) return;
  const laneLayer = zoomGroup.insert("g", ":first-child").attr("class", "lane-layer");
  function bbox(ids, padding = 28) {
    const xs = ids.flatMap((id) => {
      const p = layout[id] || { x: 0 };
      const r = radiusMap[id] || 18;
      return [p.x - r, p.x + r];
    });
    const ys = ids.flatMap((id) => {
      const p = layout[id] || { y: 0 };
      const r = radiusMap[id] || 18;
      return [p.y - r, p.y + r];
    });
    return {
      x: Math.min(...xs) - padding, y: Math.min(...ys) - padding,
      width: Math.max(...xs) - Math.min(...xs) + padding * 2,
      height: Math.max(...ys) - Math.min(...ys) + padding * 2,
    };
  }
  const primaryBox = bbox(primaryIds);
  const secondaryBox = bbox(secondaryIds);
  const sharedX = Math.min(primaryBox.x, secondaryBox.x);
  const sharedWidth = Math.max(
    primaryBox.x + primaryBox.width, secondaryBox.x + secondaryBox.width
  ) - sharedX;
  laneLayer.append("rect")
    .attr("class", "lane lane-primary")
    .attr("x", sharedX).attr("y", primaryBox.y)
    .attr("width", sharedWidth).attr("height", primaryBox.height)
    .attr("rx", 12)
    .attr("fill", "#f0fdf4").attr("fill-opacity", 0.5)
    .attr("stroke", "#86efac").attr("stroke-width", 1);
  laneLayer.append("text")
    .attr("x", sharedX + 12).attr("y", primaryBox.y + 18)
    .attr("font-size", "11px").attr("font-weight", "500")
    .attr("fill", "#16a34a").attr("opacity", 0.85)
    .attr("pointer-events", "none")
    .text("Recipe actions");
  laneLayer.append("rect")
    .attr("class", "lane lane-secondary")
    .attr("x", sharedX).attr("y", secondaryBox.y)
    .attr("width", sharedWidth).attr("height", secondaryBox.height)
    .attr("rx", 12)
    .attr("fill", "#fafafa").attr("fill-opacity", 0.6)
    .attr("stroke", "#94a3b8").attr("stroke-width", 1).attr("stroke-dasharray", "6 3");
  laneLayer.append("text")
    .attr("x", sharedX + 12).attr("y", secondaryBox.y + 18)
    .attr("font-size", "11px").attr("font-weight", "500")
    .attr("fill", "#64748b").attr("opacity", 0.85)
    .attr("pointer-events", "none")
    .text("Secondary actions (outside recipe steps)");
}

function getStraightPath(link, layout, radiusMap) {
  const source = layout[link.source] || { x: 0, y: 0 };
  const target = layout[link.target] || { x: 0, y: 0 };
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / distance;
  const ny = dy / distance;
  const x1 = source.x + nx * (radiusMap[link.source] || 18);
  const y1 = source.y + ny * (radiusMap[link.source] || 18);
  const x2 = target.x - nx * ((radiusMap[link.target] || 18) + 3);
  const y2 = target.y - ny * ((radiusMap[link.target] || 18) + 3);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 - 10;
  return `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
}

function getArcPath(link, layout, radiusMap) {
  const source = layout[link.source] || { x: 0, y: 0 };
  const target = layout[link.target] || { x: 0, y: 0 };
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / distance;
  const ny = dy / distance;
  const x1 = source.x + nx * (radiusMap[link.source] || 18);
  const y1 = source.y + ny * (radiusMap[link.source] || 18);
  const x2 = target.x - nx * ((radiusMap[link.target] || 18) + 3);
  const y2 = target.y - ny * ((radiusMap[link.target] || 18) + 3);
  const mx = (source.x + target.x) / 2;
  const arcHeight = Math.max(70, Math.abs(source.x - target.x) * 0.55 + Math.abs(source.y - target.y) * 0.2);
  const cy = Math.min(source.y, target.y) - arcHeight;
  return `M${x1},${y1} Q${mx},${cy} ${x2},${y2}`;
}

function getNodeLabel(node, mode) {
  if (node.isSpecial) return node.id;
  if (mode === "abstracted") {
    // Prefer the LLM/human step label (carried on the node as `step_label`);
    // fall back to the step id ("S01") so the node is never blank.
    return node.step_label || node.id;
  }
  const verb = node.id.split("(")[0];
  return verb.length > 7 ? verb.slice(0, 6) + "..." : verb;
}

function getNodeSubtitle(node, mode) {
  if (node.isSpecial || mode === "abstracted") return "";
  const match = node.id.match(/\((.+)\)/);
  return match ? match[1] : "";
}

function makeNodeSizeMap(filteredNodes, nodeDurationStats, sizeMode, nodeRadiusByCount, graphMode) {
  if (sizeMode === "frequency") {
    const result = {};
    filteredNodes.forEach((d) => {
      result[d.id] = d.isSpecial ? 18 : nodeRadiusByCount(d.count);
    });
    return result;
  }

  if (sizeMode === "duration") {
    const getValue = (nodeId) => {
      const stats = nodeDurationStats[nodeId];
      if (!stats) return 0;
      return graphMode === "abstracted" ? stats.total : stats.mean;
    };

    const vals = filteredNodes
      .filter((d) => !d.isSpecial)
      .map((d) => getValue(d.id))
      .filter((v) => isFinite(v) && v > 0);

    const sizeScale = d3.scaleLinear()
      .domain([d3.min(vals) || 0, d3.max(vals) || 1])
      .range([18, 36]);

    const result = {};
    filteredNodes.forEach((d) => {
      result[d.id] = d.isSpecial ? 18 : sizeScale(getValue(d.id));
    });
    return result;
  }

  if (sizeMode === "support") {
    const supports = filteredNodes
      .filter((d) => !d.isSpecial && d.support !== undefined)
      .map((d) => d.support);

    if (supports.length === 0) {
      const fallback = {};
      filteredNodes.forEach((d) => {
        fallback[d.id] = d.isSpecial ? 18 : nodeRadiusByCount(d.count);
      });
      return fallback;
    }

    const maxSupport = Math.max(...supports);
    const minSupport = Math.min(...supports);
    const sizeScale = (maxSupport === minSupport)
      ? () => 28
      : d3.scaleLinear().domain([minSupport, maxSupport]).range([18, 36]);

    const result = {};
    filteredNodes.forEach((d) => {
      if (d.isSpecial) {
        result[d.id] = 18;
        return;
      }
      result[d.id] = d.support !== undefined ? sizeScale(d.support) : 22;
    });
    return result;
  }

  const result = {};
  filteredNodes.forEach((d) => {
    result[d.id] = d.isSpecial ? 18 : nodeRadiusByCount(d.count);
  });
  return result;
}

function makeNodeColorFn(filteredNodes, sequence, colorMode, graphMode) {
  if (colorMode === "category") {
    return (d) => d.isSpecial ? "#d1d5db" : nodeColor(d.id);
  }
  if (colorMode === "phase") {
    // Path B: phase = recipe step. Path C will replace this with semantic phases.
    //
    // For abstracted (Task Phases) graph mode, node.id is already a step label
    // like "S01" / "unassigned" — use the step palette directly.
    if (graphMode === "abstracted") {
      return (d) => d.isSpecial ? "#d1d5db" : getStepPhaseColor(d.id);
    }
    // For smart-merged / full-raw graph modes, the node.id is a verb-noun
    // string. Look at every occurrence of this action in the sequence, find
    // the majority step it belongs to, and color by that step's palette
    // entry. This mirrors the barcode coloring in app.js so the two stay
    // visually consistent.
    const stepVotes = {};
    sequence.forEach((item) => {
      if (!stepVotes[item.action]) stepVotes[item.action] = {};
      const sid = item.step_id;
      if (!sid) return;
      const parts = sid.split("_");
      const last = parts[parts.length - 1];
      const display = last && last.startsWith("S") ? last : sid;
      stepVotes[item.action][display] = (stepVotes[item.action][display] || 0) + 1;
    });
    const actionToStep = {};
    Object.entries(stepVotes).forEach(([action, votes]) => {
      const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
      if (top) actionToStep[action] = top[0];
    });
    return (d) => {
      if (d.isSpecial) return "#d1d5db";
      const step = actionToStep[d.id];
      return step ? getStepPhaseColor(step) : "#94A3B8";
    };
  }
  if (colorMode === "duration") {
    const durationMap = {};
    sequence.forEach(s => {
      if (!durationMap[s.action]) durationMap[s.action] = [];
      durationMap[s.action].push(s.duration);
    });
    const meanDuration = {};
    Object.entries(durationMap).forEach(([a, ds]) => {
      meanDuration[a] = ds.reduce((s, v) => s + v, 0) / ds.length;
    });
    const values = Object.values(meanDuration);
    const colorScale = d3.scaleSequential()
      .domain([d3.min(values), d3.max(values)])
      .interpolator(d3.interpolateYlOrRd);
    return (d) => d.isSpecial ? "#d1d5db" : (colorScale(meanDuration[d.id] || 0));
  }
  return (d) => d.isSpecial ? "#d1d5db" : "#94A3B8";
}

export function createGraphController({
  svgSelector,
  graphWrapSelector,
  zoomInSelector,
  zoomOutSelector,
  zoomResetSelector,
}) {
  const svg = d3.select(svgSelector);
  const graphWrapEl = document.querySelector(graphWrapSelector);
  let bgLayer = null;
  let gLinks = null;

  function drawHRIBackgrounds(show, counts = {}, totalNodes = 1) {
    bgLayer.selectAll("*").remove();
    if (!show) return;

    const zones = Object.entries(HRI_CENTERS).map(([id, zone]) => ({ id, ...zone }));

    bgLayer.selectAll(".hri-zone")
      .data(zones)
      .enter()
      .append("circle")
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y)
      .attr("r", 150)
      .style("fill", "#f8fafc")
      .style("stroke", "#e2e8f0")
      .style("stroke-width", "2px")
      .style("stroke-dasharray", "4 4");

    bgLayer.selectAll(".hri-title")
      .data(zones)
      .enter()
      .append("text")
      .attr("x", (d) => d.x)
      .attr("y", (d) => d.y - 170)
      .attr("text-anchor", "middle")
      .style("font-weight", "bold")
      .style("font-size", "14px")
      .style("fill", "#334155")
      .text((d) => {
        // counts[] now carries integer PERCENTAGES (duration-based) and
        // totalNodes is passed as 100, so this arithmetic yields the percent
        // directly. See computeHriDurationBudget() + largestRemainderRound().
        const count = counts[d.id] || 0;
        const pct = totalNodes > 0 ? Math.round((count / totalNodes) * 100) : 0;
        return `${d.title} — ${pct}%`;
      });

    bgLayer.selectAll(".hri-subtitle")
      .data(zones)
      .enter()
      .append("text")
      .attr("x", (d) => d.x)
      .attr("y", (d) => d.y - 155)
      .attr("text-anchor", "middle")
      .style("font-size", "12px")
      .style("fill", "#64748b")
      .text((d) => d.subtitle);
  }

  let linkSelection = null;
  let nodeSelection = null;
  let selfLoopSelection = null;
  let zoomBehavior = null;
  let fitTransform = null;
  let nodeLayout = null;
  let lastActiveEdge = null;
  let lastActiveNode = null;
  let radiusMapCache = null;
  let enrichedLinksCache = null;
  let edgeWidthScale = null;
  let edgeOpacityScale = null;
  let edgeMetricFn = (d) => d.count || 1;   // updated per render
  let currentMode = "smart";
  let currentSequenceCache = [];
  let nodeDurationStatsCache = null;
  let autoZoomEnabled = true;
  let userPositions = {};
  let selectedNodeId = null;
  let lastGraph = null;
  let lastSequence = null;
  let lastMinCount = 1;
  let lastMode = "smart";
  let lastColorMode = "category";
  let lastSizeMode = "frequency";
  let lastLayoutMode = "temporal";
  let lastOptions = { onNodeClick: null };
  let lastExtras = {};

  function buildGraph(
    graph,
    sequence,
    minCount = 1,
    mode = "smart",
    colorMode = "category",
    sizeMode = "frequency",
    layoutMode = "temporal",
    options = { onNodeClick: null },
    resetPositions = true,
    extras = {}
  ) {
    lastGraph = graph;
    lastSequence = sequence;
    lastMinCount = minCount;
    lastMode = mode;
    lastColorMode = colorMode;
    lastSizeMode = sizeMode;
    lastLayoutMode = layoutMode;
    lastOptions = options;
    lastExtras = extras;

    // NEW: extras for merged-graph rendering
    const showSupportBadges = !!extras.showSupportBadges;
    const externalColorFn = extras.colorFn || null;
    const supportFilter = extras.supportFilter || 1;
    const nSessionsHint = extras.nSessions || 0;

    if (resetPositions) userPositions = {};

    currentMode = mode;
    lastActiveEdge = null;
    lastActiveNode = null;
    selectedNodeId = null;
    currentSequenceCache = sequence || [];
    const width = graphWrapEl.clientWidth || 700;
    const height = graphWrapEl.clientHeight || 540;
    svg.attr("width", width).attr("height", height);
    svg.selectAll("*").remove();
    svg.selectAll(".cycle-badge-group").remove();

    let enrichedNodes = [...graph.nodes];
    let enrichedLinks = [...graph.links];

    // NEW: support filter for merged graph (drop low-support nodes and their edges)
    if (showSupportBadges && supportFilter > 1) {
      enrichedNodes = enrichedNodes.filter(
        (n) => (n.support || nSessionsHint || 1) >= supportFilter
      );
      const keepIds = new Set(enrichedNodes.map((n) => n.id));
      enrichedLinks = enrichedLinks.filter(
        (l) => keepIds.has(l.source) && keepIds.has(l.target)
      );
    }

    // Inject START / END only in single-session mode (not merged)
    if (sequence.length > 0 && !showSupportBadges) {
      const firstAction = sequence[0].action;
      const lastAction = sequence[sequence.length - 1].action;
      enrichedNodes.unshift({ id: "START", count: 1, isSpecial: true, is_primary: true });
      enrichedNodes.push({ id: "END", count: 1, isSpecial: true, is_primary: true });
      enrichedLinks.unshift({
        source: "START", target: firstAction, count: 1, probability: 1.0,
        key: "START-" + firstAction,
      });
      enrichedLinks.push({
        source: lastAction, target: "END", count: 1, probability: 1.0,
        key: lastAction + "-END",
      });
    }

    enrichedLinks = enrichedLinks.filter(l => (l.count || 1) >= minCount);

    const activeNodeIds = new Set();
    enrichedLinks.forEach(l => { activeNodeIds.add(l.source); activeNodeIds.add(l.target); });
    let filteredNodes;
    if (showSupportBadges) {
      // Keep all support-filtered nodes even if some have no edges within minCount
      filteredNodes = enrichedNodes;
    } else {
      filteredNodes = enrichedNodes.filter(n => activeNodeIds.has(n.id));
    }

    function computeNodeDurationStats(nodes, seq) {
      const durationMap = {};
      seq.forEach((item) => {
        if (!durationMap[item.action]) durationMap[item.action] = [];
        durationMap[item.action].push(item.duration);
      });
      const stats = {};
      nodes.forEach((n) => {
        if (n.isSpecial) return;
        const durations = durationMap[n.id] || [];
        if (durations.length === 0) { stats[n.id] = null; return; }
        const total = durations.reduce((sum, value) => sum + value, 0);
        stats[n.id] = {
          mean: total / durations.length,
          total,
          min: Math.min(...durations),
          max: Math.max(...durations),
          n: durations.length,
        };
      });
      return stats;
    }
    nodeDurationStatsCache = computeNodeDurationStats(filteredNodes, sequence);

    const maxCount = d3.max(filteredNodes, (d) => d.count) || 1;
    const nodeRadiusByCount = d3.scaleSqrt()
      .domain([1, Math.max(maxCount, 2)])
      .range([18, 36]);

    enrichedLinksCache = enrichedLinks;

    const defs = svg.append("defs");
    [["arrow", "#94a3b8"], ["arrowActive", "#ea580c"]].forEach(([id, color]) => {
      defs.append("marker").attr("id", id)
        .attr("viewBox", "0 -4 10 8").attr("refX", 9).attr("refY", 0)
        .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
        .append("path").attr("d", "M0,-4L10,0L0,4Z").attr("fill", color);
    });
    defs.append("marker").attr("id", "arrowReverse")
      .attr("viewBox", "0 -4 10 8").attr("refX", 1).attr("refY", 0)
      .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto-start-reverse")
      .append("path").attr("d", "M0,-4L10,0L0,4Z").attr("fill", "#94a3b8");

    const zoomGroup = svg.append("g").attr("id", "zoomGroup");
    bgLayer = zoomGroup.append("g").attr("class", "hri-backgrounds");
    gLinks = zoomGroup.append("g").attr("class", "edges");

    const nodeLabels = new Map();
    filteredNodes.forEach((node) => { nodeLabels.set(node.id, getNodeLabel(node, currentMode)); });

    const radiusMap = makeNodeSizeMap(
      filteredNodes, nodeDurationStatsCache, sizeMode, nodeRadiusByCount, mode
    );
    radiusMapCache = radiusMap;

    const maxRadius = d3.max(Object.values(radiusMap)) || 18;
    let layout = {};
    let clusters = null;
    let totalDuration = sequence[sequence.length - 1]?.end || 1;
    let xScale = null;

    if (layoutMode === "temporal") {
      drawHRIBackgrounds(false);
      const t = computeTemporalLayout(filteredNodes, sequence, { maxRadius });
      layout = t.layout; totalDuration = t.totalDuration; xScale = t.xScale;
    } else {
      // Group nodes by role for LAYOUT positioning.
      const roleNodes = { robot: [], collab: [], human: [] };
      filteredNodes.forEach((n) => {
        if (n.isSpecial) return;
        // In abstracted mode n.id is "S01"; recover a representative verb from
        // the node's raw_actions (most frequent underlying action) so the node
        // lands in the right role cluster. Otherwise read the verb off the id.
        let verb;
        if (mode === "abstracted" && n.raw_actions) {
          const top = Object.entries(n.raw_actions).sort((a, b) => b[1] - a[1])[0];
          const act = top ? top[0] : n.id;
          verb = act.includes("(") ? act.split("(")[0] : act;
        } else {
          verb = n.id.includes("(") ? n.id.split("(")[0] : n.id;
        }
        const category = getVerbCategory(verb) || "unknown";
        const role = HRI_ROLES[category] || "human";
        if (!roleNodes[role]) roleNodes[role] = [];
        roleNodes[role].push(n);
      });

      // Header PERCENTAGES come from DURATION, computed off the sequence —
      // invariant across detail levels (full / smart / abstracted). Convert to
      // integer percents that sum to exactly 100, then pass with total=100 so
      // drawHRIBackgrounds' (count/total*100) arithmetic yields the percent.
      const { roleSeconds, total } = computeHriDurationBudget(sequence);
      const pct = (s) => (total > 0 ? (s / total) * 100 : 0);
      const rawPct = {
        robot: pct(roleSeconds.robot),
        collab: pct(roleSeconds.collab),
        human: pct(roleSeconds.human),
      };
      const roleCounts = largestRemainderRound(rawPct);
      const totalRoleNodes = 100;

      drawHRIBackgrounds(true, roleCounts, totalRoleNodes);

      gLinks.style("display", "none");
      zoomGroup.selectAll(".lane-layer, .time-ruler").style("display", "none");
      const zoneRadius = 150;
      const zonePadding = 16;

      const clampToZone = (x, y, center, nodeRadius) => {
        const dx = x - center.x;
        const dy = y - center.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const maxDist = Math.max(0, zoneRadius - nodeRadius - zonePadding);
        if (dist <= maxDist) return { x, y };
        const scale = maxDist / dist;
        return { x: center.x + dx * scale, y: center.y + dy * scale };
      };

      Object.entries(roleNodes).forEach(([role, nodes]) => {
        if (!nodes || nodes.length === 0) return;

        const center = HRI_CENTERS[role] || { x: 0, y: 0 };
        const simNodes = nodes.map((node, idx) => ({
          id: node.id,
          radius: radiusMap[node.id] || 18,
          x: center.x + Math.cos((idx / Math.max(nodes.length, 1)) * 2 * Math.PI - Math.PI / 2) * 48,
          y: center.y + Math.sin((idx / Math.max(nodes.length, 1)) * 2 * Math.PI - Math.PI / 2) * 48,
        }));

        if (simNodes.length === 1) {
          layout[simNodes[0].id] = { x: center.x, y: center.y };
          return;
        }

        const sim = d3.forceSimulation(simNodes)
          .alpha(1)
          .alphaDecay(0.04)
          .velocityDecay(0.35)
          .force("x", d3.forceX(center.x).strength(0.16))
          .force("y", d3.forceY(center.y).strength(0.16))
          .force("collide", d3.forceCollide().radius((d) => (d.radius || 18) + 12).iterations(3))
          .stop();

        for (let i = 0; i < 180; i += 1) sim.tick();

        simNodes.forEach((node) => {
          const clamped = clampToZone(node.x, node.y, center, node.radius);
          layout[node.id] = clamped;
        });
      });
    }

    Object.entries(userPositions).forEach(([id, pos]) => {
      if (layout[id]) layout[id] = { ...layout[id], ...pos };
    });

    if (layoutMode === "temporal" && xScale) {
      const minNodeY = Math.min(...Object.values(layout).map(p => p.y));
      const rulerY = minNodeY - maxRadius - 28;
      const TICK_INTERVAL = 30;
      const ticks = d3.range(0, totalDuration + TICK_INTERVAL, TICK_INTERVAL);
      const rulerG = zoomGroup.append("g").attr("class", "time-ruler");
      rulerG.append("line")
        .attr("x1", xScale(0)).attr("x2", xScale(totalDuration))
        .attr("y1", rulerY).attr("y2", rulerY)
        .attr("stroke", "#cbd5e1").attr("stroke-width", 1);
      ticks.forEach(t => {
        const x = xScale(t);
        rulerG.append("line")
          .attr("x1", x).attr("x2", x)
          .attr("y1", rulerY - 4).attr("y2", rulerY + 4)
          .attr("stroke", "#94a3b8").attr("stroke-width", 1);
        // For merged graph, label as percent (since sequence is synthetic 0-100 normalized)
        const label = showSupportBadges ? t + "%" : t + "s";
        rulerG.append("text")
          .attr("x", x).attr("y", rulerY - 8)
          .attr("text-anchor", "middle")
          .attr("font-size", "9px").attr("fill", "#6b7280")
          .text(label);
      });
    }

    if (layoutMode === "category" && clusters) {
      drawClusterHulls(zoomGroup, clusters, layout, radiusMap, mode);
    }
    if (layoutMode === "temporal") {
      drawLanes(zoomGroup, filteredNodes, layout, radiusMap);
    }

    // Edge width / opacity scales.
    // In merged-graph mode (showSupportBadges), drive both by support so
    // edges are consistent with the node size encoding. In single-session
    // mode, keep the original count-based scaling.
    if (showSupportBadges) {
      edgeMetricFn = (d) => d.support || 1;
      const supports = enrichedLinks.map(edgeMetricFn);
      const minSup = supports.length > 0 ? Math.min(...supports) : 1;
      const maxSup = supports.length > 0 ? Math.max(...supports) : 1;
      if (minSup === maxSup) {
        edgeWidthScale = () => 2;
        edgeOpacityScale = () => supportToOpacity(minSup, nSessionsHint || 1);
      } else {
        edgeWidthScale = d3.scaleLinear().domain([minSup, maxSup]).range([0.8, 5]);
        edgeOpacityScale = (support) => supportToOpacity(support, nSessionsHint || 1);
      }
    } else {
      edgeMetricFn = (d) => d.count || 1;
      const maxLinkCount = d3.max(enrichedLinks, edgeMetricFn) || 1;
      edgeWidthScale = d3.scaleSqrt().domain([1, Math.max(maxLinkCount, 2)]).range([0.8, 5]);
      edgeOpacityScale = d3.scaleLinear().domain([1, Math.max(maxLinkCount, 2)]).range([0.15, 0.85]);
    }

    const forwardEdges = [];
    const backEdges = [];
    const selfLoops = [];
    enrichedLinks.forEach((link) => {
      if (link.source === link.target) { selfLoops.push(link); return; }
      if (link.source === "START" || link.target === "END") { forwardEdges.push(link); return; }
      const sx = (layout[link.source] || { x: 0 }).x;
      const tx = (layout[link.target] || { x: 0 }).x;
      if (tx >= sx) forwardEdges.push(link); else backEdges.push(link);
    });

    const medianCount = d3.median(forwardEdges, (d) => d.count || 1) || 1;

    const selfLoopSummary = [...d3.group(selfLoops, (d) => d.source)].map(([sid, edges]) => ({
      source: sid, target: sid,
      key: edges[0]?.key || `${sid}|||${sid}`,
      count: d3.sum(edges, (e) => e.count || 1),
      occurrences: edges.flatMap((e) => e.occurrences || []),
    }));

    const backEdgesBySource = d3.group(backEdges, (d) => d.source);
    zoomGroup.append("g").attr("class", "back-indicators")
      .selectAll("g.back-indicator")
      .data([...backEdgesBySource.entries()].filter(([sid]) => sid !== "START" && sid !== "END"))
      .enter().append("g").attr("class", "back-indicator")
      .attr("transform", ([sid]) => {
        const p = layout[sid] || { x: 0, y: 0 };
        return `translate(${p.x}, ${p.y})`;
      })
      .each(function([sid, edges]) {
        const r = radiusMap[sid] || 18;
        const g = d3.select(this);
        g.append("circle").attr("class", "back-indicator-badge")
          .attr("cx", -r * 0.7).attr("cy", -r - 4).attr("r", 7)
          .attr("fill", "#f1f5f9").attr("stroke", "#94a3b8").attr("stroke-width", 1);
        g.append("text")
          .attr("x", -r * 0.7).attr("y", -r - 4)
          .attr("text-anchor", "middle").attr("dy", "0.35em")
          .attr("font-size", "7px").attr("fill", "#64748b")
          .text(edges.length);
        g.append("title").text(`Backward to: ${edges.map((e) => e.target).join(", ")}`);
      });

    const edgeSet = new Set(forwardEdges.map((d) => `${d.source}|||${d.target}`));
    const bidirectionalPairs = new Set();
    const bidirectionalForward = [];
    const unidirectionalForward = [];
    forwardEdges.forEach((d) => {
      const cur = `${d.source}|||${d.target}`;
      const rev = `${d.target}|||${d.source}`;
      if (edgeSet.has(rev) && !bidirectionalPairs.has(cur) && !bidirectionalPairs.has(rev)) {
        bidirectionalPairs.add(cur); bidirectionalPairs.add(rev);
        bidirectionalForward.push({ ...d, pairKey: rev });
      } else if (!bidirectionalPairs.has(cur)) {
        unidirectionalForward.push(d);
      }
    });

    gLinks.append("g").selectAll("path.unidir")
      .data(unidirectionalForward).enter().append("path")
      .attr("class", (d) => `link fwd-edge ${(d.count || 1) > medianCount ? "dominant" : "minor"}`)
      .attr("data-key", (d) => d.key)
      .attr("stroke-width", (d) => edgeWidthScale(edgeMetricFn(d)))
      .attr("stroke-opacity", (d) => {
        if (showSupportBadges) return edgeOpacityScale(edgeMetricFn(d));
        const c = d.count || 1;
        if (c > medianCount) return 0.75;
        if (c === medianCount) return 0.4;
        return 0.15;
      })
      .attr("marker-end", "url(#arrow)")
      .attr("d", (d) => getStraightPath(d, layout, radiusMap))
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip);

    gLinks.append("g").selectAll("path.bidir")
      .data(bidirectionalForward).enter().append("path")
      .attr("class", "link bidir-edge")
      .attr("data-key", (d) => d.key)
      .attr("data-pair-key", (d) => d.pairKey)
      .attr("stroke-width", (d) => edgeWidthScale(edgeMetricFn(d)))
      .attr("stroke-opacity", showSupportBadges ? (d) => edgeOpacityScale(edgeMetricFn(d)) : 0.6)
      .attr("marker-end", "url(#arrow)")
      .attr("marker-start", "url(#arrowReverse)")
      .attr("d", (d) => getStraightPath(d, layout, radiusMap))
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip);

    const nodeGroups = zoomGroup.append("g").selectAll(".node")
      .data(filteredNodes).enter().append("g")
      .attr("class", "node").attr("data-id", (d) => d.id)
      .attr("transform", (d) => {
        const p = layout[d.id] || { x: 0, y: 0 };
        return `translate(${p.x},${p.y})`;
      });

    // NEW: use externalColorFn if provided (comparison view passes its own)
    const colorFn = externalColorFn
      ? (d) => d.isSpecial ? "#d1d5db" : externalColorFn(d.id)
      : makeNodeColorFn(filteredNodes, sequence, colorMode, mode);

    // Selection ring
    nodeGroups.append("circle").attr("class", "selection-ring")
      .attr("r", (d) => (radiusMap[d.id] || 18) + 6)
      .attr("fill", "none").attr("stroke", "#2563EB").attr("stroke-width", 3)
      .attr("opacity", 0).attr("pointer-events", "none");

    // Main fill circle
    nodeGroups.append("circle")
      .attr("r", (d) => radiusMap[d.id] || 18)
      .style("fill", colorFn)
      .style("opacity", (d) => isSecondaryNode(d) ? 0.55 : 1.0);

    // Inside label
    nodeGroups.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => (getNodeSubtitle(d, currentMode) ? "-0.12em" : "0.35em"))
      .attr("font-size", (d) => {
        const label = nodeLabels.get(d.id) || d.id;
        if (d.isSpecial) return "10px";
        if (currentMode === "abstracted") {
          return label.length > 18 ? "7px" : label.length > 10 ? "8px" : "9px";
        }
        return label.length > 10 ? "8px" : "9px";
      })
      .attr("font-weight", "bold")
      .attr("fill", (d) => (d.isSpecial ? "#4b5563" : "white"))
      .attr("pointer-events", "none")
      .attr("textLength", (d) => Math.max(20, (radiusMap[d.id] || 18) * 1.55))
      .attr("lengthAdjust", "spacingAndGlyphs")
      .text((d) => nodeLabels.get(d.id) || d.id);

    // Subtitle
    nodeGroups.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => (radiusMap[d.id] || 18) + 14)
      .attr("font-size", (d) => (currentMode === "abstracted" ? "0px" : "7px"))
      .attr("fill", "#475569")
      .attr("pointer-events", "none")
      .text((d) => getNodeSubtitle(d, currentMode));

    // NOTE (Delivery 4): support badges removed. Node size in merged-graph
    // mode now encodes support (via sizeMode === "support" passed from
    // app.js), making the k/N badge redundant. The information remains
    // available in the hover tooltip.

    // Drag behavior (unchanged)
    const DRAG_THRESHOLD_PX = 4;
    const dragBehavior = d3.drag()
      .on("start", function(event, d) {
        d.__dragMoved = false;
        d.__startScreenX = event.sourceEvent.clientX;
        d.__startScreenY = event.sourceEvent.clientY;
        const t = d3.zoomTransform(svg.node());
        const [px, py] = d3.pointer(event, svg.node());
        const gx = (px - t.x) / t.k;
        const gy = (py - t.y) / t.k;
        d.__offsetX = gx - (layout[d.id]?.x || 0);
        d.__offsetY = gy - (layout[d.id]?.y || 0);
      })
      .on("drag", function(event, d) {
        const dxS = event.sourceEvent.clientX - d.__startScreenX;
        const dyS = event.sourceEvent.clientY - d.__startScreenY;
        const dist = Math.sqrt(dxS * dxS + dyS * dyS);
        if (!d.__dragMoved && dist < DRAG_THRESHOLD_PX) return;
        if (!d.__dragMoved) {
          d.__dragMoved = true;
          d3.select(this).classed("dragging", true);
          this.parentNode.appendChild(this);
        }
        const t = d3.zoomTransform(svg.node());
        const [px, py] = d3.pointer(event, svg.node());
        const gx = (px - t.x) / t.k;
        const gy = (py - t.y) / t.k;
        const nx = gx - d.__offsetX;
        const ny = gy - d.__offsetY;
        if (layout[d.id]) {
          layout[d.id].x = nx; layout[d.id].y = ny;
          userPositions[d.id] = { x: nx, y: ny };
        }
        d3.select(this).attr("transform", `translate(${nx}, ${ny})`);
        svg.selectAll(".link")
          .filter(link => link.source === d.id || link.target === d.id)
          .attr("d", link => {
            const isBack = (layout[link.source]?.x || 0) > (layout[link.target]?.x || 0);
            return isBack ? getArcPath(link, layout, radiusMapCache) : getStraightPath(link, layout, radiusMapCache);
          });
        svg.selectAll(".back-indicator")
          .filter(([sid]) => sid === d.id)
          .attr("transform", `translate(${nx}, ${ny})`);
        svg.selectAll(".self-loop-indicator")
          .filter(sl => sl.source === d.id)
          .attr("transform", `translate(${nx}, ${ny})`);
        if (layoutMode === "category" && clusters) {
          drawClusterHulls(zoomGroup, clusters, layout, radiusMapCache, mode);
        }
      })
      .on("end", function(event, d) {
        d3.select(this).classed("dragging", false);
      });
    nodeGroups.call(dragBehavior);

    // Self loops
    const selfLoopIndicators = zoomGroup
      .append("g").attr("class", "self-loop-indicators")
      .selectAll("g.self-loop-indicator")
      .data(selfLoopSummary.filter((d) => d.source !== "START" && d.source !== "END"))
      .enter().append("g").attr("class", "self-loop-indicator")
      .attr("data-key", (d) => d.key)
      .attr("transform", (d) => {
        const p = layout[d.source] || { x: 0, y: 0 };
        return `translate(${p.x},${p.y})`;
      });
    selfLoopIndicators.append("text")
      .attr("class", "self-loop-indicator-glyph")
      .attr("x", (d) => (radiusMap[d.source] || 18) * 0.7)
      .attr("y", (d) => -(radiusMap[d.source] || 18) - 4)
      .attr("text-anchor", "middle").attr("dy", "0.35em")
      .text("⟳");
    selfLoopIndicators
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip);

    nodeGroups
      .on("mouseover", function(event, d) {
        showNodeTooltip(event, d, currentMode);
        linkSelection.attr("stroke-opacity", 0.05).attr("stroke-width", 0.5);
        linkSelection
          .filter(link => link.source === d.id || link.target === d.id)
          .attr("stroke-opacity", link => edgeOpacityScale(edgeMetricFn(link)))
          .attr("stroke-width", link => edgeWidthScale(edgeMetricFn(link)) * 1.5)
          .attr("stroke", "#ea580c");
        nodeSelection
          .filter(n => n.id !== d.id)
          .style("opacity", function(n) {
            const isNeighbor = enrichedLinksCache.some(
              l => (l.source === d.id && l.target === n.id) ||
                   (l.target === d.id && l.source === n.id)
            );
            return isNeighbor ? 0.9 : 0.2;
          });
      })
      .on("mouseout", function() {
        hideNodeTooltip();
        linkSelection
          .attr("stroke-opacity", d => edgeOpacityScale(edgeMetricFn(d)))
          .attr("stroke-width", d => edgeWidthScale(edgeMetricFn(d)))
          .attr("stroke", null);
        nodeSelection.style("opacity", 1);
        hideEdgeTooltip();
      })
      .on("click", function(event, d) {
        if (d.__dragMoved) { d.__dragMoved = false; return; }
        selectedNodeId = d.id;
        if (options.onNodeClick) options.onNodeClick(d, currentSequenceCache);
      });

    linkSelection = zoomGroup.selectAll(".link");
    nodeSelection = zoomGroup.selectAll(".node");
    selfLoopSelection = zoomGroup.selectAll(".self-loop-indicator");
    nodeLayout = layout;

    const xs = Object.values(layout).map((p) => p.x);
    const ys = Object.values(layout).map((p) => p.y);
    const pad = 50;
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;
    const gw = maxX - minX;
    const gh = maxY - minY;
    const scale = Math.min(width / gw, height / gh) * 0.9;
    const tx = (width - gw * scale) / 2 - minX * scale;
    const ty = (height - gh * scale) / 2 - minY * scale;
    fitTransform = d3.zoomIdentity.translate(tx, ty).scale(scale);

    zoomBehavior = d3.zoom().scaleExtent([0.04, 8])
      .on("zoom", (event) => zoomGroup.attr("transform", event.transform));
    svg.call(zoomBehavior);
    svg.call(zoomBehavior.transform, fitTransform);

    // Wire zoom buttons (gracefully — if selectors point at nothing, skip)
    if (zoomInSelector) {
      const el = document.querySelector(zoomInSelector);
      if (el) el.onclick = () => svg.transition().duration(250).call(zoomBehavior.scaleBy, 1.5);
    }
    if (zoomOutSelector) {
      const el = document.querySelector(zoomOutSelector);
      if (el) el.onclick = () => svg.transition().duration(250).call(zoomBehavior.scaleBy, 1 / 1.5);
    }
    if (zoomResetSelector) {
      const el = document.querySelector(zoomResetSelector);
      if (el) el.onclick = () => svg.transition().duration(400).call(zoomBehavior.transform, fitTransform);
    }
  }

  function showEdgeTooltip(event, d) {
    const totalOutgoing = enrichedLinksCache
      .filter(l => l.source === d.source)
      .reduce((sum, l) => sum + (l.count || 1), 0);
    const pct = ((d.count || 1) / totalOutgoing * 100).toFixed(0);

    const detailMap = new Map();
    if (currentMode !== "full" && Array.isArray(d.occurrences) && currentSequenceCache.length > 0) {
      d.occurrences.forEach((index) => {
        const si = currentSequenceCache[index];
        const ti = currentSequenceCache[index + 1];
        if (!si || !ti) return;
        let rs = "", rt = "";
        if (typeof si.edge_key === "string" && si.edge_key.includes("|||")) {
          const parts = si.edge_key.split("|||");
          rs = (parts[0] || "").trim(); rt = (parts[1] || "").trim();
        }
        if (!rs) rs = si.raw_action || si.action || "";
        if (!rt) rt = si.next_action || ti.raw_action || ti.action || "";
        const k = `${rs} -> ${rt}`;
        detailMap.set(k, (detailMap.get(k) || 0) + 1);
      });
    }
    const detailLines = [...detailMap.entries()].map(([p, c]) => `${p}: ${c}`).join("\n");

    const tooltip = document.getElementById("edgeTooltip");
    let txt = `${d.source} → ${d.target}\nCount: ${d.count} (${pct}% of outgoing)`;
    if (d.support !== undefined && d.n_sessions !== undefined) {
      txt += `\nSupport: ${d.support}/${d.n_sessions}`;
    }
    if (detailLines) txt += `\n${detailLines}`;
    tooltip.textContent = txt;
    tooltip.style.display = "block";
    tooltip.style.left = (event.clientX + 12) + "px";
    tooltip.style.top = (event.clientY - 10) + "px";
  }

  function hideEdgeTooltip() {
    const t = document.getElementById("edgeTooltip");
    if (t) t.style.display = "none";
  }

  function showNodeTooltip(event, d, graphMode) {
    const stats = nodeDurationStatsCache?.[d.id];
    const lines = [`${d.id}`, `Count: ${d.count}`];

    if (d.support !== undefined && d.n_sessions !== undefined) {
      lines.push(`Support: ${d.support}/${d.n_sessions} sessions`);
      if (d.per_session_counts) {
        lines.push(`Per session: [${d.per_session_counts.join(", ")}]`);
      }
    }
    if (d.is_primary === false) lines.push(`Lane: secondary (outside recipe steps)`);
    else if (d.is_primary === true) lines.push(`Lane: primary (recipe action)`);

    if (stats) {
      if (graphMode === "abstracted") {
        lines.push(`Total step duration: ${stats.total.toFixed(2)} s`);
        lines.push(`  (${stats.n} actions, ${stats.min.toFixed(2)}-${stats.max.toFixed(2)} s)`);
      } else if (graphMode === "full") {
        if (stats.n === 1) lines.push(`Duration: ${stats.mean.toFixed(2)} s`);
        else {
          lines.push(`Mean duration: ${stats.mean.toFixed(2)} s`);
          lines.push(`  range: ${stats.min.toFixed(2)}-${stats.max.toFixed(2)} s`);
        }
      } else if (graphMode === "smart") {
        lines.push(`Mean duration (all objects): ${stats.mean.toFixed(2)} s`);
        if (stats.n > 1) lines.push(`  range: ${stats.min.toFixed(2)}-${stats.max.toFixed(2)} s`);
      } else if (graphMode === "categorical") {
        lines.push(`Mean duration (all actions): ${stats.mean.toFixed(2)} s`);
        if (stats.n > 1) lines.push(`  range: ${stats.min.toFixed(2)}-${stats.max.toFixed(2)} s`);
      }
    }

    // Verbs that map to this category (categorical mode)
    if (d.verbs && Object.keys(d.verbs).length > 0) {
      const sortedVerbs = Object.entries(d.verbs).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const verbList = sortedVerbs.map(([v, c]) => `  ${v}: ${c}`).join("\n");
      lines.push(`Verbs:\n${verbList}`);
    }

    // Top objects (sort + cap so long lists don't dominate the tooltip)
    if (d.objects && Object.keys(d.objects).length > 0) {
      const sortedObjects = Object.entries(d.objects).sort((a, b) => b[1] - a[1]).slice(0, 10);
      const objectList = sortedObjects.map(([o, c]) => `  ${o}: ${c}`).join("\n");
      lines.push(`Objects:\n${objectList}`);
    }
    // Show both the readable step label (if present) and the full step text.
    if (d.step_label) lines.push(`Step: ${d.step_label}`);
    if (d.step_text) lines.push(`Step text: ${d.step_text}`);

    const tooltip = document.getElementById("nodeTooltip");
    tooltip.textContent = lines.join("\n");
    tooltip.style.display = "block";
    tooltip.style.left = (event.clientX + 12) + "px";
    tooltip.style.top = (event.clientY - 10) + "px";
  }

  function hideNodeTooltip() {
    const t = document.getElementById("nodeTooltip");
    if (t) t.style.display = "none";
  }

  function zoomToTransition(sourceId, targetId) {
    if (!nodeLayout || !zoomBehavior || !radiusMapCache) return;
    const sp = nodeLayout[sourceId]; const tp = nodeLayout[targetId];
    if (!sp || !tp) return;
    const width = graphWrapEl.clientWidth; const height = graphWrapEl.clientHeight;
    const sr = radiusMapCache[sourceId] || 18;
    const tr = radiusMapCache[targetId] || 18;
    const minX = Math.min(sp.x - sr, tp.x - tr);
    const maxX = Math.max(sp.x + sr, tp.x + tr);
    const minY = Math.min(sp.y - sr, tp.y - tr);
    const maxY = Math.max(sp.y + sr, tp.y + tr);
    const bw = maxX - minX; const bh = maxY - minY;
    const pad = 40;
    const sx = (width - pad * 2) / Math.max(bw, 1);
    const sy = (height - pad * 2) / Math.max(bh, 1);
    const scale = Math.min(sx, sy, 3.5);
    const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
    const tx = width / 2 - cx * scale; const ty = height / 2 - cy * scale;
    svg.transition().duration(550).call(
      zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
  }

  function autoZoomToNode(nodeId) {
    if (!nodeLayout || !zoomBehavior || !radiusMapCache) return;
    const p = nodeLayout[nodeId];
    if (!p) return;
    const width = graphWrapEl.clientWidth; const height = graphWrapEl.clientHeight;
    const r = radiusMapCache[nodeId] || 18;
    const scale = Math.min(3, Math.max(1.6, Math.min(width / (r * 6), height / (r * 6))));
    const tx = width / 2 - p.x * scale; const ty = height / 2 - p.y * scale;
    svg.transition().duration(550).call(
      zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
  }

  function updateActive(item) {
    const activeNode = item ? item.action : null;
    const activeEdge = item ? item.edge_key : null;
    if (currentMode === "full") {
      let zs = null, zt = null;
      if (activeEdge && activeEdge !== lastActiveEdge) {
        lastActiveEdge = activeEdge;
        const parts = activeEdge.split("|||");
        if (parts.length === 2) { zs = parts[0].trim(); zt = parts[1].trim(); }
      } else if (!activeEdge && lastActiveEdge) {
        lastActiveEdge = null;
        if (zoomBehavior && fitTransform) svg.transition().duration(400).call(zoomBehavior.transform, fitTransform);
      }
      if (autoZoomEnabled && zs && zt) zoomToTransition(zs, zt);
    } else if (activeNode !== lastActiveNode) {
      lastActiveNode = activeNode;
      if (autoZoomEnabled && activeNode) autoZoomToNode(activeNode);
      else if (autoZoomEnabled && zoomBehavior && fitTransform) svg.transition().duration(400).call(zoomBehavior.transform, fitTransform);
    }
    if (nodeSelection) nodeSelection.classed("active", (d) => d.id === activeNode);
    if (linkSelection) {
      linkSelection
        .classed("active", (d) => d && (d.key === activeEdge || d.pairKey === activeEdge))
        .attr("marker-end", (d) => (d && (d.key === activeEdge || d.pairKey === activeEdge) ? "url(#arrowActive)" : "url(#arrow)"));
    }
    if (selfLoopSelection) selfLoopSelection.classed("active", (d) => d && d.key === activeEdge);
  }

  function setAutoZoom(enabled) { autoZoomEnabled = enabled; }

  function resetLayout() {
    userPositions = {};
    if (!lastGraph || !lastSequence) return;
    buildGraph(
      lastGraph, lastSequence, lastMinCount, lastMode, lastColorMode,
      lastSizeMode, lastLayoutMode, lastOptions, true, lastExtras
    );
  }

  return { buildGraph, updateActive, setAutoZoom, resetLayout };
}