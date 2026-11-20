// A deliberately small protocol for the cooperative C raster fixture.
// The Worker still speaks the existing mirror/input protocol. This is not a
// Wayland compositor, generic guest display endpoint, or streaming API.
export const rasterFile = 'frame.rgba';
const header = 16, widest = 64, tallest = 48;

export interface Raster {
  sequence: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}
export interface Rect { x: number; y: number; width: number; height: number }
type Mirrored = {type?: unknown; files?: unknown};

function rasterInfo(bytes: Uint8Array): Omit<Raster, 'pixels'> | null {
  if (bytes.byteLength < header || bytes.byteLength > header + widest * tallest * 4 ||
      bytes[0] !== 82 || bytes[1] !== 66 || bytes[2] !== 70 || bytes[3] !== 49) return null; // RBF1
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sequence = view.getUint32(4, true), width = view.getUint32(8, true), height = view.getUint32(12, true);
  if (!sequence || !width || width > widest || !height || height > tallest || bytes.length !== header + width * height * 4) return null;
  return {sequence, width, height};
}

export function decodeRaster(bytes: Uint8Array): Raster | null {
  const info = rasterInfo(bytes);
  // The retained-frame helpers still own a bounded copy.
  return info && {...info, pixels: new Uint8ClampedArray(bytes.subarray(header))};
}

/** Lend the exact payload to a synchronous draw of the received Worker message. */
export function lendRaster(bytes: Uint8Array): Raster | null {
  const buffer = bytes.buffer;
  if (!(buffer instanceof ArrayBuffer)) return null;
  const info = rasterInfo(bytes);
  if (!info) return null;
  // ImageData requires fixed backing. A normal transferred frame already has it.
  const pixels = buffer.resizable ? new Uint8ClampedArray(bytes.subarray(header)) :
    new Uint8ClampedArray(buffer, bytes.byteOffset + header, bytes.byteLength - header);
  return {...info, pixels};
}

function contains(box: Rect, x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(box.x) && Number.isFinite(box.y) &&
    Number.isFinite(box.width) && Number.isFinite(box.height) &&
    box.width > 0 && box.height > 0 && x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
}

export class MirrorRaster {
  #frame: Pick<Raster, 'sequence' | 'width' | 'height'> | undefined;
  #active = true;
  get size() { return this.#frame; }

  accept(event: unknown): Raster | null {
    if (!this.#active || !event || typeof event !== 'object') return null;
    const batch = event as Mirrored;
    if (batch.type !== 'changes' || !Array.isArray(batch.files)) return null;
    // No recursive search and never a substitute for the specifically agreed file.
    let exact: Uint8Array | undefined;
    for (const f of batch.files) {
      if (f?.path !== rasterFile) continue;
      if (exact || !(f.bytes instanceof Uint8Array)) return null;
      exact = f.bytes;
    }
    const frame = exact && decodeRaster(exact);
    if (!frame || (this.#frame && frame.sequence <= this.#frame.sequence)) return null;
    const {sequence, width, height} = frame;
    this.#frame = {sequence, width, height};
    return frame;
  }

  pointer(x: number, y: number, canvas: Rect, clip: Rect): Uint8Array<ArrayBuffer> | null {
    const frame = this.#frame;
    if (!this.#active || !frame || !contains(canvas, x, y) || !contains(clip, x, y)) return null;
    return Uint8Array.of(1, Math.min(frame.width - 1, Math.floor((x - canvas.x) * frame.width / canvas.width)),
      Math.min(frame.height - 1, Math.floor((y - canvas.y) * frame.height / canvas.height)));
  }

  resize(width: number, height: number): Uint8Array<ArrayBuffer> | null {
    if (!this.#active || !this.#frame || !Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || width > widest || height < 1 || height > tallest) return null;
    return Uint8Array.of(2, width, height);
  }

  retire(): void { this.#active = false; this.#frame = undefined; }
}
