// For npm test (scripts/tests.mjs, testing-together.ts): node:test as one part of a test file sees it. A file
// whose tests are each their own (each makes its own Remote) may be run in parts, in several processes at
// once: each process reads the file as a module of its own (`?part=k/n`), and its `node:test` is this one,
// read as `?part=k/n` too, under which the file registers only every n-th of its tests from the k-th, in
// the order it registers them. Every test runs in one part, and in one only.
//
// Only what the file registers as it loads is shared out: once it has loaded (`loaded()`), a test made
// inside another (a subtest) is made as node:test makes it.

import * as real from 'node:test';

const [k, n] = (new URL(import.meta.url).searchParams.get('part') ?? '1/1').split('/').map(Number);
let next = 0, done = false;
/** Whether the test being registered now is this part's. */
const mine = () => done || next++ % n === k - 1;

/** `f`, registering only this part's tests (and so its skip, todo and only). */
function part<F extends (...a: never[]) => unknown>(f: F): F {
  const g = ((...a: Parameters<F>) => (mine() ? f(...a) : undefined)) as F;
  for (const m of ['skip', 'todo', 'only'] as const) {
    if (m in f) Object.assign(g, {[m]: part((f as unknown as Record<typeof m, F>)[m])});
  }
  return g;
}
/** Suites are not shared out: a file run in parts registers its tests at its top level. */
function refused<F extends (...a: never[]) => unknown>(name: string, f: F): F {
  return ((...a: Parameters<F>) => {
    if (!done) throw new Error(`A test file run in parts registers its tests with test() at its top level, not ${name}()`);
    return f(...a);
  }) as F;
}

export const {after, afterEach, assert, before, beforeEach, mock, run, snapshot} = real;
export const test = part(real.test), it = part(real.it), skip = part(real.skip), todo = part(real.todo), only = part(real.only);
export const describe = refused('describe', real.describe), suite = refused('suite', real.suite);
export default test;

/** Said once the file has loaded: whatever registers a test after this is not shared out. */
export const loaded = () => { done = true; };
