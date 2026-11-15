import {h} from '../../ui/dom.ts';
import {pageVeil} from '../../ui/page-veil.ts';
import {cut, LAND, nudge, paced, still} from '../../ui/glide.ts';
import {t} from '../../../text/i18n.ts';
import {onChange, onRenamed, rekey, store} from '../../../repo/repos.ts';
import {stillAt} from '../../../repo/search.ts';
import {foundView, patched, readAll, search, type Files} from './found.ts';
import {drawLine, remember, seenButton, seenIn, seenKind, seenLabel, type Seen, type Slot} from './seen.ts';
import {SPRING} from '../../ui/law.ts';

// The search on the band: what is typed finds the repo's files and the lines in them (found.ts), dropped as a sheet
// over the desk; a file or a line pressed opens on the desk, in its piece. What was searched lines up sideways, in the
// order it came (seen.ts): the one in hand fills the sheet, the ones beside it a sliver past its edges, pressed (or
// ← →) to move to them; pressed with nothing typed, the box shows what was searched and read here. Each repo keeps its
// own search and line while the app runs. The keyboard gone elsewhere in the page, the sheet goes back up.
// (Before, a switch under the box (Issue, diff, Output, Agent) listed and read each repo's issues, its changes, what
// its Prompt ran and what its Agent was asked: each has its place of its own now, an issue Git's, a change the issue's
// sheet, a run the terminal's own output, an ask the Agent's piece; a file's way back to its last commit is its own
// menu's Revert.)

/** Per repo, while the app is open: what was typed (a repo renamed keeps it). */
const queries = new Map<string, string>();
onRenamed((from, to) => { rekey(queries, from, to); });

/** The box's card while nothing of the line is in hand: what is found, the switch's list, or what was searched and read. */
type Live = {kind: string; label: string; alone?: boolean};

interface ReferenceEvents {
  /** Scroll the center to a path in the open repo, at `line` if given; with `write`, the caret in it. */
  reveal(path: string, line?: number, write?: boolean): void;
}


let made = 0;

/** The search box and what opens under it, for a page that has one (Forge's and Git's bench, Home). */
export class Reference {
  /** The search box and what is under it, for the top line over the right pane. */
  readonly search: HTMLElement;
  private query: HTMLInputElement;
  /** The box gets the keyboard, what is written in it selected (Ctrl+K, Ctrl+P: writing replaces it). */
  findNow() { if (!this.searchable) return; this.query.focus(); this.query.select(); if (!this.repo) nudge(this.search); }
  private readonly searchable: boolean;
  /** Without a search field, what is under it takes the keyboard itself instead of an invisible input. */
  private focusReader(options?: FocusOptions) {
    if (this.searchable) { this.query.focus(options); return; }
    const from = document.activeElement as HTMLElement | null;
    if (!from || !this.search.contains(from)) this.before = from;
    // Focus the anchor first so :focus-within reveals the reader before it takes the keyboard.
    this.search.focus({preventScroll: true});
    this.under.focus(options);
  }
  /** Where no band says which repo it is (Home's), the box names it: "Search garden". */
  named(repo: string | null) { this.say(repo ? t('Search {repo}', {repo}) : this.repo ? t('Search this repo') : t('No repo to search')); }
  /** Under the box: the large box with what was searched and found, in a line. */
  private under: HTMLElement;
  /** The box lies on the band (a desk's): it says only Search. */
  private band: boolean;
  private panel: HTMLElement;
  /** The inside of the card in hand, where what is found is drawn. */
  private body: HTMLElement = h('div', {class: 'found-body'});
  /** The card's foot, at the box's bottom. */
  private foot: HTMLElement = h('div', {class: 'found-foot'});
  private repo: string | null = null;
  private events: ReferenceEvents;
  private files: Promise<Files> | null = null;
  /** On the band, a line or file gone to from what was found: the words go from the box once the sheet is up. */
  private used = false;
  /** The words that went so: come back to the box (/, a press), they are in it again, chosen, as a find bar's are. */
  private lastWords = '';
  private timer = 0;
  private findTimer = 0;
  private found = 0;
  /** Something saved since what is under the box was drawn, while it had the keyboard: drawn again once it does not. */
  private dirty = false;
  /** Stops following the store; null while it does not (off the screen). */
  private stop: (() => void) | null = null;
  /** What had the keyboard before the search took it (from outside the search and what is under it). */
  private before: HTMLElement | null = null;
  /** What is under the box going back up into it, while it goes. */
  private leaving: Animation | null = null;
  /**
   * On the band, nothing drops from the box until something is typed in it (it holds only what it takes room for):
   * what there is with nothing typed (what was searched and read) comes down once asked for, with ↓.
   */
  private asked = false;
  /** How tall what dropped from the box on the band was when last seen: it grows and shrinks to what it holds. */
  private tall = 0;
  /** The sheet going up a little to what it holds (fit), while it goes; and whether what it holds changed since. */
  private sizing: Animation | null = null;
  private changed = false;
  /**
   * On the band, whether what is found for the words typed is drawn: until it is, nothing drops (a sheet let down
   * empty, filled a frame later, is a sheet that flickers); it comes down with what it holds already in it.
   */
  private ready = false;

  constructor(events: ReferenceEvents, o: {band?: boolean; searchable?: boolean} = {}) {
    this.events = events;
    this.searchable = o.searchable !== false;
    this.band = !!o.band;
    const n = ++made;
    this.query = h('input', {type: 'search', class: 'search-in', placeholder: t('Search this repo'),
      'aria-label': t('Search this repo'), autocomplete: 'off', spellcheck: 'false', 'aria-controls': `found-${n}`}) as HTMLInputElement;
    this.panel = h('div', {class: 'search-panel'});
    // ← → along the line, as along Git's issues and Server's boards.
    this.panel.addEventListener('keydown', (event) => this.alongLine(event));
    this.under = h('div', {class: 'search-results', id: `found-${n}`, role: 'region', 'aria-label': t('Search results')}, this.panel);
    this.query.addEventListener('focus', () => {
      if (!this.query.value && this.lastWords) {
        this.query.value = this.lastWords;
        this.lastWords = '';
        this.query.select();
        this.keep();
        this.query.dispatchEvent(new Event('input'));
        void this.draw();
        return;
      }
      if (this.dirty) { this.dirty = false; void this.draw(); } else if (!this.panel.childElementCount) void this.draw();
    });
    this.query.addEventListener('input', () => {
      this.keep();
      this.idle();
      // Found again for each key, on the frame it shows in (keys typed within one frame found once).
      cancelAnimationFrame(this.findTimer);
      this.findTimer = requestAnimationFrame(() => void this.draw());
    });
    this.query.addEventListener('focus', (event) => {
      const from = event.relatedTarget as HTMLElement | null;
      if (!from || !this.search.contains(from)) this.before = from;
    });
    this.query.addEventListener('keydown', (event) => this.queryKey(event));
    // Held (no repo to search in): a press on it, or a letter written in it, says no where it is.
    this.query.addEventListener('pointerdown', () => { if (!this.repo) nudge(this.search); });
    this.query.addEventListener('keydown', (event) => { if (!this.repo && event.key.length === 1 && !event.ctrlKey && !event.metaKey) nudge(this.search); });
    // Along what is there with ↑ ↓; Escape goes back up to the box (from something read: back to what it was chosen from).
    this.panel.addEventListener('keydown', (event) => this.alongList(event));
    // Ctrl+K (⌘+K) comes to it from anywhere; the box does not say so on itself, as an editor's would.
    this.query.setAttribute('aria-keyshortcuts', /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta+K' : 'Control+K');
    const form = h('form', {class: 'search', role: 'search'}, this.query);
    form.addEventListener('submit', (event) => event.preventDefault());
    this.search = h('div', {class: 'search-box'}, ...(this.searchable ? [form] : []), this.under);
    if (!this.searchable) {
      this.search.tabIndex = -1;
      this.under.tabIndex = -1;
      this.under.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) this.escape(event);
      });
    }
    this.goesUp();
    this.follow();
    if (this.band) {
      // The sheet says the words searched for at its head, large (forge-band.css), wherever the band is (Forge's, Home's).
      const said = () => { this.under.dataset.q = this.query.value.trim(); };
      this.query.addEventListener('input', said);
      said();
      new ResizeObserver(() => this.fit()).observe(this.under);
      // What it holds changing is what it is fitted to again (not its own going up, which moves it each frame).
      new MutationObserver(() => { this.changed = true; }).observe(this.under, {childList: true, subtree: true, characterData: true});
      // Whether the sheet is down is said on the page's work (paintDown), as the keyboard and its states move.
      const later = () => setTimeout(() => this.paintDown());
      this.search.addEventListener('focusin', later);
      this.search.addEventListener('focusout', later);
      new MutationObserver(() => this.paintDown()).observe(this.search, {attributes: true, attributeFilter: ['class']});
    }
  }

  /** The page out of focus under what the band's search found. */
  private veil = pageVeil('deep');

  /**
   * On the band, whether what is under the box is down over the desk (the box has the keyboard, or something is read
   * or moving there, and it is not going up nor idle): said on the page's work as `sheet-down`, the desk's boxes going
   * out of sight under it (forge-band.css). A class, not a :has() asked of the whole work: that was asked again at each
   * move of the keyboard anywhere in it, a few ms of the page's styles each time.
   */
  private paintDown() {
    const s = this.search;
    const down = s.matches(':focus-within, .moving') && !s.matches('.leaving, .idle');
    s.closest('.work, .home-layout')?.classList.toggle('sheet-down', down);
    // The page under what was found steps back out of focus, as it does under File's tree (ui/page-veil.ts).
    this.veil.out(down);
  }

  /**
   * On the band, what dropped from the box grows and shrinks to what it holds as one types on (as the mock's does):
   * taken up a little over a few frames, let down at once (coming down the first time, it unrolls: styles' drop-in).
   */
  private fit() {
    // Going up a little, it is resized each frame by its own going: nothing to fit to unless what it holds changed.
    const going = this.sizing;
    if (going && !this.changed) return;
    this.changed = false;
    const shown = this.under.offsetHeight;
    going?.cancel();
    this.sizing = null;
    const now = this.under.offsetHeight, was = going ? shown : this.tall;
    this.tall = now;
    // Grown, it is as tall as what it holds at once: let down over a few frames, what came in would be cut off at its
    // foot while it went (a key every 170 ms keeps it going). Taken up, it goes up over them from where it is shown:
    // nothing in it is cut.
    if (!now || !was || now - was > -2 || still() || this.search.matches('.leaving')) return;
    const a = this.sizing = this.under.animate([{height: `${was}px`, overflow: 'hidden'}, {height: `${now}px`, overflow: 'hidden'}], {duration: cut() ? 0 : paced(220), easing: LAND});
    a.finished.then(() => { if (this.sizing === a) this.sizing = null; }, () => {});
  }

  /** On the band with nothing typed or read, and nothing asked for: nothing drops from the box. */
  private idle() {
    const typed = !!this.query.value.trim();
    if (!typed) this.ready = false;
    const idle = this.band && !this.asked && (!typed || !this.ready);
    this.search.classList.toggle('idle', idle);
    // Typed, and what is found for it not drawn yet: the sheet's lip (its shadow) shows under the band, where it will
    // come down from, so the key is answered at once (forge-band.css .lip).
    this.search.classList.toggle('lip', idle && typed);
    return idle;
  }

  /** What the box says where the words would be, and is heard as; on the band, where it is short, only Search. */
  private say(words: string) {
    // (With no repo it says Search as any box does, never an explanation of itself; why is heard only.)
    this.query.placeholder = (this.band && this.repo) || !this.repo ? t('Search') : words;
    this.query.setAttribute('aria-label', words);
  }

  /** ← → on the line (or a sliver at its edge): to the one beside. */
  private alongLine(event: KeyboardEvent) {
    if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !(event.target as HTMLElement).matches('.slide-stage, .stage-hit')) return;
    const hit = this.panel.querySelector<HTMLButtonElement>(`.stage-hit.${event.key === 'ArrowLeft' ? 'prev' : 'next'}`);
    if (hit && !hit.hidden) { event.preventDefault(); hit.click(); }
  }

  /** ↑ ↓ along what can be chosen under the box, up into the box from the first; Escape back up to the box. */
  private alongList(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); this.focusReader(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const all = this.choices();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && at === 0) this.focusReader();
    else all[Math.min(at + (event.key === 'ArrowDown' ? 1 : -1), all.length - 1)]?.focus();
  }

  /** Keys in the box: Escape, ↓ down into what is under it, Enter. */
  private queryKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Escape') { this.escape(event); return; }
    // ↓ goes down into what is under the box; Enter takes the first of it: the first line found, or before it a file
    // whose name holds what was typed (the caret in it). A file's name found by its lines alone, and its diff, are
    // pressed, not gone along (found.ts).
    if (event.key === 'ArrowDown') {
      // On the band, ↓ in the box with nothing typed lets down what there is (what was searched and read).
      if (this.search.classList.contains('idle')) { event.preventDefault(); this.asked = true; void this.draw(); return; }
      const first = this.choices()[0];
      if (first) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // The first found is taken (what was typed goes in the line before it); with none, what was typed does.
      const first = this.choices()[0];
      const q = this.query.value.trim();
      if (first) first.click();
      else if (q) { this.remember({what: 'query', text: q}); void this.draw(); }
    }
  }

  /** Escape in the box: what is typed goes, else the box lets go of the keyboard. */
  private escape(event: KeyboardEvent) {
    if (this.query.value) { event.preventDefault(); this.query.value = ''; this.keep(); void this.draw(); return; }
    // Nothing typed and nothing read: what is under the box goes.
    event.preventDefault();
    this.putAway();
  }

  /**
   * What is under the box put away (Escape with nothing typed, or its ×): the keyboard, if it was in the search, goes
   * back to what had it before the search took it, where it is still to be had; never left on nothing.
   */
  private putAway() {
    this.asked = false;
    if (!this.search.contains(document.activeElement)) return;
    const back = this.before;
    this.before = null;
    if (back?.isConnected && !back.closest('[hidden], [inert]') && back.getClientRects().length) back.focus({preventScroll: true});
    else (document.activeElement as HTMLElement).blur();
  }

  /**
   * Let go (the keyboard gone elsewhere, Escape with nothing typed, or put away by its × while the keyboard is
   * elsewhere), what is under the box goes back up into it as it came down out of it, not at once (styles.css
   * .leaving); come back to meanwhile, it stays. The keyboard gone elsewhere in the page (the file, the rail), all of
   * it goes, what is read with it: nothing searched stays over the desk. Gone to another window, it stays as it was,
   * to come back to.
   */
  private goesUp() {
    this.search.addEventListener('focusout', (event) => {
      const to = event.relatedTarget as Node | null;
      if ((to && this.search.contains(to)) || this.search.matches('.moving')) return;
      // Asked once the keyboard has landed; till then what is under the box stays as it is (.letting), not gone for
      // the frame between.
      this.search.classList.add('letting');
      setTimeout(() => {
        this.search.classList.remove('letting');
        if (!document.hasFocus() || this.search.contains(document.activeElement) || this.search.matches('.moving')) return;
        this.asked = false;
        this.goUp();
      });
    });
    this.search.addEventListener('focusin', () => { this.used = false; this.leaving?.cancel(); this.leaving = null; this.search.classList.remove('leaving'); });
  }

  /** What is under the box going back up into it. */
  private goUp() {
    if (still() || !this.search.getClientRects().length) { this.wordsGo(); return; }
    this.search.classList.add('leaving');
    // On the band the sheet goes back up behind the band as it came down, whole, as a drawer is shut (no fading: a
    // sheet half seen through over the desk is two pictures at once); elsewhere it goes as a card does.
    const frames = this.band
      ? [{transform: 'none', clipPath: 'inset(-12px -12px -12px -12px)'}, {transform: 'translateY(calc(-100% - var(--s3)))', clipPath: 'inset(100% -12px -12px -12px)'}]
      : [{opacity: 1, transform: 'none'}, {opacity: 0, transform: 'translateY(calc(-1 * var(--s2)))'}];
    const a = this.leaving = this.under.animate(frames, {duration: paced(this.band ? 220 : 150), easing: SPRING, fill: 'forwards'});
    a.finished.then(() => {
      if (this.leaving !== a) return;
      this.leaving = null;
      this.search.classList.remove('leaving');
      a.cancel();
      this.wordsGo();
    }, () => {});
  }

  /** The words used (a line or a file gone to from what they found, on the band): gone from the box, which says Search
   * again; what was searched is kept in the history (the box pressed with nothing typed). */
  private wordsGo() {
    if (!this.used) return;
    this.used = false;
    this.query.dispatchEvent(new Event('input'));
  }

  /** On the band, what was found gone to: the box says Search at once, the sheet keeping the words at its head while
   * it goes up (wordsGo tells the rest once it is up). */
  private wordsUsed() {
    if (!this.band) return;
    this.lastWords = this.query.value;
    this.query.value = '';
    this.used = true;
  }

  /** What can be chosen in the card in hand, in order. */
  private choices(): HTMLElement[] { return [...this.body.querySelectorAll<HTMLElement>('button.choice')]; }

  /**
   * What is under the box follows what is saved, here or in the Prompt: what was found.
   * Off the screen it stops following; a page that comes back with it (Forge's, Git's) calls `resume`.
   */
  private follow() {
    const stop = onChange((c) => {
      if (!this.search.isConnected) { stop(); this.stop = null; return; }
      if (c.repo !== this.repo) return;
      if (this.files) this.files = patched(this.files, c);
      // Not drawn away from under the keyboard: what has it is kept until the box has it again (asked again when
      // the moment comes, the keyboard having gone down into it meanwhile).
      const held = () => this.panel.contains(document.activeElement);
      if (held()) { this.dirty = true; return; }
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => { if (held()) this.dirty = true; else void this.draw(); }, 250);
    });
    this.stop = stop;
  }

  /** Back on the screen: following again, and drawn afresh (what changed meanwhile is in it). */
  resume() {
    if (!this.stop) this.follow();
    this.files = null;
    void this.draw();
  }

  /** The repo shown; what was searched and the history in it come back with it. */
  setRepo(repo: string | null) {
    this.repo = repo;
    this.files = null;
    this.lastWords = '';
    // With no repo it cannot be searched in: held, as a step not to be taken now is, and a press or a key on it says
    // no where it is (a box that took the press and did nothing told nothing). Why is heard: "No repo to search".
    this.query.readOnly = !repo;
    if (repo) this.query.removeAttribute('aria-disabled'); else this.query.setAttribute('aria-disabled', 'true');
    this.say(repo ? t('Search this repo') : t('No repo to search'));
    this.query.value = repo ? queries.get(repo) ?? '' : '';
    void this.draw();
  }

  private keep() {
    if (!this.repo) return;
    if (this.query.value) queries.set(this.repo, this.query.value); else queries.delete(this.repo);
  }

  /** Something searched or read here, at the line's end (once: the same thing again stays where it is). */
  private remember(s: Seen) { if (this.repo) remember(this.repo, s); }

  /**
   * The large box: the line of what was searched (files aside: they open on the desk), with the live card at its end
   * (`live`: what is found) or alone (what was searched and read). The card in hand fills it; its neighbours show a
   * sliver past its edges, pressed to move to them, as are ← and → under the box.
   */
  private frame(live: Live) {
    const line = live.alone ? [] : seenIn(this.repo ?? '').filter((s) => s.what !== 'file');
    // What is typed is already in the line: that place is the one in hand, not another card at its end.
    const typed = !live.alone && live.kind === t('Search history') ? line.findIndex((s) => s.what === 'query' && s.text === live.label) : -1;
    const slots: Slot[] = line.map((s) => ({kind: seenKind(s), label: seenLabel(s), go: () => void this.again(s)}));
    let k = typed;
    if (k < 0) { slots.push({kind: live.kind, label: live.label, go: () => void this.draw()}); k = slots.length - 1; }
    this.body = h('div', {class: 'found-body'});
    this.foot = h('div', {class: 'found-foot'});
    drawLine(this.search, this.panel, slots, k, [this.body, this.foot], () => this.putAway());
  }

  /** What is in the box now: what was found, or what was searched and read. */
  private async draw() {
    // (Drawn all the same: what is there is ready the moment it is asked for.)
    this.idle();
    const query = this.query.value.trim();
    const repo = this.repo;
    if (!repo) { this.panel.replaceChildren(h('p', {class: 'muted small'}, t('Open a repo to search'))); return; }
    // (What is found is framed by find itself, once it is found: the sheet keeps what it shows until then.)
    if (query) return this.find(query);
    // Nothing typed: what was searched and read here, newest first.
    this.frame({kind: t('Search and history'), label: '', alone: true});
    const seen = seenIn(repo).slice().reverse();
    // (On the band a sheet holds only what it has: none, nor is it left saying so while one types.)
    if (!seen.length) { this.body.replaceChildren(...(this.band ? [] : [h('p', {class: 'muted small'}, t('Searched and viewed items appear here'))])); return; }
    this.body.replaceChildren(h('ul', {class: 'found-list'}, ...seen.map((s) => h('li', {}, seenButton(s, (x) => void this.again(x))))));
  }

  private async again(s: Seen) {
    const repo = this.repo;
    if (!repo) return;
    if (s.what === 'query') { this.query.value = s.text; this.keep(); void this.draw(); return; }
    if (s.what === 'file') this.events.reveal(s.path, 0, true);
  }

  /** What is found for `query`: the repo's files and the lines in them. */
  private async find(query: string) {
    const repo = this.repo!;
    const run = ++this.found;
    const live = {kind: t('Search history'), label: query};
    // What was found for the words before stays until what is found for these is ready: never an empty sheet between
    // two keys. Nothing found yet, the card is there at once (off the band, saying it is searching).
    const had = (this.ready || !this.band) && !!this.body.querySelector('.hit-group, .found-secs, .search-count');
    if (!had) {
      this.frame(live);
      if (!this.band) this.body.replaceChildren(h('p', {class: 'muted small'}, t('Searching…')));
    }
    this.files ??= readAll(repo);
    let files: Files;
    try {
      files = await this.files;
    } catch (e) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('Search failed: {message}', {message: String(e)}))); this.drop(); return; }
    const stale = () => run !== this.found || repo !== this.repo;
    if (stale()) return;
    const found = await search(query, files, stale);
    if (!found || stale()) return;
    const said = foundView(found, query, {
      file: (path) => { this.remember({what: 'query', text: query}); this.remember({what: 'file', path}); this.wordsUsed(); this.events.reveal(path, 0, true); },
      line: (path, line) => void this.go(path, line, query),
    }, {sections: this.band});
    const focused = this.choices().indexOf(document.activeElement as HTMLElement);
    if (had) this.frame(live);
    if (!said.length) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('No results found for "{query}"', {query}))); this.drop(); return; }
    // Come in place of Searching… (not redrawn as one types on), what was found comes down the page, a group a beat
    // after the one above it, as its marks are stroked: not the whole sheet in one frame.
    const fresh = !had;
    this.body.replaceChildren(...said);
    // What was found is read from its head: the words searched for, then the first found.
    if (fresh) this.panel.scrollTop = 0;
    // (On the band the sheet carries it down as it drops: nothing in it comes in on its own.)
    if (fresh && !this.band && !still()) said.slice(0, 8).forEach((el, i) => el.animate([{opacity: 0, translate: '0 4px'}, {opacity: 1, translate: '0 0'}],
      {duration: cut() ? 0 : paced(220), delay: paced(i * 30), easing: LAND, fill: 'backwards'}));
    if (focused >= 0) this.choices()[Math.min(focused, this.choices().length - 1)]?.focus();
    this.drop();
  }

  /** What was found is drawn: on the band, the sheet comes down with it in it (idle). */
  private drop() {
    this.ready = true;
    this.idle();
  }

  /**
   * A line found is opened where it is now: what was found may have been saved over since,
   * so the file as saved is looked at first, and the line followed if it moved.
   */
  private async go(path: string, line: number, query: string) {
    const repo = this.repo;
    if (!repo) return;
    const c = await store.read(repo, path).catch(() => null);
    const at = c?.text == null ? null : stillAt(c.text, query, line);
    if (repo !== this.repo) return;
    if (at === null) {
      // Gone: what is found now is said in its place, and nothing is opened.
      this.files = null;
      void this.draw();
      this.query.focus();
      return;
    }
    this.remember({what: 'query', text: query});
    this.remember({what: 'file', path});
    this.wordsUsed();
    this.events.reveal(path, at);
  }
}
