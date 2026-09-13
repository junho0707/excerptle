#!/usr/bin/env python3
"""Download counts for works matched to Gutenberg by title (match_catalog.py).

Same cache and parser as the other two fetchers, so every book in the pool --
however it found its Gutenberg id -- ends up ranked on the same number.
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
from fetch_downloads import fetch, CACHE  # noqa: E402

OUT = ROOT / "matched_downloads.json"
WORKERS, DELAY = 2, 1.0


def main() -> None:
    CACHE.mkdir(exist_ok=True)
    rows = json.loads((ROOT / "matched_works.json").read_text(encoding="utf-8"))
    bank = json.loads((ROOT / "books.json").read_text(encoding="utf-8"))
    bank += json.loads((ROOT / "extra_books.json").read_text(encoding="utf-8"))
    have = {int(b["gutenberg"]) for b in bank}
    todo = [r for r in rows if int(r["gutenberg"]) not in have]
    print(f"{len(todo)} matched works to price (skipping {len(rows) - len(todo)} already in the bank)")

    q: Queue = Queue()
    for r in todo:
        q.put(r)
    got, lock, done = {}, threading.Lock(), [0]

    def work() -> None:
        while True:
            try:
                r = q.get_nowait()
            except Exception:
                return
            m = fetch(int(r["gutenberg"]))
            with lock:
                got[int(r["gutenberg"])] = m
                done[0] += 1
                if done[0] % 100 == 0:
                    print(f"{done[0]}/{len(todo)}", flush=True)
            time.sleep(DELAY)

    ts = [threading.Thread(target=work) for _ in range(WORKERS)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()

    out = []
    for r in todo:
        m = got.get(int(r["gutenberg"]), {})
        out.append({**r, "downloads30": m.get("downloads30"),
                    "pg_languages": m.get("languages") or []})
    out.sort(key=lambda r: -(r["downloads30"] or -1))
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(out)} rows to {OUT}")


if __name__ == "__main__":
    main()
