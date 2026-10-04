// System-mode oracle rows -> actual C-Wasm event entry and compiled IRETQ.
// JavaScript prepares fixture inputs; guest frame/flags/CR2 and return semantics
// are entirely C. QEMU is only the independent fixture oracle, not this runtime.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [providerFile,compilerFile,recordsFile]=process.argv.slice(2);
if(!recordsFile)throw new Error('usage: check-exception.mjs VM.WASM COMPILER.WASM FRAMES.txt');
const rows=(await readFile(recordsFile,'utf8')).trim().split('\n').map(line=>line.trim().split(/\s+/).map(word=>BigInt(`0x${word}`)));
assert.equal(rows.length,128);
const provider=await WebAssembly.compile(await readFile(providerFile));
const compiler=await WebAssembly.compile(await readFile(compilerFile));
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
assert.deepEqual(WebAssembly.Module.imports(compiler),[{module:'machine',name:'memory',kind:'memory'}]);
const coldMemory=new WebAssembly.Memory({initial:16,maximum:32});
const cc=(await WebAssembly.instantiate(compiler,{machine:{memory:coldMemory}})).exports;
const input=cc.compiler_arena_min(), output=input+8192, report=output+65536;
const cold=new Uint8Array(coldMemory.buffer), coldView=new DataView(coldMemory.buffer);
async function cut(address,opcode,memory,vm){
  cold.fill(0x90,input,input+4096);cold.set(opcode,input+Number(address&4095n));
  assert.equal(cc.compiler_open_pages(input,1,address&~4095n,9n),0);
  assert.equal(cc.compiler_emit(address,1,output,65536,report),0);
  const bytes=Number(coldView.getBigUint64(report+40,true));
  const module=await WebAssembly.compile(cold.slice(output,output+bytes));
  return (await WebAssembly.instantiate(module,{machine:{memory,iret:vm.vm_iret,
    software_interrupt:vm.vm_software_interrupt}})).exports.cut;
}
let comparisons=0, compiledReturns=0, retiredRF=0, softwareTraps=0;
for(const row of rows){
  const kind=Number(row[0]>>5n),trap=kind===3;
  const vector=kind===0?14:kind===1?6:trap?3:13, first=kind===1||trap?0:1, words=first?6:5;
  const memory=new WebAssembly.Memory({initial:8,maximum:16});
  const vm=(await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
  const bytes=new Uint8Array(memory.buffer), view=new DataView(memory.buffer);
  const directory=vm.vm_arena_min(), branches=directory+1024, arena=directory+4096;
  const state=arena, segments=arena+1408, port=arena+2048, execution=directory+2048;
  const addresses=[0x1000n,0x2000n,0x3000n,0x4000n,0x5000n,0x9000n,row[6+first]&~4095n,row[1]&~4095n];
  const payload=i=>arena+(i+1)*4096;
  const put=(at,value)=>view.setBigUint64(at,BigInt(value),true);
  addresses.forEach((address,i)=>{
    put(directory+i*32,address);view.setUint32(directory+i*32+8,(i+1)*4096,true);
    view.setUint32(directory+i*32+12,3,true);view.setUint32(directory+i*32+16,1,true);
  });
  put(payload(0),0x2023);put(payload(1),0x3023);put(payload(2),0xe3);
  put(payload(3)+8,0x00af9b000000ffffn);put(payload(3)+16,0x00cf93000000ffffn);
  const gate=0x8e+(Number(row[0]>>4n)&1);
  put(payload(4)+vector*16,0x9000n|8n<<16n|BigInt(gate)<<40n);
  bytes.set([0x48,0xcf],payload(5));
  const origin=row[6+first]-(trap?1n:0n);
  bytes[payload(6)+Number(origin&4095n)]=trap?0xcc:0x90;
  assert.equal(vm.vm_open(arena,bytes.length-arena,4096,directory,8,8,branches,9n),0);
  put(state+32,row[1]);put(state+384,origin);put(state+392,row[2]);
  put(state+400,0x80010011);put(state+408,0x1000);put(state+416,32);put(state+424,0x500);
  put(state+432,0xabcdef);put(state+448,0x4000);put(state+456,23);
  put(state+464,0x5000);put(state+472,4095);put(state+488,8);put(state+496,16);put(state+1128,123);
  view.setUint32(segments,2,true);
  view.setUint32(segments+8+16+8,0xffffffff,true);view.setUint32(segments+8+16+12,0xa09b,true);
  view.setUint32(segments+8+32+8,0xffffffff,true);view.setUint32(segments+8+32+12,0xc093,true);
  put(port,9);put(port+16,0x400000);view.setUint32(port+24,vector,true);view.setUint32(port+28,vector===14?2:0,true);
  assert.equal(vm.vm_bind_state(state),0);assert.equal(vm.vm_bind_segments(segments),0);
  const slot=vm.vm_slot_min(),table=vm.__indirect_function_table;
  if(slot>=table.length)table.grow(slot-table.length+1);
  if(trap) {
    table.set(slot,await cut(origin,[0xcc],memory,vm));
    put(execution,origin);view.setUint32(execution+8,1,true);view.setUint32(execution+12,1,true);
    view.setUint32(execution+16,slot,true);assert.equal(vm.vm_bind_execution(execution,1,9n),0);
    assert.equal(vm.vm_run(port,9n,1),5n);assert.equal(vm.vm_completed(),1);
    assert.equal(vm.vm_source_retired(),1n);assert.equal(view.getBigUint64(state+1128,true),124n);
    ++softwareTraps;
  }else assert.equal(vm.vm_fault(port),0n);
  assert.equal(view.getBigUint64(state+32,true),row[3]);
  assert.equal(view.getBigUint64(state+392,true),row[4]);assert.equal(view.getBigUint64(state+432,true),row[12]);
  const stack=payload(7)+Number(row[3]&4095n);
  for(let i=0;i<words;++i)assert.equal(view.getBigUint64(stack+i*8,true),row[6+i]);
  if(first)put(state+32,row[3]+8n);
  const target=row[6+first];
  // No handler interpretation here: frame mutation is an explicit fixture
  // input, then the ordinary IRETQ instruction is compiled and dispatched.
  put(stack+first*8,target);
  const returnCut=await cut(0x9000n,[0x48,0xcf],memory,vm);
  table.set(slot,returnCut);
  put(execution,0x9000);view.setUint32(execution+8,2,true);view.setUint32(execution+12,1,true);view.setUint32(execution+16,slot,true);
  assert.equal(vm.vm_bind_execution(execution,1,9n),0);assert.equal(vm.vm_run(port,9n,1),5n);
  assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);
  assert.equal(view.getBigUint64(state+384,true),target);assert.equal(view.getBigUint64(state+32,true),row[1]);
  assert.equal(view.getBigUint64(state+392,true),row[13]|(trap?0n:0x10000n));++compiledReturns;
  const nop=await cut(target,[0x90],memory,vm);table.set(slot,nop);
  put(execution,target);view.setUint32(execution+8,1,true);
  assert.equal(vm.vm_bind_execution(execution,1,9n),0);assert.equal(vm.vm_run(port,9n,1),1n);
  assert.equal(view.getBigUint64(state+392,true),row[13]);assert.equal(view.getBigUint64(state+1128,true),trap?126n:125n);++retiredRF;
  table.set(slot,null);vm.vm_close();++comparisons;
}
assert.equal(comparisons,128);assert.equal(softwareTraps,32);
console.log(JSON.stringify({format:'c-wasm-exception-oracle-v1',status:'pass',comparisons,compiledReturns,retiredRF,softwareTraps,
  oracle:'QEMU TCG system-mode Multiboot fixture, not product execution',linuxBoot:'not-tested'},null,2));
