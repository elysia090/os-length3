import {aotFraming, type AotFrame, type AotFraming} from '../format/aot-frames.ts';
import {blobAsset, type DeployedWasm} from '../format/manifest.ts';
import type {Segment} from '../../sods/runtime/translate.ts';
import {digest} from './download.ts';

/** Exact-size reads across arbitrary HTTP/decompressor chunk boundaries. We
 * copy into one frame's known bound, never accumulate variable-length output. */
class Body {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly size: number;
  readonly signal: AbortSignal;
  #bytes: Uint8Array = new Uint8Array(0);
  #received = 0;
  #offset = 0;
  #cancelling: Promise<unknown> | undefined;
  readonly #abort = () => { this.#cancelling ??= this.#reader.cancel(this.signal.reason).catch(() => {}); };

  constructor(stream: ReadableStream<Uint8Array>, size: number, signal: AbortSignal) {
    signal.throwIfAborted();
    this.size = size;
    this.signal = signal;
    this.#reader = stream.getReader();
    signal.addEventListener('abort', this.#abort, {once: true});
  }

  async #more(): Promise<boolean> {
    this.signal.throwIfAborted();
    const {value, done} = await this.#reader.read();
    this.signal.throwIfAborted();
    if (done) return false;
    if (value.byteLength > this.size - this.#received) throw new Error('framed AOT body exceeds its declared length');
    this.#received += value.byteLength;
    this.#bytes = value;
    this.#offset = 0;
    return true;
  }

  async exact(size: number): Promise<Uint8Array<ArrayBuffer>> {
    const out = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      if (this.#offset === this.#bytes.byteLength && !await this.#more()) throw new Error('truncated framed AOT body');
      const end = Math.min(this.#bytes.byteLength, this.#offset + size - at);
      out.set(this.#bytes.subarray(this.#offset, end), at);
      at += end - this.#offset;
      this.#offset = end;
    }
    return out;
  }

  async end(): Promise<void> {
    if (this.#offset !== this.#bytes.byteLength || this.#received !== this.size) throw new Error('framed AOT body disagrees with its length');
    while (await this.#more()) { /* only zero-width chunks can precede EOF */ }
  }

  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.#abort);
    this.#abort();
    await this.#cancelling;
    this.#reader.releaseLock();
    this.#bytes = new Uint8Array(0);
  }
}

async function expand(stored: Uint8Array<ArrayBuffer>, size: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  let at = 0;
  // Give the decoder a limited input window as it drains, even for a
  // malformed member with unexpectedly high expansion.
  const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (at === stored.byteLength) return controller.close();
      const end = Math.min(stored.byteLength, at + (16 << 10));
      controller.enqueue(stored.subarray(at, end)); at = end;
    },
  }, {highWaterMark: 0});
  const body = new Body(compressed.pipeThrough(new DecompressionStream('gzip')), size, signal);
  try {
    const result = await body.exact(size);
    await body.end();
    return result;
  } finally { await body.close(); }
}

/** Push only checked code into the engine. The resulting module and complete
 * initial image remain private until both jobs and the exact outer EOF pass.
 * Backpressure limits decoded code to the active frame rather than the program. */
export async function compileFramedAot(asset: DeployedWasm, shared: boolean,
                                       responseFor: (signal: AbortSignal) => Promise<Response>,
                                       outer: AbortSignal, received = (_n: number) => {}) {
  const {size: storedSize} = blobAsset(asset);
  const framed = aotFraming(asset);
  if (!framed) throw new Error('expected a framed AOT asset');
  const layout = {version: framed.version, code: framed.code.map(part => ({...part})),
    sharedHead: framed.sharedHead && {...framed.sharedHead}, data: framed.data.map(part => ({...part}))};
  outer.throwIfAborted();
  const stop = new AbortController(), signal = AbortSignal.any([outer, stop.signal]);
  const response = await responseFor(signal);
  if (signal.aborted || !response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    throw new Error(`could not read framed AOT (HTTP ${response.status})`);
  }
  const source = new Body(response.body, storedSize, signal);
  let channel!: TransformStreamDefaultController<Uint8Array<ArrayBuffer>>;
  const code = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({start(c) { channel = c; }});
  const writer = code.writable.getWriter();
  const disrupt = () => channel.error(signal.reason);
  signal.addEventListener('abort', disrupt, {once: true});
  const reject = (cause: unknown): never => { stop.abort(cause); throw cause; };
  let size = 0;
  const segments: Segment[] = [];

  async function frame(part: AotFrame) {
    const stored = await source.exact(part.size);
    if (await digest(stored) !== part.sha256) throw new Error('framed AOT member failed verification');
    signal.throwIfAborted();
    received(part.at + part.size);
    return stored;
  }

  async function feed(part: AotFrame, use: boolean) {
    const stored = await frame(part);
    if (use) {
      const bytes = await expand(stored, part.bytes, signal);
      await writer.write(bytes);
      size += bytes.byteLength;
    }
  }

  /** Exactly one reader; up to two authenticated members decoding/writing.
   * Completion remains ordered, and failure aborts and drains both slots. */
  async function ordered<F extends AotFrame>(parts: readonly F[],
      accept: (part: F, bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>) {
    const queue: {part: F; decoded: Promise<Uint8Array<ArrayBuffer>>}[] = [];
    const take = async () => {
      const item = queue[0]!;
      await accept(item.part, await item.decoded);
      queue.shift();
    };
    try {
      for (const part of parts) {
        const stored = await frame(part);
        const decoded = expand(stored, part.bytes, signal);
        void decoded.catch(error => stop.abort(error));
        queue.push({part, decoded});
        if (queue.length === 2) await take();
      }
      while (queue.length) await take();
    } catch (error) { reject(error); }
    finally { await Promise.allSettled(queue.map(item => item.decoded)); }
  }

  const compile = Promise.resolve().then(() => WebAssembly.compileStreaming(new Response(code.readable, {
    headers: {'Content-Type': 'application/wasm'},
  }))).catch(reject);
  const read = (async () => {
    try {
      await feed(layout.code[0]!, !shared || !layout.sharedHead);
      if (layout.sharedHead) await feed(layout.sharedHead, shared);
      await ordered(layout.code.slice(1), async (_part, bytes) => {
        await writer.write(bytes);
        size += bytes.byteLength;
      });
      await writer.close();
      await ordered(layout.data, (part, bytes) => { segments.push({offset: part.address, bytes}); });
      await source.end();
    } catch (error) { reject(error); }
    finally { await source.close(); }
  })();
  try {
    const [module, finished] = await Promise.allSettled([compile, read]);
    signal.throwIfAborted(); // also preserves the first failure reason
    if (module.status === 'rejected') throw module.reason;
    if (finished.status === 'rejected') throw finished.reason;
    checkAotAddresses(layout, module.value);
    return {module: module.value, segments, size, more: []};
  } finally {
    signal.removeEventListener('abort', disrupt);
    writer.releaseLock();
  }
}

/** The final engine module supplies Sods' own image bounds. Data is never
 * copied to a guest whose complete artifact has not passed this check. */
function checkAotAddresses(f: AotFraming, module: WebAssembly.Module): void {
  if (!f.data.length) return;
  const [facts] = WebAssembly.Module.customSections(module, 'sods.facts');
  if (!facts || facts.byteLength > (4 << 20)) throw new Error('ricebox: framed AOT image has no usable initial bounds');
  const {imageStart = 0, imageEnd} = JSON.parse(new TextDecoder().decode(facts)) as {imageStart?: number; imageEnd?: number};
  if (typeof imageStart !== 'number' || !Number.isSafeInteger(imageStart) || imageStart < 0 ||
      typeof imageEnd !== 'number' || !Number.isSafeInteger(imageEnd) || imageEnd > 2 ** 32 || imageStart >= imageEnd ||
      f.data.some(part => part.address < imageStart || part.bytes > imageEnd - part.address)) {
    throw new Error('ricebox: framed AOT initialize data outside its image');
  }
}
