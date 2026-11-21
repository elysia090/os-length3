import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {captureExecutableSource} from '../../runtime/linux/executable-source.ts';
import {E, FsError, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {Task} from '../../runtime/linux/process.ts';
import {guardedStaticTask} from '../support/guarded-static-task.ts';

const BASE = 0x400000, BAD = 0x500000, PATH = '/proof/static';
const art = process.env.SODS_GUARDED_TASK_TRANSLATOR_WASM;
const skip = !art ? 'needs independently pinned guarded Task translator' : process.platform !== 'linux' || process.arch !== 'x64';
const sha = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const ld = `
ENTRY(_start)
PHDRS { load PT_LOAD FILEHDR PHDRS FLAGS(5); stack PT_GNU_STACK FLAGS(6); }
SECTIONS {
 . = ${BASE} + SIZEOF_HEADERS;
 .text : { *(.text) } :load
 /DISCARD/ : { *(*) }
}
`;
const STACK_PAGE = (16 << 20) - 2*4096; // intentionally guard-only VA in these two tests
const exitA = 'mov %rax,%rdi; mov $60,%eax; syscall';
const write8 = 'mov $1,%eax; mov $1,%edi; mov $8,%edx; syscall';
const marker = 'movabs $0x0a44455453555254,%rax; push %rax';
const sources = {
  stackAndCall: `${marker}; push %rsp; call leaf; mov (%rsp),%rsi; ${write8}; ${exitA}; leaf: mov $77,%edx; ret`,
  argc: 'mov (%rsp),%rdi; mov $60,%eax; syscall',
  missingWrite: `mov $${BAD},%esi; ${write8}; ${exitA}`,
  upperAliasWrite: `movabs $${(1n << 32n) + BigInt(BASE)},%rsi; ${write8}; ${exitA}`,
  readOnlyPush: `mov $${BASE + 8},%esp; mov $88,%eax; push %rax; ${exitA}`,
  readOnlyCall: `mov $${BASE + 8},%esp; call leaf; ${exitA}; leaf: ret`,
  unmappedRet: `mov $${BAD},%esp; ret`,
  noexecRet: 'mov %rsp,%rax; push %rax; ret',
  noncanonicalRet: 'movabs $0x0200000000000000,%rax; push %rax; ret',
  cachedCodeRevoke: `call cached; mov $10,%eax; mov $${BASE},%edi; mov $4096,%esi; mov $1,%edx;
    call revoke; ${exitA}; revoke: syscall; .globl cached; cached: ret`,
  protectedStackWrite: `mov $10,%eax; mov $${STACK_PAGE},%edi; mov $4096,%esi; mov $0,%edx; syscall;
    mov %rsp,%rsi; ${write8}; ${exitA}`,
  protectCannotGrow: `mov $10,%eax; mov $${STACK_PAGE},%edi; mov $4096,%esi; mov $0,%edx; syscall;
    mov $10,%eax; mov $1,%edx; syscall; ${exitA}`,
  rejectsOpcode: 'nop; mov $15,%edi; mov $60,%eax; syscall',
  rejectsSyscall: `mov $39,%eax; syscall; ${exitA}`,
} as const;

interface Result {status: number; stdout: string; stderr: string}
const native = (p: string): Result => {
  const r = spawnSync('/bin/sh',['-c','ulimit -c 0; exec "$1"','static-fixture',p],{
    env:{LC_ALL:'C',PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});
  assert.ifError(r.error);
  assert(r.signal === null || r.signal === 'SIGSEGV');
  assert(r.status !== null || r.signal === 'SIGSEGV');
  return {status:r.signal === 'SIGSEGV' ? 11 : r.status! << 8, stdout:r.stdout, stderr:r.stderr};
};

test('pinned Rust compiler emits checked x86 for a registered Sods Task: static native parity and retirement', {skip}, async t => {
  const compiler = readFileSync(art!);
  const compilerSha256 = process.env.SODS_GUARDED_TASK_TRANSLATOR_SHA256 ?? '';
  const dir = mkdtempSync(join(tmpdir(),'sods-guarded-live-task-'));
  try {
    const script = join(dir,'proof.lds');
    writeFileSync(script,ld);
    const outs = new Map<keyof typeof sources,{path: string; bytes: Buffer; digest: string}>();
    for (const [key,body] of Object.entries(sources)) {
      const path = join(dir,key), input = path + '.S';
      writeFileSync(input,'.file "guarded-static-fixture.S"\n.text\n.globl _start\n_start:\n' + body + '\n.section .note.GNU-stack,"",@progbits\n');
      execFileSync('cc',['-nostdlib','-static','-no-pie','-Wl,--build-id=none,-z,noexecstack','-T',script,input,'-o',path]);
      const bytes = readFileSync(path);
      outs.set(key as keyof typeof sources,{path,bytes,digest:sha(bytes)});
    }
    function fresh(key: keyof typeof sources, mode = 0o555) {
      const {path,bytes,digest} = outs.get(key)!;
      const vfs = new Vfs();
      const node = mountTarget(vfs).file(PATH,mode,bytes.length,() => new Uint8Array(bytes),digest);
      const source = captureExecutableSource(vfs,PATH,{origin:digest,size:bytes.length});
      return {path, node, start:{compiler,compilerSha256,vfs,path:PATH,source,elfSha256:digest}};
    }
    async function boot(key: keyof typeof sources, observe?: () => void) {
      const {path,node,start} = fresh(key);
      const output: [number,string][] = [];
      const stack = await guardedStaticTask({...start,write:(fd,bytes) => {
        output.push([fd,Buffer.from(bytes).toString('utf8')]); observe?.();
      }});
      const actual = (): Result => ({
        status:stack.kernel.pump().status!,
        stdout:output.filter(([fd]) => fd === 1).map(([,s]) => s).join(''),
        stderr:output.filter(([fd]) => fd === 2).map(([,s]) => s).join(''),
      });
      const {kernel, task} = stack;
      assert(task instanceof Task);
      assert.equal(kernel.procs.get(task.proc.pid),task.proc);
      assert.equal(kernel.tasks.get(task.tid),task);
      assert.deepEqual(kernel.runq,[task]);
      assert.equal(task.proc.tasks.size,1);
      assert.equal(task.proc.memory,null); // no second, ordinary raw backing
      assert.throws(() => task.bytes,/no raw guest bytes/);
      assert.throws(() => task.exports.run(task.resumeAt),{kind:'owner'}); // not an out-of-scheduler callable
      const ip = task.resumeAt;
      assert.equal(kernel.enter(task,60n,[99n],0n),-38n);
      assert.equal(task.resumeAt,ip);
      return {...stack, path, node, actual, initialSp:task.reg(4)};
    }

    for (const [key,expected] of [
      ['stackAndCall',{status:8<<8,stdout:'TRUSTED\n',stderr:''}],
      ['argc',{status:1<<8,stdout:'',stderr:''}],
      ['missingWrite',{status:242<<8,stdout:'',stderr:''}],
      ['upperAliasWrite',{status:242<<8,stdout:'',stderr:''}],
      ...(['readOnlyPush','readOnlyCall','unmappedRet','noexecRet','noncanonicalRet','cachedCodeRevoke'] as const)
        .map(key => [key,{status:11,stdout:'',stderr:''}] as const),
    ] as const) {
      const q = await boot(key);
      assert.deepEqual(native(q.path),expected,key + ': Linux executes the same ELF bytes');
      assert.deepEqual(q.actual(),expected,key + ': Task result');
      t.diagnostic(JSON.stringify({fixture:key,sha256:outs.get(key)!.digest,native:expected,guarded:expected}));
      assert(q.task.dead);
      assert.equal(q.kernel.tasks.size,0);
      assert.equal(q.kernel.procs.size,0);
      assert.equal(q.kernel.spareMemories.length,0);
      assert.equal(q.task.proc.memory,null);
      assert.throws(() => q.task.exports.run(q.task.resumeAt),{kind:'owner'});
      if (key === 'readOnlyPush' || key === 'readOnlyCall') {
        assert.equal(q.task.reg(4),BigInt(BASE+8)); // fault occurs before RSP commit
        assert.equal(q.fault()?.address,BigInt(BASE));
      }
      if (key === 'unmappedRet') assert.equal(q.task.reg(4),BigInt(BAD));
      if (key === 'noexecRet') {
        assert.equal(q.task.reg(4),q.initialSp); // data read and pop; first target execute denies
        assert.equal(q.fault()?.address,q.initialSp);
        assert.equal(q.fault()?.kind,'permission');
      }
      if (key === 'noncanonicalRet') assert.equal(q.task.reg(4),q.initialSp-8n); // RET rejects target before pop
      if (key === 'cachedCodeRevoke') {
        const row = execFileSync('readelf',['-Ws',q.path],{encoding:'utf8'}).split('\n').find(s => /\bcached$/.test(s));
        const address = BigInt('0x'+row!.trim().split(/\s+/)[1]);
        assert.equal(q.fault()?.address,address);
        assert.equal(q.fault()?.kind,'permission');
        assert.equal(q.task.reg(0),0n); // actual mprotect result, then cached RET refused
      }
    }

    const protectedStack = await boot('protectedStackWrite');
    assert.deepEqual(protectedStack.actual(),{status:242<<8,stdout:'',stderr:''});
    const growth = await boot('protectCannotGrow');
    assert.deepEqual(growth.actual(),{status:243<<8,stdout:'',stderr:''}); // -EACCES, not native mprotect promotion
    const unsupported = await boot('rejectsOpcode');
    assert.equal(unsupported.actual().status,4);
    assert.match(unsupported.actual().stderr,/unsupported instruction/);
    assert.equal(native(unsupported.path).status,15<<8); // explicit negative, not a claimed match
    const syscall = await boot('rejectsSyscall');
    assert.equal(syscall.actual().status,218<<8); // ENOSYS, no accidental ordinary getpid

    const noexec = fresh('stackAndCall',0o444), wrong = fresh('stackAndCall');
    await assert.rejects(guardedStaticTask({...noexec.start,write() {}}), e => e instanceof FsError && e.errno === E.ACCES);
    await assert.rejects(guardedStaticTask({...wrong.start,elfSha256:'0'.repeat(64),write() {}}), e => e instanceof FsError && e.errno === E.NOEXEC);
    await assert.rejects(guardedStaticTask({...wrong.start,compilerSha256:'0'.repeat(64),write() {}}), /SHA-256/);

    const reexec = await boot('stackAndCall');
    assert.throws(() => reexec.task.proc.execve(PATH,[PATH],[]), e => e instanceof FsError && e.errno === E.NOEXEC);
    assert.equal(reexec.actual().status,8<<8); // established owner survives failed ordinary exec
    const sameIdentity = await boot('stackAndCall');
    sameIdentity.task.proc.image = sameIdentity.task.proc.image; // Process owner ABA, even the same undefined image
    assert.deepEqual(sameIdentity.actual(),{status:11,stdout:'',stderr:''});
    assert.equal(sameIdentity.fault()?.kind,'owner');
    const written = await boot('stackAndCall');
    written.node.truncate(0);
    assert.deepEqual(written.actual(),{status:11,stdout:'',stderr:''}); // authenticated source revision revoked
    let current: Awaited<ReturnType<typeof boot>> | undefined;
    current = await boot('stackAndCall', () => {
      assert.throws(() => current!.kernel.pump(),/reentry/);
      assert.throws(() => current!.kernel.run(current!.task),/reentry/);
      current!.kernel.halt();
    });
    assert.deepEqual(current.actual(),{status:9,stdout:'TRUSTED\n',stderr:''});
    assert(current.task.dead);
    assert.throws(() => current!.task.exports.run(current!.task.resumeAt),{kind:'owner'});
    assert.equal(current.kernel.tasks.size,0);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});
