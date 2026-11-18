// Private build scope: accepted jobs settle, and every created Worker is retired
// before a successful return. Retirement failure throws, never claims closure.
// No retries or runtime Worker lifecycle assumptions; archive reading is not cancelled.
import {Worker} from 'node:worker_threads';
type Job = {id:number;bytes:Buffer;resolve:(value:Buffer)=>void;reject:(reason:unknown)=>void};
type Slot = {worker:Worker;job?:Job};
type Compress = (bytes:Buffer)=>Promise<Buffer>;

export async function withCompression<T>(use:(compress:Compress)=>Promise<T>,
  start:()=>Worker=()=>new Worker(new URL('./compress.worker.ts',import.meta.url))):Promise<T> {
  const slots:Slot[]=[], idle:Slot[]=[], queue:Job[]=[];
  const failures:unknown[]=[];
  let accepting=true, ids=0, retirement:Promise<PromiseSettledResult<number>[]>|undefined;
  const remember=(error:unknown)=>{if(!failures.includes(error))failures.push(error);};
  const stop=()=>{
    if(retirement)return retirement;
    accepting=false;
    const reason=failures.length?failures[0]:new Error('compression scope closed before completing work');
    for(const job of queue.splice(0))job.reject(reason);
    for(const slot of slots){slot.job?.reject(reason);slot.job=undefined;}
    idle.length=0;
    // allSettled attempts every retirement even if one throws or rejects.
    retirement=Promise.allSettled(slots.map(({worker})=>Promise.resolve().then(()=>worker.terminate())));
    return retirement;
  };
  const fail=(error:unknown)=>{remember(error);void stop();};
  const dispatch=(slot:Slot,job:Job)=>{
    slot.job=job;
    try{slot.worker.postMessage({id:job.id,bytes:job.bytes});}catch(error){fail(error);}
  };
  const compress:Compress=bytes=>{
    const result=new Promise<Buffer>((resolve,reject)=>{
      if(!accepting){reject(failures.length?failures[0]:new Error('compression scope is closed'));return;}
      const job={id:ids++,bytes,resolve,reject},slot=idle.pop();
      if(slot)dispatch(slot,job);else queue.push(job);
    });
    // Jobs can fail while the owner is still streaming the archive. The owner
    // still receives the rejected promise, without a premature unhandled event.
    void result.catch(()=>{});
    return result;
  };
  let result:T|undefined;
  try{
    for(let i=0;i<3;i++){
      const slot:Slot={worker:start()};slots.push(slot);idle.push(slot);
      slot.worker.on('error',error=>{if(accepting)fail(error);});
      slot.worker.on('exit',code=>{if(accepting)fail(new Error(`compression worker exited unexpectedly (${code})`));});
      slot.worker.on('message',(message:unknown)=>{
        if(!accepting)return;
        const job=slot.job;
        const response=message as {id?:unknown;z?:unknown}|null;
        if(!job||!response||response.id!==job.id||!(response.z instanceof Uint8Array)){
          fail(new Error('compression worker returned an unowned response'));return;
        }
        let bytes:Buffer;
        try{bytes=Buffer.from(response.z);}catch(error){fail(error);return;}
        slot.job=undefined;job.resolve(bytes);
        const next=queue.shift();if(next)dispatch(slot,next);else idle.push(slot);
      });
    }
    result=await use(compress);
    if(accepting&&(queue.length||slots.some(slot=>slot.job)))fail(new Error('compression scope returned with unfinished jobs'));
  }catch(error){remember(error);}
  const stopped=await stop();
  for(const entry of stopped)if(entry.status==='rejected')remember(entry.reason);
  if(failures.length===1)throw failures[0];
  if(failures.length)throw new AggregateError(failures,'compression failed and additional failure evidence was retained');
  return result as T;
}
