import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {writeFramedAot} from '../../build/framed-aot.ts';
import {aotFraming, orderedAotFrames} from '../../format/aot-frames.ts';
import {compileFramedAot} from '../framed-aot.ts';
import {shardedAotResponse} from '../aot-shards.ts';

const base = 'https://shards.test/ricebox/';
function fixture(t: TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'ricebox-aot-shards-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const asset = writeFramedAot(dir, Uint8Array.of(0,97,115,109,1,0,0,0,0,2,1,65,0,2,1,66));
  const stored = readFileSync(join(dir,asset.path)), durable = new Map<string, Uint8Array>(), objects = new Map<string,Uint8Array>();
  const layout = asset.framing!;
  // Put the valid frames in separate physical objects so tests can exercise
  // independent failures without creating a huge ELF.
  layout.version = 'sods-framed-v2';
  layout.shards = orderedAotFrames(layout).map(({at, size, sha256})=>{
    const path=`blobs/${sha256}.bin`;
    objects.set(base+path,stored.subarray(at,at+size));
    return {at,size,sha256,path};
  });
  const shelf = {
    async match(url:string) { const bytes=durable.get(url); return bytes&&new Response(Uint8Array.from(bytes)); },
    async delete(url:string) { return durable.delete(url); },
  } as unknown as Cache;
  let evictions=0;
  return {asset,layout,objects,durable,evictions:()=>evictions,cache:{
    async open(){return shelf;},
    async keep(url:string,bytes:Uint8Array){durable.set(url,bytes.slice());return true;},
    gone(){evictions++;}, used(){},
  }};
}

test('shards resume a bounded individual range, retry transient failure, and revisit offline without re-download', async t=>{
  const {asset,layout,objects,durable,cache}=fixture(t);
  const first=base+layout.shards![0]!.path, second=base+layout.shards![1]!.path;
  const calls: {url:string; range:string|null}[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input), range=new Headers(init?.headers).get('Range');
    calls.push({url,range});
    const bytes=objects.get(url)!;
    assert.ok(bytes);
    if(url===first&&calls.filter(c=>c.url===first).length===1)return new Response(null,{status:503});
    if(url===second&&calls.filter(c=>c.url===second).length===1){
      let wrote=false;
      return new Response(new ReadableStream({
        pull(c){
          if(!wrote){wrote=true;c.enqueue(bytes.subarray(0,3));}
          else c.error(new Error('test connection lost'));
        },
      },{highWaterMark:0}),{headers:{ETag:'"asset"'}});
    }
    if(url===second){
      assert.equal(range,'bytes=3-');
      assert.equal(new Headers(init?.headers).get('If-Range'),'"asset"');
      return new Response(Uint8Array.from(bytes.subarray(3)),{status:206,headers:{'Content-Range':`bytes 3-${bytes.length-1}/${bytes.length}`}});
    }
    return new Response(Uint8Array.from(bytes));
  };
  const outer=new AbortController().signal;
  const make=(get:typeof fetch)=>compileFramedAot(asset,false,async signal=>shardedAotResponse(asset,base,cache,signal,undefined,
    {fetch:get,backoff:()=>0,attempts:3}),outer);
  assert.ok((await make(fetcher)).module instanceof WebAssembly.Module);
  assert.equal(calls.filter(c=>c.url===first).length,2);
  assert.equal(calls.filter(c=>c.url===second).length,2);
  assert.equal(durable.size,3);
  assert.ok((await make(async()=>{assert.fail('warm verified shards should work offline');})).module instanceof WebAssembly.Module);
});

test('a mismatching or oversized cache object is not accepted; network recovery is separately verified', async t=>{
  const {asset,layout,objects,durable,cache,evictions}=fixture(t);
  const first=base+layout.shards![0]!.path;
  const bytes=objects.get(first)!;
  durable.set(first,Buffer.concat([bytes, Uint8Array.of(0)]));
  let fetched=0;
  await compileFramedAot(asset,false,async signal=>shardedAotResponse(asset,base,cache,signal,undefined,
    {attempts:1,fetch:async input=>{fetched++;return new Response(Uint8Array.from(objects.get(String(input))!));}}),new AbortController().signal);
  assert.equal(evictions(),1);
  assert.equal(fetched,3);
  assert.equal(createHash('sha256').update(durable.get(first)!).digest('hex'),layout.shards![0]!.sha256);
});

test('retiring an active sharded body during an outstanding read cancels and never caches a partial', {timeout:5000}, async t=>{
  const {asset,objects,durable,cache}=fixture(t);
  const {promise:asked,resolve:seen}=Promise.withResolvers<void>(), stop=new AbortController();
  let cancelled=0, attempts=0;
  const job=compileFramedAot(asset,false,async signal=>shardedAotResponse(asset,base,cache,signal,undefined,{
    fetch:async input=>{
      attempts++;
      const first=objects.get(String(input))!.subarray(0,2);
      return new Response(new ReadableStream({
        start(c){c.enqueue(first);seen();},
        cancel(){cancelled++;},
      }));
    },
  }),stop.signal);
  await asked;
  stop.abort(new Error('retired test generation'));
  await assert.rejects(job,/retired test generation/);
  assert.equal(cancelled,1);
  assert.equal(attempts,1);
  assert.equal(durable.size,0);
});

test('retiring during retry backoff drains without issuing another shard request', {timeout: 2500}, async t => {
  const {asset, durable, cache} = fixture(t), owner = new AbortController();
  const delay = Promise.withResolvers<void>();
  let requests = 0;
  const job = compileFramedAot(asset, false, async signal => shardedAotResponse(asset, base, cache, signal, undefined, {
    fetch: async () => { requests++; return new Response(null, {status: 503}); },
    backoff: () => { delay.resolve(); return 10_000; },
  }), owner.signal);
  await delay.promise;
  owner.abort(new Error('retired during shard retry'));
  await assert.rejects(job, /retired during shard retry/);
  assert.equal(requests, 1);
  assert.equal(durable.size, 0);
});

test('misordered or frame-splitting physical offsets fail deterministically before transport', t=>{
  const {asset}=fixture(t);
  for(const edit of [
    (a: typeof asset)=>a.framing!.shards!.reverse(),
    (a: typeof asset)=>{a.framing!.shards![0]!.size++;},
    (a: typeof asset)=>{a.framing!.shards![0]!.size = (16<<20)+1;},
    (a: typeof asset)=>{a.framing!.shards![0]!.path = a.path;},
  ]){
    const bad=structuredClone(asset);edit(bad);
    assert.throws(()=>aotFraming(bad),/invalid framed AOT layout/);
  }
});
