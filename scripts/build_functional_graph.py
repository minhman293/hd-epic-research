#!/usr/bin/env python3
"""
build_functional_graph.py
=========================

Replaces the rule-based Level-3 "episode" abstraction with an LLM-derived
CLOSED functional-state alphabet.

Core idea
---------
Old pipeline: node name = verb + noun-category, computed PER ACTION.
              -> open vocabulary (106 verbs x 21 noun cats ~ 2,200 possible
                 names). Two sessions doing the same thing pick different
                 names, so nodes never merge, so every arrow is seen once,
                 so the graph is dense.

New pipeline: the alphabet is FIXED FIRST, once per recipe, by an LLM that
              reads the pooled action vocabulary + the observed activity windows
              (NEVER the recipe steps — feeding those in reproduced the recipe
              card, the circularity this pipeline avoids). Every action in every
              session is then classified INTO that fixed alphabet. Merging is
              guaranteed by construction.

Three stages
------------
  A. propose_alphabet()   1 LLM call per recipe  -> the functional states the
                          model infers from the data. The COUNT is the model's
                          call (bounded only by a readability ceiling), not a
                          fixed range and not the recipe's step count.
  B. map_pair_types()     ~5 LLM calls per recipe -> maps each DISTINCT
                          (verb_key, noun_key) TYPE to a state. Types, not
                          instances: cheap, cached, deterministic, auditable.
  C. build_graph()        pure Python. Collapse consecutive runs, build the
                          Markov chain, compute quality metrics.

Nothing is deleted. Every raw action is stored inside node["members"] with
its video id and timestamps, so drill-down still works.

Usage
-----
  pip install pandas requests

  Then, from the folder holding your data files:

      python build_functional_graph.py --recipe P03_R03

  All the file paths default to the standard HD-EPIC filenames in the current
  directory, so you only need to pass --recipe. Override any of them if your
  layout differs.

  NOTE for PowerShell users: a trailing "\" does NOT continue a line in
  PowerShell (that is bash). Use a backtick "`" or keep it on one line.

  Put your key in a .env file next to this script (or anywhere up the tree):

      GEMINI_API_KEY=AIza...

  Accepted names: GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENAI_API_KEY,
  ANTHROPIC_API_KEY. Quotes and a leading "export " are both fine. Real
  environment variables still win over the file, and --env-file overrides
  where to look.

  python build_functional_graph.py \
      --recipe P01_R01 \
      --narrations ./HD_EPIC_Narrations.pkl \
      --recipes ./complete_recipes.json \
      --verbs ./HD_EPIC_verb_classes.csv \
      --nouns ./HD_EPIC_noun_classes.csv \
      --out ./out

Outputs (in --out):
  <recipe>_alphabet.json   the state alphabet + phases (the abstraction)
  <recipe>_mapping.json    (verb,noun) type -> state   (the audit trail)
  <recipe>_graph.json      nodes + edges + members     (feed to D3)
  <recipe>_metrics.json    the numbers you show the professors
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

PROVIDER = os.environ.get("ABSTRACTION_PROVIDER", "gemini")

# Gemini free tier (Aug 2026): Flash / Flash-Lite only, Pro is paid-only.
# ~15 requests/min. This pipeline makes ~9 calls per recipe, so it fits.
# gemini-2.5-flash is closed to new projects; the API suggests gemini-3.6-flash.
# Flash / Flash-Lite are the free-tier families. Override with --model or by
# setting ABSTRACTION_MODEL in .env.
DEFAULT_MODEL = {
    "gemini": "gemini-3.5-flash-lite",
    "anthropic": "claude-sonnet-5",
}
# ----------------------------------------------------------------------------
# .env loading - no dependency, no shell setup
# ----------------------------------------------------------------------------
KEY_NAMES = {
    "gemini": ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
    "anthropic": ["ANTHROPIC_API_KEY"],
}

_ENV_LINE = re.compile(r"""^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$""")


def load_dotenv(explicit=None):
    """Read a .env file into os.environ. Existing real env vars take priority.

    Searches, in order: --env-file, ./.env, the script's directory, and each
    parent directory up to three levels. Returns the path it used, or None.
    """
    candidates = []
    if explicit:
        candidates.append(os.path.abspath(explicit))
    else:
        here = os.path.abspath(os.getcwd())
        script = os.path.dirname(os.path.abspath(__file__))
        for base in (here, script):
            d = base
            for _ in range(4):
                candidates.append(os.path.join(d, ".env"))
                parent = os.path.dirname(d)
                if parent == d:
                    break
                d = parent

    seen = set()
    for path in candidates:
        if path in seen or not os.path.isfile(path):
            seen.add(path)
            continue
        with open(path, encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                mt = _ENV_LINE.match(line)
                if not mt:
                    continue
                k, v = mt.group(1), mt.group(2)
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                else:
                    v = v.split(" #")[0].strip()
                os.environ.setdefault(k, v)   # setdefault = real env wins
        return path
    return None


def get_api_key(provider):
    for name in KEY_NAMES[provider]:
        val = os.environ.get(name, "").strip()
        if val:
            return val, name
    raise SystemExit(
        f"No API key found for {provider}.\n"
        f"Add one of {', '.join(KEY_NAMES[provider])} to a .env file, e.g.\n\n"
        f"    {KEY_NAMES[provider][0]}=your-key-here\n\n"
        f"Get a free Gemini key at https://aistudio.google.com/apikey")


MODEL = os.environ.get("ABSTRACTION_MODEL", "")
MIN_CALL_INTERVAL = 4.5          # seconds; stays under 15 RPM


# ----------------------------------------------------------------------------
# Quality gates.
#
# These are DERIVED, not guessed. See derive_targets() for the reasoning:
#   - state count is DECOUPLED from the recipe card AND chosen by the LLM. It
#     used to be anchored on the annotator's own step count, which fed the
#     recipe's granularity back into the "discovered" states: the LLM
#     reproduced the step list, and the count matched it almost exactly
#     (Nespresso: 5 steps -> 4 states = the card). The count is now the model's
#     own call from the OBSERVED action stream, bounded only by a floor and a
#     readability ceiling (STATE_FLOOR..STATE_CEILING), overridable per run.
#   - density ceiling comes from the evidence budget: with S sessions you
#     observe ~S*(V+1) transitions, so for every edge to be seen twice you
#     need E <= S*(V+1)/2, i.e. density <= S/2.
# ----------------------------------------------------------------------------
GATES = {
    "min_jaccard": 0.70,             # cross-session agreement on the state set
    "min_repeat_edge_share": 0.60,   # share of edges observed >= 2 times
    "min_coverage": 0.90,            # share of actions mapped to a real state
    "hard_max_states": 15,           # readability ceiling regardless of recipe
    "max_render_density": 3.0,       # above this a layout cannot be untangled
}

# The number of states is NOT fixed here. The LLM decides it from the observed
# action stream (that is the whole point of pattern discovery). Two guards
# remain, and both are about READABILITY for the non-expert target user named
# in the project brief — not about matching the recipe:
#
#   STATE_FLOOR    below this the graph is trivially uninformative.
#   STATE_CEILING  above this a node-link graph is an unreadable tangle for a
#                  general-public reader. This is a SAFETY CAP, not a target:
#                  the model is told to fold connective actions together rather
#                  than aim for it. Raise it with --max-states for a recipe that
#                  genuinely has more distinct recurring goals (e.g. §5 measured
#                  ~22 recurring episodes for drip coffee).
STATE_FLOOR = 3
STATE_CEILING = GATES["hard_max_states"]   # 15 by default; override per run


def derive_targets(n_sessions, min_states=None, max_states=None):
    """Readability guards only — NOT a target band.

    The state COUNT is chosen by the LLM from the observed actions. This returns
    a floor and a safety ceiling so downstream gates have bounds, but the model
    is not steered toward any particular number.
    """
    lo = STATE_FLOOR if min_states is None else max(2, int(min_states))
    hi = STATE_CEILING if max_states is None else int(max_states)
    hi = max(hi, lo + 2)
    # Evidence budget. With 1 session this is 0.5 and NO graph can pass;
    # that is a true statement about the data, not a bug.
    max_density = n_sessions / 2.0
    return {"min_states": lo, "max_states": hi,
            "max_density": round(max_density, 2), "n_sessions": n_sessions,
            "count_is_llm_decided": True}


# ============================================================================
# 0a. Finding the data files
#
# The HD-EPIC repo layout is not flat, and the script may be run from the repo
# root or from scripts/. So every path is searched against several base
# directories rather than assumed to be relative to the current one.
# ============================================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Relative locations tried for each file, in order of preference.
LAYOUTS = {
    "recipes": ["high-level/complete_recipes.json",
                "complete_recipes.json"],
    "verbs": ["narrations-and-action-segments/HD_EPIC_verb_classes.csv",
              "HD_EPIC_verb_classes.csv"],
    "nouns": ["narrations-and-action-segments/HD_EPIC_noun_classes.csv",
              "HD_EPIC_noun_classes.csv"],
    "timestamps": ["high-level/{pid}_recipe_timestamps.csv",
                   "high-level/recipe-timestamps/{pid}_recipe_timestamps.csv",
                   "recipe-timestamps/{pid}_recipe_timestamps.csv",
                   "{pid}_recipe_timestamps.csv",
                   "outputs/{pid}_recipe_timestamps.csv",
                   "annotations/{pid}_recipe_timestamps.csv"],
    "narrations": ["outputs/recipe_narrations_{recipe}.pkl",
                   "recipe_narrations_{recipe}.pkl",
                   "narrations-and-action-segments/HD_EPIC_Narrations.pkl",
                   "HD_EPIC_Narrations.pkl"],
}


def base_dirs():
    """Directories to search, nearest first, de-duplicated."""
    cwd = os.path.abspath(os.getcwd())
    cands = [cwd, os.path.dirname(cwd),
             SCRIPT_DIR, os.path.dirname(SCRIPT_DIR),
             os.path.dirname(os.path.dirname(SCRIPT_DIR))]
    seen, out = set(), []
    for d in cands:
        if d and d not in seen and os.path.isdir(d):
            seen.add(d)
            out.append(d)
    return out


def find_file(kind, explicit=None, recipe="", required=True):
    """Locate one data file. Returns an absolute path or raises with a report.

    explicit : whatever the user passed on the command line, if anything.
               Absolute paths are used as-is; relative ones are still searched
               against every base directory, so "../high-level/x.json" works
               no matter which folder you launched from.
    """
    if explicit:
        if os.path.isabs(explicit):
            if os.path.isfile(explicit):
                return explicit
            patterns = [explicit]
        else:
            patterns = [explicit]
    else:
        patterns = LAYOUTS[kind]

    pid = recipe.split("_")[0] if recipe else ""
    patterns = [p.format(recipe=recipe, pid=pid) for p in patterns]

    tried = []
    for pat in patterns:
        for base in base_dirs():
            path = os.path.normpath(os.path.join(base, pat))
            tried.append(path)
            if os.path.isfile(path):
                return path

    # Last resort: walk the tree looking for the filename anywhere.
    wanted = {os.path.basename(p) for p in patterns}
    for base in base_dirs()[:2]:
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs
                       if not d.startswith(".") and d not in
                       ("node_modules", "__pycache__", "venv", ".git")]
            if root[len(base):].count(os.sep) > 3:
                dirs[:] = []
                continue
            for f in files:
                if f in wanted:
                    return os.path.join(root, f)

    if not required:
        return None
    listing = "\n".join(f"    {t}" for t in dict.fromkeys(tried))
    raise SystemExit(
        f"Could not find the {kind} file.\n"
        f"  Ran from : {os.getcwd()}\n"
        f"  Script at: {SCRIPT_DIR}\n"
        f"  Looked in:\n{listing}\n\n"
        f"Pass it directly, e.g.  --{kind} \"D:/full/path/to/file\"")


# ============================================================================
# 0. Loading
# ============================================================================

def load_vocab(verbs_csv, nouns_csv):
    """id -> (key, category) for verbs and nouns."""
    v = pd.read_csv(verbs_csv)
    n = pd.read_csv(nouns_csv)
    verb = {int(r.id): (str(r.key), str(r.category)) for r in v.itertuples()}
    noun = {int(r.id): (str(r.key), str(r.category)) for r in n.itertuples()}
    return verb, noun


def recipe_videos(recipes_json, recipe_id):
    """Return (recipe_meta, [[video_id, ...] per capture])."""
    with open(recipes_json) as f:
        recipes = json.load(f)
    if recipe_id not in recipes:
        raise SystemExit(f"recipe {recipe_id} not in {recipes_json}")
    r = recipes[recipe_id]
    sessions = [c["videos"] for c in r["captures"]]
    return r, sessions


def load_recipe_windows(ts_csv, video_ids, recipe_id):
    """Time windows in each video where this recipe was actually happening.

    HD-EPIC videos are whole kitchen sessions: the P03_R03 pkl contains
    unloading the dishwasher, making breakfast and packing lunch as well as
    the coffee. Those are real actions but they are not this recipe, and
    mixing them in is what makes the graph complete rather than procedural.
    """
    if ts_csv is None:
        return None
    short = recipe_id.split("_")[-1]          # P03_R03 -> R03
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


def load_window_labels(ts_csv, video_ids, recipe_id):
    """(start, end, activity_label) per video: the annotator's own segmentation.

    These labels are the missing context. "take bag" means grinding inside
    "Pour beans in coffee grinder", and means something else inside "Wash
    coffee cups by hand". Mapping (verb, noun) alone cannot tell them apart,
    which is why a purely type-level mapping oscillates between states.
    """
    if ts_csv is None:
        return {}
    short = recipe_id.split("_")[-1]
    df = pd.read_csv(ts_csv)
    out = {}
    for v in video_ids:
        rows = df[(df["video_id"] == v) & (df["recipe_id"].astype(str) == short)]
        segs = []
        for r in rows.itertuples():
            end = str(r.end_time).strip()
            segs.append((float(r.start_time),
                         float("inf") if end in ("end", "nan", "") else float(end),
                         str(r.high_level_activity_label)))
        out[v] = sorted(segs)
    return out


def label_at(t, segs):
    for a, b, lab in segs:
        if a <= t < b:
            return lab
    return ""


def in_window(t, wins):
    return any(a <= t < b for a, b in wins)


def _first_pair(row):
    """Pick one (verb_class, noun_class) for an annotated action.

    Priority: main_action_classes -> pair_classes -> (verb_classes[0], noun_classes[0]).
    Returns None if the row has no usable class labels.
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
                return int(p[0]), int(p[1])
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
        return int(vc[0]), int(nc[0])
    return None


def load_actions(narrations_pkl, video_ids, verb_map, noun_map,
                 windows=None, wlabels=None):
    """All annotated actions for the given videos, time-sorted per video.

    Works with the full HD_EPIC_Narrations.pkl or a recipe-scoped subset such
    as recipe_narrations_P01_R01.pkl. If the file is already recipe-scoped the
    video filter is a no-op.
    """
    df = pd.read_pickle(narrations_pkl)
    present = set(df["video_id"].unique())
    keep = [v for v in video_ids if v in present]
    if keep:
        df = df[df["video_id"].isin(keep)]
    else:                       # recipe-scoped file whose ids differ: use all
        print("  (no video_id overlap; using every row in the pkl)",
              file=sys.stderr)
        video_ids = sorted(present)
    out = collections.defaultdict(list)
    for row in df.to_dict("records"):
        pair = _first_pair(row)
        if pair is None:
            continue
        vid_cls, noun_cls = pair
        if vid_cls not in verb_map or noun_cls not in noun_map:
            continue
        vkey, vcat = verb_map[vid_cls]
        nkey, ncat = noun_map[noun_cls]
        out[row["video_id"]].append({
            "video_id": row["video_id"],
            "start": float(row["start_timestamp"]),
            "end": float(row["end_timestamp"]),
            "verb_key": vkey, "verb_cat": vcat,
            "noun_key": nkey, "noun_cat": ncat,
            "narration": str(row.get("narration", "")),
            "context": label_at(float(row["start_timestamp"]),
                                (wlabels or {}).get(row["video_id"], [])),
            "in_recipe": (windows is None
                          or in_window(float(row["start_timestamp"]),
                                       windows.get(row["video_id"], []))),
        })
    for v in out:
        out[v].sort(key=lambda a: a["start"])
    return {v: out[v] for v in video_ids if v in out}


# ============================================================================
# 1. LLM plumbing
# ============================================================================

_last_call = [0.0]


def _throttle():
    """Free-tier friendly spacing between calls."""
    wait = MIN_CALL_INTERVAL - (time.time() - _last_call[0])
    if wait > 0:
        time.sleep(wait)
    _last_call[0] = time.time()


def _call_gemini(prompt, system, max_tokens):
    """Gemini Developer API over REST. No SDK, so no package churn."""
    import requests
    key, _ = get_api_key("gemini")
    model = MODEL or DEFAULT_MODEL["gemini"]
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent")
    body = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0,                       # reproducible runs
            "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json",  # native JSON mode
        },
    }
    delay = 8
    for attempt in range(5):
        _throttle()
        r = requests.post(url, headers={"x-goog-api-key": key,
                                        "Content-Type": "application/json"},
                          json=body, timeout=180)
        if r.status_code == 429:                    # free-tier rate limit
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


# def _call_anthropic(prompt, system, max_tokens):
#     import anthropic
#     key, _ = get_api_key("anthropic")
#     client = anthropic.Anthropic(api_key=key)
#     _throttle()
#     msg = client.messages.create(
#         model=MODEL or DEFAULT_MODEL["anthropic"],
#         max_tokens=max_tokens, temperature=0,
#         system=system, messages=[{"role": "user", "content": prompt}])
#     return "".join(b.text for b in msg.content if b.type == "text")


def llm(prompt, system, max_tokens=8000):
    """One call that must return JSON. Retries once on a parse failure."""
    # call = _call_gemini if PROVIDER == "gemini" else _call_anthropic
    call = _call_gemini
    for attempt in range(2):
        text = call(prompt, system, max_tokens).strip()
        text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            if attempt == 1:
                raise SystemExit("LLM did not return valid JSON:\n" + text[:1500])
            prompt += "\n\nYour last reply was not valid JSON. Reply with JSON only."
    raise SystemExit("unreachable")


def unit(a):
    """The thing Stage B labels: an action type IN ITS ANNOTATED CONTEXT."""
    return (a.get("context", ""), a["verb_key"], a["noun_key"])


def as_list(data, key):
    """Pull a list of records out of whatever shape the model returned.

    Models drift between {"assignments": [...]}, a bare [...], and
    {"result": [...]}. All three mean the same thing, so accept all three
    rather than crashing on a formatting preference.
    """
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if isinstance(data.get(key), list):
            return data[key]
        for v in data.values():                 # any single list-valued key
            if isinstance(v, list) and (not v or isinstance(v[0], dict)):
                return v
    raise SystemExit(f"expected a list of records, got: {str(data)[:400]}")


SYSTEM = (
    "You design compact state alphabets for procedural motion graphs built from "
    "egocentric cooking video. You reply with JSON only: no prose, no markdown, "
    "no code fences."
)


# ============================================================================
# 2. Stage A - propose the closed alphabet
# ============================================================================

ALPHABET_PROMPT = """Recipe: {name}

Number of recorded sessions of this recipe: {n_sessions}

You are NOT given the recipe's written steps or step count. Derive the states
from the observed action stream below, not from a recipe card. Group actions
that serve the same goal; do not try to reconstruct an imagined instruction
list.

The annotator cut each video into contiguous activity windows and gave each a
free-text description. These are OBSERVED boundaries in the video (what the
person was doing during each span), so your states should line up with them:
{contexts}

Below is the pooled vocabulary of annotated hand actions across all sessions,
as (verb, object) pairs with how many times each occurs, in how many sessions
it appears, and one example narration. NOTE: the (verb, object) class labels
are automatically assigned and are sometimes wrong - trust the narration text
when they disagree.

{pairs}

TASK
Design a CLOSED alphabet of functional states for this recipe. A functional
state is a goal a person is pursuing, not a hand movement. "open cupboard",
"take cup", "put cup down" are all one state if they serve the same goal.

HARD CONSTRAINTS
1. YOU decide how many states — there is no target count. Work it out from the
   observed actions: how many distinct goals recur across the sessions? Use
   exactly that many. Do NOT lump two different recurring goals into one state
   (that hides real structure), and do NOT split one goal across several states
   (that creates a hairball). Give your reasoning in "n_states_rationale".
   Upper limit: no more than {max_states} states, because above that a
   non-expert cannot read the graph. If you feel you need more, you are almost
   certainly giving fetching / opening / carrying their own states — fold those
   into the goal they serve instead (see 3b), don't exceed the limit.
2. The alphabet is the SAME for every session. Do not create a state that only
   one session could reach.
3. Each state name is an imperative verb + concrete object, 2-4 words, lowercase.
   Examples: "load coffee capsule", "froth milk". No indices, no codes, no
   words like "step 1", "phase A", "other".

3b. BANNED: any generic preparation, setup, gathering, tidying or catch-all
   state - "prepare equipment", "get things ready", "clean up", "put things
   away", "miscellaneous". These are the single biggest cause of an unreadable
   graph. Fetching and setup are interleaved with EVERY other state, so a
   state that collects them is entered and left dozens of times and connects
   to everything, turning the graph into a hairball.

   Every state must name a specific outcome that changes the food or drink,
   or a specific machine being operated. Setup belongs to the state it serves:
   opening the bean bag, finding the scoop and lifting the grinder lid are all
   part of "grind coffee beans", not a separate preparation state. Washing the
   grinder right after grinding is part of grinding; washing up at the very
   end is its own state only if the recipe genuinely ends that way.
4. Each state must be a goal a general-public annotator can recognise on sight
   and rate on its own: a person watching the video would name it this way.
   This is what the states are FOR — an annotator watches an action and decides
   whether a robot should step in. Do NOT shape states around what is easy for
   a robot to execute; shape them around the goal a person is pursuing.
5. A good state is entered once or twice per session, not constantly. This is
   about each state's visit frequency, NOT about minimizing the total count: if
   a candidate state would be visited more than about three times in one
   session, it is connective tissue (fetching, carrying, tidying) — fold it into
   the states around it. States that each fire once or twice are fine even if
   that yields many of them.
6. Your alphabet must cover EVERY activity window listed above. If a window
   describes something none of your states would capture, add a state for it
   or widen a definition. Do not leave a gap.

7. Also group the states into 3-5 ordered phases (a coarser level of the same
   alphabet), e.g. "setup", "brew", "finish".

Reply with exactly this JSON:
{{
  "n_states_rationale": "one or two sentences: how many distinct recurring goals the actions support, and why that many",
  "states": [
    {{"id": "s1",
      "name": "load coffee capsule",
      "definition": "one sentence: what counts as this state",
      "phase": "setup",
      "typical_verbs": ["open", "insert", "close"],
      "typical_objects": ["capsule", "coffee machine"]}}
  ],
  "phases": ["setup", "brew", "finish"]
}}"""


FEEDBACK = """
ATTEMPT {attempt}. Your previous alphabet was measured against the real data
and did not work. Here is what happened.

Previous states, with how many times each was entered PER SESSION:
{visits}

Problems to fix:
{problems}

Diagnosis you should act on:
- A state entered more than 3 times per session is connective tissue, not a
  phase. Fold it into the states around it, or merge it with the state it
  keeps alternating with.
- Actions with no state are absorbed into their neighbours, which is lossy. If
  many actions had no state, widen a definition or add ONE specific state that
  covers them - but only if that state would be entered once or twice per
  session, not constantly.
- These two pull against each other: fixing fragmentation removes a state,
  fixing coverage might add one. Resolve it by FOLDING connective tissue into
  the goal it serves and by WIDENING an existing state's definition before you
  add a new one — NOT by minimising the state count. The number of states is
  yours to decide from the data; there is no preference for fewer.

Examples of actions that had no state:
{gaps}

Design a better alphabet. Same JSON format, same hard constraints.
"""


def propose_alphabet(recipe, recipe_id, sessions_actions, cache_path, targets,
                     feedback=None, attempt=1):
    if os.path.exists(cache_path) and feedback is None:
        return json.load(open(cache_path))

    # pooled (verb, noun) statistics -> this is what the LLM reasons over
    count = collections.Counter()
    sess = collections.defaultdict(set)
    example = {}
    for vid, acts in sessions_actions.items():
        for a in acts:
            if not a.get("in_recipe", True):
                continue                       # breakfast is not this recipe
            k = (a["verb_key"], a["noun_key"])
            count[k] += 1
            sess[k].add(vid)
            example.setdefault(k, a["narration"])

    # The (verb, noun) class labels are sometimes noisy, e.g. ("wash", "milk").
    # One example narration per type lets the model read what really happened.
    lines = [
        f'  ({v}, {n})  n={c}  sessions={len(sess[(v, n)])}  '
        f'e.g. "{example[(v, n)][:110]}"'
        for (v, n), c in count.most_common(150)
    ]
    ctx = collections.Counter(a["context"] for acts in sessions_actions.values()
                              for a in acts
                              if a.get("in_recipe", True) and a.get("context"))
    ctx_txt = "\n".join(f"  [{c}x] {lab}" for lab, c in ctx.most_common(40)) \
        or "  (none available)"
    # NOTE: recipe["steps"] is intentionally NOT sent to the LLM. Feeding the
    # step list or step count is the circularity the pattern-discovery
    # contribution has to avoid; the alphabet must come from the observed
    # actions + observed activity windows only. The step list is used AFTER
    # generation for the leak check below, never before.

    prompt = ALPHABET_PROMPT.format(
            name=recipe.get("name", recipe_id),
            n_sessions=len(sessions_actions),
            contexts=ctx_txt,
            max_states=targets["max_states"],
            pairs="\n".join(lines),
        )
    if feedback:
        prompt += FEEDBACK.format(attempt=attempt, **feedback)
    data = llm(prompt, SYSTEM)

    data["states"] = as_list(data, "states")
    got = len(data["states"])
    if got > targets["max_states"]:
        print(f"  warning: LLM returned {got} states, over the readability "
              f"ceiling of {targets['max_states']} (raise with --max-states if "
              f"this recipe genuinely needs more)", file=sys.stderr)
    elif got < 2:
        print(f"  warning: LLM returned only {got} state(s) — too few to be a "
              f"graph", file=sys.stderr)

    # ── Leak check (§6) ──────────────────────────────────────────────────────
    # The recipe card was never shown to the LLM. If the state count still
    # equals the recipe's step count, that is a signal the alphabet may be
    # tracking the card anyway (e.g. via the activity-window labels), which is
    # worth inspecting. It is a WARNING, not a failure: an honest alphabet can
    # coincidentally match the step count.
    n_steps = len(recipe.get("steps", {}) or {})
    data["_leak_check"] = {
        "recipe_step_count": n_steps,
        "state_count": got,
        "equal": (n_steps > 0 and got == n_steps),
        "note": ("recipe steps were NOT provided to the LLM; this compares the "
                 "independently-derived state count against the card after the "
                 "fact."),
    }
    if n_steps > 0 and got == n_steps:
        print(f"  ⚠ leak check: {got} states == {n_steps} recipe steps. The "
              f"card was not fed in, but verify the states are not just the "
              f"step list (inspect {os.path.basename(cache_path)}).",
              file=sys.stderr)
    else:
        print(f"  ✓ leak check: {got} states vs {n_steps} recipe steps "
              f"(independent).", file=sys.stderr)
    json.dump(data, open(cache_path, "w"), indent=2)
    return data


# ============================================================================
# 3. Stage B - map every distinct (verb, noun) TYPE into the alphabet
# ============================================================================

MAP_PROMPT = """Recipe: {name}

The closed state alphabet for this recipe:
{alphabet}

Below are action types from the video. Each line has an id, the annotator's
description of the activity window it occurred during, the (verb, object)
labels, and an example narration.

Assign EVERY line to exactly one state id from the alphabet above.

THE CONTEXT DECIDES THE STATE, NOT THE VERB. "take bag" during "Pour beans in
coffee grinder" is grinding; "take cloth" during "Wash coffee cups by hand" is
cleaning. Fetching, opening, carrying and putting down all belong to the state
whose goal they serve. Do NOT map every "take" to a setup state and every
"put" to a different state - that produces a state that flips back and forth
every second, which is wrong.

The (verb, object) labels are auto-assigned and sometimes wrong; when they
disagree with the narration or the context, trust the context.

Rules:
- Use only the ids listed. Never invent a state.
- Fetching, opening, carrying and putting down belong to the state whose GOAL
  they serve. "take mug" during coffee making is part of the state that uses
  the mug, not a state of its own.
- If a pair genuinely serves no state in the alphabet, use "unmapped". Use this
  sparingly; it should be under 10% of pairs.
- Give a confidence: high, medium, or low.

Action types:
{pairs}

OUTPUT FORMAT - follow exactly. A JSON object with one key "assignments",
whose value is an array with ONE entry per line above, referenced by its id.
Do not return a bare array.

{{"assignments": [
  {{"id": 0, "state": "s3", "confidence": "high"}},
  {{"id": 1, "state": "s1", "confidence": "medium"}}
]}}"""


def map_pair_types(recipe, alphabet, sessions_actions, cache_path, batch=60):
    if os.path.exists(cache_path):
        return {tuple(k.split("\t")): v for k, v in json.load(open(cache_path)).items()}

    example = {}
    for acts in sessions_actions.values():
        for a in acts:
            if a.get("in_recipe", True):
                example.setdefault(unit(a), a["narration"])
    pairs = sorted(example)
    alpha_txt = "\n".join(
        f"  {s['id']}: {s['name']} - {s['definition']}" for s in alphabet["states"]
    )

    valid = {st["id"] for st in alphabet["states"]}
    mapping = {}

    def save():
        json.dump({"\t".join(k): m for k, m in mapping.items()},
                  open(cache_path + ".partial", "w"), indent=2)

    for i in range(0, len(pairs), batch):
        chunk = pairs[i:i + batch]
        try:
            data = llm(
                MAP_PROMPT.format(
                    name=recipe.get("name", ""),
                    alphabet=alpha_txt,
                    pairs="\n".join(
                        f'  id={k}  during "{c}"  action=({v}, {n})  '
                        f'e.g. "{example[(c, v, n)][:100]}"'
                        for k, (c, v, n) in enumerate(chunk)),
                ),
                SYSTEM,
                max_tokens=8000,
            )
            records = as_list(data, "assignments")
        except SystemExit as e:
            # Keep what we have; the retry will only redo the missing chunk.
            save()
            raise SystemExit(f"{e}\n\nPartial mapping saved to "
                             f"{cache_path}.partial ({len(mapping)} types done). "
                             f"Try a smaller --batch, e.g. --batch 25")

        bad = 0
        for a in records:
            if not isinstance(a, dict):
                bad += 1
                continue
            try:
                key_t = chunk[int(a["id"])]      # index back into the chunk
            except (KeyError, ValueError, TypeError, IndexError):
                bad += 1
                continue
            state = a.get("state")
            if state not in valid and state != "unmapped":
                state = "unmapped"               # model invented a state id
                bad += 1
            mapping[key_t] = {"state": state, "context": key_t[0],
                              "verb": key_t[1], "noun": key_t[2],
                              "confidence": a.get("confidence", "medium")}
        save()
        done = sum(1 for p in pairs[:i + batch] if p in mapping)
        note = f"  ({bad} rejected)" if bad else ""
        print(f"  mapped {done}/{min(i + batch, len(pairs))} types{note}",
              file=sys.stderr)

    unresolved = [p for p in pairs if p not in mapping]
    if unresolved:
        print(f"  {len(unresolved)} types unresolved -> marked unmapped",
              file=sys.stderr)
    for p in unresolved:                  # nothing may be silently dropped
        mapping[p] = {"state": "unmapped", "confidence": "low"}

    if os.path.exists(cache_path + ".partial"):
        os.remove(cache_path + ".partial")
    json.dump({"\t".join(k): m for k, m in mapping.items()},
              open(cache_path, "w"), indent=2)
    return mapping


# ============================================================================
# 4. Stage C - collapse runs and build the Markov chain
# ============================================================================

def collapse(actions, mapping, id2name, granularity="action",
             unmapped="absorb", min_run=3):
    """Consecutive actions with the same state become ONE segment.

    Actions outside the recipe windows are NOT dropped and NOT given a node.
    They are attached to the segment that follows them as an "interruption",
    so they stay inspectable on the edge while contributing no state and no
    spurious transition. This is why "prepare equipment -> [make toast] ->
    prepare equipment" stays a single node instead of becoming two nodes and
    two edges.
    """
    if unmapped == "absorb":
        # "unmapped" must never become a node. It is entered from everywhere
        # and left to everywhere, so it acts as a hub and inflates both the
        # segment count and the edge count. These are still recipe actions, so
        # they are folded into the state next to them (the goal they serve)
        # rather than dropped. They keep their own flag inside members.
        acts = [a for a in actions if a.get("in_recipe", True)]
        st = [mapping.get(unit(a), {}).get("state", "unmapped") for a in acts]
        for i, x in enumerate(st):
            if x != "unmapped":
                continue
            nxt = next((st[j] for j in range(i + 1, len(st))
                        if st[j] != "unmapped"), None)
            prv = next((st[j] for j in range(i - 1, -1, -1)
                        if st[j] != "unmapped"), None)
            st[i] = nxt or prv or "unmapped"
        mapping = dict(mapping)
        for a, new in zip(acts, st):
            old = mapping.get(unit(a), {})
            if old.get("state") == "unmapped" and new != "unmapped":
                mapping[unit(a)] = {**old, "state": new, "absorbed": True}

    if granularity == "window":
        # Force one state per annotated activity window by majority vote, so a
        # state cannot flip in the middle of a window the annotator judged to
        # be one activity. Coarser, but contiguity is guaranteed.
        votes = collections.defaultdict(collections.Counter)
        for a in actions:
            if a.get("in_recipe", True):
                votes[(a["video_id"], a.get("context", ""))][
                    mapping.get(unit(a), {}).get("state", "unmapped")] += 1
        winner = {k: c.most_common(1)[0][0] for k, c in votes.items()}
        mapping = dict(mapping)
        for a in actions:
            if a.get("in_recipe", True):
                mapping[unit(a)] = {
                    "state": winner[(a["video_id"], a.get("context", ""))],
                    "confidence": "window-vote"}

    segs = []
    pending = []                                   # out-of-recipe run
    for a in actions:
        if not a.get("in_recipe", True):
            pending.append(a)
            continue
        sid = mapping.get(unit(a), {}).get("state", "unmapped")
        name = id2name.get(sid, "unmapped")
        if segs and segs[-1]["state"] == name:
            segs[-1]["end"] = a["end"]
            segs[-1]["members"].append(a)
            segs[-1]["interruptions"].extend(pending)   # resumed the same state
        else:
            segs.append({"state": name, "state_id": sid, "video_id": a["video_id"],
                         "start": a["start"], "end": a["end"], "members": [a],
                         "entry_interruption": pending, "interruptions": []})
        pending = []
    if segs and pending:
        segs[-1]["trailing_interruption"] = pending

    # Minimum resolution. A "state" that lasts one or two actions out of a few
    # hundred is below the resolution of the abstraction: it is the label
    # flickering because consecutive actions touch different objects, not the
    # person switching goals. Such visits are merged into the longer
    # neighbouring visit. Their actions are kept, so nothing is lost.
    while min_run > 1 and len(segs) > 1:
        short = [i for i, sg in enumerate(segs) if len(sg["members"]) < min_run]
        if not short:
            break
        i = min(short, key=lambda j: len(segs[j]["members"]))
        nb = [j for j in (i - 1, i + 1) if 0 <= j < len(segs)]
        t = max(nb, key=lambda j: len(segs[j]["members"]))
        tgt, src = segs[t], segs[i]
        tgt["members"].extend(src["members"])
        tgt["members"].sort(key=lambda a: a["start"])
        tgt["interruptions"].extend(src.get("entry_interruption", []))
        tgt["interruptions"].extend(src.get("interruptions", []))
        tgt["start"] = min(tgt["start"], src["start"])
        tgt["end"] = max(tgt["end"], src["end"])
        segs.pop(i)
        j = 0                                   # re-merge neighbours that now match
        while j < len(segs) - 1:
            if segs[j]["state"] == segs[j + 1]["state"]:
                a, b = segs[j], segs.pop(j + 1)
                a["members"].extend(b["members"])
                a["interruptions"].extend(b.get("entry_interruption", []))
                a["interruptions"].extend(b.get("interruptions", []))
                a["end"] = max(a["end"], b["end"])
            else:
                j += 1
    return segs


MERGE_NAME_PROMPT = """Two states in a cooking state machine turn out to be one
activity: the data shows the person alternating between them {n} times, in
bursts of a few seconds. They must be merged into a single state.

  A: {a} - {da}
  B: {b} - {db}

Give the merged state one name, 2-4 words, imperative verb + concrete object,
lowercase, and one sentence of definition covering both.

CRITICAL - the merged name must still be ONE recognisable goal a person
pursues, nameable WITHOUT "and". "grind and load coffee" is acceptable: it is
one continuous transfer with a single goal. "prepare hot water and coffee" is
NOT acceptable: it is two different goals glued together with "and".

If the two states have genuinely different goals and no single goal-name covers
them, REFUSE the merge by replying {{"refuse": true, "why": "..."}}.
Refusing is the right answer whenever the merged name would need "and" to join
two unrelated outcomes.

Reply with either
  {{"name": "...", "definition": "..."}}
or
  {{"refuse": true, "why": "..."}}"""


def find_oscillating_pair(graph, sessions_segs, min_flips=8, max_burst_secs=15.0):
    """The pair of states that is really ONE activity split in two.

    Two states alternating is not enough evidence on its own, because there are
    two different reasons it happens and they need opposite treatment:

      - ONE ACTIVITY, split by object. Transferring ground coffee means
        reaching between the grinder and the filter, so the label flips every
        few seconds. Measured here: 27 flips, median 4.2s per pair. MERGE.

      - TWO ACTIVITIES, running in parallel. The kettle boils while you grind
        beans, so you switch back and forth over minutes. Measured here: 3
        flips, median 54.0s per pair. DO NOT MERGE - these are separate goals
        the annotator will watch and rate separately.

    The timescale separates them cleanly, so we require both a high flip count
    and a short median burst.
    """
    pairs = collections.defaultdict(list)
    for segs in sessions_segs.values():
        for i in range(len(segs) - 1):
            x, y = segs[i], segs[i + 1]
            if x["state"] == y["state"]:
                continue
            key = tuple(sorted((x["state"], y["state"])))
            pairs[key].append((x["end"] - x["start"]) + (y["end"] - y["start"]))

    best = None
    for (a, b), durs in pairs.items():
        if a in ("START", "END") or b in ("START", "END"):
            continue
        if len(durs) < min_flips:
            continue
        med = statistics.median(durs)
        if med > max_burst_secs:
            continue                       # parallel activities, not one
        if best is None or len(durs) > best[2]:
            best = (a, b, len(durs), round(med, 1))
    return best


def merge_states(alphabet, mapping, a_name, b_name, n_flips):
    """Fold state B into state A, keeping a record of where it came from."""
    by_name = {st["name"]: st for st in alphabet["states"]}
    A, B = by_name[a_name], by_name[b_name]
    try:
        got = llm(MERGE_NAME_PROMPT.format(n=n_flips, a=A["name"],
                                           da=A["definition"], b=B["name"],
                                           db=B["definition"]), SYSTEM, 500)
    except SystemExit:
        return None
    if got.get("refuse") or not got.get("name"):
        print(f"    merge refused: {got.get('why', 'no single goal covers both')}",
              file=sys.stderr)
        return None
    name, defin = got["name"], got["definition"]
    A["name"], A["definition"] = name, defin
    A["merged_from"] = [a_name, b_name]
    alphabet["states"] = [st for st in alphabet["states"] if st["id"] != B["id"]]
    for k, v in mapping.items():
        if v.get("state") == B["id"]:
            mapping[k] = {**v, "state": A["id"], "remapped_from": B["id"]}
    return name


def build_graph(sessions_segs, alphabet, level="functional"):
    """level: 'functional' (the alphabet) or 'phase' (the coarser grouping)."""
    phase_of = {s["name"]: s.get("phase", "other") for s in alphabet["states"]}
    key = (lambda name: phase_of.get(name, "other")) if level == "phase" else (lambda n: n)

    nodes = collections.OrderedDict()
    edge_n = collections.Counter()
    edge_sessions = collections.defaultdict(set)
    ranks = collections.defaultdict(list)

    edge_interrupt = collections.Counter()
    edge_interrupt_secs = collections.Counter()

    for vid, segs in sessions_segs.items():
        seq = []
        for s in segs:
            k = key(s["state"])
            intr = list(s.get("entry_interruption", [])) + list(s.get("interruptions", []))
            if seq and seq[-1][0] == k:            # re-collapse after phase merge
                seq[-1][1].extend(s["members"])
                seq[-1][2].extend(intr)
                continue
            seq.append([k, list(s["members"]), intr])

        n = max(len(seq), 1)
        for i, (k, members, _intr) in enumerate(seq):
            nd = nodes.setdefault(k, {"id": k, "count": 0, "sessions": set(),
                                      "duration": 0.0, "members": []})
            nd["count"] += 1
            nd["sessions"].add(vid)
            nd["duration"] += sum(m["end"] - m["start"] for m in members)
            nd["members"].extend(members)
            ranks[k].append(i / n)

        chain = ["START"] + [k for k, _, _ in seq] + ["END"]
        intrs = [[]] + [it for _, _, it in seq] + [[]]
        for j, (a, b) in enumerate(zip(chain, chain[1:])):
            edge_n[(a, b)] += 1
            edge_sessions[(a, b)].add(vid)
            # interruptions recorded on the segment being entered
            for x in intrs[j + 1]:
                edge_interrupt[(a, b)] += 1
                edge_interrupt_secs[(a, b)] += x["end"] - x["start"]

    for k in ("START", "END"):
        nodes[k] = {"id": k, "count": len(sessions_segs), "sessions": set(sessions_segs),
                    "duration": 0.0, "members": []}
    ranks["START"] = [0.0]
    ranks["END"] = [1.0]

    out_total = collections.Counter()
    for (a, _b), c in edge_n.items():
        out_total[a] += c

    edges = [{
        "source": a, "target": b, "n": c,
        "p": round(c / out_total[a], 3),
        "sessions": sorted(edge_sessions[(a, b)]),
        "support": len(edge_sessions[(a, b)]),
        # other-task actions that happened during this transition
        "interruption_actions": edge_interrupt[(a, b)],
        "interruption_seconds": round(edge_interrupt_secs[(a, b)], 1),
    } for (a, b), c in sorted(edge_n.items())]

    node_list = []
    for k, nd in nodes.items():
        r = sorted(ranks[k])
        node_list.append({
            "id": k,
            "label": k,
            "phase": phase_of.get(k, k if level == "phase" else "other"),
            "count": nd["count"],
            "support": len(nd["sessions"]),
            "sessions": sorted(nd["sessions"]),
            "mean_duration": round(nd["duration"] / max(nd["count"], 1), 2),
            "median_rank": round(r[len(r) // 2], 3) if r else 0.5,
            "members": [{"video_id": m["video_id"], "start": m["start"], "end": m["end"],
                         "verb": m["verb_key"], "noun": m["noun_key"],
                         "narration": m["narration"]} for m in nd["members"]],
        })
    order = {"START": -1, "END": 2}
    node_list.sort(key=lambda x: (order.get(x["id"], 0), x["median_rank"]))
    return {"level": level, "nodes": node_list, "edges": edges}

# ============================================================================
# 4b. Stage D - L2.5 OPERATIONS, discovered by the LLM
#     Paste into build_functional_graph.py after build_graph() ends and
#     before the "# 5. Metrics" header.
#
# WHY THIS STAGE EXISTS
# ---------------------
# Stage C gives each functional state a FLAT bag of raw actions in
# node["members"] - "grind coffee beans" holds 134 of them. Flat is unusable:
# the reader gets either the goal ("grind coffee beans") or 134 hand
# movements, with nothing in between.
#
# This stage cuts each state into OPERATIONS - a finer, recognisable sub-step
# for drill-down, e.g. "load beans" = take(bag) -> scoop(coffee) -> pour(grinder). Nothing is
# deleted: every raw action lands inside exactly one operation, so the
# drill-down chain is  state -> operation -> raw action -> video.
#
# SAME SHAPE AS STAGES A AND B, one level down
# --------------------------------------------
#   D1  propose_operations()   1 LLM call  -> a CLOSED operation alphabet,
#                              3-8 operations per functional state.
#   D2  map_action_operations() ~n LLM calls -> maps each distinct
#                              (state, verb, noun) TYPE to an operation.
#                              Types, not instances: cheap, cached, auditable.
#   D3  add_operations()       pure Python. Collapse consecutive runs into
#                              operation segments, merge repeats, build the
#                              inner Markov chain.
#
# Because the alphabet is fixed before anything is classified, two runs of the
# same operation MUST merge into one node - the same guarantee Stage A buys at
# the state level. That is what turns 33 one-off segments into "pour water,
# seen 19 times across 3 sessions".
# ============================================================================

OP_SYSTEM = (
    "You break cooking activities into smaller, recognisable sub-steps "
    "(operations) that a person watching the video would name. You reply with "
    "JSON only: no prose, no markdown, no code fences."
)

OP_ALPHABET_PROMPT = """Recipe: {name}

A pipeline has already grouped this recipe's annotated hand actions into
functional states (the high-level goals). Your job is the level BELOW that:
inside each state, name the OPERATIONS it breaks into — the smaller,
recognisable sub-steps a person would name while watching the video.

An operation is a short, self-contained piece of physical work with its own
purpose - "load beans", "position the grinder", "remove the grounds". It is
bigger than one hand movement and smaller than the whole state.

Rules:
  - 3 to 8 operations per state. Fewer if the state is genuinely simple.
  - Name them the way a person would say them: 2-4 plain words, a verb first
    ("load beans", "rinse filter"). No indices, no underscores.
  - They must be DISJOINT and together cover everything in the state.
  - Order them the way they are usually performed.
  - Base them on the actions actually listed below, not on how you imagine
    the recipe is done.

Here is each state with the (verb, object) action types recorded inside it,
with occurrence counts and one example narration. NOTE: the (verb, object)
labels are auto-assigned and sometimes wrong - trust the narration text when
they disagree.

{states}

Reply with JSON only:
{{"states": [
   {{"state": "<exact state name as given above>",
     "operations": [
       {{"id": "o1",
         "name": "load beans",
         "definition": "<one line: what physical work this covers>"}}
     ]}}
]}}"""

OP_MAP_PROMPT = """Recipe: {name}

Inside the functional state "{state}", these are the operations available:

{operations}

Assign every action type below to exactly one operation id. If an action
genuinely belongs to none of them, use "unmapped" - do not invent an id.

{pairs}

Reply with JSON only:
{{"assignments": [
   {{"id": <the integer id shown>, "operation": "o1",
     "confidence": "high|medium|low"}}
]}}"""


# ---------------------------------------------------------------------------
# D1 - propose the closed operation alphabet
# ---------------------------------------------------------------------------

def propose_operations(recipe, graph, cache_path):
    """One LLM call -> {state name: [{id, name, definition}, ...]}."""
    if os.path.exists(cache_path):
        return json.load(open(cache_path))

    blocks = []
    for node in graph["nodes"]:
        if node["id"] in ("START", "END"):
            continue
        count = collections.Counter()
        example = {}
        for m in node.get("members", []):
            k = (m["verb"], m["noun"])
            count[k] += 1
            example.setdefault(k, m.get("narration", ""))
        lines = [f'    ({v}, {n})  n={c}  e.g. "{example[(v, n)][:90]}"'
                 for (v, n), c in count.most_common(60)]
        blocks.append(f'  STATE "{node["id"]}"  ({len(node.get("members", []))} '
                      f'actions)\n' + "\n".join(lines))

    data = llm(OP_ALPHABET_PROMPT.format(name=recipe.get("name", ""),
                                         states="\n\n".join(blocks)),
               OP_SYSTEM)

    out = {}
    for rec in as_list(data, "states"):
        if not isinstance(rec, dict):
            continue
        ops = [o for o in as_list(rec, "operations") if isinstance(o, dict)]
        if rec.get("state") and ops:
            out[rec["state"]] = ops

    # Any state the model skipped keeps one catch-all operation, so no state
    # is left without a decomposition and nothing is silently dropped.
    for node in graph["nodes"]:
        if node["id"] in ("START", "END") or node["id"] in out:
            continue
        out[node["id"]] = [{"id": "o1", "name": node["id"],
                            "definition": "not decomposed by the model"}]
        print(f"  warning: no operations returned for '{node['id']}'",
              file=sys.stderr)

    json.dump(out, open(cache_path, "w"), indent=2)
    return out


# ---------------------------------------------------------------------------
# D2 - map every distinct (state, verb, noun) TYPE to an operation
# ---------------------------------------------------------------------------

def map_action_operations(recipe, graph, op_alphabet, cache_path, batch=60):
    """{(state, verb, noun): {"operation": id, "confidence": ...}}"""
    if os.path.exists(cache_path):
        return {tuple(k.split("\t")): v
                for k, v in json.load(open(cache_path)).items()}

    mapping = {}
    for node in graph["nodes"]:
        if node["id"] in ("START", "END"):
            continue
        state = node["id"]
        ops = op_alphabet.get(state, [])
        valid = {o["id"] for o in ops}

        example = {}
        for m in node.get("members", []):
            example.setdefault((m["verb"], m["noun"]), m.get("narration", ""))
        pairs = sorted(example)
        if not pairs:
            continue

        # A single-operation state needs no call: everything goes there.
        if len(ops) <= 1:
            only = ops[0]["id"] if ops else "unmapped"
            for v, n in pairs:
                mapping[(state, v, n)] = {"operation": only,
                                          "confidence": "high"}
            continue

        op_txt = "\n".join(f'  {o["id"]}: {o["name"]} - '
                           f'{o.get("definition", "")}' for o in ops)

        for i in range(0, len(pairs), batch):
            chunk = pairs[i:i + batch]
            data = llm(OP_MAP_PROMPT.format(
                name=recipe.get("name", ""), state=state, operations=op_txt,
                pairs="\n".join(
                    f'  id={k}  action=({v}, {n})  '
                    f'e.g. "{example[(v, n)][:90]}"'
                    for k, (v, n) in enumerate(chunk))),
                OP_SYSTEM, max_tokens=8000)

            bad = 0
            for a in as_list(data, "assignments"):
                if not isinstance(a, dict):
                    bad += 1
                    continue
                try:
                    v, n = chunk[int(a["id"])]
                except (KeyError, ValueError, TypeError, IndexError):
                    bad += 1
                    continue
                op = a.get("operation")
                if op not in valid:
                    op = "unmapped"
                    bad += 1
                mapping[(state, v, n)] = {
                    "operation": op,
                    "confidence": a.get("confidence", "medium")}

            note = f"  ({bad} rejected)" if bad else ""
            print(f"  '{state}': mapped {min(i + batch, len(pairs))}"
                  f"/{len(pairs)} types{note}", file=sys.stderr)

        # Nothing may be silently dropped.
        for v, n in pairs:
            mapping.setdefault((state, v, n), {"operation": "unmapped",
                                               "confidence": "low"})

    json.dump({"\t".join(k): v for k, v in mapping.items()},
              open(cache_path, "w"), indent=2)
    return mapping


# ---------------------------------------------------------------------------
# D3 - collapse into operation segments and build the inner chain (no LLM)
# ---------------------------------------------------------------------------

def add_operations(graph, op_alphabet, op_mapping):
    """Add node['operations'] and node['operation_edges'] in place."""
    for node in graph["nodes"]:
        if node["id"] in ("START", "END"):
            node["operations"] = []
            node["operation_edges"] = []
            continue

        state = node["id"]
        ops_def = {o["id"]: o for o in op_alphabet.get(state, [])}
        members = sorted(node.get("members", []),
                         key=lambda m: (m["video_id"], m["start"]))

        # label every raw action with its operation
        labelled = []
        for m in members:
            rec = op_mapping.get((state, m["verb"], m["noun"]))
            oid = rec["operation"] if rec else "unmapped"
            if oid == "unmapped":
                # Kept visible under its own name rather than hidden.
                name = f'{m["verb"]}({m["noun"]})'
                conf = "low"
            else:
                name = ops_def.get(oid, {}).get("name", oid)
                conf = rec.get("confidence", "medium")
            labelled.append((name, oid, conf, m))

        # collapse consecutive runs of the same operation, never across videos
        runs = []
        for name, oid, conf, m in labelled:
            if runs and runs[-1]["name"] == name and \
                    runs[-1]["members"][-1]["video_id"] == m["video_id"]:
                runs[-1]["members"].append(m)
            else:
                runs.append({"name": name, "op_id": oid, "conf": conf,
                             "members": [m]})

        # runs with the same name merge into ONE operation node
        by_name = collections.OrderedDict()
        for r in runs:
            op = by_name.setdefault(r["name"], {
                "id": r["name"], "op_id": r["op_id"], "count": 0,
                "sessions": set(), "duration": 0.0, "members": [],
                "confidences": [], "verbs": collections.Counter()})
            op["count"] += 1
            op["sessions"].add(r["members"][0]["video_id"])
            op["duration"] += sum(x["end"] - x["start"] for x in r["members"])
            op["members"].extend(r["members"])
            op["confidences"].append(r["conf"])
            for x in r["members"]:
                op["verbs"][x["verb"]] += 1

        # transitions between consecutive operations, within one session
        edge_n = collections.Counter()
        edge_sessions = collections.defaultdict(set)
        for a, b in zip(runs, runs[1:]):
            if a["members"][0]["video_id"] != b["members"][0]["video_id"]:
                continue
            edge_n[(a["name"], b["name"])] += 1
            edge_sessions[(a["name"], b["name"])].add(b["members"][0]["video_id"])

        out_total = collections.Counter()
        for (a, _b), c in edge_n.items():
            out_total[a] += c

        node["operations"] = [{
            "id": op["id"],
            "label": op["id"],
            "state": state,
            "phase": node.get("phase", "other"),
            "count": op["count"],
            "support": len(op["sessions"]),
            "sessions": sorted(op["sessions"]),
            "mean_duration": round(op["duration"] / max(op["count"], 1), 2),
            "n_raw_actions": len(op["members"]),
            # dominant verb key -> the dashboard colours the node with it
            "verb": op["verbs"].most_common(1)[0][0] if op["verbs"] else None,
            "provenance": {
                "source": "llm_operation_alphabet",
                "operation_id": op["op_id"],
                "definition": ops_def.get(op["op_id"], {}).get("definition"),
                "confidence": collections.Counter(op["confidences"])
                              .most_common(1)[0][0],
            },
            "members": op["members"],
        } for op in by_name.values()]

        node["operation_edges"] = [{
            "source": a, "target": b, "n": c,
            "p": round(c / out_total[a], 3),
            "support": len(edge_sessions[(a, b)]),
            "sessions": sorted(edge_sessions[(a, b)]),
        } for (a, b), c in sorted(edge_n.items())]

    return graph

# ============================================================================
# 5. Metrics - the numbers to put on a slide
# ============================================================================

def metrics(graph, sessions_segs, sessions_actions, mapping, targets):
    real = [n for n in graph["nodes"] if n["id"] not in ("START", "END")]
    real_ids = {n["id"] for n in real}
    edges = [e for e in graph["edges"]
             if e["source"] in real_ids and e["target"] in real_ids]

    sets = [{s["state"] for s in segs} for segs in sessions_segs.values()]
    if len(sets) >= 2:
        inter = set.intersection(*sets)
        union = set.union(*sets)
        jac = len(inter) / len(union) if union else 0.0
        # Strict intersection is brittle: it asks every session to contain
        # every state, so ONE outlier session drives it to zero and recipes
        # with MORE recordings score worse mechanically. Two fairer readings:
        pairs = [len(a & b) / len(a | b) for i, a in enumerate(sets)
                 for b in sets[i + 1:] if (a | b)]
        jac_pair = sum(pairs) / len(pairs) if pairs else None
        seen = collections.Counter(st for ss in sets for st in ss)
        state_support = (sum(seen[st] / len(sets) for st in seen) / len(seen)
                         if seen else None)
    else:
        jac = jac_pair = state_support = None

    all_actions = sum(len(a) for a in sessions_actions.values())
    in_recipe = [a for acts in sessions_actions.values() for a in acts
                 if a.get("in_recipe", True)]
    total = len(in_recipe)
    unmapped = sum(
        1 for a in in_recipe
        if mapping.get(unit(a), {}).get("state") == "unmapped"
        or mapping.get(unit(a), {}).get("absorbed"))
    low_conf = sum(1 for m in mapping.values() if m["confidence"] == "low")

    m = {
        "n_actions_in_pkl": all_actions,
        "n_actions_in_recipe": total,
        "n_actions_other_task": all_actions - total,
        "n_interruptions": sum(e["interruption_actions"] for e in graph["edges"]),
        "n_segments": sum(len(s) for s in sessions_segs.values()),
        "n_states": len(real),
        "n_edges": len(edges),
        "density_edges_per_node": round(len(edges) / max(len(real), 1), 2),
        "mean_out_degree": round(len(edges) / max(len(real), 1), 2),
        "repeat_edge_share": round(
            sum(1 for e in edges if e["n"] >= 2) / max(len(edges), 1), 3),
        "cross_session_jaccard": None if jac is None else round(jac, 3),
        "mean_pairwise_jaccard": None if jac_pair is None else round(jac_pair, 3),
        "mean_state_support": None if state_support is None else round(state_support, 3),
        "coverage": round(1 - unmapped / max(total, 1), 3),
        "low_confidence_types": low_conf,
        "n_pair_types": len(mapping),
    }
    # NOTE: computed before the gates so fragmentation can be gated on.
    frag = sorted(((n["count"] / max(n["support"], 1), n["id"]) for n in real),
                  reverse=True)
    m["visits_per_session"] = {i: round(v, 1) for v, i in frag}
    m["fragmented_states"] = [i for v, i in frag if v > 3.0]
    m["targets"] = targets

    md = targets["max_density"]
    m["gates"] = {
        f"states<={targets['max_states']}": m["n_states"] <= targets["max_states"],
        f"density<={md}": m["density_edges_per_node"] <= md,
        "jaccard>=0.70": jac is None or jac >= GATES["min_jaccard"],
        "repeat_edges>=0.60": m["repeat_edge_share"] >= GATES["min_repeat_edge_share"],
        "coverage>=0.90": m["coverage"] >= GATES["min_coverage"],
    }
    m["gates"]["no_fragmented_states"] = not m["fragmented_states"]
    m["passed"] = all(m["gates"].values())

    # Two different questions, and they were being conflated.
    #
    # BLOCKING gates are defects in the ABSTRACTION. A graph that fails one of
    # these would mislead a reader no matter how it is laid out: boxes that are
    # connective tissue, boxes that hide a tenth of the actions, or too many
    # boxes to read. These must be fixed before rendering.
    #
    # ADVISORY metrics measure whether the DATA has enough evidence: do the
    # sessions agree, do arrows repeat. You cannot fix these by changing the
    # abstraction - only by recording more sessions. They are reported next to
    # the graph, not used to block it.
    blocking = {
        "no_fragmented_states": m["gates"]["no_fragmented_states"],
        "coverage>=0.90": m["coverage"] >= GATES["min_coverage"],
        f"states<={targets['max_states']}": m["n_states"] <= targets["max_states"],
        "density<=3.0": m["density_edges_per_node"] <= GATES["max_render_density"],
    }
    m["blocking_gates"] = blocking
    m["render_ready"] = all(blocking.values())
    m["advisory"] = {
        "cross_session_jaccard": m["cross_session_jaccard"],
        "repeat_edge_share": m["repeat_edge_share"],
        "n_sessions": targets["n_sessions"],
        "density_target": targets["max_density"],
    }
    if m["fragmented_states"]:
        m["fragmentation_note"] = (
            "These states are entered more than 3x per session: "
            + ", ".join(m["fragmented_states"])
            + ". They are connective tissue rather than phases and are the "
              "main source of edges. Re-run Stage A with --rebuild so the "
              "alphabet folds them into the states they serve.")
    if targets["n_sessions"] < 4:
        m["note"] = (
            f"{targets['n_sessions']} session(s): the evidence budget caps "
            f"density at {md}. With fewer than 4 recordings, no abstraction "
            f"can make most edges repeat. Report this rather than tuning it away.")
    return m


# ============================================================================
# 6. Main
# ============================================================================

def main():
    global PROVIDER, MODEL
    ap = argparse.ArgumentParser()
    ap.add_argument("--recipe", required=True, help="e.g. P01_R01")
    ap.add_argument("--narrations", default=None,
                    help="auto-detected; see LAYOUTS at the top of the file")
    ap.add_argument("--recipes", default=None)
    ap.add_argument("--verbs", default=None)
    ap.add_argument("--nouns", default=None)
    ap.add_argument("--timestamps", default=None,
                    help="P<PID>_recipe_timestamps.csv; scopes actions to the "
                         "recipe. Use --no-scope to disable.")
    ap.add_argument("--no-scope", action="store_true",
                    help="use every action in the pkl, including other tasks")
    ap.add_argument("--out", default=None,
                    help="default: an 'out' folder next to this script")
    ap.add_argument("--level", default="functional", choices=["functional", "phase"])
    ap.add_argument("--unmapped", default="absorb", choices=["absorb", "node"],
                    help="'absorb' folds unmapped actions into the neighbouring "
                         "state; 'node' keeps them as a separate box")
    ap.add_argument("--granularity", default="action", choices=["action", "window"],
                    help="'window' forces one state per annotated activity "
                         "window (coarser, guaranteed contiguous)")
    ap.add_argument("--min-states", type=int, default=None,
                    help="floor guard against a degenerate graph "
                         f"(default {STATE_FLOOR}); the LLM chooses the actual "
                         f"count from the data")
    ap.add_argument("--max-states", type=int, default=None,
                    help="readability ceiling for the non-expert reader "
                         f"(default {STATE_CEILING}); raise it for a recipe with "
                         f"more distinct recurring goals")
    ap.add_argument("--rebuild", action="store_true", help="ignore LLM caches")
    ap.add_argument("--min-run", type=int, default=3,
                    help="a state visit shorter than this many actions is "
                         "merged into its longer neighbour (1 = off)")
    ap.add_argument("--auto-merge", type=int, default=2,
                    help="max pairs of oscillating states to merge (0 = off)")
    ap.add_argument("--refine", type=int, default=2,
                    help="extra Stage A attempts, each shown the measured "
                         "problems with the previous alphabet (0 = off)")
    ap.add_argument("--provider", default=PROVIDER, choices=["gemini", "anthropic"])
    ap.add_argument("--model", default="", help="override the model id")
    ap.add_argument("--batch", type=int, default=60,
                    help="action types per LLM call in stage B")
    ap.add_argument("--env-file", default=None,
                    help="path to a .env file (default: search ./ and upwards)")
    args = ap.parse_args()

    env_path = load_dotenv(args.env_file)
    PROVIDER = args.provider
    MODEL = args.model or os.environ.get("ABSTRACTION_MODEL", "")
    print(f"env: {env_path or 'none found (using shell environment)'}", file=sys.stderr)
    _, key_name = get_api_key(PROVIDER)          # fail fast, before any work
    print(f"provider={PROVIDER} model={MODEL or DEFAULT_MODEL[PROVIDER]} "
          f"key={key_name}", file=sys.stderr)

    # Resolve every data file before doing any work, so a wrong folder fails
    # in a second with a list of exactly where it looked.
    args.narrations = find_file("narrations", args.narrations, args.recipe)
    args.recipes = find_file("recipes", args.recipes)
    args.verbs = find_file("verbs", args.verbs)
    args.nouns = find_file("nouns", args.nouns)
    args.timestamps = (None if args.no_scope else
                       find_file("timestamps", args.timestamps, args.recipe,
                                 required=False))
    for label, p in (("narrations", args.narrations), ("recipes", args.recipes),
                     ("verbs", args.verbs), ("nouns", args.nouns),
                     ("timestamps", args.timestamps or "NOT FOUND")):
        print(f"  {label:<11} {p}", file=sys.stderr)

    if args.timestamps is None and not args.no_scope:
        pid = args.recipe.split("_")[0]
        raise SystemExit(
            f"\n!! {pid}_recipe_timestamps.csv was not found, and without it\n"
            f"   this script cannot do either of the two things that matter:\n"
            f"     - scope actions to the recipe (the pkl holds the whole\n"
            f"       kitchen session, typically ~20 percent of which is the recipe)\n"
            f"     - give Stage B the activity-window context it needs, without\n"
            f"       which the verb decides the state and the graph oscillates\n\n"
            f"   Find it:  Get-ChildItem -Recurse -Filter {pid}_recipe_timestamps.csv\n"
            f"   Then:     --timestamps <that path>\n\n"
            f"   Or pass --no-scope to run the old, worse behaviour on purpose.")

    args.out = args.out or os.path.join(SCRIPT_DIR, "out")
    os.makedirs(args.out, exist_ok=True)
    alpha_path = os.path.join(args.out, f"{args.recipe}_alphabet.json")
    map_path = os.path.join(args.out, f"{args.recipe}_mapping.json")
    op_alpha_path = os.path.join(args.out, f"{args.recipe}_operations.json")
    op_map_path = os.path.join(args.out, f"{args.recipe}_op_mapping.json")
    if args.rebuild:
        for p in (alpha_path, map_path, op_alpha_path, op_map_path):
            if os.path.exists(p):
                os.remove(p)

    verb_map, noun_map = load_vocab(args.verbs, args.nouns)
    recipe, sessions = recipe_videos(args.recipes, args.recipe)
    all_videos = [v for s in sessions for v in s]
    print(f"{args.recipe} '{recipe.get('name')}' : {len(all_videos)} videos", file=sys.stderr)

    windows = load_recipe_windows(args.timestamps, all_videos, args.recipe)
    wlabels = load_window_labels(args.timestamps, all_videos, args.recipe)
    sessions_actions = load_actions(args.narrations, all_videos, verb_map,
                                    noun_map, windows, wlabels)
    n_all = sum(len(a) for a in sessions_actions.values())
    n_in = sum(1 for acts in sessions_actions.values() for a in acts
               if a["in_recipe"])
    print(f"  {n_all} actions in pkl, {n_in} inside the recipe "
          f"({n_in / max(n_all, 1):.0%}); the rest become edge interruptions",
          file=sys.stderr)
    if windows and n_in == 0:
        raise SystemExit("No actions fell inside the recipe windows. Check that "
                         "the timestamps file matches this recipe, or --no-scope.")

    targets = derive_targets(len(sessions_actions),
                             min_states=args.min_states,
                             max_states=args.max_states)
    # The recipe's own step count is printed for the leak check only — it is
    # NOT fed to the LLM and does not set the target band.
    print(f"  target {targets['min_states']}-{targets['max_states']} states "
          f"(recipe-independent), density <= {targets['max_density']}  "
          f"[recipe card has {len(recipe['steps'])} steps, not shown to LLM]",
          file=sys.stderr)

    def build_feedback(mm, gr, mapping_):
        visits = "\n".join(f"  {v:>5} x per session   {i}"
                            for i, v in mm["visits_per_session"].items())
        probs = []
        if mm["fragmented_states"]:
            probs.append(f"- Too fragmented: {', '.join(mm['fragmented_states'])}")
        # Density is only a PROBLEM when it exceeds the render cap — a graph too
        # dense to lay out. It is NOT judged against the S/2 evidence budget:
        # that budget measures whether the DATA has enough sessions for arrows
        # to repeat, which the abstraction cannot fix and must not shrink to
        # chase. Low cross-session agreement is a property of the data, reported
        # as advisory, never fed back as something to "fix".
        if mm["density_edges_per_node"] > GATES["max_render_density"]:
            probs.append(
                f"- {mm['n_edges']} arrows for {mm['n_states']} states "
                f"({mm['density_edges_per_node']} per state). The graph is too "
                f"dense to lay out; the render limit is {GATES['max_render_density']}. "
                f"Merge connective states, do not drop states that recur.")
        if mm["coverage"] < GATES["min_coverage"]:
            probs.append(f"- Only {mm['coverage']:.0%} of actions matched a "
                         f"state; the rest had to be absorbed into neighbours.")
        # NOTE: the cross_session_jaccard / "sessions disagreed" problem was
        # removed on purpose. Telling the LLM to raise agreement can only be
        # obeyed by deleting session-specific states, i.e. by shrinking toward
        # the recipe card — the exact circularity this pipeline avoids. Session
        # disagreement is a finding (§5: order barely recurs), not a defect.
        pairs = collections.Counter()
        for e in gr["edges"]:
            if e["source"] not in ("START", "END") and e["target"] not in ("START", "END"):
                pairs[tuple(sorted((e["source"], e["target"])))] += e["n"]
        top = [f"  {a} <-> {b} ({n}x back and forth)"
               for (a, b), n in pairs.most_common(3) if a != b]
        if top:
            probs.append("- These pairs keep alternating, so they are probably "
                         "one activity split in two:\n" + "\n".join(top))
        gaps = [f'  ({k[1]}, {k[2]}) during "{k[0]}"'
                for k, v in mapping_.items()
                if v.get("state") == "unmapped" or v.get("absorbed")][:12]
        return {"visits": visits,
                "problems": "\n".join(probs) or "- none",
                "gaps": "\n".join(gaps) or "  (none)"}

    feedback, best = None, None
    for attempt in range(1, args.refine + 2):
        tag = "" if attempt == 1 else f" (attempt {attempt})"
        print(f"Stage A: proposing alphabet{tag} ...", file=sys.stderr)
        alphabet = propose_alphabet(recipe, args.recipe, sessions_actions,
                                    alpha_path, targets, feedback, attempt)
        for st in alphabet["states"]:
            print(f"    {st['id']:>4}  {st['name']:<28} [{st.get('phase')}]",
                  file=sys.stderr)

        this_map = map_path if attempt == 1 else f"{map_path}.{attempt}"
        if feedback and os.path.exists(this_map):
            os.remove(this_map)
        print("Stage B: mapping action types ...", file=sys.stderr)
        mapping = map_pair_types(recipe, alphabet, sessions_actions, this_map,
                                 batch=args.batch)

        def rebuild():
            i2n = {st["id"]: st["name"] for st in alphabet["states"]}
            ss = {v: collapse(a, mapping, i2n, args.granularity, args.unmapped,
                              args.min_run)
                  for v, a in sessions_actions.items()}
            gr = build_graph(ss, alphabet, level=args.level)
            return ss, gr, metrics(gr, ss, sessions_actions, mapping, targets)

        sessions_segs, graph, m = rebuild()

        # Fold apart states that the data shows are really one activity.
        for _ in range(args.auto_merge):
            if len(alphabet["states"]) <= max(targets["min_states"] - 1, 2):
                break
            pair = find_oscillating_pair(graph, sessions_segs)
            if not pair:
                break
            a, b, flips, med = pair
            print(f"  '{a}' + '{b}': {flips}x alternating, median {med}s "
                  f"per pair -> one activity", file=sys.stderr)
            merged = merge_states(alphabet, mapping, a, b, flips)
            if merged is None:
                break
            print(f"    merged -> '{merged}'", file=sys.stderr)
            sessions_segs, graph, m = rebuild()

        # Rank on the BLOCKING gates only — the ones that measure abstraction
        # quality (fragmentation, coverage, readable count, layout density).
        # The advisory gates (jaccard, repeat-edge share) are deliberately kept
        # OUT of the score: they measure cross-session agreement, which is a
        # property of the data, and ranking on them selects the smallest
        # alphabet (the one that forces sessions to agree) — the shrink-to-the-
        # card pressure we are removing. Tie-break on coverage (more actions
        # explained) and fewer fragmented states, never on density or count.
        n_block = sum(1 for v in m["blocking_gates"].values() if v)
        n_pass = sum(1 for v in m["gates"].values() if v)   # logged only
        score = (1 if m["render_ready"] else 0, n_block,
                 m["coverage"], -len(m["fragmented_states"]))
        failed = [k for k, v in m["gates"].items() if not v]
        print(f"  -> {m['n_states']} states, {m['n_edges']} edges, density "
              f"{m['density_edges_per_node']}, jaccard "
              f"{m['cross_session_jaccard']}, coverage {m['coverage']} "
              f"| {n_block}/{len(m['blocking_gates'])} blocking, "
              f"{n_pass}/{len(m['gates'])} total"
              + (f", failing: {', '.join(failed)}" if failed else ""),
              file=sys.stderr)
        if best is None or score > best[0]:
            best = (score, alphabet, mapping, graph, m)
        # Stop as soon as the abstraction is RENDER-READY (all blocking gates
        # pass). We no longer keep refining just to raise agreement metrics that
        # the abstraction cannot move without deleting states that recur.
        if m["render_ready"] or attempt == args.refine + 1:
            break
        feedback = build_feedback(m, graph, mapping)

    _, alphabet, mapping, graph, m = best
    print("Stage D: proposing operations ...", file=sys.stderr)
    op_alphabet = propose_operations(recipe, graph, op_alpha_path)
    print("Stage D2: mapping actions to operations ...", file=sys.stderr)
    op_mapping = map_action_operations(recipe, graph, op_alphabet,
                                       op_map_path, batch=args.batch)
    add_operations(graph, op_alphabet, op_mapping)
    json.dump(alphabet, open(alpha_path, "w"), indent=2)
    json.dump({"\t".join(k): v for k, v in mapping.items()},
              open(map_path, "w"), indent=2)
    json.dump(graph, open(os.path.join(args.out, f"{args.recipe}_graph.json"), "w"),
              indent=2)
    json.dump(m, open(os.path.join(args.out, f"{args.recipe}_metrics.json"), "w"),
              indent=2)

    print("\n--- metrics ---", file=sys.stderr)
    for k, v in m.items():
        if k not in ("gates", "targets", "note", "visits_per_session",
                     "fragmented_states", "fragmentation_note",
                     "blocking_gates", "advisory", "render_ready"):
            print(f"  {k}: {v}", file=sys.stderr)
    verdict = "READY TO RENDER" if m["render_ready"] else "NOT READY - fix the abstraction"
    print(f"\n  {verdict}", file=sys.stderr)
    for k, v in m["blocking_gates"].items():
        print(f"    {'PASS' if v else 'FAIL'}  {k}", file=sys.stderr)
    print("\n  advisory (properties of the data, not the abstraction):",
          file=sys.stderr)
    print(f"    sessions recorded    {targets['n_sessions']}", file=sys.stderr)
    print(f"    session agreement    strict {m['cross_session_jaccard']}, "
          f"pairwise {m['mean_pairwise_jaccard']}, "
          f"mean state support {m['mean_state_support']}", file=sys.stderr)
    print(f"    arrows seen 2+ times {m['repeat_edge_share']}", file=sys.stderr)
    print("\n  all gates:", file=sys.stderr)
    for k, v in m["gates"].items():
        print(f"    {'PASS' if v else 'FAIL'}  {k}", file=sys.stderr)
    print("  visits per session:", file=sys.stderr)
    for i, v in m["visits_per_session"].items():
        flag = "  <-- fragmented" if v > 3.0 else ""
        print(f"    {v:>5}  {i}{flag}", file=sys.stderr)
    for k in ("fragmentation_note", "note"):
        if k in m:
            print(f"  {k}: {m[k]}", file=sys.stderr)


if __name__ == "__main__":
    main()