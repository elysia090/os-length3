// Private build scope for one archive producer. Await admission before reading
// the next member; results arrive out of order, and stay private until all
// work and Worker retirement complete. No retries or runtime guarantees.
import {isMarkedAsUntransferable, Worker} from 'node:worker_threads';
type Accept = (stored: Buffer, raw: boolean) => void;
type Job = {id:number; size:number; fallback?:Buffer; accept:Accept};
type Slot = {worker:Worker;job?:Job};
/** A disposable input may be detached; use only the returned stored body. */
type Compress = (bytes: Buffer, accept: Accept, disposable?: boolean) => Promise<void>;

export async function withCompression<T>(use:(compress:Compress)=>Promise<T>,
  start:()=>Worker=()=>new Worker(new URL('./compress.worker.ts',import.meta.url)), rawMost = 224 << 20):Promise<T> {
  if (!Number.isSafeInteger(rawMost) || rawMost < 1) throw new RangeError('invalid compression byte budget');
  const slots:Slot[]=[];
  const failures:unknown[]=[];
  let accepting=true, offering=false, ids=0, activeBytes=0, retirement:Promise<PromiseSettledResult<number>[]>|undefined;
  let wake: (() => void) | undefined;
  const changed = () => { const waiter = wake; wake = undefined; waiter?.(); };
  const wait = () => new Promise<void>(resolve => { wake = resolve; });
  const remember=(error:unknown)=>{if(!failures.includes(error))failures.push(error);};
  const stop=()=>{
    if(retirement)return retirement;
    accepting=false;
    for (const slot of slots) slot.job = undefined;
    changed();
    // allSettled attempts every retirement even if one throws or rejects.
    retirement=Promise.allSettled(slots.map(({worker})=>Promise.resolve().then(()=>worker.terminate())));
    return retirement;
  };
  const fail=(error:unknown)=>{remember(error);void stop();};
  const lost = (error: unknown) => { if (accepting) fail(error); };
  const unowned = () => fail(new Error('compression worker returned an unowned response'));
  const occupied = () => slots.some(slot => slot.job);
  const compress:Compress=async (bytes, accept, disposable)=>{
    if (offering) throw new Error('await compression admission before offering another member');
    offering = true;
    try {
      let slot: Slot | undefined;
      const size = bytes.length;
      // At most one unadmitted archive member is staged. An oversized member
      // needs an empty pool; this is not a limit on valid archive members.
      while (accepting && (!(slot = slots.find(slot => !slot.job)) ||
          (activeBytes + size > rawMost && occupied()))) await wait();
      if (!accepting || !slot) throw failures.length ? failures[0] : new Error('compression scope is closed');
      const id = ids++;
      const {buffer} = bytes;
      const moved = disposable === true && buffer instanceof ArrayBuffer && bytes.byteOffset === 0 &&
        size === buffer.byteLength && !isMarkedAsUntransferable(buffer);
      slot.job = {id, size, accept, fallback: moved ? undefined : bytes};
      activeBytes += size; // Transferring does not make a live input free.
      try { slot.worker.postMessage({id, bytes, moved}, moved ? [buffer] : []); }
      catch (error) { fail(error); throw error; }
    } finally { offering = false; }
  };
  let result:T|undefined;
  try{
    for(let i=0;i<3;i++){
      const slot:Slot={worker:start()};slots.push(slot);
      slot.worker.on('error', lost);
      slot.worker.on('messageerror', lost);
      slot.worker.on('exit',code=>{if(accepting)fail(new Error(`compression worker exited unexpectedly (${code})`));});
      slot.worker.on('message',(message:unknown)=>{
        if(!accepting)return;
        const job=slot.job;
        const response=message as {id?:unknown;bytes?:unknown;raw?:unknown}|null;
        if (!job || response?.id !== job.id || typeof response.raw !== 'boolean') { unowned(); return; }
        const {bytes, raw} = response;
        try {
          let stored: Buffer | undefined;
          if (raw && job.fallback) {
            if (bytes === null) stored = job.fallback;
          } else if (bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer &&
              bytes.byteOffset === 0 && bytes.length === bytes.buffer.byteLength &&
              (raw ? bytes.length === job.size : bytes.length > 0 && bytes.length < job.size)) {
            stored = Buffer.from(bytes.buffer);
          }
          if (!stored) { unowned(); return; }
          job.accept(stored, raw);
        }
        catch (error) { fail(error); return; }
        slot.job = undefined;
        activeBytes -= job.size;
        changed();
      });
    }
    result=await use(compress);
    if (offering) fail(new Error('compression scope returned with an unadmitted member'));
    while (accepting && occupied()) await wait();
  }catch(error){remember(error);}
  const stopped=await stop();
  for(const entry of stopped)if(entry.status==='rejected')remember(entry.reason);
  if(failures.length===1)throw failures[0];
  if(failures.length)throw new AggregateError(failures,'compression failed and additional failure evidence was retained');
  return result as T;
}
