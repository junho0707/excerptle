import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { Miniflare } from 'miniflare';
import Stripe from 'stripe';
import worker from '../src/worker.js';

let mf, env;
const originalFetch = globalThis.fetch;
const digest = s => createHash('sha256').update(s).digest('hex');
// What the browser sends: PBKDF2 output, hex. The Worker never sees the password.
const ITERATIONS = 600000;
const derive = (password, salt) => pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256').toString('hex');
const verifier = (key, salt) => digest(`excerptle-pwd-v2:${salt}:${key}`);
const token = 'a'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);
async function request(path, data, auth = false, origin = 'https://excerptle.io') {
  return worker.fetch(new Request(`https://api.example${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  }), env);
}
before(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'], compatibilityDate: '2026-05-01' });
  env = { DB: await mf.getD1Database('DB'), SITE_URL: 'https://excerptle.io', ALLOWED_ORIGINS: 'https://excerptle.io,http://localhost:8765', STRIPE_PRICE_ID: 'price_pro', STRIPE_YEARLY_PRICE_ID: 'price_yearly', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_LIVE: 'false', OTP_SECRET: 'unit-test-only', GOOGLE_CLIENT_ID: 'our-client' };
  const migrations = (await readdir(new URL('../migrations/', import.meta.url))).sort();
  for (const migration of migrations) {
    const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
    for (const statement of sql.split(';').filter(s => s.trim())) await env.DB.prepare(statement).run();
  }
  await env.DB.prepare('INSERT INTO users(id,email,name,google_sub,stripe_customer,created_at) VALUES(?,?,?,?,?,?)').bind('user1', 'one@example.com', 'One', null, 'cus_one', now()).run();
  await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(digest(token), 'user1', now()+3600).run();
});
after(async () => { globalThis.fetch = originalFetch; await mf?.dispose(); });

test('billing rejects absent, forged, and expired sessions; CORS rejects outsiders', async () => {
  assert.equal((await request('/billing/status')).status, 401);
  assert.equal((await request('/billing/checkout', { uid: 'user1' })).status, 401);
  assert.equal((await request('/billing/status', undefined, true, 'https://evil.test')).status, 403);
  const result = await request('/billing/status', undefined, true);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), 'https://excerptle.io');
  assert.equal((await result.json()).pro, false);
});
test('return URLs cannot redirect checkout to another site', async () => {
  assert.equal((await request('/billing/checkout', { returnUrl: 'https://evil.test' }, true)).status, 400);
});
test('progress uploads are allowed by the browser CORS preflight', async () => {
  const response = await worker.fetch(new Request('https://api.example/me/progress', {
    method: 'OPTIONS', headers: { Origin: 'https://excerptle.io', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' },
  }), env);
  assert.equal(response.status, 204);
  assert.ok(response.headers.get('Access-Control-Allow-Methods').split(',').map(s => s.trim()).includes('PUT'));
});
test('checkout accepts only the two server-configured billing intervals', async () => {
  assert.equal((await request('/billing/checkout', { returnUrl: 'https://excerptle.io', plan: 'lifetime' }, true)).status, 400);
});
test('email codes are atomic, single-use, and capped at five guesses', async () => {
  const email = 'otp@example.com';
  await env.DB.prepare('INSERT INTO email_codes VALUES(?,?,?,0)').bind(email, digest(`${env.OTP_SECRET}:${email}:123456`), now()+600).run();
  const responses = await Promise.all([request('/auth/verify', { email, code: '123456' }), request('/auth/verify', { email, code: '123456' })]);
  assert.deepEqual(responses.map(r=>r.status).sort(), [200,401]);
  const session = await responses.find(r=>r.status===200).json();
  assert.equal(session.token.length, 64);
  assert.ok(await env.DB.prepare('SELECT * FROM sessions WHERE token_hash=?').bind(digest(session.token)).first());
  await env.DB.prepare('INSERT INTO email_codes VALUES(?,?,?,0)').bind(email, digest(`${env.OTP_SECRET}:${email}:654321`), now()+600).run();
  for(let i=0;i<5;i++) assert.equal((await request('/auth/verify',{email,code:'000000'})).status,401);
  assert.equal((await request('/auth/verify',{email,code:'654321'})).status,401);
});
test('Google tokens issued to another app are rejected', async () => {
  globalThis.fetch = async () => Response.json({ aud: 'another-client', expires_in: 1000 });
  try { assert.equal((await request('/auth/google',{accessToken:'fake'})).status,401); }
  finally { globalThis.fetch = originalFetch; }
});
test('a sign-in code is only ever handed back on localhost, with no mail provider', async () => {
  await env.DB.prepare('DELETE FROM rate_limits').run();
  const ask = (e, origin, extra = {}) => worker.fetch(new Request('https://api.example/auth/email', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e })
  }), { ...env, RESEND_API_KEY: undefined, ...extra });

  // The opt-in alone does nothing away from localhost.
  const dev = { DEV_ECHO_CODES: 'true' };
  assert.equal((await (await ask('a@echo.test', 'http://localhost:8765', dev)).json()).devCode.length, 6);
  assert.equal((await ask('b@echo.test', 'https://excerptle.io', dev)).status, 503);
  assert.equal((await ask('c@echo.test', '', dev)).status, 503);
  // Nor does localhost without the opt-in.
  assert.equal((await ask('d@echo.test', 'http://localhost:8765')).status, 503);
  // And a configured mail provider rules it out however the rest is set.
  globalThis.fetch = async () => Response.json({ id: 'sent' });
  try {
    const live = await (await worker.fetch(new Request('https://api.example/auth/email', {
      method: 'POST', headers: { Origin: 'http://localhost:8765', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e@echo.test' })
    }), { ...env, RESEND_API_KEY: 'live-key', DEV_ECHO_CODES: 'true' })).json();
    assert.equal(live.devCode, undefined);
  } finally { globalThis.fetch = originalFetch; }
});
test('an email is checked before anything is sent, and a password signs in without one', async () => {
  await env.DB.prepare('DELETE FROM rate_limits').run();
  const email = 'pw@example.com';
  const salt = 'a'.repeat(32), salt2 = 'b'.repeat(32);
  const as = (tok, data) => worker.fetch(new Request('https://api.example/me/password', { method: 'POST', headers: { Origin: 'https://excerptle.io', Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), env);
  const check = async () => (await request('/auth/check', { email })).json();
  const key = derive('correct horse battery', salt);

  assert.deepEqual(await check(), { account: false, hasPassword: false, google: false });
  await env.DB.prepare('INSERT INTO email_codes VALUES(?,?,?,0)').bind(email, digest(`${env.OTP_SECRET}:${email}:111222`), now()+600).run();
  const first = await (await request('/auth/verify', { email, code: '111222' })).json();
  assert.equal(first.hasPassword, false);

  // No password yet: the only way in is still a code.
  assert.equal((await request('/auth/login', { email, key })).status, 401);
  // The iteration count is the whole scheme, so it is enforced, not trusted.
  assert.equal((await as(first.token, { key, salt, iterations: 1 })).status, 400);
  assert.equal((await as(first.token, { key, salt, iterations: 599999 })).status, 400);
  assert.equal((await as(first.token, { key: 'not-a-key', salt, iterations: ITERATIONS })).status, 400);
  assert.equal((await as(first.token, { key, salt: 'short', iterations: ITERATIONS })).status, 400);
  assert.equal((await as(first.token, { key, salt, iterations: ITERATIONS })).status, 200);

  // The stored row must not be the key itself: a leak has to stay uncrackable.
  const row = await env.DB.prepare('SELECT password_hash,password_salt FROM users WHERE email=?').bind(email).first();
  assert.equal(row.password_salt, `${ITERATIONS}:${salt}`);
  assert.notEqual(row.password_hash, key);
  assert.equal(row.password_hash, verifier(key, salt));

  // The browser is told where to derive from, and what it costs.
  assert.deepEqual(await check(), { account: true, hasPassword: true, google: false, kdf: { salt, iterations: ITERATIONS } });
  const params = await (await worker.fetch(new Request('https://api.example/auth/kdf', { headers: { Origin: 'https://excerptle.io' } }), env)).json();
  assert.ok(params.iterations >= ITERATIONS);

  assert.equal((await request('/auth/login', { email, key: derive('wrong password', salt) })).status, 401);
  const signedIn = await (await request('/auth/login', { email, key })).json();
  assert.equal(signedIn.provider, 'password');
  assert.equal(signedIn.hasPassword, true);
  assert.equal(signedIn.token.length, 64);
  assert.ok(await env.DB.prepare('SELECT * FROM sessions WHERE token_hash=?').bind(digest(signedIn.token)).first());

  // Five password writes per ten minutes is the real cap; this one test walks
  // through more than that on purpose.
  await env.DB.prepare('DELETE FROM rate_limits').run();

  // A stolen session token must not be enough to replace a password.
  const next = derive('another good one', salt2);
  assert.equal((await as(signedIn.token, { key: next, salt: salt2, iterations: ITERATIONS })).status, 401);
  assert.equal((await as(signedIn.token, { key: next, salt: salt2, iterations: ITERATIONS, currentKey: derive('nope', salt) })).status, 401);
  assert.equal((await as(signedIn.token, { key: next, salt: salt2, iterations: ITERATIONS, currentKey: key })).status, 200);
  assert.equal((await request('/auth/login', { email, key: next })).status, 200);
  assert.equal((await request('/auth/login', { email, key })).status, 401);

  // Removing it drops them back to email codes.
  assert.equal((await as(signedIn.token, { remove: true, currentKey: next })).status, 200);
  assert.equal((await request('/auth/login', { email, key: next })).status, 401);
  assert.equal((await check()).hasPassword, false);
});
test('password creation, scores, and progress are scoped to a verified session', async () => {
  assert.equal((await request('/auth/password', { email: 'password@example.com', key: 'x' })).status, 404);
  const authRequest = (path, data, method = 'POST') => worker.fetch(new Request(`https://api.example${path}`, { method, headers: { Origin: 'https://excerptle.io', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), env);
  assert.equal((await authRequest('/me/password', { key: derive('a secure password', 'c'.repeat(32)), salt: 'c'.repeat(32), iterations: ITERATIONS })).status, 200);
  assert.ok((await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind('user1').first()).password_hash);
  assert.equal((await authRequest('/scores', { puzzleIndex: 1001, guesses: 3, hints: 1, timeMs: 12000, win: true })).status, 200);
  const board = await (await request('/scores?puzzleIndex=1001&hints=1')).json();
  assert.equal(board.scores[0].name, 'One');
  assert.equal((await authRequest('/me/progress', { progress: { 1001: { status: 'won', guesses: ['Book'], hints: 1, at: 1234 } } }, 'PUT')).status, 200);
  const saved = await worker.fetch(new Request('https://api.example/me/progress', { headers: { Origin: 'https://excerptle.io', Authorization: `Bearer ${token}` } }), env);
  assert.equal((await saved.json()).progress[1001].status, 'won');
});
test('a signed-in player can change their display name without changing their score', async () => {
  const before = await (await request('/me/profile', undefined, true)).json();
  assert.deepEqual(before, { uid: 'user1', name: 'One' });
  const updated = await (await request('/me/profile', { name: '  New   Name  ' }, true)).json();
  assert.deepEqual(updated, { uid: 'user1', name: 'New Name' });
  const board = await (await request('/scores?puzzleIndex=1001&hints=1', undefined)).json();
  assert.equal(board.scores[0].name, 'New Name');
  assert.equal((await request('/me/profile', { name: 'x'.repeat(25) }, true)).status, 400);
});
test('signed webhooks activate Pro, reject tampering, survive duplicates and old events', async () => {
  let sub = { id:'sub_one', customer:'cus_one', status:'active', cancel_at_period_end:false, items:{data:[{price:{id:'price_pro'},current_period_end:now()+86400}]} };
  globalThis.fetch = async () => Response.json(sub);
  async function event(id, created, bad = false) {
    const payload = JSON.stringify({id,type:'customer.subscription.updated',created,livemode:false,data:{object:{id:'sub_one'}}});
    const signature = Stripe.webhooks.generateTestHeaderString({payload,secret:env.STRIPE_WEBHOOK_SECRET});
    return worker.fetch(new Request('https://api.example/billing/webhook',{method:'POST',headers:{'Stripe-Signature':signature},body:bad ? payload+' ' : payload}),env);
  }
  try {
    assert.equal((await event('evt_bad',100,true)).status,400);
    assert.equal((await event('evt_1',100)).status,200);
    assert.equal((await (await request('/billing/status',undefined,true)).json()).pro,true);
    assert.equal((await event('evt_1',100)).status,200);
    sub.status='canceled';
    assert.equal((await event('evt_2',200)).status,200);
    sub.status='active';
    assert.equal((await event('evt_old',100)).status,200);
    assert.equal((await (await request('/billing/status',undefined,true)).json()).pro,false);
  } finally { globalThis.fetch=originalFetch; }
});
// A session opened for one plan must never be handed back for the other: that
// charges a price the customer did not pick.
function stripeStub(openSessions) {
  const calls = { expired: [], created: [] };
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = new URLSearchParams(String(init?.body || ''));
    if (url.includes('/subscriptions')) return Response.json({ data: [], has_more: false });
    if (url.includes('/expire')) { calls.expired.push(url.split('/sessions/')[1].split('/')[0]); return Response.json({ id: 'expired' }); }
    if (url.includes('/prices/')) return Response.json({ id: url.split('/prices/')[1], active: true, currency: 'usd', unit_amount: 300, livemode: false, recurring: { interval: 'month', interval_count: 1 } });
    if (url.includes('/checkout/sessions') && init?.method === 'POST') { calls.created.push(body.get('metadata[plan]')); return Response.json({ url: 'https://checkout.stripe.com/fresh' }); }
    if (url.includes('/checkout/sessions')) return Response.json({ data: openSessions, has_more: false });
    throw new Error(`Unexpected Stripe call: ${url}`);
  };
  return calls;
}
test('checkout reuses an open session for the same plan only', async () => {
  stripeStub([{ id: 'cs_monthly', url: 'https://checkout.stripe.com/existing', metadata: { plan: 'monthly' } }]);
  try {
    const response = await request('/billing/checkout', { plan: 'monthly' }, true);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, 'https://checkout.stripe.com/existing');
    assert.equal((await (await request('/billing/status', undefined, true)).json()).pro, false);
  } finally { globalThis.fetch = originalFetch; }
});
test('checkout expires a session opened for the other plan instead of reusing it', async () => {
  const calls = stripeStub([{ id: 'cs_yearly', url: 'https://checkout.stripe.com/existing', metadata: { plan: 'yearly' } }]);
  try {
    const response = await request('/billing/checkout', { plan: 'monthly' }, true);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, 'https://checkout.stripe.com/fresh');
    assert.deepEqual(calls.expired, ['cs_yearly']);
    assert.deepEqual(calls.created, ['monthly']);
  } finally { globalThis.fetch = originalFetch; }
});
test('checkout expires a legacy session that carries no plan', async () => {
  const calls = stripeStub([{ id: 'cs_legacy', url: 'https://checkout.stripe.com/existing' }]);
  try {
    const response = await request('/billing/checkout', { plan: 'monthly' }, true);
    assert.equal((await response.json()).url, 'https://checkout.stripe.com/fresh');
    assert.deepEqual(calls.expired, ['cs_legacy']);
  } finally { globalThis.fetch = originalFetch; }
});
test('scores keep the lexicographically best result, including concurrent writes', async () => {
  const post = (hints, guesses) => request('/scores', { puzzleIndex: 499, hints, guesses, win: true }, true);
  assert.equal((await post(1, 6)).status, 200);
  assert.equal((await post(2, 1)).status, 200);
  let rows = (await (await request('/scores?puzzleIndex=499')).json()).scores;
  assert.deepEqual(rows.map(({ hints, guesses }) => [hints, guesses]), [[1, 6]]);
  const responses = await Promise.all([post(0, 6), post(1, 1), post(0, 3)]);
  assert.ok(responses.every(r => r.status === 200));
  rows = (await (await request('/scores?puzzleIndex=499')).json()).scores;
  assert.deepEqual(rows.map(({ hints, guesses }) => [hints, guesses]), [[0, 3]]);
});
test('one public leaderboard spans clue-system versions', async () => {
  const post = (hintVersion, hints, guesses) => request('/scores', { puzzleIndex: 498, hintVersion, hints, guesses, win: true }, true);
  assert.equal((await post(1, 2, 2)).status, 200);
  assert.equal((await post(2, 1, 4)).status, 200);
  // The old query parameter remains harmless for cached clients, but it must
  // not hide earlier players from the shared per-book board.
  const rows = (await (await request('/scores?puzzleIndex=498&hintVersion=2')).json()).scores;
  assert.deepEqual(rows.map(({ hints, guesses }) => [hints, guesses]), [[1, 4]]);
  assert.equal((await post(1, 5, 1)).status, 200);
  const afterWorseReplay = (await (await request('/scores?puzzleIndex=498')).json()).scores;
  assert.deepEqual(afterWorseReplay.map(({ hints, guesses }) => [hints, guesses]), [[1, 4]]);
});
test('a finished round is never overwritten by one still in progress', async () => {
  const put = data => worker.fetch(new Request('https://api.example/me/progress', { method: 'PUT', headers: { Origin: 'https://excerptle.io', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: data }) }), env);
  const stored = async () => (await (await worker.fetch(new Request('https://api.example/me/progress', { headers: { Origin: 'https://excerptle.io', Authorization: `Bearer ${token}` } }), env)).json()).progress[1002];

  assert.equal((await put({ 1002: { status: 'won', guesses: ['Dracula'], hints: 0, at: 5000 } })).status, 200);
  // The other device still has the book open, and its clock is later.
  assert.equal((await put({ 1002: { status: 'playing', guesses: ['Carmilla'], hints: 2, at: 9000 } })).status, 200);
  assert.equal((await stored()).status, 'won');
  // A finished round may still be replaced by a finished round.
  assert.equal((await put({ 1002: { status: 'lost', guesses: ['a', 'b', 'c', 'd', 'e', 'f'], hints: 5, at: 9500 } })).status, 200);
  assert.equal((await stored()).status, 'lost');
  // And an open round is still saved when nothing has finished.
  assert.equal((await put({ 1003: { status: 'playing', guesses: [], hints: 1, at: 1 } })).status, 200);
  assert.equal((await put({ 1003: { status: 'playing', guesses: ['Emma'], hints: 1, at: 2 } })).status, 200);
  const open = await (await worker.fetch(new Request('https://api.example/me/progress', { headers: { Origin: 'https://excerptle.io', Authorization: `Bearer ${token}` } }), env)).json();
  assert.deepEqual(open.progress[1003].guesses, ['Emma']);
  // Merely opening the book on another device is the lowest rank of all: a
  // newer empty round must not erase guesses either.
  assert.equal((await put({ 1003: { status: 'playing', guesses: [], hints: 0, at: 9999 } })).status, 200);
  const kept = await (await worker.fetch(new Request('https://api.example/me/progress', { headers: { Origin: 'https://excerptle.io', Authorization: `Bearer ${token}` } }), env)).json();
  assert.deepEqual(kept.progress[1003].guesses, ['Emma']);
  // A played round still replaces an older played round.
  assert.equal((await put({ 1003: { status: 'playing', guesses: ['Emma', 'Persuasion'], hints: 1, at: 10000 } })).status, 200);
  const later = await (await worker.fetch(new Request('https://api.example/me/progress', { headers: { Origin: 'https://excerptle.io', Authorization: `Bearer ${token}` } }), env)).json();
  assert.deepEqual(later.progress[1003].guesses, ['Emma', 'Persuasion']);
});
test('changing a password ends every other session but the caller\'s', async () => {
  await env.DB.prepare('DELETE FROM rate_limits').run();
  const other = 'b'.repeat(64);
  await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(digest(other), 'user1', now()+3600).run();
  const asOther = () => worker.fetch(new Request('https://api.example/billing/status', { headers: { Origin: 'https://excerptle.io', Authorization: `Bearer ${other}` } }), env);
  assert.equal((await asOther()).status, 200);

  const salt = 'd'.repeat(32);
  const next = derive('a third good password', salt);
  const current = derive('a secure password', 'c'.repeat(32));
  assert.equal((await request('/me/password', { key: next, salt, iterations: ITERATIONS, currentKey: current }, true)).status, 200);
  // The stolen token is gone; the one that made the change still works.
  assert.equal((await asOther()).status, 401);
  assert.equal((await request('/billing/status', undefined, true)).status, 200);

  // Removing the password revokes the others too.
  await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(digest(other), 'user1', now()+3600).run();
  assert.equal((await request('/me/password', { remove: true, currentKey: next }, true)).status, 200);
  assert.equal((await asOther()).status, 401);
  assert.equal((await request('/billing/status', undefined, true)).status, 200);
});
test('a replayed checkout key never hands back a dead Stripe session', async () => {
  const keys = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/subscriptions')) return Response.json({ data: [], has_more: false });
    if (url.includes('/prices/')) return Response.json({ id: 'price_pro', active: true, currency: 'usd', unit_amount: 300, livemode: false, recurring: { interval: 'month', interval_count: 1 } });
    if (url.includes('/checkout/sessions') && init?.method === 'POST') {
      keys.push(new Headers(init.headers).get('Idempotency-Key'));
      // What Stripe replays after monthly -> yearly -> monthly in one bucket:
      // the first key's session, already expired by the yearly request.
      return keys.length === 1
        ? Response.json({ status: 'expired', url: 'https://checkout.stripe.com/dead' })
        : Response.json({ status: 'open', url: 'https://checkout.stripe.com/fresh' });
    }
    if (url.includes('/checkout/sessions')) return Response.json({ data: [], has_more: false });
    throw new Error(`Unexpected Stripe call: ${url}`);
  };
  try {
    const response = await request('/billing/checkout', { plan: 'monthly' }, true);
    assert.equal((await response.json()).url, 'https://checkout.stripe.com/fresh');
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  } finally { globalThis.fetch = originalFetch; }
});
test('logout revokes the server token', async () => {
  assert.equal((await request('/auth/logout',{},true)).status,200);
  assert.equal((await request('/billing/status',undefined,true)).status,401);
});
