// A hand at the keys as the person watching sees it (the Agent's typing played on screen, pages/bench/play.ts): a
// steady hand, a little quicker than a person's first pace, close to even, nothing the eye sees strain at. No slips
// and no sudden stops; only a word's space, a shifted key and a new line a little longer. The median gap between keys
// is about 120 ms (110 ms × e^(0.1·N), with what reaching the key takes), 5% of them under 100 ms and 5% over 150 ms.

/** A number from 0 to 1, as Math.random gives one (a test gives its own). */
export type Random = () => number;

/** A normal deviate from two uniform ones (Box–Muller). */
function normal(rnd: Random): number {
  return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
}

/** Keys a shift is held for: a moment longer. */
const SHIFTED = /[A-Z~!@#$%^&*()_+{}|:"<>?]/;

/** The pause before `ch` is struck, `prev` struck before it ('' for the first), in ms. */
export function gap(ch: string, prev: string, rnd: Random = Math.random): number {
  let ms = 110 * Math.exp(0.1 * normal(rnd));
  if (prev === ' ' || prev === '\t') ms += 14;
  if (SHIFTED.test(ch)) ms += 22;
  if (ch === '\n') ms += 40;
  if (prev === '\n') ms += 430 + 80 * rnd();
  return ms;
}

/** Before the first key of what is typed, the hand having just come to it: in ms. */
export const leadIn = (rnd: Random = Math.random): number => 420 + 260 * rnd();

/** Which key's sound a character is struck with. */
export const keyOf = (ch: string): 'key' | 'enter' | 'space' => (ch === '\n' ? 'enter' : ch === ' ' ? 'space' : 'key');
