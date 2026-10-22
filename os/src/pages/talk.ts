import {h} from '../dom.ts';
import {currentLang, t} from '../i18n.ts';
import {shown} from '../inbox.ts';
import * as servers from '../servers.ts';
import {coalesced, every} from '../runs.ts';
import {errorText} from '../errors.ts';

// A board's talk: read as a conversation is, oldest above and newest at the
// foot, by the box one writes in. Its people write in it; so may a guest,
// where the board takes them; anyone reads it where the board is open.
//
// It goes on by itself: scrolled near its top, the next older page is read
// in above without moving what is on screen; what came meanwhile is put at
// the foot (followed if the reader is there, else a mark to go down to it).
// And it lets go by itself: a page far out of view is folded to an empty
// box of the height it had, so nothing on screen moves, and one further
// still lets go of its posts too, read again by its range if the reader
// comes back. So scrolling for an hour holds about what a few screens do.

/** How far out of view a page stays drawn, in screens above and below. */
const NEAR = '300% 0px';
/** Pages either side of those drawn that keep their posts while folded. */
const KEEP = 8;
/** How often what came is looked for, while the page is in view. */
const EVERY = 15_000;


/** The letters of a face: the first two of the address's name. */
const face = (p: servers.Post) => [...p.by.split('@')[0]].slice(0, 2).join('').toUpperCase();
const clock = (ms: number) => new Date(ms).toLocaleTimeString(currentLang(), {hour: '2-digit', minute: '2-digit', hour12: false});
function dayName(ms: number): string {
  const now = Date.now();
  if (servers.dayOf(ms) === servers.dayOf(now)) return t('Today');
  if (servers.dayOf(ms) === servers.dayOf(now - 86_400_000)) return t('Yesterday');
  return new Date(ms).toLocaleDateString(currentLang(), {weekday: 'short', month: 'short', day: 'numeric'});
}

/** The talks on screen, by board, each with how to read what came now (`mine`: the reader just wrote, so go to it). */
const onScreen = new Set<{board: string; read(mine: boolean): Promise<void>}>();

/** Write in a board (as one of its people, or as a guest with their token); every talk of it on screen reads it in at once. */
export async function postNow(board: string, body: string, guest?: string): Promise<void> {
  await (guest ? servers.guestPost(board, guest, body) : servers.post(board, body));
  await Promise.all([...onScreen].filter((x) => x.board === board).map((x) => x.read(true)));
}

/** Something came to a board, as the rail heard it: every talk of it on screen reads it in now, not at its next look. */
export function cameTo(board: string) {
  for (const x of onScreen) if (x.board === board) void x.read(false);
}

interface Shown { page: servers.Page; el: HTMLElement; drawn: boolean; near: boolean; reading: boolean }

/**
 * A board's talk, in `scroller` (the box that scrolls it); `member`: read as one of its people.
 * `saw` hears the newest post read: its foot in view (with the window), so what came is seen.
 */
export function timeline(scroller: HTMLElement, board: string, member: boolean, saw?: (post: string) => void): HTMLElement {
  const root = h('div', {class: 'timeline'});

  // Newest page first; on screen the other way round, newest at the foot.
  const pages: Shown[] = [];
  const list = h('div', {class: 'tl-pages', role: 'region', 'aria-label': t('Posts')});
  const start = h('div', {class: 'tl-start muted small', 'aria-live': 'polite'});
  const foot = h('div', {class: 'tl-foot-mark'});
  const fresh = h('button', {type: 'button', class: 'tl-new', hidden: ''}) as HTMLButtonElement;
  let done = false, reading = false, unseen = 0, footIn = false;
  /** Something came (or was sent) while the first page was being read: it is read again once that is done. */
  let cameMeanwhile = false;
  /** The foot in view: the newest post held is read. */
  const read = () => { if (footIn && pages.length && document.visibilityState === 'visible') saw?.(pages[0].page.newest); };

  // ---- where the reader is ----
  const view = () => scroller.getBoundingClientRect();
  const atFoot = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
  const toFoot = (smooth = false) => scroller.scrollTo({top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto'});
  /** Change what is above the reader without moving what they read. */
  const steady = (change: () => void) => {
    const anchor = ([...list.children] as HTMLElement[]).find((el) => el.getBoundingClientRect().bottom > view().top) ?? foot;
    const before = anchor.getBoundingClientRect().top;
    change();
    const dy = anchor.getBoundingClientRect().top - before;
    if (dy) scroller.scrollTop += dy;
  };

  // ---- a post: a face and a name where a run starts, then the text ----
  const card = (p: servers.Post, s: Shown, runs: boolean) => {
    const when = new Date(p.at);
    // A name on this Remote is shown alone; one on a domain with it. A guest by the name they chose, always
    // with "guest" beside it and their face dashed, so they are never taken for one of its people.
    const [name, domain] = shown(p.by).split('@');
    const where = p.guest ? t('guest') : domain ? `@${domain}` : '';
    const time = h('time', {class: 'muted small', datetime: when.toISOString(), title: when.toLocaleString(currentLang())}, clock(p.at));
    const below = h('div', {class: 'tl-foot muted small'});
    const acts = h('div', {class: 'tl-acts'});
    const main = h('div', {class: 'tl-main'},
      ...(runs ? [] : [h('div', {class: 'tl-who'}, h('b', {}, name), h('span', {class: 'muted small'}, where), time)]),
      h('p', {class: 'tl-body'}, p.body), below);
    const art = h('article', {class: `tl-post${runs ? ' tl-runs' : ''}${p.guest ? ' tl-guest' : ''}`},
      runs ? h('span', {class: 'tl-face tl-at'}, time) : h('span', {class: 'tl-face', 'aria-hidden': 'true'}, face(p)), main, acts);

    if (p.mayTakeDown) {
      // Taking a post down (one's own, or any as the server's owner) asks once more, briefly.
      const down = h('button', {type: 'button', class: 'button small-button tl-act'}, t('Take down')) as HTMLButtonElement;
      let armed = 0;
      down.addEventListener('click', async () => {
        if (!armed) { down.textContent = t('Take it down?'); armed = window.setTimeout(() => { armed = 0; down.textContent = t('Take down'); }, 3000); return; }
        clearTimeout(armed);
        down.disabled = true;
        try {
          await servers.takeDown(board, p.id);
          if (s.page.posts) s.page.posts = s.page.posts.filter((q) => q.id !== p.id);
          steady(() => art.remove());
        } catch (e) { down.disabled = false; down.textContent = errorText(e); }
      });
      acts.append(down);
    }
    return art;
  };

  // ---- drawing and letting go ----
  /** A page's posts, oldest first, with a line where a day starts and runs drawn as one. */
  const draw = (s: Shown) => {
    if (s.drawn || !s.page.posts) return;
    const i = pages.indexOf(s);
    // The post just before this page, if the page before it is held.
    let prev: servers.Post | undefined = pages[i + 1]?.page.posts?.[0];
    const out: Node[] = [];
    for (const p of [...s.page.posts].reverse()) {
      const day = !prev || servers.dayOf(prev.at) !== servers.dayOf(p.at);
      if (day) out.push(h('div', {class: 'tl-day', role: 'separator'}, h('span', {}, dayName(p.at))));
      out.push(card(p, s, !day && servers.sameRun(prev, p)));
      prev = p;
    }
    s.el.replaceChildren(...out);
    s.el.style.height = '';
    s.drawn = true;
  };
  /** An empty box of the height it had: nothing on screen moves. */
  const fold = (s: Shown) => {
    if (!s.drawn) return;
    s.el.style.height = `${s.el.offsetHeight}px`;
    s.el.replaceChildren();
    s.drawn = false;
  };
  const above = (s: Shown) => s.el.getBoundingClientRect().bottom <= view().top;
  const bring = async (s: Shown) => {
    if (!s.page.posts) {
      if (s.reading) return;
      s.reading = true;
      try { s.page.posts = (await servers.range(board, member, s.page.oldest, s.page.newest)).posts; } catch { return; } finally { s.reading = false; }
      if (!s.near) return;
    }
    if (above(s)) steady(() => draw(s)); else draw(s);
  };
  /** Folded pages far from every drawn one let go of their posts. */
  const letGo = () => {
    const near = pages.flatMap((s, i) => (s.near ? [i] : []));
    for (const i of servers.farFrom(pages.length, near, KEEP)) if (!pages[i].drawn) pages[i].page.posts = null;
  };
  const watch = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const s = pages.find((x) => x.el === e.target);
      if (!s) continue;
      s.near = e.isIntersecting;
      if (s.near) void bring(s); else fold(s);
    }
    letGo();
  }, {root: scroller, rootMargin: NEAR});

  /** A page older than all (above them) or newer than all (at the foot). */
  const add = (page: servers.Page, where: 'older' | 'newer') => {
    const s: Shown = {page, el: h('div', {class: 'tl-page'}), drawn: false, near: true, reading: false};
    if (where === 'older') { pages.push(s); list.prepend(s.el); } else { pages.unshift(s); list.append(s.el); }
    draw(s);
    watch.observe(s.el);
  };

  // ---- reading on: older above, what came at the foot ----
  const nearStart = () => start.getBoundingClientRect().bottom > view().top - 2 * view().height;
  const older = async () => {
    if (reading || done) return;
    reading = true;
    list.setAttribute('aria-busy', 'true');
    start.textContent = t('Reading…');
    try {
      const r = await servers.older(board, member, pages.at(-1)?.page.oldest ?? null);
      const page = servers.pageOf(r.posts);
      const first = !pages.length;
      if (page) { if (first) { add(page, 'older'); toFoot(); read(); } else steady(() => add(page, 'older')); }
      done = !r.more;
      start.textContent = done ? (pages.length ? t('That is every post') : t('No posts yet')) : '';
      // Empty, the line sits at the talk's foot, where the first post will come; read or loading, at the top as ever.
      root.classList.toggle('tl-empty', done && !pages.length);
    } catch (e) { start.textContent = errorText(e); root.classList.remove('tl-empty'); reading = false; return; } finally { list.setAttribute('aria-busy', 'false'); }
    reading = false;
    // Something came while the first page was being read (one's own post, just sent): read again, so it shows.
    if (cameMeanwhile) { cameMeanwhile = false; if (!pages.length) { done = false; void older(); } else void came(true); return; }
    // A short page leaves the start in view: read on.
    if (!done && nearStart()) void older();
  };
  const more = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) void older(); }, {root: scroller, rootMargin: '200% 0px 0px 0px'});

  const tell = () => {
    fresh.hidden = unseen === 0;
    fresh.textContent = `↓ ${unseen === 1 ? t('{n} new post', {n: 1}) : t('{n} new posts', {n: unseen})}`;
  };
  // One look at a time; asked again while one is out (one's own post just sent, the rail's news), one more
  // after it, which goes to the foot if any asker had just written.
  const came = coalesced<boolean>(async (mine) => {
    if (!pages.length) { done = false; if (reading) { cameMeanwhile = true; return; } return older(); }
    try {
      const got: servers.Post[] = [];
      let after = pages[0].page.newest;
      for (;;) {
        const r = await servers.newer(board, member, after, 100);
        got.push(...r.posts);
        if (!r.more || !r.posts.length) break;
        after = r.posts[r.posts.length - 1].id;
      }
      if (!got.length) return;
      const following = mine || atFoot();
      // Oldest page first, each at the foot.
      for (const p of servers.onTop(got).reverse()) add(p, 'newer');
      if (following) { toFoot(mine); read(); } else { unseen += got.length; tell(); }
    } catch { /* tried again on the next look */ }
  }, (a, b) => a || b);
  fresh.addEventListener('click', () => { unseen = 0; tell(); toFoot(true); });
  const here = {board, read: came};
  onScreen.add(here);

  // Back at the foot: what came is seen.
  const seen = new IntersectionObserver((e) => {
    footIn = e.some((x) => x.isIntersecting);
    if (footIn && unseen) { unseen = 0; tell(); }
    read();
  }, {root: scroller});

  // While it is on screen, what came is looked for now and then (not while the page is hidden); once it is gone, all of this stops.
  const look = () => { if (document.visibilityState === 'visible') { void came(false); read(); } };
  every(EVERY, () => { const c = came(false); read(); return c; }, {
    alive: () => root.isConnected,
    ended: () => { watch.disconnect(); more.disconnect(); seen.disconnect(); onScreen.delete(here); removeEventListener('focus', look); },
  });
  addEventListener('focus', look);

  // The mark floats over the posts at the foot (its holder has no height), so showing it moves nothing.
  root.append(start, list, foot, h('div', {class: 'tl-new-at'}, fresh));
  more.observe(start);
  seen.observe(foot);
  return root;
}

