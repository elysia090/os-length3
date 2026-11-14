// The one law every move of the OS follows. A thing moved goes as a hand moves it and stops it: off at once, most of
// the way in the first third of its time, then settling, with no bounce (a critically damped spring, in closed form,
// so it is one curve whoever draws it: the desk's own frames, an animation of the browser's, a transition in a sheet).
// Its time is a quarter of a second, and up to a sixth more as the way is longer, never over a window's worth.
// What moves is one of three things, and only these: the world up or down (to another place), the desk along its
// row (to another piece), and what is called up in front of the world (the world behind it out of focus).

/** How nearly at rest the spring is when its time is up (e^-8: three parts in a thousand). */
const SETTLE = 8;

/** How far along a move is at `u` (0 to 1) of its time. */
export function eased(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return (1 - (1 + SETTLE * u) * Math.exp(-SETTLE * u)) / (1 - (1 + SETTLE) * Math.exp(-SETTLE));
}

/** How long a move of `far` px takes where a whole way is `whole` px (the window's, the desk's face). */
export function moveTime(far: number, whole: number): number { return 250 + 170 * Math.min(1, Math.abs(far) / Math.max(1, whole)); }

/** The law as a browser's animation takes it: the curve sampled every twentieth of its time; where a browser knows no
 * such curve, the Bezier nearest it (styles: --spring, the same two). */
const SAMPLED = `linear(${Array.from({length: 21}, (_, i) => Math.round(eased(i / 20) * 1000) / 1000).join(', ')})`;
export const SPRING = typeof CSS === 'undefined' || CSS.supports?.('transition-timing-function', 'linear(0, 1)') ? SAMPLED : 'cubic-bezier(.2, 0, 0, 1)';

/** The grid the world is laid on (styles: --u): a move of the world is whole cells, so its dots stand where they stood. */
export const CELL = 24;
