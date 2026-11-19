import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Kernel, Process} from '../../runtime/linux/process.ts';

const CREATE = 283, SET = 286, GET = 287, NONBLOCK = 0x800, CLOEXEC = 0x80000;
const IN = 1, ET = 0x80000000;
const SPEC = 4096, OLD = 4160, DATA = 4224, EVENT = 4288;
const AGAIN = -11n, BADF = -9n, FAULT = -14n, INVAL = -22n;

function guest(): Process {
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => null}});
  const p = new Process(k, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  return p;
}

function call(p: Process, nr: number, ...[a = 0n, b = 0n, c = 0n, d = 0n]: (number | bigint)[]): bigint {
  return p.syscall(BigInt(nr), BigInt(a), BigInt(b), BigInt(c), BigInt(d), 0n, 0n);
}

function spec(p: Process, valueNs = 0n, intervalNs = 0n): void {
  for (const [i, ns] of [intervalNs, valueNs].entries()) {
    p.view.setBigInt64(SPEC + i * 16, ns / 1_000_000_000n, true);
    p.view.setBigInt64(SPEC + i * 16 + 8, ns % 1_000_000_000n, true);
  }
}

test('only supported clocks and flags install a timer; invalid itimerspec leaves the old timer armed', () => {
  const p = guest();
  for (const clock of [-1, 0, 2, 7, 8, 9]) assert.equal(call(p, CREATE, clock, 0), INVAL);
  assert.equal(call(p, CREATE, 1, 1), INVAL);
  assert.equal(p.fds.slots.size, 0, 'refused calls have not installed any descriptors');
  const fd = call(p, CREATE, 1, NONBLOCK | CLOEXEC);
  assert.equal(call(p, 72, fd, 1), 1n);
  assert.equal(call(p, 72, fd, 3), BigInt(NONBLOCK | 2));
  assert.equal(call(p, SET, 99, 0, SPEC), BADF);
  assert.equal(call(p, GET, 99, OLD), BADF);
  const ep = call(p, 291, 0);
  assert.equal(call(p, SET, ep, 0, SPEC), INVAL);
  assert.equal(call(p, GET, ep, OLD), INVAL);
  assert.equal(call(p, 3, ep), 0n);
  spec(p, 30_000_000_000n);
  assert.equal(call(p, SET, fd, 0, SPEC), 0n);
  const before = p.kernel.deadline();
  assert.ok(before !== undefined);
  assert.equal(call(p, SET, fd, 4, SPEC), INVAL);
  assert.equal(call(p, SET, fd, 0, 0), FAULT);
  assert.equal(call(p, SET, fd, 0, p.bytes.length - 16), FAULT);
  assert.equal(call(p, GET, fd, 0), FAULT);
  spec(p, -1n);
  assert.equal(call(p, SET, fd, 0, SPEC), INVAL);
  spec(p);
  p.view.setBigInt64(SPEC + 8, 1_000_000_000n, true);
  assert.equal(call(p, SET, fd, 0, SPEC), INVAL);
  assert.equal(p.kernel.deadline(), before);
  spec(p);
  assert.equal(call(p, SET, fd, 0, SPEC, 1), FAULT, 'copy-back faults after resetting the timer');
  assert.equal(p.kernel.deadline(), undefined);
  assert.equal(call(p, 3, fd), 0n);
});

test('epoll sees one edge per expiration; a periodic timer does not keep waking until read or queried', () => {
  const p = guest(), fd = call(p, CREATE, 1, NONBLOCK), ep = call(p, 291, 0);
  p.view.setUint32(EVENT, IN | ET, true);
  p.view.setBigUint64(EVENT + 4, 123n, true);
  assert.equal(call(p, 233, ep, 1, fd, EVENT), 0n);
  assert.equal(call(p, 232, ep, EVENT, 1, 0), 0n);
  assert.equal(call(p, 0, fd, DATA, 0), INVAL);
  assert.equal(call(p, 0, fd, DATA, 7), INVAL);
  assert.equal(call(p, 0, fd, DATA, 8), AGAIN);

  spec(p, 1n, 3n);
  assert.equal(call(p, SET, fd, 3, SPEC), 0n); // absolute; CANCEL_ON_SET is inert
  assert.equal(p.kernel.deadline(), undefined, 'periodic overruns do not each queue a wake');
  assert.equal(call(p, 232, ep, EVENT, 1, 0), 1n);
  assert.equal(p.view.getUint32(EVENT, true), IN);
  assert.equal(p.view.getBigUint64(EVENT + 4, true), 123n);
  assert.equal(call(p, 232, ep, EVENT, 1, 0), 0n);
  assert.equal(call(p, 0, fd, DATA, 32), 8n);
  assert.ok(p.view.getBigUint64(DATA, true) > 1n);
  spec(p, 1n);
  assert.equal(call(p, SET, fd, 1, SPEC), 0n, 'reprogramming discards prior ticks');
  assert.equal(call(p, 232, ep, EVENT, 1, 0), 1n, 'rearming can produce a new edge');
  assert.equal(call(p, 0, fd, 0, 8), FAULT, 'the guest cannot write to address zero');
  assert.equal(call(p, 0, fd, DATA, 8), AGAIN, 'Linux consumes the tick before copying it');
  assert.equal(call(p, 3, fd), 0n);
  assert.equal(call(p, 3, ep), 0n);
});

test('reads use one expiration word and distinguish a short copy from no copy', () => {
  const p = guest(), fd = call(p, CREATE, 1, NONBLOCK);
  function vector(slot: number, base: number, length: number): void {
    p.view.setBigUint64(EVENT + 16 * slot, BigInt.asUintN(64, BigInt(base)), true);
    p.view.setBigUint64(EVENT + 16 * slot + 8, BigInt(length), true);
  }
  assert.equal(call(p, 19, fd, 0, 1), FAULT, 'invalid iovec address fails before waiting');
  vector(0, 1, 0);
  assert.equal(call(p, 19, fd, EVENT, 1), 0n, 'all-zero vector is not a short read');
  vector(0, DATA, 3);
  vector(1, 0, 5);
  assert.equal(call(p, 19, fd, EVENT, 2), AGAIN, 'no data to copy from an unready timer');
  spec(p, 1n);
  assert.equal(call(p, SET, fd, 1, SPEC), 0n);
  assert.equal(call(p, 0, fd, -1, 8), FAULT, 'outside the user range: fail before consuming');
  assert.equal(call(p, 19, fd, EVENT, 2), 3n, 'first vector copied before the second faulted');
  assert.equal(p.bytes[DATA], 1, 'little-endian expiration count');
  assert.equal(call(p, 0, fd, DATA, 8), AGAIN);
  assert.equal(call(p, SET, fd, 1, SPEC), 0n);
  assert.equal(call(p, 0, fd, p.bytes.length - 3, 8), 3n, 'scalar reads can also copy a prefix');
  assert.equal(p.bytes[p.bytes.length - 3], 1);
  assert.equal(call(p, 0, fd, DATA, 8), AGAIN);
  assert.equal(call(p, SET, fd, 1, SPEC), 0n);
  vector(1, DATA + 3, 5);
  assert.equal(call(p, 19, fd, EVENT, 2), 8n);
  assert.equal(p.view.getBigUint64(DATA, true), 1n);
  assert.equal(call(p, 3, fd), 0n);
});

test('duplicate descriptors share the queue entry; the last close removes it', () => {
  const p = guest(), fd = call(p, CREATE, 1, NONBLOCK | CLOEXEC);
  const copy = call(p, 32, fd);
  assert.equal(call(p, 72, copy, 1), 0n, 'a dup does not inherit close-on-exec');
  spec(p, 30_000_000_000n, 20_000_000_000n);
  assert.equal(call(p, SET, copy, 0, SPEC, OLD), 0n);
  assert.equal(p.view.getBigInt64(OLD + 16, true), 0n);
  assert.equal(call(p, GET, fd, OLD), 0n);
  assert.equal(p.view.getBigInt64(OLD, true), 20n);
  const until = p.kernel.deadline();
  assert.ok(until !== undefined);
  assert.equal(call(p, 3, fd), 0n);
  assert.equal(p.kernel.deadline(), until);
  assert.equal(call(p, GET, fd, OLD), BADF);
  assert.equal(call(p, 3, copy), 0n);
  assert.equal(p.kernel.deadline(), undefined);
});

test('last close cancels a timer wake already in the same retry snapshot', t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const p = guest(), fd = call(p, CREATE, 1, NONBLOCK), k = p.kernel;
  const checkpoint = now + 0x7fffffff;
  k.addTimer(checkpoint, () => assert.equal(call(p, 3, fd), 0n));
  // A deadline beyond the queue's maximum host delay needs a recheck at
  // the checkpoint. Closing first must prevent that same-pass recheck.
  spec(p, (0x7fffffffn + 1000n) * 1_000_000n);
  assert.equal(call(p, SET, fd, 0, SPEC), 0n);
  now = checkpoint;
  k.retry();
  assert.equal(call(p, GET, fd, OLD), BADF);
  assert.equal(k.deadline(), undefined, 'a canceled wake must not requeue after last close');
});
