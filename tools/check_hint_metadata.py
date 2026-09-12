#!/usr/bin/env python3
"""Report the reviewed facts still needed before building hint-version 2 puzzles.

Curators add facts to hint_metadata.json, keyed by a stable id such as g1342:
{"g1342": {"genre": "Novel of manners", "setting": "England, early 19th century"}}
The builder can seed genre from the catalogue, but it intentionally never
guesses a setting from a title or opening passage.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"


def main() -> int:
    books = json.loads((TOOLS / "final_bank.json").read_text()) + json.loads((TOOLS / "final_dailies.json").read_text())
    path = TOOLS / "hint_metadata.json"
    facts = json.loads(path.read_text()) if path.exists() else {}
    dates = json.loads((TOOLS / "publication_dates.json").read_text())
    missing = []
    for book in books:
        key = f"g{book['gutenberg']}"
        entry = facts.get(key, {})
        genre = str(entry.get("genre") or book.get("genre") or "").strip()
        setting = str(entry.get("setting") or "").strip()
        if not genre or not setting:
            missing.append((key, book["title"], "genre" if not genre else "setting"))
        if not (dates.get(key, {}).get("year") or book.get("year")):
            missing.append((key, book["title"], "publication date"))
    for key, title, field in missing:
        print(f"{key}\t{field}\t{title}")
    print(f"{len(books) - len(missing)}/{len(books)} ready; {len(missing)} facts still need review")
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
