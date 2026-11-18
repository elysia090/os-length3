import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {setImmediate} from 'node:timers/promises';
import {zstdDecompressSync} from 'node:zlib';
import {withCompression} from '../compression-pool.ts';
const normal=()=>new Worker(new URL('../compress.worker.ts',import.meta.url));

test('scope preserves ordered bytes and confirms all three workers stopped',{timeout:10000},async()=>{
  const workers:Worker[]=[];
  const inputs=Array.from({length:9},(_,i)=>Buffer.from(`input-${i}`));
  const result=await withCompression(compress=>Promise.all(inputs.map(compress)),()=>{const w=normal();workers.push(w);return w;});
  assert.equal(workers.length,3);
  assert.deepEqual(result.map(z=>zstdDecompressSync(z)),inputs);
  assert.ok(workers.every(w=>w.threadId===-1));
});

test('partial worker construction failure retires earlier workers without invoking owner',{timeout:10000},async()=>{
  const workers:Worker[]=[],failure=new Error('third constructor');let called=false;
  await assert.rejects(withCompression(async()=>{called=true;},()=>{
    if(workers.length===2)throw failure;
    const w=normal();workers.push(w);return w;
  }),error=>error===failure);
  assert.equal(called,false);assert.ok(workers.every(w=>w.threadId===-1));
});

for(const [name,source,pattern] of [
  ['error',"throw new Error('worker failed')",/worker failed/],
  ['unexpected exit','process.exit(0)',/exited unexpectedly \(0\)/],
  ['wrong result',"require('node:worker_threads').parentPort.on('message',m=>require('node:worker_threads').parentPort.postMessage({id:m.id+1,z:new Uint8Array()}))",/unowned response/],
] as const)test(`${name} rejects in-flight and queued jobs and retires workers`,{timeout:10000},async()=>{
  const workers:Worker[]=[];let results:PromiseSettledResult<Buffer>[]=[];
  await assert.rejects(withCompression(async compress=>{
    const jobs=Array.from({length:8},()=>compress(Buffer.from('input')));
    results=await Promise.allSettled(jobs);
  },()=>{const w=new Worker(source,{eval:true});workers.push(w);return w;}),pattern);
  assert.equal(results.length,8);assert.ok(results.every(r=>r.status==='rejected'));
  assert.ok(workers.every(w=>w.threadId===-1));
});

test('synchronous postMessage failure rejects jobs without an unhandled rejection window',{timeout:10000},async()=>{
  await assert.rejects(withCompression(async compress=>{
    const job=compress((()=>{}) as unknown as Buffer);
    // Deliberately delay ownership's await, as archive reading does.
    await setImmediate();
    await job;
  }),/could not be cloned/);
});

test('owner failure settles unawaited jobs and retains the original cause',{timeout:10000},async()=>{
  const failure=new Error('archive failed');let jobs:Promise<Buffer>[]=[];
  await assert.rejects(withCompression(async compress=>{
    jobs=Array.from({length:10},()=>compress(Buffer.alloc(100)));
    throw failure;
  }),error=>error===failure);
  assert.ok((await Promise.allSettled(jobs)).every(r=>r.status==='rejected'));
});

test('returning with unfinished jobs fails rather than claiming successful completion',{timeout:10000},async()=>{
  let job:Promise<Buffer>|undefined;
  await assert.rejects(withCompression(async compress=>{job=compress(Buffer.alloc(100));}),/unfinished jobs/);
  await assert.rejects(job!,/unfinished jobs/);
});

test('cleanup failure preserves owner error and does not prevent other retirement attempts',{timeout:10000},async()=>{
  const workers:Worker[]=[],original=new Error('owner'),cleanup=new Error('termination');
  try{
    await assert.rejects(withCompression(async()=>{throw original;},()=>{
      const w=normal();if(!workers.length)w.terminate=()=>Promise.reject(cleanup);workers.push(w);return w;
    }),error=>error instanceof AggregateError&&error.errors[0]===original&&error.errors[1]===cleanup);
    assert.ok(workers.slice(1).every(w=>w.threadId===-1));
    assert.notEqual(workers[0].threadId,-1,'failed termination is not evidence of a stopped worker');
  }finally{await Promise.all(workers.map(w=>Worker.prototype.terminate.call(w)));}
});


test('worker exit is observed even before the streaming owner awaits its jobs',{timeout:10000},async()=>{
  const workers:Worker[]=[];
  await assert.rejects(withCompression(async compress=>{
    const jobs=Array.from({length:8},()=>compress(Buffer.from('input')));
    await once(workers[0],'exit');
    await Promise.all(jobs);
  },()=>{const w=new Worker('process.exit(0)',{eval:true});workers.push(w);return w;}),/exited unexpectedly/);
  assert.ok(workers.every(w=>w.threadId===-1));
});

test('a retained compression callback cannot accept work after its scope closes',{timeout:10000},async()=>{
  let late:((bytes:Buffer)=>Promise<Buffer>)|undefined;
  await withCompression(async compress=>{late=compress;});
  await assert.rejects(late!(Buffer.from('late')),/scope is closed/);
});
