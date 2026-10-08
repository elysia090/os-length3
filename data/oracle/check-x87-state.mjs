// Actual native FPU observations -> cold C compiler -> C MMU/table.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory,mode]=process.argv.slice(2);
if(!directory||(mode&&!['--arithmetic','--status','--register','--divide','--register-divide','--memory','--multiply','--memory-multiply','--register-multiply','--store','--load','--store-fault'].includes(mode)))throw new Error('VM.WASM COLD.WASM HARDWARE-RECORDS [--arithmetic|--status|--register|--divide|--register-divide|--memory|--multiply|--memory-multiply|--register-multiply|--store|--load|--store-fault]');
const arithmetic=mode==='--arithmetic',status=mode==='--status',registerDivide=mode==='--register-divide',registerMultiply=mode==='--register-multiply',register=registerMultiply||registerDivide||mode==='--register',
  storeFault=mode==='--store-fault',load=mode==='--load',store=storeFault||mode==='--store',multiply=mode==='--multiply',memoryMultiply=mode==='--memory-multiply',divide=mode==='--divide',ieee=mode==='--memory',
  prefix=storeFault?'x87-store-fault':load?'x87-ieee-load':store?'x87-integer-store':memoryMultiply?'x87-memory-multiply':multiply?'x87-integer-multiply':registerMultiply?'x87-register-multiply':ieee?'x87-memory-arithmetic':registerDivide?'x87-register-divide':divide?'x87-division':register?'x87-register':status?'x87-status':arithmetic?'x87-arithmetic':'x87-integer',
  forms=storeFault?8:load?96:store?384:(multiply||memoryMultiply)?224:registerMultiply?27:ieee?1120:registerDivide?54:divide?448:register?81:status?172:arithmetic?576:192;
const memory=new WebAssembly.Memory({initial:16}),vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cm=new WebAssembly.Memory({initial:16}),cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,
  segments=cpu+1408,port=cpu+2048,codeView=port+64,entry=0x400000n;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));let comparisons=0,modules=0;
const cached=new Map();
for(let form=0;form<forms;++form){const file=suffix=>readFile(path.join(directory,`${prefix}-${form}.${suffix}`));
  const meta=JSON.parse(await file('json')),source=await file('source'),native=await file('cases'),operands=register?null:await file(status?'operands':'integers');
  const written=store?await file('written'):null;
  const faultRows=storeFault?await file('faults'):null,errors=storeFault?await file('errors'):null;
  assert.equal(meta.stateBytes,1256);assert.equal(native.length,meta.native*2512);if(operands)assert.equal(operands.length,meta.native*8);
  assert.equal(source.length,meta.sourceBytes);assert(((status||register)&&meta.bytes===0)||[2,4,8].includes(meta.bytes));
  const operandOffset=meta.operandOffset??256;assert([256,4096].includes(operandOffset));
  const key=source.toString('hex');let made=cached.get(key);
  if(!made){c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0,`${prefix} ${key} must compile`);
    const n=Number(cv.getBigUint64(cr+40,true)),instance=(await WebAssembly.instantiate(c.subarray(co,co+n),
      {machine:{memory,access:vm.vm_access,floating_wait:vm.vm_floating_wait,write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end}})).instance;
    made={fn:instance.exports.cut,binding:cv.getUint32(cr+76,true)};cached.set(key,made);++modules;cc.compiler_close();
  }
  for(let row=0;row<meta.native;++row){vm.vm_close();a.fill(0,dir);
    const before=native.subarray(row*2512,row*2512+1256),after=native.subarray(row*2512+1256,(row+1)*2512);a.set(before,cpu);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);put(cpu+20480,0x8067);put(cpu+20488,storeFault&&(row&1)?0x9065:0x9067);
    a.fill(0x90,cpu+24576,cpu+28672);a.set(source,cpu+24576);if(operands)a.set(operands.subarray(row*8,row*8+(store?8:meta.bytes)),cpu+24576+operandOffset);
    put(port,9);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,6,6,dir+2048,9n),0);
    assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),made.fn);
    assert.equal(vm.vm_source_publish(meta.sourceBytes,1,made.binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const result=vm.vm_run(port,9n,1),fault=storeFault&&faultRows[row];
    if(fault){assert.equal(result,115n);assert.equal(v.getUint32(port+24,true),14);assert.equal(v.getUint32(port+28,true),errors.readUInt32LE(row*4));
      assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);}
    else{assert([1n,...(store?[5n]:[])].includes(result),`${prefix} result ${form}/${row}: ${result}`);assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);}
    if(store){
      assert(a.subarray(cpu+24576+operandOffset,cpu+24576+operandOffset+8).equals(written.subarray(row*8,(row+1)*8)),`${prefix} memory ${form}/${row}`);}
    const actual=a.subarray(cpu,cpu+1256);
    assert(actual.equals(after),`${prefix} full state ${form}/${row}; byte differences: ${Array.from(after.entries())
      .filter(([offset,byte])=>actual[offset]!==byte).slice(0,24).map(([offset,byte])=>`${offset}:${actual[offset].toString(16)}/${byte.toString(16)}`).join(',')}`);++comparisons;
  }
}
vm.vm_close();console.log(JSON.stringify({format:'native-x87-full-state-c-v2',mode:mode??'--integer-load',status:'pass',comparisons,modules,
  oracle:storeFault?'actual x86 reference-build VM FPU/signal frame; write protection and invalid/precision priority; GPR/RF invariance architectural':
    status?'physical Windows FPU/RFLAGS; IM/DM,relation,alias,tag,TOP,pop matrix; GPR invariance architectural':
    'physical Windows FPU/RFLAGS; GPR invariance architectural; PC/RC/exception-mask matrix',linuxBoot:'not-tested'},null,2));
