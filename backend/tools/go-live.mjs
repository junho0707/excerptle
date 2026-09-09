// One-shot cutover from the Stripe sandbox to live payments, run locally by
// the owner.  Creates the live product, both prices, the Portal configuration
// and the webhook endpoint, stores every credential straight into Cloudflare,
// flips STRIPE_LIVE and redeploys.  The key is hidden, never written to disk,
// never passed as a command argument.
//
// Secrets and STRIPE_LIVE must land together: the Worker rejects a price or a
// webhook event whose livemode disagrees with STRIPE_LIVE, so a half-done
// cutover takes no payments at all.
import Stripe from 'stripe';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const config = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
const api = 'https://excerptle-api.winter-glade-cbab.workers.dev';
const endpointUrl = `${api}/billing/webhook`;

async function hidden(label) {
  if (!process.stdin.isTTY) throw new Error('Run this in an interactive terminal.');
  process.stdout.write(label);
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = error => { process.stdin.off('data', input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); error ? reject(error) : resolve(value.trim()); };
    const input = chunk => { for (const char of chunk) { if (char === '\u0003') return done(new Error('Cancelled.')); if (char === '\r' || char === '\n') return done(); if (char === '\u007f' || char === '\b') value = value.slice(0, -1); else value += char; } };
    process.stdin.on('data', input);
  });
}
function run(args, { onError, ...options } = {}) {
  const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'], ...options });
  if (result.status !== 0) throw new Error(onError || `Wrangler failed: ${args[0]} ${args[1] || ''}`.trim());
  return result;
}

try {
  console.log('This switches Excerptle to LIVE Stripe payments on the existing API Worker.\n');
  const key = await hidden('Paste your Stripe LIVE secret key (hidden), then press Enter: ');
  if (key.startsWith('sk_test_')) throw new Error('That is a sandbox key. This script is for the live cutover; use setup-stripe.mjs for the sandbox.');
  if (!key.startsWith('sk_live_') && !key.startsWith('rk_live_')) throw new Error('Expected a live secret key beginning sk_live_.');
  const stripe = new Stripe(key, { apiVersion: '2025-08-27.basil' });

  // Stripe accepts a live key before the business is activated, but every
  // charge then fails.  Catch that here rather than at the first customer.
  const account = await stripe.accounts.retrieve();
  if (!account.charges_enabled) throw new Error('This Stripe account cannot take charges yet. Finish Dashboard -> Activate payments (business details, bank account, tax), then rerun.');

  let product;
  for await (const p of stripe.products.list({ active: true, limit: 100 })) if (p.metadata?.excerptle === 'pro') { product = p; break; }
  product ||= await stripe.products.create({ name: 'Excerptle Pro', description: 'Removes ads from Excerptle.', metadata: { excerptle: 'pro' } }, { idempotencyKey: 'excerptle-pro-product-live-v1' });

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const find = (amount, interval) => prices.data.find(p => p.currency === 'usd' && p.unit_amount === amount && p.recurring?.interval === interval && p.recurring.interval_count === 1);
  const monthly = find(300, 'month') || await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 300, recurring: { interval: 'month' } }, { idempotencyKey: 'excerptle-pro-monthly-usd-300-live-v1' });
  const yearly = find(2000, 'year') || await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 2000, recurring: { interval: 'year' } }, { idempotencyKey: 'excerptle-pro-yearly-usd-2000-live-v1' });

  const portals = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const portal = portals.data.find(p => p.metadata?.excerptle === 'pro') || await stripe.billingPortal.configurations.create({
    business_profile: { headline: 'Manage Excerptle Pro', privacy_policy_url: 'https://excerptle.io/#/legal', terms_of_service_url: 'https://excerptle.io/#/legal' },
    features: { payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end' } },
    metadata: { excerptle: 'pro' },
  }, { idempotencyKey: 'excerptle-pro-portal-live-v1' });

  // A webhook secret is returned only when the endpoint is created, so an
  // existing endpoint is never replaced silently.
  for await (const existing of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (existing.url === endpointUrl) throw new Error('A live webhook already exists for this API. Delete it in the Dashboard first, or ask the coding agent to resume without replacing it.');
  }
  const hook = await stripe.webhookEndpoints.create({ url: endpointUrl, api_version: '2025-08-27.basil', enabled_events: ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'], metadata: { excerptle: 'pro' } });

  // Sandbox customer and subscription rows would outrank the live ones this
  // account is about to create, so they go before the first real payment.
  // Accounts, sessions and game data are untouched.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nClear sandbox subscription/customer rows from the production database? Accounts and game progress are kept. Type WIPE to confirm, anything else to skip: ');
  rl.close();
  if (answer.trim() === 'WIPE') {
    run(['d1', 'execute', 'DB', '--remote', '--config', 'wrangler.toml', '--command',
      'DELETE FROM subscriptions; DELETE FROM stripe_events; DELETE FROM checkout_locks; UPDATE users SET stripe_customer=NULL;']);
    console.log('Sandbox billing rows cleared.');
  } else {
    console.log('Skipped. Sandbox rows remain; verify no test customer is treated as a live subscriber.');
  }

  run(['secret', 'bulk', '--config', 'wrangler.toml'], {
    input: JSON.stringify({ STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: hook.secret, STRIPE_PRICE_ID: monthly.id, STRIPE_YEARLY_PRICE_ID: yearly.id, STRIPE_PORTAL_CONFIGURATION: portal.id }),
    stdio: ['pipe', 'pipe', 'pipe'],
    onError: 'Cloudflare secret upload failed. The live Stripe resources exist. Tell the coding agent; do not paste any secret here.',
  });

  const toml = readFileSync(config, 'utf8');
  if (!/^STRIPE_LIVE = "false"$/m.test(toml)) throw new Error('STRIPE_LIVE is not "false" in wrangler.toml. Secrets are stored; set it to "true" and deploy by hand.');
  writeFileSync(config, toml.replace(/^STRIPE_LIVE = "false"$/m, 'STRIPE_LIVE = "true"'));
  run(['deploy', '--config', 'wrangler.toml']);

  console.log('\nLive payments are on. Monthly', monthly.id, '/ yearly', yearly.id);
  console.log('Commit wrangler.toml (STRIPE_LIVE = "true"), then make one real purchase and refund it to confirm the webhook.');
} catch (error) {
  // Stripe SDK errors can carry request context; only controlled text is shown.
  if (error.type?.startsWith('Stripe')) console.error('Stripe cutover failed. Check the live key, account permissions, and that payments are activated.');
  else console.error(error.message);
  process.exitCode = 1;
}
