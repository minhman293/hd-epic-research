// app.js
// Main controller. Phase 1: loads manifest at startup, populates recipe
// dropdown and session-picker tabs, switches data on selection.

import {
  getManifestUrl,
  getSessionDataUrl,
  DEFAULT_DATA_MODE,
  DEFAULT_COLOR_ENCODE_MODE,
  getLegendItems,
  getStepPhaseColor,
} from "./config.js";

import { createGraphController } from "./graph.js";
import { buildLegend } from "./legend.js";
import { buildAnnotationTimeline, updateAnnotationPlayhead } from "./annotationTimeline.js";
import { drawTimeline, updateTimelineActive } from "./timeline.js";
import { currentSequenceItem, formatSeconds, renderDataError, nodeColor } from "./utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// DOM references
// ─────────────────────────────────────────────────────────────────────────────

const appRoot = document.getElementById("appRoot");
const dashboardTitle = document.getElementById("dashboardTitle");
const summaryPill = document.getElementById("summaryPill");
const recipeLabel = document.getElementById("recipeLabel");
const sessionLabel = document.getElementById("sessionLabel");
const videoLabel = document.getElementById("videoLabel");
const timeLabel = document.getElementById("timeLabel");
const actionLabel = document.getElementById("actionLabel");
const statusLabel = document.getElementById("statusLabel");
const timelineBody = document.getElementById("timelineBody");
const footerPanel = document.querySelector(".footerPanel");
const legendStrip = document.getElementById("legendStrip");
const header = document.querySelector(".header");
const video = document.getElementById("video");
const recipeSelect = document.getElementById("recipeSelect");
const sessionPickerRow = document.getElementById("sessionPickerRow");
const sessionPickerTabs = document.getElementById("sessionPickerTabs");
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

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let manifest = null;
let currentRecipeId = null;
let currentSessionIndex = 0;
let cachedData = null;
let timelineRows = [];
let annotationPlayheadEl = null;
let currentTotalDuration = 0;

let lastClickedNodeId = null;
let occurrenceCycleIndex = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Node click → seek video, cycle occurrences
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-frame refresh
// ─────────────────────────────────────────────────────────────────────────────

function refresh() {
  if (!cachedData) return;

  const item = currentSequenceItem(cachedData.sequence, video.currentTime || 0);
  timeLabel.textContent = formatSeconds(video.currentTime || 0);
  actionLabel.textContent = item ? item.action : "-";

  // Auto-deselect when playback moves past the selected node
  if (lastClickedNodeId && item && item.action !== lastClickedNodeId) {
    lastClickedNodeId = null;
    occurrenceCycleIndex = 0;
    d3.selectAll(".node").classed("selected", false);
  }

  graphController.updateActive(item);
  updateTimelineActive(timelineRows, footerPanel, item);

  if (annotationPlayheadEl && currentTotalDuration > 0) {
    updateAnnotationPlayhead(annotationPlayheadEl, video.currentTime || 0, currentTotalDuration);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legend + annotation timeline
// ─────────────────────────────────────────────────────────────────────────────

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
    // Path B: in the abstracted view, the action label IS the step label (S01...).
    // In smart/full views, look up the step for this action from the sequence
    // (majority vote across occurrences).
    if (graphMode === "abstracted") {
      return (action) => getStepPhaseColor(action);
    }

    // Build per-action majority step from the sequence
    if (!cachedData) return () => "#94A3B8";
    const stepVotes = {};
    cachedData.sequence.forEach((s) => {
      if (!stepVotes[s.action]) stepVotes[s.action] = {};
      const sid = s.step_id;
      if (!sid) return;
      // Convert raw step_id to display form: P01_R01_S02 → S02
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
    if (!cachedData) return () => "#94A3B8";
    const durationMap = {};
    cachedData.sequence.forEach((s) => {
      if (!durationMap[s.action]) durationMap[s.action] = [];
      durationMap[s.action].push(s.duration);
    });
    const meanDuration = {};
    Object.entries(durationMap).forEach(([a, ds]) => {
      meanDuration[a] = ds.reduce((sum, v) => sum + v, 0) / ds.length;
    });
    const vals = Object.values(meanDuration).filter((v) => isFinite(v));
    const colorScale = d3
      .scaleSequential()
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

// ─────────────────────────────────────────────────────────────────────────────
// Manifest loading + recipe/session UI population
// ─────────────────────────────────────────────────────────────────────────────

async function loadManifest() {
  try {
    const response = await fetch(getManifestUrl());
    if (!response.ok) throw new Error("HTTP " + response.status);
    manifest = await response.json();
  } catch (error) {
    renderDataError(
      summaryPill,
      header,
      `Failed to load manifest.json. Did you run \`python 7_build_manifest.py\`? (${error.message})`
    );
    console.error(error);
    return false;
  }

  if (!manifest.recipes || manifest.recipes.length === 0) {
    renderDataError(
      summaryPill,
      header,
      "Manifest is empty. Run `python 6_prepare_dashboard_data.py <recipe>` for at least one recipe."
    );
    return false;
  }
  return true;
}

function populateRecipeDropdown() {
  recipeSelect.innerHTML = "";
  manifest.recipes.forEach((recipe) => {
    const opt = document.createElement("option");
    opt.value = recipe.id;
    opt.textContent = `${recipe.name} (${recipe.id}) — ${recipe.sessions.length} session${
      recipe.sessions.length === 1 ? "" : "s"
    }`;
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

  // "Merged" tab — visible only if 2+ sessions. Phase 1: clicking shows an
  // alert; Phase 3 will hook in the comparison view.
  if (recipe.sessions.length >= 2) {
    const mergedBtn = document.createElement("button");
    mergedBtn.className = "session-tab merged-tab";
    mergedBtn.dataset.sessionIndex = "merged";
    mergedBtn.textContent = "Merged";
    mergedBtn.title = "Comparison view (coming in Phase 3)";
    mergedBtn.addEventListener("click", () => {
      alert("Merged session view is coming in Phase 3. For now, please pick an individual session.");
    });
    sessionPickerTabs.appendChild(mergedBtn);
  }

  sessionPickerRow.style.display = "";
  updateSessionTabHighlight();
}

function updateSessionTabHighlight() {
  Array.from(sessionPickerTabs.children).forEach((btn) => {
    const idx = btn.dataset.sessionIndex;
    btn.classList.toggle(
      "active",
      idx !== "merged" && parseInt(idx, 10) === currentSessionIndex
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipe + session switching
// ─────────────────────────────────────────────────────────────────────────────

function getCurrentRecipe() {
  return manifest.recipes.find((r) => r.id === currentRecipeId);
}

function selectRecipe(recipeId, sessionIndex = 0) {
  const recipe = manifest.recipes.find((r) => r.id === recipeId);
  if (!recipe) {
    console.warn(`Recipe ${recipeId} not found in manifest.`);
    return;
  }
  currentRecipeId = recipeId;

  // Default to session 0 (or override) if the requested session doesn't exist
  const availableIndices = recipe.sessions.map((s) => s.index);
  currentSessionIndex = availableIndices.includes(sessionIndex)
    ? sessionIndex
    : availableIndices[0];

  populateSessionTabs(recipe);
  dashboardTitle.textContent = `${recipe.name} Motion Dashboard — ${recipe.id}`;

  loadSessionData();
}

function selectSession(sessionIndex) {
  currentSessionIndex = sessionIndex;
  updateSessionTabHighlight();
  loadSessionData();
}

async function loadSessionData() {
  if (!currentRecipeId) return;

  const recipe = getCurrentRecipe();
  const session = recipe.sessions.find((s) => s.index === currentSessionIndex);
  if (!session) {
    console.error(`No session ${currentSessionIndex} for recipe ${currentRecipeId}`);
    return;
  }

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

    graphController.buildGraph(
      data.graph,
      data.sequence,
      parseInt(edgeThreshold.value, 10),
      mode,
      colorEncodeSelect.value,
      sizeEncodeSelect.value,
      layoutModeSelect ? layoutModeSelect.value : "temporal",
      { onNodeClick: handleNodeClick }
    );

    rebuildAnnotationTimeline();
    rebuildLegend();
    statusLabel.innerHTML = "Status: <strong>Ready</strong>";
    actionLabel.textContent = "-";
  } catch (error) {
    renderDataError(
      summaryPill,
      header,
      "Failed to load session data: " + error.message + ` (${dataUrl})`
    );
    console.error(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Control event listeners
// ─────────────────────────────────────────────────────────────────────────────

recipeSelect.addEventListener("change", () => {
  // Per design: switching recipes resets to session 0
  selectRecipe(recipeSelect.value, 0);
});

graphModeSelect.addEventListener("change", () => {
  loadSessionData();
});

edgeThreshold.addEventListener("input", () => {
  thresholdLabel.textContent = edgeThreshold.value;
  if (!cachedData) return;
  graphController.buildGraph(
    cachedData.graph,
    cachedData.sequence,
    parseInt(edgeThreshold.value, 10),
    graphModeSelect.value,
    colorEncodeSelect.value,
    sizeEncodeSelect.value,
    layoutModeSelect ? layoutModeSelect.value : "temporal",
    { onNodeClick: handleNodeClick }
  );
  rebuildAnnotationTimeline();
  rebuildLegend();
});

colorEncodeSelect.addEventListener("change", () => {
  rebuildLegend();
  rebuildAnnotationTimeline();
  if (!cachedData) return;
  graphController.buildGraph(
    cachedData.graph,
    cachedData.sequence,
    parseInt(edgeThreshold.value, 10),
    graphModeSelect.value,
    colorEncodeSelect.value,
    sizeEncodeSelect.value,
    layoutModeSelect ? layoutModeSelect.value : "temporal",
    { onNodeClick: handleNodeClick },
    false
  );
});

sizeEncodeSelect.addEventListener("input", () => {
  rebuildLegend();
  rebuildAnnotationTimeline();
  if (!cachedData) return;
  graphController.buildGraph(
    cachedData.graph,
    cachedData.sequence,
    parseInt(edgeThreshold.value, 10),
    graphModeSelect.value,
    colorEncodeSelect.value,
    sizeEncodeSelect.value,
    layoutModeSelect ? layoutModeSelect.value : "temporal",
    { onNodeClick: handleNodeClick },
    false
  );
});

if (layoutModeSelect) {
  layoutModeSelect.addEventListener("change", () => {
    if (!cachedData) return;
    graphController.buildGraph(
      cachedData.graph,
      cachedData.sequence,
      parseInt(edgeThreshold.value, 10),
      graphModeSelect.value,
      colorEncodeSelect.value,
      sizeEncodeSelect.value,
      layoutModeSelect.value,
      { onNodeClick: handleNodeClick }
    );
    rebuildAnnotationTimeline();
    rebuildLegend();
  });
}

const resetLayoutButton = document.querySelector("#resetLayout");
if (resetLayoutButton) {
  resetLayoutButton.onclick = () => graphController.resetLayout();
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  if (!window.d3) {
    renderDataError(summaryPill, header, "D3 was not loaded. Please reload.");
    return;
  }

  graphModeSelect.value = DEFAULT_DATA_MODE;
  colorEncodeSelect.value = DEFAULT_COLOR_ENCODE_MODE;
  sizeEncodeSelect.value = "frequency";
  if (layoutModeSelect) layoutModeSelect.value = "temporal";

  const ok = await loadManifest();
  if (!ok) return;

  populateRecipeDropdown();
  rebuildLegend();

  // Auto-select the first recipe
  const firstRecipe = manifest.recipes[0];
  recipeSelect.value = firstRecipe.id;
  selectRecipe(firstRecipe.id, 0);

  // Video event listeners
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

  // SVG background click → clear selection
  document.getElementById("graphSvg").addEventListener("click", (e) => {
    if (e.target.tagName === "svg" || e.target.id === "zoomGroup") {
      lastClickedNodeId = null;
      occurrenceCycleIndex = 0;
      d3.selectAll(".node").classed("selected", false);
    }
  });

  // Click on annotation strip background → seek
  annotationTimeline.addEventListener("click", (e) => {
    if (e.target === annotationTimeline) {
      const rect = annotationTimeline.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      video.currentTime = pct * currentTotalDuration;
    }
  });
}

init();