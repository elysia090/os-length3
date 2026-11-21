import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {captureExecutableSource} from '../../runtime/linux/executable-source.ts';
import {E, File, FsError, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {guardedStaticTask} from '../support/guarded-static-task.ts';

const a = process.env.SODS_GUARDED_TASK_TRANSLATOR_WASM;
const expected = process.env.SODS_GUARDED_TASK_TRANSLATOR_SHA256 ?? '';
const skip = !a ? 'needs independently pinned guarded Task translator' : process.platform !== 'linux' || process.arch !== 'x64';
const f = fileURLToPath(new URL('../fixtures/guarded-multi-image/',import.meta.url));
const sha = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const primaryName = '/proof/primary', companionName = '/proof/companion';
const markers = 'SECOND!\nRESULT!\n';
const cases = [
  ['returnToPrimary',37<<8,markers],
  ['dropCompanionExecute',11,markers.repeat(2)],
  ['unmapCompanionExecute',11,markers.repeat(2)],
  ['noExecuteFromRW',11,''],
  ['noWriteToRO',11,''],
  ['noCopyFromPROT_NONE',242<<8,''],
] as const;

test('two independent mapped ELF identities cross and retire in one guarded Task, paired with Linux', {skip}, async t => {
  const work = mkdtempSync(join(tmpdir(),'sods-multi-image-'));
  try {
    const compiler = readFileSync(a!), companionElf = join(work,'companion'), native = join(work,'native');
    const assemble = (name: string, object: string, options: string[] = []) =>
      execFileSync('as',['--64',...options,join(f,name+'.S'),'-o',object]);
    const link = (name: string, object: string, out: string, options: string[] = []) =>
      execFileSync('ld',['--build-id=none','-z','noexecstack',...options,'-T',join(f,name+'.lds'),object,'-o',out]);
    assemble('secondary',join(work,'s.o'));
    link('secondary',join(work,'s.o'),companionElf,['--shared']);
    const dump = execFileSync('readelf',['-Whldr',companionElf],{encoding:'utf8'});
    assert.match(dump,/Type:\s+DYN/);
    assert.match(dump,/There is no dynamic section in this file/);
    assert.match(dump,/There are no relocations in this file/);
    assert.doesNotMatch(dump,/INTERP|DYNAMIC/);
    execFileSync('cc',['-Wall','-Wextra','-Werror','-O2','-fPIE','-pie','-Wl,-z,now,-z,relro,-z,noexecstack',
      join(f,'native.c'),'-o',native]);
    const second = readFileSync(companionElf), secondDigest = sha(second);
    assert.equal(second[8192],0xc3);
    const fixture = new Map<string,string>();
    const biasList = [0x600000,0x800000];
    for (const bias of biasList) for (const n of cases.keys()) {
      const out = join(work,`primary-${bias}-${n}`), object = out+'.o';
      assemble('primary',object,['--defsym',`scenario=${n}`,'--defsym',`bias=${bias}`]);
      link('primary',object,out,['--defsym',`companion_entry=${bias+4096}`,'--defsym',`rw_target=${bias+8192}`]);
      fixture.set(`${bias}/${n}`,out);
    }

    function fresh(bias: number, n: number, opts: {
      other?: Uint8Array; mode?: number;
      materialize?: (vfs: Vfs, main: Uint8Array) => void;
    } = {}) {
      const primaryElf = fixture.get(`${bias}/${n}`)!;
      const primary = readFileSync(primaryElf), primaryDigest = sha(primary);
      const raw = opts.other ?? second, companionDigest = sha(raw);
      const vfs = new Vfs(), m = mountTarget(vfs), precommit: boolean[] = [];
      m.file(primaryName,0o555,primary.length,() => new Uint8Array(primary),primaryDigest);
      const companion = m.file(companionName,opts.mode ?? 0o555,raw.length,() => {
        const r = vfs.walk('/proc/1/status');
        precommit.push(typeof r === 'number' || r.node === null);
        opts.materialize?.(vfs,primary);
        return new Uint8Array(raw);
      },companionDigest);
      const source = captureExecutableSource(vfs,primaryName,{origin:primaryDigest,size:primary.length});
      const companionSource = captureExecutableSource(vfs,companionName,{origin:companionDigest,size:raw.length});
      return {primaryElf, primaryDigest, companion, precommit, args:{
        compiler,compilerSha256:expected,vfs,path:primaryName,source,elfSha256:primaryDigest,write() {},
        companion:{path:companionName,source:companionSource,elfSha256:companionDigest,bias},
      }};
    }

    for (const bias of biasList) for (const [n,[name,status,stdout]] of cases.entries()) {
      const job = fresh(bias,n), out: Uint8Array[] = [], err: Uint8Array[] = [];
      const loaded = await guardedStaticTask({...job.args,write:(fd,bytes) => (fd === 1 ? out : err).push(bytes)});
      assert.deepEqual(job.precommit,[true]); // lazy file read saw no /proc/1 during admission
      assert.equal(loaded.kernel.tasks.get(loaded.task.tid),loaded.task);
      assert.equal(loaded.task.proc.memory,null);
      assert.equal(loaded.task.proc.fds.slots.size,3); // source FDs closed before publication
      const got = loaded.kernel.pump();
      const control = spawnSync(native,[job.primaryElf,companionElf,'0x'+bias.toString(16)],
        {env:{LC_ALL:'C',PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});
      assert.ifError(control.error);
      assert(control.signal === null || control.signal === 'SIGSEGV');
      const wanted = {status,stdout,stderr:''};
      const nativeEffect = {status:control.signal === 'SIGSEGV' ? 11 : control.status! << 8,
        stdout:control.stdout,stderr:control.stderr};
      const checkedEffect = {status:got.status,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()};
      assert.deepEqual(nativeEffect,wanted,`${name} native @ ${bias.toString(16)}`);
      assert.deepEqual(checkedEffect,nativeEffect,`${name} checked @ ${bias.toString(16)}`);
      const target = n === 3 ? bias+8192 : n === 4 ? bias+288 : n === 1 || n === 2 ? bias+4096 : null;
      if (target !== null) assert.equal(loaded.fault()?.address,BigInt(target));
      if (n === 1 || n === 2) assert.equal(loaded.task.reg(5),0n,'guarded retirement syscall succeeded');
      assert(loaded.task.dead);
      assert.equal(loaded.kernel.tasks.size,0);
      assert.equal(loaded.kernel.spareMemories.length,0);
      assert.equal(sha(job.companion.read(0,second.length)),secondDigest); // no writable alias into source
      assert.equal(sha(readFileSync(companionElf)),secondDigest);
      t.diagnostic(JSON.stringify({fixture:name,bias:'0x'+bias.toString(16),mainSha256:job.primaryDigest,
        companionSha256:secondDigest,native:nativeEffect,guarded:checkedEffect}));
    }

    const job = fresh(biasList[0]!,0), want = (x: unknown) => x instanceof FsError && x.errno === E.NOEXEC;
    await assert.rejects(guardedStaticTask({...job.args,companion:{...job.args.companion,elfSha256:'0'.repeat(64)}}),want);
    assert.deepEqual(job.precommit,[true],'rejected second digest still publishes no process during materialization');
    const overlap = fresh(biasList[0]!,0);
    await assert.rejects(guardedStaticTask({...overlap.args,companion:{...overlap.args.companion,bias:0x400000}}),want);
    const unaligned = fresh(biasList[0]!,0);
    await assert.rejects(guardedStaticTask({...unaligned.args,companion:{...unaligned.args.companion,bias:0x600001}}),want);
    const denied = fresh(biasList[0]!,0,{mode:0o444});
    await assert.rejects(guardedStaticTask(denied.args),x => x instanceof FsError && x.errno === E.ACCES);
    const aliased = fresh(biasList[0]!,0);
    await assert.rejects(guardedStaticTask({...aliased.args,companion:{...aliased.args.companion,
      path:primaryName,source:aliased.args.source,elfSha256:aliased.args.elfSha256}}),want);

    const mutated = new Uint8Array(second);
    new DataView(mutated.buffer).setUint32(64+2*56+4,7,true); // reject would-be writable code even with its own digest
    const wx = fresh(biasList[0]!,0,{other:mutated});
    await assert.rejects(guardedStaticTask(wx.args),want);
    const replaced = fresh(biasList[0]!,0,{materialize:(vfs,bytes) => {
      vfs.dir('/proof').entries.set('primary',new File(new Uint8Array(bytes),0o555));
    }});
    await assert.rejects(guardedStaticTask(replaced.args),want); // same bytes, wrong original file identity
    assert.deepEqual(replaced.precommit,[true]);

    const invalidated = fresh(biasList[0]!,0), emitted: Buffer[] = [];
    const after = await guardedStaticTask({...invalidated.args,write:(fd,bytes) => {
      assert.equal(fd,1);
      emitted.push(Buffer.from(bytes));
      if (emitted.length === 1) invalidated.companion.truncate(0);
    }});
    assert.equal(after.kernel.pump().status,11); // post-admission inode revision withdraws cached execution authority
    assert.equal(after.fault()?.address,BigInt(biasList[0]!+4096));
    assert.equal(Buffer.concat(emitted).toString(),markers); // earlier private data page snapshots are independent
  } finally { rmSync(work,{recursive:true,force:true}); }
});
