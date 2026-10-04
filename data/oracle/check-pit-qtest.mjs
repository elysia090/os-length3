// Independent paused register/latch oracle. Not a timing or OUT-pin oracle.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {withQtestDevice} from './qtest-device.mjs';
const [qemu,model,...args]=process.argv.slice(2);
if(!model)throw new Error('usage: check-pit-qtest.mjs QEMU C-PIT-CHECK [MODEL-ARGS...]');
const ops=[];let tick=0;
const ns=t=>Math.ceil(t*1e9/1193182),w=(port,byte)=>ops.push(['W',ns(tick),port,byte]);
const r=(port,mask=255)=>ops.push(['R',ns(tick),port,mask]);
for(const mode of [0,2,6])for(let channel=0;channel<3;++channel)for(const rw of [1,2,3])
for(let byte=0;byte<256;++byte){
  // Mode-2 divisor 1 is architecturally illegal; never compare it as success.
  if(mode!==0 && rw===1 && byte===1)continue;
  const command=(channel<<6)|(rw<<4)|(mode<<1),port=0x40+channel;
  w(0x43,command);
  if(rw===1)w(port,byte);else if(rw===2)w(port,byte);else{w(port,byte);w(port,255-byte);}
  ++tick; // C CE loads on one real PIT edge. QEMU loads synchronously.
  w(0x43,channel<<6);w(0x43,channel<<6);r(port);if(rw===3)r(port);
  w(0x43,0xc0|(2<<channel));r(port,63);r(port);if(rw===3)r(port);
  r(port);if(rw===3)r(port);
}
const input=ops.map(([kind,time,port,value])=>`${kind} ${time} ${port}${kind==='W'?` ${value}`:''}`).join('\n')+'\n';
const observed=spawnSync(model,[...args,'--trace'],{input,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
assert.equal(observed.status,0,observed.stderr||String(observed.error));
const expected=observed.stdout.trim().split(/\s+/).map(Number);
await withQtestDevice(qemu,[],async({command,qmp})=>{
  let comparisons=0;
  for(const [index,op]of ops.entries()){
    const [kind,,port,value]=op,cmd=kind==='W'?`outb ${port} ${value}`:`inb ${port}`;
    const response=await command(cmd);
    if(kind==='R'){
      assert.equal(Number(response.split(/\s+/)[1])&value,expected[comparisons]&value,
        `read ${comparisons}, ${cmd}, preceding ${JSON.stringify(ops.slice(Math.max(0,index-8),index+1))}`);
      ++comparisons;
    }
  }
  assert.equal(comparisons,expected.length);
  console.log(JSON.stringify({format:'pit-qtest-independent-register-v1',status:'pass',operations:ops.length,comparisons,
    qemu:(await qmp('query-version')).qemu,cpuExecution:'paused',
    clock:'QEMU frozen; C advances one load pulse per programmed counter; NOT an independent timing comparison',
    excluded:'OUT/null-count high bits, gate/reload timing and IRQ; QEMU differs from Intel 8254 here',linuxBoot:'not-tested'},null,2));
});
