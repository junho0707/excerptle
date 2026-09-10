#!/usr/bin/env python3
"""Sanity-check Excerptle puzzle JSON against the shipped index."""

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUZ = ROOT / "puzzles"
TIERS = 5

# A handful of openings everybody knows. If the slicer drifts back into the
# front matter, these are the first things to break.
FAMOUS = {
    "g1342": "It is a truth universally acknowledged",
    "g2701": "Call me Ishmael",
    "g98": "It was the best of times",
    "g1399": "Happy families are all alike",
    "g4300": "Stately, plump Buck Mulligan",
    "g11": "Alice was beginning to get very tired",
}


def fold(s: str) -> str:
    s = s.lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return re.sub(r"^(the|a|an)\s+", "", s)


def main() -> int:
    index = json.loads((PUZ / "index.json").read_text(encoding="utf-8"))
    order = index["order"]
    bad = []

    if len(order) != index["count"] or len(set(order)) != len(order):
        bad.append(("index", "order is not a unique list of count entries", len(order)))
    if index["dailyStartIndex"] != index["presetCount"]:
        bad.append(("index", "dailies must start where the bank ends",
                    (index["presetCount"], index["dailyStartIndex"])))
    if index.get("failed"):
        bad.append(("index", "books failed to build", index["failed"]))

    for slug in order:
        f = PUZ / f"{slug}.json"
        if not f.exists():
            bad.append((slug, "no puzzle file", ""))
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        if d["id"] != slug:
            bad.append((slug, "id does not match its filename", d["id"]))
        if len(d["texts"]) != TIERS or len(d["labels"]) != TIERS:
            bad.append((slug, "wrong number of tiers", len(d["texts"])))
            continue
        if len(set(d["texts"])) != TIERS:
            bad.append((slug, "two tiers are identical", ""))
        words = [len(t.split()) for t in d["texts"]]
        if words != sorted(words):
            bad.append((slug, "tiers shrink", words))
        if len(d["texts"][0].strip()) < 4:
            bad.append((slug, "opening sentence is empty", d["texts"][0]))
        if not fold(d["title"]):
            bad.append((slug, "title folds to nothing", d["title"]))
        for a in d.get("aliases") or []:
            if not fold(a):
                bad.append((slug, "empty alias", a))

    for slug, opening in FAMOUS.items():
        f = PUZ / f"{slug}.json"
        if not f.exists():
            bad.append((slug, "famous book missing from the catalogue", ""))
            continue
        got = json.loads(f.read_text(encoding="utf-8"))["texts"][0]
        if opening not in got:
            bad.append((slug, f"opening should contain {opening!r}", got[:80]))

    if bad:
        print("FAIL")
        for row in bad:
            print(" ", row)
        return 1
    print(f"ok {len(order)} puzzles, {index['presetCount']} bank + {index['dailyPoolCount']} dailies")
    print(f"ok {len(FAMOUS)} famous openings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
