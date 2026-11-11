import {h} from './dom.ts';

// A box's own scroll, drawn in it (a terminal's on the desk), in place of the page's thin bar: a short ink bar at its
// right edge, as long as the part shown is of the whole and where that part is; seen while it is scrolled or the
// pointer is on the box (and there is more than it shows), gone a moment after; taken by the pointer, it is dragged,
// the box scrolled under it. What is past its top or foot fades out at that edge, so more there is seen to be there
// (scroll-thumb's own classes on the box: more-above, more-below).

/** Shown this long after the box was last scrolled. */
const LINGER = 900;
/** Never shorter than this, however long what it holds: it is still taken by the hand. */
const LEAST = 22;

/** `scroller` given its own scroll thumb, drawn in its parent (positioned: the thumb lies at its right). */
export function scrollThumb(scroller: HTMLElement): void {
  const host = scroller.parentElement;
  if (!host) return;
  const thumb = h('div', {class: 'scroll-thumb', 'aria-hidden': 'true'});
  host.append(thumb);
  let raf = 0, resting = 0, hovered = false, len = LEAST;
  let drag: {y: number; top: number} | null = null;
  const over = () => scroller.scrollHeight - scroller.clientHeight;
  const paint = () => {
    raf = 0;
    const far = over(), top = scroller.scrollTop;
    host.classList.toggle('more-above', far > 1 && top > 1);
    host.classList.toggle('more-below', far > 1 && top < far - 1);
    if (far <= 1) { thumb.classList.remove('shown'); return; }
    const shown = scroller.clientHeight;
    len = Math.max(LEAST, (shown * shown) / scroller.scrollHeight);
    thumb.style.height = `${len}px`;
    thumb.style.translate = `0 ${scroller.offsetTop + (shown - len) * (top / far)}px`;
  };
  const soon = () => { raf ||= requestAnimationFrame(paint); };
  /** Seen now, and gone a moment after unless the hand is on the box or the thumb. */
  const wake = () => {
    clearTimeout(resting);
    if (over() > 1) thumb.classList.add('shown');
    if (!hovered && !drag) resting = window.setTimeout(() => thumb.classList.remove('shown'), LINGER);
  };
  scroller.addEventListener('scroll', () => { soon(); wake(); }, {passive: true});
  new ResizeObserver(soon).observe(scroller);
  host.addEventListener('pointerenter', () => { hovered = true; paint(); wake(); });
  host.addEventListener('pointerleave', () => { hovered = false; wake(); });
  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drag = {y: e.clientY, top: scroller.scrollTop};
    thumb.setPointerCapture(e.pointerId);
    thumb.classList.add('held');
  });
  thumb.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const room = scroller.clientHeight - len;
    if (room > 0) scroller.scrollTop = drag.top + ((e.clientY - drag.y) * over()) / room;
  });
  const letGo = () => { drag = null; thumb.classList.remove('held'); wake(); };
  thumb.addEventListener('pointerup', letGo);
  thumb.addEventListener('pointercancel', letGo);
}
