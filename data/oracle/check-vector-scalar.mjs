// Independent native x86 -> common cold compiler -> real C MMU/dispatcher.
// A precise transfer/fault test, not SIMD arithmetic or Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';
const [providerFile,compilerFile,directory,beforeDirectory,...extra]=process.argv.slice(2);
if(!directory || extra.length)throw new Error('usage: check-vector-scalar.mjs VM.wasm COMPILER.wasm NATIVE-DIRECTORY [OBSERVE-ONLY-DIRECTORY]');
const memory=new WebAssembly.Memory({initial:8}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const engines=new CompiledModules({machine:{memory,access:vm.vm_access}});
const cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),input=cc.compiler_arena_min();
const output=input+8192,report=output+65536,data=Buffer.from(memory.buffer),v=new DataView(memory.buffer);
const dir=vm.vm_arena_min(),rows=dir+512,base=dir+4096,port=base+2048,segments=base+1408;
const entry=0x400000n,address=0x12340000n,stride=2576,code=base+40960,payload=base+45056;
const at=physical=>base+(Number(physical/4096n)+1)*4096;
const put=(where,x)=>v.setBigUint64(where,BigInt(x),true),u64=(r,i)=>r.readBigUInt64LE(2512+i*8);
const slot=vm.__indirect_function_table.grow(1),cpu=()=>Buffer.from(data.subarray(base,base+1256));
const image=()=>Buffer.from(data.subarray(code,payload+8192));
let parity=0,comparisons=0,direct=0,rfComparisons=0,faults=0,controls=0,waits=0,refusals=0,stable=0,aliases=0,halfModels=0;
function target(where) {
  if(where>=entry&&where+16n<=entry+4096n)return code+Number(where-entry);
  return where>=address&&where+16n<=address+8192n?payload+Number(where-address):-1;
}
function reset(source,meta,r,row) {
  data.fill(0,base);data.set(r.subarray(0,1256),base);
  for(let i=0;i<12;++i) {
    const where=dir+i*32;put(where,(i+1)*4096);v.setUint32(where+8,(i+2)*4096,true);
    v.setUint32(where+12,3,true);v.setUint32(where+16,1,true);data.fill(0,where+20,where+32);
  }
  put(at(0x1000n),0x2067);put(at(0x2000n),0x3067);put(at(0x3000n)+2*8,0x4067);
  put(at(0x3000n)+145*8,0x5067);put(at(0x4000n),meta.kind===4&&row%16===4?0x9065:0x9067);
  for(let page=0;page<2;++page) {
    const phase=row%16,rights=phase===3&&page===1?0n:phase===4||phase===2&&page===1?101n:103n;
    put(at(0x5000n)+(Number(address>>12n&511n)+page)*8,rights?BigInt((10+page)*4096)|rights:0n);
  }
  data.set(source,code);for(let i=0;i<8192;++i)data[payload+i]=(i*37+row)&255;
  const where=target(u64(r,0));if(where>=0){put(where,u64(r,1));put(where+8,u64(r,2));}
  put(port,9);put(port+8,0xa523841978665512n);put(port+48,0x257834162954def1n);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,12,12,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry);v.setUint32(rows+8,meta.sourceBytes,true);v.setUint32(rows+12,1,true);
  v.setUint32(rows+16,slot,true);v.setUint32(rows+20,cv.getUint32(report+76,true),true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function expected(r,meta,rf=0n) {
  const state=Buffer.from(r.subarray(1256,2512)),bytes=image(),vector=u64(r,5);
  if(vector)state.writeBigUInt64LE(state.readBigUInt64LE(392)|rf,392);
  if(meta.store&&!meta.register&&!vector){bytes.writeBigUInt64LE(u64(r,3),target(u64(r,0))-code);bytes.writeBigUInt64LE(u64(r,4),target(u64(r,0))-code+8);}
  return {state,bytes,result:vector?vector<<3n|3n:1n,write:!!meta.store&&!meta.register&&!vector};
}
function compare(cut,wanted,label,dispatch=false) {
  const low=v.getBigUint64(port+8,true),high=v.getBigUint64(port+48,true);
  assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port,entry,v.getUint32(rows+20,true)),dispatch&&wanted.write?5n:wanted.result,label);
  if(!cpu().equals(wanted.state)) {
    const delta=[];for(let i=0;i<1256;++i)if(data[base+i]!==wanted.state[i])delta.push([i,data[base+i],wanted.state[i]]);
    assert.fail(`${label}: complete CPU ${JSON.stringify(delta.slice(0,16))}`);
  }
  assert(image().equals(wanted.bytes),`${label}: whole RAM/code payload`);
  // A dispatcher has already used the scalar port for independent code fetch.
  // Only the direct instruction boundary promises the incoming scalar survives.
  if(wanted.result!==1n&&!dispatch){assert.equal(v.getBigUint64(port+8,true),low,`${label}: scalar value`);}
  assert.equal(v.getBigUint64(port+48,true),high,`${label}: unused pair field`);
  if(dispatch){assert.equal(vm.vm_completed(),wanted.result===1n?1:0);assert.equal(vm.vm_source_retired(),wanted.result===1n?1n:0n);}
}
try {
  for(let form=0;form<156;++form) {
    const prefix=path.join(directory,`vector-scalar-${form}`),source=await readFile(`${prefix}.source-page`);
    const meta=JSON.parse(await readFile(`${prefix}.json`)),emitted=await readFile(`${prefix}.wasm`),records=await readFile(`${prefix}.cases`);
    assert.equal(meta.recordBytes,stride);assert.equal(meta.stateBytes,1256);assert.equal(records.length,meta.native*stride);
    if(beforeDirectory){assert(records.equals(await readFile(path.join(beforeDirectory,`vector-scalar-${form}.cases`))),`${form}: independent observe-only records unchanged`);stable+=meta.native;}
    cold.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,8,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));assert(cold.subarray(output,output+emitted.length).equals(emitted));++parity;
    const module=await WebAssembly.compile(emitted);
    const imports=[{module:'machine',name:'memory',kind:'memory'}];
    if(!meta.register)imports.push({module:'machine',name:'access',kind:'function'});
    assert.deepEqual(WebAssembly.Module.imports(module),imports);
    const cut=(await engines.get(emitted)).exports.cut;vm.__indirect_function_table.set(slot,cut);
    if(meta.selectedHalf) {
      // Substitute a valid one-page coordinate with the NEXT page absent.
      // The exact eight-byte operand must succeed; a widened pair read fails.
      // Every crossing split then fails without publishing any selected half.
      const first=records.subarray(0,stride);
      if(meta.kind===1)for(const dispatch of [false,true])for(let split=0;split<8;++split) {
        reset(source,meta,first,0);const start=4096-8+split;
        put(base+56,address+BigInt(start));put(at(0x5000n)+(Number(address>>12n&511n)+1)*8,0n);
        const wanted={state:cpu(),bytes:image(),result:split?14n<<3n|3n:1n,write:!!meta.store&&!split};
        if(!split) {
          const offset=128+meta.xmm*16+meta.high*8;
          if(meta.store)wanted.bytes.writeBigUInt64LE(v.getBigUint64(base+offset,true),payload+start-code);
          else wanted.state.writeBigUInt64LE(v.getBigUint64(payload+start,true),offset);
          wanted.state.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);wanted.state.writeBigUInt64LE(43n,1128);
        }
        compare(cut,wanted,`${form}: exact half extent/split ${split}`,dispatch);
        if(split){assert.equal(v.getUint32(port+24,true),14);assert.equal(v.getBigUint64(port+16,true),address+4096n);}
        ++halfModels;
      }
    }
    for(let row=0;row<meta.native;++row) {
      const r=records.subarray(row*stride,(row+1)*stride);
      for(const dispatch of [false,true])for(const rf of [0n,0x10000n]) {
        reset(source,meta,r,row);put(base+392,v.getBigUint64(base+392,true)|rf);
        compare(cut,expected(r,meta,rf),`${form}/${row}/${dispatch}/${rf}`,dispatch);
        if(u64(r,5)) {
          assert.equal(v.getUint32(port+24,true),Number(u64(r,5)));assert.equal(v.getUint32(port+28,true),Number(u64(r,6)));
          if(u64(r,5)===14n)assert.equal(v.getBigUint64(port+16,true),u64(r,7));++faults;
        }
        if(rf)++rfComparisons;else if(dispatch)++comparisons;else ++direct;
      }
    }
    // Model-only control faults: a user-mode native oracle cannot write CR0/4.
    const first=records.subarray(0,stride);
    for(const dispatch of [false,true])for(const em of [0n,4n])for(const ts of [0n,8n])for(const osfxsr of [0n,512n]) {
      if(!em&&!ts&&osfxsr)continue;
      reset(source,meta,first,0);put(base+400,v.getBigUint64(base+400,true)|em|ts);put(base+416,32n|osfxsr);
      assert.equal(vm.vm_bind_execution(rows,1,9n),0);
      const vector=em||!osfxsr?6n:7n;
      compare(cut,{state:cpu(),bytes:image(),result:vector<<3n|3n},`${form}: control priority`,dispatch);
      assert.equal(v.getUint32(port+24,true),Number(vector));assert.equal(v.getUint32(port+28,true),0);++controls;
    }
    if(!meta.register && meta.kind!==4)for(const dispatch of [false,true]) {
      const row=1,r=records.subarray(row*stride,(row+1)*stride),page=10;
      reset(source,meta,r,row);v.setUint32(dir+page*32+16,3,true);
      compare(cut,{state:cpu(),bytes:image(),result:2n},`${form}: whole operand waits`,dispatch);++waits;
      v.setUint32(dir+page*32+16,1,true);compare(cut,expected(r,meta),`${form}: same instruction retries`,dispatch);++waits;
    }
    if(form>=100 && form<108)aliases+=meta.native;
    for(const badPort of [port+1,base,base+8,base+1248,data.length-24,-1]) {
      reset(source,meta,first,0);compare((state)=>cut(state,badPort,entry,v.getUint32(rows+20,true)),{state:cpu(),bytes:image(),result:6n},`${form}: private port`);++refusals;
    }
    for(const badState of [base+1,0xfffffff8,data.length-1248]) {
      reset(source,meta,first,0);const before=cpu(),bytes=image();assert.equal(cut(badState,port,entry,v.getUint32(rows+20,true)),6n);assert(cpu().equals(before));assert(image().equals(bytes));++refusals;
    }
    for(const dispatch of [false,true])for(const flag of meta.register?[0x100n]:[0x100n,0x40000n]) {
      reset(source,meta,first,0);put(base+392,v.getBigUint64(base+392,true)|flag);
      compare(cut,{state:cpu(),bytes:image(),result:6n},`${form}: debug/alignment context`,dispatch);++refusals;
    }
    reset(source,meta,first,0);put(port,8);assert.equal(vm.vm_run(port,9n,1),5n);assert(cpu().equals(first.subarray(0,1256)));++refusals;
  }
  // The precise shipped Linux gate differs from the high-XMM native fixtures.
  cold.fill(0x90,input,input+4096);cold.set([0x66,0x44,0x0f,0x6e,0xf9],input+0xdc2);
  assert.equal(cc.compiler_open_pages(input,1,0xffffffff81204000n,9n),0);
  assert.equal(cc.compiler_emit(0xffffffff81204dc2n,8,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+24,true),1n);assert.equal(cv.getUint32(report+68,true),0);
  cold.fill(0x90,input,input+4096);cold.set([0x0f,0x16,0x05,0x88,0xb8,0,0],input+0x51);
  assert.equal(cc.compiler_open_pages(input,1,0x7ff37faf2000n,9n),0);
  assert.equal(cc.compiler_emit(0x7ff37faf2051n,8,output,65536,report),0,'exact measured MOVHPS gate');
  assert.equal(cv.getBigUint64(report+24,true),1n);assert.equal(cv.getUint32(report+68,true),8);
  console.log(JSON.stringify({status:'pass',nativeColdParity:parity,stableIndependentNativeObservations:stable,
    directComparisons:direct,dispatchComparisons:comparisons,rfComparisons,independentNativeFaultComparisons:faults,
    controlPriorityModels:controls,waitRetryModels:waits,entryRefusals:refusals,nativeXmmOnlyObservations:aliases,exactHalfExtentModels:halfModels,
    shippedGate:'common C compilation accepted; not executed by this fixture',
    oracle:'actual native x86 in independent build VM; CR0/CR4 models; not physical hardware or SIMD arithmetic',
    linuxBoot:'not-tested'}));
} finally {vm.__indirect_function_table.set(slot,null);engines.close();vm.vm_close();}
