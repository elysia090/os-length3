import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {captureExecutableSource} from '../../runtime/linux/executable-source.ts';
import {E, FsError, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {guardedStaticTask} from '../support/guarded-static-task.ts';

const fixture=process.env.SODS_GUARDED_INTERPRETER_FIXTURE;
const producer=process.env.SODS_GUARDED_TASK_TRANSLATOR_WASM;
const producerHash=process.env.SODS_GUARDED_TASK_TRANSLATOR_SHA256 ?? '';
const beforeProducer=process.env.SODS_GUARDED_INTERPRETER_PREVIOUS_WASM;
const beforeProducerHash='2deae347e29e496cd9f16862f630b02be5500c529300510f4735c95809f2361a';
const skip=!fixture||!producer ? 'needs published diagnostic predecessor and pinned true PIE/GNU interpreter fixture' :
  process.platform!=='linux'||process.arch!=='x64';
const h=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const mainPath='/bin/tiny', ldPath='/lib64/ld-linux-x86-64.so.2', libPath='/lib/librxleaf.so.1';
const mainSha='e5ed560e7782d30d9971efff3c64a6b08c1d12333e7170a47c18c768b066eeef';
const ldSha='c8438e4fde1934e61c88311633f00949ff645d5c04cdb8671fa3d78164d2f307';
const libSha='e6deb4a8e325c0f851cbec4a6d58469baaf258354b1b5ff070de56a3f1bae38b';
const leafStdout='RX_DYN_TINY before_shared_call\nRX_DYN_TINY after_shared_call=37\n';
const at=(base:number,offset:number)=>BigInt(base+offset), hex=(x:bigint)=>'0x'+x.toString(16);

test('exact GNU ld.so starts on guarded Linux entry stack; first real RIP-relative LEAs execute', {skip}, async t=>{
  const mainBytes=readFileSync(join(fixture!,mainPath)), ldBytes=readFileSync(join(fixture!,ldPath)), compiler=readFileSync(producer!);
  assert.equal(h(mainBytes),mainSha);
  assert.equal(h(ldBytes),ldSha);
  assert.equal(h(readFileSync(join(fixture!,libPath))),libSha);
  assert.equal(h(readFileSync(ldPath)),ldSha,'native PT_INTERP maps exactly the same interpreter');
  const normal=spawnSync(join(fixture!,mainPath),[],{env:{},encoding:'utf8',timeout:5000});
  assert.ifError(normal.error);
  assert.equal(normal.signal,null);
  assert.equal(normal.status,37);
  assert.equal(normal.stdout,leafStdout);
  assert.equal(normal.stderr,'');
  // This actual native ld.so reports the kernel auxv and its own real
  // linking decisions; the environment is observed, not described as equal
  // to the empty-env guarded stack, and no native stepped registers are inferred.
  const actual=spawnSync(join(fixture!,mainPath),[],{env:{LD_SHOW_AUXV:'1',LD_DEBUG:'files,reloc,bindings'},encoding:'utf8',timeout:5000});
  assert.ifError(actual.error);
  assert.equal(actual.status,37);
  assert(actual.stdout.endsWith(leafStdout));
  assert.match(actual.stderr,/file=librxleaf\.so\.1.*generating link map/);
  assert.match(actual.stderr,/binding file .*\/bin\/tiny .* to .*\/lib\/librxleaf\.so\.1 .*normal symbol .rx_leaf/);
  const nativeAux=new Map([...actual.stdout.matchAll(/^(AT_[A-Z0-9_]+):\s+(.+)$/gm)].map(([,k,v])=>[k,v]));
  assert.equal(nativeAux.get('AT_PLATFORM'),'x86_64');
  const nat=(name:string)=>BigInt(nativeAux.get(name)!);
  assert.equal(nat('AT_FLAGS'),0n);
  assert.equal(nat('AT_ENTRY')-nat('AT_PHDR'),0xfe0n);
  function setup(mainBias:number,ldBias:number) {
    const vfs=new Vfs(), root=mountTarget(vfs);
    const primary=root.file(mainPath,0o555,mainBytes.length,()=>new Uint8Array(mainBytes),mainSha);
    const interp=root.file(ldPath,0o555,ldBytes.length,()=>new Uint8Array(ldBytes),ldSha);
    const source=captureExecutableSource(vfs,mainPath,{origin:mainSha,size:mainBytes.length});
    const second=captureExecutableSource(vfs,ldPath,{origin:ldSha,size:ldBytes.length});
    const out: {fd:number; text:string}[]=[];
    return {primary,interp,out,args:{compiler,compilerSha256:producerHash,vfs,path:mainPath,source,elfSha256:mainSha,
      write(fd:number,b:Uint8Array){out.push({fd,text:new TextDecoder().decode(b)});},
      interpreter:{path:ldPath,source:second,elfSha256:ldSha,bias:ldBias,mainBias}}};
  }
  for (const [mainBias,ldBias] of [[0x400000,0x800000],[0x500000,0x900000]] as const) {
    const {args,out}=setup(mainBias,ldBias);
    const p=await guardedStaticTask(args), boot=p.entryReceipt(0x3ff8);
    assert.equal(p.task.proc.memory,null);
    assert.equal(p.task.proc.fds.slots.size,3);
    const {aux}=boot;
    assert.equal(boot.entry,at(ldBias,0x1d2c0)); // MAP/ELF entry, not a chosen synthetic PC
    assert.deepEqual(boot.entryBytes,Uint8Array.of(0x48,0x89,0xe7));
    assert.equal(boot.sp%16n,0n);
    assert.equal(boot.argc,1n);
    assert.equal(boot.argv0,mainPath);
    assert.equal(boot.argvEnd,0n);
    assert.equal(boot.envEnd,0n);
    assert.equal(boot.platform,nativeAux.get('AT_PLATFORM'));
    assert.equal(boot.execfn,mainPath);
    assert(boot.randomReadable);
    for (const [tag,name] of [[4,'AT_PHENT'],[5,'AT_PHNUM'],[6,'AT_PAGESZ'],[8,'AT_FLAGS'],[17,'AT_CLKTCK'],[23,'AT_SECURE']] as const)
      assert.equal(aux.get(tag),nat(name),name);
    assert.equal(aux.get(3),at(mainBias,0x40));
    assert.equal(aux.get(7),BigInt(ldBias));
    assert.equal(aux.get(9),at(mainBias,0x1020));
    assert.equal(aux.get(9)!-aux.get(3)!,nat('AT_ENTRY')-nat('AT_PHDR'));
    assert.equal(boot.mainFirstPhdr,6n); // actual guarded read of PT_PHDR
    assert.equal(aux.has(16) || aux.has(26) || aux.has(33),false); // no CPU/vDSO claims
    assert.equal(boot.mainWord,0x1016n); // untouched pre-relocation GOT, NOT a resolved address
    assert.deepEqual(boot.ldBss,[{first:ldBias+0x36b4c,length:0xa9c,zero:true}]);
    assert.equal(boot.plans.main.loads.find(s=>s.start===mainBias+0x3000)!.prot,3); // kernel exec still leaves RELRO RW
    assert.equal(boot.plans.ld.loads.filter(s=>s.prot===5).length,1);
    assert.equal(p.kernel.pump().status,4);
    const observed=p.interpreterTrace(), states=observed.steps;
    const offsets=[0x1d2c0,0x1d2c3,0x1de30,0x1de31,0x1de38,0x1de3f,0x1de44,0x1de49,0x1de4d,
      0x1de50,0x1de52,0x1de54,0x1de56,0x1de58,0x1de59,0x1de60,0x1de67,0x1de6b];
    assert.deepEqual(states.map(s=>s.rip),offsets.map(k=>at(ldBias,k)));
    assert.deepEqual(states.map(s=>s.rsp-boot.sp),[0n,0n,-8n,-16n,-16n,-16n,-16n,-16n,-16n,
      -16n,-24n,-32n,-40n,-48n,-56n,-192n,-192n,-192n]);
    assert.deepEqual(states.slice(0,15).map(s=>s.flags),Array(15).fill(states[0]!.flags));
    assert.deepEqual(states.slice(15).map(s=>s.flags),Array(3).fill(states[15]!.flags));
    assert.equal(states[1]!.rdi,boot.sp);
    assert.equal(states[2]!.stackWord,at(ldBias,0x1d2c8));
    assert.equal(states[3]!.stackWord,states[2]!.rbp);
    assert.equal(states[4]!.rsi,BigInt(ldBias));  // LEA #1 made the actual ELF base
    assert.equal(states[5]!.rax,at(ldBias,0x375e8));
    assert.deepEqual([states[6]!.xmm2Low,states[6]!.xmm2High],[BigInt(ldBias),0n]);
    assert.deepEqual([states[7]!.xmm3Low,states[7]!.xmm3High],[at(ldBias,0x375e8),0n]);
    assert.deepEqual([states[8]!.xmm2Low,states[8]!.xmm2High],[BigInt(ldBias),at(ldBias,0x375e8)]);
    assert.equal(states[17]!.frameArg,boot.sp); // actual saved 64-bit scalar word
    assert.deepEqual(observed.stores,[{rip:at(ldBias,0x1de67),address:boot.sp-0x90n,low:BigInt(ldBias),high:at(ldBias,0x375e8)}]);
    assert.deepEqual(observed.syscalls,[]); // DSO not staged, mapped, called or claimed
    assert(!out.some(x=>x.fd===1));
    assert.match(out.map(x=>x.text).join(''),new RegExp('unsupported instruction at '+hex(at(ldBias,0x1de6b))));
    assert(p.task.dead && p.kernel.tasks.size===0);
    t.diagnostic(JSON.stringify({primary:mainSha,interpreter:ldSha,mainBias:hex(BigInt(mainBias)),loaderBias:hex(BigInt(ldBias)),
      nativeExit:37,nativeAuxvMatch:'normalized kernel page/PHDR/entry values',guestOffsets:states.map(x=>hex(x.rip-BigInt(ldBias))),
      guestInstructionsCompleted:17,guardedVectorStores:observed.stores.map(x=>({rip:hex(x.rip),address:hex(x.address),low:hex(x.low),high:hex(x.high)})),guestStatus:4,guestStdout:'',guestSyscalls:0,guestDSOLoaded:false}));
  }
  if(beforeProducer) {
    const {args,out}=setup(0x400000,0x800000);
    const old=await guardedStaticTask({...args,compiler:readFileSync(beforeProducer),compilerSha256:beforeProducerHash});
    assert.equal(old.kernel.pump().status,4);
    assert.deepEqual(old.interpreterTrace().steps.map(x=>x.rip-0x800000n),[0x1d2c0n,0x1d2c3n,0x1de30n,0x1de31n,0x1de38n,0x1de3fn]);
    assert.match(out.map(x=>x.text).join(''),/unsupported instruction at 0x81de3f/);
  }
  const no=(e:unknown)=>e instanceof FsError && e.errno===E.NOEXEC;
  const hidden=setup(0x400000,0x800000).args;
  await assert.rejects(guardedStaticTask({...hidden,interpreter:{...hidden.interpreter,elfSha256:'0'.repeat(64)}}),no);
  const renamed=setup(0x400000,0x800000).args, wrongPath='/lib64/not-the-interpreter.so.2';
  mountTarget(renamed.vfs).file(wrongPath,0o555,ldBytes.length,()=>new Uint8Array(ldBytes),ldSha);
  const other=captureExecutableSource(renamed.vfs,wrongPath,{origin:ldSha,size:ldBytes.length});
  await assert.rejects(guardedStaticTask({...renamed,interpreter:{...renamed.interpreter,path:wrongPath,source:other}}),no);
  const denied=setup(0x400000,0x800000);
  denied.interp.mode&=~0o111;
  await assert.rejects(guardedStaticTask(denied.args),
    e=>e instanceof FsError && e.errno===E.ACCES);
  const overlap=setup(0x400000,0x400000).args;
  await assert.rejects(guardedStaticTask(overlap),no);
  const noInterp=setup(0x400000,0x800000).args;
  await assert.rejects(guardedStaticTask({...noInterp,interpreter:undefined}),no);
});
