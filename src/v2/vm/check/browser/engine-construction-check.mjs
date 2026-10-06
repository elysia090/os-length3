// Compare host construction of the same cold-C emissions. This does not
// execute a decoder, substitute guest state, or claim Linux/shell acceptance.
import {CompiledModules} from '../../../web/compiled-modules.mjs';

const ensure=(condition,message)=>{if(!condition)throw new Error(message);};
const same=(a,b)=>a.length===b.length&&a.every((byte,rank)=>byte===b[rank]);
export async function checkEngineConstruction(compilerBytes) {
  const cm=new WebAssembly.Memory({initial:16}), memory=new WebAssembly.Memory({initial:2,maximum:4});
  const cc=(await WebAssembly.instantiate(compilerBytes,{machine:{memory:cm}})).instance.exports;
  const cold=new Uint8Array(cm.buffer),report=new DataView(cm.buffer);
  const input=cc.compiler_arena_min(),output=input+8192,receipt=output+65536;
  const state=4096,port=8192,view=new DataView(memory.buffer),payload=new Uint8Array(memory.buffer);
  const imports={machine:{memory}},samples=[],bodyClasses=[],modules=128,rounds=6;
  let comparisons=0,minimum=65536,maximum=0;
  function check(instance,entry,value,binding) {
    payload.fill(0,state,state+1256);view.setBigUint64(state+384,entry,true);
    view.setBigUint64(state+392,0x10002n,true);view.setBigUint64(state+1128,17n,true);
    const expected=payload.slice(state,state+1256),ev=new DataView(expected.buffer);
    ev.setBigUint64(0,BigInt(value),true);ev.setBigUint64(384,entry+5n,true);
    ev.setBigUint64(392,2n,true);ev.setBigUint64(1128,18n,true);
    ensure(instance.exports.cut(state,port,entry,binding)===1n,'generated MOV result');
    ensure(same(payload.subarray(state,state+1256),expected),'whole generated MOV CPU preservation');
    ++comparisons;
  }
  for(let round=0;round<rounds;++round) {
    const entryBase=0x400000n+BigInt(round*4096),emissions=[];
    cold.fill(0xcc,input,input+4096);
    for(let rank=0;rank<modules;++rank) {
      const at=input+rank*5,value=(0xabc00000+round*modules+rank)>>>0;
      cold[at]=0xb8;report.setUint32(at+1,value,true);
    }
    ensure(cc.compiler_open_pages(input,1,entryBase,9n)===0,'C input page');
    for(let rank=0;rank<modules;++rank) {
      const entry=entryBase+BigInt(rank*5),value=(0xabc00000+round*modules+rank)>>>0;
      ensure(cc.compiler_emit(entry,1,output,65536,receipt)===0,'C MOV lowering');
      const length=Number(report.getBigUint64(receipt+40,true));
      ensure(length>0&&length<=65536,'bounded C emission');minimum=Math.min(minimum,length);maximum=Math.max(maximum,length);
      emissions.push({entry,value,binding:report.getUint32(receipt+76,true),bytes:cold.slice(output,output+length)});
    }
    const owner=new CompiledModules(imports,{maximumEntries:1,maximumBytes:65536});
    const methods={
      asynchronous:async bytes=>WebAssembly.instantiate(await WebAssembly.compile(bytes),imports),
      inline:async bytes=>new WebAssembly.Instance(new WebAssembly.Module(bytes),imports),
      boundedOwner:async(bytes)=>owner.get(bytes),
    };
    // Rotate which API sees a fresh body first. Other positions can benefit
    // from an engine-internal cache; report all positions, not just the winner.
    const order=['asynchronous','inline','boundedOwner'];
    const rotated=order.slice(round%3).concat(order.slice(0,round%3));
    for(const method of rotated) {
      let milliseconds=0;
      for(const {entry,value,binding,bytes}of emissions) {
        const started=performance.now(),instance=await methods[method](bytes,entry);
        milliseconds+=performance.now()-started;check(instance,entry,value,binding);
      }
      samples.push({round,method,position:rotated.indexOf(method),modules,milliseconds});
    }
    const distinct=new Set(emissions.map(({bytes})=>Array.from(bytes).join(','))).size;
    bodyClasses.push({round,distinct,owner:owner.stats()});
    ensure(owner.stats().compilations===distinct,'owner constructs only distinct emitted topologies');
    ensure(owner.stats().hits===modules-distinct,'different literal bindings must reuse an exact body when emitted alike');
    ensure(owner.stats().entries===1&&owner.stats().retainedModuleBytes<=65536,'unchanged owner quota');
    owner.close();
  }
  cc.compiler_close();
  const totals=Object.fromEntries(['asynchronous','inline','boundedOwner'].map(method=>
    [method,samples.filter(row=>row.method===method).reduce((sum,row)=>sum+row.milliseconds,0)]));
  const coldFirst=Object.fromEntries(['asynchronous','inline','boundedOwner'].map(method=>
    [method,samples.filter(row=>row.method===method&&row.position===0).reduce((sum,row)=>sum+row.milliseconds,0)]));
  return {format:'bounded-engine-construction-v1',status:'pass',linuxBoot:'not-tested',
    emissions:modules*rounds,comparisons,moduleBytes:{minimum,maximum},bodyClasses,totalsMs:totals,coldFirstMs:coldFirst,samples,
    scope:'rotating fresh-first tiny cold-C MOV emissions; full 1256-byte CPU models, not a native ISA oracle or Linux speedup'};
}
