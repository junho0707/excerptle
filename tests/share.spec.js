import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await page.clock.setFixedTime(new Date('2026-09-10T18:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('bookle.seenHowTo', '1');
    // The native sheet must never be used, even where it exists.
    window.__shared = 0;
    navigator.share = async () => { window.__shared++; };
  });
  await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
});

test('Share copies the link, shows a Link copied toast, and leaves the label alone', async ({ page }) => {
  await page.goto('/#/play/4');
  await expect(page.locator('#guess-input')).toBeVisible();
  const share = page.locator('#share-playing');
  await share.click();
  const toast = page.locator('#toast');
  await expect(toast).toHaveText('Link copied');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toHaveClass(/on/);
  await expect(share).toHaveText('Share');
  expect(await page.evaluate(() => window.__shared)).toBe(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\?p=4&s=/);
  // Gone after about two seconds.
  await expect(toast).not.toHaveClass(/on/, { timeout: 4000 });
});

test('when copying is impossible the toast carries the link', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } } });
    document.execCommand = () => false;
  });
  await page.goto('/#/play/4');
  await page.locator('#share-playing').click();
  await expect(page.locator('#toast')).toContainText('Couldn’t copy — link: ');
  await expect(page.locator('#toast')).toContainText('?p=4&s=');
});

test('the static pages copy the site link with the same toast', async ({ page }) => {
  await page.goto('/about.html');
  const btn = page.locator('[data-share]');
  const label = await btn.textContent();
  await btn.click();
  await expect(page.locator('#toast')).toHaveText('Link copied');
  await expect(btn).toHaveText(label);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://excerptle.io/');
  expect(await page.evaluate(() => window.__shared)).toBe(0);
});
