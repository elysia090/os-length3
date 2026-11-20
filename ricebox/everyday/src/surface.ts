// One explicitly lent guest surface. Neither its transport nor the browser's
// camera is owned here. Input is an opt-in capability of the supplied source.
export interface GuestFrame {
  readonly serial: number;
  readonly width: number;
  readonly height: number;
  /** Straight RGBA, tightly packed; lent for the duration of frame(). */
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
}
export interface GuestSurfaceObserver {
  /** True means drawn into the canvas backing store, not physically displayed. */
  frame(frame: GuestFrame): boolean;
  end(): void;
}
export interface GuestSurfaceSource {
  /** Observe one guest surface, possibly synchronously. Return its unsubscribe. */
  observe(observer: GuestSurfaceObserver): () => void;
  /** Optional primary pointer contact in guest pixels. Not a general input protocol. */
  pointer?(event: {serial: number; x: number; y: number}): void;
  /** An explicit guest request, never inferred from a browser layout change. */
  resize?(request: {serial: number; width: number; height: number}): void;
}
export interface SurfaceLimits {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}
export interface GuestSurfaceOptions {
  readonly canvas: HTMLCanvasElement;
  /** The containing, axis-aligned scrollport; the deployer controls its camera. */
  readonly viewport: HTMLElement;
  readonly source: GuestSurfaceSource;
  readonly limits: SurfaceLimits;
}

const mounts = new WeakSet<HTMLCanvasElement>();
const dimension = (n: number) => Number.isInteger(n) && n > 0 && n <= 0xffffffff;
const finite = (...values: number[]) => values.every(Number.isFinite);

function fits(width: number, height: number, limits: SurfaceLimits): boolean {
  return dimension(width) && dimension(height) && width <= limits.width && height <= limits.height &&
    width <= Math.floor(limits.bytes / 4 / height);
}

function inside(x: number, y: number, left: number, top: number, width: number, height: number): boolean {
  const dx = x - left, dy = y - top;
  return finite(dx, dy, width, height) && dx >= 0 && dy >= 0 && dx < width && dy < height;
}

/** Mount an opted-in guest on one exclusive, borderless 2D canvas. */
export function mountGuestSurface({canvas, viewport, source, limits}: GuestSurfaceOptions) {
  const budget = {...limits};
  if (!dimension(budget.width) || !dimension(budget.height) ||
      !Number.isSafeInteger(budget.bytes) || budget.bytes < 4) throw new RangeError('Invalid guest surface limits');
  if (canvas === viewport || !viewport.contains(canvas)) throw new Error('Guest canvas must belong to its viewport');
  if (mounts.has(canvas)) throw new Error('Guest canvas is already mounted');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cannot acquire a 2D guest canvas');
  const draw = context;
  const pointer = source.pointer?.bind(source), resize = source.resize?.bind(source);

  mounts.add(canvas);
  let open = true, drawing = false, lastSerial = 0, unsubscribe: (() => void) | undefined;
  let shown: {serial: number; width: number; height: number} | undefined;

  function down(event: PointerEvent): void {
    const current = shown;
    if (!open || !current || event.button !== 0 || !event.isPrimary || !viewport.contains(canvas)) return;
    const {clientX: x, clientY: y} = event;
    const box = canvas.getBoundingClientRect(), clip = viewport.getBoundingClientRect();
    if (!inside(x, y, box.left, box.top, box.width, box.height) ||
        !inside(x, y, clip.left + viewport.clientLeft, clip.top + viewport.clientTop,
          viewport.clientWidth, viewport.clientHeight) || !open || shown !== current) return;
    pointer?.({serial: current.serial,
      x: Math.min(current.width - 1, Math.floor((x - box.left) / box.width * current.width)),
      y: Math.min(current.height - 1, Math.floor((y - box.top) / box.height * current.height))});
  }

  function close(): void {
    if (!open) return;
    open = false;
    shown = undefined;
    const stop = unsubscribe;
    unsubscribe = undefined;
    canvas.removeEventListener('pointerdown', down);
    try { draw.clearRect(0, 0, canvas.width, canvas.height); }
    finally { mounts.delete(canvas); stop?.(); }
  }

  const observer: GuestSurfaceObserver = {
    frame(value) {
      if (!open || drawing || !value) return false;
      const {serial, width, height, rgba} = value;
      if (!Number.isSafeInteger(serial) || serial <= lastSerial || !fits(width, height, budget) ||
          !(rgba instanceof Uint8ClampedArray) || !(rgba.buffer instanceof ArrayBuffer) ||
          rgba.byteLength !== width * height * 4) return false;

      drawing = true;
      try {
        const pixels = new ImageData(rgba, width, height);
        if (!open) return false;
        shown = undefined;
        if (canvas.width !== width) canvas.width = width;
        if (!open) return false;
        if (canvas.height !== height) canvas.height = height;
        if (!open) return false;
        draw.putImageData(pixels, 0, 0);
        if (!open) return false;
        lastSerial = serial;
        shown = {serial, width, height};
        return true;
      } finally { drawing = false; }
    },
    end: close,
  };

  try {
    if (pointer) canvas.addEventListener('pointerdown', down);
    const stop = source.observe(observer);
    if (typeof stop !== 'function') throw new TypeError('Guest surface source must return an unsubscribe');
    if (open) unsubscribe = stop;
    else stop(); // A source may end while observe() is still on the stack.
  } catch (error) {
    close();
    throw error;
  }

  return {
    /** True means handed to the source, not acknowledged by the guest. */
    resize(width: number, height: number): boolean {
      if (!open || !shown || !resize || !fits(width, height, budget)) return false;
      resize({serial: shown.serial, width, height});
      return true;
    },
    close,
  };
}

export {surfaceFromMirror, type MirrorSurfaceOptions, type MirrorSurfaceSource} from './mirror-surface.ts';
