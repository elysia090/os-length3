import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkManifest,checkOwner,checkBrowserResult} from './run-static-acceptance.mjs';
const REV='28c45a65649b1058da0ad5077624e8fd4fa3cee9';
const chrome='/opt/google/chrome/chrome',profile='local-revalidate',pin='a'.repeat(64);
const components=['root','busybox','translator','muk'];
const sample=()=>({
  schema:'ricebox-static-root-approval-v1',revision:REV,
  sha256:{archive:pin,busybox:pin,translator:pin,muk:pin,webroot:pin},
  provenance:Object.fromEntries(components.map(c=>[c,'Synthetic test statement for '+c])),
});
const good=()=>({
  profile,sameReleaseDigest:pin,pass:true,runError:null,diagnosticFailure:null,browser:{product:'Chrome/156.0.1.3'},
  sandbox:{layer:'Namespace',pid:'Yes',network:'Yes',seccomp:'Yes'},
  phases:['first','revisit'].map((phase,i)=>({phase,pass:true,payloadBodyBytes:i===0?404:0,coverageComplete:true,
    observations:{stage:'prompt',focus:'host-focus',marker:true,cleanExit:true,expectedMarker:'RICEBOX-BOOT:'+(41+i)}})),
});
test('approved manifest requires revision, every distinct pin key and provenance',()=>{
  assert.equal(checkManifest(sample()).revision,REV);
  for(const [mutate,reason] of [
    [s=>s.revision='main',/WRONG_APPROVED_REVISION/],
    [s=>delete s.sha256.busybox,/MISSING_OR_AMBIGUOUS_APPROVED_DIGEST/],
    [s=>s.sha256.extra=pin,/MISSING_OR_AMBIGUOUS_APPROVED_DIGEST/],
    [s=>s.sha256.webroot='0',/MISSING_OR_AMBIGUOUS_APPROVED_DIGEST/],
    [s=>s.provenance.busybox='\u0000not approved',/MISSING_INDEPENDENT_PROVENANCE/],
    [s=>delete s.provenance.root,/MISSING_INDEPENDENT_PROVENANCE/],
  ]) {const x=sample();mutate(x);assert.throws(()=>checkManifest(x),reason)}
});
test('real-format digest fields cannot legitimize unchanged example provenance',()=>{
  const entire=sample();
  for(const key of components)entire.provenance[key]='REPLACE_WITH_VERIFIED_'+key.toUpperCase()+'_RECEIPT';
  assert.throws(()=>checkManifest(entire),/MISSING_INDEPENDENT_PROVENANCE/);
  for(const key of components)for(const text of ['REPLACE_WITH_PINNED_RECEIPT','replace with approved provenance','Custody: REPLACE_WITH_PROOF']){
    const x=sample();x.provenance[key]=text;
    assert.throws(()=>checkManifest(x),/MISSING_INDEPENDENT_PROVENANCE/);
  }
});
test('runner owner rejects distro Chromium, missing dpkg and owner mismatch',()=>{
  assert.equal(checkOwner('install ok installed 156.0.1.3-1','google-chrome-stable: '+chrome,chrome),'156.0.1.3-1');
  assert.throws(()=>checkOwner('install ok installed 156.0.1.3-1','chromium: /usr/bin/chromium','/usr/bin/chromium'),/STOCK_CHROME_MISSING/);
  assert.throws(()=>checkOwner('not installed','google-chrome-stable: '+chrome,chrome),/STOCK_CHROME_PACKAGE_NOT_INSTALLED/);
  assert.throws(()=>checkOwner('install ok installed 156.0.1.3-1','chromium: '+chrome,chrome),/STOCK_CHROME_OWNER_MISMATCH/);
});
test('two complete matching witnesses are mandatory; revisit miss is measured failure',()=>{
  assert.deepEqual(checkBrowserResult(good(),profile,pin),{status:'pass',chrome:'Chrome/156.0.1.3',cold:404,revisit:0});
  for(const [mutate,reason] of [
    [s=>s.profile='global',/BROWSER_RECEIPT_WRONG_RELEASE/],
    [s=>s.sameReleaseDigest='b'.repeat(64),/BROWSER_RECEIPT_WRONG_RELEASE/],
    [s=>s.browser.product='Chromium/156.0.1.3',/BROWSER_SANDBOX_UNPROVEN/],
    [s=>s.sandbox.network='No',/BROWSER_SANDBOX_UNPROVEN/],
    [s=>s.phases.pop(),/BROWSER_PHASES_UNPROVEN/],
    [s=>s.phases.reverse(),/BROWSER_PHASES_UNPROVEN/],
    [s=>s.phases[0].observations.focus='line',/BROWSER_GUEST_PROOF_MISSING/],
    [s=>s.phases[0].observations.cleanExit=false,/BROWSER_GUEST_PROOF_MISSING/],
    [s=>s.phases[1].observations.expectedMarker=s.phases[0].observations.expectedMarker,/BROWSER_CHALLENGE_REUSED/],
  ]) {const x=good();mutate(x);assert.throws(()=>checkBrowserResult(x,profile,pin),reason)}
  const miss=good();miss.pass=false;miss.phases[1].pass=false;miss.phases[1].payloadBodyBytes=8192;
  assert.deepEqual(checkBrowserResult(miss,profile,pin),{status:'fail',chrome:'Chrome/156.0.1.3',cold:404,revisit:8192});
  const missing=good();missing.pass=false;missing.phases[1].coverageComplete=false;
  assert.deepEqual(checkBrowserResult(missing,profile,pin),{status:'incomplete',chrome:'Chrome/156.0.1.3',cold:404,revisit:null});
});
test('acceptance flags are literal booleans, never inferred from truthiness',()=>{
  for (const fake of ['false','true',1,0,null,undefined,[],{}]){
    const top=good();top.pass=fake;
    assert.throws(()=>checkBrowserResult(top,profile,pin),/BROWSER_RECEIPT_FLAGS_INVALID/);
    for(const i of [0,1])for(const key of ['pass','coverageComplete']){
      const one=good();one.phases[i][key]=fake;
      assert.throws(()=>checkBrowserResult(one,profile,pin),/BROWSER_RECEIPT_FLAGS_INVALID/);
    }
  }
});
test('doctor never navigates and CLI refuses wrong argument count',()=>{
  const cli=fileURLToPath(new URL('./run-static-acceptance.mjs',import.meta.url));
  const out=spawnSync(process.execPath,[cli,'--doctor'],{encoding:'utf8'});
  assert.ok([0,2].includes(out.status));
  const doctor=JSON.parse(out.stdout);
  assert.equal(doctor.navigation,'not_run');
  assert.equal(out.status,doctor.status==='ready'?0:2);
  assert.equal(spawnSync(process.execPath,[cli,'--wrong'],{encoding:'utf8'}).status,2);
});
