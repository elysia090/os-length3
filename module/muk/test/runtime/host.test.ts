import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {began, builtin, canRunApart, epoch, isNode, isShared, mayWait, nodeThreads, processors, said, steady} from '../../../sods/runtime/host.ts';

// The host as sods answers for it (sods/runtime/host.ts), here where the host is node: what the runtime asks in place
// of looking for itself.
test('node is known for node: its threads, its own modules, what was said to it', async () => {
  assert.equal(isNode, true);
  assert.equal(typeof (await nodeThreads())?.Worker, 'function');
  assert.equal(typeof builtin<typeof import('node:os')>('os')?.totalmem, 'function');
  assert.equal(builtin('no-such-module'), null);
  process.env.SODS_HOST_TEST = 'said';
  assert.equal(said('SODS_HOST_TEST'), 'said');
  process.env.SODS_HOST_TEST = '';
  assert.equal(said('SODS_HOST_TEST'), undefined, 'said empty is not said');
  delete process.env.SODS_HOST_TEST;
  assert.equal(said('SODS_HOST_TEST'), undefined);
});

test('memory shared between threads is told from memory that is not, and threads run apart and wait here', () => {
  assert.equal(isShared(new SharedArrayBuffer(8)), true);
  assert.equal(isShared(new ArrayBuffer(8)), false);
  assert.equal(isShared(new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}).buffer), true);
  assert.equal(canRunApart(), true);
  assert.equal(mayWait, true);
  const n = processors();
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 64, String(n));
});

test('the clocks: the steady one counts milliseconds and never goes back, and with when it began tells the calendar\'s time', async () => {
  const a = steady();
  let last = a;
  for (let i = 0; i < 1000; i++) { const t = steady(); assert.ok(t >= last); last = t; }
  await new Promise((go) => setTimeout(go, 30));
  const waited = steady() - a;
  assert.ok(waited >= 25 && waited < 2000, String(waited));
  assert.ok(began > Date.UTC(2020, 0) && began <= epoch(), String(began));
  // (The calendar's clock may have been set since the host began: within a minute here, where it was not.)
  assert.ok(Math.abs(began + steady() - epoch()) < 60_000);
});

// What has been taken on is asked of host.ts and nowhere else: muk's runtime never looks at the host's own clocks.
test('muk\'s runtime asks the time of host.ts: none of it reads the host\'s own clocks', () => {
  const dir = new URL('../../runtime/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    const found = /\bperformance\b|\bDate\.now\b|\bnew Date\b/.exec(readFileSync(new URL(name, dir), 'utf8'));
    assert.equal(found?.[0], undefined, `${name}: ${found?.[0]}`);
  }
});
