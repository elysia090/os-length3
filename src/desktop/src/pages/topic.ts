import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {connection} from '../remote.ts';
import * as topic from '../topic.ts';

// Topic: one timeline, read as a conversation is: oldest above, newest at
// the foot, beside the field one posts from (the purple lane of the field
// at the foot of the center). Anyone reads it; signed in, one also posts,
// and keeps what is worth more readers (a post widens ring by ring as those
// who see it keep it; its author sees how far it has gone).
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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The letters of a face: the first two of the address's name. */
const face = (p: topic.Post) => [...p.by.split('@')[0]].slice(0, 2).join('').toUpperCase();
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hour12: false});
function dayName(ms: number): string {
  const now = Date.now();
  if (topic.dayOf(ms) === topic.dayOf(now)) return t('Today');
  if (topic.dayOf(ms) === topic.dayOf(now - 86_400_000)) return t('Yesterday');
  return new Date(ms).toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'});
}

/** The timelines on screen, each with how to read what came now (`mine`: the reader just posted, so go to it). */
const onScreen = new Set<(mine: boolean) => Promise<void>>();

/** Post as this reader; every timeline on screen reads it in at once. */
export async function postNow(body: string): Promise<void> {
  await topic.post(body);
  await Promise.all([...onScreen].map((read) => read(true)));
}

interface Shown { page: topic.Page; el: HTMLElement; drawn: boolean; near: boolean; reading: boolean }

/** The timeline, in `scroller` (the box that scrolls it). */
export function timeline(scroller: HTMLElement): HTMLElement {
  const root = h('div', {class: 'timeline'});
  const signedIn = connection() !== null;

  // Newest page first; on screen the other way round, newest at the foot.
  const pages: Shown[] = [];
  const list = h('div', {class: 'tl-pages', 'aria-label': t('Posts')});
  const start = h('div', {class: 'tl-start muted small', 'aria-live': 'polite'});
  const foot = h('div', {class: 'tl-foot-mark'});
  const fresh = h('button', {type: 'button', class: 'tl-new', hidden: ''}) as HTMLButtonElement;
  let done = false, reading = false, looking = false, unseen = 0;

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
  const card = (p: topic.Post, s: Shown, runs: boolean) => {
    const when = new Date(p.at);
    const [name, domain] = p.by.split('@');
    const time = h('time', {class: 'muted small', datetime: when.toISOString(), title: when.toLocaleString()}, clock(p.at));
    const below = h('div', {class: 'tl-foot muted small'});
    const acts = h('div', {class: 'tl-acts'});
    const main = h('div', {class: 'tl-main'},
      ...(runs ? [] : [h('div', {class: 'tl-who'}, h('b', {}, name), h('span', {class: 'muted small'}, `@${domain}`), time)]),
      h('p', {class: 'tl-body'}, p.body), below);
    const art = h('article', {class: runs ? 'tl-post tl-runs' : 'tl-post'},
      runs ? h('span', {class: 'tl-face tl-at'}, time) : h('span', {class: 'tl-face', 'aria-hidden': 'true'}, face(p)), main, acts);

    if (p.mine) {
      // Its author sees how far it has gone, and how many kept it.
      below.append(t('Reaches {who}', {who: t(topic.RINGS[Math.min(p.ring ?? 0, topic.RINGS.length - 1)])}), p.keeps ? ` · ${t('kept by {n}', {n: p.keeps})}` : '');
      // Taking one's own post down asks once more, briefly.
      const down = h('button', {type: 'button', class: 'tl-act'}, t('Take down')) as HTMLButtonElement;
      let armed = 0;
      down.addEventListener('click', async () => {
        if (!armed) { down.textContent = t('Take it down?'); armed = window.setTimeout(() => { armed = 0; down.textContent = t('Take down'); }, 3000); return; }
        clearTimeout(armed);
        down.disabled = true;
        try {
          await topic.takeDown(p.id);
          if (s.page.posts) s.page.posts = s.page.posts.filter((q) => q.id !== p.id);
          steady(() => art.remove());
        } catch (e) { down.disabled = false; down.textContent = message(e); }
      });
      acts.append(down);
    } else if (signedIn) {
      // Keeping is what lets it reach more readers: a mark under it once kept, and on hover above it.
      const chip = h('button', {type: 'button', class: 'tl-keep'}) as HTMLButtonElement;
      const act = h('button', {type: 'button', class: 'tl-act'}) as HTMLButtonElement;
      const paint = () => {
        chip.hidden = !p.keeps;
        chip.textContent = `${t('Kept')} ${p.keeps}`;
        chip.setAttribute('aria-pressed', String(Boolean(p.kept)));
        act.textContent = p.kept ? t('Kept') : t('Keep');
        act.setAttribute('aria-pressed', String(Boolean(p.kept)));
      };
      const toggle = async () => {
        const on = !p.kept;
        p.kept = on; p.keeps += on ? 1 : -1; paint();
        try { await topic.keep(p.id, on); } catch { p.kept = !on; p.keeps += on ? -1 : 1; paint(); }
      };
      chip.addEventListener('click', () => void toggle());
      act.addEventListener('click', () => void toggle());
      paint();
      below.append(chip);
      acts.append(act);
    } else if (p.keeps) below.append(t('kept by {n}', {n: p.keeps}));
    return art;
  };

  // ---- drawing and letting go ----
  /** A page's posts, oldest first, with a line where a day starts and runs drawn as one. */
  const draw = (s: Shown) => {
    if (s.drawn || !s.page.posts) return;
    const i = pages.indexOf(s);
    // The post just before this page, if the page before it is held.
    let prev: topic.Post | undefined = pages[i + 1]?.page.posts?.[0];
    const out: Node[] = [];
    for (const p of [...s.page.posts].reverse()) {
      const day = !prev || topic.dayOf(prev.at) !== topic.dayOf(p.at);
      if (day) out.push(h('div', {class: 'tl-day', role: 'separator'}, h('span', {}, dayName(p.at))));
      out.push(card(p, s, !day && topic.sameRun(prev, p)));
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
      try { s.page.posts = (await topic.range(s.page.oldest, s.page.newest)).posts; } catch { return; } finally { s.reading = false; }
      if (!s.near) return;
    }
    if (above(s)) steady(() => draw(s)); else draw(s);
  };
  /** Folded pages far from every drawn one let go of their posts. */
  const letGo = () => {
    const near = pages.flatMap((s, i) => (s.near ? [i] : []));
    for (const i of topic.farFrom(pages.length, near, KEEP)) if (!pages[i].drawn) pages[i].page.posts = null;
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
  const add = (page: topic.Page, where: 'older' | 'newer') => {
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
      const r = await topic.older(pages.at(-1)?.page.oldest ?? null);
      const page = topic.pageOf(r.posts);
      const first = !pages.length;
      if (page) { if (first) { add(page, 'older'); toFoot(); } else steady(() => add(page, 'older')); }
      done = !r.more;
      start.textContent = done ? (pages.length ? t('That is every post.') : t('No posts yet')) : '';
    } catch (e) { start.textContent = message(e); reading = false; return; } finally { list.setAttribute('aria-busy', 'false'); }
    reading = false;
    // A short page leaves the start in view: read on.
    if (!done && nearStart()) void older();
  };
  const more = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) void older(); }, {root: scroller, rootMargin: '200% 0px 0px 0px'});

  const tell = () => {
    fresh.hidden = unseen === 0;
    fresh.textContent = `↓ ${unseen === 1 ? t('{n} new post', {n: 1}) : t('{n} new posts', {n: unseen})}`;
  };
  const came = async (mine = false) => {
    if (looking) return;
    if (!pages.length) { done = false; return void older(); }
    looking = true;
    try {
      const got: topic.Post[] = [];
      let after = pages[0].page.newest;
      for (;;) {
        const r = await topic.newer(after, 100);
        got.push(...r.posts);
        if (!r.more || !r.posts.length) break;
        after = r.posts[r.posts.length - 1].id;
      }
      if (!got.length) return;
      const following = mine || atFoot();
      // Oldest page first, each at the foot.
      for (const p of topic.onTop(got).reverse()) add(p, 'newer');
      if (following) toFoot(mine); else { unseen += got.length; tell(); }
    } catch { /* tried again on the next look */ } finally { looking = false; }
  };
  fresh.addEventListener('click', () => { unseen = 0; tell(); toFoot(true); });
  onScreen.add(came);

  // Back at the foot: what came is seen.
  const seen = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting) && unseen) { unseen = 0; tell(); } }, {root: scroller});

  // While it is on screen, what came is looked for now and then; once it is gone, all of this stops.
  const look = () => { if (document.visibilityState === 'visible') void came(); };
  const poll = window.setInterval(() => {
    if (!root.isConnected) {
      clearInterval(poll); watch.disconnect(); more.disconnect(); seen.disconnect(); onScreen.delete(came); removeEventListener('focus', look);
      return;
    }
    look();
  }, EVERY);
  addEventListener('focus', look);

  // The mark floats over the posts at the foot (its holder has no height), so showing it moves nothing.
  root.append(start, list, foot, h('div', {class: 'tl-new-at'}, fresh));
  more.observe(start);
  seen.observe(foot);
  return root;
}
