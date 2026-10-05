// C-emitted coordinate covariance and engine construction, not an ISA oracle.
// No body bytes are edited, no entry guard is removed, and no guest is booted.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';

const [compilerFile,...flags]=process.argv.slice(2);
if(!compilerFile || flags.some(flag=>flag!=='--observe') || flags.length>1)
  throw new Error('usage: check-cut-coordinate-sharing.mjs COMPILER.WASM [--observe]');
const binary=await readFile(compilerFile);
const memory=new WebAssembly.Memory({initial:32,maximum:34});
const cc=(await WebAssembly.instantiate(binary,{machine:{memory}})).instance.exports;
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const state=(report+80+4095)&~4095,windowBytes=4096,stateBytes=1256;
assert(state+windowBytes<=memory.buffer.byteLength,'disjoint state window');
let data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
const addresses=[0x400000n,0x401000n,0x412000n,0x12345000n,0x80000000n,
  0xffff0000n,0x100000000n,0x12345678000n,0x7fffffffd000n,
  0xffff800000004000n,0xffffffff81033000n,0xffffffff81204000n];
const cases=[
  {name:'nop',bytes:[0x90]},
  {name:'move-register',bytes:[0x48,0x89,0xd8]},
  {name:'add-immediate',bytes:[0x48,0x83,0xc0,1]},
  {name:'xor-self',bytes:[0x48,0x31,0xc0]},
  {name:'compare-register',bytes:[0x48,0x39,0xd8]},
  {name:'jump-relative',bytes:[0xe9,0x0c,0,0,0]},
  {name:'conditional-relative',bytes:[0x74,8]},
  {name:'lea-rip',bytes:[0x48,0x8d,0x05,0x23,1,0,0],addressResult:64},
  {name:'lea-eip',bytes:[0x67,0x48,0x8d,0x05,0x23,1,0,0],addressResult:32},
  {name:'serialized-fence',bytes:[0x0f,0xae,0xe8]},
];
const put=(at,value)=>view.setBigUint64(at,BigInt.asUintN(64,value),true);
const templates=[],families=[];
let comparisons=0,entryRefusals=0;
function seed(entry,row) {
  data.fill(0xa5,state,state+windowBytes);
  for(let rank=0;rank<16;++rank)
    put(state+rank*8,BigInt(row+1)*0x123456789n+BigInt(rank)*0x777777n);
  put(state+384,entry);put(state+392,0x202n|BigInt(row&1)*0x40n|BigInt(row&2)*0x8000n);
  put(state+400,0x80010011n);put(state+408,0x1000n);put(state+416,0x220n);
  put(state+424,0x500n);put(state+600,0x400n);put(state+1128,41n);
}
function normalized(entry,example) {
  const result=Buffer.from(data.subarray(state,state+stateBytes));
  result.writeBigUInt64LE(BigInt.asUintN(64,result.readBigUInt64LE(384)-entry),384);
  if(example.addressResult)
    result.writeBigUInt64LE(BigInt.asUintN(example.addressResult,result.readBigUInt64LE(0)-entry),0);
  return result;
}
try {
  for(const example of cases) {
    const witnesses=[],baseline=[];
    for(const entry of addresses) {
      data.fill(0x90,input,input+4096);data.set(example.bytes,input);
      assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
      assert.equal(cc.compiler_emit(entry,1,output,65536,report),0,example.name);
      assert.equal(view.getBigUint64(report,true),entry);
      assert.equal(view.getBigUint64(report+24,true),1n);
      assert.equal(view.getBigUint64(report+32,true),BigInt(example.bytes.length));
      const bytes=Buffer.from(data.subarray(output,output+Number(view.getBigUint64(report+40,true))));
      const module=new WebAssembly.Module(bytes);
      assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
      const cut=new WebAssembly.Instance(module,{machine:{memory}}).exports.cut;
      witnesses.push(bytes);templates.push({bytes,module,cut});
      for(let row=0;row<8;++row) {
        seed(entry,row);
        const outside=Buffer.from(data.subarray(state+stateBytes,state+windowBytes));
        assert.equal(cut(state,-1),1n);
        assert.equal(view.getBigUint64(state+1128,true),42n);
        assert.equal(view.getBigUint64(state+392,true)&0x10000n,0n);
        assert(data.subarray(state+stateBytes,state+windowBytes).equals(outside),'no state-window overrun');
        const actual=normalized(entry,example);
        if(!baseline[row])baseline[row]=actual;
        else assert(actual.equals(baseline[row]),`${example.name}: complete normalized state`);
        ++comparisons;
      }
      seed(entry+1n,0);
      const before=Buffer.from(data.subarray(state,state+windowBytes));
      assert.equal(cut(state,-1),6n,'coordinate mismatch must retain its entry refusal');
      assert(data.subarray(state,state+windowBytes).equals(before));++entryRefusals;
    }
    // Exact bytes only. This digest measures identity; it does not strip
    // addresses, infer equivalence, patch Wasm or authorize guest execution.
    const distinct=new Set(witnesses.map(bytes=>createHash('sha256').update(bytes).digest('hex'))).size;
    families.push({name:example.name,coordinates:addresses.length,distinctExactModules:distinct,
      bytes:witnesses.map(bytes=>bytes.length),desiredTopologyCount:1});
  }
  memory.grow(1);data=Buffer.from(memory.buffer);view=new DataView(memory.buffer);
  seed(addresses[0],0);
  assert.equal(templates[0].cut(state,-1),1n,'same existing instance after memory growth');
  const coldSamples=4096,coldConstruction={samples:coldSamples,emissionMs:0,moduleMs:0,instanceMs:0};
  data.fill(0x90,input,input+4096);
  for(let rank=0;rank<coldSamples;++rank) {
    const entry=0x20000000n+BigInt(rank)*4096n;
    let start=performance.now();
    assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
    coldConstruction.emissionMs+=performance.now()-start;
    const bytes=Buffer.from(data.subarray(output,output+Number(view.getBigUint64(report+40,true))));
    start=performance.now();const module=new WebAssembly.Module(bytes);
    coldConstruction.moduleMs+=performance.now()-start;
    start=performance.now();const instance=new WebAssembly.Instance(module,{machine:{memory}});
    coldConstruction.instanceMs+=performance.now()-start;
    assert.equal(typeof instance.exports.cut,'function');
  }
  const samples=4096,rounds=[];
  // The existing instance constructor receives the exact same ordinary
  // Memory. No cut is executed by this construction microbenchmark.
  for(let round=0;round<3;++round) {
    let last,start=performance.now();
    for(let i=0;i<samples;++i)last=new WebAssembly.Module(templates[i%templates.length].bytes);
    const moduleMs=performance.now()-start;
    assert(last instanceof WebAssembly.Module);start=performance.now();
    for(let i=0;i<samples;++i)
      last=new WebAssembly.Instance(templates[i%templates.length].module,{machine:{memory}});
    rounds.push({moduleMs,instanceMs:performance.now()-start,samples});
    assert.equal(typeof last.exports.cut,'function');
  }
  const owner=new CompiledModules({machine:{memory}},
    {maximumEntries:1024,maximumBytes:262144});
  const ownerSamples=4096,startOwner=performance.now();
  for(let i=0;i<ownerSamples;++i)
    await owner.get(BigInt(i),templates[i%templates.length].bytes);
  const boundedOwner={samples:ownerSamples,elapsedMs:performance.now()-startOwner,stats:owner.stats()};
  assert.equal(boundedOwner.stats.compilations,ownerSamples);
  assert(boundedOwner.stats.retainedModuleBytes<=262144);owner.close();
  const unmet=families.filter(family=>family.distinctExactModules!==family.desiredTopologyCount);
  console.log(JSON.stringify({format:'cut-coordinate-sharing-red-v1',status:unmet.length?'red':'pass',
    linuxBoot:'not-tested',compilerBytes:binary.length,
    compilerSha256:createHash('sha256').update(binary).digest('hex'),
    scope:'C-emission metamorphic coordinate covariance, not independent native ISA equivalence or topology proof',
    fullStateCovarianceComparisons:comparisons,unchangedWrongEntryRefusals:entryRefusals,
    memoryGrowthChecks:1,families,unmetFamilies:unmet.length,
    coldCoordinateConstruction:coldConstruction,warmCoordinateConstruction:rounds,boundedOwner,
    timingScope:'independent Node constructor microbenchmark, concurrent host load, not Linux/browser speedup',
    policy:'No production path or quota changed; no byte patch, erased entry guard or fallback'},null,2));
  if(!flags.includes('--observe'))
    assert.equal(unmet.length,0,'entry coordinates still prevent exact topology sharing');
} finally {cc.compiler_close();}
