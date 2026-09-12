import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page, baseURL }) => {
  await page.clock.setFixedTime(new Date('2026-09-10T18:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('bookle.seenHowTo', '1'));
  await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
});

test('a late puzzle response cannot replace a newer book or write its progress', async ({ page }) => {
  await page.goto('/#/play/0');
  await expect(page.locator('#meta-left')).toHaveText('Book bank #0');
  const index = await page.evaluate(() => fetch('/puzzles/index.json').then(r => r.json()));
  let release, requested;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { requested = resolve; });
  await page.route(`**/puzzles/${index.order[1]}.json`, async route => {
    requested(); await gate; await route.continue();
  });
  await page.evaluate(() => { location.hash = '#/play/1'; });
  await pending;
  await page.evaluate(() => { location.hash = '#/play/2'; });
  await expect(page.locator('#meta-left')).toHaveText('Book bank #2');
  const oldResponse = page.waitForResponse(r => r.url().endsWith(`/${index.order[1]}.json`));
  release();
  await oldResponse;
  await page.locator('#guess-input').fill('a wrong title');
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#meta-left')).toHaveText('Book bank #2');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bookle.progress.v4')));
  expect(saved['2'].puzzleId).toBe(index.order[2]);
  expect(saved['1']).toBeUndefined();
});

test('failed puzzle loads explain recovery and another book still works', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/puzzles/*.json', route => route.request().url().endsWith('/index.json')
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/#/play/0');
  await expect(page.locator('#excerpt')).toContainText('Could not load this book');
  await expect(page.locator('#guess-input')).toBeHidden();
  await page.unroute('**/puzzles/*.json');
  await page.locator('[data-act="play-random"]').click();
  await expect(page.locator('#guess-input')).toBeVisible();
  expect(errors).toEqual([]);
});

test('shared standings are numbers, never executable markup', async ({ page }) => {
  const payload = Buffer.from(JSON.stringify({ v: 2, c: 1, w: 1, g: 1, n: 'Reader',
    br: '<img src=x onerror="window.injected=1">', bn: '<b id="injected">100</b>' })).toString('base64url');
  await page.goto(`/?p=0&s=${payload}`);
  await expect(page.locator('#modal')).toBeVisible();
  await expect(page.locator('#modal img, #injected')).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('leaderboard links select the requested book on every visit', async ({ page }) => {
  await page.goto('/#/ranks?i=0');
  await expect(page.locator('#lb-index')).toHaveValue('0');
  await page.evaluate(() => { location.hash = '#/ranks?i=42'; });
  await expect(page.locator('#lb-index')).toHaveValue('42');
});

test('a returning account restores remote guesses and sign-out clears the active round', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bookle.auth.session', JSON.stringify({
    uid: 'sync-test', email: 'sync@example.test', token: 'test-token', expiresAt: 4102444800,
  })));
  const index = await (await page.request.get('/puzzles/index.json')).json();
  const uploaded = [];
  await page.route('**/me/progress', route => {
    if (route.request().method() === 'PUT') {
      uploaded.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { progress: { 0: { puzzleId: index.order[0], mode: 'preset', status: 'playing', guesses: ['remote guess'], hints: 1, at: 1 } } } });
  });
  await page.goto('/#/play/0');
  await expect(page.locator('#guesses li')).toHaveText('1🟨remote guess');
  await expect(page.locator('#count-hints')).toHaveText('1/5');
  await expect.poll(() => uploaded.length).toBeGreaterThan(0);
  expect(uploaded.every(body => body.progress['0']?.guesses?.includes('remote guess'))).toBe(true);
  await page.evaluate(() => window.BookleAuth.signOut());
  await expect(page.locator('#auth-tab')).toHaveText('Sign in');
  await expect(page.locator('#guess-input')).toBeVisible();
  await expect(page.locator('#guesses li')).toHaveCount(0);
  await page.locator('#guess-input').fill('guest guess');
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#guesses li')).toHaveText('1🟨guest guess');
});

test('a score the server took is stamped, so the next load does not resend it', async ({ page, baseURL }) => {
  const API = 'https://excerptle-api.winter-glade-cbab.workers.dev';
  const posts = [];
  await page.route(`${API}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/scores' && route.request().method() === 'POST') {
      posts.push(JSON.parse(route.request().postData()));
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    const body = path === '/scores' ? '{"scores":[]}' : path === '/me/progress' ? '{"progress":{}}' : '{}';
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await page.addInitScript(() => localStorage.setItem('bookle.auth.session', JSON.stringify({
    uid: 'sweep', email: 'sweep@example.test', name: 'Sweep', token: 'tok', expiresAt: 4102444800,
  })));
  const puzzleResponse = page.waitForResponse(r => /\/puzzles\/[^/]+\.json$/.test(new URL(r.url()).pathname) && !r.url().endsWith('/index.json'));
  await page.goto('/#/play/9');
  const puzzle = await (await puzzleResponse).json();
  await page.locator('#guess-input').fill(puzzle.title);
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#result .verdict')).toContainText('Correct');
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ puzzleIndex: 9, guesses: 1, hints: 0, win: true });
  // Stamped, which is what keeps the sign-in backfill from replaying the same
  // twenty rows forever while a longer backlog never reaches a board.
  // Signed in, so the board lives under the account's own key — a guest's
  // rounds and this account's must never share a bucket on a shared browser.
  await expect.poll(() => page.evaluate(() =>
    ((JSON.parse(localStorage.getItem('bookle.lb.v4.account:sweep') || 'null') || {})['9'] || [])
      .filter(r => r.sent === 1).length)).toBe(1);
  await page.reload();
  await expect(page.locator('#result .verdict')).toContainText('Correct');
  await page.waitForTimeout(500);
  expect(posts).toHaveLength(1);
});

test('a better result from another device does not list the player twice', async ({ page }) => {
  const API = 'https://excerptle-api.winter-glade-cbab.workers.dev';
  await page.route(`${API}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    // What the server holds: this account's best row, earned elsewhere.
    const body = path === '/scores'
      ? '{"scores":[{"name":"Sweep","playerId":"dupe","hints":0,"guesses":2,"at":1757000000000}]}'
      : path === '/me/progress' ? '{"progress":{}}' : '{}';
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await page.addInitScript(() => {
    localStorage.setItem('bookle.auth.session', JSON.stringify({
      uid: 'dupe', email: 'dupe@example.test', name: 'Sweep', token: 'tok', expiresAt: 4102444800,
    }));
    localStorage.setItem('bookle.playerId', 'local-player');
    // The same person's earlier, worse solve — already uploaded from here.
    localStorage.setItem('bookle.lb.v4.account:dupe', JSON.stringify({
      9: [{ id: 'local-player', playerId: 'dupe', name: 'Sweep', hints: 3, guesses: 4, win: true, sent: 1, at: 1756000000000 }],
    }));
  });
  await page.goto('/#/ranks?i=9');
  await expect(page.locator('#lb-body tbody tr')).toHaveCount(1);
  await expect(page.locator('#lb-body tbody tr.you td').nth(2)).toHaveText('0');
});

test('an account already signed in keeps its unscoped board and streak', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bookle.auth.session', JSON.stringify({
      uid: 'legacy', email: 'legacy@example.test', name: 'Legacy', token: 'tok', expiresAt: 4102444800,
    }));
    // Written by the build that shipped before play data was namespaced.
    localStorage.setItem('bookle.lb.v4', JSON.stringify({
      9: [{ id: 'legacy-player', name: 'Legacy', hints: 1, guesses: 2, win: true, at: 1756000000000 }],
    }));
    // The first two dailies, 2026-09-09 and 2026-09-10 — a live streak of two.
    localStorage.setItem('bookle.progress.v4', JSON.stringify({
      600: { puzzleId: 'x', mode: 'daily', status: 'won', guesses: ['a'], hints: 1, at: 1756000000000 },
      601: { puzzleId: 'y', mode: 'daily', status: 'won', guesses: ['b'], hints: 0, at: 1757000000000 },
    }));
  });
  await page.goto('/#/stats');
  const daily = page.locator('.s-block', { has: page.locator('h2:text-is("Daily")') });
  await expect(daily.locator('.stat-grid div').nth(1)).toContainText('2');
  await expect(daily.locator('.stat-grid div').nth(2)).toContainText('2');
  expect(await page.evaluate(() =>
    JSON.parse(localStorage.getItem('bookle.lb.v4.account:legacy'))['9'][0].hints)).toBe(1);
  expect(await page.evaluate(() =>
    JSON.parse(localStorage.getItem('bookle.progress.v4.account:legacy'))['601'].status)).toBe('won');
});
