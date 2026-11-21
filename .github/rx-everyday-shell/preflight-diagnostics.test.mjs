import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {appendFileSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {initTrace,traceMarker,readDoctor,renderTrace} from './preflight-diagnostics.mjs';

const privateData='RAW_PRIVATE_/tmp/not-public?token=abc\n::error::do-not-print';
const head='28c45a65649b1058da0ad5077624e8fd4fa3cee9',parent='783c012c0f2cc4d45c584717b37cb0e9e601eefa';
const qa=new URL('../../ricebox/everyday/test/wayland/static-acceptance/',import.meta.url);
const stock=process.env.EVERYDAY_STOCK_CHROME_SOURCE??new URL('../browser/stock-chrome.ts',qa);
const stages=['doctor-invoke','doctor-owner','socket-unix','socket-ipv4','sandbox-fixture',
  'launch-storage','launch-spawn-call','browser-get-version','stock-product','cdp-target-arm',
  'cdp-sandbox-navigation','cdp-sandbox-report','cdp-sandbox-policy','cdp-target-cleanup','browser-cleanup'];
const route=new URL('./preflight-diagnostics.mjs',import.meta.url);
const fileOf=name=>new URL(name,qa);
const scratch=t=>{
  const d=mkdtempSync(join(tmpdir(),'rx-preflight-control-'));
  t.after(()=>rmSync(d,{recursive:true,force:true}));
  return d;
};
const report=(path,mode)=>spawnSync(process.execPath,[route.pathname,'report',path,mode],{encoding:'utf8'});
const exactStock=()=>{
  const b=readFileSync(stock);
  assert.equal(createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex'),'6db7dd3f7583c3aa695a37ce0cb86d7068b80dbf');
  return b;
};
function loadModules(t){
  const d=scratch(t);
  copyFileSync(fileOf('sealed-parent/ricebox-transfer-receipt-f0748b1/capture.mjs'),join(d,'capture.mjs'));
  copyFileSync(fileOf('sandbox-same-process.mjs'),join(d,'sandbox-same-process.mjs'));
  writeFileSync(join(d,'stock-chrome.ts'),exactStock());
  const patch=new URL('./sandbox-observers.patch',import.meta.url).pathname;
  for(const flags of [['--check'],[]]){
    const applied=spawnSync('git',['apply','--whitespace=error',...flags,patch],{cwd:d,encoding:'utf8'});
    assert.equal(applied.status,0,applied.stdout+applied.stderr);
  }
  return {d,capture:pathToFileURL(join(d,'capture.mjs')),sandbox:pathToFileURL(join(d,'sandbox-same-process.mjs'))};
}
function logger(){
  const events=[];
  return {events,observe:(stage,state,data)=>events.push([stage,state,data]),states:()=>events.map(a=>a.slice(0,2))};
}

test('literal reporter preserves valid positive evidence; a missing or contradictory phase cannot pass',t=>{
  const d=scratch(t),f=join(d,'trace');
  initTrace(f,{ImageOS:'ubuntu24',ImageVersion:'20261116.376.1'},'6.14.0-1012-azure');
  for(const k of stages.slice(0,-1)){traceMarker(f,k,'start');traceMarker(f,k,'pass','HeadlessChrome/156.0.8116.41')}
  assert.equal(report(f,'complete').status,1);
  assert.match(report(f,'complete').stdout,/RX_EVERYDAY_CHROME_TRACE incomplete/);
  traceMarker(f,'browser-cleanup','start');traceMarker(f,'browser-cleanup','pass');
  const ready=report(f,'complete');
  assert.equal(ready.status,0);
  assert.match(ready.stdout,/image=ubuntu24\/20261116\.376\.1/);
  assert.match(ready.stdout,/kernel=6\.14\.0-1012-azure/);
  assert.match(ready.stdout,/chrome-cdp=156\.0\.8116\.41/);
  traceMarker(f,'browser-cleanup','start');
  const duplicate=report(f,'complete');
  assert.equal(duplicate.status,1);
  assert.equal(duplicate.stdout,'RX_EVERYDAY_CHROME_TRACE unavailable\n');
  const noMeta=join(d,'without-metadata');
  initTrace(noMeta,{},'unknown-kernel');
  for(const k of stages){traceMarker(noMeta,k,'start');traceMarker(noMeta,k,'pass');}
  const complete=report(noMeta,'complete');
  assert.equal(complete.status,0);
  assert(!complete.stdout.includes('RX_EVERYDAY_CHROME_ENV'));
});
test('unknown stage, private stdout/stderr and non-bounded metadata never publish',t=>{
  const d=scratch(t),f=join(d,'trace'),df=join(d,'doctor');
  initTrace(f,{ImageOS:privateData,ImageVersion:privateData},privateData);
  assert.throws(()=>traceMarker(f,privateData,privateData));
  traceMarker(f,'browser-get-version','start');traceMarker(f,'browser-get-version','pass',privateData);
  writeFileSync(df,privateData);
  traceMarker(f,'doctor-invoke','start');
  assert.equal(readDoctor(f,df,1),false);
  let observed=report(f,'partial');
  assert.equal(observed.status,0);
  assert(!observed.stdout.includes('PRIVATE')&&!observed.stdout.includes('ENV'));
  assert.match(observed.stdout,/doctor-invoke hold/);
  appendFileSync(f,JSON.stringify(['stage',privateData,'start'])+'\n');
  observed=report(f,'partial');
  assert.equal(observed.status,1);
  assert.equal(observed.stdout,'RX_EVERYDAY_CHROME_TRACE unavailable\n');
});
test('doctor ownership, independently named AF_UNIX/AF_INET checks and tool status fail closed',t=>{
  const d=scratch(t);
  const valid={schema:'ricebox-static-browser-doctor-v1',status:'ready',code:null,navigation:'not_run',
    version:'156.0.8116.41-1',sockets:{unix:'ok',ipv4:'ok'}};
  for(const [i,x,rc,needed,pass] of [
    [0,valid,0,['doctor-owner pass','socket-unix pass','socket-ipv4 pass','chrome-package=156.0.8116.41'],true],
    [1,{...valid,status:'blocked',code:'STOCK_CHROME_MISSING',version:null},2,['doctor-owner hold','socket-unix pass'],false],
    [2,{...valid,status:'blocked',code:'REQUIRED_SOCKET_UNAVAILABLE',sockets:{unix:'EPERM',ipv4:'ok'}},2,['doctor-owner pass','socket-unix hold EPERM','socket-ipv4 pass'],false],
    [3,{...valid,status:'blocked',code:'REQUIRED_SOCKET_UNAVAILABLE',sockets:{unix:'ok',ipv4:privateData}},2,['socket-unix pass','socket-ipv4 hold OTHER'],false],
    [4,valid,1,['doctor-invoke hold'],false],
    [5,{...valid,navigation:'navigate'},0,['doctor-invoke hold'],false],
  ]){
    const f=join(d,'trace'+i),df=join(d,'doctor'+i);
    initTrace(f,{},'');traceMarker(f,'doctor-invoke','start');writeFileSync(df,JSON.stringify(x));
    assert.equal(readDoctor(f,df,rc),pass);
    const visible=renderTrace(f).messages.join('\n');
    for(const s of needed)assert(visible.includes(s));
    assert(!visible.includes('PRIVATE'));
  }
});
test('actual launch bridge: storage/spawn errors and CDP version rejection hold; fixture close passes',async t=>{
  const {d,capture}=loadModules(t);
  const prior=process.env.TMPDIR;process.env.TMPDIR=d;
  t.after(()=>{if(prior===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=prior;});
  const {launchIsolatedChrome}=await import(capture);
  let log=logger();
  await assert.rejects(launchIsolatedChrome('relative',log.observe));
  assert.deepEqual(log.states(),[['launch-storage','start'],['launch-storage','hold']]);
  log=logger();
  await assert.rejects(launchIsolatedChrome('/invalid\x00file',log.observe));
  assert(log.states().some(([k,v])=>k==='launch-spawn-call'&&v==='hold'));
  log=logger();
  await assert.rejects(launchIsolatedChrome('/bin/false',log.observe));
  assert(log.states().some(([k,v])=>k==='browser-get-version'&&v==='hold'));
  assert.deepEqual(log.states().at(-1),['browser-cleanup','pass']);
  const stub=join(d,'cdp-stub');
  writeFileSync(stub, '#!'+process.execPath+'\n'+String.raw`
    const fs=require('node:fs');
    const args=process.argv.slice(2);
    if(args.length!==6||args[0]!=='--headless'||args[1]!=='--no-first-run'||
        args[2]!=='--disable-background-networking'||args[3]!=='--remote-debugging-pipe'||
        !/^--user-data-dir=/.test(args[4])||args[5]!=='about:blank')process.exit(23);
    let rest='';
    fs.createReadStream(null,{fd:3}).setEncoding('utf8').on('data',data=>{
      const frames=(rest+data).split('\0');rest=frames.pop();
      for(const raw of frames){
        const msg=JSON.parse(raw);
        if(msg.method==='Browser.getVersion')fs.writeSync(4,JSON.stringify({id:msg.id,result:{product:'Chrome/156.0.8116.41'}})+'\0');
        else if(msg.method==='Browser.close')process.exit(0);
        else process.exit(24);
      }
    });`,{mode:0o700});
  log=logger();
  const simulated=await launchIsolatedChrome(stub,log.observe);
  assert.equal(simulated.version.product,'Chrome/156.0.8116.41');
  await simulated.close();
  assert.deepEqual(log.states(),[
    ['launch-storage','start'],['launch-storage','pass'],['launch-spawn-call','start'],['launch-spawn-call','pass'],
    ['browser-get-version','start'],['browser-get-version','pass'],['browser-cleanup','start'],['browser-cleanup','pass']]);
});
test('version failure and failed browser cleanup are retained as separate fixed holds',async t=>{
  const {d,capture}=loadModules(t);
  const prior=process.env.TMPDIR;process.env.TMPDIR=d;
  t.after(()=>{if(prior===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=prior;});
  const fs=await import('node:fs/promises');
  t.mock.module('node:fs/promises',{exports:{mkdtemp:fs.mkdtemp,mkdir:fs.mkdir,rm:async()=>{throw ''}}});
  // Force the real launch bridge through a child failure and independently forced cleanup.
  const {launchIsolatedChrome}=await import(capture);
  const log=logger();
  await assert.rejects(launchIsolatedChrome('/bin/false',log.observe),error=>error==='');
  assert.deepEqual(log.states().slice(-4),[
    ['browser-get-version','start'],['browser-get-version','hold'],['browser-cleanup','start'],['browser-cleanup','hold']]);
});
test('same-process CDP arm, chrome:// navigation, report, policy and target cleanup report exact first/cleanup holds',async t=>{
  const {sandbox}=loadModules(t);
  const {verifySandbox}=await import(sandbox);
  const yes=[['Layer 1 Sandbox','Namespace'],['PID namespaces','Yes'],['Network namespaces','Yes'],['Seccomp-BPF sandbox','Yes']];
  const no=yes.map(([k,v])=>[k,k==='Seccomp-BPF sandbox'?'No':v]);
  const scenarios=[
    [[],[],yes,'Chrome/156.0.8116.41'],
    [['stock-product'],[],yes,'Chromium/156.0.8116.41'],
    [['cdp-target-arm'],['Network.enable'],yes],
    [['cdp-sandbox-navigation'],['Page.navigate'],yes],
    [['cdp-sandbox-report'],[],[['Layer 1 Sandbox','Namespace']]],
    [['cdp-sandbox-policy'],[],no],
    [['cdp-target-cleanup'],['Target.closeTarget'],yes],
    [['cdp-sandbox-policy','cdp-target-cleanup'],['Target.closeTarget'],no],
  ];
  for(const [holds,fail,rows,product='Chrome/156.0.8116.41'] of scenarios){
    const log=logger(),calls=[];
    const browser={version:{product},subscribe(){return ()=>{};},async command(method,params){
      calls.push([method,params]);
      if(fail.includes(method)){
        if(method==='Page.navigate')return {errorText:privateData};
        throw '';
      }
      if(method==='Target.createTarget')return {targetId:'tab'};
      if(method==='Target.attachToTarget')return {sessionId:'session'};
      if(method==='Runtime.evaluate')return {result:{value:rows}};
      return {};
    }};
    // Mock time only for the missing-report control; source constants stay intact.
    const original=Date.now;
    if(holds.includes('cdp-sandbox-report')){let count=0;Date.now=()=>++count*9_000;}
    try{
      if(holds.length)await assert.rejects(verifySandbox(browser,log.observe));
      else assert.equal((await verifySandbox(browser,log.observe)).seccomp,'Yes');
    }finally{Date.now=original;}
    assert.deepEqual(log.events.filter(x=>x[1]==='hold').map(x=>x[0]),holds);
    if(calls.some(([method])=>method==='Page.navigate')){
      assert.deepEqual(calls.filter(([method])=>method==='Page.navigate'),[['Page.navigate',{url:'chrome://sandbox/'}]]);
      assert.equal(calls.at(-1)[0],'Target.closeTarget');
    }
  }
});
test('real Bash orchestration rejects stale parent, doctor/fixture/trace failures and preserves stop codes',t=>{
  const d=scratch(t),bin=join(d,'bin'),product=join(d,'product');
  mkdirSync(bin);
  const stockDir=join(product,'ricebox/everyday/test/wayland/browser');
  mkdirSync(stockDir,{recursive:true});writeFileSync(join(stockDir,'stock-chrome.ts'),exactStock());
  const command=(name,source)=>writeFileSync(join(bin,name),'#!/bin/sh\n'+source,{mode:0o700});
  command('git',`
    if [ "$1" = '-C' ]; then
      if [ "$3" = status ]; then exit 0; fi
      if [ "$4" = HEAD ]; then printf '%s\\n' '${head}'; exit 0; fi
      if [ "$4" = 'HEAD^' ]; then printf '%s\\n' "$RX_CONTROL_PARENT"; exit 0; fi
    fi
    if [ "$1" = hash-object ] || [ "$1" = apply ]; then exec /usr/bin/git "$@"; fi
    exit 99
  `);
  command('cp',`
    if [ "$RX_CONTROL_CASE" = copy ]; then printf 'RAW_PRIVATE copy error\\n' >&2; exit 1; fi
    if [ "$RX_CONTROL_CASE" = corrupt-copy ]; then
      case "$1" in
      */capture.mjs) /usr/bin/cp "$@" || exit $?; printf 'RAW_PRIVATE invalid append\\n' >> "$2/capture.mjs"; exit 0;;
      esac
    fi
    exec /usr/bin/cp "$@"
  `);
  command('docker','printf "RAW_PRIVATE docker stub\\n" >&2; exit 42\n');
  command('node',`
    case "$1" in
    */run-static-acceptance.mjs)
      case "$RX_CONTROL_CASE" in
      unhandled)
        printf 'RAW_PRIVATE not JSON\\n'
        printf 'RAW_PRIVATE doctor stderr\\n' >&2
        exit 1;;
      socket)
        printf '%s\\n' '{"schema":"ricebox-static-browser-doctor-v1","status":"blocked","code":"REQUIRED_SOCKET_UNAVAILABLE","navigation":"not_run","version":"156.0.8116.41-1","sockets":{"unix":"EPERM","ipv4":"ok"}}'
        exit 2;;
      *) printf '%s\\n' '{"schema":"ricebox-static-browser-doctor-v1","status":"ready","code":null,"navigation":"not_run","version":"156.0.8116.41-1","sockets":{"unix":"ok","ipv4":"ok"}}'
        exit 0;;
      esac;;
    */sandbox-preflight.mjs)
      printf 'RAW_PRIVATE Chrome output\\n'
      printf 'RAW_PRIVATE Chrome stderr\\n' >&2
      [ "$RX_CONTROL_CASE" = complete ] || exit 0
      for stage in ${stages.slice(5).join(' ')}; do
        printf '["stage","%s","start"]\\n["stage","%s","pass"]\\n' "$stage" "$stage" >> "$2"
      done
      exit 0;;
    *) exec "$RX_REAL_NODE" "$@";;
    esac
  `);
  const cases=[
    ['stale-parent','27a78377d65c0f4dac6a64ae4e2b668c462f35bc',1,'stage=opt-in code=1',null],
    ['unhandled',parent,1,'stage=stock-chrome-sandbox code=1','doctor-invoke hold'],
    ['socket',parent,2,'stage=stock-chrome-sandbox code=2','socket-unix hold EPERM'],
    ['copy',parent,1,'stage=stock-chrome-sandbox code=1','sandbox-fixture hold'],
    ['corrupt-copy',parent,1,'stage=stock-chrome-sandbox code=1','sandbox-fixture hold'],
    ['trace-missing',parent,1,'stage=stock-chrome-sandbox code=1','RX_EVERYDAY_CHROME_TRACE incomplete'],
    ['complete',parent,42,'stage=exact-muk code=42','browser-cleanup pass'],
  ];
  for(const [phase,base,rc,why,observed] of cases){
    const runTemp=join(d,'run-'+phase);mkdirSync(runTemp);
    const env={...process.env,PATH:bin+':'+process.env.PATH,RUNNER_TEMP:runTemp,RX_REAL_NODE:process.execPath,
      RX_CONTROL_CASE:phase,RX_CONTROL_PARENT:base,GITHUB_REPOSITORY:'elysia090/os-length3',GITHUB_EVENT_NAME:'workflow_dispatch',
      GITHUB_ACTOR_ID:'148540043',GITHUB_ACTOR:'elysia090',GITHUB_TRIGGERING_ACTOR:'elysia090',
      GITHUB_REF:'refs/heads/diag/everyday-static-28c45a6'};
    const r=spawnSync('bash',[new URL('./ci.sh',import.meta.url).pathname,'preflight',product],{env,encoding:'utf8'});
    assert.equal(r.status,rc,phase+': '+r.stdout+r.stderr);
    assert(r.stdout.includes(why),phase);
    if(observed)assert(r.stdout.includes(observed),phase);
    assert(!r.stdout.includes('RAW_PRIVATE')&&!r.stderr.includes('RAW_PRIVATE'),phase);
    if(phase==='stale-parent')assert(!existsSync(join(runTemp,'rx-everyday-shell-28c45a6')),phase);
    if(phase!=='complete')assert(!r.stdout.includes('DERIVATIVE_STAGE exact-muk'),phase);
    if(phase==='trace-missing')assert.equal(r.stdout.match(/sandbox-fixture pass/g)?.length,1);
  }
});
