// Isolated physical publication-loss injection. No production failure hook.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {memoryHost} from '../../../runtime/linux/memory-host.ts';
const [corePath, translatorPath, programPath, mode] = process.argv.slice(2);
assert.ok(mode === 'ack' || mode === 'return');
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
const execution = await start();
const descriptor = Object.getOwnPropertyDescriptor(Atomics, 'store')!, original = Atomics.store;
let losses = 0;
Object.defineProperty(Atomics, 'store', {...descriptor, value(array: unknown, index: unknown, value: unknown) {
  if (array instanceof Int32Array && array.byteLength === 8 && index === 0 &&
      ((mode === 'ack' && value === 1 && Atomics.load(array, 0) === 6) || (mode === 'return' && value === 2))) {
    const words = new BigUint64Array(array.buffer, 8, 13);
    assert.equal(words[1], 158n); assert.equal(words[12], 0n, 'the actual Worker setter has finished');
    if (mode === 'return') assert.equal(words[9], 0n, 'Rust has already accepted applied-and-stopped evidence');
    losses++; throw new Error(`lost-fs-${mode}`);
  }
  return Reflect.apply(original, Atomics, [array, index, value]);
}});
try { await assert.rejects(host.runPath(execution), mode === 'ack' ? /lost-fs-ack/ : /lost-fs-return/); }
finally { Object.defineProperty(Atomics, 'store', descriptor); }
host.stopWorker(execution); await host.workerSettled(execution);
const until = Date.now() + 5000;
while (Date.now() < until) {
  const evidence = host.workerEvidence(execution);
  if (evidence.exited && !evidence.pendingRequest && (mode === 'ack' || evidence.resourcesRetired)) break;
  await new Promise(resolve => setTimeout(resolve, 5));
}
const evidence = host.workerEvidence(execution);
assert.equal(losses, 1, 'no physical register replay');
assert.equal(evidence.exited, true); assert.equal(evidence.pendingRequest, false);
assert.equal(evidence.resourcesRetired, mode === 'return', 'Unknown retains Rust resources even after the private register is destroyed');
if (mode === 'ack') {
  await assert.rejects(start(), /Linux startup admission failed/); // sole table stays quarantined
} else {
  const next = await start(); // known applied receipt freed only its original owner
  host.stopWorker(next); await host.workerSettled(next);
  const until = Date.now() + 5000;
  while (Date.now() < until && !host.workerEvidence(next).resourcesRetired) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(host.workerEvidence(next).exited, true); assert.equal(host.workerEvidence(next).resourcesRetired, true);
}
console.log(`stopped lost-fs-${mode}, retired=${evidence.resourcesRetired}`);
