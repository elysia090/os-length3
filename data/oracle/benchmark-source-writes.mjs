// Equal C-MMU stores with a full source owner and a deliberate watch-bucket
// alias. Host setup is outside timing; Linux cold readiness is not measured.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [oldVm,newVm,compiler,mode]=process.argv.slice(2);
if(!compiler)throw new Error('BASELINE-VM.WASM CURRENT-VM.WASM COMPILER.WASM');
if(mode!==undefined&&mode!=='--walk-alias')throw new Error('optional --walk-alias');
const coldMemory=new WebAssembly.Memory({initial:64});
const cc=(await WebAssembly.instantiate(await readFile(compiler),{machine:{memory:coldMemory}})).instance.exports;
const cold=new Uint8Array(coldMemory.buffer),cv=new DataView(coldMemory.buffer),input=cc.compiler_arena_min();
const output=input+8192,report=output+65536,entry=0x400000n;
cold.fill(0xf8,input,input+8192);
assert.equal(cc.compiler_open_pages(input,2,entry,9n),0);
assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
const module=new WebAssembly.Module(cold.slice(output,output+Number(cv.getBigUint64(report+40,true))));
assert.equal(cv.getBigUint64(report+32,true),1n);assert.equal(cv.getBigUint64(report+24,true),1n);
const fixtures=[];
for(const file of [oldVm,newVm]){
  const memory=new WebAssembly.Memory({initial:64});
  const vm=(await WebAssembly.instantiate(await readFile(file),{machine:{memory}})).instance.exports;
  const a=new Uint8Array(memory.buffer),v=new DataView(memory.buffer),dir=vm.vm_arena_min(),cpu=dir+16384;
  const port=cpu+2048,segments=cpu+1408,rows=dir+512,codeView=port+64;
  const code=cpu+24576,destination=(mode?cpu+8192:code)+1048576,put=(at,x)=>v.setBigUint64(at,BigInt(x),true);
  const physical=[0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000];
  for(let i=0;i<physical.length;++i){const at=dir+i*32;put(at,physical[i]);
    v.setUint32(at+8,i===6?destination-cpu:(i+2)*4096,true);
    v.setUint32(at+12,3,true);v.setUint32(at+16,1,true);}
  put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);
  put(cpu+20480,0x8067);put(cpu+20488,0x9067);put(cpu+20480+256*8,0xa067);
  if(mode)for(let i=2;i<64;++i)put(cpu+20480+i*8,0x8067);
  put(cpu+400,0x80010001);put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0xd00);
  put(cpu+384,entry);put(cpu+392,2);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);a.fill(0xf8,code,code+8192);
  assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+2048,9n),0);
  assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(vm.vm_source_versions_start(dir+4096,1024,9n),0);
  // Product revisions already reject never-observed pages. Exercise the
  // remaining case: an observed page with no currently retained source row.
  assert.equal(vm.vm_source_query(port,0x500000n,1,codeView,rows),1n);
  assert.equal(vm.vm_source_publish(0,0,0,rows),-1);
  const revision=dir+4096+((destination-cpu)>>>12)*4;
  assert.equal(v.getUint32(revision,true),1);
  const fn=new WebAssembly.Instance(module,{machine:{memory}}).exports.cut;
  vm.__indirect_function_table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-vm.__indirect_function_table.length));
  for(let i=0;i<8192;++i){assert.equal(vm.vm_source_query(port,entry+BigInt(i),1,codeView,rows),1n);
    vm.__indirect_function_table.set(v.getUint32(rows+16,true),fn);
    assert.equal(vm.vm_source_publish(1,1,cv.getUint32(report+76,true),rows),0);}
  for(let i=0;i<8192;++i)assert.equal(vm.vm_source_query(port,entry+BigInt(i),1,codeView,rows),0n);
  if(mode)for(let i=0;i<64;++i)assert.equal(vm.vm_access(port,entry+BigInt(i*4096),8,1,0n),0n);
  fixtures.push({file,vm,port,a,destination,codeView,rows,revision,samples:[]});
}
const value=0x123456789abcdef0n,iterations=4096;
function writes(f,count){let result=0n;for(let i=0;i<count;++i)result|=f.vm.vm_access(f.port,0x500080n,8,2,value);assert.equal(result,0n);}
for(const f of fixtures)writes(f,128);
for(let round=0;round<7;++round)for(const index of round&1?[1,0]:[0,1]){
  const f=fixtures[index],start=performance.now();writes(f,iterations);f.samples.push(performance.now()-start);
}
for(const f of fixtures){const view=new DataView(f.a.buffer);assert.equal(view.getBigUint64(f.destination+128,true),value);
  assert.equal(view.getUint32(f.revision,true),1+128+7*iterations,'every observed-page write still advances construction revision');
  for(let i=0;i<8192;++i)assert.equal(f.vm.vm_source_query(f.port,entry+BigInt(i),1,f.codeView,f.rows),0n);}
const median=xs=>[...xs].sort((a,b)=>a-b)[3];
const runs=fixtures.map(f=>({file:f.file,medianMs:median(f.samples),samples:f.samples}));
console.log(JSON.stringify({format:'c-source-write-frontier-benchmark-v1',alias:mode?'paging-ancestor':'source-page',sourceRows:8192,
  storesPerSample:iterations,rounds:7,runs,ratio:runs[1].medianMs/runs[0].medianMs,
  scope:'actual C MMU/data stores with product revisions and full source ownership; observed-but-not-retained page, every revision advances, all8192 rows still admitted and stored value exact; deliberate256-page watcher alias, not general Linux speedup'},null,2));
