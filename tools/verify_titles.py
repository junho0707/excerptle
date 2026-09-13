#!/usr/bin/env python3
"""Check that each shipped id really is the book the list says it is.

Gutenberg 2264 is Macbeth, but the catalogue join had it down as The Taming of
the Shrew, and 2263 is Julius Caesar, not Richard III -- a whole run of the
22xx Shakespeare series was off by one work. A puzzle built from a mislabelled
id is unwinnable: the answer it accepts is not the book on screen.

Every downloaded text opens with "The Project Gutenberg eBook of <title>",
which is the id's own account of itself. Compare that against the list.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from final_lists import same_book, title_key  # noqa: E402

CACHE = ROOT / ".gutenberg-cache"
HEAD = re.compile(r"The Project Gutenberg eBook of\s+(.+)", re.I)


def pg_title(gid: int) -> str | None:
    f = CACHE / f"{gid}.txt"
    if not f.exists():
        return None
    head = f.read_text(encoding="utf-8", errors="replace")[:4000]
    m = HEAD.search(head)
    return m.group(1).strip() if m else None


def main() -> None:
    bad, missing, checked = [], [], 0
    for name in ("final_bank", "final_dailies"):
        for r in json.loads((ROOT / f"{name}.json").read_text(encoding="utf-8")):
            actual = pg_title(r["gutenberg"])
            if actual is None:
                missing.append(r)
                continue
            checked += 1
            if not same_book(title_key(r["title"]), title_key(actual)):
                bad.append((name, r, actual))

    for name, r, actual in bad:
        print(f"[{name}] g{r['gutenberg']} list says {r['title']!r} "
              f"but the text is {actual!r}  ({r.get('author')})")
    print(f"\n{checked} checked, {len(bad)} mismatched, {len(missing)} not cached")


if __name__ == "__main__":
    main()
