import { nodeColor } from "./utils.js";

const d3 = window.d3;

function computeLayout(nodes, sequence, { maxRadius = 18 } = {}) {
  const n = sequence.length;
  const occurrences = {};
  const firstOccurrence = {};

  sequence.forEach((item, index) => {
    if (!occurrences[item.action]) {
      occurrences[item.action] = [];
    }
    const normalized = index / Math.max(n - 1, 1);
    occurrences[item.action].push(normalized);

    if (firstOccurrence[item.action] === undefined) {
      firstOccurrence[item.action] = normalized;
    }
  });

  const columnCount = 20;
  const xScale = Math.max(120, Math.round(maxRadius * 3.2));
  const yScale = Math.max(72, Math.round(maxRadius * 2.4));
  const buckets = {};

  // Compute median for each node (used for both x and y-sort)
  const medianMap = {};
  nodes.forEach((node) => {
    let pos;
    if (node.id === "START") pos = [0];
    else if (node.id === "END") pos = [1];
    else pos = occurrences[node.id] || [0.5];

    const sorted = [...pos].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];

    medianMap[node.id] = median;
    const col = Math.round(median * (columnCount - 1));
    if (!buckets[col]) buckets[col] = [];
    buckets[col].push(node.id);
  });

  const layout = {};
  Object.entries(buckets).forEach(([col, ids]) => {
    // Sort by median occurrence — earlier actions sit higher (smaller y)
    const sortedIds = [...ids].sort((a, b) => {
      const aVal = medianMap[a] ?? 0.5;
      const bVal = medianMap[b] ?? 0.5;
      return aVal - bVal;
    });

    const count = sortedIds.length;
    sortedIds.forEach((id, idx) => {
      layout[id] = {
        x: Number.parseInt(col, 10) * xScale,
        y: (idx - (count - 1) / 2) * yScale,
      };
    });
  });

  return layout;
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
  if (node.isSpecial) {
    return node.id;
  }

  if (mode === "abstracted") {
    return node.id;
  }

  const verb = node.id.split("(")[0];
  return verb.length > 7 ? verb.slice(0, 6) + "..." : verb;
}

function getNodeSubtitle(node, mode) {
  if (node.isSpecial || mode === "abstracted") {
    return "";
  }

  const match = node.id.match(/\((.+)\)/);
  return match ? match[1] : "";
}

function estimateNodeRadius(node, label, countRadius, mode) {
  const charWidth = mode === "abstracted" ? 4.9 : 3.9;
  const labelRadius = Math.max(14, label.length * charWidth * 0.5 + 12);
  return Math.max(countRadius, labelRadius);
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

  let linkSelection = null;
  let nodeSelection = null;
  let selfLoopSelection = null;
  let zoomBehavior = null;
  let fitTransform = null;
  let nodeLayout = null;
  let lastActiveEdge = null;
  let lastActiveNode = null;
  let radiusMapCache = null;
  let enrichedLinksCache = null;  // Store for hover handlers
  let edgeWidthScale = null;
  let edgeOpacityScale = null;
  let currentMode = "smart";
  let currentSequenceCache = [];

  function buildGraph(graph, sequence, minCount = 1, mode = "smart") {
    currentMode = mode;
    lastActiveEdge = null;
    lastActiveNode = null;
    currentSequenceCache = sequence || [];
    const width = graphWrapEl.clientWidth || 700;
    const height = graphWrapEl.clientHeight || 540;

    svg.attr("width", width).attr("height", height);
    svg.selectAll("*").remove();

    // Inject START and END nodes
    const enrichedNodes = [...graph.nodes];
    let enrichedLinks = [...graph.links];

    if (sequence.length > 0) {
      const firstAction = sequence[0].action;
      const lastAction = sequence[sequence.length - 1].action;

      enrichedNodes.unshift({ id: "START", count: 1, isSpecial: true });
      enrichedNodes.push({ id: "END", count: 1, isSpecial: true });

      enrichedLinks.unshift({
        source: "START",
        target: firstAction,
        count: 1,
        probability: 1.0,
        key: "START-" + firstAction,
      });
      enrichedLinks.push({
        source: lastAction,
        target: "END",
        count: 1,
        probability: 1.0,
        key: lastAction + "-END",
      });
    }

    // ── Suggestion 2: Filter edges by minimum count threshold ────────────────
    enrichedLinks = enrichedLinks.filter(l => (l.count || 1) >= minCount);

    // Only show nodes that still have at least one visible edge
    const activeNodeIds = new Set();
    enrichedLinks.forEach(l => {
      activeNodeIds.add(l.source);
      activeNodeIds.add(l.target);
    });
    const filteredNodes = enrichedNodes.filter(n => activeNodeIds.has(n.id));

    enrichedLinksCache = enrichedLinks;  // Store for hover handlers

    const defs = svg.append("defs");
    [["arrow", "#94a3b8"], ["arrowActive", "#ea580c"]].forEach(([id, color]) => {
      defs
        .append("marker")
        .attr("id", id)
        .attr("viewBox", "0 -4 10 8")
        .attr("refX", 9)
        .attr("refY", 0)
        .attr("markerWidth", 5)
        .attr("markerHeight", 5)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-4L10,0L0,4Z")
        .attr("fill", color);
    });
    defs
      .append("marker")
      .attr("id", "arrowReverse")
      .attr("viewBox", "0 -4 10 8")
      .attr("refX", 1)
      .attr("refY", 0)
      .attr("markerWidth", 5)
      .attr("markerHeight", 5)
      .attr("orient", "auto-start-reverse")
      .append("path")
      .attr("d", "M0,-4L10,0L0,4Z")
      .attr("fill", "#94a3b8");

    const zoomGroup = svg.append("g").attr("id", "zoomGroup");

    const nodeLabels = new Map();
    filteredNodes.forEach((node) => {
      nodeLabels.set(node.id, getNodeLabel(node, currentMode));
    });

    const maxCount = d3.max(filteredNodes, (d) => d.count) || 1;
    const nodeRadiusByCount = d3.scaleSqrt().domain([1, Math.max(maxCount, 2)]).range([18, 36]);

    const radiusMap = {};
    filteredNodes.forEach((d) => {
      const label = nodeLabels.get(d.id) || d.id;
      const countRadius = nodeRadiusByCount(d.count);
      radiusMap[d.id] = estimateNodeRadius(d, label, countRadius, currentMode);
    });
    radiusMapCache = radiusMap;

    const maxRadius = d3.max(Object.values(radiusMap)) || 18;
    const layout = computeLayout(filteredNodes, sequence, { maxRadius });

    // ── Suggestion 1: Create scales for edge width and opacity by frequency ──
    const maxLinkCount = d3.max(enrichedLinks, d => d.count) || 1;
    edgeWidthScale = d3.scaleSqrt()
      .domain([1, Math.max(maxLinkCount, 2)])
      .range([0.8, 5]);

    edgeOpacityScale = d3.scaleLinear()
      .domain([1, Math.max(maxLinkCount, 2)])
      .range([0.15, 0.85]);

    const forwardEdges = [];
    const backEdges = [];
    const selfLoops = [];

    enrichedLinks.forEach((link) => {
      if (link.source === link.target) {
        selfLoops.push(link);
        return;
      }

      const sourceX = (layout[link.source] || { x: 0 }).x;
      const targetX = (layout[link.target] || { x: 0 }).x;
      if (targetX >= sourceX) {
        forwardEdges.push(link);
      } else {
        backEdges.push(link);
      }
    });

    const medianCount = d3.median(forwardEdges, (d) => d.count || 1) || 1;

    const selfLoopSummary = [...d3.group(selfLoops, (d) => d.source)].map(([sourceId, edges]) => ({
      source: sourceId,
      target: sourceId,
      key: edges[0]?.key || `${sourceId}|||${sourceId}`,
      count: d3.sum(edges, (e) => e.count || 1),
      occurrences: edges.flatMap((e) => e.occurrences || []),
    }));

    const backEdgesBySource = d3.group(backEdges, (d) => d.source);
    zoomGroup
      .append("g")
      .attr("class", "back-indicators")
      .selectAll("g.back-indicator")
      .data([...backEdgesBySource.entries()])
      .enter()
      .append("g")
      .attr("class", "back-indicator")
      .attr("transform", ([sourceId]) => {
        const p = layout[sourceId] || { x: 0, y: 0 };
        return `translate(${p.x}, ${p.y})`;
      })
      .each(function([sourceId, edges]) {
        const r = radiusMap[sourceId] || 18;
        const g = d3.select(this);

        g.append("circle")
          .attr("class", "back-indicator-badge")
          .attr("cx", -r * 0.7)
          .attr("cy", -r - 4)
          .attr("r", 7)
          .attr("fill", "#f1f5f9")
          .attr("stroke", "#94a3b8")
          .attr("stroke-width", 1);

        g.append("text")
          .attr("x", -r * 0.7)
          .attr("y", -r - 4)
          .attr("text-anchor", "middle")
          .attr("dy", "0.35em")
          .attr("font-size", "7px")
          .attr("fill", "#64748b")
          .text(edges.length);

        g.append("title")
          .text(`Backward to: ${edges.map((e) => e.target).join(", ")}`);
      });

    const edgeSet = new Set(forwardEdges.map((d) => `${d.source}|||${d.target}`));
    const bidirectionalPairs = new Set();
    const bidirectionalForward = [];
    const unidirectionalForward = [];

    forwardEdges.forEach((d) => {
      const currentKey = `${d.source}|||${d.target}`;
      const reverseKey = `${d.target}|||${d.source}`;
      if (edgeSet.has(reverseKey) && !bidirectionalPairs.has(currentKey) && !bidirectionalPairs.has(reverseKey)) {
        bidirectionalPairs.add(currentKey);
        bidirectionalPairs.add(reverseKey);
        bidirectionalForward.push({ ...d, pairKey: reverseKey });
      } else if (!bidirectionalPairs.has(currentKey)) {
        unidirectionalForward.push(d);
      }
    });

    zoomGroup
      .append("g")
      .selectAll("path.unidir")
      .data(unidirectionalForward)
      .enter()
      .append("path")
      .attr("class", (d) => `link fwd-edge ${(d.count || 1) > medianCount ? "dominant" : "minor"}`)
      .attr("data-key", (d) => d.key)
      .attr("stroke-width", (d) => edgeWidthScale(d.count || 1))
      .attr("stroke-opacity", (d) => {
        const count = d.count || 1;
        if (count > medianCount) return 0.75;
        if (count === medianCount) return 0.4;
        return 0.15;
      })
      .attr("marker-end", "url(#arrow)")
      .attr("d", (d) => getStraightPath(d, layout, radiusMap))
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip);

    zoomGroup
      .append("g")
      .selectAll("path.bidir")
      .data(bidirectionalForward)
      .enter()
      .append("path")
      .attr("class", "link bidir-edge")
      .attr("data-key", (d) => d.key)
      .attr("data-pair-key", (d) => d.pairKey)
      .attr("stroke-width", (d) => edgeWidthScale(d.count || 1))
      .attr("stroke-opacity", 0.6)
      .attr("marker-end", "url(#arrow)")
      .attr("marker-start", "url(#arrowReverse)")
      .attr("d", (d) => getStraightPath(d, layout, radiusMap))
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip);

    const nodeGroups = zoomGroup
      .append("g")
      .selectAll(".node")
      .data(filteredNodes)
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("data-id", (d) => d.id)
      .attr("transform", (d) => {
        const p = layout[d.id] || { x: 0, y: 0 };
        return `translate(${p.x},${p.y})`;
      });

    nodeGroups
      .append("circle")
      .attr("r", (d) => radiusMap[d.id] || 18)
      .style("fill", (d) => (d.isSpecial ? "#d1d5db" : nodeColor(d.id)));

    nodeGroups
      .append("text")
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
      .attr("textLength", (d) => {
        const r = radiusMap[d.id] || 18;
        return Math.max(20, r * 1.55);
      })
      .attr("lengthAdjust", "spacingAndGlyphs")
      .text((d) => nodeLabels.get(d.id) || d.id);

    nodeGroups
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => (radiusMap[d.id] || 18) + 14)
      .attr("font-size", (d) => (currentMode === "abstracted" ? "0px" : "7px"))
      .attr("fill", "#475569")
      .attr("pointer-events", "none")
      .text((d) => getNodeSubtitle(d, currentMode));

    const selfLoopIndicators = zoomGroup
      .append("g")
      .attr("class", "self-loop-indicators")
      .selectAll("g.self-loop-indicator")
      .data(selfLoopSummary)
      .enter()
      .append("g")
      .attr("class", "self-loop-indicator")
      .attr("data-key", (d) => d.key)
      .attr("transform", (d) => {
        const p = layout[d.source] || { x: 0, y: 0 };
        return `translate(${p.x},${p.y})`;
      });

    selfLoopIndicators
      .append("text")
      .attr("class", "self-loop-indicator-glyph")
      .attr("x", (d) => (radiusMap[d.source] || 18) * 0.7)
      .attr("y", (d) => -(radiusMap[d.source] || 18) - 4)
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .text("⟳");

    selfLoopIndicators
      .append("title")
      .text((d) => `Self-loop on ${d.source} (count: ${d.count})`);

    selfLoopIndicators
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip);

    nodeGroups.append("title").text((d) => {
      let tooltip = `${d.id}\nCount: ${d.count}`;
      if (d.objects && Object.keys(d.objects).length > 0) {
        const objectList = Object.entries(d.objects)
          .map(([obj, cnt]) => `${obj}: ${cnt}`)
          .join(", ");
        tooltip += `\nObjects: ${objectList}`;
      }
      return tooltip;
    });

    // ── Suggestion 4: Node hover highlighting with edge focus+context ────────
    nodeGroups
      .on("mouseover", function(event, d) {
        const hoveredId = d.id;

        // Dim all edges
        linkSelection
          .attr("stroke-opacity", 0.05)
          .attr("stroke-width", 0.5);

        // Highlight edges connected to hovered node
        linkSelection
          .filter(link => link.source === hoveredId || link.target === hoveredId)
          .attr("stroke-opacity", link => edgeOpacityScale(link.count || 1))
          .attr("stroke-width", link => edgeWidthScale(link.count || 1) * 1.5)
          .attr("stroke", "#ea580c");

        // Dim non-neighbor nodes
        nodeSelection
          .filter(n => n.id !== hoveredId)
          .style("opacity", function(n) {
            const isNeighbor = enrichedLinksCache.some(
              l => (l.source === hoveredId && l.target === n.id) ||
                   (l.target === hoveredId && l.source === n.id)
            );
            return isNeighbor ? 0.9 : 0.2;
          });
      })
      .on("mouseout", function() {
        // Restore all to frequency-based encoding
        linkSelection
          .attr("stroke-opacity", d => edgeOpacityScale(d.count || 1))
          .attr("stroke-width", d => edgeWidthScale(d.count || 1))
          .attr("stroke", null);

        nodeSelection.style("opacity", 1);
        hideEdgeTooltip();
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

    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;
    const scale = Math.min(width / graphWidth, height / graphHeight) * 0.9;
    const tx = (width - graphWidth * scale) / 2 - minX * scale;
    const ty = (height - graphHeight * scale) / 2 - minY * scale;

    fitTransform = d3.zoomIdentity.translate(tx, ty).scale(scale);

    zoomBehavior = d3
      .zoom()
      .scaleExtent([0.04, 8])
      .on("zoom", (event) => zoomGroup.attr("transform", event.transform));

    svg.call(zoomBehavior);
    svg.call(zoomBehavior.transform, fitTransform);

    document.querySelector(zoomInSelector).onclick = () => {
      svg.transition().duration(250).call(zoomBehavior.scaleBy, 1.5);
    };
    document.querySelector(zoomOutSelector).onclick = () => {
      svg.transition().duration(250).call(zoomBehavior.scaleBy, 1 / 1.5);
    };
    document.querySelector(zoomResetSelector).onclick = () => {
      svg.transition().duration(400).call(zoomBehavior.transform, fitTransform);
    };
  }

  // ── Suggestion 5: Edge tooltip showing count and percentage ────────────────
  function showEdgeTooltip(event, d) {
    const totalOutgoing = enrichedLinksCache
      .filter(l => l.source === d.source)
      .reduce((sum, l) => sum + (l.count || 1), 0);
    const pct = ((d.count || 1) / totalOutgoing * 100).toFixed(0);

    const detailMap = new Map();
    if (currentMode !== "full" && Array.isArray(d.occurrences) && currentSequenceCache.length > 0) {
      d.occurrences.forEach((index) => {
        const sourceItem = currentSequenceCache[index];
        const targetItem = currentSequenceCache[index + 1];
        if (!sourceItem || !targetItem) {
          return;
        }

        const detailKey = `${sourceItem.action} -> ${targetItem.action}`;
        detailMap.set(detailKey, (detailMap.get(detailKey) || 0) + 1);
      });
    }

    const detailLines = [...detailMap.entries()]
      .map(([pair, count]) => `${pair}: ${count}`)
      .join("\n");

    const tooltip = document.getElementById("edgeTooltip");
    tooltip.textContent = detailLines
      ? `${d.source} → ${d.target}\nCount: ${d.count} (${pct}% of outgoing)\n${detailLines}`
      : `${d.source} → ${d.target}\nCount: ${d.count} (${pct}% of outgoing)`;
    tooltip.style.display = "block";
    tooltip.style.left = (event.clientX + 12) + "px";
    tooltip.style.top = (event.clientY - 10) + "px";
  }

  function hideEdgeTooltip() {
    document.getElementById("edgeTooltip").style.display = "none";
  }

  function zoomToTransition(sourceId, targetId) {
    if (!nodeLayout || !zoomBehavior || !radiusMapCache) {
      return;
    }

    const sourcePos = nodeLayout[sourceId];
    const targetPos = nodeLayout[targetId];
    
    if (!sourcePos || !targetPos) {
      return;
    }

    const width = graphWrapEl.clientWidth;
    const height = graphWrapEl.clientHeight;

    // Calculate bounding box of both nodes
    const sourceRadius = radiusMapCache[sourceId] || 18;
    const targetRadius = radiusMapCache[targetId] || 18;
    
    const minX = Math.min(sourcePos.x - sourceRadius, targetPos.x - targetRadius);
    const maxX = Math.max(sourcePos.x + sourceRadius, targetPos.x + targetRadius);
    const minY = Math.min(sourcePos.y - sourceRadius, targetPos.y - targetRadius);
    const maxY = Math.max(sourcePos.y + sourceRadius, targetPos.y + targetRadius);

    const boxWidth = maxX - minX;
    const boxHeight = maxY - minY;
    const padding = 40;

    // Calculate scale to fit both nodes with padding
    const scaleX = (width - padding * 2) / Math.max(boxWidth, 1);
    const scaleY = (height - padding * 2) / Math.max(boxHeight, 1);
    const scale = Math.min(scaleX, scaleY, 3.5);

    // Center both nodes in viewport
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const tx = width / 2 - centerX * scale;
    const ty = height / 2 - centerY * scale;

    svg.transition().duration(550).call(
      zoomBehavior.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
  }

  function autoZoomToNode(nodeId) {
    if (!nodeLayout || !zoomBehavior || !radiusMapCache) {
      return;
    }

    const p = nodeLayout[nodeId];
    if (!p) {
      return;
    }

    const width = graphWrapEl.clientWidth;
    const height = graphWrapEl.clientHeight;
    const radius = radiusMapCache[nodeId] || 18;
    const scale = Math.min(3, Math.max(1.6, Math.min(width / (radius * 6), height / (radius * 6))));
    const tx = width / 2 - p.x * scale;
    const ty = height / 2 - p.y * scale;

    svg.transition().duration(550).call(
      zoomBehavior.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
  }

  function updateActive(item) {
    const activeNode = item ? item.action : null;
    const activeEdge = item ? item.edge_key : null;

    if (currentMode === "full") {
      let zoomSource = null;
      let zoomTarget = null;

      if (activeEdge && activeEdge !== lastActiveEdge) {
        lastActiveEdge = activeEdge;
        const parts = activeEdge.split("|||");
        if (parts.length === 2) {
          zoomSource = parts[0].trim();
          zoomTarget = parts[1].trim();
        }
      } else if (!activeEdge && lastActiveEdge) {
        lastActiveEdge = null;
        if (zoomBehavior && fitTransform) {
          svg.transition().duration(400).call(zoomBehavior.transform, fitTransform);
        }
      }

      if (zoomSource && zoomTarget) {
        zoomToTransition(zoomSource, zoomTarget);
      }
    } else if (activeNode !== lastActiveNode) {
      lastActiveNode = activeNode;
      if (activeNode) {
        autoZoomToNode(activeNode);
      } else if (zoomBehavior && fitTransform) {
        svg.transition().duration(400).call(zoomBehavior.transform, fitTransform);
      }
    }

    if (nodeSelection) {
      nodeSelection.classed("active", (d) => d.id === activeNode);
    }

    if (linkSelection) {
      linkSelection
        .classed("active", (d) => d && (d.key === activeEdge || d.pairKey === activeEdge))
        .attr("marker-end", (d) => (d && (d.key === activeEdge || d.pairKey === activeEdge) ? "url(#arrowActive)" : "url(#arrow)"));
    }

    if (selfLoopSelection) {
      selfLoopSelection.classed("active", (d) => d && d.key === activeEdge);
    }
  }

  return {
    buildGraph,
    updateActive,
  };
}
