import { getDataUrl, DEFAULT_DATA_MODE, DEFAULT_COLOR_ENCODE_MODE, getLegendItems } from "./config.js";
import { createGraphController } from "./graph.js";
import { buildLegend } from "./legend.js";
import { buildAnnotationTimeline, updateAnnotationPlayhead } from "./annotationTimeline.js";
import { drawTimeline, updateTimelineActive } from "./timeline.js";
import { currentSequenceItem, formatSeconds, renderDataError, nodeColor } from "./utils.js";
import { ACTION_TO_PHASE, PHASE_COLORS } from "./config.js";

const appRoot = document.getElementById("appRoot");
const summaryPill = document.getElementById("summaryPill");
const recipeLabel = document.getElementById("recipeLabel");
const videoLabel = document.getElementById("videoLabel");
const timeLabel = document.getElementById("timeLabel");
const actionLabel = document.getElementById("actionLabel");
const statusLabel = document.getElementById("statusLabel");
const timelineBody = document.getElementById("timelineBody");
const footerPanel = document.querySelector(".footerPanel");
const legendStrip = document.getElementById("legendStrip");
const header = document.querySelector(".header");
const video = document.getElementById("video");
const graphModeSelect = document.getElementById("graphModeSelect");
const edgeThreshold = document.getElementById("edgeThreshold");
const thresholdLabel = document.getElementById("thresholdLabel");
const colorEncodeSelect = document.getElementById("colorEncodeSelect");
const sizeEncodeSelect = document.getElementById("sizeEncodeSelect");
const layoutModeSelect = document.getElementById("layoutModeSelect");
const annotationTimeline = document.getElementById("annotationTimeline");

const graphController = createGraphController({
  svgSelector: "#graphSvg",
  graphWrapSelector: "#graphWrap",
  zoomInSelector: "#zoomIn",
  zoomOutSelector: "#zoomOut",
  zoomResetSelector: "#zoomReset",
});

let cachedData = null;
let timelineRows = [];
let annotationPlayheadEl = null;
let currentTotalDuration = 0;

function handleNodeClick(d, sequence) {
  const match = sequence.find((item) => item.action === d.id);
  if (match) {
    video.currentTime = match.start;
    d3.selectAll(".node").classed("selected", (node) => node.id === d.id);
  }
}

function refresh() {
  if (!cachedData) {
    return;
  }

  const item = currentSequenceItem(cachedData.sequence, video.currentTime || 0);
  timeLabel.textContent = formatSeconds(video.currentTime || 0);
  actionLabel.textContent = item ? item.action : "-";

  graphController.updateActive(item);
  updateTimelineActive(timelineRows, footerPanel, item);
  
  if (annotationPlayheadEl && currentTotalDuration > 0) {
    updateAnnotationPlayhead(annotationPlayheadEl, video.currentTime || 0, currentTotalDuration);
  }
}

function rebuildLegend() {
  buildLegend(
    legendStrip,
    getLegendItems(colorEncodeSelect.value, sizeEncodeSelect.value, graphModeSelect.value),
    colorEncodeSelect.value,
    cachedData?.sequence || []
  );
}

function getCurrentColorFn() {
  const colorMode = colorEncodeSelect.value;
  const graphMode = graphModeSelect.value;

  if (colorMode === "category") {
    return (action) => nodeColor(action);
  }

  if (colorMode === "phase") {
    return (action) => {
      // abstracted mode: action IS the phase name
      if (graphMode === "abstracted") {
        return PHASE_COLORS[action] || "#94A3B8";
      }
      // smart mode: action is a verb, find matching phase by verb prefix
      if (graphMode === "smart") {
        const verb = action.toLowerCase();
        const matchKey = Object.keys(ACTION_TO_PHASE).find(
          k => k.split("(")[0] === verb
        );
        const phase = matchKey ? ACTION_TO_PHASE[matchKey] : null;
        return phase ? (PHASE_COLORS[phase] || "#94A3B8") : "#94A3B8";
      }
      // full raw: action is "take(cup)" — direct lookup
      const phase = ACTION_TO_PHASE[action] || null;
      return phase ? (PHASE_COLORS[phase] || "#94A3B8") : "#94A3B8";
    };
  }

  if (colorMode === "duration") {
    // Need duration stats to build the scale — read from sequence
    if (!cachedData) return (action) => "#94A3B8";

    const durationMap = {};
    cachedData.sequence.forEach(s => {
      if (!durationMap[s.action]) durationMap[s.action] = [];
      durationMap[s.action].push(s.duration);
    });
    const meanDuration = {};
    Object.entries(durationMap).forEach(([a, ds]) => {
      meanDuration[a] = ds.reduce((sum, v) => sum + v, 0) / ds.length;
    });
    const vals = Object.values(meanDuration).filter(v => isFinite(v));
    const colorScale = d3.scaleSequential()
      .domain([d3.min(vals), d3.max(vals)])
      .interpolator(d3.interpolateYlOrRd);

    return (action) => {
      const mean = meanDuration[action];
      return mean !== undefined ? colorScale(mean) : "#94A3B8";
    };
  }

  // Fallback
  return (action) => nodeColor(action);
}

function rebuildAnnotationTimeline() {
  if (!cachedData || !annotationTimeline) {
    return;
  }

  currentTotalDuration = cachedData.sequence[cachedData.sequence.length - 1]?.end || 1;
  annotationPlayheadEl = buildAnnotationTimeline(
    annotationTimeline,
    cachedData.sequence,
    currentTotalDuration,
    getCurrentColorFn()
  );
}

async function loadGraphData() {
  const mode = graphModeSelect.value;
  const dataUrl = getDataUrl(mode);

  try {
    const response = await fetch(dataUrl);
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const data = await response.json();
    cachedData = data;

    recipeLabel.textContent = `${data.recipe.name} (${data.recipe.id})`;
    videoLabel.textContent = data.recipe.video_id;
    summaryPill.textContent =
      `${data.graph.nodes.length} nodes - ` +
      `${data.graph.links.length} transitions - ` +
      `${data.sequence.length} actions`;

    video.src = data.recipe.video_path;
    video.currentTime = 0; // Reset video to start
    timelineRows = drawTimeline(timelineBody, data.sequence);
    
    graphController.buildGraph(
      data.graph,
      data.sequence,
      parseInt(edgeThreshold.value),
      mode,
      colorEncodeSelect.value,
      sizeEncodeSelect.value,
      layoutModeSelect ? layoutModeSelect.value : "temporal",
      {
        onNodeClick: handleNodeClick
      }
    );
    rebuildAnnotationTimeline();
    rebuildLegend();
    statusLabel.innerHTML = "Status: <strong>Ready</strong>";
    actionLabel.textContent = "-";
  } catch (error) {
    renderDataError(
      summaryPill,
      header,
      "Failed to load graph data. (" + error.message + ")"
    );
    console.error(error);
  }
}

// Listen for graph mode changes
graphModeSelect.addEventListener("change", () => {
  loadGraphData().then(() => {
    rebuildAnnotationTimeline();
    rebuildLegend();
  });
});

// Listen for edge threshold changes
edgeThreshold.addEventListener("input", () => {
  const val = parseInt(edgeThreshold.value);
  thresholdLabel.textContent = val;
    if (cachedData) {
      graphController.buildGraph(
        cachedData.graph,
        cachedData.sequence,
        val,
        graphModeSelect.value,
        colorEncodeSelect.value,
        sizeEncodeSelect.value,
        layoutModeSelect ? layoutModeSelect.value : "temporal",
        {
          onNodeClick: handleNodeClick
        }
      );
      rebuildAnnotationTimeline();
      rebuildLegend();
    }
});

// Listen for color encoding changes
colorEncodeSelect.addEventListener("change", () => {
  if (cachedData) {
    graphController.buildGraph(
      cachedData.graph,
      cachedData.sequence,
      parseInt(edgeThreshold.value),
      graphModeSelect.value,
      colorEncodeSelect.value,
      sizeEncodeSelect.value,
      layoutModeSelect ? layoutModeSelect.value : "temporal",
      {
        onNodeClick: handleNodeClick
      }
    );
    rebuildAnnotationTimeline();
    rebuildLegend();
  }
});

// Listen for size encoding changes
sizeEncodeSelect.addEventListener("input", () => {
  rebuildLegend();
  if (cachedData) {
    graphController.buildGraph(
      cachedData.graph,
      cachedData.sequence,
      parseInt(edgeThreshold.value),
      graphModeSelect.value,
      colorEncodeSelect.value,
      sizeEncodeSelect.value,
      layoutModeSelect ? layoutModeSelect.value : "temporal",
      {
        onNodeClick: (d, sequence) => {
          const match = sequence.find(s => s.action === d.id);
          if (match) {
            video.currentTime = match.start;
            d3.selectAll(".node").classed("selected", n => n.id === d.id);
          }
        }
      }
    );
  }
});

// Listen for layout mode changes
if (layoutModeSelect) {
  layoutModeSelect.addEventListener("change", () => {
    if (cachedData) {
      graphController.buildGraph(
        cachedData.graph,
        cachedData.sequence,
        parseInt(edgeThreshold.value),
        graphModeSelect.value,
        colorEncodeSelect.value,
        sizeEncodeSelect.value,
        layoutModeSelect.value,
        {
            onNodeClick: handleNodeClick
        }
      );
        rebuildAnnotationTimeline();
      rebuildLegend();
    }
  });
}

async function init() {
  if (!window.d3) {
    renderDataError(summaryPill, header, "D3 was not loaded. Please check your network and reload.");
    return;
  }

  // Set default graph mode, color encoding, and size encoding
  graphModeSelect.value = DEFAULT_DATA_MODE;
  colorEncodeSelect.value = DEFAULT_COLOR_ENCODE_MODE;
  sizeEncodeSelect.value = "frequency";
  if (layoutModeSelect) layoutModeSelect.value = "temporal";

  rebuildLegend();

  // Load initial graph data
  await loadGraphData();

  video.addEventListener("play", () => {
    graphController.setAutoZoom(false);
    appRoot.classList.remove("paused");
    statusLabel.innerHTML = "Status: <strong>Playing</strong>";
    refresh();
  });

  video.addEventListener("pause", () => {
    graphController.setAutoZoom(true);
    appRoot.classList.add("paused");
    statusLabel.innerHTML = "Status: <strong>Paused</strong>";
    refresh();
  });

  video.addEventListener("timeupdate", refresh);
  video.addEventListener("seeked", refresh);

  video.addEventListener("ended", () => {
    graphController.setAutoZoom(true);
    appRoot.classList.add("paused");
    statusLabel.innerHTML = "Status: <strong>Ended</strong>";
    refresh();
  });
}

init();
