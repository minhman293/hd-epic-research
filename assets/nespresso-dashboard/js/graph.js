import { formatProbability, formatBridge, evidenceStyle, MACRO_ROLE_COLORS }
  from "./config.js";
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
  SESSION_PALETTE,
  RANK_LAYOUT_MODES,
  PRETHINNED_MODES,
} from "./config.js";

const d3 = window.d3;

// d3.forceLink rewrites link.source/target from an id string to the node
// object, but only for the links it simulates. Anything comparing endpoints
// has to cope with both forms.
const endId = (v) => (v && typeof v === "object") ? v.id : v;

// Which session's numbers the edge labels and tooltips should report.
// null = the merged graph.
let activeSessionForStats = null;
let currentProbLabel = null;

// ─────────────────────────────────────────────────────────────────────────────
// HRI role time-budget
// ─────────────────────────────────────────────────────────────────────────────
function computeHriDurationBudget(sequence) {
  const roleSeconds = { robot: 0, collab: 0, human: 0 };

  (sequence || []).forEach((item) => {
    const actionStr = item.raw_action || item.action || "";
    if (!actionStr) return;

    const verb = actionStr.includes("(") ? actionStr.split("(")[0] : actionStr;
    const category = getVerbCategory(verb) || "unknown";
    const role = HRI_ROLES[category] || "human";

    const dur = Number.isFinite(item.duration) ? item.duration : 0;
    roleSeconds[role] = (roleSeconds[role] || 0) + dur;
  });

  const total = roleSeconds.robot + roleSeconds.collab + roleSeconds.human;
  return { roleSeconds, total };
}

function largestRemainderRound(pctObj) {
  const entries = Object.entries(pctObj);
  const floors = entries.map(([k, v]) => [k, Math.floor(v), v - Math.floor(v)]);
  const used = floors.reduce((s, [, f]) => s + f, 0);
  const remaining = Math.max(0, 100 - used);
  floors.sort((a, b) => b[2] - a[2]); 
  const out = {};
  floors.forEach(([k, f], i) => { out[k] = f + (i < remaining ? 1 : 0); });
  return out;
}

const SPECIAL_ID_RE = /^(START|END)(::|$)/;
 
function isSpecialId(id) {
  return typeof id === "string" && SPECIAL_ID_RE.test(id);
}
 
function isStartId(id) {
  return typeof id === "string" && (id === "START" || id.startsWith("Start:"));
}

function isEndId(id) {
  return typeof id === "string" && (id === "END" || id.startsWith("End:"));
}

function specialLabel(id) {
  if (isStartId(id)) return "START";
  if (isEndId(id))   return "END";
  return id;
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
    if (isStartId(n.id)) { meanOnset[n.id] = 0; return; }
    if (isEndId(n.id))   { meanOnset[n.id] = totalDuration; return; }
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
    if (isStartId(id) || isEndId(id)) return;
    const r = 18;
    const MIN_GAP = START_R + r + 60;
    if (Math.abs(pos.x - START_X) < MIN_GAP) pos.x = START_X + MIN_GAP;
  });

  return { layout, totalDuration, xScale, secondaryLaneTop };
}

// First occurrence wins: a node revisited later in the path still has one
// circle, and placing it at its first position makes the revisit visible as a
// backward edge instead of dragging the node into the middle.
function buildSpineOrder(pathIds) {
  const m = new Map();
  pathIds.forEach((id, i) => { if (!m.has(id)) m.set(id, i); });
  return m;
}

function computeRankLayout(nodes, sequence,
    { maxRadius = 18, links = [], radiusMap = {}, spineOrder = null } = {}) {
  const positions = {};
  const L = Math.max(sequence.length - 1, 1);
  sequence.forEach((item, i) => {
    const r = (typeof item.normalized_rank === "number") ? item.normalized_rank : i / L;
    (positions[item.action] = positions[item.action] || []).push(r);
  });
  const medianRank = {};
  Object.entries(positions).forEach(([id, arr]) => {
    arr.sort((a, b) => a - b);
    medianRank[id] = arr[Math.floor(arr.length / 2)];
  });

  // Prefer node.median_rank from the pipeline wherever it exists.
  //
  // The ranking derived above comes from `sequence`, which is the FULL action
  // list including secondary actions that were excluded from the graph. Using
  // it positions nodes by occurrences that aren't in the graph at all, and it
  // disagrees with node.median_rank — the primary-only figure that decides
  // is_return. That disagreement is visible: an edge can point rightward and
  // still be a return, or point leftward and be forward, because position and
  // direction were answering to two different populations.
  //
  // One rank, one population, used for both.
  nodes.forEach((n) => {
    if (typeof n.median_rank === "number") medianRank[n.id] = n.median_rank;
  });

  nodes.forEach((n) => {
    if (isStartId(n.id)) medianRank[n.id] = 0;
    if (isEndId(n.id))   medianRank[n.id] = 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SPINE ORDER OVERRIDES MEDIAN RANK
  //
  // A node that appears both early and late gets a median rank in the middle,
  // which is why the highlighted path zig-zagged across the canvas instead of
  // reading left to right. On the spine we know the exact position the path
  // visits, so that position is used directly.
  //
  // A node can occur twice in the spine (P01_R01 visits open(containers) and
  // close(appliances) twice each). Only ONE circle exists for it, so it is
  // placed at its FIRST spine position and the path doubles back to it — a
  // visible return, which is honest: the person really did go back.
  // ───────────────────────────────────────────────────────────────────────────
  if (spineOrder && spineOrder.size > 0) {
    const maxIdx = Math.max(...spineOrder.values());
    spineOrder.forEach((idx, id) => {
      if (medianRank[id] === undefined && !nodes.some((n) => n.id === id)) return;
      medianRank[id] = maxIdx > 0 ? idx / maxIdx : 0.5;
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Force layout with rank as a BIAS, not a pin.
  //
  // The previous version set x = (orderIndex + 1) * SPACING, which made width
  // grow linearly with node count (~8700px at 102 nodes) while every node sat
  // in one thin horizontal band. Rank decided position outright, so no amount
  // of vertical space could be used and connectivity had no influence at all.
  //
  // Now: rank supplies a weak x target, edges supply springs, and nodes repel.
  // Tightly-connected nodes settle near each other, reading order survives as
  // a tendency, and the canvas is filled in both dimensions.
  // ───────────────────────────────────────────────────────────────────────────
  const idSet = new Set(nodes.map((n) => n.id));
  const rOf = (id) => radiusMap[id] || maxRadius || 18;

  const meanR = d3.mean(nodes, (n) => rOf(n.id)) || maxRadius || 18;
  const nN = Math.max(nodes.length, 1);
  const nE = (links || []).filter((l) => l.source !== l.target).length;
  const density = nE / nN;
  const roomy = 1 + Math.min(Math.max(density - 1, 0), 2) * 0.45;

  // Scale-free constants. Every distance is in units of node radius, so the
  // layout behaves the same whether a node is 18px or 60px, and whether the
  // graph has 7 nodes or 120.
  // A node is no longer just a circle. Since every level writes its label
  // BELOW the circle, the thing that must not overlap is roughly
  //   circle radius + two lines of 11px text + an italic subtitle.
  // Colliding on the bare radius is why circles kept landing on their
  // neighbour's caption. ~30px covers the tallest label block we draw.
  const LABEL_BLOCK = 30;

  const TARGET_ROWS = Math.max(2, Math.round(Math.sqrt(nN * 0.75)));
  const SPREAD_Y = TARGET_ROWS * (meanR * 2.4 + LABEL_BLOCK) * roomy;
  const SPREAD_X = Math.max(560, SPREAD_Y * 1.4);
  const LINK_DIST = meanR * (2.2 + Math.min(density, 4) * 0.35) + LABEL_BLOCK;
  const COLLIDE = (d) => d.r + meanR * 0.55 + LABEL_BLOCK * 0.55;

  if (nN <= 2) {
    const layout = {}
    nodes.forEach((n) => {
      const rank = Number.isFinite(medianRank[n.id]) ? medianRank[n.id] : 0.5;
      layout[n.id] = { x: (rank - 0.5) * SPREAD_X, y: 0 };
    });
    return { layout, secondaryLaneTop: null };
  }

  const simNodes = nodes.map((n) => {
    const rank = Number.isFinite(medianRank[n.id]) ? medianRank[n.id] : 0.5;
    const seedY = (Math.random() - 0.5) * SPREAD_Y;
    return {
      id: n.id,
      x: (rank - 0.5) * SPREAD_X,
      y: seedY,
      seedY,
      targetX: (rank - 0.5) * SPREAD_X,
      r: rOf(n.id),
      isSpecial: !!n.isSpecial,
      onPath: !!(spineOrder && spineOrder.has(n.id)),
      bg: !!n.__bg,
    };
  });

  const simLinks = (links || [])
    .filter((l) => l.source !== l.target && !l.__minor
                && idSet.has(l.source) && idSet.has(l.target))
    .map((l) => ({
      source: l.source,
      target: l.target,
      p: typeof l.probability === "number" ? l.probability : 0.5,
    }));
  const deg = {};
  simNodes.forEach((node) => { deg[node.id] = 0; });
  simLinks.forEach((l) => {
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const t = typeof l.target === "object" ? l.target.id : l.target;
    deg[s] = (deg[s] || 0) + 1;
    deg[t] = (deg[t] || 0) + 1;
  });
  const countOf = (id) => Math.max(deg[id] || 1, 1);

  const sim = d3.forceSimulation(simNodes)
    .force("link", d3.forceLink(simLinks).id((d) => d.id)
      .distance(LINK_DIST)
      .strength((l) => 0.15 / Math.min(
        countOf(l.source.id ?? l.source),
        countOf(l.target.id ?? l.target))))
    .force("charge", d3.forceManyBody().strength(-12 * meanR * Math.sqrt(24 / Math.max(nN, 4))).distanceMax(meanR * 14))
    .force("x", d3.forceX((d) => d.targetX)
      .strength((d) => d.isSpecial ? 1.0 : 0.28))
    .force("y", d3.forceY((d) => d.seedY)
      .strength(0.05))
    .force("collide", d3.forceCollide(COLLIDE).strength(0.9).iterations(2))
    .stop();

  const ticks = Math.max(1, Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay())));
  for (let i = 0; i < ticks; i += 1) sim.tick();

  // ───────────────────────────────────────────────────────────────────────────
  // SEPARATION PASS
  //
  // The main simulation balances three competing forces, so it settles at a
  // compromise in which a few pairs are still touching. This second pass
  // optimises ONE thing — no two footprints intersecting — with the springs
  // switched off, so it can finish the job the compromise left undone. It is
  // seeded from the result above, so it moves nodes by a few pixels and does
  // not undo the structure the first pass found.
  // ───────────────────────────────────────────────────────────────────────────
  const sep = d3.forceSimulation(simNodes)
    .alpha(0.6).alphaDecay(0.06).velocityDecay(0.45)
    .force("collide", d3.forceCollide(COLLIDE).strength(1).iterations(4))
    .force("x", d3.forceX((d) => d.targetX).strength((d) => d.isSpecial ? 0.6 : 0.02))
    .stop();
  for (let i = 0; i < 90; i += 1) sep.tick();

  // START and END are pinned to the extremes afterwards: they are the only two
  // nodes whose position carries a fixed meaning, and anchoring them gives the
  // graph a readable entry and exit without re-pinning anything else.
  const xs = simNodes.filter((d) => !d.isSpecial).map((d) => d.x);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 0;
  simNodes.forEach((d) => {
    if (isStartId(d.id)) { d.x = minX - 90; d.y = 0; }
    if (isEndId(d.id))   { d.x = maxX + 90; d.y = 0; }
  });

  const layout = {};
  simNodes.forEach((d) => { layout[d.id] = { x: d.x, y: d.y }; });
  return { layout, secondaryLaneTop: null };
}

function computeCategoryLayout(nodes, sequence, graphMode) {
  const nodeLookup = makeNodeLookup(nodes);

  function getClusterCenter(nodeId) {
    if (isStartId(nodeId)) return { cx: -400, cy: 0 };
    if (isEndId(nodeId))   return { cx:  400, cy: 0 };
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
    if (isStartId(node.id)) { meanOnset[node.id] = 0; return; }
    if (isEndId(node.id)) { meanOnset[node.id] = sequence[sequence.length - 1]?.end || 0; return; }
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
    const repNode = ids.find((id) => !isSpecialId(id));
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

// Return transitions are routed as an arc BELOW the main band so they read as a
// separate channel without occluding the dominant left-to-right flow. They are
// drawn, not hidden — the arc is the visible proof that the node is connected.
function getReturnArcPath(link, layout, radiusMap, curvature = null) {
  const s = layout[link.source] || { x: 0, y: 0 };
  const t = layout[link.target] || { x: 0, y: 0 };
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / dist;
  const ny = dy / dist;
  const rS = radiusMap[link.source] || 18;
  const rT = radiusMap[link.target] || 18;
  const x1 = s.x + nx * rS;
  const y1 = s.y + ny * rS;
  const x2 = t.x - nx * (rT + 4);
  const y2 = t.y - ny * (rT + 4);
  // Bow the arc PERPENDICULAR to the edge and proportional to its length.
  // The previous version always bulged straight down by at least 90px, which
  // reads fine in a single horizontal band but sweeps across everything once
  // nodes are distributed in two dimensions.
  // A return edge always bows to ONE side so it reads as its own channel, but
  // its size now follows the edge's lane, so two returns between the same pair
  // no longer trace the same arc.
  const lane = (curvature === null) ? 0.22 : (0.16 + Math.abs(curvature) * 1.6);
  const bow = Math.min(90, Math.max(18, dist * lane));
  const mx = (x1 + x2) / 2 - ny * bow;
  const my = (y1 + y2) / 2 + nx * bow;
  return `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
}

function getCurvedPath(link, layout, radiusMap, curvature = 0.18) {
  const s = layout[link.source] || { x: 0, y: 0 };
  const t = layout[link.target] || { x: 0, y: 0 };
  const dx = t.x - s.x, dy = t.y - s.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const rS = radiusMap[link.source] || 18, rT = radiusMap[link.target] || 18;
  const sx = s.x + (dx / dist) * rS, sy = s.y + (dy / dist) * rS;
  const tx = t.x - (dx / dist) * (rT + 6), ty = t.y - (dy / dist) * (rT + 6);
  const mx = (sx + tx) / 2 - dy * curvature;
  const my = (sy + ty) / 2 + dx * curvature;
  return `M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// EDGE-LABEL DE-COLLISION
//
// Placing text so that no two pieces overlap is the classic map-labelling
// problem, and it is NP-hard in general (Formann & Wagner 1991). Nobody solves
// it exactly; the standard practical method is candidate-and-conflict:
//
//   1. give every label a small set of candidate positions,
//   2. walk the labels in order of importance,
//   3. take the first candidate that hits nothing already placed,
//   4. if every candidate collides, keep the least-bad one.
//
// Here a label rides a <textPath>, so its candidates come for free: sliding
// `startOffset` moves the text along its own edge without ever detaching it
// from that edge — which matters, because a probability that has drifted next
// to the wrong line is worse than no probability at all.
//
// Important labels go first, so when the canvas runs out of room it is the
// rare transitions that get pushed aside, not the common ones.
// ─────────────────────────────────────────────────────────────────────────────
const LABEL_OFFSETS = ["50%", "40%", "60%", "32%", "68%", "25%", "75%"];

function declutterEdgeLabels(root, { maxLabels = 120 } = {}) {
  const texts = root.selectAll("text.edge-prob-text").nodes();
  if (texts.length === 0 || texts.length > maxLabels) return;

  // White halo first: a label that must sit on a line is still readable.
  root.selectAll("text.edge-prob-text")
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 3.5)
    .attr("paint-order", "stroke")
    .attr("stroke-linejoin", "round");

  const importance = (el) => {
    const d = d3.select(el).datum() || {};
    return (typeof d.probability === "number" ? d.probability : 0)
         + (d.support || 0) * 0.001;
  };
  const ordered = [...texts].sort((a, b) => importance(b) - importance(a));

  const pad = 2;
  const box = (el) => {
    let b;
    try { b = el.getBBox(); } catch (e) { return null; }
    if (!b || !b.width) return null;
    return { x: b.x - pad, y: b.y - pad, w: b.width + pad * 2, h: b.height + pad * 2 };
  };
  const hits = (a, b) =>
    !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);

  const placed = [];
  ordered.forEach((el) => {
    const tp = el.querySelector("textPath");
    if (!tp) return;

    let bestOffset = null, bestBox = null, bestConflicts = Infinity;
    for (const off of LABEL_OFFSETS) {
      tp.setAttribute("startOffset", off);
      const b = box(el);
      if (!b) break;
      const conflicts = placed.reduce((n, p) => n + (hits(p, b) ? 1 : 0), 0);
      if (conflicts < bestConflicts) {
        bestConflicts = conflicts; bestOffset = off; bestBox = b;
      }
      if (conflicts === 0) break;
    }

    if (bestOffset) tp.setAttribute("startOffset", bestOffset);
    if (bestBox) placed.push(bestBox);

    // Still buried after trying every candidate: fade it rather than stack it.
    // The number is not lost — the edge tooltip still reports it in full.
    if (bestConflicts > 1) {
      d3.select(el).attr("opacity", 0.35);
    }
  });
}

function getNodeLabel(node, mode) {
  if (node.isSpecial) return specialLabel(node.id);
  // Expanded bridge nodes carry a synthetic id so they stay unique per edge;
  // the label is the action the person actually performed.
  if (node.label) return node.label;
  if (mode === "abstracted") return node.step_label || node.id;
  if (mode.startsWith("hybrid")) return node.id; // Return full id, parsed later
  const verb = node.id.split("(")[0];
  return verb.length > 7 ? verb.slice(0, 6) + "..." : verb;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBTITLE
//
// Every level now draws the label below the node as verb-on-top, noun-beneath.
// The subtitle used to re-print that same noun for the `full` mode, at
// dy = r + 14 while the label sits at y = r + 12 — the two strings were
// landing on top of each other. So the noun is never a subtitle any more.
//
// The subtitle is reserved for one thing the label cannot say: that a node's
// name describes only part of what is inside it.
//
//   * a step node stands for many raw actions        -> "N actions"
//   * a Level-2 node whose object category was
//     dropped by the roll-up rule                    -> "any object"
//
// The second case is NOT a rendering fault, but the reason is narrower than
// "seen once". build_rollup_taxonomy() in 6_prepare_dashboard_data.py keeps a
// state's specific label only if it clears min_support, and min_support
// defaults to len(sessions) — EVERY session. So `clean` means: some sessions
// washed the milk and some did not, therefore wash(dairy and eggs) lost its
// object and merged with the other clean-category actions.
//
// That is why a generalised node can still read "seen in 2 of 3 sessions":
// the threshold is applied to each verb+object PAIR before merging, while the
// support shown in the tooltip is counted on the MERGED node afterwards. Two
// different populations, and the node is the larger of them.
//
// "mixed objects" is therefore the honest caption — not "one object we hid".
// ─────────────────────────────────────────────────────────────────────────────
function getNodeSubtitle(node, mode) {
  if (node.isSpecial) return "";
  if (node.mean_members > 1) return `${node.mean_members} actions`;
  if (mode === "step" && node.n_raw_actions > 1) return `${node.n_raw_actions} actions`;
  if (mode.startsWith("hybrid") && !String(node.id).includes("(")) return "mixed objects";
  return "";
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

    // Every node having the same support (single-session views, where support
    // is synthesized as 1) makes the scale degenerate and every node identical.
    // Fall back to count so node size still carries information.
    const uniform = supports.length > 0
      && d3.min(supports) === d3.max(supports);

    if (supports.length === 0 || uniform) {
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
    // Prefer the node's own verb field. Deriving the verb from the id only
    // works when the id looks like verb(noun); step nodes are named after the
    // recipe wording, so every one of them came out grey.
    return (d) => d.isSpecial ? "#d1d5db"
                : nodeColor(d.verb || d.id);
  }
  if (colorMode === "phase") {
    if (graphMode === "abstracted") {
      return (d) => d.isSpecial ? "#d1d5db" : getStepPhaseColor(d.id);
    }
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
  const MARKER_NS = svgSelector.replace(/[^a-zA-Z0-9]/g, "");   
  const markerId = (base) => `${base}-${MARKER_NS}`;
  const markerUrl = (base) => `url(#${base}-${MARKER_NS})`;

  const svg = d3.select(svgSelector);
  const graphWrapEl = document.querySelector(graphWrapSelector);
  let bgLayer = null;
  let gLinks = null;
  
  // State variables for dynamic styling / highlighting
  let linkSelection = null;
  let nodeSelection = null;
  let selfLoopSelection = null;
  let zoomBehavior = null;
  let fitTransform = null;
  let nodeLayout = null;
  let lastActiveEdge = null;
  let lastActiveNode = null;
  const BG_NODE_OPACITY = 0.18;
  let radiusMapCache = null;
  let pathForCache = null;
  let baseEdgeOpacityFn = null;
  let enrichedLinksCache = null;
  let enrichedLinksFullCache = null;   
  let labelPathForCache = null;
  let edgeWidthScale = null;
  let edgeMetricFn = (d) => d.count || 1;   
  let currentMode = "hybrid";
  let currentSequenceCache = [];
  let nodeDurationStatsCache = null;
  let autoZoomEnabled = true;
  let userPositions = {};
  let selectedNodeId = null;
  let lastGraph = null;
  let lastSequence = null;
  let lastMinCount = 1;
  let lastMode = "hybrid";
  let lastColorMode = "category";
  let lastSizeMode = "frequency";
  let lastLayoutMode = "temporal";
  let lastOptions = { onNodeClick: null };
  let lastExtras = {};

  // Highlight State Trackers
  let currentShowSupportBadges = false;
  let currentExternalColorFn = null;
  let currentFilteredNodes = [];
  let activeHighlight = null; // null | { type: 'session', value: idx } | { type: 'spine', value: arr }

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

  function buildGraph(
    graph,
    sequence,
    minCount = 1,
    mode = "hybrid",
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

    currentShowSupportBadges = !!extras.showSupportBadges;
    currentExternalColorFn = extras.colorFn || null;
    activeHighlight = null; // reset highlight state on new build

    const supportFilter = extras.supportFilter || 1;
    // In macro view every edge is drawn: 26 edges do not need pruning, and
    // top-k would hide real alternatives at that size.
    const isMacro = !!extras.isMacro;

    // ─────────────────────────────────────────────────────────────────────────
    // THE CANONICAL SPINE PATH
    //
    // `canonicalSpinePath` is an ordered list of {id, tier} from the pipeline.
    // tier "spine"     — every session performed this, in this order (LCS)
    // tier "connector" — inserted to join two spine actions that were never
    //                    directly adjacent. A real observed edge, but not part
    //                    of the common sequence.
    //
    // The two tiers are drawn differently on purpose: a reader is entitled to
    // know which nodes are the finding and which are the glue. The old flat
    // array could not express that.
    // ─────────────────────────────────────────────────────────────────────────
    const spinePath = extras.canonicalSpinePath
      || (extras.canonicalSpine || []).map((id) => ({ id, tier: "spine" }));
    const spinePathIds = spinePath.map((p) => p.id);
    const expandedEdges = extras.expandedEdges || new Set();
    const edgeDetail = isMacro ? "all" : (extras.edgeDetail || "all");
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

    // ─────────────────────────────────────────────────────────────────────────
    // CROSS-FADE
    //
    // `svg.selectAll("*").remove()` is why changing level looked like a page
    // reload: the canvas went blank, then a new picture appeared, and the
    // reader had no way to see WHAT changed between the two.
    //
    // With extras.animate the previous drawing is kept in place, stripped of
    // its id and its pointer events, and faded out underneath the new one.
    // Nodes common to both levels sit in roughly the same place — rank drives
    // x in every level — so the eye follows them across.
    //
    // This is a cross-fade, not a morph. A true morph would have to know that
    // take(cup) at Level 1 becomes retrieve(crockery) at Level 2, and that
    // mapping is a pipeline fact, not something the renderer may guess.
    // ─────────────────────────────────────────────────────────────────────────
    const animate = !!extras.animate;
    let fadingOut = null;
    if (animate) {
      const prev = svg.select("#zoomGroup");
      if (!prev.empty()) {
        prev.attr("id", null)
            .attr("class", "zoomGroup-outgoing")
            .style("pointer-events", "none");
        fadingOut = prev;
      }
    }
    const keepNode = fadingOut ? fadingOut.node() : null;
    Array.from(svg.node().childNodes).forEach((child) => {
      if (child !== keepNode) svg.node().removeChild(child);
    });
    svg.selectAll(".cycle-badge-group").remove();

    let enrichedNodes = [...graph.nodes];
    let enrichedLinks = [...graph.links];

    // ─────────────────────────────────────────────────────────────────────────
    // EMPHASIS, not removal.
    //
    // supportFilter used to DELETE nodes below the threshold and every edge
    // touching them. That is the behaviour Prof. Lin objected to: the data
    // vanished with no way back. Now the threshold only decides FOREGROUND vs
    // BACKGROUND. Background nodes stay in the graph, stay connected, keep
    // their tooltips — they simply fade and drop their labels, which is where
    // most of the visual weight lives at 91 nodes.
    // ─────────────────────────────────────────────────────────────────────────
    const supportOf = (n) => n.support || nSessionsHint || 1;
    enrichedNodes.forEach((n) => {
      n.__bg = !n.isSpecial
        && currentShowSupportBadges
        && supportFilter > 1
        && supportOf(n) < supportFilter;
    });
    const bgIds = new Set(enrichedNodes.filter((n) => n.__bg).map((n) => n.id));
    // ─────────────────────────────────────────────────────────────────────────
    // EDGE DETAIL — top-k outgoing transitions per action.
    //
    // Rolling up the tail moved the density problem from nodes to edges: 42
    // nodes now carry 410 transitions, roughly a quarter of every possible
    // directed pair. A global probability threshold is the wrong instrument
    // here — an action with ten continuations at P=0.10 each would lose all of
    // them and read as disconnected, which is the failure we just spent a week
    // removing. Ranking each action's OWN outgoing edges adapts to out-degree
    // and guarantees every action keeps its most likely continuation.
    //
    // Demoted edges are dimmed, never dropped: they keep their geometry, their
    // arrowheads and their tooltips, and the ledger states how many there are.
    // ─────────────────────────────────────────────────────────────────────────
    const topK = edgeDetail === "top1" ? 1 : edgeDetail === "top2" ? 2 : Infinity;
    const flowKeys = new Set();
    if (topK !== Infinity) {
      const bySource = d3.group(enrichedLinks, (l) => l.source);
      bySource.forEach((links) => {
        [...links]
          .sort((a, b) => (b.probability || 0) - (a.probability || 0)
                       || (b.count || 0) - (a.count || 0))
          .slice(0, topK)
          .forEach((l) => flowKeys.add(l.key));
      });
      // START and END are structural: always keep their connections prominent
      // so the graph retains a visible entry and exit.
      enrichedLinks.forEach((l) => {
        if (isStartId(l.source) || isEndId(l.target)) flowKeys.add(l.key);
      });
    }

    enrichedLinks.forEach((l) => {
      l.__minor = topK !== Infinity && !flowKeys.has(l.key);
      // An edge is foreground when BOTH endpoints are — nothing more.
      //
      // The earlier version also required the edge's own support to clear the
      // threshold, which backgrounded everything: in this dataset NO edge has
      // support 3, not even between two support-3 nodes. The result was a
      // foreground of bright, totally unconnected nodes — the exact isolated-
      // node problem this feature was supposed to help with.
      //
      // Node support and edge support answer different questions. An action
      // occurring in every session does not mean one particular transition
      // into it occurred in every session; people reach the same state by
      // different routes. Gating on both is far stricter than intended.
      l.__bg = bgIds.has(l.source) || bgIds.has(l.target) || l.__minor;
    });
    const nMinor = enrichedLinks.filter((l) => l.__minor).length;
    const nBackground = enrichedNodes.filter((n) => n.__bg).length;

    const dataHasStart = enrichedNodes.some((n) => isStartId(n.id));
    const dataHasEnd   = enrichedNodes.some((n) => isEndId(n.id));
 
    enrichedNodes.forEach((n) => {
      if (isSpecialId(n.id) || isStartId(n.id) || isEndId(n.id)) {
        n.isSpecial = true;
        n.kind = isStartId(n.id) ? "start" : "end";
      }
    });
 
    // ─────────────────────────────────────────────────────────────────────────
    // START and END are structural, so every level must have them.
    //
    // The old guard included `!currentShowSupportBadges`, i.e. "only when this
    // is NOT the merged view". The hybrid and step payloads ship START/END of
    // their own, so the bug was invisible there — but the full (Level 1)
    // payload does not, and the merged view is the default, so Level 1 lost
    // its entry and exit entirely.
    //
    // Anchors are chosen by median rank rather than by sequence[0], because in
    // the merged view `sequence` is only ONE session's list; its first row is
    // not necessarily the state every session starts in. Rank is the same
    // population the layout and is_return already use, so all three agree.
    // ─────────────────────────────────────────────────────────────────────────
    if (sequence.length > 0 && !dataHasStart && !dataHasEnd) {
      const realNodes = enrichedNodes.filter((n) => !n.isSpecial);
      const rankOf = (n) => (typeof n.median_rank === "number"
        ? n.median_rank
        : (typeof n.mean_normalized_onset === "number" ? n.mean_normalized_onset : null));
      const ranked = realNodes.filter((n) => rankOf(n) !== null);

      let firstAction, lastAction;
      if (ranked.length >= 2) {
        firstAction = ranked.reduce((a, b) => (rankOf(a) <= rankOf(b) ? a : b)).id;
        lastAction  = ranked.reduce((a, b) => (rankOf(a) >= rankOf(b) ? a : b)).id;
      } else {
        firstAction = sequence[0].action;
        lastAction  = sequence[sequence.length - 1].action;
      }

      const idsPresent = new Set(realNodes.map((n) => n.id));
      if (idsPresent.has(firstAction) && idsPresent.has(lastAction)) {
        enrichedNodes.unshift({
          id: "START", count: 1, isSpecial: true, kind: "start", is_primary: true,
          support: nSessionsHint || 1, n_sessions: nSessionsHint || 1,
        });
        enrichedNodes.push({
          id: "END", count: 1, isSpecial: true, kind: "end", is_primary: true,
          support: nSessionsHint || 1, n_sessions: nSessionsHint || 1,
        });
        enrichedLinks.unshift({
          source: "START", target: firstAction, count: 1, probability: 1.0,
          key: "START-" + firstAction,
        });
        enrichedLinks.push({
          source: lastAction, target: "END", count: 1, probability: 1.0,
          key: lastAction + "-END",
        });
      }
    }

    const enrichedLinksFull = enrichedLinks.slice();   
    enrichedLinks = enrichedLinks.filter(l => (l.count || 1) >= minCount);

    const activeNodeIds = new Set();
    enrichedLinks.forEach(l => { activeNodeIds.add(l.source); activeNodeIds.add(l.target); });
    let filteredNodes;
    if (currentShowSupportBadges) {
      filteredNodes = enrichedNodes;
    } else {
      filteredNodes = enrichedNodes.filter(n => activeNodeIds.has(n.id));
    }
    
    currentFilteredNodes = filteredNodes;

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
    // One radius range for every level. The old hybrid-only [26, 46] existed
    // to fit text INSIDE the circle; nothing is drawn inside any more, so the
    // extra 10px was pure overlap. Sparse graphs get a mild boost so seven
    // nodes do not look lost on a wide canvas — that is a canvas-fill decision,
    // not a change to what size encodes.
    const sparseBoost = filteredNodes.length <= 10 ? 1.35 : 1;
    const nodeRadiusByCount = d3.scaleSqrt()
      .domain([1, Math.max(maxCount, 2)])
      .range([18 * sparseBoost, 38 * sparseBoost]);

    enrichedLinksCache = enrichedLinks;          
    enrichedLinksFullCache = enrichedLinksFull;  

    const defs = svg.append("defs");
    [["arrow", "#94a3b8"], ["arrowActive", "#ea580c"]].forEach(([id, color]) => {
      defs.append("marker").attr("id", markerId(id))
        .attr("viewBox", "0 -4 10 8").attr("refX", 9).attr("refY", 0)
        .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
        .append("path").attr("d", "M0,-4L10,0L0,4Z").attr("fill", color);
    });
    defs.append("marker").attr("id", markerId("arrowReturn"))
      .attr("viewBox", "0 -4 10 8").attr("refX", 9).attr("refY", 0)
      .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
      .append("path").attr("d", "M0,-4L10,0L0,4Z").attr("fill", "#7C3AED");
    defs.append("marker").attr("id", markerId("arrowReverse"))
      .attr("viewBox", "0 -4 10 8").attr("refX", 1).attr("refY", 0)
      .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto-start-reverse")
      .append("path").attr("d", "M0,-4L10,0L0,4Z").attr("fill", "#94a3b8");

    const zoomGroup = svg.append("g").attr("id", "zoomGroup");
    bgLayer = zoomGroup.append("g").attr("class", "hri-backgrounds");
    gLinks = zoomGroup.append("g").attr("class", "edges");

    const nodeLabels = new Map();
    filteredNodes.forEach((node) => { nodeLabels.set(node.id, getNodeLabel(node, currentMode)); });

    // const radiusMap = makeNodeSizeMap(
    //   filteredNodes, nodeDurationStatsCache, sizeMode, nodeRadiusByCount, mode
    // );
    // if (mode.startsWith("hybrid")) {
    //   filteredNodes.forEach((d) => {
    //     const label = nodeLabels.get(d.id) || d.id;
    //     const match = label.match(/^([^\(]+)\((.*)\)$/);
    //     let maxLen = label.length;
    //     if (match) maxLen = Math.max(match[1].length, match[2].length);
        
    //     // INCREASED MULTIPLIER AND BASE SIZE FOR BIGGER TEXT
    //     const fitR = Math.max(34, maxLen * 4.8 + 10); 
    //     radiusMap[d.id] = Math.max(radiusMap[d.id] || 18, fitR);
    //   });
    // }
    // radiusMapCache = radiusMap;
    // Restore pure data-driven sizing! Remove the text-based override completely.

    const radiusMap = makeNodeSizeMap(
      filteredNodes, nodeDurationStatsCache, sizeMode, nodeRadiusByCount, mode
    );
    radiusMapCache = radiusMap;

    const maxRadius = d3.max(Object.values(radiusMap)) || 18;
    let layout = {};
    let clusters = null;
    let totalDuration = sequence[sequence.length - 1]?.end || 1;
    let xScale = null;

    if (RANK_LAYOUT_MODES.some((m) => mode.startsWith(m)) && layoutMode === "temporal") {
      drawHRIBackgrounds(false);
      zoomGroup.selectAll(".hri-backgrounds").selectAll("*").remove();
      // Only order by the spine when the spine is actually being shown.
      // Re-laying-out on every render would make the graph jump whenever the
      // user toggled the highlight off.
      const spineOrder = (extras.spineHighlightActive && spinePathIds.length)
        ? buildSpineOrder(spinePathIds)
        : null;
      const t = computeRankLayout(filteredNodes, sequence,
        { maxRadius, links: enrichedLinks, radiusMap, spineOrder });
      layout = t.layout;
      xScale = null; 
    } else if (layoutMode === "temporal") {
      drawHRIBackgrounds(false);
      const t = computeTemporalLayout(filteredNodes, sequence, { maxRadius });
      layout = t.layout; totalDuration = t.totalDuration; xScale = t.xScale;
    } else {
      const roleNodes = { robot: [], collab: [], human: [] };
      filteredNodes.forEach((n) => {
        if (n.isSpecial) return;
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
        const label = currentShowSupportBadges ? t + "%" : t + "s";
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
    // LANES REMOVED.
    //
    // drawLanes() boxed the canvas into "Recipe actions" and "Secondary
    // actions". It was skipped for hybrid, so Level 1 was the only level with
    // a split canvas — same dashboard, two different pictures. The lane is a
    // property of one node field (is_primary); it does not need its own
    // geometry, and forcing every secondary node into a strip below the
    // primaries is what produced the unreadable Level 1 layout.
    //
    // is_primary is still in the payload and still shown in the tooltip, so
    // no information is lost. The function is kept for reference only.
    //   if (layoutMode === "temporal") drawLanes(...)   // intentionally off

    edgeMetricFn = (d) => (typeof d.probability === "number" ? d.probability : 0);
    edgeWidthScale = d3.scaleSqrt().domain([0, 1]).range([1.5, 5.5]);

    // ─────────────────────────────────────────────────────────────────────────
    // Edge classification
    //
    // Every edge here is a directly-follows relation, so every edge is forward
    // in time. `is_return` is computed in the pipeline from median sequence
    // rank and means only that the target is normally reached EARLIER than the
    // source — the performer came back to a state they had already visited.
    //
    // This used to be decided by comparing node x-coordinates, which made the
    // classification a property of the layout rather than of the data (and made
    // it flip when a node was dragged). The layout comparison survives only as
    // a fallback for payloads built before the pipeline emitted the flag.
    //
    // Nothing is dropped. Low-probability edges are faded, never removed, so no
    // node can be left visually isolated.
    // ─────────────────────────────────────────────────────────────────────────
    const forwardEdges = [];
    const returnEdges = [];
    const selfLoops = [];
    const WEAK_EDGE_PROB = 0.08;
    let weakEdges = 0;
    let usedRankData = false;

    const classifyReturn = (link) => {
      if (isStartId(link.source) || isEndId(link.target)) return false;
      if (typeof link.is_return === "boolean") { usedRankData = true; return link.is_return; }
      if (typeof link.rank_delta === "number") { usedRankData = true; return link.rank_delta < 0; }
      const sx = (layout[link.source] || { x: 0 }).x;
      const tx = (layout[link.target] || { x: 0 }).x;
      return tx < sx;
    };

    enrichedLinks.forEach((link) => {
      // Two different reasons an edge is untrustworthy, and they are NOT the
      // same reason:
      //   micro view  — the transition is rare (low probability)
      //   macro view  — the estimate rests on too little data (low n)
      // In macro view a P = 1.00 edge from a single observation is the LEAST
      // trustworthy thing on screen, so grading it by probability would style
      // it as the strongest. Evidence is used instead.
      // A low-probability transition is worth marking in EVERY mode. The test
      // used to be gated on `hybrid`, which meant nothing was ever dashed on
      // the episode or step layer — while the legend claimed otherwise.
      //
      // This matters more now that no edges are filtered. Rarity used to be
      // handled by removing the edge; it is now handled entirely in the
      // drawing, so the drawing has to actually show it.
      const isAnchorEdge = isStartId(link.source) || isEndId(link.target);
      link.__weak = isMacro
        ? (link.evidence === "weak" && !isAnchorEdge)
        : (typeof link.probability === "number"
        && link.probability < WEAK_EDGE_PROB
        && !isAnchorEdge);
      if (link.__weak) weakEdges += 1;

      if (link.source === link.target || link.is_self_loop) { selfLoops.push(link); return; }
      link.__isReturn = classifyReturn(link);
      if (link.__isReturn) returnEdges.push(link); else forwardEdges.push(link);
    });

    const medianCount = d3.median(forwardEdges, (d) => d.count || 1) || 1;

    // Single source of truth for edge geometry, used by the initial draw AND by
    // the drag handler, so dragging can no longer swap a curve family.
    // Geometry for the label only.
    //
    // Every path helper here emits a quadratic Bezier: "M x1 y1 Q mx my x2 y2".
    // Such a curve reverses EXACTLY by swapping its two endpoints and keeping
    // the control point, so the label rides the identical arc that is drawn,
    // just traversed the other way. That is all a right-to-left edge needs in
    // order to render its text upright.
    //
    // An earlier attempt rebuilt the geometry from the reversed link instead,
    // which produced a mirrored arc — the label then sat beside its edge rather
    // than on it. Reversing the string avoids that entirely, and lets return
    // edges use exactly the same mechanism as forward edges.
    const reverseQuadratic = (dStr) => {
      const n = dStr.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
      if (!n || n.length < 6) return dStr;
      const [x1, y1, mx, my, x2, y2] = n.slice(0, 6).map(Number);
      return `M ${x2} ${y2} Q ${mx} ${my} ${x1} ${y1}`;
    };

    const labelPathFor = (link) => {
      const d = pathFor(link);
      const a = layout[endId(link.source)], b = layout[endId(link.target)];
      return (a && b && b.x < a.x) ? reverseQuadratic(d) : d;
    };
    labelPathForCache = labelPathFor;

    // ─────────────────────────────────────────────────────────────────────────
    // EDGE LANES — the cheap half of "stop the edges overlapping"
    //
    // Two edges overlap for two different reasons, and they need two different
    // remedies:
    //
    //   1. They join the SAME pair of nodes (A→B and B→A, or a repeat).
    //      A straight line cannot separate them: both lie on the segment AB.
    //      Remedy: give each edge of a pair its own lane — a quadratic Bezier
    //      bowed sideways by an amount that depends on its index in the pair.
    //      This is the standard multi-edge treatment in graph drawing.
    //
    //   2. They join DIFFERENT nodes but happen to be collinear.
    //      Remedy: bow every edge slightly, so two edges crossing the same
    //      strip of canvas separate instead of merging into one grey line.
    //
    // Neither remedy removes a crossing. Crossings are a property of the node
    // positions, and the only real cure is a layered (Sugiyama) layout — see
    // the note above computeRankLayout.
    // ─────────────────────────────────────────────────────────────────────────
    const pairSlots = new Map();
    enrichedLinks.forEach((l) => {
      const a = endId(l.source), b = endId(l.target);
      if (a === b) return;
      const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      if (!pairSlots.has(k)) pairSlots.set(k, []);
      pairSlots.get(k).push(l);
    });
    pairSlots.forEach((group) => {
      const n = group.length;
      group.forEach((l, i) => {
        l.__slot  = i - (n - 1) / 2;     // symmetric around zero
        l.__slotN = n;
      });
    });

    // Dense graphs need a flatter bow, or the curves themselves become the
    // clutter. Scale-free: the constant is a fraction of edge length, not px.
    const BASE_CURVE = enrichedLinks.length > 120 ? 0.07
                     : enrichedLinks.length > 40  ? 0.12
                     : 0.18;
    const curvatureFor = (link) => {
      const n = link.__slotN || 1;
      if (n <= 1) return BASE_CURVE * 0.85;
      const side = link.__slot >= 0 ? 1 : -1;
      return BASE_CURVE * side * (0.7 + Math.abs(link.__slot) * 0.9);
    };

    const pathFor = (link) => {
      if (link.__isReturn) {
        return getReturnArcPath(link, layout, radiusMap, curvatureFor(link));
      }
      return getCurvedPath(link, layout, radiusMap, curvatureFor(link));
    };
    pathForCache = pathFor;

    // Weak edges are FADED, not dashed and not removed.
    //
    // Dashes were a second channel saying the same thing as opacity, and at
    // 147 edges the broken outlines read as texture rather than as meaning.
    // One channel, one claim: a paler edge is a weaker one. The ledger still
    // counts them, and the tooltip still reports the exact probability.
    const weakDash = () => null;
    const baseEdgeOpacity = (d) => {
      if (d.__bg) return 0.12;
      // Opacity = evidence (how many sessions), not probability.
      const support = d.support || 1;
      const nS = nSessionsHint || 1;
      const op = 0.45 + 0.45 * ((support - 1) / Math.max(1, nS - 1));
      return d.__weak ? op * 0.6 : op;
    };
    baseEdgeOpacityFn = baseEdgeOpacity;

    const selfLoopSummary = [...d3.group(selfLoops, (d) => d.source)].map(([sid, edges]) => ({
      source: sid, target: sid,
      key: edges[0]?.key || `${sid}|||${sid}`,
      count: d3.sum(edges, (e) => e.count || 1),
      occurrences: edges.flatMap((e) => e.occurrences || []),
      probability: edges[0]?.probability, // Carry the probability forward
    }));

    // ── Return transitions: drawn as arcs for geometry only ─────────────────

    // Density switches. The label and edge-label styling was tuned for a sparse
    // horizontal band; at raw-graph density the same styling is what makes the
    // picture unreadable, not the node positions.
    // Labels sit BELOW the node for every hybrid view. Keeping this density-gated
    // made the merged graph and the per-session graph look like different tools:
    // one with labels outside, one with white text crammed inside the circles.
    // Label placement must not depend on how many nodes a recipe happens to
    // have. Deciding it by node count put P01's 12 labels inside the circles
    // and P03's 43 below them — same dashboard, two different conventions.
    // Episode and step labels are always verb(noun), so they always go below.
    // Labels ALWAYS sit below and outside the circle.
    //
    // This used to depend on node count (`filteredNodes.length > 24`), so
    // Level 4 with its 7 nodes was the one level that crammed white text
    // inside the circles while every other level wrote it underneath. Label
    // placement is a convention of the dashboard, not a function of how many
    // nodes a recipe happens to have; a reader should not have to relearn
    // where to look each time they move the slider.
    //
    // Text inside a circle also has to shrink to fit, which caps how much a
    // label may say — "pour foam in coffee" was already unreadable at Level 4.
    const denseLabels = true;
    // Probability labels are always shown — they are the point of a Markov
    // graph — but shrink and fade on dense graphs instead of disappearing.
    const denseEdges = enrichedLinks.length > 34;
    const probFontSize = denseEdges ? "10px" : "14px";
    // Sample size travels with the probability. A 1.00 from a single
    // observation is not the same claim as a 1.00 from twenty, and the canvas
    // gave no way to tell them apart.
    const probLabel = (d) => {
      const st = edgeStats(d);
      const p = (st.probability !== undefined ? st.probability : d.probability).toFixed(2);
      const n = st.scoped ? st.count
        : ((d.n !== undefined) ? d.n : (d.count || d.total_count || 0));
      const s = d.support, nS = d.n_sessions;
      // A macro probability is meaningless without its denominator: "1.00" and
      // "1.00 (1/1)" look identical to a reader and are completely different
      // claims. The denominator is therefore mandatory here.
      if (isMacro && d.n_out) return `${p} (${n}/${d.n_out})`;
      if (s && nS) return `${p} · ${s}/${nS}`;
      return n > 0 ? `${p} (n=${n})` : p;
    };
    currentProbLabel = probLabel;
    const probOpacity  = denseEdges ? 0.72 : 1;
    // Labels ride on their own copies of the edges, always oriented
    // left-to-right. A <textPath> follows the direction of its path, so a
    // right-to-left edge rendered its probability mirrored and upside down.
    const labelPathId = (d) =>
      `lpath-${MARKER_NS}-${d.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const addLabelPath = (sel) => sel.append("path")
      .attr("id", (d) => labelPathId(d))
      .attr("fill", "none").attr("stroke", "none")
      .attr("d", (d) => labelPathFor(d));

    const returnGroups = gLinks.append("g").attr("class", "return-edges")
      .selectAll(".return-group")
      .data(returnEdges).enter().append("g").attr("class", "return-group");

    // Edges the filter invented — present in the graph but never observed as
    // consecutive actions. Zero under span scoping; drawn distinctly so that
    // zero is something you can SEE rather than something a log claims.
    const markIntroduced = (sel) => sel
      .filter((d) => d.is_introduced)
      .attr("stroke", "#DC2626")
      .attr("stroke-dasharray", "2 5")
      .attr("stroke-opacity", 0.9);

    returnGroups.append("path")
      .attr("id", d => `path-${MARKER_NS}-${d.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`)
      .attr("class", (d) => `link fwd-edge return-edge ${(d.count || 1) > medianCount ? "dominant" : "minor"}`)
      .attr("data-key", (d) => d.key)
      .attr("fill", "none")
      .attr("stroke-width", (d) => edgeWidthScale(edgeMetricFn(d)))
      .attr("stroke-dasharray", weakDash)
      .attr("opacity", (d) => baseEdgeOpacity(d)) // <-- CHANGED from hardcoded ternary to baseEdgeOpacity(d)
      .attr("marker-end", markerUrl("arrow"))
      .attr("d", (d) => pathFor(d))
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip);
    markIntroduced(returnGroups.selectAll("path.return-edge"));

    addLabelPath(returnGroups);

    returnGroups.filter(d => typeof d.probability === 'number' && d.probability > 0)
      .append("text")
      .attr("class", "edge-prob-text")
      .attr("dy", -4)
      .attr("font-size", probFontSize)
      .attr("font-weight", "bold")
      .attr("fill", "#64748b")
      .attr("opacity", (d) => d.__bg ? 0 : probOpacity)
      .attr("pointer-events", "none")
      .classed("prob-label", true)
      .append("textPath")
      .attr("href", d => `#${labelPathId(d)}`)
      .attr("startOffset", "50%")
      .attr("text-anchor", "middle")
      .text(d => probLabel(d));

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


    // ─────────────────────────────────────────────────────────────────────────
    // BRIDGED EDGES
    //
    // An edge that collapsed a run of logistics is thicker, gets a pointer
    // cursor, and shows how many actions are folded under it. It is the only
    // clickable edge in the graph, so it has to look different from an edge
    // that merely happens to be frequent — width alone would be ambiguous.
    //
    // An OPEN edge is not drawn at all: app.js has already replaced it with the
    // chain it contained, so drawing it too would show a shortcut next to the
    // route, which is exactly the phantom edge this whole design avoids.
    // ─────────────────────────────────────────────────────────────────────────
    const bridgeWidthBonus = (d) => {
      if (!isMacro || !d.is_bridged) return 0;
      return Math.min(4, 1 + Math.log2(1 + (d.bridge_len_median || 1)));
    };
    const applyBridgeAffordance = (sel) => {
      if (!isMacro) return sel;
      sel.filter((d) => d.is_bridged)
        .attr("stroke-linecap", "round")
        .style("cursor", "pointer")
        .attr("stroke-width", (d) =>
          edgeWidthScale(edgeMetricFn(d)) + bridgeWidthBonus(d));
      sel.filter((d) => d.is_bridge_edge)
        .attr("stroke", "#0F766E")
        .attr("stroke-dasharray", null);
      sel.on("click", function (event, d) {
        if (!d) return;
        if (d.is_bridge_edge && d.bridge_of) {
          // Clicking any hop of an opened run closes the whole run.
          event.stopPropagation();
          if (lastOptions && lastOptions.onEdgeClick) {
            lastOptions.onEdgeClick({ key: d.bridge_of, is_bridged: true });
          }
          return;
        }
        if (!d.is_bridged) return;
        event.stopPropagation();
        if (lastOptions && lastOptions.onEdgeClick) lastOptions.onEdgeClick(d);
      });
      return sel;
    };

    const unidirGroups = gLinks.append("g").selectAll(".unidir-group")
      .data(unidirectionalForward).enter().append("g").attr("class", "unidir-group");

    unidirGroups.append("path")
      .attr("id", d => `path-${MARKER_NS}-${d.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`)
      .attr("class", (d) => `link fwd-edge ${(d.count || 1) > medianCount ? "dominant" : "minor"}`)
      .attr("data-key", (d) => d.key)
      .attr("stroke-width", (d) => edgeWidthScale(edgeMetricFn(d)))
      .attr("opacity", (d) => baseEdgeOpacity(d))
      .attr("stroke-dasharray", weakDash)
      .attr("marker-end", markerUrl("arrow"))
      .attr("d", (d) => pathFor(d))
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip)
      .call(applyBridgeAffordance);

    addLabelPath(unidirGroups);

    unidirGroups.filter(d => typeof d.probability === 'number' && d.probability > 0)
      .append("text")
      .attr("class", "edge-prob-text")
      .attr("dy", -4)
      .attr("font-size", probFontSize)
      .attr("font-weight", "bold")
      .attr("fill", "#64748b")
      .attr("opacity", (d) => d.__bg ? 0 : probOpacity)
      .attr("pointer-events", "none")
      .classed("prob-label", true)
      .append("textPath")
      .attr("href", d => `#${labelPathId(d)}`)
      .attr("startOffset", "50%")
      .attr("text-anchor", "middle")
      .text(d => probLabel(d));

    // How many actions are hidden, written on the edge. Without this the only
    // way to know an edge is worth opening is to hover it.
    if (isMacro) {
      unidirGroups.filter((d) => d.is_bridged && !expandedEdges.has(d.key))
        .append("text")
        .attr("class", "bridge-count-text")
        .attr("dy", 11)
        .attr("font-size", denseEdges ? "9px" : "11px")
        .attr("fill", "#0F766E")
        .attr("opacity", (d) => d.__bg ? 0 : 0.9)
        .attr("pointer-events", "none")
        .append("textPath")
        .attr("href", d => `#${labelPathId(d)}`)
        .attr("startOffset", "50%")
        .attr("text-anchor", "middle")
        .text((d) => `+${d.bridge_len_median} · ${Math.round(d.gap_s_median || 0)}s`);
    }

    const bidirGroups = gLinks.append("g").selectAll(".bidir-group")
      .data(bidirectionalForward).enter().append("g").attr("class", "bidir-group");

    bidirGroups.append("path")
      .attr("id", d => `path-${MARKER_NS}-${d.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`)
      .attr("class", "link bidir-edge")
      .attr("data-key", (d) => d.key)
      .attr("data-pair-key", (d) => d.pairKey)
      .attr("stroke-width", (d) => edgeWidthScale(edgeMetricFn(d)))
      .attr("opacity", (d) => baseEdgeOpacity(d))
      .attr("marker-end", markerUrl("arrow"))
      .attr("marker-start", markerUrl("arrowReverse"))
      .attr("d", (d) => pathFor(d))
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip)
      .call(applyBridgeAffordance);

    addLabelPath(bidirGroups);

    bidirGroups.filter(d => typeof d.probability === 'number' && d.probability > 0)
      .append("text")
      .attr("class", "edge-prob-text")
      .attr("dy", -4)
      .attr("font-size", probFontSize)
      .attr("font-weight", "bold")
      .attr("fill", "#64748b")
      .attr("opacity", (d) => d.__bg ? 0 : probOpacity)
      .attr("pointer-events", "none")
      .classed("prob-label", true)
      .append("textPath")
      .attr("href", d => `#${labelPathId(d)}`)
      .attr("startOffset", "50%")
      .attr("text-anchor", "middle")
      .text(d => probLabel(d));

    // Background nodes fade to a hint of their colour. Hovering restores the
    // node and its label to full strength, so nothing is lost — it is one
    // gesture away rather than gone.
    const nodeGroups = zoomGroup.append("g").selectAll(".node")
      .data(filteredNodes).enter().append("g")
      .attr("class", (d) => d.__bg ? "node node-bg" : "node")
      .attr("data-id", (d) => d.id)
      .attr("opacity", (d) => d.__bg ? BG_NODE_OPACITY : 1)
      .on("mouseenter.emph", function(event, d) {
        if (!d.__bg) return;
        d3.select(this).style("opacity", 1)
          .select("text.node-label").attr("opacity", 1);
      })
      .on("mouseleave.emph", function(event, d) {
        if (!d.__bg) return;
        d3.select(this).style("opacity", BG_NODE_OPACITY)
          .select("text.node-label").attr("opacity", 0);
      })
      .attr("transform", (d) => {
        const p = layout[d.id] || { x: 0, y: 0 };
        return `translate(${p.x},${p.y})`;
      });

    // ─────────────────────────────────────────────────────────────────────
    // NODE HOVER
    //
    // Every field read here is already in the payload; nothing is computed at
    // render time. Kept as a native <title> so it cannot be clipped by the
    // zoom layer or fall out of sync with the node it belongs to.
    // ─────────────────────────────────────────────────────────────────────
    // ONE TOOLTIP, NOT TWO.
    //
    // This block used to append a native SVG <title>. The browser renders that
    // as its own OS tooltip, which appeared ON TOP of the styled #nodeTooltip
    // div and covered it — two boxes, overlapping, saying the same thing in
    // two formats. A native <title> also cannot be positioned, styled or
    // dismissed, so it is the one that has to go.
    //
    // Its wording was the newer and better of the two, so it is not thrown
    // away: buildNodeSummary() below produces exactly those lines, and
    // showNodeTooltip() renders them inside the single styled div.
    nodeGroups.each(function (d) {
      if (d.isSpecial) return;
      d.__summary = buildNodeSummary(d);
    });

    function buildNodeSummary(d) {
      const top = (obj, n) => Object.entries(obj || {})
        .sort((a, b) => b[1] - a[1]).slice(0, n)
        .map(([k, v]) => `${k} x${v}`).join(", ");

      const lines = [d.label || d.id];
      // "named after" is a statement about where the LABEL came from.
      // "most common action" is a statement about the contents. They are
      // different claims and only one of them applies to a given node.
      if (d.head_action && d.head_action !== d.id) {
        lines.push(`named after: ${d.head_action}`);
      } else if (d.top_action) {
        lines.push(`most common action inside: ${d.top_action}`);
      }
      if (typeof d.support === "number" && d.n_sessions > 1) {
        lines.push(`seen in ${d.support} of ${d.n_sessions} sessions - ${d.count}x total`);
      } else if (typeof d.count === "number") {
        lines.push(`${d.count}x in this session`);
      }
      if (d.n_raw_actions) lines.push(`${d.n_raw_actions} raw actions inside`);
      if (d.self_loop) lines.push(`repeats itself ${d.self_loop}x`);
      const v = top(d.verbs, 5); if (v) lines.push(`verbs: ${v}`);
      const o = top(d.objects, 5); if (o) lines.push(`objects: ${o}`);
      if (d.per_session_counts && Object.keys(d.per_session_counts).length > 1) {
        lines.push("per session: " + Object.entries(d.per_session_counts)
          .map(([s, n]) => `S${Number(s) + 1}:${n}`).join("  "));
      }
      const outs = (enrichedLinksFullCache || [])
        .filter((l) => endId(l.source) === d.id && endId(l.target) !== d.id);
      if (d.rolled_up) {
        // The threshold is ROLLUP_MIN_SUPPORT in 6_prepare_dashboard_data.py,
        // which defaults to None, meaning EVERY session. So a label is
        // generalised when the exact verb+object was missing from at least one
        // session — not, as this text used to claim, when it was seen in only
        // one. A node seen in 2 of 3 sessions is generalised and says so.
        const need = (typeof d.n_sessions === "number") ? d.n_sessions : null;
        lines.push(need
          ? `label generalised: this exact verb+object was not in all ${need} sessions,`
          : "label generalised: this exact verb+object was not in every session,");
        lines.push("so the node is named after the broader category");
      }
      if (d.n_raw_actions > 1) lines.push("double-click to open the actions inside");
      return lines;
    }

    const colorFn = currentExternalColorFn
      ? (d) => d.isSpecial ? "#d1d5db" : currentExternalColorFn(d.id)
      : makeNodeColorFn(filteredNodes, sequence, colorMode, mode);

    nodeGroups.append("circle").attr("class", "selection-ring")
      .attr("r", (d) => (radiusMap[d.id] || 18) + 6)
      .attr("fill", "none").attr("stroke", "#2563EB").attr("stroke-width", 3)
      .attr("opacity", 0).attr("pointer-events", "none");

    nodeGroups.append("circle")
      .attr("class", "node-body")
      .attr("r", (d) => radiusMap[d.id] || 18)
      .style("fill", colorFn)
      .style("stroke", (d) => (d.salient ? "#1e293b" : "none"))
      .style("stroke-width", (d) => (d.salient ? 2.5 : 0))
      // NOTE: this is .style(), which overrides the presentation attribute set
      // on the group. Background emphasis has to be applied here or it is lost.
      //
      // Secondary nodes are no longer half-faded. Opacity was carrying two
      // unrelated meanings at once — "outside a recipe step" and "below the
      // support threshold" — so a reader could not tell which claim a pale
      // circle was making. Opacity now means support only; is_primary lives in
      // the tooltip, where it can be stated in words.
      .style("opacity", (d) => d.__bg ? BG_NODE_OPACITY : 1.0);

    const nSessions = (extras && extras.nSessions) || 1;
 
    nodeGroups
      .filter((d) => !d.isSpecial && nSessions >= 2 && (d.support === nSessions))
      .append("circle")
        .attr("class", "mandatory-ring")
        .attr("r", (d) => (radiusMap[d.id] || 18) + 4)
        .attr("fill", "none")
        .attr("stroke", "#16A34A")
        .attr("stroke-width", 2.25)
        .attr("pointer-events", "none");
 
    nodeGroups
      .filter((d) => !d.isSpecial && (d.dead_end_score || 0) >= 0.7)
      .append("circle")
        .attr("class", "dead-end-ring")
        .attr("r", (d) => (radiusMap[d.id] || 18) + 8)
        .attr("fill", "none")
        .attr("stroke", "#B45309")
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "4 3")
        .attr("pointer-events", "none");

    nodeGroups.append("text")
      .attr("class", "node-label")
      // Labels carry most of the visual weight at this density, so background
      // nodes drop theirs entirely. Hover brings it back.
      .attr("opacity", (d) => d.__bg ? 0 : 1)
      .attr("text-anchor", "middle")
      .attr("dy", (d) => (getNodeSubtitle(d, currentMode) ? "-0.12em" : "0.35em"))
      // .attr("font-size", (d) => {
      //   const label = nodeLabels.get(d.id) || d.id;
      //   if (d.isSpecial) return "14px"; 
        
      //   // DYNAMIC SIZING: Font grows as the node grows!
      //   if (currentMode.startsWith("hybrid")) {
      //       const r = radiusMap[d.id] || 34;
      //       return Math.max(12, Math.round(r * 0.35)) + "px"; 
      //   }
        
      //   if (currentMode === "abstracted") {
      //     return label.length > 18 ? "7px" : label.length > 10 ? "8px" : "9px";
      //   }
      //   return label.length > 10 ? "8px" : "9px";
      // })
      .attr("font-size", (d) => {
        const label = nodeLabels.get(d.id) || d.id;
        if (d.isSpecial) return "14px"; 
        
        // DYNAMIC SIZING: Scale font down if radius is small, up if large.
        if (currentMode.startsWith("hybrid")) {
            const r = radiusMap[d.id] || 26;
            // Clamp font between 8px and 16px so it remains legible but scales with the node
            return Math.min(16, Math.max(8, Math.round(r * 0.4))) + "px"; 
        }
        
        if (currentMode === "abstracted") {
          return label.length > 18 ? "7px" : label.length > 10 ? "8px" : "9px";
        }
        return label.length > 10 ? "8px" : "9px";
      })
      .attr("font-weight", "bold")
      .attr("fill", (d) => (d.isSpecial ? "#4b5563" : "white"))
      .attr("pointer-events", "none")
      .each(function(d) {
        const label = nodeLabels.get(d.id) || d.id;
        const isHybridSplit = currentMode.startsWith("hybrid") && label.includes("(");
        const text = d3.select(this);
        text.text(null);

        // Dense graphs: put the label BELOW the node in dark text with a white
        // halo. Inside-the-node white text needs a radius the data doesn't
        // justify, and shrinking it to fit is what produced 9px three-line
        // labels nobody can read.
        if (denseLabels && !d.isSpecial) {
          const r = radiusMap[d.id] || 20;
          const m = label.match(/^([^\(]+)\((.*)\)$/);
          const verb = m ? m[1] : label;
          const noun = m ? m[2] : "";
          text.attr("font-size", "11px")
              .attr("font-weight", "600")
              .attr("fill", "#1f2937")
              .attr("stroke", "#ffffff")
              .attr("stroke-width", 3)
              .attr("paint-order", "stroke")
              .attr("y", r + 12);
          text.append("tspan").attr("x", 0).text(verb);
          if (noun) {
            text.append("tspan").attr("x", 0).attr("dy", "1.05em")
                .attr("font-weight", "400").text(noun);
          }
          return;
        }

        if (isHybridSplit) {
          const match = label.match(/^([^\(]+)\((.*)\)$/);
          const verbPart = match ? match[1] : label.split("(")[0];
          const nounPart = match ? match[2] : label.split("(")[1].replace(")", "");
          
          // Track the total number of lines to calculate vertical centering
          let totalLines = 1; 

          // 1. Render the Verb (Bold, Top row) - we will set its Y position later!
          const verbTspan = text.append("tspan")
            .attr("x", 0)
            .attr("font-weight", "900")
            .text(verbPart);

          // 2. Setup Word Wrapping for the Noun
          const r = radiusMap[d.id] || 34;
          const maxWidth = r * 1.7; // Constrain text to 85% of diameter
          const words = nounPart.split(/\s+/);
          let line = [];
          
          let tspan = text.append("tspan")
            .attr("x", 0).attr("dy", "1.2em") 
            .attr("font-weight", "500");
            
          totalLines++;

          // 3. Loop through words and measure width
          words.forEach(word => {
            line.push(word);
            tspan.text(line.join(" "));
            
            if (tspan.node().getComputedTextLength() > maxWidth && line.length > 1) {
              line.pop(); 
              tspan.text(line.join(" ")); 
              
              line = [word]; 
              tspan = text.append("tspan")
                .attr("x", 0).attr("dy", "1.1em") 
                .attr("font-weight", "500")
                .text(word);
                
              totalLines++; // Increment our line counter!
            }
          });
          
          // 4. Vertically Center the Entire Block
          // Standard offset for 2 lines is -0.2em.
          // For every extra line, we pull the first line UP by 0.55em (half a line height)
          const startDy = -0.2 - ((totalLines - 2) * 0.55);
          verbTspan.attr("dy", `${startDy}em`);
          
        } else {
          text
            .attr("textLength", Math.max(20, (radiusMap[d.id] || 18) * 1.55))
            .attr("lengthAdjust", "spacingAndGlyphs")
            .text(label);
        }
      });

    // The label block below a node is one or two lines tall (verb, then noun
    // when there is one). The subtitle has to clear whichever it is, or it
    // prints on top of the label — which is what it was doing.
    const LABEL_LINE_H = 12;
    nodeGroups.append("text")
      .attr("class", "node-subtitle")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => {
        const r = radiusMap[d.id] || 18;
        const label = nodeLabels.get(d.id) || d.id;
        const hasNoun = /^[^(]+\(.*\)$/.test(label);
        return r + 12 + (hasNoun ? 2 : 1) * LABEL_LINE_H;
      })
      .attr("font-size", "9px")
      .attr("font-style", "italic")
      .attr("fill", "#94a3b8")
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 2.5)
      .attr("paint-order", "stroke")
      .attr("opacity", (d) => d.__bg ? 0 : 1)
      .attr("pointer-events", "none")
      .text((d) => getNodeSubtitle(d, currentMode));

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
        const touches = (link) =>
          endId(link.source) === d.id || endId(link.target) === d.id;
        svg.selectAll(".link")
          .filter(touches)
          .attr("d", link => {
            return pathForCache ? pathForCache(link)
              : getStraightPath(link, layout, radiusMapCache);
          });
        // The invisible label paths have to move with the edges, or the
        // probabilities stay behind where the edge used to be.
        svg.selectAll("path[id^='lpath-']")
          .filter(touches)
          .attr("d", link => labelPathForCache ? labelPathForCache(link)
            : getStraightPath(link, layout, radiusMapCache));
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

    // Self-loops are drawn the same way at every level: a small arc on top of
    // the node with its probability beside it. This used to be gated on the
    // mode, so Level 2 showed an arc with a number while Level 1 showed a bare
    // "⟳" glyph with no probability at all — the same fact, told two ways, in
    // one dashboard.
    if (true) {
      // The arc is a CHILD of the node group, so its mouse events bubbled up
      // to the node's handler and the node tooltip won every time. The arc
      // therefore needs its own handler AND stopPropagation, or the two fire
      // together and the last one to write wins.
      const loopInfo = {};
      const loopDatum = {};
      selfLoopSummary.forEach((d) => {
        if (isSpecialId(d.source)) return;
        loopInfo[d.source] = (typeof d.probability === "number") ? d.probability : null;
        loopDatum[d.source] = d;
      });

      const loopNodes = nodeGroups.filter((d) => d.id in loopInfo);
      const loopArc = loopNodes.append("path")
        .attr("class", "self-loop-arc")
        .attr("d", (d) => {
          const r = radiusMap[d.id] || 18;
          return `M ${-r * 0.5} ${-r * 0.85} A ${r * 0.55} ${r * 0.55} 0 1 1 ${r * 0.5} ${-r * 0.85}`;
        })
        .attr("fill", "none")
        // Same grey as every other edge. Red was reading as a warning: a node
        // that repeats itself is a normal observation, not an error.
        .attr("stroke", "#94a3b8")
        .attr("stroke-width", 2)
        .attr("marker-end", markerUrl("arrow"))
        // A 2px line is hard to hit, so widen the target without widening
        // the ink.
        .style("pointer-events", "stroke")
        .style("stroke-linecap", "round");

      loopNodes.insert("path", ".self-loop-arc")
        .attr("class", "self-loop-hit")
        .attr("d", (d) => {
          const r = radiusMap[d.id] || 18;
          return `M ${-r * 0.5} ${-r * 0.85} A ${r * 0.55} ${r * 0.55} 0 1 1 ${r * 0.5} ${-r * 0.85}`;
        })
        .attr("fill", "none")
        .attr("stroke", "transparent")
        .attr("stroke-width", 14)
        .style("pointer-events", "stroke");

      loopNodes.selectAll(".self-loop-arc, .self-loop-hit")
        .on("mouseover", function (event) {
          event.stopPropagation();
          hideNodeTooltip();
          const parent = d3.select(this.parentNode).datum();
          const sl = loopDatum[parent.id];
          if (sl) showEdgeTooltip(event, sl);
        })
        .on("mousemove", function (event) { event.stopPropagation(); })
        .on("mouseout", function (event) {
          event.stopPropagation();
          hideEdgeTooltip();
        });

      loopNodes.append("text")
        .attr("class", "self-loop-prob")
        .attr("y", (d) => -(radiusMap[d.id] || 18) - 10)
        .attr("text-anchor", "middle")
        .attr("font-size", "12px")
        .attr("font-weight", "bold")
        .attr("fill", "#64748b")
        .attr("stroke", "#ffffff")
        .attr("stroke-width", 3)
        .attr("paint-order", "stroke")
        .attr("pointer-events", "none")
        .text((d) => (loopInfo[d.id] !== null ? loopInfo[d.id].toFixed(2) : ""));
    } else {
      const selfLoopIndicators = zoomGroup
        .append("g").attr("class", "self-loop-indicators")
        .selectAll("g.self-loop-indicator")
        .data(selfLoopSummary.filter((d) => !isSpecialId(d.source)))
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
    }
    
    nodeGroups
      .on("mouseover", function(event, d) {
        showNodeTooltip(event, d, currentMode);
        linkSelection.attr("stroke-opacity", 0.05).attr("stroke-width", 0.5);
        linkSelection
          .filter(link => link.source === d.id || link.target === d.id)
          .attr("stroke-opacity", link => baseEdgeOpacityFn ? baseEdgeOpacityFn(link) : 0.65)
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
        hideEdgeTooltip();
        applyHighlightState();
      })
      .on("click", function(event, d) {
        if (d.__dragMoved) { d.__dragMoved = false; return; }
        selectedNodeId = d.id;
        if (options.onNodeClick) options.onNodeClick(d, currentSequenceCache, event);
      });

    // ─────────────────────────────────────────────────────────────────────────
    // Render ledger — states on-canvas exactly what this view is showing and
    // what it is de-emphasising. Appended to the svg, not the zoom group, so it
    // stays put while panning. `weakEdges` was previously counted and silently
    // discarded; nothing told the viewer that edges had been removed at all.
    // ─────────────────────────────────────────────────────────────────────────
    // Labels are measured only after every edge and node exists, because a
    // label's candidate positions are read off the geometry that is actually
    // on the canvas. Level 1 is skipped by the maxLabels guard: at 311 edges
    // the pass costs more than it buys, and Prof. Lin has excluded that level.
    declutterEdgeLabels(gLinks, { maxLabels: 120 });

    if (animate) {
      zoomGroup.attr("opacity", 0)
        .transition().duration(420).ease(d3.easeCubicOut)
        .attr("opacity", 1);

      // Circles grow into place, so the arrival of a level reads as a change
      // rather than as a flash.
      zoomGroup.selectAll("circle.node-body")
        .attr("r", (d) => (radiusMap[d.id] || 18) * 0.55)
        .transition().duration(420).ease(d3.easeCubicOut)
        .attr("r", (d) => radiusMap[d.id] || 18);

      if (fadingOut) {
        fadingOut.transition().duration(300).ease(d3.easeCubicIn)
          .attr("opacity", 0)
          .on("end", function () { d3.select(this).remove(); });
      }
    }

    svg.selectAll(".render-ledger").remove();
    const isolated = filteredNodes.filter((n) =>
      !enrichedLinks.some((l) => l.source === n.id || l.target === n.id)
    ).length;

    // Scope provenance, read from the payload the pipeline shipped.
    let scopeInfo = null;
    const fr = (graph && graph.__filterReport) || null;
    if (fr && fr.scope_comparison && fr.scope_mode) {
      const c = fr.scope_comparison[fr.scope_mode];
      if (c) {
        scopeInfo = `scope: ${fr.scope_mode} — ${c.actions_kept}/${c.actions_total} ` +
                    `actions kept (${Math.round(c.kept_fraction * 100)}%)`;
      }
    }
    const mr = (graph && graph.__macroReport) || null;

    const ledger = svg.append("g").attr("class", "render-ledger");
    const ledgerLines = [
      `${filteredNodes.length} nodes · ${enrichedLinks.length} edges — every observed transition drawn`,
      `${forwardEdges.length} forward · ${returnEdges.length} return · ${selfLoops.length} self-loop`,
      weakEdges > 0
        ? `${weakEdges} edge${weakEdges === 1 ? "" : "s"} below P<${WEAK_EDGE_PROB} shown faded`
        : `no edges below P<${WEAK_EDGE_PROB}`,
      `${isolated} isolated node${isolated === 1 ? "" : "s"}` +
        (usedRankData ? " · direction from sequence rank" : " · direction from layout (legacy payload)"),
    ];


    const nIntroduced = enrichedLinks.filter((l) => l.is_introduced).length;
    if (nBackground > 0) {
      ledgerLines.push(
        `${filteredNodes.length - nBackground} in focus · ${nBackground} dimmed ` +
        `(support < ${supportFilter}) — hover to reveal`
      );
    }
    if (nMinor > 0) {
      ledgerLines.push(
        `${enrichedLinks.length - nMinor} main transitions · ${nMinor} secondary ` +
        `dimmed — hover an edge for its probability`
      );
    }
    ledgerLines.push(
      nIntroduced > 0
        ? `${nIntroduced} fabricated edge${nIntroduced === 1 ? "" : "s"} — never observed consecutively`
        : `0 fabricated edges — every transition was observed`
    );
    if (scopeInfo) ledgerLines.push(scopeInfo);

    // ── Macro provenance ─────────────────────────────────────────────────────
    // Three claims the reader is entitled to, in the order they matter:
    //   1. how much of the data is folded away and still reachable
    //   2. how much evidence the probabilities rest on
    //   3. whether pooling across sessions was possible at all
    // Point 2 is the honest one. Per session, 70-93% of macro edges are seen
    // once; a viewer who does not know that will read P = 1.00 as certainty.
    if (isMacro && mr && mr.usable !== false) {
      const a = mr.actions || {};
      const e = mr.edges || {};
      if (a.spine !== undefined) {
        ledgerLines.push(
          `main steps: ${a.spine} of ${a.in_scope} actions drawn as nodes · ` +
          `${a.bridge || 0} folded onto edges, none deleted`
        );
      }
      if (e.count) {
        ledgerLines.push(
          `evidence: ${e.weak_evidence}/${e.count} edges seen once ` +
          `(${Math.round(e.weak_evidence_fraction * 100)}%) — ` +
          `dotted edges are not reliable`
        );
      }
      ledgerLines.push(
        mr.evidence_basis === "cross_session"
          ? `probabilities pooled across ${mr.n_sessions} sessions`
          : `one session only — probabilities are provisional`
      );
      if (expandedEdges && expandedEdges.size > 0) {
        ledgerLines.push(
          `${expandedEdges.size} edge${expandedEdges.size === 1 ? "" : "s"} opened — ` +
          `click again to fold back`
        );
      }
    }
    ledgerLines.forEach((line, i) => {
      ledger.append("text")
        .attr("x", 12)
        .attr("y", height - 12 - (ledgerLines.length - 1 - i) * 13)
        .attr("font-size", "10px")
        .attr("fill", i === 3 && isolated > 0 ? "#b91c1c" : "#64748b")
        .attr("pointer-events", "none")
        .text(line);
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
    // A self-loop is a repeat, not a transition to somewhere else, so the
    // generic "A → B" wording reads as nonsense on it. It gets its own short
    // tooltip and returns before the transition logic runs.
    if (d && (d.source === d.target || d.is_self_loop)) {
      const t = document.getElementById("edgeTooltip");
      const p = (typeof d.probability === "number")
        ? d.probability.toFixed(2) : null;
      const rows = [
        `${d.source} → itself`,
        `Repeated ${d.count || 1} time${(d.count || 1) === 1 ? "" : "s"}`,
      ];
      if (p !== null) {
        rows.push(`P(do it again next) = ${p}`);
      }
      rows.push("The next action was the same action.");
      t.innerHTML = rows
        .map((line) => String(line).replace(/&/g, "&amp;").replace(/</g, "&lt;"))
        .join("<br>");
      t.style.display = "block";
      t.style.left = (event.clientX + 12) + "px";
      t.style.top = (event.clientY - 10) + "px";
      return;
    }

    const totalOutgoing = enrichedLinksFullCache
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

    // ── MACRO EDGE ──────────────────────────────────────────────────────────
    // Deliberately a different tooltip, not the micro one with extra lines.
    // The two answer different questions and the wording has to say which:
    //   micro  P(next action | current action)      "what does the hand do next"
    //   macro  P(next main step | current main step) "what is the next step"
    // The probability NEVER appears without its denominator, because 93% of
    // per-session macro edges rest on a single observation.
    if (d.n_out !== undefined || d.is_bridged || d.is_bridge_edge) {
      const lines = [];

      if (d.is_bridge_edge) {
        lines.push(`${d.source.split("::").pop()} → ${d.target.split("::").pop()}`);
        lines.push(`Part of an opened run. Click to close it.`);
      } else {
        lines.push(`${d.source} → ${d.target}`);
        lines.push(`Chance the next main step is ${d.target}:`);
        lines.push(`  ${formatProbability(d)}`);
        if (d.evidence === "weak") {
          lines.push(`  Seen once — this number is not reliable yet.`);
        }
        if (typeof d.p_laplace === "number") {
          lines.push(`  Smoothed estimate: ${d.p_laplace.toFixed(2)}`);
        }
        lines.push(``);
        lines.push(`In between: ${formatBridge(d)}`);
        if (d.is_bridged) {
          const hidden = d.bridge_raw_actions || d.bridge_actions || {};
          const top = Object.entries(hidden)
            .sort((a, b) => b[1] - a[1]).slice(0, 6);
          top.forEach(([a, c]) => lines.push(`  ${a} × ${c}`));
          const more = Object.keys(hidden).length - top.length;
          if (more > 0) lines.push(`  … and ${more} more`);
          lines.push(``);
          lines.push(`Wait before the next step: ${d.gap_s_median}s ` +
                     `(${d.gap_s_min}–${d.gap_s_max}s)`);
          lines.push(`Click the edge to open it.`);
        }
        if (d.support !== undefined && d.n_sessions !== undefined && d.n_sessions > 1) {
          lines.push(`Seen in ${d.support} of ${d.n_sessions} sessions`);
        }
      }

      tooltip.textContent = lines.join("\n");
      tooltip.style.display = "block";
      tooltip.style.left = (event.clientX + 12) + "px";
      tooltip.style.top = (event.clientY - 10) + "px";
      return;
    }

    // ── MICRO EDGE (unchanged) ──────────────────────────────────────────────
    const st = edgeStats(d);
    const scopePct = st.scoped
      ? (() => { const o = (enrichedLinksFullCache || [])
            .filter(l => endId(l.source) === endId(d.source))
            .reduce((s, l) => s + Number((l.per_session_counts || {})[activeSessionForStats] ||
                                         (l.per_session_counts || {})[String(activeSessionForStats)] || 0), 0);
          return o > 0 ? (st.count / o * 100).toFixed(0) : "0"; })()
      : pct;
    let txt = `${d.source} → ${d.target}`;
    txt += st.scoped ? `\nSession ${activeSessionForStats + 1} only` : `\nAll sessions`;
    txt += `\nCount: ${st.count} (${scopePct}% of outgoing)`;
    if (typeof st.probability === "number") {
      txt += `\nP(${d.target} | ${d.source}) = ${st.probability.toFixed(2)}`;
    }
    if (!st.scoped && d.support !== undefined && d.n_sessions !== undefined) {
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
    const escapeHtml = (value) => String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
    // The lines the old native <title> used to show. They are the newer, more
    // readable set, so they lead. Anything below adds to them; nothing repeats
    // them, which is what made the two overlapping boxes so confusing.
    const lines = (d.__summary && d.__summary.length)
      ? [...d.__summary]
      : [`${d.id}`, `Count: ${d.count}`];

    if (!d.__summary && d.support !== undefined && d.n_sessions !== undefined) {
      lines.push(`Support: ${d.support}/${d.n_sessions} sessions`);
      // per_session_counts is an array in session payloads and an object in
      // merged ones. Calling .join() on the object threw and killed the whole
      // tooltip, silently, for exactly the view people look at most.
      const psc = d.per_session_counts;
      if (Array.isArray(psc)) {
        lines.push(`Per session: [${psc.join(", ")}]`);
      } else if (psc && typeof psc === "object") {
        lines.push("Per session: " + Object.entries(psc)
          .map(([s, n]) => `S${Number(s) + 1}:${n}`).join("  "));
      }
    }
    if (d.is_bridge_node) {
      lines.length = 0;
      lines.push(`${d.label || d.id}`);
      lines.push(`One of the actions folded under this edge.`);
      lines.push(`Happened ${d.count} time${d.count === 1 ? "" : "s"} on this route.`);
      const t = document.getElementById("nodeTooltip");
      t.innerHTML = lines.map((line) => escapeHtml(line)).join("<br>");
      t.style.display = "block";
      t.style.left = (event.clientX + 12) + "px";
      t.style.top = (event.clientY - 10) + "px";
      return;
    }
    if (d.role === "spine") {
      lines.push(`A main step — it changes the food.`);
      if (d.mean_duration_s !== undefined) {
        lines.push(`Takes about ${d.mean_duration_s}s`);
      }
      // The number a collaborating robot actually needs.
      if (d.mean_gap_out_s) {
        lines.push(`Then about ${d.median_gap_out_s}s of fetching and moving ` +
                   `before the next main step`);
      }
      if (d.parameters && Object.keys(d.parameters).length > 0) {
        const p = Object.entries(d.parameters)
          .sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([a, c]) => `  ${a} × ${c}`).join("\n");
        lines.push(`Checked for doneness by:\n${p}`);
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

    // The summary already lists the top verbs and objects. Printing them again
    // in a second format is what made the tooltip look like two stacked boxes
    // even after the native one was removed.
    if (!d.__summary) {
      if (d.verbs && Object.keys(d.verbs).length > 0) {
        const sortedVerbs = Object.entries(d.verbs).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const verbList = sortedVerbs.map(([v, c]) => `  ${v}: ${c}`).join("\n");
        lines.push(`Verbs:\n${verbList}`);
      }
      if (d.objects && Object.keys(d.objects).length > 0) {
        const sortedObjects = Object.entries(d.objects).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const objectList = sortedObjects.map(([o, c]) => `  ${o}: ${c}`).join("\n");
        lines.push(`Objects:\n${objectList}`);
      }
    }
    if (d.step_label) lines.push(`Step: ${d.step_label}`);
    if (d.step_text) lines.push(`Step text: ${d.step_text}`);

    const tooltip = document.getElementById("nodeTooltip");
    let html = lines.map((line) => escapeHtml(line)).join("<br>");

    // What is inside this episode. The label names only the goal action;
    // these are the support actions that served it.
    if (d.verb_categories && Object.keys(d.verb_categories).length) {
      const total = Object.values(d.verb_categories).reduce((a, b) => a + b, 0);
      const rows = Object.entries(d.verb_categories)
        .slice(0, 5)
        .map(([cat, n]) => {
          const pct = Math.round((n / total) * 100);
          const bar = "█".repeat(Math.max(1, Math.round(pct / 8)));
          const isGoal = cat === d.head_verb_category;
          return `<div style="font-family:monospace;font-size:11px;
                  ${isGoal ? "font-weight:700;color:#0f172a;" : "color:#64748b;"}">
                  ${escapeHtml(cat).padEnd(11)} ${bar} ${pct}%${isGoal ? " ← goal" : ""}</div>`;
        }).join("");
      html += `<div style="margin-top:8px;border-top:1px solid #e2e8f0;padding-top:6px;">
               <div style="font-size:11px;color:#475569;margin-bottom:3px;">
               Contains ${d.mean_members} actions on average:</div>${rows}</div>`;
    }

    if (d.object_categories) {
      const objs = Object.entries(d.object_categories).slice(0, 3)
        .map(([o]) => escapeHtml(o)).join(", ");
      html += `<div style="font-size:11px;color:#64748b;margin-top:4px;">
               Acts on: ${objs}</div>`;
    }

    tooltip.innerHTML = html;
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
        .attr("marker-end", (d) => (d && (d.key === activeEdge || d.pairKey === activeEdge) ? markerUrl("arrowActive") : markerUrl("arrow")));
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Dynamic Highlight Functions
  // ─────────────────────────────────────────────────────────────────────────────

  function highlightSession(sessionIndex) {
    if (sessionIndex === null || sessionIndex === undefined || sessionIndex === "Merged") {
      activeSessionForStats = null;
      activeHighlight = null;
      resetHighlight();
      return;
    }
    activeSessionForStats = sessionIndex;
    activeHighlight = { type: 'session', value: sessionIndex };
    applyHighlightState();
  }

  function highlightSpine(canonicalArray) {
    activeSessionForStats = null;
    if (!canonicalArray || canonicalArray.length === 0) {
      activeHighlight = null;
      resetHighlight();
      return;
    }
    activeHighlight = { type: 'spine', value: canonicalArray };
    applyHighlightState();
  }

  function clearHighlight() {
    activeSessionForStats = null;
    activeHighlight = null;
    resetHighlight();
  }

  // ───────────────────────────────────────────────────────────────────────
  // edgeStats
  //
  // count, probability and support on a merged link describe ALL sessions.
  // While one session is highlighted the reader is looking at one run, so
  // "n=2, support 2/3" answers a question they did not ask and reads as an
  // error. When a session is active these are recomputed from
  // per_session_counts, renormalised over that session's own outgoing edges.
  // ───────────────────────────────────────────────────────────────────────
  function edgeStats(d) {
    const i = activeSessionForStats;
    if (i === null || !d || !d.per_session_counts) {
      return { count: d.count, probability: d.probability,
               support: d.support, nSessions: d.n_sessions, scoped: false };
    }
    const c = Number(d.per_session_counts[i] || d.per_session_counts[String(i)] || 0);
    const out = (enrichedLinksFullCache || [])
      .filter((l) => l.source === d.source)
      .reduce((sum, l) => sum + Number(
        (l.per_session_counts || {})[i] ||
        (l.per_session_counts || {})[String(i)] || 0), 0);
    return { count: c, probability: out > 0 ? c / out : 0,
             support: c > 0 ? 1 : 0, nSessions: 1, scoped: true };
  }

  function refreshProbLabels() {
    if (typeof currentProbLabel !== "function") return;
    svg.selectAll("text.prob-label textPath").text((d) => currentProbLabel(d));
  }

  function applyHighlightState() {
    refreshProbLabels();
    if (!activeHighlight) {
      resetHighlight();
      return;
    }

    if (activeHighlight.type === 'session') {
      const sessionIndex = activeHighlight.value;
      const palette = typeof SESSION_PALETTE !== 'undefined' ? SESSION_PALETTE : ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"];
      const color = palette[sessionIndex % palette.length];

      nodeSelection.each(function(d) {
        const isActive = d.per_session_counts && d.per_session_counts[sessionIndex] > 0;
        const el = d3.select(this);
        el.style("opacity", isActive ? 1.0 : 0.28);

        if (isActive && !d.isSpecial) {
          el.select("circle:not(.selection-ring):not(.mandatory-ring):not(.dead-end-ring)")
            .style("fill", color)
            .style("stroke", d.salient ? "#1e293b" : "none")
            .style("stroke-width", d.salient ? 2.5 : 0);
        } else if (!isActive && !d.isSpecial) {
          const colorFn = currentExternalColorFn ? (n) => n.isSpecial ? "#d1d5db" : currentExternalColorFn(n.id) : makeNodeColorFn(currentFilteredNodes, currentSequenceCache, lastColorMode, lastMode);
          el.select("circle:not(.selection-ring):not(.mandatory-ring):not(.dead-end-ring)")
            .style("fill", colorFn(d))
            .style("stroke", d.salient ? "#1e293b" : "none")
            .style("stroke-width", d.salient ? 2.5 : 0);
        }
      });

      linkSelection.each(function(d) {
        const isActive = d.per_session_counts && d.per_session_counts[sessionIndex] > 0;
        const el = d3.select(this);
        // 0.05 was effectively invisible, so a node whose edges were all
        // off-selection looked isolated. Context should stay readable as
        // context — visible, clearly secondary.
        el.style("opacity", isActive ? 1.0 : 0.22);
        el.style("stroke", isActive ? color : null);
        el.style("stroke-width", edgeWidthScale(edgeMetricFn(d)));
      });

      svg.selectAll("#zoomGroup .edge-prob-text").style("opacity", function(d) {
        const isActive = d.per_session_counts && d.per_session_counts[sessionIndex] > 0;
        return isActive ? 1.0 : 0.05;
      });

      if (selfLoopSelection) {
        selfLoopSelection.style("opacity", function(d) {
          const nData = currentFilteredNodes.find(n => n.id === d.source);
          const isActive = nData && nData.per_session_counts && nData.per_session_counts[sessionIndex] > 0;
          return isActive ? 1.0 : 0.05;
        });
      }
      svg.selectAll("#zoomGroup .self-loop-arc, #zoomGroup .self-loop-prob").style("opacity", function(d) {
        const isActive = d.per_session_counts && d.per_session_counts[sessionIndex] > 0;
        return isActive ? 1.0 : 0.05;
      });

    } 
    else if (activeHighlight.type === 'spine') {
      // The value is the ordered PATH, not a set: order is what lets an edge be
      // recognised as "step i to step i+1" rather than merely "both ends are on
      // the spine". Without that, any edge between two spine nodes lit up, and
      // the highlighted route grew extra branches it never had.
      const path = activeHighlight.value || [];
      const tierOf = new Map();
      path.forEach((p) => {
        const id = p.id !== undefined ? p.id : p;
        const tier = p.tier || "spine";
        // A node visited twice keeps the stronger tier.
        if (tierOf.get(id) !== "spine") tierOf.set(id, tier);
      });
      const ids = path.map((p) => (p.id !== undefined ? p.id : p));
      const pathEdges = new Set();
      for (let i = 0; i < ids.length - 1; i++) {
        pathEdges.add(ids[i] + "|||" + ids[i + 1]);
      }

      const SPINE_STROKE = "#B8362A";     // the finding
      const CONNECT_STROKE = "#C99B93";   // the glue

      nodeSelection.each(function (d) {
        const tier = tierOf.get(d.id);
        const onPath = tier !== undefined;
        const el = d3.select(this);
        el.style("opacity", onPath ? 1.0 : 0.14);

        // ── THIS IS THE FIX FOR THE CLUTTER ──────────────────────────────────
        // Previously off-path foreground nodes kept full-strength labels, so a
        // 26-node graph still showed ~26 labels behind the highlighted path.
        // Under a highlight only the path is named. Everything else is shape.
        el.select("text.node-label").attr("opacity", onPath ? 1 : 0);

        const colorFn = currentExternalColorFn
          ? (n) => n.isSpecial ? "#d1d5db" : currentExternalColorFn(n.id)
          : makeNodeColorFn(currentFilteredNodes, currentSequenceCache,
                            lastColorMode, lastMode);

        if (d.isSpecial) return;
        const circle = el.select(
          "circle:not(.selection-ring):not(.mandatory-ring):not(.dead-end-ring)");
        circle.style("fill", colorFn(d));
        if (tier === "spine") {
          circle.style("stroke", SPINE_STROKE).style("stroke-width", 3.5);
        } else if (tier === "connector") {
          // Dashed ring: on the route, but not part of what every session did.
          circle.style("stroke", CONNECT_STROKE)
                .style("stroke-width", 2.5)
                .style("stroke-dasharray", "4 3");
        } else {
          circle.style("stroke", "none").style("stroke-width", 0)
                .style("stroke-dasharray", null);
        }
      });

      linkSelection.each(function (d) {
        const isActive = pathEdges.has(d.key) || pathEdges.has(d.pairKey);
        const el = d3.select(this);
        // Same reason as the session view: at 0.06 an off-pattern edge is
        // invisible, so its nodes read as isolated rather than as context.
        el.style("opacity", isActive ? 1.0 : 0.22);
        if (isActive) {
          const bothSpine = tierOf.get(d.source) === "spine"
                         && tierOf.get(d.target) === "spine";
          el.style("stroke", bothSpine ? SPINE_STROKE : CONNECT_STROKE)
            .style("stroke-width", edgeWidthScale(edgeMetricFn(d)) + 2);
          this.parentNode.appendChild(this);
        } else {
          el.style("stroke", null)
            .style("stroke-width", edgeWidthScale(edgeMetricFn(d)));
        }
      });

      // Every text layer that rides on an edge has to be listed here. The
      // probability label was handled before; the bridge badge was not, which
      // is why "+7 · 8s" stayed dark over a dimmed graph.
      const onPathEdge = (d) =>
        d && (pathEdges.has(d.key) || pathEdges.has(d.pairKey));
      svg.selectAll("#zoomGroup .edge-prob-text")
        .style("opacity", (d) => onPathEdge(d) ? 1.0 : 0.18);
      svg.selectAll("#zoomGroup .bridge-count-text")
        .style("opacity", (d) => onPathEdge(d) ? 0.9 : 0);
      svg.selectAll("#zoomGroup .edge-gap-text")
        .style("opacity", (d) => onPathEdge(d) ? 0.9 : 0);

      if (selfLoopSelection) {
        selfLoopSelection.style("opacity", function(d) {
          const isActive = spineEdges.has(d.key);
          return isActive ? 1.0 : 0.05;
        });
      }
      svg.selectAll("#zoomGroup .self-loop-arc, #zoomGroup .self-loop-prob").style("opacity", function(d) {
        const k = `${d.id}|||${d.id}`;
        const isActive = spineEdges.has(k);
        return isActive ? 1.0 : 0.05;
      });
    }
  }

  function resetHighlight() {
    // Back to the merged view: the edge labels must go back to merged numbers.
    activeSessionForStats = null;
    refreshProbLabels();
    if (!nodeSelection || !linkSelection) return;
    
    nodeSelection.each(function(d) {
      const el = d3.select(this);
      el.style("opacity", d.__bg ? BG_NODE_OPACITY
                                 : (isSecondaryNode(d) ? 0.55 : 1.0));
      el.select("text.node-label").attr("opacity", d.__bg ? 0 : 1);
      
      const colorFn = currentExternalColorFn
        ? (n) => n.isSpecial ? "#d1d5db" : currentExternalColorFn(n.id)
        : makeNodeColorFn(currentFilteredNodes, currentSequenceCache, lastColorMode, lastMode);
        
      el.select("circle:not(.selection-ring):not(.mandatory-ring):not(.dead-end-ring)")
        .style("fill", colorFn(d))
        .style("stroke", d.salient ? "#1e293b" : "none")
        .style("stroke-width", d.salient ? 2.5 : 0);
    });

    linkSelection.each(function(d) {
      const el = d3.select(this);
      el.style("stroke", null)
        .style("stroke-width", edgeWidthScale(edgeMetricFn(d)));
        
      if (baseEdgeOpacityFn) {
        el.style("opacity", baseEdgeOpacityFn(d));
      } else {
        el.style("opacity", d.__bg ? 0.12 : 0.65);
      }
    });

    svg.selectAll("#zoomGroup .edge-prob-text")
       .style("opacity", (d) => (d && d.__bg) ? 0 : 1.0);
    if (selfLoopSelection) selfLoopSelection.style("opacity", 1.0);
    svg.selectAll("#zoomGroup .self-loop-arc, #zoomGroup .self-loop-prob").style("opacity", 1.0);
  }

  return { buildGraph, updateActive, setAutoZoom, resetLayout, highlightSession, highlightSpine, clearHighlight };
}