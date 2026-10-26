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
  const a = document.documentElement.animate([], {duration: paced(ms)});
  a.finished.then(then, () => {});
  return a;
};

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
  follow();
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
}
/** The glide on its way in each layer (the rail's places, a band's pills). */
const gliding = new WeakMap<HTMLElement, {at(): DOMRect | null; end(): void}>();

type Transitioning = Document & {startViewTransition?(update: () => void): {ready: Promise<void>; finished: Promise<void>}};

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
  const root = document.documentElement, ms = paced(400);
  el.style.setProperty('view-transition-name', 'across');
  root.classList.add('panning-across');
  // Only what it showed is taken as a picture. What it shows now comes in itself, so a press lands on it as it comes:
  // a picture of it would take no press until it had landed. It stands off at its side from the first frame.
  let mine: Animation | null = null;
  const pass = begin.call(document, () => {
    update();
    if (across !== pass) return;
    el.style.removeProperty('view-transition-name');
    mine = el.animate([{transform: `translateX(${dir * 100}%)`}, {transform: 'none'}], {duration: ms, easing: LAND});
    mine.pause();
  });
  across = pass;
  // The picture lies over what comes, so it is cut where what comes has reached as it steps back: the two set off in
  // one frame and keep step, never over each other.
  void pass.ready.then(() => {
    root.animate([
      {transform: 'none', opacity: 1, clipPath: 'inset(0)'},
      {transform: `translateX(${-dir * 22}%)`, opacity: 0, clipPath: dir > 0 ? 'inset(0 78% 0 0)' : 'inset(0 0 0 78%)'},
    ], {duration: ms, easing: LAND, fill: 'forwards', pseudoElement: '::view-transition-old(across)'});
    mine?.play();
  }, () => {});
  // Given way to a pan begun since (another pill pressed on the way), what it brought stands where it lands; the
  // picture's name and the mark are the new pan's own.
  const done = () => {
    mine?.finish();
    if (across !== pass) return;
    across = null;
    el.style.removeProperty('view-transition-name');
    root.classList.remove('panning-across');
  };
  pass.finished.then(done, done);
}
/** The band's pan going now (panAcross). */
let across: object | null = null;

/**
 * `el` comes in from `dir` (-1, 0 or 1) along `axis`: `by` pixels and a fade. `into`: how far in it already is, for
 * a thing drawn again while it came in, which goes on from there rather than starting over or stopping.
 */
export function arrive(el: HTMLElement, dir: number, axis: 'x' | 'y', by = 12, ms = 240, into = 0) {
  ms = paced(ms);
  if (still() || into >= ms) return;
  const d = (dir || 1) * by;
  el.animate([{transform: axis === 'x' ? `translateX(${d}px)` : `translateY(${d}px)`, opacity: 0}, {transform: 'none', opacity: 1}],
    {duration: ms, delay: -into, easing: LAND});
}

/**
 * The right pane brought out: as its edge lands, what it holds comes in after it, a part at a time from the side it
 * came from (its search box on the top line first, when it was put away with the pane), and its switch's mark gives
 * a small beat. Put away, it only goes (the wipe is the styles' own; paneIn). Brought back before it had gone (`words`
 * false), what it holds is still there and stays (what was on its way in goes on in); only the search, if it had gone
 * already, comes back.
 */
export function paneOut(side: HTMLElement, toggle: HTMLElement, search?: HTMLElement | null, words = true) {
  if (still()) return;
  const was = comingIn.get(side);
  for (const a of was?.words ?? []) if (words) a.cancel(); else a.play();
  was?.search?.cancel();
  if (search && !words && parseFloat(getComputedStyle(search).opacity) > .5) search = null;
  // Its words, each where it stands (a head, a line), in reading order: not the boxes they are in, and not words
  // inside words already moving (they would come twice as far).
  const worded = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
  // An icon beside words (a row's badge) comes with them, not ahead of them on the edge.
  const drawn = (el: Element) => el instanceof SVGSVGElement || el.matches('img, .lately-badge');
  // A line at a time (eight, at most): what stands on one line (a badge and its name) comes together.
  const parts: HTMLElement[] = search ? [search] : [], turns: number[] = search ? [0] : [];
  let line = parts.length - 1, top = NaN;
  for (const el of words ? side.querySelectorAll<HTMLElement>('*') : []) {
    if (!(worded(el) || drawn(el)) || parts.some((p) => p.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (!r.height) continue;
    if (!(Math.abs(r.top - top) < 8)) { line++; top = r.top; }
    if (line > 7) break;
    parts.push(el);
    turns.push(line);
  }
  const moves = parts.map((el, i) => el.animate([{opacity: 0, translate: '24px 0'}, {opacity: 1, translate: '0 0'}],
    {duration: paced(340), delay: paced(140 + turns[i] * 50), easing: LAND, fill: 'backwards'}));
  const searchMove = search ? moves.shift()! : null;
  comingIn.set(side, {words: words ? moves : was?.words ?? [], search: searchMove, searchBox: search ?? was?.searchBox ?? null});
  const m = toggle.querySelector('.mark');
  if (m) m.animate([{scale: 1}, {scale: 1.18, offset: .45}, {scale: 1}], {duration: paced(320), delay: paced(200), easing: 'ease-out'});
}

/** What paneOut set coming in, by the pane's side: its words' moves, and its search box and the move bringing it. */
const comingIn = new WeakMap<HTMLElement, {words: Animation[]; search: Animation | null; searchBox: HTMLElement | null}>();

/**
 * The right pane put away while what it holds was still coming in: what had not come in goes out with it as it is,
 * never coming on in as the pane goes; its search, still coming, goes from where it is, as a search put away goes.
 */
export function paneIn(side: HTMLElement) {
  const was = comingIn.get(side);
  if (!was || still()) return;
  for (const a of was.words) if (a.playState === 'running') a.pause();
  const box = was.searchBox;
  if (!box || was.search?.playState !== 'running') return;
  const cs = getComputedStyle(box), from: Keyframe = {opacity: cs.opacity, translate: cs.translate === 'none' ? '0 0' : cs.translate};
  was.search.cancel();
  was.search = box.animate([from, {opacity: 0, translate: '8px 0'}], {duration: paced(150), easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards'});
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
        words?.animate([{opacity: 1}, {opacity: 0}], {duration: paced(160), fill: 'forwards'});
        box.animate([{opacity: 1}, {opacity: 0}], {duration: paced(160), fill: 'forwards'}).finished.then(done, done);
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
      to.animate([{opacity: 0}, {opacity: 1}], {duration: paced(140), easing: 'ease-out'});
      words?.animate([{opacity: 1}, {opacity: 0}], {duration: paced(140), easing: 'ease-out', fill: 'forwards'});
      box.animate([{opacity: 1}, {opacity: 0}], {duration: paced(140), easing: 'ease-out', fill: 'forwards'}).finished.then(done, done);
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
    {duration: paced(300), easing: 'ease-out'});
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
  const full: Keyframe = {height: `${el.getBoundingClientRect().height}px`, minHeight: '0px', opacity: 1, overflow: 'hidden'};
  const none: Keyframe = {height: '0px', minHeight: '0px', opacity: 0, overflow: 'hidden'};
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
  const a = el.animate(frames, {duration: paced(o.ms ?? 150), easing: o.fold ? 'cubic-bezier(.4, 0, .2, 1)' : 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards'});
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

/** Shown again while it was going out: it stays, as it was. */
export function keepOut(el: HTMLElement) {
  const going = goingOut.get(el);
  if (!going) return;
  goingOut.delete(el);
  el.inert = going.inert;
  going.a.cancel();
}

/** A thing just done is rewarded: it pops past its size and settles (a TODO's mark once done). */
export function pop(el: Element, by = .16, ms = 380) {
  if (still()) return;
  el.animate([{scale: 1 - by * 2}, {scale: 1 + by, offset: .5}, {scale: 1}], {duration: paced(ms), easing: 'ease-out'});
}

/** A figure counted up from nothing to what it says ("7.9 MB", "3"), its unit kept, landing as the camera does. */
export function countUp(el: HTMLElement, ms = 560) {
  const text = el.textContent ?? '';
  const m = /^(\d+(?:\.\d+)?)(.*)$/s.exec(text);
  if (still() || !m) return;
  ms = paced(ms);
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
      const turn = paced(Math.min(i, 14) * 45) - late;
      if (turn <= -paced(360)) return;
      const from = tight(el, r) ? '0 0' : `0 ${(dir || 1) * 16}px`;
      moving.set(el, el.animate([{opacity: 0, translate: from}, {opacity: 1, translate: '0 0'}],
        {duration: paced(360), delay: turn, easing: LAND, fill: 'backwards'}));
    });
    for (const b of root.querySelectorAll<HTMLElement>('.counts b, .legend b')) { if (!seen.has(b)) { seen.add(b); countUp(b); } }
    for (const bar of root.querySelectorAll<HTMLElement>('.meter > span')) {
      if (seen.has(bar) || !bar.style.width) continue;
      seen.add(bar);
      bar.animate([{width: '0%'}, {width: bar.style.width}], {duration: paced(700), delay: paced(120), easing: LAND, fill: 'backwards'});
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
  root.animate([], {duration: paced(900)}).finished.then(over, over);
}
