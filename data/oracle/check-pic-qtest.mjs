// Independent system-device oracle, never a product guest-execution route.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer,createConnection} from 'node:net';
import {createInterface} from 'node:readline';
const [qemu,model,...modelArgs]=process.argv.slice(2);
if (!model) throw new Error('usage: check-pic-qtest.mjs QEMU-SYSTEM-X86_64 C-PIC-CHECK [MODEL-ARGS...]');
const ops=[], write=(p,v)=>ops.push(['W',p,v]), read=p=>ops.push(['R',p]);
const line=(i,v)=>ops.push(['L',i,v]);
function sample() { for (const p of [0x20,0x21,0xa0,0xa1,0x4d0,0x4d1]) read(p); }
function init(icw1=0x11,icw4=1) {
  for (let i=0;i<16;++i) if (i!==2) line(i,0);
  write(0x20,icw1); write(0xa0,icw1);
  write(0x21,0x20); write(0xa1,0x28);
  if (!(icw1&2)) { write(0x21,4); write(0xa1,2); }
  write(0x21,icw4); write(0xa1,icw4); sample();
}
init();
for (let v=0;v<256;++v) { write(0x21,v); write(0xa1,255-v); read(0x21); read(0xa1); }
let seed=0x5921, random=()=>{ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed; };
for (const [icw1,icw4] of [[0x11,1],[0x11,3],[0x11,0x11],[0x19,1],[0x13,1]]) {
  init(icw1,icw4);
  for (let i=0;i<400;++i) {
    const chip=random()&1, command=chip ? 0xa0 : 0x20, data=command+1;
    let irq=random()%16; if (irq===2) irq=3;
    line(irq,(random()>>>9)&1);
    switch ((random()>>>7)%8) {
      case 0: write(data,random()&255); break;
      case 1: write(command,0x0c); read(command); break;
      case 2: write(command,0x20); break;
      case 3: write(command,0x60|(random()&7)); break;
      case 4: write(command,0xa0); break;
      case 5: write(command,0xc0|(random()&7)); break;
      case 6: write(command,(random()&1) ? 0x68 : 0x48); break;
      case 7: write(chip ? 0x4d1 : 0x4d0,random()&255); break;
    }
    write(command,0x0a); read(command); write(command,0x0b); read(command); sample();
  }
}
const input=ops.map(o=>o.join(' ')).join('\n')+'\n';
const observed=spawnSync(model,[...modelArgs,'--trace'],{input,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
assert.equal(observed.status,0,observed.stderr || String(observed.error));
const expected=observed.stdout.trim().split(/\s+/).map(Number);
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port; await new Promise(resolve=>server.close(resolve));
const child=spawn(qemu,['-machine','pc','-m','16M','-accel','tcg','-S','-display','none','-nodefaults','-net','none',
  '-qtest',`tcp:127.0.0.1:${port},server=on,wait=off`,'-qmp','stdio'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
let errors=''; child.stderr.on('data',b=>{ errors=(errors+b).slice(-8000); });
function lines(stream) {
  const queued=[], waiting=[]; let closed;
  const rl=createInterface({input:stream});
  rl.on('line',s=>{ const w=waiting.shift(); if (w) w.resolve(s); else queued.push(s); });
  function finish(error) { closed=error; for (const w of waiting.splice(0)) w.reject(error); }
  rl.on('error',finish); stream.on('error',finish);
  rl.on('close',()=>finish(new Error('oracle stream closed')));
  return () => queued.length ? Promise.resolve(queued.shift()) : closed ? Promise.reject(closed)
    : new Promise((resolve,reject)=>waiting.push({resolve,reject}));
}
const nextQmp=lines(child.stdout);
let socket, timeout=setTimeout(()=>child.kill(),30000);
try {
  assert(JSON.parse(await nextQmp()).QMP,'QMP greeting');
  let serial=0;
  async function qmp(execute,args) {
    const id=++serial; child.stdin.write(JSON.stringify({execute,arguments:args || {},id})+'\n');
    for (;;) { const r=JSON.parse(await nextQmp()); if (r.id!==id) continue; assert(!r.error,JSON.stringify(r)); return r.return; }
  }
  await qmp('qmp_capabilities');
  const children=await qmp('qom-list',{path:'/machine/unattached'}), paths=[];
  for (const item of children) if (item.type==='child<isa-i8259>') {
    const path=`/machine/unattached/${item.name}`;
    const master=await qmp('qom-get',{path,property:'master'}); paths[master ? 0 : 1]=path;
  }
  assert.equal(paths.filter(Boolean).length,2,'discover both actual PIC objects');
  socket=createConnection({host:'127.0.0.1',port});
  await new Promise((resolve,reject)=>{ socket.once('connect',resolve); socket.once('error',reject); });
  const next=lines(socket); let comparisons=0;
  for (let index=0;index<ops.length;++index) {
    const op=ops[index];
    let command;
    if (op[0]==='W') command=`outb ${op[1]} ${op[2]}`;
    else if (op[0]==='R') command=`inb ${op[1]}`;
    else command=`set_irq_in ${paths[op[1]>>3]} unnamed-gpio-in ${op[1]&7} ${op[2]}`;
    socket.write(command+'\n'); const response=await next();
    assert(response.startsWith('OK'),`${command}: ${response}`);
    if (op[0]==='R') {
      assert.equal(Number(response.split(/\s+/)[1]),expected[comparisons],
        `read ${comparisons}, op ${command}, preceding ${JSON.stringify(ops.slice(Math.max(0,index-12),index+1))}`);
      ++comparisons;
    }
  }
  assert.equal(comparisons,expected.length);
  const version=await qmp('query-version');
  console.log(JSON.stringify({format:'pic-qtest-independent-device-v1',status:'pass',operations:ops.length,
    comparisons,qemu:version.qemu,model:'standalone C PIC',cpuExecution:'paused; register/IRQ/poll device comparison only',
    linuxBoot:'not-tested'},null,2));
} catch (error) { throw new Error(`${error.message}\n${errors}`,{cause:error}); }
finally { clearTimeout(timeout); socket?.destroy(); child.kill(); }
