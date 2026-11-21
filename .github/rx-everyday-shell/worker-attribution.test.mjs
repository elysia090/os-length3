import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {observeWorkerAttribution,renderWorkerAttribution} from './worker-attribution.mjs';

const qa=new URL('../../ricebox/everyday/test/wayland/static-acceptance/',import.meta.url);
const worker='http://127.0.0.1:4321/demo/known-worker.js';
const pack='http://127.0.0.1:4321/demo/frozen.pack';
const secret='DO_NOT_LOG /tmp/receipt ::error:: retained header';
const id='00000000-0000-4000-8000-000000000001',phase='first';
const targets=new Map([['page',{type:'page',enabled:true}],['worker',{type:'worker',url:worker,enabled:true,parent:'page'}],
  ['nested',{type:'worker',url:worker,enabled:true,parent:'worker'}],['other-frame',{type:'page',enabled:true}]]);
const scope=url=>url===worker?'bootstrap':url===pack?'root':null;
const workerURL=url=>url===worker;
const row=(overrides={})=>({phase,id,url:worker,method:'GET',status:200,bytes:4,range:null,contentRange:null,encoding:null,
  completed:true,...overrides});
const event=(sessionId,requestId,method,params)=>({sessionId,method,params:{requestId,...params}});
const req=(s,r,url=worker,method='GET',headers={})=>event(s,r,'Network.requestWillBeSent',{request:{url,method,headers}});
const res=(s,r,headerId=id,status=200,url=worker,more={})=>event(s,r,'Network.responseReceived',{
  response:{url,status,headers:{'x-ricebox-receipt':headerId}},...more});
const extra=(s,r,headerId=id,statusCode=200,h={})=>event(s,r,'Network.responseReceivedExtraInfo',{
  statusCode,headers:{'X-Ricebox-Receipt':headerId,...h}});
const finish=(s,r)=>event(s,r,'Network.loadingFinished',{encodedDataLength:300});
const scratch=t=>{const d=mkdtempSync(join(tmpdir(),'rx-worker-control-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
const run=(cwd,bin,args)=>{const p=spawnSync(bin,args,{cwd,encoding:'utf8'});assert.equal(p.status,0,p.stdout+p.stderr);};
async function realReceipt(t){
  const d=scratch(t),receiptBase='sealed-parent/ricebox-transfer-receipt-f0748b1';
  for(const file of ['capture.mjs','origin.mjs','routes.mjs','receipt.mjs','run-receipt.mjs'])
    copyFileSync(new URL(receiptBase+'/'+file,qa),join(d,file));
  const patches='sealed-parent/ricebox-staged-shell-fresh-witness-28c45a6';
  for(const f of ['run-receipt-fresh-witness.patch','run-receipt-diagnostics.patch']){
    const path=new URL(patches+'/'+f,qa).pathname;
    run(d,'git',['apply','--check',path]);run(d,'git',['apply',path]);
  }
  return {...await import(pathToFileURL(join(d,'receipt.mjs'))),d};
}
function observe(events,origin,browser=[],errors=[]){
  return observeWorkerAttribution({events,targets,origin,browser,errors,isAllowedWorker:workerURL});
}
test('duplicate browser rows keep original receipt held; exact origin group and native header provenance are separately counted',async t=>{
  const {buildReceipt}=await realReceipt(t);
  const events=[req('page','r'),res('page','r','cached-effective-id'),extra('page','r'),finish('page','r'),
    req('worker','r'),res('worker','r'),finish('worker','r')];
  const r=buildReceipt({phase,events,targets,origin:[row()],scope,isAllowedWorker:workerURL});
  assert.equal(r.pass,false);
  assert.equal(r.coverageComplete,false);
  assert.equal(r.payloadBodyBytes,null);
  assert(r.coverageCodes.includes('cdp-origin-receipt-duplicate'));
  assert(!r.coverageCodes.includes('origin-duplicate-id'));
  const before=JSON.stringify({r,events,targets:[...targets]});
  const d=observe(events,r.origin,r.browser);
  for(const key of ['duplicate-origin-receipts','duplicate-origin-worker-scripts','duplicate-across-sessions',
    'duplicate-across-sessions-same-request-id','duplicate-across-related-sessions','duplicate-with-page-and-worker',
    'duplicate-mixed-header-sources','duplicate-raw-renderer-id-conflict'])assert.equal(d.counts[key],1,key);
  assert.equal(d.counts['duplicate-across-sessions-distinct-request-id'],0);
  assert.equal(d.counts['duplicate-within-session'],0);
  for(const [label,rows,expected] of [
    ['renderer-only',[req('page','a'),res('page','a'),finish('page','a'),req('page','b'),res('page','b'),finish('page','b')],
      ['duplicate-within-session','duplicate-all-renderer']],
    ['raw-only',[req('page','a'),res('page','a'),extra('page','a'),finish('page','a'),
        req('worker','b'),res('worker','b'),extra('worker','b'),finish('worker','b')],
      ['duplicate-across-sessions','duplicate-across-sessions-distinct-request-id','duplicate-all-raw-extra']],
  ]){
    const repeated=buildReceipt({phase,events:rows,targets,origin:[row()],scope,isAllowedWorker:workerURL});
    assert.equal(repeated.payloadBodyBytes,null,label);
    const d=observe(rows,repeated.origin,repeated.browser);
    for(const k of expected)assert.equal(d.counts[k],1,label+' '+k);
  }
  assert.equal(JSON.stringify({r,events,targets:[...targets]}),before);
  const one=[req('page','x'),res('page','x'),finish('page','x')];
  const normal=buildReceipt({phase,events:one,targets,origin:[row()],scope,isAllowedWorker:workerURL});
  assert.equal(normal.pass,true);
  assert.equal(observe(one,normal.origin,normal.browser).counts['duplicate-origin-receipts'],0);
});
test('one current-origin Worker ExtraInfo and an exact other-session request identify only a candidate; weaker pairings stay separate',()=>{
  const strict=[req('worker','r'),extra('nested','r'),finish('nested','r')];
  const c=observe(strict,[row()]).counts;
  for(const key of ['origin-worker-script-responses','worker-request-without-response','worker-response-without-request',
    'worker-raw-orphan-current-origin','worker-cross-session-same-id-unique','worker-split-request-and-response',
    'worker-split-request-and-response-ancestor','worker-split-finish-only-on-response-side'])assert.equal(c[key],1,key);
  const unrelated=observe([req('other-frame','r'),extra('nested','r')],[row()]).counts;
  assert.equal(unrelated['worker-split-request-and-response'],1);
  assert.equal(unrelated['worker-split-request-and-response-ancestor'],0);
  assert.equal(unrelated['worker-split-neither-has-finish'],1);
  for(const invalid of [
    [req('worker','different-id'),extra('nested','r')],
    [req('worker','r',worker,'HEAD'),extra('nested','r')],
    [req('worker','r',pack),extra('nested','r')],
    [req('worker','r'),extra('nested','r','stale')],
    [req('worker','r'),res('nested','r',id,200,pack),extra('nested','r')],
    [event('worker','r','Network.requestWillBeSent',{request:{url:worker,method:'GET'},redirectResponse:{}}),extra('nested','r')],
  ]) assert.equal(observe(invalid,[row()]).counts['worker-split-request-and-response'],0);
  const ambiguous=observe([...strict,req('page','r')],[row()]).counts;
  assert.equal(ambiguous['worker-cross-session-same-id-ambiguous'],1);
  assert.equal(ambiguous['worker-split-request-and-response'],0);
  const complete=observe([...strict,res('worker','r'),finish('worker','r')],[row()]).counts;
  assert.equal(complete['worker-cross-session-same-id-unique'],1);
  assert.equal(complete['worker-split-request-and-response'],0);
  const conflicting=observe([...strict,res('nested','r','other')],[row()]).counts;
  assert.equal(conflicting['worker-orphan-conflicting-header'],1);
  assert.equal(conflicting['worker-split-request-and-response'],0);
});
test('wire 304 / effective 200 and request Range vs Content-Range remain separate without inferred body',async t=>{
  const {buildReceipt}=await realReceipt(t);
  const events=[req('worker','r',pack,'GET',{Range:'bytes=5-8'}),res('worker','r',id,200,pack),
    extra('worker','r',id,304),finish('worker','r')];
  const r=buildReceipt({phase,events,targets,origin:[row({url:pack,status:304,bytes:0,range:'bytes=0-3'})],scope,isAllowedWorker:workerURL});
  assert.equal(r.pass,false);assert.equal(r.payloadBodyBytes,null);
  const o=observe(events,r.origin,r.browser).counts;
  assert.equal(o['matched-wire-304-effective-200'],1);
  assert.equal(o['matched-raw-status-mismatch'],0);
  assert.equal(o['matched-request-range-mismatch'],1);
  assert.equal(o['matched-content-range-mismatch'],0);
  const f=[req('worker','r',pack,'GET',{Range:'bytes=0-3'}),res('worker','r',id,200,pack),finish('worker','r')];
  const q=buildReceipt({phase,events:f,targets,origin:[row({url:pack,status:206,bytes:4,range:'bytes=0-3',
    contentRange:'bytes 0-3/4'})],scope,isAllowedWorker:workerURL});
  const m=observe(f,q.origin,q.browser).counts;
  assert.equal(m['matched-effective-status-mismatch-without-raw'],1);
  assert.equal(m['matched-content-range-mismatch'],1);
  assert.equal(m['matched-request-range-mismatch'],0);
  assert.equal(q.payloadBodyBytes,null);
});
test('scope, caps and typed capture categories contain only known numeric values',()=>{
  assert.equal(observe([], [row(),row()]),null);
  assert.equal(observe(new Array(32769).fill(null),[]),null);
  const d=observe([], [row()],[],[
    'Duplicate target session: '+secret,'Child not paused before capture: '+secret,'Uncaught page/Worker exception: '+secret,
    'Unattached worker detected: '+secret,secret,
  ]);
  for(const key of ['capture-duplicate-session','capture-child-not-paused','capture-runtime-exception','capture-unattached-target','capture-other'])
    assert.equal(d.counts[key],1,key);
  assert(!JSON.stringify(d).includes(secret));
});
test('public output requires pinned stock shell phase custody; never prints request identity or offsets',t=>{
  const d=scratch(t),pins=join(d,'pins.json'),pin='a'.repeat(64),profile='local-revalidate';
  writeFileSync(pins,JSON.stringify({webroot:pin}));
  const obs=observe([], [row()]);
  const c={profile,sameReleaseDigest:pin,runError:null,diagnosticFailure:null,pass:false,browser:{product:'Chrome/157.0.8103.78'},
    sandbox:{layer:'Namespace',pid:'Yes',network:'Yes',seccomp:'Yes'},
    phases:['first','revisit'].map((p,i)=>({phase:p,pass:false,coverageComplete:false,payloadBodyBytes:null,
      origin:[{id,url:worker,range:secret}],observations:{stage:'prompt',focus:'host-focus',marker:true,cleanExit:true,
        expectedMarker:'RICEBOX-BOOT:'+(40+i)},workerAttribution:JSON.parse(JSON.stringify(obs))}))};
  const f=join(d,profile+'.stdout');
  const render=x=>{writeFileSync(f,JSON.stringify(x));return renderWorkerAttribution(d,pins).join('\n');};
  let out=render(c);
  assert.match(out,/local-revalidate first origin-worker-script-responses=1/);
  assert.match(out,/local-immutable unavailable/);
  for(const forbidden of [secret,id,worker,'RICEBOX-BOOT','payloadBodyBytes','157.0.8103.78'])assert(!out.includes(forbidden));
  for(const bad of [secret,8193,-1,1.5,true,null]){
    c.phases[0].workerAttribution.counts['origin-worker-script-responses']=bad;
    out=render(c);assert.match(out,/local-revalidate first unavailable/);assert(!out.includes('first observed'));
  }
  c.phases[0].workerAttribution=obs;
  out=render({...c,diagnosticFailure:{stage:secret}});
  assert.match(out,/local-revalidate unavailable/);assert(!out.includes('local-revalidate first'));
  out=render({...c,sameReleaseDigest:'b'.repeat(64)});
  assert.match(out,/local-revalidate unavailable/);
});
test('observer patch applies to a private copy with exact anchors; preserves authoritative gate and sandbox text',async t=>{
  const {d}=await realReceipt(t);
  const before=readFileSync(new URL('run-static-acceptance.mjs',qa),'utf8');
  writeFileSync(join(d,'run-static-acceptance.mjs'),before);
  const patch=new URL('./worker-attribution-observer.patch',import.meta.url).pathname;
  run(d,'git',['apply','--whitespace=error','--check',patch]);run(d,'git',['apply','--whitespace=error',patch]);
  run(d,process.execPath,['--check','run-static-acceptance.mjs']);
  const patched=readFileSync(join(d,'run-static-acceptance.mjs'),'utf8');
  const [beforeFirst,beforeRest]=before.split('      const original=readFileSync');
  const [postFirst,postRest]=patched.split('      const original=readFileSync');
  const tail="      copyFileSync(fileURLToPath(new URL('./probe-staged.mjs',import.meta.url))";
  assert.equal(beforeFirst,postFirst);
  assert.equal(beforeRest.split(tail)[1],postRest.split(tail)[1]);
  assert.equal(before.split("result.sandbox=await verifySandbox(browser)").length,2);
  assert.equal(patched.split("result.sandbox=await verifySandbox(browser)").length,2);
  assert.equal(readFileSync(join(d,'run-receipt.mjs'),'utf8').split('      result.phases.push(receipt);').length,2);
  const second=spawnSync('git',['apply','--whitespace=error','--check',patch],{cwd:d});
  assert.notEqual(second.status,0);
});
test('actual hosted private observer assembly enforces source/module/patch hashes and leaves inputs unchanged',t=>{
  const d=scratch(t),source=join(d,'source'),helpers=join(d,'helpers');
  run(d,'mkdir',[source,helpers]);
  const sourceNames=['run-static-acceptance.mjs','sandbox-same-process.mjs','probe-staged.mjs'];
  const helperNames=['worker-attribution.mjs','worker-attribution-observer.patch'];
  for(const name of sourceNames)copyFileSync(new URL(name,qa),join(source,name));
  for(const name of helperNames)copyFileSync(new URL('./'+name,import.meta.url),join(helpers,name));
  const ci=readFileSync(new URL('./ci.sh',import.meta.url),'utf8');
  const before=Object.fromEntries([...sourceNames.map(x=>join(source,x)),...helperNames.map(x=>join(helpers,x))].map(path=>[path,readFileSync(path,'utf8')]));
  assert.match(ci,/^base=9617595bbdf413ca596ebc9a34433d97288ee37f$/m);
  const fn=ci.match(/^stage_attribution\(\) \(\n[\s\S]*?\n\)$/m)?.[0];
  assert(fn);
  const prefix='set -euo pipefail\numask 077\np=$1; qa=$2; attribution=$3;\n'+
    'pin() { printf "%s  %s\\n" "$1" "$2" | sha256sum -c -; }\n';
  function invoke(name){return spawnSync('bash',['-c',prefix+fn+'\nstage_attribution','test',helpers,source,join(d,name)],
      {cwd:d,encoding:'utf8'});}
  const staged=invoke('first');assert.equal(staged.status,0,staged.stdout+staged.stderr);
  assert.match(readFileSync(join(d,'first/run-static-acceptance.mjs'),'utf8'),/receipt\.workerAttribution=observeWorkerAttribution/);
  for(const [path,bytes] of Object.entries(before))assert.equal(readFileSync(path,'utf8'),bytes);
  for(const [i,path] of Object.keys(before).entries()){
    writeFileSync(path,before[path]+'\n// Changed bytes');
    assert.notEqual(invoke('tamper-'+i).status,0,path);
    writeFileSync(path,before[path]);
  }
});
