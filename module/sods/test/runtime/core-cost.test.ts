// Deterministic resource observations, not a wall-time benchmark. Runtime code
// has no instrumentation; each scope captures a temporary export wrapper.
// Scenarios must stay sequential: Instance replacement spans async compilation.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Vfs,mountTarget,loadFileScope} from '../../runtime/linux.ts';
import type {Mapping} from '../../runtime/linux/fs.ts';
import {mountPack} from '../../../ricebox/layers/mount.ts';
import {packOf} from '../../../ricebox/layers/table.ts';
const wasm=process.env.SODS_CORE_WASM;
const hash=(b:Uint8Array)=>new Uint8Array(createHash('sha256').update(b).digest());
interface Meter {calls:Record<string,number>;preparedInputBytes:number;readBytes:number;rangeBytes:number;hashBytes:number}
const meter=():Meter=>({calls:{},preparedInputBytes:0,readBytes:0,rangeBytes:0,hashBytes:0});
async function scenario(kind:'ts'|'rust',phase:string,n:number) {
  let observed=meter();
  const Original=WebAssembly.Instance;
  let raw:WebAssembly.Exports|undefined;
  class Measured extends Original {
    private measured?: WebAssembly.Exports;
    override get exports():WebAssembly.Exports {
      if(this.measured)return this.measured;
      raw=super.exports;
      return this.measured=Object.fromEntries(Object.entries(raw).map(([name,value])=>[name,typeof value==='function'?(...args:number[])=>{
        observed.calls[name]=(observed.calls[name]??0)+1;
        const result=(value as (...args:number[])=>number)(...args);
        if(name==='files_input'&&result===0)observed.preparedInputBytes+=args[0];
        if(name==='files_read_finish'&&args[1]===0&&result>=0)observed.readBytes+=result;
        return result;
      }:value]));
    }
  }
  let scope:Awaited<ReturnType<typeof loadFileScope>>|undefined;
  try {if(kind==='rust'){WebAssembly.Instance=Measured;scope=await loadFileScope(readFileSync(wasm!),n);}}
  finally {WebAssembly.Instance=Original;}
  const vfs=new Vfs(),payload=Uint8Array.from({length:n},(_,i)=>i%251),packed=packOf([payload],hash);
  const entry={mode:0o644,size:n,pack:0,at:packed.at[0],len:n,raw:true};
  mountPack(scope?scope.mountTarget(vfs):mountTarget(vfs),{codec:'zstd',dirs:[],links:[],packs:[{name:packed.name,bytes:packed.bytes.length}],files:[{path:'/data',...entry}]},{
    range:(_name,at,len)=>{observed.rangeBytes+=len;return packed.bytes.slice(at,at+len);},
    decode(){throw Error('raw fixture must not decompress');},sha256:bytes=>{observed.hashBytes+=bytes.length;return hash(bytes);},
  });
  const file=vfs.file('/data'),into=new Uint8Array(n),expected=payload.slice();
  const maps:Mapping[]=[];
  try {
    if(phase!=='cold')file.readInto(0,into,0,n);
    if(phase==='reload')assert.equal(file.release(),n);
    if(phase.startsWith('mapping')) {
      for(let i=0;i<2;i++){const memory=into.slice(),m={proc:{bytes:memory},start:0,length:n,off:0};file.map(m);maps.push(m);}
      if(phase==='mapping-one'){maps[0].proc.bytes[n>>1]^=255;expected[n>>1]^=255;}
      if(phase==='mapping-contiguous')for(let i=0;i<n/2;i++){maps[0].proc.bytes[i]^=255;expected[i]^=255;}
      if(phase==='mapping-alternating')for(let i=0;i<n;i+=2){maps[0].proc.bytes[i]^=255;expected[i]^=255;}
    }
    observed=meter();
    if(phase==='write'){file.write(n>>1,Uint8Array.of(255));expected[n>>1]=255;}
    else if(phase==='release')assert.equal(file.release(),n);
    else if(phase.startsWith('mapping'))file.settle();
    else assert.equal(file.readInto(0,into,0,n),n);
    // Save before accounting/verification calls add activity or materialize again.
    const cost=structuredClone(observed),resident=file.heldBytes();
    const wasmMemoryBytes=raw?(raw.memory as WebAssembly.Memory).buffer.byteLength:0;
    const scratchLength=raw?(raw.files_len as ()=>number)():0;
    const unique=new Set(maps.map(m=>m.seen!.buffer));
    const baselineBytes=[...unique].reduce((sum,b)=>sum+b.byteLength,0);
    if(phase!=='release') {
      if(!phase.startsWith('mapping')&&phase!=='write')assert.deepEqual(into,expected);
      const checked=new Uint8Array(n);file.readInto(0,checked,0,n);assert.deepEqual(checked,expected);
      for(const m of maps)assert.deepEqual(m.proc.bytes,expected);
    } else assert.equal(resident,0);
    return {kind,phase,n,...cost,resident,wasmMemoryBytes,scratchLength,mappingBackingBytes:maps.length*n,baselineBytes};
  } finally {for(const m of maps)file.unmap(m);scope?.dispose();}
}
test('same raw-pack and mapping semantics expose ABI work without timing claims',{skip:!wasm},async()=>{
  const rows:Awaited<ReturnType<typeof scenario>>[]=[];
  for(const phase of ['cold','warm','release','reload','write','mapping-clean','mapping-one','mapping-contiguous','mapping-alternating']) {
    for(const kind of ['ts','rust'] as const)rows.push(await scenario(kind,phase,4096));
  }
  const row=(kind:string,phase:string)=>rows.find(r=>r.kind===kind&&r.phase===phase)!;
  for(const phase of ['cold','warm','release','reload','write','mapping-clean','mapping-one','mapping-contiguous','mapping-alternating']) {
    const a=row('ts',phase),b=row('rust',phase);
    assert.equal(a.rangeBytes,b.rangeBytes);assert.equal(a.hashBytes,b.hashBytes);
    assert.equal(a.resident,b.resident);assert.equal(a.baselineBytes,b.baselineBytes);
  }
  assert.equal(row('rust','mapping-clean').preparedInputBytes,0);
  assert.equal(row('rust','mapping-one').preparedInputBytes,1);
  assert.equal(row('rust','mapping-contiguous').preparedInputBytes,2048);
  assert.equal(row('rust','mapping-contiguous').calls.files_write,1);
  assert.equal(row('rust','mapping-alternating').preparedInputBytes,2048);
  assert.equal(row('rust','mapping-alternating').calls.files_write,2048);
  assert.equal(row('rust','mapping-clean').baselineBytes,4096);
  const crossings=(phase:string)=>Object.values(row('rust',phase).calls).reduce((sum,n)=>sum+n,0);
  assert.equal(crossings('mapping-one'),6);
  assert.equal(crossings('mapping-contiguous'),6);
  assert.equal(crossings('mapping-alternating'),10241);
  console.log('CORE_COST_LEDGER '+JSON.stringify(rows));
});
