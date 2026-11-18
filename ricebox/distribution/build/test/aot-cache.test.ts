import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {translateWhole} from '../aot-cache.ts';
const moduleURL = new URL('../aot-cache.ts', import.meta.url).href;
const wasm = Buffer.from([0,97,115,109,1,0,0,0]);
function fixture(t: import('node:test').TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'aot-test-')), sods=join(dir,'sods'), cache=join(dir,'cache'), log=join(dir,'calls');
  writeFileSync(sods, `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'x');fs.writeFileSync(process.argv.at(-1),Buffer.from([0,97,115,109,1,0,0,0]));\n`, {mode:0o755});
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const calls=()=>readFileSync(log,'utf8').length;
  return {dir,sods,cache,log,calls};
}
test('whole translation reuses exact source and translator identities', t=>{
  const f=fixture(t), input=Buffer.from('ELF');
  assert.deepEqual(translateWhole(f.sods,wasm,input,f.cache),wasm);
  assert.deepEqual(translateWhole(f.sods,wasm,input,f.cache),wasm);
  assert.equal(f.calls(),1);
  translateWhole(f.sods,wasm,Buffer.from('different ELF'),f.cache);
  translateWhole(f.sods,Buffer.concat([wasm,Buffer.from('different translator')]),input,f.cache);
  appendFileSync(f.sods,'// changed native compiler\n');
  translateWhole(f.sods,wasm,input,f.cache);
  assert.equal(f.calls(),4);
  translateWhole(f.sods,wasm,input,null);
  assert.equal(f.calls(),5);
});
test('truncation, payload corruption and wrong key never produce cache hits', t=>{
  const f=fixture(t), input=Buffer.from('ELF');
  translateWhole(f.sods,wasm,input,f.cache);
  const entry=join(f.cache,readdirSync(f.cache)[0]);
  for(const damage of [()=>Buffer.from('cut'), (b:Buffer)=>{b[b.length-1]^=1;return b;},(b:Buffer)=>{b[20]^=1;return b;}]){
    writeFileSync(entry,damage(readFileSync(entry)));
    assert.deepEqual(translateWhole(f.sods,wasm,input,f.cache),wasm);
  }
  assert.equal(f.calls(),4);
});
test('failed translation publishes nothing and leaves no temporary entry', t=>{
  const f=fixture(t);
  writeFileSync(f.sods,`#!${process.execPath}\nprocess.exit(2);\n`,{mode:0o755});
  assert.throws(()=>translateWhole(f.sods,wasm,Buffer.from('ELF'),f.cache));
  assert.throws(()=>readdirSync(f.cache),{code:'ENOENT'});
});
test('concurrent processes publish complete reusable entries', async t=>{
  const f=fixture(t);
  const source=`import {translateWhole} from ${JSON.stringify(moduleURL)};translateWhole(${JSON.stringify(f.sods)},new Uint8Array([0,97,115,109,1,0,0,0]),new Uint8Array([1]),${JSON.stringify(f.cache)});`;
  await Promise.all(Array.from({length:6},()=>new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','ignore','pipe']});
    let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('exit',c=>c===0?resolve():reject(new Error(error)));
  })));
  const count=f.calls();
  assert.deepEqual(translateWhole(f.sods,wasm,new Uint8Array([1]),f.cache),wasm);
  assert.equal(f.calls(),count);
  assert.equal(readdirSync(f.cache).length,1);
});

test('changing the compiler during a build and invalid output cannot populate the cache', t=>{
  const f=fixture(t);
  writeFileSync(f.sods,`#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(__filename,'// modified\\n');fs.writeFileSync(process.argv.at(-1),Buffer.from([0,97,115,109,1,0,0,0]));\n`,{mode:0o755});
  assert.throws(()=>translateWhole(f.sods,wasm,Buffer.from('ELF'),f.cache),/changed during translation/);
  writeFileSync(f.sods,`#!${process.execPath}\nrequire('fs').writeFileSync(process.argv.at(-1),'not wasm');\n`,{mode:0o755});
  assert.throws(()=>translateWhole(f.sods,wasm,Buffer.from('ELF'),f.cache),/did not produce/);
  assert.throws(()=>readdirSync(f.cache),{code:'ENOENT'});
});
