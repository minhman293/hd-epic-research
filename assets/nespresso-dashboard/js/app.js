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
  getMacroLegendItems,
  PRETHINNED_MODES,
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
const emphasisSelect = document.getElementById("emphasisSelect");
const edgeDetailSelect = document.getElementById("edgeDetailSelect");
const chainLevelSelect = document.getElementById("chainLevelSelect");
let currentExpandedGraph = null;
let expansionStack = [];      // [{ graph, nodeId, label }]
const patternSelect = document.getElementById("patternSelect");
const patternNoteRow = document.getElementById("patternNoteRow");
const patternNote = document.getElementById("patternNote");
const expandBackBtn = document.getElementById("expandBackBtn");
const expandCrumb = document.getElementById("expandCrumb");
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

// "macro" -> spine nodes with logistics collapsed onto edges (graph_macro)
// "micro" -> the existing per-action graph
let currentChainLevel = "macro";

// Whether the canonical pattern is currently highlighted. The layout reads this
// so the path can be pinned left-to-right ONLY while it is shown — re-laying out
// on every render would make the graph jump each time the button is toggled.
let spineHighlightOn = false;

// Macro edges the user has opened. Keyed by link.key, so an open edge stays
// open across a re-render (changing colour or layout must not close it).
let expandedEdges = new Set();

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

// ─────────────────────────────────────────────────────────────────────────────
// EXPANDING A BRIDGE
//
// A macro edge carries the run it collapsed in `bridge_samples`. Opening the
// edge replaces it with that run drawn out as a chain of temporary nodes:
//
//   A ──[8 actions]──▶ B      becomes      A → x1 → x2 → ... → x8 → B
//
// This is a DISPLAY transform only. It never touches graph_macro, so closing
// the edge restores the collapsed form exactly, and the probabilities on the
// macro chain are never recomputed from a half-expanded graph — which would be
// a third, meaningless model.
//
// Samples with the same action sequence are grouped, so an edge crossed three
// times the same way expands to one chain labelled x3 rather than three
// identical chains. Different routes between the same two steps expand as
// parallel chains, which is exactly the variation a reader wants to see.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_INLINE_BRIDGE = 20;   // longest run drawn inline before truncation

function expandMacroGraph(graph, openKeys) {
  if (!openKeys || openKeys.size === 0) return graph;

  const nodes = graph.nodes.map((n) => ({ ...n }));
  const links = [];
  const nodeIds = new Set(nodes.map((n) => n.id));

  graph.links.forEach((link) => {
    const samples = link.bridge_samples || [];
    if (!openKeys.has(link.key) || !link.is_bridged || samples.length === 0) {
      links.push({ ...link });
      return;
    }

    // Group identical runs.
    const routes = new Map();
    samples.forEach((s) => {
      const seq = (s.raw_actions && s.raw_actions.length) ? s.raw_actions : s.actions;
      if (!seq || seq.length === 0) return;
      const sig = seq.join(" > ");
      if (!routes.has(sig)) routes.set(sig, { seq, roles: s.roles || [], count: 0, gap: s.gap_s, start: s.start });
      routes.get(sig).count += 1;
    });

    if (routes.size === 0) { links.push({ ...link }); return; }

    const totalRuns = [...routes.values()].reduce((a, r) => a + r.count, 0);
    let routeIdx = 0;

    routes.forEach((route) => {
      const truncated = route.seq.length > MAX_INLINE_BRIDGE;
      const shown = truncated ? route.seq.slice(0, MAX_INLINE_BRIDGE) : route.seq;
      const chain = [];

      shown.forEach((action, i) => {
        const id = `${link.key}::r${routeIdx}::${i}::${action}`;
        nodes.push({
          id,
          label: action,
          count: route.count,
          is_bridge_node: true,
          bridge_of: link.key,
          role: (route.roles && route.roles[i]) || "bridge",
          support: link.support, n_sessions: link.n_sessions,
          per_session_counts: link.per_session_counts,
          median_rank: 0.5,
        });
        nodeIds.add(id);
        chain.push(id);
      });

      if (truncated) {
        const id = `${link.key}::r${routeIdx}::more`;
        const hidden = route.seq.length - MAX_INLINE_BRIDGE;
        nodes.push({
          id, label: `+${hidden} more`, count: route.count,
          is_bridge_node: true, is_bridge_overflow: true, bridge_of: link.key,
          role: "bridge", median_rank: 0.5,
        });
        nodeIds.add(id);
        chain.push(id);
      }

      const p = route.count / totalRuns;
      const hop = (src, dst, first) => ({
        source: src, target: dst,
        key: `${link.key}::r${routeIdx}::${src}->${dst}`,
        count: route.count, n: route.count, n_out: totalRuns,
        probability: p,
        is_bridge_edge: true, bridge_of: link.key,
        evidence: link.evidence,
        support: link.support, n_sessions: link.n_sessions,
        is_self_loop: false, is_return: false,
        // The first hop carries the wait, because that is when it happens.
        gap_s_median: first ? route.gap : 0,
      });

      links.push(hop(link.source, chain[0], true));
      for (let i = 0; i < chain.length - 1; i++) links.push(hop(chain[i], chain[i + 1], false));
      links.push(hop(chain[chain.length - 1], link.target, false));

      routeIdx += 1;
    });
  });

  return { nodes, links };
}

// The macro graph for whichever payload is on screen, or null when this JSON
// predates the macro pipeline.
function macroGraphFor(payload) {
  const g = payload && payload.graph_macro;
  if (!g || !g.nodes || g.nodes.length === 0) return null;
  return g;
}

function macroAvailable() {
  if (currentGraphSource === "merged") return !!macroGraphFor(mergedGraphPayload);
  if (currentGraphSource === "session_raw") return false;   // audit view is raw by definition
  return !!macroGraphFor(sessionPayloadsMap[sessionIndexForGraph()]);
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

  // A node has been opened: draw the expanded graph instead. Everything else
  // about the view — sequence, spine, session scope — is unchanged, so the
  // video sync and the timelines keep working while a node is open.
  if (typeof currentExpandedGraph !== "undefined" && currentExpandedGraph) {
    const base = getActiveGraphViewBase();
    return base ? { ...base, graph: currentExpandedGraph } : base;
  }
  return getActiveGraphViewBase();
}

function getActiveGraphViewBase() {
  if (!mergedGraphPayload) return null;

  const wantMacro = currentChainLevel === "macro";

  if (currentGraphSource === "merged") {
    const nSessions = mergedGraphPayload.recipe.n_sessions;
    const macro = wantMacro ? macroGraphFor(mergedGraphPayload) : null;
    return {
      graph: macro
        ? expandMacroGraph(macro, expandedEdges)
        : mergedGraphPayload.graph,
      // The sequence stays the FULL one even in macro view. It drives video
      // sync, the timeline and the swimlane, none of which should skip actions
      // just because the graph is drawn at a coarser level.
      sequence: mergedGraphPayload.sequence,
      nSessions,
      spine: macro
        ? (macro.nodes || []).map((n) => n.id)
        : (mergedGraphPayload.canonical_spine || mergedGraphPayload.analysis?.canonical_spine || []),
      spinePath: macro
        ? null
        : (mergedGraphPayload.canonical_spine_path || mergedGraphPayload.analysis?.canonical_spine_path || null),
      showSupportBadges: nSessions > 1,
      isMerged: true,
      isMacro: !!macro,
      macroReport: macro ? mergedGraphPayload.macro_report : null,
      title: macro ? "Main steps — all sessions" : "Merged Motion Graph",
    };
  }

  const si = sessionIndexForGraph();
  const payload = sessionPayloadsMap[si];
  if (!payload) return null;

  const raw = currentGraphSource === "session_raw";
  const macro = (wantMacro && !raw) ? macroGraphFor(payload) : null;
  const source = macro
    ? expandMacroGraph(macro, expandedEdges)
    : (raw ? payload.graph_unfiltered : payload.graph);
  if (!source) return null;

  const sequence = (raw
    ? payload.sequence
    : payload.sequence.filter((i) => i.is_primary !== false)
  ).map((i) => ({ ...i, session_index: si }));

  return {
    graph: decorateSessionGraph(source),
    sequence,
    nSessions: 1,
    spine: macro ? (macro.nodes || []).map((n) => n.id) : synthSpine(sequence),
    showSupportBadges: false,
    isMerged: false,
    isMacro: !!macro,
    macroReport: macro ? payload.macro_report : null,
    sessionIndex: si,
    raw,
    // Session tabs are labelled 1-based ("Session 2"); session.index is 0-based.
    // Use the tab's numbering so the panel title and the active tab agree.
    title: raw
      ? `Session ${si + 1} — Raw (unfiltered)`
      : macro
        ? `Session ${si + 1} — Main steps`
        : `Session ${si + 1} — Filtered (primary only)`,
  };
}

function resetExpansion() {
  if (typeof expansionStack !== "undefined") expansionStack = [];
  currentExpandedGraph = null;
  if (typeof updateExpandChrome === "function") updateExpandChrome();
}

function reapplyGraphSettings(resetPositions = false) {
  if (!mergedGraphPayload) return;
  queueMicrotask(() => { if (typeof applyPattern === "function") applyPattern(); });

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

  // Attach the pipeline's filter ledger to the graph object so the renderer
  // can state scope provenance on canvas without a second plumbing path.
  if (view.graph) {
    view.graph.__filterReport =
      (view.isMerged ? mergedGraphPayload : sessionPayloadsMap[view.sessionIndex])
        ?.filter_report || null;
  }

  graphController.buildGraph(
    view.graph,
    view.sequence,
    1,
    graphModeSelect.value,
    colorEncodeSelect.value,
    sizeEncodeSelect.value,
    layoutModeSelect.value,
    { onNodeClick: handleNodeClick, onEdgeClick: handleEdgeClick },
    resetPositions,
    {
      showSupportBadges: view.showSupportBadges,
      // "all" resolves against the session count, so the option keeps meaning
      // when a recipe has 3 captures or 4.
      supportFilter: (() => {
        const v = emphasisSelect ? emphasisSelect.value : "1";
        if (v === "all") return view.nSessions;
        return parseInt(v, 10) || 1;
      })(),
      edgeDetail: edgeDetailSelect ? edgeDetailSelect.value : "all",
      nSessions: view.nSessions,
      canonicalSpine: view.spine,
      // The tiered path (spine vs connector). Falls back to the flat list when
      // the payload predates the LCS spine, so an old JSON still highlights.
      canonicalSpinePath: view.spinePath || null,
      spineHighlightActive: spineHighlightOn,
      isMacro: !!view.isMacro,
      expandedEdges,
    }
  );

  rebuildLegend();
  selectSession(currentSessionIndex);
}

// Clicking a collapsed edge opens it; clicking it again closes it. Positions
// are preserved on purpose (resetPositions = false) so the graph does not jump
// under the cursor — the newly inserted chain appears in place.
function handleEdgeClick(d) {
  if (!d || !d.is_bridged) return;
  if (expandedEdges.has(d.key)) expandedEdges.delete(d.key);
  else expandedEdges.add(d.key);
  reapplyGraphSettings(false);
}

function handleNodeClick(d, sequence, event) {
  // Double-click opens a merged node. Single click keeps its old job: seek the
  // video to the next occurrence. Two different intentions, two gestures.
  if (event && event.detail >= 2 && !d.is_expanded_child) {
    if (tryExpand(d.id)) return;
  }
  const seqToSearch = currentSessionIndex === 'all' 
    ? sessionPayloadsMap[activeVideoSession]?.sequence || []
    : sessionPayloadsMap[currentSessionIndex]?.sequence || [];
    
  // An expanded bridge node has a synthetic id ("key::r0::3::take(cup)"); the
  // sequence knows it by its label. Fall back to the label so clicking an
  // opened action still seeks the video.
  const wanted = d.is_bridge_node ? (d.label || d.id) : d.id;
  const occurrences = seqToSearch.filter(
    (item) => item.action === wanted || item.raw_action === wanted
  );
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
    `Status: <strong>Selected ${wanted} (${occurrenceCycleIndex + 1}/${occurrences.length})</strong>`;
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

  // The macro view encodes different things, so it gets its own legend rather
  // than a filtered version of the micro one — a merged legend described
  // neither view correctly.
  const view = getActiveGraphView();
  if (view?.isMacro) {
    buildLegend(legendStrip, getMacroLegendItems(view.macroReport),
                colorEncodeSelect.value, seq);
    return;
  }

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

// The lookup tables inside are keyed by `item.action`. The graph is drawn from
// `sequence` (episode labels) but the barcode, swimlane and timeline are drawn
// from `raw_sequence` (raw actions). Building the table from the wrong one
// means no key ever matches and every bar falls back to grey — which is what
// happened to "Recipe step" and "Mean duration" in the barcode as soon as the
// graph switched to episodes. Callers now pass the sequence they will colour.
function getCurrentColorFn(seqOverride) {
  const colorMode = colorEncodeSelect.value;
  const graphMode = graphModeSelect.value;
  const seq = seqOverride || rawSequence(mergedGraphPayload) || [];

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
    el, rawSequence(payload), dur, getCurrentColorFn(rawSequence(payload)), {
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

// ─────────────────────────────────────────────────────────────────────────────
// rawSequence
//
// The graph and the time-based views need different data. The graph reads
// `sequence`, whose rows are graph states — in episode and step modes those
// are grouped, which is the whole point of the grouping. The barcode, the
// swimlane and the timeline answer a different question: when did things
// happen and for how long. That question is about the raw action stream, and
// grouping only hides detail from it.
//
// Modes written by 9_build_episode_graphs.py carry `raw_sequence`, the
// untouched action list. Older modes (full, hybrid, smart...) do not, and for
// them `sequence` already IS the raw stream, so the fallback is correct.
// ─────────────────────────────────────────────────────────────────────────────
function rawSequence(payload) {
  if (!payload) return [];
  return payload.raw_sequence || payload.sequence || [];
}

function withRawSequence(payload) {
  if (!payload) return payload;
  return { ...payload, sequence: rawSequence(payload) };
}

function rebuildSwimlane(payload) {
  if (swimlaneApi) { swimlaneApi.destroy(); swimlaneApi = null; }
  const el = document.getElementById('swimlaneContainer');
  if (!payload || !el) return;
  const lookup = buildStepLabelLookup(payload.steps || []);
  swimlaneApi = buildSwimlane(el, payload, getCurrentColorFn(rawSequence(payload)), {
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
    const targetRecipes = ["P01_R01", "P03_R03", "P08_R01", "P05_R02"];
    
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

      // Recipes with a single session get no merged_*.json, so the session
      // file stands in for it. The macro graph must ride along, otherwise the
      // Detail control would silently do nothing on those recipes.
      mergedGraphPayload = {
        recipe: { ...data.recipe, n_sessions: 1, session_indices: [0] },
        graph: data.graph,
        graph_macro: data.graph_macro || null,
        macro_sequence: data.macro_sequence || [],
        // evidence_basis is already "single_session" from the pipeline; the
        // legend and the ledger both read it, so a single-session recipe says
        // so on screen instead of showing confident-looking probabilities.
        macro_report: data.macro_report || null,
        filter_report: data.filter_report || null,
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
    expandedEdges.clear();
    populateSessionTabs(recipe);
    updateChainLevelAvailability();
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
          sequence: rawSequence(sessionPayloadsMap[s.index]),
          duration_s: s.duration_s
      }));

      if (barcodeApi) barcodeApi.destroy();
      barcodeApi = buildBarcodeStack(barcodeStackEl, sessionsForBarcode,
          getCurrentColorFn(rawSequence(mergedGraphPayload)), {
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

      timelineRows = drawTimeline(timelineBody, rawSequence(mergedGraphPayload));
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

      timelineRows = drawTimeline(timelineBody, rawSequence(payload));
      rebuildAnnotationTimeline(withRawSequence(payload));
      rebuildSwimlane(withRawSequence(payload));
      updateMetaLabels(idx);

      summaryPill.textContent = `Session ${idx + 1} · ${payload.graph.nodes.length} unique nodes · ${rawSequence(payload).length} actions`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Control event listeners
// ─────────────────────────────────────────────────────────────────────────────

recipeSelect.addEventListener("change", (e) => { resetExpansion(); });
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

// In macro view the spine is small enough that verb rollup changes almost
// nothing (8 nodes either way on P01_R01), and the Detail control is what
// actually governs density. Disabling it is clearer than leaving a control that
// appears to do nothing.
function updateChainLevelAvailability() {
  if (!chainLevelSelect) return;
  const available = macroAvailable();

  const macroOption = chainLevelSelect.querySelector('option[value="macro"]');
  if (macroOption) {
    macroOption.disabled = !available;
    macroOption.title = available ? "" :
      "This view has no macro graph. Re-run 6_prepare_dashboard_data.py, or " +
      "switch away from the raw audit view.";
  }
  if (!available && chainLevelSelect.value === "macro") {
    chainLevelSelect.value = "micro";
    currentChainLevel = "micro";
  }

  // Episode and step graphs are thinned by evidence in the pipeline, so the
  // render-time controls have nothing left to remove. Leaving them enabled
  // dims real edges and makes well-connected nodes look isolated.
  const preThinned = PRETHINNED_MODES.includes(graphModeSelect.value);
  const inMacro = (currentChainLevel === "macro" && available) || preThinned;
  if (graphModeSelect) {
    // Detail level is the main control now. It was being greyed out because
    // episode graphs are pre-thinned — but that reasoning applied to edge
    // pruning, not to choosing which layer to look at.
    graphModeSelect.disabled = false;
    graphModeSelect.title = inMacro
      ? "Abstraction applies to the every-action view. The main-steps view is " +
        "already coarse enough that it changes almost nothing."
      : "";
  }
  if (edgeDetailSelect) {
    // Top-k edge pruning was built for a 410-edge graph. At 26 edges it hides
    // real structure for no gain, so macro view defaults to showing all edges.
    edgeDetailSelect.disabled = inMacro;
    edgeDetailSelect.title = inMacro
      ? "Not needed here — the main-steps view has few enough edges to show all of them."
      : "";
  }
}

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

graphModeSelect.addEventListener("change", (e) => { resetExpansion(); });
graphModeSelect.addEventListener("change", () => {
  updateColorEncodeAvailability();
  loadRecipeData();
});

if (edgeDetailSelect) {
  edgeDetailSelect.addEventListener("change", () => reapplyGraphSettings(false));
}

if (chainLevelSelect) {
  chainLevelSelect.addEventListener("change", () => {
    currentChainLevel = chainLevelSelect.value;
    // Switching level changes the state space, so open edges from the old one
    // mean nothing in the new one.
    expandedEdges.clear();
    updateChainLevelAvailability();
    reapplyGraphSettings(true);
  });
}

if (emphasisSelect) {
  emphasisSelect.addEventListener("change", () => reapplyGraphSettings(false));
}

if (graphSourceSelect) {
  graphSourceSelect.addEventListener("change", () => {
    currentGraphSource = graphSourceSelect.value;
    const recipe = getCurrentRecipe();
    // A per-session graph needs a concrete session; "All" isn't one.
    if (currentGraphSource !== "merged" && currentSessionIndex === "all" && recipe) {
      currentSessionIndex = recipe.sessions[0].index;
    }
    expandedEdges.clear();
    updateChainLevelAvailability();
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
  // Macro view is the default: it is the readable one, and its probabilities
  // are the only ones in this dataset that survive pooling without collapsing
  // to a wall of P = 1.00.
  if (chainLevelSelect) chainLevelSelect.value = "macro";
  currentChainLevel = "macro";
  // Top-k pruning stays on for the every-action view, where it is still needed.
  if (edgeDetailSelect) edgeDetailSelect.value = "top1";
  if (layoutModeSelect) layoutModeSelect.value = "temporal";

  updateColorEncodeAvailability();
  updateChainLevelAvailability();

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

// ═════════════════════════════════════════════════════════════════════════
// NODE EXPANSION — showing what was merged
//
// Prof. Lin asked for the merging to be visible, not just described. Double-
// clicking a node replaces it, IN PLACE, with the raw actions it stands for.
// The rest of the graph is untouched (local expansion), so the reader keeps
// their bearings; Back pops one level.
//
// The subgraph is not derived here. `payload.expansions[nodeId]` was computed
// by the pipeline from the same episode objects that produced the node, so the
// two can never drift apart.
// ═════════════════════════════════════════════════════════════════════════


function expansionsFor() {
  const view = getActiveGraphView();
  const src = view?.isMerged
    ? mergedGraphPayload
    : sessionPayloadsMap[view?.sessionIndex];
  return src?.expansions || null;
}

function expandNodeInPlace(graph, nodeId, sub) {
  // Sub-nodes get a prefixed id so they cannot collide with real graph nodes.
  const tag = (a) => `${nodeId}::${a}`;
  const subNodes = sub.nodes.map((n, i) => ({
    ...n,
    id: tag(n.id),
    label: n.id,
    key: tag(n.id),
    is_expanded_child: true,
    parent_id: nodeId,
    isSpecial: false,
    salient: true,
    is_primary: true,
    support: 1,
    n_sessions: 1,
    per_session_counts: {},
    median_rank: (graph.nodes.find((x) => x.id === nodeId)?.median_rank ?? 0.5)
                 + (i - sub.nodes.length / 2) * 0.0008,
  }));

  const subLinks = sub.links.map((l) => ({
    ...l,
    source: tag(l.source), target: tag(l.target),
    key: `${tag(l.source)}|||${tag(l.target)}`,
    pairKey: `${tag(l.source)}|||${tag(l.target)}`,
    n_sessions: 1, per_session_counts: {},
    is_self_loop: l.source === l.target,
    is_return: false, is_bridged: false, is_bridge_edge: false,
    is_introduced: false, evidence: "inner",
    is_inner: true,
  }));

  // Rewire: whatever pointed at the merged node now points at the busiest
  // sub-node, and whatever left it now leaves from the busiest sub-node. This
  // keeps the graph connected without inventing an ordering the data does not
  // support.
  const entry = subNodes[0]?.id;
  const exit = subNodes[subNodes.length - 1]?.id || entry;
  const outer = graph.links
    .filter((l) => l.source !== nodeId || l.target !== nodeId)
    .map((l) => {
      if (l.target === nodeId) return { ...l, target: entry, key: `${l.source}|||${entry}` };
      if (l.source === nodeId) return { ...l, source: exit, key: `${exit}|||${l.target}` };
      return l;
    });

  return {
    ...graph,
    nodes: graph.nodes.filter((n) => n.id !== nodeId).concat(subNodes),
    links: outer.concat(subLinks),
  };
}

function updateExpandChrome() {
  if (!expandBackBtn) return;
  const depth = expansionStack.length;
  expandBackBtn.style.display = depth ? "inline-block" : "none";
  if (expandCrumb) {
    expandCrumb.textContent = depth
      ? `opened: ${expansionStack.map((s) => s.label).join(" › ")}`
      : "";
  }
}

function tryExpand(nodeId) {
  const map = expansionsFor();
  const sub = map && map[nodeId];
  if (!sub || !sub.nodes || sub.nodes.length < 2) return false;

  const view = getActiveGraphView();
  if (!view?.graph) return false;

  expansionStack.push({ graph: view.graph, nodeId, label: nodeId });
  const expanded = expandNodeInPlace(view.graph, nodeId, sub);
  view.graph.__expandedInto = expanded;      // remembered for re-renders
  currentExpandedGraph = expanded;
  updateExpandChrome();
  reapplyGraphSettings(true);
  return true;
}

function collapseOne() {
  if (!expansionStack.length) return;
  expansionStack.pop();
  currentExpandedGraph = expansionStack.length
    ? expansionStack[expansionStack.length - 1].graph.__expandedInto || null
    : null;
  updateExpandChrome();
  reapplyGraphSettings(true);
}


if (expandBackBtn) expandBackBtn.addEventListener("click", collapseOne);

// ═════════════════════════════════════════════════════════════════════════
// PATTERN SELECTOR
//
// Two different claims, so two options rather than one button:
//   spine   — the ordered run EVERY session performed  (may be empty)
//   likely  — the highest-probability route through the chain
// A likely route can be a route nobody performed end to end; the note says so.
// ═════════════════════════════════════════════════════════════════════════

function patternSource() {
  const view = getActiveGraphView();
  return view?.isMerged
    ? mergedGraphPayload
    : sessionPayloadsMap[view?.sessionIndex] || mergedGraphPayload;
}

function applyPattern() {
  if (!patternSelect || !graphController) return;
  const choice = patternSelect.value;
  const src = patternSource() || {};

  if (choice === "none") {
    graphController.clearHighlight();
    if (patternNoteRow) patternNoteRow.style.display = "none";
    return;
  }

  let ids = [], note = "", ok = true;
  if (choice === "spine") {
    const rep = src.analysis?.canonical_spine_report
             || src.canonical_spine_report || {};
    ids = src.canonical_spine || src.analysis?.canonical_spine || [];
    note = rep.headline || "";
    ok = rep.verdict !== "no_shared_pattern" && rep.verdict !== "single_session";
  } else {
    const rep = src.likely_path_report || {};
    ids = src.likely_path || [];
    note = rep.headline || "";
    ok = !!rep.reached_end;
  }

  if (patternNoteRow) {
    patternNoteRow.style.display = note ? "block" : "none";
    if (patternNote) patternNote.textContent = note;
  }
  // A verdict of "no pattern" is a result, not a failure: say it and highlight
  // nothing, rather than highlighting two nodes with no explanation.
  graphController.highlightSpine(ok ? ids : []);
}

if (patternSelect) patternSelect.addEventListener("change", applyPattern);