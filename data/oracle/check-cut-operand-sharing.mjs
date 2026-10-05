// Exact C-emitted body identity on matched release bytes, not guest execution.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';
const [compilerFile,kernelFile,...flags]=process.argv.slice(2);
if(!kernelFile || flags.some(x=>x!=='--observe' && x!=='--memory' && !x.startsWith('--vm='))
    || new Set(flags).size!==flags.length || flags.filter(x=>x.startsWith('--vm=')).length>1)
  throw new Error('usage: check-cut-operand-sharing.mjs COMPILER.WASM BZIMAGE [--observe] [--memory] [--vm=VM.WASM]');
const vmFile=flags.find(x=>x.startsWith('--vm='))?.slice(5);
if(vmFile==='')throw new Error('empty VM path');
const digest=b=>createHash('sha256').update(b).digest('hex');
const binary=await readFile(compilerFile),kernel=await readFile(kernelFile);
assert.equal(digest(kernel),'21771c757255406ce090faa6c5108b72618f794c8e46379a4a3d50dc21364e67');
const gzip=kernel.indexOf(Buffer.from([31,139,8]));assert(gzip>=0);
const elf=gunzipSync(kernel.subarray(gzip));
assert.equal(digest(elf),'6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9');
const memory=new WebAssembly.Memory({initial:32});
const cc=(await WebAssembly.instantiate(binary,{machine:{memory}})).instance.exports;
assert.equal(cc.compiler_report_bytes(),80);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
const families=[],templates=[];
try {
  // These are measured hot source coordinates, not a runtime opcode table.
  for(const [name,first,count] of [['load',0xffffffff810a7f5dn,6],['store',0xffffffff810a7f64n,6]]) {
    const modules=[],bindings=[];
    for(let rank=0;rank<count;++rank) {
      const entry=first+BigInt(rank)*14n,page=entry&~4095n;
      // First PT_LOAD: file offset 0x200000 at virtual 0xffffffff81000000.
      const offset=Number(page-0xffffffff81000000n)+0x200000;
      data.set(elf.subarray(offset,offset+4096),input);
      assert.equal(cc.compiler_open_pages(input,1,page,9n),0);
      assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
      assert.equal(view.getBigUint64(report+24,true),1n);
      assert.equal(view.getBigUint64(report+32,true),7n);
      modules.push(Buffer.from(data.subarray(output,output+Number(view.getBigUint64(report+40,true)))));
      templates.push(modules.at(-1));
      bindings.push(view.getUint32(report+76,true));
    }
    families.push({name,sourceCoordinates:count,distinctExactModules:new Set(modules.map(digest)).size,
      moduleBytes:modules.map(b=>b.length),bindings,desiredTopologyCount:1});
  }
  if(flags.includes('--memory'))for(const example of [
    {name:'rdi-load',prefix:[0x48,0x8b,0x87]},
    {name:'rdi-store',prefix:[0x48,0x89,0x87]},
    {name:'rsp-load',prefix:[0x48,0x8b,0x84,0x24]},
    {name:'scaled-index-load',prefix:[0x48,0x8b,0x84,0x8f]},
    {name:'address32-index-load',prefix:[0x67,0x48,0x8b,0x84,0x8f]},
    {name:'disp8-load',prefix:[0x48,0x8b,0x47],width:1},
  ]){
    // Deliberately encoded operand grid, NOT additional release coordinates.
    // This tests exact C topology identity; independent CPU/MMU tests are separate.
    const modules=[],bindings=[],width=example.width||4;
    for(const displacement of width===1?[-128,-8,-1,0,1,120,127]
      :[-2147483648,-8192,-4096,-8,-1,0,1,4092,4095,2147483647]){
      const page=Buffer.alloc(4096,0x90);page.set(example.prefix);
      page.writeIntLE(displacement,example.prefix.length,width);data.set(page,input);
      assert.equal(cc.compiler_open_pages(input,1,0x400000n,9n),0);
      assert.equal(cc.compiler_emit(0x400000n,1,output,65536,report),0);
      assert.equal(view.getBigUint64(report+24,true),1n);
      assert.equal(view.getBigUint64(report+32,true),BigInt(example.prefix.length+width));
      const body=Buffer.from(data.subarray(output,output+Number(view.getBigUint64(report+40,true))));
      modules.push(body);templates.push(body);bindings.push(view.getUint32(report+76,true));
    }
    families.push({name:example.name,sourceCoordinates:modules.length,
      source:'synthetic signed operand grid, not immutable release coordinates',
      distinctExactModules:new Set(modules.map(digest)).size,moduleBytes:modules.map(b=>b.length),
      bindings,desiredTopologyCount:1});
  }
  const unmet=families.filter(f=>f.distinctExactModules!==f.desiredTopologyCount).length;
  let construction;
  if(vmFile){
    const vmMemory=new WebAssembly.Memory({initial:16});
    const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory:vmMemory}})).instance.exports;
    assert.equal(vm.vm_entry_abi(),cc.compiler_entry_abi(),'paired frozen ABI, no legacy adapter');
    const owner=new CompiledModules({machine:{memory:vmMemory,access:vm.vm_access}},
      {maximumEntries:1024,maximumBytes:262144});
    const samples=4096,start=performance.now();
    for(let rank=0;rank<samples;++rank)await owner.get(templates[rank%templates.length]);
    construction={samples,elapsedMs:performance.now()-start,engine:owner.stats(),
      scope:flags.includes('--memory')?'matched release plus explicitly synthetic memory-operand grid; bounded constructor only, no guest execution or Linux/browser timing'
        :'matched 12 immutable hot load/store emissions; bounded constructor only, no guest execution or Linux/browser timing'};
    assert.equal(owner.stats().compilations,new Set(templates.map(digest)).size);
    owner.close();vm.vm_close();
  }
  console.log(JSON.stringify({format:'cut-operand-sharing-v1',status:unmet?'red':'pass',
    linuxBoot:'not-tested',kernelSha256:digest(kernel),decompressedElfSha256:digest(elf),
    compilerBytes:binary.length,compilerSha256:digest(binary),entryABI:cc.compiler_entry_abi(),
    families,construction,unmetFamilies:unmet,scope:flags.includes('--memory')
      ?'exact cold C body identity, matched immutable release ELF plus explicitly synthetic operand grids; no runtime admission or native ISA proof'
      :'exact cold C body identity, matched immutable release ELF; no runtime admission or native ISA proof'},null,2));
  if(!flags.includes('--observe'))assert.equal(unmet,0,'literal displacement still splits a shared topology');
}finally{cc.compiler_close();}
