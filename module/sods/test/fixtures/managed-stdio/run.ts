// Test-only child owning real borrowed standard descriptors, never a public API.
import {readFileSync} from 'node:fs';
import {memoryHost} from '../../../runtime/linux/memory-host.ts';
const [core, translator, program, selection] = process.argv.slice(2);
const bytes = (s: string) => new TextEncoder().encode(s);
const host = memoryHost(new WebAssembly.Module(readFileSync(core)), 2, 16);
const root = host.preparePreparedFiles({inodes: 8, entries: 8, fileBytes: 262144,
  tables: 1, descriptions: 3, slots: 3, reads: 2, contexts: 1, views: 1, holds: 4,
  policy: {noExec: false, noSuid: false, noSymfollow: false}});
const bin = host.directory(root, bytes('bin'), 0o755);
host.file(bin, bytes('io'), new Uint8Array(readFileSync(program)), 0o755);
const relative = selection === 'relative';
if (relative) {
  host.symlink(root, bytes('cwd'), bytes('bin'));
  host.symlink(bin, bytes('alias'), bytes('io'));
}
host.sealFiles(3);
const cwd = relative ? bytes('/cwd') : undefined;
const pending = host.pathExecution(bytes(relative ? 'alias' : '/bin/io'), [bytes('io')], [], {
  translator: new WebAssembly.Module(readFileSync(translator)),
  random: new Uint8Array(16), stdio: true,
  ...(cwd ? {cwd} : {}),
});
// The host must capture cwd before its first asynchronous import/source work.
cwd?.fill(0);
const execution = await pending;
try {
  const result = await host.runPath(execution);
  if (!host.workerEvidence(execution).resourcesRetired) throw new Error('Stream owner not retired');
  process.exitCode = result.status;
} finally { host.stopWorker(execution); await host.workerSettled(execution); }
