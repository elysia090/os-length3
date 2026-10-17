import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const digest = seed => createHash('sha256').update(Uint8Array.from({ length: 4096 },
  (_, i) => (i * 37 + seed) & 255)).digest('hex');
export function checkBrowserStorageFailureReceipt(receipt) {
  assert.equal(receipt.format, 'browser-persistent-block-failures-v1');
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.secureContext, true);
  assert.equal(receipt.linuxBoot, 'not-tested');
  assert.equal(receipt.engineQuotaExhaustion, 'not-tested');
  assert.equal(receipt.hostRss, 'not-measured');
  assert.deepEqual(receipt.errors, []);
  assert.equal(receipt.publicationPuts, 7);
  assert.equal(receipt.cases.length, 12);
  const one = scenario => {
    const rows = receipt.cases.filter(row => row.scenario === scenario);
    assert.equal(rows.length, 1, scenario);
    return rows[0];
  };
  const count = one('publication-count');
  assert.equal(count.publicationPuts, 7);
  assert.equal(count.plaintextErased, true);
  assert.equal(count.baseline.objects, 7);
  assert.equal(count.after.objects, 14);
  assert(count.baseline.ciphertextBytes > 0 && count.after.ciphertextBytes < 65536);
  const restored = row => {
    assert.equal(row.oldRootRestored, true);
    assert.equal(row.crossPageSha256, digest(5));
    assert.equal(row.distantSha256, digest(7));
  };
  const quota = receipt.cases.filter(row => row.scenario === 'quota');
  assert.deepEqual(quota.map(row => row.faultAt).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  for (const row of [...quota, one('head-abort'), one('quota-close')]) {
    assert.equal(row.plaintextErased, true);
    assert.equal(row.storeClosedOnce, true);
    restored(row);
  }
  const corruption = one('corruption');
  assert.equal(corruption.corruptionRefused, true);
  assert.equal(corruption.retainedCiphertextRestore, true);
  assert.equal(corruption.automaticRepair, false);
  restored(corruption);
  const interruption = one('worker-interruption');
  assert.equal(interruption.workerTerminatedWithoutClose, true);
  assert.equal(interruption.persistedBeforeInterruption, 3);
  restored(interruption);
  assert.equal(receipt.deletedDatabases.length, 12);
  assert.equal(new Set(receipt.deletedDatabases).size, 12);
  const namespaces = receipt.deletedDatabases.map(name => {
    assert.match(name, /^oracle-20261012-[0-9a-f-]{36}-[a-z0-9-]{1,24}$/);
    return name.slice(0, 'oracle-20261012-'.length + 36);
  });
  assert.equal(new Set(namespaces).size, 1);
  return { status: 'pass', quotaFaults: quota.length,
    restoredRoots: receipt.cases.filter(row => row.oldRootRestored).length,
    interruptedWorker: true, deletedFixtures: 12,
    scope: 'real IndexedDB receipt and independent expected byte hashes; injected quota, not engine quota or Linux/ext4' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('usage: check-browser-storage-failure-receipt.mjs RECEIPT.json');
  const receipt = JSON.parse(await readFile(process.argv[2], 'utf8'));
  console.log(JSON.stringify(checkBrowserStorageFailureReceipt(receipt), null, 2));
}
