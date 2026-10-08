// Real native observations -> independent cold-C bytes -> C-MMU/table execution.
// Descriptor/shadow models are separately identified; no host guest-memory callback.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
const [vmFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('usage: check-segment-load.mjs VM.WASM COMPILER.WASM NATIVE-FIXTURES');
const memory=new WebAssembly.Memory({initial:8,maximum:16}), cm=new WebAssembly.Memory({initial:16,maximum:32});
const provider=await WebAssembly.compile(await readFile(vmFile));
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
const vm=(await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
const compilerModule=await WebAssembly.compile(await readFile(compilerFile));
assert.deepEqual(WebAssembly.Module.imports(compilerModule),[{module:'machine',name:'memory',kind:'memory'}]);
const cc=(await WebAssembly.instantiate(compilerModule,{machine:{memory:cm}})).exports;
assert.equal(vm.vm_entry_abi(),4);assert.equal(cc.compiler_entry_abi(),4);
const cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536;
const dir=vm.vm_arena_min()+4096,rows=dir+512,branches=dir+1024,base=dir+4096;
const hidden=base+1408,port=base+2048,entry=0x400000n;
const data=Buffer.from(memory.buffer),view=new DataView(memory.buffer),table=vm.__indirect_function_table,slot=table.grow(1);
const put=(at,value)=>view.setBigUint64(at,BigInt(value),true),dw=(at,value)=>view.setUint32(at,value,true);
let parity=0,native=0,models=0,refusals=0;
function reset(meta,source,words,{mode=meta.mode,selector=words[38],descriptor=0x00cff3000000ffffn,shadow=0,resident=true}={}){
  data.fill(0,dir);seedDisabledDebug(view,base);
  for(let i=0;i<10;++i){
    const at=dir+i*32;put(at,(i+1)*4096);dw(at+8,(i+1)*4096);dw(at+12,3);dw(at+16,1);
  }
  // Separate source, data and supervisor GDT paths through ordinary four-level C paging.
  // A/D bits are already set to isolate this transfer from independent paging
  // writes, which correctly revoke an explicitly bound execution generation.
  put(base+4096,0x2067);put(base+8192,0x3067);
  put(base+12288,0x5067);put(base+12288+16,0x4067);
  put(base+16384,0xa067);put(base+16384+256*8,0x6067);
  put(base+16384+257*8,mode===3||mode===4?0:0x7067);
  put(base+20480+8*8,0x8063);
  data.set(source,base+40960);
  const linear=words[37];
  if(mode!==5){
    const at=linear>=entry && linear<entry+4096n
      ?base+40960+Number(linear-entry):base+24576+Number(linear-0x500000n);
    view.setUint16(at,Number(selector),true);
  }
  // Native rows use this oracle's user data selector; index, not a host pointer.
  const dataSelector=meta.rank===2?words[40]:meta.mode===1 && meta.rank<4?words[38]:0x2bn;
  const descriptorAt=base+32768+Number(dataSelector&~7n);
  put(descriptorAt,descriptor);
  for(let r=0;r<16;++r)put(base+r*8,words[r]);
  put(base+384,entry);put(base+392,words[16]);put(base+400,0x80010001);
  put(base+408,0x1000);put(base+416,32);put(base+424,0xd00);
  put(base+448,0x8000);put(base+456,63);put(base+1128,42);
  for(let r=0;r<6;++r){
    put(base+480+r*8,r===meta.rank?words[40]:r===1?0x33:r===2?0x2b:0);
    put(hidden+8+r*16,0xabcdef);dw(hidden+16+r*16,123);dw(hidden+20+r*16,0x10000);
  }
  dw(hidden,2);dw(hidden+4,shadow);dw(hidden+36,0xa0fb);
  if(!resident){
    // The GDT page alone is absent: source/code and all paging levels remain resident.
    data.copy(data,dir+7*32,dir+8*32,dir+10*32);
  }
  put(port,9);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,resident?10:9,10,branches,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(hidden),0);
  put(rows,entry);dw(rows+8,meta.sourceBytes);dw(rows+12,1);dw(rows+16,slot);dw(rows+20,meta.operandBinding);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  return descriptorAt;
}
function compare(meta,words,vector,error,{selector=words[38],shadow=0,stale=false,faultAddress=words[36]}={}){
  const cpu=Buffer.from(data.subarray(base,base+1256)),cache=Buffer.from(data.subarray(hidden,hidden+136));
  if(!vector){
    cpu.writeBigUInt64LE(selector,480+meta.rank*8);
    cpu.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);cpu.writeBigUInt64LE(words[16]&~0x10000n,392);
    cpu.writeBigUInt64LE(43n,1128);
    cache.writeBigUInt64LE(0n,8+meta.rank*16);
    cache.writeUInt32LE(selector<4n?0:0xffffffff,16+meta.rank*16);
    cache.writeUInt32LE(selector<4n?0x10000:0xc0f3,20+meta.rank*16);
    cache.writeUInt32LE(shadow?0:meta.rank===2?1:0,4);
  }
  assert.equal(vm.vm_run(port,9n,1),vector?BigInt(vector*8+3):stale?5n:1n);
  assert.deepEqual(data.subarray(base,base+1256),cpu,'complete architectural state');
  assert.deepEqual(data.subarray(hidden,hidden+136),cache,'ordered selector/cache/shadow publication');
  assert.equal(vm.vm_completed(),vector?0:1);assert.equal(vm.vm_source_retired(),vector?0n:1n);
  for(let r=0;r<16;++r)assert.equal(view.getBigUint64(base+r*8,true),words[17+r]);
  assert.equal(view.getBigUint64(base+392,true),words[33]&~0x10000n,'native fault context adds RF; MOV arithmetic flags are unchanged');
  if(vector){assert.equal(view.getUint32(port+24,true),vector);assert.equal(view.getUint32(port+28,true),error);}
  if(vector===14)assert.equal(view.getBigUint64(port+16,true),faultAddress,'source/descriptor fault address');
  // GDT Accessed may change; the explicit selector source is read-only.
  if(words[37]>=0x500000n && words[37]<0x501fffn){
    const at=base+24576+Number(words[37]-0x500000n);
    assert.equal(view.getUint16(at,true),Number(selector));
  }
}
const names=(await readdir(directory)).filter(name=>/^load-[0-9]+\.json$/.test(name))
  .sort((a,b)=>Number(a.slice(5,-5))-Number(b.slice(5,-5)));
assert.equal(names.length,750,'complete fixed native cohort');
try {
  for(const name of names){
    const prefix=path.join(directory,name.slice(0,-5)),meta=JSON.parse(await readFile(`${prefix}.json`));
    const source=await readFile(`${prefix}.source-page`),reference=await readFile(`${prefix}.wasm`);
    const record=await readFile(`${prefix}.cases`);assert.equal(record.length,42*8);
    const words=Array.from({length:42},(_,i)=>record.readBigUInt64LE(i*8));
    cold.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
    const status=cc.compiler_emit(entry,1,co,65536,cr);
    assert.equal(status,0,`cold segment-load grammar: ${name}`);
    assert.equal(cv.getBigUint64(cr+40,true),BigInt(reference.length));
    assert(cold.subarray(co,co+reference.length).equals(reference),'native / cold-C emitted bytes');
    assert.equal(cv.getUint32(cr+76,true),meta.operandBinding);++parity;
    const module=await WebAssembly.compile(reference);
    assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'},
      {module:'machine',name:'access',kind:'function'},{module:'machine',name:'segment',kind:'function'}]);
    const fn=(await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access,segment:vm.vm_segment}})).exports.cut;
    table.set(slot,fn);
    reset(meta,source,words);compare(meta,words,Number(words[34]),Number(words[35]));
    assert.equal(view.getBigUint64(base+480+meta.rank*8,true),words[41],'native visible selector');++native;
    if(meta.mode===0){
      for(const shadow of [1,2]){
        reset(meta,source,words,{shadow});compare(meta,words,0,0,{shadow});++models;
      }
      for(const descriptor of [0x00cf73000000ffffn,0x00cfe1000000ffffn]){
        const selector=0x2bn;reset(meta,source,words,{selector,descriptor});
        compare(meta,words,descriptor===0x00cf73000000ffffn?(meta.rank===2?12:11):13,40,{selector});++models;
      }
      reset(meta,source,words,{resident:false});
      const before=Buffer.from(data.subarray(base,base+1256)),cache=Buffer.from(data.subarray(hidden,hidden+136));
      // A null selector does not access a descriptor and cannot demand its page.
      assert.equal(vm.vm_run(port,9n,1),meta.rank===2?2n:1n);
      if(meta.rank===2){
        assert.deepEqual(data.subarray(base,base+1256),before);
        assert.deepEqual(data.subarray(hidden,hidden+136),cache);
        assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);++models;
      }
      vm.vm_close();
    }
    if(meta.mode===1 && meta.rank<4){
      const descriptor=0x00cff2000000ffffn,at=reset(meta,source,words,{descriptor});
      compare(meta,words,0,0,{stale:true});
      assert.equal(view.getBigUint64(at,true),descriptor|(1n<<40n),'Accessed update precedes cache publication');++models;
      reset(meta,source,words,{descriptor});put(base+20480+8*8,0x8061);
      compare(meta,words,14,3,{faultAddress:0x802dn});
      assert.equal(view.getBigUint64(at,true),descriptor,'readonly GDT does not publish Accessed/cache');++models;
    }
    reset(meta,source,words);
    const before=Buffer.from(data.subarray(base,base+1256)),cache=Buffer.from(data.subarray(hidden,hidden+136));
    assert.equal(vm.vm_run(port,8n,1),5n);
    assert.deepEqual(data.subarray(base,base+1256),before);assert.deepEqual(data.subarray(hidden,hidden+136),cache);++refusals;
  }
} finally {table.set(slot,null);cc.compiler_close();vm.vm_close();}
console.log(JSON.stringify({format:'segment-load-native-c-wasm-v1',status:'pass',parity,native,models,refusals,
  oracle:'native complete GPR/flags/visible selector and source-fault priority; hidden descriptor/shadow/residency are separate C models',
  linuxBoot:'not-tested'},null,2));
