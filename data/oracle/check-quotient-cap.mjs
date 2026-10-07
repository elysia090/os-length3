// Exact source-module identity fits a cap that the raw population cannot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [compilerFile]=process.argv.slice(2);if(!compilerFile)throw new Error('COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:16,maximum:32});
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory}})).instance.exports;
const data=new Uint8Array(memory.buffer),view=new DataView(memory.buffer);
const input=cc.compiler_arena_min(),options=input+8192,output=input+16384,report=output+65536;
const count=130,cap=8000;
data.fill(0x90,input,input+4096);
for(let i=0;i<count;++i){const at=input+64+i*16;data[at]=0xb8;view.setUint32(at+1,i*31337,true);data[at+5]=0xc3;
  view.setBigUint64(options+i*16,0x400040n+BigInt(i*16),true);
  view.setUint32(options+i*16+8,1,true);view.setUint32(options+i*16+12,cap,true);}
assert.equal(cc.compiler_open_pages(input,1,0x400000n,9n),0);
data.fill(0xa5,output,output+65536);
const status=cc.compiler_emit_projection(options,count,output,cap,report);
assert.equal(status,0,'exact 7,646-byte quotient must fit 8,000 bytes, regardless of raw 30,614-byte population');
const bytes=Number(view.getBigUint64(report+40,true));assert.equal(bytes,7646);
assert(WebAssembly.validate(data.subarray(output,output+bytes)));
assert(data.subarray(output+bytes,output+65536).every(byte=>byte===0xa5),'no raw body/tail writes');
const canonical=Buffer.from(data.subarray(output,output+bytes));
for(let i=0;i<count;++i)view.setUint32(options+i*16+12,bytes,true);
assert.equal(cc.compiler_emit_projection(options,count,output,bytes,report),0,'exact final cap');
assert(canonical.equals(Buffer.from(data.subarray(output,output+bytes))));
data.fill(0xa5,output,output+65536);data.fill(0xa5,report,report+count*80);
const before=Buffer.from(data.subarray(report,report+count*80));
assert.equal(cc.compiler_emit_projection(options,count,output,bytes-1,report),-103);
assert(data.subarray(output,output+65536).every(byte=>byte===0xa5));
assert(before.equals(Buffer.from(data.subarray(report,report+count*80))));
// A second class of transfers cannot even form its raw population at 64 KiB.
cc.compiler_close();
for(let i=0;i<count;++i){data.set([0x48,0x0f,0xae,0x07],input+64+i*16);view.setUint32(options+i*16+12,65536,true);}
assert.equal(cc.compiler_open_pages(input,1,0x400000n,9n),0);
assert.equal(cc.compiler_emit_projection(options,count,output,65536,report),0);
const fxsaveBytes=Number(view.getBigUint64(report+40,true));assert.equal(fxsaveBytes,9971);
assert(WebAssembly.validate(data.subarray(output,output+fxsaveBytes)));
cc.compiler_close();console.log(JSON.stringify({status:'pass',literalBytes:bytes,cap,exactCap:true,
  unchangedRefusal:true,noRawTail:true,fxsaveBytes,linuxBoot:'not-tested',wholeElf:'not-closed'}));
