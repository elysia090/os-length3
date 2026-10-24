// Motion with a reason. Two moves the whole OS makes the same way, so each says one thing wherever it is seen:
//
// - glide(): the ink of the thing chosen goes from the one it was on to the one it is on (the rail's places, the
//   band's pills), under their words, so the eye follows the choice instead of seeing one go out and another
//   light up.
// - arrive(): a page or a box coming in moves from the side it is on (down the rail, the next page comes up from
//   below; along the band, the next repo from the right), a few pixels and a fade, never a jump.
//
// Asked for less motion, neither moves: each thing is where it ends at once.

/** The camera's landing (styles.css --land): fast off the mark, the last pixels slow. */
export const LAND = 'cubic-bezier(.2, .9, .25, 1)';

/** The animations' own clock (ms): what their delays and lengths are counted on, so what is timed against them keeps
 * with them however they are played (the page's clock where there is none). */
export const clock = () => { const t = document.timeline.currentTime; return typeof t === 'number' ? t : performance.now(); };

/** Whether motion is turned off (reduced motion): each thing is where it ends, at once. */
export const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  const follow = () => {
    if (over) return;
    for (const el of row) {
      const under = covered(el) >= .5;
      if (el === to) to.classList.toggle('arriving', !under); else el.classList.toggle('under-ink', under);
    }
    requestAnimationFrame(follow);
  };
  follow();
  // Landed, it is inked at once in the slug's place: its own fill does not ease in after the slug has gone.
  const done = () => {
    over = true;
    to.style.transition = 'none';
    slug.remove();
    to.classList.remove('arriving');
    for (const el of row) el.classList.remove('under-ink');
    void to.offsetWidth;
    to.style.transition = '';
  };
  slug.animate([
    {transform: `translate(${from.left - at.left}px, ${from.top - at.top}px)`, width: `${from.width}px`, height: `${from.height}px`},
    {transform: 'none', width: `${at.width}px`, height: `${at.height}px`},
  ], {duration: ms, easing: LAND}).finished.then(done, done);
}

type Transitioning = Document & {startViewTransition?(update: () => void): {finished: Promise<void>}};

/**
 * A change of what `el` shows, as a camera pans along a row (the band's repos, left to right): what it showed goes
 * off the other way, gathering speed a short way, as what comes rises in from `dir`'s side (-1 left, 1 right) and
 * slows into place, the two never both half seen in one place and the place never empty. Only `el` is taken as a
 * picture; the window around it goes on as it is (the band's ink, the pane). Where the browser cannot, or less
 * motion is asked for, the change is made in place.
 */
export function panAcross(el: HTMLElement, dir: number, update: () => void) {
  const begin = (document as Transitioning).startViewTransition;
  if (still() || !begin || !dir || !el.isConnected) { update(); return; }
  const root = document.documentElement;
  root.style.setProperty('--pan-x', String(dir));
  el.style.setProperty('view-transition-name', 'across');
  root.classList.add('panning-across');
  const done = () => { el.style.removeProperty('view-transition-name'); root.classList.remove('panning-across'); };
  begin.call(document, update).finished.then(done, done);
}

/**
 * `el` comes in from `dir` (-1, 0 or 1) along `axis`: `by` pixels and a fade. `into`: how far in it already is, for
 * a thing drawn again while it came in, which goes on from there rather than starting over or stopping.
 */
export function arrive(el: HTMLElement, dir: number, axis: 'x' | 'y', by = 12, ms = 240, into = 0) {
  if (still() || into >= ms) return;
  const d = (dir || 1) * by;
  el.animate([{transform: axis === 'x' ? `translateX(${d}px)` : `translateY(${d}px)`, opacity: 0}, {transform: 'none', opacity: 1}],
    {duration: ms, delay: -into, easing: LAND});
}

/**
 * The right pane brought out: as its edge lands, what it holds comes in after it, a part at a time from the side it
 * came from, and its switch's mark gives a small beat. Put away, it only goes (the wipe is the styles' own).
 */
export function paneOut(side: HTMLElement, toggle: HTMLElement) {
  if (still()) return;
  // Its words, each where it stands (a head, a line), in reading order: not the boxes they are in, and not words
  // inside words already moving (they would come twice as far).
  const worded = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
  const parts: HTMLElement[] = [];
  for (const el of side.querySelectorAll<HTMLElement>('*')) {
    if (parts.length === 8) break;
    if (worded(el) && el.getBoundingClientRect().height > 0 && !parts.some((p) => p.contains(el))) parts.push(el);
  }
  parts.forEach((el, i) => el.animate([{opacity: 0, translate: '24px 0'}, {opacity: 1, translate: '0 0'}],
    {duration: 340, delay: 140 + i * 50, easing: LAND, fill: 'backwards'}));
  const m = toggle.querySelector('.mark');
  if (m) m.animate([{scale: 1}, {scale: 1.18, offset: .45}, {scale: 1}], {duration: 320, delay: 200, easing: 'ease-out'});
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

export function morph(from: DOMRect, find: () => HTMLElement | null, ms = 340, round = '', patience = 40,
  carry?: {lifted: Lifted; to(target: HTMLElement): Element | null}) {
  if (still() || !from.width) return false;
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
  // Its words go with it, from where they were read to the words they become (the issue's title onto its line).
  const words = carry?.lifted.el;
  if (words) document.body.append(words);
  const done = () => { box.remove(); words?.remove(); };
  let tries = 0;
  const go = () => {
    const to = find();
    const at = to?.getBoundingClientRect();
    if (!to || !at?.width) {
      if (++tries < patience) requestAnimationFrame(go);
      else {
        words?.animate([{opacity: 1}, {opacity: 0}], {duration: 160, fill: 'forwards'});
        box.animate([{opacity: 1}, {opacity: 0}], {duration: 160, fill: 'forwards'}).finished.then(done, done);
      }
      return;
    }
    to.style.visibility = 'hidden';
    const shown = () => { to.style.visibility = ''; };
    const goal = words && carry?.to(to)?.getBoundingClientRect();
    if (words && goal?.height) {
      const r0 = carry!.lifted.rect;
      words.animate([{transform: 'none'}, {transform: `translate(${goal.left - r0.left}px, ${goal.top - r0.top}px) scale(${goal.height / r0.height})`}],
        {duration: ms, easing: LAND, fill: 'forwards'});
    }
    box.animate([rect(from), rect(at)], {duration: ms, easing: LAND, fill: 'forwards'}).finished.then(() => {
      // Landed: the box is there under it, and the sheet gives way to it.
      shown();
      to.animate([{opacity: 0}, {opacity: 1}], {duration: 140, easing: 'ease-out'});
      words?.animate([{opacity: 1}, {opacity: 0}], {duration: 140, easing: 'ease-out', fill: 'forwards'});
      box.animate([{opacity: 1}, {opacity: 0}], {duration: 140, easing: 'ease-out', fill: 'forwards'}).finished.then(done, done);
    }, () => { shown(); done(); });
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
    {duration: 300, easing: 'ease-out'});
}

/** What stood under something taken away closes up over where it was (`by` pixels), rather than being there at once. */
export function closeUp(els: Element[], by: number, ms = 220) {
  if (still() || !by) return;
  for (const el of els) el.animate([{translate: `0 ${by}px`}, {translate: '0 0'}], {duration: ms, easing: LAND});
}

/** A thing just done is rewarded: it pops past its size and settles (a TODO's mark once done). */
export function pop(el: Element, by = .16, ms = 380) {
  if (still()) return;
  el.animate([{scale: 1 - by * 2}, {scale: 1 + by, offset: .5}, {scale: 1}], {duration: ms, easing: 'ease-out'});
}

/** A figure counted up from nothing to what it says ("7.9 MB", "3"), its unit kept, landing as the camera does. */
export function countUp(el: HTMLElement, ms = 560) {
  const text = el.textContent ?? '';
  const m = /^(\d+(?:\.\d+)?)(.*)$/s.exec(text);
  if (still() || !m) return;
  const to = parseFloat(m[1]), places = m[1].split('.')[1]?.length ?? 0, rest = m[2];
  if (!to) return;
  // Timed by the frames' own clock from the first frame it is drawn in (not the page's clock, which a frame's time
  // can be behind: it would count from below nothing).
  let t0 = -1;
  const step = (now: number) => {
    // Written over meanwhile (the figure read again): what it says now is left as it is.
    if (!el.isConnected || !(el.textContent ?? '').endsWith(rest)) return;
    if (t0 < 0) t0 = now;
    const k = Math.min(1, Math.max(0, (now - t0) / ms));
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = k < 1 ? `${(to * eased).toFixed(places)}${rest}` : text;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** A page's parts, each a beat of its arrival: a heading, a card, a box, a pill, a file. */
const BEATS = ['.page-head', '.identity', 'section > h2', '.todo-box', '.card', '.part-bar', '.meter', '.legend > span', '.space-box',
  '.sign-in-card', '.stub-holder', '.inbox-box', '.new-repo > .field', '.git-filter .chip', '.issue-stage', '.issue-new',
  '.repo-strip .pill', '.repo-strip .band-add', '.col:not([hidden]) .file', '.repo-grid > .muted', '.home-servers > .muted'].join(', ');

/** The arrival under way: a page come to before the last had landed ends it, so the two never stage the same parts. */
let arriving: (() => void) | null = null;

/**
 * A page come to is staged rather than shown at once: its parts come in one after another in reading order (the
 * heading first, then down and along, a card at a time), each from the side the page comes from, so the eye is led
 * through it and the arrival lasts long enough to be followed; its figures count up, its bars fill. What is drawn a
 * moment later (read from the store, drawn again) is where its turn in that order is by then, from before it is
 * first painted: its turn to come, it comes; under way, it goes on from there (a part drawn again as it came in
 * goes on as it was); over, it simply stands, never shown and then taken away to come in again. A part in a row that
 * clips it (Git's repos, the band) comes in where it stands, fading, not up out of the row's edge; one put out of
 * sight before it was in is where its turn is once it is back.
 */
export function stage(root: HTMLElement, dir: number) {
  if (still()) return;
  arriving?.();
  const t0 = clock(), seen = new WeakSet<Element>(), moving = new Map<Element, Animation>();
  /** Whether each box clips what is in it, asked once an arrival (its style is read, not its size). */
  const clipping = new Map<Element, boolean>();
  const clips = (p: Element) => {
    let c = clipping.get(p);
    if (c === undefined) { const o = getComputedStyle(p); c = o.overflowX !== 'visible' || o.overflowY !== 'visible'; clipping.set(p, c); }
    return c;
  };
  /** In a row that clips it to about its own height: rising, it would come up out of a cut. */
  const tight = (el: HTMLElement, r: DOMRect) => {
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (clips(p) && p.clientHeight < r.height + 32) return true;
    return false;
  };
  const run = () => {
    // Put out of sight (or drawn again) before it was in: once back, it is where its turn is by then.
    for (const [el, a] of moving) {
      if (a.playState === 'finished') moving.delete(el);
      else if (!el.isConnected || !el.getClientRects().length) { a.cancel(); moving.delete(el); seen.delete(el); }
    }
    const tall = innerHeight;
    const beats = [...root.querySelectorAll<HTMLElement>(BEATS)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.top < tall && r.bottom > 0 && !el.parentElement?.closest(BEATS);
    }).map((el) => ({el, r: el.getBoundingClientRect()}))
      .sort((a, b) => (Math.abs(a.r.top - b.r.top) > 12 ? a.r.top - b.r.top : a.r.left - b.r.left));
    const late = clock() - t0;
    beats.forEach(({el, r}, i) => {
      if (seen.has(el)) return;
      seen.add(el);
      // Its turn, as the arrival's clock has it now: still to come, under way (gone on from there), or over.
      const turn = Math.min(i, 14) * 45 - late;
      if (turn <= -360) return;
      const from = tight(el, r) ? '0 0' : `0 ${(dir || 1) * 16}px`;
      moving.set(el, el.animate([{opacity: 0, translate: from}, {opacity: 1, translate: '0 0'}],
        {duration: 360, delay: turn, easing: LAND, fill: 'backwards'}));
    });
    for (const b of root.querySelectorAll<HTMLElement>('.counts b, .legend b')) { if (!seen.has(b)) { seen.add(b); countUp(b); } }
    for (const bar of root.querySelectorAll<HTMLElement>('.meter > span')) {
      if (seen.has(bar) || !bar.style.width) continue;
      seen.add(bar);
      bar.animate([{width: '0%'}, {width: bar.style.width}], {duration: 700, delay: 120, easing: LAND, fill: 'backwards'});
    }
  };
  run();
  requestAnimationFrame(() => requestAnimationFrame(run));
  // What is put in or shown while it arrives is heard as it is (before it is painted), for as long as the arrival
  // lasts; figures counting up change only their words, and are not heard.
  const heard = new MutationObserver((ms) => {
    if (ms.some((m) => m.type === 'attributes' || [...m.addedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE))) run();
  });
  heard.observe(root, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class']});
  // Ended by the next page come to: what it still had coming stands where it is, for the next to stage.
  const end = () => { heard.disconnect(); for (const a of moving.values()) a.cancel(); moving.clear(); if (arriving === end) arriving = null; };
  arriving = end;
  // It lasts as long as its parts' turns do, on their clock.
  const over = () => { heard.disconnect(); if (arriving === end) arriving = null; };
  root.animate([], {duration: 900}).finished.then(over, over);
}

/**
 * What was made goes where it is kept, as a thing picked up goes to the bag: a dot leaves it in an arc to that
 * place's icon on the rail, which takes it in with a pop (a file saved: Runtime while it is kept on this device,
 * Remote once the Remote keeps it). The second beat of the deed, a moment after it, leading the eye back to the rail.
 */
export function keep(from: Element, to: string, ms = 640) {
  const icon = document.getElementById(`purpose-${to}`);
  if (still() || !icon || !from.isConnected) return;
  const a = from.getBoundingClientRect(), b = icon.getBoundingClientRect();
  if (!a.width || !b.width) return;
  const x0 = a.right - 6, y0 = a.top + a.height / 2, x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
  // Two moves make the arc: the outer goes across, the dot in it rises and comes down onto the icon.
  const dot = document.createElement('span');
  dot.className = 'kept-dot';
  const path = document.createElement('span');
  path.className = 'kept-path';
  path.setAttribute('aria-hidden', 'true');
  path.append(dot);
  Object.assign(path.style, {left: `${x0}px`, top: `${y0}px`});
  document.body.append(path);
  const lift = Math.min(140, Math.abs(x1 - x0) * .22);
  path.animate([{transform: 'none'}, {transform: `translateX(${x1 - x0}px)`}], {duration: ms, easing: 'cubic-bezier(.5, 0, .3, 1)', fill: 'forwards'});
  dot.animate([{transform: 'none', scale: .6}, {transform: `translateY(${Math.min(0, y1 - y0) - lift}px)`, scale: 1.2, offset: .45}, {transform: `translateY(${y1 - y0}px)`, scale: .7}],
    {duration: ms, easing: 'ease-in-out', fill: 'forwards'})
    .finished.then(() => { path.remove(); pop(icon, .12, 340); }, () => path.remove());
}
