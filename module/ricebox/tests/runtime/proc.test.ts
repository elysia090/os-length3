import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pipe} from '../../runtime/fd.ts';
import {prepare} from '../../../sods/runtime/share.ts';
import {have, shell} from './busybox.ts';

// Processes run at once, pipes hold their writers, signals reach their
// handlers: each as BusyBox shows it, beside the same script on Linux
// (the outputs here are what Linux prints).

const APPLETS = ['sh', 'cat', 'sleep', 'dd', 'wc', 'kill', 'yes', 'head', 'sha256sum', 'echo', 'true', 'flock', 'stat', 'mv', 'rm', 'mkdir', 'rmdir', 'find', 'ls', 'ln', 'readlink'];

/** Run `script` to its end, waiting out its sleeps; {status, out, ms}. */
async function run(script: string): Promise<{status: number | undefined; out: string; ms: number; seen: {at: number; out: string}[]}> {
  const t0 = performance.now();
  const {kernel, out} = await shell(script, APPLETS);
  let r = kernel.pump();
  const seen: {at: number; out: string}[] = [];
  for (let until = r.until; r.waiting && until !== undefined; until = r.until) {
    seen.push({at: performance.now() - t0, out: out()});
    await new Promise((go) => setTimeout(go, Math.max(0, until - performance.now())));
    r = kernel.pump();
  }
  assert.ok(!r.waiting, 'it does not wait for input');
  return {status: r.status, out: out(), ms: performance.now() - t0, seen};
}

test('a background job does not hold the shell: READY comes before the sleep ends', {skip: !have}, async () => {
  const r = await run('sleep 1 & echo READY; wait; echo DONE');
  assert.equal(r.out, 'READY\nDONE\n');
  // While the job slept, the shell had already said READY.
  assert.equal(r.seen[0]?.out, 'READY\n');
  assert.ok(r.ms >= 1000, `${r.ms} ms`);
});

test('a producer and a consumer run together: 65 MiB through a 64 KiB pipe, every byte counted', {skip: !have}, async () => {
  const r = await run('dd if=/dev/zero bs=1M count=65 2>/dev/null | wc -c');
  assert.equal(r.out.trim(), String(65 << 20));
  assert.equal(r.status, 0);
});

test('the bytes through a pipe are the bytes written (checksum)', {skip: !have}, async () => {
  const r = await run('dd if=/dev/urandom of=/tmp/x bs=64k count=20 2>/dev/null; a=$(sha256sum < /tmp/x); b=$(cat /tmp/x | cat | sha256sum); [ "$a" = "$b" ] && echo same');
  assert.equal(r.out, 'same\n');
});

test('time on the processor is counted as it is had: the shell\'s loop in its stat, a child\'s in times once waited for, a sleep not at all', {skip: !have}, async () => {
  const loop = 'i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done';
  const r = await run(`${loop}; set -- $(cat /proc/$$/stat); echo "utime \${14}"; times; sh -c '${loop}'; times; sleep 1; times`);
  const [own, ...times] = r.out.trim().split('\n');
  // ash's times: the shell's user and system time, then its waited-for children's, each as 0m0.12s.
  const secs = (line: string): number[] => [...line.matchAll(/(\d+)m([\d.]+)s/g)].map(([, m, s]) => Number(m) * 60 + Number(s));
  assert.match(own, /^utime [1-9]\d*$/, 'the shell ran its loop: it had the processor');
  const [, before, , after, , slept] = times.map(secs);
  assert.equal(before[0] + before[1], 0, 'no child waited for yet');
  assert.ok(after[0] > 0, `the child ran its loop: ${times[3]}`);
  // A second asleep is not time on the processor: the children's grew by a sleep's start and end only.
  assert.ok(slept[0] + slept[1] - after[0] - after[1] < 0.2, `sleep had the processor: ${times[3]} then ${times[5]}`);
  assert.ok(r.ms >= 1000);
});

test('a trap runs its handler and the shell goes on; TERM, INT and USR1', {skip: !have}, async () => {
  const r = await run('trap "echo got USR1" USR1; trap "echo got TERM" TERM; trap "echo got INT" INT; kill -USR1 $$; kill -TERM $$; kill -INT $$; echo after');
  assert.equal(r.out, 'got USR1\ngot TERM\ngot INT\nafter\n');
  assert.equal(r.status, 0);
});

test('a trap for a signal from a child runs while the shell waits for it', {skip: !have}, async () => {
  const r = await run('trap "echo cleanup" USR1; (sleep 1; kill -USR1 $$) & wait; echo after');
  assert.equal(r.out, 'cleanup\nafter\n');
});

test('an untrapped TERM ends the shell (143), an ignored one does nothing', {skip: !have}, async () => {
  assert.equal((await run('kill -TERM $$; echo not here')).status, 15);
  const r = await run('trap "" TERM; kill -TERM $$; echo still here');
  assert.equal(r.out, 'still here\n');
});

test('flock: one holds a lock at a time; -n is refused while it is held, and taken once it is let go', {skip: !have}, async () => {
  const r = await run('(flock /l sleep 1) & sleep 0.3; flock -n /l echo got || echo held; wait; flock -n /l echo free');
  assert.equal(r.out, 'held\nfree\n');
});

test('flock: one waiting for a lock goes on when its holder ends, not before', {skip: !have}, async () => {
  const r = await run('(flock /l sh -c "sleep 1; echo first") & sleep 0.3; flock /l echo second; wait');
  assert.equal(r.out, 'first\nsecond\n');
  assert.ok(r.ms >= 1000, `${r.ms} ms`);
});

test('flock: two holding a lock shared that both ask for it exclusive each get it in turn, as Linux lets go of the one held first', {skip: !have}, async () => {
  // (Each takes it shared, waits until the other has it too, then asks for it exclusive: held through the asking,
  // they would wait on each other for ever.)
  const r = await run('w() { exec 3> /l; flock -s 3; : > /s$1; while [ ! -e /s$2 ]; do sleep 0.05; done; flock -x 3; echo "ex $1"; flock -u 3; }; ' +
    'w 1 2 & w 2 1 & wait');
  assert.deepEqual(r.out.split('\n').filter(Boolean).sort(), ['ex 1', 'ex 2']);
});

test('a file renamed over or removed while it is held has no link left, as fstat on it says; a directory gone, one fewer for its parent', {skip: !have}, async () => {
  // (What a program that holds a file renamed over learns from fstat: that it holds one no longer there.)
  const r = await run('echo a > /f; echo b > /g; exec 3< /f; stat -L -c %h /proc/self/fd/3; mv /g /f; stat -L -c %h /proc/self/fd/3; ' +
    'exec 4< /f; rm /f; stat -L -c %h /proc/self/fd/4; mkdir -p /p/d; stat -c %h /p; rmdir /p/d; stat -c %h /p');
  assert.equal(r.out, '1\n0\n0\n3\n2\n');
});

test('a descriptor\'s /proc link is the canonical path of what it opened: "." and ".." gone, links followed, a name made there', {skip: !have}, async () => {
  const r = await run('mkdir -p /pa/b; echo x > /pa/b/f; ln -s b /pa/l; ln -s /pa/b/f /pa/abs; cd /pa/b; ' +
    'exec 3< /pa/./b/../b/f 4< /pa/l/f 5< /pa/abs 6< ../l/. 7> new 8< //pa///b/f; for n in 3 4 5 6 7 8; do readlink /proc/self/fd/$n; done');
  assert.equal(r.out, '/pa/b/f\n/pa/b/f\n/pa/b/f\n/pa/b\n/pa/b/new\n/pa/b/f\n');
});

test('a directory read while what is in it moves away gives each of its entries once (find -exec mv, rm -r)', {skip: !have}, async () => {
  // (200 of them: more than one read of a directory gives, so it is read again after some have gone.)
  const r = await run('mkdir -p /x /y; i=0; while [ $i -lt 200 ]; do mkdir /x/d$i; i=$((i + 1)); done; ' +
    'find /x -mindepth 1 -maxdepth 1 -exec mv {} /y \\; ; ls /x | wc -l; ls /y | wc -l');
  assert.equal(r.out, '0\n200\n');
});

test('SIGPIPE ends a writer whose reader has gone, quietly, as 141', {skip: !have}, async () => {
  const r = await run('(yes; echo "yes ended $?" >&2) | head -n 1');
  assert.equal(r.out, 'y\nyes ended 141\n');
});

test('a full pipe makes its writer wait; it never says EPIPE while a reader is there', () => {
  const p = new Pipe();
  p.readers = 1;
  assert.equal(p.write(new Uint8Array(100000)), 65536, 'what fits');
  assert.ok(!p.writable);
  assert.equal(p.read(4096).length, 4096);
  assert.ok(p.writable, 'a page is free again');
  assert.equal(p.write(new Uint8Array(10000)), 4096);
});

test('a pipe holds what a Linux pipe holds: small writes share a page only when they fit whole', () => {
  const p = new Pipe();
  let n = 0;
  while (p.fits(1000)) n += p.write(new Uint8Array(1000));
  assert.equal(n, 64000);
  const q = new Pipe();
  while (q.fits(1024)) q.write(new Uint8Array(1024));
  assert.equal(q.size, 65536);
});

test('a translation is run without its data in the module, and with its memory shared when asked', () => {
  // (module (import "env" "memory" (memory 1 65536)) (data (i32.const 16) "hi"))
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 2, 18, 1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 1, 1, 128, 128, 4,
    11, 8, 1, 0, 65, 16, 11, 2, 104, 105]);
  const plain = prepare(wasm);
  assert.deepEqual(plain.segments?.map((s) => [s.offset, [...s.bytes]]), [[16, [104, 105]]]);
  const memory = new WebAssembly.Memory({initial: 1, maximum: 65536});
  new WebAssembly.Instance(new WebAssembly.Module(plain.wasm), {env: {memory}});
  assert.equal(new Uint8Array(memory.buffer)[16], 0, 'instantiating wrote nothing');
  const shared = prepare(wasm, {shared: true});
  const sharedMemory = new WebAssembly.Memory({initial: 1, maximum: 65536, shared: true});
  new WebAssembly.Instance(new WebAssembly.Module(shared.wasm), {env: {memory: sharedMemory}});
  assert.ok(sharedMemory.buffer instanceof SharedArrayBuffer);
});
