"""
9_build_episode_graphs.py

Stage 9 — write the EPISODE graph in the payload shape the dashboard already
reads. Run it after 6_prepare_dashboard_data.py.

    python 6_prepare_dashboard_data.py P03_R03      # unchanged
    python 9_build_episode_graphs.py  P03_R03      # NEW
    python 7_build_manifest.py                     # unchanged

Why this file exists instead of a patch to stage 6
--------------------------------------------------------------------------------
config.js resolves a graph file purely from the mode string:

    getSessionDataUrl(recipeId, i, mode)  ->  session_{i}_{mode}.json
    getMergedDataUrl(recipeId,    mode)  ->  merged_{mode}.json

So a new abstraction level is a new FILE, not new frontend code. This script
writes `session_N_episode.json` and `merged_episode.json`, and the only change
needed in the UI is one <option value="episode"> in the graph-mode dropdown.
Nothing in graph.js or app.js has to be touched.

Input is `session_N_full.json` — the unfiltered stream — because the episode
assignment needs every action to guarantee 100% coverage. The `full` files are
already written by stage 6, so no earlier stage changes either.
"""

import argparse
import collections
import csv
import json
from pathlib import Path

from episodes import (Config, segment, apply_rollup, fold_one_offs,
                      TRANSPARENT_NOUNS)

from spine_verdict import spine_with_verdict, compare_layers
from likely_path import likely_path_block, build_expansions


# ─────────────────────────────────────────────────────────────────────────────
# Taxonomy
# ─────────────────────────────────────────────────────────────────────────────

def load_taxonomy(narr_dir):
    def rd(fn):
        with open(Path(narr_dir) / fn, encoding="utf-8") as f:
            return {int(r["id"]): (r["key"], r["category"])
                    for r in csv.DictReader(f)}
    return rd("HD_EPIC_verb_classes.csv"), rd("HD_EPIC_noun_classes.csv")


# ─────────────────────────────────────────────────────────────────────────────
# Scope: keep the task, drop other tasks
#
# This is the ONE removal that is legitimate. Activity outside the recipe span
# belongs to a different task, so excluding it is not the same as discarding
# detail inside the recipe. Within the span nothing is ever dropped.
# ─────────────────────────────────────────────────────────────────────────────

def task_span(actions, payload):
    marks = [(a["start"], a["end"]) for a in actions if a.get("step_id")]
    marks += [(w["start"], w["end"]) for w in (payload.get("step_windows") or [])]
    if not marks:
        return actions, None
    lo = min(m[0] for m in marks)
    hi = max(m[1] for m in marks)
    return [a for a in actions if a["end"] >= lo and a["start"] <= hi], (lo, hi)


# ─────────────────────────────────────────────────────────────────────────────
# The STEP layer
#
# Identical mechanism to the episode layer — nearest anchor in time — with the
# annotated recipe steps as anchors instead of goal verbs. One function, two
# layers. Use this layer when the episode layer has too many nodes to read.
# ─────────────────────────────────────────────────────────────────────────────

def step_segment(actions, steps, vmap, nmap, session=0):
    from episodes import _decorate, _collapse_repeats, Episode
    labels = {s["id"]: (s.get("label") or s.get("text", ""))[:28] for s in steps}
    acts = sorted((_decorate(dict(a), vmap, nmap) for a in actions),
                  key=lambda a: a["start"])
    anchors = [i for i, a in enumerate(acts) if a.get("step_id")]
    if not anchors:
        return []
    buckets = collections.defaultdict(list)
    for a in acts:
        j = min(anchors, key=lambda k: (abs(acts[k]["start"] - a["start"]), k))
        buckets[j].append(a)
    eps = []
    for j in sorted(buckets):
        mem = sorted(buckets[j], key=lambda m: m["start"])
        head = acts[j]
        e = Episode(session=session, members=mem, start=mem[0]["start"],
                    end=mem[-1]["end"], step_id=head["step_id"], head=head)
        e.anchor_noun = head["_ncat"]
        e.label = labels.get(head["step_id"], head["step_id"])
        eps.append(e)
    return _collapse_repeats(eps)


# ─────────────────────────────────────────────────────────────────────────────
# Payload assembly
# ─────────────────────────────────────────────────────────────────────────────

def episode_sequence(eps):
    """A sequence row per episode, in the shape app.js and the video sync expect.

    `action` carries the episode label because that is the field the frontend
    joins on. The raw actions stay under `members`, which is what the
    drill-down inspector reads — nothing is lost, it is only nested.
    """
    rows = []
    for i, e in enumerate(eps):
        verbs = collections.Counter(m["_vkey"] for m in e.members)
        objs = collections.Counter(m["_nkey"] for m in e.members)
        # The legend derives its colour swatches by parsing `action` for a
        # verb. That works for episode labels like press(appliances) and fails
        # for step labels like "brew espresso", which is why the step legend
        # came out empty. Carry the verb explicitly, using the same rule the
        # node colouring uses, so legend and canvas can never disagree.
        if "(" in e.label:
            row_verb = e.label.split("(")[0]
        else:
            row_verb = collections.Counter(
                m["_vcat"] for m in e.members).most_common(1)[0][0]
        rows.append({
            "index": i,
            "kind": "action",
            "action": e.label,
            "verb": row_verb,
            "start": round(e.start, 3),
            "end": round(e.end, 3),
            "duration": round(e.end - e.start, 3),
            "is_primary": True,
            "step_id": e.step_id,
            "video_id": e.members[0].get("video_id"),
            "n_actions": len(e.members),
            "repeats": getattr(e, "repeats", 1),
            "synthetic": bool(getattr(e, "synthetic", False)),
            "rolled_up": bool(getattr(e, "rolled_up", False)),
            "variants": sorted(set(getattr(e, "variants", []))),
            "verbs": dict(verbs),
            "objects": dict(objs),
            "members": [{
                "raw_action": m.get("action") or m.get("raw_action"),
                "start": round(m["start"], 3),
                "end": round(m["end"], 3),
                "verb": m["_vkey"], "object": m["_nkey"],
                "video_id": m.get("video_id"),
            } for m in e.members],
        })
    return rows


def graph_from(sessions, cfg, n_sessions, layer="episode"):
    """Nodes and links with every field graph.js reads."""
    ncount, nsess, nmem, nonset, nloop = (collections.Counter(),
                                          collections.defaultdict(set),
                                          collections.defaultdict(list),
                                          collections.defaultdict(list),
                                          collections.Counter())
    npersess = collections.defaultdict(collections.Counter)
    head_of = {}
    nrank = collections.defaultdict(list)
    ecount, esess, epersess = (collections.Counter(),
                               collections.defaultdict(set),
                               collections.defaultdict(collections.Counter))

    for s, eps in sessions.items():
        span = max((e.end for e in eps), default=1.0) or 1.0
        chain = ["START"] + [e.label for e in eps] + ["END"]
        for rank, e in enumerate(eps):
            ncount[e.label] += 1
            nsess[e.label].add(s)
            npersess[e.label][s] += 1
            nmem[e.label].extend(e.members)
            nonset[e.label].append(e.start / span)
            nrank[e.label].append(rank / max(1, len(eps) - 1))
            head_of.setdefault(e.label,
                               e.head.get("action") or e.head.get("raw_action"))
            if getattr(e, "repeats", 1) > 1:
                nloop[e.label] += getattr(e, "repeats") - 1
        for x, y in zip(chain, chain[1:]):
            ecount[(x, y)] += 1
            esess[(x, y)].add(s)
            epersess[(x, y)][s] += 1

    # thin: an edge must be reproducible, or be a START/END anchor
    # Support thresholds measure REPRODUCIBILITY. With one session there is
    # nothing to reproduce, so thinning would just delete the person's actual
    # sequence. Keep everything.
    if n_sessions < 2:
        kept = dict(ecount)
    else:
        kept = {k: v for k, v in ecount.items()
                if len(esess[k]) >= cfg.min_edge_sessions
                or v >= cfg.min_edge_count
                or k[0] == "START" or k[1] == "END"}
    dropped = {k: v for k, v in ecount.items() if k not in kept}

    # ── reconnect ──────────────────────────────────────────────────────────
    # Having "no isolated node" is not enough for a Markov chain. Thinning left
    # P01_R01 with every node touching an edge, yet START could reach only 9 of
    # 12 nodes: every arrival at mix(drinks) came from a different predecessor,
    # so all of them were single-observation edges and all were dropped. A
    # chain you cannot walk from START to END is not a chain.
    #
    # So connectivity is enforced in the direction that matters:
    #   (a) every node must be REACHABLE FROM START
    #   (b) END must be REACHABLE FROM every node
    # Each repair restores the strongest edge that was actually observed and
    # marks it `restored`, so the canvas can draw it dashed. Nothing is
    # invented — these edges happened, they were only too rare to survive the
    # support threshold.
    restored = set()

    def _reach(edge_set, seeds, forward=True):
        adj = collections.defaultdict(list)
        for (a, b) in edge_set:
            adj[a if forward else b].append(b if forward else a)
        seen, stack = set(seeds), list(seeds)
        while stack:
            for nxt in adj[stack.pop()]:
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    all_ids = set(ncount) | {"START", "END"}

    def _repair(forward):
        """forward=True: pull unreachable nodes toward START.
           forward=False: push dead ends toward END."""
        for _ in range(len(all_ids) + 1):
            good = _reach(kept.keys(), {"START"} if forward else {"END"}, forward)
            missing = all_ids - good
            if not missing:
                return
            # Prefer the strongest dropped edge that joins the good set.
            best, best_v = None, -1
            for (a, b), v in sorted(dropped.items(), key=lambda kv: (-kv[1], kv[0])):
                if (a, b) in kept:
                    continue
                joins = (a in good and b in missing) if forward \
                    else (b in good and a in missing)
                if joins and v > best_v:
                    best, best_v = (a, b), v
            if best is None:
                return                      # genuinely unreachable; report it
            kept[best] = ecount[best]
            restored.add(best)
            # If connectivity forces us to show one exit from a state, show
            # every equally-supported exit from it. Otherwise the choice
            # between two identical single-observation edges is made by the
            # order the repairs happen to run — and the reader sees one lone
            # arrow marked P = 0.50 with no visible sibling. Siblings are
            # restored together so the drawn probabilities out of that state
            # add up.
            src, tgt = best
            for (a, b), v in list(dropped.items()):
                if (a, b) in kept:
                    continue
                same_exit = forward and a == src and v == best_v
                same_entry = (not forward) and b == tgt and v == best_v
                if same_exit or same_entry:
                    kept[(a, b)] = ecount[(a, b)]
                    restored.add((a, b))

    _repair(forward=True)
    _repair(forward=False)

    # ── per-session repair ─────────────────────────────────────────────────
    # Reachability from START is not enough. Thinning keeps edges that MANY
    # sessions took, so a step only one session visited can end up with no
    # edge carrying that session's count — and when the user highlights that
    # session the node has nothing attached and reads as isolated. On
    # P03_R03 session 4 that stranded `grind beans`, even though she plainly
    # did it: boil kettle -> grind beans -> fill v60 filter.
    #
    # So for each session, walk its own sequence and restore the minimum set
    # of observed edges needed to keep its path connected.
    session_repairs = set()
    for s_i, eps in sessions.items():
        chain = ["START"] + [e.label for e in eps] + ["END"]
        has_out = {a for (a, b) in kept if epersess[(a, b)].get(s_i)}
        has_in = {b for (a, b) in kept if epersess[(a, b)].get(s_i)}
        for a, b in zip(chain, chain[1:]):
            if (a, b) in kept:
                continue
            if a in has_out and b in has_in:
                continue                 # this session already has a way through
            kept[(a, b)] = ecount.get((a, b), 1)
            restored.add((a, b))
            session_repairs.add((a, b))
            has_out.add(a)
            has_in.add(b)

    # Collapsing adjacent repeats into a count made self-loops invisible: the
    # graph reported "0 self-loop" while the data held plenty. A repeat is a
    # transition from a state to itself and belongs in the chain, including in
    # the denominator of the outgoing probabilities.
    for label, n_rep in nloop.items():
        if n_rep > 0:
            kept[(label, label)] = n_rep
            ecount.setdefault((label, label), n_rep)
            for s_i, eps in sessions.items():
                if any(e.label == label and getattr(e, "repeats", 1) > 1
                       for e in eps):
                    esess[(label, label)].add(s_i)
                    epersess[(label, label)][s_i] += 1

    out_total = collections.Counter()
    for (src, _), v in kept.items():
        out_total[src] += v

    nodes = []
    for label in list(ncount) + ["START", "END"]:
        special = label in ("START", "END")
        onsets = nonset.get(label) or [0.0 if label == "START" else 1.0]
        ranks = nrank.get(label) or [0.0 if label == "START" else 1.0]
        # Colour needs a verb it can look up. Episode labels carry one —
        # press(appliances) -> "press". Step labels are recipe wording such as
        # "pour foam in coffee", which matches no verb key, so every step node
        # fell back to the default grey. For those, use the commonest verb
        # CATEGORY of the actions inside, which is a real property of the node.
        if "(" in label:
            verb = label.split("(")[0]
        elif nmem.get(label):
            verb = collections.Counter(
                m["_vcat"] for m in nmem[label]).most_common(1)[0][0]
        else:
            verb = label
        nodes.append({
            "id": label,
            "key": label,
            "label": label,
            "isSpecial": special,
            "count": ncount.get(label, n_sessions),
            "support": len(nsess.get(label, set())) or n_sessions,
            "support_fraction": round((len(nsess.get(label, set())) or n_sessions)
                                      / n_sessions, 3),
            "n_sessions": n_sessions,
            # START and END are sentinels, not observed actions, so they have
            # no per-session tally of their own. applyHighlightState() decides
            # membership with per_session_counts[i] > 0, so without this they
            # fade out of every single-session path — the anchors disappear
            # exactly when the path most needs them.
            "per_session_counts": ({s: 1 for s in range(n_sessions)} if special
                                   else dict(npersess.get(label, {}))),
            "salient": True,
            "is_primary": True,
            "median_rank": round(sorted(ranks)[len(ranks) // 2], 4),
            "mean_onset": round(sum(onsets) / len(onsets), 4),
            "self_loop": nloop.get(label, 0),
            "n_raw_actions": len(nmem.get(label, [])),
            "verbs": dict(collections.Counter(m["_vkey"] for m in nmem.get(label, []))),
            "objects": dict(collections.Counter(m["_nkey"] for m in nmem.get(label, []))),
            "verb": verb,
            # A rolled-up label such as clean(utensils) can be far vaguer than
            # what actually happened — that node's head action was wash(filter).
            # Carrying the head and the top objects means the vague label is
            # never the only description available.
            # An episode is NAMED AFTER its head action, so reporting it
            # explains where the label came from. A step node is named by the
            # annotator; its "head" is only whichever step-tagged action
            # happened to anchor the bucket, so reporting it invents a claim
            # the data does not make. Steps get the commonest action inside
            # instead, which is a real property of the node.
            #
            # Keyed on the LAYER, not on whether the label contains a bracket:
            # a step label such as "add garlic (crushed)" would slip through a
            # string test and start claiming a head action again.
            "head_action": head_of.get(label) if layer == "episode" else None,
            "top_action": (collections.Counter(
                (m.get("action") or m.get("raw_action"))
                for m in nmem.get(label, [])).most_common(1)[0][0]
                if nmem.get(label) else None),
            "top_objects": [o for o, _ in collections.Counter(
                m["_nkey"] for m in nmem.get(label, [])).most_common(4)],
            "n_occurrences": len(nmem.get(label, [])) and ncount.get(label, 0),
        })
    # Prof. Lin, 22 May: nodes sharing an x-column read as "these happened at
    # the same time". computeRankLayout() bins on median_rank, so equal ranks
    # collapse into one column. Re-spread them evenly over their observed
    # order, breaking ties by onset, so every node gets its own column.
    nodes.sort(key=lambda n: (n["median_rank"], n["mean_onset"], n["id"]))
    real = [n for n in nodes if not n["isSpecial"]]
    for i, n in enumerate(real):
        n["median_rank"] = round((i + 1) / (len(real) + 1), 5)
    for n in nodes:
        if n["id"] == "START":
            n["median_rank"] = 0.0
        elif n["id"] == "END":
            n["median_rank"] = 1.0
    nodes.sort(key=lambda n: n["median_rank"])

    links = []
    for (src, tgt), v in kept.items():
        sup = len(esess[(src, tgt)])
        links.append({
            "source": src, "target": tgt,
            "key": f"{src}|||{tgt}",
            "pairKey": f"{src}|||{tgt}",
            "count": v,
            "support": sup,
            "support_fraction": round(sup / n_sessions, 3),
            "n_sessions": n_sessions,
            "per_session_counts": dict(epersess[(src, tgt)]),
            "probability": round(v / out_total[src], 4) if out_total[src] else 0.0,
            "is_self_loop": src == tgt,
            "is_return": False,          # set below from node order
            "is_bridged": False,         # episodes replace bridges entirely
            "is_bridge_edge": False,
            "is_introduced": False,      # nothing is fabricated, by construction
            "restored": (src, tgt) in restored,
            # Kept only so one session's own walk stays connected. Faint in the
            # merged view, full strength when that session is highlighted.
            "session_only": (src, tgt) in session_repairs,
            # Why this edge is in the graph at all:
            #   reproducible – passed the support / repeat threshold
            #   anchor       – a START or END edge
            #   connectivity – restored so the merged chain stays walkable
            #   session_path – restored so one session's own path stays whole
            "kept_reason": (
                "anchor" if src == "START" or tgt == "END"
                else "session_path" if (src, tgt) in session_repairs
                else "connectivity" if (src, tgt) in restored
                else "reproducible"),
            "weak": v < cfg.min_edge_count,
            "evidence": "weak" if v <= 1 else ("moderate" if v <= 3 else "strong"),
        })

    order = {n["id"]: i for i, n in enumerate(nodes)}
    for l in links:
        if not l["is_self_loop"]:
            l["is_return"] = order.get(l["source"], 0) > order.get(l["target"], 0)

    report = {
        "layer": layer,
        "sessions": n_sessions,
        "nodes": len(nodes),
        "edges": len(links),
        "out_degree": round(len(links) / max(1, len(nodes)), 2),
        "edges_dropped": len(dropped),
        "edges_restored": len(restored),
        "edges_kept_for_single_session": len(session_repairs),
        "fabricated_edges": 0,
        "reachable_from_start": len(_reach(kept.keys(), {"START"}, True)),
        "can_reach_end": len(_reach(kept.keys(), {"END"}, False)),
        "total_states": len(all_ids),
        "isolated_nodes": sum(1 for n in nodes
                              if n["id"] not in {x for l in links
                                                 for x in (l["source"], l["target"])}),
        "raw_actions_covered": sum(len(v) for v in nmem.values()),
    }
    return {"nodes": nodes, "links": links}, report


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def build(recipe_id, graphs_dir, narr_dir, cfg):
    rdir = Path(graphs_dir) / recipe_id
    files = sorted(rdir.glob("session_*_full.json"),
                   key=lambda p: int(p.stem.split("_")[1]))
    if not files:
        raise SystemExit(f"no session_*_full.json in {rdir}")

    vmap, nmap = load_taxonomy(narr_dir)
    docs, per = [], {}
    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        acts = [a for a in d["sequence"]
                if a.get("kind", "action") == "action" and a.get("start") is not None]
        scoped, span = task_span(acts, d)
        docs.append((f, d, span, len(acts), len(scoped)))
        per[int(f.stem.split("_")[1])] = scoped

    n_sessions = len(per)
    sessions = {s: segment(l, vmap, nmap, cfg, session=s) for s, l in per.items()}
    sessions = apply_rollup(sessions, cfg)
    sessions = fold_one_offs(sessions, cfg)

    print(f"{'session':>8}{'actions':>9}{'in span':>9}{'episodes':>10}{'coverage':>10}")
    for (f, d, span, n_all, n_sc) in docs:
        s = int(f.stem.split("_")[1])
        cov = sum(len(e.members) for e in sessions[s])
        print(f"{s:>8}{n_all:>9}{n_sc:>9}{len(sessions[s]):>10}"
              f"{str(cov) + '/' + str(n_sc):>10}")

    # per-session payloads
    session_payloads = []
    for (f, d, span, _, _) in docs:
        s = int(f.stem.split("_")[1])
        g, rep = graph_from({s: sessions[s]}, cfg, 1)
        payload = {
            "recipe": d["recipe"], "videos": d["videos"], "steps": d.get("steps", []),
            "step_windows": d.get("step_windows"),
            "session_index": s,
            "task_span": span,
            # The GRAPH reads `sequence` — one row per episode.
            "sequence": episode_sequence(sessions[s]),
            # The BARCODE, SWIMLANE and TIMELINE read `raw_sequence` — every
            # original action, untouched. Those views answer "when did things
            # happen and for how long", which is a question about raw timing,
            # not about graph states. Grouping actions into episodes is a
            # change to the graph's vocabulary and must not reach them.
            "raw_sequence": d["sequence"],
            "graph": g,
            "episode_report": rep,
            **likely_path_block(g["nodes"], g["links"], {s: sessions[s]}),
            "expansions": build_expansions({s: sessions[s]}),
        }
        out = rdir / f"session_{s}_episode.json"
        out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        session_payloads.append((s, payload))
        print(f"  ✓ {out.name}  ({rep['nodes']} nodes, {rep['edges']} edges)")

    # merged payload
    g, rep = graph_from(sessions, cfg, n_sessions)
    merged = {
        "recipe": docs[0][1]["recipe"],
        "videos": [v for (_, d, _, _, _) in docs for v in d["videos"]],
        "steps": docs[0][1].get("steps", []),
        "n_sessions": n_sessions,
        "sequence": episode_sequence(sessions[min(sessions)]),
        "raw_sequence": docs[0][1]["sequence"],
        "graph": g,
        "episode_report": rep,
    }
    spine = spine_with_verdict(session_payloads, g["nodes"], g["links"],
                               layer="episode")
    merged.update(spine)
    merged.update(likely_path_block(g["nodes"], g["links"], sessions))
    merged["expansions"] = build_expansions(sessions)
    # app.js reads the spine from payload.analysis (that is where
    # 8_aggregate_sessions.py puts it), so mirror it there as well.
    merged.setdefault("analysis", {}).update(spine)
    out = rdir / "merged_episode.json"
    out.write_text(json.dumps(merged, indent=1), encoding="utf-8")

    print(f"\n  ✓ {out.name}")
    for k, v in rep.items():
        print(f"      {k:<22} {v}")
    print(f"      spine  {merged['canonical_spine_report']['verdict']}")
    print(f"             {merged['canonical_spine_report']['headline']}")

    # ---- the step layer, same mechanism, coarser anchors -------------------
    step_sessions, step_payloads = {}, []
    for (f, d, span, _, _) in docs:
        si = int(f.stem.split("_")[1])
        step_sessions[si] = step_segment(per[si], d.get("steps", []),
                                         vmap, nmap, session=si)
    if any(step_sessions.values()):
        for si, eps in step_sessions.items():
            gg, rr = graph_from({si: eps}, cfg, 1, layer="step")
            raw = next(d for (f, d, _, _, _) in docs
                       if int(f.stem.split("_")[1]) == si)["sequence"]
            p = {"recipe": docs[0][1]["recipe"], "videos": docs[0][1]["videos"],
                 "steps": docs[0][1].get("steps", []), "session_index": si,
                 "sequence": episode_sequence(eps), "raw_sequence": raw,
                 "graph": gg, "episode_report": rr,
                 **likely_path_block(gg["nodes"], gg["links"], {si: eps}),
                 "expansions": build_expansions({si: eps})}
            (rdir / f"session_{si}_step.json").write_text(
                json.dumps(p, indent=1), encoding="utf-8")
            step_payloads.append((si, p))
        gs, reps = graph_from(step_sessions, cfg, n_sessions, layer="step")
        mstep = {"recipe": docs[0][1]["recipe"],
                 "videos": merged["videos"],
                 "steps": docs[0][1].get("steps", []),
                 "n_sessions": n_sessions,
                 "sequence": episode_sequence(step_sessions[min(step_sessions)]),
                 "raw_sequence": docs[0][1]["sequence"],
                 "graph": gs, "episode_report": reps}
        sp = spine_with_verdict(step_payloads, gs["nodes"], gs["links"],
                                layer="step")
        mstep.update(sp)
        mstep.update(likely_path_block(gs["nodes"], gs["links"], step_sessions))
        mstep["expansions"] = build_expansions(step_sessions)
        mstep.setdefault("analysis", {}).update(sp)
        (rdir / "merged_step.json").write_text(json.dumps(mstep, indent=1),
                                               encoding="utf-8")
        print(f"\n  ✓ merged_step.json  ({reps['nodes']} nodes, "
              f"{reps['edges']} edges, out-deg {reps['out_degree']})")
        print(f"      spine  {mstep['canonical_spine_report']['verdict']}")
        print(f"             {mstep['canonical_spine_report']['headline']}")
        note = compare_layers({
            "episode": merged["canonical_spine_report"],
            "step": mstep["canonical_spine_report"]})
        if note:
            print(f"\n  >> {note}")
        # tell the dashboard where to open
        default = "episode" if rep["nodes"] <= 30 else "step"
        (rdir / "default_layer.json").write_text(
            json.dumps({"default_layer": default,
                        "episode_nodes": rep["nodes"],
                        "step_nodes": reps["nodes"]}, indent=1), encoding="utf-8")
        print(f"  default_layer -> {default}")
    if rep["out_degree"] > 2.0:
        print("  ! out-degree above 2.0 — canvas will be hard to read.")
    if rep["nodes"] > 30:
        print("  ! more than 30 nodes — open the dashboard on the step layer.")
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recipe_id")
    ap.add_argument("--graphs-dir", default="../outputs/graphs")
    ap.add_argument("--narrations-dir", default="../narrations-and-action-segments")
    ap.add_argument("--max-members", type=int, default=8)
    ap.add_argument("--min-edge-sessions", type=int, default=2)
    a = ap.parse_args()
    cfg = Config(max_members=a.max_members,
                 min_edge_sessions=a.min_edge_sessions)
    print("=" * 70)
    print(f"EPISODE GRAPH — {a.recipe_id}")
    print("=" * 70)
    build(a.recipe_id, a.graphs_dir, a.narrations_dir, cfg)


if __name__ == "__main__":
    main()