// A compiled-source metadata connection is not whole ELF or Linux acceptance.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';
import {seedDisabledDebug} from './machine-observation.mjs';
const [vmFile,compilerFile,fixture,crossFixture]=process.argv.slice(2);
if(!compilerFile)throw new Error('usage: check-source-module.mjs VM.WASM COMPILER.WASM NATIVE-FIXTURE');
const memory=new WebAssembly.Memory({initial:16,maximum:32});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const coldMemory=new WebAssembly.Memory({initial:16,maximum:32});
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
for(const name of ['vm_directory_module_plan','vm_directory_source_publish'])
  assert.equal(typeof vm[name],'function',`C must consume the authenticated compiler metadata: ${name}`);
assert.equal(typeof cc.compiler_emit_projection,'function','cold C must emit ordinary Wasm source metadata');
if(!fixture)throw new Error('native fixture required after the independently red API guard');
const count=130,entry=0x400000n,source=await readFile(path.join(fixture,'source-page'));
const expectedModule=await readFile(path.join(fixture,'projection.wasm')),records=await readFile(path.join(fixture,'native'));
assert.equal(records.length,count*2*1256);
const cold=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer);
const ci=cc.compiler_arena_min(),options=ci+8192,co=ci+16384,cr=co+65536;
cold.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
for(let i=0;i<count;++i){cv.setBigUint64(options+i*16,entry+64n+BigInt(i*16),true);
  cv.setUint32(options+i*16+8,1,true);cv.setUint32(options+i*16+12,65536,true);}
assert.equal(cc.compiler_emit_projection(options,count,co,65536,cr),0);
assert.equal(cv.getBigUint64(cr+40,true),BigInt(expectedModule.length));
assert(cold.subarray(co,co+expectedModule.length).equals(expectedModule),'native / cold C projection bytes');
cc.compiler_close(); // No compiler export may be called during the reuse sequence below.

const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),dir=vm.vm_arena_min(),base=dir+8192;
const state=base,segments=base+1408,port=base+2048,rootAt=base+3072,requestAt=base+3200;
const codeView=base+3264,planAt=base+3328,blobAt=base+4096,rows=dir+512,reserved=73728;
const payload=i=>base+reserved+i*4096,put=(at,x)=>v.setBigUint64(at,BigInt(x),true);
const root=await readFile(path.join(fixture,'root-ref'));
const table=vm.__indirect_function_table,firstSlot=vm.vm_slot_min();
table.grow(Math.max(0,firstSlot+vm.vm_source_capacity()-table.length));
const engines=new CompiledModules({machine:{memory}},{maximumEntries:1,maximumBytes:65536});
let nodeReads=0,objectReads=0,coldQueries=0,warmQueries=0,comparisons=0,refusals=0;
function reset(codePages=source,rootBytes=root){
  vm.vm_close();data.fill(0,dir);
  [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000].forEach((address,i)=>{
    put(dir+i*32,address);v.setUint32(dir+i*32+8,reserved+i*4096,true);
    v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);
  });
  put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(3),0x8067);
  put(payload(3)+8,codePages.length>4096?0x9067:0x8067);
  data.set(codePages,payload(4));
  put(state+400,0x80010011);put(state+408,0x1000);put(state+416,32);put(state+424,0xd00);put(state+488,8);
  seedDisabledDebug(v,state);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);put(port,9);
  assert.equal(vm.vm_open(base,data.length-base,reserved,dir,6,6,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(state),0);assert.equal(vm.vm_bind_segments(segments),0);
  data.set(rootBytes,rootAt);assert.equal(vm.vm_directory_bind(rootAt,9n,65536),0);
}
async function load(directory=fixture,expected=expectedModule,page=0){
  assert.equal(vm.vm_directory_query(9n,1n,BigInt(page),1),0);
  while(vm.vm_directory_status()===2){
    assert.equal(vm.vm_directory_request(requestAt,9n),2);
    const ticket=v.getBigUint64(requestAt+8,true),bytes=v.getUint32(requestAt+48,true);
    const opaque=data.subarray(requestAt+16,requestAt+48).toString('hex');
    const object=await readFile(path.join(directory,opaque));assert.equal(object.length,bytes);data.set(object,blobAt);
    assert(vm.vm_directory_node_commit(blobAt,bytes,9n,ticket)>=0);++nodeReads;
  }
  assert.equal(vm.vm_directory_request(requestAt,9n),3);
  const ticket=v.getBigUint64(requestAt+8,true),bytes=v.getUint32(requestAt+48,true);
  const opaque=data.subarray(requestAt+16,requestAt+48).toString('hex');
  const object=await readFile(path.join(directory,opaque));assert(object.equals(expected));data.set(object,blobAt);
  assert.equal(vm.vm_directory_object_commit(blobAt,bytes,9n,ticket),0);++objectReads;
  return ticket;
}
function seed(index){
  const before=index*2*1256;
  for(let reg=0;reg<16;++reg)put(state+reg*8,records.readBigUInt64LE(before+reg*8));
  put(state+384,entry+64n+BigInt(index*16));put(state+392,records.readBigUInt64LE(before+392));put(state+1128,41);
}
let crossing=0;
reset();const ticket=await load();
try {
  for(let round=0;round<6;++round)for(let index=0;index<count;++index){
    seed(index);const address=v.getBigUint64(state+384,true),before=Buffer.from(data.subarray(state,state+1256));
    const status=vm.vm_source_query(port,address,1,codeView,rows);assert(status===0n||status===1n);
    if(status){
      ++coldQueries;
      assert.equal(vm.vm_directory_module_plan(9n,ticket,planAt),0);
      const offset=v.getUint32(planAt,true),bytes=v.getUint32(planAt+4,true),rank=v.getUint32(planAt+8,true),exports=v.getUint32(planAt+12,true);
      assert.equal(offset,blobAt);assert.equal(rank,index);assert.equal(exports,count);assert(bytes<expectedModule.length);
      const instance=await engines.get(data.subarray(offset,offset+bytes));
      const slot=v.getUint32(rows+16,true);table.set(slot,instance.exports[`cut.${rank}`]);
      assert.equal(vm.vm_directory_source_publish(9n,ticket,rows),0);
    }else ++warmQueries;
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);assert.equal(vm.vm_run(port,9n,1),1n);
    const expected=before,nativeAfter=(index*2+1)*1256;
    records.copy(expected,0,nativeAfter,nativeAfter+128);expected.writeBigUInt64LE(records.readBigUInt64LE(nativeAfter+392),392);
    expected.writeBigUInt64LE(address+5n,384);expected.writeBigUInt64LE(42n,1128);
    assert(data.subarray(state,state+1256).equals(expected),'complete native GPR/flags and unchanged C context');
    assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);++comparisons;
  }
  assert.equal(coldQueries,count*6,'130-coordinate loop genuinely exceeds the unchanged 64-row source owner');
  assert.equal(engines.stats().compilations,1,'one C-verified executable prefix, not per-miss reconstruction');
  // A miss may use neither caller-selected source metadata nor an old reply.
  seed(0);assert.equal(vm.vm_sources_reset(),0);assert.equal(vm.vm_source_query(port,entry+64n,1,codeView,rows),1n);
  const before=Buffer.from(data.subarray(state,state+1256));data.fill(0xa5,planAt,planAt+16);
  assert.equal(vm.vm_directory_module_plan(8n,ticket,planAt),-141);
  assert.equal(vm.vm_directory_module_plan(9n,ticket+1n,planAt),-141);
  assert.equal(vm.vm_directory_source_publish(9n,ticket+1n,rows),-141);
  assert(data.subarray(planAt,planAt+16).every(byte=>byte===0xa5));refusals+=3;
  // Equal-value restore cannot resurrect a source lease cancelled BEFORE a write.
  const immediate=entry+65n,old=data[payload(4)+65];
  assert.equal(vm.vm_access(port,immediate,1,2,BigInt(old^1)),0n);
  assert.equal(vm.vm_access(port,immediate,1,2,BigInt(old)),0n);
  assert(vm.vm_directory_source_publish(9n,ticket,rows)<0);++refusals;
  assert(data.subarray(state,state+1256).equals(before));
  assert.equal(vm.vm_source_query(port,entry+64n,1,codeView,rows),1n);
  assert.equal(vm.vm_directory_module_plan(9n,ticket,planAt),0);
  assert.equal(vm.vm_access(port,immediate,1,2,BigInt(old^1)),0n);
  assert.equal(vm.vm_source_query(port,entry+64n,1,codeView,rows),1n);
  assert.equal(vm.vm_directory_module_plan(9n,ticket,planAt),-152);++refusals;
  assert.equal(vm.vm_access(port,immediate,1,2,BigInt(old)),0n);
  put(state+384,entry+65n);assert.equal(vm.vm_source_query(port,entry+65n,1,codeView,rows),1n);
  assert.equal(vm.vm_directory_module_plan(9n,ticket,planAt),-153);++refusals;
  put(state+384,entry+64n);assert.equal(vm.vm_source_query(port,entry+64n,2,codeView,rows),1n);
  assert.equal(vm.vm_directory_module_plan(9n,ticket,planAt),-152);++refusals;
  vm.vm_directory_cancel_request();assert(vm.vm_directory_source_publish(9n,ticket,rows)<0);++refusals;
  if(crossFixture){
    const crossSource=await readFile(path.join(crossFixture,'crossing.source'));
    const crossModule=await readFile(path.join(crossFixture,'crossing.wasm'));
    const crossRoot=await readFile(path.join(crossFixture,'crossing.root-ref'));
    const offsets=[32,4094,4128],values=[17n,0x12345678n,29n];
    cold.set(crossSource,ci);assert.equal(cc.compiler_open_pages(ci,2,entry,9n),0);
    for(let i=0;i<3;++i){cv.setBigUint64(options+i*16,entry+BigInt(offsets[i]),true);
      cv.setUint32(options+i*16+8,1,true);cv.setUint32(options+i*16+12,65536,true);}
    assert.equal(cc.compiler_emit_projection(options,3,co,65536,cr),0);
    assert.equal(cv.getBigUint64(cr+40,true),BigInt(crossModule.length));
    assert(cold.subarray(co,co+crossModule.length).equals(crossModule));cc.compiler_close();
    for(let i=0;i<3;++i){
      reset(crossSource,crossRoot);const token=await load(crossFixture,crossModule,offsets[i]>>12);
      put(state+384,entry+BigInt(offsets[i]));put(state+392,0x202);put(state+1128,41);
      assert.equal(vm.vm_source_query(port,entry+BigInt(offsets[i]),1,codeView,rows),1n);
      let status=vm.vm_directory_module_plan(9n,token,planAt);
      if(i===1){
        assert.equal(status,-154,'only verified metadata can demand this crossing tail');
        assert.equal(vm.vm_source_extend(port,codeView,rows),1n);
        status=vm.vm_directory_module_plan(9n,token,planAt);
      }
      assert.equal(status,0);
      const codeOffset=v.getUint32(planAt,true),codeBytes=v.getUint32(planAt+4,true);
      const rank=v.getUint32(planAt+8,true);assert.equal(rank,i);
      const instance=await engines.get(data.subarray(codeOffset,codeOffset+codeBytes));
      const slot=v.getUint32(rows+16,true);table.set(slot,instance.exports[`cut.${rank}`]);
      assert.equal(vm.vm_directory_source_publish(9n,token,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
      assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(v.getBigUint64(state,true),values[i]);
      assert.equal(v.getBigUint64(state+384,true),entry+BigInt(offsets[i]+5));
      assert.equal(vm.vm_source_retired(),1n);++crossing;
    }
  }
} finally {for(let slot=firstSlot;slot<firstSlot+vm.vm_source_capacity();++slot)table.set(slot,null);engines.close();cc.compiler_close();vm.vm_close();}
console.log(JSON.stringify({format:'source-module-c-artifact-reuse-v1',status:'pass',nativeRows:count,comparisons,
  coldQueries,warmQueries,nodeReads,objectReads,refusals,crossing,sourceOwnerRows:64,reuseCompilerCalls:0,
  primaryEngineConstructions:1,totalEngineConstructions:engines.stats().compilations,
  authority:'local trusted compiler fixture root; not signed production root or complete executable domain',
  linuxBoot:'not-tested',wholeElf:'not-closed'},null,2));
