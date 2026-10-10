// Admission is necessary, not an execution/equivalence proof. Keep every
// declared valid form in the denominator, including unsupported families.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateProfileFixture} from './profile-input-fixture.mjs';
const [compilerFile,fixtureFile]=process.argv.slice(2);if(!fixtureFile)throw new Error('COMPILER.WASM INPUTS.json');
const compilerBytes=await readFile(compilerFile),fixture=JSON.parse(await readFile(fixtureFile,'utf8'));
validateProfileFixture(fixture);
const memory=new WebAssembly.Memory({initial:32});
const cc=(await WebAssembly.instantiate(compilerBytes,{machine:{memory}})).instance.exports;
assert.equal(cc.compiler_entry_abi(),4);
const data=Buffer.from(memory.buffer),view=new DataView(memory.buffer),input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const untouched=Buffer.alloc(65536,0xa5);
assert(report+80<=data.length);
const groups=new Map(),entry=0x400000n;let accepted=0,missing=0,falseFault=0,other=0,invalidModule=0,wrongExtent=0;
const ordinary={total:0,accepted:0,missing:0,falseFault:0,other:0,invalidModule:0,wrongExtent:0};
const architecturalFaults={...ordinary};
for(const [ordinal,record] of fixture.records.entries()){
  const bytes=Buffer.from(record.bytes,'hex');assert(bytes.length>0&&bytes.length<=15);
  const key=`${record.feature}/${record.family}/${record.shape}/${record.width}`;
  let group=groups.get(key);if(!group){group={feature:record.feature,family:record.family,shape:record.shape,width:record.width,total:0,accepted:0,missing:0,falseFault:0,other:0,invalidModule:0,wrongExtent:0,examples:[]};groups.set(key,group);}
  ++group.total;data.fill(0x90,input,input+4096);data.set(bytes,input);
  assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  data.fill(0xa5,output,output+65536);data.fill(0xa5,report,report+80);
  const status=cc.compiler_emit(entry,1,output,65536,report);let kind,reason;
  if(status===-102){kind='missing';++missing;assert(data.subarray(output,output+65536).equals(untouched));assert(data.subarray(report,report+80).equals(untouched.subarray(0,80)));}
  else if(status!==0){kind='other';++other;}
  else {
    const n=Number(view.getBigUint64(report+40,true)),boundary=view.getUint32(report+60,true);
    assert(n>0&&n<=65536);
    assert(data.subarray(output+n,output+65536).equals(untouched.subarray(n)),'no unwritten tail publication');
    if(!WebAssembly.validate(data.subarray(output,output+n))){kind='invalidModule';++invalidModule;
      try{new WebAssembly.Module(data.subarray(output,output+n));}catch(error){reason=error.message;}}
    else if(view.getBigUint64(report+24,true)!==1n||view.getBigUint64(report+32,true)!==BigInt(bytes.length)){
      kind='wrongExtent';++wrongExtent;reason=`instructions=${view.getBigUint64(report+24,true)} bytes=${view.getBigUint64(report+32,true)}/${bytes.length}`;
    }else if((boundary===4)!==record.fault){kind='falseFault';++falseFault;}else{kind='accepted';++accepted;}
  }
  ++group[kind];if(kind!=='accepted'&&group.examples.length<3)group.examples.push({assembly:record.assembly,bytes:record.bytes,status,kind,...(reason?{reason}:{})});
  const domain=record.fault?architecturalFaults:ordinary;++domain.total;++domain[kind];
  cc.compiler_close();
  if((ordinal+1)%16384===0)console.error(`profile admission ${ordinal+1}/${fixture.records.length}: ${accepted} accepted, ${missing} missing, ${falseFault} false faults, ${other} other refusals`);
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({format:'x86-profile-admission-v1',status:missing||falseFault||other||invalidModule||wrongExtent?'fail':'pass',
  profile:fixture.profile,compilerSha256:sha(compilerBytes),inputSourceSha256:fixture.sourceSha256,
  instructionSha256:fixture.instructionSha256,
  records:fixture.records.length,accepted,missing,falseFault,other,invalidModule,wrongExtent,catalogRows:fixture.catalogRows,
  ordinary,architecturalFaults,
  scope:fixture.domain,oracle:fixture.oracle,semantics:'not-verified-by-this-test',linuxBoot:'not-tested',groups:[...groups.values()]},null,2));
process.exitCode=missing||falseFault||other||invalidModule||wrongExtent?1:0;
