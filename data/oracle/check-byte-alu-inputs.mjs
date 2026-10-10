// Exhaust the entire 8-bit binary operand domain, both incoming carry values.
// This independent mathematical specification is test-only; execution below
// calls the actual emitted ordinary Wasm, never this specification as fallback.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateProfileFixture} from './profile-input-fixture.mjs';
const [compilerFile,fixtureFile]=process.argv.slice(2);
if(!fixtureFile)throw new Error('COMPILER.WASM INPUTS.json');
const compilerBytes=await readFile(compilerFile),fixture=JSON.parse(await readFile(fixtureFile,'utf8'));
validateProfileFixture(fixture);
const cm=new WebAssembly.Memory({initial:32}),cc=(await WebAssembly.instantiate(compilerBytes,{machine:{memory:cm}})).instance.exports;
const c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const memory=new WebAssembly.Memory({initial:4}),data=Buffer.from(memory.buffer),cpu=65536,entry=0x400000n;
const seed=Buffer.alloc(1256);for(let i=0;i<seed.length;++i)seed[i]=(i*37+23)&255;
seed.writeBigUInt64LE(entry,384);seed.writeBigUInt64LE(42n,1128);seed.writeBigUInt64LE(0x400n,600);
const parity=Array.from({length:256},(_,value)=>{let bits=0;for(let x=value;x;x>>=1)bits+=x&1;return (bits&1)?0:4;});
const mask=0x8d5,ops=['add','adc','sub','sbb','and','or','xor','cmp','test'];
let comparisons=0;const groups=[];
for(const operation of ops){
  const record=fixture.records.find(r=>r.feature==='integer'&&r.family===operation&&r.shape==='gpr-rm'&&r.width===8&&r.dst===0&&r.src===1&&!r.addressRole);
  assert(record,`independent GNU encoding: ${operation} al, cl`);
  const source=Buffer.from(record.bytes,'hex');c.fill(0x90,input,input+4096);c.set(source,input);
  assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
  const bytes=Number(cv.getBigUint64(report+40,true));
  const module=await WebAssembly.compile(c.subarray(output,output+bytes));
  assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
  const cut=(await WebAssembly.instantiate(module,{machine:{memory}})).exports.cut,binding=cv.getUint32(report+76,true);
  cc.compiler_close();let count=0;
  for(let carry=0;carry<2;++carry)for(let left=0;left<256;++left)for(let right=0;right<256;++right){
    let result,cf=0,of=0,af=0;
    if(operation==='add'||operation==='adc'){
      const sum=left+right+(operation==='adc'?carry:0);result=sum&255;cf=sum>255?1:0;
      of=(~(left^right)&(left^result)&128)?0x800:0;af=(left^right^result)&16;
    }else if(operation==='sub'||operation==='sbb'||operation==='cmp'){
      const subtrahend=right+(operation==='sbb'?carry:0);result=(left-subtrahend)&255;cf=left<subtrahend?1:0;
      of=((left^right)&(left^result)&128)?0x800:0;af=(left^right^result)&16;
    }else result=operation==='or'?left|right:operation==='xor'?left^right:left&right;
    const oldFlags=0x50202|((left^(right<<2))&0x8d4)|carry;
    seed[0]=left;seed[8]=right;seed.writeBigUInt64LE(BigInt(oldFlags),392);data.set(seed,cpu);
    const expected=Buffer.from(seed);
    if(operation!=='cmp'&&operation!=='test')expected[0]=result;
    // AF is undefined for logical instructions. The public compiler contract
    // chooses zero there; this does not attribute that choice to silicon.
    const flags=cf|parity[result]|af|(result===0?64:0)|(result&128)|of;
    expected.writeBigUInt64LE(BigInt((oldFlags&~(mask|0x10000))|flags),392);
    expected.writeBigUInt64LE(entry+BigInt(source.length),384);expected.writeBigUInt64LE(43n,1128);
    const actual=cut(cpu,-1,entry,binding);
    if(actual!==1n||!data.subarray(cpu,cpu+1256).equals(expected)){
      const differences=[];for(let i=0;i<1256&&differences.length<8;++i)if(data[cpu+i]!==expected[i])differences.push([i,data[cpu+i],expected[i]]);
      assert.fail(`${operation} ${left}/${right}/CF${carry}: result=${actual} state=${JSON.stringify(differences)}`);
    }++comparisons;++count;
  }
  groups.push({operation,comparisons:count,source:record.bytes});
}
console.log(JSON.stringify({format:'exhaustive-byte-alu-v1',status:'pass',comparisons,groups,
  compilerSha256:createHash('sha256').update(compilerBytes).digest('hex'),instructionSha256:fixture.instructionSha256,
  domain:'nine AL/CL binary operations; every 256 x 256 operand pair and both CF values; poisoned full-state preservation, RF clearing, incoming arithmetic flag variation; TF/breakpoints disabled',
  oracle:'independent integer arithmetic/flag equations, not physical CPU observations',
  universal64BitProof:false,mmuAndAdmission:'not-tested',linuxBoot:'not-tested'},null,2));
