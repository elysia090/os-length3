// Independent native x86 -> common cold compiler -> real C MMU/dispatcher.
// Precise transfers, packed add, bitwise logic, unpack and shuffle, not FP arithmetic or Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';
const [providerFile,compilerFile,directory,beforeDirectory,...extra]=process.argv.slice(2);
if(!directory || extra.length)throw new Error('usage: check-vector-transfer.mjs VM.wasm COMPILER.wasm NATIVE-DIRECTORY [OBSERVE-ONLY-DIRECTORY]');
const memory=new WebAssembly.Memory({initial:8}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const engines=new CompiledModules({machine:{memory,read_pair:vm.vm_read_pair,
  write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end}});
const cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),input=cc.compiler_arena_min();
const output=input+8192,report=output+65536,data=Buffer.from(memory.buffer),v=new DataView(memory.buffer);
const dir=vm.vm_arena_min(),rows=dir+512,base=dir+4096,port=base+2048,segments=base+1408;
const entry=0x400000n,address=0x12340000n,stride=2576,code=base+40960,payload=base+45056;
const at=physical=>base+(Number(physical/4096n)+1)*4096;
const put=(where,x)=>v.setBigUint64(where,BigInt(x),true),u64=(r,i)=>r.readBigUInt64LE(2512+i*8);
const slot=vm.__indirect_function_table.grow(1),cpu=()=>Buffer.from(data.subarray(base,base+1256));
const image=()=>Buffer.from(data.subarray(code,payload+8192));
let parity=0,comparisons=0,direct=0,rfComparisons=0,faults=0,controls=0,waits=0,refusals=0,stable=0,aliases=0,pairRefusals=0,carryModels=0,exhaustiveByteModels=0,shuffleSelectorModels=0,simdRefusalModels=0;
function packedAdd(a,b,width) {
  const bits=BigInt(width),mask=(1n<<bits)-1n;let value=0n;
  for(let bit=0n;bit<64n;bit+=bits)value|=(((a>>bit&mask)+(b>>bit&mask))&mask)<<bit;
  return value;
}
function byteShuffle(values,selectors) {
  const result=Buffer.alloc(16);
  for(let lane=0;lane<16;++lane)result[lane]=selectors[lane]&128?0:values[selectors[lane]&15];
  return result;
}
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
  v.setUint32(rows+16,slot,true);v.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function expected(r,meta,rf=0n) {
  const state=Buffer.from(r.subarray(1256,2512)),bytes=image(),vector=u64(r,5);
  if(vector)state.writeBigUInt64LE(state.readBigUInt64LE(392)|rf,392);
  if(meta.store&&!vector){bytes.writeBigUInt64LE(u64(r,3),target(u64(r,0))-code);bytes.writeBigUInt64LE(u64(r,4),target(u64(r,0))-code+8);}
  return {state,bytes,result:vector?vector<<3n|3n:1n,write:!!meta.store&&!vector};
}
function compare(cut,wanted,label,dispatch=false) {
  const low=v.getBigUint64(port+8,true),high=v.getBigUint64(port+48,true);
  assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port),dispatch&&wanted.write?5n:wanted.result,label);
  if(!cpu().equals(wanted.state)) {
    const delta=[];for(let i=0;i<1256;++i)if(data[base+i]!==wanted.state[i])delta.push([i,data[base+i],wanted.state[i]]);
    assert.fail(`${label}: complete CPU ${JSON.stringify(delta.slice(0,16))}`);
  }
  assert(image().equals(wanted.bytes),`${label}: whole RAM/code payload`);
  // A dispatcher has already used the scalar port for independent code fetch.
  // Only the direct instruction boundary promises the incoming pair survives.
  if(wanted.result!==1n&&!dispatch){assert.equal(v.getBigUint64(port+8,true),low,`${label}: pair low`);assert.equal(v.getBigUint64(port+48,true),high,`${label}: pair high`);}
  if(dispatch){assert.equal(vm.vm_completed(),wanted.result===1n?1:0);assert.equal(vm.vm_source_retired(),wanted.result===1n?1n:0n);}
}
try {
  for(let form=0;form<264;++form) {
    const prefix=path.join(directory,`vector-${form}`),source=await readFile(`${prefix}.source-page`);
    const meta=JSON.parse(await readFile(`${prefix}.json`)),emitted=await readFile(`${prefix}.wasm`),records=await readFile(`${prefix}.cases`);
    assert.equal(meta.recordBytes,stride);assert.equal(meta.stateBytes,1256);assert.equal(records.length,meta.native*stride);
    if(beforeDirectory){assert(records.equals(await readFile(path.join(beforeDirectory,`vector-${form}.cases`))),`${form}: pre-lowering native records unchanged`);stable+=meta.native;}
    cold.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,8,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));assert(cold.subarray(output,output+emitted.length).equals(emitted));++parity;
    const module=await WebAssembly.compile(emitted);
    if(meta.shuffle) {
      const network=Buffer.from([0xfd,0x0c,...Array(16).fill(0x8f),0xfd,0x4e,0xfd,0x0e,0xfd,0x0b]);
      assert(emitted.includes(network),`${form}: one vector AND/swizzle/publication, not sixteen scalar slices`);
    }
    const imports=[{module:'machine',name:'memory',kind:'memory'}];
    if(!meta.register)for(const name of meta.store?['write_begin','write_word','write_end']:['read_pair'])imports.push({module:'machine',name,kind:'function'});
    assert.deepEqual(WebAssembly.Module.imports(module),imports);
    const cut=(await engines.get(entry,emitted)).exports.cut;vm.__indirect_function_table.set(slot,cut);
    if(form===256) {
      // Model an engine without this required feature at its normal module
      // construction boundary. It must propagate refusal, publish nothing and
      // never select a scalar/interpreter/native alternative. Not a browser test.
      const original=WebAssembly.Module,owner=new CompiledModules({machine:{memory}});
      const before=owner.stats(),state=cpu(),bytes=image(),installed=vm.__indirect_function_table.get(slot);
      let constructions=0;
      WebAssembly.Module=function(){++constructions;throw new WebAssembly.CompileError('required SIMD unavailable');};
      try {await assert.rejects(owner.get(entry,emitted),/required SIMD unavailable/);}
      finally {WebAssembly.Module=original;}
      assert.equal(constructions,1);assert.deepEqual(owner.stats(),before);
      assert(cpu().equals(state));assert(image().equals(bytes));assert.equal(vm.__indirect_function_table.get(slot),installed);
      owner.close();++simdRefusalModels;
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
    if(meta.shuffle && meta.register) {
      // Every selector byte at every output lane, both distinct and aliased.
      // Distinct payloads make all sixteen source positions distinguishable;
      // self-alias must use the complete OLD vector, not partial stores.
      const same=(form-32)%8===1;
      for(const dispatch of [false,true])for(let selector=0;selector<256;++selector)for(let lane=0;lane<16;++lane) {
        reset(source,meta,first,0);
        for(let i=0;i<16;++i){data[base+272+i]=(i*13+17)&255;data[base+304+i]=i;}
        data[base+(same?272:304)+lane]=selector;
        const wanted={state:cpu(),bytes:image(),result:1n};
        byteShuffle(wanted.state.subarray(272,288),wanted.state.subarray(same?272:304,same?288:320)).copy(wanted.state,272);
        wanted.state.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);wanted.state.writeBigUInt64LE(43n,1128);
        compare(cut,wanted,`${form}: all byte selectors/${selector}/${lane}`,dispatch);++shuffleSelectorModels;
      }
    }
    if(meta.register && meta.addWidth && meta.addWidth<64) {
      // Whole-word corners expose carry leakage into a neighbouring lane.
      // These are independent element models, not fabricated native records.
      const width=BigInt(meta.addWidth),mask=(1n<<width)-1n;
      const patterns=[0n,~0n,0xaaaaaaaaaaaaaaaan,0x5555555555555555n,
        mask,(1n<<63n),(1n<<(width-1n))-1n,1n<<(width-1n)];
      for(const dispatch of [false,true])for(const a of patterns)for(const b of patterns) {
        reset(source,meta,first,0);const same=(form-32)%8===1;
        for(const [rank,x]of [[9,a],[11,b]])for(let half=0;half<2;++half)
          put(base+128+rank*16+half*8,BigInt.asUintN(64,half?~x:x));
        const wanted={state:cpu(),bytes:image(),result:1n};
        for(let half=0;half<2;++half) {
          const left=wanted.state.readBigUInt64LE(272+half*8);
          const right=wanted.state.readBigUInt64LE((same?272:304)+half*8);
          wanted.state.writeBigUInt64LE(packedAdd(left,right,meta.addWidth),272+half*8);
        }
        wanted.state.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);wanted.state.writeBigUInt64LE(43n,1128);
        compare(cut,wanted,`${form}: carry corner`,dispatch);++carryModels;
      }
    }
    if(form===240) {
      reset(source,meta,first,0);const wanted={state:cpu(),bytes:image(),result:1n};
      wanted.state.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);wanted.state.writeBigUInt64LE(43n,1128);
      const repeat=0x0101010101010101n;
      // All 65,536 byte input pairs execute the actual emitted register body.
      // Repeated lanes exercise overflow at every neighbouring byte boundary;
      // opposite high-word inputs include the complementary carry situation.
      for(let a=0;a<256;++a)for(let b=0;b<256;++b) {
        put(base+384,entry);put(base+1128,42n);
        for(const [offset,x]of [[272,a],[280,255-a],[304,b],[312,255-b]])put(base+offset,BigInt(x)*repeat);
        wanted.state.writeBigUInt64LE(BigInt((a+b)&255)*repeat,272);
        wanted.state.writeBigUInt64LE(BigInt((510-a-b)&255)*repeat,280);
        wanted.state.writeBigUInt64LE(BigInt(b)*repeat,304);wanted.state.writeBigUInt64LE(BigInt(255-b)*repeat,312);
        compare(cut,wanted,'exhaustive byte add');++exhaustiveByteModels;
      }
    }
    for(const dispatch of [false,true])for(const em of [0n,4n])for(const ts of [0n,8n])for(const osfxsr of [0n,512n]) {
      if(!em&&!ts&&osfxsr)continue;
      reset(source,meta,first,0);put(base+400,v.getBigUint64(base+400,true)|em|ts);put(base+416,32n|osfxsr);
      assert.equal(vm.vm_bind_execution(rows,1,9n),0);
      const vector=em||!osfxsr?6n:7n;
      compare(cut,{state:cpu(),bytes:image(),result:vector<<3n|3n},`${form}: control priority`,dispatch);
      assert.equal(v.getUint32(port+24,true),Number(vector));assert.equal(v.getUint32(port+28,true),0);++controls;
    }
    if(!meta.register && meta.kind!==4)for(const dispatch of [false,true]) {
      const row=meta.aligned?0:1,r=records.subarray(row*stride,(row+1)*stride),page=meta.aligned?9:10;
      reset(source,meta,r,row);v.setUint32(dir+page*32+16,3,true);
      compare(cut,{state:cpu(),bytes:image(),result:2n},`${form}: whole operand waits`,dispatch);++waits;
      v.setUint32(dir+page*32+16,1,true);compare(cut,expected(r,meta),`${form}: same instruction retries`,dispatch);++waits;
    }
    if(meta.register)for(const dispatch of [false,true]) {
      // Deliberate source/target alias: full input is captured before output.
      const alias=Buffer.from(source);alias[meta.sourceBytes-1]=0xc9;
      cold.set(alias,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
      assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
      const n=Number(cv.getBigUint64(report+40,true));
      const same=(await engines.get(entry,cold.subarray(output,output+n))).exports.cut;
      reset(alias,meta,first,0);const wanted={state:cpu(),bytes:image(),result:1n};
      wanted.state.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);wanted.state.writeBigUInt64LE(43n,1128);
      if(meta.add)for(const offset of [272,280])
        wanted.state.writeBigUInt64LE(BigInt.asUintN(64,wanted.state.readBigUInt64LE(offset)*2n),offset);
      if(meta.addWidth && meta.addWidth<64) {
        for(const offset of [272,280]) {
          const old=wanted.state.readBigUInt64LE(offset);
          wanted.state.writeBigUInt64LE(packedAdd(old,old,meta.addWidth),offset);
        }
      }
      if(meta.logic===1 || meta.logic===4)for(const offset of [272,280])wanted.state.writeBigUInt64LE(0n,offset);
      if(meta.unpackWidth) {
        // Byte-copy interleaving reference, independent of the emitted masks.
        const selected=272+meta.unpackHigh*8,old=Buffer.from(wanted.state.subarray(selected,selected+8));
        const width=meta.unpackWidth/8;
        for(let i=0;i<8/width;++i)for(let byte=0;byte<width;++byte) {
          wanted.state[272+2*i*width+byte]=old[i*width+byte];
          wanted.state[272+(2*i+1)*width+byte]=old[i*width+byte];
        }
      }
      if(meta.shuffle) {
        const old=Buffer.from(wanted.state.subarray(272,288));
        byteShuffle(old,old).copy(wanted.state,272);
      }
      vm.__indirect_function_table.set(slot,same);compare(same,wanted,`${form}: alias`,dispatch);++aliases;
      vm.__indirect_function_table.set(slot,cut);
    }
    for(const badPort of [port+1,base,base+8,base+1248,data.length-24,-1]) {
      reset(source,meta,first,0);compare((state)=>cut(state,badPort),{state:cpu(),bytes:image(),result:6n},`${form}: private port`);++refusals;
    }
    for(const badState of [base+1,0xfffffff8,data.length-1248]) {
      reset(source,meta,first,0);const before=cpu(),bytes=image();assert.equal(cut(badState,port),6n);assert(cpu().equals(before));assert(image().equals(bytes));++refusals;
    }
    for(const dispatch of [false,true])for(const flag of meta.register?[0x100n]:[0x100n,0x40000n]) {
      reset(source,meta,first,0);put(base+392,v.getBigUint64(base+392,true)|flag);
      compare(cut,{state:cpu(),bytes:image(),result:6n},`${form}: debug/alignment context`,dispatch);++refusals;
    }
    reset(source,meta,first,0);put(port,8);assert.equal(vm.vm_run(port,9n,1),5n);assert(cpu().equals(first.subarray(0,1256)));++refusals;
  }
  const source=await readFile(path.join(directory,'vector-0.source-page'));
  const meta=JSON.parse(await readFile(path.join(directory,'vector-0.json')));
  const record=(await readFile(path.join(directory,'vector-0.cases'))).subarray(0,stride);
  for(const [size,access,where,generation]of [[0,1,port,9n],[8,1,port,9n],[15,1,port,9n],[17,1,port,9n],
      ...[0,2,3,8,16,255].map(access=>[16,access,port,9n]),[16,1,port+1,9n],[16,1,base,9n],
      [16,1,base+4048,9n],[16,1,port,8n]]) {
    reset(source,meta,record,0);put(port,generation);const before=cpu(),bytes=image();
    const low=v.getBigUint64(port+8,true),high=v.getBigUint64(port+48,true);
    assert.equal(vm.vm_read_pair(where,u64(record,0),size,access),generation===8n?5n:6n);
    assert(cpu().equals(before));assert(image().equals(bytes));
    assert.equal(v.getBigUint64(port+8,true),low);assert.equal(v.getBigUint64(port+48,true),high);++pairRefusals;
  }
  // The precise shipped Linux gate differs from the high-XMM native fixtures.
  cold.fill(0x90,input,input+4096);cold.set([0xf3,0x0f,0x6f,0x07],input+0xda1);
  assert.equal(cc.compiler_open_pages(input,1,0xffffffff81204000n,9n),0);
  assert.equal(cc.compiler_emit(0xffffffff81204da1n,8,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+24,true),1n);assert.equal(cv.getUint32(report+68,true),16);
  cold.fill(0x90,input,input+4096);cold.set([0x66,0x0f,0x62,0xe5],input+0xe1e);
  assert.equal(cc.compiler_open_pages(input,1,0xffffffff81204000n,9n),0);
  assert.equal(cc.compiler_emit(0xffffffff81204e1en,8,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+24,true),1n);assert.equal(cv.getUint32(report+68,true),0);
  cold.fill(0x90,input,input+4096);cold.set([0x66,0x41,0x0f,0x38,0x00,0xdc],input+0xe36);
  assert.equal(cc.compiler_open_pages(input,1,0xffffffff81204000n,9n),0);
  assert.equal(cc.compiler_emit(0xffffffff81204e36n,8,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+24,true),1n);assert.equal(cv.getUint32(report+68,true),0);
  cold.fill(0x90,input,input+4096);cold.set([0x66,0x0f,0xfe,0xc4],input+0xe2a);
  assert.equal(cc.compiler_open_pages(input,1,0xffffffff81204000n,9n),0);
  assert.equal(cc.compiler_emit(0xffffffff81204e2an,8,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+24,true),1n);assert.equal(cv.getUint32(report+68,true),0);
  // Next independently observed shipped gate: high-register PADDQ.
  cold.fill(0x90,input,input+4096);cold.set([0x66,0x45,0x0f,0xd4,0xf7],input+0xdda);
  assert.equal(cc.compiler_open_pages(input,1,0xffffffff81204000n,9n),0);
  assert.equal(cc.compiler_emit(0xffffffff81204ddan,8,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+24,true),1n);assert.equal(cv.getUint32(report+68,true),0);
  cold.fill(0x90,input,input+4096);cold.set([0x66,0x0f,0xef,0x1d,0x9c,0x2f,0x6e,0x00],input+0xdec);
  assert.equal(cc.compiler_open_pages(input,1,0xffffffff81204000n,9n),0);
  assert.equal(cc.compiler_emit(0xffffffff81204decn,8,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+24,true),1n);assert.equal(cv.getUint32(report+68,true),16);
  console.log(JSON.stringify({status:'pass',nativeColdParity:parity,stablePreLoweringObservations:stable,
    directComparisons:direct,dispatchComparisons:comparisons,rfComparisons,independentNativeFaultComparisons:faults,
    controlPriorityModels:controls,waitRetryModels:waits,entryRefusals:refusals,registerAliasModels:aliases,pairBoundaryRefusals:pairRefusals,packedCarryModels:carryModels,exhaustiveByteModels,shuffleSelectorModels,simdRefusalModels,
    shippedGates:'MOVDQU, PADDQ, PXOR, PUNPCKLDQ, PADDD and PSHUFB common C compilation accepted; not executed by this fixture',
    oracle:'actual native x86 in independent build VM; CR0/CR4 models; not physical hardware or FP arithmetic',
    linuxBoot:'not-tested'}));
} finally {vm.__indirect_function_table.set(slot,null);engines.close();vm.vm_close();}
