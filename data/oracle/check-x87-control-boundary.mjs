// Control/status publication through the real C compiler, MMU and table.
// Native word/pending receipts are a separate independent population.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);if(!compilerFile)throw new Error('VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,segments=cpu+1408,port=cpu+2048,view=port+64;
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,entry=0x400000n,payload=i=>cpu+(i+2)*4096;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));
let comparisons=0,nm=0,mf=0,ferr=0,pf=0,waits=0,retries=0,success=0;
for(const prefix of [0,0x66,0x67,0x48,0x64,0x65,0xf2,0xf3]){
  const source=Buffer.from([...(prefix?[prefix]:[]),0xd9,0x28]);c.fill(0x90,ci,ci+4096);c.set(source,ci);
  assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
    {machine:{memory,access:vm.vm_access,floating_wait:vm.vm_floating_wait}})).instance.exports.cut;cc.compiler_close();
  for(const cpl of [0,3])for(const cross of [false,true])for(const target of [0,0xffff,0x37f,0x1a55])
  for(const problem of ['none','readonly','pf','wait'])for(const mask of [0,4,8,12])for(const ne of [false,true])for(const pending of [0,1,2]){
    vm.vm_close();a.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);
    put(payload(3),0x8067);put(payload(3)+8,problem==='readonly'?0x9065:0x9067);put(payload(3)+16,problem==='readonly'?0xa065:0xa067);
    a.set(source,payload(4));const address=cross?0x401fffn:0x401010n,bias=prefix===0x64?0x1000n:prefix===0x65?0x2000n:0n;
    put(cpu,address-bias+(prefix===0x67?0xabcdef00000000n:0n));v.setUint16(payload(5)+Number(address-0x401000n),target,true);
    put(cpu+384,entry);put(cpu+392,0x10a93);put(cpu+400,BigInt(0x80010011|mask|(ne?32:0)));put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0x500);
    put(cpu+488,8|cpl);put(cpu+600,0x400);put(cpu+1128,42);put(cpu+1240,0x12340000);put(cpu+1248,0x56780000);put(port,9);
    const oldCw=pending===1?0x37e:0x37f,oldSw=pending?0x8081:0x4700;
    v.setUint16(cpu+1232,oldCw,true);v.setUint16(cpu+1234,oldSw,true);v.setUint16(cpu+1236,0x5a5a,true);
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b|(cpl<<5),true);put(segments+72,0x1000);put(segments+88,0x2000);
    const page=cross?2:1;if(problem==='pf')put(payload(3)+page*8,0);
    if(problem==='wait')v.setUint32(dir+(4+page)*32+16,3,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,view,rows),1n);table.set(v.getUint32(rows+16,true),cut);
    assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),fault=mask?7:pending===1&&ne?16:pending!==1&&problem==='pf'?14:0;
    const legacy=!mask&&pending===1&&!ne,wait=!mask&&pending!==1&&problem==='wait';
    const label=`${prefix}/${cpl}/${cross}/${target}/${problem}/${mask}/${ne}/${pending}`;
    let result=vm.vm_run(port,9n,1);assert.equal(result,fault?BigInt(fault)*8n+3n:legacy?34n:wait?2n:1n,label);
    if(fault||legacy||wait){assert(a.subarray(cpu,cpu+1256).equals(before),label);assert.equal(vm.vm_source_retired(),0n);}
    if(fault){assert.equal(v.getUint32(port+24,true),fault);assert.equal(v.getUint32(port+28,true),fault===14&&cpl===3?4:0);
      fault===7?++nm:fault===16?++mf:++pf;}
    if(legacy)++ferr;
    if(wait){++waits;assert.equal(vm.vm_run(port,9n,1),2n,label);assert(a.subarray(cpu,cpu+1256).equals(before));
      v.setUint32(dir+(4+page)*32+16,1,true);assert.equal(vm.vm_run(port,9n,1),1n,label);++retries;}
    if(!fault&&!legacy){const expected=Buffer.from(before),cw=(target&0x1f3f)|0x40;
      expected.writeUInt16LE(cw,1232);expected.writeUInt16LE((oldSw&0x7f7f)|((oldSw&~cw&63)?0x8080:0),1234);
      expected.writeBigUInt64LE(entry+BigInt(source.length),384);expected.writeBigUInt64LE(0xa93n,392);expected.writeBigUInt64LE(43n,1128);
      assert(a.subarray(cpu,cpu+1256).equals(expected),label);assert.equal(vm.vm_source_retired(),1n);++success;}
    ++comparisons;
  }
}
vm.vm_close();console.log(JSON.stringify({status:'pass',comparisons,nm,mf,ferr,pf,waits,retries,success,
  scope:'actual C compiler/MMU/table: full CW/status publication, old-pending precedence, exact cross-page/read-only/FS/GS/address32 source and retries',linuxBoot:'not-tested'}));
