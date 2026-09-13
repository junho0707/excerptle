# Excerptle logic audit — 2026-09-11

Scope: `js/app.js`, `js/auth.js`, `js/pro.js`, `js/ads.js`, `js/match.js`,
`js/config.js`, `js/share-page.js`, `backend/src/worker.js`,
`backend/src/alerts.js`, plus the 720 puzzle records and their reading files.

Method: full read of every source file above; data integrity checked with a
script over all 720 puzzles and 720 reading files; `npm test` (6 suites),
`npm test --prefix backend` (17 tests) and `tools/check_hint_metadata.py` all
run and all passing. No live two-device, PeerJS, Stripe or production API test
was performed — battle and multi-device findings are read from the code.

---

## 0. Highest — account scoping has no migration for players already signed in

> **[FIXED 2026-09-11]** `importGuestPlay` now also runs at boot for a session
> that is already present, so the unscoped keys are adopted into the account
> namespace once, under the `beats()` rule from #1, behind the same marker.
> Covered by `tests/logic-sweep.spec.js` ("an account already signed in keeps
> its unscoped board and streak").

Found after the sweep below, while fixing a test the same change had broken.
This is uncommitted work in the tree, not yet shipped.

`playOwner()` moved progress, board and stats to per-account localStorage keys.
`loadPlayJSON` reads the legacy unscoped key only for a `guest:` owner, so an
account owner gets the fallback instead. The one-time import that would carry
the old data across, `importGuestPlay`, runs only from the `bookle-auth`
listener when `nextUid !== activeAccountUid` — and `activeAccountUid` is
initialised from the session at boot, so for someone already signed in no event
fires and no import runs.

On deploy, every currently signed-in player loads the new build and finds their
streak at zero and their local board empty. Progress itself comes back from the
server on the next sync; the streak does not, and neither do solves made
offline that never uploaded.

**Fix:** adopt the legacy keys once at boot for a session that is already
present, merging under the same status-before-timestamp rule as #1, then set the
marker so it cannot run twice.

**Also fixed while here:** `tests/logic-sweep.spec.js:118` was reading the
pre-scoping key and failing; it now reads `bookle.lb.v4.account:sweep`, and is
tightened (the old assertion used `.every()` on a possibly-empty array, so it
would have passed on no rows at all).

---

## 1. High — a stale in-progress round can erase a finished one

> **[FIXED 2026-09-11]** `progressRank`/`beats` rank status before timestamp at
> both client merge sites, and the server's `ON CONFLICT` now ranks the same
> three ways — over > played > only opened (`STORED_RANK`, nested CASE so a
> malformed legacy row cannot throw) — so a newer *empty* round cannot erase
> guesses either. Covered by `tools/progress_sync_test.mjs` and
> `backend/test/billing.test.js` ("a finished round is never overwritten…").

`js/app.js:299` (sync merge) and `js/app.js:382` (guest import) both resolve a
conflict on `at` alone:

```js
if (!merged[index] || (!empty && Number(row?.at || 0) >= Number(merged[index]?.at || 0)))
```

`empty` only rejects a row that is *untouched* (`playing`, no hints, no
guesses). A round that is `playing` with two guesses and a newer timestamp
therefore replaces a `won` row. The server applies the same rule
(`backend/src/worker.js`, `progress` PUT: `WHERE excluded.updated_at >=
progress.updated_at`), so the completed result is lost on both sides.

Reproduction shape: finish a book on the phone; the laptop still has the same
book open and its 5-minute checkpoint (`accountProgressSyncTimer`) pushes the
older, unfinished round over the top of it.

**Fix:** rank status before timestamp — a finished row (`won`/`lost`) must never
be replaced by a `playing` row for the same `puzzleId`. Apply it in both the
client merge and the server's `ON CONFLICT` clause.

## 2. High — every sync re-uploads the player's entire progress map

> **[FIXED 2026-09-11]** Only rows the local copy won are queued, and the batch
> is 3 entries per PUT. A sync the server already holds now issues no writes at
> all — asserted in `tools/progress_sync_test.mjs`.

`js/app.js:303`:

```js
pendingProgress = { ...pendingProgress, ...merged };
```

`merged` is the union of local *and* remote progress. Everything the server
just sent is queued straight back to it, and `flushProgressEntries` ships it
two entries per request (`js/app.js:270`). A player with 300 finished books
issues ~150 sequential `PUT /me/progress` calls on every sign-in, every
account-change event, and every `syncProgress()` at boot.

On a 100k-request/day free tier (see `LIMITS` in `backend/src/alerts.js`) a few
hundred active accounts is enough to matter, and the existing test
(`tools/progress_sync_test.mjs`, "bulk progress is split") locks the behaviour
in rather than catching it.

**Fix:** queue only rows where the local copy actually won the merge. Raising
the batch size from 2 to ~3 also stays under the 16 KB body cap, since the
server already rejects any single entry over 4096 bytes.

## 3. High — streaks and battle history never leave the device

> **[FIXED 2026-09-11]** Derived, not synced: `dailyStreaks()` reads the solved
> dailies out of the progress map (which syncs) and the Stats tiles use it;
> `recordFinish` no longer keeps a solo tally and `loadStats()` is down to the
> battle numbers, which stay device-local and are now labelled "on this device".
> Covered by `tools/aux_logic_test.mjs`.

`loadStats()` (`js/app.js:414`) reads `bookle.stats.<owner>` from localStorage
and nothing writes it to the API. Puzzle progress syncs; `currentStreak`,
`maxStreak`, `lastDaily`, `lastWinDate` and the whole `battle` tally do not.

Signing in on a second device restores the completed dailies but shows a zero
streak and zero battles, and `recordFinish` (`js/app.js:999`) cannot rebuild
them — `if (s.lastDaily === gameDate()) return;` guards against double counting,
but there is no history to replay from.

**Fix:** either sync the stats blob alongside progress, or store a completion
date on each progress row and derive the streak from it. The second is better:
one source of truth, and it self-heals.

## 4. [FIXED 2026-09-11] Medium — battle mode has no referee

> **Completed 2026-09-11.** The host's Start is now a guard rather than a button
> state: `startBattleAsHost()` refuses a second call and refuses to start at all
> without an open connection, so a double tap cannot restart the host's round
> while the guest ignores the duplicate. Covered by `tools/battle_sim.cjs` T10.

> Done. Ties now go to whoever named the book first, measured as elapsed time
> from each player's own round start rather than wall clocks; a dead heat goes
> to the host. The battle tally settles before it is written, so a win that is
> handed over never counts. `lose` is handled and a duplicate `start` cannot
> restart a guest. Covered by `tools/battle_sim.cjs` T5–T9.

Three related gaps in `onBattleData` (`js/app.js:2115`):

- **Both players can win.** Each browser awards itself the win locally and then
  sends `{type:"win"}`. The receiver only demotes itself `if (state.status ===
  "playing")` (`js/app.js:2148`), so two near-simultaneous correct guesses leave
  two winners and two recorded wins.
- **`lose` is sent and never handled.** `js/app.js:1086` sends
  `{type:"lose"}` when a player runs out of guesses; no branch in
  `onBattleData` reads it. The opponent keeps playing a race nobody can lose.
- **`start` is unguarded.** A repeated `{type:"start"}` restarts the guest's
  round from scratch at any point, including mid-game.

The lobby copy is honest ("Casual battle: it does not change solo progress or
leaderboard scores") and that separation is correctly enforced —
`saveProgress` returns early for `mode === "battle"` and `recordFinish` skips
`pushLb`. The protocol itself is what is unfinished.

**Fix (minimum):** have the host decide the result and broadcast a single
`{type:"result", winner}`; treat every other claim as advisory.

## 5. Medium — a password change does not revoke other sessions

> **[FIXED 2026-09-11]** Both the set and remove paths batch a `DELETE FROM
> sessions … AND token_hash<>?` with the update, keeping the caller signed in.
> Covered by `backend/test/billing.test.js`.

`setPassword` in `backend/src/worker.js:153` proves the current password
(good) and writes the new verifier, but the only `DELETE FROM sessions` in the
file is `/auth/logout` (`:359`). Sessions live 30 days in localStorage, so
"someone has my account, I changed my password" does not actually end their
access. Same for `remove: true` (`:163`).

**Fix:** `DELETE FROM sessions WHERE user_id=? AND token_hash<>?` on both paths,
keeping the caller signed in.

## 6. Medium — plan switching can hand back a dead Stripe checkout URL

> **[FIXED 2026-09-11]** A replayed session that comes back `expired` or
> `complete` is re-created under a per-attempt key — `crypto.randomUUID()`, not a
> timestamp, so two retries inside one second cannot collide on it either. The
> 30-minute bucket still stops a double-click buying twice. Covered by
> `backend/test/billing.test.js`.

`backend/src/worker.js:292-300`. Open sessions for the *other* plan are
expired, then a new session is created with
`idempotencyKey: checkout:<uid>:<plan>:<30-min bucket>`.

monthly → yearly → monthly inside one 30-minute bucket: the first monthly
session is expired by the yearly request, and the second monthly request
replays the idempotency key and receives the *expired* session's URL. The user
lands on a dead Stripe page. Adding `plan` to the key (recent change) fixed
charging the wrong price; it did not fix this.

**Fix:** make the key unique per attempt (e.g. include a counter or the
expired-session id), or check `status === 'open'` on the replayed session
before returning its URL.

## 7. Low — leaderboard can still show one player twice

> **[FIXED 2026-09-11]** `playerId` survives the backfill re-read, and
> `renderRanks` drops the player's own already-uploaded rows once the server has
> answered for that account. An un-uploaded row still shows. Covered by
> `tests/logic-sweep.spec.js`.

`renderRanks` (`js/app.js:1557`) dedupes a local row against the server by
`rankKey` (`playerId|hints|guesses`) and, for the player's own rows, by an
`accountScores` set of `hints|guesses`. Both compare *scores*, not identity.

If the server already holds a better result for that book from another device,
it returns only that row; the local guest-era row has different
hints/guesses, matches neither check, and is rendered as a second entry for
the same person.

Contributing: `backfillScores` stamps `r.playerId = connection.uid` on the rows
in `all`, then saves the separately re-read `latest` (`js/app.js:358`), so the
`playerId` stamp is thrown away and only `sent` survives.

**Fix:** persist `playerId` in that reconciliation, then drop any local row
whose `playerId` matches the signed-in account and that the server answered for
at all.

## 8. Low — `/billing/status` is fetched on every window focus

> **[FIXED 2026-09-11]** `refresh()` honours `force`, with a five-minute
> freshness window; `{force:true}` still round-trips.

`js/pro.js:161` calls `refresh()` on focus, and `refresh({force})`
(`js/pro.js:94`) destructures `force` and never reads it — there is no
cache-age check, so every call is a network round trip. The 24-hour cache
(`MAX_AGE`) is only consulted by `isPro()`, not by the fetch path. Alt-tabbing
hits the API each time.

**Fix:** honour `force` — skip the fetch when `cur` is younger than a few
minutes and `force` is false.

## 9. Low — `state.loading` is never cleared on a failed load

> **[FIXED 2026-09-11]** All three early exits go through a `bail()` helper that
> clears the flag.

`startPlay` sets `state.loading = true` at `js/app.js:1103` and clears it only
after the puzzle arrives (`:1146`). The three early returns — index out of
range, "that daily isn't out yet", fetch failure — leave it `true`. Nothing
visible breaks today (each of those paths also leaves `state.puzzle` null,
which every caller checks first), but it is a latent trap for any future guard
that reads `state.loading` alone.

## 10. Low — the daily schedule wraps after 120 books

> **[GUARDED 2026-09-11]** The owner's decision is (a), grow the pool, at some
> point. Until then it cannot arrive unannounced: `tools/qa_puzzles.py` prints
> the runway and exits non-zero under 30 days, and it now runs in CI and in
> `predeploy:site` as `npm run test:data` (today: 117 days; the last new daily
> falls on 2027-01-06).

`slugForIndex` (`js/app.js:436`) picks dailies with `order[presets + (day %
pool)]`, and `puzzles/index.json` has `presetCount: 600`, `order` of 720 →
`pool = 120`. Day 121 (2027-01-07, from `startDate: 2026-09-09`) serves the
same book as day 1 under a new daily number and a new leaderboard. Predictable,
but it needs a product decision before it happens.

## 11. Low — "2–4 paragraphs" is wrong for 410 of 720 puzzles

> **[FIXED 2026-09-11]** Both places now read "The book's opening paragraphs".

`js/app.js:1452` and `how-to-play.html:128` both promise "Opening excerpt (2–4
paragraphs)". Measured across the bank: 410 puzzles fall outside 2–4
paragraphs (1 paragraph ×71, 5 ×79, 6 ×66, 7+ ×63…), 98 are under 350 words,
14 over 500, and the longest is 5,945 words (`puzzles/g26.json`). The builder
preserves whole paragraphs by design, so the copy is what should change.

## 12. Deliberately deferred

Named here so they are decisions rather than oversights:

- **Session caps and further free-tier write reduction.** #2 removed the bulk of
  the redundant writes; a per-account session limit and a tighter checkpoint
  cadence are worth doing only if real traffic shows the need.
- **The leaderboard and battle results remain honour-system.** Scores are
  submitted by the browser, so a determined player can send a better result than
  they earned. Making them cheat-proof means the server holding the round, which
  is a different product. Not attempted.

## 13. Housekeeping

- `backend/migrations/0006_shared_leaderboard.sql` is untracked and therefore
  not committed or deployed. It creates `scores_user_puzzle_global`, the unique
  index that makes the `INSERT … WHERE NOT EXISTS` in `scores` safe under
  concurrent writes. Commit and apply it before the next API deploy.
- `clearLocalPlayData` (`js/app.js:364`) and `dateForDailyIndex`
  (`js/app.js:451`) are defined and never called.
- `pickById` (`js/app.js:1278`) computes `n` and `max`, validates `n`, then
  delegates to `playById(raw)`, which re-parses and re-validates. One of the two
  checks is redundant.
- `backend/backend/dist/` (788 KB, untracked) is a stray build artifact.
- `js/share-page.js` paints a signed-in name when `expiresAt` is absent;
  `js/auth.js:session()` treats the same session as expired. A session with no
  `expiresAt` shows a name in the header and "Sign in" in the game.

---

## What is sound

Verified working, not merely unexamined:

- **Round loop.** Guessing, hint spend, two-tap give-up, resume-after-reload,
  hint-fact reveal indexing (`FACT_HINTS.slice(1, revealed)` against
  `values[i+1]` lines up at every hint count), and the finished-round expansion
  into the full chapter, including the retry button and the stale-response
  guards on `state.puzzle.id` and `data.puzzleId`.
- **Data integrity.** All 720 puzzles carry `hintVersion: 2` and a non-empty
  `openingSentence`, `openingExcerpt`, `genre`, `year`, `setting`, `author` and
  `reading`; every `id` matches its filename; all 720 reading files have a
  matching `puzzleId` and non-empty `paragraphs`. The legacy (`hintVersion: 1`)
  completion crash the previous audit found is gone — `renderCompletedExcerpt`
  is now reached only when `isCurrentHints()` is true.
- **Title matching.** `fold`/`variants`/`isMatch` are careful in the right
  places: the `GENERIC`/`VAGUE` sets stop one-word guesses from solving books,
  `stripAuthor` is guess-side only, and the Levenshtein budget scales with
  length.
- **Auth.** Client-side PBKDF2 with a server-enforced iteration floor, constant-
  time verifier compare, per-route rate limits, Google `aud`/`sub`/
  `email_verified` cross-checks, and a dev code-echo path fenced behind three
  conditions that cannot co-occur in production.
- **Scores.** One row per account per book, best-kept via a delete-then-
  conditional-insert batch, one board across hint versions. Server-side input
  validation on every field.
- **Billing.** Webhook signature + livemode check, event replay table, re-read
  of live Stripe state, price amount/interval/currency/livemode verification
  before checkout, and an update guard that will not resurrect a cancelled
  subscription.
- **Ownership guards.** `ownsProgress()` is checked before and after every await
  in the sync and backfill paths, so a response for a signed-out account cannot
  write into the next one — covered by a test.
- **Cross-tab identity.** The `storage` listener in `js/auth.js:23` mirrors a
  session change into other tabs, and `playOwner()` namespaces progress, board
  and stats per account, closing the shared-browser leak the previous audit
  described.
- **XSS.** Every interpolation of player, title or share data goes through
  `escapeHtml`; the share payload is length-capped and every numeric field
  clamped in `readShare`.

## Suggested order

1. (1) finished-beats-unfinished, (2) upload only what changed — both are
   small, local, and one of them is data loss.
2. (5) revoke sessions on password change.
3. (3) durable streak/stat history.
4. (4) finish or explicitly fence the battle protocol.
5. (6)–(11) as cleanup.
