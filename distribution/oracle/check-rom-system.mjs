// QEMU is a trusted test oracle only; never a browser execution dependency.
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const [qemu,elf,log]=process.argv.slice(2);
if (!log) throw new Error('usage: check-rom-system.mjs QEMU ROM-SYSTEM.ELF NEW-LOG');
await assert.rejects(access(log),{code:'ENOENT'});
const child=spawn(qemu,['-L',path.join(path.dirname(qemu),'share'),'-machine','pc','-accel','tcg',
  '-cpu','qemu64','-m','32','-display','none','-monitor','none','-serial','none','-nic','none',
  '-no-reboot','-kernel',elf,'-debugcon',`file:${path.resolve(log)}`,'-global','isa-debugcon.iobase=0xe9',
  '-device','isa-debug-exit,iobase=0xf4,iosize=4'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let stderr=''; child.stderr.on('data',x=>{stderr+=x;});
const exit=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error(`ROM oracle timeout: ${stderr}`));},45000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);resolve(code);});
});
assert.equal(exit,33,stderr);
const rows=(await readFile(log,'utf8')).trim().split(/\r?\n/);
assert.equal(rows.length,17);
for(let i=0;i<rows.length;++i) {
  const row=rows[i].trim().split(/\s+/).map(value=>BigInt(`0x${value}`));
  assert.equal(row.length,6); assert.equal(row[0],0xf0000n+BigInt(i*4093));
  for(const value of row.slice(2)) assert.equal(value,row[1],'ROM bus rejects payload changes without #PF');
}
console.log(`QEMU TCG ROM bus: ${rows.length} actual MOV/XCHG/locked RMW immutable observations, including page crossings; NOT physical hardware, empty-firmware values or Linux boot proof`);
