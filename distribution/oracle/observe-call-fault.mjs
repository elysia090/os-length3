// Independent fault receipts, not a product execution path or equivalence pass.
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const args=process.argv.slice(2);
if (args.length!==1 && args.length!==4)
  throw new Error('usage: observe-call-fault.mjs LOG | QEMU KERNEL OBSERVER-INITRAMFS NEW-LOG');
const log=args.at(-1);
if (args.length===4) {
  const [qemu,kernel,initramfs]=args;
  await assert.rejects(access(log),{code:'ENOENT'});
  const child=spawn(qemu,['-L',path.join(path.dirname(qemu),'share'),'-machine','pc','-accel','tcg',
    '-cpu','qemu64','-m','256','-smp','1','-display','none','-monitor','none','-nic','none',
    '-no-reboot','-kernel',kernel,'-initrd',initramfs,'-append','console=ttyS0 rdinit=/init loglevel=3 panic=-1',
    '-serial',`file:${path.resolve(log)}`],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr=''; child.stderr.on('data',x=>{stderr+=x;});
  const exit=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error(`fault observer timeout: ${stderr}`));},45000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',code=>{clearTimeout(timer);resolve(code);});
  });
  assert.equal(exit,0,stderr);
}
const text=await readFile(log,'utf8');
assert(!text.includes('CALL-FAULT error'),'observer failed');
const lines=text.split(/\r?\n/).filter(line=>line.startsWith('CALL-FAULT '));
assert.equal(lines.length,220,'complete independent receipt required');
const cpuid=lines.slice(0,3).map((line,index)=>{
  const [prefix,kind,...words]=line.split(' ');
  assert.equal(prefix,'CALL-FAULT'); assert.equal(kind,['cpu','feature','hypervisor'][index]);
  assert.equal(words.length,4); assert(words.every(word=>/^[0-9a-f]{8}$/.test(word)));
  return {kind,words};
});
let stored=0,untouched=0,observations=0,mixed=0,originalFrames=0,advancedFrames=0,repetitions;
const rows=lines.slice(3,-1).map((line,index)=>{
  const match=/^CALL-FAULT row (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(line);
  assert(match); const [form,edge,flags,history,n,s,u,o,a]=match.slice(1).map(Number);
  assert.equal(form,Math.floor(index/36)); assert.equal(edge,Math.floor(index/9)%4);
  assert.equal(flags,Math.floor(index/3)%3); assert.equal(history,index%3);
  assert(n>=1 && n<=100000); repetitions??=n; assert.equal(n,repetitions);
  assert.equal(s+u,n); assert.equal(o+a,n); stored+=s; untouched+=u; observations+=n;
  originalFrames+=o; advancedFrames+=a;
  if (s && u) ++mixed;
  return {form,edge,flags,permissionHistory:history,observations:n,stored:s,untouched:u,
    originalFrames:o,advancedFrames:a};
});
assert.equal(lines.at(-1),`CALL-FAULT complete ${observations} ${mixed} ${advancedFrames}`);
console.log(JSON.stringify({format:'native-call-fault-observation-v1',status:'observed',
  oracle:args.length===4 ? 'explicit QEMU TCG, isolated diagnostic initramfs' : 'caller-supplied native log; accelerator must be independently identified',
  productLowering:'not-tested',linuxProductBoot:'not-tested',
  architecturalFrame:'all 16 GPRs, RIP, flags plus RF and #GP(0); original and advanced RSP/RIP are distinct recorded outcomes',
  stackPayload:'two outcomes recorded separately; neither is silently promoted to equivalence',
  cpuid,observations,stored,untouched,originalFrames,advancedFrames,mixedRows:mixed,rows},null,2));
