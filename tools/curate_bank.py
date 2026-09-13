#!/usr/bin/env python3
"""Rank the whole pool -- books you have plus public-domain books you don't --
on one metric, and cut a curated bank.

Everything here is public domain: the bank is Gutenberg-sourced by
construction, and the candidates come from a Wikidata query bounded at
publication year <= 1930. So the cut is about fame and shape, not rights.

Ranking metric is Gutenberg downloads in the last 30 days, fetched for every
book on both sides, so a newcomer and an incumbent are compared on the same
number. Wikipedia sitelinks ride along as a second opinion.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".pd-cache"

# P7937 "form" values that can carry a five-step excerpt ladder. A collection
# counts: the bank's #4 book, The Adventures of Sherlock Holmes, is one.
NARRATIVE_FORMS = {
    "novel", "novella", "novelette", "epistolary novel", "short story",
    "short story collection", "narration", "prose", "Erzählung",
    "collection of fairy tales", "autobiography", "memoir",
}
NON_NARRATIVE_FORMS = {
    "play", "poem", "poetry collection", "ballad", "Lied", "drama",
    "picture book", "anthology", "letter", "conversation", "essay",
}
NON_NARRATIVE_GENRES = {"poetry", "essay", "non-fiction", "drama", "philosophy"}

FIELDS = ["rank", "status", "gutenberg", "title", "author", "year",
          "downloads_30d", "sitelinks", "form", "genre", "wikipedia", "slug"]


def load() -> list[dict]:
    bank = json.loads((ROOT / "book_popularity.json").read_text(encoding="utf-8"))
    cands = json.loads((ROOT / "candidate_downloads.json").read_text(encoding="utf-8"))
    sitelinks = json.loads((CACHE / "sitelinks.json").read_text(encoding="utf-8"))
    forms = json.loads((CACHE / "forms.json").read_text(encoding="utf-8"))
    works = json.loads((CACHE / "works.json").read_text(encoding="utf-8"))
    by_gid = {int(w["gutenberg"]): w for w in works if w.get("gutenberg")}

    years = {}
    for fname in ("books.json", "extra_books.json"):
        for b in json.loads((ROOT / fname).read_text(encoding="utf-8")):
            years[b["slug"]] = b.get("year") or None

    rows = []
    for b in bank:
        gid = int(b["gutenberg"])
        w = by_gid.get(gid)
        qid = w["wikidata"] if w else None
        f = forms.get(qid or "", {})
        rows.append({
            "status": "have",
            "gutenberg": gid,
            "title": b["title"],
            "author": b["author"],
            "year": (w or {}).get("year") or years.get(b["slug"]) or "",
            "downloads_30d": b["downloads30"],
            "sitelinks": sitelinks.get(qid or "", ""),
            "form": ";".join(f.get("forms", [])),
            "genre": ";".join(f.get("genres", [])),
            "wikipedia": "yes" if qid else "no",
            "slug": b["slug"],
            "languages": b.get("languages") or [],
        })
    seen_gids = {r["gutenberg"] for r in rows}
    for c in cands:
        if int(c["gutenberg"]) in seen_gids:
            continue
        seen_gids.add(int(c["gutenberg"]))
        qid = c["wikidata"]
        f = forms.get(qid, {})
        rows.append({
            "status": "new",
            "gutenberg": int(c["gutenberg"]),
            "title": c["title"],
            "author": c.get("author") or "",
            "year": c.get("year") or "",
            "downloads_30d": c.get("downloads30"),
            "sitelinks": sitelinks.get(qid, ""),
            "form": ";".join(f.get("forms", [])),
            "genre": ";".join(f.get("genres", [])),
            "wikipedia": "yes",
            "slug": f"g{c['gutenberg']}",
            "languages": c.get("pg_languages") or [],
        })

    # Candidates whose Wikidata link pointed at a foreign-language edition,
    # re-pointed at Gutenberg's English one (see find_english_editions.py).
    en_path = ROOT / "english_editions.json"
    if en_path.exists():
        for e in json.loads(en_path.read_text(encoding="utf-8")):
            gid = int(e["en_gutenberg"])
            if gid in seen_gids:
                continue
            seen_gids.add(gid)
            rows.append({**{k: e[k] for k in
                            ("status", "title", "author", "year", "sitelinks",
                             "form", "genre", "wikipedia")},
                         "gutenberg": gid,
                         "downloads_30d": e.get("downloads30"),
                         "languages": e.get("pg_languages") or [],
                         "slug": f"g{gid}"})
    return rows


def narrative(r: dict) -> bool:
    """Long-form narrative only. Unknown shape passes: a book already in the
    bank has a built puzzle, so it demonstrably had enough text."""
    forms = {x for x in r["form"].split(";") if x}
    genres = {x for x in r["genre"].split(";") if x}
    if forms:
        return bool(forms & NARRATIVE_FORMS) or not (forms & NON_NARRATIVE_FORMS)
    if genres & NON_NARRATIVE_GENRES:
        return False
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=600)
    args = ap.parse_args()

    rows = load()
    total = len(rows)
    # The PG page states the text's own language; a bank of English excerpts
    # needs the English edition, translation or not.
    english = [r for r in rows if r["languages"] == ["en"]]
    scored = [r for r in english if r["downloads_30d"] is not None and narrative(r)]
    scored.sort(key=lambda r: (-(r["downloads_30d"] or 0), -(r["sitelinks"] or 0)))
    keep = scored[:args.size]
    for i, r in enumerate(keep, 1):
        r["rank"] = i

    with (ROOT / "curated_bank.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(keep)
    (ROOT / "curated_bank.json").write_text(
        json.dumps(keep, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    have = [r for r in keep if r["status"] == "have"]
    new = [r for r in keep if r["status"] == "new"]
    dropped = [r for r in rows if r["status"] == "have" and r not in keep]
    print(f"pool: {total} books ({sum(1 for r in rows if r['status']=='have')} yours, "
          f"{sum(1 for r in rows if r['status']=='new')} candidates)")
    print(f"  non-English edition dropped: {total - len(english)}")
    print(f"  non-narrative or no count dropped: {len(english) - len(scored)}")
    print(f"curated bank: {len(keep)}  ({len(have)} kept from yours, {len(new)} new)")
    print(f"  your books cut: {len(dropped)}")
    print(f"  download floor at rank {len(keep)}: {keep[-1]['downloads_30d']}")
    print(f"\nwrote curated_bank.csv / .json")


if __name__ == "__main__":
    main()
