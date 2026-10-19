import Stripe from 'stripe';
import { quotaCheck, dailyDigest, heartbeatCheck, signedUp, subscriptionChanged, slack } from './alerts.ts';
import type {
  AuthBody, BillingBody, BillingStatus, CheckResponse, EmailCodeResponse, EmailCodeRow, Env, ErrorResponse,
  JsonBody, KdfConfigResponse, KdfParams, OkResponse, PasswordBody, PasswordResponse, ProfileBody, ProfileResponse,
  ProgressBody, ProgressEntry, ProgressResponse, ProgressRow, ScoreBody, ScoresResponse, LeaderboardRow, SessionResponse,
  SignInProvider, SubscriptionRow, UrlResponse, UserRow, WebhookResponse,
} from './types.ts';

/* An Error carrying the HTTP status the client should see; anything thrown
   without one is answered with a generic 503. */
type HttpError = Error & { status?: number };
/* Google's token endpoints, the fields read here. */
interface GoogleTokenInfo { aud?: string; expires_in?: string | number; sub?: string }
interface GoogleUserInfo { email_verified?: boolean; email?: string; sub?: string; name?: string }
/* Webhook payload objects as this handler reads them: a subscription, or an
   invoice in either the current (`parent.subscription_details`) or the
   pre-basil (`subscription`) shape. */
type SubscriptionRef = string | { id: string };
interface WebhookObject {
  id?: string;
  parent?: { subscription_details?: { subscription?: SubscriptionRef | null } | null } | null;
  subscription?: SubscriptionRef;
}
/* `current_period_end` moved to subscription items in the basil API; older
   payloads still carry it on the subscription. */
type LegacySubscription = Stripe.Subscription & { current_period_end?: number };

const now = (): number => Math.floor(Date.now() / 1000);
const json = <T>(value: T, status = 200): Response => Response.json(value, { status });
const fail: (status: number, message: string) => never = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = async (value: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const query = (env: Env, sql: string, ...args: unknown[]): D1PreparedStatement => env.DB.prepare(sql).bind(...args);
const stripe = (key: string): Stripe => new Stripe(key, { apiVersion: '2025-08-27.basil', httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2 });
const origins = (env: Env): string[] => (env.ALLOWED_ORIGINS || '').split(',');
/* Passwords are stretched in the browser, not here.
 *
 * PBKDF2 at a defensible iteration count costs ~73ms of CPU; a Workers free
 * plan invocation gets 10ms, so hashing server-side does not run at all — it
 * blows the budget and the request dies as a 503. The client therefore does
 * the stretching (its own CPU, free to us) and sends the derived key, which
 * this Worker treats exactly as it would a password: never stored as sent,
 * only as a fast digest of it. That last step is what stops a leaked database
 * from being a pile of ready-to-use credentials.
 *
 * The floor below is enforced here rather than trusted from the client, or a
 * caller would simply announce that one iteration was plenty. Salt and count
 * are public — they travel back to the browser at sign-in — so the security
 * rests on the iteration count, not on hiding either.
 */
const KDF = { iterations: 600000, minIterations: 600000, maxIterations: 5000000, saltBytes: 16 };
const isHex = (value: unknown, chars: number): value is string => typeof value === 'string' && value.length === chars && /^[0-9a-f]+$/.test(value);
// Cheap by design: the derived key already carries the expensive work, and a
// per-user salt is what keeps one rainbow table from covering everybody.
const verifier = (key: string, salt: string): Promise<string> => hash(`excerptle-pwd-v2:${salt}:${key}`);
const kdfParams = (row: Pick<UserRow, 'password_hash' | 'password_salt'> | null): KdfParams | null => {
  const [iterations, salt] = String(row?.password_salt || '').split(':');
  return row?.password_hash && salt ? { salt, iterations: Number(iterations) } : null;
};
// Hex digests only, so a character-wise compare is enough: no early return on
// the first differing byte.
const sameSecret = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
const safeName = (value: unknown): string => {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (/[\u0000-\u001f\u007f]/.test(name) || [...name].length > 24) fail(400, 'Display names can use up to 24 visible characters.');
  return name || 'Anonymous';
};

async function body<T = JsonBody>(req: Request): Promise<T> {
  const raw = await req.text();
  if (raw.length > 16384) fail(413, 'Request too large.');
  try { return JSON.parse(raw) as T; } catch { fail(400, 'Invalid JSON.'); }
}
async function limit(env: Env, key: string, max: number, seconds: number): Promise<void> {
  const bucket = `${key}:${Math.floor(now() / seconds)}`;
  const row = await query(env, `INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`, bucket, now() + seconds).first<{ count: number }>();
  // An upsert with RETURNING always yields the row.
  if (row!.count > max) fail(429, 'Too many attempts. Try again later.');
}
async function user(req: Request, env: Env): Promise<UserRow> {
  const token = req.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) fail(401, 'Please sign in again.');
  const u = await query(env, `SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>?`, await hash(token), now()).first<UserRow>();
  if (!u) fail(401, 'Please sign in again.');
  return u;
}
async function session(env: Env, email: string, name: string, provider: SignInProvider, sub: string | null = null, ctx: ExecutionContext | null = null): Promise<Response> {
  // Google emails must be verified before linking to an existing email-code account.
  const created = await query(env, 'INSERT INTO users(id,email,name,google_sub,created_at) VALUES(?,?,?,?,?) ON CONFLICT(email) DO NOTHING', crypto.randomUUID(), email, name, sub, now()).run();
  // meta.changes distinguishes a new account from a returning one, so the
  // Slack ping fires once per person rather than once per sign-in.
  if (created.meta?.changes) signedUp(env, ctx, { email, provider });
  // Just upserted, so present.
  const u = (await query(env, 'SELECT * FROM users WHERE email=?', email).first<UserRow>())!;
  if (sub && u.google_sub && sub !== u.google_sub) fail(401, 'Google account does not match.');
  if (sub && !u.google_sub) await query(env, 'UPDATE users SET google_sub=? WHERE id=?', sub, u.id).run();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = now() + 30 * 86400;
  await query(env, 'INSERT INTO sessions VALUES(?,?,?)', await hash(token), u.id, expiresAt).run();
  return json<SessionResponse>({ uid: u.id, email: u.email, name: u.name, provider, token, expiresAt, hasPassword: !!u.password_hash });
}
async function auth(req: Request, env: Env, path: string, ctx: ExecutionContext | undefined): Promise<Response> {
  const d = await body<AuthBody>(req);
  await limit(env, `auth-ip:${req.headers.get('CF-Connecting-IP') || 'local'}`, 30, 600);
  if (path === '/auth/google') {
    if (typeof d.accessToken !== 'string' || d.accessToken.length > 4096) fail(400, 'Invalid Google token.');
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(d.accessToken)}`);
    if (!infoRes.ok) fail(401, 'Google sign-in expired.');
    const info = (await infoRes.json()) as GoogleTokenInfo;
    if (info.aud !== env.GOOGLE_CLIENT_ID || Number(info.expires_in) <= 0) fail(401, 'Invalid Google token.');
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${d.accessToken}` } });
    if (!res.ok) fail(401, 'Could not verify Google account.');
    const p = (await res.json()) as GoogleUserInfo;
    if (!p.email_verified || !p.email || !p.sub || p.sub !== info.sub) fail(401, 'Verified Google email required.');
    return session(env, p.email.toLowerCase(), p.name || p.email.split('@')[0], 'google', p.sub, ctx);
  }
  const email = String(d.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email.');
  // Asked before anything is sent, so a returning account with a password is
  // never made to wait on an email. It does tell a caller whether an address
  // has an account here; the rate limit is what keeps that from being a list.
  if (path === '/auth/check') {
    await limit(env, `check:${req.headers.get('CF-Connecting-IP') || 'local'}`, 20, 600);
    const account = await query(env, 'SELECT password_hash, password_salt, google_sub FROM users WHERE email=?', email).first<Pick<UserRow, 'password_hash' | 'password_salt' | 'google_sub'>>();
    const kdf = kdfParams(account);
    return json<CheckResponse>({ account: !!account, hasPassword: !!kdf, google: !!account?.google_sub, ...(kdf ? { kdf } : {}) });
  }
  if (path === '/auth/login') {
    await limit(env, `login:${await hash(email)}`, 10, 600);
    const u = await query(env, 'SELECT * FROM users WHERE email=?', email).first<UserRow>();
    const kdf = kdfParams(u);
    // Computed even with no account to compare against, so a missing address
    // and a wrong password cost the same and answer the same.
    const candidate = await verifier(isHex(d.key, 64) ? d.key : 'x', kdf?.salt || 'no-such-account');
    if (!kdf || !u || !sameSecret(candidate, u.password_hash)) fail(401, 'Wrong email or password.');
    return session(env, u.email, u.name, 'password', null, ctx);
  }
  if (path === '/auth/email') {
    /* Handing a sign-in code back in the response is account takeover for
       anyone who can name an address, so it takes three deliberate conditions
       that do not co-occur in production: no mail provider configured, an
       opt-in that lives only in backend/.dev.vars (gitignored, never uploaded
       by `wrangler deploy`), and a caller on localhost. Production has a
       RESEND_API_KEY, which alone is enough to rule this out. */
    const echoCode = env.DEV_ECHO_CODES === 'true'
      && !env.RESEND_API_KEY
      && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.get('Origin') || '');
    if (!env.OTP_SECRET || (!env.RESEND_API_KEY && !echoCode)) fail(503, 'Email sign-in is temporarily unavailable. Please use Google.');
    await limit(env, `mail:${await hash(email)}`, 3, 600);
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    const code = String(n % 1000000).padStart(6, '0');
    const digest = await hash(`${env.OTP_SECRET}:${email}:${code}`);
    await query(env, `INSERT INTO email_codes VALUES(?,?,?,0) ON CONFLICT(email)
      DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0`, email, digest, now() + 600).run();
    if (!echoCode) {
      const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: 'Your Excerptle sign-in code', text: `Your Excerptle code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.` }) });
      if (!res.ok) fail(503, 'Could not send your code. Try again later.');
    }
    const account = await query(env, 'SELECT password_hash, password_salt FROM users WHERE email=?', email).first<Pick<UserRow, 'password_hash' | 'password_salt'>>();
    return json<EmailCodeResponse>({ hasPassword: !!kdfParams(account), ...(echoCode ? { devCode: code } : {}) });
  }
  if (path === '/auth/verify') {
    if (!env.OTP_SECRET) fail(503, 'Email sign-in unavailable.');
    await limit(env, `verify:${await hash(email)}`, 10, 600);
    const row = await query(env, 'UPDATE email_codes SET attempts=attempts+1 WHERE email=? AND expires_at>? AND attempts<5 RETURNING *', email, now()).first<EmailCodeRow>();
    if (!row || !/^\d{6}$/.test(String(d.code)) || row.code_hash !== await hash(`${env.OTP_SECRET}:${email}:${d.code}`)) fail(401, 'Code expired or incorrect. Request a new code.');
    const deleted = await query(env, 'DELETE FROM email_codes WHERE email=? AND code_hash=? RETURNING email', email, row.code_hash).first<Pick<EmailCodeRow, 'email'>>();
    if (!deleted) fail(401, 'Code already used.');
    return session(env, email, email.split('@')[0], 'email', null, ctx);
  }
  fail(400, 'Invalid sign-in method.');
}
async function setPassword(req: Request, env: Env): Promise<Response> {
  const u = await user(req, env);
  const d = await body<PasswordBody>(req);
  // "Someone has my account, so I changed my password" has to mean something.
  // Tokens live thirty days in localStorage, so every other one goes.
  const mine = await hash(req.headers.get('Authorization')!.slice(7));
  const revokeOthers = () => query(env, 'DELETE FROM sessions WHERE user_id=? AND token_hash<>?', u.id, mine);
  await limit(env, `password:${u.id}`, 5, 600);
  const existing = kdfParams(u);
  // A session token lives in localStorage for thirty days; replacing a
  // password that already exists has to cost more than holding one.
  if (existing && !sameSecret(await verifier(isHex(d.currentKey, 64) ? d.currentKey : 'x', existing.salt), u.password_hash)) {
    fail(401, 'Current password is wrong.');
  }
  if (d.remove === true) {
    if (!existing) fail(400, 'No password to remove.');
    await env.DB.batch([
      query(env, 'UPDATE users SET password_hash=NULL,password_salt=NULL WHERE id=?', u.id),
      revokeOthers(),
    ]);
    return json<PasswordResponse>({ ok: true, hasPassword: false });
  }
  const iterations = Number(d.iterations);
  if (!isHex(d.key, 64)) fail(400, 'Could not read that password. Please try again.');
  if (!isHex(d.salt, KDF.saltBytes * 2)) fail(400, 'Could not read that password. Please try again.');
  // The whole scheme rests on this number, and it arrives from the browser.
  if (!Number.isInteger(iterations) || iterations < KDF.minIterations || iterations > KDF.maxIterations) {
    fail(400, 'Unsupported password settings. Please reload the page.');
  }
  await env.DB.batch([
    query(env, 'UPDATE users SET password_hash=?,password_salt=? WHERE id=?',
      await verifier(d.key, d.salt), `${iterations}:${d.salt}`, u.id),
    revokeOthers(),
  ]);
  return json<PasswordResponse>({ ok: true, hasPassword: true });
}
async function scores(req: Request, env: Env): Promise<Response> {
  if (req.method === 'GET') {
    const puzzleIndex = Number(new URL(req.url).searchParams.get('puzzleIndex'));
    const params = new URL(req.url).searchParams;
    const hintParam = params.get('hints');
    const hints = hintParam === null ? null : Number(hintParam);
    if (!Number.isInteger(puzzleIndex) || puzzleIndex < 0 || puzzleIndex > 10000000 || (hints !== null && (!Number.isInteger(hints) || hints < 0 || hints > 5))) fail(400, 'Invalid leaderboard filter.');
    // Ranked on help taken, then guesses, then who got there first. Time spent
    // reading is deliberately not part of it: this is a book game, not a race.
    const select = `SELECT COALESCE(NULLIF(u.name,''),s.name) AS name,s.user_id AS playerId,s.guesses,s.hints,s.hint_version AS hintVersion,s.won_at AS at FROM scores s LEFT JOIN users u ON u.id=s.user_id`;
    const rows = hints === null
      ? await query(env, `${select} WHERE s.puzzle_index=? ORDER BY s.hints,s.guesses,s.won_at LIMIT 100`, puzzleIndex).all<LeaderboardRow>()
      : await query(env, `${select} WHERE s.puzzle_index=? AND s.hints=? ORDER BY s.guesses,s.won_at LIMIT 100`, puzzleIndex, hints).all<LeaderboardRow>();
    return json<ScoresResponse>({ scores: rows.results });
  }
  const u = await user(req, env);
  const d = await body<ScoreBody>(req);
  const puzzleIndex = Number(d.puzzleIndex), guesses = Number(d.guesses), hints = Number(d.hints), hintVersion = Number(d.hintVersion || 1);
  // timeMs is no longer ranked on, but clients in the wild still send it and
  // the column is NOT NULL, so it is accepted and stored, never compared.
  const timeMs = Number.isFinite(Number(d.timeMs)) ? Math.min(Math.max(Number(d.timeMs), 0), 86400000) : 0;
  if (!Number.isInteger(puzzleIndex) || puzzleIndex < 0 || puzzleIndex > 10000000 || ![1, 2].includes(hintVersion) || !Number.isInteger(guesses) || guesses < 1 || guesses > 6 || !Number.isInteger(hints) || hints < 0 || hints > 5 || d.win !== true) fail(400, 'Invalid score.');
  await limit(env, `score:${u.id}`, 30, 600);
  // One shared board per book: clue-system versions are display metadata, not
  // separate competitions. Keep each player's best score across every version.
  await env.DB.batch([
    query(env, `DELETE FROM scores WHERE user_id=? AND puzzle_index=?
      AND (hints>? OR (hints=? AND guesses>?))`, u.id, puzzleIndex, hints, hints, guesses),
    query(env, `INSERT INTO scores(id,user_id,puzzle_index,name,guesses,hints,time_ms,won_at,hint_version)
      SELECT ?,?,?,?,?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM scores WHERE user_id=? AND puzzle_index=?)`,
      crypto.randomUUID(), u.id, puzzleIndex, safeName(u.name), guesses, hints, Math.round(timeMs), now(), hintVersion, u.id, puzzleIndex),
  ]);
  return json({ ok: true });
}
async function profile(req: Request, env: Env): Promise<Response> {
  const u = await user(req, env);
  if (req.method === 'GET') return json<ProfileResponse>({ uid: u.id, name: safeName(u.name) });
  const d = await body<ProfileBody>(req);
  const name = safeName(d.name);
  await query(env, 'UPDATE users SET name=? WHERE id=?', name, u.id).run();
  return json<ProfileResponse>({ uid: u.id, name });
}
/* How far the stored round got: 2 = over, 1 = played, 0 = only opened. The same
   three ranks as `progressRank()` in js/app.js, so the two sides of a merge
   cannot disagree — a newer row that was merely opened must not erase guesses.
   Nested CASE, not AND, because json_extract raises on a malformed legacy row
   and the GET path deliberately tolerates one. */
const STORED_RANK = `(CASE WHEN json_valid(progress.data) THEN (CASE
    WHEN json_extract(progress.data,'$.status') IN ('won','lost') THEN 2
    WHEN COALESCE(json_extract(progress.data,'$.hints'),0)>0
      OR COALESCE(json_array_length(progress.data,'$.guesses'),0)>0 THEN 1
    ELSE 0 END) ELSE 0 END)`;
async function progress(req: Request, env: Env): Promise<Response> {
  const u = await user(req, env);
  if (req.method === 'GET') {
    const rows = await query(env, 'SELECT puzzle_index,data FROM progress WHERE user_id=?', u.id).all<ProgressRow>();
    const entries: Record<number, ProgressEntry> = {};
    for (const row of rows.results) { try { entries[row.puzzle_index] = JSON.parse(row.data); } catch { /* ignore corrupt legacy row */ } }
    return json<ProgressResponse>({ progress: entries });
  }
  const d = await body<ProgressBody>(req);
  if (!d.progress || typeof d.progress !== 'object' || Array.isArray(d.progress) || Object.keys(d.progress).length > 2000) fail(400, 'Invalid progress.');
  const writes: D1PreparedStatement[] = [];
  for (const [key, value] of Object.entries(d.progress as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index > 10000000 || !value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid progress.');
    const entry = value as ProgressEntry;
    const encoded = JSON.stringify(entry);
    if (encoded.length > 4096) fail(413, 'Progress entry too large.');
    // How far a round got beats when it was saved, whatever the clocks say: a
    // second device with the same book still open would otherwise push its
    // unfinished copy over a win. Mirrors `beats()` in js/app.js.
    const rank = entry.status === 'won' || entry.status === 'lost' ? 2
      : Number(entry.hints) > 0 || (Array.isArray(entry.guesses) && entry.guesses.length) ? 1 : 0;
    writes.push(query(env, `INSERT INTO progress VALUES(?,?,?,?) ON CONFLICT(user_id,puzzle_index)
      DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at
      WHERE ?>${STORED_RANK} OR (?=${STORED_RANK} AND excluded.updated_at>=progress.updated_at)`,
      u.id, index, encoded, Number(entry.at) || Date.now(), rank, rank));
  }
  if (writes.length) await env.DB.batch(writes);
  return json<OkResponse>({ ok: true });
}
export function returnUrl(value: unknown, env: Env): string {
  let url: URL;
  // String() is what the URL constructor applies to a non-string anyway.
  try { url = new URL(String(value || `${env.SITE_URL}/#/pro`)); } catch { fail(400, 'Invalid return address.'); }
  if (!origins(env).includes(url.origin) || url.username || url.password) fail(400, 'Invalid return address.');
  return `${url.origin}/#/pro`;
}
async function status(env: Env, u: UserRow): Promise<BillingStatus> {
  const monthly = env.STRIPE_PRICE_ID || '';
  const yearly = env.STRIPE_YEARLY_PRICE_ID || '';
  const result = await query(env, `SELECT * FROM subscriptions WHERE user_id=? AND price_id IN (?,?)
    ORDER BY CASE WHEN status IN ('active','trialing') AND period_end>? THEN 0 ELSE 1 END, period_end DESC LIMIT 1`, u.id, monthly, yearly, now()).first<SubscriptionRow>();
  return { pro: !!result && ['active', 'trialing'].includes(result.status) && result.period_end > now(), status: result?.status || 'none', currentPeriodEnd: result?.period_end || null, cancelAtPeriodEnd: !!result?.cancel_at_end, price: result?.price_id === yearly ? '$20/year' : '$3/month', hasCustomer: !!u.stripe_customer };
}
async function billing(req: Request, env: Env, path: string): Promise<Response> {
  const u = await user(req, env);
  if (path === '/billing/status') return json<BillingStatus>(await status(env, u));
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID || !env.STRIPE_YEARLY_PRICE_ID) fail(503, 'Subscriptions are temporarily unavailable.');
  await limit(env, `billing:${u.id}`, 15, 600);
  const request = await body<BillingBody>(req);
  const back = returnUrl(request.returnUrl, env);
  const s = stripe(env.STRIPE_SECRET_KEY);
  if (path === '/billing/portal') {
    if (!u.stripe_customer) fail(400, 'No billing account yet.');
    return json<UrlResponse>({ url: (await s.billingPortal.sessions.create({ customer: u.stripe_customer, return_url: back, ...(env.STRIPE_PORTAL_CONFIGURATION ? { configuration: env.STRIPE_PORTAL_CONFIGURATION } : {}) })).url });
  }
  const plan = request.plan;
  if (plan !== 'monthly' && plan !== 'yearly') fail(400, 'Choose monthly or yearly billing.');
  const priceId = plan === 'yearly' ? env.STRIPE_YEARLY_PRICE_ID : env.STRIPE_PRICE_ID;
  const lock = await query(env, `INSERT INTO checkout_locks VALUES(?,?) ON CONFLICT(user_id)
    DO UPDATE SET expires_at=excluded.expires_at WHERE checkout_locks.expires_at<? RETURNING user_id`, u.id, now() + 120, now()).first<{ user_id: string }>();
  if (!lock) fail(409, 'Checkout is already opening. Try again shortly.');
  try {
    if (!u.stripe_customer) {
      const customer = await s.customers.create({ email: u.email, metadata: { user_id: u.id } }, { idempotencyKey: `customer:${u.id}` });
      await query(env, 'UPDATE users SET stripe_customer=? WHERE id=?', customer.id, u.id).run();
      u.stripe_customer = customer.id;
    }
    // Check Stripe directly to prevent a second purchase while a webhook is pending.
    for await (const sub of s.subscriptions.list({ customer: u.stripe_customer, status: 'all', limit: 100 })) {
      if (!['canceled', 'incomplete_expired'].includes(sub.status)) fail(409, 'You already have a subscription. Use Manage billing.');
    }
    // An open session is reused so a double-click cannot buy twice, but only
    // for the plan actually requested: handing back a stale session for the
    // other plan charges a price the customer did not choose. Sessions created
    // before this carried no plan metadata, so they expire here too.
    const open = await s.checkout.sessions.list({ customer: u.stripe_customer, status: 'open', limit: 100 });
    const reusable = open.data.find(session => session.metadata?.plan === plan);
    if (reusable) return json<UrlResponse>({ url: reusable.url });
    for (const stale of open.data) await s.checkout.sessions.expire(stale.id);
    const price = await s.prices.retrieve(priceId);
    const expected = plan === 'yearly' ? { amount: 2000, interval: 'year' } : { amount: 300, interval: 'month' };
    if (!price.active || price.currency !== 'usd' || price.unit_amount !== expected.amount || price.recurring?.interval !== expected.interval || price.recurring.interval_count !== 1 || price.livemode !== (env.STRIPE_LIVE === 'true')) fail(503, 'Subscription configuration needs attention.');
    const params: Stripe.Checkout.SessionCreateParams = { mode: 'subscription', customer: u.stripe_customer,
      client_reference_id: u.id, line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id: u.id, plan },
      subscription_data: { metadata: { user_id: u.id, plan } }, success_url: back, cancel_url: back };
    const key = `checkout:${u.id}:${plan}:${Math.floor(now() / 1800)}`;
    let checkout = await s.checkout.sessions.create(params, { idempotencyKey: key });
    // monthly -> yearly -> monthly inside one bucket replays the key of the
    // session the yearly request expired. The bucket still stops a double-click
    // buying twice; only a dead replay asks for a new session.
    if (checkout.status === 'expired' || checkout.status === 'complete') {
      checkout = await s.checkout.sessions.create(params, { idempotencyKey: `${key}:${crypto.randomUUID()}` });
    }
    return json<UrlResponse>({ url: checkout.url });
  } finally { await query(env, 'DELETE FROM checkout_locks WHERE user_id=?', u.id).run(); }
}
async function webhook(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) fail(503, 'Webhook not configured.');
  const s = stripe(env.STRIPE_SECRET_KEY);
  let event: Stripe.Event;
  try { event = await s.webhooks.constructEventAsync(await req.text(), req.headers.get('Stripe-Signature') || '', env.STRIPE_WEBHOOK_SECRET, 300, Stripe.createSubtleCryptoProvider()); }
  catch { fail(400, 'Invalid webhook signature.'); }
  if (event.livemode !== (env.STRIPE_LIVE === 'true')) fail(400, 'Wrong Stripe mode.');
  if (await query(env, 'SELECT id FROM stripe_events WHERE id=?', event.id).first()) return json<WebhookResponse>({ received: true });
  const object = event.data.object as WebhookObject;
  let id: SubscriptionRef | null | undefined = event.type.startsWith('customer.subscription.') ? object.id : event.type.startsWith('invoice.') ? (object.parent?.subscription_details?.subscription || object.subscription) : null;
  // typeof null is 'object' too, so an event of any other type throws here and
  // is answered 503 (only subscription and invoice events are subscribed to).
  if (typeof id === 'object') id = (id as { id: string }).id;
  if (!id) return json<WebhookResponse>({ received: true });
  // Re-read current Stripe state: delayed deliveries must not resurrect a cancelled subscription.
  const sub = await s.subscriptions.retrieve(id);
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const u = await query(env, 'SELECT id FROM users WHERE stripe_customer=?', customer).first<Pick<UserRow, 'id'>>();
  if (!u) return json<WebhookResponse>({ received: true }); // Other Stripe products/accounts are out of scope.
  const knownPrices = [env.STRIPE_PRICE_ID, env.STRIPE_YEARLY_PRICE_ID].filter(Boolean);
  const item = sub.items.data.find(i => knownPrices.includes(i.price.id));
  const end = item?.current_period_end || (sub as LegacySubscription).current_period_end || 0;
  await env.DB.batch([
    query(env, `INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,period_end=excluded.period_end,cancel_at_end=excluded.cancel_at_end,
      price_id=excluded.price_id,event_created=excluded.event_created,event_id=excluded.event_id
      WHERE excluded.event_created>=subscriptions.event_created
      AND (subscriptions.status NOT IN ('canceled','incomplete_expired') OR excluded.status IN ('canceled','incomplete_expired'))`, sub.id, u.id, item ? sub.status : 'canceled', end, sub.cancel_at_period_end ? 1 : 0, item?.price.id || '', event.created, event.id),
    query(env, 'INSERT OR IGNORE INTO stripe_events VALUES(?,?)', event.id, now())
  ]);
  // Money moving is worth a ping — but `customer.subscription.updated` also
  // fires on every renewal and on changes nobody would notice. Stripe names
  // the fields that actually moved, so ping only when one of the two a human
  // cares about is among them.
  const moved: object = event.data.previous_attributes || {};
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.deleted'
    || 'status' in moved || 'cancel_at_period_end' in moved) {
    subscriptionChanged(env, ctx, { status: item ? sub.status : 'canceled', plan: sub.metadata?.plan, cancelAtEnd: !!sub.cancel_at_period_end });
  }
  return json<WebhookResponse>({ received: true });
}
export default {
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const path = new URL(req.url).pathname;
    const origin = req.headers.get('Origin');
    let response: Response;
    try {
      if (origin && !origins(env).includes(origin)) fail(403, 'Origin not allowed.');
      if (req.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else if (path === '/health' && req.method === 'GET') response = json<OkResponse>({ ok: true });
      // Read by the browser before deriving a new password, so the cost can be
      // raised for everyone from here without shipping a new frontend.
      else if (path === '/auth/kdf' && req.method === 'GET') response = json<KdfConfigResponse>({ iterations: KDF.iterations, saltBytes: KDF.saltBytes });
      else if (path === '/billing/webhook' && req.method === 'POST') response = await webhook(req, env, ctx);
      else if (['/auth/email', '/auth/verify', '/auth/google', '/auth/check', '/auth/login'].includes(path) && req.method === 'POST') response = await auth(req, env, path, ctx);
      else if (path === '/auth/logout' && req.method === 'POST') {
        await user(req, env);
        await query(env, 'DELETE FROM sessions WHERE token_hash=?', await hash(req.headers.get('Authorization')!.slice(7))).run();
        response = json<OkResponse>({ ok: true });
      } else if ((path === '/billing/status' && req.method === 'GET') || (['/billing/checkout', '/billing/portal'].includes(path) && req.method === 'POST')) response = await billing(req, env, path);
      else if (path === '/scores' && (req.method === 'GET' || req.method === 'POST')) response = await scores(req, env);
      else if (path === '/me/progress' && (req.method === 'GET' || req.method === 'PUT')) response = await progress(req, env);
      else if (path === '/me/profile' && (req.method === 'GET' || req.method === 'POST')) response = await profile(req, env);
      else if (path === '/me/password' && req.method === 'POST') response = await setPassword(req, env);
      else response = json<ErrorResponse>({ error: 'Not found.' }, 404);
    } catch (caught) {
      const e = caught as HttpError;
      // Never log tokens, email codes, Stripe bodies, or credentials.
      response = json<ErrorResponse>({ error: e.status ? e.message : 'Service temporarily unavailable. Please try again.' }, e.status || 503);
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Vary', 'Origin');
    if (origin && origins(env).includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    return response;
  },
  /* Two schedules (see wrangler.toml [triggers]):
       0 * * * *   hourly free-tier quota check — quiet unless something moved
       7 12 * * *  nightly sweep + the daily Slack digest (08:07 New York)
     Alerting is wrapped so a Slack or analytics outage can never stop the
     expiry sweep, which is the part the service actually depends on. */
  async scheduled(event: ScheduledController, env: Env, ctx?: ExecutionContext): Promise<void> {
    const nightly = event.cron !== '0 * * * *';
    if (nightly) {
      await env.DB.batch(['sessions', 'email_codes', 'rate_limits', 'checkout_locks'].map(table => query(env, `DELETE FROM ${table} WHERE expires_at<?`, now())));
    }
    try {
      // Inside the try: alert_state only exists once migration 0003 is applied,
      // and a missing table must not be able to abort the sweep above.
      if (nightly) await query(env, 'DELETE FROM alert_state WHERE updated_at<?', now() - 7 * 86400).run();
      if (nightly) await dailyDigest(env);
      else {
        await quotaCheck(env);
        await heartbeatCheck(env);
      }
    } catch (err) {
      ctx?.waitUntil?.(slack(env, { text: `:x: Excerptle cron \`${event.cron}\` failed: ${String((err as Error).message).slice(0, 200)}` }));
    }
  }
} satisfies ExportedHandler<Env>;
