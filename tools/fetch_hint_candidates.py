#!/usr/bin/env python3
"""Collect source-backed genre and narrative-location candidates from Wikidata.

This is a curation aid, not a publishing step. It writes a review file with
the source QIDs so a reviewer can approve concise player-facing clues before
they are copied into hint_metadata.json. Network use is deliberately batched
and cacheable; no title-only guess is treated as a fact.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
OUT = TOOLS / "hint_candidates.json"
API = "https://www.wikidata.org/w/api.php"
UA = "Excerptle-hint-curation/1.0 (public-domain book metadata)"


def get(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def main() -> None:
    books = json.loads((TOOLS / "final_bank.json").read_text()) + json.loads((TOOLS / "final_dailies.json").read_text())
    works = json.loads((TOOLS / ".pd-cache" / "works.json").read_text())
    qids = {str(row["gutenberg"]): row["wikidata"] for row in works if row.get("gutenberg") and row.get("wikidata")}
    local_titles: dict[tuple[str, str], list[str]] = {}
    for row in works:
        if row.get("wikidata") and row.get("title"):
            local_titles.setdefault((norm(row["title"]), norm(row.get("author", ""))), []).append(row["wikidata"])
    for book in books:
        key = str(book["gutenberg"])
        matches = local_titles.get((norm(book["title"]), norm(book.get("author", ""))), [])
        if key not in qids and len(set(matches)) == 1:
            qids[key] = matches[0]
    cached = json.loads(OUT.read_text()) if OUT.exists() else {}
    # The older local join deliberately required a publication date and misses
    # many famous titles. Recover only exact title matches here; ambiguous
    # results stay absent rather than attaching another work's setting.
    todo = [book for book in books if f"g{book['gutenberg']}" not in cached and qids.get(str(book["gutenberg"]))]
    for offset in range(0, len(todo), 50):
        batch = todo[offset:offset + 50]
        ids = "|".join(qids[str(book["gutenberg"])] for book in batch)
        params = urllib.parse.urlencode({
            "action": "wbgetentities", "format": "json", "ids": ids,
            "props": "claims|labels", "languages": "en",
        })
        entities = get(f"{API}?{params}").get("entities", {})
        for book in batch:
            key = f"g{book['gutenberg']}"
            entity = entities.get(qids[str(book["gutenberg"])], {})
            claims = entity.get("claims", {})
            def ids_for(prop: str) -> list[str]:
                out = []
                for claim in claims.get(prop, []):
                    value = claim.get("mainsnak", {}).get("datavalue", {}).get("value", {})
                    if value.get("id"):
                        out.append(value["id"])
                return out
            cached[key] = {
                "title": book["title"], "source": f"wikidata:{qids[str(book['gutenberg'])]}",
                "genreQids": ids_for("P136"),
                "settingQids": ids_for("P840"),
                "status": "needs concise review",
            }
        OUT.write_text(json.dumps(cached, ensure_ascii=False, indent=2) + "\n")
        print(f"{min(offset + len(batch), len(todo))}/{len(todo)} source records collected")
        time.sleep(0.35)
    # Claim values are QIDs too. Resolve their English labels once so the
    # review file is readable without another browser tab per book.
    wanted = sorted({qid for record in cached.values()
                     for qid in record.get("genreQids", []) + record.get("settingQids", [])})
    labels = {}
    for offset in range(0, len(wanted), 50):
        ids = "|".join(wanted[offset:offset + 50])
        params = urllib.parse.urlencode({"action": "wbgetentities", "format": "json", "ids": ids,
                                         "props": "labels", "languages": "en"})
        for qid, entity in get(f"{API}?{params}").get("entities", {}).items():
            label = entity.get("labels", {}).get("en", {}).get("value")
            if label:
                labels[qid] = label
        time.sleep(0.35)
    for record in cached.values():
        record["genreCandidates"] = [labels.get(qid, qid) for qid in record.get("genreQids", [])]
        record["settingCandidates"] = [labels.get(qid, qid) for qid in record.get("settingQids", [])]
    print(f"wrote {len(cached)} records to {OUT}")
    OUT.write_text(json.dumps(cached, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
