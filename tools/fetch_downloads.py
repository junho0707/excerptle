#!/usr/bin/env python3
"""Fetch per-book download counts + language from gutenberg.org.

Gutendex (which exposes `download_count` in one JSON call) is unreachable, so
we read the figure off each book's own page: "N downloads in the last 30 days."
Responses are cached, so a re-run only fetches what is missing.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from queue import Queue

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".pg-meta-cache"
OUT = ROOT / "book_popularity.json"
UA = "excerptle-catalog/1.0 (junhoyoon00@gmail.com)"
WORKERS = 2
DELAY = 1.0  # seconds between requests per worker — ~2 req/s total

DOWNLOADS = re.compile(r"([\d,]+)\s+downloads in the last 30 days")
LANG = re.compile(r'property="dcterms:language"[^>]*content="([^"]+)"')


def books() -> list[dict]:
    seed = json.loads((ROOT / "books.json").read_text(encoding="utf-8"))
    extra = json.loads((ROOT / "extra_books.json").read_text(encoding="utf-8"))
    for b in seed:
        b["tier"] = "curated"
    for b in extra:
        b["tier"] = "auto"
    return seed + extra


def fetch(gid: int) -> dict:
    path = CACHE / f"{gid}.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    req = urllib.request.Request(
        f"https://www.gutenberg.org/ebooks/{gid}", headers={"User-Agent": UA}
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                html = r.read().decode("utf-8", "replace")
            break
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 2:
                return {"gutenberg": gid, "error": str(e)}
            time.sleep(2 * (attempt + 1))
    d = DOWNLOADS.search(html)
    langs = LANG.findall(html)
    meta = {
        "gutenberg": gid,
        "downloads30": int(d.group(1).replace(",", "")) if d else None,
        "languages": langs,
    }
    path.write_text(json.dumps(meta), encoding="utf-8")
    return meta


def main() -> None:
    CACHE.mkdir(exist_ok=True)
    all_books = books()
    todo: Queue = Queue()
    for b in all_books:
        todo.put(b)
    got: dict[int, dict] = {}
    lock = threading.Lock()
    done = [0]

    def work() -> None:
        while True:
            try:
                b = todo.get_nowait()
            except Exception:
                return
            meta = fetch(int(b["gutenberg"]))
            with lock:
                got[int(b["gutenberg"])] = meta
                done[0] += 1
                if done[0] % 50 == 0:
                    print(f"{done[0]}/{len(all_books)}", flush=True)
            time.sleep(DELAY)

    threads = [threading.Thread(target=work) for _ in range(WORKERS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    rows = []
    for b in all_books:
        meta = got.get(int(b["gutenberg"]), {})
        rows.append({
            "gutenberg": int(b["gutenberg"]),
            "slug": b["slug"],
            "title": b["title"],
            "author": b["author"],
            "tier": b["tier"],
            "coffees": b.get("coffees"),
            "downloads30": meta.get("downloads30"),
            "languages": meta.get("languages") or [],
            "error": meta.get("error"),
        })
    rows.sort(key=lambda r: -(r["downloads30"] or -1))
    OUT.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    missing = sum(1 for r in rows if r["downloads30"] is None)
    print(f"wrote {len(rows)} rows to {OUT} ({missing} without a count)")


if __name__ == "__main__":
    sys.exit(main())
