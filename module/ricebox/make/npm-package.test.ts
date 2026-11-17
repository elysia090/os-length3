import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, readFileSync, readdirSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const builder = fileURLToPath(new URL('npm.ts', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir, {withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);
}
test('built npm package contains builder dependencies and imports public JS without a TS loader', () => {
  const work=mkdtempSync(join(tmpdir(),'ricebox-package-')),out=join(work,'package');
  try {
    execFileSync(process.execPath,[builder,out],{encoding:'utf8',timeout:30_000});
    const pkg=JSON.parse(readFileSync(join(out,'package.json'),'utf8'));
    assert.equal(pkg.private,true);
    assert.equal(pkg.exports['./vite'].import,'./module/ricebox/npm/vite.js');
    assert.equal(pkg.exports['./prepare'].types,'./module/ricebox/npm/prepare.ts');
    for(const name of ['module/ricebox/make/layers.ts','module/ricebox/make/file-core.ts','module/sods/runtime/core/files.ts',
      'module/ricebox/npm/vite.ts','module/ricebox/npm/vite.js','module/ricebox/npm/prepare.ts','module/ricebox/npm/prepare.js']) {
      assert.ok(existsSync(join(out,name)),`missing ${name}`);
    }
    // Cover the copied builder as well as the root's transitive runtime closure.
    for(const path of files(out).filter(p=>/\.(ts|js|mjs)$/.test(p))) {
      const source=readFileSync(path,'utf8');
      for(const m of source.matchAll(/(?:from\s*|import\s*\(\s*|new URL\(\s*)['"](\.[^'"\n]+\.(?:ts|js|mjs))['"]/g)) {
        assert.ok(existsSync(resolve(dirname(path),m[1])),`${path} lacks ${m[1]}`);
      }
    }
    const imports=['.','./vite','./prepare'].map(key=>pathToFileURL(join(out,pkg.exports[key].import)).href);
    const result=execFileSync(process.execPath,['--no-experimental-strip-types','--input-type=module','-e',
      `for (const url of ${JSON.stringify(imports)}) await import(url); console.log('imports-ok');`],{encoding:'utf8',timeout:30_000});
    assert.match(result,/imports-ok/);
    const helper=pathToFileURL(join(out,'module/ricebox/make/file-core.ts')).href;
    const checks=execFileSync(process.execPath,['--input-type=module','-e',
      `const {fileCoreOptions}=await import(${JSON.stringify(helper)}); if(fileCoreOptions([])!==null) throw Error('selection'); console.log('builder-ok');`],{encoding:'utf8',timeout:30_000});
    assert.match(checks,/builder-ok/);
    const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--offline','--json','--pack-destination',work],
      {cwd:out,env:{...process.env,npm_config_cache:join(work,'npm-cache')},encoding:'utf8',timeout:30_000}));
    assert.ok(existsSync(join(work,packed[0].filename)));
    assert.ok(packed[0].files.some((f:{path:string})=>f.path==='module/ricebox/make/file-core.ts'));
    assert.ok(packed[0].files.some((f:{path:string})=>f.path==='module/ricebox/npm/vite.js'));
    assert.throws(()=>execFileSync(process.execPath,[builder,out],{stdio:'pipe',timeout:30_000}),/Refusing to replace/);
  } finally {rmSync(work,{recursive:true,force:true});}
});
