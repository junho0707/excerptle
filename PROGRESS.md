# Excerptle — progress / next-agent handoff

**Read this first.** Product is **Excerptle** at **https://excerptle.io**. Workspace: `/home/yys80/games`. Static frontend is playable. **Next job: backend.**

Do not rebuild Yeardle. Do not put the Google **client secret** in any frontend file.

---

## Run the frontend

```bash
python3 -m http.server 8765 --directory /home/yys80/games
# http://127.0.0.1:8765/
```

Hard-refresh after JS/HTML changes.

---

## What shipped (frontend)

| Area | Status |
|---|---|
| Name / domain | Excerptle, `CNAME` = `excerptle.io`. Share URLs `https://excerptle.io/?p=N`. |
| Core game | 6 guesses. **Hints** expand text (sentence → opening paragraphs → a page → a few pages → chapter 1). Each tier must clear a word target *and* grow ~1.4-2x over the one before, so no two hints ever show the same screen. Guesses do **not** reveal text. |
| Matching | Generous typos / “The…” / `by Author`. Not one-word stabs (`great`). Distinctive last tokens (`gatsby`) OK. **Titles are expanded into variants at match time** (`variants()` in `js/match.js`), so Gutenberg packaging is optional to type — “Richard Carvel” solves *Richard Carvel — Complete*, “The Adventures of Tom Sawyer” solves *…, Part 4.*, “Moby Dick” solves *Moby-Dick; or, The Whale*. Fragments still lose: “The Adventures”, “The Red Badge”, “Tom Swift”, “tom sawyer” are all rejected, because every variant is matched **whole**. Edition words (`complete`, `volume`, `romance`, …) are barred from the one-word shortcut. `by <author>` is stripped from the **guess only** — stripping it from titles used to reduce “Won By the Sword” to `won`. |
| Nav | New game (modal) · How to play (modal) · All books · Leaderboard · Sign in · Settings. Tabs sit inline in the header at ≥1025px; the hamburger takes over from iPad width (≤1024px) down. |
| New game modal | One modal, no second step. A **Battle mode switch** at the top changes what the picks below it do: off, they start a solo round; on, the pick opens a battle room directly. Three rows — Today’s daily, Random book, Choose by ID — each with its **Guess** button on the right. Today’s daily is disabled while battle is on (battle needs a book both players can be handed). Bad IDs report inside the modal (`#choice-err`), not on the covered game screen. Acts are `pick-today` / `pick-random` / `pick-id`, distinct from the `#more` row's `play-random` so the switch can't leak out of the modal. |
| After a game | Next random book, choose by ID, share, leaderboard CTA, post-game ad **slot** (no network). The reveal prints `stripEdition(title)`, so the answer reads “Richard Carvel”, not “Richard Carvel — Complete”. Standings show **both** — `#n of N at h hints` and `#n of N overall`. |
| Share | **Share copies a bare URL, nothing else** — the card is what the link previews as. The whole result rides in `?p=<index>&s=<base64url JSON>` (`sharePayload()`), so both the recipient's page and a crawler can render it with no lookup. Opening the link shows the sharer's card — grid, score, time, both standings — over the puzzle, then plays it. **The payload never carries the title**; a share must not spoil the book. `?p`/`?s`/`?b` are stripped from the URL after the first route. |
| Share unfurls | Needs a server — see `tools/og-worker/`. GitHub Pages returns the same `index.html` for every URL, and crawlers don't run JS, so per-share `<meta>` is impossible from the client. The Worker proxies the origin and rewrites OG/Twitter title + description from `?s=`. **Not deployed yet.** `og:image` is still static; the README says how to add a rendered card. |
| Daily | UTC. `puzzles/index.json`: `startDate` `2026-09-09`, `dailyStartIndex` **600**. Today = `#600 + daysSince(start)`, so launch day is **#600, Pride and Prejudice**. The dailies run in most-famous-first order, #600–#719 (120 days). |
| All books page | Show = **All** (default) / **Book bank** / **Daily**; “All” lists the bank then the dailies at the end. Pager reads Prev · Page n / m · Next, centred and stable across pages. Play labels and the in-game meta bar read **Book bank #n**. |
| Book bank | **600 books, indices #0–#599** (`presetCount`), scrambled by `sha256(ORDER_SALT + slug)`; the 120 dailies are #600–#719 and are in no bank slot, so a daily is never something you could already browse. Every slug is a Gutenberg id (`g1342`) — the curated `b*.json` puzzles are gone, along with the per-work dedupe they needed. See HANDOFF.md for how the 720 were cut and gated. |
| Battle | PeerJS P2P. Same index, shared hints, first correct title wins. `?b=CODE&p=INDEX`. Needs network. **Books only — dailies are not offered or accepted in battle.** Losing the race reads “<name> got there first”, not “Out of guesses” (`state.beatenBy`). |
| Stats (`#/stats`) | Three peer sections — **Daily → Book bank → Battle mode** — on one flat type scale, under a ruled page title. No tiering, no Overall block, no guess-distribution graph: they were noise. Battle numbers are **explicit counters** in `bookle.stats.battle` (a battle writes its book's `progress` row, so it cannot be counted back out of `progress` afterwards); everything else is derived live by `summarize()` from `bookle.progress`, so it stays true if rows are edited or cleared. |
| Leaderboard UI | One board per puzzle. Filters: Puzzle # and Hints used (0–5). No scope selector, and an empty board renders nothing rather than a placeholder. Sort win → fewer hints → faster → fewer guesses. **Local `localStorage` only** until API exists. |
| Auth UI | Google + email-first, then **code or password**. **No passkeys.** |
| Removed | Motion setting, coffee/give-up stats bar, More games. |

Gameplay JSON stays static. Backend is for **identity, mail, scores, synced progress** — not for serving the book text.

---

## Auth (do this on the backend)

### Google

- **Client ID** (public, already in `js/config.js`):  
  `1041895139600-l1k1okdmncr1kjsgknt0n5tt1oqm3nfc.apps.googleusercontent.com`
- Frontend uses **Google Identity Services** (`js/auth.js` → `google.accounts.id.initialize`). JWT comes to the browser; we parse email/name. We do **not** use the client secret here.
- **Client secret** → server `.env` only, gitignored. Needed if you verify Google ID tokens server-side (recommended) or add a code-exchange flow.
- Cloud Console **JavaScript origins**: `http://127.0.0.1:8765`, `http://localhost:8765`, `https://excerptle.io`, `https://www.excerptle.io`.
- **Redirect URIs** (same four, no trailing slash). GIS callback does not redirect; URIs exist so the Web client can be saved.

### Email (no passkeys)

Frontend already calls these when `window.EXCERPTLE_API` / `BOOKLE_API` is set (same value; see `js/config.js`):

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/auth/email` | `{ email }` | `{ hasPassword: boolean }` — also **send a 6-digit code** (email). |
| POST | `/auth/verify` | `{ email, code }` | `{ uid, name?, email }` |
| POST | `/auth/password` | `{ email, password }` | `{ uid, name?, email }` — create-or-login, min 8 chars. |

If `EXCERPTLE_API` is `""` (current), email is **demo**: code is generated in the browser and shown in the modal. Passwords hashed into `localStorage`. Replace that by setting the API origin.

**UX to preserve:** first screen = Google **or** email. After email Continue → code field + optional password. Resend code. No passkey. No “send a code / passkey / password” dump on screen 1.

Suggested session: httpOnly cookie or JWT returned from `/auth/verify` and `/auth/password`. Frontend today only stores `{ email, name, provider, uid }` in `localStorage` (`bookle.auth.session`). Wire a real token when the API exists; don’t invent a second login UI.

---

## Other API the client already expects

Set `window.EXCERPTLE_API = "https://api.excerptle.io"` (or local API) in `js/config.js`.

**Scores** — `js/app.js` `pushLb()`:

```
POST {API}/   (sendBeacon JSON)
{ type: "score", id, name, guesses, hints, timeMs, win, at, puzzleIndex }
```

Today it beacons to the API **root**. Backend should pick a real path (e.g. `POST /scores`) and **change the client** to match. Return/list:

```
GET /scores?puzzleIndex=600&hints=0
```

Sort: `win` desc, `hints` asc, `timeMs` asc, `guesses` asc.

**Progress (logged-in)** — not synced yet. Local only: `bookle.progress` map `{ [index]: { status, guesses, hints, puzzleId, mode, timeMs, at } }`. Backend should add `GET/PUT /me/progress` and merge on sign-in.

**Billing (Excerptle Pro)** — `js/pro.js`. Stripe is entirely server-side; the browser only ever
calls our API and follows the Stripe-hosted URL it hands back. All three need the session's bearer
token, which `/auth/verify`, `/auth/password` and Google verification must start returning as
`session.token` — until they do, `js/pro.js` sends no `Authorization` header and every call 401s.

```
GET  /billing/status    -> { pro, status, currentPeriodEnd, cancelAtPeriodEnd, price }
POST /billing/checkout  { returnUrl } -> { url }   Stripe Checkout session
POST /billing/portal    { returnUrl } -> { url }   Stripe Billing Portal session
```

`status` is Stripe's own subscription status (`active` | `trialing` | `past_due` | `unpaid` |
`canceled` | `none`); `pro` is the single boolean the client acts on. Entitlement must come from the
**`customer.subscription.*` and `invoice.*` webhooks**, not from the Checkout redirect — the redirect
is only a hint that something happened. The one privilege today is ad-free, so a client that fails to
reach `/billing/status` keeps its cached answer for 24h rather than showing ads to a subscriber.

**Leaderboard “global”** is a product requirement. Local boards are a stub.

---

## Static pages (SEO)

`about.html`, `how-to-play.html`, `faq.html` are plain documents — no JS, sharing `css/app.css` and
the app's header/footer. They exist because the game is a hash-routed SPA, so Google sees exactly
one URL, and because an AdSense reviewer judging "sufficient content" would otherwise land on an
empty game board. Each carries its own title/description/canonical, and `how-to-play` / `faq` carry
HowTo / FAQPage JSON-LD. Linked from the footer and listed in `sitemap.xml`.

They are served at **extensionless paths** (`/about`), which relies on Cloudflare Workers assets
`html_handling` resolving `/about` → `about.html` (the default). Verify after the next deploy; if it
404s, either set `html_handling` explicitly or change the links and canonicals to `.html`.

Hash routes are deliberately **not** in the sitemap — search engines drop fragments, so listing
`/#/bank` was listing `/` three times.

---

## Frontend files

```
index.html          shell, nav, modals
css/app.css
js/config.js        Google client ID + API origin (no secrets)
js/auth.js          GIS + email API client + demo fallback
js/match.js         title matching
js/app.js           game, bank, ranks, battle, share
puzzles/index.json  startDate 2026-09-09, dailyStartIndex 600, order[] (720: bank #0-599 scrambled, dailies #600-719 by fame), presetCount 600, dailyPoolCount 120
puzzles/g{id}.json  one per book, slug = Gutenberg id
tools/build_puzzles.py
tools/final_bank.json / final_dailies.json   the shipped 720
tools/anchors.json  hand-set excerpt starts
CNAME               excerptle.io
```

Internal JS names still say `BookleAuth` / `bookle.*` localStorage. Don’t rename unless you migrate keys (would wipe local stats).

---

## localStorage (keep compatible)

| Key | Purpose |
|---|---|
| `bookle.playerId` | anonymous UUID |
| `bookle.name` | display name |
| `bookle.stats` | daily streak / dist |
| `bookle.settings` | `{ theme }` (motion removed) |
| `bookle.seenHowTo` | first-visit how-to |
| `bookle.progress` | per-index boards |
| `bookle.lb.v1` | `{ [puzzleIndex]: Score[] }` |
| `bookle.auth.session` | `{ email, name, provider, uid }` |
| `bookle.auth.users` | demo password hashes only |

---

## Backend build order (suggested)

1. Small API (Cloudflare Worker / Hono / whatever) + CORS for `http://127.0.0.1:8765` and `https://excerptle.io`.
2. `.env`: `GOOGLE_CLIENT_ID` (same as frontend), `GOOGLE_CLIENT_SECRET` (server only), mail provider (Resend/Postmark/etc.).
3. Implement `/auth/email`, `/auth/verify`, `/auth/password`. Verify Google ID tokens if you want Google sessions server-side.
4. Point `EXCERPTLE_API` at it; confirm demo codes disappear.
5. `POST/GET /scores` + change `pushLb` path. Persist per `puzzleIndex`.
6. Sync `progress` for signed-in users.
7. Optional: replace PeerJS battle with rooms on this API.

Gameplay stays static JSON. Don’t put Gutenberg dumps behind auth.

---

## Out of scope / don’t do unless asked

- Yeardle
- Passkeys
- Putting Google client secret in `js/` or git
- Motion setting / coffee stats bar (removed on purpose)
- More Games
- Hosting full books
