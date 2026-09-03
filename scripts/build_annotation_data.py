#!/usr/bin/env python3
"""
build_annotation_data.py
========================

Raw HD-EPIC  ->  data.js  for the video-grounded proactivity annotation tool.

Replaces the hand-made data.js. Every number in the output is traceable to a
stage in this file, and every stage writes what it did to an audit report.

WHY THIS EXISTS
---------------
Prof. Lin's standing requirement is that abstraction logic be documented and
checkable, not a black box. So this script has three properties:

  1. Deterministic by default. The LLM stage only renames things for display.
     Run with --no-llm and you get the same graph with rule-based labels.
     Nothing about the structure depends on a model call.
  2. Nothing is deleted. Filtered nodes and edges stay in the output, tagged,
     with the probability mass they carry, so the Markov chain still sums to 1.
  3. Every stage writes counts to <recipe>_audit.md, which regenerates the
     tables in DESIGN.md. If a number in the paper changes, it changes because
     the data changed, not because someone retyped it.

STAGES
------
  0 load       narrations pkl + verb/noun vocab + recipe json + timestamps csv
  1 scope      keep only actions inside this recipe's activity windows
  2 reduce     one (verb_class, noun_class) per narration
  3 identify   node key = verb_key + " " + noun_category  (+ the count table
               that justifies that choice against four alternatives)
  4 align      milestone-aligned position, piecewise between step completions
  5 recur      split node types into recurring (>= --min-sessions) and one-off
  6 graph      transitions, core / backbone / hidden edges, residual mass,
               self-loops, START and END mass
  7 label      display labels    [LLM optional, cached, diffed against rules]
  8 emit       data.js + audit.md + audit.json + instances.csv

USAGE
-----
    pip install pandas requests

    python build_annotation_data.py --recipe P01_R01 --recipe P03_R03
    python build_annotation_data.py --recipe P05_R02 --no-llm

File paths default to the standard HD-EPIC filenames searched upward from the
working directory, same as build_functional_graph.py. Override any of them.

The LLM key is read from a .env next to the script (GEMINI_API_KEY=...).

OUTPUTS (in --out, default ./out)
---------------------------------
  data.js                 const DATA = {...}   <- what index.html loads
  <recipe>_audit.md       the numbers, in tables you can paste into DESIGN.md
  <recipe>_audit.json     the same numbers, machine readable
  <recipe>_instances.csv  every annotatable instance with a stable id
  <recipe>_labels.json    node key -> display label, with the rule-based
                          fallback alongside so the LLM's edits are visible
  prompts/<recipe>_*.txt  the exact prompt text sent, for the appendix
"""

import argparse
import ast
import collections
import json
import os
import re
import statistics
import sys
import time

import pandas as pd

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROVIDER = os.environ.get("ABSTRACTION_PROVIDER", "gemini")
DEFAULT_MODEL = {"gemini": "gemini-3.5-flash-lite", "anthropic": "claude-sonnet-5"}
MODEL = None
MIN_CALL_INTERVAL = 4.5

# ============================================================================
# .env + file discovery  (same conventions as build_functional_graph.py)
# ============================================================================

KEY_NAMES = {
    "gemini": ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
    "anthropic": ["ANTHROPIC_API_KEY"],
}
_ENV_LINE = re.compile(r"""^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$""")


def load_dotenv(explicit=None):
    paths = [explicit] if explicit else []
    d = os.path.abspath(os.getcwd())
    for _ in range(4):
        paths.append(os.path.join(d, ".env"))
        d = os.path.dirname(d)
    paths.append(os.path.join(SCRIPT_DIR, ".env"))
    for p in paths:
        if not p or not os.path.isfile(p):
            continue
        for line in open(p, encoding="utf-8", errors="ignore"):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            m = _ENV_LINE.match(line)
            if m:
                k, v = m.group(1), m.group(2).strip().strip("'\"")
                os.environ.setdefault(k, v)
        return p
    return None


def get_api_key(provider):
    for name in KEY_NAMES[provider]:
        if os.environ.get(name):
            return os.environ[name], name
    raise SystemExit(
        f"No API key found. Put one of {KEY_NAMES[provider]} in a .env file, "
        f"or run with --no-llm to use rule-based labels.")


LAYOUTS = {
    "recipes": ["complete_recipes.json", "high-level/complete_recipes.json",
                "../high-level/complete_recipes.json"],
    "verbs": ["HD_EPIC_verb_classes.csv", "narrations/HD_EPIC_verb_classes.csv",
              "../narrations/HD_EPIC_verb_classes.csv"],
    "nouns": ["HD_EPIC_noun_classes.csv", "narrations/HD_EPIC_noun_classes.csv",
              "../narrations/HD_EPIC_noun_classes.csv"],
    "timestamps": ["{pid}_recipe_timestamps.csv",
                   "high-level/{pid}_recipe_timestamps.csv",
                   "../high-level/{pid}_recipe_timestamps.csv"],
    "narrations": ["recipe_narrations_{recipe}.pkl", "HD_EPIC_Narrations.pkl",
                   "narrations/HD_EPIC_Narrations.pkl",
                   "../narrations/HD_EPIC_Narrations.pkl"],
}


def base_dirs():
    cwd = os.path.abspath(os.getcwd())
    cands = [cwd, os.path.dirname(cwd), SCRIPT_DIR, os.path.dirname(SCRIPT_DIR),
             os.path.dirname(os.path.dirname(SCRIPT_DIR))]
    seen, out = set(), []
    for d in cands:
        if d and d not in seen and os.path.isdir(d):
            seen.add(d)
            out.append(d)
    return out


def find_file(kind, explicit=None, recipe="", required=True):
    patterns = [explicit] if explicit else LAYOUTS[kind]
    if explicit and os.path.isabs(explicit) and os.path.isfile(explicit):
        return explicit
    pid = recipe.split("_")[0] if recipe else ""
    patterns = [p.format(recipe=recipe, pid=pid) for p in patterns]
    tried = []
    for pat in patterns:
        for base in base_dirs():
            path = os.path.normpath(os.path.join(base, pat))
            tried.append(path)
            if os.path.isfile(path):
                return path
    wanted = {os.path.basename(p) for p in patterns}
    for base in base_dirs()[:2]:
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith(".") and
                       d not in ("node_modules", "__pycache__", "venv", ".git")]
            if root[len(base):].count(os.sep) > 3:
                dirs[:] = []
                continue
            for f in files:
                if f in wanted:
                    return os.path.join(root, f)
    if not required:
        return None
    listing = "\n".join(f"    {t}" for t in dict.fromkeys(tried))
    raise SystemExit(f"Could not find the {kind} file.\n  Looked in:\n{listing}\n\n"
                     f'Pass it directly, e.g.  --{kind} "D:/path/to/file"')


# ============================================================================
# STAGE 0 - load
# ============================================================================

def load_vocab(verbs_csv, nouns_csv):
    v = pd.read_csv(verbs_csv)
    n = pd.read_csv(nouns_csv)
    verb = {int(r.id): (str(r.key), str(r.category)) for r in v.itertuples()}
    noun = {int(r.id): (str(r.key), str(r.category)) for r in n.itertuples()}
    return verb, noun


def load_recipe(recipes_json, recipe_id):
    with open(recipes_json, encoding="utf-8") as f:
        recipes = json.load(f)
    if recipe_id not in recipes:
        raise SystemExit(f"recipe {recipe_id} not in {recipes_json}")
    return recipes[recipe_id]


def load_windows(ts_csv, video_ids, recipe_id):
    """[(start, end)] per video where THIS recipe was actually happening.

    HD-EPIC videos are whole kitchen sessions. P01's first video is coffee for
    48s, then orange juice, then washing up. Only the coffee is R01.
    """
    short = recipe_id.split("_")[-1]
    df = pd.read_csv(ts_csv)
    out = {}
    for v in video_ids:
        rows = df[(df["video_id"] == v) & (df["recipe_id"].astype(str) == short)]
        wins = []
        for r in rows.itertuples():
            end = str(r.end_time).strip()
            wins.append((float(r.start_time),
                         float("inf") if end in ("end", "nan", "") else float(end)))
        out[v] = sorted(wins)
    return out


def _first_pair(row):
    """STAGE 2 in miniature: one (verb_class, noun_class) per narration.

    Priority main_action_classes -> pair_classes -> (verb_classes[0], noun_classes[0]).
    Returns (pair, source) so the audit can report how often each was used.
    """
    for field in ("main_action_classes", "pair_classes"):
        val = row.get(field)
        if isinstance(val, str):
            try:
                val = ast.literal_eval(val)
            except Exception:
                val = None
        if isinstance(val, (list, tuple)) and len(val) > 0:
            p = val[0]
            if isinstance(p, (list, tuple)) and len(p) == 2:
                return (int(p[0]), int(p[1])), field, len(val)
    vc, nc = row.get("verb_classes"), row.get("noun_classes")
    if isinstance(vc, str):
        try:
            vc = ast.literal_eval(vc)
        except Exception:
            vc = None
    if isinstance(nc, str):
        try:
            nc = ast.literal_eval(nc)
        except Exception:
            nc = None
    if vc and nc:
        return (int(vc[0]), int(nc[0])), "verb_classes+noun_classes", 1
    return None, "none", 0


def load_actions(narrations_pkl, video_ids, verb_map, noun_map):
    """Every annotated action for these videos, time-sorted, with stable ids."""
    df = pd.read_pickle(narrations_pkl)
    present = set(df["video_id"].unique())
    keep = [v for v in video_ids if v in present]
    if keep:
        df = df[df["video_id"].isin(keep)]
    else:
        print("  (no video_id overlap with the pkl; using every row)", file=sys.stderr)
    out = collections.defaultdict(list)
    prov = collections.Counter()
    multi = 0
    unmapped = 0
    for i, row in enumerate(df.to_dict("records")):
        pair, source, n_main = _first_pair(row)
        prov[source] += 1
        if n_main > 1:
            multi += 1
        if pair is None:
            continue
        vcls, ncls = pair
        if vcls not in verb_map or ncls not in noun_map:
            unmapped += 1
            continue
        vkey, vcat = verb_map[vcls]
        nkey, ncat = noun_map[ncls]
        nid = row.get("unique_narration_id")
        if not isinstance(nid, str) or not nid:
            nid = f"{row['video_id']}-{i}"
        out[row["video_id"]].append({
            "nid": nid,
            "video_id": row["video_id"],
            "start": float(row["start_timestamp"]),
            "end": float(row["end_timestamp"]),
            "verb_key": vkey, "verb_cat": vcat,
            "noun_key": nkey, "noun_cat": ncat,
            "narration": str(row.get("narration", "")).strip(),
        })
    for v in out:
        out[v].sort(key=lambda a: a["start"])
    return dict(out), {"pair_source": dict(prov), "multi_action_narrations": multi,
                       "unmapped_class_ids": unmapped}


# ============================================================================
# STAGE 1 - scope to the recipe, and build one timeline per session
# ============================================================================

def build_sessions(recipe, per_video_actions, windows, recipe_id):
    """One session per capture.

    A capture can span several videos. We lay them end to end on a single
    session clock so alignment and ordering have something to work with, but
    every action keeps its own (video_id, local start) so the clip player can
    seek the real file. offset[v] converts local -> session time.
    """
    sessions = []
    scope_log = []
    for ci, cap in enumerate(recipe["captures"]):
        vids = cap["videos"]
        offset, cursor, spans = {}, 0.0, {}
        for v in vids:
            wins = [w for w in windows.get(v, []) if w[0] != float("inf")]
            if not wins:
                offset[v], spans[v] = cursor, None
                continue
            lo = min(w[0] for w in wins)
            hi = max(w[1] for w in wins)
            if hi == float("inf"):
                acts = per_video_actions.get(v, [])
                hi = max([a["end"] for a in acts], default=lo)
            offset[v] = cursor - lo
            spans[v] = (lo, hi)
            cursor += (hi - lo)
        acts, dropped = [], 0
        for v in vids:
            for a in per_video_actions.get(v, []):
                inside = any(w[0] <= a["start"] < w[1] for w in windows.get(v, []))
                if not inside:
                    dropped += 1
                    continue
                b = dict(a)
                b["t"] = a["start"] + offset[v]
                b["t_end"] = a["end"] + offset[v]
                b["vid_idx"] = vids.index(v)
                acts.append(b)
        acts.sort(key=lambda a: a["t"])
        total = sum(len(per_video_actions.get(v, [])) for v in vids)
        scope_log.append({"session": ci + 1, "videos": vids,
                          "actions_in_videos": total, "kept": len(acts),
                          "dropped_other_activity": dropped,
                          "span_s": round(cursor, 1)})
        sessions.append({"idx": ci, "videos": vids, "offset": offset,
                         "spans": spans, "capture": cap, "actions": acts,
                         "t0": 0.0, "t1": cursor})
    return sessions, scope_log


# ============================================================================
# STAGE 3 - node identity, and the table that justifies it
# ============================================================================

NODE_DEFS = {
    "verb key + noun key": lambda a: f'{a["verb_key"]} {a["noun_key"]}',
    "verb key + noun category": lambda a: f'{a["verb_key"]} {a["noun_cat"]}',
    "verb category + noun category": lambda a: f'{a["verb_cat"]} {a["noun_cat"]}',
    "verb key alone": lambda a: a["verb_key"],
    "verb category alone": lambda a: a["verb_cat"],
}
CHOSEN_DEF = "verb key + noun category"


def identity_table(sessions):
    """The measured comparison behind the node-identity choice.

    Node explosion comes from the noun side (303 noun classes vs 106 verb
    keys), so this table is the evidence that collapsing the verb further does
    not fix it. Regenerated every run so DESIGN.md can never drift from the code.
    """
    all_acts = [a for s in sessions for a in s["actions"]]
    return {name: len({fn(a) for a in all_acts}) for name, fn in NODE_DEFS.items()}


# ============================================================================
# STAGE 4 - milestone alignment
# ============================================================================

def milestones(session, step_ids):
    """Boundary times for this session, in session-clock seconds.

    Milestone k = the LAST end time of step k's occurrences in this session,
    then a running maximum so the sequence is monotone. Steps performed out of
    order or revisited (P01_R01 S02 happens at 15s AND 41s, after S03) collapse
    into a zero-length segment rather than producing a negative one.

    Returns (boundaries, notes). boundaries has len(step_ids)+2 entries:
    [session start, M1 ... MK, session end].
    """
    cap = session["capture"]
    st = cap.get("step_times", {}) or {}
    raw, notes = [], []
    for sid in step_ids:
        occ = st.get(sid, []) or []
        ends = []
        for o in occ:
            v = o.get("video")
            if v not in session["offset"]:
                continue
            ends.append(float(o["end"]) + session["offset"][v])
        if not ends:
            raw.append(None)
            notes.append({"step": sid, "issue": "not annotated in this session"})
        else:
            raw.append(max(ends))
            if len(occ) > 1:
                notes.append({"step": sid, "issue": f"{len(occ)} occurrences, "
                              f"used last end"})

    # interpolate missing milestones between known neighbours
    known = [(i, t) for i, t in enumerate(raw) if t is not None]
    if not known:
        raise SystemExit("no step_times at all for this session; cannot align")
    filled = list(raw)
    for i, t in enumerate(raw):
        if t is not None:
            continue
        before = [(j, u) for j, u in known if j < i]
        after = [(j, u) for j, u in known if j > i]
        if before and after:
            (j0, u0), (j1, u1) = before[-1], after[0]
            filled[i] = u0 + (u1 - u0) * (i - j0) / (j1 - j0)
        elif before:
            filled[i] = before[-1][1]
        else:
            filled[i] = session["t0"]

    # monotone + clamped into the session window
    mono, prev, collapses = [], session["t0"], 0
    for t in filled:
        t = max(prev, min(t, session["t1"]))
        if abs(t - prev) < 1e-6 and mono:
            collapses += 1
        mono.append(t)
        prev = t
    if collapses:
        notes.append({"step": "-", "issue": f"{collapses} zero-length segment(s) "
                      f"from out-of-order or revisited steps"})
    return [session["t0"]] + mono + [session["t1"]], notes


def make_position_fn(bounds, seg_frac):
    """Map a session-clock time to [0,1] in the shared aligned space.

    Segment i of the session maps onto display band [seg_frac[i], seg_frac[i+1]].
    Uniform seg_frac reproduces DESIGN.md exactly; duration-weighted seg_frac
    removes the empty-band artifact when two steps share an end time.
    """
    def pos(t):
        for i in range(len(bounds) - 1):
            lo, hi = bounds[i], bounds[i + 1]
            if t < hi or i == len(bounds) - 2:
                a, b = seg_frac[i], seg_frac[i + 1]
                if hi - lo <= 1e-6:
                    return a
                return a + (b - a) * max(0.0, min(1.0, (t - lo) / (hi - lo)))
        return 1.0
    return pos


def segment_fractions(all_bounds, mode, n_seg):
    """Where each segment boundary sits on the 0-1 display axis.

    uniform : segment i -> [i/K, (i+1)/K]. What DESIGN.md describes.
    median  : segment widths proportional to their median real duration across
              sessions. Steps that take longer everywhere get more room, and a
              segment that is near-zero in every session stops eating a full
              slot. Alignment at the boundaries is identical either way.
    """
    if mode == "uniform":
        return [i / n_seg for i in range(n_seg + 1)]
    widths = []
    for i in range(n_seg):
        ds = [b[i + 1] - b[i] for b in all_bounds]
        widths.append(max(0.02, statistics.median(ds)))
    tot = sum(widths)
    frac, acc = [0.0], 0.0
    for w in widths:
        acc += w / tot
        frac.append(round(acc, 6))
    frac[-1] = 1.0
    return frac


# ============================================================================
# STAGE 6 - graph: transitions, edge classes, residual mass
# ============================================================================

def build_graph(sessions, node_index, min_sessions, transitions_mode):
    """The Markov chain, and an honest account of what is drawn.

    Every outgoing transition from a node is counted, including the ones that
    do not survive the recurrence filter and including transitions that end
    the session. Edges are then labelled:

      core     : observed in >= min_sessions sessions            (drawn dark)
      backbone : the single most likely outgoing transition of a node that
                 would otherwise have no visible successor        (drawn pale)
      hidden   : everything else, not drawn, but its probability is carried
                 on the source node as `res` so out-degree still sums to 1.

    The backbone rule exists because a >= min_sessions edge filter on its own
    produces sink nodes with no outgoing arrow at all, which Prof. Lin has
    flagged twice. It guarantees every non-terminal node has a successor
    without pretending a once-seen transition is a pattern.

    transitions_mode:
      contract : one-off actions are stepped over, so the flow between
                 recurring nodes stays connected (they remain rateable in the
                 lanes - nothing is deleted, only bypassed in the graph)
      adjacent : only literally consecutive recurring actions count
    """
    n = len(node_index)
    out_ct = collections.defaultdict(collections.Counter)   # src -> dst -> count
    out_sess = collections.defaultdict(lambda: collections.defaultdict(set))
    loops = collections.Counter()
    loop_sess = collections.defaultdict(set)
    start_ct, end_ct = collections.Counter(), collections.Counter()
    start_sess = collections.defaultdict(set)
    end_sess = collections.defaultdict(set)
    skipped_oneoff = 0

    for s in sessions:
        seq = []
        for a in s["actions"]:
            k = a["node_key"]
            if k in node_index:
                seq.append(node_index[k])
            elif transitions_mode == "adjacent":
                seq.append(None)
            else:
                skipped_oneoff += 1
        seq = [x for x in seq if x is not None] if transitions_mode == "contract" \
            else seq
        if not seq:
            continue
        first = next((x for x in seq if x is not None), None)
        last = next((x for x in reversed(seq) if x is not None), None)
        if first is not None:
            start_ct[first] += 1
            start_sess[first].add(s["idx"])
        if last is not None:
            end_ct[last] += 1
            end_sess[last].add(s["idx"])
        for a, b in zip(seq, seq[1:]):
            if a is None or b is None:
                continue
            if a == b:
                loops[a] += 1
                loop_sess[a].add(s["idx"])
                continue
            out_ct[a][b] += 1
            out_sess[a][b].add(s["idx"])

    # ---- select which transitions are drawn -------------------------------
    totals = {}
    for a in range(n):
        totals[a] = sum(out_ct[a].values()) + loops[a] + end_ct[a]

    drawn = {}          # (src, dst) -> kind  0=core 1=backbone
    for a in range(n):
        for b, c in out_ct[a].items():
            if len(out_sess[a][b]) >= min_sessions:
                drawn[(a, b)] = 0

    # backbone out: a node with no drawn successor keeps its likeliest one
    for a in range(n):
        if not out_ct[a] or any(k[0] == a for k in drawn):
            continue
        b = max(out_ct[a].items(), key=lambda kv: kv[1])[0]
        drawn[(a, b)] = 1

    # backbone in: a node nothing points to is unreachable, which is the other
    # half of the same complaint. Give it its likeliest predecessor.
    reached = {b for _, b in drawn} | set(loops) | set(start_ct)
    for b in range(n):
        if b in reached:
            continue
        preds = [(a, out_ct[a][b]) for a in range(n) if b in out_ct[a]]
        if not preds:
            continue
        a = max(preds, key=lambda kv: kv[1])[0]
        drawn.setdefault((a, b), 1)

    edges, hidden = [], []
    node_res, node_end = [0.0] * n, [0.0] * n
    for a in range(n):
        tot = totals[a]
        if tot == 0:
            continue
        shown = 0.0
        for b, c in sorted(out_ct[a].items(), key=lambda kv: -kv[1]):
            p = c / tot
            kind = drawn.get((a, b))
            if kind is None:
                hidden.append({"src": a, "dst": b, "count": c,
                               "sessions": len(out_sess[a][b])})
                continue
            edges.append([a, b, round(p, 4), len(out_sess[a][b]), kind])
            shown += p
        node_end[a] = round(end_ct[a] / tot, 4)
        shown += loops[a] / tot
        node_res[a] = round(max(0.0, 1.0 - shown - node_end[a]), 4)

    loop_list = [[a, round(loops[a] / max(1, sum(out_ct[a].values()) + loops[a]
                                          + end_ct[a]), 4),
                  len(loop_sess[a]), loops[a]] for a in sorted(loops)]
    starts = [[a, start_ct[a], len(start_sess[a])] for a in sorted(start_ct)]
    ends = [[a, end_ct[a], len(end_sess[a])] for a in sorted(end_ct)]

    # connectivity check - the thing that gets asked about in the meeting
    has_out = {e[0] for e in edges} | {l[0] for l in loop_list} | \
              {a for a in range(n) if node_end[a] > 0}
    has_in = {e[1] for e in edges} | {l[0] for l in loop_list} | \
             {a for a, _, _ in starts}
    orphans = {"no_outgoing": sorted(set(range(n)) - has_out),
               "no_incoming": sorted(set(range(n)) - has_in)}

    return {"edges": edges, "loops": loop_list, "starts": starts, "ends": ends,
            "res": node_res, "endp": node_end, "hidden": hidden,
            "orphans": orphans, "contracted_oneoffs": skipped_oneoff}


# ============================================================================
# STAGE 7 - display labels
# ============================================================================

# Particles that belong to the verb, never to the object. "pick up mug" is
# verb "pick up" + object "mug"; splitting on the first space gives the wrong
# answer for every phrasal verb in the kitchen vocabulary.
PARTICLES = {"up", "on", "off", "out", "in", "down", "over", "back", "away",
             "into", "onto", "through", "apart", "together"}

SYSTEM = ("You rename machine-generated action labels into plain English that a "
          "person with no robotics or dataset background can picture. You reply "
          "with JSON only: no prose, no markdown, no code fences.")

LABEL_PROMPT = """These are action types extracted from egocentric video of one person \
making "{recipe_name}". Each was built mechanically as [verb class] + [object \
category], which produces phrases nobody says out loud, like "lift dairy and eggs".

Rewrite each in plain English a non-expert would recognise. The node box prints
the action on the first line and the thing it acts on underneath, so return the
two parts SEPARATELY. Do not put the whole phrase in one field.

Rules:
  - "verb": the action, including any particle that belongs to it.
    "pick up", "turn on", "put back", "pour". 1-2 words, lower case.
  - "object": what it acts on. "mug", "milk bottle", "machine button".
    1-3 words, lower case, no article.
  - The particle goes with the VERB, never with the object. "pick up mug" splits
    as verb "pick up" / object "mug", never verb "pick" / object "up mug".
  - Keep the verb's meaning. Do not invent an action that is not in the samples.
  - Replace the object CATEGORY with the concrete object that dominates the
    samples. "dairy and eggs" where every sample is milk becomes "milk".
  - If the samples genuinely mix objects, use a plain umbrella word ("cups",
    "containers"), not the dataset's category name.
  - verb+object together must be unique across all keys.

Reply with JSON:
{{"labels": [{{"key": "<key exactly as given>", "verb": "<action>", "object": "<thing>"}}]}}

Action types:
{items}
"""

STEP_PROMPT = """These are the written steps of the recipe "{recipe_name}". They are \
used as tick labels on a narrow horizontal axis, so they must be very short.

Shorten each to at most 3 words that still say which step it is. Keep the order.

Reply with JSON: {{"steps": [{{"id": "<step id>", "short": "<short label>"}}]}}

Steps:
{items}
"""

_last_call = [0.0]


def _throttle():
    wait = MIN_CALL_INTERVAL - (time.time() - _last_call[0])
    if wait > 0:
        time.sleep(wait)
    _last_call[0] = time.time()


def _call_gemini(prompt, system, max_tokens):
    import requests
    key, _ = get_api_key("gemini")
    model = MODEL or DEFAULT_MODEL["gemini"]
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent")
    body = {"system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0, "maxOutputTokens": max_tokens,
                                 "responseMimeType": "application/json"}}
    delay = 8
    for _ in range(5):
        _throttle()
        r = requests.post(url, headers={"x-goog-api-key": key,
                                        "Content-Type": "application/json"},
                          json=body, timeout=180)
        if r.status_code == 429:
            print(f"    rate limited, waiting {delay}s", file=sys.stderr)
            time.sleep(delay)
            delay *= 2
            continue
        if r.status_code != 200:
            raise SystemExit(f"Gemini HTTP {r.status_code}: {r.text[:600]}")
        cand = r.json()["candidates"][0]
        if cand.get("finishReason") == "MAX_TOKENS":
            raise SystemExit("Gemini hit maxOutputTokens; lower --batch")
        return "".join(p.get("text", "") for p in cand["content"]["parts"])
    raise SystemExit("Gemini rate limit did not clear after 5 attempts")


def llm(prompt, system, max_tokens=6000):
    for attempt in range(2):
        text = _call_gemini(prompt, system, max_tokens).strip()
        text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            if attempt == 1:
                raise SystemExit("LLM did not return valid JSON:\n" + text[:1200])
            prompt += "\n\nYour last reply was not valid JSON. Reply with JSON only."
    raise SystemExit("unreachable")


def rule_label(key, members):
    """Deterministic fallback, returned already split into (verb, object).

    The split is never guessed from the string. The verb side is the HD-EPIC
    verb key, which is a single token by construction ("turn-on", not
    "turn on"), so there is nothing to parse. Hyphens become spaces for display.

    "lift dairy and eggs" -> ("lift", "milk"). No model needed. This is also the
    baseline the LLM output is diffed against, so an LLM label that is worse
    than the rule is visible rather than silently adopted.
    """
    verb = members[0]["verb_key"].replace("-", " ")
    nouns = collections.Counter(m["noun_key"] for m in members)
    top, ct = nouns.most_common(1)[0]
    if ct / len(members) >= 0.6:
        return (verb, top)
    return (verb, members[0]["noun_cat"])


def label_nodes(recipe_id, recipe_name, nodes, members_by_key, out_dir,
                use_llm, refresh):
    """Display labels, with the rule-based version kept alongside for audit."""
    cache = os.path.join(out_dir, f"{recipe_id}_labels.json")
    rules = {n["k"]: rule_label(n["k"], members_by_key[n["k"]]) for n in nodes}
    if not use_llm:
        table = {k: {"rule": list(v), "llm": None, "used": list(v),
                     "source": "rule"} for k, v in rules.items()}
        json.dump(table, open(cache, "w", encoding="utf-8"), indent=1,
                  ensure_ascii=False)
        return table

    if os.path.isfile(cache) and not refresh:
        table = json.load(open(cache, encoding="utf-8"))
        if set(table) == set(rules):
            print("  labels: cache hit")
            return table

    items = []
    for n in nodes:
        ms = members_by_key[n["k"]]
        nouns = collections.Counter(m["noun_key"] for m in ms).most_common(4)
        samples = [m["narration"][:110] for m in ms[:4]]
        items.append(f'- key: "{n["k"]}"\n  objects seen: '
                     f'{", ".join(f"{k} x{c}" for k, c in nouns)}\n  samples:\n'
                     + "\n".join(f"    * {s}" for s in samples))
    prompt = LABEL_PROMPT.format(recipe_name=recipe_name, items="\n".join(items))
    pdir = os.path.join(out_dir, "prompts")
    os.makedirs(pdir, exist_ok=True)
    open(os.path.join(pdir, f"{recipe_id}_labels.txt"), "w",
         encoding="utf-8").write(SYSTEM + "\n\n---\n\n" + prompt)

    data = llm(prompt, SYSTEM)
    got = {}
    for rec in (data.get("labels") if isinstance(data, dict) else data) or []:
        if not (isinstance(rec, dict) and rec.get("key") in rules):
            continue
        v = str(rec.get("verb", "")).strip().strip(".").lower()
        o = str(rec.get("object", "")).strip().strip(".").lower()
        # Guard the split itself: a dangling particle on the object side is the
        # exact failure this field pair exists to prevent.
        if o.split()[:1] and o.split()[0] in PARTICLES:
            v, o = f"{v} {o.split()[0]}".strip(), " ".join(o.split()[1:])
        if v and o and len(v.split()) <= 3 and len(o.split()) <= 4:
            got[rec["key"]] = (v, o)
    seen, table = set(), {}
    for k, rl in rules.items():
        pair, why = got.get(k), "llm"
        if not pair:
            pair, why = rl, "rule (llm gave nothing)"
        elif " ".join(pair) in seen:
            pair, why = rl, "rule (llm label collided)"
        seen.add(" ".join(pair))
        table[k] = {"rule": list(rl), "llm": list(got[k]) if k in got else None,
                    "used": list(pair), "source": why}
    json.dump(table, open(cache, "w", encoding="utf-8"), indent=1,
              ensure_ascii=False)
    return table


def label_steps(recipe_id, recipe_name, steps, out_dir, use_llm, refresh):
    cache = os.path.join(out_dir, f"{recipe_id}_steps.json")
    if os.path.isfile(cache) and not refresh:
        t = json.load(open(cache, encoding="utf-8"))
        if set(t) == {s["id"] for s in steps}:
            return t
    fallback = {s["id"]: " ".join(s["label"].split()[:3]).strip(",.")
                for s in steps}
    if not use_llm:
        json.dump(fallback, open(cache, "w", encoding="utf-8"), indent=1)
        return fallback
    items = "\n".join(f'- id: "{s["id"]}"  text: "{s["label"]}"' for s in steps)
    prompt = STEP_PROMPT.format(recipe_name=recipe_name, items=items)
    pdir = os.path.join(out_dir, "prompts")
    os.makedirs(pdir, exist_ok=True)
    open(os.path.join(pdir, f"{recipe_id}_steps.txt"), "w",
         encoding="utf-8").write(SYSTEM + "\n\n---\n\n" + prompt)
    data = llm(prompt, SYSTEM, 2000)
    out = dict(fallback)
    for rec in (data.get("steps") if isinstance(data, dict) else data) or []:
        if isinstance(rec, dict) and rec.get("id") in out:
            sh = str(rec.get("short", "")).strip().strip(".")
            if 0 < len(sh.split()) <= 4:
                out[rec["id"]] = sh
    json.dump(out, open(cache, "w", encoding="utf-8"), indent=1)
    return out


# ============================================================================
# The pipeline for one recipe
# ============================================================================

def process(recipe_id, args, out_dir):
    print(f"\n=== {recipe_id} ===")
    recipes_json = find_file("recipes", args.recipes)
    verbs_csv = find_file("verbs", args.verbs)
    nouns_csv = find_file("nouns", args.nouns)
    ts_csv = find_file("timestamps", args.timestamps, recipe_id)
    pkl = find_file("narrations", args.narrations, recipe_id)
    print(f"  narrations : {pkl}")
    print(f"  timestamps : {ts_csv}")

    verb_map, noun_map = load_vocab(verbs_csv, nouns_csv)
    recipe = load_recipe(recipes_json, recipe_id)
    all_videos = [v for c in recipe["captures"] for v in c["videos"]]
    windows = load_windows(ts_csv, all_videos, recipe_id)
    per_video, load_log = load_actions(pkl, all_videos, verb_map, noun_map)

    # --- stage 1 -----------------------------------------------------------
    sessions, scope_log = build_sessions(recipe, per_video, windows, recipe_id)
    sessions = [s for s in sessions if s["actions"]]
    if not sessions:
        raise SystemExit(f"{recipe_id}: no actions survived recipe scoping")
    for s in sessions:
        for a in s["actions"]:
            a["node_key"] = NODE_DEFS[CHOSEN_DEF](a)

    # --- stage 3 -----------------------------------------------------------
    id_table = identity_table(sessions)

    # --- stage 4 -----------------------------------------------------------
    step_ids = list(recipe.get("steps", {}).keys())
    step_texts = [{"id": k, "label": v} for k, v in recipe.get("steps", {}).items()]
    n_seg = len(step_ids) + 1
    all_bounds, align_notes = [], []
    for s in sessions:
        b, notes = milestones(s, step_ids)
        all_bounds.append(b)
        s["bounds"] = b
        if notes:
            align_notes.append({"session": s["idx"] + 1, "notes": notes})
    seg_frac = segment_fractions(all_bounds, args.segment_weights, n_seg)
    for s in sessions:
        pos = make_position_fn(s["bounds"], seg_frac)
        for a in s["actions"]:
            a["x"] = round(pos(a["t"]), 4)

    # --- stage 5 -----------------------------------------------------------
    members = collections.defaultdict(list)
    key_sessions = collections.defaultdict(set)
    for s in sessions:
        for a in s["actions"]:
            members[a["node_key"]].append(a)
            key_sessions[a["node_key"]].add(s["idx"])
    coverage_curve = {}
    total_instances = sum(len(s["actions"]) for s in sessions)
    for thr in range(1, len(sessions) + 1):
        keys = [k for k, ss in key_sessions.items() if len(ss) >= thr]
        coverage_curve[thr] = {
            "types": len(keys),
            "instances": sum(len(members[k]) for k in keys),
            "coverage": round(sum(len(members[k]) for k in keys) /
                              max(1, total_instances), 3)}
    # A recipe captured only once has no cross-session recurrence to filter on.
    # Clamp rather than crash, and say so loudly: the pattern view is not
    # meaningful for a single session and the audit records that.
    eff_min = min(args.min_sessions, len(sessions))
    if eff_min < args.min_sessions:
        print(f"  ! only {len(sessions)} session(s); min_sessions clamped to "
              f"{eff_min}. Cross-session pattern claims do not apply here.")
    recurring = sorted([k for k, ss in key_sessions.items()
                        if len(ss) >= eff_min],
                       key=lambda k: statistics.median(m["x"] for m in members[k]))
    node_index = {k: i for i, k in enumerate(recurring)}

    nodes = []
    for k in recurring:
        ms = members[k]
        xs = sorted(m["x"] for m in ms)
        ds = sorted(round(m["end"] - m["start"], 2) for m in ms)
        segc = collections.Counter(
            sum(1 for q in seg_frac[1:-1] if m["x"] >= q) for m in ms)
        per_sess = collections.Counter()
        for s in sessions:
            per_sess[s["idx"]] += sum(1 for a in s["actions"]
                                      if a["node_key"] == k)
        nodes.append({
            "k": k, "c": ms[0]["verb_cat"],
            "x": round(statistics.median(xs), 4),
            "ct": len(ms), "ns": len(key_sessions[k]),
            "xlo": xs[max(0, round(.1 * (len(xs) - 1)))],
            "xhi": xs[min(len(xs) - 1, round(.9 * (len(xs) - 1)))],
            "dmin": ds[0], "dmed": round(statistics.median(ds), 2), "dmax": ds[-1],
            # which recipe step this action mostly belongs to, and how cleanly.
            # segp < 1 means the action spans steps; the graph groups it by the
            # step it lands in most often, and the audit records the ambiguity.
            "seg": segc.most_common(1)[0][0],
            "segp": round(segc.most_common(1)[0][1] / len(ms), 2),
            "ps": [per_sess[s["idx"]] for s in sessions],
        })

    # --- stage 6 -----------------------------------------------------------
    g = build_graph(sessions, node_index, eff_min, args.transitions)
    for i, n in enumerate(nodes):
        n["res"] = g["res"][i]
        n["endp"] = g["endp"][i]

    # --- stage 7 -----------------------------------------------------------
    labels = label_nodes(recipe_id, recipe.get("name", recipe_id), nodes,
                         members, out_dir, not args.no_llm, args.refresh_labels)
    for n in nodes:
        v, o = labels[n["k"]]["used"]
        n["lv"], n["ln"], n["lab"] = v, o, f"{v} {o}"
    short = label_steps(recipe_id, recipe.get("name", recipe_id), step_texts,
                        out_dir, not args.no_llm, args.refresh_labels)

    # --- stage 8: assemble the render payload ------------------------------
    sess_out = []
    for s in sessions:
        arr = []
        for a in s["actions"]:
            # a[8] is this instance's own concrete label. Node labels cover
            # recurring actions; one-off instances have no node, and showing
            # them as "(leave, one-off)" tells the annotator nothing about
            # what actually happened.
            arr.append([node_index.get(a["node_key"], -1), a["verb_cat"],
                        round(a["start"], 1), round(a["end"] - a["start"], 1),
                        a["x"], a["narration"], a["vid_idx"], a["nid"],
                        f'{a["verb_key"].replace("-", " ")} {a["noun_key"]}'])
        sess_out.append({"id": f"Session {s['idx'] + 1}", "vid": s["videos"][0],
                         "vids": s["videos"], "n": len(arr), "a": arr})

    payload = {
        "name": recipe.get("name", recipe_id),
        "sessions": sess_out,
        "nodes": nodes,
        "edges": g["edges"],
        "loops": g["loops"],
        "starts": g["starts"],
        "ends": g["ends"],
        "steps": [{"id": s["id"], "label": s["label"], "short": short[s["id"]],
                   "pos": seg_frac[i + 1]} for i, s in enumerate(step_texts)],
        "segfrac": seg_frac,
        "stats": {"acts": total_instances, "types": len(members),
                  "core": len(recurring),
                  "cov": coverage_curve[eff_min]["coverage"]},
    }

    audit = {
        "recipe": recipe_id, "name": recipe.get("name", recipe_id),
        "generated": time.strftime("%Y-%m-%d %H:%M"),
        "params": {"min_sessions": eff_min,
                   "node_definition": CHOSEN_DEF,
                   "transitions": args.transitions,
                   "segment_weights": args.segment_weights,
                   "llm": (None if args.no_llm else (MODEL or DEFAULT_MODEL[PROVIDER]))},
        "stage0_load": load_log,
        "stage1_scope": scope_log,
        "stage3_identity_table": id_table,
        "stage4_alignment": {"segments": n_seg, "seg_fractions": seg_frac,
                             "notes": align_notes},
        "stage5_recurrence": {"total_types": len(members),
                              "total_instances": total_instances,
                              "coverage_by_threshold": coverage_curve,
                              "chosen": eff_min,
                              "requested": args.min_sessions,
                              "n_sessions": len(sessions)},
        "stage6_graph": {"nodes": len(nodes),
                         "edges_core": sum(1 for e in g["edges"] if e[4] == 0),
                         "edges_backbone": sum(1 for e in g["edges"] if e[4] == 1),
                         "edges_hidden": len(g["hidden"]),
                         "self_loops": len(g["loops"]),
                         "contracted_oneoff_steps": g["contracted_oneoffs"],
                         "orphans": g["orphans"],
                         "residual_mass_max": max([n["res"] for n in nodes],
                                                  default=0)},
        "stage7_labels": {k: v for k, v in labels.items()},
    }
    return payload, audit, sessions, node_index, members


# ============================================================================
# Reporting
# ============================================================================

def audit_markdown(a):
    L = [f"# Data audit - {a['recipe']} ({a['name']})", "",
         f"Generated {a['generated']} by build_annotation_data.py", "",
         "Parameters: " + ", ".join(f"`{k}={v}`" for k, v in a["params"].items()),
         "", "## 1. Scoping to the recipe", "",
         "| session | videos | actions in video | kept in recipe | dropped |",
         "|---|---|---|---|---|"]
    for s in a["stage1_scope"]:
        L.append(f"| {s['session']} | {', '.join(s['videos'])} | "
                 f"{s['actions_in_videos']} | {s['kept']} | "
                 f"{s['dropped_other_activity']} |")
    L += ["", f"Narrations with more than one main action (only the first is used): "
          f"{a['stage0_load']['multi_action_narrations']}. "
          f"Class ids missing from the vocab: "
          f"{a['stage0_load']['unmapped_class_ids']}.", "",
          "## 2. Node identity", "",
          "Measured distinct type counts on the scoped data:", "",
          "| node definition | types |", "|---|---|"]
    for k, v in a["stage3_identity_table"].items():
        star = "  **<- used**" if k == a["params"]["node_definition"] else ""
        L.append(f"| {k} | {v}{star} |")
    rec = a["stage5_recurrence"]
    L += ["", "## 3. Recurrence threshold", ""]
    if rec.get("n_sessions", 9) < rec.get("requested", 2):
        L.append(f"> **Single-capture recipe** ({rec['n_sessions']} session). "
                 f"The threshold was clamped to {rec['chosen']}, so every action "
                 f"type is 'recurring' by default and nothing here is evidence "
                 f"of a cross-session pattern.\n")
    L += [
          "| appears in >= N sessions | types kept | instances covered | coverage |",
          "|---|---|---|---|"]
    for thr, r in a["stage5_recurrence"]["coverage_by_threshold"].items():
        star = "  **<- used**" if thr == a["stage5_recurrence"]["chosen"] else ""
        L.append(f"| {thr} | {r['types']} | {r['instances']} | "
                 f"{r['coverage']:.0%}{star} |")
    g = a["stage6_graph"]
    L += ["", "## 4. Graph", "",
          f"- nodes drawn: **{g['nodes']}**",
          f"- core edges (>= {a['params']['min_sessions']} sessions): "
          f"**{g['edges_core']}**",
          f"- backbone edges (kept only to prevent a sink): "
          f"**{g['edges_backbone']}**",
          f"- hidden transitions (not drawn, carried as residual mass): "
          f"**{g['edges_hidden']}**",
          f"- self-loops: **{g['self_loops']}**",
          f"- largest residual on any node: **{g['residual_mass_max']:.0%}**",
          f"- one-off actions stepped over to keep the flow connected: "
          f"**{g['contracted_oneoff_steps']}**", ""]
    orph = g["orphans"]
    if orph["no_outgoing"] or orph["no_incoming"]:
        L.append(f"**Connectivity warning** - no outgoing: {orph['no_outgoing']}; "
                 f"no incoming: {orph['no_incoming']}")
    else:
        L.append("Connectivity check passed: every node has a visible successor "
                 "(or terminal mass) and a visible predecessor (or start mass).")
    L += ["", "## 5. Milestone alignment", "",
          f"{a['stage4_alignment']['segments']} display segments. "
          f"Boundaries at {a['stage4_alignment']['seg_fractions']}.", ""]
    if a["stage4_alignment"]["notes"]:
        L += ["| session | step | issue |", "|---|---|---|"]
        for s in a["stage4_alignment"]["notes"]:
            for nt in s["notes"]:
                L.append(f"| {s['session']} | {nt['step']} | {nt['issue']} |")
    else:
        L.append("No alignment anomalies.")
    L += ["", "## 6. Display labels", "",
          "The LLM only renames. It cannot change which nodes exist, how they "
          "merge, or where they sit. `rule` is what the deterministic fallback "
          "produces; run with `--no-llm` to use it.", "",
          "| node key | rule | llm | used (verb / object) |", "|---|---|---|---|"]
    for k, v in a["stage7_labels"].items():
        j = lambda x: " / ".join(x) if x else "-"
        L.append(f"| `{k}` | {j(v['rule'])} | {j(v['llm'])} | **{j(v['used'])}** |")
    return "\n".join(L) + "\n"


def instances_csv(path, recipe_id, payload, sessions, node_index, members):
    import csv
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["instance_id", "recipe", "session", "video_id", "narration_id",
                    "node", "node_label", "verb_category", "start_s", "end_s",
                    "duration_s", "aligned_position", "step_segment", "prev",
                    "next", "gap_after_s", "node_recurs_in_sessions",
                    "is_recurring", "narration"])
        nseg = len(payload["steps"]) + 1
        for si, s in enumerate(payload["sessions"]):
            for i, a in enumerate(s["a"]):
                nd = payload["nodes"][a[0]] if a[0] >= 0 else None
                nxt = s["a"][i + 1] if i + 1 < len(s["a"]) else None
                prv = s["a"][i - 1] if i else None
                gap = round(nxt[2] - (a[2] + a[3]), 2) if nxt else ""
                seg = sum(1 for p in payload["segfrac"][1:-1] if a[4] >= p) + 1
                w.writerow([f"{recipe_id}|{s['id'].replace(' ', '')}|{i}",
                            recipe_id, s["id"], s["vids"][a[6]], a[7],
                            nd["k"] if nd else "", nd["lab"] if nd else "",
                            a[1], a[2], round(a[2] + a[3], 2), a[3], a[4], seg,
                            (payload["nodes"][prv[0]]["lab"] if prv and prv[0] >= 0
                             else ("one-off" if prv else "")),
                            (payload["nodes"][nxt[0]]["lab"] if nxt and nxt[0] >= 0
                             else ("one-off" if nxt else "")),
                            gap, nd["ns"] if nd else 1, int(a[0] >= 0),
                            a[5].replace("\n", " ")])


# ============================================================================

def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--recipe", action="append", required=True,
                   help="recipe id, repeatable (e.g. --recipe P01_R01)")
    p.add_argument("--out", default="./out/annotation_data",)
    p.add_argument("--narrations")
    p.add_argument("--recipes")
    p.add_argument("--verbs")
    p.add_argument("--nouns")
    p.add_argument("--timestamps")
    p.add_argument("--min-sessions", type=int, default=2,
                   help="a node/edge is drawn if seen in at least this many "
                        "sessions (default 2)")
    p.add_argument("--transitions", choices=["contract", "adjacent"],
                   default="contract",
                   help="contract: step over one-off actions so the flow stays "
                        "connected. adjacent: only literally consecutive.")
    p.add_argument("--segment-weights", choices=["uniform", "median"],
                   default="uniform",
                   help="uniform reproduces DESIGN.md; median sizes each step "
                        "band by its median real duration")
    p.add_argument("--no-llm", action="store_true",
                   help="rule-based labels only; fully deterministic run")
    p.add_argument("--refresh-labels", action="store_true")
    p.add_argument("--model")
    p.add_argument("--env-file")
    args = p.parse_args()

    global MODEL
    load_dotenv(args.env_file)
    MODEL = args.model or os.environ.get("ABSTRACTION_MODEL")

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    DATA = {}
    for rid in args.recipe:
        payload, audit, sessions, node_index, members = process(rid, args, out_dir)
        DATA[rid] = payload
        json.dump(audit, open(os.path.join(out_dir, f"{rid}_audit.json"), "w",
                              encoding="utf-8"), indent=1, ensure_ascii=False)
        open(os.path.join(out_dir, f"{rid}_audit.md"), "w",
             encoding="utf-8").write(audit_markdown(audit))
        instances_csv(os.path.join(out_dir, f"{rid}_instances.csv"), rid,
                      payload, sessions, node_index, members)
        g = audit["stage6_graph"]
        print(f"  {payload['stats']['acts']} actions, "
              f"{payload['stats']['types']} types, {g['nodes']} nodes, "
              f"{g['edges_core']}+{g['edges_backbone']} edges, "
              f"coverage {payload['stats']['cov']:.0%}")
        if g["orphans"]["no_outgoing"] or g["orphans"]["no_incoming"]:
            print("  ! connectivity warning, see audit")

    js = os.path.join(out_dir, "data.js")
    with open(js, "w", encoding="utf-8") as f:
        f.write("const DATA=" + json.dumps(DATA, separators=(",", ":"),
                                           ensure_ascii=False) + ";\n")
    print(f"\nwrote {js}")
    print(f"      {out_dir}/<recipe>_audit.md   <- the tables for DESIGN.md")


if __name__ == "__main__":
    main()