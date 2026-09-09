# Monetization — Excerptle

Three lines: **Ko-fi tips**, **Pro (ad-free)**, **ad revenue**. This file is the ad half.

Last updated: 2026-09-08.

---

## The honest timeline

You cannot have AdSense ads on literal day 1. Approval is a human/automated review that takes
**~3–14 days** (sometimes longer for a first-time publisher). Nothing buys past that.

What you *can* do on day 1:

| Day 1 | Later |
| --- | --- |
| Ko-fi Support tab (live now, no approval) | AdSense ads, once approved |
| Pro toggle + ad-free flag in the code | Pro purchases (needs the backend) |
| Empty ad container + `ADS_ENABLED = false` | Flip one flag when the pub ID arrives |
| Submit the AdSense application | |

So the real goal is: **ship everything except the ad script now**, so that turning ads on is a
one-line config change the day Google says yes.

---

## What AdSense requires before it will approve you

1. **Own domain, live site.** ✅ `excerptle.io` on Cloudflare.
2. **Real, original content.** ⚠️ This is your actual risk. 824 books of Project Gutenberg text is
   *public domain*, but AdSense reviewers reject "scraped / low value content", and a dump of
   someone else's text looks exactly like that to them. Mitigations:
   - Keep excerpts behind gameplay (they already are — the SPA renders them, they aren't crawlable
     as 824 standalone text pages). Verify `sitemap.xml` doesn't expose one URL per book text.
   - Beef up the **original** pages: How to play, News, Support, Privacy & terms, an About page
     explaining how puzzles are chosen. Reviewers read those.
   - The game itself (guessing, hints, battle, stats) is original interactive content — that's the
     case you're making.
3. **Privacy policy** that names advertising cookies. ✅ page exists; the "Ads." paragraph needs
   rewriting to name Google once you're in (see below).
4. **`ads.txt`** at the site root, with your publisher ID. Not needed to apply — needed to actually
   earn (unfilled/underpriced inventory without it).
5. **A Google-certified CMP** (consent banner) for EEA/UK/Swiss traffic. Required since 2024. Use
   Google's own **Privacy & messaging** ("Funding Choices") inside AdSense — free, certified,
   auto-serves only to EEA users. Also switch on the **US states** message for CCPA.
6. **Tax + payment identity.** Provable Learning LLC needs an EIN (or your SSN for a
   single-member LLC), a W-9 in AdSense, and a bank account. Payout mechanics:
   - Address **PIN letter** mailed at $10 lifetime earnings (arrives 2–4 weeks; account holds
     payments until entered).
   - **Payment threshold $100.** Below that it rolls over month to month.
7. **18+, one AdSense account per person.** Use one Google account and keep it.

### Applying

1. adsense.google.com → sign up with the business Google account, site `excerptle.io`.
2. It gives you a `<script async src="...adsbygoogle.js?client=ca-pub-XXXX">` snippet — paste it
   into `<head>` of `index.html` and deploy. That is the ownership + review trigger.
3. Wait. Check the AdSense home page for "Getting ready…" → "Ready".
4. On approval: create an ad unit (Display, responsive), get `data-ad-slot`, drop it in
   `js/config.js`, flip `enabled: true`, enable the GDPR + US-states messages.

### The IDs, and which is which

| Value | Where it goes | Ours |
| --- | --- | --- |
| Publisher ID, `ca-pub-…` | `<meta>` + loader `?client=` in `index.html`, `client` in `js/config.js` | `ca-pub-2005015845685746` |
| Same ID as `pub-…` | `ads.txt` — **no `ca-` prefix**, a common way to get zero fill | `pub-2005015845685746` |
| Ad slot, `data-ad-slot` | `slot` in `js/config.js` | *doesn't exist yet — created with the ad unit after approval* |
| Customer ID | Nowhere in the code. It identifies the AdSense account for support/billing. | `7855100651` |

Customer ID and ad slot are both ~10 digits, which is exactly why they get swapped. If the
customer ID ends up in `slot`, the unit requests an ad that doesn't exist and silently never fills.

### "Requires review / Not found"

That's the Sites table saying the crawler could not find the snippet — the review has **not**
started. It's a deploy problem, not a waiting problem: the tag has to be live on `excerptle.io`
before the status moves on.

---

## Where the ads go

One slot, on the **post-game screen**, after the answer is revealed. Reasons:

- The player has finished; an ad there costs no gameplay.
- AdSense policy bans placements that cause accidental clicks — an ad near the guess input or the
  hint button is the classic way to get banned. Don't.
- Auto ads (letting Google inject anywhere) will wreck a game UI and can drop ads next to the
  keyboard. **Turn Auto ads off; use manual units only.**

Optional second slot later: a leaderboard/all-books list ad (long scrolling page, low risk).

### SPA caveat

Excerptle is one page with hash routing, so there is no page load per game. AdSense expects an ad
request per genuine content view. The safe pattern: on each post-game render, **remove the old
`<ins class="adsbygoogle">` node, insert a fresh one, then `(adsbygoogle = window.adsbygoogle || []).push({})`.**
Never push twice against the same `<ins>` (throws), and never refresh on a timer (policy violation).

---

## Pro (ad-free)

Ad suppression is trivial (`if (isPro) skip ad render`). The hard part is **entitlement**, and that
needs the backend already scoped in `PROGRESS.md` — the browser cannot be trusted to say "I paid".

Two routes:

- **Stripe** (recommended long term): Payment Link or Checkout → webhook → `users.pro = true` →
  `/me` returns `pro: true` → frontend hides ads. Clean, subscriptions, refunds, real receipts.
- **Ko-fi** (day-1-able, scrappy): Ko-fi Shop item or Membership tier → Ko-fi webhook to your
  backend, or, before the backend exists, mail buyers a code by hand and store a redeemed flag
  locally. Fine for the first dozen supporters, not fine at scale.

Pricing that works for a daily puzzle game: **$2–3/mo or ~$15–20 lifetime**. At Excerptle's likely
ad RPM, one Pro sale is worth hundreds of ad impressions, so don't underprice it.

---

## What ads are actually worth here

Display RPM for a word/puzzle game runs roughly **$1–6 per 1,000 pageviews**, US/UK-heavy traffic at
the top of that. One slot, one impression per completed game:

| Daily players | Monthly games | Rough monthly ad revenue |
| --- | --- | --- |
| 100 | ~3,000 | $3–18 |
| 1,000 | ~30,000 | $30–180 |
| 10,000 | ~300,000 | $300–1,800 |

Which is the real argument for shipping Ko-fi and Pro first: at small scale, tips and Pro will beat
ads by a wide margin. Ads only start mattering in the tens of thousands of daily players.

**Higher-paying networks, when you qualify:** Journey by Mediavine (~10k sessions/mo),
Mediavine (~50k), Raptive (~100k pageviews/mo). These do 2–4× AdSense RPM. Ezoic takes small sites
today but the ad density hurts a game UI. Instant-approval networks (Adsterra, Monetag,
PropellerAds) will take you on day 1 — they pay in popunders and malvertising, and they will cost
you AdSense eligibility later. Don't.

---

## Checklist

Shipped in the frontend:

- [x] Support page (`#/support`) &rarr; Ko-fi button, plus a **Support** tab in the main nav
- [x] Pro badge beside the account name &rarr; Pro modal (`#/pro` is linkable; Stripe returns to it)
- [x] `js/pro.js` — `/billing/status`, Checkout and Billing Portal hand-offs, 24h entitlement cache
- [x] `js/ads.js` — one post-game slot, fresh `<ins>` per finished game, skipped for Pro
- [x] Privacy page names Google AdSense, Stripe and Ko-fi
- [x] `js/config.js` — `EXCERPTLE_ADS` / `EXCERPTLE_PRO` are the only things to edit

Still yours to do:

- [ ] AdSense approval, then paste the **display unit's slot ID** into `EXCERPTLE_ADS.slot` and set
      `enabled: true` (the pub ID and `/ads.txt` are already in place)
- [ ] On approval, **delete the `adsbygoogle.js` `<script>` from `<head>`**. It is there so the
      reviewer's crawler finds the tag, but it loads Google's ad library on every page view for
      every visitor &mdash; Pro subscribers included, and today for no revenue at all. `js/ads.js`
      already injects the same loader on demand, only for a non-Pro player who has actually
      finished a game, which is the placement that should survive. Leave the
      `google-adsense-account` meta tag; that one is inert.
- [ ] Auto ads **off** in the AdSense console; GDPR + US-states messages **on**
- [ ] EIN &rarr; W-9 in AdSense; PIN letter at $10
- [ ] Stripe: product + $3/mo price, Checkout, Billing Portal, and the
      `customer.subscription.*` / `invoice.*` webhooks that flip `pro`
- [ ] Backend must return `session.token` from the auth routes — `js/pro.js` has nothing to
      authenticate with until it does (see PROGRESS.md)
- [ ] An About / How-it-works page with original copy, for the AdSense reviewer
