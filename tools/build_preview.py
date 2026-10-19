#!/usr/bin/env python3
"""Build the admin preview page: every shipped opening, before it runs.

The game hides titles on purpose, so there is no way inside it to read the
opening of a daily that has not come round yet -- which is exactly what writing
posts about it needs. This walks the built puzzles and writes a single
self-contained page: first sentence and the first two hint tiers for all 720,
with the daily schedule dates attached.

The 120 dailies carry all five tiers, because a daily is the one that cannot be
fixed after the fact -- this is where a bad excerpt gets caught before it runs.
The bank ships its first sentence only: 600 books' worth of hint tiers is 19MB
of page, and the bank can be read in the game itself.

Anything qa_puzzles.py flags is marked "check" on its entry, so the openings
worth a second look are findable rather than buried.

Every entry is written into the page as plain HTML, not JSON handed to a
script: a 2.5MB inline <script> is dropped in the artifact sandbox, and the
first cut of this page rendered its header and nothing else. Hints open through
<details>, so the page reads with no JavaScript at all; the search box is the
only thing script adds.
"""

from __future__ import annotations

import datetime
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from qa_puzzles import suspects  # noqa: E402
SITE = ROOT.parent
OUT = ROOT / "openings-preview.html"


def collect() -> tuple[list[dict], str]:
    idx = json.loads((SITE / "puzzles" / "index.json").read_text(encoding="utf-8"))
    start = datetime.date.fromisoformat(idx["startDate"])
    base = idx["dailyStartIndex"]
    rows = []
    for i, slug in enumerate(idx["order"]):
        p = json.loads((SITE / "puzzles" / f"{slug}.json").read_text(encoding="utf-8"))
        daily = i >= base
        # A daily carries all three tiers -- it is the one you write about
        # before it runs. The bank carries its first sentence: 600 books' worth
        # of hint tiers is 2MB of page for text nobody is scheduling around.
        depth = 5 if daily else 1
        rows.append({
            "n": i,
            "kind": "daily" if daily else "bank",
            "date": (start + datetime.timedelta(days=i - base)).isoformat() if daily else "",
            "title": p["title"],
            "author": p.get("author") or "",
            "year": p.get("year") or "",
            "gid": p["source"]["gutenberg"],
            "labels": p["labels"][:depth],
            "texts": p["texts"][:depth],
            "words": [len(t.split()) for t in p["texts"]],
            "flags": suspects(p) if daily else [],
        })
    return rows, idx["startDate"]


def shown(t: str) -> str:
    """A name the puzzle keeps back is written {{she}} in the text; the game
    prints it parenthesised, so the preview shows it that way too."""
    return re.sub(r"\{\{([^{}]+)\}\}", r"(\1)", str(t))


def esc(t: str) -> str:
    return (str(t).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def stamp(row: dict, today: datetime.date) -> tuple[str, str]:
    """How far off a daily is, in the words a person would use."""
    if row["kind"] != "daily":
        return "", "bank"
    d = (datetime.date.fromisoformat(row["date"]) - today).days
    if d == 0:
        return "today", "Today"
    if d < 0:
        n = abs(d)
        return "", f"{n} day{'s' if n != 1 else ''} ago"
    if d <= 14:
        return "soon", f"in {d} day{'s' if d != 1 else ''}"
    return "", f"in {d} days"


def entry(row: dict, today: datetime.date) -> str:
    cls, text = stamp(row, today)
    words = " / ".join(str(w) for w in row["words"][:3])
    parts = [
        f'<article class="entry" data-kind="{row["kind"]}" '
        f'data-find="{esc((row["title"] + " " + row["author"]).lower())}">',
        '<div class="rail">',
        f'<span class="idx">#{row["n"]}</span>',
        f'<span>{row["date"]}</span>' if row["date"] else "",
        f'<span class="chip {cls}">{text}</span>',
        f'<span class="chip check" title="{esc("; ".join(row["flags"]))}">check</span>'
        if row["flags"] else "",
        f'<span>pg{row["gid"]}</span>',
        "</div>",
        '<div class="body">',
        f'<h2>{esc(row["title"])}</h2>',
        f'<p class="byline">{esc(row["author"] or "unattributed")}'
        + (f' &middot; {esc(row["year"])}' if row["year"] else "")
        + f' &middot; {words} words per tier</p>',
        f'<p class="excerpt">{esc(shown(row["texts"][0]))}</p>',
    ]
    if row["flags"]:
        parts.append('<p class="flagged">qa_puzzles: '
                     + esc("; ".join(row["flags"])) + "</p>")
    for i in range(1, len(row["texts"])):
        parts += [
            "<details class=\"hint\">",
            f'<summary>Hint {i} &middot; {esc(row["labels"][i])} &middot; '
            f'{row["words"][i]} words</summary>',
            f'<p class="excerpt tier">{esc(shown(row["texts"][i]))}</p>',
            "</details>",
        ]
    parts += [
        '<p class="acts">',
        f'<a class="row-act" href="https://www.gutenberg.org/ebooks/{row["gid"]}" '
        'target="_blank" rel="noopener">Gutenberg</a>',
        f'<a class="row-act" href="https://excerptle.io/#/play/{row["n"]}" '
        f'target="_blank" rel="noopener">Play #{row["n"]}</a>',
        "</p></div></article>",
    ]
    return "".join(parts)


def section(title: str, note: str, rows: list[dict], today: datetime.date, sid: str) -> str:
    if not rows:
        return ""
    return (f'<section id="{sid}"><h2 class="sec"><span>{title}</span>'
            f'<span class="sec-n">{len(rows)}</span></h2>'
            f'<p class="sec-note">{note}</p>'
            + "".join(entry(r, today) for r in rows) + "</section>")


# The charset matters: this page is read straight off disk as often as it is
# published, and without it a browser falls back to windows-1252 and turns
# every curly quote in an opening into mojibake.
PAGE = """<meta charset="utf-8">
<title>Excerptle Openings</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root {
    --ground: #edeff2; --surface: #fff; --surface-2: #f5f6f9;
    --ink: #14171d; --ink-2: #49505f; --ink-3: #757d8d;
    --line: #d5d9e1; --line-2: #e6e9ee;
    --accent: #2c4a7c; --accent-soft: #dee6f3;
    --today: #7a4a17; --today-soft: #f5e5d2;
    --flag: #8a2f36; --flag-soft: #f6dfe0;
    --sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, monospace;
    --serif: "Newsreader", Georgia, "Times New Roman", serif;
  }
  :root:not([data-theme="light"]) { color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #0e1014; --surface: #161a21; --surface-2: #1b2029;
      --ink: #e8eaef; --ink-2: #a7afbd; --ink-3: #7c8596;
      --line: #2a313c; --line-2: #212832;
      --accent: #9cbcec; --accent-soft: #1e2a3d;
      --today: #e0ac6f; --today-soft: #33261a;
      --flag: #e79aa0; --flag-soft: #351d20;
    }
  }
  :root[data-theme="dark"] {
    --ground: #0e1014; --surface: #161a21; --surface-2: #1b2029;
    --ink: #e8eaef; --ink-2: #a7afbd; --ink-3: #7c8596;
    --line: #2a313c; --line-2: #212832;
    --accent: #9cbcec; --accent-soft: #1e2a3d;
    --today: #e0ac6f; --today-soft: #33261a;
    --flag: #e79aa0; --flag-soft: #351d20;
  }
  body {
    margin: 0; padding-block: 0 72px; padding-inline: 20px;
    background: var(--ground); color: var(--ink);
    font: 400 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 940px; margin: 0 auto; }
  header.masthead {
    display: flex; flex-wrap: wrap; align-items: flex-end; gap: 14px 28px;
    padding-block: 34px 18px; border-bottom: 2px solid var(--ink);
  }
  h1 {
    margin: 0; font-family: var(--serif); font-weight: 500;
    font-size: clamp(30px, 5vw, 40px); line-height: 1.05;
    letter-spacing: -0.015em; text-wrap: balance;
  }
  .masthead p { margin: 6px 0 0; color: var(--ink-2); max-width: 48ch; }
  .facts { display: flex; gap: 18px; flex-wrap: wrap; font: 400 12px/1.6 var(--mono); color: var(--ink-3); }
  .facts b { color: var(--ink); font-weight: 500; }
  .tools {
    position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap;
    gap: 10px; align-items: center; padding-block: 12px; margin-bottom: 6px;
    background: var(--ground); border-bottom: 1px solid var(--line-2);
  }
  .jump { display: flex; gap: 6px; flex-wrap: wrap; }
  .jump a {
    font: 500 12.5px/1 var(--sans); text-decoration: none; padding: 8px 12px;
    border: 1px solid var(--line); border-radius: 7px;
    background: var(--surface); color: var(--ink-2);
  }
  .jump a:hover { border-color: var(--accent); color: var(--accent); }
  input[type="search"] {
    flex: 1 1 200px; min-width: 0; padding: 9px 12px; border: 1px solid var(--line);
    border-radius: 7px; background: var(--surface); color: var(--ink);
    font: 400 14px/1.2 var(--sans);
  }
  input:focus-visible, .jump a:focus-visible, .row-act:focus-visible, summary:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .hits { font: 400 12px/1 var(--mono); color: var(--ink-3); }
  h2.sec {
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
    margin: 40px 0 0; padding-bottom: 8px; border-bottom: 1px solid var(--line);
    font-family: var(--serif); font-size: 24px; font-weight: 500;
  }
  .sec-n { font: 500 12px/1 var(--mono); color: var(--ink-3); }
  .sec-note { margin: 8px 0 0; color: var(--ink-3); font-size: 13px; max-width: 60ch; }
  .entry {
    display: grid; grid-template-columns: 96px 1fr; gap: 0 20px;
    padding-block: 20px; border-bottom: 1px solid var(--line-2);
  }
  .rail { display: flex; flex-direction: column; gap: 5px; font: 400 12px/1.35 var(--mono); color: var(--ink-3); }
  .rail .idx { font-size: 15px; font-weight: 500; color: var(--ink); }
  .chip {
    width: fit-content; padding: 2px 8px; border-radius: 999px;
    font: 500 11px/1.5 var(--sans); letter-spacing: 0.03em;
    background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--line-2);
  }
  .chip.today { background: var(--today-soft); color: var(--today); border-color: transparent; }
  .chip.soon { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .chip.check { background: var(--flag-soft); color: var(--flag); border-color: transparent; }
  .flagged {
    margin: 10px 0 0; padding: 8px 11px; border-left: 3px solid var(--flag);
    background: var(--flag-soft); color: var(--flag);
    font: 400 12.5px/1.45 var(--sans); max-width: 62ch; border-radius: 0 4px 4px 0;
  }
  .body h2 { margin: 0; font-family: var(--serif); font-size: 21px; font-weight: 500; line-height: 1.25; text-wrap: balance; }
  .byline { margin: 3px 0 0; color: var(--ink-2); font-size: 13.5px; }
  .excerpt { font-family: var(--serif); font-size: 17px; line-height: 1.6; margin: 12px 0 0; max-width: 62ch; white-space: pre-wrap; }
  .excerpt.tier { border-left: 2px solid var(--line); padding-left: 14px; color: var(--ink-2); font-size: 15.5px; }
  details.hint { margin-top: 10px; }
  details.hint summary {
    cursor: pointer; width: fit-content; font: 500 11.5px/1 var(--sans);
    letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3);
    padding: 6px 0;
  }
  details.hint[open] summary { color: var(--accent); }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; }
  .row-act {
    font: 500 12.5px/1 var(--sans); text-decoration: none; padding: 7px 11px;
    border: 1px solid var(--line); border-radius: 6px;
    background: var(--surface); color: var(--ink-2);
  }
  .row-act:hover { border-color: var(--accent); color: var(--accent); }
  .entry[hidden] { display: none; }
  @media (max-width: 620px) {
    .entry { grid-template-columns: 1fr; gap: 8px; }
    .rail { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 8px 10px; }
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

<div class="wrap">
  <header class="masthead">
    <div style="flex:1 1 340px">
      <h1>Excerptle Openings</h1>
      <p>Every shipped opening, readable before it runs. The game hides these; this page is for writing about them.</p>
    </div>
    <div class="facts">
      <span><b>__TOTAL__</b> books</span>
      <span><b>__DAILIES__</b> dailies</span>
      <span>through <b>__LAST__</b></span>
      <span>built <b>__BUILT__</b></span>
    </div>
  </header>

  <div class="tools">
    <div class="jump">
      <a href="#upcoming">Upcoming</a>
      <a href="#past">Already run</a>
      <a href="#bank">Book bank</a>
    </div>
    <input type="search" id="q" placeholder="Filter by title or author" autocomplete="off">
    <span class="hits" id="hits"></span>
  </div>

__SECTIONS__
</div>

<script>
(function () {
  var box = document.getElementById("q");
  var hits = document.getElementById("hits");
  var rows = Array.prototype.slice.call(document.querySelectorAll(".entry"));
  if (!box || !rows.length) return;
  box.addEventListener("input", function () {
    var q = box.value.trim().toLowerCase();
    var n = 0;
    rows.forEach(function (r) {
      var on = !q || r.dataset.find.indexOf(q) !== -1;
      r.hidden = !on;
      if (on) n++;
    });
    document.querySelectorAll("section").forEach(function (s) {
      var any = s.querySelector(".entry:not([hidden])");
      s.hidden = !!q && !any;
    });
    hits.textContent = q ? n + " of " + rows.length : "";
  });
})();
</script>
"""


def main() -> None:
    rows, _start = collect()
    # The game rolls its daily at UTC midnight, so the schedule is read in UTC
    # too -- a local date can put "Today" on the wrong book by a day.
    today = datetime.datetime.now(datetime.timezone.utc).date()
    dailies = [r for r in rows if r["kind"] == "daily"]
    upcoming = [r for r in dailies if datetime.date.fromisoformat(r["date"]) >= today]
    past = [r for r in dailies if datetime.date.fromisoformat(r["date"]) < today]
    bank = [r for r in rows if r["kind"] == "bank"]

    sections = "".join([
        section("Upcoming dailies", "In the order they will run, with all five hint tiers "
                "exactly as a player sees them. Entries marked <b>check</b> are what "
                "qa_puzzles.py flagged.", upcoming, today, "upcoming"),
        section("Already run", "Past dailies, most recent first.", list(reversed(past)), today, "past"),
        section("Book bank", "The 600 browsable books, first sentence only \u2014 the rest is "
                "readable in the game. Deeper tiers live in <code>puzzles/g&lt;id&gt;.json</code>.",
                bank, today, "bank"),
    ])
    html = (PAGE
            .replace("__SECTIONS__", sections)
            .replace("__TOTAL__", str(len(rows)))
            .replace("__DAILIES__", str(len(dailies)))
            .replace("__LAST__", dailies[-1]["date"])
            .replace("__BUILT__", today.isoformat()))
    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB): "
          f"{len(upcoming)} upcoming, {len(past)} past, {len(bank)} bank")


if __name__ == "__main__":
    main()
