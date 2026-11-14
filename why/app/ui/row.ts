// A row of pieces on a desk, and how the desk is turned along it: the one rule for what lies sideways in a place,
// Forge's files and Home's own things alike. The pieces are one width, a gap between them; the desk rests only with a
// piece at its edge, so how far it is turned is which piece is there, and what is out of sight is known from that.
// The numbers are kept apart from the page (turnedTo, atRest: tested as numbers); alongRow is the rule put on a box
// that scrolls its pieces, for a place that lays them out in its sheets (Forge's desk lays its own: pages/forge/desk.ts).

import {eased, moveTime} from './law.ts';
import {still} from './glide.ts';

/**
 * How far the desk is turned (from `now`) for the piece at `x`, `w` wide, gone to on a face `face` wide, the pieces
 * starting at `starts`, a piece's shadow `shade` wide: where it is while that piece and its shadow are whole in sight
 * (what is pressed does not go from under the hand that pressed it); else the nearest rest that shows it whole: the
 * piece itself at the edge if it was before the edge, or the earliest piece at the edge that brings its far side in.
 */
export function turnedTo(now: number, x: number, w: number, face: number, starts: readonly number[], shade = 12): number {
  const far = x + w + shade - face;
  if (now <= x && now >= far) return now;
  if (now > x) return x;
  let to = x;
  for (const s of starts) if (s >= far && s < to) to = s;
  return to;
}

/** Where the desk, let go of at `now`, comes to rest: with the nearest of `starts` at its edge. */
export function atRest(now: number, starts: readonly number[]): number {
  let best = starts[0] ?? 0;
  for (const x of starts) if (Math.abs(x - now) < Math.abs(best - now)) best = x;
  return best;
}

/** The ground goes with what is on it: turned `by` px, the desk's dots (the body's, a cell apart) are that far along,
 * and where they stood at every whole cell. */
export function ground(by: number, cell = 24) {
  document.body.style.backgroundPositionX = by % cell ? `${-(by % cell)}px` : '';
}

/**
 * `box` scrolls a row of pieces (`pieces`, as they are now): its ground goes with it, and a piece pressed or gone
 * into with the keyboard that is not whole in sight is brought in by the nearest rest, by the OS's law of motion.
 * (Scrolled by hand it comes to rest at a piece by the browser's own snapping: the sheets say so.)
 */
export function alongRow(box: HTMLElement, pieces: () => HTMLElement[]) {
  let frame = 0;
  const starts = () => pieces().map((p) => p.offsetLeft - box.offsetLeft);
  const go = (to: number) => {
    cancelAnimationFrame(frame);
    box.style.scrollSnapType = '';
    const from = box.scrollLeft;
    if (Math.abs(to - from) < .5) return;
    if (still()) { box.scrollLeft = to; return; }
    const t0 = performance.now(), ms = moveTime(to - from, box.clientWidth);
    box.style.scrollSnapType = 'none';
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      box.scrollLeft = k >= 1 ? to : from + (to - from) * eased(k);
      if (k < 1) frame = requestAnimationFrame(step); else box.style.scrollSnapType = '';
    };
    frame = requestAnimationFrame(step);
  };
  const toPiece = (e: Event) => {
    const piece = pieces().find((p) => p.contains(e.target as Node));
    if (!piece) return;
    const all = starts(), x = piece.offsetLeft - box.offsetLeft;
    go(turnedTo(atRest(box.scrollLeft, all), x, piece.offsetWidth, box.clientWidth, all));
  };
  box.addEventListener('click', toPiece);
  box.addEventListener('focusin', toPiece);
  box.addEventListener('scroll', () => ground(box.scrollLeft), {passive: true});
}
