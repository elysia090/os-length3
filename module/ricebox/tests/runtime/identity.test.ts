import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Kernel, Process} from '../../runtime/process.ts';
import {CAPS} from '../../runtime/flow.ts';

// Who a process is, as the device's Prompt has it: root in a user namespace that maps one id, 0 (core/src/launch.rs
// writes uid_map and gid_map "0 ID 1" and setgroups "deny"). So it may become no one else (an id not mapped is
// EINVAL: `su nobody` fails there as here), set no groups (EPERM), give a file no other owner (EINVAL), and it holds
// every capability within its namespace. The host running these tests is not such a namespace, so this is said here,
// through the real dispatcher, rather than beside a native run.
const EPERM = -1n, ENOENT = -2n, EINVAL = -22n, KEEP = 0xffffffffn;

function guest(): Process {
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  return p;
}
const call = (p: Process, nr: number, ...args: (number | bigint)[]): bigint => {
  const [a = 0n, b = 0n, c = 0n, d = 0n, e = 0n, f = 0n] = args.map(BigInt);
  return p.syscall(BigInt(nr), a, b, c, d, e, f);
};
const put = (p: Process, at: number, text: string): number => { p.bytes.set(new TextEncoder().encode(text + '\0'), at); return at; };

test('only 0 is anyone: set*id to it (or -1, keep) is taken, to another id EINVAL; groups are not to be set', () => {
  const p = guest();
  assert.equal(call(p, 105, 0), 0n, 'setuid(0)');
  assert.equal(call(p, 105, 65534), EINVAL, 'setuid(nobody)');
  assert.equal(call(p, 105, KEEP), EINVAL, 'setuid(-1)');
  assert.equal(call(p, 106, 65534), EINVAL, 'setgid(nobody)');
  assert.equal(call(p, 113, KEEP, 0), 0n, 'setreuid(-1, 0)');
  assert.equal(call(p, 113, 1000, KEEP), EINVAL, 'setreuid(1000, -1)');
  assert.equal(call(p, 117, KEEP, 0, KEEP), 0n, 'setresuid(-1, 0, -1)');
  assert.equal(call(p, 119, 0, 0, 100), EINVAL, 'setresgid(0, 0, 100)');
  assert.equal(call(p, 116, 0, 0), EPERM, 'setgroups(0, NULL)');
  assert.equal(call(p, 115, 0, 0), 0n, 'getgroups: none');
  for (const nr of [102, 104, 107, 108]) assert.equal(call(p, nr), 0n);
  assert.equal(call(p, 122, 1000), 0n, 'setfsuid says the old one');
});

test('a file is given no owner but 0; chown takes away its set-user-ID bit; a name not there is ENOENT first', () => {
  const p = guest();
  const vfs = p.kernel.vfs;
  vfs.mkdirp('/tmp');
  assert.ok(call(p, 2, put(p, 100, '/tmp/f'), 0o101, 0o644) >= 0n);
  const f = vfs.lookup('/tmp/f', '/');
  f.mode = (f.mode & ~0o7777) | 0o4755;
  assert.equal(call(p, 92, put(p, 100, '/tmp/f'), 65534, 65534), EINVAL, 'chown nobody');
  assert.equal(call(p, 92, put(p, 100, '/tmp/none'), 65534, 0), ENOENT, 'chown of no file');
  assert.equal(call(p, 92, put(p, 100, '/tmp/f'), KEEP, KEEP), 0n, 'chown -1:-1');
  assert.equal(f.mode & 0o7777, 0o755, 'its set-user-ID bit gone');
  assert.equal(call(p, 260, -100, put(p, 100, '/tmp/f'), 0, 0, 0), 0n, 'fchownat to root');
});

test('capabilities: all of them, dropped and not taken back; prctl says names and the bounding set', () => {
  const p = guest();
  const v = p.view;
  v.setUint32(200, 0x20080522, true);
  v.setInt32(204, 0, true);
  assert.equal(call(p, 125, 200, 300), 0n, 'capget');
  const word = (at: number): bigint => BigInt(v.getUint32(at, true));
  assert.equal(word(300) | (word(312) << 32n), CAPS, 'effective: all');
  // Drop all but CAP_NET_RAW (13); taking CAP_SYS_ADMIN (21) back is refused.
  p.bytes.fill(0, 300, 324);
  v.setUint32(300, 1 << 13, true);
  v.setUint32(304, 1 << 13, true);
  assert.equal(call(p, 126, 200, 300), 0n, 'capset: fewer');
  v.setUint32(304, (1 << 13) | (1 << 21), true);
  assert.equal(call(p, 126, 200, 300), EPERM, 'capset: one given up');
  // An unknown version: EINVAL, the header saying the one wanted.
  v.setUint32(200, 1, true);
  assert.equal(call(p, 125, 200, 0), EINVAL);
  assert.equal(v.getUint32(200, true), 0x20080522);
  // prctl.
  assert.equal(call(p, 157, 15, put(p, 400, 'worker-thread-name-long')), 0n, 'PR_SET_NAME');
  p.bytes.fill(0xff, 500, 516);
  assert.equal(call(p, 157, 16, 500), 0n, 'PR_GET_NAME');
  assert.equal(p.cstring(500), 'worker-thread-n');
  assert.equal(call(p, 157, 23, 21), 1n, 'PR_CAPBSET_READ');
  assert.equal(call(p, 157, 23, 99), EINVAL);
  assert.equal(call(p, 157, 38, 1), 0n, 'PR_SET_NO_NEW_PRIVS');
  assert.equal(call(p, 157, 39), 1n);
  assert.equal(call(p, 157, 9999), EINVAL, 'an option not known');
});
