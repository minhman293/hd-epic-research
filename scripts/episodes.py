"""
episodes.py — Stage 5.5 of the motion-graph pipeline.

Sits between the raw action stream and the graph builder.

    actions (per session)  ->  episodes  ->  merged episode graph

Design rule: NOTHING IS DELETED. Every action ends up inside exactly one
episode, and every episode keeps its members. Edges are reduced because
within-episode transitions are absorbed, not because actions are removed.

Public API
----------
    segment(actions, cfg)                 -> list[Episode]      (one session)
    build_graph(sessions_of_episodes, cfg)-> dict {nodes, links, report}
"""

from __future__ import annotations
import collections
from dataclasses import dataclass, field
from typing import Any, Callable

# --------------------------------------------------------------------------
# 1. TAXONOMY ROLES
#    Derived from the 13 HD-EPIC verb categories and 21 noun categories.
#    These decide what counts as "the same goal" and "the same object".
# --------------------------------------------------------------------------

# Verbs that change the food. These define what an episode is FOR.
TRANSFORM = {"merge", "split", "distribute", "clean"}
# Verbs that move things around in service of a transform.
LOGISTIC = {"retrieve", "leave", "access", "block", "transition"}
# Verbs that are neither — they attach to whatever is happening.
NEUTRAL = {"manipulate", "monitor", "sense", "order"}

# Nouns that never define an episode: they are carriers, not goals.
TRANSPARENT_NOUNS = {"hand", "other", "materials", "rubbish"}
# Nouns that are places you open to reach the real object.
ENCLOSURE_NOUNS = {"storage", "furniture", "containers", "cleaning equipment and material"}

# Priority for choosing the ONE action that names the episode.
def _head_priority(verb_cat: str) -> int:
    if verb_cat in TRANSFORM:
        return 3
    if verb_cat in NEUTRAL:
        return 2
    return 1


# --------------------------------------------------------------------------
# 2. CONFIG
# --------------------------------------------------------------------------

@dataclass
class Config:
    # A pause longer than this always starts a new episode.
    max_gap_s: float = 2.5
    # An episode may not run longer than this (guards against one giant blob).
    max_span_s: float = 45.0
    # Cap on how many raw actions one episode may absorb.
    max_members: int = 8
    # How far an action may reach to claim its preferred anchor.
    max_reach_s: float = 12.0
    # Keep an edge only if it was seen in at least this many sessions...
    min_edge_sessions: int = 2
    # ...or this many times in total.
    min_edge_count: int = 2
    # False = draw every observed transition (no thinning).
    thin_edges: bool = False
    # Keep a node only if seen in at least this many sessions.
    min_node_sessions: int = 2
    # Trust the annotator: a change of step_id is always a boundary.
    respect_step_boundaries: bool = True

    # ---- ABLATION SWITCHES ------------------------------------------------
    # Each of these turns OFF one rule that Part 6 named as a suspect for the
    # low internal consistency (0.31-0.34). They exist so the question "is the
    # variation in the person or in our rule?" can be answered by measurement
    # instead of argument. Defaults reproduce the current pipeline exactly.
    #
    #   reach_mode="object"  an action joins the anchor that touches the SAME
    #                        object category, falling back to time only when
    #                        neither neighbour shares it. A skill boundary is
    #                        about object state, not elapsed seconds.
    #   use_cap=False        do not cut a bucket at max_members.
    #   use_synthetic=False  do not invent an anchor for anchor-less runs.
    #   use_fold=False       do not absorb one-off labels into their neighbour.
    reach_mode: str = "time"          # "time" | "object"
    use_cap: bool = True
    use_synthetic: bool = True
    use_fold: bool = True


# --------------------------------------------------------------------------
# 3. EPISODE
# --------------------------------------------------------------------------

@dataclass
class Episode:
    session: int
    members: list = field(default_factory=list)   # raw action dicts
    anchor_noun: str | None = None                # the object this is about
    label: str = ""                               # "<verb_key> <noun_category>"
    start: float = 0.0
    end: float = 0.0
    step_id: str | None = None
    head: dict | None = None                      # the action that names it

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "session": self.session,
            "start": round(self.start, 2),
            "end": round(self.end, 2),
            "duration": round(self.duration, 2),
            "step_id": self.step_id,
            "n_actions": len(self.members),
            "head_action": self.head.get("raw_action") if self.head else None,
            # everything the drill-down inspector needs:
            "members": [
                {
                    "raw_action": m.get("raw_action"),
                    "start": m.get("start"),
                    "end": m.get("end"),
                    "video_id": m.get("video_id"),
                }
                for m in self.members
            ],
            "verbs": dict(collections.Counter(m["_vkey"] for m in self.members)),
            "objects": dict(collections.Counter(m["_nkey"] for m in self.members)),
        }


# --------------------------------------------------------------------------
# 4. SEGMENTATION  (anchor-based)
#
#    An episode = ONE goal-carrying action, plus every nearby action that
#    served it. Fetching, opening, putting down, wiping hands: all absorbed.
#
#    Two passes:
#      pass 1  find anchors  — actions that change the food or drive a device
#      pass 2  attach every other action to its nearest anchor in time
#
#    Because pass 2 assigns EVERY action, coverage is 100% by construction.
#    No filter, no fabricated edge, no orphan action.
# --------------------------------------------------------------------------

ANCHOR_VERB_CATS = TRANSFORM | {"manipulate"}


def _decorate(a: dict, verb_map: dict, noun_map: dict) -> dict:
    """Attach resolved taxonomy fields so later code stays readable."""
    vk, vcat = verb_map.get(a.get("verb_class"), ("?", "?"))
    nk, ncat = noun_map.get(a.get("noun_class"), ("?", "?"))
    a["_vkey"], a["_vcat"], a["_nkey"], a["_ncat"] = vk, vcat, nk, ncat
    return a


def _is_anchor(a: dict) -> bool:
    """Does this action carry a goal, or is it just logistics?"""
    if a["_ncat"] in TRANSPARENT_NOUNS:
        return False
    if a["_vcat"] in TRANSFORM:                       # merge / split / clean
        return True
    if a["_vcat"] == "manipulate":                    # stir, press, pour
        return True
    return False


# --- attachment direction ---------------------------------------------------
# Logistics are not neutral in time. Fetching and opening PREPARE the next
# goal; putting down and closing CLEAN UP after the last one. So direction
# is decided by meaning first, and by distance only when meaning is silent.
PREPARATORY = {"retrieve", "access", "transition"}   # take, open, walk to
CLOSING = {"leave", "block"}                         # put, close


def _preferred_direction(a: dict) -> int:
    """+1 = attach to the NEXT anchor, -1 = the PREVIOUS one, 0 = nearest."""
    if a["_vcat"] in PREPARATORY:
        return +1
    if a["_vcat"] in CLOSING:
        return -1
    return 0


def _insert_synthetic_anchors(acts: list, anchors: list, cfg: Config) -> list:
    """Guarantee no run of actions is left without an anchor.

    A participant can spend a minute only fetching. Such a run has no goal
    action, so pass 2 would either orphan it or bundle it into one huge
    episode. We promote the longest action in the run to be a synthetic
    anchor, then re-check both halves, until every run fits the caps.
    """
    bounds = [-1] + list(anchors) + [len(acts)]
    stack = [list(range(lo + 1, hi)) for lo, hi in zip(bounds, bounds[1:])]
    extra = []
    while stack:
        run = stack.pop()
        if not run:
            continue
        too_many = cfg.use_cap and len(run) > cfg.max_members
        too_long = (acts[run[-1]]["end"] - acts[run[0]]["start"]) > cfg.max_span_s
        if not (too_many or too_long):
            continue
        # The longest action is the most substantial thing the person did
        # while no goal action was available. It names the episode.
        # Longest action wins. When durations tie — common, since most
        # actions are ~1s — prefer the most central one, so the split is
        # balanced instead of shaving one action off the front each time.
        mid = (run[0] + run[-1]) / 2
        pick = max(run, key=lambda i: (round(acts[i]["end"] - acts[i]["start"], 2),
                                       -abs(i - mid)))
        acts[pick]["_synthetic_anchor"] = True
        extra.append(pick)
        stack.append([i for i in run if i < pick])
        stack.append([i for i in run if i > pick])
    return sorted(set(anchors) | set(extra))


def segment(actions: list, verb_map: dict, noun_map: dict,
            cfg: Config | None = None, session: int = 0) -> list:
    """Cut ONE session's action stream into episodes."""
    cfg = cfg or Config()
    acts = [_decorate(dict(a), verb_map, noun_map) for a in actions]
    acts.sort(key=lambda a: a["start"])
    if not acts:
        return []

    # pass 1: real anchors, then synthetic ones so no run is left uncovered.
    anchors = [i for i, a in enumerate(acts) if _is_anchor(a)]
    if cfg.use_synthetic:
        anchors = _insert_synthetic_anchors(acts, anchors, cfg)
    if not anchors:                       # a session with no anchor at all
        anchors = [max(range(len(acts)),
                       key=lambda i: acts[i]["end"] - acts[i]["start"])]
        acts[anchors[0]]["_synthetic_anchor"] = True

    # pass 2: attach every action to an anchor, direction by meaning.
    buckets = collections.defaultdict(list)
    for i, a in enumerate(acts):
        prev = max((j for j in anchors if j <= i), default=None)
        nxt = min((j for j in anchors if j >= i), default=None)
        want = _preferred_direction(a)

        # ABLATION A - object continuity instead of a 12-second window.
        # An action belongs with the anchor it shares an object with:
        # fetch the milk, open the milk, pour the milk, put the milk back.
        # Only when neither neighbour shares the object does time decide.
        if cfg.reach_mode == "object":
            same = [j for j in (prev, nxt)
                    if j is not None and acts[j]["_ncat"] == a["_ncat"]]
            if len(same) == 1:
                buckets[same[0]].append(a)
                continue
            if len(same) == 2:
                if want > 0:
                    pick = nxt
                elif want < 0:
                    pick = prev
                else:
                    pick = (nxt if _reach(acts, i, nxt) <= _reach(acts, i, prev)
                            else prev)
                buckets[pick].append(a)
                continue
            # neither anchor shares the object -> fall through to the time rule

        if prev is None:
            pick = nxt
        elif nxt is None:
            pick = prev
        elif want > 0 and _reach(acts, i, nxt) <= cfg.max_reach_s:
            pick = nxt
        elif want < 0 and _reach(acts, i, prev) <= cfg.max_reach_s:
            pick = prev
        else:
            d_prev, d_next = _reach(acts, i, prev), _reach(acts, i, nxt)
            pick = nxt if d_next <= d_prev else prev   # ties go FORWARD
        buckets[pick].append(a)

    # pass 3: build episodes, giving every chunk its own head.
    eps = []
    for j in sorted(buckets):
        members = sorted(buckets[j], key=lambda m: m["start"])
        step = cfg.max_members if cfg.use_cap else max(1, len(members))
        for k in range(0, len(members), step):
            chunk = members[k:k + step]
            head = acts[j] if acts[j] in chunk else max(
                chunk, key=lambda m: (_head_priority(m["_vcat"]),
                                      m["end"] - m["start"]))
            ep = Episode(session=session, members=chunk,
                         start=chunk[0]["start"], end=chunk[-1]["end"],
                         step_id=head.get("step_id"), head=head)
            ep.anchor_noun = head["_ncat"]
            # Format matters: config.js getVerbColor() splits on "(" to find the
            # verb, and getNodeSubtitle() reads the parenthesised noun. Writing
            # "press(appliances)" makes the node render as "press" with
            # "appliances" beneath it — the required [Verb] + [Noun category]
            # label — and gives it the right category colour. A bare
            # "press appliances" parses as an unknown verb and renders grey.
            ep.label = f"{head['_vkey']}({head['_ncat']})"
            ep.synthetic = bool(head.get("_synthetic_anchor"))
            # BUGFIX. _collapse_repeats() compares anchor_ids to tell a real
            # repeat from a bucket that max_members happened to cut in two.
            # Nothing ever set this attribute, so the comparison was always
            # between two empty sets, `repeats` was never incremented, and
            # every genuine self-loop was silently lost from the graph.
            ep.anchor_ids = {j}
            eps.append(ep)

    return _collapse_repeats(eps)


def _reach(acts: list, i: int, j: int) -> float:
    """Gap in seconds between action i and anchor j (0 if they overlap)."""
    a, b = acts[i], acts[j]
    if a["start"] <= b["end"] and b["start"] <= a["end"]:
        return 0.0
    return b["start"] - a["end"] if b["start"] > a["end"] else a["start"] - b["end"]


def apply_rollup(sessions: dict, cfg: Config | None = None) -> dict:
    """Second pass over ALL sessions: demote labels that lack support.

    A label keeps its specific verb key only if the (verb, noun) pair was
    seen in >= min_node_sessions sessions. Otherwise it falls back to the
    verb CATEGORY. Either way the label is always exactly two tokens, and
    `rolled_up` records which happened so the canvas can mark it.
    """
    cfg = cfg or Config()
    single = len(sessions) < 2          # one session: count repeats, not sessions
    pair_sessions = collections.defaultdict(set)
    for s, eps in sessions.items():
        for i, e in enumerate(eps):
            key = (e.head["_vkey"], e.anchor_noun)
            pair_sessions[key].add((s, i) if single else s)

    for s, eps in sessions.items():
        for e in eps:
            key = (e.head["_vkey"], e.anchor_noun)
            if len(pair_sessions[key]) >= cfg.min_node_sessions:
                e.label = f"{e.head['_vkey']}({e.anchor_noun})"
                e.rolled_up = False
            else:
                e.label = f"{e.head['_vcat']}({e.anchor_noun})"
                e.rolled_up = True
        sessions[s] = _collapse_repeats(eps)
    return sessions


def _collapse_repeats(eps: list) -> list:
    """Adjacent episodes with the same label become one.

    A repeat is only counted when the two episodes came from DIFFERENT anchors.

    Measured on P01_R01 and P03_R03, most same-label neighbours were one bucket
    that `max_members` had cut into pieces — a 22-action run through the fridge,
    the drawer and the scissors, labelled press(appliances) twice. Calling that
    "the person pressed the button twice" would be an artifact of the size cap
    dressed up as behaviour, and it would take probability away from the real
    outgoing transitions. Comparing anchor ids separates the two cases.
    """
    out: list[Episode] = []
    for ep in eps:
        ids = getattr(ep, "anchor_ids", set())
        if out and out[-1].label == ep.label:
            prev_ids = getattr(out[-1], "anchor_ids", set())
            out[-1].members.extend(ep.members)
            out[-1].end = ep.end
            if ids and prev_ids and ids.isdisjoint(prev_ids):
                out[-1].repeats = getattr(out[-1], "repeats", 1) + 1
            out[-1].anchor_ids = prev_ids | ids
        else:
            ep.repeats = getattr(ep, "repeats", 1)
            ep.anchor_ids = set(ids)
            out.append(ep)
    return out


# --------------------------------------------------------------------------
# 5. GRAPH BUILD  (nodes = episode labels, edges = observed transitions)
# --------------------------------------------------------------------------

def build_graph(sessions: dict, cfg: Config | None = None) -> dict:
    """sessions: {session_index: [Episode, ...]}"""
    cfg = cfg or Config()

    node_count = collections.Counter()
    node_sessions = collections.defaultdict(set)
    node_members = collections.defaultdict(list)
    node_onsets = collections.defaultdict(list)

    edge_count = collections.Counter()
    edge_sessions = collections.defaultdict(set)
    self_loops = collections.Counter()

    for s, eps in sessions.items():
        span = max((e.end for e in eps), default=1.0) or 1.0
        chain = ["START"] + [e.label for e in eps] + ["END"]
        for e in eps:
            node_count[e.label] += 1
            node_sessions[e.label].add(s)
            node_members[e.label].extend(e.members)
            node_onsets[e.label].append(e.start / span)
            if getattr(e, "repeats", 1) > 1:
                self_loops[e.label] += e.repeats - 1
        for x, y in zip(chain, chain[1:]):
            edge_count[(x, y)] += 1
            edge_sessions[(x, y)].add(s)

    # --- thin the edges -----------------------------------------------------
    kept = {
        k: v for k, v in edge_count.items()
        if len(edge_sessions[k]) >= cfg.min_edge_sessions
        or v >= cfg.min_edge_count
        or k[0] == "START" or k[1] == "END"
    }
    dropped = {k: v for k, v in edge_count.items() if k not in kept}

    # --- guarantee connectivity: restore the best dropped edge for orphans --
    restored = []
    kept, restored = _reconnect(kept, dropped, edge_count, node_count)

    # --- normalise probabilities per source --------------------------------
    out_total = collections.Counter()
    for (src, _), v in kept.items():
        out_total[src] += v

    nodes = []
    for label, count in node_count.items():
        onsets = node_onsets[label]
        nodes.append({
            "id": label,
            "count": count,
            "support": len(node_sessions[label]),
            "support_fraction": round(len(node_sessions[label]) / len(sessions), 3),
            "mean_onset": round(sum(onsets) / len(onsets), 4),
            "n_raw_actions": len(node_members[label]),
            "self_loop": self_loops.get(label, 0),
            "verbs": dict(collections.Counter(m["_vkey"] for m in node_members[label])),
            "objects": dict(collections.Counter(m["_nkey"] for m in node_members[label])),
            # Verb-CATEGORY breakdown. `verbs` above is by verb key (take,
            # remove, scoop separately); the category is what a reader needs
            # to see the shape of the episode at a glance.
            "verb_categories": dict(collections.Counter(
                m["_vcat"] for m in node_members[label]).most_common()),
            "object_categories": dict(collections.Counter(
                m["_ncat"] for m in node_members[label]).most_common(5)),
            "mean_members": round(
                len(node_members[label]) / max(1, count), 1),
            "head_verb_category": (
                collections.Counter(m["_vcat"] for m in node_members[label])
                .most_common(1)[0][0] if node_members[label] else None),
            # BUGFIX. This used to read
            #     any(... for m in []) or label.split()[0] in (...)
            # The first half loops over an empty list, so it is always False.
            # The second half splits on a SPACE, but labels are written
            # "press(appliances)" with no space, so label.split()[0] is the
            # whole label and never matches a category name. The field was
            # therefore always False. A rolled-up label is one whose verb slot
            # holds a verb CATEGORY rather than a verb key.
            "rolled_up": label.split("(")[0] in (TRANSFORM | LOGISTIC | NEUTRAL),
        })
    nodes.sort(key=lambda n: n["mean_onset"])

    links = []
    for (src, tgt), v in kept.items():
        links.append({
            "source": src,
            "target": tgt,
            "count": v,
            "support": len(edge_sessions[(src, tgt)]),
            "probability": round(v / out_total[src], 4) if out_total[src] else 0.0,
            "is_self_loop": src == tgt,
            "restored": (src, tgt) in restored,
            "weak": v < cfg.min_edge_count,     # draw dashed
        })

    n_nodes = len(nodes)
    report = {
        "sessions": len(sessions),
        "raw_actions": sum(len(m) for m in node_members.values()),
        "episodes_total": sum(node_count.values()),
        "nodes": n_nodes,
        "edges": len(links),
        "out_degree": round(len(links) / n_nodes, 2) if n_nodes else 0,
        "edges_dropped": len(dropped),
        "edges_restored": len(restored),
        "fabricated_edges": 0,          # by construction: every edge was observed
        "isolated_nodes": _count_isolated(nodes, links),
    }
    return {"nodes": nodes, "links": links, "report": report}


def _reconnect(kept: dict, dropped: dict, all_counts: dict, node_count: dict):
    """Any node with no kept edge gets its single strongest edge back."""
    touched = set()
    for (a, b) in kept:
        touched.add(a); touched.add(b)
    restored = set()
    for label in node_count:
        if label in touched:
            continue
        cands = [(k, v) for k, v in dropped.items() if label in k]
        if not cands:
            continue
        best = max(cands, key=lambda kv: kv[1])[0]
        kept[best] = all_counts[best]
        restored.add(best)
        touched.add(best[0]); touched.add(best[1])
    return kept, restored


def _count_isolated(nodes: list, links: list) -> int:
    touched = set()
    for l in links:
        touched.add(l["source"]); touched.add(l["target"])
    return sum(1 for n in nodes if n["id"] not in touched)


def fold_one_offs(sessions: dict, cfg: Config | None = None) -> dict:
    """Absorb labels seen in only one session into their nearest core node.

    A one-off episode is real, but it is personal variation, not shared
    structure. Folding it into the neighbouring core episode keeps its raw
    actions (so coverage stays 100%) and records its label under
    `variants`, so the drill-down inspector can still show it.
    """
    cfg = cfg or Config()
    if not cfg.use_fold:                  # ABLATION D
        return sessions
    single = len(sessions) < 2
    label_sessions = collections.defaultdict(set)
    for s, eps in sessions.items():
        for i, e in enumerate(eps):
            label_sessions[e.label].add((s, i) if single else s)
    core = {l for l, ss in label_sessions.items()
            if len(ss) >= cfg.min_node_sessions}

    out_all = {}
    for s, eps in sessions.items():
        out = []
        for e in eps:
            if e.label in core or not out:
                e.variants = getattr(e, "variants", [])
                out.append(e)
            else:
                out[-1].members += e.members
                out[-1].end = e.end
                out[-1].variants.append(e.label)
        out_all[s] = _collapse_repeats(out)
    return out_all


# --------------------------------------------------------------------------
# 6. AUDIT — does the label describe the episode, or only its head action?
#
# An episode is named after ONE member (its head). Nothing so far has checked
# whether the other members belong under that name. If a press(appliances)
# episode is mostly fetching, the name is a label rather than a summary, and
# both a reader and an executing agent are misled by it.
#
# Purity is the share of members that match the head. It is the standard
# measure for "does this cluster's name describe its contents".
# --------------------------------------------------------------------------

def label_faithfulness(sessions: dict) -> dict:
    """How much of each episode actually matches its own name?"""
    per_label = collections.defaultdict(lambda: {"v": [], "o": [], "n": []})
    all_v, all_o, sizes = [], [], []

    for s, eps in sessions.items():
        for e in eps:
            if not e.members or not e.head:
                continue
            hv, ho = e.head["_vcat"], e.head["_ncat"]
            v = sum(1 for m in e.members if m["_vcat"] == hv) / len(e.members)
            o = sum(1 for m in e.members if m["_ncat"] == ho) / len(e.members)
            per_label[e.label]["v"].append(v)
            per_label[e.label]["o"].append(o)
            per_label[e.label]["n"].append(len(e.members))
            all_v.append(v)
            all_o.append(o)
            sizes.append(len(e.members))

    def mean(xs):
        return round(sum(xs) / len(xs), 3) if xs else 0.0

    worst = sorted(
        ({"label": lab,
          "verb_purity": mean(d["v"]),
          "object_purity": mean(d["o"]),
          "mean_size": mean(d["n"]),
          "occurrences": len(d["n"])}
         for lab, d in per_label.items()),
        key=lambda r: r["verb_purity"],
    )

    return {
        "verb_purity": mean(all_v),
        "object_purity": mean(all_o),
        "mean_episode_size": mean(sizes),
        "singleton_fraction": mean([1.0 if n == 1 else 0.0 for n in sizes]),
        "n_episodes": len(sizes),
        "per_label": {r["label"]: r for r in worst},
        "worst_labels": worst[:5],
        "note": ("Purity = share of an episode's members whose verb/noun "
                 "category matches the head action that names it. Low purity "
                 "means the label describes one member, not the group."),
    }

def episode_structure(sessions: dict) -> dict:
    """Is an episode a SKILL (consistent internal routine) or just a NAME?

    Three questions, none of which needs any annotation:

      1. Is the head's verb category even the most common one inside the
         episode? Purity says how much matches; this says whether the name
         describes the majority or a minority.
      2. When the same label occurs several times, does it contain the same
         routine each time? Consistent internals = a reusable skill.
      3. Does the goal action sit at a consistent position? A stable
         "support first, goal last" shape means the grouping found structure
         rather than cutting the stream arbitrarily.
    """
    import statistics

    # ---- 1. is the head verb the modal verb? -------------------------------
    modal_hits, anchor_pos = [], []
    for eps in sessions.values():
        for e in eps:
            if not e.members or not e.head:
                continue
            vc = collections.Counter(m["_vcat"] for m in e.members)
            modal_hits.append(1.0 if vc.most_common(1)[0][0] == e.head["_vcat"] else 0.0)
            if len(e.members) > 1:
                try:
                    idx = e.members.index(e.head)
                except ValueError:
                    continue
                anchor_pos.append(idx / (len(e.members) - 1))

    # ---- 2. internal consistency across occurrences ------------------------
    def _edit(a, b):
        """Normalised Levenshtein over verb-category sequences."""
        if not a and not b:
            return 0.0
        prev = list(range(len(b) + 1))
        for i, x in enumerate(a, 1):
            cur = [i]
            for j, y in enumerate(b, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1,
                               prev[j - 1] + (x != y)))
            prev = cur
        return prev[-1] / max(len(a), len(b))

    by_label = collections.defaultdict(list)
    for eps in sessions.values():
        for e in eps:
            if e.members:
                by_label[e.label].append([m["_vcat"] for m in e.members])

    per_label, repeated = {}, []
    for lab, seqs in by_label.items():
        if len(seqs) < 2:
            continue
        ds = [_edit(seqs[i], seqs[j])
              for i in range(len(seqs)) for j in range(i + 1, len(seqs))]
        d = round(sum(ds) / len(ds), 3)
        per_label[lab] = {"mean_distance": d, "occurrences": len(seqs),
                          "consistency": round(1 - d, 3)}
        repeated.append(d)

    ranked = sorted(per_label.items(), key=lambda kv: kv[1]["mean_distance"])

    return {
        "head_is_modal_verb": round(sum(modal_hits) / len(modal_hits), 3)
                              if modal_hits else 0.0,
        "anchor_position_mean": round(statistics.mean(anchor_pos), 3)
                                if anchor_pos else None,
        "anchor_position_sd": round(statistics.pstdev(anchor_pos), 3)
                              if len(anchor_pos) > 1 else None,
        "internal_consistency": round(1 - sum(repeated) / len(repeated), 3)
                                if repeated else None,
        "n_repeated_labels": len(per_label),
        "most_consistent": [{"label": k, **v} for k, v in ranked[:5]],
        "least_consistent": [{"label": k, **v} for k, v in ranked[-5:]],
        "per_label": per_label,
        "note": ("consistency = 1 - mean normalised edit distance between the "
                 "verb-category sequences of episodes sharing a label. 1.0 = "
                 "identical routine every time (a skill); 0.0 = unrelated "
                 "contents under one name."),
    }