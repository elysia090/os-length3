// A host camera can float without moving or resizing the admitted guest.
type Point = {x: number; y: number};
type Size = {width: number; height: number};

export function clampCamera(point: Point, view: Size, pane: Size): Point | null {
  if (![point.x, point.y, view.width, view.height, pane.width, pane.height].every(Number.isFinite) ||
      view.width < 0 || view.height < 0 || pane.width < 0 || pane.height < 0) return null;
  const clamp = (value: number, room: number) => Math.min(Math.max(8, room - 8), Math.max(8, Math.round(value)));
  return {x:clamp(point.x,view.width-pane.width), y:clamp(point.y,view.height-pane.height)};
}

export function placeCamera(pane: HTMLElement, toolbar: HTMLElement, handle: HTMLButtonElement,
  pin: HTMLButtonElement, initial: 'floating' | 'pinned'): () => void {
  const initialBox = pane.getBoundingClientRect();
  let position = {x:initialBox.left, y:initialBox.top};
  let pinned = initial === 'pinned';
  let drag: {id: number; x: number; y: number} | undefined;
  const events = new AbortController(), signal = events.signal;
  function move(point: Point) {
    if (signal.aborted) return;
    const bounds = pane.getBoundingClientRect();
    const next = clampCamera(point, {width:innerWidth,height:innerHeight}, bounds);
    if (!next) return;
    position = next;
    if (pane.style.left !== next.x + 'px') pane.style.left = next.x + 'px';
    if (pane.style.top !== next.y + 'px') pane.style.top = next.y + 'px';
  }
  function release() {
    const previous = drag;
    drag = undefined;
    if (previous && handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
  }
  function mark() {
    pane.dataset.placement = pinned ? 'pinned' : 'floating';
    pin.setAttribute('aria-pressed', String(pinned));
  }
  toolbar.hidden = false;
  mark();
  move(position);
  const resize = new ResizeObserver(() => move(position));
  resize.observe(pane);
  addEventListener('resize', () => move(position), {signal});
  pin.addEventListener('click', () => { release(); pinned = !pinned; mark(); }, {signal});
  handle.addEventListener('pointerdown', e => {
    if (pinned || drag || !e.isPrimary || e.button !== 0 || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    try { handle.setPointerCapture(e.pointerId); } catch { return; }
    drag = {id:e.pointerId, x:e.clientX-position.x, y:e.clientY-position.y};
  }, {signal});
  handle.addEventListener('pointermove', e => {
    if (!pinned && drag && e.pointerId === drag.id) move({x:e.clientX-drag.x, y:e.clientY-drag.y});
  }, {signal});
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    handle.addEventListener(event, e => { if (drag?.id === e.pointerId) release(); }, {signal});
  }
  handle.addEventListener('keydown', e => {
    const step = e.shiftKey ? 32 : 8;
    const offset = ({
      ArrowUp: {x:0,y:-step}, ArrowDown: {x:0,y:step},
      ArrowLeft: {x:-step,y:0}, ArrowRight: {x:step,y:0},
    } as Partial<Record<string,Point>>)[e.key];
    if (!offset) return;
    e.preventDefault();
    if (!pinned) move({x:position.x+offset.x, y:position.y+offset.y});
  }, {signal});
  return () => {
    if (signal.aborted) return;
    release();
    events.abort();
    resize.disconnect();
    delete pane.dataset.placement;
    pane.style.left = pane.style.top = '';
    toolbar.hidden = true;
  };
}
