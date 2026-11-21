import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {get} from 'node:http';
import {join} from 'node:path';
import {probeNestedSite} from './probe-site.mjs';
import {stagedPlan} from './routes.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
export async function checkRange(url,slice,start,end,total) {
  const u=new URL(url);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.search||u.hash||
     !/^\/demo\/ricebox\/packs\/[a-f0-9]{64}\.pack$/.test(u.pathname))throw Error('CANARY_NOT_A_CANONICAL_LOOPBACK_ROUTE');
  return new Promise((resolve,reject)=>{
    const request=get(u,{headers:{range:'bytes='+start+'-'+end,'accept-encoding':'identity'}},r=>{
      r.on('error',reject);
      if(r.statusCode!==206||r.headers['content-range']!=='bytes '+start+'-'+end+'/'+total||
         ![undefined,'identity'].includes(r.headers['content-encoding'])||
         r.headers['content-length']!==String(slice.length)){
        r.destroy();
        reject(Error('MISSING_EXACT_PARTIAL_RESPONSE'));
        return;
      }
      const chunks=[];let received=0;
      r.on('data',b=>{
        received+=b.length;
        if(received>slice.length){r.destroy();reject(Error('PARTIAL_BODY_MISMATCH'))}
        else chunks.push(b);
      });
      r.on('end',()=>{
        const bytes=Buffer.concat(chunks);
        if(received!==slice.length||!bytes.equals(slice)){reject(Error('PARTIAL_BODY_MISMATCH'));return;}
        resolve({status:r.statusCode,bytes:received,sha256:sha(bytes)});
      });
    });
    request.on('error',reject);
    request.setTimeout(10_000,()=>request.destroy(Error('PARTIAL_RESPONSE_TIMEOUT')));
  });
}
if(import.meta.main) {
  const [site,installedManifest]=process.argv.slice(2);
  const plan=await stagedPlan(site,'local-revalidate');
  try {
    const modules=await probeNestedSite(plan.url,JSON.parse(await readFile(installedManifest,'utf8')));
    const root=join(site,'demo','ricebox');
    const about=JSON.parse(await readFile(join(root,'webroot.json'),'utf8'));
    const index=JSON.parse(await readFile(join(root,about.index.path),'utf8'));
    const entry=index.files.find(e=>e.path==='/usr/bin/busybox'&&e.len>0);
    if(!entry)throw Error('NO_BUSYBOX_RANGE_CANARY');
    const record=index.packs[entry.pack];
    const pack=await readFile(join(root,'packs',record.name));
    if(pack.length!==record.bytes||!Number.isSafeInteger(entry.at)||entry.at<0||
      !Number.isSafeInteger(entry.len)||entry.at+entry.len>pack.length)throw Error('INVALID_CANARY_BOUNDS');
    const start=entry.at,end=Math.min(start+4095,start+entry.len-1);
    if(end-start+1>=pack.length)throw Error('CANARY_NOT_PROPER_SUBRANGE');
    const payload=await checkRange(new URL('ricebox/packs/'+record.name,plan.url),pack.subarray(start,end+1),start,end,pack.length);
    const missing=await fetch(new URL('/ricebox/webroot.json',plan.url),{redirect:'error',signal:AbortSignal.timeout(10_000)});
    await missing.body?.cancel();
    if(missing.status!==404)throw Error('ROOT_PREFIX_ALIAS_EXPOSED');
    console.log(JSON.stringify({status:'pass',scope:'non-browser-loopback-static-origin',modules:modules.modules,
      display:modules.display,packRange:payload,rootPrefixStatus:404}));
  }finally {for(const origin of plan.origins)await origin.close()}
}
