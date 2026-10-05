// Independent system-mode reference only. It never participates in delivery.
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const [qemu,elf,directory,log]=process.argv.slice(2);
if (!log) throw new Error('usage: check-invalidate-system.mjs QEMU SYSTEM.ELF FIXTURES NEW-LOG');
await assert.rejects(access(log),{code:'ENOENT'});
const child=spawn(qemu,['-L',path.join(path.dirname(qemu),'share'),'-machine','pc','-accel','tcg',
  '-cpu','qemu64','-m','32','-display','none','-monitor','none','-serial','none',
  '-nic','none','-no-reboot','-kernel',elf,
  '-debugcon',`file:${path.resolve(log)}`,'-global','isa-debugcon.iobase=0xe9',
  '-device','isa-debug-exit,iobase=0xf4,iosize=4'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let stderr=''; child.stderr.on('data',x=>{stderr+=x;});
const exit=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error(`system oracle timeout: ${stderr}`));},45000);
  child.once('error',e=>{clearTimeout(timer);reject(e);});
  child.once('exit',code=>{clearTimeout(timer);resolve(code);});
});
assert.equal(exit,33,stderr);
const lines=(await readFile(log,'utf8')).trim().split(/\r?\n/);
assert.equal(lines.length,84*6*2);
const addresses=[0n,0x400000n,0x800000000000n,0xffff7fffffffffffn,0xffff800000000000n,0xffffffffffffffffn];
let comparisons=0;
for (let rank=0;rank<84;++rank) {
  const meta=JSON.parse(await readFile(path.join(directory,`invalidate-${rank}.json`)));
  const module=await WebAssembly.compile(await readFile(path.join(directory,`invalidate-${rank}.wasm`)));
  const memory=new WebAssembly.Memory({initial:2});
  const cut=(await WebAssembly.instantiate(module,{machine:{memory}})).exports.cut;
  const view=new DataView(memory.buffer), bytes=Buffer.from(memory.buffer), state=4096, port=8192;
  for (let address=0;address<6;++address) for (let flags=0;flags<2;++flags) {
    const row=lines[rank*12+address*2+flags].trim().split(/\s+/).map(x=>BigInt(`0x${x}`));
    assert.equal(row.length,4); assert.equal(row[0],BigInt(rank)); assert.equal(row[1],addresses[address]);
    assert.equal(row[2],row[3],'system INVLPG preserves flags');
    bytes.fill(0,state,state+1256); bytes.fill(0xa5,port,port+48);
    view.setBigUint64(state+56,row[1],true); view.setBigUint64(state+8,0x7fffffffffffffffn,true);
    view.setBigUint64(state+384,BigInt(meta.entry),true); view.setBigUint64(state+392,row[2],true);
    view.setBigUint64(state+488,8n,true); view.setBigUint64(state+1128,42n,true);
    const expected=Buffer.from(bytes.subarray(state,state+1256)), beforePort=Buffer.from(bytes.subarray(port,port+48));
    assert.equal(cut(state,port,BigInt(meta.entry),0),1n); expected.writeBigUInt64LE(BigInt(meta.entry)+BigInt(meta.sourceBytes),384);
    expected.writeBigUInt64LE(43n,1128); expected.writeBigUInt64LE(row[3]&~0x10000n,392);
    assert(bytes.subarray(state,state+1256).equals(expected)); assert(bytes.subarray(port,port+48).equals(beforePort));
    ++comparisons;
  }
}
console.log(`QEMU TCG CPL0 INVLPG: ${comparisons} real address/flags observations match compiled cuts; NOT physical hardware, retained-TLB or Linux boot proof`);
