import { test, expect } from '@playwright/test';

// Use shipped puzzles and real UI handlers. Account services deliberately fail:
// playing another book must remain possible when signed out or auth is down.
for (const session of ['guest', 'expired', 'signed-in']) {
  for (const outcome of ['won', 'lost']) {
    test(`${session}: daily ${outcome} → random → book ID → new game → bank`, async ({ page, baseURL }) => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://**/*', route => {
        if (new URL(route.request().url()).origin === new URL(baseURL).origin) return route.continue();
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Unavailable"}' });
      });
      await page.clock.setFixedTime(new Date('2026-09-10T18:00:00Z'));
      await page.addInitScript(({ session }) => {
        Math.random = () => 0.25;
        if (session !== 'guest') localStorage.setItem('bookle.auth.session', JSON.stringify({
          uid: 'flow-test', email: 'flow@example.test', token: 'invalid-test-token',
          expiresAt: session === 'expired' ? 1 : 4102444800,
        }));
      }, { session });
      const puzzles = new Map();
      page.on('response', async response => {
        if (/\/puzzles\/[^/]+\.json$/.test(new URL(response.url()).pathname)) {
          const puzzle = await response.json().catch(() => null);
          if (puzzle?.title) puzzles.set(puzzle.id, puzzle);
        }
      });
      await page.goto('/');
      await expect(page.locator('#excerpt')).not.toHaveText('Loading…');
      await page.locator('#modal [data-act="close-modal"]').last().click();
      const daily = await page.locator('#meta-left').innerText();
      await expect.poll(() => puzzles.size).toBeGreaterThan(0);
      const answer = [...puzzles.values()][0].title;
      for (let i = 0; i < (outcome === 'won' ? 1 : 6); i++) {
        await page.locator('#guess-input').fill(outcome === 'won' ? answer : `zzzznonbook ${i}`);
        await page.locator('#form button[type="submit"]').click();
      }
      await expect(page.locator('#result .verdict')).toContainText(outcome === 'won' ? 'Correct' : 'Out of guesses');
      await page.reload();
      await expect(page.locator('#result .verdict')).toContainText(outcome === 'won' ? 'Correct' : 'Out of guesses');
      await page.locator('#more [data-act="play-random"]').click();
      await expect(page.locator('#meta-left')).not.toHaveText(daily);
      await playable(page);
      await page.locator('#jump-input').fill('0');
      await page.locator('#jump-form button').click();
      await expect(page).toHaveURL(/#\/play\/0$/);
      await playable(page);
      await page.goto('/#/new');
      await expect(page.locator('#modal h2')).toHaveText('New game');
      await page.locator('[data-act="pick-random"]').click();
      await playable(page);
      await page.goto('/#/new');
      await page.locator('#play-id-input').fill('42');
      await page.locator('[data-act="pick-id"]').click();
      await expect(page).toHaveURL(/#\/play\/42$/);
      await playable(page);
      await page.goto('/#/bank');
      await page.locator('#bank-grid a[href="#/play/1"]').click();
      await playable(page);
      await page.locator('#guess-input').fill('a deliberately wrong title');
      await page.locator('#form button[type="submit"]').click();
      await expect(page.locator('#guesses li')).toHaveCount(1);
      await page.reload();
      await expect(page.locator('#guesses li')).toHaveCount(1);
      expect(errors).toEqual([]);
    });
  }
}

async function playable(page) {
  await expect(page.locator('#modal')).toBeHidden();
  await expect(page.locator('#guess-input')).toBeVisible();
  await expect(page.locator('#guess-input')).toBeEnabled();
  await expect(page.locator('#excerpt')).not.toHaveText('Loading…');
  await expect(page.locator('#result')).toBeHidden();
}

test('signing in after solving removes the sign-in offer and allows another round', async ({ page, baseURL }) => {
  await page.clock.setFixedTime(new Date('2026-09-10T18:00:00Z'));
  await page.route('https://**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(baseURL).origin) return route.continue();
    const responses = {
      '/auth/check': { account: true, hasPassword: false },
      '/auth/email': { ok: true },
      '/auth/verify': { uid: 'flow-test', email: 'flow@example.test', token: 'invalid-test-token', expiresAt: 4102444800, hasPassword: true },
    };
    const body = responses[url.pathname];
    return route.fulfill({ status: body ? 200 : 503, contentType: 'application/json', body: JSON.stringify(body || { error: 'Unavailable' }) });
  });
  const puzzleResponse = page.waitForResponse(response => /\/puzzles\/[^/]+\.json$/.test(new URL(response.url()).pathname) && !response.url().endsWith('/index.json'));
  await page.goto('/');
  const puzzle = await (await puzzleResponse).json();
  await page.locator('#modal [data-act="close-modal"]').last().click();
  await page.locator('#guess-input').fill(puzzle.title);
  await page.locator('#form button[type="submit"]').click();
  await page.locator('#result [data-act="open-auth"]').click();
  await page.locator('#auth-email').fill('flow@example.test');
  await page.locator('[data-act="auth-email"]').click();
  await page.locator('#auth-code').fill('123456');
  await page.locator('[data-act="auth-code"]').click();
  await expect(page.locator('#auth-tab')).toHaveText('flow');
  await expect(page.locator('#modal')).toBeHidden();
  await expect(page.locator('#result [data-act="open-auth"]')).toHaveCount(0);
  await page.locator('#more [data-act="play-random"]').click();
  await playable(page);
});

test('the previous guess field is unavailable while another book loads', async ({ page, baseURL }) => {
  await page.clock.setFixedTime(new Date('2026-09-10T18:00:00Z'));
  await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/');
  await page.locator('#modal [data-act="close-modal"]').last().click();
  await playable(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requested;
  const pending = new Promise(resolve => { requested = resolve; });
  await page.route('**/puzzles/*.json', async route => {
    requested();
    await gate;
    await route.continue();
  });
  await page.locator('#more [data-act="play-random"]').click();
  await pending;
  try {
    await expect(page.locator('#guess-input')).toBeHidden();
    await expect(page.locator('#excerpt')).toHaveText('Loading…');
  } finally {
    release();
  }
  await playable(page);
  await page.locator('#guess-input').fill('a deliberately wrong title');
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#guesses li')).toHaveCount(1);
});

test('giving up takes two taps, names the book, and survives a reload', async ({ page, baseURL }) => {
  await page.clock.setFixedTime(new Date('2026-09-10T18:00:00Z'));
  await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  const puzzleResponse = page.waitForResponse(r => /\/puzzles\/[^/]+\.json$/.test(new URL(r.url()).pathname) && !r.url().endsWith('/index.json'));
  await page.goto('/#/play/7');
  const puzzle = await (await puzzleResponse).json();
  await page.locator('#modal [data-act="close-modal"]').last().click();
  await playable(page);
  // One tap only arms it: a stray tap must not be able to end a round.
  await page.locator('#give-up').click();
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#msg')).toContainText('Tap again');
  // Any other move disarms it.
  await page.locator('[data-act="hint"]').click();
  await page.locator('#give-up').click();
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#give-up').click();
  await expect(page.locator('#result .verdict')).toContainText('Gave up');
  await expect(page.locator('#result .pg-book h2')).toContainText(puzzle.title.split(';')[0].slice(0, 12));
  await page.reload();
  await expect(page.locator('#result .verdict')).toContainText('Gave up');
  await expect(page.locator('#guess-input')).toBeHidden();
});

test('the author sits under the story box, not inside its scroll', async ({ page, baseURL }) => {
  await page.clock.setFixedTime(new Date('2026-09-10T18:00:00Z'));
  await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/#/play/7');
  await page.locator('#modal [data-act="close-modal"]').last().click();
  await playable(page);
  expect(await page.locator('#author-reveal').evaluate(el => !!el.closest('.excerpt-wrap'))).toBe(false);
  for (let i = 0; i < 5; i++) await page.locator('[data-act="hint"]').click();
  const reveal = page.locator('#author-reveal');
  await expect(reveal).toBeVisible();
  await expect(reveal).toContainText('Author:');
  // Visible where the page put it, with the story box left scrolled to the top.
  const wrap = await page.locator('.excerpt-wrap').boundingBox();
  const box = await reveal.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(wrap.y + wrap.height - 1);
  expect(await page.locator('.excerpt-wrap').evaluate(el => el.scrollTop)).toBe(0);
});

test('the bank narrows to the books this browser has finished', async ({ page, baseURL }) => {
  await page.clock.setFixedTime(new Date('2026-09-10T18:00:00Z'));
  await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  const puzzleResponse = page.waitForResponse(r => /\/puzzles\/[^/]+\.json$/.test(new URL(r.url()).pathname) && !r.url().endsWith('/index.json'));
  await page.goto('/#/play/5');
  const puzzle = await (await puzzleResponse).json();
  await page.locator('#modal [data-act="close-modal"]').last().click();
  await playable(page);
  await page.locator('#guess-input').fill(puzzle.title);
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#result .verdict')).toContainText('Correct');

  await page.goto('/#/bank');
  await expect(page.locator('#bank-grid a')).toHaveCount(100);
  await page.locator('#bank-status').selectOption('won');
  await expect(page.locator('#bank-grid a')).toHaveCount(1);
  await expect(page.locator('#bank-grid a')).toHaveAttribute('href', '#/play/5');
  await page.locator('#bank-status').selectOption('todo');
  await expect(page.locator('#bank-grid a[href="#/play/5"]')).toHaveCount(0);
  await expect(page.locator('#bank-grid a[href="#/play/4"]')).toHaveCount(1);
  await page.locator('#bank-status').selectOption('all');
  await expect(page.locator('#bank-grid a[href="#/play/5"]')).toHaveCount(1);
});
