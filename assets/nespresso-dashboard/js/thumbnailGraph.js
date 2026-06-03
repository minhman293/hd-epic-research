// thumbnailGraph.js
//
// A simplified, instance-scoped motion-graph renderer for the small-multiples
// view in comparison mode. Does NOT support drag, node click, occurrence
// cycling, or auto-zoom-during-playback. It renders a static (zoom/pan-able)
// view that fits the SVG once.
//
// Why a separate file: the existing graph.js was designed for one singleton
// graph on the page. Adding three full-featured graphs side by side would
// require refactoring graph.js's global d3.selectAll(".node") calls. This
// renderer uses .thumb-node so it doesn't collide.
//
// Public API:
//   buildThumbnailGraph(svgEl, graph, sequence, options) → { destroy() }
//
//   graph:    { nodes, links }
//   sequence: session's sequence array (used for layout's mean onset)
//   options:  { colorFn, mode }

const d3 = window.d3;

function isSecondary(node) {
  if (!node) return false;
  if (node.isSpecial) return false;
  if (node.is_primary === undefined) return false;
  return node.is_primary === false;
}

function computeTemporalLayout(nodes, sequence, { maxRadius = 14 } = {}) {
  const onsetMap = {};
  sequence.forEach((item) => {
    if (!onsetMap[item.action]) onsetMap[item.action] = [];
    onsetMap[item.action].push(item.start);
  });

  const totalDuration = sequence[sequence.length - 1]?.end || 1;
  const meanOnset = {};
  nodes.forEach((n) => {
    const times = onsetMap[n.id] || [0];
    meanOnset[n.id] = times.reduce((s, v) => s + v, 0) / times.length;
  });

  const CANVAS_WIDTH = 1100;
  const xScale = d3.scaleLinear().domain([0, totalDuration]).range([0, CANVAS_WIDTH]);

  const BUCKET_PX = 70;
  const yStep = Math.max(54, Math.round(maxRadius * 2.4));

  const primaryBuckets = {};
  const secondaryBuckets = {};
  nodes.forEach((n) => {
    const rawX = xScale(meanOnset[n.id] || 0);
    const bucketKey = Math.round(rawX / BUCKET_PX) * BUCKET_PX;
    const target = isSecondary(n) ? secondaryBuckets : primaryBuckets;
    if (!target[bucketKey]) target[bucketKey] = [];
    target[bucketKey].push(n.id);
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
  const LANE_GAP = 80;
  const secondaryLaneTop = primaryBottom + LANE_GAP;

  Object.entries(secondaryBuckets).forEach(([k, ids]) => {
    const sorted = [...ids].sort((a, b) => (meanOnset[a] || 0) - (meanOnset[b] || 0));
    sorted.forEach((id, idx) => {
      layout[id] = { x: Number(k), y: secondaryLaneTop + idx * yStep };
    });
  });

  return { layout, totalDuration, xScale };
}

function getStraightPath(link, layout, radiusMap) {
  const s = layout[link.source] || { x: 0, y: 0 };
  const t = layout[link.target] || { x: 0, y: 0 };
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / dist;
  const ny = dy / dist;
  const x1 = s.x + nx * (radiusMap[link.source] || 14);
  const y1 = s.y + ny * (radiusMap[link.source] || 14);
  const x2 = t.x - nx * ((radiusMap[link.target] || 14) + 2);
  const y2 = t.y - ny * ((radiusMap[link.target] || 14) + 2);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 - 6;
  return `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
}

export function buildThumbnailGraph(svgEl, graph, sequence, options = {}) {
  const colorFn = options.colorFn || (() => "#94A3B8");
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  if (!graph.nodes || graph.nodes.length === 0) {
    return { destroy() { svg.selectAll("*").remove(); } };
  }

  const width = svgEl.clientWidth || 700;
  const height = svgEl.clientHeight || 200;
  svg.attr("width", width).attr("height", height);

  // Unique marker ID per-instance so multiple thumbnails don't collide
  const uid = `tg-${Math.random().toString(36).slice(2, 9)}`;
  const defs = svg.append("defs");
  defs.append("marker")
    .attr("id", `arrow-${uid}`)
    .attr("viewBox", "0 -4 10 8")
    .attr("refX", 9).attr("refY", 0)
    .attr("markerWidth", 4).attr("markerHeight", 4)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-4L10,0L0,4Z")
    .attr("fill", "#94a3b8");

  const zoomGroup = svg.append("g").attr("class", "thumb-zoom-group");

  const { layout, totalDuration } = computeTemporalLayout(graph.nodes, sequence, { maxRadius: 14 });

  // Radius scale
  const maxCount = d3.max(graph.nodes, (d) => d.count || 1) || 1;
  const radiusScale = d3.scaleSqrt().domain([1, Math.max(maxCount, 2)]).range([9, 18]);
  const radiusMap = {};
  graph.nodes.forEach((d) => { radiusMap[d.id] = radiusScale(d.count || 1); });

  // Edge widths
  const maxLink = d3.max(graph.links, (d) => d.count || 1) || 1;
  const edgeWidth = d3.scaleSqrt().domain([1, Math.max(maxLink, 2)]).range([0.4, 2.5]);
  const edgeOpacity = d3.scaleLinear().domain([1, Math.max(maxLink, 2)]).range([0.15, 0.6]);

  // Edges
  zoomGroup.append("g")
    .selectAll("path.thumb-link")
    .data(graph.links.filter((l) => layout[l.source] && layout[l.target]))
    .enter()
    .append("path")
    .attr("class", "thumb-link")
    .attr("d", (d) => getStraightPath(d, layout, radiusMap))
    .attr("stroke", "#94a3b8")
    .attr("stroke-width", (d) => edgeWidth(d.count || 1))
    .attr("stroke-opacity", (d) => edgeOpacity(d.count || 1))
    .attr("fill", "none")
    .attr("marker-end", `url(#arrow-${uid})`);

  // Nodes
  const nodes = zoomGroup.append("g")
    .selectAll("g.thumb-node")
    .data(graph.nodes.filter((n) => layout[n.id]))
    .enter()
    .append("g")
    .attr("class", "thumb-node")
    .attr("transform", (d) => {
      const p = layout[d.id];
      return `translate(${p.x}, ${p.y})`;
    });

  nodes.append("circle")
    .attr("r", (d) => radiusMap[d.id] || 14)
    .attr("fill", (d) => colorFn(d.id))
    .attr("stroke", "#1e293b")
    .attr("stroke-width", 0.8)
    .attr("opacity", (d) => isSecondary(d) ? 0.55 : 1);

  nodes.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em")
    .attr("font-size", "7px")
    .attr("font-weight", "bold")
    .attr("fill", "white")
    .attr("pointer-events", "none")
    .text((d) => {
      const label = d.id.split("(")[0];
      return label.length > 7 ? label.slice(0, 6) + "…" : label;
    });

  nodes.append("title").text((d) => `${d.id}  (count ${d.count})`);

  // Fit-to-view
  const xs = Object.values(layout).map((p) => p.x);
  const ys = Object.values(layout).map((p) => p.y);
  const pad = 25;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const gW = Math.max(maxX - minX, 50);
  const gH = Math.max(maxY - minY, 50);
  const scale = Math.min(width / gW, height / gH) * 0.92;
  const tx = (width - gW * scale) / 2 - minX * scale;
  const ty = (height - gH * scale) / 2 - minY * scale;

  const fit = d3.zoomIdentity.translate(tx, ty).scale(scale);
  const zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 6])
    .on("zoom", (event) => zoomGroup.attr("transform", event.transform));

  svg.call(zoomBehavior);
  svg.call(zoomBehavior.transform, fit);

  return {
    destroy() {
      svg.selectAll("*").remove();
      svg.on(".zoom", null);
    },
  };
}