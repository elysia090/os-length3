// Touch: what is pressed is down while it is held, and up the moment it is let go, as a key is (DESIGN §14). The ear
// says when (a key's two sounds: as it goes down, as it comes up, keys.ts); the eye says what is so: that this thing
// is held down, for as long as it is (a press can still be taken back by moving off it), and then what it did. Neither
// says what the other does (Bresson: image and sound "must not support each other, but must work each in turn"): so
// the eye is told no instant the ear already hears. Down and up are cuts, never drawn going (a pointer's press has no
// travel the screen could follow, and a spring home told the eye the let-go the ear hears, moving while what the press
// did was the thing to see). Being held is a state, not a move: it is shown with less motion asked for too. The give
// is the same few pixels on anything, so a chip sinks more than a card does; it is the `scale` property, so it never
// fights a thing's own transform, and a press that becomes a drag is let go at once.

import {lift, press, strike, wake, type Key} from './keys.ts';

const WHOLE = '.card.repo, .card.new, .issue-card, .board-card';
const ONE = 'button, [role="button"], [role="radio"], [role="tab"], .chip';
const AWAY = '#rail-tabs, input, textarea, select, [contenteditable], .power, .stage-hit, .slide-stage, .tree-row';

let held: {el: HTMLElement; press: Animation} | null = null;

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

/** Held down: in the first frame drawn after the press, as the hand is. */
function down(el: HTMLElement) {
  held?.press.cancel();
  held = {el, press: el.animate([{scale: give(el)}], {duration: 0, fill: 'forwards'})};
}

/** Let go: up at once. */
function up() {
  held?.press.cancel();
  held = null;
}

/** A press on what is about to be left (the page the camera pans away from) is let go at once, so it leaves at rest. */
export function letGo(within: Element) {
  if (held && within.contains(held.el)) up();
}

/** The control a trusted press or click sounds on: none for one disabled, inert, or a field written in. */
function sounding(e: Event): Element | null {
  if (!e.isTrusted || !(e.target instanceof Element)) return null;
  const button = e.target.closest(ONE);
  return !button || button.closest(':disabled, [aria-disabled="true"], [inert]') || e.target.closest('input, textarea, select, [contenteditable]') ? null : button;
}
/** The control whose press a pointer's going down sounded: its click does not sound again. */
let sounded: Element | null = null;

/**
 * The key a stroke of the person's own typing sounds as: what is written in a field, a text or a terminal's line is
 * heard as it is struck, as a control pressed is. A letter, a figure, Backspace, Delete, Tab and Enter are keys as
 * any other (Enter and Backspace have no sound of their own: typing is one sound, however it goes on); Space is the
 * space bar. A key held sounds once (it is struck once), and one struck with Ctrl, Alt or the command key is a
 * command, not typing: silent here (what it does sounds, if it presses something), but for Ctrl or the command key's
 * Enter, which sends what was written and is the last stroke of it.
 */
export function typedKey(e: {key: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean}, inText: boolean): Key | null {
  if (!inText || e.repeat) return null;
  // (Enter with Ctrl or the command key sends what was written: the stroke that ends it is heard as Enter alone is.)
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) return 'key';
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === ' ') return 'space';
  // (A stroke taken by an input method is a stroke: its key is not said, the hand struck one all the same.)
  return e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Tab' || e.key === 'Process' || !!e.isComposing ? 'key' : null;
}
/** When Enter typed in a field last sounded (ms): the click it gives a form's button is that same stroke, not another. */
let enterTyped = -Infinity;
/** Enter or Space gone down on a control, and when (ms): it is let go as the key comes up. */
let keyed: {key: string; at: number} | null = null;
/** The least a control pressed from the keyboard is shown held (ms): a key let go sooner is still seen to go down. */
const SEEN = 70;

export function touch() {
  // A completed activation only: pointer and native Enter/Space each yield one click. A drag, focus, hover,
  // or programmatic navigation is silent. Motion preference does not mute this small confirmation.
  document.addEventListener('click', (e) => {
    const button = sounding(e);
    if (!button) return;
    // (A pointer's press sounded as it went down, below: its click is the same activation.)
    if (button === sounded) { sounded = null; return; }
    // (Enter typed in a field sounded as it was struck: the press it gives the form's button is that stroke.)
    if (e instanceof MouseEvent && e.detail === 0 && performance.now() - enterTyped < 60) return;
    strike('enter');
  }, true);
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
  addEventListener('blur', (e) => { if (e.target === window) { up(); keyed = null; } });
  // From the keys too: Enter or Space on a control is a press, down as the key goes down and up as it comes up, heard
  // so: at its click, Space's press was heard as it was let go (a key's click comes as it comes up), late by as long
  // as it was held.
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted) wake();
    // What is typed is heard as it is struck.
    if (e.isTrusted && e.target instanceof Element) {
      const field = e.target.closest('input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"], [type="submit"], [type="reset"], [type="file"], [type="color"]), textarea, [contenteditable]:not([contenteditable="false"])');
      const key = typedKey(e, !!field && !field.closest(':disabled, [inert]'));
      if (key) { if (e.key === 'Enter') enterTyped = performance.now(); strike(key); }
    }
    if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat || e.isComposing) return;
    const control = sounding(e);
    if (control) { sounded = control; press('enter'); }
    const el = pressable(e.target);
    if (el && (e.target as Element).matches(ONE)) down(el);
    if (control || held) keyed = {key: e.key, at: performance.now()};
  }, true);
  document.addEventListener('keyup', (e) => {
    if (!keyed || e.key !== keyed.key) return;
    setTimeout(up, Math.max(0, SEEN - (performance.now() - keyed.at)));
    keyed = null;
    lift();
    // (Space's click, if one comes, comes as the key comes up: before the control pressed is forgotten.)
    setTimeout(() => { sounded = null; }, 0);
  }, true);
}
