#!/usr/bin/env python3
"""Classify every shipped book by what Wikipedia's lead sentence calls it.

Wikidata carries no form or genre for 256 of the 595 bank rows, so the strays
that survived the cut -- a dictionary of jokes, a treatise on money markets, a
book of criticism -- cannot be found from the metadata already on disk. The
lead sentence of the English Wikipedia article names the form outright ("is an
1897 novel by", "is a long poem", "is a treatise"), which is the signal the
pipeline was missing.

Reads final_bank.json + final_dailies.json (or, with --pool, every playable
candidate, so the lists can be re-cut without a stray taking the freed slot),
and writes:
  .pd-cache/wiki_extracts.json   raw lead extracts, so re-runs cost nothing
  form_verdicts.json             {gutenberg id: narrative|non-narrative|unknown}
  form_review.txt                every book the lead sentence calls non-narrative
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".pd-cache" / "wiki_extracts.json"
OUT = ROOT / "form_review.txt"
VERDICTS = ROOT / "form_verdicts.json"
API = "https://en.wikipedia.org/w/api.php"
UA = "excerptle-catalog/1.0 (junhoyoon00@gmail.com)"
BATCH = 20

# What the lead sentence calls a book. Narrative words win over non-narrative
# ones when both appear ("a novel in the form of a series of letters").
# Verse is checked first and beats everything: "narrative poem" and "epic in
# verse" are poems, and a poem collapses the hint ladder -- tiers 2-5 come out
# identical, which is why the five verse titles in unusable.json were pulled.
VERSE = ["poem", "poetry", "verse", "sonnet", "ballad", "ode", "elegy", "hymn",
         "song", "epic poem", "book of poetry", "collection of poems"]

NARRATIVE = [
    "novel", "novella", "short story", "short-story", "story collection",
    "fairy tale", "folk tale", "romance", "adventure story", "detective story",
    "ghost story", "children's book", "picture book", "fable", "saga", "epic",
    "play", "comedy", "tragedy", "drama", "tale", "narrative", "memoir",
    "autobiography", "biography", "travelogue",
]
NON_NARRATIVE = [
    "essay", "essays", "treatise", "textbook", "dictionary", "lexicon",
    "encyclopedia", "manual", "handbook", "guide", "pamphlet", "manifesto",
    "speech", "lecture", "sermon", "letter", "letters",
    "catalogue", "bibliography", "anthology of poetry", "study", "monograph",
    "criticism", "philosophical work", "work of philosophy", "cookbook",
    "constitution", "report", "almanac", "grammar", "primer",
]
# Only the unambiguous form words get a second pass over the whole intro. A
# word like "speech" or "report" is ordinary prose vocabulary once you are past
# the lead sentence -- it called Dickens's Uncommercial Traveller non-narrative.
SECOND_PASS = {"essay", "essays",
               "treatise", "textbook", "dictionary", "encyclopedia", "manual",
               "manifesto", "pamphlet", "sermon", "lecture", "criticism",
               "monograph", "philosophical work", "work of philosophy",
               "study", "cookbook", "almanac", "grammar", "primer"}

# A lead sentence that only says "is a book by X" names no form. The rest of
# the intro usually gives the subject away instead, and a subject like
# aesthetics or political economy is as disqualifying as the word "treatise".
SUBJECTS = [
    "non-fiction", "nonfiction", "anthropological", "anthropology",
    "aesthetics", "political economy", "economics", "theology", "theological",
    "psychoanalysis", "sociological", "polemic", "apologetics", "jurisprudence",
    "trial attorneys", "law students", "art criticism", "literary criticism",
    "biblical", "scientific work", "self-help", "how to", "reference work",
    "political philosophy", "history book", "work of history", "pseudohistor",
    "pseudoarchaeolog", "pseudoscien", "collection of articles",
    "collection of songs", "collection of essays",
]

# Words that read as a form but are not one here.
STOP = re.compile(r"\bin the (form|style) of\b", re.I)


def fetch(titles: list[str]) -> dict[str, str]:
    q = "|".join(t.replace("|", " ") for t in titles)
    url = (f"{API}?action=query&format=json&redirects=1&prop=extracts"
           f"&exintro=1&explaintext=1&exlimit=20&titles={urllib.parse.quote(q)}")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as r:
        data = json.load(r)
    pages = data.get("query", {}).get("pages", {})
    got = {p["title"]: (p.get("extract") or "") for p in pages.values() if "missing" not in p}
    # redirects=1 and normalization rewrite titles; map the originals back.
    for hop in ("redirects", "normalized"):
        for h in data.get("query", {}).get(hop, []):
            if h["to"] in got:
                got[h["from"]] = got[h["to"]]
    return got


def lead(extract: str) -> str:
    """The first sentence, minus parentheticals, which are full of dates and
    foreign titles that carry form words of their own."""
    text = re.sub(r"\([^)]*\)", " ", extract or "")
    text = re.sub(r"\s+", " ", text).strip()
    m = re.search(r"(?<=[.!?])\s+(?=[A-Z])", text)
    return (text[:m.start()] if m else text)[:400]


def has(word: str, text: str) -> bool:
    """Match the word and its plural: "poems" and "stories" are how a lead
    sentence usually says it, and a bare +s misses "short stories"."""
    forms = {word, word + "s", re.sub(r"y$", "ies", word)}
    return any(re.search(rf"\b{re.escape(w)}\b", text) for w in forms)


def classify(sentence: str, rest: str = "") -> tuple[str, str]:
    s = STOP.sub(" ", " " + sentence.lower() + " ")
    hits_v = [w for w in VERSE if has(w, s)]
    if hits_v:
        return "non-narrative", ",".join(hits_v[:3])
    hits_n = [w for w in NARRATIVE if has(w, s)]
    hits_x = [w for w in NON_NARRATIVE if re.search(rf"\b{re.escape(w)}\b", s)]
    if hits_n:
        return "narrative", ",".join(hits_n[:3])
    if hits_x:
        return "non-narrative", ",".join(hits_x[:3])
    # Second pass over the whole intro, for the "is a book by X" leads.
    full = STOP.sub(" ", " " + (sentence + " " + rest).lower() + " ")
    hits_v = [w for w in VERSE if w != "song" and has(w, full)]
    if hits_v:
        return "non-narrative", ",".join(hits_v[:3])
    subj = [w for w in SUBJECTS if w in full]
    if subj:
        return "non-narrative", ",".join(subj[:3])
    hits_n = [w for w in NARRATIVE if has(w, full)]
    if hits_n:
        return "narrative", ",".join(hits_n[:3])
    hits_x = [w for w in NON_NARRATIVE
              if w in SECOND_PASS and re.search(rf"\b{re.escape(w)}\b", full)]
    if hits_x:
        return "non-narrative", ",".join(hits_x[:3])
    return "unknown", ""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", action="store_true",
                    help="classify every playable candidate, not just the shipped 715")
    args = ap.parse_args()

    books = []
    if args.pool:
        sys.path.insert(0, str(ROOT))
        from final_lists import build_pool, known, playable  # noqa: PLC0415
        for r in build_pool().values():
            if playable(r) and known(r):
                books.append(("pool", r))
    else:
        for name, kind in (("final_bank", "bank"), ("final_dailies", "daily")):
            for r in json.loads((ROOT / f"{name}.json").read_text(encoding="utf-8")):
                books.append((kind, r))
    print(f"{len(books)} books to classify")

    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    todo = [r for _, r in books if str(r["gutenberg"]) not in cache]
    print(f"{len(todo)} without a cached extract")

    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        try:
            got = fetch([b["title"] or "" for b in batch])
        except Exception as e:  # noqa: BLE001
            print(f"  batch {i} failed: {e}", file=sys.stderr)
            continue
        for b in batch:
            cache[str(b["gutenberg"])] = got.get(b["title"] or "", "")
        if i and i % 200 == 0:
            print(f"  {i}/{len(todo)}")
            CACHE.write_text(json.dumps(cache), encoding="utf-8")
        time.sleep(0.3)
    CACHE.write_text(json.dumps(cache), encoding="utf-8")

    rows = []
    for kind, r in books:
        extract = re.sub(r"\s+", " ", cache.get(str(r["gutenberg"]), "") or "")
        s = lead(extract)
        verdict, why = classify(s, extract[len(s):][:600])
        rows.append((kind, r, verdict, why, s))

    counts = {}
    for _, _, v, _, _ in rows:
        counts[v] = counts.get(v, 0) + 1
    print("  " + "  ".join(f"{k} {v}" for k, v in sorted(counts.items())))

    verdicts = json.loads(VERDICTS.read_text(encoding="utf-8")) if VERDICTS.exists() else {}
    for _, r, v, why, _ in rows:
        verdicts[str(r["gutenberg"])] = v if not why else f"{v}:{why}"
    VERDICTS.write_text(json.dumps(verdicts, indent=0, sort_keys=True), encoding="utf-8")
    print(f"wrote {len(verdicts)} verdicts to {VERDICTS}")

    lines = []
    for want in ("non-narrative", "unknown"):
        picked = [x for x in rows if x[2] == want]
        lines.append(f"===== {want}: {len(picked)} =====\n")
        for kind, r, _, why, s in picked:
            lines.append(f"[{kind}] g{r['gutenberg']} {r['title']} — {r.get('author') or '?'}"
                         f"  ({why or 'no form word'})\n    {s or '(no extract)'}\n")
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
