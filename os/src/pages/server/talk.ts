import {dateFormat, h} from '../../ui/dom.ts';
import {arrive, closeUp} from '../../ui/glide.ts';
import {t} from '../../i18n.ts';
import {shown} from '../../remote/inbox.ts';
import * as servers from '../../remote/servers.ts';
import {coalesced, every} from '../../app/runs.ts';
import {errorText} from '../../app/errors.ts';
import {personBadge} from '../pane.ts';

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


/** Whose a post is, as someone is everywhere (pane.ts): their initial on their tint, the same for the same name. */
const face = (p: servers.Post) => {
  const b = personBadge(shown(p.by));
  b.classList.add('tl-face');
  return b;
};
/** A time written whole, as toLocaleString writes one. */
const WHOLE: Intl.DateTimeFormatOptions = {year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'};
const CLOCK: Intl.DateTimeFormatOptions = {hour: '2-digit', minute: '2-digit', hour12: false};
const DAY_NAME: Intl.DateTimeFormatOptions = {weekday: 'short', month: 'short', day: 'numeric'};
const clock = (ms: number) => dateFormat(CLOCK).format(ms);
function dayName(ms: number): string {
  const now = Date.now();
  if (servers.dayOf(ms) === servers.dayOf(now)) return t('Today');
  if (servers.dayOf(ms) === servers.dayOf(now - 86_400_000)) return t('Yesterday');
  return dateFormat(DAY_NAME).format(ms);
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

/** A page of the talk as it is held: its posts (null: let go), its box, and whether it is drawn, near the view, being read. */
interface Shown { page: servers.Page; el: HTMLElement; drawn: boolean; near: boolean; reading: boolean }

/**
 * A board's talk, in `scroller` (the box that scrolls it); `member`: read as one of its people.
 * `saw` hears the newest post read: its foot in view (with the window), so what came is seen.
 */
export function timeline(scroller: HTMLElement, board: string, member: boolean, saw?: (post: string) => void): HTMLElement {
  return new Talk(scroller, board, member, saw).root;
}

/** Every post of `board` after post `after`, read a hundred at a time. */
async function allAfter(board: string, member: boolean, after: string): Promise<servers.Post[]> {
  const got: servers.Post[] = [];
  for (;;) {
    const r = await servers.newer(board, member, after, 100);
    got.push(...r.posts);
    if (!r.more || !r.posts.length) return got;
    after = r.posts[r.posts.length - 1].id;
  }
}

/**
 * A post: a face and a name where a run starts, then the text. One that may be taken down (one's own, or any as the
 * server's owner) has Take down, which `down` does.
 */
function post(p: servers.Post, runs: boolean, down: (art: HTMLElement) => Promise<void>): HTMLElement {
  const when = new Date(p.at);
  // A name on this Remote is shown alone; one on a domain with it. A guest by the name they chose, always
  // with "guest" beside it and their face dashed, so they are never taken for one of its people.
  const [name, domain] = shown(p.by).split('@');
  const where = p.guest ? t('guest') : domain ? `@${domain}` : '';
  const time = h('time', {class: 'muted small', datetime: when.toISOString(), title: dateFormat(WHOLE).format(when)}, clock(p.at));
  const below = h('div', {class: 'tl-foot muted small'});
  const acts = h('div', {class: 'tl-acts'});
  const main = h('div', {class: 'tl-main'},
    ...(runs ? [] : [h('div', {class: 'tl-who'}, h('b', {}, name), h('span', {class: 'muted small'}, where), time)]),
    h('p', {class: 'tl-body'}, p.body), below);
  const art = h('article', {class: `tl-post${runs ? ' tl-runs' : ''}${p.guest ? ' tl-guest' : ''}`},
    runs ? h('span', {class: 'tl-face tl-at'}, time) : face(p), main, acts);
  if (p.mayTakeDown) acts.append(takeDown(() => down(art)));
  return art;
}

/** Taking a post down asks once more, briefly: pressed, it asks; pressed again within three seconds, it is done. */
function takeDown(act: () => Promise<void>): HTMLButtonElement {
  const down = h('button', {type: 'button', class: 'button small-button tl-act'}, t('Take down')) as HTMLButtonElement;
  let armed = 0;
  down.addEventListener('click', async () => {
    if (!armed) { down.textContent = t('Take it down?'); armed = window.setTimeout(() => { armed = 0; down.textContent = t('Take down'); }, 3000); return; }
    clearTimeout(armed);
    down.disabled = true;
    try { await act(); } catch (e) { down.disabled = false; down.textContent = errorText(e); }
  });
  return down;
}

/** The talk while it is on screen: the pages it holds, where the reader is, and reading on. */
class Talk {
  readonly root = h('div', {class: 'timeline'});
  /** Newest page first; on screen the other way round, newest at the foot. */
  private readonly pages: Shown[] = [];
  private readonly list = h('div', {class: 'tl-pages', role: 'region', 'aria-label': t('Posts')});
  private readonly start = h('div', {class: 'tl-start muted small', 'aria-live': 'polite'});
  private readonly foot = h('div', {class: 'tl-foot-mark'});
  private readonly fresh = h('button', {type: 'button', class: 'tl-new', hidden: ''}) as HTMLButtonElement;
  private done = false;
  private reading = false;
  private unseen = 0;
  private footIn = false;
  /** Something came (or was sent) while the first page was being read: it is read again once that is done. */
  private cameMeanwhile = false;
  private readonly scroller: HTMLElement;
  private readonly board: string;
  private readonly member: boolean;
  private readonly saw: ((post: string) => void) | undefined;
  /** Pages near the view are drawn; far from it, folded. */
  private readonly watch: IntersectionObserver;
  /** The start near the view: the page above it is read. */
  private readonly more: IntersectionObserver;
  // One look at a time; asked again while one is out (one's own post just sent, the rail's news), one more
  // after it, which goes to the foot if any asker had just written.
  private readonly came = coalesced<boolean>((mine) => this.look(mine), (a, b) => a || b);

  constructor(scroller: HTMLElement, board: string, member: boolean, saw?: (post: string) => void) {
    this.scroller = scroller;
    this.board = board;
    this.member = member;
    this.saw = saw;
    this.watch = new IntersectionObserver((entries) => this.nearOrFar(entries), {root: scroller, rootMargin: NEAR});
    this.more = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) void this.older(); }, {root: scroller, rootMargin: '200% 0px 0px 0px'});
    this.fresh.addEventListener('click', () => { this.unseen = 0; this.tell(); this.toFoot(true); });
    const here = {board, read: this.came};
    onScreen.add(here);
    // Back at the foot: what came is seen.
    const seen = new IntersectionObserver((e) => {
      this.footIn = e.some((x) => x.isIntersecting);
      if (this.footIn && this.unseen) { this.unseen = 0; this.tell(); }
      this.read();
    }, {root: scroller});
    // While it is on screen, what came is looked for now and then (not while the page is hidden, slower while nobody is at
    // it, at once when someone comes back: runs.ts paced); once it is gone, all of this stops.
    every(EVERY, () => { const c = this.came(false); this.read(); return c; }, {
      alive: () => this.root.isConnected, paced: true,
      ended: () => { this.watch.disconnect(); this.more.disconnect(); seen.disconnect(); onScreen.delete(here); },
    });
    // The mark floats over the posts at the foot (its holder has no height), so showing it moves nothing.
    this.root.append(this.start, this.list, this.foot, h('div', {class: 'tl-new-at'}, this.fresh));
    this.more.observe(this.start);
    seen.observe(this.foot);
  }

  /** The foot in view: the newest post held is read. */
  private read() {
    if (this.footIn && this.pages.length && document.visibilityState === 'visible') this.saw?.(this.pages[0].page.newest);
  }

  // ---- where the reader is ----

  private view() { return this.scroller.getBoundingClientRect(); }
  private atFoot() { return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 32; }
  private toFoot(smooth = false) { this.scroller.scrollTo({top: this.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto'}); }

  /** Change what is above the reader without moving what they read. */
  private steady(change: () => void) {
    const anchor = ([...this.list.children] as HTMLElement[]).find((el) => el.getBoundingClientRect().bottom > this.view().top) ?? this.foot;
    const before = anchor.getBoundingClientRect().top;
    change();
    const dy = anchor.getBoundingClientRect().top - before;
    if (dy) this.scroller.scrollTop += dy;
  }

  // ---- drawing and letting go ----

  /** A page's posts, oldest first, with a line where a day starts and runs drawn as one. */
  private draw(s: Shown) {
    if (s.drawn || !s.page.posts) return;
    const i = this.pages.indexOf(s);
    // The post just before this page, if the page before it is held.
    let prev: servers.Post | undefined = this.pages[i + 1]?.page.posts?.[0];
    const out: Node[] = [];
    for (const p of [...s.page.posts].reverse()) {
      const day = !prev || servers.dayOf(prev.at) !== servers.dayOf(p.at);
      if (day) out.push(h('div', {class: 'tl-day', role: 'separator'}, h('span', {}, dayName(p.at))));
      out.push(post(p, !day && servers.sameRun(prev, p), (art) => this.takeDown(p, s, art)));
      prev = p;
    }
    s.el.replaceChildren(...out);
    s.el.style.height = '';
    s.drawn = true;
  }

  /** Post `p` of page `s` taken down: gone from what is held, and from the screen without moving what is read. */
  private async takeDown(p: servers.Post, s: Shown, art: HTMLElement) {
    await servers.takeDown(this.board, p.id);
    if (s.page.posts) s.page.posts = s.page.posts.filter((q) => q.id !== p.id);
    this.steady(() => art.remove());
  }

  /** An empty box of the height it had: nothing on screen moves. */
  private fold(s: Shown) {
    if (!s.drawn) return;
    s.el.style.height = `${s.el.offsetHeight}px`;
    s.el.replaceChildren();
    s.drawn = false;
  }

  private above(s: Shown) { return s.el.getBoundingClientRect().bottom <= this.view().top; }

  /** A page come near: drawn, its posts read again first if they were let go. */
  private async bring(s: Shown) {
    if (!s.page.posts) {
      if (s.reading) return;
      s.reading = true;
      try { s.page.posts = (await servers.range(this.board, this.member, s.page.oldest, s.page.newest)).posts; } catch { return; } finally { s.reading = false; }
      if (!s.near) return;
    }
    if (this.above(s)) this.steady(() => this.draw(s)); else this.draw(s);
  }

  /** Folded pages far from every drawn one let go of their posts. */
  private letGo() {
    const near = this.pages.flatMap((s, i) => (s.near ? [i] : []));
    for (const i of servers.farFrom(this.pages.length, near, KEEP)) if (!this.pages[i].drawn) this.pages[i].page.posts = null;
  }

  private nearOrFar(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
      const s = this.pages.find((x) => x.el === e.target);
      if (!s) continue;
      s.near = e.isIntersecting;
      if (s.near) void this.bring(s); else this.fold(s);
    }
    this.letGo();
  }

  /** A page older than all (above them) or newer than all (at the foot). */
  private add(page: servers.Page, where: 'older' | 'newer') {
    const s: Shown = {page, el: h('div', {class: 'tl-page'}), drawn: false, near: true, reading: false};
    if (where === 'older') { this.pages.push(s); this.list.prepend(s.el); } else { this.pages.unshift(s); this.list.append(s.el); }
    this.draw(s);
    this.watch.observe(s.el);
    return s;
  }

  // ---- reading on: older above, what came at the foot ----

  private nearStart() { return this.start.getBoundingClientRect().bottom > this.view().top - 2 * this.view().height; }

  /** Read the page above; `fresh`: a post just came to a talk that had none (its first), which comes in as one does. */
  private async older(fresh?: 'mine' | 'theirs') {
    if (this.reading || this.done) return;
    this.reading = true;
    this.list.setAttribute('aria-busy', 'true');
    this.start.textContent = t('Reading…');
    try {
      const r = await servers.older(this.board, this.member, this.pages.at(-1)?.page.oldest ?? null);
      this.addOlder(r.posts, fresh);
      this.done = !r.more;
      this.start.textContent = this.done ? (this.pages.length ? t('That is every post') : t('No posts yet')) : '';
      // Empty, the line sits at the talk's foot, where the first post will come; read or loading, at the top as ever.
      this.root.classList.toggle('tl-empty', this.done && !this.pages.length);
    } catch (e) { this.start.textContent = errorText(e); this.root.classList.remove('tl-empty'); this.reading = false; return; } finally { this.list.setAttribute('aria-busy', 'false'); }
    this.reading = false;
    // Something came while the first page was being read (one's own post, just sent): read again, so it shows.
    if (this.cameMeanwhile) { this.cameMeanwhile = false; if (!this.pages.length) { this.done = false; void this.older(); } else void this.came(true); return; }
    // A short page leaves the start in view: read on.
    if (!this.done && this.nearStart()) void this.older();
  }

  /** The page read above all held: the first at the foot (coming in as a post does, when `fresh`), any other above, nothing moving. */
  private addOlder(posts: servers.Post[], fresh?: 'mine' | 'theirs') {
    const page = servers.pageOf(posts);
    if (!page) return;
    if (this.pages.length) { this.steady(() => this.add(page, 'older')); return; }
    const s = this.add(page, 'older');
    this.toFoot(); this.read();
    if (fresh) arrive(s.el, fresh === 'mine' ? 1 : -1, fresh === 'mine' ? 'y' : 'x', 18, 300);
  }

  private tell() {
    this.fresh.hidden = this.unseen === 0;
    this.fresh.textContent = `↓ ${this.unseen === 1 ? t('{n} new post', {n: 1}) : t('{n} new posts', {n: this.unseen})}`;
  }

  /** What came since the newest post held, put at the foot; `mine`: the reader just wrote, so go to it. */
  private async look(mine: boolean): Promise<void> {
    if (!this.pages.length) { this.done = false; if (this.reading) { this.cameMeanwhile = true; return; } return this.older(mine ? 'mine' : 'theirs'); }
    try {
      const got = await allAfter(this.board, this.member, this.pages[0].page.newest);
      if (got.length) this.addNewer(got, mine);
    } catch { /* tried again on the next look */ }
  }

  /** What came, at the foot: followed if the reader is there (or wrote it), else a mark to go down to it. */
  private addNewer(got: servers.Post[], mine: boolean) {
    const following = mine || this.atFoot();
    // What was said before, standing on the talk's foot, goes up to make room on the same curve (as the Inbox's
    // does), not a line higher in one frame; where the talk scrolls, the scroll brings the new in instead.
    const before = [this.start, ...this.list.children] as HTMLElement[];
    const anchor = before[before.length - 1], was = anchor.getBoundingClientRect().top;
    // Oldest page first, each at the foot: one's own coming up out of the box it was written in, what someone
    // else wrote in from their side, as a message does in the Inbox.
    for (const p of servers.onTop(got).reverse()) {
      const s = this.add(p, 'newer');
      if (mine) arrive(s.el, 1, 'y', 18, 300); else arrive(s.el, -1, 'x', 18, 300);
    }
    if (following) { this.toFoot(mine); this.read(); } else { this.unseen += got.length; this.tell(); }
    const by = was - anchor.getBoundingClientRect().top;
    if (by > .5) closeUp(before, by, 300);
  }
}
