import { importStorageMasterKey } from '../../../web/ciphertext-storage.js';
import { IndexedBlockStore, PersistentBlock } from '../../../web/persistent-block.mjs';

const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const payload = seed => Uint8Array.from({ length: 4096 }, (_, i) => (i * 37 + seed) & 255);
const oldA = payload(5), oldB = payload(7), newA = payload(19), newB = payload(29);
const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  byte => byte.toString(16).padStart(2, '0')).join('');
async function rejects(action, accept, label) {
  try { await action(); }
  catch (error) { ensure(accept(error), `${label}: ${error.message}`); return error; }
  throw new Error(`${label}: unexpected success`);
}
function wrappedStore(store, options = {}) {
  return {
    puts: 0, closes: 0,
    get: key => store.get(key), read: () => store.read(),
    async put(key, bytes) {
      const at = ++this.puts;
      if (at === options.faultAt) throw new DOMException('bounded fixture quota injection', 'QuotaExceededError');
      await store.put(key, bytes);
      if (at === options.interruptAt) {
        self.postMessage({ event: 'interruptible', persistedObjects: at, trustedHead: Array.from(options.trustedHead) });
        await new Promise(() => {}); // Parent destroys this Worker before root publication.
      }
    },
    compareAndSwap(expected, replacement) {
      if (!options.abortHead) return store.compareAndSwap(expected, replacement);
      return store.transaction('head', true, objectStore => {
        objectStore.put(replacement.slice(), 0);
        objectStore.transaction.abort();
      });
    },
    close() { ++this.closes; store.close(); },
  };
}
async function identity() {
  // Deterministic test-only key material, confined to random disposable DBs.
  return { masterKey: await importStorageMasterKey(new Uint8Array(32).fill(31)),
    volumeId: new Uint8Array(16).fill(17), volumeSalt: new Uint8Array(32).fill(23), bytes: 64 * 1024 * 1024 };
}
async function seed(name, authority) {
  const store = await IndexedBlockStore.open(name);
  try {
    ensure(await store.read() === null, 'fixture namespace must be absent');
    const volume = await PersistentBlock.open({ ...authority, store, create: true });
    await volume.write(4000, oldA);
    await volume.write(16 * 1024 * 1024, oldB);
    await volume.flush();
    const trustedHead = (await store.read()).slice();
    await volume.close();
    return trustedHead;
  } finally { store.close(); }
}
async function stage(volume) {
  await volume.write(4000, newA);
  await volume.write(16 * 1024 * 1024, newB);
}
async function oldRoot(name, authority, trustedHead) {
  const store = await IndexedBlockStore.open(name);
  try {
    const volume = await PersistentBlock.open({ ...authority, store, expectedHead: trustedHead });
    ensure(equal(await volume.read(4000, 4096), oldA), 'exact committed cross-page bytes');
    ensure(equal(await volume.read(16 * 1024 * 1024, 4096), oldB), 'exact committed distant bytes');
    ensure((await volume.read(32 * 1024 * 1024, 4096)).every(byte => byte === 0), 'authenticated sparse hole');
    await volume.close();
    return { oldRootRestored: true, crossPageSha256: await sha256(oldA), distantSha256: await sha256(oldB) };
  } finally { store.close(); }
}
async function inspectObjects(store) {
  return store.transaction('objects', false, (objectStore, done) => {
    let objects = 0, ciphertextBytes = 0;
    const request = objectStore.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { done({ objects, ciphertextBytes }); return; }
      ++objects; ciphertextBytes += cursor.value.byteLength; cursor.continue();
    };
  });
}
async function check(message) {
  const { name, scenario } = message;
  ensure(/^oracle-20261012-[0-9a-f-]{36}-[a-z0-9-]{1,24}$/.test(name), 'disposable fixture namespace');
  const authority = await identity();
  if (scenario === 'restore') {
    ensure(Array.isArray(message.trustedHead), 'retained external fixture head');
    return { scenario: 'worker-interruption', ...(await oldRoot(name, authority, new Uint8Array(message.trustedHead))) };
  }
  const trustedHead = await seed(name, authority);
  const store = await IndexedBlockStore.open(name);
  const baseline = await inspectObjects(store);
  const options = scenario === 'quota' ? { faultAt: message.faultAt }
    : scenario === 'quota-close' ? { faultAt: 2 }
    : scenario === 'head-abort' ? { abortHead: true }
    : scenario === 'interrupt' ? { interruptAt: 3, trustedHead } : {};
  const wrapped = wrappedStore(store, options);
  const volume = await PersistentBlock.open({ ...authority, store: wrapped, expectedHead: trustedHead });
  try {
    if (scenario === 'corruption') {
      const key = await volume.leaf(0);
      const retained = (await store.get(key)).slice(), damaged = retained.slice();
      damaged[40] ^= 1;
      await store.transaction('objects', true, objectStore => objectStore.put(damaged, key));
      await rejects(() => volume.read(4000, 16), error => /corrupt/.test(error.message), 'corruption refusal');
      await store.transaction('objects', true, objectStore => objectStore.put(retained.slice(), key));
      ensure(equal(await volume.read(4000, 4096), oldA), 'independently retained ciphertext restores bytes');
      await volume.close();
      return { scenario, corruptionRefused: true, retainedCiphertextRestore: true,
        automaticRepair: false, ...(await oldRoot(name, authority, trustedHead)) };
    }
    await stage(volume);
    const plaintext = [...volume.cache.values(), ...volume.dirty.values()];
    ensure(plaintext.some(bytes => bytes.some(Boolean)), 'nonempty borrowed plaintext before close');
    if (scenario === 'publication-count' || scenario === 'interrupt') {
      await volume.flush();
      const after = await inspectObjects(store);
      await volume.close();
      ensure(plaintext.every(bytes => bytes.every(byte => byte === 0)), 'successful close erases plaintext');
      return { scenario, publicationPuts: wrapped.puts, baseline, after, plaintextErased: true };
    }
    if (scenario === 'quota-close') {
      const results = await Promise.allSettled([volume.close(), volume.close()]);
      ensure(results.every(result => result.status === 'rejected' && result.reason.name === 'QuotaExceededError'), 'concurrent close retains quota');
      ensure(results[0].reason === results[1].reason, 'same close failure object');
      await rejects(() => volume.close(), error => error === results[0].reason, 'repeated close failure');
    } else {
      await rejects(() => volume.flush(), error => scenario === 'quota'
        ? error.name === 'QuotaExceededError' : /abort/i.test(error.message), 'failed publication');
      ensure(equal(await store.read(), trustedHead), 'failed publication preserves committed head');
      await rejects(() => volume.read(4000, 16), error => /failed/.test(error.message), 'failed read');
      await rejects(() => volume.write(4000, newA), error => /failed/.test(error.message), 'failed write');
      await rejects(() => volume.close(), error => /failed/.test(error.message), 'failed close');
    }
    ensure(wrapped.closes === 1, 'store closes exactly once');
    ensure(volume.cache.size === 0 && volume.dirty.size === 0, 'plaintext maps emptied');
    ensure(plaintext.every(bytes => bytes.every(byte => byte === 0)), 'plaintext references erased');
    return { scenario, ...(scenario === 'quota' ? { faultAt: message.faultAt } : {}),
      plaintextErased: true, storeClosedOnce: true, ...(await oldRoot(name, authority, trustedHead)) };
  } finally { store.close(); }
}
self.onmessage = async ({ data }) => {
  try { self.postMessage({ event: 'result', ok: true, result: await check(data) }); }
  catch (error) { self.postMessage({ event: 'result', ok: false, error: error.message ?? String(error) }); }
};
