// Isolated regression: changing constructor/species AFTER memory-host import
// must not invoke a callback or expose the guest backing during path capture.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {memoryHost} from '../../../runtime/linux/memory-host.ts';

const [corePath, translatorPath, programPath] = process.argv.slice(2);
const core = new WebAssembly.Module(readFileSync(corePath!));
const translator = new WebAssembly.Module(readFileSync(translatorPath!));
const elf = readFileSync(programPath!);
const bytes = (s: string) => new TextEncoder().encode(s);
for (const kind of ['species', 'constructor']) {
  const host = memoryHost(core, 1, 16);
  const root = host.preparePreparedFiles({inodes: 4, entries: 3, fileBytes: elf.length,
    tables: 1, descriptions: 64, slots: 64, reads: 1, contexts: 2, views: 1, holds: 71,
    policy: {noExec: false, noSuid: false, noSymfollow: false}});
  const bin = host.directory(root, bytes('bin')); host.directory(root, bytes('root'));
  host.file(bin, bytes('program.elf'), elf, 0o755); host.sealFiles(64);
  const execution = await host.pathExecution(bytes('/bin/program.elf'), [bytes('/bin/program.elf')], [], {
    translator, random: new Uint8Array(16).fill(7), cwd: bytes('/root'), stdio: true,
  });
  const species = Object.getOwnPropertyDescriptor(Uint8Array, Symbol.species);
  const constructor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'constructor')!;
  const atomics = Object.getOwnPropertyDescriptor(Atomics, 'store')!, store = Atomics.store;
  let callbacks = 0, reply = false, escaped: ArrayBufferLike | undefined;
  class Observer extends Uint8Array {
    constructor(buffer: ArrayBufferLike, offset: number, length: number) {
      super(buffer, offset, length); escaped = buffer;
    }
  }
  const restore = () => {
    if (species) Object.defineProperty(Uint8Array, Symbol.species, species);
    else Reflect.deleteProperty(Uint8Array, Symbol.species);
    Object.defineProperty(Uint8Array.prototype, 'constructor', constructor);
    Object.defineProperty(Atomics, 'store', atomics);
  };
  if (kind === 'species') Object.defineProperty(Uint8Array, Symbol.species, {configurable: true, get() { callbacks++; return Observer; }});
  else Object.defineProperty(Uint8Array.prototype, 'constructor', {configurable: true, get() { callbacks++; return {[Symbol.species]: Observer}; }});
  Object.defineProperty(Atomics, 'store', {...atomics, value(array: unknown, index: unknown, value: unknown) {
    if (array instanceof Int32Array && array.byteLength === 8 && index === 0 && value === 2) {
      const words = new BigUint64Array(array.buffer, 8, 10);
      assert.equal(words[1], 257n); assert.equal(words[9], 3n);
      reply = true; restore(); // capture is finished; exclude unrelated later Node operations
    }
    return Reflect.apply(store, Atomics, [array, index, value]);
  }});
  try { assert.deepEqual(await host.runPath(execution), {status: 0, sourceFailures: 0}); }
  finally { restore(); host.stopWorker(execution); await host.workerSettled(execution); }
  assert.equal(reply, true); assert.equal(callbacks, 0, `${kind}: no user callback in the capture interval`);
  assert.equal(escaped, undefined, `${kind}: no private guest backing escape`);
  const evidence = host.workerEvidence(execution);
  assert.equal(evidence.exited, true); assert.equal(evidence.resourcesRetired, true);
}
console.log('species-safe 2 captures');
