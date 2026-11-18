import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {memoryHost} from '../../runtime/linux/memory-host.ts';

// These are real core ABI probes with SYNTHETIC image, capability, output and
// stop receipts. No Worker, socket, native sendfile, SIGPIPE or physical prefix
// is proved here. A probe-feature core must never enter the production host.
const normalArtifact = process.env.SODS_LINUX_WASM;
const probeArtifact = process.env.SODS_SENDFILE_PROBE_WASM;
const queueArtifact = process.env.SODS_QUEUED_OUTPUT_PROBE_WASM;
const normalSkip = normalArtifact ? false : 'Requires explicit SODS_LINUX_WASM production ABI7 artifact';
const probeSkip = probeArtifact ? false : 'Requires explicit SODS_SENDFILE_PROBE_WASM feature artifact; normal core cannot accept proof1';
const queueSkip = queueArtifact ? false : 'Requires the isolated SODS_QUEUED_OUTPUT_PROBE_WASM feature artifact';
const bytes = (value: string) => new TextEncoder().encode(value);
type Owner = {id: bigint; invocation: bigint; sequence: number};
type Send = {owner: Owner; action: bigint; sequence: number; endpoint: bigint; offered: bigint};

function raw(path: string, probe: boolean, lazyData = false, queued = false) {
  const wasm = new Uint8Array(readFileSync(path)), module = new WebAssembly.Module(wasm);
  assert.equal(WebAssembly.Module.imports(module).length, 0);
  const e = new WebAssembly.Instance(module).exports;
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
  if (probe) assert.equal(call('linux_sendfile_probe'), 1);
  assert.equal(call('linux_init', 16, 64), 0);
  assert.equal(call('linux_prepared_files', 8, 8, 4096, 16, 128, 256, 16, 32, 1, 192, 0), 0);
  const root = result();
  put('linux_name', bytes('app')); put('linux_input', bytes('abcdef'));
  assert.equal(call('linux_tree_file', root, 0o755), 0);
  if (lazyData) {
    put('linux_name', bytes('data'));
    assert.equal(call('linux_tree_lazy', root, 0o444, 7, 0), 0);
  }
  assert.equal(call('linux_files_seal', 16), 0);

  const stageStartup = (program = '/app') => {
    const path = bytes(program), wire = new Uint8Array(48 + path.length), view = new DataView(wire.buffer);
    view.setBigUint64(0, 1n, true); view.setBigUint64(24, BigInt(path.length), true); wire.set(path, 48);
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
  const request = (owner: Owner, nr: bigint, args: readonly bigint[]) => {
    assert.equal(args.length, 6);
    assert.equal(call('linux_syscall_sequenced', owner.id, owner.invocation, ++owner.sequence, nr, ...args, 4096n), 0);
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
  return {wasm, module, e, call, result, state, length, auxiliary, endpoint, command, put,
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
