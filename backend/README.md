# Excerptle Pro API

Worker + D1; Stripe-hosted Checkout and Portal. Only verified Stripe webhooks write subscription entitlement. No card data is collected by Excerptle. Frontend changes do not enable billing until the API URL is configured and the frontend is deployed.

## Local testing

From `backend/`:

```sh
npm ci
npm test
npm run db:local
npm run dev
```

Use Node 22+ if the installed Wrangler release requires it. Tests use a real local D1 instance and mocked Google/Stripe HTTP responses, including signed webhook payloads. They do not charge a card or contact live billing services.

For manual testing, set the frontend API to `http://localhost:8787` in a local checkout. Serve the frontend at localhost:8765. Put local secrets in ignored `backend/.dev.vars`; never paste them into chat. Test secrets must never be included in a static upload.

## Provisioning (after owner authenticates)

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create excerptle
```

The database is now provisioned as `e8cf45cb-62dc-433a-8f7b-b382369cc108`, and the API is deployed at `https://excerptle-api.winter-glade-cbab.workers.dev`. For a new environment, replace `database_id` with its returned ID, then:

```sh
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put OTP_SECRET
npx wrangler secret put RESEND_API_KEY
npm run deploy
```

Enter secrets directly at the terminal prompts. `OTP_SECRET` should be a random 32-byte-or-longer secret. API keys/webhook signing secrets live in Worker secrets, never source or frontend configuration. Do not copy any existing Stripe key from another project into the frontend.

The API is a separate Worker, `excerptle-api`; deployment does not replace the existing `excerptle` static site. Use the actual URL printed by Wrangler for `EXCERPTLE_API` in `js/config.js`; do not guess the account subdomain. Keep `BOOKLE_API` as its alias. Deploy the frontend through its verified existing deployment workflow. `.assetsignore` excludes backend/source/private files from Wrangler asset uploads; dashboard uploads must also exclude them explicitly.

## Stripe Dashboard

Start in a Stripe sandbox/test environment. The owner can run `node backend/tools/setup-stripe.mjs` from the repo root, enter a sandbox secret key at the hidden prompt, and the script creates the $3/month product/price, Portal configuration and webhook, storing credentials directly in Cloudflare. Then run `node backend/tools/add-yearly-plan.mjs` with the same sandbox key to add the $20/year price. No keys are saved to disk or printed. Both scripts refuse live keys.

For manual setup, create Excerptle Pro with USD 3.00 recurring monthly and USD 20.00 recurring yearly prices. Store their IDs as `STRIPE_PRICE_ID` and `STRIPE_YEARLY_PRICE_ID` using `wrangler secret put` (the IDs themselves are public). `STRIPE_LIVE=false` for test mode. Configure Billing Portal with payment-method updates and cancellation at period end; do not enable price/quantity changes. Store that configuration ID as `STRIPE_PORTAL_CONFIGURATION`.

Create webhook endpoint `https://ACTUAL-WORKER-URL/billing/webhook`, using API version `2025-08-27.basil`, listening to `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Store that endpoint's signing secret using Wrangler. The Stripe key, price and webhook must all belong to the same account and mode.

For a local test webhook, use `stripe listen --forward-to localhost:8787/billing/webhook`; its signing secret differs from the Dashboard endpoint secret.

Live rollout: use a separate live Worker/D1 from the sandbox deployment (change Worker/database names and IDs), set `STRIPE_LIVE=true`, create the live $3 price and live webhook, enter live secrets, and update the frontend API URL only after validation. Do not mix test and live customer IDs in one database. Owner must activate the Stripe business account before taking live payments.

## Accounts and email

Google's existing popup supplies an access token to `/auth/google`; the backend validates its client audience/expiry and verified identity with Google before issuing an Excerptle session. Keep the Google client ID in Worker vars matched to the frontend. Existing authorized origins and `/oauth.html` redirect URIs still apply.

Email codes use Resend. Verify a sending domain in Resend and set `MAIL_FROM` to an approved sender. Store its API key in Worker secrets. Without email configuration, Google remains available and email sign-in returns a helpful error. A player must verify their email or Google identity before they can set an optional password; passwords use PBKDF2 hashes with a per-account random salt. Existing local browser-local password hashes are deliberately not migrated. Existing local game progress is merged after sign-in.

Sessions are 256-bit opaque bearer tokens, expire after 30 days, are hashed in D1 and revoked on logout. Email codes expire after 10 minutes, allow at most five guesses, are single-use and are stored as salted/secret-bound hashes. Database counters throttle auth and billing. Daily cleanup removes expired rows. LocalStorage session storage means frontend script security is part of the trust boundary; do not add untrusted scripts.

## Verification before launch

1. Check `/health`, CORS allow/deny and signed-out billing 401 responses.
2. Sign in with Google and email codes. Verify wrong, expired and reused codes fail. Sign out and verify the old bearer fails.
3. Buy in Stripe test mode using a test card. Before the webhook, status must remain free. After the webhook, status must be Pro and ads must disappear.
4. Retry Checkout repeatedly and from another tab: reuse the open session and prevent a second subscription.
5. Cancel in Portal: Pro remains until the paid period ends. Test failed payments and final cancellation. Re-deliver old/duplicate webhook events and verify no stale Pro resurrection.
6. Switch users/sign out/reload: subscription state must stay bound to the right user. Test webhook-delivery delay and recovery; refresh/focus rechecks status.
7. Verify live configuration with the owner before taking a real payment. A real payment/refund requires explicit owner approval and is not part of automated tests.

Stripe's Dashboard delivery log is the operational source for webhook retries. Failures return non-2xx for retries; subscription writes and event deduplication commit in one D1 batch. Webhooks fetch current Stripe subscription state, reject wrong live/test mode, and ignore unrelated customers. Entitlements expire at period end even if a cancellation webhook is delayed. Expired/inactive subscribers can use the Portal; there are no paid gameplay features.

Routes: `POST /auth/google`, `/auth/email`, `/auth/verify`, `/auth/logout`, `/me/password`; `GET /scores`, `/me/progress`, `/billing/status`; `POST /scores`, `/me/progress`, `/billing/checkout`, `/billing/portal`, `/billing/webhook`.

Official references: [Checkout](https://docs.stripe.com/api/checkout/sessions/create), [webhook verification](https://docs.stripe.com/webhooks/signature), [D1](https://developers.cloudflare.com/d1/worker-api/).

## Slack alerting

`src/alerts.js` posts to a Slack Incoming Webhook. Three things reach it:

| When | What |
| --- | --- |
| Hourly cron | Free-tier quota check — **silent** unless a metric crosses 50 / 75 / 90 / 100 % of its daily allowance |
| 12:07 UTC cron | Daily digest: players, solves, accounts, Pro, plus yesterday's platform usage against the free limits |
| Live | A new account signs up; a Pro subscription starts, cancels, or is set to cancel |

Everything is optional and fails soft. With no `SLACK_WEBHOOK_URL` nothing is
sent and nothing breaks; with no `CF_API_TOKEN` the digest still goes out with
the product numbers and skips the platform section. The nightly expiry sweep
runs before any alerting and is never blocked by it.

### Setup

1. **Slack** — create an app at <https://api.slack.com/apps> → *Incoming
   Webhooks* → *Add New Webhook to Workspace*, pick the channel, copy the
   `https://hooks.slack.com/services/...` URL.

2. **Cloudflare token** (only for quota numbers) — dash.cloudflare.com →
   *My Profile* → *API Tokens* → *Create Token* → *Custom token*:

   | Permission | Scope |
   | --- | --- |
   | Account · Account Analytics · Read | your account |

   That single permission is enough. Everything here goes through the GraphQL
   analytics endpoint, and the D1 datasets (`d1AnalyticsAdaptiveGroups`,
   `d1StorageAdaptiveGroups`) live under Account Analytics — the separate "D1"
   permission covers the D1 REST API, which this never calls.

   The account ID is the hex string in the dashboard URL, or in the sidebar of
   Workers & Pages.

3. **Store them** (from `backend/`, or add `--config backend/wrangler.toml`):

   ```sh
   npx wrangler secret put SLACK_WEBHOOK_URL
   npx wrangler secret put CF_API_TOKEN
   npx wrangler secret put CF_ACCOUNT_ID
   ```

   `ALERT_DASH_URL` is a plain var in `wrangler.toml` — set it to the account's
   real dashboard URL so alerts link somewhere useful.

4. **Migrate and deploy** — the quota check needs the `alert_state` table:

   ```sh
   npx wrangler d1 migrations apply excerptle --remote
   npx wrangler deploy
   ```

5. **Check it** — force a run without waiting for the cron:

   ```sh
   npx wrangler dev --test-scheduled
   curl 'http://localhost:8787/__scheduled?cron=7+12+*+*+*'   # digest
   curl 'http://localhost:8787/__scheduled?cron=0+*+*+*+*'    # quota check
   ```

### Limits being watched

Cloudflare's free plan, as of the last check. They live in `LIMITS` at the top
of `src/alerts.js` — edit there if a plan changes.

| Metric | Free limit | Notes |
| --- | --- | --- |
| Workers requests | 100,000 / day | **Account-wide.** `excerptle`, `excerptle-og` and `excerptle-api` share one bucket |
| D1 rows read | 5,000,000 / day | |
| D1 rows written | 100,000 / day | |
| D1 storage | 5 GB | |

Static asset requests are not billed as Worker requests, which is the other
reason the front-door Worker was put on a diet — see `tools/og-worker/README.md`.

Counters reset at 00:00 UTC and so does the alert memory: `alert_state` is
keyed by metric + UTC day, so an hourly check that keeps seeing 78 % stays
quiet after the first message, and a genuine climb to 90 % still speaks up.

### Watchdogs

Two things guard the "silence means healthy" design:

- `heartbeatCheck()` runs on the hourly cron and posts once a day if the digest
  has not stamped `alert_state['digest:last']` in over 26 hours — a daily
  message that stops arriving is otherwise indistinguishable from a quiet day.
- `.github/workflows/uptime.yml` probes the site and `/health` from GitHub
  Actions twice an hour. It lives outside Cloudflare on purpose: every other
  alert here is sent *by* the thing being watched. It needs a repo secret named
  `SLACK_WEBHOOK_URL`.

Full picture: `MONITORING.md` at the repo root.
