# Excerptle (`excerptle.io`)

**Next agent: read [`PROGRESS.md`](PROGRESS.md) first** (frontend done, backend next).

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
| **Bookle** (was Excerptle) | **This repo** | Guess the book title in 6. Each miss expands the excerpt. |

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
- Canon only: titles an educated adult has heard of. MVP pool: **50** books.
- Do **not** host the full book. Stop at three chapters (or equivalent parts).
- Each puzzle file is attributed to Project Gutenberg (id + license note).
- Filenames are opaque (`b14.json`) so the Network panel does not shout the answer. The JSON body still contains the title — same class of spoiler as classic Wordle. No backend for gameplay.

---

## Shared architecture

| Feature | Spec |
|---|---|
| Hosting | Static. GitHub Pages / Cloudflare Pages / Vercel. Apex `excerptle.io`. |
| Backend | **None for gameplay.** Pre-generated JSON puzzles. |
| Auth | None. `localStorage` for anonymous id, streak, stats, guess distribution, current board. |
| Puzzles | **Gamebank presets #1–#1000.** **Dailies start at #1001** on launch day (UTC). Same daily worldwide. Grow the preset cap when DAU justifies it. |
| Navigation | **New** (modal: today / random / bank / battle), **Info** (how-to modal), **Bank**, **Ranks**, Settings. |
| Stats bar | Per-puzzle fun fact until a live aggregator exists. |
| Leaderboard | **Per puzzle index** (preset and daily). Sort: win, then fewer hints, then faster, then fewer guesses. Filter by hints used. Local store + optional `BOOKLE_API`. |
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

| Hash | Screen |
|---|---|
| `#/` | Today’s daily |
| `#/random` | New Game — random archive puzzle, no streak |
| `#/archive` | Date list |
| `#/play/YYYY-MM-DD` | That day’s puzzle (future dates locked) |
| `#/stats` | Stats |
| `#/settings` | Theme, motion, share prefs |
| `#/news` | Editorial / changelog |
| `#/how-to-play` | Rules |
| `#/support` | Contact / coffee |
| `#/more` | Yeardle + future games |

### `localStorage` keys (`bookle.*`)

- `bookle.playerId` — UUID
- `bookle.stats` — `{played, wins, currentStreak, maxStreak, dist[1..6], fails, lastDaily}`
- `bookle.board.<puzzleId>` — in-progress or finished guesses
- `bookle.settings`
- `bookle.seenHowTo`

Daily streak increments only when the UTC daily is won, and only once per date. Random games write to a separate `practice` counter, not the streak.

### Share copy

```
Bookle 2026-09-08 3/6
🟨🟨🟩⬜⬜⬜
https://bookle.fyi
```

Loss:

```
Bookle 2026-09-08 X/6
🟨🟨🟨🟨🟨🟨
https://bookle.fyi
```

### File map

```
/
  README.md                 ← this plan
  CNAME                     ← bookle.fyi
  index.html
  css/app.css
  js/app.js
  puzzles/index.json
  puzzles/bXX.json
  tools/books.json
  tools/build_puzzles.py
```

Zero npm dependencies. Open with any static server.

### Visual

Literary, not Wordle-green. Paper `#f4efe4`, ink `#1c140c`, wine `#7a1f2b`, rule lines like a bookplate. Excerpt in a serif; UI in a system sans. Drop cap on the first letter of the visible excerpt. No webfont files (page-weight budget).

---

## Key decisions

1. **Name is Bookle, domain `bookle.fyi`.** Excerptle was a working title. Dead USPTO serial 86569860 is not a live registration.
2. **Do not rebuild Yeardle in this repo.** Link it from More Games.
3. **UTC daily.** “Same for everyone” beats local-midnight fairness.
4. **Opaque puzzle filenames, public-domain JSON, no gameplay backend.** Matches the static-hosting constraint; title is still in the payload.
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
