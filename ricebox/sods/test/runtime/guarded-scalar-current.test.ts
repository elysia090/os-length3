import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {captureExecutableSource} from '../../runtime/linux/executable-source.ts';
import {Description, FdTable} from '../../runtime/linux/fd.ts';
import {GuardedFault} from '../../runtime/linux/guarded-inline-memory.ts';
import {GuardedScalarProbe, guardedScalarCompiler} from '../../runtime/linux/guarded-scalar-probe.ts';
import {E, FsError, mountTarget} from '../../runtime/linux/fs.ts';
import {loadTranslator} from '../../runtime/translate.ts';
import {Kernel, Process, type Image} from '../../runtime/linux/process.ts';

const translator = process.env.SODS_GUARDED_TRANSLATOR_WASM;
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const skip = !translator ? 'needs explicitly selected guarded translator' : process.platform !== 'linux' || process.arch !== 'x64';
const assembly = `
.section .text
.globl rx_scalar
.type rx_scalar,@function
rx_scalar:
  movq -8(%rdi),%rax
  movq %rax,16(%rsi)
  ret
.size rx_scalar,.-rx_scalar
.globl rx_reject
.type rx_reject,@function
rx_reject:
  nop
  movq -8(%rdi),%rax
  movq %rax,16(%rsi)
  ret
.size rx_reject,.-rx_reject
.section .note.GNU-stack,"",@progbits
`;
/** Native kernel control of the very same DSO bytes; scopes only one scalar access pair. */
const native = `
#define _GNU_SOURCE
#include <assert.h>
#include <dlfcn.h>
#include <inttypes.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>
typedef uint64_t(*F)(const void*,void*);
static int denies(F call,const void *src,void *dst) {
  pid_t child=fork(); assert(child>=0);
  if(!child) {
    struct rlimit lim={0,0}; assert(!setrlimit(RLIMIT_CORE,&lim));
    (void)call(src,dst);
    _exit(0);
  }
  int status=0; assert(waitpid(child,&status,0)==child);
  return WIFSIGNALED(status) && WTERMSIG(status)==SIGSEGV;
}
int main(int argc,char **argv) {
  const size_t P=4096; assert(argc==2 && sysconf(_SC_PAGESIZE)==P);
  void *m=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL); assert(m);
  F call=(F)dlsym(m,"rx_scalar"); assert(call);
  unsigned char *src=mmap(0,P*2,3,MAP_SHARED|MAP_ANONYMOUS,-1,0), *dst=mmap(0,P*2,3,MAP_SHARED|MAP_ANONYMOUS,-1,0);
  assert(src!=MAP_FAILED && dst!=MAP_FAILED);
  uint64_t in=UINT64_C(0x1234abcd8765dcb1), out=0, prefix=99;
  memcpy(src+40,&in,8); const uint64_t got=call(src+48,dst); memcpy(&out,dst+16,8);
  assert(!mprotect(dst+P,P,PROT_READ));
  assert(denies(call,src+48,dst+P-20)); memcpy(&prefix,dst+P-4,8);
  assert(!mprotect(src+P,P,PROT_NONE));
  assert(denies(call,src+P+8,dst));
  printf("{\\"returned\\":\\"%" PRIx64 "\\",\\"stored\\":\\"%" PRIx64 "\\",\\"wordAfterDeniedStore\\":\\"%" PRIx64 "\\",\\"readFault\\":true,\\"storeFault\\":true}\\n",got,out,prefix);
  assert(!munmap(src,P*2) && !munmap(dst,P*2) && !dlclose(m));
}
`;
const P = 4096, B = 65536, S = 2 * B, T = 3 * B, R = 1, RW = 3;
const X = 0x1234abcd8765dcb1n;
const mem = () => Object.assign(new WebAssembly.Memory({initial:2}), {users:1, written:[], keeps:false, imageOf:null});

test('actual source-built Sods guarded x86 scalar lowering: bytes, faults, code retirement and real Process lifetime', {skip}, async () => {
  const artifact=readFileSync(translator!);
  const compiler=await guardedScalarCompiler(artifact,process.env.SODS_GUARDED_TRANSLATOR_SHA256 ?? '');
  const stock=await loadTranslator(artifact);
  const work = mkdtempSync(join(tmpdir(), 'sods-guarded-scalar-'));
  try {
    const input = join(work, 'two.S'), out = join(work, 'two.so');
    writeFileSync(input, assembly);
    execFileSync('cc', ['-nostdlib','-shared','-fPIC','-Wl,-z,now,-z,relro,-z,noexecstack,--build-id=none',input,'-o',out]);
    const bytes = readFileSync(out), sha = hash(bytes), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const c=join(work,'native.c'), executable=join(work,'native');
    writeFileSync(c,native);
    execFileSync('cc',['-O2','-Wall','-Wextra','-Werror','-Wl,-z,now,-z,relro,-z,noexecstack',c,'-ldl','-o',executable]);
    const nativeEffect=JSON.parse(execFileSync(executable,[out],{encoding:'utf8',env:{LC_ALL:'C'}}));
    const symbols = execFileSync('readelf',['--dyn-syms','-W',out],{encoding:'utf8'});
    const symbol = (name: string) => {
      const row = symbols.split('\n').find(s => s.trimEnd().endsWith(' ' + name));
      assert(row);
      const [,a,n] = row.trim().split(/\s+/);
      return [Number.parseInt(a!,16), Number(n!)] as const;
    };
    const exited=join(work,'exit'), start=join(work,'exit.S');
    writeFileSync(start,'.section .text\n.globl _start\n_start: mov $60,%eax; mov $37,%edi; syscall\n.section .note.GNU-stack,"",@progbits\n');
    execFileSync('cc',['-nostdlib','-static','-no-pie','-Wl,--build-id=none',start,'-o',exited]);
    const [good,n] = symbol('rx_scalar'), [wrong,m] = symbol('rx_reject');
    const load = (addr: number) => {
      for (let i = 0, a = Number(view.getBigUint64(32,true)); i < view.getUint16(56,true); ++i, a += view.getUint16(54,true)) {
        const off = Number(view.getBigUint64(a+8,true)), va = Number(view.getBigUint64(a+16,true));
        if (view.getUint32(a,true)===1 && view.getUint32(a+4,true)===5 && addr>=va && addr<va+Number(view.getBigUint64(a+32,true)))
          return {address:B+Math.floor(va/P)*P,fileOffset:Math.floor(off/P)*P,length:P,flags:0x812,prot:5};
      }
      throw new Error('fixture has no executable file segment');
    };
    const req = load(good);
    assert.deepEqual(load(wrong),req);
    const one = () => {
      const k=new Kernel({translate:stock,x87:stock.module,console:{write() {},read:() => new Uint8Array()}});
      const p = new Process(k,null);
      p.memory=mem(); p.image={facts:{}} as Image;
      p.fixed=[]; p.free=[]; p.mapBase=B; p.mapEnd=B; p.stackLow=0; p.stackTop=B;
      const path='/lib/two.so';
      const file = mountTarget(k.vfs).file(path,0o444,bytes.length,() => new Uint8Array(bytes),sha);
      const source=captureExecutableSource(k.vfs,path,{origin:sha,size:bytes.length});
      const fd=p.fds.install(new Description('file',{node:file,mnt:k.vfs.mount}));
      const g=new GuardedScalarProbe(p,compiler);
      return {p,g,source,fd,k};
    };
    const setup = async () => {
      const q=one(), {g,source,fd}=q, proof=await g.authenticate(source,sha);
      assert(proof);
      assert(g.installCode(proof,fd,req));
      const init = new Uint8Array(P); new DataView(init.buffer).setBigUint64(40,X,true);
      g.installData(S,2*P,RW,init); g.installData(T,2*P,RW);
      return {...q,proof};
    };
    const q=await setup();
    try {
      const {g,p,source,proof,fd}=q;
      const run=g.prepare(BigInt(B+good),n);
      assert(run);
      assert.equal(run.next,BigInt(B+good+n-1)); // RET boundary, not executed by the probe
      assert.equal(g.prepare(BigInt(B+wrong),m),null);
      assert.equal(g.read(BigInt(T+16),8),0n); // rejection did not run any fallback
      const returned=run.run(BigInt(S+48),BigInt(T)); assert.equal(returned,X);
      const stored=g.read(BigInt(T+16),8); assert.equal(stored,X);
      assert.equal(g.read(BigInt(T+8),8),0n);
      assert.equal(g.read(BigInt(T+24),8),0n);
      assert.throws(()=>run.run((1n<<32n)+BigInt(S+48),BigInt(T)), e=>e instanceof GuardedFault && e.kind==='unmapped');
      assert.equal(g.read(BigInt(T+16),8),X);
      assert(g.protect(T+P,P,R));
      assert.throws(()=>run.run(BigInt(S+48),BigInt(T+P-20)), e=>e instanceof GuardedFault && e.kind==='permission' && e.address===BigInt(T+P));
      const wordAfterDeniedStore=g.read(BigInt(T+P-4),8); assert.equal(wordAfterDeniedStore,0n);
      assert(g.protect(S+P,P,0));
      assert.throws(()=>run.run(BigInt(S+P+8),BigInt(T)),e=>e instanceof GuardedFault && e.kind==='permission' && e.address===BigInt(S+P));
      assert.deepEqual({returned:returned.toString(16),stored:stored.toString(16),wordAfterDeniedStore:wordAfterDeniedStore.toString(16),readFault:true,storeFault:true}, nativeEffect);
      console.log(JSON.stringify({nativeEffect,guestBoundary:'before RET',artifactSha256:sha}));
      g.unmap(req.address,P);
      assert(g.installCode(proof,fd,req));
      assert.throws(()=>run.run(BigInt(S+48),BigInt(T)), /lease expired/);
      const again=g.prepare(BigInt(B+good),n);
      assert(again);
      const old=p.memory;
      const pending=g.authenticate(source,sha);
      p.memory=mem();
      p.memory=old; // the actual Process setter advances generation on ABA
      await assert.rejects(pending,/lifetime expired/);
      assert.throws(()=>again.run(BigInt(S+48),BigInt(T)),/already retired/);
    } finally {q.g.close();}
    for (const change of ['image','fds','zombie','task']) {
      const {p,g,k}=await setup();
      try {
        const run=g.prepare(BigInt(B+good),n);
        assert(run);
        if (change==='image') p.image={facts:{}} as Image; // same actual generation setter used by exec
        if (change==='fds') p.fds=new FdTable();
        if (change==='zombie') { k.exitProcess(p,37 << 8); assert.equal(p.state,'zombie'); }
        if (change==='task') p.tasks.add(k.newTask(p)); // admission may never coexist with a stock runnable Task
        assert.throws(()=>run.run(BigInt(S+48),BigInt(T)),/lifetime expired/);
      } finally {g.close();}
    }
    const live=await setup();
    try {
      const {p,g,k}=live, compiled=g.prepare(BigInt(B+good),n);
      assert(compiled);
      assert.throws(()=>p.execve('/bin/absent',[],[]), (e:unknown)=>e instanceof FsError && e.errno===E.NOENT);
      assert.equal(compiled.run(BigInt(S+48),BigInt(T)),X);
      k.vfs.writeFile('/bin/exit',readFileSync(exited),0o755);
      const task=k.newTask(p); p.task=task; p.tasks.add(task);
      p.execve('/bin/exit',['/bin/exit'],[]);
      assert.equal(p.exe,'/bin/exit');
      assert.throws(()=>compiled.run(BigInt(S+48),BigInt(T)),/lifetime expired/);
      k.exitProcess(p,37 << 8);
    } finally { live.g.close(); }
  } finally {rmSync(work,{recursive:true,force:true});}
});
