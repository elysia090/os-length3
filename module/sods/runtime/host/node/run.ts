/** Explicit rootless static-program profile, not the legacy CLI's Linux environment. */
import {createHash, randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {ownedInput} from '../../linux/admission-wire.ts';
import {createOwnedStdoutHost, memoryHost, type ExecutionBinding} from '../../linux/memory-host.ts';
import {acquireOwnedStdout} from './stdio.ts';

type Host = ReturnType<typeof createOwnedStdoutHost>;
const encode = (text: string) => new TextEncoder().encode(text);

function preparedProgram(host: Host, program: string, args: readonly string[], payload: Uint8Array,
  translator: WebAssembly.Module, stdio?: true): Promise<ExecutionBinding> {
  // Four inodes (/, /bin, /root, program), three namespace entries.
  // Explicit finite read-only FD profile. A path capture owns copied root/cwd
  // and a pinned dirfd; every independent file OFD also owns one mount position.
  // These are logical limits, not exact allocator or Wasm memory ceilings.
  const root = host.preparePreparedFiles({inodes: 4, entries: 3, fileBytes: payload.byteLength,
    tables: 1, descriptions: 64, slots: 64, reads: 1, contexts: 2, views: 1, holds: 71,
    policy: {noExec: false, noSuid: false, noSymfollow: false}});
  const bin = host.directory(root, encode('bin'), 0o755);
  host.directory(root, encode('root'), 0o755);
  const name = basename(program), path = '/bin/' + name;
  host.file(bin, encode(name), payload, 0o755);
  host.sealFiles(64);
  return host.pathExecution(encode(path), [path, ...args].map(encode),
    ['HOME=/root', 'PATH=/bin:/usr/bin', 'LANG=C.UTF-8', 'TERM=dumb'].map(encode),
    {translator, random: randomBytes(16), cwd: encode('/root'), stdio});
}

async function runAndObserve(host: Host, execution: ExecutionBinding, requireExit = false) {
  let status: number | undefined;
  const failures: unknown[] = [];
  try { status = (await host.runPath(execution)).status; }
  catch (error) { failures.push(error); }
  try { host.stopWorker(execution); }
  catch (error) { failures.push(error); }
  // A settled host request is not Worker termination. The new owned profile
  // waits for both; a timeout itself never authorizes recycling.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = host.workerSettled(execution);
    await Promise.race([requireExit ? Promise.all([settled, host.workerStopped(execution)]) : settled,
      new Promise<never>((_, reject) => {
        const message = requireExit ? 'Managed host requests or Worker stop remain unconfirmed' : 'Managed host requests remain unsettled';
        timer = setTimeout(() => reject(new Error(message)), 1000);
      })]);
  } catch (error) { failures.push(error); }
  finally { if (timer !== undefined) clearTimeout(timer); }
  const evidence = host.workerEvidence(execution);
  const retired = evidence.exited && !evidence.pendingRequest && evidence.resourcesRetired;
  if (!retired) failures.push(new Error('Managed execution retirement remains unconfirmed'));
  return {status, failures, retired};
}

function exitStatus({status, failures}: Pick<Awaited<ReturnType<typeof runAndObserve>>, 'status' | 'failures'>): number {
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Managed program failed or cleanup remains unconfirmed');
  if (status === undefined) throw new Error('Managed program has no exit status');
  return status;
}

export async function runManagedProgram(program: string, args: readonly string[], coreWasm: string, translatorWasm: string): Promise<number> {
  // Capture once: no pathname-backed reload or mutable-root snapshot claim.
  const payload = readFileSync(program);
  const core = new WebAssembly.Module(readFileSync(coreWasm));
  const translator = new WebAssembly.Module(readFileSync(translatorWasm));
  const host = memoryHost(core, 1, 1);
  const execution = await preparedProgram(host, program, args, payload, translator, true);
  return exitStatus(await runAndObserve(host, execution));
}

export interface OwnedStdoutPin {
  readonly kind: 'sods-linux-owned-stdout-v1';
  readonly byteLength: number;
  readonly sha256: string;
}
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
function pinnedOwnedModule(input: Uint8Array, pin: OwnedStdoutPin): WebAssembly.Module {
  const {kind, byteLength, sha256} = pin;
  if (kind !== 'sods-linux-owned-stdout-v1' || !Number.isSafeInteger(byteLength) || byteLength < 8 ||
      byteLength > 32 * 1024 * 1024 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid trusted owned stdout pin');
  }
  if (Reflect.apply(typedLength, input, []) !== byteLength) throw new Error('Owned stdout artifact length mismatch');
  const bytes = ownedInput(input);
  if (bytes.byteLength !== byteLength || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('Owned stdout artifact digest mismatch');
  }
  return new WebAssembly.Module(bytes);
}

// A deliberately single native owner in this candidate. If use is unknown,
// keep the actual File AND Core ledger reachable; do not close, retry, create
// a second owner or fall back to inherited output.
type OwnedRun = {output?: ReturnType<typeof acquireOwnedStdout>; host?: Host; execution?: ExecutionBinding};
let ownedRun: OwnedRun | undefined;

/** Explicit internal Node candidate. No default CLI flag and no inherited
 * stdin/stderr. A trusted embedding selects the pin independently of bytes. */
export async function runOwnedStdoutProgram(program: string, args: readonly string[], translator: WebAssembly.Module,
  path: string, candidate: Uint8Array, pin: OwnedStdoutPin): Promise<number> {
  if (ownedRun) throw new Error('Owned stdout is already running or remains unconfirmed');
  const module = pinnedOwnedModule(candidate, pin);
  const payload = readFileSync(program);
  const owner: OwnedRun = {};
  let canClose = true, status: number | undefined;
  const failures: unknown[] = [];
  try {
    const host = createOwnedStdoutHost(module, () => {
      // Recheck at the allocation edge, even if reading the trusted pin
      // (or another preflight input) was reentrant.
      if (ownedRun) throw new Error('Owned stdout is already running or remains unconfirmed');
      owner.output = acquireOwnedStdout(path);
      ownedRun = owner;
      return owner.output.io;
    });
    owner.host = host;
    const execution = owner.execution = await preparedProgram(host, program, args, payload, translator);
    // Before runPath no syscall could take its own physical File view.
    canClose = false;
    const observation = await runAndObserve(host, execution, true);
    canClose = observation.retired;
    status = exitStatus(observation);
  } catch (error) { failures.push(error); }
  finally {
    if (owner.output && canClose) {
      try { owner.output.close(); ownedRun = undefined; }
      catch (error) { failures.push(error); }
    }
  }
  return exitStatus({status, failures});
}
