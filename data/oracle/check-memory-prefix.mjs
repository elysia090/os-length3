// Same guest sequence through two C compilers and the same C VM/MMU.
// The old split is a differential reference, not a runtime fallback.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,oldFile,newFile]=process.argv.slice(2);if(!newFile)throw new Error('VM.WASM SPLIT-COMPILER.WASM FUSED-COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:32}),vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),dir=vm.vm_arena_min(),base=dir+32768,segments=base+1408,port=base+2048,codeView=port+64,rows=dir+1024;
const compilers=await Promise.all([oldFile,newFile].map(async file=>{const memory=new WebAssembly.Memory({initial:32});
  const cc=(await WebAssembly.instantiate(await readFile(file),{machine:{memory}})).instance.exports;
  return {cc,a:Buffer.from(memory.buffer),v:new DataView(memory.buffer),input:cc.compiler_arena_min()};}));
const put=(p,x)=>v.setBigUint64(p,BigInt.asUintN(64,BigInt(x)),true),entry=0x400000n,physical=[0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000];
const page=pa=>base+pa+4096,table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));
const sources=[
  [0x48,0xc7,0xc0,0x25,0,0,0,0x48,0x83,0xc0,8,0x48,0x8b,0x17],
  [0x31,0xc0,0x48,0x83,0xc0,8,0x48,0x89,0x07],
  [0x48,0x89,0xc7,0x48,0x0f,0xb7,0x17],
  [0x48,0x8d,0x78,4,0x66,0x8b,0x07],
  [0x48,0xc7,0xc0,0x25,0,0,0,0x48,0x89,0x07],
  [0x48,0x8d,0x78,4,0x48,0x0f,0xbe,0x17]
].map(x=>Buffer.from(x));
const modes=['normal','absent','write-protect','noncanonical','alignment-context','wait'];
function reset(source,mode){vm.vm_close();a.fill(0,dir);
  const header=dir+4096,command=header+4096;
  a[header+0x1f1]=31;a[header+0x200]=0xeb;a[header+0x201]=0x6a;a[header+0x211]=1;a[header+0x236]=1;
  const small=(p,x,n)=>{for(let i=0;i<n;++i)a[p+i]=Number(BigInt(x)>>BigInt(8*i)&255n);};
  small(header+0x1fe,0xaa55,2);small(header+0x202,0x53726448,4);small(header+0x206,0x20f,2);small(header+0x1f4,0x2e640,4);
  small(header+0x230,0x200000,4);small(header+0x258,0x1000000,8);small(header+0x260,0xe62000,4);small(header+0x22c,0x37ffffff,4);small(header+0x238,2047,4);
  a[command]=0x61;assert.equal(vm.vm_boot_prepare(header,4096,0x2ea400n,0x65432n,0x8000000n,command,1),0);
  physical.forEach((pa,i)=>{put(dir+i*32,pa);v.setUint32(dir+i*32+8,pa+4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
  put(page(0x1000),0x2067);put(page(0x2000),0x3067);put(page(0x3000)+2*8,0x4067);put(page(0x4000),0x8067);
  put(page(0x4000)+8,mode==='absent'?0:mode==='write-protect'?0x9065:mode==='wait'?0xd067:0x9067);put(page(0x4000)+16,0xa067);
  for(let i=0;i<8192;++i)a[page(0x9000)+i]=(i*37+11)&255;a.fill(0x90,page(0x8000),page(0x8000)+4096);a.set(source,page(0x8000));
  for(let r=0;r<16;++r)put(base+r*8,0xabcdef0012340000n+BigInt(r));
  const address=mode==='noncanonical'?0x800000000000n:0x401200n;
  put(base,address);put(base+56,address);put(base+384,entry);put(base+392,mode==='alignment-context'?0x50202:0x10202);
  put(base+400,0x80010011);put(base+408,0x1000);put(base+416,0x620);put(base+424,0xd00);put(base+488,19);put(base+600,0x400);put(base+1128,42);put(port,9);
  v.setUint32(base+612,0x1f80,true);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);v.setUint32(segments+52,0xc0f3,true);
  assert.equal(vm.vm_open(base,a.length-base,4096,dir,physical.length,physical.length+1,dir+2048,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
async function run(compiler,source,mode){reset(source,mode);let calls=0,last;
  const {cc,a:c,v:cv,input}=compiler,output=input+8192,report=output+65536;
  for(;calls<8;++calls){const rip=v.getBigUint64(base+384,true);if(rip===entry+BigInt(source.length))break;
    const queried=vm.vm_source_query(port,rip,16,codeView,rows);
    if(queried===6n&&mode==='wait'&&calls>0){
      // The split reference's one-instruction resource wait owns its row;
      // cold query/rebind is correctly refused until that same C entry resumes.
      assert.equal(v.getUint32(rows+12,true),1);assert.equal(last,2n);
      last=vm.vm_run(port,9n,1);assert.equal(last,1n);continue;
    }
    assert([0n,1n].includes(queried),`source query ${queried}: ${source.toString('hex')} ${mode} call${calls} rip${rip.toString(16)}`);
    if(queried===1n){
    c.fill(0x90,input,input+4096);c.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(rip,16,output,65536,report),0);
    const n=Number(cv.getBigUint64(report+40,true)),made=(await WebAssembly.instantiate(c.subarray(output,output+n),{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
    table.set(v.getUint32(rows+16,true),made);
    assert.equal(vm.vm_source_publish(Number(cv.getBigUint64(report+32,true)),Number(cv.getBigUint64(report+24,true)),cv.getUint32(report+76,true),rows),0);
    }
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);last=vm.vm_run(port,9n,1);cc.compiler_close();
    if(last===2n&&mode==='wait'){
      const request=port+256;assert.equal(vm.vm_page_prepare(port,request),0);
      assert.equal(v.getBigUint64(request+8,true),0xd000n);
      const ticket=v.getBigUint64(request+40,true);assert.equal(vm.vm_page_commit(port,ticket),0);assert.equal(vm.vm_page_commit(port,ticket),-1);
      continue;
    }
    if(last!==1n){++calls;break;}
  }
  return {calls,last,state:Buffer.from(a.subarray(base,base+1256)),ram:Buffer.from(a.subarray(page(0x1000),page(0xa000)+4096)),fault:Buffer.from(a.subarray(port+16,port+32))};
}
let comparisons=0,reduced=0;
for(const source of sources)for(const mode of modes){const old=await run(compilers[0],source,mode),now=await run(compilers[1],source,mode);
  assert.equal(now.last,old.last,`${source.toString('hex')} ${mode} result`);
  assert(now.state.equals(old.state),`${source.toString('hex')} ${mode} whole CPU: ${Array.from(old.state.entries()).filter(([i,x])=>now.state[i]!==x).slice(0,10).map(([i,x])=>`${i}:${now.state[i]}/${x}`)}`);
  assert(now.ram.equals(old.ram),`${mode} whole physical table/data/code bytes`);assert(now.fault.equals(old.fault));
  assert.equal(now.calls,mode==='wait'?2:1);assert.equal(old.calls,mode==='wait'?3:2);++reduced;++comparisons;
}
vm.vm_close();console.log(JSON.stringify({format:'precise-memory-prefix-v1',status:'pass',comparisons,reduced,
  scope:'compiled split/fused whole-state/RAM/fault differential; plain load/store/sign-extension, changed address/flags, missing/protection/canonical/AC frontiers; NOT native hardware or Linux boot'},null,2));
