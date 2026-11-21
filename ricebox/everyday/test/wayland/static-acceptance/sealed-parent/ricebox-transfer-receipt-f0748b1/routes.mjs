import {readdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {hash,immutable,revalidate,serveRoutes} from './origin.mjs';

export const isDisplay=url=>{
  const path=new URL(url).pathname;
  return /(?:^|\/)(?:everyday|display)(?:\/|[-.])/i.test(path);
};
const rootWorkerNames=['distribution/runtime/worker.js','distribution/runtime/check.worker.js',
  'distribution/runtime/translate.worker.js','sods/runtime/linux/cpu.js'];
const nice=/^[a-z0-9][a-z0-9_.-]*$/i;
const safeAsset=/^(?:index-[0-9a-f]{64}\.json|blobs\/[0-9a-f]{64}\.bin|packs\/[0-9a-f]{64}\.pack)$/;
const MIME={html:'text/html',mjs:'text/javascript',js:'text/javascript',json:'application/json'};
const noStore='no-store';
const mutableNames=['webroot.json','muk.json'];
const acceptRoot='/demo/ricebox/';

async function readSite(root) {
  const routes=new Map();
  async function walk(relative='') {
    for(const e of await readdir(join(root,relative),{withFileTypes:true})) {
      if(!nice.test(e.name)||(!e.isFile()&&!e.isDirectory())) throw Error('Unexpected stage entry: '+e.name);
      const path=relative?relative+'/'+e.name:e.name;
      if(e.isDirectory()) await walk(path);
      else {
        const route=path==='demo/index.html'?'/demo/':'/'+path;
        const body=await readFile(join(root,path));
        routes.set(route,{body,mime:MIME[e.name.split('.').pop()]??'application/octet-stream'});
      }
    }
  }
  await walk();
  return routes;
}

export async function stagedPlan(root,profile) {
  if(!['local-revalidate','local-immutable'].includes(profile)) {
    throw Error('Choose a controlled origin profile: local-revalidate or local-immutable');
  }
  const routes=await readSite(resolve(root));
  const classify=new Map();
  const add=(path,group)=>{
    const route=acceptRoot+path;
    if(!routes.has(route)||(!mutableNames.includes(path)&&!safeAsset.test(path))) {
      throw Error('Missing or unexpected staged artifact: '+path);
    }
    const old=classify.get(route);
    if(old&&old!==group) throw Error('Conflicting categories for '+route);
    classify.set(route,group);
  };
  const parse=path=>JSON.parse(routes.get(acceptRoot+path).body);
  for(const n of mutableNames) add(n,'manifest');
  const webroot=parse('webroot.json'), muk=parse('muk.json');
  add(webroot.index.path,'index');
  const index=parse(webroot.index.path);
  add(index.translator.path,'wasm'); add(muk.path,'root');
  for(const p of index.packs) add('packs/'+p.name,'root');
  for(const t of index.translations) {
    if(t.wasm?.path) add(t.wasm.path,'wasm');
    if(t.elf?.path) add(t.elf.path,'root');
  }
  for(const [path,asset] of routes) {
    if(path.startsWith(acceptRoot)&&!classify.has(path)) throw Error('Unclassified staged payload: '+path);
    if(!path.startsWith('/demo/')) throw Error('Stage escapes /demo/: '+path);
    // Pack filenames are not necessarily raw byte hashes. This private
    // process freezes the exact same route bytes for both navigations.
    asset.cacheControl=profile==='local-immutable'&&safeAsset.test(path.slice(acceptRoot.length))
      &&path.startsWith(acceptRoot)?immutable:revalidate;
    asset.ranges=path.endsWith('.pack');
  }
  const origin=await serveRoutes(routes);
  const base=origin.base;
  const allowed=new Set(rootWorkerNames.map(n=>base+'/demo/ricebox-js/'+n));
  return {origins:[origin],url:base+'/demo/',profile,sameReleaseDigest:hash(routes.get(acceptRoot+'webroot.json').body),
    scope:url=>{
      const u=new URL(url);
      if(u.origin!==base||u.search) return null;
      if(u.pathname==='/favicon.ico') return 'ignore';
      return classify.get(u.pathname)??(routes.has(u.pathname)?'bootstrap':null);
    },
    requireAssets:[...mutableNames,webroot.index.path,index.translator.path,muk.path].map(p=>base+acceptRoot+p),
    requireWorkers:[base+'/demo/ricebox-js/'+rootWorkerNames[0]],isAllowedWorker:url=>allowed.has(url),
    requireWorkerPack:true,
  };
}

export async function diagnosticPlan({rootCache=immutable}={}) {
  const crossPath='/fixture-cross-origin.wasm';
  const wasm=Buffer.from([0,97,115,109,1,0,0,0]);
  const cross=await serveRoutes([[crossPath,{
    mime:'application/wasm',body:gzipSync(wasm),cacheControl:immutable,
    extraHeaders:{'content-encoding':'gzip','access-control-allow-origin':'*'},
  }]]);
  const rootPath='/demo/root.pack', leaf='/demo/leaf-worker.mjs', parent='/demo/root-worker.mjs';
  const manifest='/demo/webroot.json', home='/demo/', display='/demo/display-worker.mjs';
  const response=(body,mime,cacheControl=revalidate,more={})=>({body,mime,cacheControl,...more});
  const page=`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:," />
  <label>Host focus witness <input id="host-focus" autofocus></label>
  <button id="opt-in">Show display</button>
  <script type="module">
    start();
    async function start() {
      try {
        const f = fetch(${JSON.stringify(cross.base+crossPath)}).then(r=>r.arrayBuffer());
        await (await fetch(${JSON.stringify(manifest)})).json();
        const w=new Worker(${JSON.stringify(parent)},{type:'module'});
        const note=await new Promise((resolve,reject)=>{
          w.onmessage=e=>resolve(e.data);w.onerror=reject;
        });
        const bytes=await f;
        if(note!==4||!WebAssembly.validate(bytes))throw Error('fixture bodies unavailable');
        window.receiptReady=true;
      } catch(e){window.receiptError=String(e);}
    }
    document.querySelector('#opt-in').onclick=()=>new Worker(${JSON.stringify(display)},{type:'module'});
  </script>`;
  try {
    const main=await serveRoutes([
      [home,response(page,'text/html')],
      [manifest,response('{"diagnostic":true}','application/json')],
      [parent,response(`const w=new Worker(${JSON.stringify(leaf)},{type:'module'});
        w.onmessage=e=>postMessage(e.data);`,'text/javascript')],
      [leaf,response(`const r=new XMLHttpRequest();r.open('GET',${JSON.stringify(rootPath)},false);
        r.responseType='arraybuffer';r.setRequestHeader('Range','bytes=2-5');r.send();
        if (r.status!==206) throw Error('Expected 206');
        postMessage(r.response.byteLength);`,'text/javascript')],
      [rootPath,response(Buffer.from('abcdefghij'),'application/octet-stream',rootCache,{ranges:true})],
      [display,response('postMessage("available fixture display");','text/javascript',noStore)],
    ]);
    const b=main.base,c=cross.base+crossPath;
    const groups=new Map([[c,'wasm'],[b+rootPath,'root'],[b+manifest,'manifest'],
      ...[home,parent,leaf,display].map(p=>[b+p,'bootstrap'])]);
    return {origins:[main,cross],url:b+home,profile:'diagnostic-configured',isAllowedWorker:url=>[b+parent,b+leaf].includes(url),
      requireAssets:[c,b+rootPath,b+manifest],requireWorkers:[b+parent,b+leaf],requireWorkerAssets:[b+rootPath],
      scope:url=>groups.get(url)??(url===b+'/favicon.ico'?'ignore':null)};
  } catch(error){await cross.close();throw error;}
}
