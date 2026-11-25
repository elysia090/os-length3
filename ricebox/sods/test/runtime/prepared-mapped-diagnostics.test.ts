import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MappedCodeChanged, MappedCodeSpace} from '../../runtime/linux/exec/mapped-code-space.ts';
import {MAPPED_ABI_VERSION, MappedCodeTable} from '../../runtime/linux/exec/mapped-code-table.ts';
import {MappedEntries} from '../../runtime/linux/exec/mapped-entries.ts';
import {preparedMappedCodeFor} from '../../runtime/linux/exec/prepared-mapped-code.ts';
import {MNT} from '../../runtime/linux/fs.ts';
import {captureExecutableSource, capturePreparedMappedCode, mountTarget, PreparedMappedTrace, Vfs} from '../../runtime/linux.ts';
import type {MappedTranslate} from '../../runtime/translation/mapped.ts';

const encode = new TextEncoder();
const name = (value: string) => [value.length, ...encode.encode(value)];
const section = (kind: number, data: number[]) => [kind, data.length, ...data];
const u32 = (n: number) => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24];
const address = 0x3000;

// Checked metadata with no Wasm instructions, code, or start section. A
// successful install only publishes an imported, never-called host function.
function fragment(entry?: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, ...section(1, [1, 0x60, 0, 0]),
    ...section(2, [4, ...name('env'), ...name('mapped_string'), 0, 0, ...name('env'), ...name('mapped_fx_state'), 0, 0,
      ...name('main'), ...name('mapped_address'), 0, 0, ...name('piece'), ...name('base'), 3, 0x7f, 1]),
    ...(entry === undefined ? [] : section(7, [1, ...name('0'), 0, 2])),
    ...section(0, [...name(`sods.mapped-piece-v${MAPPED_ABI_VERSION}`), ...u32(entry === undefined ? 0 : 1),
      ...(entry === undefined ? [] : [...u32(entry), ...u32(entry), ...u32(0), ...u32(0)])]));
}

function harness(kind: 'no-piece' | 'elsewhere' | 'entry' | 'budget' | 'unavailable' | 'no-entry' | 'used' | 'corrupt' | 'revoked', collect = true) {
  const vfs = new Vfs(), memory = new WebAssembly.Memory({initial: 1});
  const origin = 'known-packed-source', bytes = Uint8Array.of(1, 2, 3, 4, 5, 6);
  const file = mountTarget(vfs).file('/test.elf', 0o755, bytes.length, () => bytes, origin);
  const source = captureExecutableSource(vfs, '/test.elf', {origin, size: bytes.length});
  const text = {role: 'library', address, bias: 0x2000, offset: 2, length: 4} as const;
  const trace = new PreparedMappedTrace(), calls: string[] = [];
  const notCalled = () => assert.fail('No imported function or guest instructions should run');
  const compiler: MappedTranslate = {core: notCalled, close: () => { calls.push('close'); }, more: () => {
    calls.push('fallback');
    return fragment();
  }};
  const replay = fragment(kind === 'used' ? address : undefined);
  const token = capturePreparedMappedCode(vfs, compiler, kind === 'no-piece' ? [] : [{source, origin, sourceSize: bytes.length,
    text: kind === 'elsewhere' ? {...text, bias: text.bias - 1} : text, entry: kind === 'entry' ? address + 1 : address,
    bytes: kind === 'budget' ? replay.length + 1 : replay.length,
    read: () => {
      calls.push('prepared');
      if (kind === 'revoked') vfs.mount.flags |= MNT.NOEXEC;
      if (kind === 'unavailable') return;
      return kind === 'corrupt' ? replay.subarray(0, 6) : replay;
    },
  }], collect ? trace : undefined);
  const space = new MappedCodeSpace(vfs, memory, preparedMappedCodeFor(token, vfs, compiler));
  new Uint8Array(memory.buffer).set(bytes.subarray(text.offset), address);
  space.bind({file, source, text, mount: vfs.mount, prot: 5, private: true});
  const generation = space.generation;
  const table = new MappedCodeTable({table: new WebAssembly.Table({element: 'anyfunc', initial: 0}), mapped_address: notCalled},
    {mapped_string: notCalled, mapped_fx_state: notCalled}, compiler, new MappedEntries(), kind === 'budget' ? replay.length : undefined);
  trace.begin();
  const compile = (pc = address) => {
    const bound = space.find(BigInt(pc), generation);
    assert.ok(bound);
    return table.compile(bound, generation, BigInt(pc), () => { if (space.generation !== generation) throw new MappedCodeChanged(); });
  };
  return {compile, trace, calls, origin, close() { table.retain(() => false); space.close(); }};
}

test('actual prepared selection tells exact rejection and keeps the original fallback', () => {
  for (const [kind, decision, calls] of [
    ['no-piece', 'no-piece', ['fallback']], ['elsewhere', 'placement-mismatch', ['fallback']],
    ['entry', 'entry-mismatch', ['fallback']], ['budget', 'byte-budget', ['fallback']],
    ['unavailable', 'unavailable', ['prepared', 'fallback']], ['no-entry', 'artifact-entry-missing', ['prepared', 'fallback']],
  ] as const) {
    const {compile, trace, calls: observed, origin, close} = harness(kind);
    try {
      assert.equal(compile(), -1n);
      if (kind === 'entry') assert.equal(compile(address + 1), -1n, 'matching later PC is not first use');
      const rows = trace.finish()!;
      assert.deepEqual(rows.samples[0], {origin, relativePc: 0x1000, fileOffset: 2, decision});
      assert.deepEqual(rows.samples.slice(1), kind === 'entry' ?
        [{origin, relativePc: 0x1001, fileOffset: 3, decision: 'binding-started'}] : []);
      assert.deepEqual(observed, kind === 'entry' ? [...calls, 'fallback'] : calls);
    } finally { close(); }
  }
});

test('a used artifact is not a miss; errors cannot become fallback, even with tracing', () => {
  for (const [kind, failure, decision] of [
    ['used', null, 'used'], ['corrupt', /length changed/, 'prepared-error'], ['revoked', MappedCodeChanged, 'prepared-error'],
  ] as const) for (const collected of [true, false]) {
    const {compile, trace, calls, close} = harness(kind, collected);
    try {
      if (failure) assert.throws(() => compile(), failure as RegExp);
      else assert.equal(compile(), 0n);
      assert.deepEqual(trace.finish()?.samples.map(s => s.decision), collected ? [decision] : []);
      assert.deepEqual(calls, failure ? ['prepared', 'close'] : ['prepared']);
    } finally { close(); }
  }
});
