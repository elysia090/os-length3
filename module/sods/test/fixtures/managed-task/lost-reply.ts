// Real Worker reply publication loss. No production failure hook or success
// inferred from the logical registration/exit request.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {memoryHost} from '../../../runtime/linux/memory-host.ts';
const [corePath, translatorPath, programPath, mode] = process.argv.slice(2);
assert.ok(mode === 'tid' || mode === 'leave');
const host = memoryHost(new WebAssembly.Module(readFileSync(corePath!)), 3, 4);
const translator = new WebAssembly.Module(readFileSync(translatorPath!));
const elf = readFileSync(programPath!), encode = (s: string) => new TextEncoder().encode(s);
const root = host.preparePreparedFiles({inodes: 3, entries: 2, fileBytes: elf.length,
  tables: 1, descriptions: 8, slots: 8, reads: 1, contexts: 2, views: 1, holds: 16,
  policy: {noExec: false, noSuid: false, noSymfollow: false}});
const bin = host.directory(root, encode('bin'));
host.file(bin, encode('program'), elf, 0o755); host.sealFiles(8);
const start = () => host.pathExecution(encode('/bin/program'), [encode('/bin/program')], [], {
  translator, random: new Uint8Array(16).fill(7), cwd: encode('/'), stdio: true,
});
const descriptor = Object.getOwnPropertyDescriptor(Atomics, 'store')!, original = Atomics.store;
let losses = 0;
for (let run = 0; run < 2; run++) {
  const execution = await start();
  Object.defineProperty(Atomics, 'store', {...descriptor, value(array: unknown, index: unknown, value: unknown) {
    if (array instanceof Int32Array && array.byteLength === 8 && index === 0 && value === (mode === 'tid' ? 2 : 3)) {
      const words = new BigUint64Array(array.buffer, 8, 13);
      assert.equal(words[1], mode === 'tid' ? 218n : 231n);
      if (mode === 'tid') assert.equal(words[9], 1n, 'Rust captured registration and decided this execution-local guest TID');
      losses++; throw new Error(`lost-task-${mode}`);
    }
    return Reflect.apply(original, Atomics, [array, index, value]);
  }});
  try { await assert.rejects(host.runPath(execution), new RegExp(`lost-task-${mode}`)); }
  finally { Object.defineProperty(Atomics, 'store', descriptor); }
  host.stopWorker(execution); await host.workerSettled(execution);
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const e = host.workerEvidence(execution);
    if (e.exited && e.resourcesRetired && !e.pendingRequest) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const e = host.workerEvidence(execution);
  assert.equal(e.exited, true); assert.equal(e.resourcesRetired, true); assert.equal(e.pendingRequest, false);
  assert.equal(losses, run + 1, 'neither registration nor exit publication is replayed');
}
// Both failed runs returned the sole table/context. A fresh task really runs,
// including all registrations and exit_group, rather than merely preparing it.
const control = await start();
assert.deepEqual(await host.runPath(control), {status: 23, sourceFailures: 0});
const e = host.workerEvidence(control);
assert.equal(e.exited, true); assert.equal(e.resourcesRetired, true); assert.equal(e.pendingRequest, false);
console.log(`retired 2 lost-task-${mode}; fresh task exited23`);
