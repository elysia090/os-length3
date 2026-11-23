import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {packOf} from '../../format/pack.ts';
import {withStarterPreview} from '../../verification/test/fixtures/starter-preview.ts';
const builder = fileURLToPath(new URL('../npm.ts', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir, {withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);
}
test('browser manifest requires a direct literal module Worker URL', () => {
  const work=mkdtempSync(join(tmpdir(),'ricebox-browser-edges-'));
  const stamp=join(work,'ricebox/distribution/deployment/browser-modules.json');
  const script=fileURLToPath(new URL('../../../toolchain/package-browser-manifest.ts',import.meta.url));
  const root='distribution/runtime/root.js', display='everyday/src/surface.js';
  const put=(path:string,source:string)=>{
    const file=join(work,'ricebox',path);
    mkdirSync(dirname(file),{recursive:true});writeFileSync(file,source);
  };
  const build=()=>spawnSync(process.execPath,['--experimental-vm-modules',script,work,root,display],
    {encoding:'utf8',timeout:30_000});
  const url="new URL('./worker.js', import.meta.url), {type: 'module'}";
  const valid=`import './side.js';\nexport const lazy=()=>import('./lazy.js');\nexport const create=()=>new Worker(${url});\n`;
  try {
    mkdirSync(dirname(stamp),{recursive:true});
    put(root,valid+"export const message=()=>new Error('Worker response lost');\n");
    for(const name of ['worker','side','lazy','unrelated'])put(`distribution/runtime/${name}.js`,'export {};');
    put(display,"import '../../distribution/runtime/side.js';");
    const built=build();
    assert.equal(built.status,0,built.stderr);
    assert.deepEqual(JSON.parse(readFileSync(stamp,'utf8')),{v:1,
      core:['lazy','root','side','worker'].map(name=>`distribution/runtime/${name}.js`), display:[display],
    });
    rmSync(stamp);
    for(const source of [
      `new globalThis.Worker(${url});`, `new self.Worker(${url});`,
      `const Spawn=Worker; new Spawn(${url});`,
      `const Spawn=self['Worker']; new Spawn(${url});`,
      `const {Worker: Spawn}=globalThis; new Spawn(${url});`,
      "new Worker('./worker.js');", "new Worker(new URL(target, import.meta.url), {type: 'module'});",
      'const msg=`started ${new globalThis.Worker(target)}`;',
    ]) {
      put(root,valid+source);
      const result=build();
      assert.notEqual(result.status,0,source);
      assert.match(result.stderr,/unsupported Worker reference.*direct literal module Worker URL/,source);
      assert.ok(!existsSync(stamp),source);
    }
  } finally {rmSync(work,{recursive:true,force:true});}
});
test('built npm package contains builder dependencies and imports public JS without a TS loader', async () => {
  const work=mkdtempSync(join(tmpdir(),'ricebox-package-')),out=join(work,'package');
  try {
    execFileSync(process.execPath,[builder,out,'--runtime-only'],{encoding:'utf8',timeout:30_000});
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
    assert.deepEqual(pkg.bin, {'ricebox-stage-shell': './ricebox/distribution/starter/stage.js'});
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
      'ricebox/everyday/terminal/vt-view.js','ricebox/everyday/terminal/vt-view.ts',
      'ricebox/everyday/terminal/vt.js','ricebox/everyday/terminal/vt.ts',
    ],'only the explicit Everyday surface API and the shared VT implementation are package content');
    assert.ok(packed[0].files.some((f:{path:string})=>f.path==='ricebox/distribution/format/executable-source.ts'));
    assert.ok(packed[0].files.some((f:{path:string})=>f.path==='ricebox/distribution/integrations/vite.js'));
    const consumer=join(work,'consumer'); mkdirSync(consumer);
    writeFileSync(join(consumer,'package.json'),'{"private":true}\n');
    execFileSync('npm',['install','--ignore-scripts','--offline','--no-audit','--no-fund',join(work,packed[0].filename)],
      {cwd:consumer,env:{...process.env,npm_config_cache:join(work,'empty-consumer-cache')},encoding:'utf8',timeout:30_000});
    const composed=execFileSync(process.execPath,['--no-experimental-strip-types','--experimental-vm-modules','--input-type=module','-e',`
      import assert from 'node:assert/strict';
      import {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync,symlinkSync,unlinkSync} from 'node:fs';
      import {dirname,join,resolve} from 'node:path'; import {createHash} from 'node:crypto';
      import {SourceTextModule,createContext} from 'node:vm';
      globalThis.fetch=()=>{throw Error('package import and staging must not fetch');};
      globalThis.Worker=class { constructor(){throw Error('package import and staging must not start a browser Worker');} };
      await import('ricebox');
      const {mountGuestSurface,surfaceFromMirror}=await import('ricebox/everyday');
      if(typeof mountGuestSurface!=='function'||typeof surfaceFromMirror!=='function')throw Error('missing installed Everyday API');
      console.log('everyday-js-ok');
      const {prepareDistribution}=await import('ricebox/prepare');
      const {distributionAssets,browserModules}=await import('ricebox/assets');
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
      const installed='node_modules/ricebox/ricebox';
      const stamped=join(installed,'distribution/deployment/browser-modules.json');
      const original=readFileSync(stamped);
      try {
        for (const bad of ['../package.json','sods/runtime/../host.js','/distribution/runtime/root.js','distribution/build/prepare.js']) {
          const manifest=JSON.parse(original);manifest.core.push(bad);
          writeFileSync(stamped,JSON.stringify(manifest));
          assert.throws(()=>browserModules(),/invalid browser module manifest paths/);
        }
      } finally {writeFileSync(stamped,original);}

      // Being present in an allowed package directory is not a staging grant.
      writeFileSync(join(installed,'distribution/runtime/rogue.js'),'throw Error("not for staging");');
      const browser=browserModules();
      const withDisplay=browserModules({display:true});
      assert.ok(existsSync(join(installed,'distribution/format/inventory.js')));
      for (const path of ['distribution/runtime/rogue.js','distribution/format/inventory.js']) {
        assert.ok(!browser.has('ricebox-js/'+path) && !withDisplay.has('ricebox-js/'+path),path);
      }
      assert.deepEqual([...withDisplay.keys()].filter(path=>!browser.has(path)).sort(),[
        'ricebox-js/everyday/src/mirror-surface.js', 'ricebox-js/everyday/src/surface.js',
      ]);
      const promised=join(installed,'distribution/runtime/worker.js');
      renameSync(promised,promised+'.moved');
      try {
        assert.throws(()=>browserModules(),{code:'ENOENT'});
        symlinkSync(resolve(promised+'.moved'),promised);
        try {assert.throws(()=>browserModules(),/not a regular file/);}
        finally {unlinkSync(promised);}
      } finally {renameSync(promised+'.moved',promised);}

      const renderer=join(installed,'everyday/src/surface.js');
      renameSync(renderer,renderer+'.moved');
      try {
        assert.deepEqual(browserModules(),browser);
        assert.throws(()=>browserModules({display:true}),{code:'ENOENT'});
      } finally {renameSync(renderer+'.moved',renderer);}
      for(const [path,bytes] of browser){
        assert.match(path,/^ricebox-js\\/(?:distribution\\/(?:format|runtime)|sods\\/runtime)\\/.+[.]js$/);
        assert.deepEqual(bytes,readFileSync(join(installed,path.slice('ricebox-js/'.length))));
      }
      for(const [path,bytes] of [...distributionAssets(output), ...browser]){
        const file=join(site,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes,{flag:'wx'});
      }
      const layers=join(site,'ricebox');
      for(const name of ['webroot.json','muk.json']){
        if(!readFileSync(join(layers,name)).equals(readFileSync(join(output,name))))throw Error('wrong static asset: '+name);
      }
      assert.ok(!existsSync(join(site,'ricebox-js/everyday')));
      // Model same-origin module resolution in process-free realms. This verifies
      // the installed ESM and Worker entry graph, not browser-guest behavior.
      const origin='https://example.test/subdirectory/';
      const reached=new Set();
      async function load(path, globals={}, staged=browser){
        const context=createContext({performance,URL,TextEncoder,TextDecoder, ...globals,
          fetch:globalThis.fetch, Worker:globalThis.Worker});
        context.self=context;
        const modules=new Map();
        function add(url){
          assert.ok(url.startsWith(origin),url);
          if(modules.has(url))return modules.get(url);
          const local=url.slice(origin.length);
          assert.ok(staged.has(local),url+' is not staged');
          reached.add(local);
          const m=new SourceTextModule(readFileSync(join(site,local),'utf8'),{
            context,identifier:url,initializeImportMeta(meta){meta.url=url;},
          });
          modules.set(url,m);
          return m;
        }
        const module=add(new URL(path,origin).href);
        await module.link((specifier, parent)=>{
          assert.ok(specifier.startsWith('./')||specifier.startsWith('../'),specifier);
          return add(new URL(specifier,parent.identifier).href);
        });
        await module.evaluate();
        return {module,context,modules};
      }
      const runtime='ricebox-js/distribution/runtime/';
      const {module:root}=await load(runtime+'root.js');
      const api=root.namespace.createRoot({base:new URL('ricebox/',origin).href,
        usedKey:'example-used',planKey:'example-plan',message:key=>key,missing:()=>'',errorText:String});
      const stages=[];
      api.watchLoad(stage=>stages.push(stage.at))();
      assert.deepEqual(stages,['prepare']);
      for(const path of [runtime+'worker.js', runtime+'check.worker.js', runtime+'translate.worker.js', 'ricebox-js/sods/runtime/linux/cpu.js']){
        const messages=[], listeners=[];
        const {context,modules}=await load(path,{
          postMessage(message){messages.push(message.type);},
          addEventListener(event,listener){assert.equal(event,'message');listeners.push(listener);},
        });
        assert.equal(typeof (context.onmessage ?? listeners[0]),'function',path);
        assert.deepEqual(messages,path.endsWith('/cpu.js')?['up']:[],path);
        if(path.endsWith('/cpu.js'))assert.ok(!modules.has(new URL('ricebox-js/sods/runtime/linux/process.js',origin).href),
          'guest CPU starts without loading the process kernel');
      }
      assert.deepEqual([...reached].sort(),[...browser.keys()].sort(),'core is exactly the root and module Worker closure');
      for(const [path,bytes] of withDisplay){
        if(browser.has(path))continue;
        const file=join(site,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes,{flag:'wx'});
      }
      const {module:display}=await load('ricebox-js/everyday/src/surface.js',{},withDisplay);
      assert.equal(typeof display.namespace.mountGuestSurface,'function');
      assert.deepEqual([...reached].sort(),[...withDisplay.keys()].sort(),'opt-in is exactly the added presenter closure');
      console.log('browser-modules-ok');
      if((await import('ricebox/vite')).distributionAssets!==distributionAssets)throw Error('Vite alias changed');
      console.log('static-assets-ok');
    `],{cwd:consumer,encoding:'utf8',timeout:30_000});
    assert.match(composed,/everyday-js-ok/);
    assert.match(composed,/static-assets-ok/);
    assert.match(composed,/browser-modules-ok/);
    // Synthetic distribution for packaging/staging only; its binaries do not run.
    const release=join(work,'shell-release');
    mkdirSync(join(release,'blobs'),{recursive:true});mkdirSync(join(release,'packs'));
    const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
    const blob=(text:string)=>{
      const bytes=Buffer.from(text),sha256=hash(bytes),path='blobs/'+sha256+'.bin';
      writeFileSync(join(release,path),bytes);
      return {path,sha256,size:bytes.length,bytes:bytes.length};
    };
    const translator=blob('translator'),maker=blob('muk'),rootSHA='a'.repeat(64);
    const shell=Buffer.from('guest payload placeholder, not executable machine code');
    const pack=packOf([shell],bytes=>createHash('sha256').update(bytes).digest());
    writeFileSync(join(release,'packs',pack.name),pack.bytes);
    const muk=Buffer.from(JSON.stringify(maker));writeFileSync(join(release,'muk.json'),muk);
    const descriptor=(version:string,path='/usr/bin/selected-shell', indexVersion=version)=>{
      const index=Buffer.from(JSON.stringify({sha256:rootSHA,version:indexVersion,codec:'zstd',dirs:[],
        links:[{path:'/bin',target:'usr/bin'},{path:'/usr/bin/terminal',target:'selected-shell'},
          {path:'/usr/bin/sh',target:'selected-shell'},
          {path:'/usr/bin/cycle',target:'cycle'}],translator,
        translations:[],packs:[{name:pack.name,bytes:pack.bytes.length}],
        files:[{path,mode:0o755,size:shell.length,pack:0,at:pack.at[0],len:shell.length,raw:true}],
      }));
      const sha256=hash(index),indexPath='index-'+sha256+'.json';
      writeFileSync(join(release,indexPath),index);
      const about=Buffer.from(JSON.stringify({sha256:rootSHA,version,index:{path:indexPath,sha256,size:index.length}}));
      writeFileSync(join(release,'webroot.json'),about);
      return hash(about);
    };
    const physicalPreview=join(work,'preview-owned'), preview=join(work,'preview'), staged=join(preview,'prefix');
    mkdirSync(physicalPreview);
    symlinkSync(physicalPreview,preview,'junction'); // An ordinary supported alias for the output parent.
    const declaration=join(work,'terminal.json');
    const source=(webPin:string,mukPin=hash(muk), terminal:unknown={argv:['/bin/terminal','-i'],cols:96}) =>
      ({guest:{directory:'./shell-release',webrootSha256:webPin,mukSha256:mukPin},terminal});
    const invokeStarter = (...args: string[]) => spawnSync('npm',
      ['exec', '--offline', '--', 'ricebox-stage-shell', ...args],
      {cwd: consumer, encoding: 'utf8', timeout: 15_000, env: {...process.env, npm_config_cache: join(work, 'empty-consumer-cache')}});
    const execStage=(value:unknown)=>{
      writeFileSync(declaration,JSON.stringify(value));
      return invokeStarter(declaration, staged);
    };
    const help = invokeStarter('--help');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /uses the bundled Ricebox guest/);
    assert.match(invokeStarter().stderr, /ricebox.json: declaration not found/);
    const webPin=descriptor(pkg.version);
    for (const [value, expected] of [
      [source('0'.repeat(64)),/webroot.json does not match/],
      [source(webPin,'0'.repeat(64)),/muk.json does not match/],
      [source(webPin,hash(muk),{argv:['/usr/bin/missing','-i']}),/executable .*missing.*not present/],
      [source(webPin,hash(muk),{argv:['/bin/cycle']}),/executable .*cycle.*not present/],
      [source(webPin,hash(muk),{argv:['/bin/terminal'],cols:241}),/Terminal geometry/],
      [source(webPin,hash(muk),{autoStart:'false'}),/autoStart must be true or false/],
      [source(webPin,hash(muk),{argv:['relative'],rows:30}),/absolute guest executable/],
      [{...source(webPin),display:{}},/only guest and terminal are supported/],
    ] as const) {
      const result=execStage(value);
      assert.equal(result.status,1,result.stderr);
      assert.match(result.stderr,expected);
      assert.ok(!existsSync(staged));
    }
    const mismatched=execStage(source(descriptor('9.8.7','/usr/bin/selected-shell','9.8.6')));
    assert.equal(mismatched.status,1,mismatched.stderr);
    assert.match(mismatched.stderr,/distribution and index disagree/);
    assert.ok(!existsSync(staged));
    // This authenticates a self-consistent descriptor; it does not relabel it to npm's version.
    const exactWebPin=descriptor('9.8.7');
    const packedFile=join(release,'packs',pack.name), changedPack=pack.bytes.slice();
    changedPack[changedPack.length-1]^=1;
    writeFileSync(packedFile,changedPack);
    const stalePack=execStage(source(exactWebPin));
    assert.equal(stalePack.status,1,stalePack.stderr);
    assert.match(stalePack.stderr,/not the file its table names/);
    assert.deepEqual(readdirSync(preview),[],'invalid input publishes nothing and leaves no private snapshot');
    writeFileSync(packedFile,pack.bytes);
    const stagedResult=execStage(source(exactWebPin));
    assert.equal(stagedResult.status,0,stagedResult.stderr);
    assert.deepEqual(readdirSync(preview),['prefix'],'success leaves only the selected output');
    assert.deepEqual(readdirSync(physicalPreview),['prefix'],'the same physical parent owns publication and cleanup');
    writeFileSync(packedFile,changedPack);
    assert.deepEqual(new Uint8Array(readFileSync(join(staged,'ricebox','packs',pack.name))),pack.bytes,
      'staged bytes belong to the verified snapshot, not the mutable source file');
    writeFileSync(packedFile,pack.bytes);
    const existing=execStage(source(exactWebPin));
    assert.equal(existing.status,1,existing.stderr);
    assert.match(existing.stderr,/Output already exists/);
    assert.deepEqual(readdirSync(preview),['prefix']);
    const stagedWebroot=readFileSync(join(staged,'ricebox/webroot.json'));
    assert.equal(hash(stagedWebroot),exactWebPin);
    assert.equal(JSON.parse(stagedWebroot.toString()).version,'9.8.7');
    assert.equal(hash(readFileSync(join(staged,'ricebox/muk.json'))),hash(muk));
    assert.deepEqual(JSON.parse(readFileSync(join(staged,'ricebox-starter.json'),'utf8')),{
      v:1,generation:JSON.parse(stagedWebroot.toString()).index.sha256,makerSha256:maker.sha256,
      program:'/usr/bin/selected-shell',writableHome:false,terminal:{argv:['/bin/terminal','-i'],cols:96,rows:24,autoStart:true},
    });
    assert.deepEqual(files(join(staged,'ricebox-js/everyday')).map(file=>file.slice(staged.length)).sort(),[
      '/ricebox-js/everyday/src/mirror-surface.js','/ricebox-js/everyday/src/surface.js',
      '/ricebox-js/everyday/terminal/vt-view.js','/ricebox-js/everyday/terminal/vt.js',
    ]);
    const everyday = await import(pathToFileURL(join(staged, 'everyday.js')).href);
    assert.equal(typeof everyday.mountGuestSurface, 'function');
    assert.equal(typeof everyday.surfaceFromMirror, 'function');
    const html=readFileSync(join(staged,'index.html'),'utf8'),siteURL=new URL('https://example.test/a/prefix/');
    const moduleURL=new URL(html.match(/script type="module" src="([^"]+)"/)![1]!,siteURL);
    const moduleRead=(url:URL)=>{
      assert.ok(url.href.startsWith(siteURL.href),url.href);
      return readFileSync(join(staged,url.href.slice(siteURL.href.length)),'utf8');
    };
    const js=moduleRead(moduleURL);
    const rootURL=new URL(js.match(/import\('([^']+root\.js)'\)/)![1]!,moduleURL);
    assert.ok(moduleRead(rootURL).includes('createRoot'));
    assert.ok(moduleRead(new URL('worker.js',rootURL)));
    // Evaluate the shipped page under a URL prefix with the actual npm runtime.
    // A missing release and interrupted module load exercise the UI without a guest.
    const boot=execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',`
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {join} from 'node:path';
      import {SourceTextModule,createContext} from 'node:vm';
      const files=${JSON.stringify(staged)}, prefix=${JSON.stringify(siteURL.href)};
      async function run(cancel, manual=false) {
        const fields=new Map(), events=new Map(), seen=[], workers=[];
        const document={
          getElementById(id) {
            if (!fields.has(id)) {
              const listeners = new Map();
              fields.set(id,{disabled:true,textContent:'',value:'',dataset:{},
                addEventListener(type,fn){listeners.set(type,fn);},
                click(){listeners.get('click')?.({isTrusted:true});},
                focus(){throw Error('starter must not take focus');}});
            }
            return fields.get(id);
          },
        };
        const context=createContext({
          document,window:{addEventListener(type,fn){events.set(type,fn);}},isSecureContext:true,location:{href:prefix},
          URL,WebAssembly,TextEncoder,TextDecoder,AbortController,performance,setTimeout,clearTimeout,setInterval,clearInterval,
          Worker:class {constructor(url){workers.push(url.href);throw Error('No Workers in this model');}},
          fetch: async url=>{
            seen.push(url);
            if(url===new URL('ricebox-starter.json',prefix).href) {
              const plan=JSON.parse(readFileSync(join(files,'ricebox-starter.json'),'utf8'));
              if (manual) plan.terminal.autoStart=false;
              return Response.json(plan);
            }
            return new Response(null,{status:404});
          },
        });
        const cache=new Map();
        let resume, started;
        const hold=new Promise(resolve=>{resume=resolve;});
        const importStarted=new Promise(resolve=>{started=resolve;});
        let imported;
        const importFinished=new Promise(resolve=>{imported=resolve;});
        function add(url) {
          assert.ok(url.startsWith(prefix),url);
          if (cache.has(url)) return cache.get(url);
          const m=new SourceTextModule(readFileSync(join(files,url.slice(prefix.length)),'utf8'),{
            context,identifier:url,initializeImportMeta(meta){meta.url=url;},
            async importModuleDynamically(specifier,parent) {
              if(cancel) {started(); await hold;}
              const importedModule=add(new URL(specifier,parent.identifier).href);
              if(importedModule.status==='unlinked') await importedModule.link(link);
              if(importedModule.status==='linked') await importedModule.evaluate();
              imported();
              return importedModule;
            },
          });
          cache.set(url,m);
          return m;
        }
        const link=(specifier,parent)=>add(new URL(specifier,parent.identifier).href);
        const page=add(${JSON.stringify(moduleURL.href)});
        await page.link(link);
        await page.evaluate();
        assert.equal(document.getElementById('open').disabled,true);
        const status=document.getElementById('status');
        if(cancel) {
          await importStarted;
          events.get('pagehide')();
          resume();
          await importFinished;
          await new Promise(resolve=>setImmediate(resolve));
          assert.equal(status.dataset.phase,'closed');
          assert.deepEqual(seen,[new URL('ricebox-starter.json',prefix).href]);
          assert.deepEqual(workers,[]);
        } else {
          const expected=[];
          if (manual) {
            for(let i=0;status.dataset.phase!=='closed'&&i<100;i++) await new Promise(resolve=>setTimeout(resolve,10));
            expected.push('ricebox-starter.json');
            assert.deepEqual(seen,expected.map(path=>new URL(path,prefix).href));
            assert.deepEqual(workers,[]);
            assert.equal(document.getElementById('open').disabled,false);
            document.getElementById('open').click();
          }
          expected.push('ricebox-starter.json','ricebox/webroot.json');
          for(let i=0;status.dataset.phase!=='error'&&i<100;i++) await new Promise(resolve=>setTimeout(resolve,10));
          assert.deepEqual(seen,expected.map(path=>new URL(path,prefix).href),status.textContent);
          assert.deepEqual(workers,[new URL('ricebox-js/distribution/runtime/check.worker.js',prefix).href]);
          assert.match(status.textContent,/Could not attach the terminal.*webroot[.]json: 404/);
          assert.equal(document.getElementById('open').disabled,false);
          document.getElementById('open').click();
          for(let i=0;status.dataset.phase!=='error'&&i<100;i++) await new Promise(resolve=>setTimeout(resolve,10));
          expected.push('ricebox-starter.json','ricebox/webroot.json');
          assert.deepEqual(seen,expected.map(path=>new URL(path,prefix).href));
          assert.equal(workers.length,1,'a failed retry does not construct another checker');
          events.get('pagehide')();
        }
        assert.equal(document.getElementById('open').disabled,true);
        assert.equal(document.getElementById('line').disabled,true);
      }
      await run(false);
      await run(true);
      await run(false,true);
      console.log('starter-auto-error-ok');
    `],{cwd:consumer,encoding:'utf8',timeout:15_000});
    assert.match(boot,/starter-auto-error-ok/);
    for (const file of files(staged).map(path=>path.slice(staged.length))) {
      assert.doesNotMatch(file,/wayland|[.]tsx?$/);
    }
    assert.deepEqual(files(staged).filter(file=>file.endsWith('.css')), [join(staged,'shell.css')]);
    assert.match(moduleRead(new URL('shell.css',siteURL)), /overflow: auto/);
    const repeated=execStage(source(exactWebPin));
    assert.equal(repeated.status,1,repeated.stderr);
    assert.match(repeated.stderr,/Output already exists/);
    assert.equal(readFileSync(join(staged,'index.html'),'utf8'),html);

    // The conventional layout needs only the two trusted pins.
    symlinkSync(release, join(consumer, 'prepared'), 'junction');
    writeFileSync(join(consumer, 'ricebox.json'), JSON.stringify({guest: {webrootSha256: exactWebPin, mukSha256: hash(muk)}}));
    const defaults = invokeStarter();
    assert.equal(defaults.status, 0, defaults.stderr);
    const site = join(consumer, 'ricebox-site');
    assert.deepEqual(JSON.parse(readFileSync(join(site, 'ricebox-starter.json'), 'utf8')).terminal,
      {argv: ['/bin/sh', '-i'], cols: 80, rows: 24, autoStart: true});
    const nested = join(consumer, 'new-parent', 'tools', 'linux');
    writeFileSync(packedFile, changedPack);
    const invalidNested = invokeStarter('ricebox.json', nested);
    assert.equal(invalidNested.status, 1, invalidNested.stderr);
    assert.ok(!existsSync(join(consumer, 'new-parent')));
    writeFileSync(packedFile, pack.bytes);
    const validNested = invokeStarter('ricebox.json', nested);
    assert.equal(validNested.status, 0, validNested.stderr);
    assert.equal(readFileSync(join(nested, 'index.html'), 'utf8'), html);

    const previewRoot = join(work, 'preview-tmp');
    mkdirSync(previewRoot);
    const entry = join(consumer, 'node_modules', 'ricebox', pkg.bin['ricebox-stage-shell']);
    await withStarterPreview(entry, consumer, async url => {
      const asset = new URL('ricebox/packs/' + pack.name, url);
      const partial = await fetch(asset, {headers: {Range: 'bytes=1-3'}});
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get('content-range'), `bytes 1-3/${pack.bytes.length}`);
      assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), pack.bytes.subarray(1, 4));
      const invalid = await fetch(asset, {headers: {Range: `bytes=${pack.bytes.length}-`}});
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers.get('content-range'), `bytes */${pack.bytes.length}`);
      const presenter = await fetch(new URL('everyday.js', url), {method: 'HEAD'});
      assert.match(presenter.headers.get('content-type') ?? '', /^text\/javascript\b/);
      assert.equal((await fetch(new URL('package.json', url))).status, 404);
    }, {...process.env, TMPDIR: previewRoot});
    assert.deepEqual(readdirSync(previewRoot), []);

    const bundled = join(dirname(entry), 'default'), fresh = join(work, 'standalone');
    mkdirSync(bundled);
    mkdirSync(fresh);
    symlinkSync(release, join(bundled, 'prepared'), 'junction');
    const guest = {webrootSha256: exactWebPin, mukSha256: hash(muk)};
    writeFileSync(join(bundled, 'ricebox.json'), JSON.stringify({guest}));
    const fromBundle = (...args: string[]) => spawnSync(process.execPath, ['--no-experimental-strip-types', entry, ...args],
      {cwd: fresh, encoding: 'utf8', timeout: 15_000});
    const firstRun = fromBundle();
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const starter = (output: string) => JSON.parse(readFileSync(join(fresh, output, 'ricebox-starter.json'), 'utf8'));
    assert.equal(starter('ricebox-site').writableHome, true);
    assert.deepEqual(starter('ricebox-site').terminal, {argv: ['/bin/sh', '-i'], cols: 80, rows: 24, autoStart: true});
    writeFileSync(join(fresh, 'ricebox.json'), JSON.stringify({terminal: {cols: 104}}));
    const changed = fromBundle('ricebox.json', 'changed');
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(starter('changed').writableHome, true);
    assert.equal(starter('changed').terminal.cols, 104);
    writeFileSync(join(fresh, 'ricebox.json'), JSON.stringify({guest: {...guest, directory: release, mukSha256: 'b'.repeat(64)}}));
    const badOverride = fromBundle('ricebox.json', 'invalid');
    assert.equal(badOverride.status, 1);
    assert.match(badOverride.stderr, /muk.json does not match/);
    assert.ok(!existsSync(join(fresh, 'invalid')));

    assert.throws(()=>execFileSync(process.execPath,[builder,out],{stdio:'pipe',timeout:30_000}),/Refusing to replace/);
  } finally {rmSync(work,{recursive:true,force:true});}
});
