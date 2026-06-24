#!/usr/bin/env python3
"""
fix_step_labels_encoding.py

One-off repair: re-save an existing step_labels.json as clean UTF-8.

Your current file was written with Windows-1252 "smart quotes" (e.g. the curly
apostrophe in "It's", byte 0x92), which is not valid UTF-8 and crashed the
loader. This reads the file with a tolerant encoding and rewrites it as UTF-8 so
every downstream tool can read it.

USAGE:
  python fix_step_labels_encoding.py path/to/step_labels.json

  # makes a backup at step_labels.json.bak, then overwrites with UTF-8.
"""

import json
import shutil
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        print("usage: python fix_step_labels_encoding.py path/to/step_labels.json")
        sys.exit(1)

    path = Path(sys.argv[1])
    if not path.exists():
        print(f"ERROR: {path} not found")
        sys.exit(1)

    data = None
    used = None
    for enc in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            with open(path, encoding=enc) as f:
                data = json.load(f)
            used = enc
            break
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue

    if data is None:
        print("ERROR: could not decode the file in any known encoding.")
        sys.exit(1)

    print(f"Decoded {len(data)} entries using '{used}'.")

    backup = path.with_suffix(path.suffix + ".bak")
    shutil.copy2(path, backup)
    print(f"Backup written to {backup}")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"Re-saved {path} as UTF-8. Done.")


if __name__ == "__main__":
    main()