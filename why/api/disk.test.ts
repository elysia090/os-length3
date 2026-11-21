import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finished, whole} from './indexeddb.ts';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
test('a bubbling request error is not transaction completion', async () => {
  const tx = {} as IDBTransaction;
  let settled = false;
  const done = finished(tx).then(() => { settled = true; }, () => { settled = true; });
  tx.onerror?.call(tx, new Event('error'));
  await turn(); assert.equal(settled, false);
  tx.onabort!.call(tx, new Event('abort'));
  await done; assert.equal(settled, true);
});

test('request success waits for transaction complete', async () => {
  const tx = {} as IDBTransaction, request = {result: 'bytes'} as IDBRequest<string>;
  let settled = false;
  const result = whole(tx, request).then(value => { settled = true; return value; });
  request.onsuccess!.call(request, new Event('success'));
  await turn(); assert.equal(settled, false);
  tx.oncomplete!.call(tx, new Event('complete'));
  assert.equal(await result, 'bytes');
});

test('failed request also waits until abort and returns its error', async () => {
  const error = new DOMException('failed', 'ConstraintError');
  const tx = {error} as IDBTransaction, request = {error} as IDBRequest<string>;
  let settled = false;
  const result = whole(tx, request).catch(error => { settled = true; return error; });
  request.onerror!.call(request, new Event('error'));
  await turn(); assert.equal(settled, false);
  tx.onabort!.call(tx, new Event('abort'));
  assert.equal(await result, error);
});

test('a handled request failure still propagates after transaction completion', async () => {
  const error = new Error('request failed');
  const tx = {} as IDBTransaction, request = {error} as unknown as IDBRequest<string>;
  const result = whole(tx, request);
  request.onerror!.call(request, new Event('error'));
  tx.oncomplete!.call(tx, new Event('complete'));
  await assert.rejects(result, error);
});
