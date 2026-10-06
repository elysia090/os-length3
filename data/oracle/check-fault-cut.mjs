// Pending architectural faults, not a substitute Linux execution backend.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
if(!compilerFile)throw new Error('VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const dir=vm.vm_arena_min(),base=dir+4096,port=base+2048,segments=base+1408,rows=dir+512;
const codeView=port+64,code=base+24576,tail=base+28672,leaf=base+20480;
const table=vm.__indirect_function_table,first=vm.vm_slot_min();
table.grow(Math.max(0,first+vm.vm_source_capacity()-table.length));
const put=(at,x)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true);
const cpu=()=>Buffer.from(data.subarray(base,base+1256));
function reset(entry,flags){
  vm.vm_close();data.fill(0,dir);
  for(let i=0;i<6;++i){put(dir+i*32,i<4?(i+1)*4096:(i+4)*4096);
    v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);}
  put(base+8192,0x2067);put(base+12288,0x3067);put(base+16384+16,0x4067);
  put(leaf,0x8067);put(leaf+8,0x9007n|(1n<<63n));
  for(let i=0;i<16;++i)put(base+i*8,BigInt(i+1)*0x123456789abn);
  put(base+384,entry);put(base+392,flags);put(base+400,0x80010011);put(base+408,0x1000);
  put(base+416,32);put(base+424,0xd00);put(base+488,8);put(base+1128,41);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
  data.fill(0x90,code,tail+4096);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,6,6,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
async function compile(entry,count=1,limit=1){
  cold.set(data.subarray(code,code+4096),input);
  if(count===2)cold.set(data.subarray(tail,tail+4096),input+4096);
  assert.equal(cc.compiler_open_pages(input,count,0x400000n,9n),0);
  cold.fill(0xa5,output,report+80);
  const status=cc.compiler_emit(entry,limit,output,65536,report);
  if(status){assert(cold.subarray(output,report+80).every(x=>x===0xa5));return {status};}
  const n=Number(cv.getBigUint64(report+40,true)),module=Buffer.from(cold.subarray(output,output+n));
  assert.deepEqual(WebAssembly.Module.imports(await WebAssembly.compile(module)),[{module:'machine',name:'memory',kind:'memory'}]);
  const cut=(await WebAssembly.instantiate(module,{machine:{memory}})).instance.exports.cut;
  return {status,cut,module,bytes:Number(cv.getBigUint64(report+32,true)),instructions:Number(cv.getBigUint64(report+24,true))};
}
const forms=[
  {bytes:[0x06],vector:6},{bytes:[0xf0,0x90],vector:6},{bytes:[0x0f,0x0b],vector:6},
  {bytes:[0xf0,0xf4],vector:6},{bytes:[0xf3,0x0f,0x0b],vector:6},
  {bytes:Array(15).fill(0x66),vector:13},
  // Absent AVX/AES/XSAVE are #UD under the fixed CPUID profile. Even their
  // memory operands must not be touched. Host feature observations are not used.
  {bytes:[0xc5,0xf8,0x10,0x07],vector:6},
  {bytes:[0x66,0x0f,0x38,0xdc,0x07],vector:6},
  {bytes:[0x0f,0xae,0x27],vector:6},
];
let direct=0,dispatch=0,priority=0,refusals=0,prefix=0;let udBody;
for(const form of forms)for(const flags of [2,0x203,0x10203,0x20203]){
  const entry=0x401000n-BigInt(form.bytes.length);reset(entry,flags);
  data.set(form.bytes,code+4096-form.bytes.length);put(base+56,0x8000000000000000n);
  const result=await compile(entry);assert.equal(result.status,0);assert.equal(result.bytes,form.bytes.length);
  assert.equal(result.instructions,1);assert.equal(cv.getBigUint64(report+8,true),entry);
  if(form.vector===6){if(udBody)assert(result.module.equals(udBody));else udBody=result.module;}
  const expected=cpu(),fault=BigInt(3|(form.vector<<3));
  data.fill(0xa5,port+8,port+64);assert.equal(result.cut(base,port,entry,0),fault);
  assert(cpu().equals(expected));assert.equal(v.getBigUint64(port+16,true),entry);
  assert.equal(v.getUint32(port+24,true),form.vector);assert.equal(v.getUint32(port+28,true),0);++direct;
  // Bad/overlapping reservations refuse without a Wasm trap or visible write.
  for(const [stateAt,portAt]of [[base+1,port],[base,base],[base,port+1],[data.length-8,port]]){
    const saved=Buffer.from(data);assert.equal(result.cut(stateAt,portAt,entry,0),6n);
    assert(data.equals(saved));++refusals;
  }
  v.setUint32(segments+4,2,true);
  assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);
  assert.equal(v.getUint32(codeView+44,true),0);
  table.set(v.getUint32(rows+16,true),result.cut);
  assert.equal(vm.vm_source_publish(result.bytes,1,0,rows),0);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  assert.equal(vm.vm_run(port,9n,1),fault);assert.equal(vm.vm_source_retired(),0n);assert.equal(vm.vm_completed(),0);
  assert(cpu().equals(expected));assert.equal(v.getUint32(segments+4,true),2);
  assert.equal(v.getBigUint64(leaf+8,true),0x9007n|(1n<<63n));++dispatch;++priority;
}
// An incomplete decisive prefix requires the next page; #PF/NX takes priority.
for(const pte of [0n,0x9007n|(1n<<63n)]){
  const entry=0x400fffn;reset(entry,0x10203);data[code+4095]=0x0f;data[tail]=0x0b;put(leaf+8,pte);
  const before=cpu();assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);
  assert.equal((await compile(entry)).status,-105);
  assert.equal(vm.vm_source_extend(port,codeView,rows),115n);
  assert.equal(v.getUint32(port+28,true),pte?17:16);assert(cpu().equals(before));++priority;
}
reset(0x400fffn,0x10203);data[code+4095]=0x0f;data[tail]=0x0b;put(leaf+8,0x9067);
assert.equal(vm.vm_source_query(port,0x400fffn,1,codeView,rows),1n);
assert.equal(vm.vm_source_extend(port,codeView,rows),1n);
const crossing=await compile(0x400fffn,2);assert.equal(crossing.bytes,2);
table.set(v.getUint32(rows+16,true),crossing.cut);assert.equal(vm.vm_source_publish(2,1,0,rows),0);
assert.equal(vm.vm_bind_execution(rows,1,9n),0);const crossed=cpu();
assert.equal(vm.vm_run(port,9n,1),51n);assert(cpu().equals(crossed));++dispatch;
// Retire a successful prefix first; no speculative fault/RF publication.
reset(0x400000n,0x10203);data.set([0x90,0x0f,0x0b],code);
const preceding=await compile(0x400000n,1,8);assert.equal(preceding.bytes,1);
assert.equal(preceding.cut(base,port,0x400000n,0),1n);assert.equal(v.getBigUint64(base+1128,true),42n);
assert.equal(v.getBigUint64(base+384,true),0x400001n);assert.equal(v.getBigUint64(base+392,true),0x203n);
const afterPrefix=cpu(),next=await compile(0x400001n);
assert.equal(next.cut(base,port,0x400001n,0),51n);assert(cpu().equals(afterPrefix));++prefix;
// Valid unsupported RCL cannot be mislabeled #UD just to obtain closure.
reset(0x400000n,2);data.set([0x48,0xd1,0xd0],code);
assert.equal((await compile(0x400000n)).status,-102);++refusals;
vm.vm_close();
console.log(JSON.stringify({format:'fault-cut-c-wasm-v1',status:'pass',direct,dispatch,priority,refusals,prefix,
  oracle:'six native page-end #UD/#GP forms; fixed-profile feature/RF/shadow/MMU models separate',linuxBoot:'not-tested'},null,2));
