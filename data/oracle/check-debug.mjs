// Generated MOV DR -> C owner, with independent fixed-profile SDM models.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,directory]=process.argv.slice(2);
if (!directory) throw new Error('usage: check-debug.mjs VM.WASM CUT-DIRECTORY');
const provider=await WebAssembly.compile(await readFile(vmFile));
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
const files=(await readdir(directory)).filter(name=>/^debug-.*\.json$/.test(name));
assert.equal(files.length,768);
const values=Array.from({length:64},(_,bit)=>1n<<BigInt(bit));
values.push(0n,0xffffffffffffffffn,0xffff0ff0n,0xffff23ffn,0x400n,
  0x7fffffffffffn,0x800000000000n,0xffff7fffffffffffn,0xffff800000000000n);
let comparisons=0,dispatches=0,refusals=0;
for (const file of files) {
  const prefix=path.join(directory,file.slice(0,-5));
  const meta=JSON.parse(await readFile(`${prefix}.json`));
  const module=await WebAssembly.compile(await readFile(`${prefix}.wasm`));
  assert.deepEqual(WebAssembly.Module.imports(module),[
    {module:'machine',name:'memory',kind:'memory'},{module:'machine',name:'debug',kind:'function'}]);
  const memory=new WebAssembly.Memory({initial:8});
  const vm=(await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
  const cut=(await WebAssembly.instantiate(module,{machine:{memory,debug:vm.vm_debug}})).exports.cut;
  const view=new DataView(memory.buffer),bytes=Buffer.from(memory.buffer);
  const dir=vm.vm_arena_min(),rows=dir+512,state=dir+4096,segments=state+1408,port=state+2048;
  const put=(at,v)=>view.setBigUint64(at,BigInt(v),true);
  const entry=BigInt(meta.entry),target=meta.debug===4 || meta.debug===5 ? meta.debug+2 : meta.debug;
  for (let i=0;i<5;++i) {
    put(dir+i*32,i<4 ? (i+1)*4096 : 0x8000); view.setUint32(dir+i*32+8,(i+2)*4096,true);
    view.setUint32(dir+i*32+12,3,true); view.setUint32(dir+i*32+16,1,true);
  }
  for (let i=0;i<4;++i) put(state+(i+2)*4096+Number((entry>>[39n,30n,21n,12n][i])&511n)*8,
    BigInt(i===3 ? 0x8000 : (i+2)*4096)|103n);
  bytes.set(await readFile(`${prefix}.source-page`),state+24576);
  const table=vm.__indirect_function_table,slot=table.grow(1);table.set(slot,cut);
  put(rows,entry);view.setUint32(rows+8,meta.sourceBytes,true);view.setUint32(rows+12,1,true);
  view.setUint32(rows+16,slot,true);
  function reset(cpl,gd,value) {
    bytes.fill(0,state,state+4096);
    for (let reg=0;reg<16;++reg) put(state+reg*8,0xabcdef0100000000n+BigInt(reg));
    put(state+meta.reg*8,value);put(state+384,entry);put(state+392,0x10202);
    put(state+400,0x80010011);put(state+408,0x1000);put(state+416,32);put(state+424,0x500);
    put(state+488,8|cpl);put(state+1128,42);
    for (let rank=0;rank<6;++rank) put(state+544+rank*8,0xa5a5a5a5a5a5a5a5n+BigInt(rank));
    put(state+592,0xffff0ff0);put(state+600,0x400|(gd ? 0x2000 : 0));
    view.setUint32(segments,2,true);view.setUint32(segments+36,0xa09b,true);put(port,9);
    assert.equal(vm.vm_open(state,bytes.length-state,4096,dir,5,5,dir+1024,9n),0);
    assert.equal(vm.vm_bind_state(state),0);assert.equal(vm.vm_bind_segments(segments),0);
  }
  for (let cpl=0;cpl<4;++cpl) for (let gd=0;gd<2;++gd) for (const value of values) {
    if (!meta.write && value!==0n) continue;
    reset(cpl,gd,value);
    const vector=cpl ? 13 : gd ? 1 : meta.write && target>=6 && value>>32n ? 13 : 0;
    const expected=Buffer.from(bytes.subarray(state,state+1256));
    const hidden=Buffer.from(bytes.subarray(segments,segments+136));
    if (vector===1) expected.writeBigUInt64LE(0xffff2ff0n,592);
    if (!vector) {
      if (meta.write) expected.writeBigUInt64LE(target<6 ? value : target===6
        ? (value&0xe00fn)|0xffff0ff0n : (value&0xffff23ffn)|0x400n,544+target*8);
      else expected.writeBigUInt64LE(expected.readBigUInt64LE(544+target*8),meta.reg*8);
      expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);
      expected.writeBigUInt64LE(0x202n,392);expected.writeBigUInt64LE(43n,1128);
    }
    assert.equal(cut(state,port),vector ? BigInt(vector*8+3) : 1n,`${file} CPL${cpl} GD${gd} ${value.toString(16)}`);
    assert.deepEqual(bytes.subarray(state,state+1256),expected);
    assert.deepEqual(bytes.subarray(segments,segments+136),hidden);
    if (vector) {assert.equal(view.getUint32(port+24,true),vector);assert.equal(view.getUint32(port+28,true),0);}
    ++comparisons;
  }
  reset(0,0,0x400n);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);++dispatches;
  for (let bit=0;bit<8;++bit) {
    reset(0,0,0n);put(state+600,1n<<BigInt(bit));
    const before=Buffer.from(bytes.subarray(state,state+4096));
    assert.equal(cut(state,port),6n);assert.deepEqual(bytes.subarray(state,state+4096),before);
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);assert.equal(vm.vm_run(port,9n,1),6n);
    assert.equal(vm.vm_completed(),0);assert.deepEqual(bytes.subarray(state,state+4096),before);++refusals;
  }
  for (const badPort of [state,segments,port+1,0xfffffff8]) {
    reset(0,0,0n);const before=Buffer.from(bytes.subarray(state,state+4096));
    assert.equal(cut(state,badPort),6n);assert.deepEqual(bytes.subarray(state,state+4096),before);++refusals;
  }
  reset(0,0,0n);put(port,8);const before=Buffer.from(bytes.subarray(state,state+4096));
  assert.equal(cut(state,port),5n);assert.deepEqual(bytes.subarray(state,state+4096),before);++refusals;
  reset(0,0,0n);assert.equal(vm.vm_reserve(port,entry,8,3),0n);
  assert.equal(vm.vm_debug(port,2,0,0n),6n);assert.equal(vm.vm_commit(port,0n),6n);++refusals;
}
console.log(JSON.stringify({format:'c-wasm-debug-register-v1',status:'pass',modules:files.length,
  comparisons,dispatches,refusals,debugException:'pending fault only; #DB delivery remains explicit',
  activeBreakpoints:'refused before fetch/call',linuxBoot:'not-tested'},null,2));
