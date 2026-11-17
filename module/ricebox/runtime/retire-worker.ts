/** Browser caller boundary. Admission acknowledgement is not termination proof.
 * This preserves abort-style terminal close: it does not drain output or writes. */
export interface RootWorkerControl {
  postMessage(message: {type: 'retire'}): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
export interface RootRetirement {
  admission: 'acknowledged' | 'unconfirmed';
  reason: 'acknowledgement' | 'timeout' | 'request-failure';
  hostStopped: 'unconfirmed';
  failures: {phase: 'listen' | 'request' | 'retire' | 'unlisten' | 'terminate'; error: unknown}[];
}
const retirements = new WeakMap<RootWorkerControl, Promise<RootRetirement>>();
/** Detach the product's ordinary message handler first. A timed grace period (subject to event-loop scheduling)
 * lets the Worker freeze admission, but neither expiry nor terminate() returning
 * authorizes memory reuse or file-scope disposal. Duplicate calls share one try. */
export function retireRootWorker(worker: RootWorkerControl, timeoutMs = 250): Promise<RootRetirement> {
  const previous = retirements.get(worker);
  if (previous) return previous;
  let resolve!: (result: RootRetirement) => void;
  const result = new Promise<RootRetirement>(done => { resolve = done; });
  retirements.set(worker, result); // Before any callback can reenter.
  const failures: RootRetirement['failures'] = [];
  let acknowledged = false, posting = true, finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (reason: RootRetirement['reason']): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { worker.removeEventListener('message', hear); } catch (error) { failures.push({phase: 'unlisten', error}); }
    try { worker.terminate(); } catch (error) { failures.push({phase: 'terminate', error}); }
    resolve({admission: acknowledged ? 'acknowledged' : 'unconfirmed', reason, hostStopped: 'unconfirmed', failures});
  };
  const hear = ({data}: MessageEvent): void => {
    if (data?.type !== 'retiring' || finished || acknowledged) return;
    acknowledged = true;
    if (Array.isArray(data.failures)) for (const message of data.failures) {
      if (typeof message === 'string') failures.push({phase: 'retire', error: new Error(message)});
    }
    if (!posting) finish('acknowledgement');
  };
  try { worker.addEventListener('message', hear); }
  catch (error) { failures.push({phase: 'listen', error}); posting = false; finish('request-failure'); return result; }
  timer = setTimeout(() => finish('timeout'), Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 250);
  try { worker.postMessage({type: 'retire'}); }
  catch (error) { failures.push({phase: 'request', error}); posting = false; finish('request-failure'); return result; }
  posting = false;
  if (acknowledged) finish('acknowledgement');
  return result;
}
