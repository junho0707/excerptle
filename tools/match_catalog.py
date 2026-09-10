#!/usr/bin/env python3
"""Find Gutenberg texts for works whose Wikidata record has no P2034.

Only 1,181 of the 8,415 public-domain works carry a Gutenberg id in Wikidata,
but the property being empty says nothing about whether Gutenberg has the book
-- Middlemarch, War and Peace and Uncle Tom's Cabin are all on Gutenberg with
no P2034. Matching titles against Gutenberg's own catalogue recovers them, at
no request cost, since the catalogue is already on disk.
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
from build_pd_dataset import norm  # noqa: E402
from pick_catalog import catalog_author, ok_title  # noqa: E402

CATALOG = ROOT / ".pg-meta-cache" / "pg_catalog.csv.gz"
OUT = ROOT / "matched_works.json"
THRESHOLD = 0.80  # stricter than the translation pass: no language cue to lean on


def surname(author: str | None) -> str:
    return norm((author or "").split("&")[0]).split(" ")[-1] if author else ""


def clean_title(t: str) -> str:
    n = norm(t)
    for tag in (" novel", " book", " play", " poem", " short story", " dante"):
        if n.endswith(tag):
            n = n[: -len(tag)].strip()
    return n


def main() -> None:
    works = json.loads((ROOT / ".pd-cache" / "works.json").read_text(encoding="utf-8"))
    todo = [w for w in works if not w.get("gutenberg")]
    print(f"{len(todo)} works with no Gutenberg id in Wikidata")

    by_surname: dict[str, list[dict]] = {}
    by_title: dict[str, list[dict]] = {}
    with gzip.open(CATALOG, "rt", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("Type") != "Text" or (row.get("Language") or "") != "en":
                continue
            title = (row.get("Title") or "").split("\n")[0].strip()
            if not ok_title(title):  # drops indexes, dictionaries, periodicals
                continue
            by_title.setdefault(norm(title), []).append(row)
            sn = surname(catalog_author(row.get("Authors") or ""))
            if sn:
                by_surname.setdefault(sn, []).append(row)

    def title_of(row: dict) -> str:
        return norm((row.get("Title") or "").split("\n")[0])

    found, missed = [], []
    for w in todo:
        want = clean_title(w["title"] or "")
        sn = surname(w.get("author"))
        pick, how, score = None, "", 0.0

        exact = [c for c in by_title.get(want, [])
                 if not sn or sn in norm(catalog_author(c.get("Authors") or ""))]
        if exact:
            pick, how, score = min(exact, key=lambda c: int(c["Text#"])), "title+author", 1.0
        elif sn:
            best, best_score = None, 0.0
            for c in by_surname.get(sn, []):
                t = title_of(c)
                sc = 1.0 if (t == want or t.startswith(want + " ")) else \
                    difflib.SequenceMatcher(None, want, t).ratio()
                # Prefer the lower id when two editions tie.
                if sc > best_score or (sc == best_score and best and int(c["Text#"]) < int(best["Text#"])):
                    best, best_score = c, sc
            if best is not None and best_score >= THRESHOLD:
                pick, how, score = best, "author+fuzzy", best_score

        if pick:
            found.append({**w, "gutenberg": int(pick["Text#"]),
                          "pg_title": (pick.get("Title") or "").split("\n")[0].strip(),
                          "pg_author": catalog_author(pick.get("Authors") or ""),
                          "match": how, "match_score": round(score, 3)})
        else:
            missed.append(w)

    OUT.write_text(json.dumps(found, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"matched {len(found)} to a Gutenberg text; {len(missed)} still unmatched")
    exact_n = sum(1 for r in found if r["match"] == "title+author")
    print(f"  exact title+author: {exact_n}   fuzzy: {len(found) - exact_n}")
    print("\nnotable recoveries:")
    for name in ("Middlemarch", "War and Peace", "Uncle Tom", "Room with a View",
                 "Grimm", "Iliad", "Odyssey", "Anna Karenina", "Wuthering"):
        for r in found:
            if name.lower() in (r["title"] or "").lower():
                print(f"  {r['title'][:34]:<34} -> pg{r['gutenberg']:<7} {r['pg_title'][:34]:<34} [{r['match']} {r['match_score']}]")
                break


if __name__ == "__main__":
    main()
