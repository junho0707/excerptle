# Share previews

**Two Workers, deliberately.**

| Script | Config | Contents |
| --- | --- | --- |
| `excerptle` (front door) | root `wrangler.jsonc` → `worker.js` | ~5 KB: static assets plus the OG meta-tag rewrite |
| `excerptle-og` (renderer) | `tools/og-worker/wrangler.jsonc` → `render-worker.js` | ~3.5 MB: resvg WASM, two TTFs, the card SVG |

They were one script until the weight showed up in the wrong place.
`run_worker_first` puts the front door in front of `/`, so Cloudflare loads
that script into an isolate before the first page load in any cold colo can be
answered — and it was loading 3.5 MB of WASM and fonts to serve HTML that
needed none of it. Only crawlers ever fetch `/og.png`, so the renderer now
sits behind the `OG` service binding in its own isolate, woken only when
something actually asks for a card.

**Keep the front door light.** No WASM, no fonts, no `nodejs_compat`. Check it
with `wrangler deploy --dry-run` — "Total Upload" belongs in the single-digit
KB. Anything that needs weight goes in the renderer.

The renderer has no `ASSETS` binding (a service-bound Worker cannot reach the
front door's bindings), so it fetches puzzle text and the brand icon over HTTP
from `SITE_URL`. Those paths are not `run_worker_first`, so the subrequest goes
straight to the static asset server.

The front door runs first for `/`, `/index.html`, and `/og.png`. Other assets
keep their normal static routing. Valid share links get personalized OG and
Twitter metadata and a 1200×630 PNG rendered by resvg WASM. Ordinary pages
keep the brand card. Share HTML is noindex and not cached; images are cached
by their full URL for one day. Bump the card query version when changing designs.

## Local preview and checks

From the repository root:

```sh
npm ci --prefix tools/og-worker
npm run preview --prefix tools/og-worker
npm test --prefix tools/og-worker
node backend/node_modules/wrangler/bin/wrangler.js dev --port 8791 --local --persist-to /tmp/excerptle-og-state
# In another terminal:
SHARE_TEST_URL=http://localhost:8791 npm test --prefix tools/og-worker
node backend/node_modules/wrangler/bin/wrangler.js deploy --dry-run
```

Open `dist/share-previews/index.html` for all five designs and their metadata.
These previews use the same renderer as production. The fonts and their
redistribution license are bundled in `fonts/`.
If the installed local runtime rejects the production compatibility date,
upgrade Wrangler or use its supported date with `--compatibility-date` for
local checks only. The production configuration keeps its original date.

Deploy from the root after visual review — **renderer first**, because the
front door's `OG` service binding will not resolve until that script exists:

```sh
node backend/node_modules/wrangler/bin/wrangler.js deploy --config tools/og-worker/wrangler.jsonc
node backend/node_modules/wrangler/bin/wrangler.js deploy
```

Locally, `wrangler dev` shows the binding as `[not connected]` until a second
`wrangler dev --config tools/og-worker/wrangler.jsonc` is running alongside it;
`/og.png` is the only path that needs it.

Then verify live page metadata, image dimensions, ordinary pages, and a real
messaging-app unfurl. Messaging apps may retain previously fetched previews.
Complete Google Search Console ownership verification after deployment using
the account's actual verification token, then submit `/sitemap.xml`.

## Link format

Puzzle links use `?p=<zero-based index>&s=<base64url JSON>`.
Version 2 adds `c` (1 completed, 0 unfinished). Both wins and losses are
completed. Version 1 links remain readable as completed results.

Other fields: `n` display name (24 characters), `m` daily/preset/battle,
`w` won, `g` guesses, `h` hints, `t` seconds,
`br/bn` hint-bracket rank/field, `or/on` overall rank/field.
These are self-reported sharing details, not verified leaderboard records.
No book title or excerpt is included.

Unfinished daily and question-bank links invite the recipient to play.
Completed links show the result. Battle invitations use the existing
`?b=<room>&p=<index>` format with optional `n=<host name>`; old invitations
without a name still work. An invitation is not a live room-status check.
