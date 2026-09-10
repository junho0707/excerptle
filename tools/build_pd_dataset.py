#!/usr/bin/env python3
"""Build a fame-ranked dataset of pre-1931 (US public-domain) English books.

Sources (all verified reachable from this host; gutenberg.org/gutendex.com are
deliberately NOT touched -- a separate download-count scrape is in flight
against gutenberg.org and must not be disturbed):

  * query.wikidata.org/sparql  -- literary works (P31 = Q7725634) with a
    publication date (P577) <= 1930 and an English Wikipedia sitelink.
    Gives: title, author, year (+ precision caveat), Project Gutenberg id
    (P2034) when Wikidata already knows it, and the Wikidata QID.
  * www.wikidata.org/w/api.php (wbgetentities) -- sitelink COUNT per QID.
    Number of language Wikipedias carrying the work is our primary fame
    signal (a book with 40 editions is famous; one with 1 is not). Done via
    the plain wikidata API instead of a SPARQL aggregate because the
    aggregate query reliably timed out (60s WDQS budget) at this class size.
  * openlibrary.org/search.json -- first_publish_year (cross-check on year),
    ratings_count/average, readinglog_count, want_to_read_count,
    already_read_count, OpenLibrary work id, and OL's own idea of the
    Project Gutenberg id (id_project_gutenberg) as a second source for the
    gutenberg field.
  * en.wikipedia.org/w/api.php (prop=pageviews) -- last ~60 days of daily
    pageviews on the work's English Wikipedia article; summed over the most
    recent 30 as a recency-weighted fame signal.

Everything is cached under tools/.pd-cache/ so re-runs are cheap and the
script can be interrupted and resumed. Rate limit: ~2 req/s per host via a
small worker pool per host, User-Agent identifies us and gives contact info.

Usage:
    python3 tools/build_pd_dataset.py --stage sparql
    python3 tools/build_pd_dataset.py --stage sitelinks
    python3 tools/build_pd_dataset.py --stage enrich [--limit N]
    python3 tools/build_pd_dataset.py --stage build
    python3 tools/build_pd_dataset.py --stage all
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from queue import Queue

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".pd-cache"
UA = "excerptle-catalog/1.0 (junhoyoon00@gmail.com)"

SPARQL_ENDPOINT = "https://query.wikidata.org/sparql"
WD_API = "https://www.wikidata.org/w/api.php"
OL_SEARCH = "https://openlibrary.org/search.json"
WP_API = "https://en.wikipedia.org/w/api.php"

PAGE_SIZE = 1000
MAX_YEAR = 1930
# Windows sized so no single one needs a deep OFFSET; later years are denser.
YEAR_WINDOWS = [
    (-3000, 1799), (1800, 1849), (1850, 1869), (1870, 1884), (1885, 1894),
    (1895, 1899), (1900, 1904), (1905, 1909), (1910, 1914), (1915, 1919),
    (1920, 1924), (1925, 1930),
]

BANNED_HOSTS = ("gutenberg.org", "www.gutenberg.org", "gutendex.com")


# --------------------------------------------------------------------------
# low-level fetch: cached, IPv4-forced, polite
# --------------------------------------------------------------------------

def _check_host(url: str) -> None:
    host = urllib.parse.urlparse(url).netloc
    if any(b in host for b in BANNED_HOSTS):
        raise RuntimeError(f"refusing to hit banned host: {host}")


def _cache_path(subdir: str, key: str) -> Path:
    d = CACHE / subdir
    d.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()[:24]
    return d / f"{h}.json"


def cached_get(subdir: str, url: str, params: dict, cache_key: str | None = None,
                timeout: int = 60, retries: int = 3) -> dict | None:
    _check_host(url)
    key = cache_key or (url + "?" + urllib.parse.urlencode(params, doseq=True))
    path = _cache_path(subdir, key)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    full = url + "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(full, headers={"User-Agent": UA, "Accept": "application/json"})
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8", "replace")
            data = json.loads(raw)
            path.write_text(json.dumps(data), encoding="utf-8")
            return data
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            time.sleep(2 * (attempt + 1))
    sys.stderr.write(f"FAILED {full[:120]} : {last_err}\n")
    return None


class HostWorker:
    """~2 req/s pool against one host, used for the enrich stage."""

    def __init__(self, n=2, delay=1.0):
        self.q: Queue = Queue()
        self.results: dict = {}
        self.lock = threading.Lock()
        self.threads = [threading.Thread(target=self._run, args=(delay,), daemon=True) for _ in range(n)]
        for t in self.threads:
            t.start()

    def _run(self, delay):
        while True:
            item = self.q.get()
            if item is None:
                self.q.task_done()
                return
            job_id, fn = item
            try:
                res = fn()
            except Exception as e:  # noqa: BLE001
                res = None
                sys.stderr.write(f"worker error {job_id}: {e}\n")
            with self.lock:
                self.results[job_id] = res
            time.sleep(delay)
            self.q.task_done()

    def submit(self, job_id, fn):
        self.q.put((job_id, fn))

    def join(self):
        self.q.join()

    def stop(self):
        for _ in self.threads:
            self.q.put(None)


# --------------------------------------------------------------------------
# Stage 1: SPARQL -- literary works, date <= 1930, has enwiki sitelink
# --------------------------------------------------------------------------

SPARQL_TEMPLATE = """
SELECT ?work ?workLabel ?authorLabel ?date ?pgid ?enTitle WHERE {{
  ?work wdt:P31 wd:Q7725634 .
  ?work wdt:P577 ?date .
  FILTER(YEAR(?date) >= {min_year} && YEAR(?date) <= {max_year})
  ?enwiki schema:about ?work ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?enTitle .
  OPTIONAL {{ ?work wdt:P50 ?author . }}
  OPTIONAL {{ ?work wdt:P2034 ?pgid . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
ORDER BY ?work
LIMIT {limit}
OFFSET {offset}
"""


def qid_from_uri(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


def stage_sparql() -> list[dict]:
    """Fetch every page, group rows by work QID (OPTIONAL author/pgid can
    multiply rows for the same work)."""
    grouped: dict[str, dict] = {}
    incomplete = []
    for lo, hi in YEAR_WINDOWS:
        offset = 0
        while True:
            query = SPARQL_TEMPLATE.format(min_year=lo, max_year=hi, limit=PAGE_SIZE, offset=offset)
            data = cached_get(
                "sparql", SPARQL_ENDPOINT, {"query": query, "format": "json"},
                cache_key=f"sparql:{hashlib.sha1(query.encode()).hexdigest()[:12]}:{offset}",
                timeout=120,
            )
            if data is None:
                print(f"  {lo}-{hi} offset={offset} FAILED — window incomplete", file=sys.stderr)
                incomplete.append((lo, hi, offset))
                break
            rows = data["results"]["bindings"]
            print(f"  {lo}-{hi} offset={offset}: {len(rows)} rows")
            _absorb(grouped, rows)
            if len(rows) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
            time.sleep(0.5)
    if incomplete:
        print(f"  WARNING: {len(incomplete)} window(s) incomplete: {incomplete}", file=sys.stderr)
    return _finish(grouped)


def _absorb(grouped: dict, rows: list) -> None:
    """Fold result rows into the per-work map. OPTIONAL author/pgid multiply
    rows for one work, so authors and Gutenberg ids accumulate into sets."""
    for row in rows:
        qid = qid_from_uri(row["work"]["value"])
        g = grouped.setdefault(qid, {
            "wikidata": qid,
            "title": row.get("enTitle", {}).get("value") or row.get("workLabel", {}).get("value"),
            "authors": set(),
            "date": row.get("date", {}).get("value"),
            "pgids": set(),
        })
        if "authorLabel" in row:
            g["authors"].add(row["authorLabel"]["value"])
        if "pgid" in row:
            g["pgids"].add(row["pgid"]["value"])


def _finish(grouped: dict) -> list[dict]:
    out = []
    for g in grouped.values():
        year = None
        if g["date"]:
            try:
                year = int(g["date"][:4])
            except ValueError:
                year = None
        pgid = None
        if g["pgids"]:
            for p in g["pgids"]:
                try:
                    pgid = int(p)
                    break
                except ValueError:
                    continue
        out.append({
            "wikidata": g["wikidata"],
            "title": g["title"],
            "author": " & ".join(sorted(g["authors"])) if g["authors"] else None,
            "year": year,
            "year_source": "wikidata:P577",
            "gutenberg": pgid,
        })
    (CACHE / "works.json").write_text(json.dumps(out), encoding="utf-8")
    print(f"stage_sparql: {len(out)} distinct works")
    return out


# --------------------------------------------------------------------------
# Stage 2: sitelink counts, batched 50 QIDs/request against wikidata API
# --------------------------------------------------------------------------

def stage_sitelinks(works: list[dict]) -> dict[str, int]:
    qids = [w["wikidata"] for w in works]
    counts: dict[str, int] = {}
    batch = 50
    for i in range(0, len(qids), batch):
        chunk = qids[i:i + batch]
        data = cached_get(
            "sitelinks", WD_API,
            {"action": "wbgetentities", "props": "sitelinks", "ids": "|".join(chunk), "format": "json"},
            cache_key="sitelinks:" + ",".join(sorted(chunk)),
        )
        if data is None:
            continue
        for qid, ent in data.get("entities", {}).items():
            counts[qid] = len(ent.get("sitelinks", {}))
        if i % 1000 == 0:
            print(f"  sitelinks {i}/{len(qids)}")
        time.sleep(0.5)
    (CACHE / "sitelinks.json").write_text(json.dumps(counts), encoding="utf-8")
    print(f"stage_sitelinks: {len(counts)} qids covered")
    return counts


# --------------------------------------------------------------------------
# Stage 3: enrich with OpenLibrary + Wikipedia pageviews
# --------------------------------------------------------------------------

def ol_lookup(title: str, author: str | None) -> dict | None:
    q = title if not author else f"{title} {author}"
    fields = "first_publish_year,ratings_count,ratings_average,readinglog_count,want_to_read_count,already_read_count,id_project_gutenberg,key,language,title,author_name"
    data = cached_get(
        "ol", OL_SEARCH,
        {"q": q, "limit": 1, "fields": fields},
        cache_key="ol:" + q.lower(),
        timeout=30,
    )
    if not data or not data.get("docs"):
        return None
    return data["docs"][0]


def wp_pageviews(title: str) -> int | None:
    data = cached_get(
        "pv", WP_API,
        {"action": "query", "prop": "pageviews", "titles": title, "format": "json"},
        cache_key="pv:" + title,
        timeout=30,
    )
    if not data:
        return None
    pages = data.get("query", {}).get("pages", {})
    for _, page in pages.items():
        pv = page.get("pageviews") or {}
        vals = [v for v in pv.values() if isinstance(v, int)]
        if not vals:
            return None
        # last 30 days of the ~60-day window returned
        return sum(vals[-30:])
    return None


def stage_enrich(works: list[dict], limit: int | None) -> dict[str, dict]:
    ordered = sorted(works, key=lambda w: -(w.get("sitelinks") or 0))
    if limit:
        # A work with a Gutenberg text is actionable today, so it is enriched
        # whatever its sitelink rank; the limit only trims the rest of the tail.
        head = ordered[:limit]
        seen = {w["wikidata"] for w in head}
        ordered = head + [w for w in ordered[limit:] if w.get("gutenberg") and w["wikidata"] not in seen]
    ol_worker = HostWorker(n=2, delay=1.0)
    pv_worker = HostWorker(n=2, delay=1.0)
    for w in ordered:
        wid = w["wikidata"]
        ol_worker.submit(wid, lambda w=w: ol_lookup(w["title"], w.get("author")))
        pv_worker.submit(wid, lambda w=w: wp_pageviews(w["title"]))
    ol_worker.join()
    pv_worker.join()
    ol_worker.stop()
    pv_worker.stop()
    enrich = {}
    for wid in [w["wikidata"] for w in ordered]:
        enrich[wid] = {
            "ol": ol_worker.results.get(wid),
            "pageviews_30d": pv_worker.results.get(wid),
        }
    (CACHE / "enrich.json").write_text(json.dumps(enrich), encoding="utf-8")
    print(f"stage_enrich: enriched {len(enrich)} works (of {len(works)} total candidates)")
    return enrich


# --------------------------------------------------------------------------
# Bank join
# --------------------------------------------------------------------------

STOP_LEAD = re.compile(r"^(the|a|an)\s+", re.I)
PUNCT = re.compile(r"[^a-z0-9 ]")


def norm(s: str | None) -> str:
    if not s:
        return ""
    s = s.lower().strip()
    s = STOP_LEAD.sub("", s)
    s = PUNCT.sub("", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def load_bank() -> list[dict]:
    """Prefer book_popularity.json (produced by the concurrent
    gutenberg.org download-count scrape) since it already carries slug,
    tier and a real downloads30 figure per book -- exactly what we need
    both for the join and for validating fame_score against readership.
    Falls back to books.json + extra_books.json (year=0 for the auto
    tier) if that file isn't there yet."""
    pop_path = ROOT / "book_popularity.json"
    if pop_path.exists():
        bank = json.loads(pop_path.read_text(encoding="utf-8"))
        years = {}
        for fname in ("books.json", "extra_books.json"):
            p = ROOT / fname
            if p.exists():
                for b in json.loads(p.read_text(encoding="utf-8")):
                    years[b["slug"]] = b.get("year")
        for b in bank:
            b["year"] = years.get(b["slug"]) or None
        return bank
    seed = json.loads((ROOT / "books.json").read_text(encoding="utf-8"))
    extra = json.loads((ROOT / "extra_books.json").read_text(encoding="utf-8"))
    for b in seed:
        b["tier"] = "curated"
    for b in extra:
        b["tier"] = "auto"
    return seed + extra


def build_bank_index(bank: list[dict]):
    by_gid = {}
    by_title_author = {}
    for b in bank:
        gid = b.get("gutenberg")
        if gid:
            by_gid[int(gid)] = b
        key = (norm(b.get("title")), norm(b.get("author")))
        by_title_author.setdefault(key, b)
        # also index by title alone as fallback
    by_title = {}
    for b in bank:
        by_title.setdefault(norm(b.get("title")), b)
    return by_gid, by_title_author, by_title


def match_bank(cand: dict, by_gid, by_title_author, by_title):
    gid = cand.get("gutenberg")
    if gid and int(gid) in by_gid:
        b = by_gid[int(gid)]
        return True, b["slug"]
    key = (norm(cand.get("title")), norm(cand.get("author")))
    if key in by_title_author:
        return True, by_title_author[key]["slug"]
    tkey = norm(cand.get("title"))
    if tkey and tkey in by_title:
        return True, by_title[tkey]["slug"]
    return False, None


# --------------------------------------------------------------------------
# Fame score + final build
# --------------------------------------------------------------------------

def log_scale(x, cap):
    import math
    if not x or x <= 0:
        return 0.0
    return min(1.0, math.log10(1 + x) / math.log10(1 + cap))


def fame_score(row: dict) -> float:
    """0-100 composite. Weighted toward sitelinks (cross-language notability,
    available for ~all candidates) with pageviews and OpenLibrary engagement
    as secondary, log-scaled signals (each caps out so one huge outlier like
    a Bible-scale value can't dominate)."""
    sitelinks = row.get("sitelinks") or 0
    pageviews = row.get("pageviews_30d") or 0
    readinglog = row.get("readinglog_count") or 0
    ratings = row.get("ratings_count") or 0

    s_sitelinks = log_scale(sitelinks, 60)      # 60+ languages ~ maximal fame
    s_pageviews = log_scale(pageviews, 100000)  # 100k/30d ~ maximal
    s_reading = log_scale(readinglog, 20000)
    s_ratings = log_scale(ratings, 3000)

    score = 100 * (0.45 * s_sitelinks + 0.25 * s_pageviews + 0.20 * s_reading + 0.10 * s_ratings)
    return round(score, 2)


def stage_build():
    works = json.loads((CACHE / "works.json").read_text(encoding="utf-8"))
    sitelinks = json.loads((CACHE / "sitelinks.json").read_text(encoding="utf-8"))
    enrich_path = CACHE / "enrich.json"
    enrich = json.loads(enrich_path.read_text(encoding="utf-8")) if enrich_path.exists() else {}

    bank = load_bank()
    by_gid, by_title_author, by_title = build_bank_index(bank)

    rows = []
    for w in works:
        wid = w["wikidata"]
        sl = sitelinks.get(wid)
        e = enrich.get(wid) or {}
        ol = e.get("ol")
        year = w.get("year")
        year_source = w.get("year_source")
        gutenberg = w.get("gutenberg")
        title = w.get("title")
        author = w.get("author")
        languages = ["en"]  # gate: work has an English Wikipedia article
        if ol:
            if ol.get("id_project_gutenberg") and not gutenberg:
                try:
                    gutenberg = int(ol["id_project_gutenberg"][0])
                except (ValueError, IndexError):
                    pass
            ol_year = ol.get("first_publish_year")
            if ol_year and (year is None or ol_year < year):
                # OpenLibrary's first_publish_year is usually the true first
                # edition and a good cross-check / fallback against a
                # Wikidata P577 date that might reflect a later edition.
                if year is None:
                    year = ol_year
                    year_source = "openlibrary:first_publish_year"
            ol_langs = ol.get("language") or []
            if ol_langs:
                languages = ol_langs

        row = {
            "title": title,
            "author": author,
            "year": year,
            "year_source": year_source,
            "languages": languages,
            "gutenberg": gutenberg,
            "wikidata": wid,
            "openlibrary": (ol.get("key") or "").replace("/works/", "") if ol else None,
            "sitelinks": sl,
            "readinglog_count": ol.get("readinglog_count") if ol else None,
            "want_to_read_count": ol.get("want_to_read_count") if ol else None,
            "already_read_count": ol.get("already_read_count") if ol else None,
            "ratings_count": ol.get("ratings_count") if ol else None,
            "ratings_average": ol.get("ratings_average") if ol else None,
            "pageviews_30d": e.get("pageviews_30d"),
            "enriched": bool(e),
        }
        row["fame_score"] = fame_score(row)
        in_bank, slug = match_bank(row, by_gid, by_title_author, by_title)
        row["in_bank"] = in_bank
        row["bank_slug"] = slug
        if in_bank:
            bank_row = by_gid.get(int(gutenberg)) if gutenberg and int(gutenberg) in by_gid else None
            if bank_row is None:
                bank_row = next((b for b in bank if b["slug"] == slug), None)
            row["bank_downloads30"] = bank_row.get("downloads30") if bank_row else None
            row["bank_tier"] = bank_row.get("tier") if bank_row else None
        rows.append(row)

    rows.sort(key=lambda r: -r["fame_score"])
    (ROOT / "pd_candidates.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print(f"stage_build: wrote {len(rows)} rows to tools/pd_candidates.json")

    matched = sum(1 for r in rows if r["in_bank"])
    print(f"  bank matches: {matched} / {len(bank)} bank books")
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["sparql", "sitelinks", "enrich", "build", "all"], default="all")
    ap.add_argument("--limit", type=int, default=None, help="cap enrich stage to top-N by sitelinks")
    args = ap.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)

    if args.stage in ("sparql", "all"):
        works = stage_sparql()
    else:
        works = json.loads((CACHE / "works.json").read_text(encoding="utf-8")) if (CACHE / "works.json").exists() else []

    if args.stage in ("sitelinks", "all"):
        stage_sitelinks(works)

    if args.stage in ("enrich", "all"):
        sitelinks = json.loads((CACHE / "sitelinks.json").read_text(encoding="utf-8"))
        for w in works:
            w["sitelinks"] = sitelinks.get(w["wikidata"])
        stage_enrich(works, args.limit)

    if args.stage in ("build", "all"):
        stage_build()


if __name__ == "__main__":
    main()
