import {ago, h} from '../dom.ts';
import {t} from '../i18n.ts';
import {connection, RemoteError} from '../remote.ts';
import * as topic from '../topic.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';

// Topic: one timeline, newest at the top, as far back as there are posts.
// Anyone reads it; signed in, one also posts, and keeps what is worth more
// readers (a post widens ring by ring as those who see it keep it; its
// author sees how far it has gone).
//
// It goes on by itself: near its end the next older page is read, and what
// came meanwhile is put on top (the reader kept where they are if they are
// further down, with a mark to go up to it). And it lets go by itself: a
// page far out of view is folded to an empty box of the height it had, so
// nothing on screen moves, and one further still lets go of its posts too,
// read again by its range if the reader comes back. So scrolling for an
// hour holds about what a few screens do.

/** How far out of view a page stays drawn, in screens above and below. */
const NEAR = '300% 0px';
/** Pages either side of those drawn that keep their posts while folded. */
const KEEP = 8;
/** How often what came is looked for, while the page is in view. */
const EVERY = 15_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {type: 'button', class: `button ${kind}`.trim()}, text) as HTMLButtonElement;
}

/** The letters of a face: the first two of the address's name. */
const face = (p: topic.Post) => [...p.by.split('@')[0]].slice(0, 2).join('').toUpperCase();

export function topicPage(ctx: Context): Node[] {
  return [pageHead('topic'), timeline(ctx, null)];
}

interface Shown { page: topic.Page; el: HTMLElement; drawn: boolean; near: boolean; reading: boolean }

/** The timeline, scrolled by `scroller` (null: the window). */
export function timeline(ctx: Context, scroller: HTMLElement | null): HTMLElement {
  const root = h('div', {class: 'timeline'});
  const signedIn = connection() !== null;

  const pages: Shown[] = [];
  const list = h('div', {class: 'tl-pages', 'aria-label': t('Posts')});
  const end = h('div', {class: 'tl-end muted small', 'aria-live': 'polite'});
  const fresh = h('button', {type: 'button', class: 'tl-new', hidden: ''}) as HTMLButtonElement;
  let done = false, reading = false, looking = false, unseen = 0;

  // ---- where the reader is ----
  const view = () => scroller ? scroller.getBoundingClientRect() : {top: 0, bottom: innerHeight, height: innerHeight};
  const scrollBy = (dy: number) => { if (scroller) scroller.scrollTop += dy; else scrollTo(0, scrollY + dy); };
  /** The top of the timeline is in view: what comes is seen as it comes. */
  const atTop = () => list.getBoundingClientRect().top >= view().top - 4;
  /** Change what is above the reader without moving what they read. */
  const steady = (change: () => void) => {
    const anchor = pages.map((s) => s.el).find((el) => el.getBoundingClientRect().bottom > view().top) ?? end;
    const before = anchor.getBoundingClientRect().top;
    change();
    const dy = anchor.getBoundingClientRect().top - before;
    if (dy) scrollBy(dy);
  };

  // ---- a post ----
  const card = (p: topic.Post, s: Shown) => {
    const when = new Date(p.at);
    const [name, domain] = p.by.split('@');
    const foot = h('div', {class: 'tl-foot muted small'});
    const art = h('article', {class: 'tl-post'},
      h('span', {class: 'tl-face', 'aria-hidden': 'true'}, face(p)),
      h('div', {class: 'tl-main'},
        h('div', {class: 'tl-who'}, h('b', {}, name), h('span', {class: 'muted small'}, `@${domain}`),
          h('time', {class: 'muted small', datetime: when.toISOString(), title: when.toLocaleString()}, ago(p.at))),
        h('p', {class: 'tl-body'}, p.body), foot));
    if (p.mine) {
      // Its author sees how far it has gone, and how many kept it.
      foot.append(t('Reaches {who}', {who: t(topic.RINGS[Math.min(p.ring ?? 0, topic.RINGS.length - 1)])}), p.keeps ? ` · ${t('kept by {n}', {n: p.keeps})}` : '');
    } else if (signedIn) {
      // Keeping is what lets it reach more readers.
      const k = h('button', {type: 'button', class: 'button link tl-keep', 'aria-pressed': String(Boolean(p.kept))}) as HTMLButtonElement;
      const paint = () => { k.textContent = `${p.kept ? t('Kept') : t('Keep')}${p.keeps ? ` ${p.keeps}` : ''}`; k.setAttribute('aria-pressed', String(Boolean(p.kept))); };
      k.addEventListener('click', async () => {
        const on = !p.kept;
        p.kept = on; p.keeps += on ? 1 : -1; paint();
        try { await topic.keep(p.id, on); } catch { p.kept = !on; p.keeps += on ? -1 : 1; paint(); }
      });
      paint();
      foot.append(k);
    } else if (p.keeps) foot.append(t('kept by {n}', {n: p.keeps}));
    if (p.mine) {
      // Taking one's own post down asks once more, briefly.
      const down = h('button', {type: 'button', class: 'button link tl-down'}, t('Take down')) as HTMLButtonElement;
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
      art.querySelector('.tl-who')!.append(down);
    }
    return art;
  };

  // ---- drawing and letting go ----
  const draw = (s: Shown) => {
    if (s.drawn || !s.page.posts) return;
    s.el.replaceChildren(...s.page.posts.map((p) => card(p, s)));
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

  const add = (page: topic.Page, where: 'end' | 'top') => {
    const s: Shown = {page, el: h('div', {class: 'tl-page'}), drawn: false, near: true, reading: false};
    if (where === 'end') { pages.push(s); list.append(s.el); draw(s); } else { pages.unshift(s); list.prepend(s.el); draw(s); }
    watch.observe(s.el);
  };

  // ---- reading on: older at the end, what came on top ----
  const nearEnd = () => end.getBoundingClientRect().top < view().bottom + 2 * view().height;
  const older = async () => {
    if (reading || done) return;
    reading = true;
    list.setAttribute('aria-busy', 'true');
    end.textContent = t('Reading…');
    try {
      const r = await topic.older(pages.at(-1)?.page.oldest ?? null);
      const page = topic.pageOf(r.posts);
      if (page) add(page, 'end');
      done = !r.more;
      end.textContent = done ? (pages.length ? t('That is every post.') : t('No posts yet')) : '';
    } catch (e) { end.textContent = message(e); reading = false; return; } finally { list.setAttribute('aria-busy', 'false'); }
    reading = false;
    // A short page leaves the end in view: read on.
    if (!done && nearEnd()) void older();
  };
  const more = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) void older(); }, {root: scroller, rootMargin: '0px 0px 200% 0px'});

  const tell = () => {
    fresh.hidden = unseen === 0;
    fresh.textContent = `↑ ${unseen === 1 ? t('{n} new post', {n: 1}) : t('{n} new posts', {n: unseen})}`;
  };
  const came = async () => {
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
      const seeing = atTop();
      // Oldest page first, each on top of the last.
      const put = () => { for (const p of topic.onTop(got).reverse()) add(p, 'top'); };
      if (seeing) put(); else { steady(put); unseen += got.length; tell(); }
    } catch { /* tried again on the next look */ } finally { looking = false; }
  };
  fresh.addEventListener('click', () => {
    unseen = 0; tell();
    (scroller ?? document.scrollingElement ?? document.documentElement).scrollTo({top: 0, behavior: 'smooth'});
  });

  // ---- writing ----
  const text = h('textarea', {class: 'tl-text', rows: '2', maxlength: String(topic.LIMIT), placeholder: t('Something short to share'), 'aria-label': t('New post')}) as HTMLTextAreaElement;
  const left = h('span', {class: 'muted small tl-left'});
  const go = button(t('Post'), 'primary');
  const error = h('p', {class: 'error', role: 'alert'});
  const count = () => { left.textContent = String(topic.LIMIT - text.value.length); go.disabled = !text.value.trim(); };
  const send = async () => {
    if (go.disabled) return;
    go.disabled = true;
    error.replaceChildren();
    try {
      await topic.post(text.value);
      text.value = '';
      await came();
    } catch (e) {
      if (e instanceof RemoteError && e.status === 409) {
        const inbox = button(t('Go to Inbox'), 'small-button');
        inbox.addEventListener('click', () => ctx.go('inbox'));
        error.replaceChildren(t('Posting needs an address. Claim one in Inbox.'), ' ', inbox);
      } else error.textContent = message(e);
    }
    count();
  };
  text.addEventListener('input', count);
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } });
  go.addEventListener('click', () => void send());
  count();
  // Reading needs nothing; writing needs an account.
  const signIn = button(t('Sign in'), 'small-button');
  signIn.addEventListener('click', () => ctx.go('remote'));
  const write = signedIn ? h('div', {class: 'tl-write'}, text, h('div', {class: 'row tl-write-row'}, left, go), error)
    : h('div', {class: 'tl-write tl-signed-out'}, h('span', {class: 'muted'}, t('Sign in to post.')), signIn);

  // Back at the top: what came is seen.
  const top = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting) && unseen) { unseen = 0; tell(); } }, {root: scroller});

  // While the page is in view, what came is looked for now and then; once it is gone, all of this stops.
  const look = () => { if (document.visibilityState === 'visible') void came(); };
  const poll = window.setInterval(() => {
    if (!root.isConnected) { clearInterval(poll); watch.disconnect(); more.disconnect(); top.disconnect(); removeEventListener('focus', look); return; }
    look();
  }, EVERY);
  addEventListener('focus', look);

  // The mark floats over the posts (its holder has no height), so showing it moves nothing.
  root.append(write, h('div', {class: 'tl-new-at'}, fresh), list, end);
  more.observe(end);
  top.observe(write);
  return root;
}
