import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {memoryHost} from '../../runtime/linux/memory-host.ts';

const artifact = process.env.SODS_LINUX_WASM;
const bytes = (s: string) => new TextEncoder().encode(s);
// Real ABI with synthetic image/stop receipts, not evidence of physical Worker
// execution. managed-open.test.ts exercises the actual translated CLI/Worker.
function raw() {
  const wasm = new Uint8Array(readFileSync(artifact!)), module = new WebAssembly.Module(wasm);
  const e = new WebAssembly.Instance(module).exports;
  const call = (name: string, ...args: (number | bigint)[]) => (e[name] as (...args: (number | bigint)[]) => number)(...args);
  const result = () => (e.linux_result as () => bigint)();
  const state = () => (e.linux_result_state as () => number)();
  const length = () => (e.linux_result_length as () => bigint)();
  const put = (name: string, value: Uint8Array) => {
    assert.equal(call(name, value.length), 0);
    new Uint8Array((e.memory as WebAssembly.Memory).buffer, Number(result()), value.length).set(value);
  };
  assert.equal(call('linux_abi_version'), 3); assert.equal(call('linux_init', 8, 32), 0);
  assert.equal(call('linux_prepared_files', 4, 4, 4096, 8, 64, 64, 8, 16, 1, 96, 0), 0);
  const root = result(); put('linux_name', bytes('app')); put('linux_input', bytes('elf'));
  assert.equal(call('linux_tree_file', root, 0o755), 0); assert.equal(call('linux_files_seal', 8), 0);
  function live() {
    const path = bytes('/app'), wire = new Uint8Array(48 + path.length), view = new DataView(wire.buffer);
    view.setBigUint64(0, 1n, true); view.setBigUint64(24, BigInt(path.length), true); wire.set(path, 48);
    put('linux_startup_input', wire); assert.equal(call('linux_startup_begin'), 0); const id = result();
    assert.equal(call('linux_startup_input', 0), 0);
    assert.equal(call('linux_startup_source_start', id), 0); assert.equal(result(), 0n);
    assert.equal(call('linux_startup_bytes', id), 0);
    assert.equal(call('linux_startup_translation_finish', id, 1, 4096n, 0n, 56n, 0n, 131072n), 0);
    assert.equal(call('linux_bind', 131072n), 0); const binding = result();
    assert.equal(call('linux_startup_image_begin', id, binding, 65536n, 131072n), 0);
    assert.equal(call('linux_startup_image_finish', id, 0), 0);
    assert.equal(call('linux_run_start', id), 0); const invocation = result();
    return {id, invocation};
  }
  function open(owner: ReturnType<typeof live>, at = 32n) {
    assert.equal(call('linux_syscall', owner.id, owner.invocation, 257n, -100n, at, 0n, 0n, 0n, 0n, 4096n), 0);
    assert.equal(state(), 8); return result();
  }
  function capture(owner: ReturnType<typeof live>, action: bigint, value: Uint8Array) {
    assert.equal(call('linux_syscall_path_start', owner.id, action), 0); const pointer = result(), maximum = length();
    new Uint8Array((e.memory as WebAssembly.Memory).buffer, Number(pointer), value.length).set(value);
    return maximum;
  }
  return {wasm, module, e, call, result, state, length, live, open, capture};
}
// Imports are absent. Read actual exported function types so guard probes use
// type-correct zero arguments rather than passing because JavaScript rejected a
// wrong BigInt/number signature before entering the Wasm function.
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

test('pathname capture excludes every nonmatching core export, including read-view exceptions', {skip: !artifact}, () => {
  const r = raw(), owner = r.live(), action = r.open(owner); r.capture(owner, action, bytes('/app\0'));
  assert.equal(WebAssembly.Module.imports(r.module).length, 0);
  const scalar = new Set(['linux_abi_version', 'linux_result', 'linux_result_length', 'linux_result_auxiliary', 'linux_result_endpoint', 'linux_result_state']);
  let checked = 0;
  for (const [name, params] of signatures(r.wasm)) {
    if (scalar.has(name)) continue;
    const args = params.map(type => type === 0x7e ? 0n : 0);
    assert.ok(r.call(name, ...args) < 0, name); checked++;
  }
  assert.ok(checked > 50);
  assert.equal(r.call('linux_syscall_path_finish', owner.id, action + 1n, 5n, 0), -4);
  assert.equal(r.call('linux_syscall_path_finish', owner.id + 1n, action, 5n, 0), -4);
  assert.equal(r.call('linux_syscall_path_finish', owner.id, action, 5n, 0), 0); assert.equal(r.result(), 0n);
});

test('another Unknown capture finish cannot allocate while a different owner exposes its input view', {skip: !artifact}, () => {
  const r = raw(), a = r.live(), b = r.live(), old = r.open(b); r.capture(b, old, bytes('/app\0'));
  assert.equal(r.call('linux_syscall_path_finish', b.id, old, 5n, 2), 0); assert.equal(r.state(), 4);
  const current = r.open(a); r.capture(a, current, bytes('/app\0'));
  assert.equal(r.call('linux_syscall_path_finish', b.id, old, 5n, 0), -4);
  assert.equal(r.call('linux_syscall_path_finish', a.id, current, 5n, 0), 0); assert.equal(r.result(), 0n);
  assert.equal(r.call('linux_syscall_path_finish', b.id, old, 5n, 0), 0); assert.equal(r.result(), 0n);
  assert.ok(r.call('linux_syscall_path_finish', b.id, old, 5n, 0) < 0);
});

test('zero or truncated capture never uses stale scratch NUL and never unlocks the live owner', {skip: !artifact}, () => {
  const r = raw(), owner = r.live(), first = r.open(owner); r.capture(owner, first, bytes('/app\0'));
  assert.equal(r.call('linux_syscall_path_finish', owner.id, first, 5n, 0), 0);
  const next = r.open(owner); r.capture(owner, next, bytes('/x'));
  assert.ok(r.call('linux_syscall_path_finish', owner.id, next, 0n, 0) < 0);
  assert.ok(r.call('linux_syscall_path_finish', owner.id, next, 2n, 0) < 0);
  assert.equal(r.call('linux_startup_input', 0), -4);
  assert.equal(r.call('linux_syscall_path_finish', owner.id, next, 0n, 1), 0); assert.equal(r.state(), 4);
  assert.ok(r.call('linux_syscall', owner.id, owner.invocation, 3n, 0n, 0n, 0n, 0n, 0n, 0n, 0n) < 0);
});

test('NUL at the physical tail succeeds without requiring the whole 4096-byte span', {skip: !artifact}, () => {
  const r = raw(), owner = r.live(), empty = r.open(owner, 131071n);
  assert.equal(r.capture(owner, empty, bytes('\0')), 1n);
  assert.equal(r.call('linux_syscall_path_finish', owner.id, empty, 1n, 0), 0); assert.equal(BigInt.asIntN(64, r.result()), -2n);
  const directory = r.open(owner, 131070n); assert.equal(r.capture(owner, directory, bytes('/\0')), 2n);
  assert.equal(r.call('linux_syscall_path_finish', owner.id, directory, 2n, 0), 0); assert.equal(r.result(), 0n);
});

test('unknown issued capture retains owners through synthetic stop until matching late completion', {skip: !artifact}, () => {
  const r = raw(), owner = r.live(), action = r.open(owner); r.capture(owner, action, bytes('/app\0'));
  assert.equal(r.call('linux_syscall_path_finish', owner.id, action, 5n, 2), 0);
  assert.ok(r.call('linux_start', action) < 0); assert.ok(r.call('linux_receipt', action, 5n, 0) < 0); assert.ok(r.call('linux_retire', action) < 0);
  assert.equal(r.call('linux_syscall_abandon', owner.id), 0); assert.equal(r.result(), 0n);
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 0n);
  assert.equal(r.call('linux_syscall_path_finish', owner.id, action, 5n, 0), 0); assert.equal(r.state(), 4);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
});

test('ready cancellation releases the operation but closes further syscall admission', {skip: !artifact}, () => {
  const r = raw(), owner = r.live(), action = r.open(owner);
  assert.equal(r.call('linux_syscall_abandon', owner.id), 0); assert.equal(r.result(), 1n);
  assert.ok(r.call('linux_syscall_path_start', owner.id, action) < 0);
  assert.ok(r.call('linux_syscall', owner.id, owner.invocation, 3n, 0n, 0n, 0n, 0n, 0n, 0n, 0n) < 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 0n);
  assert.equal(r.call('linux_run_receipt', owner.id, owner.invocation, 2, 0n), 0);
  assert.equal(r.call('linux_execution_retire', owner.id), 0); assert.equal(r.result(), 1n);
});

test('new required export names cannot make an obsolete private ABI acceptable', {skip: !artifact}, () => {
  const current = new WebAssembly.Module(readFileSync(artifact!));
  const names = WebAssembly.Module.exports(current).filter(e => e.kind === 'function').map(e => e.name);
  const leb = (value: number): number[] => { const out: number[] = []; do { const b = value & 127; value = Math.floor(value / 128); out.push(b | (value ? 128 : 0)); } while (value); return out; };
  const section = (id: number, payload: number[]) => [id, ...leb(payload.length), ...payload];
  const name = (value: string) => { const b = Array.from(bytes(value)); return [...leb(b.length), ...b]; };
  const exports = [...leb(names.length + 1), ...name('memory'), 2, 0, ...names.flatMap((n, i) => [...name(n), 0, ...leb(i)])];
  const bodies = names.flatMap(n => { const body = [0, 0x41, n === 'linux_abi_version' ? 2 : 0, 0x0b]; return [...leb(body.length), ...body]; });
  // Shape-complete controlled stub only tests version admission, not old behavior.
  const old = new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0,
    ...section(1,[1,0x60,0,1,0x7f]), ...section(3,[...leb(names.length), ...names.map(() => 0)]),
    ...section(5,[1,0,1]), ...section(7,exports), ...section(10,[...leb(names.length), ...bodies]),
  ]));
  assert.throws(() => memoryHost(old, 1, 1), /Unsupported Linux admission ABI/);
});
