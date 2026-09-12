# Excerptle — technical material for a résumé item

Raw material for whoever writes the bullet. Nothing here is phrased for a résumé yet;
pick, compress, and quantify. Everything below is verified against the tree at
commit `c34eda8` (branch `adsense-content-pages`), 2026-09-10.

---

## One-line framing options

- **Product angle:** designed, built, and shipped a daily literary guessing game at
  `excerptle.io` — 720-book corpus, accounts, subscriptions, leaderboards, P2P
  multiplayer — solo, end to end, on a serverless edge stack.
- **Systems angle:** built a full-stack edge application on Cloudflare Workers (three
  Workers, D1, static assets) with a Python data pipeline that curates a 720-book corpus
  from Wikidata/OpenLibrary/Gutenberg behind automated quality gates.
- **Data angle:** built a reproducible ETL that ranks ~2,300 public-domain works by a
  multi-source fame signal and gates them through three automated correctness checks,
  producing the game's shipped 720-puzzle dataset.

---

## Stack, factually

| Layer | What it actually is |
|---|---|
| Frontend | Vanilla JS SPA (no framework, no build step). ~2,280 LOC `js/app.js` + 5 modules; hash routing; `localStorage` for guest play. ~5.8k LOC of HTML/CSS/JS total. |
| Hosting | Cloudflare Workers static assets. Repo root *is* the deployed site. Apex bound as a Custom Domain; `www` 301s via an edge Redirect Rule; `workers.dev` deliberately disabled to avoid a duplicate-content host. |
| Edge Workers | **Three**, deployed in a fixed order: `excerptle-og` (share-card renderer), `excerptle` (front door), `excerptle-api` (backend). |
| Backend | Cloudflare Worker, `backend/src/worker.js` (383 LOC), 11 JSON endpoints. |
| Database | Cloudflare **D1** (SQLite at the edge), 4 SQL migrations, 8 tables. |
| Payments | Stripe subscriptions (Checkout + Billing Portal + webhooks), monthly/yearly. |
| Auth | Google OAuth, email one-time codes, and passwords — all three into one account. |
| Multiplayer | PeerJS / WebRTC peer-to-peer "battle mode" — no game server. |
| Data pipeline | ~3,800 LOC of Python across 25 scripts; Wikidata SPARQL, Wikidata API, OpenLibrary, Wikipedia pageviews, Project Gutenberg. |
| Tests | Node `node:test` + **Miniflare** for the Worker/D1/Stripe suite; Playwright E2E across desktop + mobile viewports; two bespoke simulators. |
| CI | GitHub Actions on push/PR: unit + E2E, Playwright traces uploaded on failure. |
| Ops | Slack alerting Worker with Cloudflare GraphQL Analytics quota watch; cron triggers (hourly + daily digest). |

---

## The genuinely interesting engineering (ranked — lead with the top few)

### 1. Client-side PBKDF2 because the edge CPU budget forbids server-side hashing
`backend/src/worker.js` top-of-file comment. A Workers free-plan invocation gets ~10ms
CPU; PBKDF2 at a defensible iteration count costs ~73ms — so server-side stretching
doesn't merely cost money, it *fails* (503). The browser therefore derives the key
(600k iterations, per-user 16-byte salt) and the Worker treats the derived key exactly
as it would a password: never stored as sent, only as a salted SHA-256 verifier, so a
database leak isn't a pile of usable credentials. The iteration floor is enforced
server-side (a client would otherwise announce that one iteration was plenty), and
`GET /auth/kdf` publishes the current cost so it can be raised for everyone without
shipping a new frontend. Login does a constant-time compare and computes a dummy
verifier even when no account exists, so a missing address and a wrong password cost
the same and answer the same.

### 2. Cold-start budgeting across two isolates
Share links need per-link OpenGraph `<meta>`, which crawlers can't get from an SPA. The
front-door Worker uses `run_worker_first` on `/` + `HTMLRewriter` to rewrite unfurl tags
from the share payload in the query string. But the share-card *renderer* needs ~3.5 MB
of resvg WASM plus two TTF fonts, and Cloudflare loads the whole script into the isolate
on cold start — which put that weight in front of every first page load in every colo.
Split into a second Worker reached over a **service binding**, so only crawlers ever pay
it. The renderer memoizes WASM init, brand icon, and puzzle index per isolate, and each
cache clears its own slot on failure so one bad fetch can't poison the isolate for life.
Rendered cards are stored in the Workers Cache API; `resvg` handles are freed in a
`finally`.

### 3. Stripe correctness under concurrency and replay
- Webhook signature verified with `constructEventAsync` + SubtleCrypto provider; livemode
  asserted against config so test events can't touch prod.
- `stripe_events` table = idempotency; every handler **re-reads current Stripe state**
  rather than trusting the event body, so a delayed delivery can't resurrect a cancelled
  subscription.
- The upsert carries its own guard clause: `WHERE excluded.event_created >= …` plus a
  refusal to move a row out of `canceled`, so out-of-order webhooks are safe.
- Checkout is protected by a D1 `checkout_locks` row (a lease with an expiry), an
  idempotency key bucketed per 30 minutes, a live `subscriptions.list` check against
  Stripe, and reuse of an open session **only for the plan actually requested** — a
  stale session for the other plan would charge a price the customer didn't choose.
- Price objects are validated before checkout (amount, currency, interval, interval
  count, livemode) so a misconfigured dashboard fails closed with a 503.

### 4. A data pipeline with quality gates, not hand edits
`tools/build_pd_dataset.py` (564 LOC) builds a fame-ranked corpus of pre-1931 English
works from four sources: Wikidata SPARQL (works with a publication date ≤ 1930), the
Wikidata API for **sitelink count** as the primary fame signal (the SPARQL aggregate
reliably timed out on WDQS's 60s budget, so it's done as a separate API pass),
OpenLibrary for readership counts and a second Gutenberg-id source, and 30 days of
English Wikipedia pageviews as a recency-weighted signal. Per-host worker pools at ~2
req/s, an identifying User-Agent, and a disk cache so runs are resumable.

The first cut shipped bad data, and the fix was three **automated gates** rather than
manual cleanup — the part worth saying out loud in an interview:
- **Wrong-id gate** (`verify_ids.py`): a run of Shakespeare's `22xx` Gutenberg ids was off
  by one work, so 15 puzzles accepted an answer that wasn't the book on screen —
  *unwinnable*. Now every id is checked against Gutenberg's own catalogue; omnibuses are
  dropped, mismatches are retitled so dedupe collapses them.
- **Non-narrative gate** (`classify_form.py`): parses English Wikipedia's lead sentence
  ("is an 1897 novel" / "is a treatise") for all 2,308 candidates. Verse is excluded — a
  poem collapses hint tiers 2–5 into the same screen.
- **Non-fiction gate:** Library of Congress classification from Gutenberg's catalogue.
  Deliberately paired with the Wikipedia signal because each covers the other's blind
  spot: LoCC alone drops *News from Nowhere* and *Twelve Years a Slave* (filed under
  socialism and slavery), and Wikipedia says only "is a book by X" for a few hundred.

`build_puzzles.py` (740 LOC) then slices each Gutenberg text from a verified opening line
(hand-audited anchors, else heuristic detection) so a table of contents or an etext
preamble never becomes hint #1, and enforces that each of the five hint tiers clears a
word target *and* grows ~1.4–2× over the previous one — so no two hints ever show the
same screen. Bank play order is scrambled by `sha256(salt + slug)` so book #1 isn't the
top of the catalogue and the sequence doesn't track Gutenberg ids.

### 5. A matching algorithm that's mostly about what it *refuses*
`js/match.js` (201 LOC). Case/diacritic/punctuation folding, optional leading article,
`&` → `and`, per-puzzle aliases, `by <author>` stripped from the guess only (stripping it
from *titles* turned "Won By the Sword" into "won"), Levenshtein typo budget scaled to
word length, and title *variant expansion* so Gutenberg packaging is optional to type
("Moby Dick" solves *Moby-Dick; or, The Whale*). The hard part is the false-accept side:
a `GENERIC`/`VAGUE` stoplist bars one-word stabs, so "great" doesn't solve *The Great
Gatsby* and "complete" doesn't solve *Richard Carvel — Complete*, while a distinctive
6+-letter last token ("gatsby", "karenina") still does. Every variant is matched whole,
so fragments lose.

### 6. P2P multiplayer, and the failure mode nobody sees
PeerJS/WebRTC battle rooms — same book, shared hints, first correct title wins, no game
server. The bug worth telling: a signalling server forgets a peer id the instant its
socket closes, and *a phone leaving the browser to paste the invite link into a chat app*
is exactly that. The host's lobby still showed a code and a working Copy button, so
nothing looked broken; the guest's single connection attempt just failed. Fix: both sides
watch the socket — the host re-registers on `visibilitychange`, on `online`, on peer
disconnect, and from a 10s watchdog, and reclaims its code from a stale socket still
holding it; the guest keeps knocking for ~90s. Covered by `tools/battle_sim.cjs`, a
**fake PeerJS whose ids die with their sockets**, exercising the frozen-host case, a dead
room, and a code the server still holds.

### 7. Offline-first sync with a last-write-wins merge in SQL
Guests play fully offline against `localStorage`; signing in merges. `PUT /me/progress`
batches upserts with `ON CONFLICT … DO UPDATE … WHERE excluded.updated_at >=
progress.updated_at`, so the conflict resolution is one clause in the statement rather
than application code. Score submission keeps the *better* attempt on the board's own
ordering (hints → guesses), and leaderboards deliberately **stopped ranking on time** —
a migration that dropped and rebuilt the covering index because the old one led on
`time_ms` and forced a post-lookup sort on every board read.

### 8. Timezone correctness for a "daily"
The daily rolled at 00:00 UTC — 5pm Pacific the day before, so today's book appeared
during yesterday evening and then sat unchanged all day, reading as a daily that never
fired. Now formatted in `America/Los_Angeles`, and re-checked when a backgrounded tab
returns (it was previously read only at route time), leaving a game with guesses on it
alone.

### 9. Self-monitoring on a free plan
`backend/src/alerts.js` (253 LOC) queries the Cloudflare GraphQL Analytics API hourly and
compares usage to documented free-tier limits (100k Worker requests/day, 5M D1 rows
read, 100k written, 5 GB storage). Alerts fire on **bands** (50/75/90/100%) with the last
band fired remembered per metric per UTC day, so an hourly check that keeps seeing 78%
stays quiet after the first message. A daily cron posts a Slack digest; signups and
subscription changes ping in real time — but only when Stripe's `previous_attributes`
says a field a human cares about actually moved, so renewals don't spam. Everything fails
soft by design: "an alerting path that can take the site down is worse than no alerting
at all."

---

## Security / abuse surface (good for a security-flavored bullet)

- Strict origin allowlist enforced before routing; no CORS reflection.
- D1-backed fixed-window rate limiter (`INSERT … ON CONFLICT DO UPDATE … RETURNING
  count`) applied per IP, per email hash, and per user id on separate budgets.
- Session tokens: 32 random bytes, stored only as a SHA-256 digest, 30-day expiry,
  validated by a join rather than a lookup-then-check.
- Google sign-in verifies the access token's `aud` against our client ID *and* cross-checks
  `sub` between `tokeninfo` and `userinfo`, and requires `email_verified` before linking
  to an existing email-code account.
- Every input bounded: 16 KB body cap, 254-char emails, hex-shape assertions on all
  digests, per-entry and per-payload progress caps.
- Changing an existing password requires the current one (a session token lives in
  `localStorage` for 30 days; replacing a password must cost more than holding one).
- The local-dev shortcut that returns a sign-in code in the response requires three
  conditions that cannot co-occur in production (no mail provider, an opt-in that lives
  only in a gitignored `.dev.vars`, and a localhost caller).

---

## Testing story

- **Worker suite** (`backend/test/billing.test.js`, 226 LOC): runs the real Worker against
  **Miniflare** with a real D1 instance built by replaying the actual migration files, and
  a stubbed Stripe. Covers forged/expired sessions, CORS rejection, webhook replay and
  out-of-order delivery, double-checkout, and the PBKDF2 handshake end to end.
- **Playwright E2E** (`tests/gameplay.spec.js`): a 6-way matrix — guest / expired session /
  signed-in × won / lost — each walking daily → random → book-by-id → new game → bank,
  run on desktop *and* mobile viewports. Notably, **every external origin is stubbed to
  503 on purpose**: playing another book must keep working when auth is down. Page errors
  are collected and asserted empty; the clock is pinned so the daily is deterministic.
- **Simulators:** `battle_sim.cjs` (fake PeerJS with socket-lifetime ids),
  `auth_flow_test.cjs`, `dev_api_switch_test.cjs`, `test_match.mjs` (matcher accept/reject
  corpus), plus Python `test_puzzles.py` / `qa_puzzles.py` over the built dataset.
- `predeploy:site` chains unit + E2E, so a deploy can't skip them.

---

## Numbers worth quoting

| | |
|---|---|
| Books shipped | **720** (600-book browsable bank + 120 held-back dailies, no overlap) |
| Candidates evaluated | **~2,308** classified; corpus drawn from a Wikidata pull of pre-1931 English works |
| Puzzle files | 721 JSON files, 5 progressive hint tiers each |
| Workers deployed | 3 (front door, share-card renderer, API) |
| D1 | 8 tables, 4 migrations |
| API endpoints | 11 |
| Backend | 383 LOC (Worker) + 253 (alerts) |
| Frontend | ~5.8k LOC, zero dependencies, zero build step |
| Python tooling | ~3,800 LOC / 25 scripts |
| E2E matrix | 6 flows × 2 viewports |
| Timeline | first commit 2026-09-08; production, monetized, and CI-gated by 2026-09-10 |

---

## Angles for the personal-site version (longer form)

The website version can afford the *stories*, which are the memorable part:

1. **"The 10ms problem."** Why password hashing moved into the browser — a real
   platform constraint producing a real cryptographic design decision, with the
   server-side floor as the part that keeps it honest.
2. **"3.5 MB in the wrong isolate."** Cold starts, `run_worker_first`, and why the
   share-card renderer had to move to its own Worker behind a service binding.
3. **"Fifteen unwinnable puzzles."** An off-by-one in a run of Gutenberg ids meant the
   accepted answer wasn't the book on screen — and the fix was a gate in the pipeline,
   not fifteen hand edits. Good "systems over heroics" story.
4. **"The daily that never fired."** UTC vs. Pacific, and how the bug presented as the
   feature simply not working.
5. **"The invite link that killed the room."** Leaving the browser to paste a link drops
   the WebRTC signalling socket — a failure mode that only exists on a phone, and is
   invisible from the host's screen.
6. **What it refuses to accept.** The matcher section is unusually demo-able: show the
   accept/reject table ("gatsby" ✓, "great" ✗, "Moby Dick" ✓, "The Adventures" ✗).

Screenshot-worthy surfaces: the game with hint tiers expanding, a rendered share card,
the stats page, the Slack quota alert format.

---

## Caveats for whoever writes the bullet

- It is a solo project with **no users yet** — the interesting claims are engineering
  claims, not traction claims. Do not imply scale, DAUs, or revenue.
- AdSense was applied for but is gated behind human review; ads ship behind a config
  flag that is off. Don't claim ad revenue.
- "Three Workers" and "edge" are accurate; "microservices" and "distributed system"
  would be overselling it.
- The most senior-sounding, defensible claims are: the KDF placement decision, the
  isolate split, the Stripe idempotency/replay handling, and replacing manual data
  cleanup with automated gates. Lead with those.
