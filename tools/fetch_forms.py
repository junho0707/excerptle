#!/usr/bin/env python3
"""Genre (P136) and form (P7937) for candidate works.

Every candidate is P31 "literary work", which says nothing about whether it is
a novel, a sonnet or a catechism -- and the game needs a long narrative to cut
a five-step excerpt ladder from. Genre/form is the cheapest pre-filter that
avoids downloading a thousand texts to find out.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from build_pd_dataset import cached_get, SPARQL_ENDPOINT, CACHE  # noqa: E402

OUT = CACHE / "forms.json"
CHUNK = 200

Q = """
SELECT ?work ?genreLabel ?formLabel WHERE {{
  VALUES ?work {{ {values} }}
  OPTIONAL {{ ?work wdt:P136 ?genre . }}
  OPTIONAL {{ ?work wdt:P7937 ?form . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""


def main() -> None:
    works = json.loads((CACHE / "works.json").read_text(encoding="utf-8"))
    qids = [w["wikidata"] for w in works if w.get("gutenberg")]
    print(f"{len(qids)} candidates with a Gutenberg text")
    out: dict[str, dict] = {}
    for i in range(0, len(qids), CHUNK):
        chunk = qids[i:i + CHUNK]
        query = Q.format(values=" ".join(f"wd:{q}" for q in chunk))
        data = cached_get("forms", SPARQL_ENDPOINT, {"query": query, "format": "json"},
                          cache_key=f"forms:{chunk[0]}:{len(chunk)}", timeout=120)
        if data is None:
            print(f"  chunk {i} FAILED", file=sys.stderr)
            continue
        for row in data["results"]["bindings"]:
            qid = row["work"]["value"].rsplit("/", 1)[-1]
            e = out.setdefault(qid, {"genres": [], "forms": []})
            for key, bucket in (("genreLabel", "genres"), ("formLabel", "forms")):
                v = row.get(key, {}).get("value")
                if v and not v.startswith("Q") and v not in e[bucket]:
                    e[bucket].append(v)
        print(f"  {i + len(chunk)}/{len(qids)}")
    OUT.write_text(json.dumps(out), encoding="utf-8")
    described = sum(1 for v in out.values() if v["genres"] or v["forms"])
    print(f"wrote {len(out)} entries to {OUT}; {described} have a genre or form")


if __name__ == "__main__":
    main()
