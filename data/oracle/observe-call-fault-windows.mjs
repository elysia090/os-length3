// Independent Windows native observations, not product equivalence or boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [log,...extra]=process.argv.slice(2);
if(!log || extra.length)throw new Error('usage: observe-call-fault-windows.mjs COMPLETE-NATIVE-LOG');
const lines=(await readFile(log,'utf8')).split(/\r?\n/).filter(line=>line.startsWith('CALL-WINDOWS '));
assert.equal(lines.length,220,'complete independent native receipt');
const cpuid=lines.slice(0,3).map((line,index)=>{
  const m=/^CALL-WINDOWS cpuid (0|1|40000000) ([0-9a-f]{8}) ([0-9a-f]{8}) ([0-9a-f]{8}) ([0-9a-f]{8})$/.exec(line);
  assert(m);assert.equal(m[1],['0','1','40000000'][index]);
  return {leaf:m[1],words:m.slice(2)};
});
let repetitions,observations=0,stored=0,untouched=0,originalFrames=0,advancedFrames=0,rfFrames=0,mixedRows=0;
const rows=lines.slice(3,-1).map((line,index)=>{
  const m=/^CALL-WINDOWS row (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(line);
  assert(m);const [form,edge,flags,history,n,s,u,o,a,rf]=m.slice(1).map(Number);
  assert.equal(form,Math.floor(index/36));assert.equal(edge,Math.floor(index/9)%4);
  assert.equal(flags,Math.floor(index/3)%3);assert.equal(history,index%3);
  assert(n>=1&&n<=100000);repetitions??=n;assert.equal(n,repetitions);
  for(const count of [s,u,o,a,rf])assert(count>=0&&count<=n);
  assert.equal(s+u,n);assert.equal(o+a,n);
  observations+=n;stored+=s;untouched+=u;originalFrames+=o;advancedFrames+=a;rfFrames+=rf;
  if(s&&u)++mixedRows;
  return {form,edge,flags,permissionHistory:history,observations:n,stored:s,untouched:u,
    originalFrames:o,advancedFrames:a,rfFrames:rf};
});
assert.equal(lines.at(-1),`CALL-WINDOWS complete ${observations} ${stored} ${untouched} ${originalFrames} ${advancedFrames} ${rfFrames}`);
console.log(JSON.stringify({format:'windows-native-call-fault-observation-v1',status:'observed',
  oracle:'native Windows process, Win32 VEH/context; CPUID retained, not assumed bare hardware',
  productLowering:'not-tested',linuxProductBoot:'not-tested',
  exception:'Windows ACCESS_VIOLATION, not an asserted x86 vector; all 16 GPRs, RIP, flags/RF recorded before recovery',
  stackPayload:'stored and untouched outcomes separately counted, never promoted to equivalence',
  cpuid,observations,stored,untouched,originalFrames,advancedFrames,rfFrames,mixedRows,rows},null,2));
