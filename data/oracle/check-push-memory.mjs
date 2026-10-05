// Independent x86 CPU/fault/RAM observations -> cold C -> real C MMU.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
const [providerFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('usage: check-push-memory.mjs VM.WASM COMPILER.WASM NATIVE-DIRECTORY');
const memory=new WebAssembly.Memory({initial:8}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),input=cc.compiler_arena_min();
const output=input+8192,report=output+65536,data=Buffer.from(memory.buffer),v=new DataView(memory.buffer);
const dir=vm.vm_arena_min(),rows=dir+512,base=dir+4096,port=base+2048,segments=base+1408;
const entry=0x400000n,stride=41*8,addresses=[0x12340000n,0x23450000n,0x200012340000n];
const payloads=[10,12,14].map(i=>base+(i+1)*4096),code=base+40960;
const at=physical=>base+(Number(physical/4096n)+1)*4096,put=(where,x)=>v.setBigUint64(where,BigInt(x),true);
const u64=(record,i)=>record.readBigUInt64LE(i*8),slot=vm.__indirect_function_table.grow(1);
const cpu=()=>Buffer.from(data.subarray(base,base+1256));
const payload=()=>Buffer.from(data.subarray(code,base+65536));
let parity=0,comparisons=0,directComparisons=0,rf=0,faults=0,refusals=0,waits=0,retries=0,aliases=0;
function reset(source,meta,record,row) {
  data.fill(0,base);
  for(const [first,end] of [[128,384],[432,488],[496,1128],[1136,1256]])data.fill(0x5a,base+first,base+end);
  seedDisabledDebug(v,base);
  for(let i=0;i<16;++i) {
    const where=dir+i*32;put(where,(i+1)*4096);v.setUint32(where+8,(i+2)*4096,true);
    v.setUint32(where+12,3,true);v.setUint32(where+16,1,true);data.fill(0,where+20,where+32);
  }
  put(at(0x1000n),0x2067);put(at(0x2000n),0x3067);
  put(at(0x1000n)+Number(addresses[2]>>39n&511n)*8,0x10067);put(at(0x10000n),0x7067);
  put(at(0x3000n)+2*8,0x4067);put(at(0x3000n)+145*8,0x5067);
  put(at(0x3000n)+282*8,0x6067);put(at(0x7000n)+145*8,0x8067);put(at(0x4000n),0x9067);
  const phase=row%16,stackOwner=phase===10?2:0;
  for(let owner=0;owner<3;++owner) {
    const table=[0x5000n,0x6000n,0x8000n][owner];
    for(let page=0;page<2;++page) {
      let rights=103n;
      if(owner===1&&(phase===3||phase===9)&&page===1)rights=0n;
      if(owner===0&&(meta.kind===0||meta.kind===5)&&phase===3&&page===1)rights=0n;
      if(owner===stackOwner&&phase===4&&page===1)rights=101n;
      if(owner===stackOwner&&phase===7&&page===1)rights=0n;
      if(owner===1&&phase===8)rights=101n;
      if(owner===stackOwner&&phase===14)rights=101n;
      put(at(table)+(Number(addresses[owner]>>12n&511n)+page)*8,
        rights?BigInt((10+owner*2+page)*4096)|rights:0n);
    }
    for(let byte=0;byte<8192;++byte)data[payloads[owner]+byte]=(byte*37+row+owner*91)&255;
  }
  data.set(source,code);
  for(let reg=0;reg<17;++reg)put(base+(reg===16?392:reg*8),u64(record,reg));
  put(base+384,entry);put(base+1128,42);put(base+400,0x80010011);put(base+408,0x1000);
  put(base+416,32);put(base+424,0xd00);put(base+488,19);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,16,16,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry);v.setUint32(rows+8,meta.sourceBytes,true);v.setUint32(rows+12,1,true);
  v.setUint32(rows+16,slot,true);v.setUint32(rows+20,0,true);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function expected(record,meta) {
  const state=cpu(),image=payload(),vector=u64(record,35);
  for(let reg=0;reg<16;++reg)state.writeBigUInt64LE(u64(record,17+reg),reg*8);
  state.writeBigUInt64LE(u64(record,33),392);state.writeBigUInt64LE(u64(record,34),384);
  if(!vector) {
    state.writeBigUInt64LE(43n,1128);
    const target=u64(record,38),owner=addresses.findIndex(a=>target>=a&&target+BigInt(meta.bytes)<=a+8192n);
    assert(owner>=0);
    for(let i=0;i<meta.bytes;++i)image[payloads[owner]+Number(target-addresses[owner])-code+i]=Number(u64(record,39)>>BigInt(i*8)&255n);
  }
  return {state,image,result:vector?vector<<3n|3n:1n};
}
function physical(address) {
  if(address>=entry&&address<entry+4096n)return 0x9000n;
  const owner=addresses.findIndex(a=>address>=a&&address<a+8192n);assert(owner>=0);
  return BigInt(10+2*owner)*4096n+(address-addresses[owner]&~4095n);
}
try {
  for(let form=0;form<28;++form) {
    const prefix=path.join(directory,`push-memory-${form}`),source=await readFile(`${prefix}.source-page`);
    const meta=JSON.parse(await readFile(`${prefix}.json`)),emitted=await readFile(`${prefix}.wasm`);
    const native=await readFile(`${prefix}.cases`);assert.equal(native.length,128*stride);
    cold.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,8,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));assert(cold.subarray(output,output+emitted.length).equals(emitted));++parity;
    const module=await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'},
      {module:'machine',name:'access',kind:'function'}]);
    const cut=(await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    for(let row=0;row<128;++row) {
      const record=native.subarray(row*stride,(row+1)*stride),vector=u64(record,35);
      reset(source,meta,record,row);const wanted=expected(record,meta);
      assert.equal(vm.vm_run(port,9n,1),vector?wanted.result:5n,`${form}/${row}: dispatch result`);
      assert(cpu().equals(wanted.state),`${form}/${row}: full CPU`);assert(payload().equals(wanted.image),`${form}/${row}: full payload`);
      assert.equal(vm.vm_completed(),vector?0:1);assert.equal(vm.vm_source_retired(),vector?0n:1n);++comparisons;
      if(vector) {
        assert.equal(v.getUint32(port+24,true),Number(vector));assert.equal(v.getUint32(port+28,true),Number(u64(record,36)));
        assert.equal(v.getBigUint64(port+16,true),u64(record,37),`${form}/${row}: fault coordinate`);++faults;
      }
      reset(source,meta,record,row);const hidden=Buffer.from(data.subarray(segments,segments+136));
      assert.equal(cut(base,port,entry),wanted.result);assert(cpu().equals(wanted.state));assert(payload().equals(wanted.image));
      assert(data.subarray(segments,segments+136).equals(hidden));++directComparisons;
      reset(source,meta,record,row);put(base+392,u64(record,16)|0x10000n);
      const rfState=Buffer.from(wanted.state);if(vector)rfState.writeBigUInt64LE(u64(record,16)|0x10000n,392);
      assert.equal(cut(base,port,entry),wanted.result);assert(cpu().equals(rfState));assert(payload().equals(wanted.image));++rf;
    }
    const first=native.subarray(0,stride);
    for(const failure of ['TF','AC','alias','wrap','stale']) {
      reset(source,meta,first,0);
      if(failure==='TF'||failure==='AC')put(base+392,0x202n|(failure==='TF'?256n:262144n));
      if(failure==='stale')put(port,8);
      const before=cpu(),image=payload();
      assert.equal(cut(base,failure==='alias'?base:failure==='wrap'?0xfffffff8:port,entry),failure==='stale'?5n:6n);
      assert(cpu().equals(before));assert(payload().equals(image));++refusals;
    }
    for(const dispatch of [false,true])for(const missing of ['source','stack-first','stack-second']) {
      // Row 1 has a valid split stack store. Source old RSP and destination
      // can occupy the same page: the first unavailable access wins naturally.
      const row=missing==='source'?0:1,record=native.subarray(row*stride,(row+1)*stride);
      assert.equal(u64(record,35),0n);
      reset(source,meta,record,row);const wanted=expected(record,meta);
      const address=missing==='source'?u64(record,40):u64(record,38)+(missing==='stack-second'?BigInt(meta.bytes-1):0n);
      const page=physical(address),index=Number(page/4096n)-1;
      v.setUint32(dir+index*32+16,3,true);const before=cpu(),image=payload();
      assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port,entry),2n,`${form}/${missing}: wait`);
      assert(cpu().equals(before));assert(payload().equals(image));
      assert.equal(v.getBigUint64(port+32,true)&~4095n,page);assert(v.getUint32(port+44,true)&16);
      if(dispatch){assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);}++waits;
      // Supply the exact deferred physical row; do not repair a guest PTE.
      v.setUint32(dir+index*32+16,1,true);
      assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port,entry),dispatch?5n:1n);
      assert(cpu().equals(wanted.state));assert(payload().equals(wanted.image));++retries;
    }
    if(meta.kind===1 || meta.kind===2 || meta.kind===3 || meta.kind===4) {
      // Architectural model, separate from the independent receipts: alias
      // the stack's physical page to the currently admitted executable page.
      // A completed write revokes execution, without rereading the instruction.
      reset(source,meta,first,0);put(at(0x5000n)+Number(addresses[0]>>12n&511n)*8,0x9067);
      const wanted=cpu(),image=payload(),rsp=u64(first,4),target=rsp-BigInt(meta.bytes);
      for(let i=0;i<meta.bytes;++i)image[Number(target-addresses[0])+i]=Number(u64(first,39)>>BigInt(i*8)&255n);
      wanted.writeBigUInt64LE(target,32);wanted.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);wanted.writeBigUInt64LE(43n,1128);
      assert.equal(vm.vm_run(port,9n,1),5n);assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);
      assert(cpu().equals(wanted));assert(payload().equals(image));
      assert.equal(vm.vm_run(port,9n,1),5n);assert.equal(vm.vm_completed(),0);assert(cpu().equals(wanted));++aliases;
    }
  }
}finally{vm.__indirect_function_table.set(slot,null);vm.vm_close();cc.compiler_close();}
console.log(JSON.stringify({format:'c-wasm-push-memory-native-v1',status:'pass',parity,comparisons,directComparisons,
  faults,rf,refusals,waits,retries,executableAliasModels:aliases,oracle:'actual x86 user-mode reference build VM; not physical hardware',
  linuxBoot:'not-tested',exceptionDelivery:'not-tested'},null,2));
