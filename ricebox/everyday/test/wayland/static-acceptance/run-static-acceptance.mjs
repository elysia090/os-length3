#!/usr/bin/env node
// Integration/admission only: run the previously reviewed stager and browser receipt, not a second browser harness.
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {accessSync, constants, copyFileSync, createReadStream, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REV='28c45a65649b1058da0ad5077624e8fd4fa3cee9';
const CHROME='/opt/google/chrome/chrome';
const STOCK='ricebox/everyday/test/wayland/browser/stock-chrome.ts';
const STOCK_BLOB='6db7dd3f7583c3aa695a37ce0cb86d7068b80dbf';
const STAGER='ricebox-static-shell-acceptance-f0748b1';
const RECEIPTS='ricebox-transfer-receipt-f0748b1';
const FRESH='ricebox-staged-shell-fresh-witness-28c45a6';
const HASH='^[0-9a-f]{64}$';
const expected={
  [STAGER]:{
    'stage.mjs':'a34b312b45cfc67019206e719d8b83d981f6ed264273139973a75aaaf7fc643a',
    'demo.mjs':'7645de89a1fd2d5fa86d9ba926f47fb8f809adb208070afb9474ee7c36e8a48f',
    'launch.mjs':'e046060be52f7ec472aa5e330f436962404ad8c51881e5fad34f23ca94a779cd',
    'index.html':'9fb79830455adf030a3259565b01862f954d73863f11517310bfe27a6fe13c64',
    'probe-site.mjs':'72d3b546d0e49dee32d87e2a644eb5c38674197015c92d809363a423855802b7',
  },
  [RECEIPTS]:{
    'run-receipt.mjs':'33f94341c345bc5fda9c40ea04f0c63b58b9f1b83389157c35f159bbc06c334a',
    'capture.mjs':'78eaee010b2ff951c163984f258b8574ca255a9710a327db1b13f2f5c5c9c42f',
    'origin.mjs':'51b2ab15ced4d52b13a94d26e5b89c73766199eba71638308f030085bb92ff18',
    'receipt.mjs':'a370202f12b2196787f98dfff5c0dc41fd87a265e483780fadf97134bb2b9ef0',
    'routes.mjs':'beabfc4d3095d101a0be9ceec62ed90accaeba58a5702dbb4d0aca76f22ad8dd',
  },
  [FRESH]:{
    'run-receipt-fresh-witness.patch':'0bc1fb42ef313feab8f21127224af167e1281c9971ae16c66be9632b0169dd4c',
  },
};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const need=(ok,code)=>{if(!ok)throw Error(code)};
const issha=s=>typeof s==='string'&&new RegExp(HASH).test(s);
const textMemo=s=>typeof s==='string'&&s.trim()===s&&s.length>=8&&s.length<=1024&&!/[\u0000-\u001f\u007f]/.test(s)&&!/REPLACE[_ -]+WITH(?:$|[_ -])/i.test(s);

export function checkManifest(value) {
  need(value?.schema==='ricebox-static-root-approval-v1'&&value.revision===REV,'WRONG_APPROVED_REVISION');
  need(['archive','busybox','muk','translator','webroot'].every(k=>issha(value.sha256?.[k]))&&
    Object.keys(value.sha256).length===5,'MISSING_OR_AMBIGUOUS_APPROVED_DIGEST');
  need(['root','busybox','muk','translator'].every(k=>textMemo(value.provenance?.[k])),
    'MISSING_INDEPENDENT_PROVENANCE');
  return value;
}
export function checkOwner(version,owner,executable) {
  need(executable===CHROME,'STOCK_CHROME_MISSING');
  need(/^install ok installed [0-9][a-z0-9.+:~\-]+$/i.test(version),'STOCK_CHROME_PACKAGE_NOT_INSTALLED');
  need(owner==='google-chrome-stable: '+CHROME,'STOCK_CHROME_OWNER_MISMATCH');
  return version.slice('install ok installed '.length);
}
export function checkBrowserResult(receipt,profile,pin) {
  need(receipt?.profile===profile&&receipt.sameReleaseDigest===pin,'BROWSER_RECEIPT_WRONG_RELEASE');
  const pages=receipt.phases;
  need(/^(?:Headless)?Chrome\/[0-9.]+$/.test(receipt.browser?.product??'')&&receipt.sandbox?.seccomp==='Yes'&&
    receipt.sandbox?.pid==='Yes'&&receipt.sandbox?.network==='Yes'&&
    ['Namespace','SUID'].includes(receipt.sandbox?.layer),'BROWSER_SANDBOX_UNPROVEN');
  need(Array.isArray(pages)&&pages.map(p=>p?.phase).join(',')==='first,revisit','BROWSER_PHASES_UNPROVEN');
  need(typeof receipt.pass==='boolean'&&pages.every(p=>typeof p.pass==='boolean'&&typeof p.coverageComplete==='boolean'),
    'BROWSER_RECEIPT_FLAGS_INVALID');
  need(pages.every(p=>p.observations?.stage==='prompt'&&
    p.observations?.focus==='host-focus'&&p.observations?.marker===true&&p.observations?.cleanExit===true&&
    /^RICEBOX-BOOT:[0-9]+$/.test(p.observations?.expectedMarker??'')),'BROWSER_GUEST_PROOF_MISSING');
  need(pages[0].observations.expectedMarker!==pages[1].observations.expectedMarker,'BROWSER_CHALLENGE_REUSED');
  const payload=p=>p.coverageComplete===true&&Number.isSafeInteger(p.payloadBodyBytes)&&p.payloadBodyBytes>=0?p.payloadBodyBytes:null;
  const cold=payload(pages[0]),revisit=payload(pages[1]);
  const pass=receipt.pass===true&&pages.every(p=>p.pass===true)&&cold>0&&revisit===0;
  return {status:pass?'pass':cold===null||revisit===null?'incomplete':'fail',chrome:receipt.browser.product,cold,revisit};
}
const cmd=(bin,args,opts={})=>execFileSync(bin,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10_000,...opts}).trim();
async function localSockets() {
  const dir=mkdtempSync(join(tmpdir(),'rx-probe-'));
  const tryOpen=opts=>new Promise(resolve=>{
    const s=createServer();
    s.once('error',e=>resolve(e.code??'ERROR'));
    s.listen(opts,()=>s.close(()=>resolve('ok')));
  });
  try {
    return {unix:await tryOpen({path:join(dir,'s')}),ipv4:await tryOpen({host:'127.0.0.1',port:0})};
  }finally{rmSync(dir,{force:true,recursive:true})}
}
function chrome() {
  accessSync(CHROME,constants.X_OK);
  const path=realpathSync(CHROME);
  return checkOwner(cmd('dpkg-query',['-W','-f=${Status} ${Version}','google-chrome-stable']),
    cmd('dpkg-query',['-S',CHROME]),path);
}
function copyVerified(folders,suite) {
  for(const [dir,files] of Object.entries(expected)) {
    for(const [name,hash] of Object.entries(files)) {
      const bytes=readFileSync(join(folders,dir,name));
      need(sha(bytes)===hash,'HARNESS_INTEGRITY_FAILURE');
      writeFileSync(join(suite,name),bytes,{flag:'wx'});
    }
  }
}
const digest=async path=>{
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
};

if(import.meta.main) {
  process.umask(0o077);
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--doctor') {
    let status='ready',code=null,version=null;
    try {version=chrome()} catch(error) {status='blocked';code=error.code==='ENOENT'?'STOCK_CHROME_MISSING':'STOCK_CHROME_PROVENANCE_FAILED'}
    const sockets=await localSockets();
    if(status==='ready'&&(sockets.unix!=='ok'||sockets.ipv4!=='ok')){status='blocked';code='REQUIRED_SOCKET_UNAVAILABLE'}
    console.log(JSON.stringify({schema:'ricebox-static-browser-doctor-v1',status,code,version,sockets,
      navigation:'not_run',node:process.version}));
    process.exitCode=status==='ready'?0:2;
  } else if([5,6].includes(args.length)) {
    const [checkout,prepared,approval,parents,report,muslPresenter]=args.map(x=>resolve(x));
    const summary={schema:'ricebox-static-browser-admission-v1',revision:REV,scope:muslPresenter?'exact-package-loopback-demo-shell-and-musl-control':'exact-package-shell-only-loopback-demo',
      status:'blocked',stage:'report',browserRuns:{},notCovered:['actual deployed host','Quickshell','Wayland keyboard','guest app scrolling','guest input-to-frame timing','latency benchmark']};
    let work,safeReport=false;
    const run=(name,bin,argv,{cwd=work,timeout=120_000,env=process.env}={})=>{
      const stdout=openSync(join(report,name+'.stdout'),'wx',0o600);
      const stderr=openSync(join(report,name+'.stderr'),'wx',0o600);
      try {
        const r=spawnSync(bin,argv,{cwd,timeout,env,stdio:['ignore',stdout,stderr]});
        return {status:r.status,ok:!r.error&&r.status===0};
      } finally {closeSync(stdout);closeSync(stderr)}
    };
    try {
      mkdirSync(report,{mode:0o700}); safeReport=true;
      summary.stage='chrome-owner';
      summary.chromePackage=chrome();
      const sockets=await localSockets();
      need(sockets.unix==='ok'&&sockets.ipv4==='ok','REQUIRED_SOCKET_UNAVAILABLE');
      summary.stage='checkout';
      need(process.versions.node.startsWith('24.'),'NODE_24_REQUIRED');
      need(cmd('git',['-C',checkout,'rev-parse','HEAD'])===REV&&
        !cmd('git',['-C',checkout,'status','--porcelain','--untracked-files=no']),'DIRTY_OR_WRONG_CHECKOUT');
      const stock=readFileSync(join(checkout,STOCK));
      need(createHash('sha1').update('blob '+stock.length+'\0').update(stock).digest('hex')===STOCK_BLOB,
        'STOCK_SANDBOX_POLICY_MISMATCH');
      summary.stage='approved-root';
      const approved=checkManifest(json(approval));
      const rootAbout=readFileSync(join(prepared,'webroot.json'));
      need(sha(rootAbout)===approved.sha256.webroot&&JSON.parse(rootAbout).sha256===approved.sha256.archive,
        'PREPARED_ROOT_NOT_APPROVED');
      summary.approved={sha256:approved.sha256,provenance:approved.provenance};
      summary.stage='harness';
      work=mkdtempSync(join(tmpdir(),'ricebox-static-acceptance-'));
      const consumer=join(work,'consumer'), site=join(work,'site');
      mkdirSync(consumer,{mode:0o700});
      copyVerified(parents,consumer);
      writeFileSync(join(consumer,'stock-chrome.ts'),stock,{flag:'wx'});
      need(run('apply-witness','git',['apply','--check','run-receipt-fresh-witness.patch'],{cwd:consumer}).ok,'FRESH_WITNESS_PATCH_INVALID');
      need(run('patch-witness','git',['apply','run-receipt-fresh-witness.patch'],{cwd:consumer}).ok,'FRESH_WITNESS_PATCH_FAILED');
      // Gate the exact CDP process used for acceptance before it sees any /demo/ URL.
      const original=readFileSync(join(consumer,'run-receipt.mjs'),'utf8');
      const needle='  result.browser=browser.version;';
      need(original.split(needle).length===2,'SANDBOX_HOOK_ANCHOR_MISMATCH');
      writeFileSync(join(consumer,'sandbox-same-process.mjs'),readFileSync(fileURLToPath(new URL('./sandbox-same-process.mjs',import.meta.url))),{flag:'wx'});
      writeFileSync(join(consumer,'run-receipt.mjs'),"import { verifySandbox } from './sandbox-same-process.mjs';\n"+original.replace(needle,
        needle+"\n  if(mode==='staged') result.sandbox=await verifySandbox(browser);"));
      copyFileSync(fileURLToPath(new URL('./probe-staged.mjs',import.meta.url)),join(consumer,'probe-staged.mjs'));
      summary.stage='installed-exact-package';
      const node=process.execPath, packageOut=join(work,'npmpackage');
      const cacheFlag='--cache='+join(work,'npm-cache');
      need(run('package-build',node,['ricebox/distribution/build/npm.ts',packageOut],{cwd:checkout}).ok,'EXACT_PACKAGE_BUILD_FAILED');
      need(run('package-pack','npm',['pack','--ignore-scripts','--offline',cacheFlag],{cwd:packageOut}).ok,'PACKAGE_TARBALL_FAILED');
      const archives=readdirSync(packageOut).filter(f=>/^ricebox-[0-9.]+\.tgz$/.test(f));
      need(archives.length===1,'PACKAGE_TARBALL_AMBIGUOUS');
      const archive=join(packageOut,archives[0]);
      summary.npmTarballSha256=await digest(archive);
      writeFileSync(join(consumer,'package.json'),'{"name":"ricebox-acceptance-local","private":true,"type":"module"}\n',{flag:'wx'});
      need(run('package-install','npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--no-package-lock',cacheFlag,archive],{cwd:consumer}).ok,'PACKAGE_OFFLINE_INSTALL_FAILED');
      const browserManifest=join(consumer,'node_modules/ricebox/ricebox/distribution/deployment/browser-modules.json');
      need(lstatSync(browserManifest).isFile(),'INSTALLED_PACKAGE_BROWSER_MANIFEST_MISSING');
      summary.stage='staging';
      const pins=join(work,'pins.json');
      const {archive:_,...four}=approved.sha256;
      writeFileSync(pins,JSON.stringify(four),{flag:'wx'});
      need(run('stage',node,['stage.mjs',prepared,pins,site],{cwd:consumer}).ok,'APPROVED_STAGE_FAILED');
      summary.stage='origin-route-and-range';
      need(run('origin-probe',node,['--experimental-vm-modules','probe-staged.mjs',site,browserManifest],{cwd:consumer}).ok,'STAGED_ORIGIN_PROBE_FAILED');
      summary.stage='stock-browser';
      let failed=false;
      for(const profile of ['local-revalidate','local-immutable']) {
        const r=run(profile,node,['run-receipt.mjs','staged',CHROME,site,profile],{cwd:consumer,timeout:180_000});
        try {
          const receipt=json(join(report,profile+'.stdout'));
          const measured=checkBrowserResult(receipt,profile,approved.sha256.webroot);
          if(!r.ok&&measured.status==='pass')measured.status='not_accepted';
          summary.browserRuns[profile]=measured;
          if(measured.status!=='pass')failed=true;
        } catch(error) { summary.browserRuns[profile]={status:'not_accepted',reason:/^[A-Z0-9_]+$/.test(error.message)?error.message:'BROWSER_RECEIPT_MISSING_OR_INVALID'};failed=true; }
      }
      if(muslPresenter){
        summary.stage='musl-wayland-display';
        for(const helper of ['stage-display.mjs','run-display.mjs','display-page.mjs','wayland-contract.mjs','presenter-pin.mjs']){
          copyFileSync(fileURLToPath(new URL('./'+helper,import.meta.url)),join(consumer,helper));
        }
        const r=run('display-stage',node,['stage-display.mjs',checkout,site,muslPresenter],{cwd:consumer});
        let status=r.ok?'not_run':'blocked';
        if(r.ok){
          const r=run('display-stock-chrome',node,['run-display.mjs',CHROME,site],{cwd:consumer,timeout:240_000});
          try{
            const verdict=json(join(report,'display-stock-chrome.stdout'));
            status=r.ok&&verdict?.pass===true&&verdict.scope==='static-musl-c-wayland-fallback'?'pass':'fail';
          }catch{status='incomplete'}
        }
        summary.displayFallback={status,scope:'static-musl-c-wayland-only'};
        if(status!=='pass')failed=true;
      }
      need(!failed,'STOCK_CHROME_ACCEPTANCE_NOT_COMPLETE');
      summary.stage='complete';
      summary.status='pass';
    } catch(error) {
      summary.reason=typeof error.message==='string'&&/^[A-Z0-9_]+$/.test(error.message)?error.message:
        (summary.stage==='chrome-owner'?'STOCK_CHROME_NOT_AVAILABLE_OR_UNVERIFIED':'STEP_FAILED');
    } finally {
      if(work)rmSync(work,{recursive:true,force:true});
      if(safeReport)writeFileSync(join(report,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});
      const {approved:_,npmTarballSha256:__,...bounded}=summary;
      console.log(JSON.stringify(bounded));
    }
    process.exitCode=summary.status==='pass'?0:2;
  } else {
    console.error('Usage: node run-static-acceptance.mjs CHECKOUT PREPARED_ROOT APPROVED_ROOT.json SEALED_PARENT_ROOT NEW_REPORT_DIR [PINNED_MUSL_PRESENTER]\n       node run-static-acceptance.mjs --doctor');
    process.exitCode=2;
  }
}
