// Read-only diagnostic attach to an explicitly selected, already-running
// startup process. No guest register/memory modification or checkpoint load.
const pid=Number(process.argv[2]);
if(!Number.isSafeInteger(pid)||pid<1)throw new Error('STARTUP-PID');
const list=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(2000)})).json();
if(list.length!==1||!list[0].webSocketDebuggerUrl.startsWith('ws://127.0.0.1:9229/'))throw new Error('one loopback target');
const socket=new WebSocket(list[0].webSocketDebuggerUrl),pending=new Map();let sequence=0,paused,pausedResolve;
const pauseEvent=new Promise(resolve=>pausedResolve=resolve);
socket.addEventListener('message',event=>{const message=JSON.parse(event.data);
  if(message.method==='Debugger.paused'){paused=message.params;pausedResolve(paused);}
  if(message.id){const waiter=pending.get(message.id);if(waiter){pending.delete(message.id);clearTimeout(waiter.timer);
    message.error?waiter.reject(new Error(JSON.stringify(message.error))):waiter.resolve(message.result);}}});
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
function request(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`timeout ${method}`));},5000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
let owner=false;
try{
  const identity=await request('Runtime.evaluate',{expression:'JSON.stringify({pid:process.pid,args:process.argv})',returnByValue:true});
  const target=JSON.parse(identity.result.value);
  if(target.pid!==pid||!target.args[1]?.replaceAll('\\','/').endsWith('/data/oracle/check-wasm-startup.mjs')
      &&!target.args[1]?.replaceAll('\\','/').endsWith('data/oracle/check-wasm-startup.mjs'))throw new Error('selected startup process identity');
  owner=true;await request('Debugger.enable');await request('Debugger.pause');
  await Promise.race([pauseEvent,new Promise((_,reject)=>setTimeout(()=>reject(new Error('pause timeout')),5000))]);
  let observed;
  for(const frame of paused.callFrames){const value=await request('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,
    expression:"typeof consoleOutput==='undefined'?null:JSON.stringify({console:new TextDecoder().decode(consoleOutput.subarray(0,consoleBytes)),retired,admissions,sourceHits,sourceMisses,engine:engines.stats(),rip:String(rip())})",returnByValue:true});
    if(typeof value.result?.value==='string'){observed=JSON.parse(value.result.value);break;}}
  console.log(JSON.stringify({format:'live-startup-observation-v1',pid,observed,frames:paused.callFrames.map(frame=>frame.functionName)}));
}finally{
  if(owner){if(paused)await request('Debugger.resume').catch(()=>{});await request('Debugger.disable').catch(()=>{});
    // Release the temporary listener after the read. No attach remains on the
    // benchmark and no network-facing debugger is part of the product.
    await request('Runtime.evaluate',{expression:'setImmediate(()=>process._debugEnd())'}).catch(()=>{});}
  socket.close();for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('diagnostic detached'));}
}
