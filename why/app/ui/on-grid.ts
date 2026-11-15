// What is called up and laid over the page (a menu: a thing's own, the person's, a row's deeds) is a sheet like any
// other (DESIGN §3, whole cells): its edges on lines of the grid, as wide as whole cells, and whole in the window with
// its shadow (DESIGN §2, a title is whole; the subject whole with its shadow). Each is laid where its press asked
// (its own sheet's rules place it), then, the moment it is seen, set on the grid line nearest that and, where the window
// would cut it, along by whole cells into it. Not a move: it is there at once, where it rests.

const U = 24;
/** The shadow's reach past a sheet's edge (DESIGN §3). */
const SHADE = 12;

export interface Laid { dx: number; dy: number; width: number }

/**
 * Where a sheet laid at `r` goes in a window `w` × `h`: its left and top on the grid lines nearest them, its width up to
 * whole cells, then along by whole cells, left or up, while its shadow would pass the window's edge; never past the
 * frame's corner (48, 48) by that.
 */
export function laid(r: {left: number; top: number; width: number; height: number}, w: number, h: number): Laid {
  const width = Math.ceil(r.width / U) * U;
  let left = Math.round(r.left / U) * U, top = Math.round(r.top / U) * U;
  while (left + width + SHADE > w && left - U >= 2 * U) left -= U;
  while (top + Math.ceil(r.height / U) * U + SHADE > h && top - U >= 2 * U) top -= U;
  return {dx: left - r.left, dy: top - r.top, width};
}

const seen = new WeakSet<HTMLElement>();

function place(el: HTMLElement) {
  el.style.translate = '';
  el.style.minWidth = '';
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const at = laid(r, innerWidth, innerHeight);
  el.style.minWidth = `${at.width}px`;
  el.style.translate = at.dx || at.dy ? `${at.dx}px ${at.dy}px` : '';
}

function shown(el: HTMLElement): boolean {
  return !el.hidden && el.isConnected && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
}

/** Every menu, set on the grid as it comes into sight. */
export function menusOnGrid(): void {
  const look = () => {
    for (const el of document.querySelectorAll<HTMLElement>('.pop')) {
      if (!shown(el)) { seen.delete(el); continue; }
      if (seen.has(el)) continue;
      seen.add(el);
      place(el);
    }
  };
  // Only what can bring a menu into sight or take it away is looked at (a menu made, one shown or hidden, what holds one
  // opened): a terminal printing does not have the page's styles read again for it.
  const about = (n: Node) => n instanceof Element && (n.matches('.pop') || !!n.querySelector('.pop'));
  // (Before the frame is drawn: never seen where it was first laid and then here.)
  new MutationObserver((changes) => {
    if (changes.some((c) => (c.type === 'attributes' ? about(c.target) : [...c.addedNodes].some(about)))) look();
  }).observe(document.body,
    {subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'aria-expanded']});
  addEventListener('resize', () => { for (const el of document.querySelectorAll<HTMLElement>('.pop')) if (shown(el)) place(el); });
}
