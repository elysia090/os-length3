import {Worker} from 'node:worker_threads';
import {SLOT_BYTES, IDLE, REQUEST, RETURN, LEAVE, MAX_SEQUENCE, type GuestRequest, type GuestReply, type GuestOutcome} from './protocol.ts';
export type {GuestRequest, GuestReply, GuestOutcome} from './protocol.ts';

/** Internal only. The caller admits a prepared module (no start/active data),
 * fresh fixed shared Memory and its initialization before construction. Neither
 * the Worker nor channel nor Memory is returned to the application. */
export function createGuest(input: {module: WebAssembly.Module; memory: WebAssembly.Memory; stackPointer?: bigint}) {
  const channel = new SharedArrayBuffer(SLOT_BYTES);
  const control = new Int32Array(channel, 0, 2), words = new BigUint64Array(channel, 8, 10);
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  let stoppedResolve!: (evidence: {code: number}) => void;
  const stopped = new Promise<{code: number}>(resolve => { stoppedResolve = resolve; });
  let requestFinished = false, finishRequest!: () => void;
  const requestSettled = new Promise<void>(resolve => { finishRequest = () => { requestFinished = true; resolve(); }; });
  let evidenceWait: Promise<void> | undefined;
  let exited = false, stopping = false, initialized = false, lastInvocation = 0n, sequence = 0;
  let failureCount = 0, firstFailure: unknown;
  const fail = (error: unknown) => { if (!failureCount++) firstFailure = error; };
  let active: {invocation: bigint; request: (request: GuestRequest) => GuestReply | Promise<GuestReply>; resolve: (outcome: GuestOutcome) => void} | undefined;
  let pending: Promise<void> | undefined;
  let worker: Worker | undefined;
  const failOperations = (error: unknown) => {
    readyReject(error);
    active?.resolve({kind: 'failed', unwound: false, error}); active = undefined;
  };
  const requestStop = () => {
    if (stopping || exited) return;
    stopping = true;
    try {
      if (worker) void worker.terminate().then(() => finishRequest(), error => { fail(error); failOperations(error); finishRequest(); });
      else finishRequest();
    } catch (error) { fail(error); failOperations(error); finishRequest(); }
    // terminate resolution alone is deliberately not used as exit evidence.
  };
  try {
    worker = new Worker(new URL('./guest.ts', import.meta.url), {workerData: {...input, channel}});
    worker.on('exit', code => {
      exited = true;
      const error = new Error(`Guest Worker exited (${code})`);
      if (!stopping) fail(error);
      failOperations(error);
      stoppedResolve({code});
    });
    worker.on('error', error => { fail(error); failOperations(error); requestStop(); });
    worker.on('message', message => {
      try {
        if (exited) return;
        if (message.kind === 'ready') {
          if (initialized || stopping) throw new Error('Unexpected guest ready');
          initialized = true; readyResolve(); return;
        }
        if (message.kind === 'unwound') {
          if (!active || message.invocation !== active.invocation || Atomics.load(control, 0) !== IDLE) throw new Error('Unwind identity mismatch');
          const a = active;
          if (message.outcome?.unwound !== true || !['left', 'returned', 'failed'].includes(message.outcome?.kind)) throw new Error('Invalid unwind outcome');
          active = undefined; a.resolve(message.outcome); return;
        }
        if (message.kind !== 'request' || !active || pending || stopping ||
            message.invocation !== active.invocation || message.sequence !== sequence + 1 ||
            message.sequence > MAX_SEQUENCE || Atomics.load(control, 0) !== REQUEST ||
            Atomics.load(control, 1) !== message.sequence || words[0] !== active.invocation) throw new Error('Request identity mismatch');
        sequence = message.sequence;
        const a = active, seq = sequence;
        const request: GuestRequest = {invocation: a.invocation, sequence: seq, nr: words[1], args: [words[2], words[3], words[4], words[5], words[6], words[7]], next: words[8]};
        // Keep the callback promise observed even after Worker exit. Its late
        // failure is diagnostic; a late result is never published to the slot.
        pending = Promise.resolve().then(() => a.request(request)).then(reply => {
          if (exited || stopping || active !== a) return;
          if (Atomics.load(control, 0) !== REQUEST || Atomics.load(control, 1) !== seq || words[0] !== a.invocation) throw new Error('Reply identity mismatch');
          if (reply.kind === 'return') words[9] = BigInt.asUintN(64, reply.value);
          else if (reply.kind !== 'leave') throw new Error('Invalid guest reply');
          Atomics.store(control, 0, reply.kind === 'return' ? RETURN : LEAVE);
          Atomics.notify(control, 0);
        }).catch(error => { fail(error); failOperations(error); requestStop(); }).finally(() => { pending = undefined; });
      } catch (error) { fail(error); failOperations(error); requestStop(); }
    });
  } catch (error) {
    fail(error); failOperations(error); requestStop();
    // No Worker handle was returned. This is not an observed exit event.
  }
  return {
    ready, stopped, requestStop,
    async stopEvidence(): Promise<{stopped: boolean; failureCount: number; firstFailure: unknown}> {
      if (!stopping && !exited) throw new Error('Stop has not been requested');
      if (!exited && !requestFinished) {
        evidenceWait ??= Promise.race([stopped.then(() => {}), requestSettled]);
        await evidenceWait;
      }
      return {stopped: exited, failureCount, firstFailure};
    },
    diagnostics: () => ({failureCount, firstFailure, pendingRequest: pending !== undefined, exited, stopping, created: worker !== undefined}),
    requestsSettled: (): Promise<void> => pending ?? Promise.resolve(),
    run(invocation: bigint, entry: bigint, request: (request: GuestRequest) => GuestReply | Promise<GuestReply>): Promise<GuestOutcome> {
      if (!initialized || exited || stopping || active || pending || lastInvocation !== 0n || invocation <= 0n || invocation > 0xffffffffffffffffn) return Promise.reject(new Error('Guest run unavailable'));
      lastInvocation = invocation;
      return new Promise(resolve => {
        active = {invocation, request, resolve};
        try { worker!.postMessage({kind: 'run', invocation, entry}); }
        catch (error) { fail(error); failOperations(error); requestStop(); }
      });
    },
  };
}
