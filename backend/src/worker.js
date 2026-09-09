import Stripe from 'stripe';

const now = () => Math.floor(Date.now() / 1000);
const json = (value, status = 200) => Response.json(value, { status });
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const query = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const stripe = env => new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2025-08-27.basil', httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2 });
const origins = env => (env.ALLOWED_ORIGINS || '').split(',');
const passwordHash = async (password, salt) => {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 310000, hash: 'SHA-256' }, material, 256);
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
};
const safeName = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 24) || 'Reader';

async function body(req) {
  const raw = await req.text();
  if (raw.length > 16384) fail(413, 'Request too large.');
  try { return JSON.parse(raw); } catch { fail(400, 'Invalid JSON.'); }
}
async function limit(env, key, max, seconds) {
  const bucket = `${key}:${Math.floor(now() / seconds)}`;
  const row = await query(env, `INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`, bucket, now() + seconds).first();
  if (row.count > max) fail(429, 'Too many attempts. Try again later.');
}
async function user(req, env) {
  const token = req.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) fail(401, 'Please sign in again.');
  const u = await query(env, `SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>?`, await hash(token), now()).first();
  if (!u) fail(401, 'Please sign in again.');
  return u;
}
async function session(env, email, name, provider, sub = null) {
  // Google emails must be verified before linking to an existing email-code account.
  await query(env, 'INSERT INTO users(id,email,name,google_sub,created_at) VALUES(?,?,?,?,?) ON CONFLICT(email) DO NOTHING', crypto.randomUUID(), email, name, sub, now()).run();
  const u = await query(env, 'SELECT * FROM users WHERE email=?', email).first();
  if (sub && u.google_sub && sub !== u.google_sub) fail(401, 'Google account does not match.');
  if (sub && !u.google_sub) await query(env, 'UPDATE users SET google_sub=? WHERE id=?', sub, u.id).run();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = now() + 30 * 86400;
  await query(env, 'INSERT INTO sessions VALUES(?,?,?)', await hash(token), u.id, expiresAt).run();
  return json({ uid: u.id, email: u.email, name: u.name, provider, token, expiresAt });
}
async function auth(req, env, path) {
  const d = await body(req);
  await limit(env, `auth-ip:${req.headers.get('CF-Connecting-IP') || 'local'}`, 30, 600);
  if (path === '/auth/google') {
    if (typeof d.accessToken !== 'string' || d.accessToken.length > 4096) fail(400, 'Invalid Google token.');
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(d.accessToken)}`);
    if (!infoRes.ok) fail(401, 'Google sign-in expired.');
    const info = await infoRes.json();
    if (info.aud !== env.GOOGLE_CLIENT_ID || Number(info.expires_in) <= 0) fail(401, 'Invalid Google token.');
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${d.accessToken}` } });
    if (!res.ok) fail(401, 'Could not verify Google account.');
    const p = await res.json();
    if (!p.email_verified || !p.email || !p.sub || p.sub !== info.sub) fail(401, 'Verified Google email required.');
    return session(env, p.email.toLowerCase(), p.name || p.email.split('@')[0], 'google', p.sub);
  }
  const email = String(d.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email.');
  if (path === '/auth/email') {
    if (!env.RESEND_API_KEY || !env.OTP_SECRET) fail(503, 'Email sign-in is temporarily unavailable. Please use Google.');
    await limit(env, `mail:${await hash(email)}`, 3, 600);
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    const code = String(n % 1000000).padStart(6, '0');
    const digest = await hash(`${env.OTP_SECRET}:${email}:${code}`);
    await query(env, `INSERT INTO email_codes VALUES(?,?,?,0) ON CONFLICT(email)
      DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0`, email, digest, now() + 600).run();
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: 'Your Excerptle sign-in code', text: `Your Excerptle code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.` }) });
    if (!res.ok) fail(503, 'Could not send your code. Try again later.');
    const account = await query(env, 'SELECT password_hash FROM users WHERE email=?', email).first();
    return json({ hasPassword: !!account?.password_hash });
  }
  if (path === '/auth/verify') {
    if (!env.OTP_SECRET) fail(503, 'Email sign-in unavailable.');
    await limit(env, `verify:${await hash(email)}`, 10, 600);
    const row = await query(env, 'UPDATE email_codes SET attempts=attempts+1 WHERE email=? AND expires_at>? AND attempts<5 RETURNING *', email, now()).first();
    if (!row || !/^\d{6}$/.test(String(d.code)) || row.code_hash !== await hash(`${env.OTP_SECRET}:${email}:${d.code}`)) fail(401, 'Code expired or incorrect. Request a new code.');
    const deleted = await query(env, 'DELETE FROM email_codes WHERE email=? AND code_hash=? RETURNING email', email, row.code_hash).first();
    if (!deleted) fail(401, 'Code already used.');
    return session(env, email, email.split('@')[0], 'email');
  }
  fail(400, 'Invalid sign-in method.');
}
async function setPassword(req, env) {
  const u = await user(req, env);
  const d = await body(req);
  const password = String(d.password || '');
  if (password.length < 8 || password.length > 256) fail(400, 'Password must be 8 to 256 characters.');
  await limit(env, `password:${u.id}`, 5, 600);
  const salt = crypto.randomUUID();
  await query(env, 'UPDATE users SET password_hash=?,password_salt=? WHERE id=?', await passwordHash(password, salt), salt, u.id).run();
  return json({ ok: true });
}
async function scores(req, env) {
  if (req.method === 'GET') {
    const puzzleIndex = Number(new URL(req.url).searchParams.get('puzzleIndex'));
    const hintParam = new URL(req.url).searchParams.get('hints');
    const hints = hintParam === null ? null : Number(hintParam);
    if (!Number.isInteger(puzzleIndex) || puzzleIndex < 0 || puzzleIndex > 10000000 || (hints !== null && (!Number.isInteger(hints) || hints < 0 || hints > 5))) fail(400, 'Invalid leaderboard filter.');
    const rows = hints === null
      ? await query(env, `SELECT name,guesses,hints,time_ms AS timeMs,won_at AS at FROM scores WHERE puzzle_index=? ORDER BY hints,guesses,time_ms,won_at LIMIT 100`, puzzleIndex).all()
      : await query(env, `SELECT name,guesses,hints,time_ms AS timeMs,won_at AS at FROM scores WHERE puzzle_index=? AND hints=? ORDER BY guesses,time_ms,won_at LIMIT 100`, puzzleIndex, hints).all();
    return json({ scores: rows.results });
  }
  const u = await user(req, env);
  const d = await body(req);
  const puzzleIndex = Number(d.puzzleIndex), guesses = Number(d.guesses), hints = Number(d.hints), timeMs = Number(d.timeMs);
  if (!Number.isInteger(puzzleIndex) || puzzleIndex < 0 || puzzleIndex > 10000000 || !Number.isInteger(guesses) || guesses < 1 || guesses > 6 || !Number.isInteger(hints) || hints < 0 || hints > 5 || !Number.isFinite(timeMs) || timeMs < 0 || timeMs > 86400000 || d.win !== true) fail(400, 'Invalid score.');
  await limit(env, `score:${u.id}`, 30, 600);
  const previous = await query(env, 'SELECT id,guesses,hints,time_ms FROM scores WHERE user_id=? AND puzzle_index=?', u.id, puzzleIndex).first();
  const candidate = [hints, timeMs, guesses];
  const old = previous && [previous.hints, previous.time_ms, previous.guesses];
  if (old && old.every((v, i) => v <= candidate[i])) return json({ ok: true });
  if (previous) await query(env, 'DELETE FROM scores WHERE id=?', previous.id).run();
  await query(env, 'INSERT INTO scores VALUES(?,?,?,?,?,?,?,?)', crypto.randomUUID(), u.id, puzzleIndex, safeName(u.name), guesses, hints, Math.round(timeMs), now()).run();
  return json({ ok: true });
}
async function progress(req, env) {
  const u = await user(req, env);
  if (req.method === 'GET') {
    const rows = await query(env, 'SELECT puzzle_index,data FROM progress WHERE user_id=?', u.id).all();
    const entries = {};
    for (const row of rows.results) { try { entries[row.puzzle_index] = JSON.parse(row.data); } catch { /* ignore corrupt legacy row */ } }
    return json({ progress: entries });
  }
  const d = await body(req);
  if (!d.progress || typeof d.progress !== 'object' || Array.isArray(d.progress) || Object.keys(d.progress).length > 2000) fail(400, 'Invalid progress.');
  const writes = [];
  for (const [key, value] of Object.entries(d.progress)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index > 10000000 || !value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid progress.');
    const encoded = JSON.stringify(value);
    if (encoded.length > 4096) fail(413, 'Progress entry too large.');
    writes.push(query(env, `INSERT INTO progress VALUES(?,?,?,?) ON CONFLICT(user_id,puzzle_index)
      DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at WHERE excluded.updated_at>=progress.updated_at`, u.id, index, encoded, Number(value.at) || Date.now()));
  }
  if (writes.length) await env.DB.batch(writes);
  return json({ ok: true });
}
export function returnUrl(value, env) {
  let url;
  try { url = new URL(value || `${env.SITE_URL}/#/pro`); } catch { fail(400, 'Invalid return address.'); }
  if (!origins(env).includes(url.origin) || url.username || url.password) fail(400, 'Invalid return address.');
  return `${url.origin}/#/pro`;
}
async function status(env, u) {
  const monthly = env.STRIPE_PRICE_ID || '';
  const yearly = env.STRIPE_YEARLY_PRICE_ID || '';
  const result = await query(env, `SELECT * FROM subscriptions WHERE user_id=? AND price_id IN (?,?)
    ORDER BY CASE WHEN status IN ('active','trialing') AND period_end>? THEN 0 ELSE 1 END, period_end DESC LIMIT 1`, u.id, monthly, yearly, now()).first();
  return { pro: !!result && ['active', 'trialing'].includes(result.status) && result.period_end > now(), status: result?.status || 'none', currentPeriodEnd: result?.period_end || null, cancelAtPeriodEnd: !!result?.cancel_at_end, price: result?.price_id === yearly ? '$20/year' : '$3/month', hasCustomer: !!u.stripe_customer };
}
async function billing(req, env, path) {
  const u = await user(req, env);
  if (path === '/billing/status') return json(await status(env, u));
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID || !env.STRIPE_YEARLY_PRICE_ID) fail(503, 'Subscriptions are temporarily unavailable.');
  await limit(env, `billing:${u.id}`, 15, 600);
  const request = await body(req);
  const back = returnUrl(request.returnUrl, env);
  const s = stripe(env);
  if (path === '/billing/portal') {
    if (!u.stripe_customer) fail(400, 'No billing account yet.');
    return json({ url: (await s.billingPortal.sessions.create({ customer: u.stripe_customer, return_url: back, ...(env.STRIPE_PORTAL_CONFIGURATION ? { configuration: env.STRIPE_PORTAL_CONFIGURATION } : {}) })).url });
  }
  const plan = request.plan;
  if (plan !== 'monthly' && plan !== 'yearly') fail(400, 'Choose monthly or yearly billing.');
  const priceId = plan === 'yearly' ? env.STRIPE_YEARLY_PRICE_ID : env.STRIPE_PRICE_ID;
  const lock = await query(env, `INSERT INTO checkout_locks VALUES(?,?) ON CONFLICT(user_id)
    DO UPDATE SET expires_at=excluded.expires_at WHERE checkout_locks.expires_at<? RETURNING user_id`, u.id, now() + 120, now()).first();
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
    if (reusable) return json({ url: reusable.url });
    for (const stale of open.data) await s.checkout.sessions.expire(stale.id);
    const price = await s.prices.retrieve(priceId);
    const expected = plan === 'yearly' ? { amount: 2000, interval: 'year' } : { amount: 300, interval: 'month' };
    if (!price.active || price.currency !== 'usd' || price.unit_amount !== expected.amount || price.recurring?.interval !== expected.interval || price.recurring.interval_count !== 1 || price.livemode !== (env.STRIPE_LIVE === 'true')) fail(503, 'Subscription configuration needs attention.');
    const checkout = await s.checkout.sessions.create({ mode: 'subscription', customer: u.stripe_customer,
      client_reference_id: u.id, line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id: u.id, plan },
      subscription_data: { metadata: { user_id: u.id, plan } }, success_url: back, cancel_url: back },
      { idempotencyKey: `checkout:${u.id}:${plan}:${Math.floor(now() / 1800)}` });
    return json({ url: checkout.url });
  } finally { await query(env, 'DELETE FROM checkout_locks WHERE user_id=?', u.id).run(); }
}
async function webhook(req, env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) fail(503, 'Webhook not configured.');
  const s = stripe(env);
  let event;
  try { event = await s.webhooks.constructEventAsync(await req.text(), req.headers.get('Stripe-Signature') || '', env.STRIPE_WEBHOOK_SECRET, 300, Stripe.createSubtleCryptoProvider()); }
  catch { fail(400, 'Invalid webhook signature.'); }
  if (event.livemode !== (env.STRIPE_LIVE === 'true')) fail(400, 'Wrong Stripe mode.');
  if (await query(env, 'SELECT id FROM stripe_events WHERE id=?', event.id).first()) return json({ received: true });
  const object = event.data.object;
  let id = event.type.startsWith('customer.subscription.') ? object.id : event.type.startsWith('invoice.') ? (object.parent?.subscription_details?.subscription || object.subscription) : null;
  if (typeof id === 'object') id = id.id;
  if (!id) return json({ received: true });
  // Re-read current Stripe state: delayed deliveries must not resurrect a cancelled subscription.
  const sub = await s.subscriptions.retrieve(id);
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const u = await query(env, 'SELECT id FROM users WHERE stripe_customer=?', customer).first();
  if (!u) return json({ received: true }); // Other Stripe products/accounts are out of scope.
  const knownPrices = [env.STRIPE_PRICE_ID, env.STRIPE_YEARLY_PRICE_ID].filter(Boolean);
  const item = sub.items.data.find(i => knownPrices.includes(i.price.id));
  const end = item?.current_period_end || sub.current_period_end || 0;
  await env.DB.batch([
    query(env, `INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,period_end=excluded.period_end,cancel_at_end=excluded.cancel_at_end,
      price_id=excluded.price_id,event_created=excluded.event_created,event_id=excluded.event_id
      WHERE excluded.event_created>=subscriptions.event_created
      AND (subscriptions.status NOT IN ('canceled','incomplete_expired') OR excluded.status IN ('canceled','incomplete_expired'))`, sub.id, u.id, item ? sub.status : 'canceled', end, sub.cancel_at_period_end ? 1 : 0, item?.price.id || '', event.created, event.id),
    query(env, 'INSERT OR IGNORE INTO stripe_events VALUES(?,?)', event.id, now())
  ]);
  return json({ received: true });
}
export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    const origin = req.headers.get('Origin');
    let response;
    try {
      if (origin && !origins(env).includes(origin)) fail(403, 'Origin not allowed.');
      if (req.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else if (path === '/health' && req.method === 'GET') response = json({ ok: true });
      else if (path === '/billing/webhook' && req.method === 'POST') response = await webhook(req, env);
      else if (['/auth/email', '/auth/verify', '/auth/google'].includes(path) && req.method === 'POST') response = await auth(req, env, path);
      else if (path === '/auth/logout' && req.method === 'POST') {
        await user(req, env);
        await query(env, 'DELETE FROM sessions WHERE token_hash=?', await hash(req.headers.get('Authorization').slice(7))).run();
        response = json({ ok: true });
      } else if ((path === '/billing/status' && req.method === 'GET') || (['/billing/checkout', '/billing/portal'].includes(path) && req.method === 'POST')) response = await billing(req, env, path);
      else if (path === '/scores' && (req.method === 'GET' || req.method === 'POST')) response = await scores(req, env);
      else if (path === '/me/progress' && (req.method === 'GET' || req.method === 'PUT')) response = await progress(req, env);
      else if (path === '/me/password' && req.method === 'POST') response = await setPassword(req, env);
      else response = json({ error: 'Not found.' }, 404);
    } catch (e) {
      // Never log tokens, email codes, Stripe bodies, or credentials.
      response = json({ error: e.status ? e.message : 'Service temporarily unavailable. Please try again.' }, e.status || 503);
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Vary', 'Origin');
    if (origin && origins(env).includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    return response;
  },
  async scheduled(event, env) {
    await env.DB.batch(['sessions', 'email_codes', 'rate_limits', 'checkout_locks'].map(table => query(env, `DELETE FROM ${table} WHERE expires_at<?`, now())));
  }
};
