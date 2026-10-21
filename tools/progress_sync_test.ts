import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// The real src/app.ts with its types stripped. Stripping blanks the types out
// in place, so the comment and declaration markers sliced on below survive.
const source = stripTypeScriptTypes(readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8'));

interface Row { status?: string; guesses?: string[]; hints?: number; at?: number }
type Progress = Record<string, Row>;
type FetchInit = { method?: string; body: string };
type FakeFetch = (url: string, options: FetchInit) => Promise<{ ok: boolean; status?: number; json?: () => Promise<unknown> }>;
interface SyncApi {
  syncProgress(): Promise<void>;
  syncProgressEntry(entries: Progress): Promise<void>;
  flushProgressEntries(): Promise<void>;
  pending(): Progress;
}

function setup(fetch: FakeFetch, local: Progress = {}) {
  const state = { token: 'owner-a' };
  const writes: [string, Progress][] = [];
  const sandbox: Record<string, unknown> & { api?: SyncApi } = {
    window: { EXCERPTLE_API: 'https://api.test', BookleAuth: { session: () => state } },
    fetch, localStorage: { setItem: (...args: [string, Progress]) => writes.push(args) },
    AbortSignal,
    K: { progress: 'progress' }, progressMap: () => local,
    savePlayJSON: (key: string, value: Progress) => writes.push([key, value]),
    $: () => null, renderStats: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('  let progressSyncing'), source.indexOf('  /* Carry unscoped local play')) +
    '\nglobalThis.api = { syncProgress, syncProgressEntry, flushProgressEntries, pending: () => pendingProgress };', sandbox);
  return { api: sandbox.api!, state, writes };
}

test('HTTP failures retain progress and retry without a request loop', async () => {
  let ok = false;
  const bodies: unknown[] = [];
  const { api } = setup(async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok, status: ok ? 200 : 503 }; });
  await api.flushProgressEntries(); // An empty queue must not lock future writes.
  await api.syncProgressEntry({ 0: { guesses: ['first'], at: 1 } });
  assert.equal(bodies.length, 1);
  assert.ok(api.pending()['0']);
  ok = true;
  await api.flushProgressEntries();
  assert.equal(bodies.length, 2);
  assert.equal(Object.keys(api.pending()).length, 0);
});

test('bulk progress is split below the backend request limit', async () => {
  const bodies: string[] = [];
  const { api } = setup(async (_url, options) => { bodies.push(options.body); return { ok: true }; });
  await api.syncProgressEntry(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, { guesses: ['x'.repeat(3000)], at: i }])));
  assert.equal(bodies.length, 7);
  assert.ok(bodies.every(body => body.length < 16384));
});

test('a finished round survives a newer copy that is still in progress', async () => {
  const local = { 7: { status: 'playing', guesses: ['Emma'], hints: 2, at: 9000 } };
  const { api, writes } = setup(async () => ({ ok: true, json: async () => ({ progress: { 7: { status: 'won', guesses: ['Dracula'], hints: 0, at: 5000 } } }) }), local);
  await api.syncProgress();
  const [, merged] = writes.find(([key]) => key === 'progress')!;
  assert.equal(merged['7'].status, 'won');
});

test('a sync the server already holds sends nothing back', async () => {
  const remote = { 7: { status: 'won', hints: 0, guesses: ['Dracula'], at: 5000 } };
  const requests: string[] = [];
  const { api } = setup(async (_url, options) => {
    requests.push(options?.method || 'GET');
    return { ok: true, json: async () => ({ progress: remote }) };
  }, { 7: { status: 'won', hints: 0, guesses: ['Dracula'], at: 4000 } });
  await api.syncProgress();
  assert.deepEqual(requests, ['GET']);
  assert.equal(Object.keys(api.pending()).length, 0);
});

test('a previous account response cannot restore its progress after account switching', async () => {
  let release: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => {};
  const { api, state, writes } = setup(() => new Promise(resolve => { release = resolve; }));
  const pending = api.syncProgress();
  state.token = 'owner-b';
  release({ ok: true, json: async () => ({ progress: { 42: { status: 'won' } } }) });
  await pending;
  assert.equal(writes.length, 0);
  assert.equal(Object.keys(api.pending()).length, 0);
});
