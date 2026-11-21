// Never write raw browser records, tokens/provenance, paths or guest stdout to Actions.
import {readFileSync} from 'node:fs';
const ids=['local-revalidate','local-immutable'];
const statuses=new Set(['pass','fail','blocked','incomplete','not_accepted','not_run']);
const number=n=>Number.isSafeInteger(n)&&n>=0&&n<1e10;
try{
  const r=JSON.parse(readFileSync(process.argv[2],'utf8'));
  if(r.schema!=='ricebox-static-browser-admission-v1'||r.revision!=='28c45a65649b1058da0ad5077624e8fd4fa3cee9'||
     r.scope!=='exact-package-shell-only-loopback-demo')throw Error('WRONG_SUMMARY');
  console.log('RX_EVERYDAY_PROFILE published-busybox-current-config-v1');
  for(const p of ids){
    const v=r.browserRuns?.[p];
    console.log('RX_EVERYDAY_SHELL '+p+' '+(statuses.has(v?.status)?v.status:'not_run'));
    if(number(v?.cold)&&number(v?.revisit))
        console.log('RX_EVERYDAY_SHELL_BODIES '+p+' cold='+v.cold+' revisit='+v.revisit);
  }
  console.log('RX_EVERYDAY_DISPLAY not_run');
  if(!ids.every(x=>r.browserRuns?.[x]?.status==='pass'&&number(r.browserRuns[x].cold)&&
       r.browserRuns[x].cold>0&&r.browserRuns[x].revisit===0))process.exitCode=2;
}catch{
  console.log('RX_EVERYDAY_SUMMARY unavailable');
  process.exitCode=2;
}
