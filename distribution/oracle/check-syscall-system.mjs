// Independent system fixture only, never a product execution dependency.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
const [qemuFile,elfFile,logFile,accelerator='whpx',...extra]=process.argv.slice(2);
if(!logFile||extra.length||!['tcg','whpx'].includes(accelerator))
  throw new Error('usage: check-syscall-system.mjs QEMU.EXE ORACLE.ELF NEW-ROWS.log [whpx|tcg]');
assert.equal(await stat(logFile).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),false,'immutable oracle receipt');
const stderr=[];
const exit=await new Promise((resolve,reject)=>{
  const child=spawn(qemuFile,['-accel',accelerator,'-m','64M','-nic','none','-display','none','-serial','none','-monitor','none','-no-reboot',
    '-kernel',path.resolve(elfFile),'-debugcon',`file:${path.resolve(logFile)}`,'-global','isa-debugcon.iobase=0xe9',
    '-device','isa-debug-exit,iobase=0xf4,iosize=0x04'],{windowsHide:true,timeout:15000,stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',chunk=>stderr.push(chunk));child.on('error',reject);
  child.on('exit',(code,signal)=>resolve({code,signal}));
});
assert.equal(exit.code,33,Buffer.concat(stderr).toString()||'fixture must reach the success port');assert.equal(exit.signal,null);
const rows=(await readFile(logFile,'utf8')).trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/).map(x=>BigInt(`0x${x}`)));
assert.equal(rows.length,64);for(const [rank,row]of rows.entries()){assert.equal(row.length,32);assert.equal(row[0],BigInt(rank));}
const vectors=Object.fromEntries([...new Set(rows.map(x=>Number(x[14])))].map(n=>[n,rows.filter(x=>Number(x[14])===n).length]));
assert.deepEqual(vectors,{6:16,13:16,128:32});
console.log(JSON.stringify({format:'native-syscall-observation-v1',status:'pass',rows:rows.length,vectors,accelerator,
  oracle:accelerator==='whpx'?'hardware-assisted reference CPU':'QEMU TCG system semantics',linuxBoot:'not-tested'},null,2));
