// Flat CDP sessions; pause new children until Network observation is armed.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';

const auto={autoAttach:true,waitForDebuggerOnStart:true,flatten:true};
export async function launchIsolatedChrome(executable) {
  if(!executable.startsWith('/')) throw Error('Supply an explicit executable path');
  const profile=await mkdtemp(join(tmpdir(),'ricebox-receipt-'));
  const config=join(profile,'config'), cache=join(profile,'cache');
  await Promise.all([mkdir(config),mkdir(cache)]);
  const child=spawn(executable,[
    '--headless','--no-first-run','--disable-background-networking',
    '--remote-debugging-pipe','--user-data-dir='+join(profile,'browser'),'about:blank',
  ],{stdio:['ignore','ignore','pipe','pipe','pipe'],
  env:{...process.env,XDG_CONFIG_HOME:config,XDG_CACHE_HOME:cache}});
  let id=0, frame='', stderr='', dead=null;
  const pending=new Map(), listeners=new Set();
  const fail=error=>{
    dead=error;
    for(const {reject} of pending.values()) reject(error);
    pending.clear();
  };
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
  child.on('error',fail);
  // A process abort can close both pipes just before its exit event. Keep
  // the browser's stderr/exit diagnostic instead of racing ECONNRESET.
  const pipeError=error=>{stderr=(stderr+'\n'+error).slice(-4096);};
  child.stdio[3].on('error',pipeError);child.stdio[4].on('error',pipeError);
  child.on('exit',(code,signal)=>fail(Error('Browser exited '+(signal??code)+'\n'+stderr)));
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data',chunk=>{
    const frames=(frame+chunk).split('\0'); frame=frames.pop();
    for(const raw of frames) {
      const msg=JSON.parse(raw);
      if(msg.id) {
        const entry=pending.get(msg.id);
        if(!entry) continue;
        pending.delete(msg.id);
        if(msg.error) entry.reject(Error(entry.method+': '+msg.error.message));
        else entry.resolve(msg.result);
      } else {
        for(const listen of listeners) listen(msg);
      }
    }
  });
  async function command(method,params={},sessionId) {
    if(dead) throw dead;
    const token=++id;
    let timer;
    try {
      return await new Promise((resolve,reject)=>{
        timer=setTimeout(()=>{pending.delete(token);reject(Error('CDP timeout: '+method+'\n'+stderr));},10_000);
        pending.set(token,{resolve,reject,method});
        child.stdio[3].write(JSON.stringify({id:token,method,params,sessionId})+'\0');
      });
    } finally {clearTimeout(timer);}
  }
  const close=async()=>{
    if(child.pid && child.exitCode===null && child.signalCode===null) {
      const done=once(child,'exit').catch(()=>{});
      // Ask Chrome to close; signal only the child we own if startup failed.
      let timer;
      await Promise.race([command('Browser.close').catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,750);})]);
      clearTimeout(timer);
      if(child.exitCode===null&&child.signalCode===null) child.kill();
      await done;
    }
    await rm(profile,{recursive:true,force:true});
  };
  try {
    const version=await command('Browser.getVersion');
    return {version,command,close,subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);}};
  } catch(error){await close();throw error;}
}

export async function armCapture(browser) {
  const {command}=browser, events=[], targets=new Map(), byId=new Map(), errors=[], work=new Set();
  const {targetId}=await command('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
  const page={type:'page',url:'about:blank',targetId,sessionId,enabled:false};
  targets.set(sessionId,page);byId.set(targetId,page);
  const configure=async(target,paused)=>{
    await command('Network.enable',{},target.sessionId);
    await command('Runtime.enable',{},target.sessionId);
    target.enabled=true;
    await command('Target.setAutoAttach',auto,target.sessionId);
    if(paused) await command('Runtime.runIfWaitingForDebugger',{},target.sessionId);
  };
  const unsubscribe=browser.subscribe(msg=>{
    if(msg.method==='Target.attachedToTarget'&&targets.has(msg.sessionId)) {
      const {targetInfo,sessionId:child,waitingForDebugger}=msg.params;
      if(targets.has(child)) {errors.push('Duplicate target session: '+child);return;}
      const target={...targetInfo,sessionId:child,parent:msg.sessionId,enabled:false};
      targets.set(child,target);byId.set(target.targetId,target);
      if(!waitingForDebugger) errors.push('Child not paused before capture: '+child);
      const p=configure(target,waitingForDebugger).catch(err=>errors.push(String(err)));
      work.add(p);void p.finally(()=>work.delete(p));
    } else if(msg.method==='Target.targetInfoChanged') {
      const info=msg.params.targetInfo, old=byId.get(info.targetId);
      if(old&&info.url) old.url=info.url;
    } else if(msg.method==='Target.detachedFromTarget') {
      const target=targets.get(msg.params.sessionId);
      if(target) target.detached=true;
    } else if(msg.method==='Runtime.exceptionThrown'&&targets.has(msg.sessionId)) {
      const info=msg.params.exceptionDetails;
      errors.push('Uncaught page/Worker exception: '+(info.exception?.description??info.text));
    } else if(msg.method?.startsWith('Network.')&&targets.has(msg.sessionId)) events.push(msg);
  });
  try {
    await configure(page,false);await command('Page.enable',{},sessionId);
    // Discovery provides target URL updates even when the initial info is blank.
    await command('Target.setDiscoverTargets',{discover:true});
  } catch(error){unsubscribe();throw error;}
  const drain=async()=>{
    while(work.size) await Promise.all([...work]);
    const {targetInfos}=await command('Target.getTargets');
    for(const info of targetInfos) {
      const target=byId.get(info.targetId);
      if(target&&info.url) target.url=info.url;
      else if(!target && ['worker','shared_worker','service_worker','iframe'].includes(info.type)) {
        errors.push('Unattached '+info.type+' detected: '+info.url);
      }
    }
  };
  const evaluate=async(expression)=>{
    const {result,exceptionDetails}=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    if(exceptionDetails) throw Error(exceptionDetails.exception?.description??exceptionDetails.text);
    return result.value;
  };
  const close=async()=>{
    try {await command('Target.closeTarget',{targetId});}
    finally {unsubscribe();}
  };
  return {events,targets,errors,drain,close,evaluate,
    call:(method,params={})=>command(method,params,sessionId)};
}
