// dataAdapter.js
// ─────────────────────────────────────────────────────────────────────────────
// NEW DATA → OLD PAYLOAD CONTRACT
//
// The LLM preprocessing ships two files per recipe:
//
//   [recipe]_graph.json     one graph at the "functional state" level:
//                           nodes (with `members` = every raw action inside),
//                           edges (n / p / support / interruption_actions).
//   [recipe]_alphabet.json  the state definitions + the phase of each state.
//
// The old renderer (graph.js, swimlane.js, barcodeStack.js, timeline.js,
// annotationTimeline.js, legend.js, videoQueue.js, captureController.js) all
// speak one payload shape. Rather than rewrite eight modules, this file
// translates the new data INTO that shape. Everything downstream keeps working.
//
// WHAT THE THREE DETAIL LEVELS NOW MEAN
//
//   L3 "step"    functional state             froth milk         shipped in _graph.json
//   L2 "hybrid"  verb + object category       take(crockery)     derived from `members`
//   L1 "full"    every distinct action        take(cup)          derived from `members`
//
// THE LEVELS ARE NESTED, NOT PARALLEL. L3 is the whole recipe. L1 and L2 are
// the INSIDE of ONE state, reached by passing `focusState`.
//
// Drawing L1/L2 across the whole recipe puts every annotated action in one
// view - for P01_R01 that is 65 nodes and 135 edges, which is the exact
// open-vocabulary hairball the new pipeline exists to remove. Scoped to one
// state it is a readable handful of nodes, and nothing is hidden: the user
// reaches every action by opening the state that contains it.
//
// L1 and L2 are DERIVED here, in the browser, from node.members. They are not
// separate files any more. Nothing is invented: every L1/L2 node is a real
// annotated action and every L1/L2 edge is a real observed adjacency inside one
// session. The mode strings ("full" / "hybrid" / "step") are unchanged so no
// other module needs to learn a new vocabulary.
//
// WHAT ONLY EXISTS AT L3
//
//   interruption_actions / interruption_seconds  — how much other-task work the
//   person did while crossing that edge. The pipeline only measures this
//   between functional states, so it is carried on L3 edges only.
//
// RESOLUTION LIMIT
//
//   The pipeline was run with `--min-run 3`: a run of fewer than 3 consecutive
//   actions is not promoted to its own state. That is a declared limit of the
//   data, not of this renderer. MIN_RUN below is only used for the caption.
// ─────────────────────────────────────────────────────────────────────────────

import { registerAlphabet } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE FILES LIVE — edit these three lines to match your folder layout
// ─────────────────────────────────────────────────────────────────────────────
const DATA_BASE = "scripts/out";
const VIDEO_BASE = "https://controversial-sophisticated-dozen-quit.trycloudflare.com/hd_epic_videos";
const NOUN_CSV_URL = "narrations-and-action-segments/HD_EPIC_noun_classes.csv";

export const MIN_RUN = 3;

// The recipes to show, and their display names. There is no manifest.json in
// the new pipeline, so the list is declared here.
export const RECIPES = [
  { id: "P01_R01", name: "Nespresso" },
  { id: "P03_R03", name: "Drip Coffee" },
  { id: "P05_R02", name: "Porridge" },
  { id: "P08_R01", name: "Espresso" },
];

const graphUrl = (recipeId) => `${DATA_BASE}/${recipeId}_graph.json`;
const alphabetUrl = (recipeId) => `${DATA_BASE}/${recipeId}_alphabet.json`;
const videoUrl = (videoId) => `${VIDEO_BASE}/${videoId}.mp4`;

// ─────────────────────────────────────────────────────────────────────────────
// NOUN → CATEGORY  (needed for Level 2 only)
// Same CSV shape as the verb file: quoted `instances` cells contain commas and
// newlines, so the parser has to be quote-aware.
// ─────────────────────────────────────────────────────────────────────────────

export const NOUN_TO_CATEGORY = {};
let nounsLoaded = false;

export async function loadNounCategories(csvUrl = NOUN_CSV_URL) {
  if (nounsLoaded) return;
  try {
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    let inQuotes = false, row = [], cell = "";
    const processRow = (r) => {
      if (r.length < 4 || r[0].trim() === "id") return;
      const key = r[1].trim();
      const instances = r[2].trim();
      const category = r[3].trim();
      NOUN_TO_CATEGORY[key] = category;
      const matches = instances.match(/'([^']+)'/g);
      if (matches) {
        matches.forEach((m) => { NOUN_TO_CATEGORY[m.replace(/'/g, "")] = category; });
      }
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === "," && !inQuotes) { row.push(cell); cell = ""; }
      else if ((ch === "\n" || ch === "\r") && !inQuotes) {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); processRow(row); row = []; cell = "";
      } else cell += ch;
    }
    if (row.length || cell) { row.push(cell); processRow(row); }

    nounsLoaded = true;
  } catch (err) {
    console.error("[dataAdapter] noun classes CSV failed to load:", err);
  }
}

const nounCategory = (noun) => NOUN_TO_CATEGORY[noun] || noun || "object";

// ─────────────────────────────────────────────────────────────────────────────
// FILE CACHE — one fetch per recipe, reused by all three levels
// ─────────────────────────────────────────────────────────────────────────────

const bundleCache = new Map();

async function loadBundle(recipeId) {
  if (bundleCache.has(recipeId)) return bundleCache.get(recipeId);

  const [graphRes, alphaRes] = await Promise.all([
    fetch(graphUrl(recipeId)),
    fetch(alphabetUrl(recipeId)),
  ]);
  if (!graphRes.ok) throw new Error(`${recipeId}_graph.json → HTTP ${graphRes.status}`);
  if (!alphaRes.ok) throw new Error(`${recipeId}_alphabet.json → HTTP ${alphaRes.status}`);

  const graph = await graphRes.json();
  const alphabet = await alphaRes.json();
  await loadNounCategories();

  const bundle = buildBundle(recipeId, graph, alphabet);
  bundleCache.set(recipeId, bundle);
  return bundle;
}

// Exposed for tests / for loading from an object instead of a URL.
export function buildBundle(recipeId, graph, alphabet) {
  const isSpecial = (id) => id === "START" || id === "END";

  // 1. Sessions. One session = one video in this dataset.
  const sessionIds = [...new Set(graph.nodes.flatMap((n) => n.sessions || []))].sort();
  const sessionIndexOf = new Map(sessionIds.map((v, i) => [v, i]));

  // 2. Flatten every member into one raw-action stream, tagged with its state.
  const stateOf = new Map(alphabet.states.map((s) => [s.name, s]));
  const rawBySession = sessionIds.map(() => []);

  graph.nodes.forEach((node) => {
    if (isSpecial(node.id)) return;
    (node.members || []).forEach((m) => {
      const si = sessionIndexOf.get(m.video_id);
      if (si === undefined) return;
      rawBySession[si].push({
        video_id: m.video_id,
        session_index: si,
        start: m.start,
        end: m.end,
        duration: +(m.end - m.start).toFixed(3),
        verb: m.verb,
        noun: m.noun,
        narration: (m.narration || "").trim(),
        state: node.id,
        phase: node.phase || stateOf.get(node.id)?.phase || "other",
      });
    });
  });
  rawBySession.forEach((arr) => arr.sort((a, b) => a.start - b.start));

  // 3. Per-session duration = last action's end. There is no separate video
  //    length in the new files, so this is the honest upper bound we have.
  const durations = rawBySession.map((arr) => (arr.length ? arr[arr.length - 1].end : 0));

  return {
    recipeId,
    graph,
    alphabet,
    sessionIds,
    sessionIndexOf,
    rawBySession,
    durations,
    nSessions: sessionIds.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MANIFEST — synthesized, because the new pipeline writes no manifest.json
// ─────────────────────────────────────────────────────────────────────────────

export async function loadRecipeManifest() {
  const recipes = [];
  for (const r of RECIPES) {
    try {
      const b = await loadBundle(r.id);
      recipes.push({
        id: r.id,
        name: r.name,
        has_merged: b.nSessions > 1,
        sessions: b.sessionIds.map((videoId, i) => ({
          index: i,
          video_id: videoId,
          video_path: videoUrl(videoId),
          duration_s: b.durations[i],
        })),
      });
    } catch (err) {
      console.warn(`[dataAdapter] skipping ${r.id}:`, err.message);
    }
  }
  if (recipes.length === 0) throw new Error("No recipe data files could be loaded.");
  return { recipes };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

const ACTION_ID = {
  full: (a) => `${a.verb}(${a.noun})`,
  hybrid: (a) => `${a.verb}(${nounCategory(a.noun)})`,
  step: (a) => a.state,
};

// ─────────────────────────────────────────────────────────────────────────────
// SEQUENCE BUILDERS
//
// Two timelines per payload, exactly as before:
//   sequence     — one row per GRAPH state (collapsed runs at L3)
//   raw_sequence — every annotated action, untouched (barcode / swimlane / table)
// ─────────────────────────────────────────────────────────────────────────────

function rawSequenceFor(actions, stepIdOf) {
  const L = Math.max(actions.length - 1, 1);
  const ids = actions.map((a) => `${a.verb}(${a.noun})`);
  return actions.map((a, i) => ({
    // `index` is required by timeline.js (row id + active-row matching).
    index: i,
    action: ids[i],
    raw_action: ids[i],
    // `edge_key` is what graph.js updateActive() matches against link.key to
    // light up the transition the video is currently playing. Same "|||"
    // separator the renderer already splits on.
    edge_key: i < ids.length - 1 ? `${ids[i]}|||${ids[i + 1]}` : null,
    next_action: ids[i + 1] || null,
    start: a.start,
    end: a.end,
    duration: a.duration,
    verb: a.verb,
    noun: a.noun,
    narration: a.narration,
    step_id: stepIdOf.get(a.state) || a.state,
    state: a.state,
    phase: a.phase,
    session_index: a.session_index,
    video_id: a.video_id,
    normalized_rank: i / L,
    is_primary: true,
  }));
}

// Collapse consecutive actions that map to the same id into one sequence row.
// At L1/L2 this only merges genuine immediate repeats; at L3 it is what turns
// 52 raw actions into "froth milk".
function graphSequenceFor(actions, mode, stepIdOf) {
  const idFn = ACTION_ID[mode] || ACTION_ID.hybrid;
  const runs = [];
  actions.forEach((a) => {
    const id = idFn(a);
    const last = runs[runs.length - 1];
    if (last && last.action === id) {
      last.end = a.end;
      last.members.push(a);
    } else {
      runs.push({ action: id, start: a.start, end: a.end, members: [a] });
    }
  });

  const L = Math.max(runs.length - 1, 1);
  return runs.map((r, i) => {
    const first = r.members[0];
    return {
      index: i,
      action: r.action,
      edge_key: i < runs.length - 1 ? `${r.action}|||${runs[i + 1].action}` : null,
      next_action: runs[i + 1] ? runs[i + 1].action : null,
      start: r.start,
      end: r.end,
      duration: +(r.end - r.start).toFixed(3),
      verb: first.verb,
      noun: first.noun,
      narration: first.narration,
      step_id: stepIdOf.get(first.state) || first.state,
      state: first.state,
      phase: first.phase,
      session_index: first.session_index,
      video_id: first.video_id,
      normalized_rank: i / L,
      n_raw_actions: r.members.length,
      members: r.members,
      is_primary: true,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAPH BUILDER (derives nodes + links from a set of session sequences)
//
// Used for L1 and L2 merged graphs, and for every per-session graph at every
// level. The L3 MERGED graph is not built here — it is read from the file,
// because only the file carries interruption_actions.
// ─────────────────────────────────────────────────────────────────────────────

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Evidence grade drives dash + opacity in graph.js (EVIDENCE_STYLE).
// Two things can make an edge weak, and both matter:
//   * it happened once  → the probability is one event written as a fraction
//   * only one session did it (support == 1) → it is not reproducible
// Weak edges are DE-EMPHASISED, never removed. Nothing is deleted here.
function evidenceOf(count, support, nSessions, anchor) {
  if (anchor) return "strong";
  if (nSessions > 1 && support === 1) return "weak";
  return count <= 1 ? "weak" : count <= 3 ? "moderate" : "strong";
}

function buildGraphFromSequences(sequences, nSessions, { stateMeta = null } = {}) {
  const nodeMap = new Map();
  const linkMap = new Map();

  const touchNode = (id, sessionIdx, item) => {
    if (!nodeMap.has(id)) {
      nodeMap.set(id, {
        id,
        counts: new Array(nSessions).fill(0),
        ranks: [],
        durations: [],
        verbs: {},
        states: {},
        members: [],
      });
    }
    const n = nodeMap.get(id);
    n.counts[sessionIdx] += 1;
    if (item) {
      n.ranks.push(item.normalized_rank);
      n.durations.push(item.duration);
      n.verbs[item.verb] = (n.verbs[item.verb] || 0) + 1;
      if (item.step_id) n.states[item.step_id] = (n.states[item.step_id] || 0) + 1;
      (item.members || [item]).forEach((m) => n.members.push(m));
    }
  };

  const touchLink = (s, t, sessionIdx) => {
    // "|||" not "->": graph.js builds pairKey as `${target}|||${source}` and
    // matches sequence.edge_key against link.key. A different separator here
    // means the playing transition never lights up.
    const key = `${s}|||${t}`;
    if (!linkMap.has(key)) {
      linkMap.set(key, { key, source: s, target: t, counts: new Array(nSessions).fill(0) });
    }
    linkMap.get(key).counts[sessionIdx] += 1;
  };

  sequences.forEach((seq, si) => {
    if (!seq.length) return;
    touchNode("START", si, null);
    touchNode("END", si, null);
    seq.forEach((item) => touchNode(item.action, si, item));
    touchLink("START", seq[0].action, si);
    for (let i = 0; i < seq.length - 1; i++) touchLink(seq[i].action, seq[i + 1].action, si);
    touchLink(seq[seq.length - 1].action, "END", si);
  });

  // ── nodes ────────────────────────────────────────────────────────────────
  const nodes = [...nodeMap.values()].map((n) => {
    const count = n.counts.reduce((a, b) => a + b, 0);
    const support = n.counts.filter((c) => c > 0).length;
    const special = n.id === "START" || n.id === "END";
    const topVerb = Object.entries(n.verbs).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    // n.states was voted on with the ALREADY-parseable step id, so no mapping
    // is needed here.
    const topState = Object.entries(n.states).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const meta = stateMeta ? stateMeta.get(n.id) : null;

    return {
      id: n.id,
      label: special ? n.id : (meta ? n.id : undefined),
      count,
      support,
      support_fraction: nSessions ? support / nSessions : 1,
      n_sessions: nSessions,
      per_session_counts: n.counts,
      median_rank: special ? (n.id === "START" ? 0 : 1) : median(n.ranks),
      mean_duration: n.durations.length
        ? +(n.durations.reduce((a, b) => a + b, 0) / n.durations.length).toFixed(2)
        : 0,
      n_raw_actions: n.members.length,
      verb: topVerb,
      step_id: topState,
      phase: meta?.phase || (n.members[0]?.phase ?? "other"),
      definition: meta?.definition || null,
      typical_verbs: meta?.typical_verbs || null,
      typical_objects: meta?.typical_objects || null,
      members: n.members,
      is_primary: true,
      isSpecial: special,
    };
  });

  // ── links ────────────────────────────────────────────────────────────────
  const outTotals = new Map();
  linkMap.forEach((l) => {
    const total = l.counts.reduce((a, b) => a + b, 0);
    outTotals.set(l.source, (outTotals.get(l.source) || 0) + total);
  });

  const rankOf = new Map(nodes.map((n) => [n.id, n.median_rank]));

  const links = [...linkMap.values()].map((l) => {
    const count = l.counts.reduce((a, b) => a + b, 0);
    const nOut = outTotals.get(l.source) || count;
    const support = l.counts.filter((c) => c > 0).length;
    const anchor = l.source === "START" || l.target === "END";
    return {
      key: l.key,
      source: l.source,
      target: l.target,
      count,
      n: count,
      n_out: nOut,
      probability: nOut ? +(count / nOut).toFixed(3) : 0,
      support,
      support_fraction: nSessions ? support / nSessions : 1,
      n_sessions: nSessions,
      per_session_counts: l.counts,
      evidence: evidenceOf(count, support, nSessions, anchor),
      // support == 1 → only one session ever did this. Styled, never removed.
      session_specific: !anchor && support === 1 && nSessions > 1,
      is_self_loop: l.source === l.target,
      is_return: (rankOf.get(l.target) ?? 1) < (rankOf.get(l.source) ?? 0),
      interruption_actions: 0,
      interruption_seconds: 0,
    };
  });

  return { nodes, links };
}

// ─────────────────────────────────────────────────────────────────────────────
// L3 MERGED GRAPH — straight from the file, only renamed
// ─────────────────────────────────────────────────────────────────────────────

function stateGraphFromFile(bundle, stepIdOf) {
  const { graph, alphabet, nSessions, sessionIndexOf } = bundle;
  const stateMeta = new Map(alphabet.states.map((s) => [s.name, s]));

  const nodes = graph.nodes.map((node) => {
    const special = node.id === "START" || node.id === "END";
    const perSession = new Array(nSessions).fill(0);
    (node.sessions || []).forEach((v) => {
      const i = sessionIndexOf.get(v);
      if (i !== undefined) perSession[i] += 1;
    });
    // `count` is how many RUNS of this state happened; `sessions` says which
    // sessions saw it, but not how many runs each contributed. Spread the extra
    // runs round-robin over the sessions that did see it, so per_session_counts
    // still sums to count and the support badge stays truthful.
    const seen = perSession.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
    let extra = (node.count || 0) - perSession.reduce((a, b) => a + b, 0);
    for (let k = 0; extra > 0 && seen.length > 0; k++, extra--) {
      perSession[seen[k % seen.length]] += 1;
    }

    const verbs = {};
    (node.members || []).forEach((m) => { verbs[m.verb] = (verbs[m.verb] || 0) + 1; });
    const topVerb = Object.entries(verbs).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const meta = stateMeta.get(node.id);

    return {
      id: node.id,
      label: node.label || node.id,
      count: node.count || 0,
      support: node.support || 0,
      support_fraction: nSessions ? (node.support || 0) / nSessions : 1,
      n_sessions: nSessions,
      per_session_counts: perSession,
      median_rank: node.median_rank ?? 0.5,
      mean_duration: node.mean_duration ?? 0,
      n_raw_actions: (node.members || []).length,
      verb: topVerb,
      step_id: stepIdOf ? (stepIdOf.get(node.id) || node.id) : node.id,
      state: node.id,
      phase: node.phase || meta?.phase || "other",
      definition: meta?.definition || null,
      typical_verbs: meta?.typical_verbs || null,
      typical_objects: meta?.typical_objects || null,
      merged_from: node.merged_from || null,
      sessions: node.sessions || [],
      members: node.members || [],
      is_primary: true,
      isSpecial: special,
    };
  });

  const rankOf = new Map(nodes.map((n) => [n.id, n.median_rank]));
  const outTotals = new Map();
  graph.edges.forEach((e) => {
    outTotals.set(e.source, (outTotals.get(e.source) || 0) + (e.n || 0));
  });

  const links = graph.edges.map((e) => {
    const perSession = new Array(nSessions).fill(0);
    (e.sessions || []).forEach((v) => {
      const i = sessionIndexOf.get(v);
      if (i !== undefined) perSession[i] += 1;
    });
    const anchor = e.source === "START" || e.target === "END";
    return {
      key: `${e.source}|||${e.target}`,
      source: e.source,
      target: e.target,
      count: e.n,
      n: e.n,
      n_out: outTotals.get(e.source) || e.n,
      probability: e.p,
      support: e.support,
      support_fraction: nSessions ? e.support / nSessions : 1,
      n_sessions: nSessions,
      per_session_counts: perSession,
      evidence: evidenceOf(e.n, e.support, nSessions, anchor),
      session_specific: !anchor && e.support === 1 && nSessions > 1,
      is_self_loop: e.source === e.target,
      is_return: (rankOf.get(e.target) ?? 1) < (rankOf.get(e.source) ?? 0),
      // Only the state level measures these.
      interruption_actions: e.interruption_actions || 0,
      interruption_seconds: e.interruption_seconds || 0,
      sessions: e.sessions || [],
    };
  });

  return { nodes, links };
}

// ─────────────────────────────────────────────────────────────────────────────
// L2.5 OPERATIONS → `expansions`
//
// PASTE 1 of 2 — put this function in dataAdapter.js, directly after
// stateGraphFromFile() ends and before the "COMMON TO EVERY SESSION" block.
//
// app.js already has the whole drill-down mechanism built:
//   double-click a node → tryExpand(id) → expansionsFor() → expandNodeInPlace()
// …plus the "← Back" button and the breadcrumb. It has never fired, because
// expansionsFor() looks for payload.expansions and nothing ever created it.
// This is that field.
//
// Shape it must have, per state:
//   expansions["froth milk"] = { nodes: [...], links: [{source,target,...}] }
// A state with fewer than 2 operations is skipped, because tryExpand() bails
// out below 2 nodes anyway — a single-operation state has nothing to open.
// ─────────────────────────────────────────────────────────────────────────────

function buildExpansions(bundle, videoId = null) {
  const { graph, nSessions } = bundle;
  const out = {};

  graph.nodes.forEach((node) => {
    if (node.id === "START" || node.id === "END") return;

    let ops = node.operations || [];
    let opEdges = node.operation_edges || [];

    // Per-session payload: keep only the operations that session performed.
    if (videoId) {
      ops = ops.filter((o) => (o.sessions || []).includes(videoId));
      const live = new Set(ops.map((o) => o.id));
      opEdges = opEdges.filter(
        (e) => (e.sessions || []).includes(videoId) &&
               live.has(e.source) && live.has(e.target)
      );
    }
    if (ops.length < 2) return;

    const denom = videoId ? 1 : nSessions;

    const nodes = ops.map((o, i) => ({
      id: o.id,
      label: o.label || o.id,
      count: o.count,
      support: o.support,
      support_fraction: denom ? o.support / denom : 1,
      n_sessions: denom,
      mean_duration: o.mean_duration,
      n_raw_actions: o.n_raw_actions,
      // getVerbColor() splits on "(", so "pour(water)" colours itself.
      verb: o.verb || String(o.id).split("(")[0],
      phase: o.phase,
      state: o.state,
      step_id: o.state,
      median_rank: ops.length > 1 ? i / (ops.length - 1) : 0.5,
      // Drill-down layer 3: the raw actions, with video id + timestamps.
      members: o.members || [],
      provenance: o.provenance || null,
      is_operation: true,
      is_primary: true,
      isSpecial: false,
    }));

    const outTotals = new Map();
    opEdges.forEach((e) => {
      outTotals.set(e.source, (outTotals.get(e.source) || 0) + (e.n || 0));
    });

    const links = opEdges.map((e) => {
      const nOut = outTotals.get(e.source) || e.n;
      return {
        key: `${e.source}|||${e.target}`,
        source: e.source,
        target: e.target,
        count: e.n,
        n: e.n,
        n_out: nOut,
        probability: videoId ? (nOut ? +(e.n / nOut).toFixed(3) : 0) : e.p,
        support: e.support,
        support_fraction: denom ? e.support / denom : 1,
        n_sessions: denom,
        evidence: evidenceOf(e.n, e.support, denom, false),
        session_specific: !videoId && e.support === 1 && nSessions > 1,
        is_self_loop: e.source === e.target,
        is_return: false,
        interruption_actions: 0,
        interruption_seconds: 0,
        sessions: e.sessions || [],
      };
    });

    out[node.id] = { nodes, links };
  });

  return out;
}


// ─────────────────────────────────────────────────────────────────────────────
// PASTE 2 of 2 — two one-line additions inside buildLevelPayloads().
//
// (a) In the `const merged = { … }` object literal, add this line
//     (anywhere among the other keys, e.g. right after `alphabet,`):
//
//         expansions: mode === "step" ? buildExpansions(bundle) : null,
//
//     Operations live INSIDE a functional state, so they are only reachable
//     from the L3 view. At L1/L2 you are already inside a state.
//
// (b) In the `sessions[i] = { … }` object literal, add:
//
//         expansions: mode === "step" ? buildExpansions(bundle, videoId) : null,
//
// Nothing else changes. graph.js is untouched; no layout code is touched.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// "COMMON TO EVERY SESSION" (Pattern A)
//
// Longest common subsequence across every session's state list, folded
// pairwise. Pairwise folding is an approximation of the true multi-sequence
// LCS (which is NP-hard); it can return a shorter answer, never a wrong one —
// everything it returns really did occur in every session, in order.
// ─────────────────────────────────────────────────────────────────────────────

function lcs2(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { out.unshift(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return out;
}

function canonicalSpine(sequences) {
  const paths = sequences
    .filter((s) => s.length)
    .map((s) => s.map((i) => i.action));

  if (paths.length === 0) {
    return { ids: [], report: { verdict: "no_shared_pattern", headline: "No data." } };
  }
  if (paths.length === 1) {
    return {
      ids: [],
      report: {
        verdict: "single_session",
        headline: "Only one recording of this recipe — agreement cannot be measured. "
                + "What you see is one observed run, not a pattern.",
      },
    };
  }

  let spine = paths[0];
  for (let i = 1; i < paths.length; i++) spine = lcs2(spine, paths[i]);

  const coverage = paths.map((p) => (p.length ? spine.length / p.length : 0));
  const minCov = Math.min(...coverage);
  const pct = Math.round(minCov * 100);

  let verdict, headline;
  if (spine.length < 2 || minCov < 0.2) {
    verdict = "no_shared_pattern";
    headline = `No shared pattern: the sessions agree on only ${spine.length} state(s), `
             + `covering ${pct}% of the shortest run. Reported as a result, not hidden.`;
  } else if (minCov < 0.5) {
    verdict = "partial_pattern";
    headline = `Partial pattern: ${spine.length} states in the same order in every session, `
             + `covering ${pct}–${Math.round(Math.max(...coverage) * 100)}% of each run.`;
  } else {
    verdict = "shared_pattern";
    headline = `Shared pattern: ${spine.length} states in the same order in every session, `
             + `covering ${pct}–${Math.round(Math.max(...coverage) * 100)}% of each run.`;
  }

  return { ids: spine, report: { verdict, headline, coverage } };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYLOAD ASSEMBLY
// ─────────────────────────────────────────────────────────────────────────────

// The step id MUST end in S<nn>.
//
// swimlane.js `localStepId()` and timeline.js `shortStepLabel()` both test the
// last underscore-separated part against /^S\d+$/ and bail out otherwise.
// Handing them "froth milk" gives the swimlane zero lanes and the table a
// meaningless Step column. So the state keeps its NAME as the label — which is
// what the reader sees, via buildStepLabelLookup() — and gets an ordinal id in
// the shape those two modules can parse.
export function ordinalStepId(recipeId, i) {
  return `${recipeId}_S${String(i + 1).padStart(2, "0")}`;
}

function stepsFrom(recipeId, alphabet) {
  return (alphabet.states || []).map((s, i) => ({
    id: ordinalStepId(recipeId, i),
    label: s.name,
    name: s.name,
    state_id: s.id,
    order: i,
    phase: s.phase,
    definition: s.definition,
    typical_verbs: s.typical_verbs,
    typical_objects: s.typical_objects,
  }));
}

function videosFor(bundle, sessionIdx) {
  const videoId = bundle.sessionIds[sessionIdx];
  // captureController.js maps unified time onto files with offset_s +
  // duration_s and loads `video_path`; videoQueue.js reads `video_path` for the
  // thumbnail. One session is one video here, so the layout is a single entry
  // at offset 0 and no source switching ever happens.
  return [{
    video_id: videoId,
    video_path: videoUrl(videoId),
    offset_s: 0,
    duration_s: bundle.durations[sessionIdx],
  }];
}

// Copy interruption figures from the file's merged edges onto a per-session
// graph, where the file recorded them for that session.
function attachInterruptions(links, fileEdges, videoId) {
  const byKey = new Map(fileEdges.map((e) => [`${e.source}|||${e.target}`, e]));
  links.forEach((l) => {
    const e = byKey.get(l.key);
    if (e && (e.sessions || []).includes(videoId)) {
      l.interruption_actions = e.interruption_actions || 0;
      l.interruption_seconds = e.interruption_seconds || 0;
    }
  });
  return links;
}

/**
 * Drop-in replacement for the old buildLevelPayloads().
 * Returns { merged, sessions } in exactly the old payload shape.
 */
export async function buildLevelPayloads(
  recipeId,
  recipe,
  mode = "step",                 // L3 is the default view, not L2
  focusState = null              // state NAME, e.g. "froth milk"; L1/L2 only
) {
  const bundle = await loadBundle(recipeId);
  registerAlphabet(recipeId, bundle.alphabet);

  const { alphabet, nSessions, sessionIds, durations, graph } = bundle;

  // Scope L1/L2 to one state. At L3 the whole recipe is always shown.
  const scoped = mode !== "step" && focusState;
  const rawBySession = scoped
    ? bundle.rawBySession.map((arr) => arr.filter((a) => a.state === focusState))
    : bundle.rawBySession;

  if (mode !== "step" && !focusState) {
    console.warn(
      `[dataAdapter] ${recipeId}: level "${mode}" was requested with no ` +
      `focusState, so every action in the recipe will be drawn at once. ` +
      `Pass the selected state name to keep the view readable.`
    );
  }
  const stateMeta = new Map(alphabet.states.map((s) => [s.name, s]));
  const steps = stepsFrom(recipeId, alphabet);
  // state name → "P01_R01_S02", so every sequence row and every graph node can
  // carry an id the swimlane and the timeline table know how to read.
  const stepIdOf = new Map(
    (alphabet.states || []).map((s, i) => [s.name, ordinalStepId(recipeId, i)])
  );

  const graphSeqs = rawBySession.map((a) => graphSequenceFor(a, mode, stepIdOf));
  const rawSeqs = rawBySession.map((a) => rawSequenceFor(a, stepIdOf));

  // ── merged ───────────────────────────────────────────────────────────────
  const mergedGraph = mode === "step"
    ? stateGraphFromFile(bundle, stepIdOf)
    : buildGraphFromSequences(graphSeqs, nSessions, { stateMeta: null });

  const spine = canonicalSpine(graphSeqs);
  const mandatory = mergedGraph.nodes
    .filter((n) => !n.isSpecial && n.support === nSessions)
    .map((n) => n.id);

  const merged = {
    recipe: {
      id: recipeId,
      name: recipe?.name || recipeId,
      n_sessions: nSessions,
      session_indices: sessionIds.map((_, i) => i),
      total_capture_duration_s: Math.max(...durations, 1),
      level: mode,
      min_run: MIN_RUN,
      focus_state: scoped ? focusState : null,
      // For the caption: "52 of 160 actions - inside 'froth milk'".
      n_actions_shown: rawBySession.reduce((t, a) => t + a.length, 0),
      n_actions_total: bundle.rawBySession.reduce((t, a) => t + a.length, 0),
    },
    graph: mergedGraph,
    graph_macro: null,      // no macro/bridge level in the new pipeline
    macro_sequence: [],
    macro_report: null,
    filter_report: null,
    // Pooled across sessions — used for duration statistics and the temporal
    // layout, never for "what happened when" (that is per-session).
    sequence: graphSeqs.flat(),
    raw_sequence: rawSeqs.flat(),
    steps,
    alphabet,
    expansions: mode === "step" ? buildExpansions(bundle) : null,
    analysis: {
      canonical_spine: spine.ids,
      canonical_spine_path: spine.ids.map((id) => ({ id, tier: "spine" })),
      canonical_spine_report: spine.report,
      mandatory_nodes: mandatory,
    },
  };

  // ── one payload per session ──────────────────────────────────────────────
  const sessions = {};
  sessionIds.forEach((videoId, i) => {
    const sessionGraph = buildGraphFromSequences([graphSeqs[i]], 1, {
      stateMeta: mode === "step" ? stateMeta : null,
    });
    if (mode === "step") attachInterruptions(sessionGraph.links, graph.edges, videoId);

    sessions[i] = {
      recipe: {
        id: recipeId,
        name: recipe?.name || recipeId,
        n_sessions: 1,
        session_index: i,
        video_id: videoId,
        total_capture_duration_s: durations[i] || 1,
        level: mode,
        min_run: MIN_RUN,
        focus_state: scoped ? focusState : null,
      },
      graph: sessionGraph,
      // Nothing is filtered out of a single session's own path, so the audit
      // view and the primary view are the same graph.
      graph_unfiltered: sessionGraph,
      graph_macro: null,
      macro_report: null,
      sequence: graphSeqs[i],
      raw_sequence: rawSeqs[i],
      videos: videosFor(bundle, i),
      steps,
      alphabet,
      expansions: mode === "step" ? buildExpansions(bundle, videoId) : null,
      analysis: {
        canonical_spine: graphSeqs[i].map((s) => s.action),
        canonical_spine_report: {
          verdict: "single_session",
          headline: "One session — this is the run that happened, not a pattern.",
        },
        mandatory_nodes: [],
      },
    };
  });

  return { merged, sessions };
}