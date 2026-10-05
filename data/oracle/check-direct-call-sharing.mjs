// Same admitted CALL transition, exact topology sharing. Encoded grids are
// synthetic: not a Linux hot-frequency census or an independent ISA oracle.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';
const [vmFile,compilerFile,...flags]=process.argv.slice(2);
if(!compilerFile||flags.some(x=>x!=='--observe'&&!x.startsWith('--native='))
    ||new Set(flags).size!==flags.length||flags.filter(x=>x.startsWith('--native=')).length>1)
  throw new Error('usage: check-direct-call-sharing.mjs VM.WASM COMPILER.WASM [--observe] [--native=DIRECTORY]');
const nativeDirectory=flags.find(x=>x.startsWith('--native='))?.slice(9);
if(nativeDirectory==='')throw new Error('empty native directory');
const memory=new WebAssembly.Memory({initial:16}),coldMemory=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const compiler=await readFile(compilerFile);
const cc=(await WebAssembly.instantiate(compiler,{machine:{memory:coldMemory}})).instance.exports;
const cold=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),directory=vm.vm_arena_min();
const base=directory+4096,segments=base+1408,port=base+2048,rows=directory+512;
const slot=vm.__indirect_function_table.grow(1),stack=0x500000n,codePhysical=0xa000n;
const pageOffset=physical=>base+Number(physical)+4096;
const put=(at,value)=>v.setBigUint64(at,BigInt.asUintN(64,value),true);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const cpu=()=>Buffer.from(data.subarray(base,base+1256)),hidden=()=>Buffer.from(data.subarray(segments,segments+136));
const ram=()=>Buffer.from(data.subarray(pageOffset(0x1000n),pageOffset(0xc000n)+4096));
function reset(entry,source,rsp,mappedStack=stack) {
  vm.vm_close();data.fill(0,base);put(port,9n);
  for(let rank=0;rank<12;++rank){const physical=BigInt(rank+1)*4096n,at=directory+rank*32;
    put(at,physical);v.setUint32(at+8,Number(physical)+4096,true);v.setUint32(at+12,3,true);
    v.setUint32(at+16,1,true);data.fill(0,at+20,at+32);}
  let nextTable=0x2000n;
  function map(address,physical){let table=0x1000n;
    for(const shift of [39n,30n,21n]){const at=pageOffset(table)+Number(address>>shift&511n)*8;
      let pte=v.getBigUint64(at,true);if(!pte){assert(nextTable<codePhysical);pte=nextTable|0x67n;nextTable+=4096n;put(at,pte);}table=pte&~4095n;}
    put(pageOffset(table)+Number(address>>12n&511n)*8,physical|0x67n);
  }
  map(entry,codePhysical);map(mappedStack,0xb000n);map(mappedStack+4096n,0xc000n);
  data.set(source,pageOffset(codePhysical));data.fill(0x93,pageOffset(0xb000n),pageOffset(0xc000n)+4096);
  for(let reg=0;reg<16;++reg)put(base+reg*8,BigInt(reg+1)*0x123456789abcdefn);
  put(base+32,rsp);put(base+384,entry);put(base+392,0x10246n);put(base+400,0x80010011n);
  put(base+408,0x1000n);put(base+416,32n);put(base+424,0xd00n);put(base+488,8n);put(base+496,16n);
  put(base+600,0x400n);put(base+1128,123n);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
  v.setUint32(segments+52,0xc093,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,directory,12,12,directory+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
const entries=[0x400000n,0x100000000n,0xffffffff81040000n];
const displacements=[-2147483648,-8192,-129,-1,0,1,127,8192,2147483647];
const prefixes=[[],[0x67],[0x48]],bodies=new Map(),templates=[],families=[];
let emissions=0,comparisons=0,faults=0,entryRefusals=0,bindingMismatches=0;
for(const prefix of prefixes){const distinct=new Set();
  for(const entry of entries)for(const displacement of displacements){
    const source=Buffer.alloc(prefix.length+5);source.set(prefix);source[prefix.length]=0xe8;
    source.writeInt32LE(displacement,prefix.length+1);cold.fill(0x90,input,input+4096);cold.set(source,input);
    assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+32,true),BigInt(source.length));assert.equal(cv.getBigUint64(report+24,true),1n);
    const binding=cv.getUint32(report+76,true);if(binding!==(displacement>>>0))++bindingMismatches;
    const body=Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
    const identity=hash(body);bodies.set(identity,body);templates.push(body);distinct.add(identity);++emissions;
    const cut=(await WebAssembly.instantiate(body,{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
    vm.__indirect_function_table.set(slot,cut);cold.fill(0xa5,report,report+80);
    for(const rsp of [stack+16n,stack+4101n])for(const mode of [0,1]) {
      reset(entry,source,rsp);const state=cpu(),cache=hidden(),image=ram();
      state.writeBigUInt64LE(rsp-8n,32);state.writeBigUInt64LE(BigInt.asUintN(64,entry+BigInt(source.length+displacement)),384);
      state.writeBigUInt64LE(0x246n,392);state.writeBigUInt64LE(124n,1128);
      image.writeBigUInt64LE(entry+BigInt(source.length),Number(0xa000n+rsp-stack-8n));
      if(mode){put(rows,entry);v.setUint32(rows+8,source.length,true);v.setUint32(rows+12,1,true);
        v.setUint32(rows+16,slot,true);v.setUint32(rows+20,binding,true);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
        assert.equal(vm.vm_run(port,9n,1),5n);assert.equal(vm.vm_source_retired(),1n);assert.equal(vm.vm_completed(),1);
      }else assert.equal(cut(base,port,entry,binding),1n);
      assert(cpu().equals(state)&&hidden().equals(cache)&&ram().equals(image),'complete CPU/cache and exact return-address store');++comparisons;
    }
    for(const [rsp,vector,error]of [[0x800000000000n,14,2],[0x800000000008n,12,0]]) {
      reset(entry,source,rsp);const before=cpu(),cache=hidden(),image=ram();
      assert.equal(cut(base,port,entry,binding),BigInt(vector*8+3));assert(cpu().equals(before)&&hidden().equals(cache)&&ram().equals(image));++faults;
      assert.equal(v.getUint32(port+24,true),vector);assert.equal(v.getUint32(port+28,true),error);
    }
    reset(entry,source,stack+16n);const before=cpu(),cache=hidden(),image=ram();
    assert.equal(cut(base,port,entry+1n,binding),6n);assert(cpu().equals(before)&&hidden().equals(cache)&&ram().equals(image));++entryRefusals;
  }
  families.push({prefix,emissions:entries.length*displacements.length,distinctExactBodies:distinct.size,desiredBodies:1});
}
const owner=new CompiledModules({machine:{memory,access:vm.vm_access}},{maximumEntries:1024,maximumBytes:262144});
for(let request=0;request<4096;++request)await owner.get(templates[request%templates.length]);
let nativeColdParity=0,nativeComparisons=0;
if(nativeDirectory)for(let form=0;form<30;++form) {
  const prefix=`${nativeDirectory}/direct-call-${form}`;
  const meta=JSON.parse(await readFile(`${prefix}.json`,'utf8')),source=await readFile(`${prefix}.source-page`);
  const records=await readFile(`${prefix}.cases`),entry=BigInt(meta.entry),stackAddress=0x12340000n;
  assert.equal(records.length,128*38*8);assert.equal(meta.words,38);assert.equal(meta.rows,128);
  cold.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry&~4095n,9n),0);
  assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
  assert.equal(cv.getUint32(report+76,true),meta.operandBinding);assert.equal(cv.getBigUint64(report+32,true),BigInt(meta.sourceBytes));
  const body=Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
  assert.deepEqual(body,await readFile(`${prefix}.wasm`),'fresh native C/cold C byte parity');++nativeColdParity;
  const cut=(await WebAssembly.instantiate(body,{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
  vm.__indirect_function_table.set(slot,cut);
  for(let row=0;row<128;++row)for(const mode of [0,1]) {
    const word=index=>records.readBigUInt64LE((row*38+index)*8);
    reset(entry,source,word(4),stackAddress);
    for(let reg=0;reg<16;++reg)put(base+reg*8,word(reg));put(base+392,word(16));
    const state=cpu(),cache=hidden(),image=ram();
    for(let reg=0;reg<16;++reg)state.writeBigUInt64LE(word(17+reg),reg*8);
    state.writeBigUInt64LE(word(33),392);state.writeBigUInt64LE(word(37),384);state.writeBigUInt64LE(124n,1128);
    assert.equal(word(35),entry+BigInt(meta.sourceBytes));
    image.writeBigUInt64LE(word(35),Number(0xa000n+word(34)-stackAddress));
    if(mode){put(rows,entry);v.setUint32(rows+8,meta.sourceBytes,true);v.setUint32(rows+12,1,true);
      v.setUint32(rows+16,slot,true);v.setUint32(rows+20,meta.operandBinding,true);
      assert.equal(vm.vm_bind_execution(rows,1,9n),0);assert.equal(vm.vm_run(port,9n,1),5n);assert.equal(vm.vm_source_retired(),1n);
    }else assert.equal(cut(base,port,entry,meta.operandBinding),1n);
    assert(cpu().equals(state)&&hidden().equals(cache)&&ram().equals(image),`native CALL form ${form}, row ${row}, mode ${mode}`);
    ++nativeComparisons;
  }
}
const result={format:'cold-direct-call-sharing-v1',status:bindingMismatches||families.some(x=>x.distinctExactBodies!==1)?'red':'pass',
  compilerBytes:compiler.length,compilerSha256:hash(compiler),entryABI:cc.compiler_entry_abi(),emissions,comparisons,faults,entryRefusals,
  bindingMismatches,families,distinctExactBodies:bodies.size,witnessBytes:[...bodies.values()].reduce((sum,body)=>sum+body.length,0),
  engineReuse:owner.stats(),nativeColdParity,nativeComparisons,
  scope:'synthetic canonical direct CALL grid; separate successful native GPR/flags/return-word observations if supplied; no noncanonical-target CALL-fault equivalence claim',linuxBoot:'not-tested'};
owner.close();vm.vm_close();console.log(JSON.stringify(result,null,2));
if(result.status==='red'&&!flags.includes('--observe'))process.exitCode=1;
