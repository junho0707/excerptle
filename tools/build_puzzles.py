#!/usr/bin/env python3
"""Download public-domain Gutenberg texts and emit Bookle puzzle JSON.

Each book has a verified narrative `anchor` (famous first line). We slice
the Gutenberg file from that line so TOCs, prefaces, and etext boilerplate
never become guess 1.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).parent
OUT = ROOT / "puzzles"
CACHE = HERE / ".gutenberg-cache"
# The two lists final_lists.py cuts. The bank is the pick-any catalogue; the
# dailies are held back so a daily is never a book you could already browse.
BANK_PATH = HERE / "final_bank.json"
DAILIES_PATH = HERE / "final_dailies.json"
# Hand-written aliases from the original 50-book bank, keyed by old slug.
LEGACY_ALIASES = {
    b["slug"]: b.get("aliases") or []
    for b in json.loads((HERE / "books.json").read_text(encoding="utf-8"))
}
# Hand-verified opening lines, keyed by Gutenberg id. auto_start() reads a file
# top-down and takes the first thing that looks like prose, which lands on an
# epigraph, a chapter argument or a table of contents often enough to matter.
# An anchor here overrides it: see tools/opening_audit.md for how each was found.
ANCHORS = json.loads((HERE / "anchors.json").read_text(encoding="utf-8"))
# Salt for the bank play order. Book #1 must not be the first line of the
# catalogue, and the sequence must not track Gutenberg ids.
ORDER_SALT = "excerptle-order-v1:"
WORD_CAP = 3500
PAGES_CAP = 900
UA = "BookleFyi/1.0 (public-domain excerpts for bookle.fyi)"


def load_books() -> list[dict]:
    """The shipped books, bank first, in the order they will be indexed.

    A book with an entry in anchors.json starts at that line; every other book
    falls back to auto_start(). The slug is the Gutenberg id, which is the one
    identifier that is stable across rebuilds and unique across both lists.
    """
    out = []
    for kind, path in (("bank", BANK_PATH), ("daily", DAILIES_PATH)):
        for b in json.loads(path.read_text(encoding="utf-8")):
            gid = int(b["gutenberg"])
            year = str(b.get("year") or "").strip()
            out.append({
                "slug": f"g{gid}",
                "kind": kind,
                "rank": int(b.get("rank") or 0),
                "gutenberg": gid,
                "title": b["title"],
                "author": b.get("author") or "",
                "year": int(year) if year.isdigit() else 0,
                "aliases": LEGACY_ALIASES.get(b.get("old_slug") or "", []),
                "anchor": ANCHORS.get(str(gid), ""),
            })
    seen = set()
    for b in out:
        if b["slug"] in seen:
            raise SystemExit(f"duplicate gutenberg id across the lists: {b['slug']}")
        seen.add(b["slug"])
    return out


BOOKS = load_books()

START_RE = re.compile(r"\*\*\*\s*START OF (THIS|THE) PROJECT GUTENBERG.*?\*\*\*", re.I)
END_RE = re.compile(r"\*\*\*\s*END OF (THIS|THE) PROJECT GUTENBERG.*?\*\*\*", re.I)
# Older etexts close with a bare sentence before the starred marker — and some
# carry no starred marker at all, which is how licence text reached hint 5.
END_PLAIN_RE = re.compile(
    r"^\s*end of (?:the )?project gutenberg(?:'|\u2019)?s?\b.*$", re.I | re.M)

HEADING_RE = re.compile(
    r"""^\s*(?:
        (?:CHAPTER|Chapter|STAVE|Stave|ACT|Act|SCENE|Scene|PART|Part|BOOK|Book|LETTER|Letter)
        [\s.:]+.{0,80}|
        [IVXLCDM]{1,7}\.?\s*$
    )\s*$""",
    re.X,
)

ABBREV = {
    "mr", "mrs", "ms", "dr", "st", "no", "nos", "prof", "rev", "col", "gen",
    "sgt", "capt", "jr", "sr", "vs", "etc", "vol", "ch", "pp", "jan", "feb",
    "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "p", "pp", "viz", "eg", "ie", "al", "m", "mm",
}


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = s.replace("—", "-").replace("–", "-").replace("‐", "-")
    s = s.replace("_", "")
    s = re.sub(r"\s+", " ", s)
    return s.lower()


def fold_with_map(s: str) -> tuple[str, list[int]]:
    """Fold text and remember the original index of each folded character."""
    out = []
    idx = []
    prev_space = False
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        nfd = unicodedata.normalize("NFKD", ch)
        base = "".join(c for c in nfd if not unicodedata.combining(c))
        if ch in "’‘":
            trans = "'"
        elif ch in "“”":
            trans = '"'
        elif ch in "—–‐":
            trans = "-"
        elif ch == "_":
            trans = ""
        else:
            trans = base
        trans = trans.lower()
        if not trans:
            i += 1
            continue
        if trans.isspace():
            if not prev_space and out:
                out.append(" ")
                idx.append(i)
                prev_space = True
            i += 1
            continue
        prev_space = False
        for k, tch in enumerate(trans):
            out.append(tch)
            idx.append(i)
        i += 1
    return "".join(out), idx


def fetch(gid: int) -> str:
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"{gid}.txt"
    if cached.exists() and cached.stat().st_size > 2000:
        return cached.read_text(encoding="utf-8", errors="replace")
    urls = [
        f"https://www.gutenberg.org/cache/epub/{gid}/pg{gid}.txt",
        f"https://www.gutenberg.org/files/{gid}/{gid}-0.txt",
        f"https://www.gutenberg.org/files/{gid}/{gid}.txt",
        # Older postings ship the latin-1 file only (Howards End is one).
        f"https://www.gutenberg.org/files/{gid}/{gid}-8.txt",
        f"https://www.gutenberg.org/ebooks/{gid}.txt.utf-8",
    ]
    last_err = None
    for url in urls:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = resp.read()
            text = raw.decode("utf-8", errors="replace")
            if len(text) < 1500:
                continue
            cached.write_text(text, encoding="utf-8")
            return text
        except Exception as e:  # noqa: BLE001
            last_err = e
            continue
    raise RuntimeError(f"gutenberg {gid}: {last_err}")


def strip_pg(text: str) -> str:
    # Cut the header first, then search for the footer in what is left: an
    # offset measured in the original string is meaningless once the text has
    # been re-sliced, and using it let the licence through by the length of
    # the header — invisible in a novel, but hint 5 of a short story is the
    # whole text, so it ended on the trademark notice.
    start = START_RE.search(text)
    if start:
        text = text[start.end() :]
    for pattern in (END_RE, END_PLAIN_RE):
        end = pattern.search(text)
        if end:
            text = text[: end.start()]
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\ufeff", "").strip()


def looks_like_front(p: str) -> bool:
    low = p.lower()
    if low.startswith(("produced by", "e-text prepared", "transcriber", "transcribed", "illustrated by", "author of")):
        return True
    if len(re.findall(r"\b(chapter|chap\.)\b", low)) >= 3:
        return True
    if len(re.findall(r"\b[ivxlcdm]{1,6}\.\s", low)) >= 4:
        return True
    letters = [c for c in p if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) / len(letters) > 0.72 and len(p) < 500:
        return True
    if p.count("  ") > 12 and len(p) < 600:
        return True
    return False


FRONT_LINE_RE = re.compile(
    r"^\s*(contents|table of contents|preface|introduction|dedication|foreword|"
    r"prologue|epigraph|note|author.s note|chapter|book|part|volume|stave|act|"
    r"scene|canto|section|copyright|first published|printed|new york|london)\b",
    re.I,
)
BYLINE_RE = re.compile(
    r"^\s*(by|author of|translated|illustrated|edited|adapted|with \d+|"
    r"transcribed|transcriber|produced by|e-?text|scanned|proofread|revised)\b",
    re.I,
)
ROMAN_LINE_RE = re.compile(r"^\s*[IVXLCDM]{1,7}\.?\s*$", re.I)
# Publishing apparatus can appear anywhere in the line, not just at its start.
FRONT_ANYWHERE_RE = re.compile(
    r"project gutenberg|gutenberg|e-?text|etext|transcrib|proofread|proofed|"
    r"all rights reserved|copyright|printed in|\bisbn\b|electronic edition|"
    r"distributed proofreading|online distributed",
    re.I,
)


def looks_like_prose_line(s: str) -> bool:
    """A real narrative line: long, mostly lower-case, actual sentences."""
    s = s.strip()
    if len(s) < 45:
        return False
    letters = [c for c in s if c.isalpha()]
    if len(letters) < 25:
        return False
    if sum(c.isupper() for c in letters) / len(letters) > 0.4:
        return False
    if not re.search(r"[a-z]{3}", s):
        return False
    if FRONT_LINE_RE.match(s) or BYLINE_RE.match(s) or FRONT_ANYWHERE_RE.search(s):
        return False
    if s.startswith("[") or s.count("  ") > 6:
        return False
    # Title Case Across Most Words means a heading or a contents entry.
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z'’-]*", s) if len(w) > 2]
    if len(words) >= 4:
        capped = sum(1 for w in words if w[0].isupper())
        if capped / len(words) > 0.6:
            return False
    # Illustration captions sit in quotes with no sentence punctuation.
    if s[0] in "\"“" and s[-1] in "\"”" and not re.search(r"[.!?][\"”]?$", s):
        return False
    return True


def is_caption_para(p: str) -> bool:
    """An illustration caption: a short standalone block that never ends
    like a sentence. Real prose paragraphs either close a sentence or run on."""
    p = p.strip()
    if not p:
        return True
    # A colon is a lead-in ("...kept repeating over and over:"), not a caption.
    if re.search(r"[.!?:][\"'’”)\]]?$", p):
        return False
    return len(p.split()) < 45


# Headings that announce apparatus rather than the story. A candidate opening
# sitting under one of these is a preface, not chapter one.
FRONT_HEADING_RE = re.compile(
    r"^\s*(?:the\s+)?(preface|introduction|introductory|foreword|"
    r"dedication|advertisement|publisher.s note|editor.s note|editor.s preface|"
    r"translator.s note|transcriber.s note|note to the|prefatory)\b",
    re.I,
)


CHAPTER_HEADING_RE = re.compile(
    r"""^\s*(?:
        (?:chapter|chap\.?|book|part|stave|act|canto|letter|section|volume)
        \s*[\s.:\-]?\s*(?:[0-9]+|[ivxlcdm]{1,7}|one|two|three|four|five|six|seven|
                              eight|nine|ten|first|second|third|the\s+first)\b.*|
        [0-9]{1,3}\.?|
        [ivxlcdm]{1,7}\.?
    )\s*$""",
    re.I | re.X,
)
# Only chapter *one* ends the front matter. A bare "XLII" or "M." is either a
# stray initial (Ulysses signs a letter "M.") or a chapter deep in the book,
# and jumping to either lands the excerpt in the middle of the story.
FIRST_CHAPTER_RE = re.compile(
    r"""^\s*(?:
        (?:chapter|chap\.?|book|part|stave|act|canto|letter|section|volume)
        \s*[\s.:\-]?\s*(?:1|i|one|first|the\s+first)\b.*|
        (?:1|i|one|first)\.?
    )\s*$""",
    re.I | re.X,
)


def _heading_line(s: str) -> bool:
    """A standalone heading, not a wrapped line of prose.

    Deliberately narrower than is_heading(): "Part of the reason he came..."
    opens with "Part" and would otherwise read as a heading, and a false
    heading here truncates the excerpt in the middle of a sentence.
    """
    t = s.strip()
    if not t or len(t) > 90 or t.endswith((",", ";", ":", "-", "—", "–")):
        return False
    if CHAPTER_HEADING_RE.match(t) or ROMAN_LINE_RE.match(t):
        return True
    if len(t) < 60 and FRONT_HEADING_RE.match(t):
        return True
    # An all-caps line is usually a heading -- but not when it is shouted
    # dialogue. Tom Sawyer opens on one: '"TOM!"'.
    if t[0] in "\"'\u201c\u2018" or t.endswith(("!", "?")):
        return False
    letters = [c for c in t if c.isalpha()]
    if len(letters) < 4:
        return False
    return sum(c.isupper() for c in letters) / len(letters) > 0.7


def _looks_like_verse(block: list[str]) -> bool:
    """A stanza: short lines, most of them starting on a capital. Epigraphs
    sit between a chapter heading and the prose it belongs to."""
    ls = [l.strip() for l in block if l.strip()]
    if len(ls) < 3:
        return False
    if sum(len(l) for l in ls) / len(ls) > 58:
        return False
    return sum(1 for l in ls if l[:1].isupper()) / len(ls) >= 0.7


def auto_start(body: str) -> int:
    """Find where the story actually begins.

    Scans line by line rather than paragraph by paragraph: a title page often
    collapses into one paragraph with the title, byline and opening line all
    together, which no paragraph-level test can split. Once a line reads as
    prose, back up over the rest of its own block so the excerpt starts at the
    top of the sentence and not halfway through it -- the first wrapped line of
    a paragraph is often Title Case Enough ("Sir Walter Elliot, of Kellynch
    Hall, in Somersetshire, was a man who,") to fail the prose test on its own.
    """
    head = body[:30000]
    low = head.lower()
    cut = 0
    for marker in ("\ncontents\n", "\ntable of contents", "\ncontents.\n"):
        i = low.find(marker)
        if i >= 0:
            cut = max(cut, i + len(marker))
    chunk = body[cut:]

    lines = chunk.split("\n")
    offsets = []
    at = 0
    for line in lines:
        offsets.append(at)
        at += len(line) + 1

    # Headings arrive in runs. Two or three in a row are one compound heading
    # ("CHAPTER ONE" / "PLAYING PILGRIMS"); a dozen in a row are a table of
    # contents, whose "CHAPTER I" is not where chapter one starts.
    TOC_RUN = 4

    def heading_run(i: int) -> int:
        """Index just past the run of heading lines starting at i.

        Contents entries sit line under line; at most one blank separates them.
        A wider gap ends the run, which is what keeps a table of contents from
        swallowing the "CHAPTER ONE" printed four blank lines below it.
        """
        j = i
        k = i + 1
        blanks = 0
        while k < len(lines):
            if not lines[k].strip():
                blanks += 1
                if blanks > 1:
                    break
                k += 1
                continue
            if not _heading_line(lines[k]):
                break
            blanks = 0
            j = k
            k += 1
        return j + 1

    section = ""  # what the most recent heading says we are inside of
    candidates = []  # (section, is_verse, offset)
    i = 0
    while i < len(lines):
        line = lines[i]
        if _heading_line(line):
            end = heading_run(i)
            run = [l.strip() for l in lines[i:end] if l.strip()]
            if len(run) < TOC_RUN:
                if any(FRONT_HEADING_RE.match(t) for t in run):
                    section = "front"
                elif any(FIRST_CHAPTER_RE.match(t) for t in run):
                    section = "chapter"
                elif section == "front":
                    # An unnamed heading ends the preface. It does not undo a
                    # chapter number: "1" and the chapter's title sit four
                    # blank lines apart in The Maltese Falcon, and the title
                    # must not put us back outside the book.
                    section = ""
            i = end
            continue
        if not looks_like_prose_line(line):
            i += 1
            continue
        # Widen to the block this line sits in, stopping at a blank line or at
        # a heading -- a heading swept into the block would veto it as front
        # matter even though the prose below it is the real opening.
        j = i
        while j > 0 and lines[j - 1].strip() and not _heading_line(lines[j - 1]):
            j -= 1
        k = i
        while k + 1 < len(lines) and lines[k + 1].strip() and not _heading_line(lines[k + 1]):
            k += 1
        i = k + 1
        # A transcriber's note runs over several lines and only the first names
        # itself, so veto on the whole block, not on the line that matched.
        block = " ".join(l.strip() for l in lines[j:k + 1])
        if FRONT_ANYWHERE_RE.search(block) or looks_like_front(block) or is_caption_para(block):
            continue
        verse = _looks_like_verse(lines[j:k + 1])
        candidates.append((section, verse, cut + offsets[j]))
        # Prose under a chapter heading is the book itself; stop looking.
        if (section == "chapter" and not verse) or offsets[j] > 400000:
            break

    # Order of preference: the first chapter, then any prose that is not
    # explicitly under a preface, then the preface -- better a preface than
    # the title page. Prose beats verse at every step, so a chapter epigraph
    # gives way to the paragraph underneath it.
    for want, allow_verse in (("chapter", False), ("", False), ("chapter", True),
                              ("", True), ("front", False), ("front", True)):
        for section, verse, off in candidates:
            if section == want and (allow_verse or not verse):
                return off

    # Nothing looked like prose -- fall back to the old paragraph filter.
    paras = [p for p in paragraphs_from(chunk) if not looks_like_front(p) and len(p) >= 40]
    if not paras:
        return cut
    target = paras[0]
    i = chunk.find(target[:40] if len(target) > 40 else target)
    return cut + max(i, 0)


def locate(body: str, book: dict) -> int:
    anchors = [book.get("anchor") or "", *book.get("anchors", [])]
    anchors = [a for a in anchors if a and a.strip()]
    if not anchors:
        return auto_start(body)
    folded, orig = fold_with_map(body)
    best = None
    for c in anchors:
        fc = fold(c).strip()
        if not fc:
            continue
        i = folded.find(fc)
        if i >= 0 and (best is None or i < best):
            best = i
    if best is None:
        return auto_start(body)
    return orig[best]


def is_heading(line: str) -> bool:
    s = line.strip()
    if not s or len(s) > 90:
        return False
    if HEADING_RE.match(s):
        return True
    if re.match(r"^(CHAPTER|STAVE|ACT|SCENE|PART|BOOK)\b", s, re.I):
        return True
    return False


def first_sentence(text: str) -> str:
    buf = []
    words = re.findall(r"\S+|\s+", text)
    acc = ""
    for tok in words:
        acc += tok
        stripped = tok.strip()
        if not stripped:
            continue
        core = re.sub(r"[^A-Za-z.]+", "", stripped).rstrip(".").lower()
        end = stripped[-1] if stripped else ""
        if end in ".?!" or (len(stripped) >= 2 and stripped[-1] in "\"”'" and stripped[-2] in ".?!"):
            if core in ABBREV:
                continue
            if re.fullmatch(r"[A-Z]\.?", stripped.replace('"', "").replace("”", "")):
                continue
            sent = acc.strip()
            if len(sent) < 12 and not sent.endswith("?"):
                continue  # keep going for "TOM!" + next line unless it's a question
            return sent
    return acc.strip()


def paragraphs_from(text: str) -> list[str]:
    chunks = re.split(r"\n\s*\n", text)
    out = []
    for p in chunks:
        p = re.sub(r"\n+", " ", p)
        p = re.sub(r"\s+", " ", p).strip().replace("_", "")
        if len(p) < 3:
            continue
        if is_heading(p) and len(p) < 80:
            continue
        if re.match(r"^\[illustration", p, re.I):
            continue
        out.append(p)
    if out and len(out[0]) < 80:
        acc = [out[0]]
        i = 1
        while i < len(out) and len("\n\n".join(acc)) < 280:
            acc.append(out[i])
            i += 1
        out = ["\n\n".join(acc)] + out[i:]
    return out


def word_trim(text: str, cap: int = WORD_CAP) -> str:
    words = text.split()
    if len(words) <= cap:
        return text.strip()
    return " ".join(words[:cap]).strip() + "…"


def split_after_anchor(from_here: str) -> list[str]:
    lines = from_here.split("\n")
    idxs = [i for i, ln in enumerate(lines) if i > 4 and is_heading(ln)]
    if not idxs:
        return [from_here]
    chapters = ["\n".join(lines[: idxs[0]])]
    for n, start in enumerate(idxs):
        end = idxs[n + 1] if n + 1 < len(idxs) else len(lines)
        chunk = "\n".join(lines[start:end]).strip()
        if len(chunk) > 80:
            chapters.append(chunk)
        if len(chapters) >= 4:
            break
    return chapters


def build_ladder(paras: list[str], sent: str) -> tuple[list[str], list[int]]:
    """Five strictly growing tiers, sliced at paragraph boundaries.

    A paragraph can be three words long ("No answer."), so "add one more
    paragraph" is not enough to make a hint feel like a hint. Every tier has
    to clear a word target *and* grow substantially over the tier before it,
    otherwise two hints in a row look like the same screen of text.
    """

    def upto(n: int) -> str:
        return "\n\n".join(paras[:n])

    def wc(n: int) -> int:
        return len(upto(n).split())

    total = len(paras)
    # (minimum words, minimum growth over the previous tier)
    steps = ((45, 2.0), (140, 1.6), (PAGES_CAP, 1.5), (WORD_CAP, 1.4))

    seq = [sent]
    used = [0]
    prev = len(sent.split())
    n = 0
    for target, ratio in steps:
        n = min(n + 1, total)
        while n < total and (wc(n) < target or wc(n) < prev * ratio):
            n += 1
        seq.append(upto(n))
        used.append(n)
        prev = wc(n)

    # Short books run out of paragraphs and the tail tiers collapse into one
    # another. Spread the paragraphs we do have across the ladder instead.
    if len(set(seq)) < len(seq):
        counts = sorted({max(1, round(total ** ((i + 1) / 4))) for i in range(4)})
        while len(counts) < 4:
            counts.append(min(total, counts[-1] + 1))
        counts = sorted(set(counts))[:4]
        if len(counts) == 4 and counts[0] >= 1 and upto(counts[0]) != sent:
            seq = [sent] + [upto(c) for c in counts]
            used = [0] + counts
    return seq, used


def build_one(book: dict) -> dict:
    raw = fetch(int(book["gutenberg"]))
    body = strip_pg(raw)
    start = locate(body, book)
    from_here = body[start:]
    paras = paragraphs_from(from_here)
    if not paras:
        raise RuntimeError(f"no paragraphs after anchor: {book['title']}")
    sent = first_sentence(paras[0])
    if book["gutenberg"] == 74:  # Tom Sawyer opens mid-dialogue ("TOM!" / "No answer.")
        sent = paras[0].split("No answer")[0].strip() or '"TOM!"'
        if not sent.endswith("!") and "TOM" in paras[0].upper():
            sent = '"TOM!"'
    # Build the ladder on the full continuous stream from the anchor.
    # split_after_anchor() caps at four chapters and re-splits paragraphs, so
    # it starves the ladder — use it only to size chapter 1 for the label.
    seq, used = build_ladder(paras, sent)
    ch1_words = 0
    for ch in split_after_anchor(from_here):
        ps = paragraphs_from(ch)
        if ps and len(" ".join(ps).split()) > 200:
            ch1_words = len(" ".join(ps).split())
            break
    labels = [
        "First sentence",
        "First paragraph" if used[1] <= 1 else f"First {used[1]} paragraphs",
        "First two paragraphs" if used[2] <= 2 else f"First {used[2]} paragraphs",
        "A few pages",
        "Chapter 1" if ch1_words and len(seq[4].split()) <= ch1_words else "The opening pages",
    ]
    return {
        "id": book["slug"],
        "title": book["title"],
        "author": book["author"],
        "year": book["year"],
        "aliases": book["aliases"],
        "source": {
            "gutenberg": book["gutenberg"],
            "url": f"https://www.gutenberg.org/ebooks/{book['gutenberg']}",
            "license": "public-domain",
        },
        "labels": labels,
        "texts": seq,
    }


def main() -> None:
    force = "--force" in sys.argv
    # --cached-only builds what .gutenberg-cache already holds and touches the
    # network for nothing. Use it while prefetch_texts.py is running: two
    # fetchers against gutenberg.org at once is exactly what not to do.
    cached_only = "--cached-only" in sys.argv
    only = None
    for a in sys.argv[1:]:
        if a.startswith("--limit="):
            only = int(a.split("=", 1)[1])
    OUT.mkdir(parents=True, exist_ok=True)
    built = set()
    failed = []
    fresh = 0
    for i, book in enumerate(BOOKS):
        dest = OUT / f"{book['slug']}.json"
        if not force and dest.exists() and dest.stat().st_size > 400:
            built.add(book["slug"])
            continue
        if only is not None and fresh >= only:
            break
        if cached_only:
            src = CACHE / f"{book['gutenberg']}.txt"
            if not (src.exists() and src.stat().st_size > 2000):
                continue
        print(f"[{i+1}/{len(BOOKS)}] {book['title'][:50]} ({book['gutenberg']})", flush=True)
        try:
            puzzle = build_one(book)
        except Exception as e:  # noqa: BLE001
            print(f"  FAIL: {e}", flush=True)
            failed.append({
                "slug": book["slug"],
                "book": book["title"],
                "kind": book["kind"],
                "error": str(e)[:200],
            })
            continue
        dest.write_text(json.dumps(puzzle, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        preview = puzzle["texts"][0].replace("\n", " ")[:80]
        print(f"  ok  {preview!r}", flush=True)
        built.add(book["slug"])
        fresh += 1
    write_index(built, failed)
    bank = sum(1 for b in BOOKS if b["kind"] == "bank" and b["slug"] in built)
    daily = sum(1 for b in BOOKS if b["kind"] == "daily" and b["slug"] in built)
    print(
        f"built {len(built)}/{len(BOOKS)} puzzles "
        f"(bank {bank}, dailies {daily}), {len(failed)} failed this run",
        flush=True,
    )
    if failed:
        (HERE / "build_failures.json").write_text(
            json.dumps(failed, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"failures written to tools/build_failures.json", flush=True)


def play_order(slugs):
    """Scramble the catalogue into play order.

    Keyed on a hash of the slug, not on list position, so the same book keeps
    the same id across rebuilds and the sequence carries no trace of the
    Gutenberg numbering.
    """
    return sorted(slugs, key=lambda s: hashlib.sha256((ORDER_SALT + s).encode()).hexdigest())


def write_index(built, failed) -> None:
    """Bank first at #0..#N-1, then the dailies most-famous-first from #N.

    The bank is scrambled so browsing it carries no ranking signal. The daily
    run is deliberately *not* scrambled: day 1 should be Pride and Prejudice,
    not whatever a hash puts first.
    """
    bank = play_order([b["slug"] for b in BOOKS if b["kind"] == "bank" and b["slug"] in built])
    dailies = [
        b["slug"]
        for b in sorted(
            (b for b in BOOKS if b["kind"] == "daily" and b["slug"] in built),
            key=lambda b: b["rank"],
        )
    ]
    order = bank + dailies
    index = {
        "startDate": "2026-09-09",
        "dailyStartIndex": len(bank),
        "presetCount": len(bank),
        "dailyPoolCount": len(dailies),
        "order": order,
        "count": len(order),
        "failed": failed[:50],
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
