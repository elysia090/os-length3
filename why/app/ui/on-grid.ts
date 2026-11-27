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
export function laid(r: {left: number; top: number; width: number; height: number}, w: number, h: number,
  anchor?: {top: number; bottom: number}): Laid {
  const width = Math.ceil(r.width / U) * U, height = Math.ceil(r.height / U) * U;
  let left = Math.round(r.left / U) * U, top = Math.round(r.top / U) * U;
  if (anchor) {
    // Leave the key in sight and under the hand: when the menu cannot fit below it, turn the menu above it.
    const after = Math.max(top, Math.ceil(anchor.bottom / U) * U);
    const before = Math.floor((anchor.top - height - SHADE) / U) * U;
    if (after + height + SHADE <= h) top = after;
    else if (before >= 2 * U) top = before;
  }
  while (left + width + SHADE > w && left - U >= 2 * U) left -= U;
  while (top + height + SHADE > h && top - U >= 2 * U) top -= U;
  return {dx: left - r.left, dy: top - r.top, width};
}

const seen = new WeakSet<HTMLElement>();
const keys = new WeakMap<HTMLElement, HTMLElement>();
const rowMenus = new WeakSet<HTMLElement>();

/** Actions sharing their row's lane keep its exact position, not the nearest sheet cell. */
export function keepAtRow(menu: HTMLElement) { rowMenus.add(menu); }

/** A menu on a scrolling desk may turn above its key rather than making the desk scroll. */
export function pinOnGrid(menu: HTMLElement, key: HTMLElement) { keys.set(menu, key); }

function place(el: HTMLElement) {
  if (rowMenus.has(el)) return;
  el.style.translate = '';
  el.style.minWidth = '';
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const key = keys.get(el)?.getBoundingClientRect();
  // A mobile window's inner size may include horizontal overflow, including a menu not yet laid down.
  const view = document.documentElement;
  const at = laid(r, key ? view.clientWidth : innerWidth, key ? view.clientHeight : innerHeight, key);
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

/**
 * Where the first move of an empty place stands (DESIGN §1: centred, with no frame), `w` × `h` as it is drawn, in a
 * window `W` × `H` whose world starts past the frame's corner (48, 48): whole cells wide and tall, so the patch of ground
 * under its words takes the dots of whole cells and cuts none (DESIGN §3), and its edges on the grid lines that bring
 * its middle nearest the world's. Where two are as near, the one half a cell up and left: the eye takes a thing's
 * middle a little above where it is measured.
 */
export function amid(w: number, h: number, W: number, H: number): {left: number; top: number; width: number; height: number} {
  const width = Math.ceil(w / U) * U, height = Math.ceil(h / U) * U;
  const near = (room: number, size: number) => 2 * U + Math.max(0, Math.ceil((room - 2 * U - size) / 2 / U - .5)) * U;
  return {left: near(W, width), top: near(H, height), width, height};
}

/** `el` kept where `amid` lays it, as its words or the window change. */
export function amidOnGrid(el: HTMLElement): void {
  const lay = () => {
    el.style.minWidth = el.style.minHeight = '';
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const at = amid(r.width, r.height, innerWidth, innerHeight);
    Object.assign(el.style, {left: `${at.left}px`, top: `${at.top}px`, minWidth: `${at.width}px`, minHeight: `${at.height}px`});
  };
  new ResizeObserver(lay).observe(el);
  const gone = new AbortController();
  addEventListener('resize', () => el.isConnected ? lay() : gone.abort(), {signal: gone.signal});
}
