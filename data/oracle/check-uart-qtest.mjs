// Paused independent 16550A register/loopback oracle, never product execution.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {withQtestDevice} from './qtest-device.mjs';
const [qemu,model,...args]=process.argv.slice(2);
if(!model)throw new Error('usage: check-uart-qtest.mjs QEMU-SYSTEM-X86_64 C-UART-CHECK [MODEL-ARGS...]');
const ops=[],w=(rank,byte)=>ops.push(['W',0x3f8+rank,byte]),r=rank=>ops.push(['R',0x3f8+rank]);
for(let rank=0;rank<8;++rank)r(rank);
for(let byte=0;byte<256;++byte){
  w(7,byte);r(7);w(3,128);w(0,byte);w(1,255-byte);r(0);r(1);w(3,3);
  w(1,byte);r(1);r(2);r(2);w(4,byte);r(4);r(6);
}
w(1,0);w(4,16);
for(const fifo of [0,1,0x41,0x81,0xc1]){
  w(2,fifo|6);w(1,7);
  for(let byte=0;byte<18;++byte){w(0,byte);r(2);r(5);}
  for(let byte=0;byte<18;++byte){r(0);r(2);r(5);}
  w(2,fifo|6);r(2);r(5);
}
w(2,0);w(4,8);w(1,2);r(2);r(2);w(1,0);w(1,2);r(2);
// The native standalone model explicitly accepts the same null sink as QEMU.
// This does NOT mean the product I/O owner may ignore a transmitted byte.
w(0,65);r(2);r(5);
const observed=spawnSync(model,[...args,'--trace'],{input:ops.map(o=>o.join(' ')).join('\n')+'\n',
  encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
assert.equal(observed.status,0,observed.stderr||String(observed.error));
const expected=observed.stdout.trim().split(/\s+/).map(Number);
await withQtestDevice(qemu,['-serial','null'],async({qmp,command})=>{
  let comparisons=0;
  for(let index=0;index<ops.length;++index){
    const op=ops[index],cmd=op[0]==='W'?`outb ${op[1]} ${op[2]}`:`inb ${op[1]}`;
    const response=await command(cmd);
    if(op[0]==='R'){
      assert.equal(Number(response.split(/\s+/)[1]),expected[comparisons],
        `read ${comparisons}, ${cmd}, preceding ${JSON.stringify(ops.slice(Math.max(0,index-12),index+1))}`);
      ++comparisons;
    }
  }
  assert.equal(comparisons,expected.length);
  console.log(JSON.stringify({format:'uart-qtest-independent-device-v1',status:'pass',operations:ops.length,
    comparisons,qemu:(await qmp('query-version')).qemu,cpuExecution:'paused',
    clock:'frozen; sampled timeout tested separately, not independent wire timing',
    sink:'null backend explicitly accepted in test only; product external transmission remains refused',
    profile:'COM1 16550A register/FIFO/loopback; fixed modem inputs, no break-line or modem-delta transport',
    linuxBoot:'not-tested'},null,2));
});
