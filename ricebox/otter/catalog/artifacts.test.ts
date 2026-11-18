import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,readlinkSync,lstatSync} from 'node:fs';
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

test('acquisition preserves package and tool modes under a restrictive umask',async t=>{
  const {at,pin,published}=fixture(t);
  const catalog=JSON.parse(readFileSync(join(published,'catalog.json'),'utf8'));
  catalog.packages.base.files.find((f: {path: string})=>f.path==='usr/bin/base').mode=0o644;
  const tool={sha256:hash(Buffer.from('base')),size:4};
  catalog.toolchains={[`${process.platform}-${process.arch}`]:{sods:tool,translator:tool,muk:tool}};
  const bytes=Buffer.from(JSON.stringify(catalog)+'\n');
  writeFileSync(join(published,'catalog.json'),bytes);
  const selected={...pin,sha256:hash(bytes),size:bytes.length};
  const mask=process.umask(0o077);
  try {
    const result=await acquirePackages({catalog:selected,packages:['app'],cache:join(at,'private-cache')});
    const mode=(path: string)=>lstatSync(path).mode & 0o777;
    assert.equal(mode(result.packageCache),0o700,'the private cache container is not a guest directory');
    assert.equal(mode(join(result.packageCache,'app/tree/usr')),0o755);
    assert.equal(mode(join(result.packageCache,'app/tree/usr/bin/app')),0o755);
    assert.equal(mode(join(result.packageCache,'base/tree/usr/bin/base')),0o644);
    assert.equal(mode(result.tools!.sods.path),0o755);
    assert.equal(mode(result.tools!.translator.path),0o644);
    assert.equal(mode(result.tools!.muk.path),0o644);
    assert.equal(readFileSync(result.tools!.translator.path,'utf8'),'base');
    assert.equal((await acquirePackages({catalog:selected,packages:['app'],cache:join(at,'private-cache')})).packageCache,result.packageCache);
  } finally { process.umask(mask); }
});
test('declared directory modes do not depend on catalog file ordering',async t=>{
  const {at,pin,published}=fixture(t);
  const catalog=JSON.parse(readFileSync(join(published,'catalog.json'),'utf8'));
  catalog.packages.base.files.reverse();
  catalog.packages.base.files.find((f: {path: string})=>f.path==='usr').mode=0o700;
  const bytes=Buffer.from(JSON.stringify(catalog)+'\n');
  writeFileSync(join(published,'catalog.json'),bytes);
  const result=await acquirePackages({catalog:{...pin,sha256:hash(bytes),size:bytes.length},packages:['base'],cache:join(at,'cache')});
  assert.equal(lstatSync(join(result.packageCache,'base/tree/usr')).mode & 0o777,0o700);
  assert.equal(readFileSync(join(result.packageCache,'base/tree/usr/bin/base'),'utf8'),'base');
});
