import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page, baseURL }) => {
  // 2026-10-19 Pacific is daily #640 (#600 was 2026-09-09).
  await page.clock.setFixedTime(new Date('2026-10-19T18:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('bookle.seenHowTo', '1');
    localStorage.setItem('bookle.progress.v4', JSON.stringify({
      622: { puzzleId: 'x', mode: 'daily', status: 'won', guesses: ['a'], hints: 0, at: 1 },
      625: { puzzleId: 'y', mode: 'daily', status: 'lost', guesses: ['a', 'b', 'c', 'd', 'e', 'f'], hints: 2, at: 2 },
      630: { puzzleId: 'z', mode: 'daily', status: 'playing', guesses: ['q'], hints: 0, at: 3 },
    }));
  });
  await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
});

test('the stats calendar colours solved and missed dailies, and days are not links', async ({ page }) => {
  await page.goto('/#/stats');
  await expect(page.locator('.cal-month')).toHaveText('October 2026');
  await expect(page.locator('.cal-day.won')).toHaveCount(1);
  await expect(page.locator('.cal-day.lost')).toHaveCount(1);
  await expect(page.locator('.cal-day.play')).toHaveCount(1);
  await expect(page.locator('.cal-day.today')).toHaveAttribute('aria-label', 'October 19, not played');
  await expect(page.locator('.cal-day.won')).toHaveAttribute('aria-label', 'October 1, solved');
  await expect(page.locator('.cal-day.lost')).toHaveAttribute('aria-label', 'October 4, missed');
  // Days after today are muted and are not links.
  await expect(page.locator('.cal-day.off').last()).toHaveText('31');
  await expect(page.locator('a.cal-day')).toHaveCount(0);
});

test('the calendar steps between the first daily month and this one, and no further', async ({ page }) => {
  await page.goto('/#/stats');
  const next = page.locator('[data-act="cal-next"]');
  const prev = page.locator('[data-act="cal-prev"]');
  await expect(next).toBeDisabled();
  await prev.click();
  await expect(page.locator('.cal-month')).toHaveText('September 2026');
  await expect(prev).toBeDisabled();
  // Before the 9th there was no daily; from the 9th on every day is playable.
  await expect(page.locator('.cal-day.off')).toHaveCount(8);
  await expect(page.locator('.cal-day:not(.off)')).toHaveCount(22);
  await next.click();
  await expect(page.locator('.cal-month')).toHaveText('October 2026');
});
