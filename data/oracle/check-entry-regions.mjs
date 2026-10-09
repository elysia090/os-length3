// Exercise the emitted public ABI, not a host replacement for its validation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [compilerFile]=process.argv.slice(2);
if(!compilerFile)throw new Error('usage: check-entry-regions.mjs COMPILER.WASM');
const cm=new WebAssembly.Memory({initial:32});
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const memory=new WebAssembly.Memory({initial:1}),bytes=Buffer.from(memory.buffer),view=new DataView(memory.buffer),limit=bytes.length,entry=0x400000n;
let calls=0,cases=0,refusals=0,accepted=0,seed=0x73514a29;const moduleBytes={};
function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const forms=[{name:'scalar',source:[0x8b,0x07],port:48},
  {name:'pair',source:[0xf3,0x0f,0x6f,0x07],port:56},
  {name:'checkpoint',source:[0xc8,0,0,0],port:64},
  {name:'extent',source:[0x0f,0xae,0x0f],port:64}];
const expected=(s,p,n)=>!(s&7)&&!(p&7)&&BigInt(s)+1256n<=BigInt(limit)&&BigInt(p)+BigInt(n)<=BigInt(limit)
  &&(BigInt(s)+1256n<=BigInt(p)||BigInt(p)+BigInt(n)<=BigInt(s));
for(const form of forms){
  c.fill(0x90,input,input+4096);c.set(form.source,input);
  assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,output,65536,report),0,form.name);
  moduleBytes[form.name]=Number(cv.getBigUint64(report+40,true));
  const module=await WebAssembly.compile(c.subarray(output,output+moduleBytes[form.name]));
  const imports={memory};
  for(const item of WebAssembly.Module.imports(module))if(item.kind==='function')imports[item.name]=()=>{++calls;return 2n;};
  const cut=(await WebAssembly.instantiate(module,{machine:imports})).exports.cut;
  const edges=[0,1,7,8,48,56,64,1255,1256,1264,4096,limit-1256,limit-1255,limit-form.port,limit-form.port+1,
    limit-8,limit,0x7ffffff8,0x80000000,0xfffff800,0xffffffb0,0xffffffc0,0xfffffff8,0xffffffff];
  const pairs=edges.flatMap(s=>edges.map(p=>[s,p]));
  for(const s of [0,8,4096,limit-1256])for(const offset of [-8,0,8]){
    pairs.push([s,(s+1256+offset)>>>0],[s,(s-form.port+offset)>>>0]);
  }
  for(let i=0;i<4096;++i){const s=(random()%(limit+4096))&~7,p=(random()%(limit+4096))&~7;pairs.push([s>>>0,p>>>0]);}
  for(const [s,p] of pairs){
    bytes.fill(0x5a);if(BigInt(s)+1256n<=BigInt(limit)){
      bytes.fill(0,s,s+1256);view.setBigUint64(s+384,entry,true);view.setBigUint64(s+392,2n,true);
      view.setBigUint64(s+416,0x600n,true);
    }
    const before=Buffer.from(bytes);calls=0;const valid=expected(s,p,form.port);
    const result=cut(s,p,entry,cv.getUint32(report+76,true));++cases;
    if(!valid){assert.equal(result,6n,`${form.name} rejects ${s}/${p}`);assert.equal(calls,0);assert(bytes.equals(before));++refusals;}
    else{assert.equal(calls,1,`${form.name} reaches the C boundary ${s}/${p}`);assert.equal(result,2n);++accepted;}
  }
  cc.compiler_close();
}
// A pure cut has no port interval. Invalid public state offsets still fail
// before any architectural load or mutation, even near the u32 wrap edge.
c.fill(0x90,input,input+4096);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
const pure=(await WebAssembly.instantiate(c.subarray(output,output+Number(cv.getBigUint64(report+40,true))),{machine:{memory}})).instance.exports.cut;
for(const s of [1,7,limit-1255,limit,0xfffffff8,0xffffffff]){
  bytes.fill(0x5a);const before=Buffer.from(bytes);assert.equal(pure(s,0xffffffff,entry,0),6n);assert(bytes.equals(before));++cases;++refusals;
}
console.log(JSON.stringify({format:'emitted-entry-region-proof-v1',status:'pass',cases,refusals,accepted,moduleBytes,portBytes:[48,56,64],
  scope:'u32 pointers, both interval orders, adjacency, overlap, alignment, bounds/wrap; no guest ISA replacement'},null,2));
