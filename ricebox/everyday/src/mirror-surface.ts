import type {GuestFrame, GuestSurfaceObserver, GuestSurfaceSource} from './surface.ts';

type FrameInfo = Readonly<Pick<GuestFrame, 'serial' | 'width' | 'height'>>;
type Point = Parameters<NonNullable<GuestSurfaceSource['pointer']>>[0];
type Size = Parameters<NonNullable<GuestSurfaceSource['resize']>>[0];
type Encoder<T> = (input: T) => Uint8Array<ArrayBuffer> | null;

export interface MirrorSurfaceOptions {
  /** The exact caller-owned root Worker, before the producer first publishes. */
  worker: Pick<Worker, 'addEventListener' | 'removeEventListener' | 'postMessage'>;
  /** A single basename inside the Worker's explicitly configured mirror. */
  file: string;
  maxEncodedBytes: number;
  /** Synchronous decoder for this producer's format; bound its decoded size too. */
  decode(bytes: Uint8Array<ArrayBuffer>): GuestFrame | null;
  /** These packets, if supplied, go to this same Worker's existing guest stdin. */
  encodePointer?: Encoder<Point>;
  encodeResize?: Encoder<Size>;
}

export interface MirrorSurfaceSource extends GuestSurfaceSource {
  /** The last accepted surface while safe to address, without retaining pixels. */
  readonly current: FrameInfo | null;
}

const ownedBytes = (value: unknown): value is Uint8Array<ArrayBuffer> =>
  value instanceof Uint8Array && value.buffer instanceof ArrayBuffer && value.byteLength > 0;

const positive = (n: number) => Number.isSafeInteger(n) && n > 0;

/** Observe one file already lent by a root Worker. No launch, mirror writes or retirement. */
export function surfaceFromMirror({worker, file, maxEncodedBytes, decode, encodePointer, encodeResize}: MirrorSurfaceOptions): MirrorSurfaceSource {
  if (typeof file !== 'string' || !file || file === '.' || file === '..' || /[\\/\u0000]/.test(file)) {
    throw new TypeError('Guest surface file must be a single mirror basename');
  }
  if (!positive(maxEncodedBytes)) throw new RangeError('Invalid encoded guest surface budget');

  const postInput = worker.postMessage.bind(worker);
  let used = false, revision = 0, lastSerial = 0;
  let observer: GuestSurfaceObserver | undefined, current: FrameInfo | null = null;

  function release(ended: boolean): void {
    const previous = observer;
    observer = undefined;
    current = null;
    revision++;
    if (!previous) return;
    worker.removeEventListener('message', message);
    worker.removeEventListener('error', end);
    worker.removeEventListener('messageerror', end);
    if (ended) previous.end();
  }
  const end = () => release(true);

  function message(event: MessageEvent): void {
    const receiver = observer;
    if (!receiver) return;
    const data = event.data;
    if (data?.type === 'exit' || data?.type === 'error' || data?.type === 'retiring') { end(); return; }
    if (data?.type !== 'changes') return;
    if ([data.removed, data.dirs].some(paths => Array.isArray(paths) && paths.includes(file))) { end(); return; }
    if (!Array.isArray(data.files)) return;

    let found = false, encoded: unknown;
    for (const entry of data.files) {
      if (entry?.path !== file) continue;
      if (found) { current = null; revision++; return; }
      found = true;
      encoded = entry.bytes;
    }
    if (!found) return;
    current = null;
    const version = ++revision;
    if (!ownedBytes(encoded) || encoded.byteLength > maxEncodedBytes) return;
    let frame: GuestFrame | null;
    try { frame = decode(encoded); }
    catch { return; } // A bad publication does not leave a stale interactive frame.
    if (!frame || receiver !== observer || version !== revision) return;
    if (!positive(frame.serial) || frame.serial <= lastSerial || !positive(frame.width) || !positive(frame.height)) return;
    const info = Object.freeze({serial: frame.serial, width: frame.width, height: frame.height});
    if (receiver.frame(frame) && receiver === observer && version === revision) {
      lastSerial = info.serial;
      current = info;
    }
  }

  function post<T extends {serial: number}>(input: T, encode: Encoder<T>, target: FrameInfo): void {
    if (input.serial !== target.serial) return;
    const bytes = encode(input);
    if (current === target && ownedBytes(bytes)) postInput({type: 'input', bytes});
  }

  return {
    get current() { return current; },
    observe(receiver) {
      if (used) throw new Error('Guest mirror surface is single-use');
      used = true;
      observer = receiver;
      try {
        worker.addEventListener('message', message);
        worker.addEventListener('error', end);
        worker.addEventListener('messageerror', end);
      } catch (error) { release(false); throw error; }
      return () => release(false);
    },
    ...(encodePointer && {pointer(point: Point) {
      const target = current;
      if (target && Number.isSafeInteger(point.x) && point.x >= 0 && point.x < target.width &&
          Number.isSafeInteger(point.y) && point.y >= 0 && point.y < target.height) post(point, encodePointer, target);
    }}),
    ...(encodeResize && {resize(size: Size) {
      const target = current;
      if (target && positive(size.width) && positive(size.height)) post(size, encodeResize, target);
    }}),
  };
}
