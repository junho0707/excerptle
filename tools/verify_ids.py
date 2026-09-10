#!/usr/bin/env python3
"""Catch ids whose text is not the book the list says it is.

Two ways the pool acquires a wrong id, both fatal to a puzzle -- the answer it
accepts is not the book on screen:

  mislabelled  the id belongs to a *different work by the same author* that the
               pool also knows about. Gutenberg 2264 is Macbeth, but the join
               had it down as The Taming of the Shrew, and 2263 is Julius
               Caesar, not Richard III: a run of the 22xx Shakespeare series
               was off by one work.
  collection   the id is an omnibus or a numbered volume ("The Works of Edgar
               Allan Poe -- Volume 1" standing in for The Mystery of Marie
               Roget), so the excerpt opens on whatever the volume opens on.

A mislabelled id is retitled, not dropped: the text is a real book, just not
the one the join named, so calling it what Gutenberg calls it puts the right
answer on screen (2264 becomes Macbeth) and lets the dedupe collapse it against
whatever other id carries the same work. A collection is dropped outright --
there is no single book behind it.

Everything else that differs is edition drift -- "Notre-Dame de Paris" for The
Hunchback of Notre-Dame, "The Princess of Cleves" for La Princesse de Cleves --
which is what `variants()` in js/match.js exists to absorb. Those are left
alone; only the two classes above are written to bad_ids.json.

  python3 tools/verify_ids.py            # check the shipped lists
  python3 tools/verify_ids.py --pool     # check every playable candidate
  python3 tools/verify_ids.py --pool --write   # ... and write bad_ids.json
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from build_pd_dataset import norm  # noqa: E402
from final_lists import same_book, title_key  # noqa: E402

CATALOG = ROOT / ".pg-meta-cache" / "pg_catalog.csv.gz"
OUT = ROOT / "bad_ids.json"

COLLECTION = re.compile(
    r"(\bthe (complete )?works of\b|\bcomplete works\b|\bvolume\s+[ivxlc\d]|"
    r"\bvol\.?\s*[ivxlc\d]|\(of \d+\)|\bcollected (works|poems|stories)\b)", re.I)


def catalogue() -> dict[int, dict]:
    with gzip.open(CATALOG, "rt", encoding="utf-8") as f:
        return {int(r["Text#"]): r for r in csv.DictReader(f) if r["Text#"].isdigit()}


def surname(author: str) -> str:
    a = (author or "").split("&")[0].split(";")[0]
    a = a.split(",")[0] if "," in a else a
    return norm(a).split(" ")[-1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", action="store_true")
    ap.add_argument("--write", action="store_true", help="write bad_ids.json")
    args = ap.parse_args()

    cat = catalogue()
    if args.pool:
        from final_lists import build_pool, known, playable  # noqa: PLC0415
        rows = [r for r in build_pool().values() if playable(r) and known(r)]
    else:
        rows = []
        for name in ("final_bank", "final_dailies"):
            rows += json.loads((ROOT / f"{name}.json").read_text(encoding="utf-8"))
    print(f"{len(rows)} rows to check")

    # What else the pool believes each author wrote, so a swapped id can be
    # recognised as *another book we know*, not merely a different title.
    by_author: dict[str, set[str]] = {}
    for r in rows:
        by_author.setdefault(surname(r.get("author") or ""), set()).add(title_key(r["title"]))

    bad, drift = [], []
    for r in rows:
        c = cat.get(int(r["gutenberg"]))
        if not c:
            continue
        actual = (c["Title"] or "").replace("\n", " ").strip()
        if same_book(title_key(r["title"]), title_key(actual)):
            continue
        if COLLECTION.search(actual):
            bad.append((r, actual, "drop",
                        "collection: the id is an omnibus or a numbered volume"))
            continue
        others = by_author.get(surname(r.get("author") or ""), set()) - {title_key(r["title"])}
        if any(same_book(title_key(actual), o) for o in others):
            bad.append((r, actual, "retitle",
                        "mislabelled: the id is a different work by the same author"))
            continue
        drift.append((r, actual))

    for r, actual, action, why in bad:
        print(f"  {action:<7} g{r['gutenberg']:<6} {r['title'][:40]:<40} -> {actual[:40]:<40} {why.split(':')[0]}")
    print(f"\n{len(bad)} wrong ids "
          f"({sum(1 for b in bad if b[2] == 'drop')} dropped, "
          f"{sum(1 for b in bad if b[2] == 'retitle')} retitled), "
          f"{len(drift)} edition-title drift (left alone)")

    if args.write:
        old = {int(x["gutenberg"]): x for x in json.loads(OUT.read_text(encoding="utf-8"))} \
            if OUT.exists() else {}
        for r, actual, action, why in bad:
            old[int(r["gutenberg"])] = {"gutenberg": int(r["gutenberg"]), "action": action,
                                        "title_claimed": r["title"], "title_actual": actual,
                                        "reason": why}
        OUT.write_text(json.dumps(sorted(old.values(), key=lambda x: x["gutenberg"]),
                                  indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {len(old)} ids to {OUT}")


if __name__ == "__main__":
    main()
