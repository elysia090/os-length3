// The core built for the browser (core/web/src/lib.rs): its three exports, and the one import of its own
// (length3.http, core/src/net.rs mod web) beside WASI. core/worker.ts runs it; wasi.test.ts runs it in Node.

import type {WASI} from './wasi.ts';

/** A request as the core sends it; headers are pairs, in its order. */
interface Head { method: string; url: string; headers: [string, string][]; timeout: number }
/** Status 0: not reached, and the body says why. */
export interface Sent { status: number; body: Uint8Array }
export type Send = (head: Head, body: Uint8Array) => Sent;
export type Answer = {ok: unknown} | {error: string};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Exports {
  memory: WebAssembly.Memory;
  l3_alloc(len: number): number;
  l3_call(ptr: number, len: number): bigint;
  l3_free(ptr: number, len: number): void;
  _initialize?(): void;
}

export class Core {
  private exports: Exports;

  private constructor(exports: Exports) { this.exports = exports; }

  /** An instance of `module` over `wasi`, reaching the network through `send`. */
  static async start(module: WebAssembly.Module, wasi: WASI, send: Send): Promise<Core> {
    // Bodies wait here between http and http_body: the core asks for one once it has room for it.
    const bodies = new Map<number, Uint8Array>();
    let next = 0;
    let memory: WebAssembly.Memory | undefined;
    const view = () => new DataView(memory!.buffer);
    const length3 = {
      http: (head: number, headLen: number, body: number, bodyLen: number, status: number, len: number) => {
        const bytes = (p: number, n: number) => new Uint8Array(memory!.buffer, p >>> 0, n >>> 0).slice();
        let sent: Sent;
        try {
          sent = send(JSON.parse(decoder.decode(bytes(head, headLen))) as Head, bytes(body, bodyLen));
        } catch (e) {
          sent = {status: 0, body: encoder.encode(e instanceof Error ? e.message : String(e))};
        }
        const handle = ++next >>> 0;
        bodies.set(handle, sent.body);
        view().setUint32(status >>> 0, sent.status, true);
        view().setUint32(len >>> 0, sent.body.length, true);
        return handle;
      },
      http_body: (handle: number, out: number) => {
        const b = bodies.get(handle >>> 0);
        bodies.delete(handle >>> 0);
        if (b) new Uint8Array(memory!.buffer, out >>> 0, b.length).set(b);
      },
    };
    const instance = await WebAssembly.instantiate(module, {wasi_snapshot_preview1: wasi.imports, length3});
    const exports = instance.exports as unknown as Exports;
    memory = exports.memory;
    wasi.bind(instance);
    exports._initialize?.();
    return new Core(exports);
  }

  /** The core's answer to `name` with `args` (core/src/api.rs). A trap is thrown, and this instance is done. */
  call(name: string, args: unknown): Answer {
    const {memory, l3_alloc, l3_call, l3_free} = this.exports;
    const q = encoder.encode(JSON.stringify({name, args: args ?? {}}));
    const ptr = l3_alloc(q.length) >>> 0;
    new Uint8Array(memory.buffer, ptr, q.length).set(q);
    const r = BigInt.asUintN(64, l3_call(ptr, q.length));
    const at = Number(r >> 32n);
    const len = Number(r & 0xffffffffn);
    const text = decoder.decode(new Uint8Array(memory.buffer, at, len));
    l3_free(at, len);
    return JSON.parse(text) as Answer;
  }
}
