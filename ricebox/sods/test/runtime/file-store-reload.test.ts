import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {loadFileScope} from '../../runtime/linux/file-scope.ts';
import {Vfs, provide, FsError, E} from '../../runtime/linux/fs.ts';
import {Kernel} from '../../runtime/linux/process.ts';
import {mountPack} from '../../../distribution/format/mount.ts';
import {packOf} from '../../../distribution/format/pack.ts';
const wasm = process.env.SODS_FILE_STORE_WASM, enc = new TextEncoder(), dec = new TextDecoder();
const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());
const kernel = (vfs: Vfs) => new Kernel({vfs,translate() { throw new Error('unused'); }, console:{write(){},read:()=>new Uint8Array(0)}});
async function setup() {
  const scope = await loadFileScope(readFileSync(wasm!),32), vfs = new Vfs();
  const payload = enc.encode('abcdef'), packed = packOf([payload],sha256); let reads = 0, corrupt = false;
  const entry = {mode:0o644,size:6,pack:0,at:packed.at[0],len:6,raw:true};
  mountPack(scope.mountTarget(vfs),{codec:'zstd',dirs:[],links:[],packs:[{name:packed.name,bytes:packed.bytes.length}],files:[{path:'/a',...entry},{path:'/b',...entry}]}, {
    range:(_name,at,len)=>{ reads++; const b=packed.bytes.slice(at,at+len); if(corrupt && at===entry.at)b[0]^=1; return b; },
    decode(){throw new Error('raw only');},sha256,
  });
  return {scope,vfs,file:vfs.file('/a'),reads:()=>reads,corrupt:(value:boolean)=>{corrupt=value;}};
}
test('real pack mount uses one Rust inode for hardlinks, release preserves size and verifies reload', {skip:!wasm},async()=>{
  const s=await setup(), k=kernel(s.vfs);
  assert.equal(s.reads(),0); assert.equal(s.file,s.vfs.file('/b')); assert.equal(s.file.size,6);
  assert.equal(k.held().files,0); assert.equal(dec.decode(s.file.bytes()),'abcdef'); assert.equal(k.held().files,6);
  assert.equal(s.reads(),2); assert.equal(k.free().after.files,0); assert.equal(s.file.size,6); assert.equal(s.file.heldBytes(),0);
  s.corrupt(true); assert.throws(()=>s.file.bytes(),(e:unknown)=>e instanceof FsError && e.errno===E.IO);
  assert.equal(s.file.size,6); assert.equal(k.held().files,0);
  s.corrupt(false); assert.equal(dec.decode(s.file.bytes()),'abcdef'); assert.equal(k.held().files,6);
  s.scope.dispose(); assert.equal(s.vfs.loaded.files.size,0);
});
test('verified root provide preserves hardlinks without pack fetch; failed mutation keeps reload capability', {skip:!wasm},async()=>{
  const s=await setup(), k=kernel(s.vfs);
  assert.equal(provide(s.vfs,{path:'/a',bytes:enc.encode('abcdef'),root:true}),s.file);
  assert.equal(s.reads(),0); assert.equal(k.held().files,6); assert.equal(s.vfs.file('/b'),s.file);
  assert.throws(()=>s.file.truncate(33),(e:unknown)=>e instanceof FsError && e.errno===E.FBIG);
  assert.equal(s.file.release(),6); assert.equal(dec.decode(s.file.bytes()),'abcdef');
  s.file.write(1,enc.encode('Z')); assert.equal(s.file.release(),0); assert.equal(k.held().files,0);
  assert.equal(dec.decode(s.file.bytes()),'aZcdef'); s.scope.dispose();
});
test('shared tree keepers prevent eviction and dirty mapping cannot be reloaded away', {skip:!wasm},async()=>{
  const s=await setup(), a=kernel(s.vfs), b=kernel(s.vfs);
  s.file.bytes();
  b.remember(s.file,{version:0,image:{size:0},used:0,kept:true} as unknown as Parameters<Kernel['remember']>[1]);
  assert.equal(a.free().after.files,6); b.ended(); assert.equal(a.free().after.files,0);
  const memory=s.file.bytes(); const mapping={proc:{bytes:memory},start:0,length:6,off:0};
  s.file.map(mapping); memory[0]=90;
  assert.equal(s.file.release(),0); assert.equal(dec.decode(s.file.bytes()),'Zbcdef');
  assert.equal(a.held().files,0); s.file.unmap(mapping); s.scope.dispose();
});
test('empty sources can evict and reload; mapped sources are not advertised as spare', {skip:!wasm},async()=>{
  const scope=await loadFileScope(readFileSync(wasm!),32),vfs=new Vfs(),k=kernel(vfs);let loads=0;
  const empty=scope.lazyFile(vfs,'/empty',()=>{loads++;return new Uint8Array(0);});
  empty.bytes();assert.equal(vfs.loaded.files.has(empty),true);assert.equal(empty.release(),0);
  assert.equal(vfs.loaded.files.has(empty),false);empty.bytes();assert.equal(loads,2);
  const file=scope.lazyFile(vfs,'/mapped',()=>enc.encode('abc'));
  const mapping={proc:{bytes:file.bytes()},start:0,length:3,off:0};file.map(mapping);
  assert.equal(k.held().files,3);assert.equal(k.held().spare,0);assert.equal(file.release(),0);
  file.unmap(mapping);assert.equal(k.free().after.files,0);scope.dispose();
});
