// Adds the $20/year price to the existing Excerptle Stripe sandbox product.
// The key is hidden and never saved locally.
import Stripe from 'stripe';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

async function prompt() {
  if (!process.stdin.isTTY) throw new Error('Run this in an interactive terminal.');
  process.stdout.write('Paste your Stripe SANDBOX secret key (hidden), then press Enter: ');
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = error => { process.stdin.off('data', input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); error ? reject(error) : resolve(value.trim()); };
    const input = chunk => { for (const char of chunk) { if (char === '\u0003') return done(new Error('Cancelled.')); if (char === '\r' || char === '\n') return done(); if (char === '\u007f' || char === '\b') value = value.slice(0, -1); else value += char; } };
    process.stdin.on('data', input);
  });
}

try {
  const key = await prompt();
  if (!key.startsWith('sk_test_')) throw new Error('Use a sandbox key beginning sk_test_.');
  const stripe = new Stripe(key, { apiVersion: '2025-08-27.basil' });
  let product;
  for await (const p of stripe.products.list({ active: true, limit: 100 })) if (p.metadata?.excerptle === 'pro') { product = p; break; }
  if (!product) throw new Error('Excerptle Pro was not found. Run setup-stripe.mjs first.');
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let yearly = prices.data.find(p => p.currency === 'usd' && p.unit_amount === 2000 && p.recurring?.interval === 'year' && p.recurring.interval_count === 1);
  yearly ||= await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 2000, recurring: { interval: 'year' } }, { idempotencyKey: 'excerptle-pro-yearly-usd-2000-v1' });
  const upload = spawnSync(process.execPath, [wrangler, 'secret', 'put', 'STRIPE_YEARLY_PRICE_ID', '--config', 'wrangler.toml'], { cwd: root, input: `${yearly.id}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (upload.status !== 0) throw new Error('Cloudflare update failed. The yearly price exists; tell the coding agent.');
  console.log('Excerptle Pro yearly ($20/year) is connected to the sandbox API.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
