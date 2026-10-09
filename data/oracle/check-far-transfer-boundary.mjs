// Exact source/descriptor/TSS/frame boundaries through the actual C compiler,
// shared table and C MMU. Expected state is a model, not a CPU receipt.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
if(!compilerFile)throw new Error('VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,segments=cpu+1408,port=cpu+2048,view=port+80;
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,entry=0x7000n,payload=i=>cpu+(i+2)*4096;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));
let comparisons=0,faults=0,waits=0,retries=0,success=0;
async function compile(source){c.fill(0x90,ci,ci+4096);c.set(source,ci);
  assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
    {machine:{memory,read_pair:vm.vm_read_pair,far_transfer:vm.vm_transfer,checkpoint:vm.vm_checkpoint}})).instance.exports.cut;
  cc.compiler_close();return {cut,binding};}
function reset(source,cpl,conform,gate,width,prefix,cross){vm.vm_close();a.fill(0,dir);
  for(let page=1;page<=10;++page){put(dir+(page-1)*32,page*4096);v.setUint32(dir+(page-1)*32+8,(page+1)*4096,true);
    v.setUint32(dir+(page-1)*32+12,3,true);v.setUint32(dir+(page-1)*32+16,1,true);}
  put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2),0xe7);a.set(source,payload(6));
  const address=cross?0x8ffdn:0x8010n,bias=prefix===0x64?0x1000n:prefix===0x65?0x2000n:0n;
  put(cpu,address-bias);put(payload(7)+Number(address-0x8000n),0x7100);
  v.setUint16(payload(7)+Number(address-0x8000n)+width,(gate?64:56)|cpl,true);
  const dpl=conform||gate?0:cpl;
  put(payload(3)+56,0x00af9a000000ffffn|(BigInt(dpl)<<45n)|(conform?1n<<42n:0n));
  put(payload(3)+64,0x0000ec0000387100n);put(payload(3)+72,0);put(payload(5)+4,0x9f08);
  put(cpu+384,entry);put(cpu+392,0xa93);put(cpu+400,0x80010011);put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0x500);
  put(cpu+32,0x9d08);put(cpu+488,8|cpl);put(cpu+496,16|cpl);put(cpu+448,0x4000);put(cpu+456,79);put(cpu+536,40);
  put(cpu+600,0x400);put(cpu+1128,42);put(port,9);v.setUint32(segments,2,true);
  v.setUint32(segments+36,0xa09b|(cpl<<5),true);v.setUint32(segments+52,0xc093|(cpl<<5),true);
  put(segments+72,0x1000);put(segments+88,0x2000);
  put(segments+120,0x6000);v.setUint32(segments+128,103,true);v.setUint32(segments+132,0x8b,true);
  return address;
}
function bind(made,source){assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,10,10,dir+2048,9n),0);
  assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(vm.vm_source_query(port,entry,1,view,rows),1n);table.set(v.getUint32(rows+16,true),made.cut);
  assert.equal(vm.vm_source_publish(source.length,1,made.binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);}
for(const prefix of [0,0x64,0x65,0x67])for(const width of [2,4,8])for(const call of [false,true]){
  const source=Buffer.from([...(prefix?[prefix]:[]),...(width===2?[0x66]:width===8?[0x48]:[]),0xff,call?0x18:0x28]),made=await compile(source);
  for(const cpl of [0,3])for(const conform of [false,true])for(const gate of [false,true])for(const cross of [false,true])
  for(const problem of ['none','source-wait','descriptor-wait','tss-wait','stack-wait','source-pf','descriptor-pf','tss-pf','stack-pf']){
    const address=reset(source,cpl,conform,gate,width,prefix,cross),inner=gate&&call&&!conform&&cpl!==0;
    const invalid=gate&&!call&&!conform&&cpl!==0;
    const active=problem.startsWith('source-')||problem.startsWith('descriptor-')
      ||(!invalid&&(problem.startsWith('tss-')?inner:problem.startsWith('stack-')&&call));
    const wait=active&&problem.endsWith('wait'),pf=active&&problem.endsWith('pf');
    const page=problem.startsWith('source-')?(cross?8:7):problem.startsWith('descriptor-')?3:problem.startsWith('tss-')?5:8;
    if(wait)v.setUint32(dir+page*32+16,3,true);
    if(pf){if(problem.startsWith('source-'))put(cpu,0x300000n-(prefix===0x64?0x1000n:prefix===0x65?0x2000n:0n));
      else if(problem.startsWith('descriptor-'))put(cpu+448,0x300000);
      else if(problem.startsWith('tss-'))put(segments+120,0x300000);
      else if(inner)put(payload(5)+4,0x300100);else put(cpu+32,0x300100);}
    bind(made,source);const before=Buffer.from(a.subarray(cpu,cpu+1256));
    const label=`${prefix}/${width}/${call}/${cpl}/${conform}/${gate}/${cross}/${problem}`;
    let result=vm.vm_run(port,9n,1);assert.equal(result,wait?2n:pf?115n:invalid?107n:5n,label);
    if(wait||pf||invalid){assert(a.subarray(cpu,cpu+1256).equals(before),label);assert.equal(vm.vm_source_retired(),0n);}
    if(pf){assert.equal(v.getUint32(port+24,true),14);const user=problem.startsWith('source-')?cpl:problem.startsWith('stack-')&&!inner?cpl:0;
      assert.equal(v.getUint32(port+28,true),(user===3?4:0)|(problem.startsWith('stack-')?2:0),label);++faults;}
    if(wait){++waits;assert.equal(vm.vm_run(port,9n,1),2n,label);assert(a.subarray(cpu,cpu+1256).equals(before));
      v.setUint32(dir+page*32+16,1,true);result=vm.vm_run(port,9n,1);assert.equal(result,invalid?107n:5n,label);++retries;}
    if(!pf&&!invalid){const expected=Buffer.from(before),nextCpl=inner?0:cpl,bytes=gate?8:width,sp=inner?0x9f08n:before.readBigUInt64LE(32);
      expected.writeBigUInt64LE(0x7100n,384);expected.writeBigUInt64LE(BigInt(56|nextCpl),488);
      if(call)expected.writeBigUInt64LE(sp-BigInt((inner?4:2)*bytes),32);if(inner)expected.writeBigUInt64LE(0n,496);
      expected.writeBigUInt64LE(43n,1128);assert(a.subarray(cpu,cpu+1256).equals(expected),label);
      assert.equal(vm.vm_source_retired(),1n,label);++success;
      if(call){const offset=payload(8)+Number(sp-0x9000n);
        const load=n=>bytes===8?v.getBigUint64(offset-n*bytes,true):bytes===4?BigInt(v.getUint32(offset-n*bytes,true)):BigInt(v.getUint16(offset-n*bytes,true));
        assert.equal(load(inner?3:1),BigInt(8|cpl),label);assert.equal(load(inner?4:2),entry+BigInt(source.length),label);}
    }
    if(invalid&&!pf)assert.equal(v.getUint32(port+28,true),56,label);
    assert.equal(vm.vm_run(port,8n,1),5n,'stale generation cannot consume a continuation');++comparisons;
    // This test's retained owner never lets a second guest writer mutate the
    // descriptor/TSS/stack while a wait is in flight. CPU receipts test aliases.
    assert(address>=0x8000n);
  }
}
vm.vm_close();console.log(JSON.stringify({status:'pass',comparisons,faults,waits,retries,success,
  scope:'actual C compiler/MMU/table: 4/6/10-byte cross-page/FS/GS/address32 source, descriptor/TSS/frame waits and PF, duplicate wait and exact retirement',linuxBoot:'not-tested'}));
