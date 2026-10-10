// The emitted body, including literal operands, must be origin-independent.
// This checks C compiler outputs, not a host decoder or guest interpreter.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {validateProfileFixture} from './profile-input-fixture.mjs';
const [file,fixtureFile]=process.argv.slice(2);if(!file)throw new Error('COMPILER.WASM [INPUTS.json]');
const memory=new WebAssembly.Memory({initial:128}),cc=(await WebAssembly.instantiate(await readFile(file),{machine:{memory}})).instance.exports;
const input=cc.compiler_arena_min()+131072,out=cc.compiler_arena_min(),report=out+65536;
if(input+4096>memory.buffer.byteLength)memory.grow(Math.ceil((input+4096-memory.buffer.byteLength)/65536));
const bytes=new Uint8Array(memory.buffer),view=new DataView(memory.buffer);
const forms=[[0x48,0x8b,0x05,0x17,0,0,0],[0x48,0x8d,0x3d,0x20,0,0,0],[0xe8,0x80,0,0,0],[0x75,0x80],[0xc3],
 [0x48,0xb8,0x12,0x34,0x56,0x78,0,0,0,0],[0x0f,0x05],[0x48,0xf7,0xf1],[0xf3,0xa5],[0xd9,0xe8],[0x0f,0x10,0x05,0x14,0,0,0]];
let comparisons=0;for(const source of forms)for(const offset of [0,8,63,2048,4080])for(const limit of [1,16,1024]){
 bytes.fill(0x90,input,input+4096);bytes.set(source,input+offset);let body=null,metadata=null;
 for(const origin of [0x400000n,0x7f1234500000n,0xffffffff81000000n]){
  assert.equal(cc.compiler_open_fragments(input,0,1,origin,9n),0);assert.equal(cc.compiler_emit(origin+BigInt(offset),limit,out,65536,report),0);
  const length=Number(view.getBigUint64(report+40,true)),current=bytes.slice(out,out+length);
  const description=[view.getBigUint64(report+24,true),view.getBigUint64(report+32,true),view.getUint32(report+76,true)];
  if(body){assert.deepEqual(current,body);assert.deepEqual(description,metadata);++comparisons;}else{body=current;metadata=description;}
 }
}
if(fixtureFile){const fixture=JSON.parse(await readFile(fixtureFile,'utf8'));validateProfileFixture(fixture);
 for(const [rank,record]of fixture.records.entries()){
  bytes.fill(0x90,input,input+4096);bytes.set(Buffer.from(record.bytes,'hex'),input);let body,description;
  for(const origin of [0x400000n,0x7f1234500000n,0xffffffff81000000n]){
   assert.equal(cc.compiler_open_fragments(input,0,1,origin,9n),0);assert.equal(cc.compiler_emit(origin,1,out,65536,report),0);
   const length=Number(view.getBigUint64(report+40,true)),current=bytes.slice(out,out+length);
   const metadata=[view.getBigUint64(report+24,true),view.getBigUint64(report+32,true),view.getUint32(report+60,true),view.getUint32(report+76,true)];
   if(body){assert.deepEqual(current,body,record.assembly);assert.deepEqual(metadata,description);++comparisons;}else{body=current;description=metadata;}
  }if((rank&65535)===65535)console.error('origin binding '+(rank+1)+'/'+fixture.records.length);
 }
}console.log('Origin binding: '+comparisons+' exact C-emitted body/extent/instruction/literal-binding comparisons across user/kernel virtual origins');
