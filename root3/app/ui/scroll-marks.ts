import {h} from './dom.ts';

/** A mark stays this long after what it tells was last scrolled. */
const MARK_MS = 700;
/** How far in from the piece's edge a mark lies, and how thick it is (styles: .scroll-mark). */
const MARK_IN = 6;

/**
 * Where a piece of the desk (`host`, a sheet, a terminal) is scrolled to, said in it while it is scrolled and a moment
 * after: a bar cut square just inside its right edge for down, just inside its foot for across, each as long as the
 * part in sight is of the whole and where that part is. Nothing at rest, and nothing the pointer takes: the piece is
 * scrolled by the wheel, the keys and the text's own caret. Whatever scrolls inside the piece tells them (heard as its
 * scroll goes by), so what is put in it later (a file read, its text made a field) needs nothing more.
 */
export function scrollMarks(host: HTMLElement): void {
  const down = h('div', {class: 'scroll-mark down', 'aria-hidden': 'true'}), across = h('div', {class: 'scroll-mark across', 'aria-hidden': 'true'});
  host.append(down, across);
  const was = new WeakMap<Element, {x: number; y: number}>();
  let restDown = 0, restAcross = 0;
  host.addEventListener('scroll', (e) => {
    const s = e.target;
    if (!(s instanceof HTMLElement) || s === host) return;
    const before = was.get(s) ?? {x: 0, y: 0}, x = s.scrollLeft, y = s.scrollTop;
    was.set(s, {x, y});
    const farDown = s.scrollHeight - s.clientHeight, farAcross = s.scrollWidth - s.clientWidth;
    if (y !== before.y && farDown > 1) {
      const room = host.clientHeight - 2 * MARK_IN, len = Math.max(24, room * s.clientHeight / s.scrollHeight);
      down.style.height = `${len}px`;
      down.style.translate = `0 ${MARK_IN + (room - len) * (y / farDown)}px`;
      down.classList.add('shown');
      clearTimeout(restDown);
      restDown = window.setTimeout(() => down.classList.remove('shown'), MARK_MS);
    }
    if (x !== before.x && farAcross > 1) {
      // (Across, from where the words begin in the piece: its numbers' margin is not scrolled.)
      const from = Math.max(MARK_IN, s.getBoundingClientRect().left - host.getBoundingClientRect().left);
      const room = host.clientWidth - from - 2 * MARK_IN, len = Math.max(24, room * s.clientWidth / s.scrollWidth);
      across.style.width = `${len}px`;
      across.style.translate = `${from + (room - len) * (x / farAcross)}px 0`;
      across.classList.add('shown');
      clearTimeout(restAcross);
      restAcross = window.setTimeout(() => across.classList.remove('shown'), MARK_MS);
    }
  }, {capture: true, passive: true});
}
