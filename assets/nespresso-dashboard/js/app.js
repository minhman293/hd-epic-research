import { getDataUrl, DEFAULT_DATA_MODE, DEFAULT_COLOR_ENCODE_MODE, getLegendItems } from "./config.js";
import { createGraphController } from "./graph.js";
import { buildLegend } from "./legend.js";
import { drawTimeline, updateTimelineActive } from "./timeline.js";
import { currentSequenceItem, formatSeconds, renderDataError } from "./utils.js";

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

const graphController = createGraphController({
  svgSelector: "#graphSvg",
  graphWrapSelector: "#graphWrap",
  zoomInSelector: "#zoomIn",
  zoomOutSelector: "#zoomOut",
  zoomResetSelector: "#zoomReset",
});

let cachedData = null;
let timelineRows = [];

function refresh() {
  if (!cachedData) {
    return;
  }

  const item = currentSequenceItem(cachedData.sequence, video.currentTime || 0);
  timeLabel.textContent = formatSeconds(video.currentTime || 0);
  actionLabel.textContent = item ? item.action : "-";

  graphController.updateActive(item);
  updateTimelineActive(timelineRows, footerPanel, item);
}

function rebuildLegend() {
  buildLegend(
    legendStrip,
    getLegendItems(colorEncodeSelect.value, sizeEncodeSelect.value, graphModeSelect.value),
    colorEncodeSelect.value,
    cachedData?.sequence || []
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
      layoutModeSelect ? layoutModeSelect.value : "temporal"
    );
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
  loadGraphData();
  rebuildLegend();
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
        layoutModeSelect ? layoutModeSelect.value : "temporal"
      );
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
      layoutModeSelect ? layoutModeSelect.value : "temporal"
    );
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
      layoutModeSelect ? layoutModeSelect.value : "temporal"
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
        layoutModeSelect.value
      );
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
