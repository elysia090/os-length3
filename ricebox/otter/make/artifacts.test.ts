import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,readlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {resolvePackages,acquirePackages,publishCatalog} from './artifacts.ts';
const hash=(b: Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fixture(t: TestContext) {
  const at=mkdtempSync(join(tmpdir(),'otter-test-')); t.after(()=>rmSync(at,{recursive:true,force:true}));
  const built=join(at,'built');
  for(const n of ['base','app','unused']) {
    const d=join(built,n); mkdirSync(join(d,'tree/usr/bin'),{recursive:true});
    for(const [k,v] of Object.entries({version:'1.0',source:n+'-source',key:n+'-key'})) writeFileSync(join(d,k),v);
    writeFileSync(join(d,'tree/usr/bin',n),n,{mode:0o755});
  }
  symlinkSync('/usr/bin/app',join(built,'app/tree/usr/bin/alias'));
  const published=join(at,'published'), identity=publishCatalog({packageCache:built,packages:{base:[],app:['base'],unused:[]},output:published});
  const pin={...identity,url:'https://example.test/releases/catalog.json'};
  const calls: string[]=[];
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request,options?: RequestInit)=>{
    assert.equal(options?.redirect,'manual'); calls.push(String(url));
    const path=new URL(url instanceof Request ? url.url : url).pathname.replace('/releases/','');
    return new Response(readFileSync(join(published,path)));
  });
  return {at,published,pin,calls};
}
test('publisher and consumer resolve dependencies and materialize only the selected closure',async t=>{
  const {at,pin,calls}=fixture(t), cache=join(at,'cache');
  const result=await acquirePackages({catalog:pin,packages:['app'],cache});
  assert.deepEqual(result.packages,['base','app']);
  assert.equal(readFileSync(join(result.packageCache,'app/tree/usr/bin/app'),'utf8'),'app');
  assert.equal(readlinkSync(join(result.packageCache,'app/tree/usr/bin/alias')),'app');
  assert.equal(calls.length,3); // catalog, base, app; no unused package
  await acquirePackages({catalog:pin,packages:['app'],cache});
  assert.equal(calls.length,4); // cached files reverified, not downloaded
  writeFileSync(join(result.packageCache,'app/tree/usr/bin/injected'),'bad');
  await assert.rejects(acquirePackages({catalog:pin,packages:['app'],cache}),/unexpected cached artifact/);
});
test('rejects tampered catalogs and payloads, without accepting partial outputs',async t=>{
  const {at,pin,published}=fixture(t);
  await assert.rejects(acquirePackages({catalog:{...pin,sha256:'0'.repeat(64)},packages:['app'],cache:join(at,'cache')}),/integrity mismatch/);
  writeFileSync(join(published,'blobs',hash(Buffer.from('base'))),'evil');
  await assert.rejects(acquirePackages({catalog:pin,packages:['app'],cache:join(at,'cache')}),/integrity mismatch/);
});
test('rejects cycles, missing dependencies, path traversal and symlink parents',()=>{
  const p={version:'1',source:'source',key:'key',requires:[],files:[]};
  const c: {format: string; packages: Record<string, unknown>}={format:'otter-packages-v1',packages:{a:{...p,requires:['b']},b:{...p,requires:['a']}}};
  assert.throws(()=>resolvePackages(c,['a']),/cycle/);
  delete c.packages.b; assert.throws(()=>resolvePackages(c,['a']),/unknown package/);
  c.packages.a={...p,files:[{path:'../escape',target:'target'}]}; assert.throws(()=>resolvePackages(c,['a']),/unsafe/);
  c.packages.a={...p,files:[{path:'usr',target:'etc'},{path:'usr/file',target:'elsewhere'}]}; assert.throws(()=>resolvePackages(c,['a']),/parent directory/);
  c.packages.a={...p,files:[{path:'link',target:'../../escape'}]}; assert.throws(()=>resolvePackages(c,['a']),/escaping/);
});
test('unknown catalog boundary checks only selected packages and rejects malformed selected data',()=>{
  const valid={version:'1',source:'source',key:'key',requires:[],files:[]};
  assert.deepEqual(resolvePackages({format:'otter-packages-v1',packages:{good:valid,unused:null}},['good']),['good']);
  for (const malformed of [null,42,{}, {...valid,files:[null]}, {...valid,requires:[null]}, {...valid,files:[{path:'x',sha256:'0'.repeat(64),size:'1',mode:0o644}]}]) {
    assert.throws(()=>resolvePackages({format:'otter-packages-v1',packages:{bad:malformed}},['bad']));
  }
  for (const selected of [null,[],['good','good'],[3]]) {
    assert.throws(()=>resolvePackages({format:'otter-packages-v1',packages:{good:valid}},selected),/select unique/);
  }
});
