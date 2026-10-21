import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// The real src/app.ts with its types stripped. Stripping blanks the types out
// in place, so the declarations sliced on below survive — but only up to the
// opening parenthesis: the parameter list now holds the erased annotations.
const source = stripTypeScriptTypes(readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8'));
test('daily streaks are derived from the dailies actually solved', () => {
  // 600 is the first daily, on the index's startDate: one index, one date.
  const won = (n: number): [number, { status: string }] => [n, { status: 'won' }];
  const progress: Record<number, { status: string }> = Object.fromEntries([won(600), won(601), won(602), won(604), won(605), [3, { status: 'won' }]]);
  const state = { index: { startDate: '2026-09-09', dailyStartIndex: 600 } };
  const context: {
    gameDate: () => string;
    dailyStreaks?: () => { current: number; best: number };
    [name: string]: unknown;
  } = { state, progressMap: () => progress,
    START: '2026-09-09', gameDate: () => '2026-09-14',
    addDays: (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10),
    daysBetween: (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000),
  };
  vm.createContext(context);
  const start = source.indexOf('  function dateForDailyIndex(');
  vm.runInContext(source.slice(start, source.indexOf('  async function loadIndex(', start)), context);
  const streaks = () => ({ ...context.dailyStreaks!() });

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
  const context: { pageList?: (page: number, max: number) => (number | string)[] } = {};
  vm.createContext(context);
  const start = source.indexOf('  function pageList(');
  vm.runInContext(source.slice(start, source.indexOf('  function renderBank(', start)) + '\nglobalThis.pageList = pageList;', context);
  const pages = (page: number, max: number) => [...context.pageList!(page, max)];
  assert.deepEqual(pages(1, 1), [1]);
  assert.deepEqual(pages(3, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pages(1, 12), [1, 2, '…', 12]);
  assert.deepEqual(pages(6, 12), [1, '…', 5, 6, 7, '…', 12]);
  // A single hidden page is shown, not hidden behind an ellipsis.
  assert.deepEqual(pages(4, 12), [1, 2, 3, 4, 5, '…', 12]);
  assert.deepEqual(pages(12, 12), [1, '…', 11, 12]);
});
