import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {checkedRange,packOf} from '../layers/table.ts';
import {syncRange} from '../layers/pack.ts';
const hash=(b:Uint8Array)=>new Uint8Array(createHash('sha256').update(b).digest());
const files=[new Uint8Array(4096).fill(1),new Uint8Array(8192).fill(2)];
const pack=packOf(files,hash), sizes=new Map([[pack.name,pack.bytes.length]]);
const index={packs:[{name:pack.name,bytes:pack.bytes.length}],files:files.map((b,i)=>({pack:0,at:pack.at[i],len:b.length}))};
test('same pack HTTP 200 materializes once, Free releases it without changing owned files',()=>{
 let calls=0;const range=syncRange('https://example.invalid/',()=>{calls++;return{status:200,bytes:pack.bytes.slice()};},sizes);
 const read=checkedRange(index,range,hash),raw=read(0,pack.at[0],files[0].length).slice();
 assert.deepEqual(read(0,pack.at[1],files[1].length),files[1]);assert.equal(calls,1);assert.equal(range.held(),pack.bytes.length);
 range.clear();assert.equal(range.held(),0);assert.deepEqual(raw,files[0]);read(0,pack.at[0],files[0].length);assert.equal(calls,2);
});
test('switching packs releases old response, including failed and HTTP 206 reads',()=>{
 let status=200;const range=syncRange('https://example.invalid/',(_u,_a,n)=>({status,bytes:new Uint8Array(status===206?n:64)}),new Map([['a',64],['b',64]]));
 range('a',0,1);assert.equal(range.held(),64);status=206;range('b',0,1);assert.equal(range.held(),0);
 status=200;range('a',0,1);status=500;assert.throws(()=>range('b',0,1));assert.equal(range.held(),0);
});
test('index sizes reject wrong bodies, unsafe offsets and unknown packs',()=>{
 for(const size of [1,65]){const r=syncRange('https://example.invalid/',()=>({status:200,bytes:new Uint8Array(size)}),new Map([['a',64]]));assert.throws(()=>r('a',0,1),/length/);assert.equal(r.held(),0);}
 let calls=0;const r=syncRange('https://example.invalid/',()=>{calls++;return{status:200,bytes:new Uint8Array(64)};},new Map([['a',64]]));
 for(const args of [['a',-1,1],['a',63,2],['a',Number.MAX_SAFE_INTEGER,1],['b',0,1]] as [string,number,number][])assert.throws(()=>r(...args));assert.equal(calls,0);
});
test('unindexed reads keep no response; retained size follows pack contract, not a magic cap',()=>{
 const unindexed=syncRange('https://example.invalid/',()=>({status:200,bytes:new Uint8Array(64)}));unindexed('a',0,1);assert.equal(unindexed.held(),0);
 const size=(32<<20)+1,large=syncRange('https://example.invalid/',()=>({status:200,bytes:new Uint8Array(size)}),new Map([['a',size],['b',64]]));
 large('a',0,1);assert.equal(large.held(),size);large.clear();assert.equal(large.held(),0);
});
test('integrity failure discards response and generation changes never replace verified hashes',()=>{
 let changed=false;const other=packOf(files.map(b=>new Uint8Array(b.length).fill(9)),hash);
 const r=syncRange('https://example.invalid/',()=>({status:200,bytes:(changed?other.bytes:pack.bytes).slice()}),sizes),read=checkedRange(index,r,hash);
 read(0,pack.at[0],files[0].length);changed=true;r.clear();assert.throws(()=>read(0,pack.at[1],files[1].length),/file/);assert.equal(r.held(),0);
 assert.throws(()=>read(0,pack.at[1],files[1].length),/table/);assert.equal(r.held(),0);
});
test('subviews own exactly pack bytes even for Buffer transports; separate roots never share',()=>{
 const slab=Buffer.alloc(1024),a=syncRange('https://a.invalid/',()=>({status:200,bytes:slab.subarray(100,164)}),new Map([['a',64]]));
 assert.equal(a('a',0,1).buffer.byteLength,64);
 const b=syncRange('https://b.invalid/',()=>({status:200,bytes:new Uint8Array(64).fill(2)}),new Map([['a',64]]));assert.equal(b('a',0,1)[0],2);a.clear();assert.equal(b.held(),64);
});
test('synchronous reentry never counts multiple responses as one current pack',()=>{
 let entered=false;const r=syncRange('https://example.invalid/',()=>{if(!entered){entered=true;r('b',0,1);}return{status:200,bytes:new Uint8Array(64)};},new Map([['a',64],['b',64]]));
 r('a',0,1);assert.equal(r.held(),64);r.clear();assert.equal(r.held(),0);
});
test('reader snapshots indexed sizes before caller mutates its map',()=>{
 const metadata=new Map([['a',64]]),r=syncRange('https://example.invalid/',()=>({status:200,bytes:new Uint8Array(64)}),metadata);
 r('a',0,1);metadata.set('a',128);assert.throws(()=>r('a',64,1),/outside/);assert.equal(r.held(),64);
});
test('outer HTTP 206 and failure release responses acquired by reentrant transport',()=>{
 for(const status of [206,500]){
  let inside=false;
  const r=syncRange('https://example.invalid/',()=>{
   if(inside)return{status:200,bytes:new Uint8Array(64)};
   inside=true;r('b',0,1);return{status,bytes:new Uint8Array(1)};
  },new Map([['a',64],['b',64]]));
  if(status===500)assert.throws(()=>r('a',0,1));else r('a',0,1);
  assert.equal(r.held(),0);
 }
});
