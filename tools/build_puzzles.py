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
READING_OUT = OUT / "reading"
CACHE = HERE / ".gutenberg-cache"
HINT_METADATA_PATH = HERE / "hint_metadata.json"
PUBLICATION_DATES = json.loads((HERE / "publication_dates.json").read_text(encoding="utf-8"))
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
                "year": PUBLICATION_DATES.get(f"g{gid}", {}).get("year") or (int(year) if year.isdigit() else 0),
                "genre": b.get("genre") or "",
                "form": b.get("form") or "",
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


def load_hint_metadata() -> dict[str, dict]:
    """Reviewed facts keyed by the stable Gutenberg puzzle id.

    Genre can be seeded from the curated catalogue, but setting is never
    invented by the builder. Missing facts are reported and block a rebuild.
    """
    try:
        data = json.loads(HINT_METADATA_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise RuntimeError("hint_metadata.json must be an object keyed by puzzle id")
    return data


HINT_METADATA = load_hint_metadata()

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


EXCERPT_TARGET = 350
EXCERPT_CEILING = 500
# Thresholds for "a human should look at this one", not for rejecting a book.
# Every flagged row still ships; the report is what says which ones were read.
EXCERPT_MIN = 60
READING_MIN = 400
READING_MAX = 12000


def opening_excerpt(paras: list[str]) -> str:
    """Complete opening paragraphs, aimed at 350--500 words.

    Paragraph boundaries win over the word target: a paragraph is never cut
    mid-sentence to hit a quota. So a book that opens with one 600-word block
    gets that block, and build_report() records it as an over-length exception.
    """
    chosen: list[str] = []
    words = 0
    for para in paras:
        n = len(para.split())
        if chosen and (words >= EXCERPT_TARGET or words + n > EXCERPT_CEILING):
            break
        chosen.append(para)
        words += n
    return "\n\n".join(chosen)


# Chapter headings the shared is_heading() misses: "CHAP. II." and the bare
# capitalised story titles that separate the tales in a collection.
CHAPTERISH_RE = re.compile(
    r"^(?:CHAPTER|CHAP\.?|STAVE|ACT|SCENE|PART|BOOK|LETTER|CANTO)\b",
    re.I,
)
# "CHAPTER II." often sits on its own line with the chapter's title on the
# next one, so a named heading is allowed to run straight into text -- but
# only while it stays short enough that no sentence of prose could pass for it.
HEADING_MAX_RUN_ON = 45
# A title line is all-caps (underscores stripped), short, and not a shouted
# line of dialogue.
TITLE_LINE_RE = re.compile(r"^[A-Z][A-Z0-9 ,.'\u2019\-&:]{2,68}$")
# "II.", "CHAPTER 4.", "Book the Second." -- a heading that numbers a section
# without naming it. Inside a collection these number the parts of one story,
# so they are not where one story ends and the next begins.
INITIALS_RE = re.compile(r"^(?:[A-Z]\.){1,4}$")
NUMERAL_HEADING_RE = re.compile(
    r"^(?:(?:CHAPTER|CHAP\.?|PART|BOOK|CANTO|SECTION|STAVE)[\s.:]*)?"
    r"(?:[IVXLCDM]+|\d+|THE\s+\w+)\.?$",
    re.I,
)


def heading_kind(line: str, prev: str, nxt: str) -> str:
    """"titled", "numeral", or "" for a line that starts no new section.

    Wider than is_heading(), and deliberately kept separate from it:
    is_heading() also decides which paragraphs to drop, and a looser test there
    would eat prose. This one only decides where sections divide, so it can
    afford to recognise a bare title line -- but it demands blank lines on both
    sides, which a wrapped line of prose never has.
    """
    s = line.strip()
    if not s or len(s) > 90 or prev.strip():
        return ""
    core = s.replace("_", "").strip()
    if core.endswith(("!", "?", ",", ";", ":", "-", "\u2013", "\u2014")):
        return ""
    named = is_heading(core) or CHAPTERISH_RE.match(core)
    # A capitalised line inside a letter -- "DEAR FRIEND", a signature, a set
    # of initials -- is not a heading, however isolated it looks.
    titled = (
        TITLE_LINE_RE.match(core)
        and len(core.split()) <= 12
        and len(re.sub(r"[^A-Za-z]", "", core)) >= 4
        and not INITIALS_RE.match(core)
    )
    if named:
        if nxt.strip() and len(core) > HEADING_MAX_RUN_ON:
            return ""
    elif not (titled and not nxt.strip()):
        return ""
    return "numeral" if NUMERAL_HEADING_RE.match(core) else "titled"


def split_sections(from_here: str, titled_only: bool = False) -> tuple[list[str], str]:
    """The text after the anchor, cut at the next real section heading.

    Returns the sections found and the heading that ended the first one, which
    is what tells a chapter apart from the next story in a collection.
    """
    lines = from_here.split("\n")
    idxs = []
    for i, ln in enumerate(lines):
        if i <= 4:
            continue
        kind = heading_kind(ln, lines[i - 1], lines[i + 1] if i + 1 < len(lines) else "")
        if kind and not (titled_only and kind == "numeral"):
            idxs.append(i)
    if not idxs:
        return [from_here], ""
    sections = ["\n".join(lines[: idxs[0]])]
    for n, start in enumerate(idxs):
        end = idxs[n + 1] if n + 1 < len(idxs) else len(lines)
        chunk = "\n".join(lines[start:end]).strip()
        if len(chunk) > 80:
            sections.append(chunk)
        if len(sections) >= 4:
            break
    return sections, lines[idxs[0]].strip()


COLLECTION_FORMS = ("short story collection", "fairy tales", "myth", "folklore")


def reading_label(book: dict, sections: list[str], next_heading: str) -> str:
    """Name the reading section for what it actually is.

    Calling the first Grimm tale "Chapter 1" would be a lie, and so would
    calling a whole short story an opening. The catalogue's form field decides
    where it has one; the shape of the next heading decides otherwise.
    """
    form = (book.get("form") or "").lower()
    if is_collection(book):
        return "First story"
    if form == "play":
        return "Opening scene"
    if form in ("short story", "novelette") and len(sections) == 1:
        return "The full story"
    if next_heading and CHAPTERISH_RE.match(next_heading):
        return "Chapter 1"
    return "Opening section"


def reading_kind(label: str) -> str:
    low = label.lower()
    if low.startswith("chapter"):
        return "chapter"
    if "story" in low or "tale" in low:
        return "story"
    if low.startswith("the opening"):
        return "pages"
    return "section"


def is_collection(book: dict) -> bool:
    form = (book.get("form") or "").lower()
    return any(f in form for f in COLLECTION_FORMS)


# Some books simply have no chapters -- Mrs Dalloway runs unbroken, and plenty
# of etexts carry no heading the splitter can trust. Handing the reader the
# whole novel is not "the first chapter", so cap it and stop calling it one.
OPENING_PAGES_WORDS = 2500


def opening_pages(paras: list[str], cap: int = OPENING_PAGES_WORDS) -> list[str]:
    """Whole paragraphs up to roughly `cap` words."""
    out: list[str] = []
    words = 0
    for para in paras:
        out.append(para)
        words += len(para.split())
        if words >= cap:
            break
    return out


def reading_section(from_here: str, book: dict) -> tuple[str, list[str]]:
    """The complete first narrative chapter, story or section after the anchor."""
    sections, next_heading = split_sections(from_here, titled_only=is_collection(book))
    paras = paragraphs_from(sections[0] if sections else from_here)
    if not paras:
        raise RuntimeError("no prose in first reading section")
    words = sum(len(para.split()) for para in paras)
    # A bare "II" can number the parts of one prologue rather than divide the
    # book, leaving a stub. Read on into the next sections until it is a
    # section worth opening.
    nxt = 1
    while words < READING_MIN and nxt < len(sections):
        more = paragraphs_from(sections[nxt])
        paras += more
        words += sum(len(para.split()) for para in more)
        nxt += 1
    if words < READING_MIN:
        # Headings so dense the "sections" are stubs -- a contents list, or a
        # run of chapter titles. Fall back to the prose itself.
        paras = opening_pages(paragraphs_from(from_here))
        words = sum(len(para.split()) for para in paras)
        if words >= READING_MIN:
            return "The opening pages", paras
    label = reading_label(book, sections, next_heading)
    if words > READING_MAX:
        return "The opening pages", opening_pages(paras)
    return label, paras


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
    if not book.get("year"):
        raise RuntimeError(f"missing reviewed publication date: {book['slug']}")
    raw = fetch(int(book["gutenberg"]))
    body = strip_pg(raw)
    start = locate(body, book)
    from_here = body[start:]
    paras = paragraphs_from(from_here)
    if not paras:
        raise RuntimeError(f"no paragraphs after anchor: {book['title']}")
    sent = first_sentence(paras[0])
    # The hint-version-2 fields all have to agree with each other: the sentence
    # on screen at nought hints is the sentence the excerpt and the reader then
    # open with. The legacy ladder keeps its own overridden `sent` below.
    opening_sentence = sent
    if book["gutenberg"] == 74:  # Tom Sawyer opens mid-dialogue ("TOM!" / "No answer.")
        sent = paras[0].split("No answer")[0].strip() or '"TOM!"'
        if not sent.endswith("!") and "TOM" in paras[0].upper():
            sent = '"TOM!"'
    # Build the ladder on the full continuous stream from the anchor.
    # split_after_anchor() caps at four chapters and re-splits paragraphs, so
    # it starves the ladder — use it only to size chapter 1 for the label.
    seq, used = build_ladder(paras, sent)
    opening = opening_excerpt(paras)
    reading_label_text, reading_paras = reading_section(from_here, book)
    meta = HINT_METADATA.get(book["slug"], {})
    genre = str(meta.get("genre") or book.get("genre") or "").strip()
    setting = str(meta.get("setting") or "").strip()
    if not genre or not setting:
        missing = ", ".join(name for name, value in (("genre", genre), ("setting", setting)) if not value)
        raise RuntimeError(f"missing reviewed hint metadata: {missing}")
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
    reading = {
        "puzzleId": book["slug"],
        "label": str(meta.get("readingLabel") or reading_label_text),
        "paragraphs": reading_paras,
    }
    reading_words = sum(len(para.split()) for para in reading_paras)
    return {
        "schemaVersion": 2,
        "hintVersion": 2,
        "id": book["slug"],
        "title": book["title"],
        "author": book["author"],
        "year": book["year"],
        "openingSentence": opening_sentence,
        "openingExcerpt": opening,
        "genre": genre,
        "setting": setting,
        "reading": {
            "kind": reading_kind(reading["label"]),
            "label": reading["label"],
            "url": f"/puzzles/reading/{book['slug']}.v2.json",
            "wordCount": reading_words,
        },
        "aliases": book["aliases"],
        "source": {
            "gutenberg": book["gutenberg"],
            "url": f"https://www.gutenberg.org/ebooks/{book['gutenberg']}",
            "license": "public-domain",
        },
        "labels": labels,
        "texts": seq,
        "_reading": reading,
    }


def main() -> None:
    if "--refresh-years" in sys.argv:
        # Apply reviewed metadata without regenerating text, reading sections,
        # or the play order. The same overrides are used by normal builds.
        for book in BOOKS:
            dest = OUT / f"{book['slug']}.json"
            puzzle = json.loads(dest.read_text(encoding="utf-8"))
            if not book["year"]:
                raise RuntimeError(f"Missing publication date: {book['slug']}")
            if puzzle.get("year") != book["year"]:
                puzzle["year"] = book["year"]
                dest.write_text(json.dumps(puzzle, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"Publication dates checked for {len(BOOKS)} puzzles")
        return
    if "--refresh-excerpts" in sys.argv:
        # Puzzle source texts are normally read from the Gutenberg cache. This
        # path updates an already-built catalogue from its matching opening
        # reader data, so a copy-only hint-length change needs no re-download.
        refreshed = set()
        for dest in OUT.glob("*.json"):
            if dest.name == "index.json":
                continue
            reading_path = READING_OUT / f"{dest.stem}.v2.json"
            try:
                puzzle = json.loads(dest.read_text(encoding="utf-8"))
                reading = json.loads(reading_path.read_text(encoding="utf-8"))
                paras = reading.get("paragraphs")
                if not isinstance(paras, list) or not paras:
                    continue
                puzzle["openingExcerpt"] = opening_excerpt(paras)
                dest.write_text(json.dumps(puzzle, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                refreshed.add(dest.stem)
            except (OSError, json.JSONDecodeError):
                continue
        write_report(refreshed)
        print(f"refreshed opening excerpts for {len(refreshed)} puzzles", flush=True)
        return
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
    READING_OUT.mkdir(parents=True, exist_ok=True)
    # A run that builds nothing -- --limit=0, an empty cache -- must not be able
    # to publish an index with no puzzles in it.
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
        reading = puzzle.pop("_reading")
        dest.write_text(json.dumps(puzzle, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        (READING_OUT / f"{book['slug']}.v2.json").write_text(
            json.dumps(reading, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

        preview = puzzle["texts"][0].replace("\n", " ")[:80]
        print(f"  ok  {preview!r}", flush=True)
        built.add(book["slug"])
        fresh += 1
    if built:
        write_index(built, failed)
        write_report(built)
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


def normalise_quotes(text: str) -> str:
    return text.replace("\u201c", '"').replace("\u201d", '"').replace("\u2018", "'").replace("\u2019", "'")


def review_row(puzzle: dict, reading: dict) -> dict:
    """One line of the curation report: what was built, and what looks odd."""
    excerpt_words = len(puzzle["openingExcerpt"].split())
    reading_words = puzzle["reading"]["wordCount"]
    flags = []
    if excerpt_words < EXCERPT_MIN:
        flags.append("excerpt-short")
    if excerpt_words > EXCERPT_CEILING:
        flags.append("excerpt-long-paragraph")
    if reading_words < READING_MIN:
        flags.append("reading-short")
    if reading_words > READING_MAX:
        flags.append("reading-long")
    if puzzle["reading"]["label"] == "Opening section":
        flags.append("no-section-boundary")
    head = normalise_quotes(puzzle["openingSentence"])[:40]
    if not normalise_quotes(puzzle["openingExcerpt"]).startswith(head):
        flags.append("excerpt-does-not-open-the-book")
    if not normalise_quotes(reading["paragraphs"][0]).startswith(head):
        flags.append("reader-does-not-start-at-the-opening")
    return {
        "id": puzzle["id"],
        "title": puzzle["title"],
        "genre": puzzle["genre"],
        "setting": puzzle["setting"],
        "excerptWords": excerpt_words,
        "excerptParagraphs": puzzle["openingExcerpt"].count("\n\n") + 1,
        "readingLabel": puzzle["reading"]["label"],
        "readingKind": puzzle["reading"]["kind"],
        "readingWords": reading_words,
        "readingParagraphs": len(reading["paragraphs"]),
        "flags": flags,
    }


def write_report(built: set[str]) -> None:
    """Coverage and exceptions, for review before a rebuild ships.

    Read back off disk rather than collected during the loop, so an incremental
    run still reports on the whole catalogue instead of on the one book it
    happened to rebuild.
    """
    report = []
    for slug in sorted(built):
        try:
            puzzle = json.loads((OUT / f"{slug}.json").read_text(encoding="utf-8"))
            reading = json.loads((READING_OUT / f"{slug}.v2.json").read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        report.append(review_row(puzzle, reading))
    if not report:
        return
    flagged = [row for row in report if row["flags"]]
    (HERE / "hint_report.json").write_text(
        json.dumps({"built": len(report), "flagged": len(flagged), "rows": report},
                   indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    counts: dict[str, int] = {}
    for row in flagged:
        for flag in row["flags"]:
            counts[flag] = counts.get(flag, 0) + 1
    print(f"hint report: {len(flagged)}/{len(report)} rows flagged for review", flush=True)
    for flag, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {n:4d}  {flag}", flush=True)


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
