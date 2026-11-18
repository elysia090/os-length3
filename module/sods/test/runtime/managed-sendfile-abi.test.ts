import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {memoryHost} from '../../runtime/linux/memory-host.ts';
import {createGuest} from '../../runtime/host/node/execution.ts';
import {verifiedCaptureCandidate} from '../../runtime/host/node/capture-artifact.ts';
import {fixedTranslatedModule, fixedTranslatedModuleAsync} from '../../runtime/linux/translated-image.ts';
import {prepare} from '../../runtime/translation/share.ts';
import {loadTranslator, NotAProgram} from '../../runtime/translation/translator.ts';

// These are real Core ABI probes with synthetic image/capability/output setup.
// Named Node cases exercise a real Worker and owned regular-file deliveries.
// None qualifies an arbitrary borrowed descriptor, socket, native sendfile or SIGPIPE.
// A probe-feature Core must never enter the production host.
const normalArtifact = process.env.SODS_LINUX_WASM;
const probeArtifact = process.env.SODS_SENDFILE_PROBE_WASM;
const queueArtifact = process.env.SODS_QUEUED_OUTPUT_PROBE_WASM;
const workerQueueArtifact = process.env.SODS_QUEUED_WORKER_PROBE_WASM;
const resultArtifact = process.env.SODS_CAPTURE_RESULT_WASM;
const currentTranslatorArtifact = process.env.SODS_CURRENT_TRANSLATOR_WASM;
const normalSkip = normalArtifact ? false : 'Requires explicit SODS_LINUX_WASM production ABI7 artifact';
const probeSkip = probeArtifact ? false : 'Requires explicit SODS_SENDFILE_PROBE_WASM feature artifact; normal core cannot accept proof1';
const queueSkip = queueArtifact ? false : 'Requires the isolated SODS_QUEUED_OUTPUT_PROBE_WASM feature artifact';
const workerQueueSkip = workerQueueArtifact ? false : 'Requires the stronger SODS_QUEUED_WORKER_PROBE_WASM feature artifact';
const currentMixedSkip = workerQueueSkip || (!currentTranslatorArtifact || process.platform !== 'linux' || process.arch !== 'x64'
  ? 'Requires explicit current-source translator and a Linux x86-64 fixture compiler' : false);
const currentResultSkip = !resultArtifact || !currentTranslatorArtifact || process.platform !== 'linux' || process.arch !== 'x64'
  ? 'Requires the explicit independent-result artifact and current Linux x86-64 translator' : false;
const bytes = (value: string) => new TextEncoder().encode(value);
type Owner = {id: bigint; invocation: bigint; sequence: number};
type Send = {owner: Owner; action: bigint; sequence: number; endpoint: bigint; offered: bigint};

function raw(path: string, probe: boolean, lazyData = false, queued = false, workerQueue = false, program = bytes('abcdef'), resultProfile = false) {
  const wasm = new Uint8Array(readFileSync(path));
  if (resultProfile) {
    // CI pins a separate known build independently before exercising this
    // private relay. This is intentionally not an application-facing loader.
    assert.equal(wasm.byteLength, Number(process.env.SODS_CAPTURE_RESULT_BYTES));
    assert.equal(createHash('sha256').update(wasm).digest('hex'), process.env.SODS_CAPTURE_RESULT_SHA256);
  }
  const module = new WebAssembly.Module(wasm);
  assert.equal(WebAssembly.Module.imports(module).length, 0);
  const e = new WebAssembly.Instance(module).exports;
  if (resultProfile) {
    const marker = WebAssembly.Module.customSections(module, 'sods.linux.capture');
    assert.equal(marker.length, 1);
    assert.deepEqual([...new Uint8Array(marker[0]!)], [83, 79, 68, 83, 67, 65, 80, 0, 7, 6, 2, 0]);
    assert.ok(!Object.keys(e).some(name => name.startsWith('linux_queued_') || name.startsWith('linux_sendfile_')));
    for (const name of ['linux_startup_begin', 'linux_startup_begin_stdio', 'linux_execution_create']) assert.equal(e[name], undefined);
  }
  assert.equal(typeof e.linux_queued_worker_probe_startup_shared, workerQueue ? 'function' : 'undefined');
  assert.equal(typeof e.linux_queued_worker_probe_init_joined, workerQueue ? 'function' : 'undefined');
  const call = (name: string, ...args: (number | bigint)[]): number => {
    assert.equal(typeof e[name], 'function', `Missing ABI7 export ${name}`);
    return (e[name] as (...values: (number | bigint)[]) => number)(...args);
  };
  const result = () => (e.linux_result as () => bigint)();
  const state = () => (e.linux_result_state as () => number)();
  const length = () => (e.linux_result_length as () => bigint)();
  const auxiliary = () => (e.linux_result_auxiliary as () => bigint)();
  const endpoint = () => (e.linux_result_endpoint as () => bigint)();
  const command = () => ({tag: state(), value: result(), next: length(), target: auxiliary(), endpoint: endpoint()});
  const put = (name: string, value: Uint8Array) => {
    assert.equal(call(name, value.length), 0);
    const pointer = result();
    new Uint8Array((e.memory as WebAssembly.Memory).buffer, Number(pointer), value.length).set(value);
    return pointer;
  };
  assert.equal(call('linux_abi_version'), 7, 'Explicit artifacts must be fresh ABI7, not silently skipped ABI6');
  assert.equal(Object.hasOwn(e, 'linux_sendfile_probe'), probe, 'Normal/probe artifacts must not be interchanged');
  assert.equal(Object.hasOwn(e, 'linux_sendfile_probe_access_ended'), probe);
  for (const name of ['init', 'publish', 'peek', 'discard', 'startup']) {
    assert.equal(Object.hasOwn(e, `linux_queued_output_probe_${name}`), queued);
  }
  for (const name of ['write', 'start', 'finish', 'sendfile', 'request']) {
    assert.equal(Object.hasOwn(e, `linux_queued_worker_probe_${name}`), workerQueue);
  }
  for (const name of ['head', 'start', 'finish']) {
    assert.equal(Object.hasOwn(e, `linux_queued_worker_probe_receive_${name}`), workerQueue);
  }
  for (const name of ['bind', 'head', 'copy_start', 'offer', 'receipt', 'cancel', 'discard', 'shutdown']) {
    assert.equal(Object.hasOwn(e, `linux_queued_worker_probe_sink_${name}`), workerQueue);
  }
  if (probe) assert.equal(call('linux_sendfile_probe'), 1);
  assert.equal(call('linux_init', 16, 64), 0);
  if (resultProfile) {
    assert.equal(call('linux_capture_candidate'), 2);
    assert.equal(call('linux_capture_select', 1), -12);
    assert.equal(call('linux_capture_select', 2), 0);
    assert.equal(call('linux_capture_result_init', 4, 4), -9, 'exact sealed Files must precede the receiver');
  }
  assert.equal(call('linux_prepared_files', 8, 8, Math.max(4096, program.length), 16, 128, 256, 16, 32, 1, 192, 0), 0);
  const root = result();
  put('linux_name', bytes('app')); put('linux_input', program);
  assert.equal(call('linux_tree_file', root, 0o755), 0);
  if (lazyData) {
    put('linux_name', bytes('data'));
    assert.equal(call('linux_tree_lazy', root, 0o444, 7, 0), 0);
  }
  if (workerQueue || resultProfile) {
    put('linux_name', bytes('source')); put('linux_input', bytes('BD'));
    assert.equal(call('linux_tree_file', root, 0o444), 0);
  }
  assert.equal(call('linux_files_seal', 16), 0);

  const stageStartup = (program = '/app', argv: readonly string[] = []) => {
    const path = bytes(program), args = argv.map(bytes), inputLength = args.reduce((n, a) => n + 8 + a.length, 0);
    const wire = new Uint8Array(48 + path.length + inputLength), view = new DataView(wire.buffer);
    view.setBigUint64(0, 1n, true); view.setBigUint64(8, BigInt(args.length), true);
    view.setBigUint64(24, BigInt(path.length), true); wire.set(path, 48);
    let offset = 48 + path.length;
    for (const arg of args) {
      view.setBigUint64(offset, BigInt(arg.length), true);
      wire.set(arg, offset + 8); offset += 8 + arg.length;
    }
    put('linux_startup_input', wire);
  };
  const live = (captured = false): Owner => {
    stageStartup();
    assert.equal(call(captured ? 'linux_queued_output_probe_startup' : 'linux_startup_begin_stdio'), 0); const id = result();
    assert.equal(call('linux_startup_input', 0), 0);
    assert.equal(call('linux_startup_source_start', id), 0); assert.equal(result(), 0n);
    assert.equal(call('linux_startup_bytes', id), 0);
    assert.equal(call('linux_startup_translation_finish', id, 1, 4096n, 0n, 56n, 0n, 131072n), 0);
    assert.equal(call('linux_bind', 131072n), 0); const binding = result();
    assert.equal(call('linux_startup_image_begin', id, binding, 65536n, 131072n), 0);
    assert.equal(call('linux_startup_image_finish', id, 0), 0);
    assert.equal(call('linux_run_start', id), 0);
    return {id, invocation: result(), sequence: 0};
  };
  const request = (owner: Owner, nr: bigint, args: readonly bigint[], next = 4096n) => {
    assert.equal(args.length, 6);
    assert.equal(call('linux_syscall_sequenced', owner.id, owner.invocation, ++owner.sequence, nr, ...args, next), 0);
    return command();
  };
  const openReady = (owner: Owner) => {
    const c = request(owner, 2n, [32n, 0n, 0n, 0n, 0n, 0n]);
    assert.equal(c.tag, 8); return c.value;
  };
  const capturePath = (owner: Owner, action: bigint, path: string) => {
    const value = bytes(`${path}\0`);
    assert.equal(call('linux_syscall_path_start', owner.id, action), 0); const pointer = result();
    assert.ok(length() >= BigInt(value.length));
    new Uint8Array((e.memory as WebAssembly.Memory).buffer, Number(pointer), value.length).set(value);
    return value;
  };
  const open = (owner: Owner, path = '/app') => {
    const action = openReady(owner), value = capturePath(owner, action, path);
    assert.equal(call('linux_syscall_path_finish', owner.id, action, BigInt(value.length), 0), 0);
    assert.equal(state(), 0); const fd = result(); assert.equal(fd, 3n); return fd;
  };
  const begin = (owner: Owner, fd: bigint, count = 6n): Send => {
    const c = request(owner, 40n, [1n, fd, 0n, count, 0x55n, 0x66n]);
    assert.equal(c.tag, 10); assert.equal(c.target, BigInt(owner.sequence)); assert.equal(c.endpoint, 2n);
    return {owner, action: c.value, sequence: owner.sequence, endpoint: c.endpoint, offered: 0n};
  };
  const capStart = (send: Send) => {
    assert.equal(call('linux_sendfile_cap_start', send.owner.id, send.sequence, send.action), 0);
    assert.equal(result(), send.action); assert.equal(auxiliary(), BigInt(send.sequence));
    assert.equal(endpoint(), send.endpoint);
  };
  const capFinish = (send: Send, proof: number) => {
    assert.equal(call('linux_sendfile_cap_finish', send.owner.id, send.sequence, send.action, send.endpoint, proof), 0);
    const c = command();
    if (c.tag === 12) {
      assert.equal(c.value, send.action); assert.equal(c.target, BigInt(send.sequence));
      assert.equal(c.endpoint, send.endpoint); send.offered = c.next;
    }
    return c;
  };
  const qualify = (send: Send) => { capStart(send); return capFinish(send, 1); };
  const start = (send: Send) => {
    assert.equal(call('linux_sendfile_start', send.owner.id, send.sequence, send.action), 0);
    const c = command(); assert.equal(c.tag, 0); assert.equal(c.target, BigInt(send.sequence));
    assert.equal(c.endpoint, send.endpoint); assert.equal(c.next, send.offered); return c.value;
  };
  const finish = (send: Send, count: bigint, outcome = 0, ended = 1) => {
    assert.equal(call('linux_sendfile_receipt', send.owner.id, send.sequence, send.action, count, outcome, ended), 0);
    return command();
  };
  const genericBlocked = (action: bigint) => {
    for (const [name, args] of [
      ['linux_start', [action]], ['linux_cancel', [action]],
      ['linux_receipt', [action, 0n, 0]], ['linux_retire', [action]],
    ] as const) assert.equal(call(name, ...args), -4, name);
  };
  const remaining = (owner: Owner, fd: bigint): Uint8Array => {
    assert.equal(call('linux_managed_read_begin', owner.id, Number(fd), 0n, 6n), 0); const read = result();
    assert.equal(call('linux_managed_read_start', owner.id, read), 0); const pointer = result(), n = length();
    // Test observation only. This snapshot is not the product sendfile transport.
    const value = Uint8Array.from(new Uint8Array((e.memory as WebAssembly.Memory).buffer, Number(pointer), Number(n)));
    assert.equal(call('linux_read_receipt', read, 0n, 0), 0); // Observe without advancing its cursor.
    assert.equal(call('linux_read_retire', read), 0); return value;
  };
  const transfer = captureTransfer({e, call, result, length, auxiliary, endpoint}, resultProfile);
  return {wasm, module, e, call, result, state, length, auxiliary, endpoint, command, put,
    receive: (lane: number, limit?: number) => transfer(lane, false, limit)?.bytes,
    receiveRecord: (lane: number, limit?: number) => transfer(lane, false, limit),
    transferForSink: (lane: number) => transfer(lane, true),
    stageStartup, live, request, openReady, capturePath, open, begin, capStart, capFinish, qualify, start, finish, genericBlocked, remaining};
}

// Parse actual Wasm function parameter types. Type-correct probes must reach the
// core guard, not pass because JavaScript rejected Number versus BigInt first.
function signatures(wasm: Uint8Array): Map<string, number[]> {
  let at = 8; const types: number[][] = [], functions: number[] = [], exports: [string, number][] = [];
  const leb = () => { let n = 0, shift = 0, b: number; do { b = wasm[at++]!; n += (b & 127) * 2 ** shift; shift += 7; } while (b & 128); return n; };
  while (at < wasm.length) {
    const id = wasm[at++]!, size = leb(), end = at + size;
    if (id === 1) for (let i = leb(); i; i--) {
      assert.equal(wasm[at++], 0x60); const count = leb(); types.push(Array.from(wasm.slice(at, at + count))); at += count;
      const returns = leb(); at += returns;
    } else if (id === 3) for (let i = leb(); i; i--) functions.push(leb());
    else if (id === 7) for (let i = leb(); i; i--) {
      const count = leb(), name = new TextDecoder().decode(wasm.slice(at, at + count)); at += count;
      const kind = wasm[at++]!, index = leb(); if (kind === 0) exports.push([name, index]);
    }
    at = end;
  }
  return new Map(exports.map(([name, index]) => [name, types[functions[index]!]!]));
}

test('production ABI7 rejects synthetic acceptance without losing its exact capability ticket', {skip: normalSkip}, () => {
  const r = raw(normalArtifact!, false, true), owner = r.live(), fd = r.open(owner, '/data'), send = r.begin(owner, fd);
  r.genericBlocked(send.action); r.capStart(send);
  for (const [endpoint, proof] of [[send.endpoint, 1], [send.endpoint, 2], [send.endpoint + 1n, 0]] as const) {
    assert.ok(r.call('linux_sendfile_cap_finish', owner.id, send.sequence, send.action, endpoint, proof) < 0);
    r.genericBlocked(send.action);
    assert.ok(r.call('linux_sendfile_load_start', owner.id, send.sequence, send.action) < 0);
  }
  const rejected = r.capFinish(send, 0); assert.equal(rejected.tag, 3); assert.equal(rejected.value, 40n);
  assert.ok(r.call('linux_sendfile_cap_finish', owner.id, send.sequence, send.action, send.endpoint, 0) < 0);
  assert.ok(r.call('linux_syscall_sequenced', owner.id, owner.invocation, 3, 3n, fd, 0n, 0n, 0n, 0n, 0n, 4096n) < 0);
  // A separate private read observes attempt1: sendfile rejection did not even
  // prepare a source attempt. This is not a guest fallback or physical loader.
  assert.equal(r.call('linux_managed_read_begin', owner.id, Number(fd), 0n, 6n), 0); const read = r.result();
  assert.equal(r.call('linux_read_load_start', owner.id, read), 0); assert.equal(r.result(), 7n);
  const attempt = Number(r.length()); assert.equal(attempt, 1);
  assert.equal(r.call('linux_read_load_finish', owner.id, read, attempt, 0), 0);
  assert.equal(r.call('linux_read_retire', read), 0);
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
});

test('production capability rejection preserves a resident source cursor and never returns a fabricated errno', {skip: normalSkip}, () => {
  const r = raw(normalArtifact!, false), owner = r.live(), fd = r.open(owner), send = r.begin(owner, fd);
  r.capStart(send); const rejected = r.capFinish(send, 0);
  assert.equal(rejected.tag, 3); assert.equal(rejected.value, 40n);
  assert.deepEqual(r.remaining(owner, fd), bytes('abcdef'));
});

test('unsequenced sendfile is Unsupported40 and cannot admit a capability or consume the Worker sequence', {skip: normalSkip}, () => {
  const r = raw(normalArtifact!, false), owner = r.live(), fd = r.open(owner);
  assert.equal(r.call('linux_syscall', owner.id, owner.invocation, 40n, 1n, fd, 0n, 6n, 0n, 0n, 4096n), 0);
  assert.equal(r.state(), 3); assert.equal(r.result(), 40n);
  const send = r.begin(owner, fd); assert.equal(send.sequence, 2);
  r.capStart(send); assert.equal(r.capFinish(send, 0).tag, 3);
});

test('probe sentinel rejects the real feature module and even shape/version-independent trapping stubs before instantiation', {skip: probeSkip}, () => {
  const module = new WebAssembly.Module(readFileSync(probeArtifact!));
  assert.ok(WebAssembly.Module.exports(module).some(e => e.name === 'linux_sendfile_probe'));
  assert.throws(() => memoryHost(module, 1, 1), /probe/i);
  const leb = (n: number) => { const out: number[] = []; do { const b = n & 127; n = Math.floor(n / 128); out.push(b | (n ? 128 : 0)); } while (n); return out; };
  const section = (id: number, payload: number[]) => [id, ...leb(payload.length), ...payload];
  const name = (value: string) => { const valueBytes = Array.from(bytes(value)); return [...leb(valueBytes.length), ...valueBytes]; };
  for (const version of [6, 7]) {
    // This stub lacks all other required names and has a trapping start function.
    // Only a pre-instantiation sentinel check gives the required probe error.
    const stub = new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0,
      ...section(1, [2, 0x60, 0, 1, 0x7f, 0x60, 0, 0]), ...section(3, [3, 0, 0, 1]),
      ...section(5, [1, 0, 1]), ...section(7, [3, ...name('memory'), 2, 0, ...name('linux_sendfile_probe'), 0, 0, ...name('linux_abi_version'), 0, 1]),
      ...section(8, [2]), ...section(10, [3, 4, 0, 0x41, 1, 0x0b, 4, 0, 0x41, version, 0x0b, 3, 0, 0, 0x0b]),
    ]));
    assert.throws(() => memoryHost(stub, 1, 1), /probe/i);
  }
});

test('one canonical send view excludes every unrelated export with type-correct arguments', {skip: probeSkip}, () => {
  const r = raw(probeArtifact!, true), owner = r.live(), fd = r.open(owner), send = r.begin(owner, fd);
  assert.equal(r.qualify(send).tag, 12); assert.equal(send.offered, 6n); const pointer = r.start(send);
  const scalars = new Set(['linux_abi_version', 'linux_sendfile_probe', 'linux_result', 'linux_result_length',
    'linux_result_auxiliary', 'linux_result_endpoint', 'linux_result_state']);
  let checked = 0;
  for (const [name, params] of signatures(r.wasm)) {
    if (scalars.has(name)) continue;
    const status = r.call(name, ...params.map(type => type === 0x7e ? 0n : 0));
    // Reinitialization is a fixed no-allocation -9, not a view-bypass route.
    assert.equal(status, name === 'linux_init' ? -9 : -4, name); checked++;
  }
  assert.ok(checked > 60);
  for (const [id, sequence, action] of [[owner.id + 1n, send.sequence, send.action],
    [owner.id, send.sequence + 1, send.action], [owner.id, send.sequence, send.action + 1n]] as const) {
    assert.equal(r.call('linux_sendfile_receipt', id, sequence, action, 3n, 0, 1), -4);
  }
  assert.deepEqual(new Uint8Array((r.e.memory as WebAssembly.Memory).buffer, Number(pointer), 6), bytes('abcdef'));
  const done = r.finish(send, 3n); assert.equal(done.tag, 0); assert.equal(done.value, 3n);
  assert.deepEqual(r.remaining(owner, fd), bytes('def'));
  assert.ok(r.call('linux_sendfile_receipt', owner.id, send.sequence, send.action, 3n, 0, 1) < 0);
  assert.deepEqual(r.remaining(owner, fd), bytes('def'), 'duplicate cannot advance the original cursor twice');
});

test('a different live owner genuine late-Stopped receipt cannot bypass the current send view', {skip: probeSkip}, () => {
  const r = raw(probeArtifact!, true), b = r.live(), fdB = r.open(b), sendB = r.begin(b, fdB);
  assert.equal(r.qualify(sendB).tag, 12); r.start(sendB); assert.equal(r.finish(sendB, 0n, 6, 1).tag, 4);
  const a = r.live(), fdA = r.open(a), sendA = r.begin(a, fdA);
  assert.notEqual(sendA.action, sendB.action); assert.equal(r.qualify(sendA).tag, 12); r.start(sendA);
  // B is a real live execution with a real same-issuer Unknown action, not an
  // unissued token or a Ready action that Domain would reject as NotExecuting.
  assert.equal(r.call('linux_sendfile_receipt', b.id, sendB.sequence, sendB.action, 0n, 0, 1), -4);
  assert.equal(r.call('linux_read_query', 1n), -4, 'old Access::Read exception cannot bypass send guard');
  assert.equal(r.finish(sendA, 3n).tag, 0); assert.deepEqual(r.remaining(a, fdA), bytes('def'));
  assert.equal(r.finish(sendB, 0n).tag, 4, 'closed B cannot resurrect Return');
  assert.deepEqual(r.remaining(b, fdB), bytes('abcdef'));
});

test('combined Unknown/access-ended preflight rejects malformed evidence without clearing the guard', {skip: probeSkip}, () => {
  const r = raw(probeArtifact!, true), owner = r.live(), fd = r.open(owner), send = r.begin(owner, fd);
  r.qualify(send); r.start(send);
  const invalid = (count: bigint, outcome: number, ended: number) => {
    assert.ok(r.call('linux_sendfile_receipt', owner.id, send.sequence, send.action, count, outcome, ended) < 0);
    assert.equal(r.call('linux_load_input', 0), -4, 'invalid receipt must not clear the live view');
  };
  invalid(0n, 0, 0); invalid(0n, 0, 2); invalid(0n, 8, 1); invalid(1n, 1, 1); invalid(7n, 6, 1);
  assert.equal(r.finish(send, 2n, 6, 0).tag, 4);
  assert.equal(r.call('linux_load_input', 0), -4, 'Unknown prefix alone is not access-ended');
  invalid(1n, 6, 1); invalid(2n, 8, 1); invalid(2n, 6, 2);
  assert.equal(r.finish(send, 3n, 6, 1).tag, 4);
  assert.equal(r.call('linux_load_input', 0), 0, 'valid independent ended evidence releases only the lexical guard');
  assert.equal(r.call('linux_sendfile_query', owner.id), 0);
  assert.equal(r.state(), 0x107); assert.equal(r.result(), 3n); assert.equal(r.length(), 6n);
  assert.equal(r.auxiliary(), BigInt(send.sequence)); assert.equal(r.endpoint(), send.endpoint);
  r.genericBlocked(send.action);
  assert.ok(r.call('linux_run_start', owner.id) < 0);
  assert.ok(r.call('linux_managed_read_begin', owner.id, Number(fd), 0n, 6n) < 0, 'uncertain cursor stays reserved');
  assert.ok(r.call('linux_sendfile_start', owner.id, send.sequence, send.action) < 0, 'Unknown is never reoffered');
  assert.equal(r.finish(send, 5n).tag, 4);
  assert.deepEqual(r.remaining(owner, fd), bytes('f'), 'late stopped cumulative prefix is committed once');
  assert.ok(r.call('linux_sendfile_receipt', owner.id, send.sequence, send.action, 6n, 0, 1) < 0);
  assert.deepEqual(r.remaining(owner, fd), bytes('f'));
});

test('probe-only standalone access-ended releases no prefix, cursor, action or call obligation', {skip: probeSkip}, () => {
  const r = raw(probeArtifact!, true), owner = r.live(), fd = r.open(owner), send = r.begin(owner, fd);
  r.qualify(send); r.start(send); assert.equal(r.finish(send, 2n, 6, 0).tag, 4);
  assert.equal(r.call('linux_sendfile_probe_access_ended', owner.id, send.sequence + 1, send.action), -4);
  assert.equal(r.call('linux_load_input', 0), -4);
  assert.equal(r.call('linux_sendfile_probe_access_ended', owner.id, send.sequence, send.action), 0);
  assert.equal(r.call('linux_sendfile_query', owner.id), 0); assert.equal(r.state(), 0x107);
  assert.equal(r.result(), 2n); assert.equal(r.length(), 6n);
  r.genericBlocked(send.action);
  assert.ok(r.call('linux_managed_read_begin', owner.id, Number(fd), 0n, 6n) < 0);
  assert.ok(r.call('linux_sendfile_probe_access_ended', owner.id, send.sequence, send.action) < 0);
  assert.equal(r.finish(send, 2n).tag, 4);
  assert.deepEqual(r.remaining(owner, fd), bytes('cdef'));
});

test('synthetic fault/retirement cannot free an Unknown output before its real matching late receipt', {skip: probeSkip}, () => {
  const r = raw(probeArtifact!, true), owner = r.live(), fd = r.open(owner), send = r.begin(owner, fd);
  r.qualify(send); r.start(send); assert.equal(r.finish(send, 1n, 6, 1).tag, 4);
  assert.equal(r.call('linux_syscall_abandon', owner.id), 0); assert.equal(r.result(), 0n);
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 0n);
  r.genericBlocked(send.action);
  assert.equal(r.finish(send, 3n).tag, 4, 'late cleanup after fault is never guest success');
  assert.ok(r.call('linux_sendfile_receipt', owner.id, send.sequence, send.action, 3n, 0, 1) < 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
});

test('new send exports cannot bypass a valid pathname or canonical-read view', {skip: probeSkip}, () => {
  for (const kind of ['path', 'read'] as const) {
    const r = raw(probeArtifact!, true), b = r.live(), fdB = r.open(b), sendB = r.begin(b, fdB);
    r.qualify(sendB); r.start(sendB); r.finish(sendB, 0n, 6, 1);
    const a = r.live(); let viewOwner: bigint;
    if (kind === 'path') { viewOwner = r.openReady(a); r.capturePath(a, viewOwner, '/app'); }
    else {
      const fdA = r.open(a);
      assert.equal(r.call('linux_managed_read_begin', a.id, Number(fdA), 0n, 6n), 0); viewOwner = r.result();
      assert.equal(r.call('linux_managed_read_start', a.id, viewOwner), 0);
    }
    for (const [name, args] of [
      ['linux_sendfile_cap_start', [b.id, sendB.sequence, sendB.action]],
      ['linux_sendfile_cap_finish', [b.id, sendB.sequence, sendB.action, sendB.endpoint, 0]],
      ['linux_sendfile_load_start', [b.id, sendB.sequence, sendB.action]],
      ['linux_sendfile_load_finish', [b.id, sendB.sequence, sendB.action, 7, 1, 0]],
      ['linux_sendfile_start', [b.id, sendB.sequence, sendB.action]],
      ['linux_sendfile_receipt', [b.id, sendB.sequence, sendB.action, 0n, 0, 1]],
      ['linux_sendfile_probe_access_ended', [b.id, sendB.sequence, sendB.action]],
      ['linux_sendfile_cleanup', [b.id, sendB.sequence]], ['linux_sendfile_query', [b.id]],
    ] as const) assert.equal(r.call(name, ...args), -4, `${kind}: ${name}`);
    if (kind === 'path') assert.equal(r.call('linux_syscall_path_finish', a.id, viewOwner, 5n, 0), 0);
    else { assert.equal(r.call('linux_read_receipt', viewOwner, 0n, 0), 0); assert.equal(r.call('linux_read_retire', viewOwner), 0); }
    assert.equal(r.finish(sendB, 0n).tag, 4);
  }
});

test('lazy source commands retain exact source/attempt and do not consume malformed completion staging', {skip: probeSkip}, () => {
  const r = raw(probeArtifact!, true, true), owner = r.live(), fd = r.open(owner, '/data'), send = r.begin(owner, fd);
  assert.equal(r.qualify(send).tag, 11); r.genericBlocked(send.action);
  assert.equal(r.call('linux_sendfile_load_start', owner.id, send.sequence, send.action), 0);
  const source = Number(r.result()), attempt = Number(r.length()); assert.equal(source, 7); assert.equal(attempt, 1);
  assert.equal(r.auxiliary(), BigInt(send.sequence));
  assert.ok(r.call('linux_sendfile_load_start', owner.id, send.sequence, send.action) < 0);
  const pointer = r.put('linux_load_input', bytes('abcdef'));
  for (const [s, a, success] of [[source + 1, attempt, 1], [source, attempt + 1, 1], [source, attempt, 2]] as const) {
    assert.ok(r.call('linux_sendfile_load_finish', owner.id, send.sequence, send.action, s, a, success) < 0);
    assert.deepEqual(new Uint8Array((r.e.memory as WebAssembly.Memory).buffer, Number(pointer), 6), bytes('abcdef'));
  }
  assert.equal(r.call('linux_sendfile_load_finish', owner.id, send.sequence, send.action, source, attempt, 1), 0);
  assert.equal(r.state(), 12); send.offered = r.length(); assert.equal(send.offered, 6n);
  assert.equal(r.call('linux_load_input', 0), 0);
  const output = r.start(send);
  assert.deepEqual(new Uint8Array((r.e.memory as WebAssembly.Memory).buffer, Number(output), 6), bytes('abcdef'));
  assert.equal(r.finish(send, 3n).tag, 0); assert.deepEqual(r.remaining(owner, fd), bytes('def'));
});

test('count0 still requires capability but leaves a lazy source absent for the next nonzero call', {skip: probeSkip}, () => {
  const r = raw(probeArtifact!, true, true), owner = r.live(), fd = r.open(owner, '/data'), zero = r.begin(owner, fd, 0n);
  assert.ok(r.call('linux_sendfile_start', owner.id, zero.sequence, zero.action) < 0);
  assert.equal(r.qualify(zero).tag, 12); assert.equal(zero.offered, 0n); assert.equal(r.start(zero), 0n);
  const done = r.finish(zero, 0n); assert.equal(done.tag, 0); assert.equal(done.value, 0n);
  const next = r.begin(owner, fd); assert.equal(r.qualify(next).tag, 11);
  assert.equal(r.call('linux_sendfile_load_start', owner.id, next.sequence, next.action), 0);
  assert.equal(r.result(), 7n); const attempt = Number(r.length()); assert.equal(attempt, 1);
  assert.equal(r.call('linux_syscall_abandon', owner.id), 0); assert.equal(r.result(), 0n);
  assert.equal(r.call('linux_sendfile_load_finish', owner.id, next.sequence, next.action, 7, attempt, 0), 0);
  assert.equal(r.state(), 4);
});

test('late stopped loader after synthetic guest fault cannot adopt staged bytes or restore Return', {skip: probeSkip}, () => {
  const r = raw(probeArtifact!, true, true), owner = r.live(), fd = r.open(owner, '/data'), send = r.begin(owner, fd);
  assert.equal(r.qualify(send).tag, 11);
  assert.equal(r.call('linux_sendfile_load_start', owner.id, send.sequence, send.action), 0);
  const source = Number(r.result()), attempt = Number(r.length());
  assert.equal(r.call('linux_syscall_abandon', owner.id), 0); assert.equal(r.result(), 0n);
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 0n);
  const pointer = r.put('linux_load_input', bytes('abcdef'));
  assert.equal(r.call('linux_sendfile_load_finish', owner.id, send.sequence, send.action, source, attempt, 1), 0);
  assert.equal(r.state(), 4);
  assert.deepEqual(new Uint8Array((r.e.memory as WebAssembly.Memory).buffer, Number(pointer), 6), bytes('abcdef'));
  assert.equal(r.call('linux_load_input', 0), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
});

test('every stopped-zero physical error closes transport instead of manufacturing a sendfile errno', {skip: probeSkip}, () => {
  for (const outcome of [1, 2, 3, 4, 5, 7]) {
    const r = raw(probeArtifact!, true), owner = r.live(), fd = r.open(owner), send = r.begin(owner, fd);
    r.qualify(send); r.start(send); const done = r.finish(send, 0n, outcome);
    assert.equal(done.tag, 4, `physical outcome ${outcome} cannot be guest errno/Return`);
    assert.deepEqual(r.remaining(owner, fd), bytes('abcdef'));
    assert.ok(r.call('linux_syscall_sequenced', owner.id, owner.invocation, 3, 3n, fd, 0n, 0n, 0n, 0n, 0n, 4096n) < 0);
  }
});

test('nonempty stopped0 settles once but closes transport instead of claiming qualified EOF', {skip: probeSkip}, () => {
  const r = raw(probeArtifact!, true), owner = r.live(), fd = r.open(owner), send = r.begin(owner, fd);
  assert.equal(r.qualify(send).tag, 12); assert.equal(send.offered, 6n); r.start(send);
  assert.equal(r.call('linux_load_input', 0), -4, 'the actual nonempty offer owns the canonical view');
  const done = r.finish(send, 0n);
  assert.equal(done.tag, 4, 'physical stopped0 is valid settlement, not proved sendfile Return0 for nonempty input');
  assert.equal(r.call('linux_sendfile_query', owner.id), 0); assert.equal(r.state(), 0xffff);
  assert.equal(r.result(), 0n); assert.equal(r.length(), 0n); assert.equal(r.auxiliary(), 0n); assert.equal(r.endpoint(), 0n);
  assert.equal(r.call('linux_load_input', 0), 0, 'known stopped/ended receipt released lexical access');
  for (const [name, args] of [
    ['linux_start', [send.action]], ['linux_cancel', [send.action]],
    ['linux_receipt', [send.action, 0n, 0]], ['linux_retire', [send.action]],
    ['linux_sendfile_start', [owner.id, send.sequence, send.action]],
    ['linux_sendfile_receipt', [owner.id, send.sequence, send.action, 0n, 0, 1]],
  ] as const) assert.ok(r.call(name, ...args) < 0, `${name}: settled action cannot replay or settle twice`);
  assert.ok(r.call('linux_syscall_sequenced', owner.id, owner.invocation, 3, 3n, fd, 0n, 0n, 0n, 0n, 0n, 4096n) < 0);
  // These private reads observe the original execution's OFD, not linux_offset's
  // separate normal table. Each observation itself commits read0/revision; only
  // native owner tests assert the exact sendfile-only revision increment.
  assert.deepEqual(r.remaining(owner, fd), bytes('abcdef'));
  assert.ok(r.call('linux_sendfile_receipt', owner.id, send.sequence, send.action, 0n, 0, 1) < 0);
  assert.deepEqual(r.remaining(owner, fd), bytes('abcdef'), 'duplicate did not advance the captured cursor');
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
});

test('actual resident EOF stays qualified offered0 and returns0 without closing the guest', {skip: probeSkip}, () => {
  const r = raw(probeArtifact!, true), owner = r.live(), fd = r.open(owner), positive = r.begin(owner, fd);
  assert.equal(r.qualify(positive).tag, 12); assert.equal(positive.offered, 6n); r.start(positive);
  const prefix = r.finish(positive, 6n); assert.equal(prefix.tag, 0); assert.equal(prefix.value, 6n);
  // The same held source OFD is now truly at its materialized resident EOF.
  // Count is still6: this is neither count0 nor a provisional lazy size hint.
  const eof = r.begin(owner, fd);
  assert.ok(r.call('linux_sendfile_start', owner.id, eof.sequence, eof.action) < 0, 'EOF cannot bypass capability');
  assert.equal(r.qualify(eof).tag, 12); assert.equal(eof.offered, 0n); assert.equal(r.start(eof), 0n);
  const done = r.finish(eof, 0n); assert.equal(done.tag, 0); assert.equal(done.value, 0n);
  assert.equal(r.call('linux_sendfile_query', owner.id), 0); assert.equal(r.state(), 0xffff);
  assert.deepEqual(r.remaining(owner, fd), new Uint8Array());
  const close = r.request(owner, 3n, [fd, 0n, 0n, 0n, 0n, 0n]);
  assert.equal(close.tag, 0); assert.equal(close.value, 0n, 'qualified EOF did not close continuation admission');
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
});

test('isolated queue probe retains distinct resident prefixes in actual Sealed after producer resource retirement', {skip: queueSkip}, () => {
  const r = raw(queueArtifact!, true, false, true);
  assert.throws(() => memoryHost(r.module, 2, 8), /Synthetic sendfile probe/);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  assert.ok(r.call('linux_queued_output_probe_init') < 0);
  const owner = r.live(), fd = r.open(owner);
  const publish = (lane: number, length: number, invocation = owner.invocation) =>
    r.call('linux_queued_output_probe_publish', owner.id, invocation, Number(fd), lane, length);
  const peek = (lane: number, index: number) => {
    assert.equal(r.call('linux_queued_output_probe_peek', lane, index), 0);
    return {length: r.length(), byte: r.result()};
  };
  for (const [lane, length, invocation] of [[2, 2, owner.invocation], [0, 0, owner.invocation], [0, 2, owner.invocation + 1n]] as const) {
    assert.ok(publish(lane, length, invocation) < 0);
  }
  assert.deepEqual(r.remaining(owner, fd), bytes('abcdef'));
  assert.equal(publish(0, 2), 0); assert.equal(r.result(), 2n);
  assert.ok(publish(0, 1) < 0, 'one full lane must refuse without moving the shared cursor');
  assert.equal(publish(1, 2), 0); assert.equal(r.result(), 2n);
  assert.equal(publish(0, 4), -5, 'partial resident tail is not an exact four-byte publication');
  assert.deepEqual(r.remaining(owner, fd), bytes('ef'));
  assert.deepEqual(peek(0, 0), {length: 2n, byte: 97n});
  assert.deepEqual(peek(1, 0), {length: 2n, byte: 99n});
  assert.equal(r.call('linux_queued_output_probe_peek', 1, 2), -5);
  const path = r.openReady(owner), pathBytes = r.capturePath(owner, path, '/app');
  assert.equal(publish(0, 1), -4);
  assert.equal(r.call('linux_queued_output_probe_peek', 0, 0), -4);
  assert.equal(r.call('linux_queued_output_probe_discard', 0), -4);
  assert.equal(r.call('linux_queued_output_probe_startup'), -4);
  assert.equal(r.call('linux_syscall_path_finish', owner.id, path, BigInt(pathBytes.length), 0), 0);
  // Advance the diagnostic read cursor using a synthetic stopped read receipt.
  // This only sets up real resident EOF; it is not a delivery signal.
  assert.equal(r.call('linux_managed_read_begin', owner.id, Number(fd), 0n, 2n), 0);
  const tail = r.result();
  assert.equal(r.call('linux_managed_read_start', owner.id, tail), 0);
  assert.equal(r.length(), 2n);
  assert.equal(r.call('linux_read_receipt', tail, 2n, 0), 0);
  assert.equal(r.call('linux_read_retire', tail), 0);
  assert.equal(publish(0, 1), -5, 'resident EOF must not publish another chunk');
  assert.deepEqual(r.remaining(owner, fd), bytes(''));
  assert.equal(r.request(owner, 3n, [fd, 0n, 0n, 0n, 0n, 0n]).value, 0n);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 0n);
  // Synthetic Run Fault receipt, then actual resource retirement in this Core.
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
  assert.ok(publish(0, 1) < 0);
  assert.deepEqual([peek(0, 0), peek(0, 1), peek(1, 0), peek(1, 1)], [97n, 98n, 99n, 100n].map(byte => ({length: 2n, byte})));
  assert.equal(r.call('linux_queued_output_probe_discard', 0), 0); assert.equal(r.result(), 1n);
  assert.deepEqual(peek(0, 0), {length: 0n, byte: 0n});
  assert.deepEqual(peek(1, 0), {length: 2n, byte: 99n});
  assert.equal(r.call('linux_queued_output_probe_discard', 1), 0); assert.equal(r.result(), 1n);
});

test('tagged captured stdio in the sealed core refuses physical fallback', {skip: queueSkip}, () => {
  const r = raw(queueArtifact!, true, true, true);
  assert.throws(() => memoryHost(r.module, 2, 8), /Synthetic sendfile probe/);
  r.stageStartup();
  assert.equal(r.call('linux_queued_output_probe_startup'), -9);
  assert.equal(r.result(), 0n, 'missing capture registry must not publish a startup owner');
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  r.stageStartup('/not-present');
  assert.ok(r.call('linux_queued_output_probe_startup') < 0);
  const failed = r.result();
  assert.equal(failed, 1n, 'failed program after table installation has a cleanup owner');
  assert.equal(r.call('linux_startup_cancel', failed), 0);
  const capture = r.live(true), fd = r.open(capture, '/data');
  assert.equal(capture.id, 2n, 'startup cancellation does not reuse the failed identity');
  for (const [nr, args] of [
    [1n, [1n, 0n, 1n, 0n, 0n, 0n]], [1n, [2n, 0n, 0n, 0n, 0n, 0n]],
    [18n, [1n, 0n, 1n, 0n, 0n, 0n]], [20n, [1n, 0n, 1n, 0n, 0n, 0n]],
    [40n, [1n, fd, 0n, 1n, 0n, 0n]], [40n, [2n, fd, 0n, 0n, 0n, 0n]],
  ] as const) {
    assert.deepEqual(r.request(capture, nr, args), {tag: 3, value: nr, next: 0n, target: 0n, endpoint: 0n});
  }
  assert.deepEqual(r.request(capture, 0n, [1n, 0n, 1n, 0n, 0n, 0n]),
    {tag: 0, value: -9n, next: 0n, target: 0n, endpoint: 0n});
  assert.equal(r.call('linux_managed_read_begin', capture.id, Number(fd), 0n, 1n), 0);
  const read = r.result();
  assert.equal(r.call('linux_read_load_start', capture.id, read), 0);
  assert.deepEqual([r.result(), r.length()], [7n, 1n], 'negative route never dispatched a lazy attempt');
  assert.equal(r.call('linux_read_load_finish', capture.id, read, 1, 0), 0);
  assert.equal(r.call('linux_read_retire', read), 0);
  for (const lane of [0, 1]) {
    assert.equal(r.call('linux_queued_output_probe_peek', lane, 0), 0); assert.equal(r.length(), 0n);
  }
  assert.equal(r.call('linux_run_receipt', capture.id, capture.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', capture.id), 0); assert.equal(r.result(), 1n);

  // The real dispatcher still admits the ordinary physical stdio command on
  // another execution. Don't start it or pretend that anything was stopped.
  const physical = r.live(), c = r.request(physical, 1n, [1n, 0n, 1n, 0n, 0n, 0n]);
  assert.deepEqual([c.tag, c.endpoint, c.next], [263, 2n, 1n]);
  assert.equal(r.call('linux_syscall_abandon', physical.id), 0);
  assert.equal(r.call('linux_run_receipt', physical.id, physical.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', physical.id), 0); assert.equal(r.result(), 1n);
});

test('strong capture probe admits an exact guarded lexical write without allowing physical fallback', {skip: workerQueueSkip}, () => {
  const r = raw(workerQueueArtifact!, true, false, true, true);
  assert.throws(() => memoryHost(r.module, 2, 8), /Synthetic sendfile probe/);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  const physical = r.live();
  assert.ok(r.call('linux_queued_worker_probe_write', physical.id, physical.invocation, 1, 1n, 32n, 2n) < 0);
  assert.deepEqual(r.request(physical, 1n, [1n, 32n, 2n, 0n, 0n, 0n]).tag, 263);
  assert.equal(r.call('linux_syscall_abandon', physical.id), 0);
  const owner = r.live(true);
  const enter = (sequence: number) => r.call('linux_queued_worker_probe_write', owner.id, owner.invocation, sequence, 1n, 32n, 2n);
  assert.ok(enter(2) < 0);
  assert.equal(enter(1), 0);
  const c = r.command(), id = owner.id, start = 'linux_queued_worker_probe_start', finish = 'linux_queued_worker_probe_finish';
  assert.deepEqual([c.tag, c.target, c.next, c.endpoint], [13, 32n, 2n, 0n]);
  r.genericBlocked(c.value);
  assert.ok(r.call(start, id, 2, c.value) < 0);
  assert.ok(r.call(start, physical.id, 1, c.value) < 0);
  assert.equal(r.call(start, id, 1, c.value), 0);
  const pointer = r.result();
  assert.deepEqual([r.auxiliary(), r.length()], [32n, 2n]);
  const readOnly = new Set(['linux_abi_version', 'linux_sendfile_probe', 'linux_result', 'linux_result_length',
    'linux_result_state', 'linux_result_auxiliary', 'linux_result_endpoint']);
  for (const [name, types] of signatures(r.wasm)) {
    if (!readOnly.has(name)) assert.ok(r.call(name, ...types.map(type => type === 0x7e ? 0n : 0)) < 0, name);
  }
  assert.ok(r.call(finish, id, 1, c.value, 0, 1) < 0, 'short complete claim is invalid');
  assert.ok(r.call('linux_queued_output_probe_peek', 0, 0) < 0, 'invalid evidence left the guard live');
  // Test-only trusted lexical input; no real Worker or sink in this case.
  new Uint8Array((r.e.memory as WebAssembly.Memory).buffer, Number(pointer), 2).set([65, 66]);
  assert.equal(r.call(finish, id, 1, c.value, 0, 2), 0);
  assert.deepEqual([r.state(), r.result()], [0, 2n]);
  assert.ok(r.call(finish, id, 1, c.value, 0, 2) < 0);
  assert.equal(r.call('linux_run_receipt', id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', id), 0); assert.equal(r.result(), 1n);
  assert.equal(r.call('linux_queued_output_probe_peek', 0, 1), 0);
  assert.deepEqual([r.length(), r.result()], [2n, 66n]);
});

test('strong capture probe retains exclusive access after full count or only one side ends', {skip: workerQueueSkip}, () => {
  const r = raw(workerQueueArtifact!, true, false, true, true);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  const owner = r.live(true), id = owner.id;
  const write = 'linux_queued_worker_probe_write', start = 'linux_queued_worker_probe_start', finish = 'linux_queued_worker_probe_finish';
  assert.equal(r.call(write, id, owner.invocation, 1, 1n, 32n, 2n), 0);
  const action = r.result();
  assert.equal(r.call(start, id, 1, action), 0);
  for (const access of [2, 3, 4]) {
    assert.equal(r.call(finish, id, 1, action, access, 2), 0);
    assert.deepEqual([r.state(), r.result()], [4, 0n]);
    assert.ok(r.call('linux_run_receipt', id, owner.invocation, 2, 0n) < 0);
    assert.ok(r.call('linux_syscall_abandon', id) < 0);
  }
  assert.ok(r.call(finish, id, 1, action + 1n, 1, 0) < 0);
  assert.equal(r.call(finish, id, 1, action, 1, 0), 0);
  assert.deepEqual([r.state(), r.result()], [4, 0n]);
  assert.equal(r.call('linux_run_receipt', id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', id), 0); assert.equal(r.result(), 1n);
  assert.equal(r.call('linux_queued_output_probe_peek', 0, 0), 0); assert.equal(r.length(), 0n);
});

test('strong capture probe resident sendfile rejects unsupported shapes and preserves the source on pressure', {skip: workerQueueSkip}, () => {
  const r = raw(workerQueueArtifact!, true, true, true, true);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  const physical = r.live(), name = 'linux_queued_worker_probe_sendfile';
  assert.ok(r.call(name, physical.id, physical.invocation, 1, 1n, 3n, 0n, 1n) < 0);
  assert.equal(r.request(physical, 1n, [1n, 32n, 1n, 0n, 0n, 0n]).tag, 263);
  assert.equal(r.call('linux_syscall_abandon', physical.id), 0);
  const owner = r.live(true), id = owner.id, fd = r.open(owner, '/source');
  const send = (sequence: number, length: bigint, offset = 0n) =>
    r.call(name, id, owner.invocation, sequence, 1n, fd, offset, length);
  for (const [sequence, n, offset] of [[3, 1n, 0n], [2, 1n, 1n], [2, 0n, 0n], [2, 5n, 0n]] as const) {
    assert.ok(send(sequence, n, offset) < 0);
  }
  assert.ok(send(2, 3n) < 0, 'short resident data cannot become a partial success');
  assert.ok(send(2, 1n) < 0, 'failed admitted sequence may not replay');
  assert.deepEqual(r.remaining(owner, fd), bytes('BD'));
  assert.equal(r.call('linux_queued_worker_probe_write', id, owner.invocation, 3, 1n, 32n, 4n), 0);
  const action = r.result();
  assert.equal(r.call('linux_queued_worker_probe_start', id, 3, action), 0);
  new Uint8Array((r.e.memory as WebAssembly.Memory).buffer, Number(r.result()), 4).set(bytes('fill'));
  assert.equal(r.call('linux_queued_worker_probe_finish', id, 3, action, 0, 4), 0);
  assert.ok(send(4, 1n) < 0, 'Q is full even with spare entry and pin slots');
  assert.deepEqual(r.remaining(owner, fd), bytes('BD'));
  assert.equal(r.call('linux_queued_output_probe_discard', 0), 0);
  assert.equal(send(5, 1n), 0);
  assert.deepEqual([r.state(), r.result()], [0, 1n]);
  assert.deepEqual(r.remaining(owner, fd), bytes('D'));
  assert.ok(send(6, 1n) < 0, 'R is full even with spare Q/K');
  assert.deepEqual(r.remaining(owner, fd), bytes('D'));
  assert.equal(r.call('linux_queued_output_probe_peek', 0, 0), 0); assert.deepEqual([r.length(), r.result()], [1n, 66n]);
  assert.equal(r.call('linux_queued_output_probe_discard', 0), 0);
  assert.equal(send(7, 1n), 0);
  assert.equal(r.call('linux_queued_output_probe_peek', 0, 0), 0); assert.deepEqual([r.length(), r.result()], [1n, 68n]);
  assert.deepEqual(r.remaining(owner, fd), bytes(''));
  assert.equal(r.call('linux_queued_output_probe_discard', 0), 0);
  assert.ok(send(8, 1n) < 0, 'EOF rejects even with Q/K/R available');
  assert.equal(r.call('linux_queued_output_probe_peek', 0, 0), 0); assert.equal(r.length(), 0n);

  const lazy = r.live(true), lazyFd = r.open(lazy, '/data');
  assert.ok(r.call(name, lazy.id, lazy.invocation, 2, 1n, lazyFd, 0n, 1n) < 0);
  assert.equal(r.call('linux_managed_read_begin', lazy.id, Number(lazyFd), 0n, 1n), 0);
  const read = r.result();
  assert.equal(r.call('linux_read_load_start', lazy.id, read), 0);
  assert.deepEqual([r.result(), r.length()], [7n, 1n], 'resident-only refusal never dispatched this lazy attempt');
  assert.equal(r.call('linux_read_load_finish', lazy.id, read, 1, 0), 0);
  assert.equal(r.call('linux_read_retire', read), 0);
  assert.equal(r.call('linux_queued_output_probe_peek', 0, 0), 0); assert.equal(r.length(), 0n);
});

function captureGuest(mixed = false) {
  // Hand-written fixture only; the real Node Worker executes a Wasm store and
  // syscall. This is not a currently translated ELF or an installed profile.
  const unsigned = (n: number) => {
    const out: number[] = [];
    do { const low = n & 127; n >>>= 7; out.push(low | (n ? 128 : 0)); } while (n);
    return out;
  };
  const signed = (n: number) => {
    const out: number[] = [];
    for (;;) {
      const low = n & 127; n >>= 7;
      const end = (n === 0 && !(low & 64)) || (n === -1 && (low & 64));
      out.push(low | (end ? 0 : 128));
      if (end) return out;
    }
  };
  const name = (s: string) => [...unsigned(s.length), ...bytes(s)];
  const section = (id: number, content: number[]) => [id, ...unsigned(content.length), ...content];
  const store = (at: number, value: number) => [0x41, ...signed(at), 0x41, ...signed(value), 0x3a, 0, 0];
  const syscall = (nr: number, args: number[]) =>
    [nr, ...args, ...Array(7 - args.length).fill(0)].flatMap(n => [0x42, ...signed(n)]).concat(0x10, 0);
  const expect = (n: number) => [0x42, ...signed(n), 0x52, 0x04, 0x40, 0x00, 0x0b];
  const operations = mixed ? [
    ...Array.from(bytes('/source\0')).flatMap((b, i) => store(64 + i, b)),
    ...syscall(2, [64, 0]), ...expect(3),
    ...store(32, 65), ...syscall(1, [1, 32, 1]), ...expect(1),
    ...syscall(40, [1, 3, 0, 1]), ...expect(1),
    ...store(32, 88), ...store(33, 67), ...syscall(1, [1, 33, 1]), ...expect(1),
    ...store(33, 89),
  ] : [
    ...store(32, 65), ...store(33, 66), ...syscall(1, [1, 32, 2]), ...expect(2),
    ...store(32, 88), ...store(33, 89),
  ];
  const code = [0, ...operations, ...syscall(60, [42]), 0x1a, 0x0b];
  const wasm = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [2, 0x60, 8, ...Array(8).fill(0x7e), 1, 0x7e, 0x60, 1, 0x7e, 0]),
    ...section(2, [2, ...name('env'), ...name('syscall'), 0, 0, ...name('env'), ...name('memory'), 2, 3, 2, 2]),
    ...section(3, [1, 1]), ...section(7, [1, ...name('run'), 0, 1]), ...section(10, [1, ...unsigned(code.length), ...code]),
  ]);
  return {module: new WebAssembly.Module(wasm), memory: new WebAssembly.Memory({initial: 2, maximum: 2, shared: true})};
}

const FixtureBytes = Uint8Array;
const fixtureSet = FixtureBytes.prototype.set;
const fixtureApply = Reflect.apply;
const fixtureMemoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer')!.get!;

test('strong capture probe Rust dispatcher decides without borrowing physical output', {skip: workerQueueSkip}, () => {
  const r = raw(workerQueueArtifact!, true, false, true, true);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  const ordinary = r.live(), captured = r.live(true);
  const name = 'linux_queued_worker_probe_request';
  const write = [1n, 32n, 1n, 0n, 0n, 0n] as const;
  assert.ok(r.call(name, ordinary.id, ordinary.invocation, 1, 1n, ...write, 4096n) < 0,
    'this selected ingress cannot silently use an ordinary physical output');
  assert.equal(r.request(ordinary, 1n, write).tag, 0x107, 'separate ordinary Worker entrance still issues its physical command');
  assert.equal(r.call(name, captured.id, captured.invocation, 1, 999n, 0n, 0n, 0n, 0n, 0n, 0n, 4096n), 0);
  assert.deepEqual([r.state(), r.result()], [3, 999n]);
  assert.ok(r.call(name, captured.id, captured.invocation, 1, 1n, ...write, 4096n) < 0);
  assert.equal(r.call(name, captured.id, captured.invocation, 2, 1n, ...write, 4096n), 0);
  const action = r.result();
  assert.deepEqual([r.state(), r.auxiliary(), r.length(), r.endpoint()], [13, 32n, 1n, 0n]);
  assert.ok(r.call(name, captured.id, captured.invocation, 3, 60n, 0n, 0n, 0n, 0n, 0n, 0n, 4096n) < 0,
    'ordinary Rust path cannot overtake the admitted WriteCall');
  assert.equal(r.call('linux_queued_worker_probe_start', captured.id, 2, action), 0);
  const memory = r.e.memory as WebAssembly.Memory;
  new FixtureBytes(memory.buffer, Number(r.result()), 1)[0] = 65;
  assert.equal(r.call('linux_queued_worker_probe_finish', captured.id, 2, action, 0, 1), 0);
  assert.deepEqual(r.receive(0), bytes('A'));
  assert.equal(r.call(name, captured.id, captured.invocation, 3, 60n, 0n, 0n, 0n, 0n, 0n, 0n, 4096n), 0);
  assert.equal(r.state(), 2);
});

test('strong capture probe receiver rejects stale heads and same-head stale attempts', {skip: workerQueueSkip}, () => {
  const r = raw(workerQueueArtifact!, true, false, true, true);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  const head = (lane = 0) => {
    assert.equal(r.call('linux_queued_worker_probe_receive_head', lane), 0);
    return {stamp: r.auxiliary(), generation: r.result(), length: Number(r.length())};
  };
  assert.deepEqual(head(), {stamp: 0n, generation: 0n, length: 0}, 'empty is not a record');
  const owner = r.live(), fd = r.open(owner);
  const publish = (lane: number, length = 2) =>
    assert.equal(r.call('linux_queued_output_probe_publish', owner.id, owner.invocation, Number(fd), lane, length), 0);
  publish(0);
  const old = head();
  assert.equal(r.call('linux_queued_output_probe_discard', 0), 0);
  publish(0); publish(1, 1);
  assert.equal(r.call('linux_queued_output_probe_discard', 1), 0);
  publish(1, 1);
  const current = head(), other = head(1);
  assert.equal(current.stamp, old.stamp, 'reuse the exact entry arena slot');
  assert.equal(current.length, old.length);
  assert.notEqual(current.generation, old.generation);
  assert.equal(current.generation, other.generation, 'lane-local generations do collide');
  const start = (h: ReturnType<typeof head>, lane = 0) =>
    r.call('linux_queued_worker_probe_receive_start', lane, h.stamp, h.generation);
  const finish = (attempt: bigint, proof: number, count: number) =>
    r.call('linux_queued_worker_probe_receive_finish', attempt, proof, count);
  assert.ok(start(old) < 0);
  assert.ok(start(other, 0) < 0, 'different lane stamp cannot retarget a head even with equal generation');
  assert.deepEqual(head(), current);
  const destination = new FixtureBytes(current.length);
  const core = r.e.memory as WebAssembly.Memory;
  assert.equal(start(current), 0);
  const oldAttempt = r.auxiliary();
  assert.equal(finish(oldAttempt, 1, 0), 0, 'ended unpublished abort retains the head');
  assert.deepEqual(head(), current);
  assert.equal(start(current), 0);
  const attempt = r.auxiliary(), pointer = Number(r.result());
  assert.notEqual(attempt, oldAttempt);
  const copy = () => fixtureApply(fixtureSet, destination,
    [new FixtureBytes(fixtureApply(fixtureMemoryBuffer, core, []), pointer, current.length)]);
  copy();
  assert.deepEqual(destination, bytes('cd'));
  assert.equal(finish(oldAttempt, 1, 0), -4);
  assert.equal(finish(attempt, 0, current.length - 1), -5);
  for (const proof of [2, 3, 4]) {
    assert.equal(finish(attempt, proof, current.length), 0);
    assert.equal(r.result(), 0n, 'full count cannot certify access');
    assert.equal(r.call('linux_queued_output_probe_discard', 0), -4);
    assert.equal(r.call('linux_queued_output_probe_peek', 1, 0), -4);
    assert.equal(start(current), -4);
    assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), -4);
    assert.equal(r.call('linux_execution_retire', owner.id), -4);
  }
  assert.equal(finish(attempt, 0, current.length), -4, 'uncertain copies can no longer be published');
  assert.equal(finish(attempt, 1, 0), 0);
  assert.deepEqual(head(), current);
  assert.deepEqual(head(1), other);
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
  assert.equal(start(current), 0);
  const last = r.auxiliary(), source = Number(r.result());
  fixtureApply(fixtureSet, destination, [new FixtureBytes(fixtureApply(fixtureMemoryBuffer, core, []), source, current.length)]);
  assert.equal(finish(last, 0, current.length), 0);
  assert.equal(r.result(), 2n);
  assert.equal(finish(last, 0, current.length), -4);
  assert.equal(head().generation, 0n);
  assert.deepEqual(destination, bytes('cd'));
  assert.deepEqual(head(1), other);
});

function copyWorkerInput(guest: WebAssembly.Memory, core: WebAssembly.Memory, at: number, pointer: number, length: number) {
  const input = new FixtureBytes(fixtureApply(fixtureMemoryBuffer, guest, []), at, length);
  const output = new FixtureBytes(fixtureApply(fixtureMemoryBuffer, core, []), pointer, length);
  // No callback, species lookup, await, export, grow, or view escaping here.
  fixtureApply(fixtureSet, output, [input]);
}

type CaptureCore = {
  e: WebAssembly.Exports;
  call(name: string, ...args: (number | bigint)[]): number;
  result(): bigint;
  length(): bigint;
  auxiliary(): bigint;
  endpoint(): bigint;
};

type CaptureRecord = {head: bigint; generation: bigint; bytes: Uint8Array<ArrayBuffer>; origin?: bigint};

// Private diagnostic adapter bound to one Core (including any other lane). No
// callback, await or other Core call receives the raw view or the local copy.
function captureTransfer(r: CaptureCore, resultProfile = false) {
  const memory = r.e.memory as WebAssembly.Memory;
  let unresolved: CaptureRecord | undefined;
  return (lane: number, sink: boolean, limit = 4): CaptureRecord | undefined => {
    if (unresolved) throw new Error('Capture receiver has unresolved Core access');
    if (resultProfile) assert.ok(!sink && lane === 0, 'the result artifact has one receiver and no sink');
    const route = sink ? 'sink' : 'receive';
    assert.equal(resultProfile ? r.call('linux_capture_result_head') : r.call(`linux_queued_worker_probe_${route}_head`, lane), 0);
    const generation = r.result(), head = r.auxiliary(), length = Number(r.length());
    if (generation === 0n) return undefined; // Temporary empty, not EOF.
    const origin = resultProfile ? r.endpoint() : undefined;
    if (resultProfile) assert.ok(origin === 1n || origin === 2n, 'the result head has a logical origin');
    assert.ok(length >= 1 && length <= limit, 'Capture receiver has insufficient capacity');
    const output = new FixtureBytes(length); // The one final allocation, before start.
    const record = {head, generation, bytes: output, ...(origin === undefined ? {} : {origin})};
    unresolved = record; // Keep allocation on ambiguous start/finish. Do not replay.
    const whichStart = sink ? 'sink_copy_start' : 'receive_start';
    const start = resultProfile ? r.call('linux_capture_result_copy_start', Number(head), generation)
      : r.call(`linux_queued_worker_probe_${whichStart}`, lane, head, generation);
    if (start !== 0) {
      unresolved = undefined; // Known rejection, no loan issued.
      throw new Error(`Capture receiver start: ${start}`);
    }
    const attempt = r.auxiliary(), pointer = Number(r.result());
    const finish = resultProfile ? 'linux_capture_result_copy_finish' : 'linux_queued_worker_probe_receive_finish';
    try {
      if (Number(r.length()) !== length || (resultProfile && r.endpoint() !== origin)) throw new Error('Capture receiver metadata changed');
      fixtureApply(fixtureSet, output,
        [new FixtureBytes(fixtureApply(fixtureMemoryBuffer, memory, []), pointer, length)]);
    } catch (error) {
      // The trusted lexical source view cannot survive synchronous unwind.
      assert.equal(r.call(finish, attempt, 1, 0), 0);
      unresolved = undefined;
      throw error;
    }
    assert.equal(r.call(finish, attempt, 0, length), 0);
    assert.equal(r.result(), BigInt(length));
    unresolved = undefined;
    return record;
  };
}

test('strong capture probe receiver never publishes or retries an ambiguous receipt', {skip: workerQueueSkip}, () => {
  const r = raw(workerQueueArtifact!, true, false, true, true);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  const owner = r.live(), fd = r.open(owner);
  for (const lane of [0, 1]) {
    assert.equal(r.call('linux_queued_output_probe_publish', owner.id, owner.invocation, Number(fd), lane, 1), 0);
  }
  let finishes = 0;
  const receive = captureTransfer({...r, call(name, ...args) {
    const status = r.call(name, ...args);
    if (name === 'linux_queued_worker_probe_receive_finish') {
      assert.equal(status, 0);
      finishes++;
      throw new Error('Receipt outcome unavailable to adapter');
    }
    return status;
  }});
  assert.throws(() => receive(0, false), /outcome unavailable/);
  assert.throws(() => receive(0, false), /unresolved/);
  assert.throws(() => receive(1, false), /unresolved/);
  assert.equal(finishes, 1);
  // Raw diagnostic only; the poisoned adapter cannot infer the lost result
  // from empty or attempt to deliver the still-present other lane.
  assert.equal(r.call('linux_queued_output_probe_peek', 0, 0), 0); assert.equal(r.length(), 0n);
  assert.equal(r.call('linux_queued_output_probe_peek', 1, 0), 0); assert.equal(r.result(), 98n);
});

test('strong capture probe sink keeps its escrowed frontier after full uncertain progress', {skip: workerQueueSkip}, () => {
  const r = raw(workerQueueArtifact!, true, false, true, true);
  const bind = 'linux_queued_worker_probe_sink_bind', head = 'linux_queued_worker_probe_sink_head';
  const start = 'linux_queued_worker_probe_sink_copy_start', offer = 'linux_queued_worker_probe_sink_offer';
  const finish = 'linux_queued_worker_probe_receive_finish', receipt = 'linux_queued_worker_probe_sink_receipt';
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  assert.equal(r.call(bind, 0), 0);
  assert.ok(r.call(bind, 1) < 0, 'a second physical owner may not substitute itself');
  const owner = r.live(true), fd = r.open(owner);
  for (const [lane, length] of [[0, 2], [1, 1]] as const) {
    assert.equal(r.call('linux_queued_output_probe_publish', owner.id, owner.invocation, Number(fd), lane, length), 0);
  }
  assert.equal(r.call('linux_queued_worker_probe_write', owner.id, owner.invocation, ++owner.sequence, 1n, 32n, 1n), 0);
  const write = r.result();
  assert.equal(r.call('linux_queued_worker_probe_start', owner.id, owner.sequence, write), 0);
  new FixtureBytes((r.e.memory as WebAssembly.Memory).buffer, Number(r.result()), 1)[0] = 100;
  assert.equal(r.call('linux_queued_worker_probe_finish', owner.id, owner.sequence, write, 0, 1), 0);
  assert.equal(r.call('linux_queued_worker_probe_receive_head', 0), -4);
  assert.equal(r.call('linux_queued_output_probe_discard', 0), -4);
  assert.deepEqual(r.receive(1), bytes('c'));
  assert.equal(r.call(head, 0), 0);
  const stamp = r.auxiliary(), generation = r.result(), size = Number(r.length());
  const output = new FixtureBytes(size), memory = r.e.memory as WebAssembly.Memory;
  assert.equal(r.call(start, 0, stamp, generation), 0);
  const view = r.auxiliary(), pointer = Number(r.result());
  fixtureApply(fixtureSet, output, [new FixtureBytes(fixtureApply(fixtureMemoryBuffer, memory, []), pointer, size)]);
  assert.equal(r.call(finish, view, 0, size), 0);
  assert.equal(r.result(), BigInt(size));
  assert.deepEqual(output, bytes('ab'));
  assert.equal(r.call(head, 0), -4, 'escrow is not empty or the next record');
  assert.equal(r.call(offer, 0, stamp, generation), 0);
  const action = r.result();
  assert.deepEqual([r.auxiliary(), r.length()], [0n, 2n]);
  assert.equal(r.call('linux_queued_worker_probe_sink_cancel', 0, stamp, generation, action), 0);
  assert.equal(r.call(receipt, 0, stamp, generation, action, 2, 1), 0, 'unknown at full has no terminal permission');
  assert.equal(r.state(), 0);
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0, 'independent producer can stop');
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
  assert.equal(r.call(offer, 0, stamp, generation), -4);
  assert.equal(r.call('linux_queued_output_probe_discard', 0), -4);
  assert.equal(r.call('linux_queued_worker_probe_sink_discard', 0, stamp, generation), -4);
  assert.equal(r.call('linux_queued_worker_probe_sink_shutdown', 0), 0);
  assert.equal(r.result(), 0n, 'admission closure does not close the handle or clear the frontier');
  for (const oneSide of [2, 3]) {
    assert.equal(r.call(receipt, 0, stamp, generation, action, 2, oneSide), 0);
    assert.equal(r.state(), 0);
  }
  assert.equal(r.call(receipt, 0, stamp, generation, action, 1, 0), -4, 'progress cannot recede');
  assert.equal(r.call(receipt, 0, stamp, generation, action, 2, 0), 0);
  assert.equal(r.state(), 2);
  assert.equal(r.call(receipt, 0, stamp, generation, action, 2, 0), -4);
  assert.equal(r.call(head, 0), 0);
  assert.equal(r.length(), 1n);
});

test('strong capture probe sink shutdown distinguishes empty from a live producer reservation', {skip: workerQueueSkip}, () => {
  const r = raw(workerQueueArtifact!, true, false, true, true);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  assert.equal(r.call('linux_queued_worker_probe_sink_bind', 0), 0);
  const owner = r.live(true);
  assert.equal(r.call('linux_queued_worker_probe_write', owner.id, owner.invocation, ++owner.sequence, 1n, 32n, 1n), 0);
  const action = r.result();
  assert.equal(r.call('linux_queued_worker_probe_sink_head', 0), 0);
  assert.equal(r.length(), 0n, 'no published head yet');
  assert.equal(r.call('linux_queued_worker_probe_sink_shutdown', 0), 0);
  assert.equal(r.result(), 0n, 'outstanding reservation precludes drained certificate');
  assert.ok(r.call('linux_queued_worker_probe_start', owner.id, owner.sequence, action) < 0,
    'after closure not even the earlier reservation starts its guest copy');
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_syscall_abandon', owner.id), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
  assert.equal(r.call('linux_queued_worker_probe_sink_shutdown', 0), 0);
  assert.equal(r.result(), 1n);
});

// Owns the only file handle and final byte allocation for a bound Core/lane.
// Exposing a number/Buffer to another caller would invalidate this witness.
// The private test knobs bound one actual call and withhold its known receipt.
function ownedNodeSink(r: ReturnType<typeof raw>, lane: number, path: string) {
  const fd = openSync(path, 'wx', 0o600);
  try { assert.equal(r.call('linux_queued_worker_probe_sink_bind', lane), 0); }
  catch (error) { closeSync(fd); throw error; }
  let pending: CaptureRecord | undefined;
  let active: {action: bigint; stoppedAt?: number} | undefined;
  let ambiguous = false, closed = false;

  const report = (record: CaptureRecord, action: bigint, boundary: number, proof: number) => {
    // A trap after Core accepted the receipt cannot authorize replay or a new
    // effect. Leave both the allocation and native handle in this owner.
    ambiguous = true;
    assert.equal(r.call('linux_queued_worker_probe_sink_receipt', lane, record.head, record.generation,
      action, boundary, proof), 0);
    const state = r.state();
    assert.ok(state === 0 || state === 1 || state === 2);
    ambiguous = false;
    return state;
  };
  const acknowledge = () => {
    if (ambiguous || !pending || !active || active.stoppedAt === undefined) throw new Error('No exact stopped Node receipt');
    const state = report(pending, active.action, active.stoppedAt, 0);
    assert.ok(state === 1 || state === 2);
    active = undefined;
    if (state === 2) pending = undefined;
    return state === 2 ? 'complete' as const : 'suffix' as const;
  };

  return {
    writeOne(limit = 4, withholdStopped = false) {
      if (closed || ambiguous || active) throw new Error('Node sink has an unresolved or closed offer');
      assert.ok(Number.isSafeInteger(limit) && limit > 0);
      if (!pending) {
        ambiguous = true;
        pending = r.transferForSink(lane);
        ambiguous = false;
      }
      if (!pending) return 'empty' as const;
      ambiguous = true;
      assert.equal(r.call('linux_queued_worker_probe_sink_offer', lane, pending.head, pending.generation), 0);
      const action = r.result(), begin = Number(r.auxiliary()), end = Number(r.length());
      assert.ok(begin >= 0 && begin < end && end === pending.bytes.length);
      active = {action};
      ambiguous = false;
      let count: number;
      try { count = writeSync(fd, pending.bytes, begin, Math.min(end - begin, limit)); }
      catch (error) {
        assert.equal(report(pending, action, begin, 1), 0);
        throw error; // No guessed stopped evidence, no retry and no handle close.
      }
      // Real synchronous return, not a cancellation or Worker-exit guess.
      active.stoppedAt = begin + count;
      if (!withholdStopped) return acknowledge();
      assert.equal(report(pending, action, active.stoppedAt, 1), 0);
      return 'waiting' as const;
    },
    acknowledge,
    closeIfDrained() {
      if (closed) return true;
      if (ambiguous) throw new Error('Cannot close an unresolved Node sink');
      ambiguous = true;
      assert.equal(r.call('linux_queued_worker_probe_sink_shutdown', lane), 0);
      if (r.result() === 0n) { ambiguous = false; return false; }
      assert.equal(r.result(), 1n);
      assert.equal(pending, undefined);
      assert.equal(active, undefined);
      closeSync(fd);
      closed = true;
      ambiguous = false;
      return true;
    },
  };
}

test('strong capture probe real Node sink writes a new absolute suffix without replay', {skip: workerQueueSkip}, () => {
  const r = raw(workerQueueArtifact!, true, false, true, true);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  const directory = mkdtempSync(join(tmpdir(), 'sods-private-sink-'));
  const path = join(directory, 'output');
  const sink = ownedNodeSink(r, 0, path);
  const owner = r.live(), fd = r.open(owner);
  assert.equal(r.call('linux_queued_output_probe_publish', owner.id, owner.invocation, Number(fd), 0, 4), 0);
  assert.equal(sink.writeOne(2, true), 'waiting');
  assert.deepEqual(new Uint8Array(readFileSync(path)), bytes('ab'));
  assert.throws(() => sink.writeOne(), /unresolved/);
  assert.equal(sink.closeIfDrained(), false, 'effects at the sink do not permit a close while unconfirmed');
  assert.equal(sink.acknowledge(), 'suffix');
  assert.equal(sink.closeIfDrained(), false, 'a stopped partial suffix is still owned');
  assert.equal(sink.writeOne(), 'complete');
  assert.equal(sink.writeOne(), 'empty');
  assert.ok(r.call('linux_queued_output_probe_publish', owner.id, owner.invocation, Number(fd), 0, 2) < 0);
  assert.equal(sink.closeIfDrained(), true);
  try { assert.deepEqual(new Uint8Array(readFileSync(path)), bytes('abcd')); }
  finally { rmSync(directory, {recursive: true, force: true}); }
});

const compiledCapture = new Map<string, {elf: Uint8Array<ArrayBuffer>; translator: WebAssembly.Module; sha: string}>();
function currentCaptureProgram(pressure = false, singlePhysicalEndpoint = false) {
  const form = `${pressure}:${singlePhysicalEndpoint}`;
  const cached = compiledCapture.get(form);
  if (cached) return cached;
  const directory = mkdtempSync(join(tmpdir(), 'sods-current-capture-'));
  try {
    const source = fileURLToPath(new URL('../fixtures/managed-sendfile/captured-order.S', import.meta.url));
    const compiler = process.env.SODS_FIXTURE_CC ?? 'musl-gcc';
    const object = join(directory, 'captured-order.o');
    const output = join(directory, 'capture.elf');
    // A stable object basename avoids cc's random temp symbol-file name.
    execFileSync(compiler, [...(pressure ? ['-DSODS_CAPTURE_RESIDENT_PRESSURE'] : []),
      ...(singlePhysicalEndpoint ? ['-DSODS_PHYSICAL_ONE_ENDPOINT'] : []), '-c', source, '-o', object], {stdio: 'pipe', timeout: 30_000});
    execFileSync(compiler, [
      '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', object, '-o', output,
    ], {stdio: 'pipe', timeout: 30_000});
    const artifact = readFileSync(currentTranslatorArtifact!);
    const built = {elf: new Uint8Array(readFileSync(output)), translator: new WebAssembly.Module(artifact),
      sha: createHash('sha256').update(artifact).digest('hex')};
    compiledCapture.set(form, built);
    return built;
  } finally { rmSync(directory, {recursive: true, force: true}); }
}

function cancelPreparedImage(r: ReturnType<typeof raw>, id: bigint) {
  assert.equal(r.call('linux_startup_image_finish', id, 2), 0);
  assert.equal(r.call('linux_startup_failed_image', id), 0);
  assert.equal(r.call('linux_startup_cancel', id), 0); assert.equal(r.result(), 1n);
}

async function prepareCurrentCapture(
  r: ReturnType<typeof raw>, translator: WebAssembly.Module, expectedElf: Uint8Array,
  {omitPhnum = false, resultProfile = false, physicalProbe = false} = {},
) {
  const translate = await loadTranslator(translator);
  const core = r.e.memory as WebAssembly.Memory;
  r.stageStartup('/app', ['mixed']);
  assert.ok(!resultProfile || !physicalProbe);
  const begun = resultProfile ? r.call('linux_capture_result_startup', 0)
    : r.call(physicalProbe ? 'linux_startup_begin_stdio' : 'linux_queued_worker_probe_startup_shared');
  const id = r.result();
  assert.equal(r.call('linux_startup_input', 0), 0);
  if (begun !== 0) {
    if (id) assert.equal(r.call('linux_startup_cancel', id), 0);
    assert.equal(begun, 0);
  }
  let translating = false, initializing = false;
  try {
    assert.equal(r.call('linux_startup_source_start', id), 0); assert.equal(r.result(), 0n);
    assert.equal(r.call('linux_startup_bytes', id), 0);
    translating = true;
    const pointer = Number(r.result()), length = Number(r.length());
    const original = (() => {
      // Only this synchronous scope holds the sealed Core ELF view. The
      // translator copies it into its own memory, and returned wasm is owned.
      const canonical = new FixtureBytes(fixtureApply(fixtureMemoryBuffer, core, []), pointer, length);
      assert.deepEqual(canonical, expectedElf);
      return translate.whole(canonical);
    })();
    const validated = await fixedTranslatedModuleAsync(original);
    const sections = WebAssembly.Module.customSections(validated, 'sods.facts');
    assert.equal(sections.length, 1);
    const facts = JSON.parse(new TextDecoder().decode(sections[0])) as Record<string, unknown>;
    if (omitPhnum) delete facts.phnum; // Fixture-only corruption before any image admission.
    const fact = (key: string): number => {
      const value = facts[key];
      assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, key);
      return value;
    };
    const entry = BigInt(fact('entry')), low = Math.ceil(fact('imageEnd') / 65536) * 65536, top = low + 65536;
    const phdr = BigInt(fact('phdr')), phent = BigInt(fact('phent')), phnum = BigInt(fact('phnum'));
    assert.ok(top <= 0x100000000);
    const prepared = prepare(original, {shared: true});
    assert.ok(prepared.segments);
    const module = fixedTranslatedModule(prepared.wasm, {externalData: true});
    for (const segment of prepared.segments) {
      assert.ok(Number.isSafeInteger(segment.offset) && segment.offset >= 0 &&
        segment.bytes.length <= top - segment.offset);
      assert.ok(segment.bytes.length === 0 || segment.offset + segment.bytes.length <= low);
    }
    translating = false; // Never replay a receipt call of uncertain outcome.
    assert.equal(r.call('linux_startup_translation_finish', id, 1, entry, phdr, phent, phnum, BigInt(top)), 0);
    const pages = top / 65536, memory = new WebAssembly.Memory({initial: pages, maximum: pages, shared: true});
    assert.equal(r.call('linux_bind', BigInt(top)), 0); const binding = r.result();
    assert.equal(r.call('linux_startup_image_begin', id, binding, BigInt(low), BigInt(top)), 0);
    initializing = true;
    assert.equal(r.call('linux_startup_stack', id), 0);
    const stackFrom = Number(r.result()), stackLength = Number(r.length()), stackPointer = r.auxiliary();
    assert.ok(stackPointer >= BigInt(low) && stackPointer + BigInt(stackLength) <= BigInt(top));
    copyWorkerInput(core, memory, stackFrom, Number(stackPointer), stackLength);
    for (const segment of prepared.segments) {
      fixtureApply(fixtureSet, new FixtureBytes(fixtureApply(fixtureMemoryBuffer, memory, []),
        segment.offset, segment.bytes.length), [segment.bytes]);
    }
    return {module, memory, stackPointer, id, entry};
  } catch (error) {
    if (translating) assert.equal(r.call('linux_startup_translation_finish', id, 0, 0n, 0n, 0n, 0n, 0n), 0);
    // No actual Worker received this memory, and local lexical initialization
    // terminated. A failure after handed-off startup uses real exit instead.
    if (initializing) cancelPreparedImage(r, id);
    else { assert.equal(r.call('linux_startup_cancel', id), 0); assert.equal(r.result(), 1n); }
    throw error;
  }
}

// Test-only transport, not a new guest mode. The fixture installs one exact
// nonappend handle; the proof integer is still accepted only by the probe
// artifact, and default memoryHost must reject that artifact.
for (const stopAfterWrite of [false, true]) test(
  `real Node Worker capture fixture: physical offer to its owned regular file ${stopAfterWrite ? 'settles only after observed Worker stop' : 'returns the direct confirmed prefix'}`,
  {skip: currentMixedSkip, timeout: 30_000}, async () => {
    const {elf, translator} = currentCaptureProgram(false, true);
    const r = raw(workerQueueArtifact!, true, false, true, true, elf);
    assert.throws(() => memoryHost(r.module, 2, 8), /Synthetic sendfile probe/);
    const input = await prepareCurrentCapture(r, translator, elf, {physicalProbe: true});
    const {id, memory, entry} = input, core = r.e.memory as WebAssembly.Memory;
    const bridge = createGuest(input);
    const directory = mkdtempSync(join(tmpdir(), 'sods-physical-witness-')), path = join(directory, 'out');
    const fd = openSync(path, 'wx', 0o600);
    let unresolved = false;
    let writes = 0, sends = 0, observedStop = false;
    const viewAt = (backing: WebAssembly.Memory, pointer: number, length: number) =>
      new FixtureBytes(fixtureApply(fixtureMemoryBuffer, backing, []), pointer, length);
    try {
      await bridge.ready;
      assert.equal(r.call('linux_startup_image_finish', id, 0), 0);
      assert.equal(r.call('linux_run_start', id), 0);
      const owner = {id, invocation: r.result(), sequence: 0};
      const outcome = await bridge.run(owner.invocation, entry, async request => {
        assert.equal(request.invocation, owner.invocation);
        assert.equal(request.sequence, ++owner.sequence);
        assert.equal(r.call('linux_syscall_sequenced', id, owner.invocation, request.sequence,
          request.nr, ...request.args, request.next), 0);
        const c = r.command();
        if (c.tag === 8) {
          const length = bytes('/source\0').length;
          assert.equal(request.nr, 2n);
          assert.equal(r.call('linux_syscall_path_start', id, c.value), 0);
          copyWorkerInput(memory, core, Number(c.target), Number(r.result()), length);
          assert.equal(r.call('linux_syscall_path_finish', id, c.value, BigInt(length), 0), 0);
          assert.deepEqual([r.state(), r.result()], [0, 3n]);
          return {kind: 'return', value: r.result()};
        }
        if (c.tag === 263) {
          assert.equal(c.endpoint, 2n, 'exact registered output, not a host fd supplied by the guest');
          assert.equal(c.next, 1n);
          const count = (() => {
            const view = viewAt(memory, Number(c.target), 1);
            unresolved = true;
            assert.equal(r.call('linux_stream_start', id, c.value), 0);
            return writeSync(fd, view, 0, 1, null);
          })();
          assert.equal(r.call('linux_stream_receipt', id, c.value, BigInt(count), 0), 0);
          const value = r.result();
          assert.deepEqual([r.state(), value], [0, 1n]);
          unresolved = false;
          if (++writes === 2) assert.deepEqual(r.remaining(owner, 3n), bytes('D'), 'only the actual source prefix commits');
          return {kind: 'return', value};
        }
        if (c.tag === 2) return {kind: 'leave'};
        assert.equal(c.tag, 10);
        assert.equal(c.target, BigInt(request.sequence));
        assert.equal(c.endpoint, 2n);
        const send = {owner, action: c.value, sequence: request.sequence, endpoint: 2n, offered: 0n};
        assert.equal(r.qualify(send).tag, 12, 'synthetic admission exists only in the marker-rejected artifact');
        assert.equal(send.offered, 1n);
        unresolved = true;
        const count = (() => {
          const view = viewAt(core, Number(r.start(send)), Number(send.offered));
          return writeSync(fd, view, 0, Number(send.offered), null);
        })();
        sends++;
        assert.equal(count, 1);
        if (stopAfterWrite) {
          // Only the count remains outside the lexical view; the Core owner is
          // not released merely by the actually stopped Worker.
          bridge.requestStop();
          assert.equal((await bridge.stopEvidence()).stopped, true);
          assert.equal(bridge.diagnostics().pendingRequest, true);
          assert.equal(r.call('linux_run_receipt', id, owner.invocation, 2, 0n), -4, 'guest stop does not end the lexical fence');
          // Conservatively disclose only ended access and already confirmed
          // prefix, withholding the physical stop receipt until after exit.
          assert.equal(r.finish(send, BigInt(count), 6, 1).tag, 4);
          assert.equal(r.call('linux_run_receipt', id, owner.invocation, 2, 0n), 0);
          assert.equal(r.call('linux_execution_retire', id), 0);
          assert.equal(r.result(), 0n, 'ended access and Worker exit do not settle the physical offer');
          observedStop = true;
        }
        const complete = r.finish(send, BigInt(count));
        unresolved = false;
        assert.equal(complete.tag, stopAfterWrite ? 4 : 0);
        return stopAfterWrite ? {kind: 'leave'} : {kind: 'return', value: complete.value};
      });
      await bridge.requestsSettled();
      assert.equal(bridge.diagnostics().failureCount, 0);
      if (stopAfterWrite) assert.equal(outcome.kind, 'failed');
      else {
        assert.deepEqual(outcome, {kind: 'left', unwound: true});
        assert.equal(r.call('linux_run_receipt', id, owner.invocation, 1, 0n), 0);
        assert.equal(r.result(), 42n);
        bridge.requestStop();
        assert.equal((await bridge.stopEvidence()).stopped, true);
      }
      assert.equal(r.call('linux_execution_retire', id), 0);
      assert.equal(r.result(), 1n);
      assert.deepEqual([writes, sends, observedStop], [stopAfterWrite ? 1 : 2, 1, stopAfterWrite]);
      assert.deepEqual(readFileSync(path), Buffer.from(stopAfterWrite ? 'AB' : 'ABC'));
    } finally {
      bridge.requestStop();
      await bridge.stopped;
      // A trapped/unknown callback cannot give permission to close/reuse the
      // file. The failing test leaves its isolated process as the last owner.
      if (!unresolved) { closeSync(fd); rmSync(directory, {recursive: true, force: true}); }
    }
  });

test('current-source mixed capture rejects malformed canonical ELF before Worker construction', {skip: currentMixedSkip, timeout: 30_000}, async () => {
  const invalid = bytes('not an ELF'), {translator} = currentCaptureProgram();
  const r = raw(workerQueueArtifact!, true, false, true, true, invalid);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  await assert.rejects(prepareCurrentCapture(r, translator, invalid), NotAProgram);
  assert.ok(r.call('linux_run_start', 1n) < 0);
  for (const lane of [0, 1]) {
    assert.equal(r.call('linux_queued_output_probe_peek', lane, 0), 0); assert.equal(r.length(), 0n);
  }
});

test('current-source mixed capture rejects incomplete translated facts with stopped startup cleanup', {skip: currentMixedSkip, timeout: 30_000}, async () => {
  const {elf, translator} = currentCaptureProgram();
  const r = raw(workerQueueArtifact!, true, false, true, true, elf);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  await assert.rejects(prepareCurrentCapture(r, translator, elf, {omitPhnum: true}), /phnum/);
  assert.equal(r.call('linux_startup_cancel', 1n), 0); assert.equal(r.result(), 1n);
  assert.ok(r.call('linux_run_start', 1n) < 0);
});

test('current-source mixed capture keeps cancelled initialization until stopped evidence', {skip: currentMixedSkip, timeout: 30_000}, async () => {
  const {elf, translator} = currentCaptureProgram();
  const r = raw(workerQueueArtifact!, true, false, true, true, elf);
  assert.equal(r.call('linux_queued_output_probe_init'), 0);
  const prepared = await prepareCurrentCapture(r, translator, elf);
  assert.equal(r.call('linux_startup_cancel', prepared.id), 0); assert.equal(r.result(), 0n);
  assert.ok(r.call('linux_run_start', prepared.id) < 0);
  // This fixture demonstrably did not hand off the initialized memory to any
  // Worker. Local accesses have ended; this is not inferred from cancellation.
  cancelPreparedImage(r, prepared.id);
  assert.ok(r.call('linux_run_start', prepared.id) < 0);
});

test('strong capture probe joined startup owns only admitted failure and never falls back', {skip: workerQueueSkip}, () => {
  const r = raw(workerQueueArtifact!, true, false, true, true);
  const begin = () => r.call('linux_queued_worker_probe_startup_shared');
  r.stageStartup();
  assert.equal(begin(), -9);
  assert.equal(r.result(), 0n, 'missing registry is not admission');
  assert.equal(r.call('linux_queued_worker_probe_init_joined'), 0);
  assert.equal(r.call('linux_queued_output_probe_init'), -4, 'cannot replace the admitted receiver');
  assert.equal(r.call('linux_queued_worker_probe_init_joined'), -4);
  assert.equal(r.call('linux_queued_worker_probe_sink_bind', 1), -5);
  assert.equal(r.call('linux_queued_output_probe_startup'), -5);
  assert.equal(r.result(), 0n, 'an unavailable split route must not reserve an execution');
  r.stageStartup('/not-present');
  assert.ok(begin() < 0);
  const cleanup = r.result();
  assert.equal(cleanup, 1n, 'failure after table installation retains the exact cleanup owner');
  assert.ok(r.call('linux_run_start', cleanup) < 0);
  assert.equal(r.call('linux_startup_cancel', cleanup), 0);
  assert.equal(r.result(), 1n);
  assert.equal(r.receive(0), undefined);
  assert.equal(r.call('linux_queued_worker_probe_receive_head', 1), -5);
  r.stageStartup();
  assert.equal(begin(), 0);
  const next = r.result();
  assert.equal(next, 2n, 'later preparation never adopts the cancelled identity');
  assert.equal(r.call('linux_startup_cancel', next), 0);
  assert.equal(r.result(), 1n);
});

test('non-probe capture result cannot start or borrow before its exact receiver', {
  skip: resultArtifact ? false : 'Requires explicit independent-result artifact',
}, () => {
  const r = raw(resultArtifact!, false, false, false, false, bytes('not needed'), true);
  assert.throws(() => memoryHost(r.module, 2, 8), /not an ordinary Linux admission/);
  assert.throws(() => verifiedCaptureCandidate(r.wasm, {kind: 'sods-linux-capture-candidate-v1',
    byteLength: r.wasm.byteLength, sha256: createHash('sha256').update(r.wasm).digest('hex')}), /identity/);
  const separate = new WebAssembly.Instance(r.module).exports;
  const call = (name: string, ...args: number[]) => (separate[name] as (...values: number[]) => number)(...args);
  assert.equal(call('linux_init', 1, 8), 0);
  assert.equal(call('linux_capture_select', 2), 0);
  assert.equal(call('linux_files_prepare', 8, 8, 4096, 8, 32, 32, 2), 0);
  assert.equal(call('linux_files_seal', 8), 0);
  assert.equal(call('linux_capture_result_init', 4, 4), -11, 'an unmounted diagnostic Files is not the startup owner');
  r.stageStartup();
  assert.equal(r.call('linux_capture_result_startup', 2), -5);
  assert.equal(r.result(), 0n, 'unsupported input permission cannot reserve startup');
  assert.equal(r.call('linux_capture_result_startup', 0), -9);
  assert.equal(r.result(), 0n);
  assert.equal(r.call('linux_capture_result_head'), -9);
  for (const [m, q] of [[0, 4], [5, 4], [1, 65537], [4, -1]]) {
    assert.equal(r.call('linux_capture_result_init', m!, q!), -5);
    assert.equal(r.call('linux_capture_result_head'), -9, 'invalid width did not install a receiver');
    assert.equal(r.call('linux_capture_result_startup', 0), -9);
  }
  assert.equal(r.call('linux_capture_result_init', 4, 4), 0);
  assert.equal(r.call('linux_capture_result_init', 4, 4), -4);
  assert.equal(r.call('linux_capture_result_copy_start', 0, 1n), -10);
  assert.equal(r.receive(0), undefined);
  r.stageStartup('/not-present');
  assert.ok(r.call('linux_capture_result_startup', 0) < 0);
  const failed = r.result();
  assert.equal(failed, 1n, 'missing receiver previously admitted no execution');
  assert.ok(r.call('linux_run_start', failed) < 0);
  assert.equal(r.call('linux_startup_cancel', failed), 0);
  assert.equal(r.result(), 1n);
  assert.equal(r.receive(0), undefined);
});

test('non-probe capture result resumes the exact write only after confirmed result consumption', {
  skip: currentResultSkip, timeout: 30_000,
}, async () => {
  const current = currentCaptureProgram();
  const r = raw(resultArtifact!, false, false, false, false, current.elf, true);
  const resume = 'linux_capture_result_resume';
  assert.equal(r.call('linux_capture_result_init', 4, 4), 0);
  const input = await prepareCurrentCapture(r, current.translator, current.elf, {resultProfile: true});
  const {id, memory} = input;
  assert.equal(r.call('linux_startup_image_finish', id, 0), 0);
  assert.equal(r.call('linux_run_start', id), 0);
  const invocation = r.result();
  const at = 64n;
  new Uint8Array(memory.buffer, Number(at), 5).set(bytes('ABCDE'));
  const request = (seq: number, fd: bigint, addr: bigint, size: bigint) =>
    r.call('linux_syscall_sequenced', id, invocation, seq, 1n, fd, addr, size, 0n, 0n, 0n, 0n);
  const start = 'linux_capture_result_write_start', finish = 'linux_capture_result_write_finish';
  const settle = (sequence: number, action: bigint, length: number) => {
    assert.equal(r.call(start, id, sequence, action), 0);
    const core = r.e.memory as WebAssembly.Memory;
    copyWorkerInput(memory, core, Number(r.auxiliary()), Number(r.result()), length);
    assert.equal(r.call(finish, id, sequence, action, 0, length), 0);
    assert.deepEqual([r.state(), r.result()], [15, BigInt(length)]);
  };
  assert.equal(request(1, 1n, at, 4n), 0);
  assert.equal(r.state(), 13);
  const prior = r.result();
  settle(1, prior, 4);
  assert.equal(request(2, 2n, at + 4n, 1n), 0);
  const held = r.command();
  assert.deepEqual(held, {tag: 14, value: prior + 1n, next: 0n, target: 2n, endpoint: 0n});
  assert.equal(r.call(start, id, 2, held.value), -12, 'room pressure exposes no staging pointer');
  assert.equal(r.call(resume, id + 1n, 2, held.value), -4);
  assert.equal(r.call(resume, id, 1, held.value), -4);
  assert.equal(r.call(resume, id, 2, prior), -4);
  assert.equal(request(2, 2n, at + 4n, 1n), -4, 'the same request is not reissued');
  assert.equal(request(3, 2n, at + 4n, 1n), -4, 'later requests cannot overtake');
  assert.equal(r.call('linux_capture_result_head'), 0);
  const slot = Number(r.auxiliary()), generation = r.result();
  assert.equal(r.call('linux_capture_result_copy_start', slot, generation), 0);
  const receiver = r.auxiliary();
  assert.equal(r.call(resume, id, 2, held.value), -4, 'a lexical receive view fences all other dispatch');
  assert.equal(r.call('linux_capture_result_copy_finish', receiver, 1, 0), 0, 'unpublished ended access preserves the head');
  assert.equal(r.call(resume, id, 2, held.value), 0);
  assert.deepEqual(r.command(), held);
  assert.deepEqual(r.receive(0), bytes('ABCD'));
  assert.equal(r.call(resume, id, 2, held.value), 0);
  assert.deepEqual(r.command(), {tag: 13, value: held.value, next: 1n, target: at + 4n, endpoint: 0n});
  assert.equal(r.call(resume, id, 2, held.value), -12, 'only one ready staged copy');
  settle(2, held.value, 1);
  assert.equal(r.call(resume, id, 2, held.value), -4);
  assert.equal(r.call('linux_run_receipt', id, invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', id), 0);
  assert.equal(r.result(), 1n);
  assert.deepEqual(r.receive(0), bytes('E'));
  assert.equal(r.receive(0), undefined);
});

test('non-probe capture result rejects requests wider than M even with Q available', {
  skip: currentResultSkip, timeout: 30_000,
}, async () => {
  const current = currentCaptureProgram();
  const r = raw(resultArtifact!, false, false, false, false, current.elf, true);
  assert.equal(r.call('linux_capture_result_init', 4, 8), 0);
  const {id, memory} = await prepareCurrentCapture(r, current.translator, current.elf, {resultProfile: true});
  assert.equal(r.call('linux_startup_image_finish', id, 0), 0);
  assert.equal(r.call('linux_run_start', id), 0);
  const invocation = r.result(), at = 64n;
  new Uint8Array(memory.buffer, Number(at), 5).set(bytes('ABCDE'));
  const request = (nr: bigint, n: bigint) =>
    r.call('linux_syscall_sequenced', id, invocation, 1, nr, 1n, nr === 1n ? at : 999n, nr === 1n ? n : 0n, n, 0n, 0n, 0n);
  for (const invalid of [0n, 5n, 0x100000004n]) {
    assert.equal(request(1n, invalid), -5);
    assert.equal(request(40n, invalid), -5, 'wide resident length rejects before the source fd');
    assert.equal(r.receive(0), undefined);
  }
  assert.equal(request(1n, 4n), 0, 'invalid width did not spend the request sequence');
  const action = r.result();
  assert.equal(r.call('linux_capture_result_write_start', id, 1, action), 0);
  copyWorkerInput(memory, r.e.memory as WebAssembly.Memory, Number(at), Number(r.result()), 4);
  assert.equal(r.call('linux_capture_result_write_finish', id, 1, action, 0, 4), 0);
  assert.deepEqual(r.receive(0), bytes('ABCD'));
  assert.equal(r.call('linux_run_receipt', id, invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', id), 0);
  assert.equal(r.result(), 1n);
});

for (const cancel of [false, true]) test(`non-probe capture result ${cancel ? 'abandons stopped' : 'resumes'} resident sendfile on the actual Worker`, {
  skip: currentResultSkip, timeout: 30_000,
}, async () => {
  const current = currentCaptureProgram(true);
  const r = raw(resultArtifact!, false, false, false, false, current.elf, true);
  const resume = 'linux_capture_result_resume';
  assert.equal(r.call('linux_capture_result_init', 4, 4), 0);
  const prepared = await prepareCurrentCapture(r, current.translator, current.elf, {resultProfile: true});
  const bridge = createGuest(prepared);
  try {
    await bridge.ready;
    const {id, memory, entry} = prepared, core = r.e.memory as WebAssembly.Memory;
    assert.equal(r.call('linux_startup_image_finish', id, 0), 0);
    assert.equal(r.call('linux_run_start', id), 0);
    const invocation = r.result(), observed: bigint[] = [], consumed: string[] = [];
    const run = await bridge.run(invocation, entry, async request => {
      observed.push(request.nr);
      assert.equal(r.call('linux_syscall_sequenced', id, request.invocation, request.sequence,
        request.nr, ...request.args, request.next), 0);
      const c = r.command();
      if (c.tag === 8) {
        const length = bytes('/source\0').length;
        assert.equal(r.call('linux_syscall_path_start', id, c.value), 0);
        copyWorkerInput(memory, core, Number(c.target), Number(r.result()), length);
        assert.equal(r.call('linux_syscall_path_finish', id, c.value, BigInt(length), 0), 0);
        assert.deepEqual([r.state(), r.result()], [0, 0n]);
        return {kind: 'return', value: 0n};
      }
      if (c.tag === 13) {
        assert.equal(r.call('linux_capture_result_write_start', id, request.sequence, c.value), 0);
        copyWorkerInput(memory, core, Number(r.auxiliary()), Number(r.result()), 1);
        assert.equal(r.call('linux_capture_result_write_finish', id, request.sequence, c.value, 0, 1), 0);
        assert.deepEqual([r.state(), r.result()], [15, 1n]);
        return {kind: 'return', value: 1n};
      }
      if (c.tag === 15) return {kind: 'return', value: c.value};
      if (c.tag === 2) return {kind: 'leave'};
      assert.equal(c.tag, 14);
      assert.equal(request.nr, 40n);
      assert.equal(c.target, BigInt(request.sequence));
      assert.equal(r.call('linux_capture_result_write_start', id, request.sequence, c.value), -4,
        'resident pressure never exposes a write copy view');
      assert.equal(r.call(resume, id, request.sequence, c.value + 1n), -4);
      assert.equal(r.call(resume, id, request.sequence, c.value), 0);
      assert.deepEqual(r.command(), c, 'nothing released yet');
      const first = r.receiveRecord(0);
      assert.deepEqual([first?.bytes, first?.origin], [bytes('A'), 1n]);
      consumed.push('A');
      assert.equal(r.call(resume, id, request.sequence, c.value), 0);
      assert.deepEqual(r.command(), c, 'receiving copied A returns Q/K, not the held R');
      if (cancel) {
        bridge.requestStop();
        await bridge.stopped;
        assert.equal(r.call('linux_run_receipt', id, invocation, 2, 0n), 0);
        assert.equal(r.call(resume, id, request.sequence, c.value), -12, 'observed stop prevents publication');
        assert.equal(r.call('linux_syscall_abandon', id), 0);
        assert.equal(r.call(resume, id, request.sequence, c.value), -4);
      } else {
        const firstPin = r.receiveRecord(0);
        assert.deepEqual([firstPin?.bytes, firstPin?.origin], [bytes('B'), 1n]);
        consumed.push('B');
        assert.equal(r.call(resume, id, request.sequence, c.value), 0);
        assert.deepEqual([r.state(), r.result()], [15, 1n]);
        assert.equal(r.call(resume, id, request.sequence, c.value), -4);
        assert.deepEqual(r.remaining({id, invocation, sequence: request.sequence}, 0n), Uint8Array.of(),
          'the retained source advanced exactly once from original B to the end of D');
      }
      return {kind: 'return', value: 1n};
    });
    await bridge.requestsSettled();
    assert.equal(bridge.diagnostics().failureCount, 0);
    if (cancel) {
      assert.equal(run.kind, 'failed');
      assert.deepEqual(observed, [2n, 1n, 40n, 40n]);
    } else {
      assert.deepEqual(run, {kind: 'left', unwound: true});
      assert.deepEqual(observed, [2n, 1n, 40n, 40n, 1n, 60n]);
      assert.equal(r.call('linux_run_receipt', id, invocation, 1, 0n), 0);
      assert.equal(r.result(), 42n);
    }
    bridge.requestStop(); await bridge.stopped;
    assert.equal(r.call('linux_execution_retire', id), 0);
    assert.equal(r.result(), 1n);
    for (const expected of cancel ? ['B'] : ['D', 'C']) {
      const record = r.receiveRecord(0);
      assert.deepEqual([record?.bytes, record?.origin], [bytes(expected), cancel ? 1n : 2n]);
      consumed.push(expected);
    }
    assert.equal(r.receive(0), undefined);
    assert.equal(consumed.join(''), cancel ? 'AB' : 'ABDC');
  } finally {
    bridge.requestStop();
    if (bridge.diagnostics().created) await bridge.stopped;
  }
});

for (const mode of ['accept', 'stop-before-copy', 'stop-after-accept', 'stop-while-unconfirmed'] as const) {
  test(`real Node Worker capture fixture: ${mode}`, {skip: workerQueueSkip, timeout: 30_000}, async t => {
    const r = raw(workerQueueArtifact!, true, false, true, true);
    assert.equal(r.call('linux_queued_output_probe_init'), 0);
    const input = captureGuest(), bridge = createGuest(input);
    const onAbort = () => bridge.requestStop();
    t.signal.addEventListener('abort', onAbort, {once: true});
    try {
      await bridge.ready;
      const owner = r.live(true), id = owner.id;
      let writes = 0, accepted = false, callbackStopped = false;
      const outcome = await bridge.run(owner.invocation, 4096n, async request => {
        assert.equal(request.invocation, owner.invocation);
        assert.equal(request.sequence, owner.sequence + 1);
        assert.equal(bridge.diagnostics().exited, false);
        if (request.nr === 60n) {
          assert.equal(mode, 'accept');
          assert.deepEqual(r.request(owner, request.nr, request.args).tag, 2);
          return {kind: 'leave'} as const;
        }
        assert.equal(request.nr, 1n);
        assert.equal(++writes, 1);
        const [fd, at, requested] = request.args;
        assert.equal(r.call('linux_queued_worker_probe_write', id, request.invocation, request.sequence, fd, at, requested), 0);
        owner.sequence = request.sequence;
        const c = r.command(), action = c.value, start = 'linux_queued_worker_probe_start', finish = 'linux_queued_worker_probe_finish';
        assert.deepEqual([c.tag, c.target, c.next, c.endpoint], [13, 32n, 2n, 0n]);
        if (mode === 'stop-before-copy') {
          bridge.requestStop(); await bridge.stopped;
          assert.equal(bridge.diagnostics().pendingRequest, true);
          assert.equal(r.call('linux_run_receipt', id, request.invocation, 2, 0n), 0);
          assert.ok(r.call(start, id, request.sequence, action) < 0);
          assert.equal(r.call('linux_syscall_abandon', id), 0);
          callbackStopped = true;
          return {kind: 'leave'} as const;
        }
        assert.equal(r.call(start, id, request.sequence, action), 0);
        const pointer = r.result(), source = r.auxiliary(), length = Number(r.length());
        assert.deepEqual([source, length], [c.target, Number(c.next)]);
        try { copyWorkerInput(input.memory, r.e.memory as WebAssembly.Memory, Number(source), Number(pointer), length); }
        catch (error) {
          // The trusted lexical helper unwound; the views cannot remain.
          assert.equal(r.call(finish, id, request.sequence, action, 1, 0), 0);
          throw error;
        }
        if (mode === 'stop-while-unconfirmed') {
          // Keep the access state unresolved as an explicit fault injection.
          // No actual JS view is stored across this await.
          assert.equal(r.call(finish, id, request.sequence, action, 2, length), 0);
          bridge.requestStop(); await bridge.stopped;
          assert.equal(bridge.diagnostics().pendingRequest, true);
          assert.equal(r.call('linux_run_receipt', id, request.invocation, 2, 0n), -4);
          assert.equal(r.call('linux_execution_retire', id), -4);
          assert.equal(r.call(finish, id, request.sequence, action, 1, 0), 0);
          assert.equal(r.call('linux_run_receipt', id, request.invocation, 2, 0n), 0);
          callbackStopped = true;
          return {kind: 'leave'} as const;
        }
        assert.equal(r.call(finish, id, request.sequence, action, 0, length), 0);
        const done = r.command();
        assert.deepEqual([done.tag, done.value], [0, 2n]);
        accepted = true;
        if (mode === 'stop-after-accept') {
          bridge.requestStop(); await bridge.stopped;
          assert.equal(bridge.diagnostics().pendingRequest, true);
          assert.equal(r.call('linux_run_receipt', id, request.invocation, 2, 0n), 0);
          callbackStopped = true;
        }
        return {kind: 'return', value: done.value} as const;
      });
      await bridge.requestsSettled();
      assert.equal(bridge.diagnostics().failureCount, 0);
      if (mode === 'accept') {
        assert.deepEqual(outcome, {kind: 'left', unwound: true});
        assert.equal(r.call('linux_run_receipt', id, owner.invocation, 1, 0n), 0); assert.equal(r.result(), 42n);
        bridge.requestStop(); await bridge.stopped;
        assert.deepEqual(Array.from(new Uint8Array(input.memory.buffer, 32, 2)), [88, 89]);
      } else {
        assert.equal(outcome.kind, 'failed');
        assert.equal(callbackStopped, true);
      }
      assert.equal(writes, 1);
      assert.equal(bridge.diagnostics().exited, true);
      assert.equal(r.call('linux_execution_retire', id), 0); assert.equal(r.result(), 1n);
      assert.equal(accepted, mode === 'accept' || mode === 'stop-after-accept');
      assert.equal(r.call('linux_queued_output_probe_peek', 0, 0), 0);
      assert.deepEqual([r.length(), r.result()], accepted ? [2n, 65n] : [0n, 0n]);
      if (accepted) {
        assert.equal(r.call('linux_queued_output_probe_peek', 0, 1), 0);
        assert.deepEqual([r.length(), r.result()], [2n, 66n]);
        assert.equal(r.call('linux_queued_worker_probe_receive_head', 0), 0);
        assert.equal(r.call('linux_queued_worker_probe_receive_start', 0, r.auxiliary(), r.result()), 0);
        const attempt = r.auxiliary();
        assert.equal(r.call('linux_queued_worker_probe_receive_finish', attempt, 2, 0), 0);
        // Producer exit does not authorize freeing a copied head's Vec while
        // the independent receiver holds an unresolved view of that Vec.
        assert.equal(r.call('linux_queued_output_probe_discard', 0), -4);
        assert.equal(r.call('linux_queued_worker_probe_receive_finish', attempt, 1, 0), 0);
        assert.throws(() => r.receive(0, 1), /insufficient capacity/);
        const retained = r.receive(0);
        assert.deepEqual(retained, bytes('AB'), 'copied head survives rejected pre-admission and producer retirement');
        assert.notEqual(retained?.buffer, (r.e.memory as WebAssembly.Memory).buffer);
        assert.equal(r.receive(0), undefined);
      }
    } finally {
      t.signal.removeEventListener('abort', onAbort);
      bridge.requestStop();
      if (bridge.diagnostics().created) {
        const cleanup = await bridge.stopEvidence();
        assert.equal(cleanup.stopped, true, 'cleanup requires observed Worker exit');
        await bridge.requestsSettled();
      }
    }
  });
}

for (const [useCurrent, stopBeforeFileReply, withSink, resultProfile] of [
  [false, false, false, false], [false, true, false, false], [true, false, false, false],
  [true, true, false, false], [true, false, true, false], [true, false, false, true], [true, true, false, true],
] as const) {
  test(`real Node Worker capture fixture: ${resultProfile ? 'non-probe capture result ' : ''}${useCurrent ? 'current-source translated ' : ''}same lane ${stopBeforeFileReply ? 'AB then observed stop before file reply' : withSink ? 'ABC reaches the owned Node file only through exact sink settlement' : 'write, resident sendfile, write yields ABC'}`, {
    skip: resultProfile ? currentResultSkip : useCurrent ? currentMixedSkip : workerQueueSkip, timeout: 30_000,
  }, async t => {
    const inputFd = resultProfile ? 0n : 3n;
    const current = useCurrent ? currentCaptureProgram() : undefined;
    const r = resultProfile ? raw(resultArtifact!, false, false, false, false, current!.elf, true)
      : raw(workerQueueArtifact!, true, false, true, true, current?.elf);
    assert.throws(() => memoryHost(r.module, 2, 8), resultProfile ? /not an ordinary Linux admission/ : /Synthetic sendfile probe/);
    assert.equal(resultProfile ? r.call('linux_capture_result_init', 4, 4)
      : r.call(current ? 'linux_queued_worker_probe_init_joined' : 'linux_queued_output_probe_init'), 0);
    const prepared = current ? await prepareCurrentCapture(r, current.translator, current.elf, {resultProfile}) : undefined;
    const input = prepared ?? captureGuest(true), bridge = createGuest(input);
    const onAbort = () => bridge.requestStop();
    t.signal.addEventListener('abort', onAbort, {once: true});
    let attemptedImageReceipt = false;
    let sinkDirectory: string | undefined;
    let sink: ReturnType<typeof ownedNodeSink> | undefined;
    try {
      await bridge.ready;
      if (withSink) {
        sinkDirectory = mkdtempSync(join(tmpdir(), 'sods-worker-sink-'));
        sink = ownedNodeSink(r, 0, join(sinkDirectory, 'output'));
      }
      let owner: Owner;
      const entry = prepared?.entry ?? 4096n;
      if (prepared) {
        assert.equal(bridge.diagnostics().exited, false);
        const id = prepared.id;
        attemptedImageReceipt = true;
        assert.equal(r.call('linux_startup_image_finish', id, 0), 0);
        assert.equal(r.call('linux_startup_entry', id), 0); assert.equal(r.result(), entry);
        assert.equal(r.call('linux_run_start', id), 0);
        owner = {id, invocation: r.result(), sequence: 0};
      } else owner = r.live(true);
      const id = owner.id, guestCalls: bigint[] = [], writeAddresses: number[] = [];
      const core = r.e.memory as WebAssembly.Memory;
      let firstWriteAction: bigint | undefined, inputCursorChecked = false;
      const outcome = await bridge.run(owner.invocation, entry, async request => {
        assert.equal(request.invocation, owner.invocation);
        assert.equal(request.sequence, owner.sequence + 1);
        assert.equal(bridge.diagnostics().exited, false);
        guestCalls.push(request.nr);
        // The original request crosses once. The fixture now responds to the
        // Rust-issued command; syscall numbers below are assertions only.
        assert.equal(r.call(resultProfile ? 'linux_syscall_sequenced' : 'linux_queued_worker_probe_request', id, request.invocation, request.sequence,
          request.nr, ...request.args, request.next), 0);
        owner.sequence = request.sequence;
        const command = r.command();
        if (command.tag === 8) {
          assert.equal(request.nr, 2n);
          assert.equal(command.target, request.args[0]);
          const pathLength = bytes('/source\0').length;
          assert.equal(r.call('linux_syscall_path_start', id, command.value), 0);
          const pointer = Number(r.result());
          assert.ok(r.length() >= BigInt(pathLength));
          copyWorkerInput(input.memory, core, Number(command.target), pointer, pathLength);
          assert.equal(r.call('linux_syscall_path_finish', id, command.value, BigInt(pathLength), 0), 0);
          assert.deepEqual([r.state(), r.result()], [0, inputFd]);
          return {kind: 'return', value: r.result()} as const;
        }
        if (command.tag === (resultProfile ? 15 : 0)) {
          assert.equal(request.nr, 40n);
          const [out, fd, offset, length] = request.args;
          assert.deepEqual([out, fd, offset, length], [1n, inputFd, 0n, 1n]);
          assert.deepEqual(command, {tag: resultProfile ? 15 : 0, value: 1n, next: 0n, target: 0n, endpoint: 0n});
          if (stopBeforeFileReply) {
            assert.deepEqual(r.remaining(owner, fd), bytes('D'));
            inputCursorChecked = true;
            bridge.requestStop(); await bridge.stopped;
            assert.equal(bridge.diagnostics().pendingRequest, true);
            assert.equal(r.call('linux_run_receipt', id, request.invocation, 2, 0n), 0);
          }
          return {kind: 'return', value: command.value} as const;
        }
        if (command.tag === 2) {
          assert.equal(request.nr, 60n);
          return {kind: 'leave'} as const;
        }
        assert.equal(command.tag, 13);
        assert.equal(request.nr, 1n);
        const [fd, at, length] = request.args;
        assert.equal(fd, current && writeAddresses.length === 1 ? 2n : 1n);
        assert.equal(length, 1n);
        writeAddresses.push(Number(at));
        const action = command.value;
        assert.deepEqual([command.tag, command.target, command.next, command.endpoint], [13, at, 1n, 0n]);
        if (firstWriteAction === undefined) firstWriteAction = action;
        else assert.equal(action, firstWriteAction + 1n, 'resident file acceptance did not issue another Domain action');
        const start = resultProfile ? 'linux_capture_result_write_start' : 'linux_queued_worker_probe_start';
        const finish = resultProfile ? 'linux_capture_result_write_finish' : 'linux_queued_worker_probe_finish';
        assert.equal(r.call(start, id, request.sequence, action), 0);
        const pointer = Number(r.result()), source = Number(r.auxiliary()), extent = Number(r.length());
        assert.deepEqual([source, extent], [Number(at), 1]);
        try { copyWorkerInput(input.memory, core, source, pointer, extent); }
        catch (error) {
          assert.equal(r.call(finish, id, request.sequence, action, 1, 0), 0);
          throw error;
        }
        assert.equal(r.call(finish, id, request.sequence, action, 0, extent), 0);
        const step = r.command();
        assert.deepEqual([step.tag, step.value], [resultProfile ? 15 : 0, 1n]);
        if (writeAddresses.length === 2) {
          assert.deepEqual(r.remaining(owner, inputFd), bytes('D'));
          inputCursorChecked = true;
        }
        return {kind: 'return', value: step.value} as const;
      });
      await bridge.requestsSettled();
      assert.equal(bridge.diagnostics().failureCount, 0);
      assert.equal(inputCursorChecked, true);
      if (stopBeforeFileReply) {
        assert.equal(outcome.kind, 'failed');
        assert.deepEqual(guestCalls, [2n, 1n, 40n]);
      } else {
        assert.deepEqual(outcome, {kind: 'left', unwound: true});
        assert.deepEqual(guestCalls, [2n, 1n, 40n, 1n, 60n]);
        assert.equal(r.call('linux_run_receipt', id, owner.invocation, 1, 0n), 0); assert.equal(r.result(), 42n);
        bridge.requestStop(); await bridge.stopped;
        assert.deepEqual(writeAddresses.map(at => new Uint8Array(input.memory.buffer, at, 1)[0]), [88, 89]);
      }
      assert.equal(bridge.diagnostics().exited, true);
      assert.equal(r.call('linux_execution_retire', id), 0); assert.equal(r.result(), 1n);
      if (resultProfile) {
        const head = 'linux_capture_result_head', start = 'linux_capture_result_copy_start', finish = 'linux_capture_result_copy_finish';
        assert.equal(r.call(head), 0);
        const generation = r.result(), slot = Number(r.auxiliary()), extent = Number(r.length());
        assert.equal(extent, 1);
        assert.equal(r.call(start, slot, generation + 1n), -10, 'stale result may not expose bytes');
        assert.equal(r.call(start, slot, generation), 0);
        const attempt = r.auxiliary();
        assert.equal(r.call(head), -4, 'one published Core view excludes the next access');
        assert.equal(r.call(finish, attempt + 1n, 1, 0), -4);
        assert.equal(r.call(finish, attempt, 2, extent), 0, 'full count without stop is not publication');
        assert.equal(r.call(finish, attempt, 0, extent), -4);
        assert.equal(r.call(finish, attempt, 1, 0), 0, 'ended unpublished access leaves the same head');
        assert.equal(r.call(head), 0);
        assert.deepEqual([r.result(), Number(r.auxiliary()), Number(r.length())], [generation, slot, extent]);
      }
      if (sink) {
        assert.equal(sink.writeOne(1, true), 'waiting');
        assert.deepEqual(new Uint8Array(readFileSync(join(sinkDirectory!, 'output'))), bytes('A'));
        assert.equal(sink.closeIfDrained(), false, 'observed Worker exit is not sink stop');
        assert.equal(sink.acknowledge(), 'complete');
        assert.equal(sink.writeOne(), 'complete');
        assert.equal(sink.writeOne(), 'complete');
        assert.equal(sink.writeOne(), 'empty');
        assert.equal(sink.closeIfDrained(), true);
        assert.deepEqual(new Uint8Array(readFileSync(join(sinkDirectory!, 'output'))), bytes('ABC'));
        assert.equal(r.call('linux_queued_worker_probe_receive_head', 1), -5,
          'joined initialization allocated no spare receiver');
      } else {
        const received: Uint8Array[] = [];
        for (const expected of stopBeforeFileReply ? ['A', 'B'] : ['A', 'B', 'C']) {
          const buffer = r.receive(0);
          assert.deepEqual(buffer, bytes(expected));
          assert.notEqual(buffer?.buffer, core.buffer, 'the exposed result is not the borrowed Core memory');
          received.push(buffer!);
        }
        assert.equal(r.receive(0), undefined);
        if (resultProfile) assert.throws(() => r.receive(1), /one receiver/);
        else if (current) assert.equal(r.call('linux_queued_worker_probe_receive_head', 1), -5);
        else assert.equal(r.receive(1), undefined);
        assert.equal(received.map(value => new TextDecoder().decode(value)).join(''), stopBeforeFileReply ? 'AB' : 'ABC');
      }
      if (current) t.diagnostic(JSON.stringify({translatorSha256: current.sha, elfBytes: current.elf.length,
        elfSha256: createHash('sha256').update(current.elf).digest('hex'), entry: String(entry),
        stack: 'Rust-created, guest checked argc and first byte of argv0'}));
    } finally {
      t.signal.removeEventListener('abort', onAbort);
      bridge.requestStop();
      if (bridge.diagnostics().created) {
        const stopped = await bridge.stopEvidence();
        assert.equal(stopped.stopped, true);
        await bridge.requestsSettled();
        if (prepared && !attemptedImageReceipt) cancelPreparedImage(r, prepared.id);
      } else if (prepared && !attemptedImageReceipt) {
        // The bridge was invoked but returned no Worker handle. A failed
        // creation is not an exit receipt: request cancellation and retain.
        assert.equal(r.call('linux_startup_cancel', prepared.id), 0); assert.equal(r.result(), 0n);
      }
      if (sinkDirectory && (!sink || sink.closeIfDrained())) rmSync(sinkDirectory, {recursive: true, force: true});
    }
  });
}
