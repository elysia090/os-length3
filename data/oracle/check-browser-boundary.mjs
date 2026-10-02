// Node/HTTP checks only. Browser CSP/isolation/lifecycle must be probed in a browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture } from '../../src/v2/vm/check/browser/fixture.mjs';
import { inspectCapabilities } from '../../src/v2/vm/check/browser/capabilities.mjs';

const forbiddenCall = () => { throw new Error('passive probe requested permission or I/O'); };
const capabilities = inspectCapabilities({
  navigator: { storage: { getDirectory: forbiddenCall, persist: forbiddenCall, estimate: forbiddenCall },
    serial: { requestPort: forbiddenCall }, locks: { request: forbiddenCall } },
  showDirectoryPicker: forbiddenCall, WebTransport: forbiddenCall,
});
assert.equal(capabilities.opfs.api, 'available-unprobed');
assert.equal(capabilities.directoryPicker.permission, 'user-action-required');
assert.equal(capabilities.webTransport.api, 'available-unprobed');
assert.equal(capabilities.webTransport.connection, 'not-connected');
assert.equal(capabilities.clipboard.api, 'unavailable');
assert.equal(inspectCapabilities({}).opfs.api, 'unavailable');
console.log('Capability inventory: green (passive; no permission, I/O or connectivity claim)');

for (const value of [0n, 0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn]) {
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 256 });
  const table = new WebAssembly.Table({ element: 'anyfunc', initial: 2, maximum: 8 });
  const { instance } = await WebAssembly.instantiate(fixture, { machine: { memory, table } });
  assert.equal(instance.exports.cut(0, value), BigInt.asIntN(64, value + 1n));
  assert.equal(table.get(1)(8, value), BigInt.asIntN(64, value + 1n));
  assert.equal(new DataView(memory.buffer).getBigUint64(0, true), value);
  const old = memory.buffer;
  assert.equal(memory.grow(1), 16);
  assert.equal(old.byteLength, 0);
  assert.equal(new DataView(memory.buffer).getBigUint64(8, true), value);
  assert.throws(() => memory.grow(256), RangeError);
  assert.throws(() => instance.exports.cut(memory.buffer.byteLength - 4, 0n), WebAssembly.RuntimeError);
  table.set(1, null);
  assert.equal(table.get(1), null);
}
console.log('Node Wasm ABI: green (i64 wrap/high bit, shared imports, growth, trap, slot release)');

for (const isolated of [false, true]) {
  const child = spawn(process.execPath, ['data/oracle/serve-browser.mjs', '--port=0',
    ...(isolated ? ['--isolated'] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const base = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`server exited before ready: ${code ?? signal}`));
      });
      child.stdout.on('data', bytes => {
        text += bytes;
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(text);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    const request = (path, options) => fetch(new URL(path, base), options);
    const whole = await request('/probe.wasm');
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'application/wasm');
    assert.equal(whole.headers.get('cross-origin-opener-policy'), isolated ? 'same-origin' : null);
    assert.equal(whole.headers.get('cross-origin-embedder-policy'), isolated ? 'require-corp' : null);
    assert.match(whole.headers.get('content-security-policy'), /'wasm-unsafe-eval'/);
    assert.doesNotMatch(whole.headers.get('content-security-policy'), /\s'unsafe-eval'/);
    assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), fixture);
    const small = await request('/probe.wasm', { headers: { Range: 'bytes=0-7' } });
    assert.equal(small.status, 206);
    assert.equal(small.headers.get('content-range'), `bytes 0-7/${fixture.length}`);
    assert.deepEqual(new Uint8Array(await small.arrayBuffer()), fixture.slice(0, 8));
    const tooFar = await request('/probe.wasm', { headers: { Range: 'bytes=999-1000' } });
    assert.equal(tooFar.status, 416);
    assert.equal(tooFar.headers.get('content-range'), `bytes */${fixture.length}`);
    assert.equal((await request('/probe.wasm', { headers: { Range: 'bytes=0-9007199254740992' } })).status, 416);
    assert.equal((await request('/probe.wasm', { method: 'HEAD' })).headers.get('content-length'), String(fixture.length));
    assert.equal((await request('/probe.wasm', { method: 'POST' })).status, 405);
    for (const path of ['/.git/config', '/temp/bootstrap/id_ed25519', '/data/upstream/anything',
      '/src/v2/vm/check/browser/%5C..%5Csecret']) {
      assert.equal((await request(path)).status, 404, path);
    }
    console.log(`HTTP boundary: green (isolated=${isolated}, MIME/CSP/Range/private-path rejection)`);
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
  }
}
console.log('Browser execution and Linux boot: not verified by this Node test');
