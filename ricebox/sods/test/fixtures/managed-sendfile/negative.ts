// Isolated actual core/translator/Worker test. The private tree builder is only
// fixture setup; all startup/syscall/retirement decisions use the normal host.
// No accepted physical capability, probe-feature core or successful cat claim.
import assert from 'node:assert/strict';
import {createHook} from 'node:async_hooks';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import type {ExecutionBinding} from '../../../runtime/linux/memory-host.ts';

const [corePath, translatorPath, programPath, controlPath, mode] = process.argv.slice(2);
assert.ok(corePath && translatorPath && programPath && controlPath);
assert.ok(mode === 'lazy-six' || mode === 'lazy-zero' || mode === 'resident-eof');
const encode = (value: string) => new TextEncoder().encode(value);
const nativeRead = fs.readSync, nativeWrite = fs.writeSync;
let observing = false, reads = 0, writes = 0, written = 0;
// Install before the first stdio module evaluation. Observe only fd0/1/2 during
// runPath -> actual stopped/retired windows; always forward to the captured
// native API. This supplies no qualifier, completion or production test hook.
fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
  if (observing && args[0] === 0) reads++;
  return Reflect.apply(nativeRead, fs, args);
}) as typeof fs.readSync;
fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
  if (observing && (args[0] === 1 || args[0] === 2)) writes++;
  const count = Reflect.apply(nativeWrite, fs, args);
  if (observing && (args[0] === 1 || args[0] === 2)) written += count;
  return count;
}) as typeof fs.writeSync;
syncBuiltinESMExports();
const stdio = await import('../../../runtime/host/node/stdio.ts');
assert.equal(typeof stdio.captureStdio, 'function');
const {memoryHost} = await import('../../../runtime/linux/memory-host.ts');
const coreBytes = new Uint8Array(fs.readFileSync(corePath)), module = new WebAssembly.Module(coreBytes);
const names = WebAssembly.Module.exports(module).map(value => value.name);
assert.equal(names.includes('linux_sendfile_probe'), false);
assert.equal(names.includes('linux_sendfile_probe_access_ended'), false);
const host = memoryHost(module, 2, 16); // ABI7 is checked by the real host.
const translator = new WebAssembly.Module(fs.readFileSync(translatorPath));
const program = new Uint8Array(fs.readFileSync(programPath)), control = new Uint8Array(fs.readFileSync(controlPath));
const payload = encode('abcdef');
const root = host.preparePreparedFiles({inodes: 5, entries: 4, fileBytes: Math.max(program.length, control.length),
  tables: 1, descriptions: 4, slots: 4, reads: 1, contexts: 2, views: 1, holds: 16,
  policy: {noExec: false, noSuid: false, noSymfollow: false}});
const bin = host.directory(root, encode('bin'));
host.file(bin, encode('negative'), program, 0o755);
host.file(bin, encode('control'), control, 0o755);
if (mode === 'resident-eof') host.file(root, encode('input'), new Uint8Array(0), 0o444);
else host.lazyFile(root, encode('input'), 7, payload.length, 0o444);
host.sealFiles(4);
let sourceLoads = 0, sourceBytes = 0, workers = 0;
const load = (id: number): Uint8Array => {
  sourceLoads++; assert.equal(id, 7); sourceBytes += payload.length;
  return payload;
};
const start = (path: string) => host.pathExecution(encode(path), [encode(path)], [], {
  translator, load, random: new Uint8Array(16).fill(7), cwd: encode('/'), stdio: true,
});
async function stopped(execution: ExecutionBinding) {
  host.stopWorker(execution);
  await host.workerSettled(execution);
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const value = host.workerEvidence(execution);
    if (value.exited && value.resourcesRetired && !value.pendingRequest) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const value = host.workerEvidence(execution);
  assert.equal(value.created, true);
  assert.equal(value.exited, true, 'stop request/job settlement is not actual Worker exit');
  assert.equal(value.resourcesRetired, true, 'the sole table and held source/context must be returned');
  assert.equal(value.pendingRequest, false);
  return {created: value.created, exited: value.exited, resourcesRetired: value.resourcesRetired, pendingRequest: value.pendingRequest};
}
const hook = createHook({init(_id, type) {if (type === 'WORKER') workers++;}});
hook.enable();
try {
  const execution = await start('/bin/negative');
  assert.equal(sourceLoads, 0, 'resident startup must not demand any canonical source');
  assert.equal(workers, 1, 'negative must run an actual Worker');
  let errorMessage = '', negative;
  observing = true;
  try {
    await assert.rejects(host.runPath(execution, load), error => {
      assert.ok(error instanceof Error);
      errorMessage = error.message;
      assert.equal(errorMessage, 'Unsupported Rust Worker command: 3 (value 40, syscall 40)');
      return true;
    });
  } finally {negative = await stopped(execution);observing = false;}
  assert.equal(sourceLoads, 0, 'cap rejection must precede even a source loader call');
  assert.equal(sourceBytes, 0);
  assert.deepEqual({reads, writes, written}, {reads: 0, writes: 0, written: 0});
  const rejected = {error: errorMessage, ...negative};
  const next = await start('/bin/control');
  assert.equal(workers, 2, 'fresh same-host control must create its own actual Worker');
  assert.equal(sourceLoads, 0);
  let outcome, retired;
  observing = true;
  try {outcome = await host.runPath(next, load);}
  finally {retired = await stopped(next);observing = false;}
  assert.deepEqual(outcome, {status: 42, sourceFailures: 0});
  assert.equal(sourceLoads, 0);
  assert.deepEqual({reads, writes, written}, {reads: 0, writes: 0, written: 0});
  // Report on a separate owned channel, outside every observed run window.
  nativeWrite(3, JSON.stringify({mode, coreSha256: createHash('sha256').update(coreBytes).digest('hex'),
    programBytes: program.length, controlBytes: control.length, registeredInputBytes: mode === 'resident-eof' ? 0 : payload.length,
    sourceLoads, sourceBytes, reads, writes, written, workers, observerBeforeStdioImport: true,
    rejected, control: {...outcome, ...retired}}));
} finally {
  hook.disable(); observing = false;
  fs.readSync = nativeRead;fs.writeSync = nativeWrite;syncBuiltinESMExports();
}
