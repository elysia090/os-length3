// Motion with a reason. Two moves the whole OS makes the same way, so each says one thing wherever it is seen:
//
// - glide(): the ink of the thing chosen goes from the one it was on to the one it is on (the rail's places, the
//   band's pills), under their words, so the eye follows the choice instead of seeing one go out and another
//   light up.
// - arrive(): a page or a box coming in moves from the side it is on (down the rail, the next page comes up from
//   below; along the band, the next repo from the right), a few pixels and a fade, never a jump.
//
// Asked for less motion, neither moves: each thing is where it ends at once.

import {CELL, moveTime, SPRING} from './law.ts';

/** The camera's landing (styles.css --land): fast off the mark, the last pixels slow. */
export const LAND = SPRING;

/** The animations' own clock (ms): what their delays and lengths are counted on, so what is timed against them keeps
 * with them however they are played (the page's clock where there is none). */
export const clock = () => { const t = document.timeline.currentTime; return typeof t === 'number' ? t : performance.now(); };

/** The pace of the OS's moves (styles.css --pace): each move's length (and its delays) is its own times this; what
 * answers the hand at once (a press, a "no", the caret) is never paced. Read once it is there to read. */
let paceIs = 0;
export const pace = () => {
  if (!paceIs) paceIs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pace')) || 0;
  return paceIs || 1;
};
/** A length of time as styles.css says it, in ms: '320ms' as written, or '.32s' as a build's minifier writes it. */
export const msOf = (v: string): number => { const s = v.trim(), n = parseFloat(s); return s.endsWith('ms') ? n : s.endsWith('s') ? n * 1000 : n; };

/** A move's length (or a delay in it) at the OS's pace. */
export const paced = (ms: number) => ms * pace();
/** `then`, once a move of `ms` (at the OS's pace) is over: timed on the moves' own clock, so it keeps with the move
 * it waits for however they are played. Cancelled, it never comes. */
export const after = (ms: number, then: () => void): Animation => {
  const a = document.documentElement.animate([], {duration: reduced() ? 0 : paced(ms)});
  a.finished.then(then, () => {});
  return a;
};

/** Less motion asked for (the system's own setting): nothing moves, the rail's ink included. */
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Motion is a user preference, never a global experiment switch. */
export const still = reduced;

/** Changing the OS preference settles work already on screen, including pending dismissal callbacks. */
if (typeof matchMedia !== 'undefined') matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (event) => {
  if (!event.matches) return;
  for (const animation of document.getAnimations()) {
    const timing = animation.effect?.getComputedTiming();
    if (timing && Number.isFinite(timing.endTime)) animation.finish();
    else animation.cancel();
  }
});

/** Where `el` is now, to glide from once it is no longer the one chosen. */
export const where = (el: Element | null | undefined): DOMRect | null => el?.getBoundingClientRect() ?? null;

/**
 * The ink goes from `from` (a place measured before the choice) to `to` (the one chosen now), as a slug laid in
 * `layer` (positioned, under its children: `isolation: isolate`, the slug at z-index -1). `round` is the slug's
 * corner. The words of each it goes over are as the ink under them is: light while the slug covers half of it or more
 * (`.under-ink`: the one it leaves, those it passes, the one it lands on), in ink otherwise (`to` waits un-inked,
 * `.arriving`), so none is ever ink on ink, an icon gone as the slug goes by.
 */
export function glide(from: DOMRect | null, to: HTMLElement | null, layer: HTMLElement, round: string, ms = 220) {
  // One still on its way in this layer (another place pressed before it landed) gives way: the ink goes on from where
  // it is now, never back from the place it was going to, nor as a second ink beside the first.
  const going = gliding.get(layer);
  if (going) { from = going.at() ?? from; going.end(); }
  if (!from || !to || still()) return;
  const at = to.getBoundingClientRect();
  if (!at.width || (Math.abs(from.left - at.left) < 1 && Math.abs(from.top - at.top) < 1)) return;
  const box = layer.getBoundingClientRect();
  const slug = document.createElement('span');
  slug.className = 'glide-ink';
  slug.setAttribute('aria-hidden', 'true');
  Object.assign(slug.style, {left: `${at.left - box.left + layer.scrollLeft}px`, top: `${at.top - box.top + layer.scrollTop}px`,
    width: `${at.width}px`, height: `${at.height}px`, borderRadius: round});
  layer.append(slug);
  to.classList.add('arriving');
  // What it can go over: `to` and the others in a row with it (the rail's places, the band's pills).
  const row = [...(to.parentElement?.children ?? [])].filter((el) => el !== slug);
  let over = false;
  /** How much of `el` the slug covers now (0 to 1). */
  const covered = (el: Element) => {
    const s = slug.getBoundingClientRect(), r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(s.right, r.right) - Math.max(s.left, r.left)), h = Math.max(0, Math.min(s.bottom, r.bottom) - Math.max(s.top, r.top));
    return r.width && r.height ? (w * h) / (r.width * r.height) : 0;
  };
  // The one it lands on is as the others are while the slug comes: its own fill waits, so the slug never has a second
  // box under it, the place's own ink showing past its edge before it has arrived.
  const follow = () => {
    if (over) return;
    for (const el of row) {
      const under = covered(el) >= .5;
      if (el === to) to.classList.toggle('arriving', !under);
      el.classList.toggle('under-ink', under);
    }
    requestAnimationFrame(follow);
  };
  // Landed, it is inked at once in the slug's place: its own fill does not ease in after the slug has gone.
  const done = () => {
    if (over) return;
    over = true;
    if (gliding.get(layer) === mine) gliding.delete(layer);
    to.style.transition = 'none';
    slug.remove();
    to.classList.remove('arriving');
    for (const el of row) el.classList.remove('under-ink');
    void to.offsetWidth;
    to.style.transition = '';
  };
  const a = slug.animate([
    {transform: `translate(${from.left - at.left}px, ${from.top - at.top}px)`, width: `${from.width}px`, height: `${from.height}px`},
    {transform: 'none', width: `${at.width}px`, height: `${at.height}px`},
  ], {duration: paced(ms), easing: LAND});
  // Where it is now, unless its row was drawn anew with it in it (it went with the row).
  const mine = {at: () => (slug.isConnected ? slug.getBoundingClientRect() : null), end: () => { done(); a.cancel(); }};
  gliding.set(layer, mine);
  a.finished.then(done, done);
  // Who is under it, from its first frame: read once it stands where it sets off (before, it stood on the place it
  // goes to, and for a frame that one went light and the one left ink on ink).
  follow();
}
/** The glide on its way in each layer (the rail's places, a band's pills). */
const gliding = new WeakMap<HTMLElement, {at(): DOMRect | null; end(): void}>();

/** Change repository immediately; a short directional arrival preserves its position along the band.
 * No snapshot holds input or queues a second navigation behind the first. */
export function panAcross(el: HTMLElement, dir: number, update: () => void) {
  update();
  if (dir && el.isConnected) arrive(el, dir, 'x', 16, 200);
}

/** Only one arrival owns an element, even when a newer selection interrupts it. */
const arrivals = new WeakMap<HTMLElement, Animation>();

/**
 * `el` comes in from `dir` (-1, 0 or 1) along `axis`: `by` pixels and a fade. `into`: how far in it already is, for
 * a thing drawn again while it came in, which goes on from there rather than starting over or stopping.
 */
export function arrive(el: HTMLElement, dir: number, axis: 'x' | 'y', by = 12, ms = 240, into = 0) {
  arrivals.get(el)?.cancel();
  arrivals.delete(el);
  ms = paced(ms);
  if (still() || into >= ms) return;
  const d = (dir || 1) * by;
  const animation = el.animate([{transform: axis === 'x' ? `translateX(${d}px)` : `translateY(${d}px)`, opacity: 0}, {transform: 'none', opacity: 1}],
    {duration: ms, delay: -into, easing: LAND});
  arrivals.set(el, animation);
  const done = () => { if (arrivals.get(el) === animation) arrivals.delete(el); };
  animation.finished.then(done, done);
}

/** The pane's contents arrive together, immediately readable. Its search and switch remain fixed;
 * the CSS edge transition supplies the opening/closing continuity, with no delayed word cascade. */
export function paneOut(side: HTMLElement, _toggle: HTMLElement, _search?: HTMLElement | null, _words = true) {
  arrive(side, 1, 'x', 8, 180);
}

/** Closing interrupts arrival instead of leaving hidden, paused words behind. */
export function paneIn(side: HTMLElement) {
  arrivals.get(side)?.cancel();
  arrivals.delete(side);
}

/**
 * A thing opened from where it was shown (a repo's card on Home, its row in File) becomes the box it opens as:
 * a sheet grows from `from` (measured before the page changed) to the box found by `find` once it is on the
 * screen, so the eye goes with the repo instead of starting over on a new page. The box it becomes waits out of
 * sight while the sheet goes to it, and shows as the sheet lands: one box the whole way, never two at once.
 */
/** A thing's words as they stand, copied where and as they are drawn, for a morph to carry (taken before the thing
 * is drawn again and they are gone). */
export type Lifted = {el: HTMLElement; rect: DOMRect};
export function lift(el: Element | null | undefined): Lifted | null {
  const rect = el?.getBoundingClientRect();
  if (!el || !rect?.width) return null;
  const copy = el.cloneNode(true) as HTMLElement;
  const cs = getComputedStyle(el);
  copy.removeAttribute('id');
  copy.setAttribute('aria-hidden', 'true');
  copy.classList.add('morph-words');
  Object.assign(copy.style, {left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    font: cs.font, color: cs.color, letterSpacing: cs.letterSpacing});
  return {el: copy, rect};
}

/** The first line of what is written in `field`, lifted where it is drawn in it (as `lift` lifts a thing's words). */
export function liftLine(field: HTMLTextAreaElement): Lifted | null {
  const line = field.value.split('\n')[0]?.trim();
  const r = field.getBoundingClientRect();
  if (!line || !r.width) return null;
  const cs = getComputedStyle(field), at = textAt(field, 0);
  const el = document.createElement('div');
  el.className = 'morph-words';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = line;
  Object.assign(el.style, {left: `${at.left}px`, top: `${at.top}px`, height: `${at.height}px`,
    font: cs.font, color: cs.color, letterSpacing: cs.letterSpacing});
  // After the font, whose shorthand sets it too: one line as tall as the field's.
  el.style.lineHeight = `${at.height}px`;
  return {el, rect: at};
}

/** Where line `i` (from 0) of what is written in `area` is drawn, as tall as a line, from where its words start. */
export function textAt(area: HTMLTextAreaElement, i: number): DOMRect {
  const r = area.getBoundingClientRect(), cs = getComputedStyle(area);
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.5;
  const left = r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0) - area.scrollLeft;
  const top = r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0) + i * lh - area.scrollTop;
  return new DOMRect(left, top, Math.max(0, r.right - left), lh);
}

/** A thing's words carried by a morph (`lifted`) onto what they become in the box it lands on (`to`: an element, or
 * where its words are drawn); `rest`, what else the thing held. */
export type Carry = {lifted: Lifted; to(target: HTMLElement): Element | DOMRect | null; rest?: HTMLElement};

export function morph(from: DOMRect, find: () => HTMLElement | null, ms = 340, round = '', patience = 40, carry?: Carry) {
  if (still() || !from.width) return false;
  ms = paced(ms);
  // The outline stands where the thing was at once, so the eye has it while the page it goes to is drawn (a repo read
  // from the store a moment later); it goes on once its box is there, or fades where it stood if none comes.
  const box = document.createElement('div');
  box.className = 'morph-box';
  box.setAttribute('aria-hidden', 'true');
  // A field becomes a field: its own corner, not a box's.
  if (round) box.style.borderRadius = round;
  const rect = (r: DOMRect) => ({left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`});
  Object.assign(box.style, rect(from));
  document.body.append(box);
  // What else the thing held (`rest`: a copy of it as it was, its words left out) is in the sheet as it sets off and
  // fades as it goes, cut by the sheet's edges as they close in: never an empty sheet where the thing stood.
  const rest = carry?.rest;
  if (rest) {
    const edge = parseFloat(getComputedStyle(box).borderTopWidth) || 0;
    Object.assign(rest.style, {position: 'absolute', left: `${-edge}px`, top: `${-edge}px`, width: `${from.width}px`, margin: '0',
      borderColor: 'transparent', background: 'transparent', pointerEvents: 'none'});
    rest.inert = true;
    rest.setAttribute('aria-hidden', 'true');
    box.style.overflow = 'hidden';
    box.append(rest);
    rest.animate([{opacity: 1}, {opacity: 0}], {duration: paced(180), easing: SPRING, fill: 'forwards'});
  }
  // Its words go with it, from where they were read to the words they become (the issue's title onto its line).
  const words = carry?.lifted.el;
  if (words) document.body.append(words);
  const done = () => { box.remove(); words?.remove(); };
  /** Gone where it stands: no box came for it, or the camera went on to another page meanwhile (the sheet is over
   * the window, not in the page: it would hang there as the pages go by under it). */
  const fade = (ms2 = 160) => {
    if (still()) { done(); return; }
    words?.animate([{opacity: 1}, {opacity: 0}], {duration: paced(ms2), fill: 'forwards'});
    box.animate([{opacity: 1}, {opacity: 0}], {duration: paced(ms2), fill: 'forwards'}).finished.then(done, done);
  };
  let tries = 0;
  const go = () => {
    if (still()) { done(); return; }
    let to = find();
    const at = to?.getBoundingClientRect();
    if (!to || !at?.width) {
      if (++tries < patience) requestAnimationFrame(go); else fade();
      return;
    }
    to.style.visibility = 'hidden';
    // The page drawn again while the sheet is on its way (read again a moment after) puts a new box where it goes: that
    // one waits out of sight as the first did, never shown under the sheet before it lands.
    let flying = true;
    const keep = () => {
      if (!flying) return;
      const now = find();
      if (now && now !== to) { to!.style.visibility = ''; to = now; now.style.visibility = 'hidden'; }
      requestAnimationFrame(keep);
    };
    requestAnimationFrame(keep);
    const shown = () => { flying = false; to!.style.visibility = ''; };
    // The sheet goes to where its box is in each frame, not where it was when it set off: the page closing up under it
    // meanwhile (a part folding away, read again), it lands on its box, never a few pixels off and then jumping. The
    // move's own timing (an animation that does nothing) says how far along it is, at the OS's pace.
    const timer = box.animate([{opacity: 1}, {opacity: 1}], {duration: ms, easing: LAND, fill: 'forwards'});
    let gone = false;
    const r0 = carry?.lifted.rect;
    const mix = (a: number, b: number, p: number) => a + (b - a) * p;
    const step = () => {
      // Its box gone from the page (another page come to) before it landed: it fades where it is, not to nowhere.
      if (!to!.isConnected || !to!.getClientRects().length) { if (timer.playState === 'running') { gone = true; timer.cancel(); shown(); fade(100); } return; }
      const p = timer.effect?.getComputedTiming().progress ?? 1, now = to!.getBoundingClientRect();
      Object.assign(box.style, {left: `${mix(from.left, now.left, p)}px`, top: `${mix(from.top, now.top, p)}px`,
        width: `${mix(from.width, now.width, p)}px`, height: `${mix(from.height, now.height, p)}px`});
      const onto = words && r0 ? carry!.to(to!) : null;
      const goal = onto instanceof Element ? onto.getBoundingClientRect() : onto;
      if (words && r0 && goal?.height) {
        words.style.transform = `translate(${mix(0, goal.left - r0.left, p)}px, ${mix(0, goal.top - r0.top, p)}px) scale(${mix(1, goal.height / r0.height, p)})`;
      }
      if (timer.playState === 'running') requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    timer.finished.then(() => {
      step();
      // Landed: the box is there under it, and the sheet gives way to it.
      shown();
      if (still()) { done(); return; }
      to!.animate([{opacity: 0}, {opacity: 1}], {duration: paced(140), easing: SPRING});
      words?.animate([{opacity: 1}, {opacity: 0}], {duration: paced(140), easing: SPRING, fill: 'forwards'});
      box.animate([{opacity: 1}, {opacity: 0}], {duration: paced(140), easing: SPRING, fill: 'forwards'}).finished.then(done, done);
    }, () => { shown(); if (!gone) done(); });
  };
  requestAnimationFrame(go);
  return true;
}

/**
 * A name that cannot be (taken, or not a name): the field gives a short shake, side to side and less each time, as
 * a head does saying no, while the keyboard goes back to it. Once, never on its own.
 */
export function nudge(el: Element | null) {
  if (still() || !el) return;
  el.animate([{translate: '0 0'}, {translate: '-5px 0'}, {translate: '4px 0'}, {translate: '-2px 0'}, {translate: '1px 0'}, {translate: '0 0'}],
    {duration: paced(300), easing: SPRING});
}

/** What stood under something taken away closes up over where it was (`by` pixels), rather than being there at once. */
export function closeUp(els: Element[], by: number, ms = 220) {
  if (still() || !by) return;
  for (const el of els) el.animate([{translate: `0 ${by}px`}, {translate: '0 0'}], {duration: paced(ms), easing: LAND});
}

/** What is on its way out (putAway), so that shown again meanwhile it stays (keepOut), and whether it was inert. */
const goingOut = new WeakMap<Element, {a: Animation; inert: boolean}>();

/**
 * Put away, as it came, never at once: a menu, an ask, a line under a box goes a few pixels back toward where it came
 * from (its --from, as menu-in brings it), a touch smaller, fading, and only then is it hidden or taken away (`gone`).
 * A folder closed (`fold`) folds up instead, what stands under it closing up as it does. Going out quicker than it
 * came (150 ms of the pace to 280): what is done with leaves the eye. Already going, it is not started again. On its
 * way it is inert: nothing in it is pressed or found (a menu going is no longer a menu).
 */
/**
 * A thing at its full room and at none, for folding it up or out: its height and everything else that holds room
 * (its least height, the room inside and round it, its edges), so it goes all the way to nothing, and what stands
 * under it is never left to jump the last of the way once it is hidden.
 */
function folded(el: HTMLElement): [Keyframe, Keyframe] {
  const cs = getComputedStyle(el);
  const room = ['paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'borderTopWidth', 'borderBottomWidth'] as const;
  // Its height alone says how much room it takes as it goes: a share of a column's free room (a Forge box's flex-grow)
  // given on top would have it stand at half its size in the first frame.
  const full: Keyframe = {height: `${el.getBoundingClientRect().height}px`, minHeight: '0px', flexGrow: '0', opacity: 1, overflow: 'hidden'};
  const none: Keyframe = {height: '0px', minHeight: '0px', flexGrow: '0', opacity: 0, overflow: 'hidden'};
  for (const k of room) { full[k] = cs[k]; none[k] = '0px'; }
  return [full, none];
}

export function putAway(el: HTMLElement, gone: () => void, o: {fold?: boolean; ms?: number} = {}) {
  if (goingOut.has(el)) return;
  if (still() || el.hidden || !el.isConnected || !el.getClientRects().length) { gone(); return; }
  const from = getComputedStyle(el).getPropertyValue('--from').trim() || '0 4px';
  const frames: Keyframe[] = o.fold
    ? folded(el)
    : [{opacity: 1, translate: '0 0', scale: 1}, {opacity: 0, translate: from, scale: .96}];
  const a = el.animate(frames, {duration: paced(o.ms ?? 150), easing: SPRING, fill: 'forwards'});
  const going = {a, inert: el.inert};
  goingOut.set(el, going);
  el.inert = true;
  a.finished.then(() => {
    if (goingOut.get(el) !== going) return;
    goingOut.delete(el);
    el.inert = going.inert;
    gone();
    a.cancel();
  }, () => {});
}

/** Opened (a folder), it unfolds as a closed one folds: from nothing to its height, what stands under it making way. */
export function unfold(el: HTMLElement, ms = 200) {
  if (still()) return;
  if (!el.getBoundingClientRect().height) return;
  const [full, none] = folded(el);
  el.animate([none, full], {duration: paced(ms), easing: LAND});
}

/** Shown again while it was going out: it stays, coming back from where it had got to the way it was going (a menu
 * half faded fades back in, a folder half folded opens again from there), never at once to where it stood. */
export function keepOut(el: HTMLElement) {
  const going = goingOut.get(el);
  if (!going) return;
  goingOut.delete(el);
  el.inert = going.inert;
  const a = going.a;
  a.finished.then(() => a.cancel(), () => {});
  a.reverse();
}

/** A thing just done is rewarded: it pops past its size and settles (a TODO's mark once done). */
export function pop(el: Element, by = .16, ms = 380) {
  if (still()) return;
  el.animate([{scale: 1 - by * 2}, {scale: 1 + by, offset: .5}, {scale: 1}], {duration: paced(ms), easing: SPRING});
}

/** What stays where it is while a page comes and goes: the band and the panes, the window's own instruments. */
const FRAME = ':is(.home-band, .home-pane, .work > .bar, .work > .side, .work > .pane-toggle)';

/** `el` as it is seen now, as a thing of its own that nothing happens to: a copy with what is written in its fields
 * and drawn on its canvases (`settle`, once it is in the document, puts each part where it was scrolled to). */
function likeness(el: Element): {copy: Element; settle(): void} {
  const copy = el.cloneNode(true) as Element;
  const was = [el, ...el.querySelectorAll('*')], now = [copy, ...copy.querySelectorAll('*')];
  const scrolled: [Element, number, number][] = [];
  was.forEach((a, i) => {
    const b = now[i];
    if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) (b as HTMLInputElement).value = a.value;
    else if (a instanceof HTMLCanvasElement && a.width && a.height) (b as HTMLCanvasElement).getContext('2d')?.drawImage(a, 0, 0);
    if (a.scrollLeft || a.scrollTop) scrolled.push([b, a.scrollLeft, a.scrollTop]);
    b.removeAttribute('id');
  });
  return {copy, settle: () => { for (const [b, x, y] of scrolled) { (b as HTMLElement).style.scrollSnapType = 'none'; b.scrollLeft = x; b.scrollTop = y; } }};
}

/**
 * The world gone up or down to another place (`dir`: 1 to one further down the rail, -1 to one further up): asked
 * before the page is drawn again, it keeps the place left in sight as it was; what it gives back is called once the
 * new place is drawn. Then the place left goes out the way the world went by, the new one comes in after it from
 * the other side, and the ground goes with them: one move, a window's height in whole cells, by the OS's law
 * (law.ts). The band and the rail are the window's and stay. Nothing waits on it: the new place is there to be used
 * from the first frame. Asked for less motion, there is no move.
 */
export function travel(root: HTMLElement, dir: number): () => void {
  if (still() || !dir || !root.getClientRects().length) return () => {};
  const far = CELL * Math.round(innerHeight / CELL), ms = paced(moveTime(far, far)), timing = {duration: ms, easing: SPRING};
  const at = root.getBoundingClientRect();
  const page = root.cloneNode(false) as HTMLElement;
  for (const name of ['id', 'tabindex', 'aria-labelledby']) page.removeAttribute(name);
  const settles: (() => void)[] = [];
  for (const child of root.children) {
    if ((child as HTMLElement).hidden) continue;
    const {copy, settle} = likeness(child);
    page.append(copy);
    settles.push(settle);
  }
  const left = document.createElement('div');
  left.className = 'place-left';
  left.inert = true;
  left.setAttribute('aria-hidden', 'true');
  Object.assign(left.style, {left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px`, height: `${at.height}px`});
  left.append(page);
  document.body.append(left);
  for (const settle of settles) settle();
  for (const part of left.querySelectorAll(FRAME)) (part as HTMLElement).style.visibility = 'hidden';
  const gone = () => left.remove();
  left.animate([{transform: 'none'}, {transform: `translateY(${-dir * far}px)`}], {...timing, fill: 'forwards'}).finished.then(gone, gone);
  document.body.animate([{backgroundPositionY: '0px'}, {backgroundPositionY: `${-dir * far}px`}], timing);
  return () => {
    stopStage(root);
    const surfaces = surfacesOf(root);
    staged.set(root, surfaces);
    for (const part of surfaces) {
      const animation = part.animate([{transform: `translateY(${dir * far}px)`}, {transform: 'none'}], timing);
      arrivals.set(part, animation);
      const done = () => { if (arrivals.get(part) === animation) arrivals.delete(part); };
      animation.finished.then(done, done);
    }
  };
}

/** The parts of `root` that are the page's own (its frame left where it is). */
function surfacesOf(root: HTMLElement): HTMLElement[] {
  const parts = (el: HTMLElement): HTMLElement[] => {
    if (!el.getClientRects().length || el.matches(FRAME)) return [];
    if (!el.querySelector(FRAME)) return [el];
    return [...el.children].flatMap((child) => parts(child as HTMLElement));
  };
  return parts(root);
}

const staged = new WeakMap<HTMLElement, HTMLElement[]>();
/** Release a shared root before it is reused by another page. */
export function stopStage(root: HTMLElement) {
  for (const part of staged.get(root) ?? []) { arrivals.get(part)?.cancel(); arrivals.delete(part); }
  staged.delete(root);
}

/** A page arrives as one readable surface. Data never counts up from invented values, and asynchronous
 * cards are never hidden again for a stagger. The rail, band and pane stay fixed as landmarks. */
export function stage(root: HTMLElement, dir: number) {
  stopStage(root);
  const surfaces = surfacesOf(root);
  staged.set(root, surfaces);
  for (const part of surfaces) arrive(part, dir, 'y', 12, 200);
}
