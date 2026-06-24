// app.js

import {
  getManifestUrl,
  getSessionDataUrl,
  getMergedDataUrl,
  DEFAULT_DATA_MODE,
  DEFAULT_COLOR_ENCODE_MODE,
  loadVerbCategories,
  getLegendItems,
  getStepPhaseColor,
  buildStepLabelLookup,
  resolveStepLabel
} from "./config.js";

import { createGraphController } from "./graph.js";
import { buildLegend } from "./legend.js";
import { buildAnnotationTimeline, updateAnnotationPlayhead } from "./annotationTimeline.js";
import { drawTimeline, updateTimelineActive } from "./timeline.js";
import { currentSequenceItem, formatSeconds, renderDataError, nodeColor } from "./utils.js";

import { buildBarcodeStack } from "./barcodeStack.js";
import { buildVideoQueue } from "./videoQueue.js";
import { buildThumbnailGraph } from "./thumbnailGraph.js";
import { buildSwimlane } from "./swimlane.js";

// ─────────────────────────────────────────────────────────────────────────────
// DOM references
// ─────────────────────────────────────────────────────────────────────────────

const appRoot = document.getElementById("appRoot");
const dashboardTitle = document.getElementById("dashboardTitle");
const summaryPill = document.getElementById("summaryPill");
const header = document.querySelector(".header");

const singleSessionView = document.getElementById("singleSessionView");
const recipeLabel = document.getElementById("recipeLabel");
const sessionLabel = document.getElementById("sessionLabel");
const videoLabel = document.getElementById("videoLabel");
const timeLabel = document.getElementById("timeLabel");
const actionLabel = document.getElementById("actionLabel");
const statusLabel = document.getElementById("statusLabel");
const timelineBody = document.getElementById("timelineBody");
const footerPanel = document.getElementById("footerPanel");
const legendStrip = document.getElementById("legendStrip");
const video = document.getElementById("video");
const annotationTimeline = document.getElementById("annotationTimeline");
const swimlaneContainer = document.getElementById("swimlaneContainer");

const comparisonView = document.getElementById("comparisonView");
const comparisonVideo = document.getElementById("comparisonVideo");
const videoQueueEl = document.getElementById("videoQueue");
const barcodeStackEl = document.getElementById("barcodeStack");
const cmpRecipeLabel = document.getElementById("cmpRecipeLabel");
const cmpSessionLabel = document.getElementById("cmpSessionLabel");
const cmpTimeLabel = document.getElementById("cmpTimeLabel");
const mergedGraphWrap = document.getElementById("mergedGraphWrap");
const mergedGraphSvg = document.getElementById("mergedGraphSvg");
const smallMultiplesContainer = document.getElementById("smallMultiplesContainer");
const mergedSubmodeRow = document.getElementById("mergedSubmodeRow");
const supportFilter = document.getElementById("supportFilter");
const supportFilterLabel = document.getElementById("supportFilterLabel");

const recipeSelect = document.getElementById("recipeSelect");
const sessionPickerRow = document.getElementById("sessionPickerRow");
const sessionPickerTabs = document.getElementById("sessionPickerTabs");
const graphModeSelect = document.getElementById("graphModeSelect");
const edgeThreshold = document.getElementById("edgeThreshold");
const thresholdLabel = document.getElementById("thresholdLabel");
const colorEncodeSelect = document.getElementById("colorEncodeSelect");
const sizeEncodeSelect = document.getElementById("sizeEncodeSelect");
const layoutModeSelect = document.getElementById("layoutModeSelect");

// ─────────────────────────────────────────────────────────────────────────────
// Two graph controllers — one per SVG
// ─────────────────────────────────────────────────────────────────────────────

const singleGraphController = createGraphController({
  svgSelector: "#graphSvg",
  graphWrapSelector: "#graphWrap",
  zoomInSelector: "#zoomIn",
  zoomOutSelector: "#zoomOut",
  zoomResetSelector: "#zoomReset",
});

const mergedGraphController = createGraphController({
  svgSelector: "#mergedGraphSvg",
  graphWrapSelector: "#mergedGraphWrap",
  zoomInSelector: null,
  zoomOutSelector: null,
  zoomResetSelector: null,
});

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let manifest = null;
let currentRecipeId = null;
let currentSessionIndex = 0;
let viewMode = "single";
let mergedSubmode = "merged";

let cachedData = null;
let timelineRows = [];
let annotationPlayheadEl = null;
let currentTotalDuration = 0;
let lastClickedNodeId = null;
let occurrenceCycleIndex = 0;
let swimlaneApi = null;

// Comparison-mode state
let barcodeApi = null;
let videoQueueApi = null;
let comparisonSessionPayloads = [];
let comparisonMergedPayload = null;
let comparisonActiveSession = null;
let thumbnailInstances = [];

// ─────────────────────────────────────────────────────────────────────────────
// View-mode switching
// ─────────────────────────────────────────────────────────────────────────────

function showSingleView() {
  viewMode = "single";
  document.body.classList.remove("comparison-mode");
  singleSessionView.style.display = "";
  comparisonView.style.display = "none";
  mergedSubmodeRow.style.display = "none";
  footerPanel.style.display = "";
}

function showComparisonView() {
  viewMode = "comparison";
  document.body.classList.add("comparison-mode");
  singleSessionView.style.display = "none";
  comparisonView.style.display = "";
  mergedSubmodeRow.style.display = "";
  footerPanel.style.display = "none";
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-session controller
// ─────────────────────────────────────────────────────────────────────────────

function handleNodeClick(d, sequence) {
  const occurrences = sequence.filter((item) => item.action === d.id);
  if (occurrences.length === 0) return;

  if (lastClickedNodeId !== d.id) {
    occurrenceCycleIndex = 0;
    lastClickedNodeId = d.id;
  } else {
    occurrenceCycleIndex = (occurrenceCycleIndex + 1) % occurrences.length;
  }
  const target = occurrences[occurrenceCycleIndex];
  video.currentTime = target.start;
  d3.selectAll(".node").classed("selected", (n) => n.id === d.id);
  statusLabel.innerHTML =
    `Status: <strong>Selected ${d.id} (${occurrenceCycleIndex + 1}/${occurrences.length})</strong>`;
}

function refresh() {
  if (!cachedData || viewMode !== "single") return;
  const item = currentSequenceItem(cachedData.sequence, video.currentTime || 0);
  timeLabel.textContent = formatSeconds(video.currentTime || 0);
  actionLabel.textContent = item ? item.action : "-";
  if (lastClickedNodeId && item && item.action !== lastClickedNodeId) {
    lastClickedNodeId = null;
    occurrenceCycleIndex = 0;
    d3.selectAll(".node").classed("selected", false);
  }
  singleGraphController.updateActive(item);
  updateTimelineActive(timelineRows, footerPanel, item);
  if (annotationPlayheadEl && currentTotalDuration > 0) {
    updateAnnotationPlayhead(annotationPlayheadEl, video.currentTime || 0, currentTotalDuration);
  }
  if (swimlaneApi) {
    swimlaneApi.updatePlayhead(video.currentTime || 0);
  }
}

function rebuildLegend() {
  const singleSeq = cachedData?.sequence || [];
  const singleStepLabelLookup = buildStepLabelLookup(cachedData?.steps || []);
  buildLegend(
    legendStrip,
    getLegendItems(
      colorEncodeSelect.value,
      sizeEncodeSelect.value,
      graphModeSelect.value,
      singleSeq,
      singleStepLabelLookup
    ),
    colorEncodeSelect.value,
    singleSeq
  );

  const comparisonLegendStrip = document.getElementById("comparisonLegendStrip");
  if (comparisonLegendStrip && comparisonSessionPayloads.length > 0) {
    let combinedSeq = [];
    comparisonSessionPayloads.forEach((sessionData) => {
      if (sessionData.sequence) combinedSeq = combinedSeq.concat(sessionData.sequence);
    });
    const firstPayload = comparisonSessionPayloads[0]?.payload;
    const comparisonStepLabelLookup = buildStepLabelLookup(firstPayload?.steps || []);
    buildLegend(
      comparisonLegendStrip,
      getLegendItems(
        colorEncodeSelect.value,
        sizeEncodeSelect.value,
        graphModeSelect.value,
        combinedSeq,
        comparisonStepLabelLookup
      ),
      colorEncodeSelect.value,
      combinedSeq
    );
  }
}

function getCurrentColorFn(seqOverride) {
  const colorMode = colorEncodeSelect.value;
  const graphMode = graphModeSelect.value;
  const seq = seqOverride || cachedData?.sequence || [];

  if (colorMode === "category") return (action) => nodeColor(action);

  if (colorMode === "phase") {
    if (graphMode === "abstracted") return (action) => getStepPhaseColor(action);
    if (seq.length === 0) return () => "#94A3B8";
    const stepVotes = {};
    seq.forEach((s) => {
      if (!stepVotes[s.action]) stepVotes[s.action] = {};
      const sid = s.step_id;
      if (!sid) return;
      const parts = sid.split("_");
      const last = parts[parts.length - 1];
      const display = last && last.startsWith("S") ? last : sid;
      stepVotes[s.action][display] = (stepVotes[s.action][display] || 0) + 1;
    });
    const actionToStep = {};
    Object.entries(stepVotes).forEach(([action, votes]) => {
      const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
      if (top) actionToStep[action] = top[0];
    });
    return (action) => {
      const step = actionToStep[action];
      return step ? getStepPhaseColor(step) : "#94A3B8";
    };
  }

  if (colorMode === "duration") {
    if (seq.length === 0) return () => "#94A3B8";
    const durationMap = {};
    seq.forEach((s) => {
      if (!durationMap[s.action]) durationMap[s.action] = [];
      durationMap[s.action].push(s.duration);
    });
    const meanDuration = {};
    Object.entries(durationMap).forEach(([a, ds]) => {
      meanDuration[a] = ds.reduce((sum, v) => sum + v, 0) / ds.length;
    });
    const vals = Object.values(meanDuration).filter((v) => isFinite(v));
    const colorScale = d3.scaleSequential()
      .domain([d3.min(vals), d3.max(vals)])
      .interpolator(d3.interpolateYlOrRd);
    return (action) => {
      const mean = meanDuration[action];
      return mean !== undefined ? colorScale(mean) : "#94A3B8";
    };
  }
  return (action) => nodeColor(action);
}

function rebuildAnnotationTimeline() {
  if (!cachedData || !annotationTimeline) return;
  currentTotalDuration = cachedData.sequence[cachedData.sequence.length - 1]?.end || 1;
  annotationPlayheadEl = buildAnnotationTimeline(
    annotationTimeline,
    cachedData.sequence,
    currentTotalDuration,
    getCurrentColorFn(),
    {
      onSegmentClick: (item) => {
        video.currentTime = item.start;
        const node = d3.select(`.node[data-id="${CSS.escape(item.action)}"]`);
        if (!node.empty()) {
          d3.selectAll(".node").classed("selected", false);
          node.classed("selected", true);
        }
      },
    }
  );
}

function rebuildSwimlane() {
  if (swimlaneApi) { swimlaneApi.destroy(); swimlaneApi = null; }
  if (!cachedData || !swimlaneContainer) return;
  const stepLabelLookup = buildStepLabelLookup(cachedData.steps || []);
  swimlaneApi = buildSwimlane(swimlaneContainer, cachedData, getCurrentColorFn(), {
    onSegmentClick: (item) => {
      video.currentTime = item.start;
      if (!item.synthetic) {
        const node = d3.select(`.node[data-id="${CSS.escape(item.action)}"]`);
        if (!node.empty()) {
          d3.selectAll(".node").classed("selected", false);
          node.classed("selected", true);
        }
      }
    },
    stepLabelLookup,
    colorMode: colorEncodeSelect.value,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest + recipe / session selection
// ─────────────────────────────────────────────────────────────────────────────

async function loadManifest() {
  try {
    const response = await fetch(getManifestUrl());
    if (!response.ok) throw new Error("HTTP " + response.status);
    manifest = await response.json();
  } catch (error) {
    renderDataError(
      summaryPill, header,
      `Failed to load manifest.json. (${error.message})`
    );
    console.error(error);
    return false;
  }
  if (!manifest.recipes || manifest.recipes.length === 0) {
    renderDataError(summaryPill, header,
      "Manifest is empty. Run `python 6_prepare_dashboard_data.py <recipe>` first.");
    return false;
  }
  return true;
}

function populateRecipeDropdown() {
  recipeSelect.innerHTML = "";
  manifest.recipes.forEach((recipe) => {
    const opt = document.createElement("option");
    opt.value = recipe.id;
    const mergedNote = recipe.has_merged ? " · merged available" : "";
    opt.textContent = `${recipe.name} (${recipe.id}) — ${recipe.sessions.length} session${
      recipe.sessions.length === 1 ? "" : "s"
    }${mergedNote}`;
    recipeSelect.appendChild(opt);
  });
}

function populateSessionTabs(recipe) {
  sessionPickerTabs.innerHTML = "";
  recipe.sessions.forEach((session) => {
    const btn = document.createElement("button");
    btn.className = "session-tab";
    btn.dataset.sessionIndex = String(session.index);
    btn.textContent = `Session ${session.index + 1}`;
    btn.title = `${session.video_id} · ${session.action_count} actions · ${session.duration_s.toFixed(1)}s`;
    btn.addEventListener("click", () => selectSession(session.index));
    sessionPickerTabs.appendChild(btn);
  });
  if (recipe.has_merged && recipe.sessions.length >= 2) {
    const mergedBtn = document.createElement("button");
    mergedBtn.className = "session-tab merged-tab";
    mergedBtn.dataset.sessionIndex = "merged";
    mergedBtn.textContent = "Merged";
    mergedBtn.title = "Comparison view across all sessions";
    mergedBtn.addEventListener("click", () => enterComparisonMode());
    sessionPickerTabs.appendChild(mergedBtn);
  }
  sessionPickerRow.style.display = "";
  updateSessionTabHighlight();
}

function updateSessionTabHighlight() {
  Array.from(sessionPickerTabs.children).forEach((btn) => {
    const idx = btn.dataset.sessionIndex;
    if (idx === "merged") {
      btn.classList.toggle("active", viewMode === "comparison");
    } else if (viewMode === "single") {
      btn.classList.toggle("active", parseInt(idx, 10) === currentSessionIndex);
    } else {
      btn.classList.remove("active");
    }
  });
}

function getCurrentRecipe() {
  return manifest.recipes.find((r) => r.id === currentRecipeId);
}

function selectRecipe(recipeId, sessionIndex = 0) {
  const recipe = manifest.recipes.find((r) => r.id === recipeId);
  if (!recipe) return;
  currentRecipeId = recipeId;
  const availableIndices = recipe.sessions.map((s) => s.index);
  currentSessionIndex = availableIndices.includes(sessionIndex) ? sessionIndex : availableIndices[0];

  populateSessionTabs(recipe);
  dashboardTitle.textContent = `${recipe.name} Motion Dashboard — ${recipe.id}`;
  showSingleView();
  updateSessionTabHighlight();
  loadSessionData();
}

function selectSession(sessionIndex) {
  currentSessionIndex = sessionIndex;
  showSingleView();
  updateSessionTabHighlight();
  loadSessionData();
}

async function loadSessionData() {
  if (!currentRecipeId) return;
  const recipe = getCurrentRecipe();
  const session = recipe.sessions.find((s) => s.index === currentSessionIndex);
  if (!session) return;
  const mode = graphModeSelect.value;
  const dataUrl = getSessionDataUrl(currentRecipeId, currentSessionIndex, mode);
  try {
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    cachedData = data;
    recipeLabel.textContent = `${data.recipe.name} (${data.recipe.id})`;
    sessionLabel.textContent = `${session.index + 1} / ${recipe.sessions.length}`;
    videoLabel.textContent = data.recipe.video_id;
    summaryPill.textContent =
      `${data.graph.nodes.length} nodes · ` +
      `${data.graph.links.length} transitions · ` +
      `${data.sequence.length} actions`;
    video.src = data.recipe.video_path;
    video.currentTime = 0;
    timelineRows = drawTimeline(timelineBody, data.sequence);
    singleGraphController.buildGraph(
      data.graph, data.sequence,
      parseInt(edgeThreshold.value, 10),
      mode, colorEncodeSelect.value, sizeEncodeSelect.value,
      layoutModeSelect ? layoutModeSelect.value : "temporal",
      { onNodeClick: handleNodeClick }
    );
    rebuildAnnotationTimeline();
    rebuildLegend();
    rebuildSwimlane();
    statusLabel.innerHTML = "Status: <strong>Ready</strong>";
    actionLabel.textContent = "-";
  } catch (error) {
    renderDataError(summaryPill, header,
      "Failed to load session data: " + error.message + ` (${dataUrl})`);
    console.error(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison view
// ─────────────────────────────────────────────────────────────────────────────

async function enterComparisonMode() {
  if (!currentRecipeId) return;
  const recipe = getCurrentRecipe();
  if (!recipe.has_merged) {
    alert("This recipe has no merged data. Pick a recipe with multiple sessions.");
    return;
  }

  showComparisonView();
  updateSessionTabHighlight();

  const mode = graphModeSelect.value;

  try {
    const sessionFetches = recipe.sessions.map((s) =>
      fetch(getSessionDataUrl(currentRecipeId, s.index, mode))
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then((data) => ({
          index: s.index,
          video_id: s.video_id,
          video_path: s.video_path,
          duration_s: s.duration_s,
          payload: data,
          sequence: data.sequence,
        }))
    );
    const mergedFetch = fetch(getMergedDataUrl(currentRecipeId, mode))
      .then((r) => { if (!r.ok) throw new Error("Merged: HTTP " + r.status); return r.json(); });

    comparisonSessionPayloads = await Promise.all(sessionFetches);
    comparisonMergedPayload = await mergedFetch;
  } catch (error) {
    renderDataError(summaryPill, header, "Failed to load comparison data: " + error.message);
    console.error(error);
    return;
  }

  cmpRecipeLabel.textContent = `${recipe.name} (${recipe.id})`;
  cmpSessionLabel.textContent = `1 / ${recipe.sessions.length}`;
  summaryPill.textContent =
    `${recipe.sessions.length} sessions merged · ` +
    `${comparisonMergedPayload.graph.nodes.length} merged nodes · ` +
    `${comparisonMergedPayload.graph.links.length} merged transitions`;

  supportFilter.min = "1";
  supportFilter.max = String(recipe.sessions.length);
  supportFilter.value = "1";
  supportFilterLabel.textContent = "1";

  buildComparisonVideoUI();
  renderMergedSubmode();
  rebuildLegend();
}

function buildComparisonVideoUI() {
  if (barcodeApi) { barcodeApi.destroy(); barcodeApi = null; }
  videoQueueApi = null;
  videoQueueEl.innerHTML = "";
  barcodeStackEl.innerHTML = "";

  const sessionsForQueue = comparisonSessionPayloads.map((s) => ({
    index: s.index,
    video_path: s.video_path,
  }));
  videoQueueApi = buildVideoQueue(comparisonVideo, videoQueueEl, sessionsForQueue, {
    onActiveChange: (newIdx) => {
      comparisonActiveSession = newIdx;
      if (barcodeApi) barcodeApi.setActiveSession(newIdx);
      cmpSessionLabel.textContent = `${newIdx + 1} / ${comparisonSessionPayloads.length}`;
    },
  });
  comparisonActiveSession = comparisonSessionPayloads[0].index;

  const sessionsForBarcode = comparisonSessionPayloads.map((s) => ({
    index: s.index,
    label: `Session ${s.index + 1}`,
    sequence: s.sequence,
    duration_s: s.duration_s,
  }));
  const colorFn = getCurrentColorFn(comparisonSessionPayloads[0].sequence);
  barcodeApi = buildBarcodeStack(barcodeStackEl, sessionsForBarcode, colorFn, {
    onSegmentClick: (sessionIndex, item) => {
      if (sessionIndex !== comparisonActiveSession) {
        videoQueueApi.setActiveSession(sessionIndex);
        comparisonVideo.addEventListener("loadedmetadata", function once() {
          comparisonVideo.currentTime = item.start;
          comparisonVideo.removeEventListener("loadedmetadata", once);
        });
      } else {
        comparisonVideo.currentTime = item.start;
      }
    },
  });
  barcodeApi.setActiveSession(comparisonActiveSession);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-mode rendering: merged graph OR small multiples
// ─────────────────────────────────────────────────────────────────────────────

function renderMergedSubmode() {
  if (!comparisonMergedPayload || !comparisonSessionPayloads.length) return;

  thumbnailInstances.forEach((t) => t.destroy && t.destroy());
  thumbnailInstances = [];
  smallMultiplesContainer.innerHTML = "";

  if (mergedSubmode === "merged") {
    mergedGraphWrap.style.display = "";
    smallMultiplesContainer.style.display = "none";
    supportFilter.parentElement.style.display = "";
    renderMergedGraph();
  } else {
    mergedGraphWrap.style.display = "none";
    smallMultiplesContainer.style.display = "";
    supportFilter.parentElement.style.display = "none";
    renderSmallMultiples();
  }
}

function renderMergedGraph() {
  if (!comparisonMergedPayload) return;
  const recipe = getCurrentRecipe();
  const nSessions = recipe.sessions.length;
  const supportFilterVal = parseInt(supportFilter.value, 10);

  const firstPayload = comparisonSessionPayloads[0]?.payload;
  const stepLabelLookup = buildStepLabelLookup(firstPayload?.steps || []);
  comparisonMergedPayload.graph.nodes.forEach((n) => {
    if (n.step_label) return;
    const sid = n.merged_step_id || n.id;
    const label = resolveStepLabel(sid, stepLabelLookup);
    if (label && label !== sid) n.step_label = label;
  });

  const synthesizedSequence = comparisonMergedPayload.graph.nodes.map((n, i) => ({
    index: i,
    action: n.id,
    start: (n.mean_normalized_onset || 0) * 100,
    end: (n.mean_normalized_onset || 0) * 100 + 1,
    duration: 1,
    step_id: n.merged_step_id || null,
    is_primary: n.is_primary !== false,
    next_action: null,
    edge_key: null,
  })).sort((a, b) => a.start - b.start)
    .map((item, i) => ({ ...item, index: i }));

  const colorFn = getCurrentColorFn(synthesizedSequence);
  const mergedSizeMode = sizeEncodeSelect.value === "frequency" ? "support" : "duration";

  mergedGraphController.buildGraph(
    comparisonMergedPayload.graph,
    synthesizedSequence,
    1,
    graphModeSelect.value,
    colorEncodeSelect.value,
    mergedSizeMode,
    "temporal",
    { onNodeClick: null },
    true,
    {
      showSupportBadges: true,
      colorFn,
      supportFilter: supportFilterVal,
      nSessions,
    }
  );
}

function renderSmallMultiples() {
  smallMultiplesContainer.innerHTML = "";
  thumbnailInstances.forEach((t) => t.destroy && t.destroy());
  thumbnailInstances = [];

  comparisonSessionPayloads.forEach((s) => {
    const row = document.createElement("div");
    row.className = "thumbnail-graph-wrap";

    const heading = document.createElement("div");
    heading.className = "thumbnail-graph-heading";
    heading.textContent =
      `Session ${s.index + 1} — ${s.payload.graph.nodes.length} nodes · ` +
      `${s.payload.graph.links.length} transitions · ` +
      `${s.duration_s.toFixed(1)}s`;
    row.appendChild(heading);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("thumbnail-graph-svg");
    row.appendChild(svg);

    smallMultiplesContainer.appendChild(row);

    requestAnimationFrame(() => {
      const inst = buildThumbnailGraph(svg, s.payload.graph, s.payload.sequence, {
        colorFn: getCurrentColorFn(s.payload.sequence),
      });
      thumbnailInstances.push(inst);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison-video event handlers
// ─────────────────────────────────────────────────────────────────────────────

comparisonVideo.addEventListener("timeupdate", () => {
  if (viewMode !== "comparison" || !barcodeApi) return;
  cmpTimeLabel.textContent = formatSeconds(comparisonVideo.currentTime || 0);
  barcodeApi.updatePlayhead(comparisonActiveSession, comparisonVideo.currentTime || 0);
});
comparisonVideo.addEventListener("seeked", () => {
  if (viewMode !== "comparison" || !barcodeApi) return;
  barcodeApi.updatePlayhead(comparisonActiveSession, comparisonVideo.currentTime || 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Control event listeners
// ─────────────────────────────────────────────────────────────────────────────

recipeSelect.addEventListener("change", () => selectRecipe(recipeSelect.value, 0));

function updateColorEncodeAvailability() {
  const isAbstracted = graphModeSelect.value === "abstracted";
  const categoryOption = colorEncodeSelect.querySelector('option[value="category"]');
  if (!categoryOption) return;

  categoryOption.disabled = isAbstracted;
  if (isAbstracted) {
    categoryOption.title = "Action category doesn't apply in Task Phases level " +
                           "(node IDs are recipe steps, not actions).";
    if (colorEncodeSelect.value === "category") {
      colorEncodeSelect.value = "phase";
      colorEncodeSelect.dispatchEvent(new Event("change"));
    }
  } else {
    categoryOption.title = "";
  }
}

graphModeSelect.addEventListener("change", () => {
  updateColorEncodeAvailability();
  if (viewMode === "single") loadSessionData();
  else enterComparisonMode();
});

edgeThreshold.addEventListener("input", () => {
  thresholdLabel.textContent = edgeThreshold.value;
  if (viewMode !== "single" || !cachedData) return;
  singleGraphController.buildGraph(
    cachedData.graph, cachedData.sequence,
    parseInt(edgeThreshold.value, 10),
    graphModeSelect.value, colorEncodeSelect.value, sizeEncodeSelect.value,
    layoutModeSelect ? layoutModeSelect.value : "temporal",
    { onNodeClick: handleNodeClick }
  );
  rebuildAnnotationTimeline();
  rebuildLegend();
});

colorEncodeSelect.addEventListener("change", () => {
  if (viewMode === "single") {
    rebuildLegend();
    rebuildAnnotationTimeline();
    rebuildSwimlane();
    if (!cachedData) return;
    singleGraphController.buildGraph(
      cachedData.graph, cachedData.sequence,
      parseInt(edgeThreshold.value, 10),
      graphModeSelect.value, colorEncodeSelect.value, sizeEncodeSelect.value,
      layoutModeSelect ? layoutModeSelect.value : "temporal",
      { onNodeClick: handleNodeClick }, false
    );
  } else {
    buildComparisonVideoUI();
    renderMergedSubmode();
    rebuildLegend();
  }
});

sizeEncodeSelect.addEventListener("input", () => {
  if (viewMode === "single") {
    rebuildLegend();
    rebuildAnnotationTimeline();
    if (!cachedData) return;
    singleGraphController.buildGraph(
      cachedData.graph, cachedData.sequence,
      parseInt(edgeThreshold.value, 10),
      graphModeSelect.value, colorEncodeSelect.value, sizeEncodeSelect.value,
      layoutModeSelect ? layoutModeSelect.value : "temporal",
      { onNodeClick: handleNodeClick }, false
    );
  } else {
    if (mergedSubmode === "merged") renderMergedGraph();
    rebuildLegend();
  }
});

if (layoutModeSelect) {
  layoutModeSelect.addEventListener("change", () => {
    if (viewMode !== "single" || !cachedData) return;
    singleGraphController.buildGraph(
      cachedData.graph, cachedData.sequence,
      parseInt(edgeThreshold.value, 10),
      graphModeSelect.value, colorEncodeSelect.value, sizeEncodeSelect.value,
      layoutModeSelect.value,
      { onNodeClick: handleNodeClick }
    );
    rebuildAnnotationTimeline();
    rebuildLegend();
  });
}

document.querySelectorAll("#mergedSubmodeTabs .submode-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#mergedSubmodeTabs .submode-tab").forEach((b) =>
      b.classList.toggle("active", b === btn));
    mergedSubmode = btn.dataset.submode;
    if (viewMode === "comparison") renderMergedSubmode();
  });
});

supportFilter.addEventListener("input", () => {
  supportFilterLabel.textContent = supportFilter.value;
  if (viewMode === "comparison" && mergedSubmode === "merged") {
    renderMergedGraph();
  }
});

const resetLayoutButton = document.querySelector("#resetLayout");
if (resetLayoutButton) {
  resetLayoutButton.onclick = () => singleGraphController.resetLayout();
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  if (!window.d3) {
    renderDataError(summaryPill, header, "D3 was not loaded. Please reload.");
    return;
  }

  await loadVerbCategories('../../../narrations-and-action-segments/HD_EPIC_verb_classes.csv');

  graphModeSelect.value = DEFAULT_DATA_MODE;
  colorEncodeSelect.value = DEFAULT_COLOR_ENCODE_MODE;
  sizeEncodeSelect.value = "frequency";
  if (layoutModeSelect) layoutModeSelect.value = "temporal";

  updateColorEncodeAvailability();

  const ok = await loadManifest();
  if (!ok) return;

  populateRecipeDropdown();
  rebuildLegend();

  const firstRecipe = manifest.recipes[0];
  recipeSelect.value = firstRecipe.id;
  selectRecipe(firstRecipe.id, 0);

  video.addEventListener("play", () => {
    singleGraphController.setAutoZoom(false);
    appRoot.classList.remove("paused");
    statusLabel.innerHTML = "Status: <strong>Playing</strong>";
    refresh();
  });
  video.addEventListener("pause", () => {
    singleGraphController.setAutoZoom(true);
    appRoot.classList.add("paused");
    statusLabel.innerHTML = "Status: <strong>Paused</strong>";
    refresh();
  });
  video.addEventListener("timeupdate", refresh);
  video.addEventListener("seeked", refresh);
  video.addEventListener("ended", () => {
    singleGraphController.setAutoZoom(true);
    appRoot.classList.add("paused");
    statusLabel.innerHTML = "Status: <strong>Ended</strong>";
    refresh();
  });

  document.getElementById("graphSvg").addEventListener("click", (e) => {
    if (e.target.tagName === "svg" || e.target.id === "zoomGroup") {
      lastClickedNodeId = null;
      occurrenceCycleIndex = 0;
      d3.selectAll(".node").classed("selected", false);
    }
  });

  annotationTimeline.addEventListener("click", (e) => {
    if (e.target === annotationTimeline) {
      const rect = annotationTimeline.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      video.currentTime = pct * currentTotalDuration;
    }
  });
}

init();