import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {prepareTree} from '../prepared-tree.ts';
import {packOf} from '../table.ts';
import {Kernel} from '../../../sods/runtime/linux.ts';
const wasm=process.env.SODS_FILE_STORE_WASM, enc=new TextEncoder(), dec=new TextDecoder();
const sha256=(b:Uint8Array)=>new Uint8Array(createHash('sha256').update(b).digest());
function root(){
  const pack=packOf([enc.encode('abc')],sha256);let reads=0;
  return {value:{index:{codec:'zstd',dirs:[],links:[],packs:[{name:pack.name,bytes:pack.bytes.length}],files:[{path:'/a',mode:0o644,size:3,pack:0,at:pack.at[0],len:3,raw:true}]},reading:{sha256,decode:(b:Uint8Array)=>b,range:(_n:string,at:number,len:number)=>{reads++;return pack.bytes.slice(at,at+len);}}},reads:()=>reads};
}
for(const selected of [false,true])test(`ready tree survives a rehearsal owner ending, Rust=${selected}`,{skip:selected&&!wasm},async()=>{
  const r=root(),tree=await prepareTree({fileStore:selected?{module:readFileSync(wasm!),maxFileBytes:64}:undefined,root:r.value,muk:enc.encode('maker'),files:[{path:'/a',bytes:enc.encode('abc'),root:true}]});
  assert.equal(r.reads(),0);assert.equal(dec.decode(tree.vfs.readFile('/run/box/muk')),'maker');
  const k=()=>new Kernel({vfs:tree.vfs,translate(){throw new Error('unused');},console:{write(){},read:()=>new Uint8Array(0)}});
  const rehearsal=k();assert.equal(rehearsal.held().files,3);rehearsal.ended();
  const run=k();assert.equal(dec.decode(run.vfs.readFile('/a')),'abc');assert.equal(run.free().after.files,0);
  assert.equal(dec.decode(run.vfs.readFile('/a')),'abc');assert.equal(r.reads(),2);
  run.ended();tree.dispose();tree.dispose();
  if(selected)assert.throws(()=>tree.vfs.readFile('/a'),/closed/);
});
test('explicit invalid fileStore fails without fetching packs or falling back',{skip:!wasm},async()=>{
  const r=root();await assert.rejects(prepareTree({fileStore:{module:new Uint8Array([0,97,115,109,1,0,0,0]),maxFileBytes:64},root:r.value,muk:enc.encode('m')}),/ABI/);assert.equal(r.reads(),0);
});
test('preparation failure does not publish partial tree and independent retry succeeds',{skip:!wasm},async()=>{
  const r=root(),fileStore={module:readFileSync(wasm!),maxFileBytes:2};
  await assert.rejects(prepareTree({fileStore,root:r.value,muk:enc.encode('m')}));assert.equal(r.reads(),0);
  const tree=await prepareTree({fileStore:{...fileStore,maxFileBytes:64},root:r.value,muk:enc.encode('m')});
  assert.equal(dec.decode(tree.vfs.readFile('/a')),'abc');tree.dispose();
});
test('prepared Rust pack executes a minimal ELF through the supplied real translator',{skip:!wasm||!process.env.SODS_TRANSLATOR_WASM},async()=>{
  const {loadTranslator}=await import('../../../sods/runtime/translate.ts');
  const elf=new Uint8Array(4108),v=new DataView(elf.buffer);
  elf.set([0x7f,69,76,70,2,1,1]);v.setUint16(16,2,true);v.setUint16(18,62,true);v.setUint32(20,1,true);
  v.setBigUint64(24,0x401000n,true);v.setBigUint64(32,64n,true);v.setUint16(52,64,true);v.setUint16(54,56,true);v.setUint16(56,1,true);
  v.setUint32(64,1,true);v.setUint32(68,5,true);v.setBigUint64(80,0x400000n,true);
  v.setBigUint64(96,BigInt(elf.length),true);v.setBigUint64(104,BigInt(elf.length),true);v.setBigUint64(112,4096n,true);
  elf.set([0xb8,60,0,0,0,0xbf,7,0,0,0,0x0f,0x05],4096);
  const pack=packOf([elf],sha256);
  const tree=await prepareTree({fileStore:{module:readFileSync(wasm!),maxFileBytes:8192},muk:enc.encode('unused fixture'),root:{index:{codec:'zstd',dirs:[],links:[],packs:[{name:pack.name,bytes:pack.bytes.length}],files:[{path:'/exit',mode:0o755,size:elf.length,pack:0,at:pack.at[0],len:elf.length,raw:true}]},reading:{sha256,decode:(b)=>b,range:(_n,at,len)=>pack.bytes.slice(at,at+len)}}});
  const k=new Kernel({vfs:tree.vfs,translate:await loadTranslator(readFileSync(process.env.SODS_TRANSLATOR_WASM!)),console:{write(){},read:()=>new Uint8Array(0)}});
  try {
    k.start('/exit',['/exit'],[],'/');
    for(let i=0;i<100 && k.status===null;i++)k.pump();
    assert.equal(k.status,7 << 8); // Linux wait status, not a raw exit code.
  } finally { k.halt();tree.dispose(); }
});
