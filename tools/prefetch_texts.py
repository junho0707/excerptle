#!/usr/bin/env python3
"""Warm .gutenberg-cache for the shipped lists, politely.

build_puzzles.py fetches on demand, but 546 downloads in one pass runs longer
than a single sitting. This does the same fetch in bounded chunks so a run
always finishes: `--limit=N` stops after N new texts.

Never run two of these at once -- gutenberg.org is one small server and this
project has already leaned on it hard.
"""

import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])

import build_puzzles as B  # noqa: E402

DELAY = 0.7  # ~1.4 requests/second


def main() -> None:
    limit = None
    for a in sys.argv[1:]:
        if a.startswith("--limit="):
            limit = int(a.split("=", 1)[1])
    todo = []
    for b in B.BOOKS:
        cached = B.CACHE / f"{b['gutenberg']}.txt"
        if not (cached.exists() and cached.stat().st_size > 2000):
            todo.append(b)
    print(f"{len(B.BOOKS) - len(todo)} cached, {len(todo)} to fetch", flush=True)
    done = failed = 0
    for b in todo:
        if limit is not None and done + failed >= limit:
            break
        try:
            text = B.fetch(int(b["gutenberg"]))
            done += 1
            print(f"  ok   {b['gutenberg']:>6} {b['title'][:44]:<46} {len(text)//1024}KB", flush=True)
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL {b['gutenberg']:>6} {b['title'][:44]:<46} {e}", flush=True)
        time.sleep(DELAY)
    print(f"fetched {done}, failed {failed}, {len(todo) - done - failed} still missing", flush=True)


if __name__ == "__main__":
    main()
