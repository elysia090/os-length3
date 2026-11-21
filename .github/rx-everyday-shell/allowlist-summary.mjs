// Never write raw browser records, tokens/provenance, paths or guest stdout to Actions.
import {readFileSync} from 'node:fs';
import {diagnosticMarkers,hasAdmissibleBrowserDiagnostic} from '../../ricebox/everyday/test/wayland/static-acceptance/run-static-acceptance.mjs';
const ids=['local-revalidate','local-immutable'];
const statuses=new Set(['pass','fail','blocked','incomplete','not_accepted','not_run']);
const number=n=>Number.isSafeInteger(n)&&n>=0&&n<1e10;
const admissible=v=>hasAdmissibleBrowserDiagnostic(v?.diagnostic,v?.status)&&number(v?.cold)&&number(v?.revisit);
const admittedPass=v=>v?.status==='pass'&&admissible(v)&&v.cold>0&&v.revisit===0;
try{
  const r=JSON.parse(readFileSync(process.argv[2],'utf8'));
  if(r.schema!=='ricebox-static-browser-admission-v1'||r.revision!=='28c45a65649b1058da0ad5077624e8fd4fa3cee9'||
     r.scope!=='exact-package-shell-only-loopback-demo')throw Error('WRONG_SUMMARY');
  console.log('RX_EVERYDAY_PROFILE published-busybox-current-config-v1');
  const stages=new Set(['report','chrome-owner','checkout','approved-root','harness','installed-exact-package',
    'staging','origin-route-and-range','stock-browser','complete']);
  const wrapperStatuses=new Set(['pass','blocked']);
  const clean=r.stage==='complete'&&r.status==='pass'&&ids.every(x=>admittedPass(r.browserRuns?.[x]));
  if(stages.has(r.stage)&&wrapperStatuses.has(r.status))
    console.log('RX_EVERYDAY_SHELL_PARENT stage='+r.stage+' status='+(clean?'pass':'blocked'));
  for(const p of ids){
    const v=r.browserRuns?.[p];
    const verdict=!statuses.has(v?.status)?'not_run':v.status==='pass'&&!admittedPass(v)?'not_accepted':v.status;
    console.log('RX_EVERYDAY_SHELL '+p+' '+verdict);
    for(const marker of diagnosticMarkers(v?.diagnostic))console.log('RX_EVERYDAY_SHELL_DIAG '+p+' '+marker);
    if(admissible(v))
        console.log('RX_EVERYDAY_SHELL_BODIES '+p+' cold='+v.cold+' revisit='+v.revisit);
  }
  console.log('RX_EVERYDAY_DISPLAY not_run');
  if(!clean)process.exitCode=2;
}catch{
  console.log('RX_EVERYDAY_SUMMARY unavailable');
  process.exitCode=2;
}
