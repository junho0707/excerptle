import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
test('an archived daily does not count toward today’s streak', () => {
  const writes = [];
  const state = { mode: 'daily', playIndex: 600, status: 'won', guesses: ['title'], hints: 0 };
  const stats = { lastDaily: null, played: 0, wins: 0, dist: [0, 0, 0, 0, 0, 0], currentStreak: 0, maxStreak: 0 };
  const context = vm.createContext({ state, MAX_GUESSES: 6, K: { stats: 'stats' },
    dailyIndexNow: () => 602, gameDate: () => '2026-09-10', loadStats: () => stats,
    stopRoundTimers() {}, saveProgress() {}, pushLb() {}, playerId() {}, displayName() {},
    localStorage: { setItem: (...args) => writes.push(args) },
  });
  const start = source.indexOf('  function recordFinish()');
  vm.runInContext(source.slice(start, source.indexOf('  function onHint()', start)), context);
  context.recordFinish();
  assert.equal(writes.length, 0);
  state.playIndex = 602;
  context.recordFinish();
  assert.equal(stats.currentStreak, 1);
  assert.equal(writes.length, 1);
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
