// Node unit test of diagnostic Worker setup. NOT a browser observation.
// Only fixture delivery/self are adapted; all guest execution is C-Wasm.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const generated = new URL('../../src/v2/vm/check/browser/generated/', import.meta.url);
globalThis.fetch = async url => {
  const name = new URL(url);
  assert(name.href.startsWith(generated.href), 'driver only supplies local generated fixtures');
  return new Response(await readFile(name), {
    headers: { 'Content-Type': name.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' },
  });
};
let result;
globalThis.self = { isSecureContext: false, crossOriginIsolated: false,
  postMessage(value) { result = value; } };
await import('../../src/v2/vm/check/browser/provider-worker.mjs');
await self.onmessage({ data: { generation: 9 } });
assert.equal(result.status, 'pass', JSON.stringify(result));
assert.equal(result.format, 'browser-c-provider-probe-v2');
assert.equal(result.comparisons, 512);
assert.equal(result.guestExecution, 'C-Wasm table dispatcher');
assert.equal(result.linuxBoot, 'not-tested');
console.log(`Node diagnostic Worker setup -> C dispatcher/MMU: green (${result.comparisons} native cases; NOT an actual browser run)`);
