import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixedTranslatedModule, fixedTranslatedModuleAsync} from '../../runtime/linux/translated-image.ts';

const leb = (n: number): number[] => n < 128 ? [n] : [(n & 127) | 128, ...leb(n >>> 7)];
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
const name = (s: string) => [s.length, ...new TextEncoder().encode(s)];
const names = ['syscall', 'trap', 'div128', 'clock', 'fpu', 'trace', 'miss', 'time'];
function image(options: {start?: boolean; data?: boolean; omit?: boolean; foreign?: boolean; grow?: boolean; definedMemory?: boolean; duplicate?: boolean; wrongKind?: boolean} = {}) {
  const imports = [
    [...name('env'), ...name('memory'), 2, 1, 1, 1],
    ...(options.omit ? names.slice(1) : names).map(n => [...name(options.foreign ? 'other' : 'env'), ...name(options.duplicate ? 'syscall' : n), ...(options.wrongKind ? [3, 0x7f, 0] : [0, 0])]),
  ];
  const body = options.grow ? [0, 0x41, 0, 0x40, 0, 0x1a, 0x0b] : [0, 0x0b];
  return new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(2, [imports.length, ...imports.flat()]),
    ...section(3, [1, 0]),
    ...(options.definedMemory ? section(5, [1, 1, 1, 1]) : []),
    ...(options.start ? section(8, [imports.length - 1]) : []),
    ...section(10, [1, ...leb(body.length), ...body]),
    ...(options.data ? section(11, [1, 0, 0x41, 0, 0x0b, 1, 42]) : []),
  ]);
}

test('fixed image framing admits data but never instantiates or executes it', () => {
  const input = image({data: true});
  const module = fixedTranslatedModule(input);
  input.fill(0);
  assert.equal(WebAssembly.Module.imports(module).length, 9);
});

test('fixed image rejects start, unknown and missing imports', () => {
  assert.throws(() => fixedTranslatedModule(image({start: true})), /start function/);
  assert.throws(() => fixedTranslatedModule(image({foreign: true})), /Unsupported.*import/);
  assert.throws(() => fixedTranslatedModule(image({omit: true})), /Incomplete.*imports/);
  assert.throws(() => fixedTranslatedModule(new Uint8Array([0, 97])), WebAssembly.CompileError);
});

test('fixed profile does not pretend to prove absence of memory.grow', () => {
  assert.ok(fixedTranslatedModule(image({grow: true})) instanceof WebAssembly.Module);
  // Admission is valid only when the host supplies a private initial=max Memory
  // and uses fresh views with no guest reentry during a physical copy.
});

test('fixed image rejects hidden memory and ambiguous import identities', () => {
  assert.throws(() => fixedTranslatedModule(image({definedMemory: true})), /must not define memory/);
  assert.throws(() => fixedTranslatedModule(image({duplicate: true})), /Unsupported.*import/);
  assert.throws(() => fixedTranslatedModule(image({wrongKind: true})), /Unsupported.*import/);
});


test('externally initialized Worker image rejects retained data', () => {
  assert.throws(() => fixedTranslatedModule(image({data: true}), {externalData: true}), /retain data segments/);
  assert.ok(fixedTranslatedModule(image(), {externalData: true}) instanceof WebAssembly.Module);
});


test('async admission owns the pre-await bytes and returns the validated module', async () => {
  const input = image({data: true});
  const pending = fixedTranslatedModuleAsync(input);
  input.fill(0);
  const module = await pending;
  assert.equal(WebAssembly.Module.imports(module).length, 9);
  // Changing a rejected original after dispatch cannot make its checks inspect
  // replacement bytes while the engine uses the earlier compilation snapshot.
  const forbidden = image({start: true});
  const rejection = fixedTranslatedModuleAsync(forbidden);
  forbidden.fill(0);
  await assert.rejects(rejection, /start function/);
});

test('async admission preserves all synchronous framing and import policies', async () => {
  for (const [options, message] of [
    [{start: true}, /start function/],
    [{foreign: true}, /Unsupported.*import/],
    [{omit: true}, /Incomplete.*imports/],
    [{definedMemory: true}, /must not define memory/],
    [{duplicate: true}, /Unsupported.*import/],
    [{wrongKind: true}, /Unsupported.*import/],
  ] as const) await assert.rejects(fixedTranslatedModuleAsync(image(options)), message);
  await assert.rejects(fixedTranslatedModuleAsync(image({data: true}), {externalData: true}), /retain data segments/);
  await assert.rejects(fixedTranslatedModuleAsync(new Uint8Array([0, 97])), WebAssembly.CompileError);
  assert.ok(await fixedTranslatedModuleAsync(image(), {externalData: true}) instanceof WebAssembly.Module);
});
