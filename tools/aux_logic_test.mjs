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
test('mixed server and browser timestamps sort chronologically', () => {
  const context = vm.createContext({});
  const start = source.indexOf('  const rankSort =');
  vm.runInContext(source.slice(start, source.indexOf('  // The server carries', start)) + '\nglobalThis.compare = rankSort;', context);
  const local = { hints: 1, guesses: 2, at: 1800000000000 };
  const remote = { hints: 1, guesses: 2, at: 1800000001 };
  assert.ok(context.compare(local, remote) < 0);
});

test('battle messages tolerate closed rooms, bound hints, and preserve book zero', async () => {
  const started = [];
  const state = { battle: null, mode: 'battle', status: 'playing', hints: 0, puzzle: {} };
  const context = vm.createContext({ state, MAX_HINTS: 5, presetCount: () => 600,
    startPlay: async options => started.push(options.playIndex), setMsg() {}, repaintLobby() {},
    renderExcerpt() {}, bump() {}, $() {},
  });
  const start = source.indexOf('  async function onBattleData');
  vm.runInContext(source.slice(start, source.indexOf('  function route()', start)), context);
  await context.onBattleData({ type: 'hello' });
  state.battle = { role: 'guest', playIndex: 42 };
  await context.onBattleData({ type: 'hint', hints: 1000 });
  assert.equal(state.hints, 0);
  await context.onBattleData({ type: 'hint', hints: 3 });
  assert.equal(state.hints, 3);
  await context.onBattleData({ type: 'start', playIndex: 0 });
  await context.onBattleData({ type: 'start', playIndex: -1 });
  assert.deepEqual(started, [0]);
});
