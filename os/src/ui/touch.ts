// Touch: what is pressed gives under the finger, and comes back with a little spring once let go, as a key does.
// The give is the same few pixels on anything, so a pill sinks more than a card does; it is the `scale` property, so
// it never fights a thing's own transform, and a press that becomes a drag is let go at once. Asked for less motion,
// nothing gives.

import {paced} from './glide.ts';

const WHOLE = '.pill, .card.repo, .card.new, .issue-card, .board-card';
const ONE = 'button, [role="button"], [role="radio"], [role="tab"], .chip';
const AWAY = 'input, textarea, select, [contenteditable], .power, .stage-hit, .slide-stage, .tree-row';

let held: {el: HTMLElement; s: number; press: Animation} | null = null;
/** The spring of the last press let go, while it goes. */
let spring: {el: HTMLElement; a: Animation} | null = null;

/** The thing that gives: a pill or a card as a whole when its body is pressed, a button in it (×, the gear) alone. */
function pressable(at: EventTarget | null): HTMLElement | null {
  if (!(at instanceof Element) || at.closest(AWAY)) return null;
  const one = at.closest<HTMLElement>(ONE), whole = at.closest<HTMLElement>(WHOLE);
  const el = whole && (!one || !whole.contains(one) || one.matches('.pill-name, .card-open')) ? whole : one;
  if (!el || el.matches(':disabled, [aria-disabled="true"]')) return null;
  return el;
}

/** How far `el` gives: about 3 px on each side, never more than 8 %. */
function give(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  return Math.min(.99, Math.max(.92, 1 - 6 / Math.max(r.width, r.height, 1)));
}

function down(el: HTMLElement) {
  const s = give(el);
  held?.press.cancel();
  held = {el, s, press: el.animate([{scale: s}], {duration: 70, easing: 'ease-out', fill: 'forwards'})};
}

function up() {
  if (!held) return;
  const {el, s, press} = held;
  held = null;
  press.cancel();
  // Past where it was by a third of the give, then home: the spring.
  const a = el.animate([{scale: s}, {scale: 1 + (1 - s) / 3, offset: .45}, {scale: 1}], {duration: paced(300), easing: 'cubic-bezier(.2, .9, .25, 1)'});
  spring = {el, a};
}

/**
 * A press on what is about to be left (the page the camera pans away from, kept as it is at that moment) is let
 * go at once, so the page leaves with it at rest, not still sunk; one elsewhere (the rail, which stays) springs on.
 */
export function letGo(within: Element) {
  if (held && within.contains(held.el)) up();
  if (spring && within.contains(spring.el)) spring.a.finish();
  spring = null;
}

export function touch() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = pressable(e.target);
    if (el) down(el);
  }, true);
  for (const name of ['pointerup', 'pointercancel', 'dragstart']) addEventListener(name, up, true);
  addEventListener('blur', (e) => { if (e.target === window) up(); });
  // From the keys too: Enter or Space on a button is a press let go at once.
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat || e.isComposing) return;
    const el = pressable(e.target);
    if (!el || !(e.target as Element).matches(ONE)) return;
    down(el);
    setTimeout(up, 70);
  }, true);
}
