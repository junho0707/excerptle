#!/usr/bin/env python3
"""Download public-domain Gutenberg texts and emit Bookle puzzle JSON.

Each book has a verified narrative `anchor` (famous first line). We slice
the Gutenberg file from that line so TOCs, prefaces, and etext boilerplate
never become guess 1.
"""

from __future__ import annotations

import json
import re
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


def auto_start(body: str) -> int:
    head = body[:30000]
    low = head.lower()
    cut = 0
    for marker in ("\ncontents\n", "\ntable of contents", "\ncontents.\n"):
        i = low.find(marker)
        if i >= 0:
            cut = max(cut, i + len(marker))
    chunk = body[cut:]
    paras = paragraphs_from(chunk)
    paras = [p for p in paras if not looks_like_front(p) and len(p) >= 40]
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
    para1 = paras[0]
    para2 = "\n\n".join(paras[:2])
    chapters = split_after_anchor(from_here)
    prose = []
    for ch in chapters:
        ps = paragraphs_from(ch)
        if ps:
            prose.append("\n\n".join(ps))
    if not prose:
        prose = [para2]
    while len(prose) < 3:
        prose.append(prose[-1])
    pages = word_trim(prose[0], PAGES_CAP)
    chapter = word_trim(prose[0], WORD_CAP)
    seq = [sent, para1, para2, pages, chapter]
    for i in range(1, 5):
        if len(seq[i].split()) < len(seq[i - 1].split()):
            seq[i] = seq[i - 1]
    labels = [
        "First sentence",
        "First paragraph",
        "First two paragraphs",
        "A few pages",
        "Chapter 1",
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
    OUT.mkdir(parents=True, exist_ok=True)
    order = []
    failed = []
    for i, book in enumerate(BOOKS):
        dest = OUT / f"{book['slug']}.json"
        print(f"[{i+1}/{len(BOOKS)}] {book['title'][:50]} ({book['gutenberg']})", flush=True)
        if dest.exists() and dest.stat().st_size > 400:
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
        write_index(order, failed)
        time.sleep(0.12)
    write_index(order, failed)
    print(f"wrote {min(1000, len(order))} puzzles, {len(failed)} failed", flush=True)


def write_index(order, failed) -> None:
    seen = []
    for s in order:
        if s not in seen:
            seen.append(s)
    index = {
        "startDate": "2026-09-08",
        "dailyStartIndex": 1001,
        "presetCount": min(1000, len(seen)),
        "order": seen[:1000],
        "count": min(1000, len(seen)),
        "failed": failed[:50],
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
