import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url)),work=await mkdtemp(path.join(tmpdir(),'length3-web-release-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const bytes=Buffer.alloc(70000,49);await copyFile(path.join(repo,'data/distribution/serve-web-release.mjs'),path.join(work,'serve.mjs'));
await writeFile(path.join(work,'public.object'),bytes);await writeFile(path.join(work,'not-published.txt'),'private fixture; no real secret');
await writeFile(path.join(work,'web-bundle.json'),JSON.stringify({format:'web-distribution-bundle-v1',releaseSha256:'7'.repeat(64),files:{'public.object':{}}}));
let child;
function get(url,{method='GET',headers={}}={}){return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path:url,method,headers},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));});req.on('error',reject);req.end();});}
try{
  child=spawn(process.execPath,[path.join(work,'serve.mjs'),String(port)],{cwd:work,stdio:['ignore','pipe','pipe'],windowsHide:true});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('packaged static server startup timeout')),5000);
    child.once('error',reject);child.once('exit',()=>reject(new Error('packaged static server exited')));
    child.stdout.once('data',raw=>{clearTimeout(timer);const result=JSON.parse(raw);assert.equal(result.url,`http://127.0.0.1:${port}/`);resolve();});});
  const entry=await get('/');assert.equal(entry.status,302);const link=new URL(entry.headers.location,'http://localhost');
  assert.equal(link.pathname,'/web/index.html');assert.equal(link.searchParams.get('linux-release-sha256'),'7'.repeat(64));
  const full=await get('/public.object');assert.equal(full.status,200);assert.deepEqual(full.bytes,bytes);assert.equal(full.headers['x-content-type-options'],'nosniff');
  assert.match(full.headers['content-security-policy'],/connect-src 'self'/);
  const partial=await get('/public.object',{headers:{Range:'bytes=10-20'}});assert.equal(partial.status,206);assert.equal(partial.headers['content-range'],'bytes 10-20/70000');assert.deepEqual(partial.bytes,bytes.subarray(10,21));
  const last=await get('/public.object',{headers:{Range:'bytes=69999-69999'}});assert.equal(last.status,206);assert.equal(last.bytes.length,1);
  const head=await get('/public.object',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(head.headers['content-length'],'70000');
  for(const Range of ['bytes=0-69999','bytes=70000-70000','bytes=-10','bytes=0-1,3-4'])assert.equal((await get('/public.object',{headers:{Range}})).status,416);
  assert.equal((await get('/not-published.txt')).status,404);assert.equal((await get('/%2e%2e/not-published.txt')).status,404);
  assert.equal((await get('/public.object',{method:'POST'})).status,403);assert.equal((await get('/public.object',{headers:{Host:'unapproved.invalid'}})).status,403);
  console.log(JSON.stringify({status:'pass',scope:'actual packaged server; no guest or browser lifecycle claim',
    cases:['pinned Terminal entry','full exact public body','bounded exact Range','last byte Range','HEAD','oversized Range refusal','out-of-bounds refusal',
      'suffix/multiple Range refusal','unlisted-file refusal','traversal refusal','write-method refusal','Host refusal','self-only CSP and MIME protection']}));
}finally{
  if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}
  // This unique test directory contains only the files created above.
  assert(work.startsWith(path.resolve(tmpdir())+path.sep+'length3-web-release-'));await rm(work,{recursive:true,force:true});
}
