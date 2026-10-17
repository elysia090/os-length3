// Independent paused-device tests only. This is never imported by the product.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer,createConnection} from 'node:net';
import {createInterface} from 'node:readline';
function lines(stream) {
  const queued=[],waiting=[]; let closed;
  const rl=createInterface({input:stream});
  rl.on('line',s=>{ const w=waiting.shift(); if (w) w.resolve(s); else queued.push(s); });
  function finish(error) { closed=error; for (const w of waiting.splice(0)) w.reject(error); }
  rl.on('error',finish); stream.on('error',finish);
  rl.on('close',()=>finish(new Error('oracle stream closed')));
  return ()=>queued.length ? Promise.resolve(queued.shift()) : closed ? Promise.reject(closed)
    : new Promise((resolve,reject)=>waiting.push({resolve,reject}));
}
export async function withQtestDevice(qemu,extra,check) {
  const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port; await new Promise(resolve=>server.close(resolve));
  const child=spawn(qemu,['-machine','pc','-m','16M','-accel','tcg','-S','-display','none','-nodefaults','-net','none',
    ...extra,'-qtest',`tcp:127.0.0.1:${port},server=on,wait=off`,'-qmp','stdio'],
    {windowsHide:true,stdio:['pipe','pipe','pipe']});
  let errors=''; child.stderr.on('data',b=>{ errors=(errors+b).slice(-8000); });
  child.on('error',error=>{ errors=(errors+error.message).slice(-8000); });
  const nextQmp=lines(child.stdout); let socket;
  const timeout=setTimeout(()=>child.kill(),30000);
  try {
    assert(JSON.parse(await nextQmp()).QMP,'QMP greeting'); let serial=0;
    async function qmp(execute,args) {
      const id=++serial; child.stdin.write(JSON.stringify({execute,arguments:args || {},id})+'\n');
      for (;;) { const r=JSON.parse(await nextQmp()); if (r.id!==id) continue; assert(!r.error,JSON.stringify(r)); return r.return; }
    }
    await qmp('qmp_capabilities');
    socket=createConnection({host:'127.0.0.1',port});
    await new Promise((resolve,reject)=>{ socket.once('connect',resolve); socket.once('error',reject); });
    const next=lines(socket);
    async function command(input) {
      socket.write(input+'\n'); const response=await next();
      assert(response.startsWith('OK'),`${input}: ${response}`); return response;
    }
    return await check({qmp,command});
  } catch (error) { throw new Error(`${error.message}\n${errors}`,{cause:error}); }
  finally { clearTimeout(timeout); socket?.destroy(); child.kill(); }
}
