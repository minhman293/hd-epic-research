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
  LEVELS,
  levelIndexOf,
} from "./config.js";

// NEW DATA PIPELINE ─────────────────────────────────────────────────────────
// The recipe files are now [recipe]_graph.json + [recipe]_alphabet.json.
// dataAdapter.js reads them and hands back payloads in the SAME shape the
// renderer has always used, so nothing below this import had to change.
import {
  loadRecipeManifest,
  buildLevelPayloads as buildPayloadsFromNewData,
  MIN_RUN,
} from "./dataAdapter.js";

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
const levelSlider = document.getElementById("levelSlider");
const levelSliderValue = document.getElementById("levelSliderValue");
const levelSliderTicks = document.querySelectorAll(".level-slider-ticks span");
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

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL CACHE
//
// Every level is a separate JSON file. Re-fetching on each slider move is what
// made a level change feel like a page load, and it also made the change
// un-animatable: you cannot cross-fade into a picture that does not exist yet.
//
// So all three levels for the current recipe are fetched once, in parallel,
// when the recipe is chosen. After that the slider is pure rendering — no
// network, no await — and the transition can be shown.
//
// Keyed by recipe AND level, so switching recipe and switching level cannot
// serve each other's data.
// ─────────────────────────────────────────────────────────────────────────────
const payloadCache = new Map();          // "P01_R01|hybrid" -> { merged, sessions }
const cacheKey = (recipeId, mode) => `${recipeId}|${mode}`;
let levelSwitchInFlight = false;

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

// ─────────────────────────────────────────────────────────────────────────────
// ALWAYS-ON HONESTY CAVEAT (§7)
//
// A persistent, plain-language line under the graph title stating (a) the
// sample size — this is a small-sample backbone, not a population result — and
// (b) whether a fixed order exists at all. §5 established that for unscripted
// recipes the actions recur but their ORDER does not; the graph must say so
// rather than implying a mainstream flow that isn't in the data. Derived from
// the payload, never hard-coded, so it stays true per recipe and per view.
// ─────────────────────────────────────────────────────────────────────────────
function updateGraphCaveat(view) {
  const el = document.getElementById("graphCaveat");
  if (!el) return;
  const n = (view && view.nSessions) || 1;

  if (!view || !view.isMerged || n < 2) {
    el.textContent =
      "Single session — this is one observed run, not a pattern. "
      + "Cross-session agreement cannot be measured here.";
    return;
  }

  const rep = (mergedGraphPayload
    && mergedGraphPayload.analysis
    && mergedGraphPayload.analysis.canonical_spine_report) || {};

  let orderNote;
  if (rep.verdict === "no_shared_pattern") {
    orderNote = "These actions recur, but their order does not — there is no "
              + "fixed sequence for this recipe.";
  } else if (rep.verdict === "partial_pattern" || rep.verdict === "shared_pattern") {
    orderNote = "A recurring order exists — choose “Common to every session” "
              + "under Pattern to highlight it.";
  } else {
    orderNote = "";
  }

  el.textContent =
    `Based on ${n} sessions — a small-sample backbone (n=${n}). `
    + "Bigger node = performed in more sessions; a paler edge = fewer sessions. "
    + orderNote;
}

function reapplyGraphSettings(resetPositions = false, { animate = false } = {}) {
  if (!mergedGraphPayload) return;
  queueMicrotask(() => {
    if (typeof applyPattern === "function") applyPattern();
    rebuildLegend();
  });

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
  updateGraphCaveat(view);

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
      // Only a level change cross-fades. Re-colouring or re-sizing keeps the
      // same nodes on screen, so fading the canvas there would be motion that
      // tells the reader nothing.
      animate,
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
  
  // TWO lookups, not one.
  //
  // The graph is drawn from `sequence` (states at L3) and the footer table from
  // `raw_sequence` (every annotated action). Their row indices are different
  // arrays — at L3, 4 states against 50 actions — so feeding the graph's item
  // to updateTimelineActive() highlighted an unrelated row. Each view gets the
  // item from the timeline it was actually built from.
  const activePayload = currentSessionIndex === 'all'
    ? sessionPayloadsMap[activeVideoSession]
    : sessionPayloadsMap[currentSessionIndex];

  const graphItem = currentSequenceItem(activePayload?.sequence || [], t);
  const rawItem = currentSequenceItem(rawSequence(activePayload), t);

  timeLabel.textContent = formatSeconds(t);
  // The raw action is what the hands are doing right now; the state it belongs
  // to is the context. Showing only the state at L3 would make the label sit
  // still for a minute at a time.
  actionLabel.textContent = rawItem
    ? (graphItem && graphItem.action !== rawItem.action
        ? `${rawItem.action}  ·  ${graphItem.action}`
        : rawItem.action)
    : (graphItem ? graphItem.action : "-");

  const item = graphItem;
  if (lastClickedNodeId && item && item.action !== lastClickedNodeId) {
    lastClickedNodeId = null;
    occurrenceCycleIndex = 0;
    d3.selectAll(".node").classed("selected", false);
  }

  graphController.updateActive(item);
  updateTimelineActive(timelineRows, footerPanel, rawItem);
  
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
  const stepLabelLookup = buildStepLabelLookup(mergedGraphPayload?.steps || []);

  // The legend must describe what is ON THE CANVAS, so it is built from the
  // graph's own nodes rather than from a sequence.
  //
  // `mergedGraphPayload.sequence` is one session's episode list — there is no
  // single timeline across three sessions — so any category that appeared only
  // in the other sessions was missing from the legend while being plainly
  // visible in the picture. On P01_R01 that lost `block`, `pour` and `wash`.
  const drawn = getActiveGraphView()?.graph?.nodes || [];
  const seq = drawn.length
    ? drawn.filter((n) => !n.isSpecial)
           .map((n) => ({ action: n.id, verb: n.verb, step_id: n.step_id }))
    : (mergedGraphPayload?.sequence || []);

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

// There is no manifest.json in the new pipeline. The adapter builds one by
// opening each recipe's graph file and reading the session list off the nodes,
// so the recipe list lives in one place (RECIPES in dataAdapter.js).
async function loadManifest() {
  try {
    manifest = await loadRecipeManifest();
  } catch (error) {
    renderDataError(summaryPill, header, `Failed to load recipe data. (${error.message})`);
    return false;
  }

  if (!manifest.recipes || manifest.recipes.length === 0) {
    renderDataError(summaryPill, header, "No recipe data files could be read.");
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

// Fetch one level for one recipe, or return the copy already in the cache.
// The whole body below is the original loading logic, unchanged except that it
// now returns its result instead of assigning to module state.
async function fetchLevelPayloads(recipeId, recipe, mode) {
  const key = cacheKey(recipeId, mode);
  if (payloadCache.has(key)) return payloadCache.get(key);

  const built = await buildLevelPayloads(recipeId, recipe, mode);
  payloadCache.set(key, built);
  return built;
}

// Warm the other levels in the background. Failures are ignored on purpose:
// a level that cannot be prefetched will simply be fetched on demand, and a
// missing file for one level must never break the level the user is looking at.
function prefetchOtherLevels(recipeId, recipe, activeMode) {
  LEVELS.filter((l) => l.mode !== activeMode).forEach((l) => {
    fetchLevelPayloads(recipeId, recipe, l.mode).catch(() => {});
  });
}

async function loadRecipeData({ animate = false } = {}) {
  if (!currentRecipeId) return;
  const recipe = getCurrentRecipe();
  const mode = graphModeSelect.value;

  try {
    const { merged, sessions } = await fetchLevelPayloads(currentRecipeId, recipe, mode);
    mergedGraphPayload = merged;
    sessionPayloadsMap = sessions;

    expandedEdges.clear();
    populateSessionTabs(recipe);
    updateChainLevelAvailability();
    reapplyGraphSettings(true, { animate });
    selectSession(recipe.has_merged ? 'all' : 0);

    prefetchOtherLevels(currentRecipeId, recipe, mode);
  } catch (error) {
    console.error(error);
    renderDataError(summaryPill, header, "Failed to load recipe data.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildLevelPayloads
//
// Was: fetch merged_<mode>.json + session_<i>_<mode>.json for the recipe.
// Now: one call into dataAdapter.js, which reads [recipe]_graph.json and
// [recipe]_alphabet.json once and derives all three levels from them.
//
//   L1 "full"    take(cup)          derived from node.members
//   L2 "hybrid"  take(crockery)     derived from node.members
//   L3 "step"    froth milk         the shipped functional-state graph
//
// The return shape is unchanged: { merged, sessions }.
// ─────────────────────────────────────────────────────────────────────────────
async function buildLevelPayloads(currentRecipeId, recipe, mode) {
  return buildPayloadsFromNewData(currentRecipeId, recipe, mode);
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

      // The per-action table describes ONE session's timeline, so it has no
      // meaning in the merged view — there is no single timeline to list.
      footerPanel.style.display = 'none';
      const mandatoryCount = (mergedGraphPayload.analysis?.mandatory_nodes || []).length;
      // `--min-run 3` is a declared limit of the preprocessing: a run of fewer
      // than 3 consecutive actions was not promoted to its own state. Saying so
      // here means the reader is never left to infer the resolution.
      summaryPill.textContent =
        `${recipe.sessions.length} sessions merged · ` +
        `${mergedGraphPayload.graph.nodes.length} nodes · ` +
        `${mandatoryCount} in every session · resolution: runs of ≥${MIN_RUN} actions`;

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

      footerPanel.style.display = '';
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

// ═════════════════════════════════════════════════════════════════════════
// DETAIL-LEVEL SLIDER
//
// The slider is the control; the <select> is now a hidden field that holds
// the value. Everything downstream still reads graphModeSelect.value, so no
// other listener had to change.
//
// Switching level does not refetch. All levels for the recipe are already in
// payloadCache (see prefetchOtherLevels), so the change is pure rendering and
// the graph can cross-fade instead of blanking.
//
// The guard matters: a slider fires `input` on every pixel of a drag. Without
// it a fast drag starts three builds against one SVG and they interleave.
// ═════════════════════════════════════════════════════════════════════════

function syncLevelUI(mode) {
  const idx = levelIndexOf(mode);
  if (levelSlider) levelSlider.value = String(idx);
  if (levelSliderValue) levelSliderValue.textContent = LEVELS[idx].label;
  levelSliderTicks.forEach((el, i) => el.classList.toggle("active", i === idx));
}

async function setLevel(mode, { animate = true } = {}) {
  if (!mode || mode === graphModeSelect.value) { syncLevelUI(mode); return; }
  if (levelSwitchInFlight) return;

  levelSwitchInFlight = true;
  appRoot.classList.add("level-switching");
  graphModeSelect.value = mode;
  syncLevelUI(mode);

  // A node opened at one level names actions that do not exist at another,
  // so an open expansion cannot survive the change.
  resetExpansion();
  updateColorEncodeAvailability();

  try {
    await loadRecipeData({ animate });
  } finally {
    levelSwitchInFlight = false;
    appRoot.classList.remove("level-switching");
  }
}

if (levelSlider) {
  levelSlider.addEventListener("input", () => {
    const level = LEVELS[Number(levelSlider.value)];
    if (level) setLevel(level.mode, { animate: true });
  });
}

// Kept so anything that still writes to the select — including a future
// keyboard shortcut or a test — keeps working and updates the slider with it.
graphModeSelect.addEventListener("change", () => {
  syncLevelUI(graphModeSelect.value);
  resetExpansion();
  updateColorEncodeAvailability();
  loadRecipeData({ animate: true });
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
  syncLevelUI(DEFAULT_DATA_MODE);
  colorEncodeSelect.value = DEFAULT_COLOR_ENCODE_MODE;
  sizeEncodeSelect.value = "support";
  // The macro (main-steps) chain is a separate model from the detail ladder.
  // It stays on "micro" now that the ladder itself carries the abstraction.
  if (chainLevelSelect) chainLevelSelect.value = "micro";
  currentChainLevel = "micro";
  // Top-k edge pruning is off: the pruning control was retired, and setting a
  // value the hidden <select> does not contain silently blanked it anyway.
  if (edgeDetailSelect) edgeDetailSelect.value = "all";
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

// ═════════════════════════════════════════════════════════════════════════
// MOST LIKELY ROUTE
//
// applyPattern() used to read `src.likely_path` and `src.likely_path_report`.
// Neither field is written by 6_prepare_dashboard_data.py or by
// 8_aggregate_sessions.py, and neither appears in any payload — so `ids` was
// always [] and `ok` was always false. The option looked functional and did
// nothing, silently. That is the worst kind of broken control.
//
// It is computed here instead, from the graph already on screen.
//
// "Most likely route" means the path START → END whose product of transition
// probabilities is largest. Maximising a product of probabilities is the same
// as minimising the sum of −log(p), and −log(p) ≥ 0 for p ≤ 1, so this is an
// ordinary shortest-path problem and Dijkstra solves it exactly.
//
// A greedy "always take the biggest arrow" walk is NOT the same thing and can
// miss the real answer: one strong first step can lead into a dead region.
//
// Two honest limits, both reported in the note:
//   - the result is the most likely route through the model, which is not the
//     same as a route anybody actually performed end to end;
//   - it needs a START and an END to exist in the drawn graph.
// ═════════════════════════════════════════════════════════════════════════

function computeLikelyPath(graph) {
  if (!graph || !graph.nodes || !graph.links) return { ids: [], report: {} };

  const idOf = (v) => (v && typeof v === "object") ? v.id : v;
  const isStart = (id) => id === "START" || String(id).startsWith("Start:");
  const isEnd   = (id) => id === "END"   || String(id).startsWith("End:");

  const startNode = graph.nodes.find((n) => isStart(n.id));
  const endNode   = graph.nodes.find((n) => isEnd(n.id));
  if (!startNode || !endNode) {
    return { ids: [], report: { reached_end: false,
      headline: "No START/END in this view, so there is no route to trace." } };
  }

  // Adjacency, self-loops dropped: repeating an action does not advance a
  // route, and a zero-cost loop would sit in the queue forever.
  const out = new Map();
  graph.links.forEach((l) => {
    const s = idOf(l.source), t = idOf(l.target);
    if (s === t) return;
    const p = (typeof l.probability === "number" && l.probability > 0)
      ? l.probability : null;
    if (p === null) return;
    if (!out.has(s)) out.set(s, []);
    out.get(s).push({ t, cost: -Math.log(p), p });
  });

  // Dijkstra. The graph is small enough (≤ ~330 edges) that a linear scan for
  // the minimum is cheaper than maintaining a heap.
  const dist = new Map([[startNode.id, 0]]);
  const prev = new Map();
  const done = new Set();

  for (;;) {
    let u = null, best = Infinity;
    dist.forEach((dv, k) => { if (!done.has(k) && dv < best) { best = dv; u = k; } });
    if (u === null || u === endNode.id) break;
    done.add(u);
    (out.get(u) || []).forEach(({ t, cost }) => {
      const alt = best + cost;
      if (alt < (dist.has(t) ? dist.get(t) : Infinity)) {
        dist.set(t, alt);
        prev.set(t, u);
      }
    });
  }

  if (!dist.has(endNode.id)) {
    return { ids: [], report: { reached_end: false,
      headline: "No route of observed transitions reaches END from START." } };
  }

  const ids = [];
  for (let cur = endNode.id; cur !== undefined; cur = prev.get(cur)) {
    ids.unshift(cur);
    if (cur === startNode.id) break;
  }

  const probability = Math.exp(-dist.get(endNode.id));
  const steps = Math.max(ids.length - 1, 0);
  return {
    ids,
    report: {
      reached_end: true,
      probability,
      headline:
        `Most likely route: ${steps} steps, combined probability ` +
        `${probability < 0.001 ? probability.toExponential(1) : probability.toFixed(3)}. ` +
        `This is the highest-probability path through the model — it is not ` +
        `necessarily a route any single session performed from start to finish.`,
    },
  };
}

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

  // Show the strip only when it has something to say, and collapse it fully
  // otherwise — an empty coloured band between the controls and the styling
  // row reads as a layout fault.
  const setNote = (text) => {
    if (patternNote) patternNote.textContent = text || "";
    if (patternNoteRow) {
      patternNoteRow.style.display = text ? "block" : "none";
      patternNoteRow.style.margin = "0";
    }
  };

  if (choice === "none") {
    graphController.clearHighlight();
    setNote("");
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
    // Computed from the graph on screen, because no payload carries one.
    // Deliberately recomputed on every call rather than cached: the drawn
    // graph changes with level, session tab and any opened node, and a
    // highlighted path that belongs to a graph you are no longer looking at
    // is worse than no highlight.
    const view = getActiveGraphView();
    const { ids: pathIds, report } = computeLikelyPath(view?.graph);
    ids = pathIds;
    note = report.headline || "";
    ok = !!report.reached_end;
  }

  setNote(note);
  // A verdict of "no pattern" is a result, not a failure: say it and highlight
  // nothing, rather than highlighting two nodes with no explanation.
  graphController.highlightSpine(ok ? ids : []);
}

if (patternSelect) patternSelect.addEventListener("change", applyPattern);