import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Description, FdTable} from '../../runtime/linux/fd.ts';
import {FsError, E} from '../../runtime/linux/fs.ts';

for (const cleanupFails of [false, true]) test(`failed FD fork retires every completed acquisition, cleanup fails=${cleanupFails}`, () => {
  const table = new FdTable(), a = new Description('console', {path: 'stdout'}), b = new Description('console', {path: 'stderr'});
  const refusal = new Description('console', {path: 'stdin'});
  table.install(a, {fd: 3}); table.install(a, {fd: 4}); table.install(b, {fd: 5}); table.install(refusal, {fd: 6});
  const original = new FsError(E.NOMEM), cleanup = new Error('release failed');
  // Refuse before acquiring the final description. The prefix includes a dup:
  // ownership is per copied slot, not per distinct Description identity.
  refusal.retain = () => { throw original; };
  const release = a.release.bind(a);
  if (cleanupFails) a.release = () => { release(); throw cleanup; };
  assert.throws(() => table.fork(), (error: unknown) => {
    if (!cleanupFails) assert.equal(error, original);
    else {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], original);
      const nested = error.errors[1];
      assert.ok(nested instanceof AggregateError); assert.deepEqual(nested.errors, [cleanup, cleanup]);
    }
    return true;
  });
  assert.deepEqual([a.refs, b.refs, refusal.refs, table.holders], [2, 1, 1, 1]);
  assert.deepEqual([...table.slots.keys()], [3, 4, 5, 6]);
  assert.equal(table.get(3), a); assert.equal(table.get(4), a); assert.equal(table.get(5), b);
  assert.equal(a.closed, false); assert.equal(b.closed, false); assert.equal(refusal.closed, false);
});

for (const cleanupFails of [false, true]) test(`FD fork pending owner returns before slot insertion, cleanup fails=${cleanupFails}`, () => {
  const table = new FdTable(), a = new Description('console', {path: 'stdout'}), b = new Description('console', {path: 'stderr'});
  table.install(a, {fd: 3}); table.install(b, {fd: 4});
  const original = new Error('slot metadata inaccessible');
  // Object construction reads cloexec after retain returns and before Map.set.
  Object.defineProperty(table.slots.get(4)!, 'cloexec', {get() { throw original; }});
  const cleanup = new Error('pending owner release failed'), release = b.release.bind(b);
  if (cleanupFails) b.release = () => { release(); throw cleanup; };
  assert.throws(() => table.fork(), error => {
    if (!cleanupFails) assert.equal(error, original);
    else { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [original, cleanup]); }
    return true;
  });
  assert.equal(a.refs, 1); assert.equal(b.refs, 1);
  assert.equal(a.closed, false); assert.equal(b.closed, false);
});

test('successful FD copy retains each slot and releases only its own owners', () => {
  const table = new FdTable(), a = new Description('console', {path: 'stdout'});
  table.install(a, {fd: 3}); table.install(a, {fd: 4, cloexec: true});
  const copy = table.fork();
  assert.equal(a.refs, 4); assert.equal(copy.cloexec(4), true); assert.equal(copy.cloexec(3), false);
  copy.letGo(); assert.equal(a.refs, 2); assert.equal(a.closed, false);
  assert.equal(table.get(3), a); assert.equal(table.get(4), a);
});

test('FD console metadata copy failure releases the complete unpublished copy', () => {
  const table = new FdTable(), d = new Description('console', {path: 'stdout'});
  table.install(d, {fd: 1});
  // A detached typed-array source makes TypedArray.set throw after all slots
  // were copied. No global monkeypatch or allocation exhaustion is required.
  structuredClone(table.consoles.buffer, {transfer: [table.consoles.buffer as ArrayBuffer]});
  assert.throws(() => table.fork(), TypeError);
  assert.equal(d.refs, 1); assert.equal(d.closed, false); assert.equal(table.get(1), d);
});
