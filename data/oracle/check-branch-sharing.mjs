// Exact cold-C branch topology and complete CPU models. Encoded grids are
// synthetic; this is neither an ISA oracle nor Linux/browser acceptance.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';

const [compilerFile,...flags]=process.argv.slice(2);
if(!compilerFile || flags.some(flag=>flag!=='--observe') || flags.length>1)
  throw new Error('usage: check-branch-sharing.mjs COMPILER.WASM [--observe]');
const compiler=await readFile(compilerFile),memory=new WebAssembly.Memory({initial:32});
const cc=(await WebAssembly.instantiate(compiler,{machine:{memory}})).instance.exports;
assert.equal(cc.compiler_entry_abi(),3);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const state=(report+80+4095)&~4095,data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const put=(at,value)=>view.setBigUint64(at,BigInt.asUintN(64,value),true);
const entries=[0x1400000n,0x100000000n,0xffffffff81034000n];
const values=[-2147483648,-8192,-129,-128,-1,0,1,127,8192,2147483647];
const families=[],bodies=new Map(),templates=[];
let comparisons=0,entryRefusals=0,emissions=0,bindingMismatches=0;
function taken(condition,flags) {
  const cf=!!(flags&1n),pf=!!(flags&4n),zf=!!(flags&64n),sf=!!(flags&128n),of=!!(flags&2048n);
  const predicates=[of,cf,zf,cf||zf,sf,pf,sf!==of,zf||sf!==of];
  return condition===undefined || (condition&1 ? !predicates[condition>>1] : predicates[condition>>1]);
}
const shapes=[{name:'jmp-near',opcode:[0xe9]},...Array.from({length:16},(_,condition)=>
  ({name:`jcc-near-${condition}`,opcode:[0x0f,0x80+condition],condition})),
  {name:'jmp-short',opcode:[0xeb],short:true},
  {name:'jcc-short-zero',opcode:[0x74],condition:4,short:true},
  // The LEA has an unrelated literal displacement. Binding the branch must
  // not accidentally parameterize that preceding memory-shaped operand.
  {name:'lea-then-jcc',opcode:[0x75],condition:5,short:true,prefix:[0x48,0x8d,0x43,0x19]},
  {name:'cmp-then-jcc',opcode:[0x0f,0x84],condition:4,prefix:[0x48,0x39,0xd8],compare:true}];
try {
  for(const shape of shapes) {
    const distinct=new Set(),width=shape.short?1:4,displacements=shape.short?[-128,-1,0,1,127]:values;
    const prefix=shape.prefix||[],length=prefix.length+shape.opcode.length+width;
    for(const entry of entries)for(const displacement of displacements) {
      data.fill(0x90,input,input+4096);data.set(prefix,input);data.set(shape.opcode,input+prefix.length);
      data.writeIntLE(displacement,input+prefix.length+shape.opcode.length,width);
      assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
      assert.equal(cc.compiler_emit(entry,prefix.length?2:1,output,65536,report),0,shape.name);
      assert.equal(view.getBigUint64(report+24,true),prefix.length?2n:1n);
      assert.equal(view.getBigUint64(report+32,true),BigInt(length));
      const binding=view.getUint32(report+76,true);
      if(binding!==(displacement>>>0))++bindingMismatches;
      const body=Buffer.from(data.subarray(output,output+Number(view.getBigUint64(report+40,true))));
      const identity=hash(body);distinct.add(identity);bodies.set(identity,body);templates.push(body);++emissions;
      const module=new WebAssembly.Module(body);
      assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
      const cut=new WebAssembly.Instance(module,{machine:{memory}}).exports.cut;
      // The report can be recycled immediately; the emitted call must use its
      // immutable admitted value, not re-read compiler memory or current RIP.
      data.fill(0xa5,report,report+80);
      for(let rank=0;rank<64;++rank) {
        data.fill(0x93,state,state+4096);
        for(let reg=0;reg<16;++reg)put(state+reg*8,BigInt(reg+1)*0x123456789abcdefn);
        const flags=0x202n|BigInt(rank&1)|BigInt(rank>>1&1)*4n|BigInt(rank>>2&1)*64n
          |BigInt(rank>>3&1)*128n|BigInt(rank>>4&1)*2048n|BigInt(rank>>5&1)*65536n;
        if(shape.compare) {put(state,BigInt(rank&1));put(state+24,0n);}
        put(state+384,entry);put(state+392,flags);put(state+600,0x400n);put(state+1128,~0n);
        const expected=Buffer.from(data.subarray(state,state+4096)),ev=new DataView(expected.buffer,expected.byteOffset);
        if(prefix.length&&!shape.compare)ev.setBigUint64(0,BigInt.asUintN(64,view.getBigUint64(state+24,true)+25n),true);
        const observedFlags=shape.compare ? (flags&~0x8d5n)|(rank&1?0n:0x44n) : flags;
        ev.setBigUint64(384,BigInt.asUintN(64,entry+BigInt(length)+(taken(shape.condition,observedFlags)?BigInt(displacement):0n)),true);
        ev.setBigUint64(392,observedFlags&~0x10000n,true);
        ev.setBigUint64(1128,prefix.length?1n:0n,true);
        assert.equal(cut(state,-1,entry,binding),1n);
        assert(data.subarray(state,state+4096).equals(expected),`${shape.name}: complete state rank ${rank}`);++comparisons;
      }
      for(const mismatch of [true,false]) {
        put(state+384,mismatch?entry+1n:entry);put(state+392,mismatch?0x202n:0x10302n);
        const before=Buffer.from(data.subarray(state,state+4096));
        assert.equal(cut(state,-1,entry,binding),6n);assert(data.subarray(state,state+4096).equals(before));++entryRefusals;
      }
    }
    families.push({name:shape.name,emissions:entries.length*displacements.length,distinctExactBodies:distinct.size,desiredBodies:1});
  }
  const owner=new CompiledModules({machine:{memory}},{maximumEntries:1024,maximumBytes:262144});
  for(let rank=0;rank<4096;++rank)await owner.get(templates[rank%templates.length]);
  const result={format:'cold-branch-sharing-v1',status:bindingMismatches||families.some(f=>f.distinctExactBodies!==1)?'red':'pass',
    linuxBoot:'not-tested',compilerBytes:compiler.length,compilerSha256:hash(compiler),entryABI:cc.compiler_entry_abi(),
    emissions,comparisons,entryRefusals,bindingMismatches,families,
    distinctExactBodies:bodies.size,witnessBytes:[...bodies.values()].reduce((n,b)=>n+b.length,0),
    boundedConstruction:{samples:4096,...owner.stats()},
    scope:'synthetic signed rel8/rel32 grid, all 16 conditions, incoming flags, LEA/CMP prefixes, whole CPU/window and RF/retirement models; not native ISA, actual hot frequency or Linux/browser speedup'};
  assert.equal(owner.stats().compilations,bodies.size);owner.close();
  console.log(JSON.stringify(result,null,2));
  if(!flags.includes('--observe'))assert.equal(result.status,'pass','branch displacement still partitions one topology');
} finally {cc.compiler_close();}
