// Test-only child owning real borrowed standard descriptors, never a public API.
import {readFileSync} from 'node:fs';
import {memoryHost} from '../../../runtime/linux/memory-host.ts';
const [core, translator, program] = process.argv.slice(2);
const bytes = (s: string) => new TextEncoder().encode(s);
const host = memoryHost(new WebAssembly.Module(readFileSync(core)), 2, 16);
const root = host.preparePreparedFiles({inodes: 4, entries: 4, fileBytes: 262144,
  tables: 1, descriptions: 3, slots: 3, reads: 2, contexts: 1, views: 1, holds: 4,
  policy: {noExec: false, noSuid: false, noSymfollow: false}});
const bin = host.directory(root, bytes('bin'), 0o755);
host.file(bin, bytes('io'), new Uint8Array(readFileSync(program)), 0o755);
host.sealFiles(3);
const execution = await host.pathExecution(bytes('/bin/io'), [bytes('io')], [], {
  translator: new WebAssembly.Module(readFileSync(translator)),
  random: new Uint8Array(16), stdio: true,
});
try {
  const result = await host.runPath(execution);
  if (!host.workerEvidence(execution).resourcesRetired) throw new Error('Stream owner not retired');
  process.exitCode = result.status;
} finally { host.stopWorker(execution); await host.workerSettled(execution); }
