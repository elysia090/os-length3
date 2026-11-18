import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, readFileSync, readdirSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const builder = fileURLToPath(new URL('../npm.ts', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir, {withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);
}
test('built npm package contains builder dependencies and imports public JS without a TS loader', () => {
  const work=mkdtempSync(join(tmpdir(),'ricebox-package-')),out=join(work,'package');
  try {
    execFileSync(process.execPath,[builder,out],{encoding:'utf8',timeout:30_000});
    const pkg=JSON.parse(readFileSync(join(out,'package.json'),'utf8'));
    assert.equal(pkg.private,true);
    for(const path of ['make','maintenance','test/fixtures']) assert.equal(existsSync(join(out,'module/ricebox',path)),false,path+' is not package content');
    assert.equal(existsSync(join(out,'module/ricebox/verification')),false,'comparison harnesses are not package entries');
    assert.equal(existsSync(join(out,'module/otter')),false);
    assert.equal(existsSync(join(out,'module/ricebox/npm')),false);
    assert.equal(pkg.exports['./vite'].import,'./module/ricebox/integrations/vite.js');
    assert.equal(pkg.exports['./prepare'].types,'./module/ricebox/build/prepare.ts');
    for(const name of ['module/ricebox/distribution/executable-source.ts','module/ricebox/build/distribution.ts','module/ricebox/build/file-store-artifact.ts','module/sods/runtime/file-store.ts',
      'module/ricebox/build/capture-result-artifact.ts','module/ricebox/build/capture-result-artifact.js',
      'module/ricebox/deployment/assets.ts','module/ricebox/deployment/assets.js',
      'module/ricebox/integrations/vite.ts','module/ricebox/integrations/vite.js','module/ricebox/build/prepare.ts','module/ricebox/build/prepare.js']) {
      assert.ok(existsSync(join(out,name)),`missing ${name}`);
    }
    // Cover the copied builder as well as the root's transitive runtime closure.
    for(const path of files(out).filter(p=>/\.(ts|js|mjs)$/.test(p))) {
      assert.doesNotMatch(path.slice(out.length), /\/(?:test|verification)\/|\.(?:test|spec)\.[cm]?[jt]s$/, 'tests and verification are not package content');
      const source=readFileSync(path,'utf8');
      for(const m of source.matchAll(/(?:from\s*|import\s*\(\s*|new URL\(\s*)['"](\.[^'"\n]+\.(?:ts|js|mjs))['"]/g)) {
        assert.ok(existsSync(resolve(dirname(path),m[1])),`${path} lacks ${m[1]}`);
      }
    }
    const imports=['.','./vite','./prepare'].map(key=>pathToFileURL(join(out,pkg.exports[key].import)).href);
    const result=execFileSync(process.execPath,['--no-experimental-strip-types','--input-type=module','-e',
      `for (const url of ${JSON.stringify(imports)}) await import(url); console.log('imports-ok');`],{encoding:'utf8',timeout:30_000});
    assert.match(result,/imports-ok/);
    const composed=execFileSync(process.execPath,['--no-experimental-strip-types','--input-type=module','-e',`
      import {mkdirSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; import {createHash} from 'node:crypto';
      const {prepareDistribution}=await import(${JSON.stringify(imports[2])});
      const {distributionAssets}=await import(${JSON.stringify(imports[1])});
      const work=${JSON.stringify(work)}, cache=join(work,'selected-cache'), base=join(cache,'base');
      mkdirSync(join(base,'tree/usr/share'),{recursive:true});writeFileSync(join(base,'tree/usr/share/base'),'package');
      for(const [key,value] of Object.entries({version:'1',source:'fixture',key:'fixture'}))writeFileSync(join(base,key),value);
      const tools=Object.fromEntries(['translator','sods','muk'].map(name=>{
        const path=join(work,name),bytes=name==='translator'?Buffer.from([0,97,115,109,1,0,0,0]):Buffer.from('fixture');
        writeFileSync(path,bytes);return [name,{path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}];
      }));
      globalThis.fetch=()=>{throw Error('package composition must not acquire');};
      const output=join(work,'composed');await prepareDistribution({packages:['base'],packageCache:cache,tools,output,cache:''});
      if(!distributionAssets(output).has('ricebox/muk.json'))throw Error('missing maker');console.log('composition-ok');
    `],{encoding:'utf8',timeout:30_000});
    assert.match(composed,/composition-ok/);
    const helper=pathToFileURL(join(out,'module/ricebox/build/file-store-artifact.ts')).href;
    const checks=execFileSync(process.execPath,['--input-type=module','-e',
      `const {fileStoreOptions}=await import(${JSON.stringify(helper)}); if(fileStoreOptions([])!==null) throw Error('selection'); console.log('builder-ok');`],{encoding:'utf8',timeout:30_000});
    assert.match(checks,/builder-ok/);
    const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--offline','--json','--pack-destination',work],
      {cwd:out,env:{...process.env,npm_config_cache:join(work,'npm-cache')},encoding:'utf8',timeout:30_000}));
    assert.ok(existsSync(join(work,packed[0].filename)));
    assert.ok(packed[0].files.some((f:{path:string})=>f.path==='module/ricebox/build/file-store-artifact.ts'));
    assert.ok(packed[0].files.some((f:{path:string})=>f.path==='module/ricebox/distribution/executable-source.ts'));
    assert.ok(packed[0].files.some((f:{path:string})=>f.path==='module/ricebox/integrations/vite.js'));
    assert.throws(()=>execFileSync(process.execPath,[builder,out],{stdio:'pipe',timeout:30_000}),/Refusing to replace/);
  } finally {rmSync(work,{recursive:true,force:true});}
});
