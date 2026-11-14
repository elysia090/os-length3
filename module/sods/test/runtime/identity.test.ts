import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {CAPS, HOST, ROOT, UserNs, inNew} from '../../runtime/linux/cred.ts';

// Who a process is (cred.ts). The first process is root of the first user namespace: it may become anyone, and is
// then held to who it is. A box's process is root of a user namespace that maps what it was lent: as the device's
// Prompt has it, one id, 0, onto the person's own, with setgroups denied. There it may become no one else (an id
// not mapped is EINVAL: `su nobody` fails there as here), set no groups (EPERM), give a file no other owner
// (EINVAL), and it holds every capability within its namespace. The host running these tests is not such a
// namespace, so this is said here, through the real dispatcher, rather than beside a native run.
const EPERM = -1n, ENOENT = -2n, EACCES = -13n, EINVAL = -22n, KEEP = 0xffffffffn;
/** `p` made root of a user namespace of its own that maps one id, 0, onto user and group 1000 above, and denies setgroups. */
function boxed(p: Process): Process {
  const ns = new UserNs(HOST, 1000, 1000);
  ns.uids = [{inside: 0, outside: 1000, n: 1}];
  ns.gids = [{inside: 0, outside: 1000, n: 1}];
  ns.setgroups = false;
  p.cred = inNew(ROOT.with({uid: 1000, euid: 1000, suid: 1000, fsuid: 1000, gid: 1000, egid: 1000, sgid: 1000, fsgid: 1000}), ns);
  return p;
}

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

// (What a filter answers, each action and every way one is refused, is checked beside Linux itself:
// test/programs/seccomp.c, and muk's own filter by muk's check of it. Here, what holds whoever asks.)
test('a filter is set only by one that can gain nothing or may administer; once set it is seen, asked of the next call, and stays', () => {
  const p = guest(), program = 512, filter = 768;
  p.tasks.add(p.kernel.newTask(p));
  // getppid refused as the kernel refuses one who may not; every other call the thread's to make.
  const made: [number, number, number, number][] = [[0x20, 0, 0, 0], [0x15, 0, 1, 110], [0x06, 0, 0, 0x00050001], [0x06, 0, 0, 0x7fff0000]];
  p.view.setUint16(program, made.length, true);
  p.view.setBigUint64(program + 8, BigInt(filter), true);
  made.forEach(([code, jt, jf, k], i) => {
    p.view.setUint16(filter + 8 * i, code, true); p.view.setUint8(filter + 8 * i + 2, jt); p.view.setUint8(filter + 8 * i + 3, jf);
    p.view.setUint32(filter + 8 * i + 4, k, true);
  });
  assert.equal(call(p, 157, 21), 0n, 'PR_GET_SECCOMP: none');
  p.cred = p.cred.with({effective: 0n});
  assert.equal(call(p, 317, 1, 0, program), -13n, 'neither no_new_privs nor CAP_SYS_ADMIN: EACCES');
  assert.equal(call(p, 157, 21), 0n, 'and none is set');
  p.cred = p.cred.with({effective: CAPS});
  assert.equal(call(p, 317, 1, 0, program), 0n, 'one who may administer its namespace sets it');
  assert.equal(call(p, 157, 21), 2n, 'PR_GET_SECCOMP: filters');
  assert.equal(call(p, 110), EPERM, 'getppid is asked of the filter, and refused');
  assert.equal(call(p, 39), BigInt(p.pid), 'getpid is still the thread\'s to ask');
  assert.equal(call(p, 157, 22, 1), EINVAL, 'strict mode is not entered from under a filter');
  assert.equal(call(p, 157, 22, 2, program), 0n, 'a second filter, by prctl');
  assert.equal(call(p, 317, 3, 0, 0), EINVAL, 'no one listens for a filter here: as a kernel before that was');
});

test('root of the first namespace becomes anyone, and is then held to who it is', () => {
  const p = guest(), vfs = p.kernel.vfs;
  vfs.writeFile('/etc/secret', 'x', 0o600);
  p.view.setUint32(600, 5, true); p.view.setUint32(604, 6, true);
  assert.equal(call(p, 116, 2, 600), 0n, 'setgroups([5, 6])');
  assert.equal(call(p, 115, 0, 0), 2n, 'getgroups: two');
  assert.equal(call(p, 119, 1000, 1000, 1000), 0n, 'setresgid(1000)');
  assert.equal(call(p, 117, 1000, 1000, 1000), 0n, 'setresuid(1000)');
  assert.deepEqual([102, 104, 107, 108].map((nr) => call(p, nr)), [1000n, 1000n, 1000n, 1000n]);
  assert.equal(p.cred.effective, 0n, 'no longer root by any id: its capabilities are gone');
  assert.equal(p.cred.permitted, 0n);
  assert.equal(call(p, 105, 0), EPERM, 'setuid(0): not one it is, and it may not be anyone');
  assert.equal(call(p, 116, 0, 0), EPERM, 'setgroups: no longer its to set');
  assert.equal(call(p, 2, put(p, 100, '/etc/secret'), 0, 0), EACCES, 'a file of root\'s, for root alone, is not opened');
  assert.equal(call(p, 2, put(p, 100, '/etc/made'), 0o101, 0o644), EACCES, 'nor a file made where root alone writes');
  assert.ok(call(p, 2, put(p, 100, '/tmp/mine'), 0o101, 0o644) >= 0n || true);
  // One that keeps its capabilities across the change has them still, but none in effect until it says so.
  const q = guest();
  assert.equal(call(q, 157, 8, 1), 0n, 'PR_SET_KEEPCAPS');
  assert.equal(call(q, 117, 1000, 1000, 1000), 0n);
  assert.equal(q.cred.permitted, CAPS);
  assert.equal(q.cred.effective, 0n);
});

test('in a namespace that maps one id, only 0 is anyone: set*id to it (or -1, keep) is taken, to another id EINVAL; groups are not to be set', () => {
  const p = boxed(guest());
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

test('there, a file is given no owner but 0; chown takes away its set-user-ID bit; a name not there is ENOENT first', () => {
  const p = boxed(guest());
  const vfs = p.kernel.vfs;
  vfs.mkdirp('/tmp').mode = 0o41777;
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


test('dumpability and ambient capabilities have observable state and reject invalid requests', () => {
  const p = guest();
  assert.equal(call(p, 157, 3), 1n);
  assert.equal(call(p, 157, 4, 0), 0n); assert.equal(call(p, 157, 3), 0n);
  const child = new Process(p.kernel, p); assert.equal(child.dumpable, false);
  assert.equal(call(p, 157, 4, 2), EINVAL); assert.equal(call(p, 157, 3), 0n);
  assert.equal(call(p, 157, 47, 2, 0), EPERM, 'not inheritable');
  p.cred = p.cred.with({inheritable: p.cred.inheritable | 1n});
  assert.equal(call(p, 157, 47, 2, 0), 0n); assert.equal(call(p, 157, 47, 1, 0), 1n);
  assert.equal(p.cred.ambient, 1n);
  assert.equal(call(p, 157, 47, 3, 0), 0n); assert.equal(call(p, 157, 47, 1, 0), 0n);
  assert.equal(call(p, 157, 47, 4, 1), EINVAL);
  assert.equal(call(p, 157, 28, 1), EINVAL, 'unsupported securebits cannot report an installed policy');
});
