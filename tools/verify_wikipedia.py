#!/usr/bin/env python3
"""Check every candidate title against English Wikipedia directly.

The Wikidata join under-reports badly: it required a publication date, which
Hamlet and The Odyssey do not carry, so famous books looked article-less. Asking
Wikipedia itself -- following redirects, so retitled editions resolve -- is both
more accurate and cheap, at 40 titles a request.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from final_lists import build_pool, playable  # noqa: E402
from build_pd_dataset import norm  # noqa: E402

OUT = ROOT / ".pd-cache" / "wikipedia.json"
API = "https://en.wikipedia.org/w/api.php"
UA = "excerptle-catalog/1.0 (junhoyoon00@gmail.com)"
BATCH = 40


def main() -> None:
    rows = [r for r in build_pool().values() if playable(r)]
    print(f"{len(rows)} playable books to check")
    cache = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    todo = [r for r in rows if str(r["gutenberg"]) not in cache]
    print(f"{len(todo)} not yet checked")

    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        titles = "|".join((r["title"] or "").replace("|", " ") for r in batch)
        url = (f"{API}?action=query&format=json&redirects=1&prop=pageprops"
               f"&titles={urllib.parse.quote(titles)}")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                data = json.load(r)
        except Exception as e:  # noqa: BLE001
            print(f"  batch {i} failed: {e}", file=sys.stderr)
            continue
        pages = data.get("query", {}).get("pages", {})
        # A disambiguation page means the title is ambiguous, not that the book
        # is notable, so it does not count as an article.
        live = {norm(p["title"]) for p in pages.values()
                if "missing" not in p and "disambiguation" not in (p.get("pageprops") or {})}
        # redirects=1 rewrites titles; map the originals back through them.
        for r_ in data.get("query", {}).get("redirects", []):
            if norm(r_["to"]) in live:
                live.add(norm(r_["from"]))
        for r_ in data.get("query", {}).get("normalized", []):
            if norm(r_["to"]) in live:
                live.add(norm(r_["from"]))
        for b in batch:
            cache[str(b["gutenberg"])] = norm(b["title"] or "") in live
        if i % 400 == 0:
            print(f"  {i}/{len(todo)}")
            OUT.write_text(json.dumps(cache), encoding="utf-8")
        time.sleep(0.4)

    OUT.write_text(json.dumps(cache), encoding="utf-8")
    yes = sum(1 for v in cache.values() if v)
    print(f"wrote {len(cache)} verdicts to {OUT}: {yes} with an article, {len(cache)-yes} without")


if __name__ == "__main__":
    main()
