/** Explicit rootless static-program profile, not the legacy CLI's Linux environment. */
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {memoryHost} from '../../linux/memory-host.ts';

export async function runManagedProgram(program: string, args: readonly string[], coreWasm: string, translatorWasm: string): Promise<number> {
  const encode = (text: string) => new TextEncoder().encode(text);
  // Capture once: no pathname-backed reload or mutable-root snapshot claim.
  const payload = readFileSync(program);
  const core = new WebAssembly.Module(readFileSync(coreWasm));
  const translator = new WebAssembly.Module(readFileSync(translatorWasm));
  const host = memoryHost(core, 1, 1);
  // Four inodes (/, /bin, /root, program), three entries and three standards.
  // One runner/action at a time; Fs root/cwd + program + cwd replacement hold.
  // These are logical limits, not exact allocator or Wasm memory ceilings.
  const root = host.preparePreparedFiles({inodes: 4, entries: 3, fileBytes: payload.byteLength,
    tables: 1, descriptions: 3, slots: 3, reads: 1, contexts: 1, views: 1, holds: 4,
    policy: {noExec: false, noSuid: false, noSymfollow: false}});
  const bin = host.directory(root, encode('bin'), 0o755);
  host.directory(root, encode('root'), 0o755);
  const name = basename(program), path = '/bin/' + name;
  host.file(bin, encode(name), payload, 0o755);
  host.sealFiles(3);
  const execution = await host.pathExecution(encode(path), [path, ...args].map(encode),
    ['HOME=/root', 'PATH=/bin:/usr/bin', 'LANG=C.UTF-8', 'TERM=dumb'].map(encode),
    {translator, random: randomBytes(16), cwd: encode('/root'), stdio: true});
  let status: number | undefined;
  const failures: unknown[] = [];
  try { status = (await host.runPath(execution)).status; }
  catch (error) { failures.push(error); }
  try { host.stopWorker(execution); }
  catch (error) { failures.push(error); }
  // This only settles host requests, not physical Worker termination. A bounded
  // failure leaves Unknown ownership in the host; it never authorizes recycling.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([host.workerSettled(execution), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Managed host requests remain unsettled')), 1000);
    })]);
  } catch (error) { failures.push(error); }
  finally { if (timer !== undefined) clearTimeout(timer); }
  const evidence = host.workerEvidence(execution);
  if (!evidence.exited || evidence.pendingRequest || !evidence.resourcesRetired) {
    failures.push(new Error('Managed execution retirement remains unconfirmed'));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Managed program failed or cleanup remains unconfirmed');
  if (status === undefined) throw new Error('Managed program has no exit status');
  return status;
}
