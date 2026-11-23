import assert from 'node:assert/strict';
import {join} from 'node:path';
import {test} from 'node:test';
import {prepareTinyDynamicAcceptance, tinyDynamicConsole} from './tiny-dynamic-acceptance.ts';

const ok = {status: 0}, exact = Buffer.from('dynamic-pie:42\n');
test('the tiny fixture receipt requires exact raw console bytes and one normal zero-status stop', () => {
  const capture = tinyDynamicConsole();
  capture.console.write(1, exact.subarray(0, 6));
  capture.console.write(1, exact.subarray(6));
  assert.deepEqual(capture.outcome(ok, 0, 0, 1), {
    stdout: new Uint8Array(exact), stderr: new Uint8Array(0), status: 0, stopReceipts: 1,
  });
  for (const [pumped, kernel, guest, stops] of [[{waiting: true}, null, undefined, 0], [{status: 7}, 7, 7, 1],
    [ok, 0, undefined, 1], [ok, 0, 0, 0], [ok, 0, 0, 2]] as const)
    assert.throws(() => capture.outcome(pumped, kernel, guest, stops), /no single normal zero-status/);
});

test('stderr, trailing bytes, wrong bytes, unexpected descriptor and capture overflow are nonpasses', () => {
  for (const [fd, bytes] of [[1, Buffer.from('bad')], [2, Buffer.of(0)], [3, Buffer.of(0)],
    [1, new Uint8Array(1024)], [2, new Uint8Array(1025)]] as const) {
    const capture = tinyDynamicConsole();
    capture.console.write(1, exact);
    capture.console.write(fd, bytes);
    assert.throws(() => capture.outcome(ok, 0, 0, 1), /guest output/);
  }
  const wrong = tinyDynamicConsole(), bytes = Buffer.from(exact);
  bytes[0] ^= 1;
  wrong.console.write(1, bytes);
  assert.throws(() => wrong.outcome(ok, 0, 0, 1), /guest output/);
});

const root = process.env.SODS_TEST_DYNAMIC_PACK_ROOT;
test('the exact tiny input opens and closes before any guest exists', {skip: !root}, async () => {
  const muk = process.env.RICEBOX_MUK_FILE;
  assert.ok(root && muk);
  await assert.rejects(() => prepareTinyDynamicAcceptance(root, join(root, 'webroot.json')), /Muk pin/);
  const prepared = await prepareTinyDynamicAcceptance(root, muk);
  prepared.close();
  assert.throws(prepared.run, /unavailable or already used/);
});
