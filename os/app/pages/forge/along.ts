import type {Row} from './columns.ts';
import type {Band} from './pills.ts';

// Going along Forge's row from box to box without pressing one: swiped sideways over it, or by the keys.

/** Whether anything from `el` up to `cols` can still scroll the way `dx` goes (a long line of code). */
function scrollsThatWay(el: HTMLElement | null, cols: HTMLElement, dx: number): boolean {
  for (; el && el !== cols; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0)) return true;
  }
  return false;
}

/**
 * Swiped sideways over the row (a trackpad, or Shift and the wheel), the next box along is the one worked on
 * (`activate`): one box a swipe, however long the swipe, so it never runs past where it was meant to stop.
 */
export function swipeAlong(row: Row, activate: (key: string) => void) {
  const cols = row.element;
  let swiped = 0, swipeQuiet = 0;
  cols.addEventListener('wheel', (event) => {
    if (row.shown.length < 2 || !row.repo) return;
    const dx = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (!dx) return;
    // What can still scroll that way under the pointer (a long line of code) scrolls first; only at its end, or
    // where nothing scrolls sideways, does the swipe go to the next box.
    if (scrollsThatWay(event.target as HTMLElement | null, cols, dx)) return;
    event.preventDefault();
    clearTimeout(swipeQuiet);
    swipeQuiet = window.setTimeout(() => { swiped = 0; }, 220);
    if (swiped === Infinity) return;
    swiped += dx;
    if (Math.abs(swiped) < 40) return;
    const i = row.shown.indexOf(row.repo) + Math.sign(swiped);
    swiped = Infinity;
    if (row.shown[i]) activate(row.shown[i]);
  }, {passive: false});
}

/**
 * Ctrl+\: the next repo on the band opens beside (`beside`). Alt+[ and Alt+]: the box to the left or right is worked
 * on (`activate`), the keyboard with it.
 */
export function keysAlong(work: HTMLElement, row: Row, band: Band, ways: {beside(name: string): void; activate(key: string): void}) {
  work.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === '\\') {
      const next = band.names.find((n) => !row.shown.includes(n));
      if (next) { event.preventDefault(); ways.beside(next); }
      return;
    }
    if (event.altKey && (event.key === '[' || event.key === ']') && row.shown.length > 1 && row.repo) {
      event.preventDefault();
      const to = row.shown[(row.shown.indexOf(row.repo) + (event.key === ']' ? 1 : row.shown.length - 1)) % row.shown.length];
      ways.activate(to);
      row.views.get(to)?.flow.focus({preventScroll: true});
    }
  });
}
