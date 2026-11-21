import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile,spawnSync} from 'node:child_process';
import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkBrowserResult,classifyBrowserDiagnostic,diagnosticMarkers} from './run-static-acceptance.mjs';

const profile='local-revalidate', revision='28c45a65649b1058da0ad5077624e8fd4fa3cee9', pin='a'.repeat(64);
const leak='PRIVATE_path=/tmp/only-private?token=EXAMPLE';
const base='sealed-parent/ricebox-transfer-receipt-f0748b1';
const patches='sealed-parent/ricebox-staged-shell-fresh-witness-28c45a6';
const load=p=>new URL(p,import.meta.url);
const sandbox={seccomp:'Yes',pid:'Yes',network:'Yes',layer:'Namespace'};
const observed=(i)=>({stage:'prompt',focus:'host-focus',marker:true,cleanExit:true,expectedMarker:'RICEBOX-BOOT:'+i});
const good=()=>({profile,sameReleaseDigest:pin,browser:{product:'Chrome/123.4.5.6'},sandbox,pass:true,runError:null,diagnosticFailure:null,
  phases:['first','revisit'].map((phase,i)=>({phase,pass:true,coverageComplete:true,payloadBodyBytes:i===0?42:0,
    observations:observed(i),coverageCodes:[],failureCodes:[]}))});

test('phase classification leaves the original measured acceptance and redaction intact',()=>{
  const r=good();
  assert.equal(checkBrowserResult(r,profile,pin).status,'pass');
  assert.deepEqual(diagnosticMarkers(classifyBrowserDiagnostic(r,'ok',profile,null)),
    ['transport=ok','wrapper=none','phase=first:recorded','phase=revisit:recorded']);
  r.pass=false;r.phases[1]={...r.phases[1],pass:false,coverageComplete:false,payloadBodyBytes:null,coverage:[leak],
    coverageCodes:['worker-script-origin-cdp-response-missing',leak,'cdp-extra-info-missing','cdp-extra-info-missing']};
  const gap=checkBrowserResult(r,profile,pin);
  assert.deepEqual([gap.status,gap.cold,gap.revisit],['incomplete',42,null]);
  assert.deepEqual(diagnosticMarkers(classifyBrowserDiagnostic(r,'nonzero',profile,null)),[
    'transport=nonzero','wrapper=none','phase=first:recorded','phase=revisit:coverage-gap',
    'codes=revisit:cdp-extra-info-missing,worker-script-origin-cdp-response-missing']);
  r.phases[1]={...r.phases[1],coverageComplete:true,payloadBodyBytes:9,failureCodes:['revisit-frozen-payload']};
  assert.equal(checkBrowserResult(r,profile,pin).status,'fail');
  assert(diagnosticMarkers(classifyBrowserDiagnostic(r,'nonzero',profile,null)).includes('phase=revisit:policy-fail'));
  r.phases[1].payloadBodyBytes='0';
  assert.equal(checkBrowserResult(r,profile,pin).status,'incomplete');
  assert(diagnosticMarkers(classifyBrowserDiagnostic(r,'nonzero',profile,null)).includes('phase=revisit:body-counter-invalid'));
});

test('strict closed diagnostic markers for launch, sandbox, shell and parent failures',()=>{
  const runs=[['browser-launch',null],['sandbox-proof',null],['http-navigation','first'],['shell-witness','revisit']];
  for (const [stage,phase] of runs){
    const result={profile,pass:false,runError:leak,diagnosticFailure:{stage,phase},phases:[]};
    const actual=diagnosticMarkers(classifyBrowserDiagnostic(result,'nonzero',profile,'BROWSER_PHASES_UNPROVEN'));
    assert(actual.includes('run='+(phase?phase+':':'')+stage));
    assert(actual.includes('wrapper=BROWSER_PHASES_UNPROVEN'));
    assert(actual.includes('phase=first:missing'));
    assert(!actual.join(' ').includes(leak));
    const invalid={...result,diagnosticFailure:{stage:leak,phase:leak}};
    assert(!diagnosticMarkers(classifyBrowserDiagnostic(invalid,leak,profile,leak)).some(x=>x.startsWith('run=')));
    assert(!diagnosticMarkers(classifyBrowserDiagnostic(result,'nonzero','local-immutable',null)).some(x=>x.startsWith('run=')));
  }
  for(const outcome of ['spawn-error','timeout','signal']){
    assert(diagnosticMarkers(classifyBrowserDiagnostic(null,outcome,profile,leak)).includes('transport='+outcome));
  }
  const late=good();late.phases[1].observations.marker='true';
  assert.throws(()=>checkBrowserResult(late,profile,pin),/BROWSER_GUEST_PROOF_MISSING/);
  assert(diagnosticMarkers(classifyBrowserDiagnostic(late,'nonzero',profile,'BROWSER_GUEST_PROOF_MISSING'))
    .includes('phase=revisit:guest-unproven'));
});

test('public formatter accepts fixed markers and suppresses forged files, reason and payload',()=>{
  const d=mkdtempSync(join(tmpdir(),'rx-redaction-control-'));
  try{
    const file=join(d,'summary.json');
    const doc={schema:'ricebox-static-browser-admission-v1',revision,scope:'exact-package-shell-only-loopback-demo',
      status:'pass',stage:'complete',browserRuns:{}};
    for(const arm of [profile,'local-immutable'])doc.browserRuns[arm]={status:'pass',cold:42,revisit:0,
      diagnostic:classifyBrowserDiagnostic(good(),'ok',profile,null)};
    const emitter=fileURLToPath(load('../../../../../.github/rx-everyday-shell/allowlist-summary.mjs'));
    const run=()=>spawnSync(process.execPath,[emitter,file],{encoding:'utf8'});
    writeFileSync(file,JSON.stringify(doc));
    const ok=run();
    assert.equal(ok.status,0,ok.stderr);
    assert.match(ok.stdout,/RX_EVERYDAY_SHELL_BODIES local-revalidate cold=42 revisit=0/);
    assert.match(ok.stdout,/RX_EVERYDAY_SHELL_PARENT stage=complete status=pass/);
    doc.stage=leak;doc.reason=leak;doc.approved={raw:leak};
    doc.browserRuns[profile]={status:'incomplete',cold:42,revisit:leak,reason:leak,diagnostic:{
      transport:leak,wrapper:leak,run:{stage:leak,phase:null},phases:[{phase:'first',state:leak},
        {phase:'revisit',state:'coverage-gap',codes:[leak,'http-range-mismatch']}]}};
    writeFileSync(file,JSON.stringify(doc));
    const hold=run();
    assert.equal(hold.status,2,hold.stderr);
    assert.match(hold.stdout,/RX_EVERYDAY_SHELL_DIAG local-revalidate codes=revisit:http-range-mismatch/);
    assert(!hold.stdout.includes(leak)&&!hold.stdout.includes('RX_EVERYDAY_SHELL_BODIES local-revalidate '));
    doc.stage='complete';
    doc.browserRuns[profile]={status:'pass',cold:42,revisit:0,
      diagnostic:{transport:'ok',wrapper:'none',run:null,phases:[
        {phase:'first',state:'recorded'},{phase:'first',state:'coverage-gap'}]}};
    writeFileSync(file,JSON.stringify(doc));
    const duplicate=run();
    assert.equal(duplicate.status,2,duplicate.stderr);
    assert.match(duplicate.stdout,/local-revalidate phase=first:invalid/);
    assert(!duplicate.stdout.includes('local-revalidate phase=first:recorded'));
    assert(!duplicate.stdout.includes('RX_EVERYDAY_SHELL local-revalidate pass'));
    assert(!duplicate.stdout.includes('RX_EVERYDAY_SHELL_BODIES local-revalidate '));
    assert(!duplicate.stdout.includes('stage=complete status=pass'));
    doc.browserRuns[profile].diagnostic.phases=[{phase:'first',state:'recorded'},{phase:'revisit',state:'recorded'}];
    doc.browserRuns[profile].diagnostic.run={stage:'browser-close',phase:null};
    writeFileSync(file,JSON.stringify(doc));
    const cleanup=run();
    assert.equal(cleanup.status,2,cleanup.stderr);
    assert.match(cleanup.stdout,/local-revalidate run=browser-close/);
    assert(!cleanup.stdout.includes('RX_EVERYDAY_SHELL local-revalidate pass'));
    assert(!cleanup.stdout.includes('RX_EVERYDAY_SHELL_BODIES local-revalidate '));
    doc.stage='stock-browser';doc.status='blocked';
    doc.browserRuns[profile]={status:'fail',cold:42,revisit:9,diagnostic:{transport:'nonzero',wrapper:'none',run:null,
      phases:[{phase:'first',state:'recorded'},{phase:'revisit',state:'policy-fail',codes:['revisit-frozen-payload']}] }};
    writeFileSync(file,JSON.stringify(doc));
    const measuredFail=run();
    assert.equal(measuredFail.status,2,measuredFail.stderr);
    assert.match(measuredFail.stdout,/RX_EVERYDAY_SHELL local-revalidate fail/);
    assert.match(measuredFail.stdout,/RX_EVERYDAY_SHELL_BODIES local-revalidate cold=42 revisit=9/);
  }finally{rmSync(d,{recursive:true,force:true})}
});

const setup=()=>{
  const d=mkdtempSync(join(tmpdir(),'rx-diagnostic-stage-control-'));
  for(const file of ['run-receipt.mjs','receipt.mjs','capture.mjs','routes.mjs','origin.mjs','receipt.test.mjs'])
    cpSync(load(base+'/'+file),join(d,file));
  for(const file of ['run-receipt-fresh-witness.patch','run-receipt-diagnostics.patch']){
    const patch=readFileSync(load(patches+'/'+file));
    const wrapper=readFileSync(load('run-static-acceptance.mjs'),'utf8');
    assert(wrapper.includes(createHash('sha256').update(patch).digest('hex')));
    for(const args of [['--check'],[]]){
      const a=spawnSync('git',['apply',...args,'-'],{input:patch,cwd:d,encoding:'utf8'});
      assert.equal(a.status,0,a.stderr);
    }
  }
  // Same insertion as the wrapper, but a test-only fake verifies failure boundaries.
  const run=join(d,'run-receipt.mjs'), s=readFileSync(run,'utf8'), needle='  result.browser=browser.version;';
  assert.equal(s.split(needle).length,2);
  writeFileSync(run,"import {verifySandbox} from './sandbox-same-process.mjs';\n"+s.replace(needle,
    needle+"\n  if(mode==='staged'){at='sandbox-proof'; result.sandbox=await verifySandbox(browser);}"));
  return d;
};

test('reapply the exact two layers and preserve real HTTP plus synthetic CDP positive/negative controls',async()=>{
  const d=setup();
  try{
    const r=spawnSync(process.execPath,['--test',join(d,'receipt.test.mjs')],{encoding:'utf8',cwd:d});
    assert.equal(r.status,0,r.stdout+r.stderr);
    const {buildReceipt}=await import('file://'+join(d,'receipt.mjs'));
    const url='http://127.0.0.1:41411/demo/known-worker.js', id='worker-origin-id';
    const origin=[{phase:'first',id,url,completed:true,status:200,bytes:4,method:'GET',range:null,contentRange:null,encoding:null}];
    const targets=new Map([['page',{type:'page',enabled:true}]]);
    const event=(method,o)=>({method,sessionId:'page',params:{requestId:'r',...o}});
    const request=event('Network.requestWillBeSent',{request:{url,method:'GET'}});
    const response=event('Network.responseReceived',{response:{url,status:200,headers:{'X-Ricebox-Receipt':id}}});
    const end=event('Network.loadingFinished',{encodedDataLength:128});
    const run=events=>buildReceipt({phase:'first',events,targets,origin,scope:()=> 'bootstrap',isAllowedWorker:x=>x===url});
    assert.equal(run([request,response,end]).pass,true);
    const gap=run([request]);
    assert.equal(gap.pass,false);assert.equal(gap.payloadBodyBytes,null);
    for(const code of ['cdp-response-status-missing','cdp-loading-finished-missing','worker-script-cdp-lifecycle-incomplete',
      'worker-script-origin-cdp-response-missing'])assert(gap.coverageCodes.includes(code));
  }finally{rmSync(d,{recursive:true,force:true})}
});

test('instrumented receipt reports the actual failed stage, with no synthetic browser accepted',()=>{
  const d=setup();
  try{
    const env={...process.env};
    // Keep production acceptance files untouched; swap dependencies only within this temp control.
    writeFileSync(join(d,'routes.mjs'),`
      export const isDisplay=()=>false;
      export const diagnosticPlan=()=>{};
      export const stagedPlan=async(_stage,profile)=>{
        if(process.env.RX_CONTROL==='origin-plan')throw Error('private origin cause');
        return {profile,origins:[],sameReleaseDigest:'${pin}',url:'http://localhost/demo/'};
      };`);
    writeFileSync(join(d,'capture.mjs'),`
      export const launchIsolatedChrome=async()=>{
        if(process.env.RX_CONTROL==='browser-launch')throw Error('private launch cause');
        return {version:{product:'Chrome/123.4.5.6'},close:async()=>{}};
      };
      export const armCapture=async()=>({
        events:[],close:async()=>{},
        call:async method=>{if(method==='Page.navigate'&&process.env.RX_CONTROL==='http-navigation')return {errorText:'private HTTP cause'};return {};},
        evaluate:async expr=>{
          if(expr.includes("p==='prompt'"))return {stage:'prompt',focus:'host-focus'};
          if(expr.includes("const old="))return {marker:false,cleanExit:true};
          return '';
        },
      });`);
    writeFileSync(join(d,'sandbox-same-process.mjs'),`
      export const verifySandbox=async()=>{
        if(process.env.RX_CONTROL==='sandbox-proof')throw Error('private sandbox cause');
        return ${JSON.stringify(sandbox)};
      };`);
    for(const [stage,phase] of [['origin-plan',null],['browser-launch',null],['sandbox-proof',null],
      ['http-navigation','first'],['shell-witness','first']]){
      const done=spawnSync(process.execPath,[join(d,'run-receipt.mjs'),'staged','/fake/chrome',d,profile],
        {cwd:d,encoding:'utf8',env:{...env,RX_CONTROL:stage}});
      assert.equal(done.status,1,done.stdout+done.stderr);
      const r=JSON.parse(done.stdout);
      assert.deepEqual(r.diagnosticFailure,{stage,phase});
      assert.equal(r.pass,false);assert.deepEqual(r.phases,[]);
      assert(diagnosticMarkers(classifyBrowserDiagnostic(r,'nonzero',profile,null)).includes('run='+(phase?phase+':':'')+stage));
    }
  }finally{rmSync(d,{recursive:true,force:true})}
});

test('parent requires explicit null producer failure fields; never admits bytes from a failed run',()=>{
  for(const field of ['diagnosticFailure','runError']){
    for(const value of ['',false,0,null,undefined,{stage:'browser-close',phase:null}]){
      if(value===null)continue; // Sole explicitly clean value.
      const r=good();r[field]=value;
      assert.throws(()=>checkBrowserResult(r,profile,pin),/BROWSER_RUN_FAILED/);
    }
    const r=good();delete r[field];
    assert.throws(()=>checkBrowserResult(r,profile,pin),/BROWSER_RUN_FAILED/);
  }
  const r=good();r.pass=false;
  r.phases[1].coverageComplete=false;r.phases[1].pass=false;r.phases[1].payloadBodyBytes=null;
  assert.equal(checkBrowserResult(r,profile,pin).status,'incomplete');
  r.phases[0].phase='revisit';r.phases[0].pass=true;
  const markers=diagnosticMarkers(classifyBrowserDiagnostic(r,'nonzero',profile,null));
  assert(markers.includes('phase=revisit:invalid'));
  assert(!markers.includes('phase=revisit:recorded'));
});

test('after two green phases, any cleanup throw holds output and exit status',async()=>{
  const d=setup();
  try{
    writeFileSync(join(d,'routes.mjs'),`
      export const isDisplay=()=>false;
      export const diagnosticPlan=()=>{};
      export const stagedPlan=async(_stage,profile)=>{
        const url='http://127.0.0.1:42/demo/fixture.bin';
        const rows=[{phase:'first',id:'body',url,completed:true,status:200,bytes:17,method:'GET',
          range:null,contentRange:null,encoding:null}];
        const origin={rows,setPhase(){},close:async()=>{if(process.env.RX_CONTROL==='origin-empty')throw '';}};
        return {profile,origins:[origin],sameReleaseDigest:'${pin}',url,scope:()=> 'root',
          isAllowedWorker:()=>false,requireWorkers:[],requireAssets:[url]};
      };`);
    writeFileSync(join(d,'capture.mjs'),`
      let n=0;
      const ctrl=process.env.RX_CONTROL;
      const failures={empty:'',zero:0,negativeZero:-0,emptyArray:[],noValue:undefined,nullValue:null,
        falseValue:false,nan:NaN,unprintable:{toString(){throw Error('private conversion failure');}}};
      export const launchIsolatedChrome=async()=>({
        version:{product:'Chrome/123.4.5.6'},
        close:async()=>{if(Object.hasOwn(failures,ctrl))throw failures[ctrl]},
      });
      export const armCapture=async()=>{
        const first=n++===0;
        const url='http://127.0.0.1:42/demo/fixture.bin';
        const event=(method,params)=>({method,sessionId:'page',params:{requestId:'r',...params}});
        return {
          events:first?[
            event('Network.requestWillBeSent',{request:{url,method:'GET'}}),
            event('Network.responseReceived',{response:{url,status:200,headers:{'x-ricebox-receipt':'body'}}}),
            event('Network.loadingFinished',{encodedDataLength:521})]:[],
          targets:new Map([['page',{type:'page',enabled:true}]]),errors:[],drain:async()=>{},
          close:async()=>{if(!first&&ctrl==='target-empty')throw '';},
          call:async()=>({}),
          evaluate:async expr=>{
            if(expr.includes("p==='prompt'"))return {stage:'prompt',focus:'host-focus'};
            if(expr.includes('const old='))return {marker:true,cleanExit:true};
            if(expr.includes('performance.getEntriesByType'))return {nav:['navigate'],resourceTiming:[]};
            return '';
          },
        };
      };`);
    writeFileSync(join(d,'sandbox-same-process.mjs'),`export const verifySandbox=async()=>(${JSON.stringify(sandbox)});`);
    const cases=[['clean',null,null],['empty','browser-close',null],['zero','browser-close',null],
      ['negativeZero','browser-close',null],['emptyArray','browser-close',null],['noValue','browser-close',null],
      ['nullValue','browser-close',null],['falseValue','browser-close',null],['nan','browser-close',null],
      ['unprintable','browser-close',null],['origin-empty','origin-close',null],['target-empty','target-close','revisit']];
    const observations=await Promise.all(cases.map(([control,stage,phase])=>new Promise((resolve,reject)=>{
      execFile(process.execPath,[join(d,'run-receipt.mjs'),'staged','/fake/chrome',d,profile],{
        cwd:d,env:{...process.env,RX_CONTROL:control},timeout:25_000,
      },(error,stdout,stderr)=>{
        try{
          assert(stdout,control+":"+String(error)+" "+stderr);
          const r=JSON.parse(stdout);
          assert(r.phases.length===2&&r.phases.every(x=>x.pass&&x.coverageComplete),control);
          assert.deepEqual(r.phases.map(x=>x.payloadBodyBytes),[17,0],control);
          if(stage===null){
            assert.equal(error,null,stderr);assert.equal(r.pass,true);assert.equal(r.diagnosticFailure,null);
            assert.equal(checkBrowserResult(r,profile,pin).status,'pass');
          }else{
            assert.equal(error?.code,1,stderr+control);
            assert.equal(r.pass,false,control);
            assert.deepEqual(r.diagnosticFailure,{stage,phase},control);
            assert.throws(()=>checkBrowserResult(r,profile,pin),/BROWSER_RUN_FAILED/);
            const markers=diagnosticMarkers(classifyBrowserDiagnostic(r,'nonzero',profile,'BROWSER_RUN_FAILED'));
            assert(markers.includes('run='+(phase?phase+':':'')+stage));
            assert(markers.includes('wrapper=BROWSER_RUN_FAILED'));
            if(control==='empty'||control==='emptyArray')assert.equal(r.runError,'',control);
            if(control==='unprintable')assert.equal(r.runError,'Unprintable browser exception',control);
          }
          resolve(control);
        }catch(failure){reject(failure)}
      });
    })));
    assert.equal(observations.length,cases.length);
  }finally{rmSync(d,{recursive:true,force:true})}
});
