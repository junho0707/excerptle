# Fix plan — LOGIC-AUDIT.md findings

Ordered by what I'd land first. Each item lists the change, the test that
proves it, and the risk. Numbers match LOGIC-AUDIT.md.

---

## 0. Adopt legacy local data at boot  (do before the scoping change ships)

> **Done 2026-09-11.** Implemented by reusing `importGuestPlay` at boot, which already falls back to the unscoped keys for a guest owner.

`js/app.js`, after `activeAccountUid` is initialised: if a session is already
present and the account namespace is empty, adopt the legacy unscoped
`bookle.progress.v4` / `bookle.lb.v4` / `bookle.stats` into it, merging with the
same `beats()` rule as #1, then write the `bookle.guest-imported.*` marker so it
cannot run twice.

**Test.** A Playwright case: pre-seed the unscoped keys plus a session, load,
and assert the streak and board survive.

**Risk:** low, and it is the difference between a silent reset for every
existing player and a clean upgrade.

---

## 1. Finished beats unfinished  (data loss — do first)

> **Done 2026-09-11.** Client and server, and the server ranks all three levels (over > played > only opened), not just finished/unfinished. The SQL is nested CASE so `json_extract` cannot raise on a malformed legacy row.

**Client.** Add one helper next to the sync block and use it at both merge
sites:

```js
// 2 = the round is over, 1 = it was played, 0 = it was only opened.
function progressRank(row) {
  if (row?.status === "won" || row?.status === "lost") return 2;
  return row?.hints || row?.guesses?.length ? 1 : 0;
}
const beats = (a, b) =>
  progressRank(a) !== progressRank(b)
    ? progressRank(a) > progressRank(b)
    : Number(a?.at || 0) >= Number(b?.at || 0);
```

- `js/app.js:299` (`syncProgress`) → `if (!merged[index] || beats(row, merged[index])) …`
- `js/app.js:382` (`importGuestPlay`) → same, replacing the `oldEmpty` logic.

Declare `progressRank`/`beats` **inside** the region
`tools/progress_sync_test.mjs` slices (between `let progressSyncing` and the
backfill comment) so the existing harness can see them.

**Server.** `backend/src/worker.js`, `progress` PUT. The handler already has
the parsed `value`, so bind a finished flag rather than adding a column:

```js
const done = value.status === 'won' || value.status === 'lost' ? 1 : 0;
...
ON CONFLICT(user_id,puzzle_index) DO UPDATE SET
  data=excluded.data, updated_at=excluded.updated_at
WHERE ? > (json_extract(progress.data,'$.status') IN ('won','lost'))
   OR (? = (json_extract(progress.data,'$.status') IN ('won','lost'))
       AND excluded.updated_at >= progress.updated_at)
```

(`done` bound twice; D1 ships SQLite's JSON1, so no migration is needed.)

**Tests.** New case in `tools/progress_sync_test.mjs`: a remote `won` row and a
newer local `playing` row must merge to `won`. New case in
`backend/test/` : PUT `won`, then PUT `playing` with a later `at`, then GET must
still read `won`.

**Risk:** low. The only behaviour change is that a finished round becomes
sticky, which is the intent everywhere else in the app.

---

## 2. Upload only what changed

> **Done 2026-09-11.** Batch is 3; the bulk test now expects 7 requests for 20 entries.

`js/app.js:296-304`, in `syncProgress`:

```js
const merged = { ...remote };
const changed = {};
for (const [index, row] of Object.entries(local)) {
  if (!merged[index] || beats(row, merged[index])) { merged[index] = row; changed[index] = row; }
}
savePlayJSON(K.progress, merged);
if (Object.keys(changed).length) pendingProgress = { ...pendingProgress, ...changed };
```

Then raise the batch slice at `js/app.js:270` from 2 to 3 — the server caps a
single entry at 4096 bytes, so 3 entries plus wrapper stays under the 16 KB
body limit with room to spare.

**Tests.** Update `tools/progress_sync_test.mjs` "bulk progress is split"
(20 entries → 7 requests, still asserting `< 16384` bytes) and add: a sync whose
remote copy wins every row must issue **zero** PUTs.

**Risk:** low, and it deletes traffic rather than adding it. Pairs naturally
with #1 since both turn on `beats()`.

---

## 3. Durable streaks — derive, don't sync

> **Done 2026-09-11.** Derived, as planned. Battle stats took option (a): still device-local, and the Stats heading now says "on this device".

Worth checking first: of the solo half of `loadStats()`, only
`currentStreak`, `maxStreak`, `lastWinDate` and `lastDaily` are ever read
(`js/app.js:1695-1696`). `played`, `wins`, `fails`, `dist` and
`practicePlayed` are written by `recordFinish` and read by nothing — the Stats
screen already recomputes those from `summarize()`.

So the streak does not need syncing; it needs deriving. A daily's index maps
back to its date through `dateForDailyIndex` (currently dead code,
`js/app.js:451`), and the progress map already syncs:

```js
function dailyStreaks() {
  const won = Object.entries(progressMap())
    .filter(([k, r]) => r?.status === "won" && Number(k) >= (state.index?.dailyStartIndex ?? 600))
    .map(([k]) => dateForDailyIndex(Number(k)))
    .sort();
  // longest run of consecutive dates; current run only counts if it ends
  // today or yesterday.
}
```

Then: delete the solo-stat block in `recordFinish` (`js/app.js:997-1013`), drop
those fields from `loadStats()`, and point the two Stats tiles at
`dailyStreaks()`. `loadStats()` shrinks to the battle tally.

**Battle stats** genuinely cannot be derived — battles write no progress row.
Two options, your call:
- **(a) Leave device-local** and label the panel "on this device". Zero work.
- **(b) Sync it** with a `GET/PUT /me/stats` endpoint (one JSON blob per user,
  one small table, ~15 lines of Worker). Right answer if battles ever get a
  public board.

**Tests.** Node test over `dailyStreaks` with a synthetic progress map: a gap
breaks the run, yesterday keeps it alive, today's win extends it, an archived
daily played out of order doesn't inflate it.

**Risk:** medium — it changes what the Stats screen shows for existing players
(their streak is recomputed, and will be *correct* rather than whatever their
local counter drifted to). Worth a line in the release note.

---

## 4. [FIXED 2026-09-11] Battle referee

> Done. Ties now go to whoever named the book first, measured as elapsed time
> from each player's own round start rather than wall clocks; a dead heat goes
> to the host. The battle tally settles before it is written, so a win that is
> handed over never counts. `lose` is handled and a duplicate `start` cannot
> restart a guest. Covered by `tools/battle_sim.cjs` T5–T9.

Two sizes. I'd do the minimal one now and the full one only if battles get
used.

**Minimal (~25 lines, `js/app.js:2115`).**
- Handle `{type:"lose"}`: if the opponent is out of guesses and you are still
  playing, you win — finish the round with `state.beatenBy = null`.
- Tie rule: on `{type:"win"}` arriving when you are *already* `won`, the host's
  claim wins. The guest demotes itself to `lost`; the host ignores the message.
  One line each side, and it makes the two browsers agree.
- Guard `start`: ignore it when `state.mode === "battle" && state.puzzle`.

**Full (~60 lines).** Host becomes the referee: it stamps a `matchId` onto
`start`; every later message carries it and is dropped if it does not match
(this alone fixes the restart bug). A local win sends `{type:"claim"}` and waits
rather than finishing; the host resolves the first claim it sees and broadcasts
`{type:"result", winner}`; both sides finish on that. A 3-second timeout on an
unanswered claim falls back to the optimistic local result so a host
disconnect can't hang the round.

**Tests.** `tools/battle_sim.cjs` already exists — extend it with a
simultaneous-win case and an opponent-out-of-guesses case.

**Risk:** minimal version is low. Full version changes the wire format, so both
players need the same build — acceptable for a P2P feature with no persistence.

---

## 5. Revoke sessions on password change

> **Done 2026-09-11.**

`backend/src/worker.js:153`, `setPassword`. The caller's token hash is already
derivable the way `/auth/logout` does it:

```js
const mine = await hash(req.headers.get('Authorization').slice(7));
// after both the remove branch and the set branch:
await query(env, 'DELETE FROM sessions WHERE user_id=? AND token_hash<>?', u.id, mine).run();
```

Batch it with the UPDATE so a change can't half-apply.

**Test.** `backend/test/`: open two sessions, change the password on one, assert
the other's next authenticated call is 401 and the caller's still works.

**Risk:** none. ~4 lines.

---

## 6. Stripe checkout replay

> **Done 2026-09-11.** The second create fires only on a session that comes back `expired` or `complete`, so a stub or an older API version that omits `status` changes nothing. Its key carries a UUID, not a timestamp.

`backend/src/worker.js:288-300`. Keep the bucket idempotency key (it is what
stops a double-click buying twice) and verify what comes back:

```js
let checkout = await s.checkout.sessions.create({...}, { idempotencyKey: key });
if (checkout.status !== 'open') {
  checkout = await s.checkout.sessions.create({...}, { idempotencyKey: `${key}:${now()}` });
}
```

A replayed-but-expired session is the only case that trips the second call, so
the double-click guard is untouched.

**Test.** Extend `backend/test/billing.test.js` with the
monthly → yearly → monthly sequence inside one bucket and assert the returned
URL belongs to an open session.

**Risk:** low. One extra Stripe call on a path that is already several.

---

## 7. Leaderboard duplicate row

> **Done 2026-09-11.**

Two small changes:

1. `js/app.js:352-358` (`backfillScores` reconciliation) — carry `playerId`
   across, not just `sent`:
   ```js
   if (match) { row.sent = 1; row.playerId = connection.uid; }
   ```
2. `js/app.js:1557` (`renderRanks`) — the server keeps exactly one row per
   account per book, so a local row of the player's own that has already been
   sent is always a duplicate identity once *any* remote row for this account
   exists:
   ```js
   const accountHasRemote = remote.some(r => r.playerId === accountId);
   ... local.filter(r => !(r.mine && r.sent && accountHasRemote) && !seen.has(rankKey(r)))
   ```
   Gating on `r.sent` keeps an un-uploaded row visible, so a failed upload never
   makes someone's result disappear.

**Test.** Extend `tests/logic-sweep.spec.js` — stub `/scores` to return a better
row for the account and assert the board renders the player once.

**Risk:** low.

---

## 8. `pro.js` honours `force`

> **Done 2026-09-11.**

`js/pro.js:94`, first lines of `refresh`:

```js
const FRESH_MS = 5 * 60 * 1000;
if (!force && cur && !cur.error && Date.now() - cur.at < FRESH_MS) return view();
```

The focus listener (`:161`) then costs nothing on a quick alt-tab, while
`{force:true}` (post-checkout, sign-in, modal open) still round-trips.

**Risk:** none. Someone who buys Pro in another tab sees it up to 5 minutes
later on this one, and the Stripe return URL already forces a refresh.

---

## 9. `state.loading` on failed loads

> **Done 2026-09-11.**

`js/app.js:1103-1140`. Replace the three bare `return`s with a helper:

```js
const bail = (text) => { state.loading = false; $("#excerpt").textContent = text; };
```

**Risk:** none.

---

## 10. Daily pool exhaustion (2027-01-07)

> **Guard landed 2026-09-11**, and the answer is (a), grow the pool, at some point. `npm run test:data` runs the check in CI and in `predeploy:site`, failing under 30 days of runway.

Not a code fix — a decision, with ~4 months of runway. Options:

- **(a) Grow the pool.** `tools/build_puzzles.py` already builds 720; raising
  `dailyPoolCount` means curating more books. Preferred: the archive keeps
  growing and nothing repeats.
- **(b) Reshuffle per cycle.** Seed a permutation on `floor(day / pool)` so
  cycle 2 isn't cycle 1 in order. Cheap, but repeats are still repeats.
- **(c) Stop.** Show "the archive has caught up" past the last daily.

Whichever way it goes, add a check to `tools/check_hint_metadata.py` (or a new
`qa` step) that fails the build when fewer than 30 days of unused dailies
remain, so this can't arrive by surprise.

---

## 11. Excerpt copy

> **Done 2026-09-11.**

`js/app.js:1452` and `how-to-play.html:128`: replace
"Opening excerpt (2–4 paragraphs)" with "Opening excerpt (the book's opening
paragraphs)". Two strings; the underlying behaviour is correct and deliberate.

---

## 12. Housekeeping

- `git add backend/migrations/0006_shared_leaderboard.sql`, apply to the
  production D1 **before** the next `npm run deploy:api`, and note the ordering
  in `DEPLOYMENT.md`. The `INSERT … WHERE NOT EXISTS` in `scores` relies on the
  unique index it creates.
- Delete `clearLocalPlayData` (`js/app.js:364`); `dateForDailyIndex`
  (`js/app.js:451`) stops being dead once #3 lands.
- Collapse `pickById` (`js/app.js:1278`) into `playById` — one validation path.
- Remove the untracked `backend/backend/` build artifact and add it to
  `.gitignore`.
- Align `js/share-page.js`'s session check with `js/auth.js:session()` (treat a
  missing `expiresAt` as expired).

---

## Suggested batches

| Batch | Items | Why together |
|---|---|---|
| A | 1, 2 | Both hinge on `beats()`; one commit, one test file touched twice. |
| B | 5, 6, 12-migration | All backend, one API deploy. |
| C | 3 | Behaviour change worth its own commit and release note. |
| D | 7, 8, 9, 11, rest of 12 | Small, independent, low risk. |
| E | 4 | Its own thing; decide minimal vs full first. |
| — | 10 | Decision, not code. Needs an answer before ~2026-12-07. |
