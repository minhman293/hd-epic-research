import { getDataUrl, DEFAULT_DATA_MODE, LEGEND_ITEMS } from "./config.js";
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
      mode
    );
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
      graphModeSelect.value
    );
  }
});

async function init() {
  if (!window.d3) {
    renderDataError(summaryPill, header, "D3 was not loaded. Please check your network and reload.");
    return;
  }

  // Set default graph mode
  graphModeSelect.value = DEFAULT_DATA_MODE;

  buildLegend(legendStrip, LEGEND_ITEMS);

  // Load initial graph data
  await loadGraphData();

  video.addEventListener("play", () => {
    appRoot.classList.remove("paused");
    statusLabel.innerHTML = "Status: <strong>Playing</strong>";
    refresh();
  });

  video.addEventListener("pause", () => {
    appRoot.classList.add("paused");
    statusLabel.innerHTML = "Status: <strong>Paused</strong>";
    refresh();
  });

  video.addEventListener("timeupdate", refresh);
  video.addEventListener("seeked", refresh);

  video.addEventListener("ended", () => {
    appRoot.classList.add("paused");
    statusLabel.innerHTML = "Status: <strong>Ended</strong>";
    refresh();
  });
}

init();
