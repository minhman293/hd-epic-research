import { nodeColor } from "./utils.js";

const d3 = window.d3;

function computeLayout(nodes, sequence) {
  const n = sequence.length;
  const occurrences = {};

  sequence.forEach((item, index) => {
    if (!occurrences[item.action]) {
      occurrences[item.action] = [];
    }
    occurrences[item.action].push(index / Math.max(n - 1, 1));
  });

  const columnCount = 20;
  const xScale = 120;
  const yScale = 72;
  const buckets = {};

  nodes.forEach((node) => {
    // Special positioning for START and END nodes
    let pos;
    if (node.id === "START") {
      pos = [0];
    } else if (node.id === "END") {
      pos = [1];
    } else {
      pos = occurrences[node.id] || [0.5];
    }

    const sorted = [...pos].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const col = Math.round(median * (columnCount - 1));

    if (!buckets[col]) {
      buckets[col] = [];
    }
    buckets[col].push(node.id);
  });

  const layout = {};
  Object.entries(buckets).forEach(([col, ids]) => {
    const sortedIds = [...ids].sort();
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
  let zoomBehavior = null;
  let fitTransform = null;
  let nodeLayout = null;
  let lastActiveEdge = null;
  let radiusMapCache = null;
  let enrichedLinksCache = null;  // Store for hover handlers
  let edgeWidthScale = null;
  let edgeOpacityScale = null;

  function buildGraph(graph, sequence, minCount = 1) {
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

    const zoomGroup = svg.append("g").attr("id", "zoomGroup");
    const layout = computeLayout(filteredNodes, sequence);

    const maxCount = d3.max(filteredNodes, (d) => d.count) || 1;
    const nodeRadius = d3.scaleSqrt().domain([1, Math.max(maxCount, 2)]).range([18, 36]);

    const radiusMap = {};
    filteredNodes.forEach((d) => {
      radiusMap[d.id] = nodeRadius(d.count);
    });
    radiusMapCache = radiusMap;

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

    // ── Suggestion 3: Separate visual treatment for back edges ────────────────
    zoomGroup
      .append("g")
      .selectAll("path")
      .data(backEdges)
      .enter()
      .append("path")
      .attr("class", "link back-edge")
      .attr("data-key", (d) => d.key)
      .attr("stroke-width", d => Math.max(0.6, edgeWidthScale(d.count || 1) * 0.5))
      .attr("stroke-opacity", d => edgeOpacityScale(d.count || 1) * 0.6)
      .attr("stroke-dasharray", "4,3")
      .attr("marker-end", "url(#arrow)")
      .attr("d", (d) => getArcPath(d, layout, radiusMap))
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip);

    zoomGroup
      .append("g")
      .selectAll("path")
      .data(selfLoops)
      .enter()
      .append("path")
      .attr("class", "link self-loop")
      .attr("data-key", (d) => d.key)
      .attr("stroke-width", d => edgeWidthScale(d.count || 1))
      .attr("stroke-opacity", d => edgeOpacityScale(d.count || 1) * 0.7)
      .attr("stroke-dasharray", "4,3")
      .attr("marker-end", "url(#arrow)")
      .attr("d", (d) => {
        const p = layout[d.source] || { x: 0, y: 0 };
        const r = radiusMap[d.source] || 18;
        const loopR = r + 13;
        return `M${p.x - r * 0.6},${p.y - r} A${loopR},${loopR} 0 1,0 ${p.x + r * 0.6},${p.y - r}`;
      })
      .on("mouseover", function(event, d) { showEdgeTooltip(event, d); })
      .on("mouseout", hideEdgeTooltip);

    // ── Forward edges with full treatment ────────────────────────────────────
    zoomGroup
      .append("g")
      .selectAll("path")
      .data(forwardEdges)
      .enter()
      .append("path")
      .attr("class", "link fwd-edge")
      .attr("data-key", (d) => d.key)
      .attr("stroke-width", d => edgeWidthScale(d.count || 1))
      .attr("stroke-opacity", d => edgeOpacityScale(d.count || 1))
      .attr("marker-end", "url(#arrow)")
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
      .attr("r", (d) => nodeRadius(d.count))
      .style("fill", (d) => (d.isSpecial ? "#d1d5db" : nodeColor(d.id)));

    nodeGroups
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("font-size", (d) => (d.isSpecial ? "10px" : "9px"))
      .attr("font-weight", "bold")
      .attr("fill", (d) => (d.isSpecial ? "#4b5563" : "white"))
      .attr("pointer-events", "none")
      .text((d) => {
        if (d.isSpecial) return d.id;
        const verb = d.id.split("(")[0];
        return verb.length > 7 ? verb.slice(0, 6) + "..." : verb;
      });

    nodeGroups
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => nodeRadius(d.count) + 14)
      .attr("font-size", "7px")
      .attr("fill", "#475569")
      .attr("pointer-events", "none")
      .text((d) => {
        if (d.isSpecial) return "";
        const match = d.id.match(/\((.+)\)/);
        return match ? match[1] : "";
      });

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

    const tooltip = document.getElementById("edgeTooltip");
    tooltip.textContent = `${d.source} → ${d.target}\nCount: ${d.count} (${pct}% of outgoing)`;
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
    if (!nodeLayout || !zoomBehavior) {
      return;
    }

    const p = nodeLayout[nodeId];
    if (!p) {
      return;
    }

    const width = graphWrapEl.clientWidth;
    const height = graphWrapEl.clientHeight;
    const scale = 2.2;
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
    let shouldZoom = false;
    let zoomSource = null;
    let zoomTarget = null;

    // Detect transition change and parse edge_key (format: "action1|||action2")
    if (activeEdge && activeEdge !== lastActiveEdge) {
      lastActiveEdge = activeEdge;
      shouldZoom = true;
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

    if (shouldZoom && zoomSource && zoomTarget) {
      zoomToTransition(zoomSource, zoomTarget);
    }

    if (nodeSelection) {
      nodeSelection.classed("active", (d) => d.id === activeNode);
    }

    if (linkSelection) {
      linkSelection
        .classed("active", (d) => d && d.key === activeEdge)
        .attr("marker-end", (d) => (d && d.key === activeEdge ? "url(#arrowActive)" : "url(#arrow)"));
    }
  }

  return {
    buildGraph,
    updateActive,
  };
}
