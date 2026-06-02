"""
7_build_manifest.py

Scans outputs/graphs/ for processed recipes and writes manifest.json
that the dashboard reads to populate its recipe and session dropdowns.

Run AFTER 6_prepare_dashboard_data.py and (optionally) 8_aggregate_sessions.py.

Manifest format:
{
  "generated_at": "...",
  "recipes": [
    {
      "id": "P01_R01",
      "name": "Nespresso",
      "sessions": [ {index, video_id, action_count, duration_s, ...}, ... ],
      "has_merged": true,
      "merged": {                       // present only if has_merged
        "modes": ["full", "smart", "abstracted"],
        "node_count": 142,              // from merged_smart.json
        "link_count": 198,
        "n_sessions": 3
      }
    }
  ]
}
"""

import argparse
import json
import re
from datetime import datetime
from pathlib import Path


def scan_per_session_files(recipe_dir):
    """Scan session_{N}_smart.json files. Returns list of session descriptors."""
    sessions = []
    pattern = re.compile(r"^session_(\d+)_smart\.json$")

    for f in sorted(recipe_dir.iterdir()):
        m = pattern.match(f.name)
        if not m:
            continue
        session_idx = int(m.group(1))

        try:
            with open(f, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
        except Exception as e:
            print(f"  ⚠ Could not read {f.name}: {e}")
            continue

        recipe_info = payload.get("recipe", {})
        seq = payload.get("sequence", [])
        nodes = payload.get("graph", {}).get("nodes", [])

        if not seq:
            print(f"  ⚠ {f.name} has empty sequence — skipping.")
            continue

        full_path = recipe_dir / f"session_{session_idx}_full.json"
        abstracted_path = recipe_dir / f"session_{session_idx}_abstracted.json"
        if not full_path.exists() or not abstracted_path.exists():
            print(f"  ⚠ Session {session_idx} missing companion files; including anyway.")

        duration_s = seq[-1].get("end", 0.0) if seq else 0.0
        primary = sum(1 for n in nodes if n.get("is_primary"))
        secondary = len(nodes) - primary

        sessions.append({
            "index": session_idx,
            "video_id": recipe_info.get("video_id", ""),
            "video_path": recipe_info.get("video_path", ""),
            "action_count": len(seq),
            "duration_s": round(float(duration_s), 2),
            "node_count": len(nodes),
            "primary_count": primary,
            "secondary_count": secondary,
        })

    return sessions


def scan_merged_files(recipe_dir):
    """
    Detect which merged_*.json files exist. Returns a dict suitable for the
    manifest's 'merged' block, or None if no merged files exist.
    """
    modes = ["full", "smart", "abstracted"]
    available = [m for m in modes if (recipe_dir / f"merged_{m}.json").exists()]
    if not available:
        return None

    # Read summary stats from the smart variant (preferred), fall back to first available
    canonical_mode = "smart" if "smart" in available else available[0]
    canonical_path = recipe_dir / f"merged_{canonical_mode}.json"

    try:
        with open(canonical_path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception as e:
        print(f"  ⚠ Could not read {canonical_path.name}: {e}")
        return None

    nodes = payload.get("graph", {}).get("nodes", [])
    links = payload.get("graph", {}).get("links", [])
    recipe_info = payload.get("recipe", {})

    # Quick support distribution (how many nodes appear in all sessions vs only one)
    n_sessions = recipe_info.get("n_sessions", 0)
    support_in_all = sum(1 for n in nodes if n.get("support") == n_sessions)
    support_in_one = sum(1 for n in nodes if n.get("support") == 1)

    return {
        "modes": available,
        "node_count": len(nodes),
        "link_count": len(links),
        "n_sessions": n_sessions,
        "support_in_all": support_in_all,
        "support_in_one": support_in_one,
    }


def build_manifest(graphs_dir):
    graphs_path = Path(graphs_dir)
    if not graphs_path.exists():
        raise FileNotFoundError(f"Graphs directory not found: {graphs_path}")

    recipes = []
    for entry in sorted(graphs_path.iterdir()):
        if not entry.is_dir():
            continue

        print(f"\nScanning {entry.name}/")
        sessions = scan_per_session_files(entry)
        if not sessions:
            print(f"  ⚠ No per-session files in {entry.name}/ — skipping.")
            continue

        # Recipe name from first session
        first_smart = entry / f"session_{sessions[0]['index']}_smart.json"
        recipe_name = entry.name
        try:
            with open(first_smart, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
                recipe_name = payload.get("recipe", {}).get("name", entry.name)
        except Exception:
            pass

        merged_info = scan_merged_files(entry)

        recipe_entry = {
            "id": entry.name,
            "name": recipe_name,
            "sessions": sessions,
            "has_merged": merged_info is not None,
        }
        if merged_info is not None:
            recipe_entry["merged"] = merged_info

        recipes.append(recipe_entry)

        merged_note = (
            f" + merged ({merged_info['node_count']} nodes, {merged_info['n_sessions']} sessions)"
            if merged_info else ""
        )
        print(f"  ✓ {entry.name} — {len(sessions)} session(s){merged_note}")

    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "recipes": recipes,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Build manifest.json by scanning outputs/graphs/"
    )
    parser.add_argument("--outputs-dir", default="../outputs")
    args = parser.parse_args()

    graphs_dir = Path(args.outputs_dir) / "graphs"
    manifest = build_manifest(graphs_dir)

    manifest_path = graphs_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    total_sessions = sum(len(r["sessions"]) for r in manifest["recipes"])
    n_merged = sum(1 for r in manifest["recipes"] if r.get("has_merged"))
    print("\n" + "=" * 80)
    print(f"MANIFEST WRITTEN → {manifest_path}")
    print(f"  Recipes: {len(manifest['recipes'])}")
    print(f"  Total sessions: {total_sessions}")
    print(f"  Recipes with merged data: {n_merged}")
    print("=" * 80)


if __name__ == "__main__":
    main()