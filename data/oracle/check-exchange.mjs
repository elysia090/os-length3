import {checkRegisterRecords} from './check-register-records.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {seedDisabledDebug} from './machine-observation.mjs';
const [providerFile,compilerFile,directory,...extra]=process.argv.slice(2);
const observe=extra.length===1&&extra[0]==='--observe';
if(!directory||(extra.length&&!observe))throw new Error('usage: check-exchange.mjs VM.WASM COMPILER.WASM EXCHANGE-FIXTURE-DIRECTORY [--observe]');
const result=await checkRegisterRecords({providerFile,compilerFile,directory,prefix:'exchange',forms:186,
  // Memory XCHG already uses the serialized atomic/RMW boundary. Only
  // invalid LOCK-on-register encodings belong in this refusal set.
  refusedSources:[[0xf0,0x48,0x93],[0xf0,0x48,0x87,0xc3]]});
// Explicit substitution models include RSP writes, which the native CALL
// harness cannot observe safely. They are not independent ISA observations.
const memory=new WebAssembly.Memory({initial:16}),coldMemory=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
const cold=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer),data=Buffer.from(memory.buffer),v=new DataView(memory.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536,base=vm.vm_arena_min(),port=base+2048;
let models=0,identityModels=0,sharingRed=false;const identities=new Map(),identityWitnesses=new Map();
for(const legacy of [false,true])for(const width of legacy?[8]:[8,16,32,64])
for(let a=0;a<(legacy?8:16);++a)for(let b=0;b<(legacy?8:16);++b){
  const code=[];if(width===16)code.push(0x66);
  const rex=(width===64?8:0)|(a>=8?1:0)|(b>=8?4:0);
  if(rex||(width===8&&!legacy))code.push(0x40|rex);
  code.push(width===8?0x86:0x87,0xc0|((b&7)<<3)|(a&7));
  cold.fill(0x90,input,input+4096);cold.set(code,input);
  assert.equal(cc.compiler_open_pages(input,1,0x400000n,9n),0);
  assert.equal(cc.compiler_emit(0x400000n,1,output,65536,report),0);
  const body=Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
  if(a===b&&width!==32){
    identityWitnesses.set(body.toString('hex'),body.length);
    const previous=identities.get(code.length);
    if(previous&&!body.equals(previous)){
      sharingRed=true;
      assert(observe,'reflexive fields must share the exact identity body at equal source length');
    }
    else identities.set(code.length,body);
    ++identityModels;
  }
  const module=await WebAssembly.instantiate(body,{machine:{memory}});
  data.fill(0x5a,base,base+1256);
  seedDisabledDebug(v,base);
  for(let reg=0;reg<16;++reg)v.setBigUint64(base+reg*8,BigInt(reg+1)*0x1029384756abcdefn&0xffffffffffffffffn,true);
  v.setBigUint64(base+384,0x400000n,true);v.setBigUint64(base+392,0x10ed7n,true);v.setBigUint64(base+1128,42n,true);
  const expected=Buffer.from(data.subarray(base,base+1256)),mask=(1n<<BigInt(width))-1n;
  const parent=reg=>legacy&&reg>=4?reg-4:reg,shift=reg=>legacy&&reg>=4?8n:0n;
  const left=expected.readBigUInt64LE(parent(a)*8)>>shift(a)&mask,right=expected.readBigUInt64LE(parent(b)*8)>>shift(b)&mask;
  function write(reg,value){
    const at=parent(reg)*8,s=shift(reg),preserved=width<32?expected.readBigUInt64LE(at)&~(mask<<s):0n;
    expected.writeBigUInt64LE(preserved|(value<<s),at);
  }
  write(a,right);write(b,left);
  expected.writeBigUInt64LE(0x400000n+BigInt(code.length),384);expected.writeBigUInt64LE(0xed7n,392);expected.writeBigUInt64LE(43n,1128);
  assert.equal(module.instance.exports.cut(base,port,0x400000n,0),1n);
  assert(data.subarray(base,base+1256).equals(expected),`substitution model ${legacy}/${width}/${a}/${b}`);++models;
}
cc.compiler_close();vm.vm_close();
console.log(JSON.stringify({format:'c-wasm-register-exchange-native-v1',...result,status:sharingRed?'identity-sharing-red':'pass',models,identityModels,
  identityBodies:identityWitnesses.size,identitySourceLengths:[...identities.keys()],
  identityModuleBytes:[...identityWitnesses.values()],identityStoredBytes:[...identityWitnesses.values()].reduce((a,b)=>a+b,0),
  modelScope:'1088 exact complete-state substitutions including virtual RSP and AL/AH aliases; not hardware observations'},null,2));
