#!/usr/bin/env python3
"""Show which catalogue books survive a popularity cut.

Reads book_popularity.json (from fetch_downloads.py) and reports, for a set of
candidate thresholds, how much of the bank is left and what falls out.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ROWS = json.loads((ROOT / "book_popularity.json").read_text(encoding="utf-8"))

CUTS = (100, 250, 500, 1000, 2000, 5000)


def english(r: dict) -> bool:
    return r["languages"] == ["en"]


def main() -> None:
    total = len(ROWS)
    missing = [r for r in ROWS if r["downloads30"] is None]
    non_en = [r for r in ROWS if r["languages"] and not english(r)]
    live = [r for r in ROWS if r["downloads30"] is not None and english(r)]
    live.sort(key=lambda r: -r["downloads30"])

    print(f"catalogue: {total} books "
          f"({sum(1 for r in ROWS if r['tier'] == 'curated')} curated, "
          f"{sum(1 for r in ROWS if r['tier'] == 'auto')} auto)")
    print(f"no count fetched: {len(missing)}   not English-only: {len(non_en)}")
    for r in non_en:
        print(f"   drop (lang {','.join(r['languages'])}): {r['slug']} {r['title']}")
    print()

    counts = [r["downloads30"] for r in live]
    mid = counts[len(counts) // 2]
    print(f"downloads/30d — max {counts[0]}, median {mid}, min {counts[-1]}")
    print()
    print(f"{'cut':>6} {'survive':>8} {'%':>5} {'curated lost':>13}")
    for cut in CUTS:
        keep = [r for r in live if r["downloads30"] >= cut]
        lost_curated = [r for r in live if r["downloads30"] < cut and r["tier"] == "curated"]
        print(f"{cut:>6} {len(keep):>8} {100*len(keep)//total:>4}% {len(lost_curated):>13}")
    print()

    print("top 15:")
    for r in live[:15]:
        print(f"  {r['downloads30']:>7}  {r['title'][:52]:<52} {r['author'][:24]}")
    print("\nbottom 15:")
    for r in live[-15:]:
        print(f"  {r['downloads30']:>7}  {r['title'][:52]:<52} {r['author'][:24]}")

    if len(sys.argv) > 1:
        cut = int(sys.argv[1])
        keep = [r for r in live if r["downloads30"] >= cut]
        out = ROOT / f"survivors_{cut}.json"
        out.write_text(json.dumps(keep, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"\nwrote {len(keep)} survivors at cut {cut} to {out}")


if __name__ == "__main__":
    main()
