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
| Core game | 6 guesses. **Hints** expand text (sentence → paragraph → two paras → a few pages → chapter 1). Guesses do **not** reveal text. |
| Matching | Generous typos / “The…” / `by Author`. Not one-word stabs (`great`). Distinctive last tokens (`gatsby`) OK. `js/match.js`. |
| Nav | New game (modal) · How to play (modal) · All books · Leaderboard · Sign in · Settings. |
| New game modal | Today’s daily, random book, choose by ID, battle. |
| After a game | Next random book, choose by ID, share (🟨 + 💡), challenge, leaderboard CTA, post-game ad **slot** (no network). |
| Daily | UTC. `puzzles/index.json`: `startDate` `2026-09-08`, `dailyStartIndex` **1001**. Today = `#1001 + daysSince(start)`. |
| Book bank | Presets `#1…#863` (`presetCount`). Aim was 1000; extras filtered. Curated `b01`–`b50` are high quality; `g*.json` extras are mixed (Gutenberg front matter). |
| Battle | PeerJS P2P. Same index, shared hints, first correct title wins. `?b=CODE&p=INDEX`. Needs network. |
| Leaderboard UI | Per-index, filter by hints, sort win → fewer hints → faster → fewer guesses. **Local `localStorage` only** until API exists. |
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
GET /scores?puzzleIndex=1001&hints=0
```

Sort: `win` desc, `hints` asc, `timeMs` asc, `guesses` asc.

**Progress (logged-in)** — not synced yet. Local only: `bookle.progress` map `{ [index]: { status, guesses, hints, puzzleId, mode, timeMs, at } }`. Backend should add `GET/PUT /me/progress` and merge on sign-in.

**Leaderboard “global”** is a product requirement. Local boards are a stub.

---

## Frontend files

```
index.html          shell, nav, modals
css/app.css
js/config.js        Google client ID + API origin (no secrets)
js/auth.js          GIS + email API client + demo fallback
js/match.js         title matching
js/app.js           game, bank, ranks, battle, share
puzzles/index.json  startDate, dailyStartIndex 1001, order[], presetCount 863
puzzles/bXX.json    curated (good openings)
puzzles/g{id}.json  Gutenberg extras (quality varies)
tools/build_puzzles.py
tools/books.json    50 curated + anchors
tools/extra_books.json
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
