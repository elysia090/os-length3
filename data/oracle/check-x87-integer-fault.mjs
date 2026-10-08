// C/MMU fault priority and atomic integer loads. No guest ISA
// or exception interpreter is implemented by this model supervisor.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile,mode]=process.argv.slice(2),memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
if(mode&&mode!=='--arithmetic')throw new Error('VM.WASM COMPILER.WASM [--arithmetic]');
const arithmetic=mode==='--arithmetic';
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,port=cpu+2048,segments=cpu+1408,codeView=port+64,
  ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,payload=i=>cpu+(i+2)*4096,entry=0x400000n;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));let faults=0,success=0;
for(const prefix of [[],[0x66],[0x67],[0x48],[0x64],[0x65]])for(const width of arithmetic?[2,4]:[2,4,8])for(const group of arithmetic?[0,4,5]:[0]){
  const source=Buffer.from([...prefix,arithmetic?(width===4?0xda:0xde):width===4?0xdb:0xdf,
    arithmetic?(group<<3)|7:width===8?0x2f:7]);c.fill(0x90,ci,ci+4096);c.set(source,ci);
  assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),instance=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
    {machine:{memory,access:vm.vm_access,floating_wait:vm.vm_floating_wait}})).instance;
  for(const mask of [0n,4n,8n,12n])for(const pending of [false,true])for(const resident of [false,true])for(const crossing of [false,true]){
    vm.vm_close();a.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(3),0x8067);
    put(payload(3)+8,crossing?0x9067:resident?0x9065:0);put(payload(3)+16,resident?0xa065:0);
    const address=crossing?0x401fffn:0x401010n;put(cpu+56,address);put(cpu+384,entry);put(cpu+392,0x10202);put(cpu+400,0x80010031n|mask);
    put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0xd00);put(cpu+488,8);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    v.setUint16(cpu+1232,pending?0x37e:0x37f,true);v.setUint16(cpu+1234,pending?0x8081:0,true);v.setUint16(cpu+1236,arithmetic?0xfffd:0xffff,true);
    a.set(source,payload(4));a.fill(0,payload(5),payload(6)+4096);a[payload(5)+(crossing?4095:16)]=1;
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),instance.exports.cut);
    assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),data=Buffer.from(a.subarray(payload(5),payload(6)+4096));
    const expected=mask?7:pending?16:!resident?14:0,result=vm.vm_run(port,9n,1);
    if(expected){assert.equal(result,BigInt(expected)*8n+3n);assert.equal(v.getUint32(port+24,true),expected);assert(a.subarray(cpu,cpu+1256).equals(before));++faults;}
    else{assert.equal(result,1n);const top=arithmetic?0:7;
      assert.equal(v.getBigUint64(cpu+1152+top*8,true),0x8000000000000000n);
      assert.equal(v.getUint16(cpu+1216+top*2,true),arithmetic&&group===4?0xbfff:0x3fff);++success;}
    assert(a.subarray(payload(5),payload(6)+4096).equals(data));
  }
}
vm.vm_close();cc.compiler_close();console.log(JSON.stringify({status:'pass',family:arithmetic?'integer-arithmetic':'FILD',faults,success,oracle:'C #NM/#MF-before-access and readonly/cross-page/absent operand models',linuxBoot:'not-tested'}));
