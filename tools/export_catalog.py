#!/usr/bin/env python3
"""Flatten the catalogue into one plain row per book: both scores side by side.

`pick_score` is what actually chose the bank — Gutenberg metadata only, no
popularity signal. `downloads_30d` is the real-world readership the picker never
saw. Reading the two columns together is the point of this file.

CSV for spreadsheets, JSON for tooling. Same rows, same order.
"""

from __future__ import annotations

import csv
import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from pick_catalog import literature_score  # noqa: E402  the picker's own metric

SRC = ROOT / "book_popularity.json"
CATALOG = ROOT / ".pg-meta-cache" / "pg_catalog.csv.gz"
FIELDS = ["rank", "gutenberg", "title", "author", "downloads_30d", "pick_score",
          "locc", "shelves", "pg_issued", "language", "source", "coffees", "slug"]


def catalog_rows() -> dict[int, dict]:
    """LoCC/Bookshelves per Gutenberg id, to recompute the picker's score.

    Note the catalogue carries no publication year at all — `Issued` is the day
    Gutenberg posted the text, which is why every auto-picked book has year 0.
    """
    if not CATALOG.exists():
        return {}
    out = {}
    with gzip.open(CATALOG, "rt", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            try:
                out[int(row["Text#"])] = row
            except (ValueError, KeyError):
                continue
    return out


def main() -> None:
    rows = json.loads(SRC.read_text(encoding="utf-8"))
    rows.sort(key=lambda r: -(r["downloads30"] or -1))
    catalog = catalog_rows()
    out = []
    for i, r in enumerate(rows, 1):
        meta = catalog.get(r["gutenberg"], {})
        locc = meta.get("LoCC") or ""
        shelves = meta.get("Bookshelves") or ""
        out.append({
            "rank": i,
            "gutenberg": r["gutenberg"],
            "title": r["title"],
            "author": r["author"],
            # None means the page gave no figure — kept distinct from 0.
            "downloads_30d": r["downloads30"] if r["downloads30"] is not None else "",
            "pick_score": literature_score(locc, shelves) if meta else "",
            "locc": locc,
            "shelves": shelves,
            "pg_issued": meta.get("Issued") or "",
            "language": ",".join(r["languages"]) or "",
            "source": "hand-picked" if r["tier"] == "curated" else "auto-scored",
            "coffees": r.get("coffees") or "",
            "slug": r["slug"],
        })

    with (ROOT / "catalog.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(out)
    (ROOT / "catalog.json").write_text(
        json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(out)} books -> tools/catalog.csv, tools/catalog.json")


if __name__ == "__main__":
    main()
