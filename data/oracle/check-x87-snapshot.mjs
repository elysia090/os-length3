// Native observations and C MMU/dispatch parity, never an x87 interpreter.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COLD.WASM NATIVE-RECORDS');
const memory=new WebAssembly.Memory({initial:16}),vm=(await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const coldMemory=new WebAssembly.Memory({initial:16}),cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer);
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,dir=vm.vm_arena_min(),cpu=dir+4096,
  rows=dir+512,branches=dir+2048,segments=cpu+1408,port=cpu+2048,codeView=port+64;
const put=(at,n)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(n)),true),payload=i=>cpu+(i+2)*4096,entry=0x400000n;
const table=vm.__indirect_function_table,slot=vm.vm_slot_min();table.grow(Math.max(0,slot+vm.vm_source_capacity()-table.length));
let comparisons=0,directComparisons=0,faults=0,parity=0;
function reset(source,record,{mask=0n,permission='write',crossing=false,pending=false}={}){
  vm.vm_close();a.fill(0,dir);a.set(record,cpu);
  [0x1000,0x2000,0x3000,0x4000,0x5000,0x8000,0x9000,0xa000].forEach((address,i)=>{
    put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
  const destination=record.readBigUInt64LE(56)&~4095n,pd=Number((destination>>21n)&511n);assert.notEqual(pd,2);
  put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(3),0x8067);
  put(payload(1)+Number((destination>>30n)&511n)*8,0x3067);
  put(payload(2)+pd*8,0x5067);const pte=Number((destination>>12n)&511n);
  assert(pte<511);put(payload(4)+pte*8,permission==='absent'?0:permission==='readonly'?0x9065:0x9067);
  put(payload(4)+(pte+1)*8,permission==='absent'?0:permission==='readonly'?0xa065:0xa067);
  if(crossing){put(payload(4)+pte*8,0x9067);put(cpu+56,destination+4095n);}
  put(cpu+400,record.readBigUInt64LE(400)|mask);put(port,9);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
  if(pending){v.setUint16(cpu+1232,0,true);v.setUint16(cpu+1234,0xffff,true);}
  a.set(source,payload(5));a.fill(0xa5,payload(6),payload(7)+4096);
  assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,8,8,branches,9n),0);
  assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);
}
for(let form=0;form<24;++form){const file=suffix=>readFile(path.join(directory,`x87-snapshot-${form}.${suffix}`));
  const meta=JSON.parse(await file('json')),source=await file('source-page'),native=await file('cases'),expectedModule=await file('wasm'),words=await file('words');
  assert.equal(meta.stateBytes,1256);assert.equal(native.length,32*2*1256);assert.equal(words.length,64);
  c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1024,co,65536,cr),0);const n=Number(cv.getBigUint64(cr+40,true));
  assert.equal(n,expectedModule.length);assert(c.subarray(co,co+n).equals(expectedModule));++parity;
  const binding=cv.getUint32(cr+76,true),span=Number(cv.getBigUint64(cr+32,true));assert.equal(span,meta.sourceBytes);
  const instance=(await WebAssembly.instantiate(c.subarray(co,co+n),{machine:{memory,access:vm.vm_access}})).instance;
  cc.compiler_close();
  function install(){table.set(v.getUint32(rows+16,true),instance.exports.cut);assert.equal(vm.vm_source_publish(span,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);}
  for(let row=0;row<32;++row){const before=native.subarray(row*2512,row*2512+1256),after=native.subarray(row*2512+1256,(row+1)*2512);
    for(const dispatched of [false,true]){reset(source,before);install();
      assert.equal(dispatched?vm.vm_run(port,9n,1):instance.exports.cut(cpu,port,entry,binding),1n,`native form ${form} row ${row}`);
      assert(a.subarray(cpu,cpu+1256).equals(after),`full native CPU/FPU parity: form ${form} row ${row}`);
      if(meta.memory)assert.equal(v.getUint16(payload(6),true),words.readUInt16LE(row*2));
      dispatched?++comparisons:++directComparisons;
    }
  }
  const record=native.subarray(0,1256);
  for(const mask of [0n,4n,8n,12n])for(const permission of ['write','readonly','absent'])for(const crossing of [false,true]){
    reset(source,record,{mask,permission,crossing,pending:true});install();
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),ram=Buffer.from(a.subarray(payload(6),payload(7)+4096));
    const expectedFault=mask?7:meta.memory&&permission!=='write'?14:0,result=vm.vm_run(port,9n,1);
    if(expectedFault){assert.equal(result&7n,3n);assert.equal(v.getUint32(port+24,true),expectedFault);
      assert(a.subarray(cpu,cpu+1256).equals(before));assert(a.subarray(payload(6),payload(7)+4096).equals(ram));++faults;
    }else{assert.equal(result,1n);assert.equal(v.getUint16(cpu+1232,true),0);assert.equal(v.getUint16(cpu+1234,true),0xffff);
      const word=meta.status?0xffff:0;if(meta.memory){ram.writeUInt16LE(word,crossing?4095:0);assert(a.subarray(payload(6),payload(7)+4096).equals(ram));}
      else assert.equal(v.getBigUint64(cpu,true),(before.readBigUInt64LE(0)&~0xffffn)|BigInt(word));
    }
  }
}
cc.compiler_close();vm.vm_close();console.log(JSON.stringify({format:'x87-no-wait-snapshot-native-c-parity-v1',status:'pass',parity,comparisons,directComparisons,faults,
  executionCompilerCalls:0,oracle:'actual native GPR/flags/full FPU observations plus C-MMU EM/TS/permission/crossing/pending-exception models; native is build QEMU CPU, not physical silicon',linuxBoot:'not-tested'},null,2));
