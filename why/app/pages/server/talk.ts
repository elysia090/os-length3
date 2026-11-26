import {h} from '../../ui/dom.ts';
import {dateFormat} from '../../../text/format.ts';
import {t} from '../../../text/i18n.ts';
import {shown} from '../../../shipto/inbox.ts';
import * as servers from '../../../shipto/servers.ts';
import {coalesced, every} from '../../../api/runs.ts';
import {errorText} from '../../../api/errors.ts';
import {readTime} from '../../ui/law.ts';
import {connection} from '../../../shipto/connection.ts';

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
/** Reading a page longer than this, the talk says it is reading. */
const SAY_READING = 250;


// Only the place in a transcript is held across topics, never a post or an
// old view. A different Remote session or guest/member scope cannot reuse it.
type Spot = {id: string; at: number; top: number};
const places = new Map<string, Spot>();
let readingAs: string | undefined;

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
const onScreen = new Set<{board: string; read(mine: boolean): Promise<void>; seen(): void}>();

/** Write in a board (as one of its people, or as a guest with their token); every talk of it on screen reads it in at once. */
export async function postNow(board: string, body: string, guest?: string): Promise<void> {
  await (guest ? servers.guestPost(board, guest, body) : servers.post(board, body));
  await Promise.all([...onScreen].filter((x) => x.board === board).map((x) => x.read(true)));
}

/** Something came to a board, as the rail heard it: every talk of it on screen reads it in now, not at its next look. */
export function cameTo(board: string) {
  for (const x of onScreen) if (x.board === board) void x.read(false);
}

/** Server came out, or a board read ahead was slid to: what the talks on screen show is seen now (their foot in view). */
export function seenNow() {
  for (const x of onScreen) x.seen();
}

/** A page of the talk as it is held: its posts (null: let go), its box, and whether it is drawn, near the view, being read. */
interface Shown { page: servers.Page; el: HTMLElement; drawn: boolean; near: boolean; reading: boolean }

/**
 * A board's talk, in `scroller` (the box that scrolls it); `member`: read as one of its people.
 * `saw` hears the newest post read: its foot in view (with the window), so what came is seen.
 */
export function timeline(scroller: HTMLElement, board: string, member: boolean, saw?: (post: string) => void) {
  return new Talk(scroller, board, member, saw);
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

/** Plain attribution and its words, in order. The real deletion affordance remains scoped by Remote. */
function post(p: servers.Post, day: boolean, down: (art: HTMLElement) => Promise<void>): HTMLElement {
  const when = new Date(p.at);
  const [name, domain] = shown(p.by).split('@');
  const where = p.guest ? t('Guest') : domain ? `@${domain}` : '';
  const time = h('time', {datetime: when.toISOString()}, day ? `${dayName(p.at)}  ${clock(p.at)}` : clock(p.at));
  const acts = h('div', {class: 'tl-acts'});
  const art = h('article', {class: 'tl-post', 'data-post': p.id, 'data-time': String(p.at),
    ...(p.mayTakeDown ? {tabindex: '0'} : {})},
  h('div', {class: 'tl-who'}, h('b', {}, name), where ? h('span', {class: 'muted small'}, where) : null, time),
  h('p', {class: 'tl-body'}, p.body), acts);
  if (p.mayTakeDown) acts.append(takeDown(() => down(art)));
  art.addEventListener('click', () => {
    for (const other of art.closest('.timeline')?.querySelectorAll('.tl-post.held') ?? []) if (other !== art) other.classList.remove('held');
    art.classList.add('held');
  });
  return art;
}

/** Taking a post down asks once more, briefly: pressed, it asks; pressed again within three seconds, it is done. */
function takeDown(act: () => Promise<void>): HTMLButtonElement {
  const down = h('button', {type: 'button', class: 'button small-button tl-act'}, t('Delete post')) as HTMLButtonElement;
  let armed = 0;
  down.addEventListener('click', async () => {
    if (!armed) { down.textContent = t('Delete this post?'); armed = window.setTimeout(() => { armed = 0; down.textContent = t('Delete post'); }, Math.max(3000, readTime(down.textContent ?? ''))); return; }
    clearTimeout(armed);
    down.disabled = true;
    try { await act(); } catch (e) { down.disabled = false; down.textContent = errorText(e); }
  });
  return down;
}

/** The talk while it is on screen: the pages it holds, where the reader is, and reading on. */
class Talk {
  readonly root = h('div', {class: 'timeline'});
  readonly stop: () => void;
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
  private readonly scope: string;
  private readonly placeKey: string;
  private restore: Spot | null;
  private height = 0;
  private heldTop: number | null = null;
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
    this.scope = connection()?.session ?? '';
    this.placeKey = `${member ? 'member' : 'public'}:${board}`;
    if (readingAs !== this.scope) { places.clear(); readingAs = this.scope; }
    this.restore = places.get(this.placeKey) ?? null;
    this.saw = saw;
    this.watch = new IntersectionObserver((entries) => this.nearOrFar(entries), {root: scroller, rootMargin: NEAR});
    this.more = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) void this.older(); }, {root: scroller, rootMargin: '200% 0px 0px 0px'});
    this.fresh.addEventListener('click', () => { this.unseen = 0; this.tell(); this.toFoot(true); });
    scroller.addEventListener('scroll', () => this.keepPlace(), {passive: true});
    // If the composition is being written to, the previous viewport tells
    // whether the reader followed the foot or was reading elsewhere.
    const sized = new ResizeObserver(() => {
      const next = scroller.clientHeight;
      if (!next) return;
      const wasAtFoot = this.height && scroller.scrollHeight - scroller.scrollTop - this.height < 3;
      this.height = next;
      this.root.classList.toggle('tl-fits', scroller.scrollHeight <= next + 1);
      if (wasAtFoot && !this.restore) this.toFoot();
    });
    sized.observe(scroller);
    sized.observe(this.root);
    const takeReading = () => { if (this.pages.length) this.restore = null; };
    scroller.addEventListener('wheel', takeReading, {passive: true});
    scroller.addEventListener('pointerdown', takeReading, {passive: true});
    scroller.addEventListener('keydown', (e) => {
      if (['Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown'].includes(e.key)) takeReading();
    });
    const here = {board, read: this.came, seen: () => this.read()};
    onScreen.add(here);
    // Back at the foot: what came is seen.
    const seen = new IntersectionObserver((e) => {
      this.footIn = e.some((x) => x.isIntersecting);
      if (this.footIn && this.unseen) { this.unseen = 0; this.tell(); }
      this.read();
    }, {root: scroller});
    // While it is on screen, what came is looked for now and then (not while the page is hidden, slower while nobody is at
    // it, at once when someone comes back: runs.ts paced); once it is gone, all of this stops.
    const polling = every(EVERY, () => { const c = this.came(false); this.read(); return c; }, {
      alive: () => this.root.isConnected, paced: true,
      ended: () => { this.watch.disconnect(); this.more.disconnect(); seen.disconnect(); sized.disconnect(); onScreen.delete(here); },
    });
    this.stop = () => { this.keepPlace(); polling.stop(); };
    // The mark floats over the posts at the foot (its holder has no height), so showing it moves nothing.
    this.root.append(this.start, this.list, this.foot, h('div', {class: 'tl-new-at'}, this.fresh));
    this.more.observe(this.start);
    seen.observe(this.foot);
  }

  /** The scrollport's geometry disappears while TODO is in front. Its position does not. */
  holdFace() {
    this.keepPlace();
    this.heldTop = this.scroller.scrollTop;
  }

  showFace() {
    if (this.heldTop !== null) {
      this.scroller.scrollTop = this.heldTop;
      this.heldTop = null;
    }
    if (this.pages.length && this.locatePlace(!this.done)) void this.older();
    this.read();
  }

  /** The foot in view: the newest post held is read. */
  private read() {
    if (!this.active() || this.restore) return;
    if (this.footIn && this.pages.length && this.atFoot() && document.visibilityState === 'visible') this.saw?.(this.pages[0].page.newest);
  }

  private active() {
    return this.root.isConnected && (connection()?.session ?? '') === this.scope && !this.root.closest('[hidden], [inert]');
  }

  private keepPlace() {
    if (!this.active() || this.restore || this.heldTop !== null || !this.pages.length) return;
    if (this.atFoot()) { places.delete(this.placeKey); return; }
    const top = this.view().top;
    const row = [...this.list.querySelectorAll<HTMLElement>('[data-post]')]
      .find((el) => el.getBoundingClientRect().bottom > top);
    if (row?.dataset.post && row.dataset.time) {
      places.delete(this.placeKey);
      places.set(this.placeKey, {id: row.dataset.post, at: Number(row.dataset.time), top: row.getBoundingClientRect().top - top});
      // Bound memory independently of how many threads were once visited.
      if (places.size > 64) places.delete(places.keys().next().value!);
    }
  }

  /** Restore an actual author line, even when new posts arrived in the meantime. */
  private locatePlace(more: boolean): boolean {
    if (!this.restore) return false;
    const here = this.restore;
    const rows = [...this.list.querySelectorAll<HTMLElement>('[data-post]')];
    const exact = rows.find((el) => el.dataset.post === here.id);
    const oldest = Number(rows[0]?.dataset.time ?? Infinity);
    if (!exact && more && oldest >= here.at) return true;
    // A removed post restores to its nearest surviving successor, not to a different thread.
    const target = exact ?? rows.find((el) => Number(el.dataset.time) >= here.at) ?? rows.at(-1);
    this.restore = null;
    if (target) this.scroller.scrollTop += target.getBoundingClientRect().top - this.view().top - here.top;
    return false;
  }

  private report() {
    this.scroller.dispatchEvent(new CustomEvent('topic-posts', {detail: this.pages.some((page) => page.page.posts === null || page.page.posts.length > 0), bubbles: true}));
  }

  // ---- where the reader is ----

  private view() { return this.scroller.getBoundingClientRect(); }
  private atFoot() { return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 32; }
  private toFoot(_smooth = false) { this.scroller.scrollTo({top: this.scroller.scrollHeight, behavior: 'auto'}); }

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
      out.push(post(p, day, (art) => this.takeDown(p, s, art)));
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
    this.report();
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
    if (!this.active()) return;
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
  private async older(mine = false) {
    if (this.reading || this.done) return;
    this.reading = true;
    let seek = false;
    this.list.setAttribute('aria-busy', 'true');
    this.start.classList.remove('tl-all');
    // Said only when reading takes a while: a page read at once comes without a word flashing before it (a board just
    // made said No posts yet as it was named, and says it again, not Reading… between).
    const saying = window.setTimeout(() => { this.start.textContent = t('Loading…'); }, SAY_READING);
    try {
      const r = await servers.older(this.board, this.member, this.pages.at(-1)?.page.oldest ?? null);
      if (!this.root.isConnected) return;
      this.addOlder(r.posts, mine);
      this.done = !r.more;
      seek = this.active() && this.locatePlace(r.more);
      this.report();
      this.start.textContent = this.done ? (this.pages.length ? t('No more posts') : t('No posts yet')) : '';
      // Every post said to be there: only worth saying where there is more than the board shows (styles.css).
      this.start.classList.toggle('tl-all', this.done && this.pages.length > 0);
      // Empty, the line sits at the talk's foot, where the first post will come; read or loading, at the top as ever.
      this.root.classList.toggle('tl-empty', this.done && !this.pages.length);
    } catch (e) { this.start.textContent = errorText(e); this.start.classList.remove('tl-all'); this.root.classList.remove('tl-empty'); this.reading = false; return; } finally { clearTimeout(saying); this.list.setAttribute('aria-busy', 'false'); this.root.dataset.read = ''; }
    this.reading = false;
    // Something came while the first page was being read (one's own post, just sent): read again, so it shows.
    if (this.cameMeanwhile) { this.cameMeanwhile = false; if (!this.pages.length) { this.done = false; void this.older(); } else void this.came(true); return; }
    // A short page leaves the start in view: read on.
    if (!this.done && this.active() && (seek || this.nearStart())) void this.older();
  }

  /** Older pages are inserted above the reading position; a first visit starts at the latest overflow. */
  private addOlder(posts: servers.Post[], mine: boolean) {
    const page = servers.pageOf(posts);
    if (!page) return;
    if (this.pages.length) { this.steady(() => this.add(page, 'older')); return; }
    this.add(page, 'older');
    if (this.active() && (mine || !this.restore)) this.toFoot();
    this.read();
  }

  private tell() {
    this.fresh.hidden = this.unseen === 0;
    this.fresh.textContent = `↓ ${this.unseen === 1 ? t('{n} new post', {n: 1}) : t('{n} new posts', {n: this.unseen})}`;
  }

  /** What came since the newest post held, put at the foot; `mine`: the reader just wrote, so go to it. */
  private async look(mine: boolean): Promise<void> {
    if (!this.root.isConnected || (connection()?.session ?? '') !== this.scope) return;
    if (!this.pages.length) {
      this.done = false;
      if (this.reading) { this.cameMeanwhile = true; return; }
      return this.older(mine);
    }
    try {
      const got = await allAfter(this.board, this.member, this.pages[0].page.newest);
      if (this.root.isConnected && (connection()?.session ?? '') === this.scope && got.length) this.addNewer(got, mine);
    } catch { /* tried again on the next look */ }
  }

  /** New arrivals do not move a place held higher up. One's own post does go to the foot. */
  private addNewer(got: servers.Post[], mine: boolean) {
    const open = this.active();
    const following = open && (mine || (!this.restore && this.atFoot()));
    for (const page of servers.onTop(got).reverse()) this.add(page, 'newer');
    this.report();
    if (following) { this.restore = null; this.toFoot(); this.read(); }
    else if (mine) { this.restore = null; this.heldTop = Number.MAX_SAFE_INTEGER; }
    else { this.unseen += got.length; this.tell(); }
  }
}
