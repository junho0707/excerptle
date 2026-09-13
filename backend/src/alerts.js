/* Slack alerting: free-tier quota watch, system health, and product numbers.

   Everything here is optional and fails soft. Excerptle must keep serving if
   Slack is down, the Cloudflare API token is missing, or the analytics schema
   moves under us — an alerting path that can take the site down is worse than
   no alerting at all. Every entry point swallows its own errors.

   Secrets (all optional, `wrangler secret put --config backend/wrangler.toml`):
     SLACK_WEBHOOK_URL  Slack Incoming Webhook. Nothing is sent without it.
     CF_API_TOKEN       Cloudflare token, "Account Analytics: Read" +
                        "D1: Read". Only the quota section needs it.
     CF_ACCOUNT_ID      Account tag the token belongs to.
   Vars: ALERT_DASH_URL (optional link put in the message footer). */

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

/* Cloudflare's free plan, as documented at
   developers.cloudflare.com/workers/platform/limits and .../d1/platform/limits.
   Daily counters reset at 00:00 UTC, which is why every window below is a UTC
   day rather than a rolling 24 hours. Update here if a plan changes. */
const LIMITS = {
  workerRequests: { limit: 100_000, label: 'Workers requests', unit: 'req' },
  d1RowsRead: { limit: 5_000_000, label: 'D1 rows read', unit: 'rows' },
  d1RowsWritten: { limit: 100_000, label: 'D1 rows written', unit: 'rows' },
  d1StorageBytes: { limit: 5 * 1024 ** 3, label: 'D1 storage', unit: 'bytes' },
};

/* Bands, not a single threshold: crossing 50% is worth knowing about once,
   and crossing 100% is worth knowing about the moment it happens. The band a
   metric last fired at is remembered per UTC day, so an hourly check that
   keeps seeing 78% stays quiet after the first message. */
const BANDS = [
  { at: 1.0, level: 'critical', emoji: ':rotating_light:' },
  { at: 0.9, level: 'critical', emoji: ':rotating_light:' },
  { at: 0.75, level: 'warn', emoji: ':warning:' },
  { at: 0.5, level: 'notice', emoji: ':eyes:' },
];

const utcDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);
const pct = (used, limit) => (limit > 0 ? used / limit : 0);
const num = (n) => Math.round(n).toLocaleString('en-US');
const bytes = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;
const fmt = (n, unit) => (unit === 'bytes' ? bytes(n) : `${num(n)} ${unit}`);
const bandFor = (ratio) => BANDS.find((b) => ratio >= b.at) || null;

export async function slack(env, { text, blocks }) {
  if (!env.SLACK_WEBHOOK_URL) return false;
  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(blocks ? { text, blocks } : { text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* Fire-and-forget from a request path. Slack latency must never be added to
   somebody's sign-in, so this goes through waitUntil when there is a ctx. */
export function notify(env, ctx, message) {
  const sent = slack(env, message).catch(() => false);
  ctx?.waitUntil?.(sent);
  return sent;
}

async function graphql(env, query, variables) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await res.json();
  if (!res.ok || payload.errors?.length) {
    throw new Error(payload.errors?.[0]?.message || `analytics HTTP ${res.status}`);
  }
  return payload.data?.viewer?.accounts?.[0] || {};
}

const USAGE_QUERY = `query($account: String!, $date: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 100, filter: { date: $date }) {
      sum { requests errors subrequests }
      dimensions { scriptName }
    }
    d1AnalyticsAdaptiveGroups(limit: 100, filter: { date: $date }) {
      sum { rowsRead rowsWritten }
      dimensions { databaseId }
    }
    d1StorageAdaptiveGroups(limit: 100, filter: { date: $date }) {
      max { databaseSizeBytes }
      dimensions { databaseId }
    }
  } }
}`;

/* Today's account-wide usage, as { metric: number } plus per-script detail.
   Requests are summed across every Worker on the account because that is how
   the free plan's 100k/day is counted — the site Worker, the OG renderer and
   this API all draw on the same bucket. */
export async function usage(env, date = utcDay()) {
  const data = await graphql(env, USAGE_QUERY, { account: env.CF_ACCOUNT_ID, date });
  const invocations = data.workersInvocationsAdaptive || [];
  const d1 = data.d1AnalyticsAdaptiveGroups || [];
  const storage = data.d1StorageAdaptiveGroups || [];
  const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) || 0), 0);
  return {
    date,
    workerRequests: sum(invocations, (r) => r.sum?.requests),
    workerErrors: sum(invocations, (r) => r.sum?.errors),
    workerSubrequests: sum(invocations, (r) => r.sum?.subrequests),
    d1RowsRead: sum(d1, (r) => r.sum?.rowsRead),
    d1RowsWritten: sum(d1, (r) => r.sum?.rowsWritten),
    d1StorageBytes: Math.max(0, ...storage.map((r) => r.max?.databaseSizeBytes || 0)),
    scripts: invocations
      .map((r) => ({
        name: r.dimensions?.scriptName || 'unknown',
        requests: r.sum?.requests || 0,
        errors: r.sum?.errors || 0,
      }))
      .sort((a, b) => b.requests - a.requests),
  };
}

/* Alert state lives in D1 so it survives isolate churn and stays consistent
   across colos — two concurrent cron runs would otherwise both alert. */
async function readState(env, key) {
  const row = await env.DB.prepare('SELECT value FROM alert_state WHERE key=?').bind(key).first();
  return row?.value ?? null;
}
async function writeState(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO alert_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  ).bind(key, value, Math.floor(Date.now() / 1000)).run();
}

function quotaBlocks(breaches, u, dashUrl) {
  const worst = breaches[0];
  const lines = breaches.map(({ metric, ratio, used }) => {
    const { limit, label, unit } = LIMITS[metric];
    return `${bandFor(ratio).emoji} *${label}* — ${fmt(used, unit)} of ${fmt(limit, unit)}  (*${Math.round(ratio * 100)}%*)`;
  });
  const context = [
    `UTC day ${u.date}`,
    `${num(u.workerRequests)} requests`,
    `${num(u.workerErrors)} errors`,
    `${num(u.workerSubrequests)} subrequests`,
    `D1 ${bytes(u.d1StorageBytes)}`,
  ].join('  ·  ');
  return {
    text: `${worst.level === 'critical' ? 'Cloudflare free tier at risk' : 'Cloudflare free tier'}: ${LIMITS[worst.metric].label} at ${Math.round(worst.ratio * 100)}%`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: worst.level === 'critical' ? '🚨 Cloudflare free tier at risk' : '⚠️ Cloudflare free tier' } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
      ...(dashUrl ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `<${dashUrl}|Cloudflare dashboard>` }] }] : []),
    ],
  };
}

/* Hourly. Reads today's usage, and posts only for metrics that have climbed
   into a band they were not already in today. Silence means healthy. */
export async function quotaCheck(env) {
  if (!env.SLACK_WEBHOOK_URL || !env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { skipped: true };
  const u = await usage(env);
  const breaches = [];
  for (const metric of Object.keys(LIMITS)) {
    const ratio = pct(u[metric], LIMITS[metric].limit);
    const band = bandFor(ratio);
    if (!band) continue;
    // Keyed by UTC day: the counters reset at midnight and so does the memory.
    const key = `quota:${metric}:${u.date}`;
    if (Number(await readState(env, key) || 0) >= band.at) continue;
    await writeState(env, key, String(band.at));
    breaches.push({ metric, ratio, used: u[metric], level: band.level });
  }
  if (!breaches.length) return { usage: u, alerted: [] };
  breaches.sort((a, b) => b.ratio - a.ratio);
  await slack(env, quotaBlocks(breaches, u, env.ALERT_DASH_URL));
  return { usage: u, alerted: breaches.map((b) => b.metric) };
}

const DAY = 86400;
const DIGEST_KEY = 'digest:last';
/* 26h, not 24: a digest that runs a little late must not read as a failure. */
const STALE_AFTER = 26 * 3600;

/* Daily. The product picture — who showed up, who paid — plus yesterday's
   platform usage as a percentage of what the free plan allows. */
export async function dailyDigest(env) {
  if (!env.SLACK_WEBHOOK_URL) return { skipped: true };
  const since = Math.floor(Date.now() / 1000) - DAY;
  const [users, newUsers, solves, subs, newSubs, cancelling, active] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) n FROM users'),
    env.DB.prepare('SELECT COUNT(*) n FROM users WHERE created_at>=?').bind(since),
    // scores.won_at is seconds (server clock); progress.updated_at is the
    // client's milliseconds. Same window, different units.
    env.DB.prepare('SELECT COUNT(*) n, COUNT(DISTINCT user_id) players, AVG(guesses) g, AVG(hints) h FROM scores WHERE won_at>=?').bind(since),
    env.DB.prepare("SELECT COUNT(*) n FROM subscriptions WHERE status IN ('active','trialing')"),
    env.DB.prepare("SELECT COUNT(*) n FROM subscriptions WHERE status IN ('active','trialing') AND event_created>=?").bind(since),
    env.DB.prepare('SELECT COUNT(*) n FROM subscriptions WHERE cancel_at_end=1'),
    env.DB.prepare('SELECT COUNT(DISTINCT user_id) n FROM progress WHERE updated_at>=?').bind(since * 1000),
  ]);
  const first = (r) => r.results?.[0] || {};
  const s = first(solves);

  const product = [
    `*Players (24h)* ${num(first(active).n || 0)} signed in · ${num(s.players || 0)} solved a puzzle`,
    `*Solves (24h)* ${num(s.n || 0)}${s.n ? ` · avg ${Number(s.g).toFixed(1)} guesses, ${Number(s.h).toFixed(1)} hints` : ''}`,
    `*Accounts* ${num(first(users).n || 0)} total · +${num(first(newUsers).n || 0)} today`,
    `*Pro* ${num(first(subs).n || 0)} active · +${num(first(newSubs).n || 0)} today · ${num(first(cancelling).n || 0)} cancelling`,
  ].join('\n');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📚 Excerptle daily' } },
    { type: 'section', text: { type: 'mrkdwn', text: product } },
  ];

  // Platform section is best-effort: no token, or a bad one, still leaves a
  // useful product digest rather than no message at all.
  let platform = null;
  if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID) {
    try {
      platform = await usage(env, utcDay(-1));
    } catch (err) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:warning: Cloudflare analytics unavailable — ${String(err.message).slice(0, 140)}` }] });
    }
  }
  if (platform) {
    const rows = Object.entries(LIMITS).map(([metric, { limit, label, unit }]) => {
      const ratio = pct(platform[metric], limit);
      const mark = ratio >= 0.9 ? ':rotating_light:' : ratio >= 0.75 ? ':warning:' : ':white_check_mark:';
      return `${mark} *${label}* ${fmt(platform[metric], unit)} / ${fmt(limit, unit)} (${Math.round(ratio * 100)}%)`;
    });
    const errRate = platform.workerRequests ? (platform.workerErrors / platform.workerRequests) * 100 : 0;
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Cloudflare free tier — ${platform.date}*\n${rows.join('\n')}` } });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Errors ${num(platform.workerErrors)} (${errRate.toFixed(2)}%) · subrequests ${num(platform.workerSubrequests)} · ${platform.scripts.slice(0, 4).map((x) => `${x.name} ${num(x.requests)}`).join(' · ') || 'no Worker traffic'}` }] });
  }
  if (env.ALERT_DASH_URL) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${env.ALERT_DASH_URL}|Cloudflare dashboard>` }] });

  await slack(env, { text: `Excerptle daily — ${num(s.n || 0)} solves, ${num(first(subs).n || 0)} Pro`, blocks });
  // The digest is the heartbeat: this stamp is what heartbeatCheck watches.
  await writeState(env, DIGEST_KEY, String(Math.floor(Date.now() / 1000)));
  return { platform };
}

/* Hourly. "Silence means healthy" only works if somebody notices the silence,
   and nobody notices a daily message that stops arriving. So the hourly run —
   the schedule most likely to still be firing — checks the digest's own
   heartbeat and speaks up when it goes stale. Needs no Cloudflare token.
   It cannot catch Cloudflare dropping *every* cron; that is what the external
   uptime workflow in .github/workflows/uptime.yml is for. */
export async function heartbeatCheck(env) {
  if (!env.SLACK_WEBHOOK_URL) return { skipped: true };
  const last = Number(await readState(env, DIGEST_KEY) || 0);
  // No stamp at all means the digest has not run since this shipped, not that
  // it is broken — stay quiet until one has been recorded.
  if (!last) return { unknown: true };
  const age = Math.floor(Date.now() / 1000) - last;
  if (age < STALE_AFTER) return { age };
  const key = `digest:stale:${utcDay()}`;
  if (await readState(env, key)) return { age, alerted: false };
  await writeState(env, key, '1');
  const hours = Math.floor(age / 3600);
  await slack(env, { text: `:warning: Excerptle daily digest has not run for ${hours}h — the 12:07 UTC cron may have stopped firing.` });
  return { age, alerted: true };
}

/* Events worth interrupting someone for, sent from the request path. */
export const signedUp = (env, ctx, { email, provider }) =>
  notify(env, ctx, { text: `:wave: New Excerptle account — ${String(email).replace(/^(.).*(@.*)$/, '$1***$2')} via ${provider}` });

export const subscriptionChanged = (env, ctx, { status, plan, cancelAtEnd }) => {
  const emoji = status === 'active' || status === 'trialing' ? (cancelAtEnd ? ':warning:' : ':tada:') : ':broken_heart:';
  const what = cancelAtEnd ? 'set to cancel at period end' : status;
  return notify(env, ctx, { text: `${emoji} Excerptle Pro subscription ${what}${plan ? ` (${plan})` : ''}` });
};
