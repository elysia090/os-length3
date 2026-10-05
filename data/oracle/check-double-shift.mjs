// Independent x86 -> cold C lowering -> C memory owner and table dispatch.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
const [providerFile,compilerFile,directory,beforeDirectory]=process.argv.slice(2);
if(!directory)throw new Error('usage: check-double-shift.mjs VM.WASM COMPILER.WASM NATIVE-DIRECTORY [OBSERVE-ONLY-DIRECTORY]');
const memory=new WebAssembly.Memory({initial:8}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),input=cc.compiler_arena_min();
const output=input+8192,report=output+65536,data=Buffer.from(memory.buffer),v=new DataView(memory.buffer);
const dir=vm.vm_arena_min(),rows=dir+512,base=dir+4096,port=base+2048,segments=base+1408;
const entry=0x400000n,stride=43*8,addresses=[0x12340000n,0x200012340000n];
const payloads=[10,12].map(i=>base+(i+1)*4096),code=base+40960;
const at=physical=>base+(Number(physical/4096n)+1)*4096,put=(where,x)=>v.setBigUint64(where,BigInt(x),true);
const u64=(record,i)=>record.readBigUInt64LE(i*8),slot=vm.__indirect_function_table.grow(1);
const cpu=()=>Buffer.from(data.subarray(base,base+1256)),payload=()=>Buffer.from(data.subarray(code,base+65536));
let parity=0,comparisons=0,directComparisons=0,rf=0,faults=0,zeroWriteFaults=0,refusals=0,waits=0,retries=0,aliases=0,stable=0,undefinedDestinations=0;
function targetOffset(address) {
  if(address>=entry&&address<entry+4096n)return code+Number(address-entry);
  const owner=addresses.findIndex(a=>address>=a&&address<a+8192n);
  return owner<0?-1:payloads[owner]+Number(address-addresses[owner]);
}
function reset(source,meta,record,row) {
  data.fill(0,base);
  for(const [first,end] of [[128,384],[432,488],[496,1128],[1136,1256]])data.fill(0x5a,base+first,base+end);
  seedDisabledDebug(v,base);
  for(let i=0;i<16;++i) {
    const where=dir+i*32;put(where,(i+1)*4096);v.setUint32(where+8,(i+2)*4096,true);
    v.setUint32(where+12,3,true);v.setUint32(where+16,1,true);data.fill(0,where+20,where+32);
  }
  put(at(0x1000n),0x2067);put(at(0x2000n),0x3067);
  put(at(0x1000n)+Number(addresses[1]>>39n&511n)*8,0x10067);put(at(0x10000n),0x7067);
  put(at(0x3000n)+2*8,0x4067);put(at(0x3000n)+145*8,0x5067);
  put(at(0x7000n)+145*8,0x8067);put(at(0x4000n),0x9067);
  const phase=meta.kind===6?0:row<256?0:row%16,selected=phase===10&&meta.kind!==1?1:0;
  for(let owner=0;owner<2;++owner) {
    const table=owner?0x8000n:0x5000n;
    for(let page=0;page<2;++page) {
      let rights=103n;
      if(owner===selected) {
        if(phase===2&&page===1)rights=101n;
        if(phase===3&&page===1)rights=0n;
        if([4,7,14].includes(phase))rights=101n;
      }
      put(at(table)+(Number(addresses[owner]>>12n&511n)+page)*8,
        rights?BigInt((10+owner*2+page)*4096)|rights:0n);
    }
    for(let byte=0;byte<8192;++byte)data[payloads[owner]+byte]=(byte*37+row+owner*91)&255;
  }
  if(meta.kind===5&&[4,7,14].includes(phase))put(at(0x4000n),0x9065);
  data.set(source,code);
  const target=targetOffset(u64(record,38));
  if(meta.kind!==6&&target>=0)for(let i=0;i<meta.bytes;++i)data[target+i]=Number(u64(record,39)>>BigInt(i*8)&255n);
  for(let reg=0;reg<17;++reg)put(base+(reg===16?392:reg*8),u64(record,reg));
  put(base+384,entry);put(base+1128,42);put(base+400,0x80010011);put(base+408,0x1000);
  put(base+416,32);put(base+424,0xd00);put(base+488,19);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,16,16,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry);v.setUint32(rows+8,meta.sourceBytes,true);v.setUint32(rows+12,meta.instructions,true);
  v.setUint32(rows+16,slot,true);v.setUint32(rows+20,0,true);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function expected(record,meta) {
  const state=cpu(),image=payload(),vector=u64(record,35),defined=u64(record,42);
  for(let reg=0;reg<16;++reg) {
    let value=u64(record,17+reg);
    // Defined high parent and all other registers remain observable even
    // when a 16-bit overshift's low destination is architecturally undefined.
    if(meta.kind===6&&!defined&&reg===meta.destination)value&=~65535n;
    state.writeBigUInt64LE(value,reg*8);
  }
  state.writeBigUInt64LE(u64(record,33)&u64(record,41),392);state.writeBigUInt64LE(u64(record,34),384);
  if(!vector) {
    state.writeBigUInt64LE(42n+BigInt(meta.instructions),1128);
    if(meta.kind!==6) {
      const target=targetOffset(u64(record,38));assert(target>=code);
      for(let i=0;i<meta.bytes;++i)image[target-code+i]=Number((u64(record,40)&defined)>>BigInt(i*8)&255n);
    }
  }
  return {state,image,result:vector?vector<<3n|3n:1n,dispatchResult:vector?vector<<3n|3n:meta.kind===6?1n:5n};
}
function physical(address) {
  if(address>=entry&&address<entry+4096n)return 0x9000n;
  const owner=addresses.findIndex(a=>address>=a&&address<a+8192n);assert(owner>=0);
  return BigInt(10+2*owner)*4096n+(address-addresses[owner]&~4095n);
}
function compare(cut,wanted,label,dispatch=false) {
  assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port,entry),dispatch?wanted.dispatchResult:wanted.result,label);
  if(!cpu().equals(wanted.state)) {
    const differences=[];
    for(let i=0;i<1256;++i)if(data[base+i]!==wanted.state[i])differences.push([i,data[base+i],wanted.state[i]]);
    assert.fail(`${label}: full CPU ${JSON.stringify(differences.slice(0,16))}`);
  }
  assert(payload().equals(wanted.image),`${label}: entire RAM and code payload`);
  if(dispatch){assert.equal(vm.vm_completed(),wanted.result===1n?1:0);}
}
try {
  for(let form=0;form<222;++form) {
    const prefix=path.join(directory,`double-shift-${form}`),source=await readFile(`${prefix}.source-page`);
    const meta=JSON.parse(await readFile(`${prefix}.json`)),emitted=await readFile(`${prefix}.wasm`);
    const native=await readFile(`${prefix}.cases`);assert.equal(native.length,512*stride);
    if(beforeDirectory) {
      const before=await readFile(path.join(beforeDirectory,`double-shift-${form}.cases`));assert.equal(before.length,native.length);
      for(let row=0;row<512;++row) {
        const a=before.subarray(row*stride,(row+1)*stride),b=native.subarray(row*stride,(row+1)*stride);
        for(let rank=0;rank<43;++rank) {
          let mask=rank===33?u64(b,41):0xffffffffffffffffn;
          if(!u64(b,42)) {
            if(meta.kind===6&&rank===17+meta.destination)mask&=~65535n;
            if(meta.kind!==6&&rank===40)mask=0n;
          }
          assert.equal(u64(a,rank)&mask,u64(b,rank)&mask,`${form}/${row}/${rank}: independent observe-only observation`);
        }
        ++stable;
      }
    }
    cold.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,meta.instructions,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));assert(cold.subarray(output,output+emitted.length).equals(emitted));++parity;
    const module=await WebAssembly.compile(emitted),imports=[{module:'machine',name:'memory',kind:'memory'}];
    if(meta.kind!==6)imports.push({module:'machine',name:'reserve',kind:'function'},{module:'machine',name:'commit',kind:'function'});
    assert.deepEqual(WebAssembly.Module.imports(module),imports);
    const cut=(await WebAssembly.instantiate(module,{machine:{memory,reserve:vm.vm_reserve,commit:vm.vm_commit}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    for(let row=0;row<512;++row) {
      const record=native.subarray(row*stride,(row+1)*stride),vector=u64(record,35),label=`${form}/${row}`;
      reset(source,meta,record,row);const wanted=expected(record,meta);compare(cut,wanted,`${label}: dispatch`,true);++comparisons;
      assert.equal(vm.vm_source_retired(),vector?0n:BigInt(meta.instructions));
      if(!u64(record,42))++undefinedDestinations;
      if(vector) {
        assert.equal(v.getUint32(port+24,true),Number(vector));assert.equal(v.getUint32(port+28,true),Number(u64(record,36)));
        assert.equal(v.getBigUint64(port+16,true),u64(record,37),`${label}: fault coordinate`);++faults;
        const count=(meta.countKind?meta.count:Number(u64(record,1)&255n))&(meta.bytes===8?63:31);
        if(!count&&vector===14n&&(u64(record,36)&2n))++zeroWriteFaults;
      }
      reset(source,meta,record,row);const hidden=Buffer.from(data.subarray(segments,segments+136));
      compare(cut,wanted,`${label}: direct`);assert(data.subarray(segments,segments+136).equals(hidden));++directComparisons;
      reset(source,meta,record,row);put(base+392,u64(record,16)|0x10000n);
      const rfState=Buffer.from(wanted.state);if(vector)rfState.writeBigUInt64LE(u64(record,16)|0x10000n,392);
      compare(cut,{...wanted,state:rfState},`${label}: RF`);++rf;
    }
    const first=native.subarray(0,stride);
    for(const failure of meta.kind===6?['TF','state-align','state-wrap','RIP']:['TF','AC','alias','wrap','stale']) {
      reset(source,meta,first,0);
      if(failure==='TF'||failure==='AC')put(base+392,0x202n|(failure==='TF'?256n:262144n));
      if(failure==='stale')put(port,8);
      if(failure==='RIP')put(base+384,entry+1n);
      const before=cpu(),image=payload();
      const state=failure==='state-align'?base+1:failure==='state-wrap'?0xfffffff8:base;
      assert.equal(cut(state,failure==='alias'?base:failure==='wrap'?0xfffffff8:port,entry),failure==='stale'?5n:6n,`${form}: ${failure}`);
      assert(cpu().equals(before));assert(payload().equals(image));++refusals;
    }
    if(meta.kind!==6) {
      for(const dispatch of [false,true])for(const missing of ['first','second']) {
        const row=meta.kind===5?0:257,record=native.subarray(row*stride,(row+1)*stride);
        assert.equal(u64(record,35),0n);reset(source,meta,record,row);const wanted=expected(record,meta);
        const address=u64(record,38)+(missing==='second'?BigInt(meta.bytes-1):0n),page=physical(address),index=Number(page/4096n)-1;
        v.setUint32(dir+index*32+16,3,true);const before=cpu(),image=payload();
        assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port,entry),2n,`${form}/${missing}: wait`);
        assert(cpu().equals(before));assert(payload().equals(image));
        assert.equal(v.getBigUint64(port+32,true)&~4095n,page);assert(v.getUint32(port+44,true)&16);++waits;
        // Exact deferred physical row promoted by a serialized test owner;
        // this is not guest-PTE repair or signed production supply.
        v.setUint32(dir+index*32+16,1,true);compare(cut,wanted,`${form}/${missing}: retry`,dispatch);++retries;
      }
    }
    if(meta.kind===5) {
      reset(source,meta,first,0);const wanted=expected(first,meta);
      compare(cut,wanted,`${form}: executable write`,true);
      assert.equal(vm.vm_run(port,9n,1),5n);assert.equal(vm.vm_completed(),0);assert(cpu().equals(wanted.state));++aliases;
    }
  }
}finally{vm.__indirect_function_table.set(slot,null);vm.vm_close();cc.compiler_close();}
console.log(JSON.stringify({format:'c-wasm-double-shift-native-v1',status:'pass',parity,comparisons,directComparisons,
  faults,maskedZeroWriteFaults:zeroWriteFaults,undefinedDestinations,rf,refusals,waits,retries,executableAliasModels:aliases,
  stableNativeObservations:stable,oracle:'actual x86 user-mode reference build VM; not physical hardware',
  linuxBoot:'not-tested',exceptionDelivery:'not-tested'},null,2));
