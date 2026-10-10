// Verify the entire declared input population before consulting the compiler.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inputs,catalog} from './x86-profile-inputs.mjs';
export function validateProfileFixture(fixture) {
  assert.equal(fixture.format,'x86-profile-inputs-v1');
  assert.equal(fixture.profile,'development-standard-v2');
  assert.equal(fixture.catalogRows,catalog.length,'no missing declared family');
  const full=fixture.registerPairs==='all 16 x 16 where legal';
  assert(full||fixture.registerPairs==='boundary');
  const source=createHash('sha256'),binary=createHash('sha256');
  source.update('.intel_syntax noprefix\n.text\n');let ordinal=0;
  for(const expected of inputs({full})) {
    const actual=fixture.records[ordinal];assert(actual,`missing declared input ${ordinal}`);
    const {bytes,...metadata}=actual;
    assert.deepEqual(metadata,expected,`declared input ${ordinal}`);
    assert(/^(?:[a-f0-9]{2}){1,15}$/.test(bytes),'one encoded instruction');
    source.update(`input_${ordinal}:\n${expected.assembly}\n`);
    binary.update(Buffer.from(bytes,'hex'));++ordinal;
  }
  assert.equal(fixture.records.length,ordinal,'no undeclared tail');
  source.update('input_end:\n');
  assert.equal(source.digest('hex'),fixture.sourceSha256,'exact declared assembly identity');
  // An object section may have trailing alignment padding after input_end.
  // That padding is not an instruction record or part of the denominator.
  assert.equal(binary.digest('hex'),fixture.instructionSha256,'all actual encoded instruction bytes');
  return ordinal;
}
