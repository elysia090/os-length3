import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {releaseFileStore} from '../file-store.ts';
import {prepareTree} from '../prepared-tree.ts';
import type {FileStoreDescriptor} from '../shape.ts';
const wasm=process.env.SODS_FILE_STORE_WASM;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function descriptor(bytes:Uint8Array):FileStoreDescriptor {const packed=gzipSync(bytes),sha256=hash(packed);return {abi:4,maxFileBytes:64,path:`blobs/${sha256}.bin`,sha256,size:packed.length,bytes:bytes.length,wasm:hash(bytes)};}
test('release-selected core is the default prepared-root owner',{skip:!wasm},async()=>{
  const bytes=readFileSync(wasm!),d=descriptor(bytes);let reads=0;
  const core=await releaseFileStore(d,async(actual)=>{assert.equal(actual,d);reads++;return bytes;});
  assert.equal(reads,1);assert.ok(core?.module instanceof WebAssembly.Module);
  const tree=await prepareTree({fileStore:core,muk:new Uint8Array([1])});tree.dispose();
});
test('missing descriptor retains old release compatibility, conflicting override is refused',{skip:!wasm},async()=>{
  const bytes=readFileSync(wasm!),explicit={module:bytes,maxFileBytes:64};
  assert.equal(await releaseFileStore(undefined,async()=>{throw new Error('unexpected');}),undefined);
  assert.equal(await releaseFileStore(undefined,async()=>bytes,explicit),explicit);
  await assert.rejects(releaseFileStore(descriptor(bytes),async()=>bytes,explicit),/separate caller selection/);
});
test('selected descriptor never falls back on missing, corrupt or mismatched core',{skip:!wasm},async()=>{
  const bytes=readFileSync(wasm!),d=descriptor(bytes);
  await assert.rejects(releaseFileStore(d,async()=>{throw new Error('404');}),/404/);
  await assert.rejects(releaseFileStore({...d,wasm:'0'.repeat(64)},async()=>bytes),/content mismatch/);
  await assert.rejects(releaseFileStore({...d,bytes:d.bytes+1},async()=>bytes),/content mismatch/);
  await assert.rejects(releaseFileStore({...d,abi:3} as unknown as FileStoreDescriptor,async()=>bytes),/descriptor/);
  const empty=new Uint8Array([0,97,115,109,1,0,0,0]);
  await assert.rejects(releaseFileStore(descriptor(empty),async()=>empty),/ABI/);
});

test('present malformed descriptor cannot downgrade to legacy',async()=>{
  for(const value of [null,false,0,'']) await assert.rejects(releaseFileStore(value as unknown as FileStoreDescriptor,async()=>{throw new Error('must not read');}),/descriptor/);
});
test('claiming ABI4 without its required operations is rejected before readiness',async()=>{
  const name=[...new TextEncoder().encode('files_abi_version')],section=(id:number,data:number[])=>[id,data.length,...data];
  const bytes=new Uint8Array([0,97,115,109,1,0,0,0,...section(1,[1,0x60,0,1,0x7f]),...section(3,[1,0]),...section(7,[1,name.length,...name,0,0]),...section(10,[1,4,0,0x41,4,0x0b])]);
  await assert.rejects(releaseFileStore(descriptor(bytes),async()=>bytes),/missing required exports/);
});

test('legacy selection names are rejected before browser config acquires resources', async () => {
  const {createRoot}=await import('../root.ts');
  const {requireFileStoreName}=await import('../shape.ts');
  for(const value of [null,false,{},undefined]) {
    assert.throws(()=>requireFileStoreName({fileCore:value}),/regenerate/);
    assert.throws(()=>requireFileStoreName({fileCore:value,fileStore:{}}),/regenerate/);
    assert.throws(()=>createRoot({fileCore:value} as unknown as Parameters<typeof createRoot>[0]),/regenerate/);
  }
  assert.doesNotThrow(()=>requireFileStoreName({}));
  assert.doesNotThrow(()=>requireFileStoreName({fileStore:{}})); // descriptor validation is the next gate
});

test('direct prepared-tree callers cannot silently drop obsolete selections', async () => {
  for (const key of ['core','fileCore']) for (const value of [undefined,null,{}]) {
    await assert.rejects(prepareTree({[key]:value,muk:null} as unknown as Parameters<typeof prepareTree>[0]),/obsolete selection/);
  }
  await assert.rejects(prepareTree({muk:null,root:{index:{fileCore:null},reading:{}}} as unknown as Parameters<typeof prepareTree>[0]),/obsolete selection/);
});

test('explicit falsy artifact selections cannot become legacy storage',async()=>{
  for(const value of [null,false,0,'']) {
    const fileStore=value as unknown as NonNullable<Parameters<typeof prepareTree>[0]['fileStore']>;
    await assert.rejects(prepareTree({fileStore,muk:new Uint8Array([1])}),/Invalid file-store artifact/);
    await assert.rejects(releaseFileStore(undefined,async()=>{throw new Error('must not read');},fileStore),/Invalid file-store artifact/);
  }
});
