// A missing/renamed/changed input must not become a smaller green denominator.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inputs,catalog} from './x86-profile-inputs.mjs';
import {validateProfileFixture} from './profile-input-fixture.mjs';
const records=Array.from(inputs({full:false}),r=>({...r,bytes:'90'}));
const source=['.intel_syntax noprefix','.text',...records.flatMap((r,i)=>[`input_${i}:`,r.assembly]),'input_end:',''].join('\n');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// Synthetic bytes exercise the fixture guard only; this is NOT a prepared
// assembler fixture and is never passed to the product compiler.
const fixture={format:'x86-profile-inputs-v1',profile:'development-standard-v2',catalogRows:catalog.length,
  registerPairs:'boundary',records,sourceSha256:sha(source),instructionSha256:sha(Buffer.alloc(records.length,0x90))};
assert.equal(validateProfileFixture(fixture),records.length);
let refusals=0;
for(const change of [f=>{f.records=f.records.slice(1);},f=>{f.records=f.records.slice(0,-1);},
  f=>{f.catalogRows--;},f=>{f.profile='other';},f=>{f.sourceSha256='0'.repeat(64);},f=>{f.instructionSha256='0'.repeat(64);},
  f=>{f.records=[{...f.records[0],fault:true},...f.records.slice(1)];},
  f=>{f.records=[{...f.records[0],assembly:'nop'},...f.records.slice(1)];},
  f=>{f.records=[{...f.records[0],bytes:'0f0b'},...f.records.slice(1)];}]){
  const changed={...fixture};change(changed);assert.throws(()=>validateProfileFixture(changed));++refusals;
}
console.log(JSON.stringify({format:'profile-input-population-guard-v1',status:'pass',records:records.length,
  refusals,scope:'declared population/hash guard only; NOT instruction encoding/execution/closure proof'}));
