import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Vfs} from '../../runtime/linux/fs.ts';
import {RemoteKernel} from '../../runtime/linux/remote.ts';
import {CH, OP, Outbox, REPLY} from '../../runtime/linux/channel.ts';
import {Process} from '../../runtime/linux/process.ts';
import {prepare} from '../../runtime/translation/share.ts';
import {loadTranslator} from '../../runtime/translation/translator.ts';
import {hasUserland as have, userland} from '../fixtures/runtime.ts';

// Each thread in a Worker of its own, memory shared: what a cross-origin
// isolated page runs. Here a thread that never makes a call cannot hold
// the others, and one killed while it computes ends at once.


async function shell(script: string, {input = null, said = null, files = {}, observe}: {input?: string | null; said?: [number, string][] | null;
  files?: Record<string, Uint8Array>; observe?: (kernel: RemoteKernel) => void} = {}): Promise<{status: number; out: string; ms: number}> {
  const vfs = new Vfs();
  for (const [path, bytes] of Object.entries(files)) vfs.writeFile(path, bytes, 0o755);
  const busybox = vfs.writeFile('/bin/busybox', readFileSync(userland.busybox), 0o755);
  for (const a of ['sh', 'sleep', 'cat', 'kill', 'echo', 'dd', 'wc', 'sha256sum', 'yes', 'head']) vfs.symlink('busybox', `/bin/${a}`);
  let out = '';
  const typed = input ? [new TextEncoder().encode(input)] : [];
  const kernel = new RemoteKernel({
    vfs, translate: await loadTranslator(readFileSync(userland.translator)),
    console: {
      interactive: false,
      write: (fd, b) => { const text = new TextDecoder().decode(b); out += text; said?.push([fd, text]); },
      read: () => typed.shift() ?? new Uint8Array(0),
      ready: () => true,
    },
  });
  observe?.(kernel);
  const {wasm, segments} = prepare(readFileSync(userland.translated), {shared: true});
  kernel.prebuilt(busybox, new WebAssembly.Module(wasm), segments);
  const t0 = performance.now();
  const status = await kernel.spawn('/bin/sh', ['/bin/sh', '-c', script], ['PATH=/bin'], '/');
  return {status, out, ms: performance.now() - t0};
}

test('apart: a background job and its shell run at once', {skip: !have}, async () => {
  const r = await shell('sleep 1 & echo READY; wait; echo DONE');
  assert.equal(r.out, 'READY\nDONE\n');
  assert.equal(r.status, 0);
});

test('apart: a job that computes without a call does not hold the shell, and kill ends it there', {skip: !have}, async () => {
  const r = await shell('(while :; do :; done) & p=$!; sleep 1; echo still here; kill $p; wait $p; echo "status $?"');
  assert.equal(r.out, 'still here\nstatus 143\n');
});

test('apart: time on the processor is counted in each Worker as it runs, and a sleep not at all', {skip: !have}, async () => {
  const loop = 'i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done';
  const r = await shell(`${loop}; set -- $(cat /proc/$$/stat); echo "utime \${14}"; sh -c '${loop}'; times; sleep 1; times`);
  const [own, ...times] = r.out.trim().split('\n');
  const secs = (line: string): number[] => [...line.matchAll(/(\d+)m([\d.]+)s/g)].map(([, m, s]) => Number(m) * 60 + Number(s));
  assert.match(own, /^utime [1-9]\d*$/);
  const [, after, , slept] = times.map(secs);
  assert.ok(after[0] > 0, `the child ran its loop: ${times[1]}`);
  assert.ok(slept[0] + slept[1] - after[0] - after[1] < 0.2, `sleep had the processor: ${times[1]} then ${times[3]}`);
});

test('apart: sampled calls charge the exact kernel share once and to the correct task', t => {
  let now = 100, cost = 3;
  t.mock.method(performance, 'now', () => now);
  const kernel = new RemoteKernel({spares: 0, translate: () => assert.fail('no guest image'),
    console: {write() {}, read: () => null}});
  const first = kernel.newTask(new Process(kernel, null)), second = kernel.newTask(new Process(kernel, null));
  for (const task of [first, second]) {
    task.state = 'running'; task.since = 100;
    kernel.tasks.set(task.tid, task);
  }
  kernel.handle = task => {
    assert.equal(Atomics.load(task.i32, CH.STATE), 3);
    now += cost;
    task.reply(REPLY.VALUE);
  };
  const ask = (task: typeof first, op: number) => {
    task.i32[CH.OP] = op;
    Atomics.store(task.i32, CH.STATE, 1);
    assert.equal(kernel.drain(), true);
    assert.equal(Atomics.load(task.i32, CH.STATE), 2);
  };
  try {
    for (let i = 0; i < 7; i++) ask(first, OP.SYSCALL);
    assert.deepEqual([first.since, first.cpu, kernel.cpu], [100, {user: 0, sys: 0}, {user: 0, sys: 0}]);

    // Three milliseconds in the eighth handler, 43 elapsed since admission:
    // 24ms sample debit, with the other 19ms on the original task.
    now = 140;
    ask(first, OP.SYSCALL);
    assert.deepEqual([first.since, first.owed, first.cpu], [143, 0, {user: 19, sys: 24}]);

    // A non-syscall request is charged once and doesn't shift the syscall
    // sample cadence, or move this task's charge to another owner.
    second.since = 143;
    now = 150; cost = 4;
    ask(second, OP.MISS);
    assert.deepEqual([second.since, second.owed, second.cpu], [154, 0, {user: 7, sys: 4}]);
    assert.equal(kernel.calls, 8);
    assert.deepEqual(first.cpu, {user: 19, sys: 24});
    assert.deepEqual(kernel.cpu, {user: 26, sys: 28});

    // A sampled handler longer than its completed run slice leaves debt.
    // A later lap discharges the balance, never crediting more than the
    // available interval nor charging the first task's account.
    now = 154; cost = 0;
    for (let i = 0; i < 7; i++) ask(second, OP.SYSCALL);
    cost = 3;
    ask(second, OP.SYSCALL);
    assert.deepEqual([second.since, second.owed, second.cpu], [157, 21, {user: 7, sys: 7}]);
    kernel.lap(second, 167);
    assert.deepEqual([second.owed, second.cpu], [11, {user: 7, sys: 17}]);
    kernel.lap(second, 187);
    assert.deepEqual([second.owed, second.cpu, first.cpu, kernel.cpu],
      [0, {user: 16, sys: 28}, {user: 19, sys: 24}, {user: 35, sys: 52}]);
  } finally { kernel.close(); }
});

test('apart: BusyBox times exposes the exact waited-child counters', {skip: !have}, async () => {
  let waited: {user: number; sys: number} | undefined;
  const r = await shell('dd if=/dev/zero of=/dev/null bs=1 count=50000 2>/dev/null && times', {observe(kernel) {
    const attempt = kernel.attempt;
    kernel.attempt = function (task, call) {
      if (call.nr === 100) waited = {...task.proc.waited};
      return attempt.call(this, task, call);
    };
  }});
  assert.equal(r.status, 0, r.out);
  const times = [...r.out.trim().matchAll(/(\d+)m(\d+)\.(\d{3})s/g)].map(([, minutes, seconds, millis]) =>
    Number(minutes) * 60_000 + Number(seconds) * 1000 + Number(millis));
  assert.equal(times.length, 4, r.out);
  assert.ok(waited && waited.sys > 0, 'the real child must accrue sampled kernel work');
  assert.deepEqual(times.slice(2), [Math.floor(waited.user / 10) * 10, Math.floor(waited.sys / 10) * 10]);
});

test('apart: a pipe streams between two Workers, every byte', {skip: !have}, async () => {
  const r = await shell('dd if=/dev/zero bs=64k count=200 2>/dev/null | wc -c');
  assert.equal(r.out.trim(), String(200 * 65536));
});

test('apart: traps and SIGPIPE as on Linux', {skip: !have}, async () => {
  const r = await shell('trap "echo got USR1" USR1; kill -USR1 $$; (yes; echo "yes $?" >&2) | head -n 1; echo after');
  assert.equal(r.out, 'got USR1\ny\nyes 141\nafter\n');
});

test('apart: what threads write to the console comes in the order written, stderr told apart', {skip: !have}, async () => {
  const said: [number, string][] = [];
  const r = await shell('for i in 1 2 3; do echo o$i; echo e$i >&2; done; (echo child; echo childerr >&2); echo last', {said});
  assert.equal(r.out, 'o1\ne1\no2\ne2\no3\ne3\nchild\nchilderr\nlast\n');
  const errs = said.filter(([fd]) => fd === 2).map(([, t]) => t).join('');
  assert.equal(errs, 'e1\ne2\ne3\nchilderr\n');
});

test('apart: a flood written a line at a time to the console comes whole', {skip: !have}, async () => {
  const r = await shell('yes | head -c 300000 | (cat; echo end)');
  assert.equal(r.out.length, 300004);
  assert.ok(r.out.endsWith('y\ny\nend\n'));
});

test('the console outbox: writes in order round the ring, fds kept, none past its room', () => {
  const box = new Outbox(new SharedArrayBuffer(16 + 64));
  const from = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz');
  const out: {fd: number; bytes: Uint8Array}[] = [];
  for (let k = 0; k < 20; k++) {
    assert.equal(box.put(k % 3 ? 1 : 2, from, [[k, 3], [0, 1]], 4) !== null, true);
    if (k % 4 === 3) out.push(...box.take());
  }
  out.push(...box.take());
  const want: [number, string][] = [];
  for (let k = 0; k < 20; k++) want.push([k % 3 ? 1 : 2, String.fromCharCode(97 + k, 98 + k, 99 + k) + 'a']);
  // Writes in a row to one fd come as one.
  const flat = out.map(({fd, bytes}): [number, string] => [fd, new TextDecoder().decode(bytes)]);
  assert.equal(flat.map(([, t]) => t).join(''), want.map(([, t]) => t).join(''));
  for (const [fd, t] of flat) assert.ok(want.filter(([f]) => f === fd).map(([, w]) => w).join('').includes(t));
  // Full: a write that does not fit is refused whole, and what fits still goes in.
  assert.equal(box.put(1, from, [[0, 26]], 26), true);
  assert.equal(box.put(1, from, [[0, 26]], 26), false);
  assert.equal(box.put(1, from, [[0, 26]], 26), null);
  assert.equal(new TextDecoder().decode(box.take()[0].bytes), 'abcdefghijklmnopqrstuvwxyz'.repeat(2));
});

test('apart: #143: a file that is no program the translator takes is refused as one (ENOEXEC), and the shell goes on', {skip: !have}, async () => {
  const r = await shell('/bad-elf; echo "status $?"; echo survived', {files: {'/bad-elf': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1])}});
  assert.match(r.out, /^\/bad-elf: line 1: .*: not found\nstatus 127\nsurvived\n$/s);
  assert.equal(r.status, 0);
});
