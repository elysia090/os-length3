import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const builder = fileURLToPath(new URL('npm.ts', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);
}
function unpack(work: string): string {
  const out=join(work,'built');
  execFileSync(process.execPath,[builder,out],{stdio:'pipe',timeout:30_000});
  const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--offline','--json','--pack-destination',work],
    {cwd:out,env:{...process.env,npm_config_cache:join(work,'cache')},encoding:'utf8',timeout:30_000}));
  const consumer=join(work,'consumer'),pkg=join(consumer,'node_modules/sods');mkdirSync(pkg,{recursive:true});
  execFileSync('tar',['-xf',join(work,packed[0].filename),'--strip-components=1','-C',pkg]);
  return consumer;
}
test('standalone tarball exposes only sods entrances and complete JS/Worker closure',()=>{
  const work=mkdtempSync(join(tmpdir(),'sods-package-'));
  try {
    const consumer=unpack(work),pkg=join(consumer,'node_modules/sods');
    const manifest=JSON.parse(readFileSync(join(pkg,'package.json'),'utf8'));
    assert.equal(manifest.private,true);assert.equal(manifest.dependencies,undefined);
    assert.deepEqual(Object.keys(manifest.exports),['./translate','./linux','./host','./targets']);
    assert.ok(existsSync(join(pkg,'runtime/linux/cpu.js')));
    for(const path of files(pkg).filter(p=>/\.(ts|js)$/.test(p))) {
      const source=readFileSync(path,'utf8');
      for(const m of source.matchAll(/['"](\.[^'"\n]+\.(?:ts|js))['"]/g)) assert.ok(existsSync(resolve(dirname(path),m[1])),`${path}: ${m[1]}`);
    }
    writeFileSync(join(consumer,'check.mjs'),`for(const name of ['translate','linux','host','targets']) await import('sods/'+name); console.log('ok');`);
    assert.match(execFileSync(process.execPath,['--no-experimental-strip-types','check.mjs'],{cwd:consumer,encoding:'utf8',timeout:30_000}),/ok/);
    assert.throws(()=>execFileSync(process.execPath,[builder,join(work,'built')],{stdio:'pipe'}),/Refusing to replace/);
  } finally {rmSync(work,{recursive:true,force:true});}
});
const core=process.env.SODS_CORE_WASM,translator=process.env.SODS_TRANSLATOR_WASM;
test('installed package runs real ELF inline and in Node CPU Worker with explicit Rust file scope',{skip:!core||!translator},()=>{
  const work=mkdtempSync(join(tmpdir(),'sods-execution-'));
  try {
    const consumer=unpack(work);
    writeFileSync(join(work,'exit.s'),'.global _start\n.text\n_start:\n mov $2,%rax\n lea path(%rip),%rdi\n mov $66,%rsi\n mov $420,%rdx\n syscall\n mov %rax,%r12\n mov %rax,%rdi\n mov $1,%rax\n lea message(%rip),%rsi\n mov $3,%rdx\n syscall\n mov $3,%rax\n mov %r12,%rdi\n syscall\n mov $60,%rax\n mov $42,%rdi\n syscall\n.section .rodata\npath: .asciz "/created"\nmessage: .ascii "new"\n');
    execFileSync('cc',['-nostdlib','-static','-Wl,--build-id=none',join(work,'exit.s'),'-o',join(work,'exit')]);
    writeFileSync(join(work,'zero.s'),readFileSync(join(work,'exit.s'),'utf8').replace('mov $42,%rdi','mov $0,%rdi'));
    execFileSync('cc',['-nostdlib','-static','-Wl,--build-id=none',join(work,'zero.s'),'-o',join(work,'zero')]);
    writeFileSync(join(consumer,'run.mjs'),`
      import assert from 'node:assert/strict'; import {readFileSync,writeFileSync} from 'node:fs';
      import {linux,RemoteKernel,prepareFileCore,loadFileScope} from 'sods/linux';
      import {loadTranslator} from 'sods/translate';
      const module=await prepareFileCore(readFileSync(${JSON.stringify(core)}),1048576);
      const quarantined=[];
      for(const inline of [true,false]) for(const code of [0,42]) for(const refusal of (!inline && code===0 ? ['none','sink','stop','preparation'] : ['none'])) {
        const scope=await loadFileScope(module,1048576),vfs=scope.createVfs();
        const file=scope.writeFile(vfs,'/bin/exit',readFileSync(code ? ${JSON.stringify(join(work,'exit'))} : ${JSON.stringify(join(work,'zero'))}),0o755);
        const translate=await loadTranslator(readFileSync(${JSON.stringify(translator)}));
        const k=linux({vfs,translate,inline,passOn:false,console:{write(){},read:()=>null}});
        assert.equal(k instanceof RemoteKernel,!inline);
        const adopted=[];
        if(k instanceof RemoteKernel) {
          const adopt=k.adoptWorker.bind(k);
          k.adoptWorker=hand=>{adopted.push(hand);return adopt(hand);}; // Observe actual host adoption, without changing ownership.
        }
        // spawn drives the selected scheduler, including the RemoteKernel door.
        // Failure destroys this test's child realm, never a live scope in place.
        assert.equal(await k.spawn('/bin/exit',['/bin/exit'],[],'/'),code << 8);
        assert.equal(new TextDecoder().decode(vfs.file('/created').bytes()),'new');
        assert.throws(()=>vfs.file('/created').data);
        // This finite caller owns the complete graph and publishes only copied bytes.
        // Guest exit, host-stop evidence and sink acknowledgement are separate gates.
        const result=vfs.file('/created').bytes(); // Rust File.bytes already returns an owned snapshot.
        let accepted=false;
        await Promise.resolve().then(()=>{if(refusal!=='sink'){writeFileSync('result.bin',result);accepted=true;}});
        if(accepted) assert.deepEqual(readFileSync('result.bin'),Buffer.from('new'));
        assert.equal(k.tasks.size,0); assert.equal(k.runq.length,0); assert.equal(k.blocked.size,0);
        assert.equal(k.current,null); assert.equal(k.failedPreparations?.size ?? 0,0);
        let stopped=inline;
        if(k instanceof RemoteKernel) {
          k.close(); // synchronous request, not by itself a stop barrier
          const evidence=await k.snapshotWorkerStops();
          assert.ok(adopted.length>0); // Real Node execution, independent of remaining snapshot size.
          const allStops=await Promise.all(adopted.map(hand=>hand.stop.evidence()));
          assert.ok(allStops.every(result=>result.stopped && !('requestFailure' in result) && !('notificationFailure' in result)));
          assert.equal(evidence.unconfirmed,0);
          assert.equal(evidence.observedStopped,evidence.captured); assert.deepEqual(evidence.failures,[]);
          stopped=refusal!=='stop'; // Explicit evidence-loss injection, after real Node stop.
        }
        if(refusal==='preparation') k.failedPreparations=new Set([{}]); // Inject unresolved evidence, not a real failed fork.
        if(!accepted || !stopped || k.failedPreparations?.size) {
          assert.notEqual(refusal,'none');
          assert.deepEqual(vfs.file('/created').bytes(),result); // scope remains live, not disposed
          quarantined.push({scope,k});
          continue; // This finite test realm owns the retained graph until process exit.
        }
        assert.equal(refusal,'none');
        // No rehearsal, passOn, continuing callbacks or external raw graph users.
        // After this point the caller promises no further use of this graph.
        scope.dispose();
        assert.deepEqual(result,new TextEncoder().encode('new'));
        assert.throws(()=>file.bytes(),/scope is closed/);
      }
      assert.equal(quarantined.length,3);
      console.log('execution-ok');
    `);
    const env={...process.env};delete env.SODS_INLINE;
    assert.match(execFileSync(process.execPath,['--no-experimental-strip-types','run.mjs'],{cwd:consumer,env,encoding:'utf8',timeout:30_000}),/execution-ok/);
  } finally {rmSync(work,{recursive:true,force:true});}
});
