import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {withQtestDevice} from './qtest-device.mjs';
const [qemu,model,...modelArgs]=process.argv.slice(2);
if (!model) throw new Error('usage: check-rtc-qtest.mjs QEMU-SYSTEM-X86_64 C-RTC-CHECK [MODEL-ARGS...]');
const ops=[],w=(p,v)=>ops.push(['W',p,v]),r=p=>ops.push(['R',p]);
function write(index,value) { w(0x70,index); w(0x71,value); }
function read(index) { w(0x70,index); r(0x71); }
r(0x70);
for (const index of [0,2,4,6,7,8,9,10,11,12,13,0x32,0x37]) read(index);
for (let index=14;index<128;++index) if (index!==0x32 && index!==0x37) {
  for (const byte of [0,255,index,255-index]) { write(index,byte); read(index); }
}
for (const mode of [0,2,4,6]) {
  write(11,mode|128|16); read(11); // SET clears UIE
  const enc=v=>mode&4 ? v : Math.floor(v/10)*16+v%10;
  for (const [index,value] of [[0,58],[2,47],[4,mode&2 ? 23 : 0x80|11],[6,1],[7,4],[8,10],[9,26],[0x32,20]]) {
    write(index,index===4 && !(mode&2) ? enc(11)|128 : enc(value)); read(index);
  }
  write(11,mode); read(11);
  for (const index of [0,2,4,6,7,8,9,0x32,0x37]) read(index);
  for (const index of [1,3,5]) for (const value of [0xc0,0xff]) { write(index,value); read(index); }
  for (let code=0;code<16;++code) { write(10,0x20|code); read(10); }
  write(12,255); read(12); read(12); write(13,0); read(13);
}
const input=ops.map(o=>o.join(' ')).join('\n')+'\n';
const observed=spawnSync(model,[...modelArgs,'--trace'],{input,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
assert.equal(observed.status,0,observed.stderr || String(observed.error));
const expected=observed.stdout.trim().split(/\s+/).map(Number);
await withQtestDevice(qemu,['-rtc','base=2026-10-04T12:34:56,clock=vm'],async ({qmp,command})=>{
  let comparisons=0;
  for (let i=0;i<ops.length;++i) {
    const op=ops[i],cmd=op[0]==='W' ? `outb ${op[1]} ${op[2]}` : `inb ${op[1]}`;
    const response=await command(cmd);
    if (op[0]==='R') {
      assert.equal(Number(response.split(/\s+/)[1]),expected[comparisons],
        `read ${comparisons}, ${cmd}, preceding ${JSON.stringify(ops.slice(Math.max(0,i-12),i+1))}`);
      ++comparisons;
    }
  }
  assert.equal(comparisons,expected.length);
  console.log(JSON.stringify({format:'rtc-qtest-independent-device-v1',status:'pass',operations:ops.length,comparisons,
    qemu:(await qmp('query-version')).qemu,utcSeed:'2026-10-04T12:34:56Z',cpuExecution:'paused',
    clock:'frozen VM clock; dynamic timing/IRQ not compared by this oracle',linuxBoot:'not-tested'},null,2));
});
