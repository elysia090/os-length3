import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';

// Exercise the actual orchestration, without compiling the product's WASM or replacing its source with a model.
const source = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');
const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const code = stripTypeScriptTypes(between('async function persist(', '/** Under the lock:')
  + between('async function calls(', 'interface Call '));
const make = new Function('state', `
  let seen = 0, reader = false, tab = 'test';
  const READS = new Set(['read']);
  const fs = {get dirty() { return state.dirty; }, flush() { if (state.flushError) throw new Error('lazy read failed'); state.dirty = false; return {put: [], removed: []}; }};
  const channel = {postMessage() {}};
  const said = e => e.message;
  const locked = f => f();
  const current = async () => { state.reloads++; seen = state.generation; state.memory = state.disk; return {}; };
  const readInRepos = async () => {};
  const run = async (name) => { state.observed.push(state.memory); if (name === 'write') { state.memory = 'changed'; state.dirty = true; } return {ok: state.memory}; };
  const keep = async () => { if (state.failWrite) { state.failWrite = false; throw new Error('commit failed'); } state.disk = state.memory; state.generation++; };
  const call = async () => { throw new Error('not used'); }, read = call;
  ${code}
  return {calls, persist, seen: () => seen};
`);
test('later calls in a batch reload after a failed disk commit', async () => {
  const state = {memory: 'old', disk: 'old', generation: 0, reloads: 0, dirty: false, failWrite: true, observed: []};
  const worker = make(state);
  const answers = await worker.calls([{name: 'write'}, {name: 'read'}]);
  assert.match(answers[0].error, /commit failed/);
  assert.equal(answers[1].ok, 'old');
  assert.equal(state.reloads, 2);
});
test('failure materializing dirty file bytes invalidates the in-memory view', async () => {
  const worker = make({dirty: true, flushError: true});
  assert.match((await worker.persist({}, {ok: true})).error, /lazy read failed/);
  assert.equal(worker.seen(), -1);
});
