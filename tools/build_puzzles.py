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
CURATED = json.loads((Path(__file__).parent / "books.json").read_text(encoding="utf-8"))
EXTRA_PATH = Path(__file__).parent / "extra_books.json"
BOOKS = list(CURATED)
if EXTRA_PATH.exists():
    BOOKS.extend(json.loads(EXTRA_PATH.read_text(encoding="utf-8")))
OUT = ROOT / "puzzles"
CACHE = Path(__file__).parent / ".gutenberg-cache"
# Books #1..#PRESET_COUNT are the pick-any bank; everything past that is held
# back as the daily pool, so a daily is never a book you could already browse.
PRESET_COUNT = 600
# Salt for the play order. Book #1 must not be the first line of the
# catalogue, and the sequence must not track Gutenberg ids.
ORDER_SALT = "excerptle-order-v1:"
WORD_CAP = 3500
PAGES_CAP = 900
UA = "BookleFyi/1.0 (public-domain excerpts for bookle.fyi)"

START_RE = re.compile(r"\*\*\*\s*START OF (THIS|THE) PROJECT GUTENBERG.*?\*\*\*", re.I)
END_RE = re.compile(r"\*\*\*\s*END OF (THIS|THE) PROJECT GUTENBERG.*?\*\*\*", re.I)

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
    start = START_RE.search(text)
    end = END_RE.search(text)
    if start:
        text = text[start.end() :]
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
    r"project gutenberg|gutenberg|e-?text|etext|transcrib|proofread|"
    r"all rights reserved|copyright|printed in|\bisbn\b|"
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
    if re.search(r"[.!?][\"'’”)\]]?$", p):
        return False
    return len(p.split()) < 45


def auto_start(body: str) -> int:
    """Find where the story actually begins.

    Scans line by line rather than paragraph by paragraph: a title page often
    collapses into one paragraph with the title, byline and opening line all
    together, which no paragraph-level test can split.
    """
    head = body[:30000]
    low = head.lower()
    cut = 0
    for marker in ("\ncontents\n", "\ntable of contents", "\ncontents.\n"):
        i = low.find(marker)
        if i >= 0:
            cut = max(cut, i + len(marker))
    chunk = body[cut:]
    # A transcriber's note runs over several lines and only the first names
    # itself, so veto on the whole paragraph the candidate line sits in.
    paras = paragraphs_from(chunk)
    banned = {
        p[:60]
        for p in paras
        if FRONT_ANYWHERE_RE.search(p) or looks_like_front(p) or is_caption_para(p)
    }
    offset = 0
    for line in chunk.split("\n"):
        if looks_like_prose_line(line):
            stripped = line.strip()
            para = next((p for p in paras if stripped in p), "")
            if para[:60] not in banned:
                return cut + offset
        offset += len(line) + 1
    # Nothing looked like prose — fall back to the old paragraph filter.
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


def fun_for(book: dict) -> dict:
    coffees = int(book.get("coffees") or 1)
    gid = int(book["gutenberg"])
    give = round(4.0 + (gid % 17) + coffees * 3.1, 1)
    mins = 3 + (gid % 9) + coffees * 2
    secs = (gid * 7) % 60
    median = f"{mins}m{secs:02d}s"
    return {
        "coffees": coffees,
        "giveUpPct": give,
        "median": median,
        "blurb": (
            f"You’ll need {coffees} coffee{'s' if coffees != 1 else ''} to solve this — "
            f"{give}% give-up rate, {median} median time"
        ),
    }


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
    if book["slug"] == "b13":
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
        "fun": fun_for(book),
    }


def main() -> None:
    force = "--force" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    order = []
    failed = []
    skipped = []
    for i, book in enumerate(BOOKS):
        dest = OUT / f"{book['slug']}.json"
        print(f"[{i+1}/{len(BOOKS)}] {book['title'][:50]} ({book['gutenberg']})", flush=True)
        if book.get("exclude"):
            # Kept in the catalogue for the record, but never served: the
            # Gutenberg text opens on front matter we can't reliably strip.
            skipped.append({
                "slug": book["slug"],
                "title": book["title"],
                "reason": book.get("exclude_reason", "unusable opening"),
            })
            print(f"  EXCLUDED: {book.get('exclude_reason', 'unusable opening')}", flush=True)
            continue
        if not force and dest.exists() and dest.stat().st_size > 400:
            order.append(book["slug"])
            print("  skip existing", flush=True)
            continue
        try:
            puzzle = build_one(book)
        except Exception as e:  # noqa: BLE001
            print(f"  FAIL: {e}", flush=True)
            failed.append({"book": book["title"], "error": str(e)})
            time.sleep(0.15)
            continue
        dest.write_text(json.dumps(puzzle, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        preview = puzzle["texts"][0].replace("\n", " ")[:80]
        print(f"  ok  {preview!r}", flush=True)
        order.append(book["slug"])
        write_index(order, failed, skipped)
        time.sleep(0.12)
    write_index(order, failed, skipped)
    print(
        f"wrote {len(order)} puzzles, "
        f"{len(failed)} failed, {len(skipped)} excluded",
        flush=True,
    )


# Mirrors stripEdition/fold in js/match.js. Gutenberg ships the same book many
# times over ("The Adventures of Tom Sawyer, Part 1..8"); the answer is
# identical every time, so only one of them earns a slot.
EDITION_TAILS = [
    re.compile(r"\s*[([](?:complete|unabridged|illustrated|annotated)[^)\]]*[)\]]\s*$", re.I),
    re.compile(r"\s*\(\s*\d{4}\s*(?:[-–—]\s*\d{4}\s*)?\)\s*$"),
    re.compile(r"(?:[—–,.;:]|\s-|\s)\s*(?:complete|unabridged|illustrated|annotated)\s*\.?\s*$", re.I),
    re.compile(r"[—–,.;:]\s*[^,.;:—–]*\bedition\b\s*\.?\s*$", re.I),
    re.compile(r"(?:[—–,.;:]|\s-)\s*(?:vol(?:ume|s?\.)?|pt\.?|parts?|chapters?)\s+[\divxlcdmIVXLCDM][\s\S]*$", re.I),
]


def strip_edition(title: str) -> str:
    t = (title or "").strip()
    for _ in range(4):
        before = t
        for rx in EDITION_TAILS:
            t = rx.sub("", t).strip()
        if t == before:
            break
        t = re.sub(r"[\s.,;:—–-]+$", "", t).strip()
    return t or (title or "").strip()


def book_key(title: str) -> str:
    t = unicodedata.normalize("NFD", strip_edition(title).lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"&", " and ", t)
    t = re.sub(r"[^a-z0-9\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    while True:
        m = re.match(r"^(the|a|an)\s+", t)
        if not m:
            break
        t = t[m.end():]
    return t


def dedupe_books(slugs):
    """One slot per distinct book, curated edition winning."""
    best = {}
    for slug in slugs:
        f = OUT / f"{slug}.json"
        if not f.exists():
            continue
        key = book_key(json.loads(f.read_text(encoding="utf-8")).get("title", slug))
        # b* files are hand-checked openings; prefer them over the g* dumps.
        rank = (0 if slug.startswith("b") else 1, slug)
        if key not in best or rank < best[key][0]:
            best[key] = (rank, slug)
    keep = {slug for _, slug in best.values()}
    return [s for s in slugs if s in keep]


def play_order(slugs):
    """Scramble the catalogue into play order.

    Keyed on a hash of the slug, not on list position, so the same book keeps
    the same id across rebuilds and the sequence carries no trace of the
    Gutenberg numbering.
    """
    return sorted(slugs, key=lambda s: hashlib.sha256((ORDER_SALT + s).encode()).hexdigest())


def write_index(order, failed, skipped=()) -> None:
    seen = []
    for s in order:
        if s not in seen:
            seen.append(s)
    shuffled = play_order(dedupe_books(seen))
    presets = min(PRESET_COUNT, len(shuffled))
    index = {
        "startDate": "2026-09-09",
        "dailyStartIndex": 600,
        "presetCount": presets,
        "dailyPoolCount": len(shuffled) - presets,
        "order": shuffled,
        "count": len(shuffled),
        "failed": failed[:50],
        "excluded": list(skipped),
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
