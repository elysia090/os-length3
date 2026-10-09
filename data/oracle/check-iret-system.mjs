// Run an independent system fixture, never a product execution route.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
const [qemuFile,elfFile,logFile,accelerator='tcg',...flags]=process.argv.slice(2);
if(!logFile||flags.length>1||flags.some(x=>!['--frame-priority','--user-fault','--control-events','--cr0-clear'].includes(x)&&!/^--return=(2|4|8),(0|1),(0|7)$/.test(x))||!['tcg','whpx'].includes(accelerator))
  throw new Error('usage: check-iret-system.mjs QEMU.EXE ORACLE.ELF NEW-NATIVE.LOG [tcg|whpx] [--frame-priority|--user-fault|--control-events|--cr0-clear]');
const framePriority=flags.includes('--frame-priority'),cr0Clear=flags.includes('--cr0-clear');
const controlEvents=flags.includes('--control-events');
const userFault=flags.includes('--user-fault');
const returning=flags.find(x=>x.startsWith('--return='))?.slice(9).split(',').map(Number);
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
assert.equal(rows.length,cr0Clear?128:controlEvents?1152:framePriority?352:320);
for(const [rank,row]of rows.entries()){assert.equal(row.length,cr0Clear?5:controlEvents?28:userFault?27:framePriority?23:22);assert.equal(row[0],BigInt(rank));}
if(cr0Clear){for(const row of rows){assert.equal(row[2],row[1]&~8n);assert.equal(row[4],row[3]);}
  console.log(JSON.stringify({format:'native-cr0-clear-v1',status:'pass',rows:rows.length,accelerator,scope:'CPL0 MP/EM/TS/NE and8 prefix encodings; actual CR0/RFLAGS, not product execution',linuxBoot:'not-tested'},null,2));process.exit(0);}
const vectorField=controlEvents?11:7;
const vectors=Object.fromEntries([...new Set(rows.map(row=>Number(row[vectorField])))].map(vector=>[vector,rows.filter(row=>Number(row[vectorField])===vector).length]));
console.log(JSON.stringify({format:'native-outer-iret-observation-v1',status:'pass',rows:rows.length,vectors,accelerator,
  oracle:accelerator==='tcg'?'QEMU TCG system semantics':'Windows Hypervisor Platform virtual CPU',
  framePriority,userFault,controlEvents,returning,scope:controlEvents?'Every INT vector and FWAIT MP/TS/EM/pending fault frames':'CPL0/long-mode return, GDT/TSS/IDT and resulting processor frames; not product execution',linuxBoot:'not-tested'},null,2));
