import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {memoryHost} from '../../runtime/linux/memory-host.ts';

const artifact = process.env.SODS_LINUX_WASM;
// A configured current artifact never falls back to a historical one on failure.
const translatorPath = process.env.SODS_CURRENT_TRANSLATOR_WASM ?? process.env.SODS_PATH_TRANSLATOR_WASM;
const provenance = process.env.SODS_CURRENT_TRANSLATOR_WASM ? 'current-source' : 'explicit external';
const options = {skip: !artifact || !translatorPath, timeout: 30_000};
const bytes = (s: string) => new TextEncoder().encode(s);
let fixture: {elf: Uint8Array; translator: WebAssembly.Module} | undefined;
function program() {
  if (fixture) return fixture;
  const dir = mkdtempSync(join(tmpdir(), 'sods-path-startup-'));
  try {
    const source = fileURLToPath(new URL('../fixtures/managed-path-startup/program.S', import.meta.url));
    const output = join(dir, 'program.elf');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
      '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', source, '-o', output,
    ], {stdio: 'pipe', timeout: 30_000});
    fixture = {elf: new Uint8Array(readFileSync(output)), translator: new WebAssembly.Module(readFileSync(translatorPath!))};
    return fixture;
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
function prepared(lazy: boolean, mode = 0o755, noExec = false) {
  const {elf, translator} = program();
  const host = memoryHost(new WebAssembly.Module(readFileSync(artifact!)), 4, 16);
  const root = host.preparePreparedFiles({inodes: 8, entries: 8, fileBytes: 262144,
    tables: 1, descriptions: 1, slots: 4, reads: 4, contexts: 1, views: 1, holds: 8,
    policy: {noExec, noSuid: false, noSymfollow: false}});
  const bin = host.directory(root, bytes('bin'), 0o755);
  const file = lazy ? host.lazyFile(bin, bytes('startup'), 7, elf.length, mode)
    : host.file(bin, bytes('startup'), elf, mode);
  host.sealFiles(4);
  // Prepared roots never grant the diagnostic global descriptor table.
  assert.throws(() => host.open(file), /admission/);
  return {host, elf, translator};
}
function inputs() {
  return {path: bytes('/bin/startup'), argv: [bytes('alias'), new Uint8Array([255, 254])],
    env: [bytes('A=1'), bytes('A=2')], random: new Uint8Array(16).fill(7)};
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return {promise, resolve};
}
for (const lazy of [false, true]) test(`${provenance} path-selected ${lazy ? 'lazy' : 'resident'} guest receives Rust credentials and original arguments`, options, async () => {
  const {host, elf, translator} = prepared(lazy);
  let calls = 0;
  for (let run = 0; run < 2; run++) {
    const i = inputs();
    const execution = await host.pathExecution(i.path, i.argv, i.env, {translator, random: i.random,
      load: async source => { assert.equal(source, 7); calls++; return elf; }});
    try {
      await assert.rejects(host.runWorker(execution, 1n)); // cannot replace committed entry
      assert.deepEqual(await host.runPath(execution), {status: 0, sourceFailures: 0});
      assert.equal(host.workerEvidence(execution).exited, true);
      assert.equal(host.workerEvidence(execution).resourcesRetired, true);
    } finally { host.stopWorker(execution); await host.workerSettled(execution); }
  }
  assert.equal(calls, lazy ? 1 : 0); // loaded lazy retains a source ID, not a load obligation
  // Two starts with one Fs/Table slot also exercise successful owner retirement.
});

test('path startup snapshots inputs before the source callback', options, async () => {
  const {host, elf, translator} = prepared(true);
  const i = inputs(), entered = deferred<void>(), source = deferred<Uint8Array>();
  const pending = host.pathExecution(i.path, i.argv, i.env, {translator, random: i.random,
    load: () => { entered.resolve(); return source.promise; }});
  await entered.promise;
  i.path.fill(0); i.argv[0].fill(0); i.argv[1].fill(0); i.env[0].fill(0); i.random.fill(0);
  source.resolve(elf);
  const execution = await pending;
  try { assert.deepEqual(await host.runPath(execution), {status: 0, sourceFailures: 0}); }
  finally { host.stopWorker(execution); await host.workerSettled(execution); }
});

for (const reason of ['mode', 'mount'] as const) test(`path startup rejects ${reason} execution policy before loading`, options, async () => {
  const {host, translator} = prepared(true, reason === 'mode' ? 0o644 : 0o755, reason === 'mount');
  const i = inputs(); let calls = 0;
  await assert.rejects(host.pathExecution(i.path, i.argv, i.env, {translator, random: i.random,
    load: () => { calls++; throw new Error('must not load'); }}));
  assert.equal(calls, 0);
});

test('path source failure retires startup owners and leaves the source retryable', options, async () => {
  const {host, elf, translator} = prepared(true), i = inputs();
  const failure = new Error('source unavailable');
  await assert.rejects(host.pathExecution(i.path, i.argv, i.env, {translator, random: i.random,
    load: () => { throw failure; }}));
  let calls = 0;
  const execution = await host.pathExecution(i.path, i.argv, i.env, {translator, random: i.random,
    load: () => { calls++; return elf; }});
  try { assert.equal((await host.runPath(execution)).status, 0); }
  finally { host.stopWorker(execution); await host.workerSettled(execution); }
  assert.equal(calls, 1);
});

test('path cancellation retains a pending source and does not adopt late success', options, async () => {
  const {host, elf, translator} = prepared(true), i = inputs();
  const controller = new AbortController(), entered = deferred<void>(), source = deferred<Uint8Array>();
  const pending = host.pathExecution(i.path, i.argv, i.env, {translator, random: i.random,
    signal: controller.signal, load: () => { entered.resolve(); return source.promise; }});
  const rejected = assert.rejects(pending);
  await entered.promise;
  controller.abort();
  source.resolve(elf);
  await rejected;
  let calls = 0;
  const execution = await host.pathExecution(i.path, i.argv, i.env, {translator, random: i.random,
    load: () => { calls++; return elf; }});
  try { assert.equal((await host.runPath(execution)).status, 0); }
  finally { host.stopWorker(execution); await host.workerSettled(execution); }
  assert.equal(calls, 1); // cancelled late bytes were not canonicalized
});

// Synthetic host receipts exercise private ABI admission, not real Module validation.
function rawPrepared(lazy = false, stdio = false) {
  const e = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(artifact!))).exports;
  const call = (name: string, ...args: (number | bigint)[]) => (e[name] as (...a: (number | bigint)[]) => number)(...args);
  const result = () => (e.linux_result as () => bigint)();
  const auxiliary = () => (e.linux_result_auxiliary as () => bigint)();
  const put = (name: string, b: Uint8Array) => {
    assert.equal(call(name, b.length), 0);
    new Uint8Array((e.memory as WebAssembly.Memory).buffer, Number(result()), b.length).set(b);
  };
  assert.equal(call('linux_init', 8, 16), 0);
  assert.equal(call('linux_prepared_files', 4, 4, 4096, 2, stdio ? 6 : 2, stdio ? 8 : 4, 4, 2, 1, 12, 0), 0);
  const root = result();
  assert.equal(call('linux_bind', 131072n), 0);
  const orphan = result();
  assert.ok(call('linux_execution_create', orphan) < 0); // reject even while builder exists
  put('linux_name', bytes('app'));
  if (lazy) assert.equal(call('linux_tree_lazy', root, 0o755, 7, 3), 0);
  else { put('linux_input', bytes('elf')); assert.equal(call('linux_tree_file', root, 0o755), 0); }
  assert.equal(call('linux_files_seal', 4), 0);
  function begin() {
    const path = bytes('/app'), wire = new Uint8Array(48 + path.length);
    const v = new DataView(wire.buffer);
    v.setBigUint64(0, 1n, true); v.setBigUint64(24, BigInt(path.length), true);
    wire.fill(7, 32, 48); wire.set(path, 48);
    put('linux_startup_input', wire);
    assert.equal(call(stdio ? 'linux_startup_begin_stdio' : 'linux_startup_begin'), 0);
    const id = result();
    assert.equal(call('linux_startup_input', 0), 0);
    return id;
  }
  function translated(id: bigint) {
    assert.equal(call('linux_startup_source_start', id), 0);
    assert.equal(result(), 0n);
    assert.equal(call('linux_startup_bytes', id), 0);
    assert.equal(call('linux_startup_translation_finish', id, 1, 4096n, 0n, 56n, 0n, 131072n), 0);
  }
  return {call, result, auxiliary, put, begin, translated, exports: e};
}

test('real startup ABI excludes diagnostic mutation and binds one physical owner', {skip: !artifact}, () => {
  const r = rawPrepared(), a = r.begin(), b = r.begin();
  for (const id of [a, b]) {
    assert.ok(r.call('linux_run_start', id) < 0);
    assert.ok(r.call('linux_image_begin', id, 131072n) < 0);
    assert.ok(r.call('linux_stack_input', id, 0) < 0);
    r.translated(id);
  }
  assert.equal(r.call('linux_bind', 131072n), 0); const binding = r.result();
  assert.equal(r.call('linux_startup_image_begin', a, binding, 65536n, 131072n), 0);
  assert.ok(r.call('linux_startup_image_begin', b, binding, 65536n, 131072n) < 0);
  assert.ok(r.call('linux_span', binding, 0n, 1n) < 0);
  assert.ok(r.call('linux_change', binding, 131072n) < 0);
  assert.equal(r.call('linux_startup_stack', a), 0);
  assert.equal(r.call('linux_startup_image_finish', a, 0), 0); const liveBinding = r.result();
  assert.ok(r.call('linux_stack_input', a, 0) < 0);
  assert.ok(r.call('linux_image_begin', a, 131072n) < 0);
  assert.ok(r.call('linux_span', liveBinding, 0n, 1n) < 0);
  assert.equal(r.call('linux_startup_entry', a), 0); assert.equal(r.result(), 4096n);
  assert.equal(r.call('linux_execution_unstarted_stopped', a), 0);
  assert.equal(r.call('linux_execution_retire', a), 0); assert.equal(r.result(), 1n);
  assert.ok(r.call('linux_span', liveBinding, 0n, 1n) < 0);
  assert.equal(r.call('linux_startup_cancel', b), 0); assert.equal(r.result(), 1n);
  const c = r.begin(); assert.ok(c > b); // old ID never names this new owner's work
  assert.ok(r.call('linux_startup_translation_finish', b, 1, 0n, 0n, 0n, 0n, 131072n) < 0);
  assert.equal(r.call('linux_startup_cancel', c), 0);
});

test('real startup ABI quarantines Unknown image and preserves its retired binding', {skip: !artifact}, () => {
  const r = rawPrepared(), id = r.begin(); r.translated(id);
  assert.equal(r.call('linux_bind', 131072n), 0); const binding = r.result();
  assert.equal(r.call('linux_startup_image_begin', id, binding, 65536n, 131072n), 0);
  assert.equal(r.call('linux_startup_image_finish', id, 3), 0);
  assert.ok(r.call('linux_startup_stack', id) < 0);
  assert.ok(r.call('linux_startup_image_finish', id, 0) < 0);
  assert.equal(r.call('linux_startup_cancel', id), 0); assert.equal(r.result(), 0n);
  assert.equal(r.call('linux_startup_image_finish', id, 2), 0);
  assert.equal(r.call('linux_startup_failed_image', id), 0); const retired = r.result();
  assert.notEqual(retired, binding);
  assert.equal(r.call('linux_startup_cancel', id), 0); assert.equal(r.result(), 1n);
  assert.ok(r.call('linux_span', retired, 0n, 1n) < 0);
});

test('real startup ABI keeps cancelled source ownership until matching completion', {skip: !artifact}, () => {
  const r = rawPrepared(true), id = r.begin();
  assert.equal(r.call('linux_startup_source_start', id), 0);
  assert.equal(r.result(), 7n); const attempt = Number(r.auxiliary());
  assert.equal(r.call('linux_startup_cancel', id), 0); assert.equal(r.result(), 0n);
  assert.ok(r.call('linux_startup_check', id) < 0);
  r.put('linux_load_input', bytes('late'));
  assert.ok(r.call('linux_startup_source_finish', id, attempt + 1, 1) < 0);
  assert.equal(r.call('linux_startup_cancel', id), 0); assert.equal(r.result(), 0n);
  assert.equal(r.call('linux_startup_source_finish', id, attempt, 1), 0);
  assert.equal(r.call('linux_startup_cancel', id), 0); assert.equal(r.result(), 1n);
  const next = r.begin();
  assert.equal(r.call('linux_startup_source_start', next), 0);
  assert.equal(r.result(), 7n); const nextAttempt = Number(r.auxiliary());
  assert.notEqual(nextAttempt, attempt);
  assert.equal(r.call('linux_startup_source_finish', next, nextAttempt, 0), 0);
  assert.equal(r.call('linux_startup_cancel', next), 0); assert.equal(r.result(), 1n);
});


test('real stream ABI prevents generic receipt bypass and retains unknown host effects after guest stop', {skip: !artifact}, () => {
  // Synthetic stop receipts test the actual ABI, not real host I/O behavior.
  const r = rawPrepared(false, true), id = r.begin(); r.translated(id);
  assert.equal(r.call('linux_bind', 131072n), 0); const binding = r.result();
  assert.equal(r.call('linux_startup_image_begin', id, binding, 65536n, 131072n), 0);
  assert.equal(r.call('linux_startup_image_finish', id, 0), 0);
  assert.equal(r.call('linux_run_start', id), 0); const invocation = r.result();
  assert.equal(r.call('linux_syscall', id, invocation, 1n, 1n, 32n, 4n, 0n, 0n, 0n, 4096n), 0);
  const action = r.result();
  assert.equal((r.exports.linux_result_state as () => number)(), 263);
  assert.equal((r.exports.linux_result_endpoint as () => bigint)(), 2n);
  assert.equal(r.auxiliary(), 32n);
  assert.equal((r.exports.linux_result_length as () => bigint)(), 4n);
  assert.ok(r.call('linux_start', action) < 0);
  assert.ok(r.call('linux_receipt', action, 4n, 0) < 0);
  assert.equal(r.call('linux_stream_start', id, action), 0);
  assert.ok(r.call('linux_stream_start', id, action) < 0);
  assert.ok(r.call('linux_stream_receipt', id, action + 1n, 0n, 0) < 0);
  assert.equal(r.call('linux_stream_receipt', id, action, 2n, 6), 0);
  assert.equal((r.exports.linux_result_state as () => number)(), 4);
  assert.equal(r.call('linux_run_receipt', id, invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', id), 0); assert.equal(r.result(), 0n);
  assert.ok(r.call('linux_stream_receipt', id, action, 1n, 0) < 0);
  assert.ok(r.call('linux_stream_receipt', id, action, 2n, 5) < 0);
  assert.equal(r.call('linux_stream_receipt', id, action, 2n, 0), 0);
  assert.equal((r.exports.linux_result_state as () => number)(), 4);
  assert.equal(r.call('linux_execution_retire', id), 0); assert.equal(r.result(), 1n);
  assert.ok(r.call('linux_stream_receipt', id, action, 2n, 0) < 0);
});

test('cwd resolution rejects missing, file and looping paths before source and releases partial startup owners', {skip: !artifact}, async () => {
  const host = memoryHost(new WebAssembly.Module(readFileSync(artifact!)), 8, 16);
  const root = host.preparePreparedFiles({inodes: 8, entries: 8, fileBytes: 64,
    tables: 1, descriptions: 1, slots: 3, reads: 2, contexts: 1, views: 1, holds: 8,
    policy: {noExec: false, noSuid: false, noSymfollow: false}});
  const work = host.directory(root, bytes('work'));
  host.lazyFile(work, bytes('program'), 7, 3, 0o755);
  host.symlink(work, bytes('alias'), bytes('program'));
  host.symlink(root, bytes('cwd'), bytes('work'));
  host.symlink(root, bytes('loop'), bytes('loop'));
  assert.throws(() => host.symlink(root, bytes('bad'), new Uint8Array([0])));
  host.sealFiles(3);
  assert.throws(() => host.symlink(root, bytes('late'), bytes('work')));
  const translator = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
  let loads = 0;
  const load = () => { loads++; throw new Error('expected source stop'); };
  for (const cwd of ['/missing', '/work/program', '/loop']) {
    await assert.rejects(host.pathExecution(bytes('alias'), [], [], {
      translator, random: new Uint8Array(16), cwd: bytes(cwd), load,
    }));
    assert.equal(loads, 0);
  }
  // With one Fs slot, this also proves failed cwd owners were retired.
  await assert.rejects(host.pathExecution(bytes('alias'), [], [], {
    translator, random: new Uint8Array(16), cwd: bytes('/cwd'), load,
  }), /expected source stop/);
  assert.equal(loads, 1);
});
