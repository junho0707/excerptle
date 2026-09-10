#!/usr/bin/env python3
"""Cut the launch lists: 120 dailies and a 600-book bank.

Five sources feed one pool, keyed by Gutenberg id:
  book_popularity      the 863 already shipped
  candidate_downloads  Wikidata works that carried a Gutenberg id
  english_editions     translations re-pointed at the English edition
  matched_downloads    works Wikidata never linked, matched via the catalogue
  pool_resolved        the hand-curated pool -- the quality anchor

Everything ranks on Gutenberg downloads over the last 30 days, except that a
book in the hand-curated pool outranks one that is not, S before A before B.
The pool encodes "somebody has actually heard of this", which no automatic
signal reproduces.

Two gates run on top of the ranking, each fed by a file another script writes:

  bad_ids.json       verify_ids.py -- ids whose text is not the book the join
                     named. Collections are dropped, mislabelled ids retitled
                     to what Gutenberg calls them.
  pg_catalog.csv.gz  Gutenberg's own catalogue -- its Library of Congress
                     class is the cheapest fiction test there is: PR/PS/PQ/PZ
                     and the rest of P are literature, B is philosophy, D is
                     history, HG is banking. A non-P book that Wikipedia does
                     not describe as a narrative is a treatise, not a novel.
  form_verdicts.json classify_form.py -- what Wikipedia's lead sentence calls
                     each book. Wikidata carries no form for 256 of the bank
                     rows, which is how a dictionary, a treatise on money
                     markets and an anthology of verse reached the shipped set.
                     An untiered non-narrative book is dropped; a curated one
                     is kept, because the owner picked it on purpose.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import gzip
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from build_pd_dataset import norm  # noqa: E402

TIER_RANK = {"S": 0, "A": 1, "B": 2, "": 3}

# Gutenberg carries several editions of the same book under different ids --
# Jekyll and Hyde is both pg42 and pg43 -- and a duplicate is worse here than
# anywhere else: two dailies could be the same book.
PARTIAL = re.compile(
    r"(chapters?\s+\d|volume\s+[ivx\d]|vol\.?\s*[ivx\d]|part\s+[ivx\d]|\bin \d+ volumes\b)",
    re.I)

BAD_IDS = json.loads((ROOT / "bad_ids.json").read_text(encoding="utf-8")) \
    if (ROOT / "bad_ids.json").exists() else []
DROP_IDS = {int(b["gutenberg"]) for b in BAD_IDS if b["action"] == "drop"}
RETITLE = {int(b["gutenberg"]): b["title_actual"] for b in BAD_IDS if b["action"] == "retitle"}

FORM = json.loads((ROOT / "form_verdicts.json").read_text(encoding="utf-8")) \
    if (ROOT / "form_verdicts.json").exists() else {}

# Hand decisions on top of both gates: an id that is not one book, or one whose
# text is a real book the catalogue names differently (pg61620 is billed as The
# Curse of Capistrano and reads as The Mark of Zorro).
OVERRIDES = json.loads((ROOT / "overrides.json").read_text(encoding="utf-8")) \
    if (ROOT / "overrides.json").exists() else {}
DROP_IDS_MANUAL = {int(k) for k in OVERRIDES.get("drop", {})}
RETITLE_MANUAL = {int(k): v for k, v in OVERRIDES.get("retitle", {}).items()}
# Editions no source volunteered. Gutenberg's modern-spelling Shakespeare is
# only reachable this way: every automatic source points at the old-spelling
# texts, which open on Gutenberg's note about the spelling instead of the play.
ADD_MANUAL = {int(k): v for k, v in OVERRIDES.get("add", {}).items()}

def _locc() -> dict[int, str]:
    p = ROOT / ".pg-meta-cache" / "pg_catalog.csv.gz"
    if not p.exists():
        return {}
    with gzip.open(p, "rt", encoding="utf-8") as f:
        return {int(r["Text#"]): r["LoCC"] for r in csv.DictReader(f) if r["Text#"].isdigit()}


LOCC = _locc()

NON_NARRATIVE_FORMS = {"poem", "poetry collection", "ballad", "Lied",
                       "picture book", "anthology", "letter", "conversation"}
NON_NARRATIVE_GENRES = {"poetry", "essay", "non-fiction"}

FIELDS = ["rank", "tier", "gutenberg", "title", "author", "year", "downloads_30d",
          "form", "source", "in_old_bank", "old_slug"]


def read(name):
    p = ROOT / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


def build_pool() -> dict[int, dict]:
    """One row per Gutenberg id. Later sources only fill gaps, except the
    curated pool, whose tier and title always win."""
    by_gid: dict[int, dict] = {}

    def add(gid, **kw):
        if gid is None:
            return
        gid = int(gid)
        row = by_gid.setdefault(gid, {"gutenberg": gid})
        for k, v in kw.items():
            if v not in (None, "", []) and not row.get(k):
                row[k] = v

    for b in read("book_popularity.json"):
        add(b["gutenberg"], title=b["title"], author=b["author"],
            downloads_30d=b["downloads30"], languages=b.get("languages"),
            source="old-bank", in_old_bank=True, old_slug=b["slug"])
    for c in read("candidate_downloads.json"):
        add(c.get("gutenberg"), title=c["title"], author=c.get("author"),
            year=c.get("year"), downloads_30d=c.get("downloads30"),
            languages=c.get("pg_languages"), source="wikidata")
    for e in read("english_editions.json"):
        add(e.get("en_gutenberg"), title=e["title"], author=e.get("author"),
            year=e.get("year"), downloads_30d=e.get("downloads30"),
            languages=e.get("pg_languages"), source="translation")
    for m in read("matched_downloads.json"):
        add(m.get("gutenberg"), title=m["title"], author=m.get("author"),
            year=m.get("year"), downloads_30d=m.get("downloads30"),
            languages=m.get("pg_languages"), source="catalogue-match")

    forms = json.loads((ROOT / ".pd-cache" / "forms.json").read_text(encoding="utf-8"))
    works = json.loads((ROOT / ".pd-cache" / "works.json").read_text(encoding="utf-8"))
    for w in works:
        if w.get("gutenberg") and int(w["gutenberg"]) in by_gid:
            f = forms.get(w["wikidata"], {})
            r = by_gid[int(w["gutenberg"])]
            r.setdefault("form", ";".join(f.get("forms", [])))
            r.setdefault("genre", ";".join(f.get("genres", [])))
            r.setdefault("year", w.get("year"))

    # The curated pool overrides: its tier is the whole point, and its titles
    # are the ones players would actually type.
    for p in read("pool_resolved.json"):
        if not p.get("gutenberg"):
            continue
        gid = int(p["gutenberg"])
        row = by_gid.setdefault(gid, {"gutenberg": gid})
        row.update({
            "tier": p["tier"], "title": p["title"], "author": p["author"],
            "year": p.get("year") or row.get("year"),
            "form": p.get("form") or row.get("form", ""),
            "downloads_30d": p.get("downloads30") or row.get("downloads_30d"),
            "languages": p.get("pg_languages") or row.get("languages"),
            "source": "curated-pool",
        })
    return by_gid


WIKI = json.loads((ROOT / ".pd-cache" / "wikipedia.json").read_text(encoding="utf-8")) \
    if (ROOT / ".pd-cache" / "wikipedia.json").exists() else {}


def known(r: dict) -> bool:
    """Someone wrote an encyclopedia entry about it. A curated-pool book is
    exempt: it was vetted by hand, which is a stronger signal than the gate."""
    if r.get("tier"):
        return True
    return bool(WIKI.get(str(r["gutenberg"])))


def narrative(r: dict) -> bool:
    """What Wikipedia's lead sentence calls it, backed by where the Library of
    Congress files it. A curated book is exempt: the owner chose The Prince and
    A Modest Proposal knowing what they are.

    The two signals cover each other. Wikipedia names the form outright for
    most books but says only "is a book by X" for a few hundred, which is how
    Lombard Street and Democracy and Education reached the bank. The LoCC class
    catches those -- and on its own would throw out News from Nowhere and
    Twelve Years a Slave, filed under socialism and slavery rather than
    literature, so a book Wikipedia calls a narrative survives a non-P class."""
    if r.get("tier"):
        return True
    verdict = str(FORM.get(str(r["gutenberg"]), ""))
    if verdict.startswith("non-narrative"):
        return False
    locc = LOCC.get(int(r["gutenberg"]), "")
    if locc and not locc.startswith("P"):
        return verdict.startswith("narrative")
    return True


def playable(r: dict) -> bool:
    """English, priced, and long enough to cut an excerpt ladder from. A pool
    book is exempt from the shape test -- it was vetted by hand."""
    if r.get("languages") != ["en"] or not r.get("downloads_30d"):
        return False
    if r.get("tier"):
        return True
    forms = {x for x in (r.get("form") or "").split(";") if x}
    genres = {x for x in (r.get("genre") or "").split(";") if x}
    if forms:
        return not (forms & NON_NARRATIVE_FORMS) or bool(forms - NON_NARRATIVE_FORMS)
    return not (genres & NON_NARRATIVE_GENRES)


def title_key(t: str) -> str:
    """Compare titles the way a reader would. Editions differ by subtitle and
    punctuation -- "Moby-Dick" and "Moby Dick; Or, The Whale" are one book -- so
    cut at the subtitle and treat punctuation as a space rather than deleting it
    (which would glue "Moby-Dick" into one word and hide the match)."""
    t = (t or "").lower()
    t = re.split(r"[;:]", t)[0]
    t = re.sub(r"[^a-z0-9]+", " ", t).strip()
    t = re.sub(r"^(the|a|an)\s+", "", t)
    return re.sub(r"\s+", " ", t).strip()


def same_book(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b or a.startswith(b + " ") or b.startswith(a + " "):
        return True
    # A plain singular/plural or spelling drift between editions.
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.90


def dedupe(rows: list[dict]) -> tuple[list[dict], list[tuple[dict, dict]]]:
    """One row per work, keeping the edition with the wider readership. Grouped
    by author first so a fuzzy title test cannot merge two different authors."""
    kept: dict[str, list[dict]] = {}
    out, dropped = [], []
    # A pinned edition wins its group outright; everything else by readership.
    for r in sorted(rows, key=lambda r: (not r.get("preferred"), -(r["downloads_30d"] or 0))):
        surname = norm((r.get("author") or "").split("&")[0]).split(" ")[-1]
        key = title_key(r["title"])
        bucket = kept.setdefault(surname, [])
        match = next((k for k in bucket if same_book(key, title_key(k["title"]))), None)
        if match is not None:
            dropped.append((r, match))
            continue
        bucket.append(r)
        out.append(r)
    return out, dropped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dailies", type=int, default=120)
    ap.add_argument("--bank", type=int, default=600)
    ap.add_argument("--exclude", default="unusable.json",
                    help="JSON list of {gutenberg, reason} to drop from the pool: "
                         "books with no usable text, so the next candidate takes the slot")
    args = ap.parse_args()

    dead = {}
    ex = ROOT / args.exclude
    if ex.exists():
        dead = {int(r["gutenberg"]): r.get("reason", "") for r in json.loads(ex.read_text(encoding="utf-8"))}

    pool = build_pool()
    for gid, row in ADD_MANUAL.items():
        pool[gid] = {"gutenberg": gid, "languages": ["en"], "source": "override",
                     "preferred": True, **row}
    # An id that turned out to hold a different book is called what Gutenberg
    # calls it, before the dedupe runs -- otherwise Macbeth-as-Taming-of-the-
    # Shrew survives as a second, wrongly answered copy of a play we already
    # have.
    for gid, title in {**RETITLE, **RETITLE_MANUAL}.items():
        if gid in pool:
            pool[gid]["title"] = title
    rows = [r for r in pool.values()
            if playable(r) and narrative(r)
            and r["gutenberg"] not in dead
            and r["gutenberg"] not in DROP_IDS
            and r["gutenberg"] not in DROP_IDS_MANUAL]
    # A part-file is a fragment of a book, not the book.
    partial = [r for r in rows if PARTIAL.search(r["title"] or "")]
    rows = [r for r in rows if r not in partial]
    rows, dropped = dedupe(rows)
    unknown = [r for r in rows if not known(r)]
    rows = [r for r in rows if known(r)]
    for r in rows:
        r.setdefault("tier", "")
    rows.sort(key=lambda r: (TIER_RANK[r.get("tier", "")], -(r["downloads_30d"] or 0)))

    # Dailies come off the top of S and A only; the rest of S/A falls through
    # to the bank so the browsable set is not left with only the long tail.
    sa = [r for r in rows if r.get("tier") in ("S", "A")]
    dailies = sa[:args.dailies]
    chosen = {r["gutenberg"] for r in dailies}
    bank = [r for r in rows if r["gutenberg"] not in chosen][:args.bank]

    for i, r in enumerate(dailies, 1):
        r["rank"] = i
    for i, r in enumerate(bank, 1):
        r["rank"] = i

    for name, data in (("final_dailies", dailies), ("final_bank", bank)):
        with (ROOT / f"{name}.csv").open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
            w.writeheader()
            w.writerows(data)
        (ROOT / f"{name}.json").write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if dead:
        print(f"dropped as unusable: {len(dead)}")
    print(f"dropped as a wrong id: {len(DROP_IDS)} collections, {len(RETITLE)} retitled")
    print(f"dropped as partial editions: {len(partial)}")
    print(f"dropped as duplicate editions: {len(dropped)}")
    for r, kept in dropped[:8]:
        print(f"    pg{r['gutenberg']} {r['title'][:34]:<34} -> kept pg{kept['gutenberg']} ({kept['downloads_30d']})")
    print(f"dropped with no Wikipedia article: {len(unknown)}")
    print(f"playable pool: {len(rows)} books")
    print(f"  S {sum(1 for r in rows if r.get('tier')=='S')}  "
          f"A {sum(1 for r in rows if r.get('tier')=='A')}  "
          f"B {sum(1 for r in rows if r.get('tier')=='B')}  "
          f"untiered {sum(1 for r in rows if not r.get('tier'))}")
    print(f"\ndailies: {len(dailies)}  (S {sum(1 for r in dailies if r['tier']=='S')}, "
          f"A {sum(1 for r in dailies if r['tier']=='A')})")
    print(f"  downloads {dailies[0]['downloads_30d']} .. {dailies[-1]['downloads_30d']}")
    print(f"bank: {len(bank)}  (tiered {sum(1 for r in bank if r['tier'])}, "
          f"untiered {sum(1 for r in bank if not r['tier'])})")
    print(f"  reused from the shipped 863: {sum(1 for r in bank if r.get('in_old_bank'))}")
    print(f"  download floor: {bank[-1]['downloads_30d']}")
    print("\nfirst 15 dailies:")
    for r in dailies[:15]:
        print(f"  {r['rank']:>3} [{r['tier']}] {r['downloads_30d']:>7}  {r['title'][:40]:<40} {(r['author'] or '')[:20]}")


if __name__ == "__main__":
    main()
