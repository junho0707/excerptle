#!/usr/bin/env python3
"""Resolve every row of the hand-curated excerptle_pool to a Gutenberg text.

The pool is the quality anchor -- books a general audience has plausibly read --
but its `gutenberg` column is sparse and its `us_pd` rows predate Gutenberg's
recent uploads of 1925-1930 titles. This fills in the id from Gutenberg's own
catalogue and fetches the download figure, so pool books rank beside everything
else instead of sitting outside the ranking.
"""

from __future__ import annotations

import csv
import gzip
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from build_pd_dataset import norm  # noqa: E402
from pick_catalog import catalog_author  # noqa: E402
from fetch_downloads import fetch  # noqa: E402

POOL = ROOT / "excerptle_pool.csv"
CATALOG = ROOT / ".pg-meta-cache" / "pg_catalog.csv.gz"
OUT = ROOT / "pool_resolved.json"


def surname(a: str) -> str:
    return norm((a or "").split("&")[0]).split(" ")[-1]


def main() -> None:
    pool = list(csv.DictReader(POOL.open(encoding="utf-8-sig")))
    idx: dict[str, list[dict]] = {}
    with gzip.open(CATALOG, "rt", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("Type") == "Text" and (row.get("Language") or "") == "en":
                idx.setdefault(norm((row.get("Title") or "").split("\n")[0]), []).append(row)

    out, unresolved = [], []
    for p in pool:
        gid = int(p["gutenberg"]) if p["gutenberg"] else None
        source = "csv" if gid else None
        if gid is None:
            sn = surname(p["author"])
            m = [x for x in idx.get(norm(p["title"]), [])
                 if sn and sn in norm(catalog_author(x.get("Authors") or ""))]
            if m:
                gid = min(int(x["Text#"]) for x in m)
                source = "catalogue"
        if gid is None:
            unresolved.append(p)
            out.append({**p, "gutenberg": None, "resolved": "none",
                        "downloads30": None, "pg_languages": []})
            continue
        meta = fetch(gid)  # cached; only new ids cost a request
        if not meta.get("downloads30"):
            time.sleep(0.8)
        out.append({**p, "gutenberg": gid, "resolved": source,
                    "downloads30": meta.get("downloads30"),
                    "pg_languages": meta.get("languages") or []})

    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    got = [r for r in out if r["gutenberg"]]
    print(f"pool: {len(pool)} rows")
    print(f"  resolved to a Gutenberg text: {len(got)}")
    print(f"    id already in the csv: {sum(1 for r in got if r['resolved']=='csv')}")
    print(f"    found in the catalogue: {sum(1 for r in got if r['resolved']=='catalogue')}")
    print(f"  no Gutenberg text: {len(unresolved)}")
    for p in unresolved:
        print(f"    {p['tier']}  {p['year']}  {p['title'][:38]:<38} {p['author'][:20]}")
    missing = [r for r in got if not r["downloads30"]]
    print(f"  resolved but no download figure: {len(missing)}")
    noten = [r for r in got if r["pg_languages"] and r["pg_languages"] != ["en"]]
    print(f"  resolved to a non-English text: {len(noten)}")
    for r in noten[:8]:
        print(f"    {r['title'][:38]:<38} {r['pg_languages']}")


if __name__ == "__main__":
    main()
