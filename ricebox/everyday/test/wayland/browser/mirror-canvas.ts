// Host presenter for one bounded mirror channel. Caller owns the transport;
// this adapter neither starts nor terminates a Worker or its guest.
import {MirrorRaster, type Rect} from '../support/mirror-raster.ts';

export function mountMirrorCanvas(viewport: HTMLElement, canvas: HTMLCanvasElement,
  sendInput: (input: Uint8Array<ArrayBuffer>) => void) {
  const draw = canvas.getContext('2d');
  if (!draw) throw new Error('Cannot acquire a 2D canvas');
  const model = new MirrorRaster();
  let attached = true;
  function pointer(ev: PointerEvent) {
    if (!attached || ev.button !== 0) return;
    const {left, top, width, height} = canvas.getBoundingClientRect();
    const b = viewport.getBoundingClientRect();
    const clip: Rect = {x:b.left + viewport.clientLeft, y:b.top + viewport.clientTop,
      width:viewport.clientWidth, height:viewport.clientHeight};
    const input = model.pointer(ev.clientX, ev.clientY, {x:left,y:top,width,height}, clip);
    if (input) sendInput(input);
  }
  canvas.addEventListener('pointerdown', pointer);
  return {
    accept(message: unknown) {
      const frame = model.accept(message);
      if (!frame) return null;
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      draw.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
      const {sequence, width, height} = frame;
      return {sequence, width, height};
    },
    pan(x: number, y: number) {
      if (attached && Number.isFinite(x) && Number.isFinite(y)) viewport.scrollTo(x, y);
    },
    resizeGuest(width: number, height: number) {
      const input = model.resize(width,height);
      if (input) sendInput(input);
      return !!input;
    },
    detach() {
      if (!attached) return;
      attached = false;
      model.retire();
      canvas.removeEventListener('pointerdown', pointer);
    },
  };
}
