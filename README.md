# Excerptle (`excerptle.io`)

**Next agent: read [`PROGRESS.md`](PROGRESS.md) first.** Frontend and backend both ship; `DEPLOYMENT.md` is the operational truth and `MONITORING.md` the alerting map. Sections below marked ~~struck~~ or *Not what shipped* are kept as history — trust the code over this file.

Guess the book from a public-domain excerpt. Six tries. Hints expand the text.

This is the main product/engineering plan. **Yeardle already exists** and is out of scope for this repo. Working names along the way: Excerptle → Bookle → **Excerptle** again (this is the ship name). Domain: `excerptle.io`.

---

## Can you use `bookle.fyi` / the name BOOKLE?

**Short answer: the USPTO record you pasted does not stop you from using BOOKLE.** That is not the same as “the name is cleared forever.” This is product research, not legal advice.

### The filing you found (serial 86569860)

| Field | Value |
|---|---|
| Wordmark | BOOKLE (standard characters) |
| Applicant | Bakkle Inc. (Pleasanton, CA) |
| Filed | 2015-03-19, **intent-to-use** (1(b)) |
| Goods | Class 9: marketplace-style mobile app; Class 45: online social networking |
| Registration number | **None** — it never registered |
| Status | **Dead / abandoned** 2016-05-09 — no Statement of Use (or extension) after the Notice of Allowance |

An abandoned application is not a live federal registration. It does not give Bakkle Inc. the right to block you at the USPTO. An intent-to-use file that died for “no use statement filed” is also a strong signal they **never put BOOKLE on those goods in commerce**, which is what creates common-law rights.

### What can still bite you

1. **Common-law use.** Rights come from use, not from a dead application. Unlikely for *this* Bakkle filing, but always possible from someone else.
2. **Other “Bookle” products exist** in book-adjacent spaces (not the dead USPTO file):
   - `gobookle.com` — sales meeting incentives
   - `bookle.co.za` — South African secondhand-book marketplace
   - `bookle.ai` — AI book generator
   - “Bookle” EPUB reader (Stairways / TidBITS, ~2012)
   - “Bookle: Book Tracker” iOS app
   - BOOKLET (serial 98514163) — also **abandoned** (2025), entertainment/literature reviews
3. **Likelihood of confusion** is the test, not “does the string BOOKLE appear anywhere.” A daily literary guessing game on `bookle.fyi` is far from a B2B meeting-incentive tool. It is closer to book trackers / book marketplaces. Different class (we would be Class 41 entertainment, plus maybe Class 9 for a web app) still gets compared if consumers would think the same company is behind both.
4. **Domain ≠ trademark.** `bookle.fyi` is a registration at the registrar. The dead USPTO file does not control `.fyi`. Register the domain if you have not.
5. **Wordle-style `-le` suffix.** NYT owns WORDLE, not the suffix. Heardle, Gamedle, etc. shipped on that pattern. Do not use a Wordle logo, green/yellow square trademarking, or “Wordle for books” as a brand line in paid ads.

### Practical recommendation

- **Ship on `bookle.fyi`.** The dead Bakkle mark is not a blocker.
- Before ads scale or a paid trademark filing: run a full **live** TESS search, app-store search, and EUIPO/UKIPO search; have a lawyer do a clearance opinion if you are putting real money behind the name.
- When you file, file **Class 41** (“entertainment services, namely providing an online computer game”) and consider Class 9 if you wrap it as an app. Use the mark in commerce first (or file 1(b) and actually use it).
- If a live, related-class BOOKLE appears later, fallback names already in this family: Excerptle, Novelle, Firstline, Gutenbergle.

---

## Family

| Game | Status | Mechanic |
|---|---|---|
| **Yeardle** | Exists (do not rebuild here) | Guess the year in 6. Each miss reveals a more obvious historical clue. Higher/lower. |
| **Excerptle** | **This repo** | Guess the book title in 6. Each miss expands the excerpt. |

Shared chrome (nav, stats, ads, leaderboard contract) is specified below so Yeardle and Bookle can feel like one studio later.

---

## Bookle — core mechanic

Guess the **book title** in **6 tries**. **Guesses do not reveal more text.** Hints do.

You always start with the first sentence. Choose **Guess** or **Hint**.

| Hints used | Text on screen |
|---|---|
| 0 | First sentence |
| 1 | First paragraph |
| 2 | First two paragraphs |
| 3 | A few pages |
| 4 | Chapter 1 |

After a win or loss: title, author, year, Gutenberg link, this-puzzle leaderboard rank, share, **challenge a friend**, ads, CTAs into the bank / another game.

**Share** (spoiler-free):

```
Bookle Daily #1001 3/6 · 2 hints
🟨🟨🟩⬜⬜⬜
💡💡⬜⬜
https://excerptle.io/?p=1001
```

### Title matching

- Case, punctuation, diacritics ignored (`Les Misérables` = `les miserables`).
- Leading article optional (`The Great Gatsby` = `Great Gatsby`).
- `&` = `and`. Subtitles optional.
- Trailing `by <author>` stripped.
- Alias list per puzzle (`Alice in Wonderland` → *Alice’s Adventures in Wonderland*; `Huck Finn`; `Moby Dick`; `Les Mis`).
- Typo budget: 0 edits under 5 letters, 1 edit at 5–7, then ~1 per 6 letters. Token-level typos on long words too.
- Extra words allowed if every content word of the title is present (`pride and prejudice austen`).
- A **single** leftover word only counts if it is the whole title (`emma`) or a distinctive **last** token of 6+ letters (`gatsby`, `karenina`) — not `great`, `tale`, `pride`.
- Author-only and year-only guesses miss.

### Content rules

- **Public domain in the United States only.** As of 2026 that means works published 1930 or earlier (95-year term), plus US government works and older expired copyrights.
- Canon only: titles an educated adult has heard of. The MVP target was **50** books; the shipped bank is **720** (600 presets + a 120-book daily tail).
- Do **not** host the full book. Stop at three chapters (or equivalent parts).
- Each puzzle file is attributed to Project Gutenberg (id + license note).
- Filenames were meant to be opaque (`b14.json`) so the Network panel does not shout the answer. **This no longer holds:** the dataset rebuild in `688e23f` renamed every puzzle to `g<gutenberg-id>.json`, so the filename *is* the answer (`g345` = *Dracula*), and `puzzles/index.json` ships the full slug order. The JSON body also still contains the title — that part was always accepted, same class of spoiler as classic Wordle. No backend for gameplay. See `ANSWER-PRIVACY.md`.

---

## Shared architecture

| Feature | Spec |
|---|---|
| Hosting | Static, on Cloudflare Workers static assets. Apex `excerptle.io`. |
| Backend | **None for gameplay** — pre-generated JSON puzzles. A separate `excerptle-api` Worker over D1 carries accounts, scores, progress and Pro billing. |
| Auth | Real, server-side: Google and email sign-in through `excerptle-api`. `localStorage` still holds the anonymous id, streak, stats, guess distribution and current board for signed-out play. |
| Puzzles | **Gamebank presets #0–#599.** **Dailies start at #600** (`startDate` 2026-09-09), drawn from a 120-book tail the bank never offers. Same daily worldwide. Grow the preset cap when DAU justifies it. |
| Navigation | **New** (modal: today / random / bank / battle), **Info** (how-to modal), **Bank**, **Ranks**, Settings. |
| Stats bar | Per-puzzle fun fact until a live aggregator exists. |
| Leaderboard | **Per puzzle index** (preset and daily). Sort: win, then fewer hints, then faster, then fewer guesses. Filter by hints used. Local store, synced through `excerptle-api` when signed in. The config global is `EXCERPTLE_API`; `BOOKLE_API` is kept as an alias (`js/config.js:6`). |
| Battle | Same index. First correct title wins. A hint either player takes is shown to both. Share `?b=CODE&p=INDEX`. |
| Ads | From day 1. **Post-game only.** Never during deduction. |
| Mobile | Mobile-first. Shell (HTML+CSS+JS, no puzzle JSON) **&lt;50KB gzip**. System fonts. Puzzle JSON lazy-loaded. |

Daily index: `puzzleIndex = daysSince(startDateUTC) % pool.length` using the curated `order` array in `puzzles/index.json`. Same puzzle worldwide.

---

## MVP: in vs out

| IN | OUT |
|---|---|
| Daily #1001+ + gamebank presets + random | Hard mode settings |
| 6 guesses; **hints** reveal text | Sound |
| Title matching + aliases | Animations beyond CSS fade |
| Battle mode (PeerJS) |  |
| Per-puzzle leaderboard + hint filter |  |
| Public-domain canon, 50 titles, 3-chapter cap | Full book hosting |
| Shareable spoiler-free grid | Subscription paywall (after ~1,000 DAU) |
| Global leaderboard contract + local stats | Rebuilding Yeardle |
| Ads (post-game only) | Accounts, social login |
| `localStorage` stats/streaks | |

---

## Content pipeline (Bookle)

1. Catalog lives in `tools/books.json` (title, author, year, Gutenberg id, aliases, difficulty).
2. `tools/build_puzzles.py` downloads UTF-8 text from Gutenberg, strips PG header/footer, splits chapters/acts/staves, writes `puzzles/bXX.json` with six tiers.
3. Short works (novellas, stories, plays): use the work’s own parts (Stave, Act, Part). If fewer than three parts, split the remaining body into word-count buckets so every puzzle still has six tiers.
4. Long chapter 1 (e.g. *Les Misérables* is actually fine; *Ulysses* is not): cap each stored chapter at **12,000 words**. The player still scrolls; we do not ship *War and Peace* Book I in one JSON.
5. Manual pass: first sentence must be the real first sentence of the narrative (skip title pages, tables of contents, “CHAPTER I.” labels, and stage-direction-only lines).

Yeardle content (not in this repo): Google Sheet, 30 days, six clues ranked by obscurity.

---

## Build order

1. **Bookle** (this repo) — excerpt UI, title matching, daily + random, share, stats, post-game ad slot.
2. Share-grid polish + mobile pass (target shell &lt;50KB gzip).
3. Global leaderboard endpoint + ads network (GAM / EthicalAds / Carbon) behind the existing slot.
4. Archive search/browse by date.
5. Studio wrapper / “More Games” pointing at live Yeardle.

---

## Technical spec (Bookle)

### Routes (hash, no server)

As shipped (router at `js/app.js` ~2305). Puzzles are addressed by **index**,
not date; `#/random`, `#/archive`, `#/news` and `#/more` were never built, and
how-to-play and support became real pages rather than hash routes.

| Hash | Screen |
|---|---|
| `#/` | Today’s daily |
| `#/play/N` | Puzzle #N — bank #0–#599, dailies #600+ (future dailies locked) |
| `#/bank` | All Books grid |
| `#/ranks` | Leaderboard (`?i=N` for one index) |
| `#/stats` | Stats |
| `#/settings` | Theme, motion, share prefs |
| `#/pro` | Pro modal — also Stripe's return URL |
| `#/battle` / `#/battle/CODE` | Host or join a battle |

Static pages, not routes: `how-to-play.html`, `about.html`, `faq.html`,
`support.html`, `privacy.html`.

### `localStorage` keys (`bookle.*`)

As shipped (`K` at `js/app.js:11`). The `.v4` suffix is deliberate: the
720-book rebuild changed every puzzle id, so new keys leave pre-launch progress
behind rather than misread it.

- `bookle.playerId` — UUID
- `bookle.name`
- `bookle.stats` — `{played, wins, currentStreak, maxStreak, dist[1..6], fails, lastDaily}`, plus a `battle` block
- `bookle.progress.v4` — per-index rounds, in progress or finished (replaces the spec's `bookle.board.<puzzleId>`)
- `bookle.lb.v4` — local leaderboard rows
- `bookle.settings`
- `bookle.seenHowTo`

The keys stay `bookle.*` after the rename to Excerptle; changing them would drop
every existing player's streak.

Daily streak increments only when the daily is won, once per date, on the
**midnight-Pacific** day boundary (`c34eda8`) — not UTC. Bank games write to a
separate counter, not the streak.

### Share copy

The Wordle-style emoji block below was the spec. **Not what shipped.** Sharing
calls `navigator.share` and falls back to copying a plain result URL
(`js/app.js` ~2640); the emoji grid survives only as the 🟩/🟨 marks beside each
guess in the result list. The rich preview a shared link unfurls to is a PNG
rendered by the `excerptle-og` Worker, not text the player pastes.

Original spec, kept for reference:

```
Bookle 2026-09-08 3/6
🟨🟨🟩⬜⬜⬜
https://bookle.fyi
```

### File map

Roughly current; `backend/` and `tools/og-worker/` came later.

```
/
  README.md                 ← this plan, part history (see the struck items below)
  CNAME                     ← excerptle.io
  index.html
  css/app.css
  js/app.js                 ← game; js/match.js is the title matcher
  puzzles/index.json
  puzzles/gXX.json          ← XX is the Gutenberg id; see Content rules
  backend/                  ← excerptle-api: accounts, scores, billing
  tools/og-worker/          ← excerptle-og: share-card PNGs
  tools/books.json
  tools/build_puzzles.py
```

Zero npm dependencies. Open with any static server.

### Visual

Literary, not Wordle-green. Paper `#f4efe4`, ink `#1c140c`, wine `#7a1f2b`, rule lines like a bookplate. Excerpt in a serif; UI in a system sans. Drop cap on the first letter of the visible excerpt. No webfont files (page-weight budget).

---

## Key decisions

1. ~~**Name is Bookle, domain `bookle.fyi`.**~~ Reversed before launch: the game shipped as **Excerptle** on **`excerptle.io`**. The trademark note above is kept for the reasoning, not as a live plan. `localStorage` keys are still `bookle.*` — renaming them would drop every existing player's streak, so they stay.
2. **Do not rebuild Yeardle in this repo.** Link it from More Games.
3. ~~**UTC daily.**~~ Superseded by `c34eda8`: the daily rolls at **midnight Pacific** (3am Eastern). Still one book for everyone — a fixed zone, just not UTC, so a day's leaderboard does not span two calendar dates in the Americas.
4. **Opaque puzzle filenames, public-domain JSON, no gameplay backend.** The last two hold; the title is still in the payload by design. The opaque filenames were lost in `688e23f` — see *Content rules* above.
5. **Practice ≠ daily streak.** “New Game” must not nuke Wordle-style streaks.
6. **Post-game ads only.** Deduction is the product; ads after the reveal.
7. **Three-chapter cap + 12k word cap per chapter.** Legal/hosting hygiene, not a teaser paywall.
8. **Leaderboard is a typed client contract from day 1**, even if the first ship is local + baked fun-facts. The UI does not wait on Cloudflare/Firebase.

---

## Open questions (non-blocking for MVP)

- Which live Yeardle URL to put under More Games.
- Ad network (EthicalAds vs GAM vs later).
- Leaderboard host (Cloudflare Worker + KV is the default when you are ready).
- Whether archive search is date-only (recommended) or title-search after that UTC day has ended.

---

## PR / implementation slices

1. **Shell + daily engine + matching** — `index.html`, `css/app.css`, `js/app.js`, empty puzzle slot.
2. **50-title corpus** — `tools/build_puzzles.py` + `puzzles/`.
3. **Stats, share, settings, how-to, news, support, more games.**
4. **Archive + random.**
5. **Post-game ad slot + leaderboard client.**
