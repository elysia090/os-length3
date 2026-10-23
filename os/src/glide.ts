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

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where `el` is now, to glide from once it is no longer the one chosen. */
export const where = (el: Element | null | undefined): DOMRect | null => el?.getBoundingClientRect() ?? null;

/**
 * The ink goes from `from` (a place measured before the choice) to `to` (the one chosen now), as a slug laid in
 * `layer` (positioned, under its children: `isolation: isolate`, the slug at z-index -1). `to` waits un-inked
 * (`.arriving`) until it lands. `round` is the slug's corner.
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
  const done = () => { slug.remove(); to.classList.remove('arriving'); };
  slug.animate([
    {transform: `translate(${from.left - at.left}px, ${from.top - at.top}px)`, width: `${from.width}px`, height: `${from.height}px`},
    {transform: 'none', width: `${at.width}px`, height: `${at.height}px`},
  ], {duration: ms, easing: LAND}).finished.then(done, done);
}

/** `el` comes in from `dir` (-1, 0 or 1) along `axis`: `by` pixels and a fade. */
export function arrive(el: HTMLElement, dir: number, axis: 'x' | 'y', by = 12, ms = 240) {
  if (still()) return;
  const d = (dir || 1) * by;
  el.animate([{transform: axis === 'x' ? `translateX(${d}px)` : `translateY(${d}px)`, opacity: 0}, {transform: 'none', opacity: 1}],
    {duration: ms, easing: LAND});
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
 * an outline grows from `from` (measured before the page changed) to the box found by `find` once it is on the
 * screen, and fades as it lands, so the eye goes with the repo instead of starting over on a new page.
 */
export function morph(from: DOMRect, find: () => HTMLElement | null, ms = 340, round = '') {
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
  const done = () => box.remove();
  let tries = 0;
  const go = () => {
    const to = find();
    const at = to?.getBoundingClientRect();
    if (!to || !at?.width) {
      if (++tries < 40) requestAnimationFrame(go);
      else box.animate([{opacity: 1}, {opacity: 0}], {duration: 160, fill: 'forwards'}).finished.then(done, done);
      return;
    }
    box.animate([{...rect(from), opacity: 1}, {...rect(at), opacity: 1, offset: .82}, {...rect(at), opacity: 0}], {duration: ms, easing: LAND, fill: 'forwards'})
      .finished.then(done, done);
  };
  requestAnimationFrame(go);
  return true;
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
  const t0 = performance.now();
  const step = (now: number) => {
    // Written over meanwhile (the figure read again): what it says now is left as it is.
    if (!el.isConnected || !(el.textContent ?? '').endsWith(rest)) return;
    const k = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = k < 1 ? `${(to * eased).toFixed(places)}${rest}` : text;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** A page's parts, each a beat of its arrival: a heading, a card, a box, a pill, a file. */
const BEATS = ['.page-head', '.identity', 'section > h2', '.todo-box', '.card', '.part-bar', '.meter', '.legend > span', '.space-box',
  '.sign-in-card', '.stub-holder', '.inbox-box', '.new-repo > .field', '.git-filter .chip', '.issue-stage', '.issue-new',
  '.repo-strip .pill', '.repo-strip .band-add', '.col:not([hidden]) .file'].join(', ');

/**
 * A page come to is staged rather than shown at once: its parts come in one after another in reading order (the
 * heading first, then down and along, a card at a time), each from the side the page comes from, so the eye is led
 * through it and the arrival lasts long enough to be followed; its figures count up, its bars fill. What is drawn a
 * moment later (read from the store) takes its turn where it stands in that order.
 */
export function stage(root: HTMLElement, dir: number) {
  if (still()) return;
  const t0 = performance.now(), seen = new WeakSet<Element>();
  const run = () => {
    const tall = innerHeight;
    const beats = [...root.querySelectorAll<HTMLElement>(BEATS)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.top < tall && r.bottom > 0 && !el.parentElement?.closest(BEATS);
    }).map((el) => ({el, r: el.getBoundingClientRect()}))
      .sort((a, b) => (Math.abs(a.r.top - b.r.top) > 12 ? a.r.top - b.r.top : a.r.left - b.r.left));
    const late = performance.now() - t0;
    beats.forEach(({el}, i) => {
      if (seen.has(el)) return;
      seen.add(el);
      el.animate([{opacity: 0, translate: `0 ${(dir || 1) * 16}px`}, {opacity: 1, translate: '0 0'}],
        {duration: 360, delay: Math.max(0, Math.min(i, 14) * 45 - late), easing: LAND, fill: 'backwards'});
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
  setTimeout(run, 160);
  setTimeout(run, 420);
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
