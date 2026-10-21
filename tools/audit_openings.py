#!/usr/bin/env python3
"""Score every puzzle's opening for non-narrative front matter.

Reads puzzles/*.json in play order (puzzles/index.json) and prints the likeliest
glossaries, contents pages, prefaces, transcriber notes and dedications first.
The score is a triage aid, not a verdict: read the hits (see opening_audit.md),
then fix real ones with an entry in anchors.json and a rebuild.

    python3 tools/audit_openings.py [--min=3] [--all]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "puzzles"

# Words that only turn up at the front of a book. Each is worth 3 at most once.
FRONT_WORDS_RE = re.compile(
    r"\b(glossary|contents|illustrations|list of|preface|foreword|introduction|"
    r"transcriber|editor'?s note|errata|dedicat\w*|inscribed to|copyright|"
    r"all rights reserved|e-?text|produced by|illustrated by|edition|volume [ivx\d]+|"
    r"table of|index|appendix|footnotes?|bibliograph\w*|notes?:)\b",
    re.I,
)
# A common-verb stand-in: narrative has plenty of these, term lists have none.
VERB_RE = re.compile(
    r"\b(was|were|is|are|had|has|have|did|do|does|said|says|went|came|saw|made|took|"
    r"found|knew|felt|thought|looked|asked|began|stood|sat|ran|walked|could|would|"
    r"should|will|been|being|be)\b",
    re.I,
)
# Openings that only make sense after something else was read.
MIDBOOK_RE = re.compile(r"\b(?:previous|preceding|last|foregoing) (?:chapter|book|volume|section)\b", re.I)
# A bracketed author's/editor's note, or a cast line ("VILLAGERS from ...").
NOTE_RE = re.compile(r"^\s*\[(?:note|the following|author|editor|translator)|^\s*[A-Z]{4,}S\s+(?:from|of|in)\b", re.I)
# A scripture epigraph standing alone: one archaic quotation, nobody "said" it.
EPIGRAPH_RE = re.compile(
    r"^\s*[\"\u201c](?=[^\"\u201d]{20,200}[\"\u201d]\s*$)[^\"\u201d]*\b(?:ye|thee|thou|thy|hath|unto|hereunto)\b",
    re.I)
DEFINITION_RE = re.compile(r"\b[A-Z][\w'-]+\s+(?:A|An|The|To)\s+[a-z]")
DASH_DEF_RE = re.compile(r"\w\s*(?:--|—)\s*[A-Za-z]")


def score(text: str) -> tuple[int, list[str]]:
    """Return (score, reasons). Higher means more like front matter."""
    s, why = 0, []
    words = text.split()
    n = len(words)
    if n < 8:
        return 0, why
    for name, rx in (("midbook", MIDBOOK_RE), ("note/cast", NOTE_RE)):
        if rx.search(text[:300]):
            s += 4
            why.append(name)
    # "To my father" / "TO THE READER" as a whole opening, not mid-sentence.
    hit = FRONT_WORDS_RE.search(text) or re.match(r"\s*to\s+(?:my|the|his|her)\s+\w+\s*$", text[:60], re.I)
    if hit:
        s += 3
        why.append(f"front-word:{hit.group(0).lower().strip()}")
    # Title-Case runs: three or more capitalised words in a row, several times.
    caps = [bool(re.match(r"^[\"'“(]?[A-Z]", w)) for w in words]
    ratio = sum(caps) / n
    if ratio > 0.45:
        s += 3
        why.append(f"title-case:{ratio:.2f}")
    elif ratio > 0.33:
        s += 1
        why.append(f"title-case:{ratio:.2f}")
    # Term + capitalised gloss pairs ("Billy A tin pail", "Blokes Guys").
    defs = len(DEFINITION_RE.findall(text))
    if defs >= 2:
        s += min(2 + defs, 6)
        why.append(f"term-gloss x{defs}")
    dashes = len(DASH_DEF_RE.findall(text))
    # Narrative is full of dashes too; only count them where verbs are scarce.
    if dashes >= 3 and len(VERB_RE.findall(text)) / n < 0.04:
        s += 2
        why.append(f"dash-defs x{dashes}")
    if n < 25:  # too short to measure density: the one-line openingSentence
        return s, why
    verbs = len(VERB_RE.findall(text)) / n
    if verbs < 0.015:
        s += 3
        why.append(f"verbs:{verbs:.3f}")
    elif verbs < 0.03:
        s += 1
        why.append(f"verbs:{verbs:.3f}")
    # Sentence-final punctuation per word: lists and headings have almost none.
    stops = len(re.findall(r"[.!?][\"'”’)]?(?:\s|$)", text)) / n
    if stops < 0.02:
        s += 2
        why.append(f"stops:{stops:.3f}")
    # Short lines of few words each, as a flattened list leaves behind.
    lines = [ln for ln in text.split("\n") if ln.strip()]
    if len(lines) >= 4 and sum(len(ln.split()) for ln in lines) / len(lines) < 6:
        s += 2
        why.append("short-lines")
    return s, why


def sentence_flags(sentence: str) -> tuple[int, list[str]]:
    """openingSentence is too short for density rules; only look for shape."""
    if EPIGRAPH_RE.match(sentence):
        return 4, ["epigraph"]
    return score(sentence)


def main() -> None:
    floor = 3
    for a in sys.argv[1:]:
        if a.startswith("--min="):
            floor = int(a.split("=", 1)[1])
    if "--all" in sys.argv:
        floor = -1
    order = json.loads((OUT / "index.json").read_text(encoding="utf-8"))["order"]
    rows = []
    for i, slug in enumerate(order):
        p = json.loads((OUT / f"{slug}.json").read_text(encoding="utf-8"))
        # Worst of the three places an opening shows up.
        best = (0, [])
        for text in (p["texts"][0], p.get("openingExcerpt") or ""):
            sc = score(text)
            if sc[0] > best[0]:
                best = sc
        sc = sentence_flags(p.get("openingSentence") or "")
        if sc[0] > best[0]:
            best = sc
        if best[0] > floor:
            first = " ".join((p.get("openingExcerpt") or p["texts"][0]).split())[:120]
            rows.append((best[0], i, slug, p["title"], first, best[1]))
    rows.sort(key=lambda r: (-r[0], r[1]))
    for sc, i, slug, title, first, why in rows:
        print(f"{i:4d}  {slug:<8}  {title[:40]:<40}  {sc:2d}  {first!r}  [{', '.join(why)}]")
    print(f"{len(rows)} of {len(order)} openings scored above {floor}", file=sys.stderr)


if __name__ == "__main__":
    main()
