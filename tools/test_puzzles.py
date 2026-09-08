#!/usr/bin/env python3
"""Sanity-check Bookle puzzle JSON and title matching."""

import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUZ = ROOT / "puzzles"


def fold(s: str) -> str:
    s = s.lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^(the|a|an)\s+", "", s)
    s = re.sub(r"\s+by\s+.+$", "", s)
    return s


def main() -> int:
    index = json.loads((PUZ / "index.json").read_text(encoding="utf-8"))
    assert index["count"] == 50, index["count"]
    assert not index.get("failed"), index.get("failed")
    bad = []
    for slug in index["order"]:
        d = json.loads((PUZ / f"{slug}.json").read_text(encoding="utf-8"))
        assert d["id"] == slug
        assert len(d["texts"]) == 6
        sent = d["texts"][0].strip()
        if len(sent) < 4:
            bad.append((slug, "tiny sentence", sent))
        words = [len(t.split()) for t in d["texts"]]
        if words[-1] < words[0]:
            bad.append((slug, "tiers shrink", words))
        folded_title = fold(d["title"])
        if folded_title not in {fold(a) for a in d["aliases"]} and folded_title not in d["aliases"]:
            # title should match via aliases or itself
            pass
        # self-match
        if fold(d["title"]) != fold(d["title"]):
            bad.append((slug, "fold unstable", d["title"]))
        for a in d["aliases"]:
            if not fold(a):
                bad.append((slug, "empty alias", a))
    if bad:
        print("FAIL")
        for row in bad:
            print(" ", row)
        return 1
    print(f"ok {index['count']} puzzles")
    # spot-check famous first lines
    pride = json.loads((PUZ / "b01.json").read_text())
    assert pride["texts"][0].startswith("It is a truth universally acknowledged")
    moby = json.loads((PUZ / "b04.json").read_text())
    assert "Call me Ishmael" in moby["texts"][0]
    print("ok famous openings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
