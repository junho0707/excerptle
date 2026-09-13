#!/usr/bin/env python3
"""Download counts for PD candidates that are not yet in the bank.

The bank's own counts come from fetch_downloads.py. This walks the Wikidata
candidates that carry a Gutenberg id, so every book -- kept or proposed -- is
ranked on the same number instead of one metric for the bank and another for
the newcomers. Shares the same cache, so nothing is fetched twice.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path
from queue import Queue

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from fetch_downloads import fetch, CACHE  # noqa: E402  same cache, same parser

OUT = ROOT / "candidate_downloads.json"
WORKERS = 2
DELAY = 1.0


def main() -> None:
    CACHE.mkdir(exist_ok=True)
    works = json.loads((ROOT / ".pd-cache" / "works.json").read_text(encoding="utf-8"))
    bank = json.loads((ROOT / "books.json").read_text(encoding="utf-8"))
    bank += json.loads((ROOT / "extra_books.json").read_text(encoding="utf-8"))
    have = {int(b["gutenberg"]) for b in bank}

    todo_works = [w for w in works if w.get("gutenberg") and int(w["gutenberg"]) not in have]
    print(f"{len(todo_works)} candidates with a Gutenberg text, not in the bank")

    q: Queue = Queue()
    for w in todo_works:
        q.put(w)
    got: dict[int, dict] = {}
    lock = threading.Lock()
    done = [0]

    def work() -> None:
        while True:
            try:
                w = q.get_nowait()
            except Exception:
                return
            meta = fetch(int(w["gutenberg"]))
            with lock:
                got[int(w["gutenberg"])] = meta
                done[0] += 1
                if done[0] % 100 == 0:
                    print(f"{done[0]}/{len(todo_works)}", flush=True)
            time.sleep(DELAY)

    threads = [threading.Thread(target=work) for _ in range(WORKERS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    rows = []
    for w in todo_works:
        meta = got.get(int(w["gutenberg"]), {})
        rows.append({**w, "downloads30": meta.get("downloads30"),
                     "pg_languages": meta.get("languages") or []})
    rows.sort(key=lambda r: -(r["downloads30"] or -1))
    OUT.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    missing = sum(1 for r in rows if r["downloads30"] is None)
    print(f"wrote {len(rows)} rows to {OUT} ({missing} without a count)")


if __name__ == "__main__":
    main()
