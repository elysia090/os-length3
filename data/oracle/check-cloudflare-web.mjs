import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import worker from '../distribution/cloudflare-web.mjs';
import release from '../distribution/cloudflare-release.generated.json' with {type:'json'};
const repo=fileURLToPath(new URL('../../',import.meta.url)),dist=path.join(repo,'dist');
const source=(await readFile(path.join(repo,'temp','cloudflare-web',release.releaseSha256,'selected-source.txt'),'utf8')).trim();
const sha=b=>createHash('sha256').update(b).digest('hex');
const env={ASSETS:{async fetch(req){
  const name=new URL(req.url).pathname.slice(1);let bytes;
  try{bytes=await readFile(path.join(dist,name));}catch{return new Response('missing',{status:404});}
  const range=req.headers.get('range'),headers={'Content-Length':String(bytes.length)};
  if(range){const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(range);headers['Content-Range']=`bytes ${a}-${b}/${bytes.length}`;
    bytes=bytes.subarray(Number(a),Number(b)+1);headers['Content-Length']=String(bytes.length);}
  return new Response(req.method==='HEAD'?null:bytes,{status:range?206:200,headers});
}}};
const get=(pathname,options={})=>worker.fetch(new Request('https://os.length3.com'+pathname,options),env);
const root=await get('/');assert.equal(root.status,302);const entry=new URL(root.headers.get('location'),'https://os.length3.com');
assert.equal(entry.searchParams.get('linux-release-sha256'),release.releaseSha256);assert.equal(entry.searchParams.get('focus'),'source');
for(const [name,row] of Object.entries(release.objects)){
  const original=await readFile(path.join(repo,'temp','cloudflare-web',release.releaseSha256,source,name.slice(1)));
  for(const [a,b] of [[0,65535],[0,Math.min(row.bytes-1,1048575)],[row.bytes-1,row.bytes-1],...(row.parts.length>1?[[row.partBytes-10,row.partBytes+9]]:[])]){
    const reply=await get(release.versionPrefix+name,{headers:{Range:`bytes=${a}-${b}`}});
    assert.equal(reply.status,206);assert.equal(reply.headers.get('Content-Range'),`bytes ${a}-${b}/${row.bytes}`);
    assert.deepEqual(Buffer.from(await reply.arrayBuffer()),original.subarray(a,b+1));
    assert.match(reply.headers.get('Cache-Control'),/immutable/);
  }
  const full=await get(name);assert.equal(full.status,200);assert.equal(sha(Buffer.from(await full.arrayBuffer())),row.sha256);
  assert.equal(full.headers.get('Cache-Control'),'no-store, no-transform');
  const head=await get(name,{method:'HEAD'});assert.equal(head.headers.get('Content-Length'),String(row.bytes));assert.equal((await head.arrayBuffer()).byteLength,0);
  for(const Range of ['bytes=0-1048576',`bytes=${row.bytes}-${row.bytes}`,'bytes=-10','bytes=0-1,3-4'])assert.equal((await get(name,{headers:{Range}})).status,416);
}
const wasm=await get('/web/vm.wasm');assert.equal(wasm.headers.get('Content-Type'),'application/wasm');
assert.equal(wasm.headers.get('Cross-Origin-Opener-Policy'),'same-origin');assert.equal(wasm.headers.get('Cross-Origin-Embedder-Policy'),'require-corp');
const descriptor=await get(release.versionPrefix+'/artifact/release/release.json');assert.equal(sha(Buffer.from(await descriptor.arrayBuffer())),release.releaseSha256);
assert.equal((await get('/not-published.txt')).status,404);assert.equal((await get('/release-parts/private')).status,404);
assert.equal((await get('/web/index.html',{method:'POST'})).status,405);
const legacy=await worker.fetch(new Request('https://qm.length3.com/legacy/?focus=files'),env);assert.equal(legacy.status,200);
const failed=await worker.fetch(new Request('https://qm.length3.com/artifact/release/system.object',{headers:{Range:'bytes=0-10'}}),{ASSETS:{fetch:async()=>new Response('missing',{status:404})}});
assert.equal(failed.status,503);assert.match(await failed.text(),/Release delivery failed/);
console.log(JSON.stringify({status:'pass',scope:'delivery Worker with deterministic ASSETS fixture; actual Cloudflare is verified after deployment',
  releaseSha256:release.releaseSha256,cases:['pinned Terminal redirect','all five full-object hashes','all five exact first/last ranges',
  'split-boundary range','HEAD','oversized/out-of-bounds/suffix/multiple refusals','versioned cache','MIME','COOP/COEP','unknown path/write refusal','503 on broken delivery']}));
