#!/usr/bin/env python3
"""Flag puzzles whose opening is probably not the opening.

The slicer starts a book at the first prose under the first chapter heading.
That is right most of the time and wrong in recognisable ways: it lands on a
preface, a dedication, a table-of-contents line, or a stanza. This lists the
ones worth a human eye, worst first, so the reserve pool can replace them.
"""

import datetime as dt
import json
import re
import sys
from pathlib import Path

# The daily pool is finite: past the last one, `slugForIndex` wraps and serves
# book #1 again under a new daily number. That must be a decision, not a
# surprise, so the build fails while there is still time to curate more.
RUNWAY_DAYS = 30

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "puzzles"

APPARATUS = re.compile(
    r"gutenberg|transcrib|proofread|this (?:e-?text|edition|volume|translation)|"
    r"the (?:author|editor|translator|publisher) (?:of|gives|makes|ventures|wishes)|"
    r"preface|foreword|introduction|dedicat|copyright|is the final volume|"
    r"first published|in preparing this|the present (?:edition|translation|volume)",
    re.I,
)


def suspects(p: dict) -> list[str]:
    out = []
    first = (p["texts"][0] or "").strip()
    words = first.split()
    if not first:
        out.append("empty opening")
        return out
    if first[0].islower():
        out.append("starts mid-sentence")
    if len(words) < 4:
        out.append(f"opening is {len(words)} words")
    if APPARATUS.search(first):
        out.append("reads like front matter")
    if first.startswith(("Chap.", "Chapter", "CHAPTER", "ARGUMENT")):
        out.append("starts on a heading")
    tiers = p["texts"]
    if len(set(tiers)) < len(tiers):
        out.append("ladder repeats a tier")
    counts = [len(t.split()) for t in tiers]
    if counts != sorted(counts):
        out.append("ladder shrinks")
    if counts[-1] < 400:
        out.append(f"last tier only {counts[-1]} words")
    # A treatise and a novel are told apart by whether anybody speaks. Some
    # real novels open on pure narration, so this flags for review rather than
    # condemning: it is how the essays and the philosophy get spotted.
    long_text = tiers[-1]
    if len(long_text.split()) > 800:
        quotes = sum(long_text.count(c) for c in '"\u201c')
        speech = len(re.findall(r"\b(said|says|asked|replied|answered|cried|"
                                r"whispered|shouted|murmured)\b", long_text, re.I))
        if quotes == 0 and speech == 0:
            out.append("no dialogue in the opening pages")
    return out


def last_new_daily(index: dict) -> dt.date:
    """The date of the final daily before the pool wraps and books repeat."""
    order, presets = index["order"], min(index.get("presetCount") or len(index["order"]), len(index["order"]))
    pool = max(len(order) - presets, 0)
    return dt.date.fromisoformat(index["startDate"]) + dt.timedelta(days=pool - 1)


def main() -> int:
    index = json.loads((OUT / "index.json").read_text(encoding="utf-8"))
    rows = []
    for i, slug in enumerate(index["order"]):
        f = OUT / f"{slug}.json"
        if not f.exists():
            rows.append((99, slug, i, "MISSING FILE", ""))
            continue
        p = json.loads(f.read_text(encoding="utf-8"))
        flags = suspects(p)
        if flags:
            where = f"daily #{i}" if i >= index["dailyStartIndex"] else f"bank #{i}"
            rows.append((len(flags), slug, i, f"{p['title']} — {'; '.join(flags)}",
                         p["texts"][0][:100].replace("\n", " ")))
    rows.sort(key=lambda r: (-r[0], r[2]))
    for _, slug, i, what, sample in rows:
        where = "daily" if i >= index["dailyStartIndex"] else "bank "
        print(f"{where} #{i:<4} {slug:>8}  {what}")
        if sample:
            print(f"{'':>21}{sample!r}")
    print(f"\n{len(rows)} of {len(index['order'])} flagged", flush=True)
    if index.get("failed"):
        print(f"{len(index['failed'])} failed to build")
    last = last_new_daily(index)
    left = (last - dt.date.today()).days
    print(f"daily pool: {left} days left (the last new daily falls on {last.isoformat()})")
    if left < RUNWAY_DAYS:
        print(f"FAIL: fewer than {RUNWAY_DAYS} days of unused dailies remain — "
              "add books to the pool, reshuffle each cycle, or stop the daily deliberately")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
