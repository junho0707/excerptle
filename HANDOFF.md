# Excerptle — handoff

Everything below is uncommitted work in the tree. **The game has no users yet**, so
nothing here needs a data migration, a compatibility shim, or a key-versioning
dance. Old rows, old share links and old localStorage keys can be discarded.

---

## What this project is becoming

Excerptle was a speed-based literary guessing game. It is being turned into a
**book discovery game**: read the opening of a public-domain book, take as many
hints as you like, name the book. Reading more is the point, so nothing is timed
and the tone is "check out this book", not "can you beat this".

Battle mode stays competitive — it is the one opt-in head-to-head surface.

---

## Part 1 — DONE (verify, do not redo)

### The redesign, already implemented
| change | where |
|---|---|
| Timer removed entirely | `js/app.js` (`startRoundTimers`/`stopRoundTimers` replaced the elapsed clock; `state.startedAt` deleted), `index.html`, `css/app.css` |
| Leaderboard ranks hints → guesses → earliest solve | `backend/src/worker.js` `scores()`, `js/app.js` `rankSort`/`pushLb` |
| `time_ms` no longer ranked on | still accepted and stored (column is NOT NULL); never compared |
| New index | `backend/migrations/0004_rank_without_time.sql` |
| Share copy | `tools/og-worker/share.js`, `card.js` — "Check out this book." |
| Old share links with a `t` field | still parse, value simply not displayed (covered by a test) |
| Stats page | "Books discovered / Authors / Openings read" block added; every "Fastest" row removed |
| Solved books show their title in the bank grid | `js/app.js` `renderBank`, `.bank-t`/`.bank-n`/`.bank-tick` in CSS. Progress rows now store `title` + `author` on finish |
| Fabricated puzzle stats deleted | `tools/build_puzzles.py` `fun_for()` used to emit a give-up rate and median solve time derived from `gid % 17`. Nothing ever rendered them. The `coffees` rating and the whole `fun` block are gone too |

Tests pass: `backend` 11/11, `tools/og-worker` 3 pass + 1 skipped (needs wrangler dev).

**Gotcha for future migrations:** `backend/test/billing.test.js` splits migration
files on `;`. A semicolon *inside a SQL comment* leaves a comment-only chunk and
fails the whole run. Keep semicolons out of comments.

### The dataset, rebuilt (2026-09-09, second pass)

`tools/final_dailies.csv/.json` (120) and `tools/final_bank.csv/.json` (600) --
720 books, all 720 texts cached, all 720 puzzles built, no overlap.

The first cut shipped strays: a satirical dictionary, a treatise on the money
market, Gladstone on Homer, an anthology of English verse, `Studies on Homer
and the Homeric Age`. It also shipped **wrong ids**: pg2264 is Macbeth, not The
Taming of the Shrew, and pg2263 is Julius Caesar, not Richard III -- a run of
the 22xx Shakespeare series was off by one work, so those puzzles were
unwinnable (the answer they accepted was not the book on screen). Both classes
are now gates in the pipeline rather than hand edits:

| gate | script | file it writes | what it does |
|---|---|---|---|
| wrong id | `tools/verify_ids.py` | `tools/bad_ids.json` | compares each id against Gutenberg's own catalogue. An omnibus or numbered volume is dropped (22 of them); an id that holds a different work by the same author is **retitled** to what Gutenberg calls it (15), so the dedupe collapses it against the edition we already have |
| non-narrative | `tools/classify_form.py` | `tools/form_verdicts.json` | what English Wikipedia's lead sentence calls the book ("is an 1897 novel", "is a treatise"), for all 2,308 candidates. Verse beats every other word: a poem collapses tiers 2-5 |
| non-fiction | (same gate) | `pg_catalog.csv.gz` | the Library of Congress class. Non-P (B philosophy, D history, HG banking) plus no narrative verdict = drop. The two signals cover each other: Wikipedia says only "is a book by X" for a few hundred, and LoCC alone would throw out News from Nowhere and Twelve Years a Slave, filed under socialism and slavery |

A curated (S/A/B) book is exempt from the form gates -- The Prince, A Modest
Proposal, Walden and The Souls of Black Folk are non-narrative on purpose.

`tools/overrides.json` holds the decisions no rule can make: `drop` (First
Folio, one volume of Burton's Nights, The Birth of Tragedy), `retitle` (pg61620
is billed as The Curse of Capistrano and reads as The Mark of Zorro; pg179 is
billed as "Europe" and is The Europeans), and `add` (Gutenberg's
modern-spelling Shakespeare: every automatic source points at the old-spelling
texts, whose excerpt opens on Gutenberg's note *about* the spelling).

What changed in the shipped set: 147 books swapped out, and the bank's tail is
now novels where it used to be treatises. The download floor fell from 1,083 to
948 because the strays that outranked them are gone.

Verification, all clean:

```
python3 tools/verify_ids.py        # 0 wrong ids (46 edition-title drifts left alone)
python3 tools/verify_titles.py     # every id vs the title inside its own text
python3 tools/test_puzzles.py      # 720 puzzles, 600 bank + 120 dailies
node    tools/test_match.mjs       # 720 titles match their own aliases
python3 tools/qa_puzzles.py        # 16 of 720 flagged, all read as false alarms
```

`test_match.mjs` was passing on **zero** files -- it filtered for the curated
`b\d+.json` puzzles, which no longer exist. It reads `index.json` now.

192 unreferenced puzzle files (the old `b*.json` and dropped `g*.json`) were
deleted; `puzzles/` is exactly the 720 in the index plus `index.json`.
Local keys are `.v4`: bank indices moved, so a `.v3` progress row points at a
different book.

Left for a human eye: `qa_puzzles.py`'s 16 flags are openings like "Call me
Ishmael." (three words) and Pickwick's mock-heroic first paragraph, which
really are the openings. Anchors now cover Gargantua (was opening on Rabelais's
prologue) and The Upper Berth (was opening on the publisher's note).

### The dataset, first pass (superseded by the rebuild above)
`tools/final_dailies.csv` (120) and `tools/final_bank.csv` (600) — 720 unique
books, no overlap, every one verified to have an English Wikipedia article and a
live Gutenberg text with a download count.

Chosen: 120 dailies (~4 months) drawn most-famous-first from the hand-curated
S/A tiers; the remaining S/A plus everything else fills the 600-book bank. The
owner will top the dailies up by hand before #120 runs out.

Ranking metric is **Gutenberg downloads over the last 30 days**, with a
hand-curated pool (`tools/excerptle_pool.csv`, tiers S/A/B) overriding it —
S before A before B before untiered.

The reserve pool is `2,271` verified books, so failures can be backfilled.

Pipeline scripts, all cached (re-runs are nearly free):
```
tools/fetch_downloads.py            download counts for the shipped 863
tools/build_pd_dataset.py           Wikidata: PD works <= 1930 with an enwiki article
tools/match_catalog.py              finds Gutenberg texts Wikidata never linked
tools/find_english_editions.py      re-points foreign editions at the English one
tools/resolve_pool.py               resolves the curated pool to Gutenberg ids
tools/verify_wikipedia.py           checks every title against Wikipedia directly
tools/classify_form.py --pool       novel or treatise, per Wikipedia's lead sentence
tools/verify_ids.py --pool --write  ids whose text is a different book
tools/verify_titles.py              shipped ids vs the title inside their own text
tools/final_lists.py                cuts final_dailies + final_bank (both formats)
```

Bugs already found and fixed in that pipeline — do not reintroduce:
- Wikidata records a Gutenberg id (`P2034`) for only 1,181 of 8,415 works. A
  missing id does **not** mean no text exists. Matching titles against
  Gutenberg's catalogue recovered 1,105 books including Middlemarch and
  A Room with a View.
- Gutenberg hosts several editions of the same book (Moby-Dick is pg15, pg2489
  *and* pg2701). Dedupe on author + fuzzy title, cutting titles at the subtitle.
- Wikidata's Gutenberg link often points at the original-language edition, not
  the English translation.
- Deep SPARQL `OFFSET` 502s on the public Wikidata endpoint. Partition by
  publication year instead.
- Part-files ("Huckleberry Finn, Chapters 01–05") are fragments, not books.

---

## Part 2 — TO DO (Task A and D; B and C are done)

### Task A: podium placement (small)

Replace the ranked-board framing with a podium badge. **Only positions 1, 2 and
3 are recognised. There is no percentile and no rank shown for anyone else** —
the owner considered a top-X% system and decided against it.

1. Migration `0005`: add `placement INTEGER` to `scores` (null for 4th onward).
2. In `worker.js` `scores()` POST, after the insert, compute how many rows for
   this `puzzle_index` sort ahead of the new one (hints, then guesses, then
   `won_at`). If that count is 0, 1 or 2, store `placement` = count + 1.
   The `scores_board` index from migration 0004 already covers this.
3. Return `placement` on the board read so the client can show it.
4. Post-game: a badge for 1st/2nd/3rd, nothing for everyone else.
5. Stats: a podium tally ("1st × 3, 2nd × 1"). Derive it from the score rows.

The badge is **frozen at the moment of solving** — a later player who does
better does not take it away. Say so in the UI copy, or it will read as a bug.
At launch, with few players, nearly every solver will get one. That is expected
and stops happening naturally as the game grows.

### Task B + C — DONE (verify, do not redo)

`tools/build_puzzles.py` now reads `final_bank.json` + `final_dailies.json`,
not `books.json` / `extra_books.json`. Slugs are the Gutenberg id (`g1342`).
All 720 texts are cached and all 720 puzzles build:

```
python3 tools/build_puzzles.py            # incremental; --force rebuilds all
python3 tools/build_puzzles.py --cached-only   # never touches the network
python3 tools/prefetch_texts.py --limit=N      # warm the cache in chunks
python3 tools/test_puzzles.py                  # 720 puzzles + famous openings
python3 tools/qa_puzzles.py                    # openings worth a human eye
```

`index.json`: bank #0–#599 scrambled by slug hash, dailies #600–#719 in
most-famous-first order (Pride and Prejudice is #600). `js/app.js` reads
`dailyStartIndex` / `presetCount`, so nothing there needed changing beyond the
localStorage keys, now `.v3`.

The last fabricated stat is gone: `fun_for()` and its `coffees` rating are
deleted, and puzzles carry no `fun` block at all. Nothing rendered it.

**Where the excerpt starts.** Without hand-set anchors every book relies on
`auto_start()`, which used to open a third of them on a preface, a dedication
or a table-of-contents line. It now walks headings: a run of four or more is a
contents list, one to three is a compound heading ("CHAPTER ONE" /
"PLAYING PILGRIMS"), and only a heading naming the *first* chapter ends the
front matter -- a bare "XLII" or the "M." that signs a letter in Ulysses used
to count and threw the excerpt into the middle of the book. Verse blocks lose
to the prose under them, so chapter epigraphs are skipped.

Books with no usable text go in `tools/unusable.json`; `final_lists.py
--exclude` drops them and the next candidate takes the slot. Seven are in
there: Howards End and The Laws of Thought have no plain-text file on
gutenberg.org at all (404 on every path), and five verse titles (Shakespeare's
sonnets, Childe Harold, The Ballad of Reading Gaol, The Angel in the House,
Cautionary Tales) parse into ~130 words of paragraphs, which collapses tiers
2-5 into one.

**Left for a human eye:** `qa_puzzles.py` flags 32 of 720. Most are false
alarms ("Call me Ishmael." is three words; Pickwick and The Three Musketeers
really do open that way). Two are real and both are dailies: Gulliver's
Travels opens on the chapter argument ("The author gives some account of
himself and family.") and Tom Jones opens mid-sentence. Ten plays open on a
stage direction or a dramatis personae, which may be fine or may not.

### Task D: deploy

`npm run deploy` runs all three (og worker, site, api). D1 migrations 0004 and
0005 need applying to the real database.

---

## Standing instructions

- The owner wants **short answers**. Detail goes in files, not chat.
- Do not launch a long background job and then stop — a previous agent stalled
  this task three times that way. Either wait for the job or run it in chunks
  that finish inside your turn.
- Verify claims before making them. Several confident statements in this project
  turned out wrong on inspection (including "those books aren't on Gutenberg" —
  19 of 25 were).

## Still open / unresolved

- Bottom-of-bank strays: **done**. The form/LoCC gates dropped them all,
  "Constitution of the Lacedaemonians" included, and the freed slots went to
  the next narrative candidates.
- Six books the owner wanted have no Gutenberg text at all: To the Lighthouse,
  Orlando, Red Harvest, As I Lay Dying, Swallows and Amazons, An American
  Tragedy. They need an external source or they stay out.
- `js/auth.js` only fires the `bookle-auth` event on explicit sign-in/out, so
  the score backfill never retries on a later page load. A guest with more than
  20 solves has to sign out and back in to push the rest. Unrelated to the
  redesign, still worth fixing.
