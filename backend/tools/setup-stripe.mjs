// Run locally by the owner. Secrets are entered without echo and sent directly
// to Cloudflare; never written to source, temporary files, or command arguments.
import Stripe from 'stripe';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const api = 'https://excerptle-api.winter-glade-cbab.workers.dev';
const endpointUrl = `${api}/billing/webhook`;

async function secretPrompt() {
  if (!process.stdin.isTTY) throw new Error('Run this in an interactive terminal.');
  process.stdout.write('Paste your Stripe SANDBOX secret key (hidden), then press Enter: ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      process.stdin.off('data', input);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value.trim());
    }
    function input(chunk) {
      for (const c of chunk) {
        if (c === '\u0003') return finish(new Error('Cancelled.'));
        if (c === '\r' || c === '\n') return finish();
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    }
    process.stdin.on('data', input);
  });
}

try {
  console.log('This configures Excerptle in a Stripe sandbox. It cannot take live payments.');
  const key = await secretPrompt();
  if (!key.startsWith('sk_test_')) throw new Error('Use a sandbox secret key beginning sk_test_. Live keys are not accepted here.');
  const stripe = new Stripe(key, { apiVersion: '2025-08-27.basil' });
  let product;
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    if (p.metadata?.excerptle === 'pro') { product = p; break; }
  }
  product ||= await stripe.products.create({ name: 'Excerptle Pro', description: 'Removes ads from Excerptle.', metadata: { excerptle: 'pro' } }, { idempotencyKey: 'excerptle-pro-product-v1' });
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find(p => p.currency === 'usd' && p.unit_amount === 300 && p.recurring?.interval === 'month' && p.recurring.interval_count === 1);
  price ||= await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 300, recurring: { interval: 'month' } }, { idempotencyKey: 'excerptle-pro-monthly-usd-300-v1' });
  const portals = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  let portal = portals.data.find(p => p.metadata?.excerptle === 'pro');
  portal ||= await stripe.billingPortal.configurations.create({
    business_profile: { headline: 'Manage Excerptle Pro', privacy_policy_url: 'https://excerptle.io/#/legal', terms_of_service_url: 'https://excerptle.io/#/legal' },
    features: { payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end' } },
    metadata: { excerptle: 'pro' },
  }, { idempotencyKey: 'excerptle-pro-portal-v1' });
  // Never replace an existing endpoint silently: its secret is only returned on creation.
  for await (const hook of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (hook.url === endpointUrl) throw new Error('A webhook already exists for this API. Ask the coding agent to resume setup without replacing it.');
  }
  const hook = await stripe.webhookEndpoints.create({ url: endpointUrl, api_version: '2025-08-27.basil', enabled_events: ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'], metadata: { excerptle: 'pro' } });
  const result = spawnSync(process.execPath, [wrangler, 'secret', 'bulk', '--config', 'wrangler.toml'], {
    cwd: root, input: JSON.stringify({ STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: hook.secret, STRIPE_PRICE_ID: price.id, STRIPE_PORTAL_CONFIGURATION: portal.id }),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error('Cloudflare secret upload failed. Stripe resources were created. Tell the coding agent; do not paste any secret here.');
  console.log('Stripe sandbox connected. Secrets were stored in Cloudflare. Tell the coding agent: done.');
} catch (error) {
  // SDK errors can include request context; expose only controlled messages.
  if (error.type?.startsWith('Stripe')) console.error('Stripe setup failed. Check the sandbox key/account permissions and retry.');
  else console.error(error.message);
  process.exitCode = 1;
}
