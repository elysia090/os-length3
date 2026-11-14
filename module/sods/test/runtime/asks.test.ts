// What muk asks of Linux, and whether this Linux answers it (runtime/targets.ts CALLS_OWED): read off muk's own
// sources and this kernel's tables, so the list of what is owed is what is owed. A call muk comes to make that is
// not answered here fails this until it is listed; one listed that is answered since fails it until it is struck.
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {FILE_CALLS} from '../../runtime/linux/sys-file.ts';
import {NET_CALLS} from '../../runtime/linux/sys-net.ts';
import {PROC_CALLS} from '../../runtime/linux/sys-proc.ts';
import {SIGNAL_CALLS} from '../../runtime/linux/signal.ts';
import {MOUNT_CALLS} from '../../runtime/linux/sys-mount.ts';
import {BRANCHES, CALLS_OWED, owed, targets} from '../../runtime/targets.ts';

const root = new URL('../../../../', import.meta.url);
const text = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const ANSWERED = {...FILE_CALLS, ...PROC_CALLS, ...NET_CALLS, ...SIGNAL_CALLS, ...MOUNT_CALLS};

/** Each call muk's C makes, by its number: every SYS_ name its sources and lib's use, as their headers number them. */
function asked(): Map<number, string> {
  const sources = ['module/muk/src/muk.c', 'module/muk/src/bundle.h', 'module/muk/src/filter.h', 'module/lib/sys.h', 'module/lib/io.h', 'module/lib/arena.h', 'module/lib/word.h'].map(text);
  const numbers = new Map<string, number>();
  for (const header of [text('module/muk/src/linux-abi.h'), text('module/lib/sys.h')]) {
    for (const m of header.matchAll(/\bSYS_(\w+) = (\d+)/g)) numbers.set(m[1], Number(m[2]));
  }
  const out = new Map<number, string>();
  // (a call's name is in small letters: CAP_SYS_ADMIN and its kin are not calls)
  for (const source of sources) for (const m of source.matchAll(/(?<![A-Za-z0-9_])SYS_([a-z][a-z0-9_]*)\b(?! =)/g)) {
    const nr = numbers.get(m[1]);
    assert.ok(nr !== undefined, `SYS_${m[1]} has no number in muk's headers`);
    out.set(nr, m[1]);
  }
  return out;
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

test('every call muk makes is answered here, or is owed by name', () => {
  const calls = asked();
  assert.ok(calls.size > 50, `muk's calls are not read: ${calls.size}`);
  const absent = [...calls].filter(([nr]) => !ANSWERED[nr]).map(([nr, name]) => `${name} (${nr})`).sort();
  assert.deepEqual(absent, CALLS_OWED.filter((c) => c.how === 'absent').map((c) => `${c.name} (${c.nr})`).sort());
  for (const c of CALLS_OWED) assert.equal(calls.get(c.nr), c.name, `${c.name} (${c.nr}) is owed, and muk does not make it`);
});

test('what muk asks to be put in namespaces by is answered: by one who may, done; by one who may not, EPERM', () => {
  const EPERM = -1n, ENOENT = -2n, EINVAL = -22n, p = guest();
  p.tasks.add(p.kernel.newTask(p));
  assert.deepEqual(CALLS_OWED, []);
  // Each as Linux answers it where nothing is asked of it (no path, no descriptor): never "no such call", never a refusal of all.
  assert.equal(call(p, 165, 0, 0, 0, 0, 0), ENOENT, 'mount of nothing on nothing');
  assert.equal(call(p, 166, 0, 0), ENOENT, 'umount2 of nothing');
  assert.equal(call(p, 155, 0, 0), ENOENT, 'pivot_root to nothing');
  assert.equal(call(p, 308, -1, 0), -9n, 'setns by no descriptor');
  assert.equal(call(p, 435, 0, 0), EINVAL, 'clone3 told by nothing');
  assert.equal(call(p, 116, 0, 0), 0n, 'setgroups, by root of the first namespace');
  assert.equal(call(p, 272, 0x2000000), 0n, 'unshare: a cgroup namespace begun where it is');
  assert.notEqual(p.ns.cgroup, p.kernel.spaces.cgroup);
  // One with no capability over its namespace is refused each.
  p.cred = p.cred.with({effective: 0n});
  for (const [name, asked] of Object.entries({mount: () => call(p, 165, 0, 512, 0, 0, 0), umount2: () => call(p, 166, 512, 0), pivot_root: () => call(p, 155, 512, 512),
    unshare: () => call(p, 272, 0x20000), setgroups: () => call(p, 116, 0, 0)})) {
    p.bytes.set(new TextEncoder().encode('/tmp\0'), 512);
    assert.equal(asked(), EPERM, name);
  }
});

test('where something else makes a box or a terminal, what does it is there to be seen', () => {
  for (const b of BRANCHES) {
    const named = [...b.by.matchAll(/\b((?:why|scripts|module)\/[\w./-]+)/g)].map((m) => m[1].replace(/[.,;:]$/, ''));
    assert.ok(named.length > 0, `${b.what}: nothing is named`);
    for (const path of named) assert.ok(existsSync(new URL(path, root)), `${b.what}: ${path} is not there`);
  }
});

test('what is owed is every row not verified or excluded, every call and every branch', () => {
  const rows = targets().filter(({state}) => state.is === 'unverified' || state.is === 'unimplemented').length;
  assert.equal(owed().length, rows + CALLS_OWED.length + BRANCHES.length);
});
