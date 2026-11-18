// Physical transport fault injection in an isolated child, using the real Node
// guest Worker and matching Rust core. No production failure hook is exported.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {memoryHost} from '../../../runtime/linux/memory-host.ts';

const [corePath, translatorPath, programPath, number] = process.argv.slice(2);
const syscall = BigInt(number ?? '257');
assert.ok(syscall === 2n || syscall === 257n);
const host = memoryHost(new WebAssembly.Module(readFileSync(corePath!)), 4, 16);
const translator = new WebAssembly.Module(readFileSync(translatorPath!));
const elf = readFileSync(programPath!);
const bytes = (value: string) => new TextEncoder().encode(value);
const root = host.preparePreparedFiles({inodes: 4, entries: 3, fileBytes: elf.length,
  tables: 1, descriptions: 6, slots: 6, reads: 1, contexts: 2, views: 1, holds: 16,
  policy: {noExec: false, noSuid: false, noSymfollow: false}});
const bin = host.directory(root, bytes('bin'));
host.directory(root, bytes('root'));
host.file(bin, bytes('program.elf'), elf, 0o755); host.sealFiles(6);
const original = Object.getOwnPropertyDescriptor(Atomics, 'store')!;
const store = Atomics.store;
let lost = 0;
for (let run = 0; run < 2; run++) {
  const execution = await host.pathExecution(bytes('/bin/program.elf'), [bytes('/bin/program.elf')], [], {
    translator, random: new Uint8Array(16).fill(7), cwd: bytes('/root'), stdio: true,
  });
  Object.defineProperty(Atomics, 'store', {...original, value(array: unknown, index: unknown, value: unknown) {
    if (array instanceof Int32Array && array.byteLength === 8 && index === 0 && value === 2) {
      const words = new BigUint64Array(array.buffer, 8, 10);
      assert.equal(words[1], syscall, 'only the first guest open reply may reach this point');
      assert.equal(words[9], 3n, 'Rust already published the lowest free file descriptor');
      lost++;
      throw new Error('lost-open-reply'); // before RETURN publication; guest remains paused
    }
    return Reflect.apply(store, Atomics, [array, index, value]);
  }});
  try { await assert.rejects(host.runPath(execution), /lost-open-reply/); }
  finally { Object.defineProperty(Atomics, 'store', original); }
  host.stopWorker(execution);
  await host.workerSettled(execution);
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const observed = host.workerEvidence(execution);
    if (observed.exited && observed.resourcesRetired) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const observed = host.workerEvidence(execution);
  assert.equal(observed.exited, true); assert.equal(observed.resourcesRetired, true);
  assert.equal(observed.pendingRequest, false);
  assert.equal(lost, run + 1, 'the original syscall was not re-entered/replayed');
  // The next actual execution needs the same sole table/context capacity. It
  // could not start if the committed FD/table/lookup owners had been lost.
}
console.log('retired 2 lost-open-replies');
