# Deployment

How excerptle.io is hosted, how to ship an update, and what still needs doing.

Last verified: 2026-09-08.

## Architecture

Static frontend — HTML, CSS, JS, and pre-built puzzle JSON — served by **Cloudflare Workers static assets**. There is no backend. No build step: the repo root *is* the deployed site.

| Thing | Value |
| --- | --- |
| Worker name | `excerptle` |
| Account subdomain | `winter-glade-cbab` |
| Live URL | https://excerptle.io |
| Repo | `github.com/junho0707/excerptle` (branch `main`) |

`tools/` is a local puzzle-generation toolchain (Python). It is not part of the deployed site.

## DNS

`excerptle.io` is on Cloudflare nameservers — `cesar.ns.cloudflare.com`, `mallory.ns.cloudflare.com`.

| Record | Type | Value | Proxy | TTL |
| --- | --- | --- | --- | --- |
| `excerptle.io` | A | `104.21.36.79`, `172.67.190.101` | Proxied | Auto |
| `www.excerptle.io` | CNAME | `excerptle.io` | Proxied | Auto |

The apex A records are managed by Cloudflare — they appear automatically when the Worker's Custom Domain is bound, so don't hand-edit them. TTL is locked to Auto (`1`) on proxied records; Cloudflare controls it at the edge.

## Custom domain

The apex is attached to the Worker as a **Custom Domain**, not a Route:
Workers & Pages → `excerptle` → Settings → Domains & Routes. Cloudflare issues and renews the TLS cert automatically.

`www` is deliberately *not* a second Custom Domain. Binding it would serve identical content on two hostnames and split SEO. It redirects instead.

## www → apex redirect

Rules → Redirect Rules:

- **Match:** Wildcard pattern, field URI Full, value `https://www.excerptle.io/*`
- **Then:** Static redirect → `https://excerptle.io/${1}`, status **301**, preserve query string

`${1}` carries the captured path through, so `www.excerptle.io/about` lands on `excerptle.io/about`. Without it every path collapses to the homepage.

Redirect Rules run at Cloudflare's edge *before* origin lookup, which is why `www` needs no Worker binding. Before this rule existed, `www` returned **522** — DNS resolved to the edge, but nothing was bound to that hostname.

## workers.dev is disabled

Both routes are turned off in Settings → Domains & Routes:

- Production: `excerptle.winter-glade-cbab.workers.dev`
- Preview: `*-excerptle.winter-glade-cbab.workers.dev`

They served a public duplicate of the site on a hostname nobody should be linking to. `excerptle.winter-glade-cbab.workers.dev` now returns **404**; the apex is unaffected. Keep these off.

## Shipping an update

### Three Workers, and the order matters

| Script | Config | What it is |
| --- | --- | --- |
| `excerptle` | `wrangler.jsonc` | The front door: static assets + share-link meta rewrite. ~5 KB, deliberately |
| `excerptle-og` | `tools/og-worker/wrangler.jsonc` | Share-card PNG renderer (resvg WASM + fonts). ~3.5 MB |
| `excerptle-api` | `backend/wrangler.toml` | Accounts, scores, billing, Slack alerts |

```bash
npx wrangler deploy --config tools/og-worker/wrangler.jsonc   # renderer FIRST
npm run deploy:site                                             # tests, then front door
npx wrangler deploy --config backend/wrangler.toml             # api
```

The renderer goes first: the front door's `OG` service binding will not resolve
against a script that does not exist yet.

### Core gameplay release checks

Install the browser once with `npx playwright install chromium`. `npm run
deploy:site` runs the client checks and the Playwright gameplay suite before
uploading; a failure stops the deployment. Direct `wrangler deploy` bypasses
this gate. GitHub Actions runs the same checks on pushes and pull requests
and keeps browser traces when they fail.

Run `npm run test:e2e` independently to exercise daily wins/losses, reloads,
random books, book #0, the New game picker, and All Books on desktop and
mobile viewports. It covers guests, expired sessions, and signed-in users
with unavailable account services, plus a successful sign-in after solving.
It also holds back a puzzle response to check that loading cannot erase a guess.
The logic sweep adds stale-response navigation, failed puzzle recovery, shared
link validation, leaderboard routing, remote-progress restoration and sign-out
isolation. `npm test` also checks progress retries, upload batching, battle
message bounds, timestamp ordering, and archived-daily streak handling.
`npm run deploy:api` gates API uploads on the backend suite, including CORS,
score ordering/concurrency, sessions, password flows, and billing webhooks.
Account responses are mocked, so this checks browser behavior, not delivery
of email codes or Google OAuth. No production accounts or scores are written.

For a post-deployment check, use `PLAY_TEST_URL=https://excerptle.io npm run
test:e2e`. To use an existing Chromium installation, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable.

**Why they're split.** `run_worker_first` puts `excerptle` in front of `/`, so
its whole bundle is loaded into an isolate before the first page load in a cold
colo can be answered. While the card renderer lived in that bundle, every such
load waited on 3.5 MB of WASM and fonts to serve HTML that used neither. If you
ever add a dependency to the front door, run `npx wrangler deploy --dry-run`
and check "Total Upload" is still single-digit KB.

### History

The site was deployed from the Cloudflare **dashboard** — there is no `wrangler.toml` in the repo and wrangler has never run on this machine. That leaves two possibilities, and they differ in what you have to do:

**Check which one you're on:** Workers & Pages → `excerptle` → Settings. If a **Build** section shows a connected GitHub repo, it's Git-connected. If there's no build config, it's manual upload.

### If Git-connected (Workers Builds)

```
git add -A
git commit -m "your message"
git push origin main
```

The push triggers a build and deploy automatically. Watch it under the worker's Deployments tab.

### If manual upload

Re-upload the project folder through the dashboard on every change. Committing to git does **not** deploy anything.

Worth migrating off this. To switch to reproducible CLI deploys, add a `wrangler.toml`:

```toml
name = "excerptle"
compatibility_date = "2026-09-08"
assets = { directory = "." }
```

then `npx wrangler deploy`. Commit that file so the config lives with the code.

## Verifying a deploy

```bash
# apex serves the site
curl -sS -o /dev/null -w "%{http_code}\n" https://excerptle.io/          # expect 200

# www redirects to apex
curl -sSI https://www.excerptle.io/ | grep -iE '^(HTTP|location)'         # expect 301 + Location

# workers.dev stays dead
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://excerptle.winter-glade-cbab.workers.dev/                        # expect 404

# live HTML matches the current commit
diff <(curl -sSL https://excerptle.io/) <(git show HEAD:index.html) && echo "in sync"
```

Note that `https://excerptle.io/index.html` redirects to `/`, so fetch `/` or pass `curl -L`.

### If the site loads for everyone but not for you

Almost certainly a stale negative DNS cache on your machine, not a Cloudflare problem — this happened during initial setup, when the local resolver kept returning NXDOMAIN for hours after the domain went live. In Windows PowerShell as admin:

```
ipconfig /flushdns
wsl --shutdown
```

Confirm the site is genuinely up by loading it on a phone over cellular, which bypasses your local resolver entirely.

## Secrets and environment variables

**There are none, and none are needed right now.** Nothing in this repo reads an env var, and the Worker has no bindings.

`js/config.js` holds the Google **client ID**:

```
1084292631320-lat25fml3s4n627i4c9aur7a4752cmrm.apps.googleusercontent.com
```

That is public by design. OAuth client IDs are meant to ship in frontend code — they identify the app, they don't authenticate it. Committing it is correct.

The Google **client secret** does not belong anywhere in this repo, and has no use yet. It's only needed to verify ID tokens server-side or run a code-exchange flow, and there is no server: `window.EXCERPTLE_API` is `""`, so `js/auth.js` falls back to a localStorage demo mode.

When a backend does exist, the secret goes in **Worker secrets** — Settings → Variables and Secrets → add as *Secret* (encrypted, write-only), or `npx wrangler secret put GOOGLE_CLIENT_SECRET`. Never in `js/config.js`, never in any file the browser downloads. `.env` is already gitignored for local use.

## Google OAuth client (from scratch)

The old client ID lived in a Cloud project whose consent screen reads **ProvableLearning**, and one project has exactly one consent screen — so Excerptle needs its own project, not just a renamed client.

**1. New project.** [console.cloud.google.com](https://console.cloud.google.com/) → project picker (top bar) → **New project** → name `Excerptle` → Create → then switch the picker to it. Every step below happens inside this project.

**2. Branding** (APIs & Services → **OAuth consent screen** → *Get started* / **Branding**):

| Field | Value |
| --- | --- |
| App name | `Excerptle` |
| User support email | your address |
| Audience | **External** |
| Authorized domain | `excerptle.io` |
| Application home page | `https://excerptle.io` |
| Developer contact | your address |

Skip the **app logo**. Uploading one pushes the app into Google's brand-verification queue (days to weeks) and the consent screen keeps working fine without it.

**3. Scopes.** Add nothing. The flow requests `openid email profile`, which are non-sensitive and need no verification.

**4. Audience → Publish.** While the app sits in *Testing*, only listed test users can sign in and their sessions die after 7 days. Set it to **In production** before launch.

**5. Credentials** → **Create credentials** → **OAuth client ID** → Application type **Web application**, name `Excerptle web`.

*Authorized JavaScript origins* — origins only, never a path:

```
https://excerptle.io
https://www.excerptle.io
http://localhost:8765
http://127.0.0.1:8765
```

*Authorized redirect URIs* — every one ends in `/oauth.html`, because that page is where Google hands the token back:

```
https://excerptle.io/oauth.html
https://www.excerptle.io/oauth.html
http://localhost:8765/oauth.html
http://127.0.0.1:8765/oauth.html
```

**6. Take the client ID only.** Copy the `…apps.googleusercontent.com` string into `js/config.js`:

```js
window.EXCERPTLE_GOOGLE_CLIENT_ID = "NEW-ID.apps.googleusercontent.com";
```

The **client secret** stays in the console. It has no use in a static frontend and must never land in this repo.

**7. Test.** Serve on 8765, open `http://localhost:8765`, click Sign in → Continue with Google. The chooser should now say *Excerptle*. `redirect_uri_mismatch` means the string in the console doesn't match this, character for character:

```js
location.origin + location.pathname.replace(/[^/]*$/, "") + "oauth.html"
```

Console edits can take a few minutes to propagate.

**8. Old client.** Once the new one works, delete the `1041895139600-…` client from the ProvableLearning project, or at least strip Excerptle's URIs out of it.

## Known gaps

**Google sign-in redirect URI — do this before promoting the site.** `js/auth.js` opens the account chooser itself (a centred popup running the OAuth implicit flow) and Google sends the token back to `/oauth.html`. In Google Cloud Console → Credentials → your OAuth client, add **`https://excerptle.io/oauth.html`** under *Authorized redirect URIs* — exact string, no trailing slash — plus a `http://localhost:PORT/oauth.html` entry for local testing. Keep `https://excerptle.io` under *Authorized JavaScript origins* and drop stale `workers.dev` entries. Until the redirect URI is registered, Google answers "Continue with Google" with `redirect_uri_mismatch`.

**Auth is a demo, not real auth.** With no API configured, `js/auth.js` stores users and sessions in `localStorage`, generates verification codes client-side, and trusts a Google access token read **entirely in the browser**. Anyone can forge a session from devtools. Fine for a static preview; it cannot back real accounts or trustworthy leaderboards. Both need the server before they mean anything.

**Leftover `CNAME` file.** The repo root has a `CNAME` containing `excerptle.io` — a GitHub Pages artifact. Cloudflare ignores it. Safe to delete.

## Checking sign-in locally

Two switches, both refusing to work anywhere but localhost (see `js/config.js`):

| URL | API | Good for |
| --- | --- | --- |
| `localhost:8765/?demo=1` | none | the whole flow with no backend; the sign-in code is printed on screen instead of mailed |
| `localhost:8765/?api=local` | real Worker on `:8787` | the frontend and the API actually talking to each other |
| `localhost:8765` | **deployed** API | what production does — and what a not-yet-deployed API does to it |

The choice sticks to the browser tab, not the address bar: `js/app.js` rewrites
the URL to drop the query string on some routes, so a page that read the flag
from `location.search` every time would fall back to the deployed API on the
next reload and start contradicting the Worker under test. A badge in the corner
names the backend in use. `?api=off` leaves dev mode; so does closing the tab.

The middle one is the one that matters before a release. `?demo=1` cannot catch
a frontend and an API that disagree, because there is no API to disagree with:
that is how a `/me/password` rewrite reached the browser while the deployed
Worker still expected the old request shape, and answered a derived key with a
complaint about password length.

```bash
cd backend
npx wrangler d1 migrations apply DB --local --config wrangler.toml   # once
npx wrangler dev --config wrangler.toml --port 8787
```

Copy `backend/.dev.vars.example` to `backend/.dev.vars` and email sign-in works
locally without a mail provider: the code comes back in the response and the
page prints it on screen. That path needs all three of no `RESEND_API_KEY`, the
`DEV_ECHO_CODES` opt-in, and a caller on localhost — production has a Resend
key, which on its own rules it out. `.dev.vars` is gitignored and `wrangler
deploy` does not upload it. A test asserts each gate.

To skip sign-in altogether, seed an account straight into the local D1 —
`--local` touches a file on this machine, never production:

```bash
npx wrangler d1 execute DB --local --config wrangler.toml --command \
  "INSERT INTO users(id,email,name,created_at) VALUES('dev1','dev@local.test','Dev',strftime('%s','now'))"
```

`http://localhost:8765` is already in `ALLOWED_ORIGINS`, so CORS works as-is.
