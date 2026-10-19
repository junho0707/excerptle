import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
test('daily streaks are derived from the dailies actually solved', () => {
  // 600 is the first daily, on the index's startDate: one index, one date.
  const won = n => [n, { status: 'won' }];
  const progress = Object.fromEntries([won(600), won(601), won(602), won(604), won(605), [3, { status: 'won' }]]);
  const state = { index: { startDate: '2026-09-09', dailyStartIndex: 600 } };
  const context = vm.createContext({ state, progressMap: () => progress,
    START: '2026-09-09', gameDate: () => '2026-09-14',
    addDays: (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10),
    daysBetween: (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000),
  });
  const start = source.indexOf('  function dateForDailyIndex(n)');
  vm.runInContext(source.slice(start, source.indexOf('  async function loadIndex()', start)), context);
  const streaks = () => ({ ...context.dailyStreaks() });

  // Sep 9-11 and Sep 13-14: the longest run is three, and the live one is the
  // run that reaches today. A solved bank book is not a daily and never counts.
  assert.deepEqual(streaks(), { current: 2, best: 3 });
  // Yesterday still counts as alive — today's daily is still playable.
  context.gameDate = () => '2026-09-15';
  assert.deepEqual(streaks(), { current: 2, best: 3 });
  // A day later it is over, and a gap in the middle has already broken it.
  context.gameDate = () => '2026-09-16';
  assert.deepEqual(streaks(), { current: 0, best: 3 });
  // A lost daily ends a run rather than extending it.
  progress[603] = { status: 'lost' };
  context.gameDate = () => '2026-09-14';
  assert.deepEqual(streaks(), { current: 2, best: 3 });
});

test('the bank pager shows first, last and the current page with its neighbours', () => {
  const context = vm.createContext({});
  const start = source.indexOf('  function pageList(');
  vm.runInContext(source.slice(start, source.indexOf('  function renderBank()', start)) + '\nglobalThis.pageList = pageList;', context);
  const pages = (page, max) => [...context.pageList(page, max)];
  assert.deepEqual(pages(1, 1), [1]);
  assert.deepEqual(pages(3, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pages(1, 12), [1, 2, '…', 12]);
  assert.deepEqual(pages(6, 12), [1, '…', 5, 6, 7, '…', 12]);
  // A single hidden page is shown, not hidden behind an ellipsis.
  assert.deepEqual(pages(4, 12), [1, 2, 3, 4, 5, '…', 12]);
  assert.deepEqual(pages(12, 12), [1, '…', 11, 12]);
});
