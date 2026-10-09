// Models drive the actual C compiler/MMU/table. They are not native receipts
// and do not evaluate guest opcodes outside the compiled Wasm function.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile,mode]=process.argv.slice(2),integerFloat=mode==='--integer-float',compare=mode==='--float-compare';
if(!compilerFile||(mode&&!integerFloat&&!compare))throw new Error('VM.WASM COMPILER.WASM [--integer-float|--float-compare]');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,segments=cpu+1408,port=cpu+2048,codeView=port+64;
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,entry=0x400000n,payload=i=>cpu+(i+2)*4096;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));
const profiles=[
  {mask:0,fx:true,ne:true}, {mask:4,fx:true,ne:true}, {mask:8,fx:true,ne:true},
  {mask:12,fx:true,ne:true}, {mask:0,fx:false,ne:true}, {mask:8,fx:false,ne:true},
  {mask:0,fx:true,ne:true,pending:true}, {mask:0,fx:true,ne:false,pending:true},
  {mask:4,fx:true,ne:true,pending:true}, {mask:8,fx:true,ne:true,pending:true},
  {mask:0,fx:true,ne:true,pending:true,masked:true},
];
let comparisons=0,faults=0,waits=0,retries=0,success=0;
for(let kind=0;kind<(integerFloat||compare?4:8);++kind)for(const mem of [false,true]){
  const scalar=!integerFloat&&!compare&&kind>=3&&kind<=6,mmx=!integerFloat&&!compare&&kind<3;
  const wide=integerFloat||compare?!!(kind&1):[2,4,6,7].includes(kind),out64=integerFloat?!!(kind&2):kind===5||kind===6;
  const bytes=integerFloat||compare?wide?8:4:scalar?(wide?8:4):wide?16:8;
  const source=Buffer.from(integerFloat?[...(out64?[0xf2]:[0xf3]),...(wide?[0x48]:[]),0x0f,0x2a,mem?7:0xc0]:
    compare?[...(wide?[0x66]:[]),0x0f,kind&2?0x2f:0x2e,mem?7:0xc1]:
    [...(scalar?[wide?0xf2:0xf3]:wide?[0x66]:[]),...(out64?[0x48]:[]),0x0f,kind===7?0xe6:kind===1?0x2d:0x2c,mem?7:0xc0]);
  c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
    {machine:{memory,access:vm.vm_access,read_pair:vm.vm_read_pair,floating_wait:vm.vm_floating_wait}})).instance.exports.cut;
  for(const dispatch of [false,true])for(const p of profiles)for(const xm of [false,true])
  for(const location of [0,1,2])for(const resident of [0,1,2])for(const numeric of (compare?[0,1,2,3]:[0,1,2]))for(const unmask of [false,true]){
    vm.vm_close();a.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);
    });
    if(resident===2){v.setUint32(dir+5*32+16,3,true);v.setUint32(dir+6*32+16,3,true);}
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(3),0x8067);
    put(payload(3)+8,resident?0x9065:0);put(payload(3)+16,resident?0xa065:0);
    a.set(source,payload(4));
    const address=location===2?0x800000000000n:location===1?0x401fffn:0x401010n;
    for(let r=0;r<16;++r)put(cpu+r*8,0xabcdef0123450000n+BigInt(r));put(cpu+56,address);
    put(cpu+384,entry);put(cpu+392,0x10202);put(cpu+400,(0x80010011|p.mask|(p.ne?32:0))>>>0);
    put(cpu+408,0x1000);put(cpu+416,32|(p.fx?512:0)|(xm?1024:0));put(cpu+424,0xd00);
    put(cpu+488,19);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    v.setUint16(cpu+1232,p.pending&&!p.masked?0x37e:0x37f,true);v.setUint16(cpu+1234,p.pending?0xb881:0x3800,true);
    for(let r=0;r<8;++r){put(cpu+1152+r*8,0x8000000000000000n);v.setUint16(cpu+1216+r*2,0x3fff,true);}
    v.setUint16(cpu+1236,0,true);put(cpu+1240,0x12340000);put(cpu+1248,0x56780000);
    const bits=integerFloat?[3n,wide&&out64?0x0020000000000001n:0x01000001n,wide?0x8000000000000000n:0x80000000n][numeric]:
      compare?(wide?[0x4008000000000000n,1n,0x7ff8000000000001n,0x7ff0000000000001n]:[0x40400000n,1n,0x7fc00001n,0x7f800001n])[numeric]:
      wide?[0x4008000000000000n,0x400c000000000000n,0x7ff0000000000000n][numeric]:[0x40400000n,0x40600000n,0x7f800000n][numeric];
    const operand=Buffer.alloc(bytes);for(let n=0;n<bytes;n+=wide?8:4){wide?operand.writeBigUInt64LE(bits,n):operand.writeUInt32LE(Number(bits),n);}
    if(mem&&location!==2){const offset=Number(address-0x401000n);a.set(operand,payload(5)+offset);}
    else if(!mem){if(integerFloat)put(cpu,bits);else a.set(operand,cpu+(compare?144:128));}
    if(compare)put(cpu+128,wide?0x3ff0000000000000n:0x3f800000n);
    const raised=integerFloat?(numeric===1&&(wide||!out64)?32:0):compare?(numeric===1?2:numeric===3||numeric===2&&(kind&2)?1:0):numeric===1?32:numeric===2?1:0;
    const mxcsr=0x1f80&~(unmask?(compare?384:0x1080):0);v.setUint32(cpu+612,mxcsr,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+2048,9n),0);
    assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),cut);
    assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),expected=Buffer.from(before);
    function numericState(out,fault){
      out.writeUInt32LE(mxcsr|raised,612);
      if(mmx)out.writeUInt16LE(before.readUInt16LE(1234)&~0x3800,1234);
      if(fault)return;
      const word=numeric===2?0x80000000n:numeric===1&&kind===1?4n:3n,result64=numeric===2&&out64?0x8000000000000000n:word;
      if(integerFloat){const encoded=numeric===0?(out64?0x4008000000000000n:0x40400000n):numeric===1?
          out64?(wide?0x4340000000000000n:0x4170000010000000n):0x4b800000n:
          out64?(wide?0xc3e0000000000000n:0xc1e0000000000000n):(wide?0xdf000000n:0xcf000000n);
        out64?out.writeBigUInt64LE(encoded,128):out.writeUInt32LE(Number(encoded),128);
      }else if(compare){/* Only EFLAGS changes; operand columns stay resident. */}
      else if(scalar)out.writeBigUInt64LE(result64,0);
      else if(kind===7){out.writeBigUInt64LE(word|(word<<32n),128);out.writeBigUInt64LE(0n,136);}
      else{out.writeBigUInt64LE(word|(word<<32n),1152);out.writeUInt16LE(0xffff,1216);out.writeUInt16LE(2,1236);}
      out.writeBigUInt64LE(entry+BigInt(source.length),384);out.writeBigUInt64LE(compare?(numeric===0?0x203n:numeric>=2?0x247n:0x202n):0x202n,392);out.writeBigUInt64LE(43n,1128);
    }
    let fault=p.mask&4||!p.fx?6:p.mask&8?7:mmx&&p.pending&&!p.masked&&p.ne?16:
      mem&&(location===2||bytes===16&&location===1)?13:mem&&resident===0?14:unmask&&raised?xm?19:6:0;
    let waiting=!fault&&mmx&&p.pending&&!p.masked&&!p.ne?34:0;
    // Pending legacy FERR is ahead of any operand or SIMD exception.
    if(!(p.mask&12)&&p.fx&&mmx&&p.pending&&!p.masked&&!p.ne){fault=0;waiting=34;}
    // Host residency is ahead of conversion; it never publishes MXCSR/TOP.
    if(!fault&&!waiting&&mem&&resident===2)waiting=2;
    if(!(p.mask&12)&&p.fx&&!(mmx&&p.pending&&!p.masked)&&mem&&resident===2&&location!==2&&!(bytes===16&&location===1)){fault=0;waiting=2;}
    const result=dispatch?vm.vm_run(port,9n,1):cut(cpu,port,entry,binding);
    if(waiting){assert.equal(result,BigInt(waiting));++waits;}
    else if(fault){assert.equal(result,BigInt(fault)*8n+3n);assert.equal(v.getUint32(port+24,true),fault);++faults;}
    else{assert.equal(result,1n);++success;}
    const numericReached=!waiting&&((!fault)||fault===19||fault===6&&p.fx&&!(p.mask&12));
    if(numericReached)numericState(expected,fault);
    assert(a.subarray(cpu,cpu+1256).equals(expected),`full state ${kind}/${mem}/${dispatch}/${JSON.stringify(p)}/${xm}/${location}/${resident}/${numeric}/${unmask}`);
    if(dispatch)assert.equal(vm.vm_source_retired(),fault||waiting?0n:1n);
    if(waiting===2&&dispatch){
      // Serialized test owner promotes the same deferred descriptor; no
      // guest PTE, radix coordinate or instruction is rewritten on retry.
      v.setUint32(dir+5*32+16,1,true);v.setUint32(dir+6*32+16,1,true);
      const retry=vm.vm_run(port,9n,1),f=unmask&&raised?(xm?19:6):0;
      assert.equal(retry,f?BigInt(f)*8n+3n:1n);assert.equal(vm.vm_source_retired(),f?0n:1n);
      const resumed=Buffer.from(before);numericState(resumed,f);assert(a.subarray(cpu,cpu+1256).equals(resumed),'exact complete state after residency retry');++retries;}
    ++comparisons;
  }
}
vm.vm_close();cc.compiler_close();console.log(JSON.stringify({status:'pass',mode:mode??'--float-integer',comparisons,faults,waits,retries,success,
  scope:'C guard/exception/alignment/readonly/cross-page/residency matrix; full-state models, direct and C table',linuxBoot:'not-tested'}));
