import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishCatalog,acquirePackages} from './artifacts.ts';
import {prepareDistribution} from '../../distribution/build/prepare.ts';
import {distributionAssets} from '../../distribution/integrations/vite.ts';

test('otter acquires pinned closure then ricebox composes it without acquisition dependency',async t=>{
  const work=mkdtempSync(join(tmpdir(),'otter-composition-'));t.after(()=>rmSync(work,{recursive:true,force:true}));
  const source=join(work,'source');
  for(const name of ['base','app','unused']) {
    const dir=join(source,name);mkdirSync(join(dir,'tree/usr/share'),{recursive:true});
    writeFileSync(join(dir,'tree/usr/share',name),name);
    for(const [key,value] of Object.entries({version:'1',source:name+'-source',key:name+'-key'}))writeFileSync(join(dir,key),value);
  }
  const tool = (name: string) => {
    const path=join(work,name);writeFileSync(path,name==='translator'?Buffer.from([0,97,115,109,1,0,0,0]):Buffer.from('not-executed-fixture'));return path;
  };
  const tools = {translator: tool('translator'), sods: tool('sods'), muk: tool('muk')};
  const published=join(work,'published');
  const pin={...publishCatalog({packageCache:source,packages:{base:[],app:['base'],unused:[]},toolchains:{[`${process.platform}-${process.arch}`]:tools},output:published}),url:'https://example.test/catalog.json'};
  let calls=0;
  const fetch=t.mock.method(globalThis,'fetch',async(url: string | URL | Request)=>{calls++;return new Response(readFileSync(join(published,new URL(url instanceof Request ? url.url : url).pathname.slice(1))));});
  const acquired=await acquirePackages({catalog:pin,packages:['app'],cache:join(work,'downloaded')});
  assert.ok(acquired.tools);
  assert.deepEqual(acquired.packages,['base','app']);assert.equal(existsSync(join(acquired.packageCache,'unused')),false);
  assert.ok(calls>0);const before=calls;
  fetch.mock.mockImplementation(()=>{throw new Error('assembly must not acquire');});
  const output=join(work,'layers');
  // Acquisition succeeded independently. Later composition failure leaves this
  // cache available to the caller, not removed as part of a failed build.
  await assert.rejects(prepareDistribution({...acquired,tools:{...acquired.tools,muk:{...acquired.tools.muk,sha256:'0'.repeat(64)}},output}),/integrity mismatch/);
  assert.equal(existsSync(output),false);assert.ok(existsSync(acquired.packageCache));
  await prepareDistribution({...acquired,output,cache:''});
  const assets=distributionAssets(output);
  assert.ok(assets.has('ricebox/muk.json'));assert.ok([...assets.keys()].some(p=>p.startsWith('ricebox/packs/')));
  assert.equal(calls,before);
});
