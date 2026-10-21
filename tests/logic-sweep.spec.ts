import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page, baseURL }) => {
  await page.clock.setFixedTime(new Date('2026-09-10T18:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('bookle.seenHowTo', '1'));
  await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(baseURL!).origin
    ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
});

test('a late puzzle response cannot replace a newer book or write its progress', async ({ page }) => {
  await page.goto('/#/play/0');
  await expect(page.locator('#meta-left')).toHaveText('Book bank #0');
  const index = await page.evaluate(() => fetch('/puzzles/index.json').then(r => r.json()));
  let release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { requested = resolve; });
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
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bookle.progress.v4')!));
  expect(saved['2'].puzzleId).toBe(index.order[2]);
  expect(saved['1']).toBeUndefined();
});

test('failed puzzle loads explain recovery and another book still works', async ({ page }) => {
  const errors: string[] = [];
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

test('a shared result is text, never executable markup, and old standings fields are ignored', async ({ page }) => {
  // Links made while the leaderboard existed carry br/bn/or/on, and m=battle.
  const payload = Buffer.from(JSON.stringify({ v: 2, c: 1, w: 1, g: 1, m: 'battle', n: '<img src=x onerror="window.injected=1">',
    br: '<img src=x onerror="window.injected=1">', bn: '<b id="injected">100</b>' })).toString('base64url');
  await page.goto(`/?p=0&s=${payload}`);
  await expect(page.locator('#modal')).toBeVisible();
  await expect(page.locator('#modal img, #injected')).toHaveCount(0);
  await expect(page.locator('#modal .sc-who')).toContainText('Book #0');
  await expect(page.locator('#modal .sc-rank')).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('a returning account restores remote guesses and sign-out clears the active round', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bookle.auth.session', JSON.stringify({
    uid: 'sync-test', email: 'sync@example.test', token: 'test-token', expiresAt: 4102444800,
  })));
  const index = await (await page.request.get('/puzzles/index.json')).json();
  const uploaded: { progress: Record<string, { guesses?: string[] } | undefined> }[] = [];
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

test('an account already signed in keeps its unscoped progress and streak', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bookle.auth.session', JSON.stringify({
      uid: 'legacy', email: 'legacy@example.test', name: 'Legacy', token: 'tok', expiresAt: 4102444800,
    }));
    // Written by the build that shipped before play data was namespaced.
    // The first two dailies, 2026-09-09 and 2026-09-10 — a live streak of two.
    localStorage.setItem('bookle.progress.v4', JSON.stringify({
      600: { puzzleId: 'x', mode: 'daily', status: 'won', guesses: ['a'], hints: 1, at: 1756000000000 },
      601: { puzzleId: 'y', mode: 'daily', status: 'won', guesses: ['b'], hints: 0, at: 1757000000000 },
    }));
  });
  await page.goto('/#/stats');
  const overall = page.locator('.s-block', { has: page.locator('h2:text-is("Overall progress")') });
  await expect(overall.locator('.stat-grid div').nth(1)).toContainText('2');
  expect(await page.evaluate(() =>
    JSON.parse(localStorage.getItem('bookle.progress.v4.account:legacy')!)['601'].status)).toBe('won');
});

test('a streak that arrives from the server repaints the stats screen', async ({ page }) => {
  const API = 'https://excerptle-api.winter-glade-cbab.workers.dev';
  // The first two dailies, won on another device and held only by the server.
  await page.route(`${API}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/me/progress' && route.request().method() === 'PUT') return route.fulfill({ json: { ok: true } });
    const body = path === '/me/progress'
      ? '{"progress":{"600":{"status":"won","guesses":["a"],"hints":0,"at":1},"601":{"status":"won","guesses":["b"],"hints":0,"at":2}}}'
      : path === '/scores' ? '{"scores":[]}' : '{}';
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await page.addInitScript(() => localStorage.setItem('bookle.auth.session', JSON.stringify({
    uid: 'sync-stats', email: 'stats@example.test', name: 'Stats', token: 'tok', expiresAt: 4102444800,
  })));
  await page.goto('/#/stats');
  const overall = page.locator('.s-block', { has: page.locator('h2:text-is("Overall progress")') });
  // Landing straight on Stats, with nothing local: the numbers must arrive.
  await expect(overall.locator('.stat-grid div').nth(1)).toContainText('2');
});

test('retired routes land on a working daily instead of a blank screen', async ({ page }) => {
  for (const url of ['/#/ranks?i=3', '/#/battle/abc123', '/#/support', '/#/pro', '/?b=abc123']) {
    await page.goto(url);
    await expect(page.locator('#guess-input')).toBeVisible();
    await expect(page.locator('#meta-left')).toHaveText('Daily #601');
    expect(new URL(page.url()).hash).toBe(url.startsWith('/#') ? '#/' : '');
  }
  // An old invite that names a book plays that book.
  await page.goto('/?b=abc123&p=7');
  await expect(page.locator('#meta-left')).toHaveText('Book bank #7');
});

test('the post-game card offers Share and the full book, with no chapter-size or Gutenberg rows', async ({ page }) => {
  const puzzleResponse = page.waitForResponse(r => /\/puzzles\/[^/]+\.json$/.test(new URL(r.url()).pathname) && !r.url().endsWith('/index.json'));
  await page.goto('/#/play/4');
  const puzzle = await (await puzzleResponse).json();
  await page.locator('#guess-input').fill(puzzle.title);
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#result .verdict')).toContainText('Correct');
  const actions = page.locator('#result .pg-actions .btn');
  await expect(actions).toHaveText(['Share', 'Read the full book →']);
  await expect(actions.nth(1)).toHaveAttribute('href', puzzle.source.url);
  await expect(actions.nth(1)).toHaveAttribute('target', '_blank');
  await expect(page.locator('#result .pg-stats dt')).not.toContainText(['Gutenberg']);
  await expect(page.locator('#result .pg-stats')).not.toContainText('words');
});

test('the studio cards are VocabHelp and By the Zeitgeist, both black ink on a white chip in either theme', async ({ page }) => {
  await page.goto('/#/play/4');
  const card = page.locator('#elsewhere a[href^="https://bythezeitgeist.com/"]');
  await expect(page.locator('#elsewhere a')).toHaveCount(2);
  await expect(page.locator('#elsewhere a[href*="provablelearning.com"]')).toHaveCount(0);
  await expect(card).toContainText('By the Zeitgeist');
  const logo = card.locator('img.elsewhere-logo');
  await expect(logo).toHaveCount(1);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'night'; });
  await expect(logo).toBeVisible();
  await expect(logo).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('no page links the archive from its header or footer, since it names past dailies', async ({ page }) => {
  for (const path of ['/', '/about.html', '/faq.html', '/how-to-play.html', '/privacy.html']) {
    await page.goto(path);
    await expect(page.locator('header a[href="/archive"], footer a[href="/archive"]')).toHaveCount(0);
  }
});

test('there is no Support tab or link to the old Support page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#main-nav')).not.toContainText('Support');
  await expect(page.locator('footer')).not.toContainText('Support');
  await expect(page.locator('a[href*="ko-fi"], a[href="/support"]')).toHaveCount(0);
  for (const path of ['/about.html', '/faq.html', '/how-to-play.html', '/privacy.html']) {
    await page.goto(path);
    await expect(page.locator('a[href*="ko-fi"], a[href="/support"]')).toHaveCount(0);
  }
});

test('Excerptle Pro is gone: no badge, no script, no Pro row, and the studio cards always show', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bookle.auth.session', JSON.stringify({
    uid: 'pro-gone', email: 'pro@example.test', token: 'tok', expiresAt: 4102444800,
  })));
  await page.route('**/billing/**', route => route.fulfill({ json: { pro: true, status: 'active' } }));
  await page.goto('/');
  await expect(page.locator('#pro-badge, script[src*="pro.js"]')).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.ExcerptlePro)).toBe('undefined');
  await expect(page.locator('#elsewhere')).toBeVisible();
  await page.locator('#auth-tab').click();
  await expect(page.locator('#modal h2')).toHaveText('Account');
  await expect(page.locator('#modal')).not.toContainText('Pro');
});

test('the How to play modal is the hint table plus three notes', async ({ page }) => {
  await page.goto('/');
  if (await page.locator('#nav-toggle').isVisible()) await page.locator('#nav-toggle').click();
  await page.locator('#main-nav [data-act="open-how"]').click();
  await expect(page.locator('#modal .how-table tr')).toHaveCount(6);
  await expect(page.locator('#modal .how-notes li')).toHaveCount(3);
  await expect(page.locator('#modal .how-notes')).toContainText('Wrong guesses don’t reveal anything');
});

test('the All books screen: one-line lede, a key, titled missed books, numbered pages', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bookle.progress.v4', JSON.stringify({
    3: { status: 'won', title: 'Emma', guesses: ['emma'], hints: 0 },
    5: { status: 'lost', title: 'Dracula', guesses: ['a'], hints: 1 },
    6: { status: 'lost', guesses: ['a'], hints: 1 },
    8: { status: 'playing', guesses: ['x'], hints: 0 },
  })));
  await page.goto('/#/bank');
  await expect(page.locator('#screen-bank .lede')).toHaveCount(0);
  await expect(page.locator('.bank-legend li')).toHaveText(['Solved', 'Missed', 'Started', 'New']);
  await expect(page.locator('.bank-legend li').first()).toHaveAttribute('title', /Solved/);
  await expect(page.locator('#bank-filter')).toHaveAttribute('title', /#0–#599/);
  const missed = page.locator('#bank-grid a[href="#/play/5"]');
  await expect(missed).toHaveClass(/lost/);
  await expect(missed).toContainText('Dracula');
  await expect(missed).toHaveAttribute('aria-label', '#5, Dracula, missed');
  await expect(page.locator('#bank-grid a[href="#/play/6"]')).toContainText('✕');
  expect(await missed.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
  await expect(page.locator('#bank-grid a[href="#/play/8"]')).toHaveClass(/play/);
  // 641 books at 100 a page: seven numbered pages, the first one current.
  await expect(page.locator('#bank-pager [data-page][aria-current="page"]')).toHaveText('1');
  await page.locator('#bank-pager [data-page="2"]').first().click();
  await expect(page.locator('#bank-pager [aria-current="page"]')).toHaveText('2');
  await expect(page).toHaveURL(/#\/bank\?page=2$/);
});

test('"Want to guess more?" sits evenly between the rules above and below it while playing', async ({ page }) => {
  await page.goto('/#/play/4');
  await expect(page.locator('#elsewhere')).toBeVisible();
  const gaps = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const more = r('#more'), q = r('.more-q'), nav = r('#story-nav'), els = r('#elsewhere');
    return { above: q.top - more.top, below: els.top - nav.bottom };
  });
  expect(Math.abs(gaps.above - gaps.below)).toBeLessThanOrEqual(6);
});
