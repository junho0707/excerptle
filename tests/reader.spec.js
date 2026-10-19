import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page, baseURL }) => {
  await page.clock.setFixedTime(new Date('2026-09-10T18:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('bookle.seenHowTo', '1'));
  await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
});

const same = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

test('tapping the excerpt reads it full screen, and Esc, the button and Back all close it', async ({ page }) => {
  await page.goto('/#/play/7');
  await expect(page.locator('#excerpt')).not.toHaveText('Loading…');
  await expect(page.locator('.reader-hint')).toBeVisible();
  await expect(page.locator('#excerpt')).toHaveAttribute('role', 'button');
  const text = () => page.locator('#excerpt').innerText();

  await page.locator('#excerpt').click();
  await expect(page.locator('#reader')).toBeVisible();
  expect(same(await page.locator('#reader-body').innerText(), await text())).toBe(true);
  await expect(page.locator('#reader-label')).toHaveText(await page.locator('#tier-label').textContent());
  await page.keyboard.press('Escape');
  await expect(page.locator('#reader')).toBeHidden();
  await expect(page.locator('#excerpt')).toBeFocused();

  // Keyboard opens it too.
  await page.keyboard.press('Enter');
  await expect(page.locator('#reader')).toBeVisible();
  await page.locator('#reader-close').click();
  await expect(page.locator('#reader')).toBeHidden();

  // The browser's Back button closes it rather than leaving the game.
  const url = page.url();
  await page.locator('#excerpt').click();
  await expect(page.locator('#reader')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#reader')).toBeHidden();
  expect(page.url()).toBe(url);
  await expect(page.locator('#guess-input')).toBeVisible();
});

test('the reader never shows more than the player has unlocked', async ({ page }) => {
  await page.goto('/#/play/7');
  await expect(page.locator('#excerpt')).not.toHaveText('Loading…');
  await page.locator('#excerpt').click();
  const before = (await page.locator('#reader-body').innerText()).length;
  await page.keyboard.press('Escape');
  await page.locator('#hint-btn').click();
  await page.locator('#excerpt').click();
  const afterHint = await page.locator('#reader-body').innerText();
  expect(same(afterHint, await page.locator('#excerpt').innerText())).toBe(true);
  expect(afterHint.length).toBeGreaterThanOrEqual(before);
  await expect(page.locator('#reader-label')).toHaveText(await page.locator('#tier-label').textContent());
});

test('selecting text in the excerpt does not open the reader', async ({ page }) => {
  await page.goto('/#/play/7');
  await expect(page.locator('#excerpt')).not.toHaveText('Loading…');
  // Dragging across the sentence ends in a click on the excerpt; with text
  // selected it must be left alone so the reader can copy a quotation.
  const box = await page.locator('#excerpt').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + 12, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => String(getSelection()))).not.toBe('');
  await expect(page.locator('#reader')).toBeHidden();
});

test('after the round the reader holds the full reading', async ({ page }) => {
  const puzzleResponse = page.waitForResponse(r => /\/puzzles\/[^/]+\.json$/.test(new URL(r.url()).pathname) && !r.url().endsWith('/index.json'));
  await page.goto('/#/play/7');
  const puzzle = await (await puzzleResponse).json();
  await page.locator('#guess-input').fill(puzzle.title);
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#result .verdict')).toContainText('Correct');
  await expect(page.locator('.reader-hint')).toBeVisible();
  await expect(page.locator('#excerpt')).not.toContainText('Loading the complete');
  await page.locator('#excerpt').click();
  expect(same(await page.locator('#reader-body').innerText(), await page.locator('#excerpt').innerText())).toBe(true);
});
