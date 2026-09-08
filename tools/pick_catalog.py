#!/usr/bin/env python3
"""Pick ~1000 English Gutenberg texts for the Bookle gamebank."""

from __future__ import annotations

import csv
import gzip
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXISTING = json.loads((ROOT / "books.json").read_text(encoding="utf-8"))
HAVE = {int(b["gutenberg"]) for b in EXISTING}

SKIP_TITLE = (
    "complete works", "collected works", "anthology", "index of",
    "gutenberg", "dictionary", "encyclopedia", "bible, the",
    "the bible", "quran", "koran", "book of mormon",
    "congressional", "periodical", "magazine", "journal of",
    "volume ii", "volume iii", "vol. 2", "vol. 3",
    "audio", "librivox", "copyright",
)
SKIP_SUBJECT = (
    "computer", "software", "programming", "juvenile -- periodical",
)


def ok_title(t: str) -> bool:
    low = t.lower()
    if len(t) < 4 or len(t) > 80:
        return False
    return not any(s in low for s in SKIP_TITLE)


def main() -> None:
    src = Path("/tmp/pg_catalog.csv.gz")
    rows = []
    with gzip.open(src, "rt", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("Type") != "Text":
                continue
            if (row.get("Language") or "") != "en":
                continue
            try:
                gid = int(row["Text#"])
            except ValueError:
                continue
            if gid in HAVE:
                continue
            title = (row.get("Title") or "").split("\n")[0].strip()
            if not ok_title(title):
                continue
            subj = (row.get("Subjects") or "").lower()
            if any(s in subj for s in SKIP_SUBJECT):
                continue
            locc = row.get("LoCC") or ""
            shelves = row.get("Bookshelves") or ""
            authors = (row.get("Authors") or "").split(";")[0].strip()
            # prefer literature
            score = 0
            if locc.startswith("P") or " PR" in f" {locc}" or locc.startswith("PR") or locc.startswith("PS") or locc.startswith("PZ"):
                score += 5
            if "Fiction" in shelves or "Literature" in shelves:
                score += 4
            if "Bestsellers" in shelves:
                score += 6
            if "Adventure" in shelves or "Gothic" in shelves or "Mystery" in shelves:
                score += 2
            year = None
            issued = row.get("Issued") or ""
            rows.append((score, gid, title, authors, issued, shelves))

    rows.sort(key=lambda r: (-r[0], r[1]))
    picked = []
    seen_titles = {b["title"].lower() for b in EXISTING}
    n = 1
    for score, gid, title, authors, issued, shelves in rows:
        key = title.lower()
        if key in seen_titles:
            continue
        seen_titles.add(key)
        slug = f"g{gid}"
        author = authors.split(",")[0].strip() if authors else "Unknown"
        # invert last-name, first-name if needed
        if authors.count(",") == 1 and not authors.lower().startswith("anonymous"):
            last, first = [x.strip() for x in authors.split(",", 1)]
            first = first.split(",")[0]
            # drop years
            import re
            first = re.sub(r"\d{4}.*", "", first).strip(" ,")
            last = re.sub(r"\d{4}.*", "", last).strip(" ,")
            if first:
                author = f"{first} {last}".strip()
        aliases = [title]
        if title.lower().startswith("the "):
            aliases.append(title[4:])
        if title.lower().startswith("a "):
            aliases.append(title[2:])
        picked.append({
            "slug": slug,
            "gutenberg": gid,
            "title": title,
            "author": author or "Unknown",
            "year": 0,
            "coffees": 2 if score < 5 else 1,
            "aliases": aliases,
            "anchor": "",
        })
        if len(picked) >= 950:
            break
        n += 1

    out = ROOT / "extra_books.json"
    out.write_text(json.dumps(picked, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(picked)} extras to {out}")


if __name__ == "__main__":
    main()
