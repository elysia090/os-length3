import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync} from 'node:fs';
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
    assert.equal(pkg.version,'0.0.1');
    assert.equal(readFileSync(join(out,'ricebox/distribution/RELEASE'),'utf8').trim(),pkg.version);
    for(const path of ['make','maintenance','test/fixtures']) assert.equal(existsSync(join(out,'ricebox/distribution',path)),false,path+' is not package content');
    assert.equal(existsSync(join(out,'ricebox/distribution/verification')),false,'comparison harnesses are not package entries');
    assert.equal(existsSync(join(out,'ricebox/otter')),false);
    assert.equal(existsSync(join(out,'ricebox/distribution/npm')),false);
    assert.equal(pkg.exports['./vite'].import,'./ricebox/distribution/integrations/vite.js');
    assert.equal(pkg.exports['./prepare'].types,'./ricebox/distribution/build/prepare.ts');
    assert.deepEqual(pkg.exports['./assets'],{
      types:'./ricebox/distribution/deployment/assets.ts', import:'./ricebox/distribution/deployment/assets.js',
    });
    assert.deepEqual(pkg.exports['./everyday'],{
      types:'./ricebox/everyday/src/surface.ts', import:'./ricebox/everyday/src/surface.js',
    });
    for(const name of ['ricebox/distribution/format/executable-source.ts','ricebox/distribution/build/distribution.ts',
      'ricebox/distribution/deployment/assets.ts','ricebox/distribution/deployment/assets.js',
      'ricebox/distribution/integrations/vite.ts','ricebox/distribution/integrations/vite.js','ricebox/distribution/build/prepare.ts','ricebox/distribution/build/prepare.js']) {
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
    const imports=['.','./vite','./prepare','./assets'].map(key=>pathToFileURL(join(out,pkg.exports[key].import)).href);
    const result=execFileSync(process.execPath,['--no-experimental-strip-types','--input-type=module','-e',
      `for (const url of ${JSON.stringify(imports)}) await import(url); console.log('imports-ok');`],{encoding:'utf8',timeout:30_000});
    assert.match(result,/imports-ok/);
    const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--offline','--json','--pack-destination',work],
      {cwd:out,env:{...process.env,npm_config_cache:join(work,'npm-cache')},encoding:'utf8',timeout:30_000}));
    assert.ok(existsSync(join(work,packed[0].filename)));
    assert.ok(!packed[0].files.some((f:{path:string})=>/file-store|file-scope/.test(f.path)), 'retired file ownership implementations are not package content');
    assert.ok(!packed[0].files.some((f:{path:string})=>/(^|\/)(why|site|demos?|examples?|playground|test|verification)(\/|$)/.test(f.path)), 'products and demos are not package content');
    assert.deepEqual(packed[0].files.map((f:{path:string})=>f.path).filter((path:string)=>/(^|\/)everyday(\/|$)/.test(path)).sort(),[
      'ricebox/everyday/src/mirror-surface.js','ricebox/everyday/src/mirror-surface.ts',
      'ricebox/everyday/src/surface.js','ricebox/everyday/src/surface.ts',
    ],'only the explicit Everyday API and its source modules are package content');
    assert.ok(packed[0].files.some((f:{path:string})=>f.path==='ricebox/distribution/format/executable-source.ts'));
    assert.ok(packed[0].files.some((f:{path:string})=>f.path==='ricebox/distribution/integrations/vite.js'));
    const consumer=join(work,'consumer'); mkdirSync(consumer);
    writeFileSync(join(consumer,'package.json'),'{"private":true}\n');
    execFileSync('npm',['install','--ignore-scripts','--offline','--no-audit','--no-fund',join(work,packed[0].filename)],
      {cwd:consumer,env:{...process.env,npm_config_cache:join(work,'empty-consumer-cache')},encoding:'utf8',timeout:30_000});
    const composed=execFileSync(process.execPath,['--no-experimental-strip-types','--input-type=module','-e',`
      import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'; import {dirname,join} from 'node:path'; import {createHash} from 'node:crypto';
      globalThis.fetch=()=>{throw Error('package import and staging must not fetch');};
      globalThis.Worker=class { constructor(){throw Error('package import and staging must not start a browser Worker');} };
      await import('ricebox');
      const {mountGuestSurface,surfaceFromMirror}=await import('ricebox/everyday');
      if(typeof mountGuestSurface!=='function'||typeof surfaceFromMirror!=='function')throw Error('missing installed Everyday API');
      console.log('everyday-js-ok');
      const {prepareDistribution}=await import('ricebox/prepare');
      const {distributionAssets}=await import('ricebox/assets');
      const work=${JSON.stringify(work)}, cache=join(work,'selected-cache'), base=join(cache,'base');
      mkdirSync(join(base,'tree/usr/share'),{recursive:true});writeFileSync(join(base,'tree/usr/share/base'),'package');
      for(const [key,value] of Object.entries({version:'1',source:'fixture',key:'fixture'}))writeFileSync(join(base,key),value);
      const tools=Object.fromEntries(['translator','sods','muk'].map(name=>{
        const path=join(work,name),bytes=name==='translator'?Buffer.from([0,97,115,109,1,0,0,0]):Buffer.from('fixture');
        writeFileSync(path,bytes);return [name,{path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}];
      }));
      const output=join(work,'composed');await prepareDistribution({packages:['base'],packageCache:cache,tools,output,cache:''});
      if(JSON.parse(readFileSync(join(output,'webroot.json'),'utf8')).version!==${JSON.stringify(pkg.version)})throw Error('wrong packaged version');
      const site=join(work,'site');mkdirSync(site);
      for(const [path,bytes] of distributionAssets(output)){
        const file=join(site,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes,{flag:'wx'});
      }
      const layers=join(site,'ricebox');
      for(const name of ['webroot.json','muk.json']){
        if(!readFileSync(join(layers,name)).equals(readFileSync(join(output,name))))throw Error('wrong static asset: '+name);
      }
      if((await import('ricebox/vite')).distributionAssets!==distributionAssets)throw Error('Vite alias changed');
      console.log('static-assets-ok');
    `],{cwd:consumer,encoding:'utf8',timeout:30_000});
    assert.match(composed,/everyday-js-ok/);
    assert.match(composed,/static-assets-ok/);
    assert.throws(()=>execFileSync(process.execPath,[builder,out],{stdio:'pipe',timeout:30_000}),/Refusing to replace/);
  } finally {rmSync(work,{recursive:true,force:true});}
});
