import {
  getManifestUrl,
  getSessionDataUrl,
  getMergedDataUrl,
  DEFAULT_DATA_MODE,
  DEFAULT_COLOR_ENCODE_MODE,
  loadVerbCategories,
  getLegendItems,
  getStepPhaseColor,
  buildStepLabelLookup
} from "./config.js";

import { createGraphController } from "./graph.js";
import { buildLegend } from "./legend.js";
import { buildAnnotationTimeline, updateAnnotationPlayhead } from "./annotationTimeline.js";
import { drawTimeline, updateTimelineActive } from "./timeline.js";
import { currentSequenceItem, formatSeconds, renderDataError, nodeColor } from "./utils.js";

import { buildBarcodeStack } from "./barcodeStack.js";
import { buildVideoQueue } from "./videoQueue.js";
import { buildSwimlane } from "./swimlane.js";
import { makeCaptureController } from "./captureController.js";

// ─────────────────────────────────────────────────────────────────────────────
// DOM references
// ─────────────────────────────────────────────────────────────────────────────

const appRoot = document.getElementById("appRoot");
const dashboardTitle = document.getElementById("dashboardTitle");
const summaryPill = document.getElementById("summaryPill");
const header = document.querySelector(".header");

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

const annotationTimelineWrap = document.getElementById("annotationTimelineWrap");
const annotationTimeline = document.getElementById("annotationTimeline");
const swimlanePanel = document.getElementById("swimlanePanel");
const swimlaneContainer = document.getElementById("swimlaneContainer");

const videoQueueRow = document.getElementById("videoQueueRow");
const videoQueueEl = document.getElementById("videoQueue");
const barcodeStackWrap = document.getElementById("barcodeStackWrap");
const barcodeStackEl = document.getElementById("barcodeStack");

const recipeSelect = document.getElementById("recipeSelect");
const sessionPickerRow = document.getElementById("sessionPickerRow");
const sessionPickerTabs = document.getElementById("sessionPickerTabs");

const graphModeSelect = document.getElementById("graphModeSelect");
const colorEncodeSelect = document.getElementById("colorEncodeSelect");
const sizeEncodeSelect = document.getElementById("sizeEncodeSelect");
const layoutModeSelect = document.getElementById("layoutModeSelect");
const highlightSpineBtn = document.getElementById("highlightSpineBtn");
const graphSourceSelect = document.getElementById("graphSourceSelect");
const graphPanelTitle = document.getElementById("graphPanelTitle");

// ─────────────────────────────────────────────────────────────────────────────
// Graph controller
// ─────────────────────────────────────────────────────────────────────────────

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
let currentSessionIndex = 'all';
// "merged" | "session" | "session_raw"
// session      -> that session's own primary graph (the "before merge" column)
// session_raw  -> that session's graph_unfiltered (every action, nothing removed)
let currentGraphSource = "merged";

let mergedGraphPayload = null;
let sessionPayloadsMap = {};

let activeVideoSession = 0; 
let timelineRows = [];
let annotationPlayheadEl = null;

let swimlaneApi = null;
let barcodeApi = null;
let videoQueueApi = null;
let captureCtrl = null;        

let lastClickedNodeId = null;
let occurrenceCycleIndex = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Graph Settings & Refresh
// ─────────────────────────────────────────────────────────────────────────────

// Which session a per-session view should render. Falls back to the first
// session when the "All" tab is active.
function sessionIndexForGraph() {
  if (currentSessionIndex !== "all") return currentSessionIndex;
  const recipe = getCurrentRecipe();
  return recipe?.sessions?.[0]?.index ?? 0;
}

// Session payloads carry no cross-session fields. Synthesize them so the
// renderer and the highlight code can treat every source uniformly.
function decorateSessionGraph(graph) {
  const copy = {
    nodes: graph.nodes.map((n) => ({ ...n })),
    links: graph.links.map((l) => ({ ...l })),
  };
  copy.nodes.forEach((n) => {
    n.per_session_counts = [n.count];
    n.support = 1; n.support_fraction = 1; n.n_sessions = 1;
  });
  copy.links.forEach((l) => {
    l.per_session_counts = [l.count];
    l.support = 1; l.support_fraction = 1; l.n_sessions = 1;
  });
  return copy;
}

function synthSpine(sequence) {
  const spine = [];
  sequence.forEach((item) => {
    if (spine.length === 0 || spine[spine.length - 1] !== item.action) {
      spine.push(item.action);
    }
  });
  return spine;
}

// Resolve whichever graph the source dropdown is asking for.
// Returns null when the requested graph is unavailable (e.g. graph_unfiltered
// missing because the JSON predates the filter-ledger pipeline).
function getActiveGraphView() {
  if (!mergedGraphPayload) return null;

  if (currentGraphSource === "merged") {
    const nSessions = mergedGraphPayload.recipe.n_sessions;
    return {
      graph: mergedGraphPayload.graph,
      sequence: mergedGraphPayload.sequence,
      nSessions,
      spine: mergedGraphPayload.analysis?.canonical_spine || [],
      showSupportBadges: nSessions > 1,
      isMerged: true,
      title: "Merged Motion Graph",
    };
  }

  const si = sessionIndexForGraph();
  const payload = sessionPayloadsMap[si];
  if (!payload) return null;

  const raw = currentGraphSource === "session_raw";
  const source = raw ? payload.graph_unfiltered : payload.graph;
  if (!source) return null;

  const sequence = (raw
    ? payload.sequence
    : payload.sequence.filter((i) => i.is_primary !== false)
  ).map((i) => ({ ...i, session_index: si }));

  return {
    graph: decorateSessionGraph(source),
    sequence,
    nSessions: 1,
    spine: synthSpine(sequence),
    showSupportBadges: false,
    isMerged: false,
    sessionIndex: si,
    raw,
    // Session tabs are labelled 1-based ("Session 2"); session.index is 0-based.
    // Use the tab's numbering so the panel title and the active tab agree.
    title: raw
      ? `Session ${si + 1} — Raw (unfiltered)`
      : `Session ${si + 1} — Filtered (primary only)`,
  };
}

function reapplyGraphSettings(resetPositions = false) {
  if (!mergedGraphPayload) return;

  let view = getActiveGraphView();
  if (!view) {
    // Requested graph is unavailable — revert rather than render nothing.
    const wanted = currentGraphSource;
    currentGraphSource = "merged";
    if (graphSourceSelect) graphSourceSelect.value = "merged";
    view = getActiveGraphView();
    if (!view) return;
    renderDataError(
      summaryPill, header,
      wanted === "session_raw"
        ? "This recipe's JSON has no graph_unfiltered — re-run 6_prepare_dashboard_data.py to enable the raw view."
        : "Session graph unavailable; showing the merged graph."
    );
  }

  if (graphPanelTitle) graphPanelTitle.textContent = view.title;

  graphController.buildGraph(
    view.graph,
    view.sequence,
    1,
    graphModeSelect.value,
    colorEncodeSelect.value,
    sizeEncodeSelect.value,
    layoutModeSelect.value,
    { onNodeClick: handleNodeClick },
    resetPositions,
    {
      showSupportBadges: view.showSupportBadges,
      supportFilter: 1,
      nSessions: view.nSessions,
      canonicalSpine: view.spine
    }
  );

  rebuildLegend();
  selectSession(currentSessionIndex);
}

function handleNodeClick(d, sequence) {
  const seqToSearch = currentSessionIndex === 'all' 
    ? sessionPayloadsMap[activeVideoSession]?.sequence || []
    : sessionPayloadsMap[currentSessionIndex]?.sequence || [];
    
  const occurrences = seqToSearch.filter((item) => item.action === d.id);
  if (occurrences.length === 0) return;

  if (lastClickedNodeId !== d.id) {
    occurrenceCycleIndex = 0;
    lastClickedNodeId = d.id;
  } else {
    occurrenceCycleIndex = (occurrenceCycleIndex + 1) % occurrences.length;
  }
  const target = occurrences[occurrenceCycleIndex];
  if (captureCtrl) captureCtrl.seekUnified(target.start);
  
  d3.selectAll(".node").classed("selected", (n) => n.id === d.id);
  statusLabel.innerHTML =
    `Status: <strong>Selected ${d.id} (${occurrenceCycleIndex + 1}/${occurrences.length})</strong>`;
}

function refresh() {
  if (!mergedGraphPayload) return;
  const t = captureCtrl ? captureCtrl.getUnifiedTime() : 0;
  
  const seqToSearch = currentSessionIndex === 'all' 
    ? sessionPayloadsMap[activeVideoSession]?.sequence || []
    : sessionPayloadsMap[currentSessionIndex]?.sequence || [];
    
  const item = currentSequenceItem(seqToSearch, t);
  timeLabel.textContent = formatSeconds(t);
  actionLabel.textContent = item ? item.action : "-";
  
  if (lastClickedNodeId && item && item.action !== lastClickedNodeId) {
    lastClickedNodeId = null;
    occurrenceCycleIndex = 0;
    d3.selectAll(".node").classed("selected", false);
  }
  
  graphController.updateActive(item);
  updateTimelineActive(timelineRows, footerPanel, item);
  
  if (currentSessionIndex !== 'all') {
    if (annotationPlayheadEl) {
      const dur = sessionPayloadsMap[activeVideoSession]?.recipe?.total_capture_duration_s || 1;
      updateAnnotationPlayhead(annotationPlayheadEl, t, dur);
    }
    if (swimlaneApi) swimlaneApi.updatePlayhead(t);
  } else {
    if (barcodeApi) barcodeApi.updatePlayhead(activeVideoSession, t);
  }
}

function rebuildLegend() {
  const seq = mergedGraphPayload?.sequence || [];
  const stepLabelLookup = buildStepLabelLookup(mergedGraphPayload?.steps || []);
  buildLegend(
    legendStrip,
    getLegendItems(
      colorEncodeSelect.value,
      sizeEncodeSelect.value,
      graphModeSelect.value,
      seq,
      stepLabelLookup
    ),
    colorEncodeSelect.value,
    seq
  );
}

function getCurrentColorFn(seqOverride) {
  const colorMode = colorEncodeSelect.value;
  const graphMode = graphModeSelect.value;
  const seq = seqOverride || mergedGraphPayload?.sequence || [];

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

function rebuildAnnotationTimeline(payload) {
  const el = document.getElementById('annotationTimeline');
  if (!payload || !el) return;
  const dur = payload.recipe?.total_capture_duration_s || 1;
  annotationPlayheadEl = buildAnnotationTimeline(
    el, payload.sequence, dur, getCurrentColorFn(), {
      onSegmentClick: (item) => {
        if (captureCtrl) captureCtrl.seekUnified(item.start);
        const node = d3.select(`.node[data-id="${CSS.escape(item.action)}"]`);
        if (!node.empty()) {
          d3.selectAll(".node").classed("selected", false);
          node.classed("selected", true);
        }
      },
    }
  );
}

function rebuildSwimlane(payload) {
  if (swimlaneApi) { swimlaneApi.destroy(); swimlaneApi = null; }
  const el = document.getElementById('swimlaneContainer');
  if (!payload || !el) return;
  const lookup = buildStepLabelLookup(payload.steps || []);
  swimlaneApi = buildSwimlane(el, payload, getCurrentColorFn(), {
    onSegmentClick: (item) => {
      if (captureCtrl) captureCtrl.seekUnified(item.start);
      if (!item.synthetic) {
        const node = d3.select(`.node[data-id="${CSS.escape(item.action)}"]`);
        if (!node.empty()) {
          d3.selectAll(".node").classed("selected", false);
          node.classed("selected", true);
        }
      }
    },
    stepLabelLookup: lookup,
    colorMode: colorEncodeSelect.value,
  });
}

function updateMetaLabels(idx) {
  const recipe = getCurrentRecipe();
  recipeLabel.textContent = `${recipe.name} (${recipe.id})`;
  sessionLabel.textContent = `${idx + 1} / ${recipe.sessions.length}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Fetch & Core Logic
// ─────────────────────────────────────────────────────────────────────────────

async function loadManifest() {
  try {
    const response = await fetch(getManifestUrl());
    if (!response.ok) throw new Error("HTTP " + response.status);
    let fullManifest = await response.json();

    // ─────────────────────────────────────────────────────────────────
    // TEMPORARY FILTER: Only keep the recipes you want to visualize now
    // ─────────────────────────────────────────────────────────────────
    const targetRecipes = ["P01_R01", "P03_R03", "P08_R01"];
    
    fullManifest.recipes = fullManifest.recipes.filter(r => 
      targetRecipes.includes(r.id)
    );

    manifest = fullManifest;
  } catch (error) {
    renderDataError(summaryPill, header, `Failed to load manifest.json. (${error.message})`);
    return false;
  }
  
  if (!manifest.recipes || manifest.recipes.length === 0) {
    renderDataError(summaryPill, header, "No target recipes found in the manifest.");
    return false;
  }
  
  return true;
}

function populateRecipeDropdown() {
  recipeSelect.innerHTML = "";
  manifest.recipes.forEach((recipe) => {
    const opt = document.createElement("option");
    opt.value = recipe.id;
    opt.textContent = `${recipe.name} (${recipe.id}) — ${recipe.sessions.length} session${recipe.sessions.length === 1 ? "" : "s"}`;
    recipeSelect.appendChild(opt);
  });
}

function populateSessionTabs(recipe) {
  sessionPickerTabs.innerHTML = "";
  
  if (recipe.sessions.length > 1) {
    const allBtn = document.createElement("button");
    allBtn.className = "session-tab merged-tab";
    allBtn.dataset.sessionIndex = "all";
    allBtn.textContent = "All Sessions";
    allBtn.addEventListener("click", () => onSessionTabClick("all"));
    sessionPickerTabs.appendChild(allBtn);
  }

  recipe.sessions.forEach((session) => {
    const btn = document.createElement("button");
    btn.className = "session-tab";
    btn.dataset.sessionIndex = String(session.index);
    btn.textContent = `Session ${session.index + 1}`;
    btn.addEventListener("click", () => onSessionTabClick(session.index));
    sessionPickerTabs.appendChild(btn);
  });

  sessionPickerRow.style.display = "";
}

// A session tab changes WHICH graph is drawn when a per-session source is
// selected, so it needs a rebuild — not just a highlight update.
function onSessionTabClick(idx) {
  if (currentGraphSource !== "merged") {
    currentSessionIndex = idx;
    if (idx === "all" && graphSourceSelect) {
      // "All" has no meaning for a per-session graph; go back to merged.
      currentGraphSource = "merged";
      graphSourceSelect.value = "merged";
    }
    reapplyGraphSettings(true);
    return;
  }
  selectSession(idx);
}

function getCurrentRecipe() {
  return manifest.recipes.find((r) => r.id === currentRecipeId);
}

async function loadRecipeData() {
  if (!currentRecipeId) return;
  const recipe = getCurrentRecipe();
  const mode = graphModeSelect.value;
  
  try {
    // 1. Fetch Merged Graph (or synthesize from Session 0)
    if (recipe.has_merged) {
      const res = await fetch(getMergedDataUrl(currentRecipeId, mode));
      if (!res.ok) throw new Error("HTTP " + res.status);
      mergedGraphPayload = await res.json();
    } else {
      const res = await fetch(getSessionDataUrl(currentRecipeId, 0, mode));
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      
      // Inject fields to make single-session data behave like merged data
      data.graph.nodes.forEach(n => {
          n.per_session_counts = [n.count];
          n.support = 1;
      });
      data.graph.links.forEach(l => {
          l.per_session_counts = [l.count];
          l.support = 1;
      });
      
      // Synthesize a canonical spine (the exact sequence)
      const spine = [];
      data.sequence.forEach(item => {
         if (spine.length === 0 || spine[spine.length-1] !== item.action) {
             spine.push(item.action);
         }
      });

      mergedGraphPayload = {
        recipe: { ...data.recipe, n_sessions: 1, session_indices: [0] },
        graph: data.graph,
        sequence: data.sequence.map(s => ({...s, session_index: 0})),
        analysis: {
           ...data.analysis,
           canonical_spine: spine
        },
        steps: data.steps
      };
    }

    // 2. Fetch individual session payloads
    sessionPayloadsMap = {};
    const fetches = recipe.sessions.map(s => 
      fetch(getSessionDataUrl(currentRecipeId, s.index, mode))
        .then(r => r.json())
        .then(d => { sessionPayloadsMap[s.index] = d; })
    );
    await Promise.all(fetches);
    
    // 3. Update UI & Build Base Graph
    populateSessionTabs(recipe);
    reapplyGraphSettings(true);
    selectSession(recipe.has_merged ? 'all' : 0);

  } catch (error) {
    console.error(error);
    renderDataError(summaryPill, header, "Failed to load recipe data.");
  }
}

function selectSession(idx) {
  currentSessionIndex = idx;
  const recipe = getCurrentRecipe();
  
  // 1. Update Tab styling
  Array.from(sessionPickerTabs.children).forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sessionIndex == String(idx));
  });

  // 2. Update Graph Highlights
  // Session highlighting only makes sense against the merged graph. When a
  // per-session graph is on screen it already IS that session, and its nodes
  // carry synthesized support fields that highlightSession would misread.
  const usingSessionGraph = currentGraphSource !== "merged";
  if (idx === 'all' || recipe.sessions.length === 1 || usingSessionGraph) {
      graphController.clearHighlight();
      highlightSpineBtn.classList.remove('active');
  } else {
      graphController.highlightSession(idx);
      highlightSpineBtn.classList.remove('active');
  }

  // 3. Update Panels & Player
  if (idx === 'all') {
      barcodeStackWrap.style.display = '';
      annotationTimelineWrap.style.display = 'none';
      videoQueueRow.style.display = '';
      swimlanePanel.style.display = 'none';

      const sessionsForQueue = recipe.sessions.map(s => ({
          index: s.index,
          videos: sessionPayloadsMap[s.index].videos,
          video_path: s.video_path
      }));
      
      if (videoQueueApi) videoQueueApi = null;
      videoQueueEl.innerHTML = '';
      videoQueueApi = buildVideoQueue(videoQueueEl, sessionsForQueue, {
          onActiveChange: (newIdx) => {
              activeVideoSession = newIdx;
              if (captureCtrl) captureCtrl.load(sessionPayloadsMap[newIdx].videos || []);
              if (barcodeApi) barcodeApi.setActiveSession(newIdx);
              updateMetaLabels(newIdx);
          }
      });

      const sessionsForBarcode = recipe.sessions.map(s => ({
          index: s.index,
          label: `Session ${s.index + 1}`,
          sequence: sessionPayloadsMap[s.index].sequence,
          duration_s: s.duration_s
      }));

      if (barcodeApi) barcodeApi.destroy();
      barcodeApi = buildBarcodeStack(barcodeStackEl, sessionsForBarcode, getCurrentColorFn(), {
          onSegmentClick: (sIdx, item) => {
              if (captureCtrl && activeVideoSession !== sIdx) {
                  activeVideoSession = sIdx;
                  captureCtrl.load(sessionPayloadsMap[sIdx].videos || []);
                  if(videoQueueApi) videoQueueApi.setActiveSession(sIdx);
                  updateMetaLabels(sIdx);
              }
              if (captureCtrl) captureCtrl.seekUnified(item.start);
          }
      });
      
      activeVideoSession = 0;
      if (captureCtrl) captureCtrl.destroy();
      captureCtrl = makeCaptureController(video, sessionPayloadsMap[0].videos || [], {
          onVideoChange: (v) => { videoLabel.textContent = v.video_id; }
      });
      
      barcodeApi.setActiveSession(0);
      videoQueueApi.setActiveSession(0);
      updateMetaLabels(0);

      timelineRows = drawTimeline(timelineBody, mergedGraphPayload.sequence);
      const mandatoryCount = (mergedGraphPayload.analysis?.mandatory_nodes || []).length;
      summaryPill.textContent = `${recipe.sessions.length} sessions merged · ${mergedGraphPayload.graph.nodes.length} nodes · ${mandatoryCount} mandatory`;

  } else {
      barcodeStackWrap.style.display = 'none';
      annotationTimelineWrap.style.display = '';
      videoQueueRow.style.display = 'none';
      swimlanePanel.style.display = '';

      const payload = sessionPayloadsMap[idx];
      activeVideoSession = idx;
      
      if (captureCtrl) captureCtrl.destroy();
      captureCtrl = makeCaptureController(video, payload.videos || [], {
          onVideoChange: (v) => { videoLabel.textContent = v.video_id; }
      });

      timelineRows = drawTimeline(timelineBody, payload.sequence);
      rebuildAnnotationTimeline(payload);
      rebuildSwimlane(payload);
      updateMetaLabels(idx);

      summaryPill.textContent = `Session ${idx + 1} · ${payload.graph.nodes.length} unique nodes · ${payload.sequence.length} actions`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Control event listeners
// ─────────────────────────────────────────────────────────────────────────────

recipeSelect.addEventListener("change", () => {
  currentRecipeId = recipeSelect.value;
  dashboardTitle.textContent = `${getCurrentRecipe().name} Motion Dashboard — ${currentRecipeId}`;
  loadRecipeData();
});

highlightSpineBtn.addEventListener('click', function() {
  const isActive = this.classList.contains('active');
  if (isActive) {
      this.classList.remove('active');
      graphController.clearHighlight();
      if (mergedGraphPayload.recipe.n_sessions > 1) {
        selectSession('all'); 
      } else {
        selectSession(0);
      }
  } else {
      this.classList.add('active');
      const view = getActiveGraphView();
      graphController.highlightSpine(view?.spine || []);

      // Ensure UI is in 'all' mode to explore the spine globally — but only
      // for the merged graph; a per-session graph has its own spine already.
      if (view?.isMerged && currentSessionIndex !== 'all'
          && mergedGraphPayload.recipe.n_sessions > 1) {
          selectSession('all');
          this.classList.add('active'); // Re-apply class because selectSession removes it
          graphController.highlightSpine(view.spine || []);
      }
  }
});

function updateColorEncodeAvailability() {
  const isAbstracted = graphModeSelect.value === "abstracted";
  const categoryOption = colorEncodeSelect.querySelector('option[value="category"]');
  if (!categoryOption) return;

  categoryOption.disabled = isAbstracted;
  if (isAbstracted) {
    categoryOption.title = "Action category doesn't apply in Task Phases level.";
    if (colorEncodeSelect.value === "category") {
      colorEncodeSelect.value = "phase";
    }
  } else {
    categoryOption.title = "";
  }
}

graphModeSelect.addEventListener("change", () => {
  updateColorEncodeAvailability();
  loadRecipeData();
});

if (graphSourceSelect) {
  graphSourceSelect.addEventListener("change", () => {
    currentGraphSource = graphSourceSelect.value;
    const recipe = getCurrentRecipe();
    // A per-session graph needs a concrete session; "All" isn't one.
    if (currentGraphSource !== "merged" && currentSessionIndex === "all" && recipe) {
      currentSessionIndex = recipe.sessions[0].index;
    }
    reapplyGraphSettings(true);
  });
}

colorEncodeSelect.addEventListener("change", () => reapplyGraphSettings(false));
sizeEncodeSelect.addEventListener("change", () => reapplyGraphSettings(false));
if (layoutModeSelect) layoutModeSelect.addEventListener("change", () => reapplyGraphSettings(false));

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

  await loadVerbCategories('narrations-and-action-segments/HD_EPIC_verb_classes.csv');

  graphModeSelect.value = DEFAULT_DATA_MODE;
  colorEncodeSelect.value = DEFAULT_COLOR_ENCODE_MODE;
  sizeEncodeSelect.value = "support";
  if (layoutModeSelect) layoutModeSelect.value = "temporal";

  updateColorEncodeAvailability();

  const ok = await loadManifest();
  if (!ok) return;

  populateRecipeDropdown();

  const firstRecipe = manifest.recipes[0];
  recipeSelect.value = firstRecipe.id;
  currentRecipeId = firstRecipe.id;
  dashboardTitle.textContent = `${firstRecipe.name} Motion Dashboard — ${firstRecipe.id}`;
  
  loadRecipeData();

  // Video Events
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

  document.getElementById("graphSvg").addEventListener("click", (e) => {
    if (e.target.tagName === "svg" || e.target.id === "zoomGroup") {
      lastClickedNodeId = null;
      occurrenceCycleIndex = 0;
      d3.selectAll(".node").classed("selected", false);
    }
  });

  if (annotationTimeline) {
    annotationTimeline.addEventListener("click", (e) => {
      if (e.target === annotationTimeline) {
        const rect = annotationTimeline.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        const dur = sessionPayloadsMap[activeVideoSession]?.recipe?.total_capture_duration_s || 1;
        const t = pct * dur;
        if (captureCtrl) captureCtrl.seekUnified(t);
      }
    });
  }
}

init();