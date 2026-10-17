// Receipt validation tests are not a browser execution witness.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkBrowserStorageFailureReceipt } from './check-browser-storage-failure-receipt.mjs';
const hash = seed => createHash('sha256').update(Uint8Array.from({ length: 4096 },
  (_, i) => (i * 37 + seed) & 255)).digest('hex');
const restored = { oldRootRestored: true, crossPageSha256: hash(5), distantSha256: hash(7) };
const cleanup = { ...restored, plaintextErased: true, storeClosedOnce: true };
const prefix = 'oracle-20261012-12345678-1234-1234-1234-123456789abc-';
const positive = {
  format: 'browser-persistent-block-failures-v1', status: 'pass', secureContext: true,
  linuxBoot: 'not-tested', engineQuotaExhaustion: 'not-tested', hostRss: 'not-measured', errors: [], publicationPuts: 7,
  cases: [{ scenario: 'publication-count', publicationPuts: 7, plaintextErased: true,
    baseline: { objects: 7, ciphertextBytes: 12718 }, after: { objects: 14, ciphertextBytes: 25436 } },
  ...Array.from({ length: 7 }, (_, i) => ({ ...cleanup, scenario: 'quota', faultAt: i + 1 })),
  { ...cleanup, scenario: 'head-abort' },
  { ...restored, scenario: 'corruption', corruptionRefused: true, retainedCiphertextRestore: true, automaticRepair: false },
  { ...cleanup, scenario: 'quota-close' },
  { ...restored, scenario: 'worker-interruption', workerTerminatedWithoutClose: true, persistedBeforeInterruption: 3 }],
  deletedDatabases: Array.from({ length: 12 }, (_, i) => `${prefix}case-${i}`),
};
assert.equal(checkBrowserStorageFailureReceipt(positive).status, 'pass');
assert.equal(checkBrowserStorageFailureReceipt(positive).restoredRoots, 11);
const negatives = [
  r => { r.status = 'running'; },
  r => { r.errors.push('cleanup blocked'); },
  r => { r.cases[1].faultAt = 2; },
  r => { r.cases[1].crossPageSha256 = '0'.repeat(64); },
  r => { r.cases[1].plaintextErased = false; },
  r => { r.cases[9].automaticRepair = true; },
  r => { r.cases[11].workerTerminatedWithoutClose = false; },
  r => { r.deletedDatabases.pop(); },
  r => { r.deletedDatabases[0] = r.deletedDatabases[1]; },
  r => { r.linuxBoot = 'pass'; },
  r => { r.engineQuotaExhaustion = 'pass'; },
  r => { r.hostRss = 'zero'; },
];
for (const mutate of negatives) {
  const invalid = structuredClone(positive);
  mutate(invalid);
  assert.throws(() => checkBrowserStorageFailureReceipt(invalid));
}
console.log(JSON.stringify({ status: 'pass', positive: 1, negative: negatives.length,
  scope: 'receipt rejection tests; browser execution remains separate' }));
