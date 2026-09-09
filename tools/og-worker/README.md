# Share unfurls

`excerptle.io` is static (GitHub Pages), so every URL returns the same
`index.html`. A crawler unfurling a share link therefore reads the *site's*
`<meta>` tags, not the sharer's result — every preview looks identical, and
nothing can change that from the browser: crawlers don't run our JS.

This Worker fixes that. It proxies the origin unchanged, and when a request
carries `?p=<index>&s=<payload>` it rewrites the OG/Twitter tags from the
payload before the HTML goes out.

## Deploy

```bash
cd tools/og-worker
npx wrangler deploy
```

Then point `excerptle.io/*` at the Worker (uncomment `[[routes]]` in
`wrangler.toml`) and set `ORIGIN` to wherever Pages actually serves from.
Removing the Worker breaks nothing — the game is a pass-through.

Check a preview with any unfurl debugger, or:

```bash
curl -s 'https://excerptle.io/?p=42&s=<payload>' | grep 'og:'
```

## The payload

`js/app.js` `sharePayload()` writes it; `share.js` `readShare()` reads it.
Base64url'd JSON, `v:1`:

| key | meaning | key | meaning |
|---|---|---|---|
| `n` | display name (≤24) | `t` | seconds |
| `m` | `daily` / `preset` / `battle` | `br`/`bn` | rank / field at that hint count |
| `w` | 1 solved, 0 not | `or`/`on` | rank / field overall |
| `g` | guesses used | | |
| `h` | hints used | | |

**The book is never in the payload.** A share must not spoil the puzzle for
whoever opens it — keep it that way.

## Image

`og:image` is still the static `/assets/og.png`; only title and description
are per-share, which is what most clients show largest. To render a real
card, add a `/og` route that draws the same layout as `.share-card` in
`css/app.css` (satori + resvg-wasm is the usual pairing in Workers) and set
`OG_IMAGE` to it. `unfurl()` already has every value the card needs.
