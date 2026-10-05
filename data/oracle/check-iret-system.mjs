// Run an independent system fixture, never a product execution route.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
const [qemuFile,elfFile,logFile,accelerator='tcg',...extra]=process.argv.slice(2);
if(!logFile||extra.length||!['tcg','whpx'].includes(accelerator))
  throw new Error('usage: check-iret-system.mjs QEMU.EXE ORACLE.ELF NEW-NATIVE.LOG [tcg|whpx]');
assert.equal(await stat(logFile).then(()=>true,err=>{if(err.code==='ENOENT')return false;throw err;}),false,'do not replace a native receipt');
const stderr=[];
const exit=await new Promise((resolve,reject)=>{
  const child=spawn(qemuFile,['-accel',accelerator,'-m','64M','-nic','none','-display','none','-serial','none','-monitor','none','-no-reboot',
    '-kernel',path.resolve(elfFile),'-debugcon',`file:${path.resolve(logFile)}`,'-global','isa-debugcon.iobase=0xe9',
    '-device','isa-debug-exit,iobase=0xf4,iosize=0x04'],{windowsHide:true,timeout:15000,stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',chunk=>stderr.push(chunk));child.on('error',reject);
  child.on('exit',(code,signal)=>resolve({code,signal}));
});
assert.equal(exit.code,33,Buffer.concat(stderr).toString()||'fixture must exit through its success port');
assert.equal(exit.signal,null);
const rows=(await readFile(logFile,'utf8')).trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/).map(x=>BigInt(`0x${x}`)));
assert.equal(rows.length,320);for(const [rank,row]of rows.entries()){assert.equal(row.length,22);assert.equal(row[0],BigInt(rank));}
const vectors=Object.fromEntries([...new Set(rows.map(row=>Number(row[7])))].map(vector=>[vector,rows.filter(row=>Number(row[7])===vector).length]));
console.log(JSON.stringify({format:'native-outer-iret-observation-v1',status:'pass',rows:rows.length,vectors,accelerator,
  oracle:accelerator==='tcg'?'QEMU TCG system semantics':'Windows Hypervisor Platform virtual CPU',
  scope:'CPL0/long-mode IRET, GDT/TSS/IDT and resulting processor frames; not product execution',linuxBoot:'not-tested'},null,2));
