#!/usr/bin/env python3
"""Recover English editions for candidates whose Gutenberg link is foreign.

Wikidata's P2034 often points at the original-language text -- Madame Bovary
resolves to the French edition -- so a title-matching pass over Gutenberg's own
catalogue finds the English translation, which is what the game needs. The
catalogue is already on disk, so this costs no requests.
"""

from __future__ import annotations

import csv
import difflib
import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from curate_bank import load, narrative  # noqa: E402
from pick_catalog import catalog_author  # noqa: E402
from build_pd_dataset import norm  # noqa: E402

CATALOG = ROOT / ".pg-meta-cache" / "pg_catalog.csv.gz"
OUT = ROOT / "english_editions.json"


def surname(author: str | None) -> str:
    return norm((author or "").split("&")[0]).split(" ")[-1] if author else ""


def main() -> None:
    rows = load()
    foreign = [r for r in rows if r["status"] == "new" and r["languages"] != ["en"]]
    print(f"{len(foreign)} candidates whose Gutenberg edition is not English")

    # Index the English catalogue by exact title and by author surname. An
    # English edition is often retitled ("The Red and the Black: A Chronicle of
    # 1830"), so the author index is what actually finds most of them.
    by_title: dict[str, list[dict]] = {}
    by_surname: dict[str, list[dict]] = {}
    with gzip.open(CATALOG, "rt", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("Type") != "Text" or (row.get("Language") or "") != "en":
                continue
            t = norm((row.get("Title") or "").split("\n")[0])
            if t:
                by_title.setdefault(t, []).append(row)
            sn = surname(catalog_author(row.get("Authors") or ""))
            if sn:
                by_surname.setdefault(sn, []).append(row)

    def title_of(row: dict) -> str:
        return norm((row.get("Title") or "").split("\n")[0])

    def similar(a: str, b: str) -> float:
        if not a or not b:
            return 0.0
        if a == b or a.startswith(b) or b.startswith(a):
            return 1.0
        return difflib.SequenceMatcher(None, a, b).ratio()

    found, missed = [], []
    for r in foreign:
        want = norm(r["title"])
        # Wikidata titles carry disambiguators like "The Big Four (novel)".
        for tag in (" novel", " book", " play", " poem"):
            if want.endswith(tag):
                want = want[: -len(tag)].strip()
        sn = surname(r["author"])
        pick, how, score = None, "", 0.0

        exact = by_title.get(want, [])
        if exact:
            same = [c for c in exact if sn and sn in norm(catalog_author(c.get("Authors") or ""))]
            pool = same or exact
            # Lowest id tends to be Gutenberg's long-standing main edition.
            pick, how, score = min(pool, key=lambda c: int(c["Text#"])), "title" + ("+author" if same else ""), 1.0

        if pick is None and sn:
            best, best_score = None, 0.0
            for c in by_surname.get(sn, []):
                sc = similar(want, title_of(c))
                if sc > best_score:
                    best, best_score = c, sc
            # 0.72 keeps "The Red and the Black" -> "The Red and the Black: A
            # Chronicle of 1830" while rejecting a different book by the author.
            if best is not None and best_score >= 0.72:
                pick, how, score = best, "author+fuzzy", best_score

        if pick:
            found.append({**r, "en_gutenberg": int(pick["Text#"]),
                          "en_title": (pick.get("Title") or "").split("\n")[0].strip(),
                          "en_author": catalog_author(pick.get("Authors") or ""),
                          "match": how, "match_score": round(score, 3)})
        else:
            missed.append(r)

    OUT.write_text(json.dumps(found, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"found an English edition for {len(found)}; no match for {len(missed)}")
    print("\nrecovered (first 20):")
    for r in found[:20]:
        print(f"  {r['title'][:34]:<34} -> pg{r['en_gutenberg']:<7} {r['en_title'][:32]:<32} [{r['match']} {r['match_score']}]")
    print("\nno English edition found (first 10):")
    for r in missed[:10]:
        print(f"  {r['title'][:44]:<44} {r['languages']}")


if __name__ == "__main__":
    main()
