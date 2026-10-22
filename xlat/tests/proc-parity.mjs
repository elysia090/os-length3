#!/usr/bin/env node
// node tests/proc-parity.mjs [--table FILE] [NAME...]
//
// The process and I/O cases, each run by the same BusyBox ELF on this Linux
// and under xlat (runtime/run.mjs), compared on stdout and exit status,
// with the time each took and when its first line came (a background job
// that holds its shell shows there). Prints a Markdown table; exits 1 if
// any case differs. BusyBox is the one the Prompt has (os/scripts/userland.sh
// stages it).
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const BUSYBOX = fileURLToPath(new URL('../../os/target/userland/busybox', import.meta.url));
const RUN = join(here, '..', 'runtime', 'run.mjs');

export const CASES = [
  {name: 'background and wait', script: 'busybox sleep 2 & echo READY; wait; echo DONE'},
  {name: 'producer and consumer together', script: 'i=0; while [ $i -lt 200 ]; do echo line $i; i=$((i+1)); done | (while read l; do echo "$l"; done) | busybox wc -l'},
  {name: '65 MiB through a pipe', script: 'busybox dd if=/dev/zero bs=1M count=65 2>/dev/null | busybox wc -c'},
  {name: '65 MiB checksum', script: 'busybox dd if=/dev/zero bs=1M count=65 2>/dev/null | busybox sha256sum'},
  {name: '1 GiB through a pipe', script: 'busybox dd if=/dev/zero bs=1M count=1024 2>/dev/null | busybox sha256sum', slow: true},
  {name: 'trap USR1', script: 'trap "echo got USR1" USR1; kill -USR1 $$; echo after'},
  {name: 'trap TERM and INT, cleanup', script: 'trap "echo cleanup TERM" TERM; trap "echo cleanup INT" INT; kill -TERM $$; kill -INT $$; echo after'},
  {name: 'trap from a child while waiting', script: 'trap "echo cleanup" USR1; (busybox sleep 1; kill -USR1 $$) & wait; echo "after $?"'},
  {name: 'untrapped TERM', script: 'kill -TERM $$; echo not here'},
  {name: 'ignored TERM', script: 'trap "" TERM; kill -TERM $$; echo still here'},
  {name: 'SIGPIPE', script: '(busybox yes; echo "yes ended $?" >&2) | busybox head -n 1'},
  {name: 'kill a background job', script: 'busybox sleep 30 & p=$!; kill $p; wait $p; echo "status $?"'},
  {name: 'jobs run at once', script: 'busybox sleep 1 & busybox sleep 1 & busybox sleep 1 & wait; echo three'},
  {name: 'exit status through a pipe', script: 'busybox false | busybox true; echo $?; (exit 3) | (exit 4); echo $?'},
  {name: 'wait for one of two', script: 'busybox sleep 2 & a=$!; (busybox sleep 1; exit 7) & b=$!; wait $b; echo "b $?"; wait $a; echo "a $?"'},
  {name: 'timeout kills', script: 'busybox timeout 1 busybox sleep 5; echo "status $?"'},
];

function sh(argv, env) {
  return new Promise((done) => {
    const t0 = performance.now();
    let first = null, out = '';
    const p = spawn(argv[0], argv.slice(1), {env, stdio: ['ignore', 'pipe', 'inherit']});
    p.stdout.on('data', (b) => { first ??= performance.now() - t0; out += b; });
    p.on('close', (code, signal) => done({out, status: signal ? 128 + {SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGUSR2: 12}[signal] : code, ms: performance.now() - t0, first}));
  });
}

export async function runCase(c, bin) {
  const env = {PATH: `${bin}:/usr/bin:/bin`, HOME: '/root', LANG: 'C.UTF-8'};
  const native = await sh([BUSYBOX, 'sh', '-c', c.script], env);
  const xlat = await sh([process.execPath, RUN, BUSYBOX, 'sh', '-c', c.script], env);
  return {native, xlat, same: native.out === xlat.out && native.status === xlat.status};
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (!existsSync(BUSYBOX)) { console.error(`no BusyBox at ${BUSYBOX} (os/scripts/userland.sh stages it)`); process.exit(2); }
  const args = process.argv.slice(2);
  let table = null;
  if (args[0] === '--table') { args.shift(); table = args.shift(); }
  const slow = !!process.env.PARITY_SLOW;
  const want = args.length ? CASES.filter((c) => args.some((a) => c.name.includes(a))) : CASES.filter((c) => slow || !c.slow);
  // Native BusyBox finds its applets the way the Prompt's does: busybox on the PATH.
  const bin = mkdtempSync(join(tmpdir(), 'proc-parity-'));
  symlinkSync(BUSYBOX, join(bin, 'busybox'));
  const f = (ms) => (ms === null ? '-' : `${(ms / 1000).toFixed(3)} s`);
  const rows = ['| case | native | xlat | same | first line native / xlat |', '|---|---|---|---|---|'];
  let bad = 0;
  for (const c of want) {
    const r = await runCase(c, bin);
    if (!r.same) bad++;
    const show = (x) => `${JSON.stringify(x.out.length > 60 ? x.out.slice(0, 57) + '...' : x.out)} (${x.status}) ${f(x.ms)}`;
    rows.push(`| ${c.name} | ${show(r.native)} | ${show(r.xlat)} | ${r.same ? 'yes' : '**no**'} | ${f(r.native.first)} / ${f(r.xlat.first)} |`);
    console.error(`${r.same ? 'ok  ' : 'FAIL'} ${c.name}`);
  }
  rmSync(bin, {recursive: true});
  const text = rows.join('\n') + '\n';
  process.stdout.write(text);
  if (table) { mkdirSync(join(table, '..'), {recursive: true}); writeFileSync(table, text); }
  process.exit(bad ? 1 : 0);
}
