// Touch: what is pressed gives under the finger, and comes back with a little spring once let go, as a key does.
// The give is the same few pixels on anything, so a chip sinks more than a card does; it is the `scale` property, so
// it never fights a thing's own transform, and a press that becomes a drag is let go at once. Asked for less motion,
// nothing gives.

import {paced, still} from './glide.ts';
import {lift, press, strike, wake} from './keys.ts';
import {SPRING} from './law.ts';

const WHOLE = '.card.repo, .card.new, .issue-card, .board-card';
const ONE = 'button, [role="button"], [role="radio"], [role="tab"], .chip';
const AWAY = '#rail-tabs, input, textarea, select, [contenteditable], .power, .stage-hit, .slide-stage, .tree-row';

let held: {el: HTMLElement; s: number; press: Animation} | null = null;
/** The spring of the last press let go, while it goes. */
let spring: {el: HTMLElement; a: Animation} | null = null;

/** The thing that gives: a card as a whole when its body is pressed, a button in it (×, the gear) alone. */
function pressable(at: EventTarget | null): HTMLElement | null {
  if (!(at instanceof Element) || at.closest(AWAY)) return null;
  const one = at.closest<HTMLElement>(ONE), whole = at.closest<HTMLElement>(WHOLE);
  const el = whole && (!one || !whole.contains(one) || one.matches('.card-open')) ? whole : one;
  if (!el || el.matches(':disabled, [aria-disabled="true"]')) return null;
  return el;
}

/** How far `el` gives: about 3 px on each side, never more than 8 %. */
function give(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  return Math.min(.99, Math.max(.92, 1 - 6 / Math.max(r.width, r.height, 1)));
}

function down(el: HTMLElement) {
  if (still()) return;
  spring?.a.cancel();
  spring = null;
  const s = give(el);
  held?.press.cancel();
  held = {el, s, press: el.animate([{scale: s}], {duration: 70, easing: SPRING, fill: 'forwards'})};
}

function up() {
  if (!held) return;
  const {el, s, press} = held;
  held = null;
  press.cancel();
  if (still()) return;
  // Past where it was by a third of the give, then home: the spring.
  const a = el.animate([{scale: s}, {scale: 1 + (1 - s) / 3, offset: .45}, {scale: 1}], {duration: paced(300), easing: SPRING});
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

/** The control a trusted press or click sounds on: none for one disabled, inert, or a field written in. */
function sounding(e: Event): Element | null {
  if (!e.isTrusted || !(e.target instanceof Element)) return null;
  const button = e.target.closest(ONE);
  return !button || button.closest(':disabled, [aria-disabled="true"], [inert]') || e.target.closest('input, textarea, select, [contenteditable]') ? null : button;
}
/** The control whose press a pointer's going down sounded: its click does not sound again. */
let sounded: Element | null = null;

export function touch() {
  // A completed activation only: pointer and native Enter/Space each yield one click. A drag, focus, hover,
  // or programmatic navigation is silent. Motion preference does not mute this small confirmation.
  document.addEventListener('click', (e) => {
    const button = sounding(e);
    if (!button) return;
    // (A pointer's press sounded as it went down, below: its click is the same activation.)
    if (button === sounded) { sounded = null; return; }
    strike('enter');
  }, true);
  // A held press ends below full size with forwards fill. Finishing it preserves that size;
  // the owner must cancel it when motion is reduced, without waiting for pointerup or adding a spring.
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (event) => {
    if (!event.matches) return;
    held?.press.cancel();
    held = null;
    spring?.a.cancel();
    spring = null;
  });
  document.addEventListener('pointerdown', (e) => {
    // The person's first act opens the sound's output, before a stroke is asked of it.
    if (e.isTrusted) wake();
    if (e.button !== 0) return;
    const el = pressable(e.target);
    if (el) down(el);
    // A control pressed with a mouse or a pen sounds as it goes down, as a key does, and its release as it is let
    // go: heard at the click that ends the press, it was late by as long as the press was held. (A finger's press
    // may be the start of a scroll: it sounds at its click.)
    sounded = e.pointerType === 'touch' ? null : sounding(e);
    if (sounded) press('enter');
  }, true);
  for (const name of ['pointerup', 'pointercancel', 'dragstart']) addEventListener(name, up, true);
  for (const name of ['pointerup', 'pointercancel', 'dragstart']) {
    // (The click, if one comes, comes before the control pressed is forgotten.)
    addEventListener(name, () => { lift(); setTimeout(() => { sounded = null; }, 0); }, true);
  }
  addEventListener('blur', (e) => { if (e.target === window) up(); });
  // From the keys too: Enter or Space on a button is a press let go at once.
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted) wake();
    if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat || e.isComposing) return;
    const el = pressable(e.target);
    if (!el || !(e.target as Element).matches(ONE)) return;
    down(el);
    setTimeout(up, 70);
  }, true);
}
