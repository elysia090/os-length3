import { fixture } from './fixture.mjs';
import { inspectCapabilities } from './capabilities.mjs';

self.onmessage = async ({ data: { generation } }) => {
  try {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 256 });
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 2, maximum: 8 });
    const response = await fetch('/probe.wasm');
    if (response.headers.get('content-type') !== 'application/wasm') {
      throw new Error('incorrect Wasm MIME');
    }
    // Compile a fixed known fixture; production admission must authenticate
    // immutable executable bytes before instantiating or executing them.
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== fixture.length || bytes.some((byte, i) => byte !== fixture[i])) {
      throw new Error('fixture identity changed');
    }
    const module = await WebAssembly.compileStreaming(
      new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }),
    );
    const instance = await WebAssembly.instantiate(module, { machine: { memory, table } });
    const value = 0x8000000000000000n + BigInt(generation);
    const expected = BigInt.asIntN(64, value + 1n);
    if (instance.exports.cut(0, value) !== expected
        || new DataView(memory.buffer).getBigUint64(0, true) !== value
        || table.get(1)(8, value) !== expected) {
      throw new Error('i64/memory/table ABI mismatch');
    }
    const before = memory.buffer;
    if (memory.grow(1) !== 16 || before.byteLength !== 0
        || memory.buffer.byteLength !== 17 * 65536
        || new DataView(memory.buffer).getBigUint64(0, true) !== value) {
      throw new Error('memory growth/view refresh mismatch');
    }
    table.set(1, null);
    if (table.get(1) !== null) throw new Error('table slot retained');
    let sharedMemory = false;
    if (self.crossOriginIsolated && typeof SharedArrayBuffer === 'function') {
      const shared = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
      sharedMemory = shared.buffer instanceof SharedArrayBuffer;
      if (!sharedMemory) throw new Error('shared memory admission failed');
    }
    // Never send memory, instance or table references to the supervisor.
    self.postMessage({ generation, ok: true, secureContext: self.isSecureContext,
      isolated: self.crossOriginIsolated, sharedMemory, memoryBytes: memory.buffer.byteLength,
      abi: 'i32-offset-i64-value', tableSlotReleased: true,
      capabilities: inspectCapabilities(self) });
  } catch (error) {
    self.postMessage({ generation, ok: false, error: String(error) });
  }
};
