// A row of pieces on a desk whose pieces are as tall as the window (Forge's), and how the desk is turned along it. The
// pieces are one width, a gap between them; the desk rests only with a piece at its edge, so how far it is turned is
// which piece is there, and what is out of sight is known from that. The numbers are kept apart from the page
// (turnedTo, atRest: tested as numbers); the desk that lays its pieces by them is pages/forge/desk.ts. (A desk of
// short pieces, Home's, has no row to turn: its pieces go under one another where they do not fit side by side.)

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
