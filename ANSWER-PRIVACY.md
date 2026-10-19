# Hiding the answer

Last written: 2026-09-16. Status: **not built** — this is the plan, not a record.

Today the answer to every daily is public. Not leaked by a bug; it is how a
fully static client-side game works. Wordle shipped its answer list the same
way. This file is what it would take to close it, and what it would cost.

## What is exposed now

| Surface | What it hands over |
| --- | --- |
| `/puzzles/index.json` | `startDate`, `dailyStartIndex`, and the full 720-slug `order` — enough to compute the book for any future date |
| `/puzzles/g345.json` | `title`, `author`, `aliases`, `source.gutenberg` — in the same file the browser must fetch to render hint 1 |
| the slug itself | `g345` **is** the Gutenberg id. The filename is the answer, so redacting the file's contents changes nothing |

That last row is the one that kills the cheap fixes. Any scheme that leaves the
asset addressable as `g345.json` has already told you the book.

## Why the excerpt redaction is not this

`{{the Count}}` (see `d11b365`, `99a7751`, and g345 on 2026-09-16) keeps the
prose from handing the book to somebody *reading it*. It is a fix to the
reading experience. It was never a secrecy boundary and should not be sold as
one.

## The crux

Matching is client-side and forgiving. `js/match.js` (`window.BookleMatch`)
folds case and accents, strips a trailing "by <author>", drops stop words,
accepts a token-subset match, and accepts near-misses by edit distance —
`close()`. That is what makes "moby dick" and "Moby-Dick; or, The Whale" the
same guess.

Forgiving matching needs the accepted strings in the clear. So:

- **Keep client-side matching** → `aliases` must reach the browser before the
  round ends → the answer stays public. No way around it.
- **Hide the answer** → matching moves to the server.

Pick one. There is no third option that keeps both.

### Rejected: ship hashes instead of titles

Send `sha256(fold(alias))` and compare client-side. Breaks `close()` entirely —
you cannot edit-distance a hash — so every near-miss becomes a wrong guess. And
the candidate set is 720 public-domain books whose ids are already in `order`;
the whole table is brute-forced in seconds. Strictly worse than doing nothing.

## The build

1. **Split what the build emits.** `tools/build_puzzles.py` writes two things
   per book instead of one.
   - *Public asset*: `openingSentence`, `openingExcerpt`, `texts`, `labels`,
     `genre`, `year`, `setting`, `reading`. No `title`, `author`, `aliases`,
     `source`.
   - *Private row*: `title`, `author`, `aliases`, `source`, keyed by index.
     Into D1, next to the tables `backend/` already owns.

   Note `FACT_HINTS` — hint 5 *is* the author. So `author` has to come back
   from the server at hint 5, not sit in the asset waiting.

2. **Make the address opaque.** Publish each daily under an unguessable name
   (`/puzzles/d/<hmac(index, secret)>.json`) so the filename stops being the
   answer. `slugForIndex()` in `js/app.js` goes away for dailies; the client
   asks the API what today's id is. The bank (indices 0–599) can keep readable
   slugs — nothing is secret there.

3. **Stop shipping the tail of `order`.** `index.json` keeps the preset order
   it needs and drops the 120-entry daily pool.

4. **Move matching.** `js/match.js` becomes `backend/src/match.js`, imported by
   the Worker. The site keeps its copy for bank and battle modes, where there
   is nothing to protect. One file, two callers — do not fork it.

5. **Add the endpoints**, in the `path === '/x'` chain in
   `backend/src/worker.js` (~line 379), reusing the CORS and session handling
   already there.

   ```
   GET  /daily/today          -> { index, assetId }
   POST /daily/guess          -> { correct }            ; + { title, author } on the
                                 6th guess or a win
   GET  /daily/fact?n=5       -> { author }             ; hint 5 only
   ```

6. **Rate-limit it.** Server-side matching invites brute force. Cap at
   `MAX_GUESSES` = 6 per index per session, and per IP for signed-out players.

## What it costs

**Requests.** This is the real objection. Per `MONITORING.md` the Cloudflare
free plan gives 100,000 requests/day **account-wide**, shared by `excerptle`,
`excerptle-og` and `excerptle-api`. Today a round is static assets and zero API
calls. After this, a full round is up to 6 guesses + 1 author fact + 1 id
lookup ≈ 8 calls. At 1,000 daily players that is ~8,000 requests/day on a bucket
the whole account shares. Workable now; model it against the quota alerts in
`backend/src/alerts.js` before shipping, because it turns a free static game
into something with a per-player marginal cost.

**Offline and latency.** Guesses stop being instant and stop working offline.

**Battle mode** assumes both clients can judge correctness locally. It needs
its own answer, or the server has to referee the match.

## Recommendation

Do nothing, unless answer secrecy is actually a product requirement. The genre
norm is that the determined player can read the answer out of devtools, and the
cost above is real — a request budget, an offline regression, and a second
matcher to keep in sync. If it does become a requirement, steps 1, 2 and 4 are
the load-bearing ones; 3, 5 and 6 fall out of them.
