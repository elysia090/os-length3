// Outside the browser. Assert deployed ES module routes without loading any
// guest asset, running the app, starting a Worker, or affecting browser cache.
import {readFile} from 'node:fs/promises';
import {createContext,SourceTextModule} from 'node:vm';

const mime = value => value?.split(';',1)[0].trim().toLowerCase();
const jsTypes = new Set(['text/javascript','application/javascript']);
const workerEntries = [
  'distribution/runtime/worker.js',
  'distribution/runtime/check.worker.js',
  'distribution/runtime/translate.worker.js',
  'sods/runtime/linux/cpu.js',
];
const rootEntry='distribution/runtime/root.js';

export async function probeNestedSite(site, manifest) {
  const base=new URL(site);
  if(base.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(base.hostname) ||
     base.pathname!=='/demo/' || base.username || base.password || base.search || base.hash) {
    throw Error('Use an explicit loopback HTTP /demo/ URL for this fixture');
  }
  if(manifest?.v!==1 || !Array.isArray(manifest.core) || !Array.isArray(manifest.display)) {
    throw Error('Expected the trusted installed package browser module manifest');
  }
  const allowed=new Set(manifest.core.map(path=>{
    if(typeof path!=='string' || !/^(?:distribution\/(?:format|runtime)|sods\/runtime)(?:\/[a-z0-9-]+)*\/[a-z0-9.-]+\.js$/.test(path)) {
      throw Error('Invalid core manifest path: '+path);
    }
    return new URL('ricebox-js/'+path,base).href;
  }));
  if(allowed.size!==manifest.core.length) throw Error('Duplicate core manifest module');
  function get(url) {
    return fetch(url,{redirect:'error',signal:AbortSignal.timeout(10_000)});
  }
  const sources=new Map();
  async function js(url) {
    const reply=await get(url);
    if(reply.status!==200) throw Error('Module '+url+' answered '+reply.status);
    if(!jsTypes.has(mime(reply.headers.get('content-type')))) {
      throw Error('Expected JavaScript MIME for '+url);
    }
    return reply.text();
  }
  function source(url){
    if(!allowed.has(url)) throw Error('Module escapes the staged /demo/ graph: '+url);
    if(!sources.has(url)) sources.set(url,js(url));
    return sources.get(url);
  }
  const navigation=await get(base);
  if(navigation.status!==200 || mime(navigation.headers.get('content-type'))!=='text/html') {
    throw Error('Expected an HTML document at '+base);
  }
  await navigation.body?.cancel();
  for(const path of ['demo.mjs','launch.mjs']) {
    const url=new URL(path,base);
    new SourceTextModule(await js(url),{identifier:url.href}); // Parse only, never autostart the app.
  }
  const fail=()=>{throw Error('Probe unexpectedly tried to fetch a guest asset or start a Worker');};
  for(const path of [rootEntry,...workerEntries]) {
    const context=createContext({performance,URL,TextEncoder,TextDecoder,fetch:fail,
      Worker:class{constructor(){fail();}},addEventListener(){},postMessage(){}});
    context.self=context;
    const linked=new Map();
    function add(url) {
      if(!linked.has(url)) linked.set(url,source(url).then(data=>new SourceTextModule(data,{
        context, identifier:url, initializeImportMeta(meta){meta.url=url;},
      })));
      return linked.get(url);
    }
    const entry=await add(new URL('ricebox-js/'+path,base).href);
    await entry.link((specifier,parent)=>{
      if(!specifier.startsWith('./')&&!specifier.startsWith('../')) {
        throw Error('Non-relative module specifier in '+parent.identifier+': '+specifier);
      }
      return add(new URL(specifier,parent.identifier).href);
    });
    await entry.evaluate();
  }
  if(sources.size!==allowed.size) throw Error('Staged module set does not exactly match the resolved module graph');
  const display=new URL('ricebox-js/everyday/src/surface.js',base);
  const omitted=await get(display);
  await omitted.body?.cancel();
  if(omitted.status!==404) throw Error('Shell-only route must not expose the optional presenter');
  return {modules:sources.size, root:base.href, display:'absent'};
}

if(import.meta.main) {
  const [site,stamp,...extra]=process.argv.slice(2);
  if(!site||!stamp||extra.length) throw Error('Usage: node --experimental-vm-modules probe-site.mjs LOOPBACK_DEMO_URL INSTALLED_BROWSER_MANIFEST.json');
  console.log(await probeNestedSite(site,JSON.parse(await readFile(stamp,'utf8'))));
}
