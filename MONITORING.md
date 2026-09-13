# Monitoring & telemetry — what is set up, and how

Last verified: 2026-09-12 (branch `adsense-content-pages`).

Excerptle runs on Cloudflare's free plan. The whole point of the setup below is
to notice a free-tier ceiling *before* it is hit, and to keep the site serving
even if every piece of the alerting path is broken. Nothing here is a paid
observability product; it is one Worker module plus a Slack webhook.

## The map

| Piece | Where | What it does |
| --- | --- | --- |
| Alerting module | `backend/src/alerts.js` (253 LOC) | Quota watch, daily digest, live events. All of it fails soft. |
| Cron entry point | `backend/src/worker.js` → `scheduled()` | Routes the two cron schedules; alerting is inside a `try` so it can never abort the nightly expiry sweep. |
| Schedules | `backend/wrangler.toml` `[triggers]` | `0 * * * *` hourly quota check + digest heartbeat · `7 12 * * *` nightly sweep + digest (**08:07 New York**, 07:07 in winter — Cloudflare crons are UTC and ignore DST) |
| Alert memory | D1 table `alert_state` (migration `0003_alerts.sql`) | One row per metric per UTC day, so an hourly check does not repeat itself. |
| Usage source | Cloudflare GraphQL Analytics API | `workersInvocationsAdaptive`, `d1AnalyticsAdaptiveGroups`, `d1StorageAdaptiveGroups` |
| Workers Logs | `wrangler.jsonc`, `tools/og-worker/wrangler.jsonc`, `backend/wrangler.toml` | `observability.enabled: true` on all three Workers. |
| External deadman | `.github/workflows/uptime.yml` | Probes `excerptle.io`, the sitemap and the API's `/health` at :13 and :43 from GitHub Actions — outside Cloudflare — and posts to Slack when any of them stops answering. |
| CI | `.github/workflows/gameplay.yml` | Unit + backend + data + Playwright e2e on every push/PR; traces uploaded on failure. |
| Ads | AdSense tag `ca-pub-2005015845685746` on 6 HTML pages | Revenue reporting lives in the AdSense console, not here. |

## What reaches Slack

| When | What | Loud or quiet |
| --- | --- | --- |
| Hourly | Free-tier quota check | **Silent unless** a metric crosses a 50 / 75 / 90 / 100 % band it has not already crossed today |
| 12:07 UTC (08:07 New York) | Daily digest — players, solves, accounts, Pro, plus yesterday's platform usage vs. the free limits | Always |
| Live, from the request path | New account signs up; Pro subscription starts / cancels / is set to cancel | Always |
| On cron failure | `:x: Excerptle cron <expr> failed: …` | Always |
| Hourly, if the digest is >26 h stale | `:warning: … daily digest has not run for Nh` — `heartbeatCheck()` in `alerts.js`, once per UTC day | Only when stale |
| Every 30 min, if the site or API stops answering | `🚨 Excerptle is not answering`, sent from GitHub Actions | Only when down |

Live events go through `ctx.waitUntil`, so Slack latency is never added to
somebody's sign-in.

## Limits being watched

Cloudflare free plan, defined in `LIMITS` at the top of `backend/src/alerts.js`.
Edit there if a plan changes.

| Metric | Free limit | Note |
| --- | --- | --- |
| Workers requests | 100,000 / day | **Account-wide** — `excerptle`, `excerptle-og`, `excerptle-api` share one bucket |
| D1 rows read | 5,000,000 / day | |
| D1 rows written | 100,000 / day | |
| D1 storage | 5 GB | |

Counters reset at 00:00 UTC, which is why every window is a UTC day rather than
a rolling 24 hours — and why `alert_state` keys are `quota:<metric>:<utc-day>`.

## Configuration

Secrets (all optional; each missing one degrades, never breaks):

```sh
npx wrangler secret put SLACK_WEBHOOK_URL --config backend/wrangler.toml  # no webhook = nothing sent
npx wrangler secret put CF_API_TOKEN      --config backend/wrangler.toml  # no token = digest without the platform section
npx wrangler secret put CF_ACCOUNT_ID     --config backend/wrangler.toml
```

The Cloudflare token needs exactly one permission: **Account · Account
Analytics · Read**. The D1 datasets live under Account Analytics; the separate
"D1" permission covers the REST API, which this never calls.

`ALERT_DASH_URL` is a plain var in `backend/wrangler.toml` (footer link on every
alert).

## How to exercise it without waiting for a cron

```sh
cd backend && npx wrangler dev --test-scheduled
curl 'http://localhost:8787/__scheduled?cron=7+12+*+*+*'   # daily digest
curl 'http://localhost:8787/__scheduled?cron=0+*+*+*+*'    # quota check
```

## Known gaps (as of this review)

1. **No client-side telemetry at all.** The only third-party script on the site is
   AdSense. There is no analytics, no error reporting, no Core Web Vitals beacon —
   so a JS exception in a player's browser is invisible. This may be a deliberate
   privacy choice; it is not written down as one anywhere.
2. **No Sentry / Logpush / tail consumer.** Workers Logs is the only retention,
   and no Worker writes `console.log` at all (verified: zero occurrences).
3. **Slack webhook health is unverified.** A revoked webhook fails soft and
   silently. The 08:07 digest arriving is the proof the pipe still works — which
   is exactly why its absence is now alerted on, but a *dead webhook* silences
   that alert too. Re-test with `--test-scheduled` if a week passes quietly.
4. **The uptime workflow needs `SLACK_WEBHOOK_URL` as a repo secret.** Without it
   the run still goes red on GitHub, but nothing reaches Slack.
   Settings → Secrets and variables → Actions → New repository secret.
5. **GitHub's scheduled runs are best-effort** and can be delayed by minutes
   under load, and are disabled on repos with no activity for 60 days.

## Where the reminders land

Slack is the central reminder system. Everything above funnels there — no
second inbox, no dashboard to remember to open:

- **08:07 New York, daily** — the digest. This is the status update: players,
  solves, accounts, Pro, and yesterday's free-tier usage as a percentage.
- **The moment something breaks** — cron failure, a quota band crossed, the site
  not answering from outside Cloudflare, or the digest itself going quiet.

"Silence means healthy" is the design, and the two watchdogs above are what make
silence trustworthy: the hourly heartbeat catches a digest that stopped, and the
GitHub Actions probe catches a Cloudflare outage that would otherwise take the
alerting down with the site.
