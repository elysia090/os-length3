import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {FdTable} from '../../runtime/linux/fd.ts';
import {Vfs} from '../../runtime/linux/fs.ts';
import {GuardedFault, GuardedInlineMemory} from '../../runtime/linux/guarded-inline-memory.ts';

const artifact=process.env.SODS_GUARDED_TASK_TRANSLATOR_WASM;
const skip=!artifact ? 'needs the independently pinned XMM guarded translator producer' : process.platform!=='linux'||process.arch!=='x64';
const F=0x8d5n, EXTRA=0x202n;
const P=4096, B=65536, PC=0x600000n;
const lo=0x1234abcd8765dcb1n, hi=0xfedcba9087654321n, mask=(1n<<64n)-1n, canary=0x5a5a5a5a5a5a5a5an;
const values=[0n,7n,0x80n,0x88n,0x89n,1n<<63n,(1n<<63n)-1n,mask];
const ops={
  mov2:[0x66,0x48,0x0f,0x6e,0xd6], mov3:[0x66,0x48,0x0f,0x6e,0xd8], merge:[0x66,0x0f,0x6c,0xd3],
  self:[0x66,0x0f,0x6c,0xd2], store:[0x0f,0x29,0x55,0x80], scalar:[0x48,0x89,0xbd,0x78,0xff,0xff,0xff],
  sub:[0x48,0x81,0xec,0x88,0,0,0], push:[0x41,0x57],
};
type Native={merge:string[];clear:string[];self:string[];scalar:string[];push:string;flags:number[];
  unaligned:1;readOnly:1;none:1;unmapped:1};

test('exact guarded XMM encodings, aligned write and flags match independent native CPU controls',{skip},t=>{
  const dir=mkdtempSync(join(tmpdir(),'sods-guarded-xmm-'));
  try {
    const nativeExe=join(dir,'native');
    const c=fileURLToPath(new URL('../fixtures/guarded-xmm/native.c',import.meta.url));
    execFileSync('cc',['-O2','-Wall','-Wextra','-Werror','-Wl,-z,noexecstack',c,'-o',nativeExe]);
    const actual=JSON.parse(execFileSync(nativeExe,[],{env:{LC_ALL:'C'},encoding:'utf8',timeout:5000})) as Native;
    const wasm=readFileSync(artifact!);
    assert.equal(createHash('sha256').update(wasm).digest('hex'),process.env.SODS_GUARDED_TASK_TRANSLATOR_SHA256);
    const source=new WebAssembly.Instance(new WebAssembly.Module(wasm),{}).exports;
    const memory=source.memory as WebAssembly.Memory;
    const alloc=source.sods_alloc as (n:number)=>number;
    const lower=source.sods_translate_guarded_task_step as (ptr:number,n:number)=>number;
    const outPtr=source.sods_output_ptr as ()=>number, outLen=source.sods_output_len as ()=>number;

    const guard=new GuardedInlineMemory(2), vfs=new Vfs(), fds=new FdTable();
    let owner=guard.installOwner(vfs,fds);
    const registers=new BigInt64Array(19), lanes=new BigInt64Array(16);
    const api={guard:{
      read64:(at:bigint)=>guard.read(owner,at,8), write64:(at:bigint,word:bigint)=>guard.write(owner,at,8,word),
      reg:(r:number)=>registers[r]!, set:(r:number,value:bigint)=>{registers[r]=value;},
      syscall:()=>{throw new Error('Unexpected syscall in guarded opcode control');}, target:(at:bigint)=>at,
      xmmLow:(r:number)=>lanes[2*r]!, setXmm:(r:number,l:bigint,h:bigint)=>{lanes[2*r]=l;lanes[2*r+1]=h;},
      storeAligned128:(at:bigint,r:number)=>guard.writeAligned128(owner,at,lanes[2*r]!,lanes[2*r+1]!),
    }};
    const make=(op:number[])=>{
      const p=alloc(op.length);
      new Uint8Array(memory.buffer,p,op.length).set(op);
      assert.equal(lower(p,op.length),0);
      const m=new WebAssembly.Module(new Uint8Array(memory.buffer,outPtr(),outLen()).slice());
      assert(WebAssembly.Module.imports(m).every(i=>i.kind==='function'&&i.module==='guard'));
      return new WebAssembly.Instance(m,api).exports.step as (at:bigint)=>bigint;
    };
    const module=new Map(Object.entries(ops).map(([k,v])=>[k,make(v)]));
    const step=(op:keyof typeof ops)=>assert.equal(module.get(op)!(PC),PC+BigInt(ops[op].length));
    const rw=()=>guard.installData(owner,B,2*P,3,new Uint8Array(2*P).fill(0x5a),true);
    const pair=(address:bigint)=>[guard.read(owner,address,8),guard.read(owner,address+8n,8)].map(x=>x.toString(16));
    rw();
    registers[6]=lo; registers[0]=hi;
    step('mov2'); step('mov3'); step('merge');
    const addr=BigInt(B+P-16); registers[5]=addr+0x80n;
    step('store');
    assert.deepEqual(pair(addr),actual.merge); // ends exactly at page boundary
    registers[5]=BigInt(B)+0x80n;
    lanes[4]=-1n; lanes[5]=-1n; // MOVQ must clear a live nonzero upper lane
    step('mov2'); step('store');
    assert.deepEqual(pair(BigInt(B)),actual.clear);
    step('self'); step('store');
    assert.deepEqual(pair(BigInt(B)),actual.self);
    registers[5]=BigInt(B+8)+0x88n; registers[7]=hi;
    step('scalar');
    assert.deepEqual(pair(BigInt(B)),actual.scalar);
    registers[4]=BigInt(B+P); registers[15]=hi;
    step('push');
    assert.equal(registers[4],BigInt(B+P-8));
    assert.equal(guard.read(owner,registers[4]!,8).toString(16),actual.push);

    for (const [i,v] of values.entries()) {
      registers[4]=v; registers[17]=EXTRA|F;
      step('sub');
      assert.equal(BigInt.asUintN(64,registers[4]!),(v-0x88n)&mask);
      assert.equal(registers[17]!&F,BigInt(actual.flags[i]!));
      assert.equal(registers[17]!&~F,EXTRA);
    }
    assert.deepEqual([actual.unaligned,actual.readOnly,actual.none,actual.unmapped],[1,1,1,1]);
    const store=(at:bigint)=>{registers[5]=at+0x80n;return ()=>step('store');};
    const fault=(kind:GuardedFault['kind'],address:bigint)=>(e:unknown)=>e instanceof GuardedFault&&e.kind===kind&&e.address===address;
    const untouched=(addresses:bigint[])=>addresses.forEach(a=>assert.equal(guard.read(owner,a,8),canary));
    const cross=BigInt(B+P-8), aligned=BigInt(B+P);
    rw();
    assert.throws(store(cross),fault('alignment',cross)); // zero partial bytes across a page
    untouched([cross,aligned]);
    assert(guard.protect(owner,B+P,P,1));
    assert.throws(store(aligned),fault('permission',aligned));
    untouched([aligned,aligned+8n]);
    assert(guard.protect(owner,B+P,P,0));
    assert.throws(store(aligned),fault('permission',aligned));
    assert(guard.protect(owner,B+P,P,1));
    untouched([aligned,aligned+8n]);
    guard.unmap(owner,B+P,P);
    assert.throws(store(aligned),fault('unmapped',aligned));
    untouched([cross]);
    const alias=(1n<<32n)+BigInt(B);
    assert.throws(store(alias),fault('unmapped',alias));
    untouched([BigInt(B),BigInt(B+8)]);
    const stale=owner;
    owner=guard.installOwner(vfs,fds);
    assert.throws(()=>guard.writeAligned128(stale,BigInt(B),lo,hi),fault('owner',BigInt(B)));
    guard.retireOwner(owner);
    t.diagnostic(JSON.stringify({nativeExactOpcodeControls:actual,nativeWaitStatusFault:'SIGSEGV',checkedWritesBeforeFault:0,
      u64AliasGuardOnly:true,subcases:values.length}));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
