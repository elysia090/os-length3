// Native/C-Wasm module identity and authenticated C range delivery, not Linux admission.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,elfFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COMPILER.WASM VERIFIED.elf NATIVE-DIRECTORY');
const elf=await readFile(elfFile),cm=new WebAssembly.Memory({initial:16,maximum:32});
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),ci=cc.compiler_arena_min(),co=ci+16384,cr=co+65536;
c.set(elf,ci);assert.equal(cc.compiler_open_elf(ci,elf.length),0);
assert.equal(typeof cc.compiler_prepare_image,'function','complete multi-module preflight must exist');
assert.equal(cc.compiler_prepare_image(256,65536,cr),0);
const total={coordinates:cv.getBigUint64(cr+16,true),modules:cv.getBigUint64(cr+32,true),bytes:cv.getBigUint64(cr+40,true)};
assert(total.coordinates>256n && total.modules>1n);assert.equal(cc.compiler_image_module_bytes(),64);
const memory=new WebAssembly.Memory({initial:16,maximum:32});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),dir=vm.vm_arena_min(),base=dir+4096,
  rootAt=base+2048,request=base+2208,blob=base+8192;
v.setBigUint64(dir,0x1000n,true);v.setUint32(dir+8,131072,true);v.setUint32(dir+12,3,true);v.setUint32(dir+16,1,true);
assert.equal(vm.vm_open(base,a.length-base,131072,dir,1,1,dir+512,1n),0);
assert.equal(vm.vm_bind_state(base),0);
a.set(await readFile(path.join(directory,'root-ref')),rootAt);
assert.equal(vm.vm_directory_bind(rootAt,1n,65536),0);
let nodes=0,objects=0,queries=0,refusals=0;
async function load(major,coordinate,kind){
  assert.equal(vm.vm_directory_query(1n,major,coordinate,kind),0);
  while(vm.vm_directory_status()===2){
    assert.equal(vm.vm_directory_request(request,1n),2);
    const token=v.getBigUint64(request+8,true),length=v.getUint32(request+48,true),name=a.subarray(request+16,request+48).toString('hex');
    const bytes=await readFile(path.join(directory,name));assert.equal(bytes.length,length);a.set(bytes,blob);
    assert.equal(vm.vm_directory_node_commit(blob,length,1n,token+1n),-141);++refusals;
    assert(vm.vm_directory_node_commit(blob,length,1n,token)>=0);++nodes;
  }
  assert.equal(vm.vm_directory_request(request,1n),3);assert.equal(v.getUint32(request+52,true),kind);
  const token=v.getBigUint64(request+8,true),length=v.getUint32(request+48,true),name=a.subarray(request+16,request+48).toString('hex');
  const bytes=await readFile(path.join(directory,name));assert.equal(bytes.length,length);a.set(bytes,blob);
  a[blob]^=1;assert.equal(vm.vm_directory_object_commit(blob,length,1n,token),-35);a[blob]^=1;++refusals;
  assert.equal(vm.vm_directory_object_commit(blob,length,1n,token),0);assert.equal(vm.vm_directory_status(),4);
  ++objects;++queries;return Buffer.from(a.subarray(blob,blob+length));
}
assert((await load(0n,0n,6)).equals(elf),'canonical ELF owner appears once before derived modules');
let modules=0n,coordinates=0n,bytes=0n,last=0n;
while(true){const status=cc.compiler_image_next(co,65536,cr);assert(status>=0);if(!status)break;
  const first=cv.getBigUint64(cr,true),end=cv.getBigUint64(cr+8,true),length=Number(cv.getBigUint64(cr+56,true));
  assert(first>=last && end>first);const module=Buffer.from(c.subarray(co,co+length));assert(WebAssembly.validate(module));
  for(const point of [first,first+(end-first)/2n,end-1n])assert((await load(1n,point,5)).equals(module),'C floor/range selection matches cold C module bytes');
  last=end;++modules;coordinates+=end-first;bytes+=BigInt(length);
}
assert.equal(modules,total.modules);assert.equal(coordinates,total.coordinates);assert.equal(bytes,total.bytes);
// The last interval extends beyond the last stored key; its exclusive end is absent.
assert.equal(vm.vm_directory_query(1n,1n,last,5),0);
while(vm.vm_directory_status()===2){assert.equal(vm.vm_directory_request(request,1n),2);
  const token=v.getBigUint64(request+8,true),length=v.getUint32(request+48,true),name=a.subarray(request+16,request+48).toString('hex');
  const node=await readFile(path.join(directory,name));a.set(node,blob);
  const result=vm.vm_directory_node_commit(blob,length,1n,token);if(result<0){assert.equal(result,-36);++refusals;break;}}
cc.compiler_close();assert.equal(cc.compiler_image_next(co,65536,cr),-100);vm.vm_close();
console.log(JSON.stringify({format:'image-directory-c-range-delivery-v1',status:'pass',coordinates:Number(coordinates),
  modules:Number(modules),moduleBytes:Number(bytes),queries,nodeReads:nodes,objectReads:objects,refusals,
  oracle:'native/C-Wasm bytes and actual C authenticated index/object reader; no host row or ISA parser',
  executionAdmission:'not-tested-by-this-delivery-driver',linuxBoot:'not-tested',productionRoot:'not-signed'},null,2));
