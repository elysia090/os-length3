// Same common SSA -> native/cold ordinary Wasm byte identity at every prefix.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const [compiler,directory]=process.argv.slice(2),memory=new WebAssembly.Memory({initial:16});
const cc=(await WebAssembly.instantiate(await readFile(compiler),{machine:{memory}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),input=cc.compiler_arena_min(),out=input+8192,report=out+65536;
let forms=0;for(const file of await readdir(directory)){
  assert(/^[0-9a-f]{4,6}\.wasm$/.test(file));const source=Buffer.from(file.slice(0,-5),'hex'),expected=await readFile(path.join(directory,file));
  a.fill(0x90,input,input+4096);a.set(source,input);assert.equal(cc.compiler_open_pages(input,1,0x9000n,9n),0);
  assert.equal(cc.compiler_emit(0x9000n,1,out,65536,report),0);const n=Number(v.getBigUint64(report+40,true));
  assert.equal(n,expected.length);assert(a.subarray(out,out+n).equals(expected));++forms;
}
assert.equal(forms,72);cc.compiler_close();console.log(JSON.stringify({status:'pass',nativeColdForms:forms,linuxBoot:'not-tested'}));
