import {addToBand, closeBeside, moveTo, offBand, openBeside, parseBand, removeFromBand, showIn} from '../band.ts';
import {currentLang, t} from '../i18n.ts';
import {getState, setState} from '../state.ts';
import {h} from '../dom.ts';
import {mark} from '../icons.ts';
import {bring, onSync, remoteOnly} from '../lifecycle.ts';
import {onChange, store} from '../repos.ts';
import {shownName} from '../issues.ts';
import {work as workOn} from '../history.ts';
import type {Context} from './context.ts';
import {bench} from './bench.ts';
import {openNext as openConversation} from './inbox.ts';
import {Reader, type Writing} from './reader.ts';
import {startIssue} from './issue-form.ts';
import {showIssue} from './git.ts';
import {after, glide, LAND, paced, panAcross, where} from '../glide.ts';

/**
 * Forge, the place you work. The repos out to work on run as pills in a band
 * on the top line; ⊕ brings the rest out and each
 * pill comes off with its ×. The large center is the open repo's files one
 * after another, an endless page you scroll through and edit in place,
 * opened at the file chosen in File; there are no tabs. Up to three repos
 * stand side by side in it, each its own page, tiled: one is opened beside
 * the others by dragging its pill into the center (where it is let go is
 * where it stands), by Ctrl+click on its pill, or Ctrl+\ (the next on the
 * band); the one worked on (the prompt, the search and File follow it) is
 * the one last pressed in, drawn in ink. A prompt box sits at
 * the bottom of the center. The narrow right pane holds the search box and a
 * reference switched freely on top and the Prompt below; using the prompt
 * box sends the Prompt up over the center, just above the box, and the
 * reference grows down into the room it leaves.
 *
 * Forge is made once and stays as it was while another page is shown, so
 * coming back is coming back to the same repo, where it was read, what was
 * searched and what was half written. Each repo on the band keeps its own
 * place the same way: going to another repo and back is going back to where
 * one was in it.
 */

/** Set when Forge is opened for a repo: the path to scroll to ('' for the top), and whether to write there. */
let pending: {path: string; write: Writing; line: number} | null = null;

/** The Forge on screen, so File can move it in place. */
let live: {element: HTMLElement; show(repo: string, path: string, write: Writing, line?: number): void} | null = null;

/** Show `repo` at `path` in the Forge on screen (at `line`; the caret there with `write`); false when Forge is not showing. */
export function showInForge(repo: string, path: string, write: Writing = false, line = 0): boolean {
  if (!live?.element.isConnected) return false;
  live.show(repo, path, write, line);
  return true;
}

/** Forge is next drawn for the repo just asked for, at `path` ('' for its top), at `line` of it. */
export function revealNext(path: string, write: Writing = false, line = 0) { pending = {path, write, line}; }

/**
 * One repo's page in the center: its box in the row (its head, and the page that scrolls), what reads it, where it
 * was scrolled to, and whether it must be read again.
 */
interface View { col: HTMLElement; flow: HTMLElement; reader: Reader; root: HTMLElement; top: number; stale: boolean }

/** The repos side by side, as last left on this device (a convenience: the band is what is kept). */
const BESIDE_KEY = 'length3.forge.beside';
const readBeside = (): string[] => { try { const v: unknown = JSON.parse(localStorage.getItem(BESIDE_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : []; } catch { return []; } };
const saveBeside = (shown: string[]) => { try { localStorage.setItem(BESIDE_KEY, JSON.stringify(shown)); } catch { /* a convenience */ } };
/** What a drag of a repo carries: its name, for the band and the center of this page alone. */
const DRAGGED = 'application/x-length3-repo';
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** A box in the row is a repo's page (its name) or one file of it beside (name:path; a repo's name has no colon). */
const repoOf = (key: string) => key.split(':')[0];
const fileOf = (key: string) => (key.includes(':') ? key.slice(key.indexOf(':') + 1) : null);
const keyOf = (repo: string, path: string) => `${repo}:${path}`;

let made: {element: HTMLElement; enter(): void; drop(): void} | null = null;

/**
 * Forge's element once made, which the page keeps in the document (hidden) while
 * another page is shown: a text box taken out of the document loses what Undo
 * would take back, so nothing written in Forge is ever taken out to show something else.
 */
export const keptForge = (): HTMLElement | null => (madeIn === currentLang() ? made?.element ?? null : null);
/** The language Forge was made in: another chosen since, it is made again, so none of its words stay in the last one. */
let madeIn: string | null = null;

export function forge(ctx: Context): Node[] {
  if (madeIn !== currentLang()) { made?.drop(); made = null; madeIn = currentLang(); }
  made ??= make(ctx);
  made.enter();
  return [made.element];
}

function make(ctx: Context) {
  const views = new Map<string, View>();
  let repo: string | null = null;
  /** The repos side by side in the center, left to right; the one worked on is among them. */
  let shown: string[] = readBeside();
  const view = () => (repo ? views.get(repo) ?? null : null);
  const strip = h('nav', {class: 'repo-strip', 'aria-label': 'repo'});
  // The center's row: each repo's box stays in it once made, those not shown hidden, and each stands where CSS
  // `order` puts it, never moved in the document (a text box taken out of the document loses its Undo).
  const cols = h('div', {class: 'columns'});
  /** What the center says with no repo out. */
  // ⊕ in the words is the band's own mark (its circle and plus, on the words' line), not a glyph of the font set high.
  const nothing = h('div', {class: 'empty forge-none', hidden: ''},
    ...t('Bring a repo out to the band with ⊕, or open one from File').split('⊕').flatMap((part, i) => (i ? [h('span', {class: 'inline-add', 'aria-label': '⊕'}, mark('plus')), part] : [part])));
  cols.append(nothing);
  /** Drawn as `shown` and `repo` say: which boxes stand, in what order, and which is worked on. */
  const layout = () => {
    nothing.hidden = shown.length > 0;
    acts.disabled = repo === null;
    cols.classList.toggle('split', shown.length > 1);
    cols.dataset.n = String(shown.length);
    for (const [name, v] of views) {
      const at = shown.indexOf(name);
      v.col.hidden = at < 0;
      v.col.style.order = String(at);
      v.col.classList.toggle('active', name === repo);
      v.col.classList.toggle('first', at === 0);
      v.col.classList.toggle('last', at === shown.length - 1);
      v.col.classList.toggle('before', at >= 0 && repo !== null && at < shown.indexOf(repo));
      v.col.classList.toggle('after', at >= 0 && repo !== null && at > shown.indexOf(repo));
    }
    work.element.classList.toggle('split-on', shown.length > 1);
    // A file in a box of its own is only its head in its repo's page.
    for (const [name, v] of views) {
      if (fileOf(name) === null) v.reader.fold(shown.filter((k) => repoOf(k) === name && fileOf(k) !== null).map((k) => fileOf(k)!));
      else if (shown.includes(name)) v.reader.refit();
    }
    // The row slides so the box worked on stands in it whole and its neighbours' edges show past the frame's lines.
    // A box just shown takes the row's place first (the reflow), so it slides with the rest rather than appearing.
    const at = repo ? Math.max(0, shown.indexOf(repo)) : 0;
    cols.style.setProperty('--at', String(at));
    cols.style.setProperty('--lead', String(at === 0 ? 0 : at === shown.length - 1 ? 2 : 1));
    cols.style.setProperty('--n', String(Math.max(1, shown.length)));
    room();
    saveBeside(shown);
  };
  /**
   * The prompt box stands under the box worked on, its edges a step (s3) outside that box's: where the box will be
   * once the row has moved (styles.css: one box s5 in from the center's edges; side by side with the pane out, the
   * one worked on whole between its neighbours' edges, `--peek` and `--pad`; with the pane away, all of them whole
   * and as wide), so it moves with the row rather than after it.
   */
  const placeDock = (w: number) => {
    const bench = work.element;
    const n = shown.length, at = repo ? Math.max(0, shown.indexOf(repo)) : 0;
    const S3 = 12, PEEK = 64;
    let left = S3, width = w - 2 * S3;
    if (n > 1 && bench.classList.contains('pane-closed')) { width = (w - 2 * S3) / n; left = S3 + at * width; }
    else if (n > 1) { width = w - 2 * PEEK - 2 * S3; left = S3 + (at === 0 ? 0 : at === n - 1 ? 2 : 1) * PEEK; }
    bench.style.setProperty('--dock-l', `${left}px`);
    bench.style.setProperty('--dock-r', `${w - left - width}px`);
  };
  /**
   * How wide the row is once the pane has done moving (the bench's width, less the pane's when it is out: styles.css
   * `.work.bench`, max(280px, 25%); narrow, the pane is laid over the center), not how wide it is this frame: the row
   * and the prompt box are sent there once, as the pane is put away or brought back, and move on its curve beside its
   * edge, not after it a step behind each frame.
   */
  const room = () => {
    const W = work.element.clientWidth;
    if (!W) return;
    const w = narrow.matches || work.element.classList.contains('pane-closed') ? W : W - Math.max(280, W / 4);
    cols.style.setProperty('--cols-w', `${w}px`);
    placeDock(w);
  };
  const narrow = matchMedia('(max-width: 760px)');

  // A place asked for in another file than the one a box beside holds is read in the repo's page, which comes in
  // where that box stood (or is gone to, standing in the row already).
  const revealAt = (path: string, line = 0, write: Writing = false) => {
    const file = repo ? fileOf(repo) : null;
    // A file standing in a box of its own is read there, not in the page where it is only its head.
    const own = repo ? keyOf(repoOf(repo), path) : '';
    if (repo && own !== repo && shown.includes(own)) {
      repo = null;
      activate(own);
      paintBand();
    } else if (repo && file !== null && file !== path) {
      const page = repoOf(repo);
      if (!shown.includes(page)) { shown = showIn(shown, page, repo); viewOf(page); }
      repo = null;
      activate(page);
      paintBand();
    }
    void view()?.reader.reveal(path, line, write).then(() => track());
  };
  const work = bench({strip, main: cols, reveal: (path, line, write) => revealAt(path, line, write), word: (a) => { openConversation(a); void ctx.go('inbox'); },
    went: (repo, to) => { if (to !== 'todo') showIssue(repo, to.issue); void ctx.go(to === 'todo' ? 'home' : 'git'); }});
  new ResizeObserver(room).observe(work.element);
  new MutationObserver(room).observe(work.element, {attributes: true, attributeFilter: ['class']});
  // The Issue view with none open begins one for this repo on Git; Not now there comes back here.
  work.reference.writeIssue = (r) => { startIssue(r); ctx.go('git'); };

  // The band: ⊕ first, then the repos out to work on, each a pill that comes
  // off with its ×. One press of ⊕ brings every repo not on the band out at
  // once; this is not adding tabs one by one, and what comes and goes is to
  // its right, so ⊕ stays where it was pressed however many come out (the
  // pills scroll after it). With no pill left the center says how to bring one out.
  let band: string[] = [];
  let all: string[] = [];
  const pills = h('div', {class: 'pills'});
  const add = h('button', {type: 'button', class: 'band-add', 'aria-label': t('Bring every repo out to the band')}, mark('plus')) as HTMLButtonElement;
  // First on the band, what can be done to the file read now (or the repo itself): File's menu for it, out of the
  // tree at its row (New file, New folder, Rename, Delete, as each allows); ⊕ after the pills (issue #49).
  const acts = h('button', {type: 'button', class: 'band-add band-acts', 'aria-label': t('Files: new, rename, delete'),
    title: t('Files: new, rename, delete')}, mark('files')) as HTMLButtonElement;
  acts.addEventListener('click', () => { if (repo) ctx.actOn(repoOf(repo), reading ?? ''); });
  strip.append(acts, pills, add);
  const saveBand = () => { void setState('band', JSON.stringify(band)).catch(() => { /* the band is a convenience */ }); };
  /** Every repo: here, and only on the Remote (fetched when it comes out, as opening one from Home does). */
  const every = () => [...all, ...remoteOnly().map((r) => r.name).filter((n) => !all.includes(n))];
  add.addEventListener('click', async () => {
    const rest = offBand(band, every());
    if (!rest.length) return;
    // Held down while repos come from the Remote, ⊕ loses the keyboard; it is given back below.
    const pressed = document.activeElement === add;
    add.disabled = true;
    try {
      for (const name of rest.filter((n) => !all.includes(n))) { await bring(name); all = [...all, name]; }
    } catch (e) { add.disabled = false; add.title = e instanceof Error ? e.message : String(e); if (pressed) add.focus(); return; }
    for (const name of rest) band = addToBand(band, name);
    saveBand();
    if (repo) paintBand(); else show(rest[0]);
    // Nothing left to bring out, ⊕ steps back; the keyboard that pressed it goes to the first repo it brought.
    if (pressed) (add.disabled ? pills.querySelector<HTMLElement>(`.pill[data-repo="${CSS.escape(rest[0])}"] .pill-name`) : add)?.focus();
  });

  /**
   * The issue each repo on the band is worked on for (#n), while its copy is an issue's rather than main: Start in Git
   * turns the repo's files into the issue's, and its pill says so, so what is written here is seen to be for it.
   */
  const onIssue = new Map<string, string>();
  const readIssues = () => {
    for (const name of band) {
      void workOn(name).then((w) => {
        const n = w.issue?.match(/(\d+)/)?.[1];
        const was = onIssue.get(name);
        if (n) onIssue.set(name, `#${Number(n)}`); else onIssue.delete(name);
        if (was !== onIssue.get(name)) paintBand();
      }, () => {});
    }
  };
  /** The band as last drawn: which pills, and which is worked on or open beside. */
  let painted = '';
  const paintBand = () => {
    // Asked again as it already is (one deed can ask twice: the box chosen, then the box shown), it is left as it
    // is: drawn anew, its pills would be new ones, and the ink on its way between two would stop where it was.
    const state = band.map((name) => `${name}${onIssue.get(name) ?? ''}:${repo && name === repoOf(repo) ? 'on' : shown.some((k) => repoOf(k) === name) ? 'beside' : ''}`).join('|');
    if (state === painted && pills.querySelectorAll('.pill').length === band.length) { paintAdd(); return; }
    painted = state;
    const was = new Map([...pills.querySelectorAll<HTMLElement>('.pill')].map((p) => [p.dataset.repo!, p.getBoundingClientRect()]));
    const inkWas = where(pills.querySelector('.pill[aria-current]'));
    pills.replaceChildren(...band.map((name) => {
      // Pressed, it is worked on in the box worked on; with Ctrl (⌘), it opens beside (as a link opens in a new tab).
      const issue = onIssue.get(name);
      const open = h('button', {type: 'button', class: 'pill-name', title: issue ? t('On {issue}: what is written here is for it', {issue}) : t('Ctrl+click: open beside')},
        name, issue ? h('span', {class: 'pill-issue', 'aria-hidden': 'true'}, issue) : null);
      open.addEventListener('click', (event) => { if (event.ctrlKey || event.metaKey) beside(name); else show(name); });
      const close = h('button', {type: 'button', class: 'pill-close', 'aria-label': t('Take {name} off the band', {name})}, mark('close'));
      // Taken off, the keyboard is not left on nothing: it goes to the pill now worked on (or the next), on the band.
      close.addEventListener('click', () => {
        takeOff(name);
        (pills.querySelector<HTMLElement>('.pill[aria-current] .pill-name') ?? pills.querySelector<HTMLElement>('.pill-name'))?.focus({preventScroll: true});
      });
      const pill = h('span', {class: 'pill', 'data-repo': name, draggable: 'true'}, open, close);
      // The middle button takes it off, as it closes a tab.
      pill.addEventListener('auxclick', (event) => { if (event.button === 1) { event.preventDefault(); takeOff(name); } });
      pill.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData(DRAGGED, name);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        dragging = name;
        requestAnimationFrame(() => pill.classList.add('lifted'));
      });
      pill.addEventListener('dragend', () => { dragging = null; pill.classList.remove('lifted'); unhint(); });
      // The pill shows it (ink); its button says it, which is what is heard. Beside it, its outline in ink.
      if (repo && name === repoOf(repo)) { pill.setAttribute('aria-current', 'page'); open.setAttribute('aria-current', 'page'); }
      else if (shown.some((k) => repoOf(k) === name)) pill.classList.add('beside');
      return pill;
    }));
    if (!still()) {
      // What moved along the band glides to where it is now; the ink goes from the pill it was on to the one it is on.
      // What is new on a band that was there (brought out with ⊕, made, opened) comes out of the ⊕ at its end, one
      // after another, as from where it was kept.
      let came = 0;
      for (const p of pills.querySelectorAll<HTMLElement>('.pill')) {
        const from = was.get(p.dataset.repo!), to = p.getBoundingClientRect();
        if (from && Math.abs(from.left - to.left) > 1) p.animate([{transform: `translateX(${from.left - to.left}px)`}, {transform: 'none'}], {duration: paced(240), easing: LAND});
        else if (!from && was.size) p.animate([{transform: 'translateX(24px)', opacity: 0}, {transform: 'none', opacity: 1}],
          {duration: paced(300), delay: paced(came++ * 60), easing: LAND, fill: 'backwards'});
      }
    }
    glide(inkWas, pills.querySelector<HTMLElement>('.pill[aria-current]'), pills, 'var(--r-round)');
    paintAdd();
  };

  // Along the band, a pill dragged lands where it is let go, the others making room.
  let dragging: string | null = null;
  const bandSlot = (x: number) => {
    const ps = [...pills.querySelectorAll<HTMLElement>('.pill')];
    const i = ps.findIndex((p) => { const r = p.getBoundingClientRect(); return x < r.left + r.width / 2; });
    return i < 0 ? ps.length : i;
  };
  const caret = h('span', {class: 'band-caret', 'aria-hidden': 'true'});
  pills.addEventListener('dragover', (event) => {
    if (!dragging || !band.includes(dragging)) return;
    event.preventDefault();
    const i = bandSlot(event.clientX), ps = [...pills.querySelectorAll<HTMLElement>('.pill')];
    const box = pills.getBoundingClientRect();
    const edge = ps[i] ? ps[i].getBoundingClientRect().left - 5 : ps.at(-1)!.getBoundingClientRect().right + 3;
    caret.style.left = `${edge - box.left + pills.scrollLeft}px`;
    if (!caret.isConnected) pills.append(caret);
  });
  pills.addEventListener('dragleave', (event) => { if (!pills.contains(event.relatedTarget as Node)) caret.remove(); });
  pills.addEventListener('drop', (event) => {
    const name = event.dataTransfer?.getData(DRAGGED) || dragging;
    caret.remove();
    if (!name || !band.includes(name)) return;
    event.preventDefault();
    band = moveTo(band, name, bandSlot(event.clientX));
    saveBand();
    paintBand();
  });
  /** ⊕, by how many repos are not on the band yet. */
  const paintAdd = () => {
    const rest = offBand(band, every()).length;
    add.disabled = rest === 0;
    add.title = rest ? t('Bring every repo out to the band ({n} more)', {n: rest}) : t('Every repo is on the band');
  };

  const takeOff = (name: string) => {
    const r = removeFromBand(band, name, repo && repoOf(repo));
    band = r.band;
    saveBand();
    // Off the band, its boxes go from the row too (its page, and any file of it beside); their place is not kept:
    // brought out again, it opens at its top.
    let c: {shown: string[]; active: string | null} = {shown, active: repo};
    for (const k of [...views.keys()].filter((k) => repoOf(k) === name)) {
      c = closeBeside(c.shown, k, c.active);
      views.get(k)?.col.remove();
      views.delete(k);
    }
    shown = c.shown;
    if (!r.active) { none(); return; }
    const next = c.active && band.includes(repoOf(c.active)) ? c.active : r.active;
    if (shown.includes(next)) { if (next !== repo) { repo = null; activate(next); } else { layout(); paintBand(); } } else show(repoOf(next));
  };

  /** Nothing on the band: the center says how to bring a repo out (Server is laid over any page, not kept here). */
  const none = () => {
    repo = null;
    shown = [];
    work.setRepo(null);
    layout();
    told(null);
    paintBand();
  };

  /** A repo's page, made the first time it is shown, or again once what it showed changed out of sight. */
  /** What a box reads: the repo's whole page, or the one file it was opened beside for. */
  const pageOf = (name: string, flow: HTMLElement) => {
    const reader = new Reader(repoOf(name), flow, {beside: (path) => beside(keyOf(repoOf(name), path)), act: (path) => ctx.actOn(repoOf(name), path)});
    const file = fileOf(name);
    return {reader, root: file === null ? reader.directory('') : reader.only(file)};
  };
  const viewOf = (name: string): View => {
    const had = views.get(name);
    if (had && !had.stale) return had;
    if (had) {
      // Read again: the page it was takes its place, in the same box.
      const v = {...had, ...pageOf(name, had.flow), stale: false};
      had.root.replaceWith(v.root);
      views.set(name, v);
      return v;
    }
    // Its head says whose it is and closes it, side by side only; pressed, or dragged along the row, it moves.
    // A file beside says its repo quietly, then its name (its whole path when pointed at).
    const file = fileOf(name);
    const label = h('button', {type: 'button', class: 'col-name', title: file ?? name},
      ...(file === null ? [name] : [h('span', {class: 'col-repo'}, repoOf(name)), shownName(file)]));
    label.addEventListener('click', () => activate(name));
    const close = h('button', {type: 'button', class: 'col-close', 'aria-label': t('Close {name} beside', {name})}, mark('close'));
    close.addEventListener('click', () => closeCol(name));
    const head = h('div', {class: 'col-head', draggable: 'true'}, label, close);
    head.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData(DRAGGED, name);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      dragging = name;
    });
    head.addEventListener('dragend', () => { dragging = null; unhint(); });
    const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': file === null ? t('The files of {name}', {name}) : `${repoOf(name)}/${file}`});
    const col = h('div', {class: `col${file === null ? '' : ' col-file'}`, 'data-repo': repoOf(name), 'data-key': name, hidden: ''}, head, flow);
    cols.append(col);
    const {reader, root} = pageOf(name, flow);
    flow.append(root);
    const v = {col, flow, reader, root, top: 0, stale: false};
    views.set(name, v);
    return v;
  };

  /** `name`, shown, is the one worked on: the prompt, the search and File follow it, the row as it is. */
  const activate = (name: string) => {
    if (name === repo || !shown.includes(name)) return;
    repo = name;
    known = repoOf(name);
    ctx.remember(repoOf(name));
    work.setRepo(repoOf(name));
    layout();
    paintBand();
    // Only come to (pressed, or come in as another closed): what it reads is said, not taken as where one left off.
    track(false);
  };

  /** A box going from the row fades where it stands; then the row closes over its place, by the move that slides it. */
  const shrink = (col: HTMLElement) => new Promise<void>((done) => {
    if (still()) { done(); return; }
    col.classList.add('nothing');
    after(280, done);
  });

  /** `name` opened beside what is shown (at `at`, an index among the boxes), and worked on. */
  const beside = (name: string, at?: number) => {
    if (matchMedia('(max-width: 760px)').matches) { show(repoOf(name), fileOf(name) ?? ''); return; }
    band = addToBand(band, repoOf(name));
    saveBand();
    const before = shown;
    shown = openBeside(shown, name, repo, at);
    const v = viewOf(name);
    const fresh = !before.includes(name);
    for (const gone of before.filter((n) => !shown.includes(n))) { const g = views.get(gone); if (g) g.top = g.flow.scrollTop; }
    // Come in, it opens from no width where it stands as the row slides to it, so it pushes in from its side.
    const opening = fresh && shown.length > 1 && !still();
    if (opening) {
      v.col.classList.add('nothing');
      // It stands in the row where the row is now, before the row moves to it: drawn first at the row's present place,
      // it then goes with the others on their curve, not at once to where they are only on their way to.
      layout();
      void cols.offsetWidth;
    }
    repo = null;
    activate(name);
    v.flow.scrollTop = v.top;
    // The keyboard goes with it: what opened it (a file's head, now only peeking) is no longer the place to hold it,
    // and given back to the box it was in, that box would be the one worked on again.
    v.flow.focus({preventScroll: true});
    if (opening) requestAnimationFrame(() => v.col.classList.remove('nothing'));
  };

  /** `name`'s box closed (the repo stays on the band); the last one stays. */
  const closeCol = (name: string) => {
    if (shown.length < 2 || !shown.includes(name)) return;
    const v = views.get(name);
    const c = closeBeside(shown, name, repo);
    const done = () => {
      // The boxes that stay go on from where they are seen: the closed one's place gone from the row moves them in the
      // layout at once, so each is held where it stood and goes from there to its place on the row's curve, rather
      // than leaping by a box's width and sliding back.
      const rest = c.shown.map((n) => views.get(n)?.col).filter((el): el is HTMLElement => !!el);
      const was = new Map(rest.map((el) => [el, el.getBoundingClientRect().left]));
      for (const el of rest) el.style.transitionProperty = 'flex-basis, opacity';
      shown = c.shown;
      if (c.active && c.active !== repo) { repo = null; activate(c.active); } else { layout(); paintBand(); }
      void cols.offsetWidth;
      for (const el of rest) {
        const dx = was.get(el)! - el.getBoundingClientRect().left;
        el.style.transitionProperty = '';
        if (Math.abs(dx) > .5 && !still()) el.animate([{translate: `${dx}px 0`}, {translate: '0 0'}], {duration: paced(450), easing: LAND});
      }
    };
    if (!v) { done(); return; }
    v.top = v.flow.scrollTop;
    v.col.classList.add('going');
    // The one worked on closed, the one taking its place comes in as it goes (the row sliding to it), the keyboard
    // with it: never an empty row while the closed one closes.
    const next = c.active && c.active !== repo ? views.get(c.active) : undefined;
    if (next && c.active) { activate(c.active); next.flow.focus({preventScroll: true}); }
    void shrink(v.col).then(() => { v.col.classList.remove('going', 'nothing'); done(); });
  };

  // Into the center, a pill (or a box's head) dragged shows where it would stand: over a box's left or right
  // third, beside it on that side; over its middle, in its place. Let go, it stands there.
  const hint = h('div', {class: 'drop-hint', 'aria-hidden': 'true'});
  const unhint = () => { hint.remove(); cols.classList.remove('dropping'); };
  /** Where a repo let go at x would stand: an index among the shown, and whether it takes that box's place. */
  const dropAt = (x: number): {at: number; instead: boolean; over: HTMLElement | null} => {
    const boxes = shown.map((n) => views.get(n)?.col).filter((c): c is HTMLElement => !!c);
    for (const [i, c] of boxes.entries()) {
      const r = c.getBoundingClientRect();
      if (x > r.right) continue;
      const third = (x - r.left) / r.width;
      if (third < 1 / 3) return {at: i, instead: false, over: c};
      if (third > 2 / 3) return {at: i + 1, instead: false, over: c};
      return {at: i, instead: true, over: c};
    }
    return {at: boxes.length, instead: false, over: boxes.at(-1) ?? null};
  };
  // Files dragged in from the desktop go into the repo whose box they are let go over: into the folder of the file
  // under the pointer, else its top; a name already there is never written over (the new one is "name (2)").
  const filesIn = (event: DragEvent) => !dragging && !!event.dataTransfer?.types.includes('Files');
  const dropTarget = (event: DragEvent) => {
    const el = event.target as HTMLElement;
    const col = el.closest<HTMLElement>('.col');
    const file = el.closest<HTMLElement>('section.file')?.dataset.path ?? '';
    return col?.dataset.repo ? {repo: col.dataset.repo, col, dir: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''} : null;
  };
  cols.addEventListener('dragover', (event) => {
    if (filesIn(event)) {
      const at = dropTarget(event);
      if (!at) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      const box = cols.getBoundingClientRect(), r = at.col.getBoundingClientRect();
      Object.assign(hint.style, {left: `${r.left - box.left}px`, width: `${r.width}px`});
      hint.dataset.how = 'files';
      hint.textContent = t('Put in {where}', {where: at.dir ? `${at.repo}/${at.dir}` : at.repo});
      if (!hint.isConnected) { cols.append(hint); cols.classList.add('dropping'); }
      return;
    }
    if (!dragging || matchMedia('(max-width: 760px)').matches) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const d = dropAt(event.clientX);
    const box = cols.getBoundingClientRect();
    const r = d.over?.getBoundingClientRect() ?? box;
    const left = d.instead ? r.left : d.at <= shown.indexOf(d.over?.dataset.key ?? '') ? r.left : r.left + r.width / 2;
    const width = d.instead ? r.width : r.width / 2;
    Object.assign(hint.style, {left: `${left - box.left}px`, width: `${width}px`});
    hint.dataset.how = d.instead ? 'instead' : 'beside';
    hint.textContent = d.instead ? t('Open here') : t('Open beside');
    if (!hint.isConnected) { cols.append(hint); cols.classList.add('dropping'); }
  });
  cols.addEventListener('dragleave', (event) => { if (!cols.contains(event.relatedTarget as Node)) unhint(); });
  cols.addEventListener('drop', (event) => {
    if (filesIn(event)) {
      unhint();
      const at = dropTarget(event);
      const files = [...event.dataTransfer?.files ?? []];
      if (!at || !files.length) return;
      event.preventDefault();
      void (async () => {
        const taken = new Set((await store.tree(at.repo, at.dir).catch(() => [])).map((e) => e.name));
        let first: string | null = null;
        for (const f of files) {
          const dot = f.name.lastIndexOf('.') > 0 ? f.name.lastIndexOf('.') : f.name.length;
          let name = f.name;
          for (let n = 2; taken.has(name); n++) name = `${f.name.slice(0, dot)} (${n})${f.name.slice(dot)}`;
          taken.add(name);
          const path = at.dir ? `${at.dir}/${name}` : name;
          // A folder dragged in reads as no bytes at all: it is left where it was.
          const bytes = await f.arrayBuffer().then((b) => new Uint8Array(b), () => null);
          if (!bytes) continue;
          await store.put(at.repo, path, bytes);
          first ??= path;
        }
        if (first) show(at.repo, first);
      })();
      return;
    }
    const name = event.dataTransfer?.getData(DRAGGED) || dragging;
    unhint();
    if (!name) return;
    event.preventDefault();
    const d = dropAt(event.clientX);
    const there = shown[d.at] ?? null;
    if (shown.includes(name)) {
      // A box dragged along the row: it stands where it is let go (in a box's middle, the two change places).
      shown = d.instead && there ? shown.map((n) => (n === name ? there : n === there ? name : n)) : moveTo(shown, name, d.at);
      repo = null;
      activate(name);
      layout();
      return;
    }
    if (d.instead && there) { repo = there; show(name); } else beside(name, d.at);
  });
  // Pressed into, a box is the one worked on (what was pressed goes on as pressed); its × closes it, the one
  // worked on staying as it was.
  cols.addEventListener('pointerdown', (event) => {
    const el = event.target as HTMLElement;
    const c = el.closest<HTMLElement>('.col');
    if (c?.dataset.key && !el.closest('.col-close')) activate(c.dataset.key);
  }, true);
  cols.addEventListener('focusin', (event) => {
    const el = event.target as HTMLElement;
    const c = el.closest<HTMLElement>('.col');
    if (c?.dataset.key && !el.closest('.col-close')) activate(c.dataset.key);
  });
  // Swiped sideways over the row (a trackpad, or Shift and the wheel), the next box along is the one worked on: one
  // box a swipe, however long the swipe, so it never runs past where it was meant to stop.
  let swiped = 0, swipeQuiet = 0;
  cols.addEventListener('wheel', (event) => {
    if (shown.length < 2 || !repo) return;
    const dx = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (!dx) return;
    // What can still scroll that way under the pointer (a long line of code) scrolls first; only at its end, or
    // where nothing scrolls sideways, does the swipe go to the next box.
    for (let el = event.target as HTMLElement | null; el && el !== cols; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1 && (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0)) return;
    }
    event.preventDefault();
    clearTimeout(swipeQuiet);
    swipeQuiet = window.setTimeout(() => { swiped = 0; }, 220);
    if (swiped === Infinity) return;
    swiped += dx;
    if (Math.abs(swiped) < 40) return;
    const i = shown.indexOf(repo) + Math.sign(swiped);
    swiped = Infinity;
    if (shown[i]) activate(shown[i]);
  }, {passive: false});
  // Ctrl+\: the next repo on the band opens beside. Alt+[ and Alt+]: the box to the left or right is worked on.
  work.element.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === '\\') {
      const next = band.find((n) => !shown.includes(n));
      if (next) { event.preventDefault(); beside(next); }
      return;
    }
    if (event.altKey && (event.key === '[' || event.key === ']') && shown.length > 1 && repo) {
      event.preventDefault();
      const to = shown[(shown.indexOf(repo) + (event.key === ']' ? 1 : shown.length - 1)) % shown.length];
      activate(to);
      views.get(to)?.flow.focus({preventScroll: true});
    }
  });

  /** Show `name` in the band, the center and the terminal, in place; at `path` if given, ready to write with `write`. */
  const show = (name: string, path = '', write: Writing = false, line = 0, pan = true) => {
    band = addToBand(band, name);
    saveBand();
    const from = repo;
    const switching = repo !== name || !shown.includes(name);
    // Coming into a box another stood in, the camera pans along the band to it: from the side its pill is on. Come
    // from another page (a repo made, opened from File or Home), the camera is already going down the rail to Forge:
    // it arrives with the repo in its box, not panning sideways as well (the neighbour beside it passing through).
    const across = pan && switching && !!from && !shown.includes(name) ? Math.sign(band.indexOf(name) - band.indexOf(repoOf(from!))) : 0;
    const go = () => {
      if (switching) {
        const was = views.get(from ?? '');
        if (was) was.top = was.flow.scrollTop;
        shown = showIn(shown.filter((n) => views.has(n) || n === name), name, from);
        const v = viewOf(name);
        repo = null;
        activate(name);
        v.flow.scrollTop = v.top;
      }
      paintBand();
      arrived();
    };
    const arrived = () => {
      // A file just made (from File) is read in now, so the caret lands in it, not in the page about to be read again.
      if (path && again) { clearTimeout(again); readAgain(false); }
      // Nor does a page just read again put it back where it was, over the place asked for.
      if (path) cancelAnimationFrame(putBack);
      // A place asked for is where the center goes: coming back does not put it back where it was.
      landed = path ?? null;
      // Gone to, it is the file read from now (File marks it, the band's first button opens at it), not only once the
      // center has settled on it a moment later.
      if (path) told(path);
      if (path) { revealing = true; void view()?.reader.reveal(path, line, write).then(() => track()); }
      else track(false);
    };
    if (across) panAcross(cols, across, go); else go();
  };
  live = {element: work.element, show};

  // Where the center is read is kept for its repo at each scroll, and the
  // file being read is said to File, which marks it.
  let reading: string | null = null;
  /** The file last gone to in this repo: the one read while it is in view, wherever the keyboard goes (reader.ts). */
  let landed: string | null = null;
  const told = (path: string | null) => { if (path !== reading) { reading = path; ctx.reading(path); } };
  let quiet = 0;
  /** The file read now, said to File and the band; with `place`, also where in it one is (for Home's Lately). */
  let placing = false;
  const track = (place = true) => {
    clearTimeout(quiet);
    placing ||= place;
    quiet = window.setTimeout(() => {
      const v = view(), was = placing;
      placing = false;
      if (!v || !v.flow.isConnected) return;
      const path = v.reader.reading(landed);
      told(path);
      // Where in it, to come back to (Home's Lately): the caret, or the line read.
      if (was && path) ctx.leftAt(v.reader.repo, path, v.reader.place(path));
    }, 120);
  };
  // Where one is is what one did: written in a file, the caret put or moved in it, the page scrolled by hand. A box
  // coming in (one beside closed, the row sliding to it), a page put back where it was, a button pressed is not, so
  // Home's Lately never quotes the top of a page that only came back into view.
  let handAt = 0;
  for (const e of ['wheel', 'touchmove', 'keydown']) work.element.addEventListener(e, () => { handAt = performance.now(); }, {capture: true, passive: true});
  const inText = (event: Event) => { const el = event.target as Element; return !!el.closest?.('.flow') && !el.closest('button, .path, .col-head'); };
  for (const e of ['input', 'keyup', 'pointerup']) work.element.addEventListener(e, (event) => { if (view() && inText(event)) track(); }, true);
  // Taken off the screen and put back, a place that scrolls starts at its top again: each comes back where it was.
  let restoring = false;
  /** A path was asked for since Forge came back on screen (File, Git, a search): that wins over where it was. */
  let revealing = false;
  const tops = new Map<Element, number>();
  work.element.addEventListener('scroll', (event) => {
    if (restoring || !work.element.isConnected) return;
    const el = event.target as Element;
    const v = el.classList.contains('flow') ? [...views.values()].find((w) => w.flow === el) : undefined;
    if (v) { v.top = el.scrollTop; if (v === view() && performance.now() - handAt < 800) track(); } else tops.set(el, el.scrollTop);
  }, true);

  // The repo changed through the store (the shell, l3's twin in the Prompt,
  // Git…): open files take the new text, new or removed entries redraw the
  // page where it was; a repo out of sight is read again when it is shown.
  let again = 0, putBack = 0;
  /** The open repo's page read again where it was read; `keep` false when it is about to be scrolled elsewhere. */
  const readAgain = (keep = true) => {
    again = 0;
    if (!repo) return;
    const was = views.get(repo);
    if (!was) return;
    const top = was.top;
    const {reader, root} = pageOf(repo, was.flow);
    const fresh = {...was, reader, root, top, stale: false};
    // The file being written keeps the keyboard and its caret through the page read again.
    const writing = document.activeElement instanceof HTMLTextAreaElement && was.root.contains(document.activeElement) ? document.activeElement : null;
    const at = writing?.closest<HTMLElement>('section.file')?.dataset.path;
    views.set(repo, fresh);
    was.root.replaceWith(fresh.root);
    layout();
    if (keep) putBack = requestAnimationFrame(() => { fresh.flow.scrollTop = top; });
    if (writing && at) void reader.refocus(at, writing.selectionStart, writing.selectionEnd);
  };
  const offChange = onChange((c) => {
    // Every box of the repo hears it: its page, and each file of it beside.
    for (const [key, v] of [...views]) {
      if (repoOf(key) !== c.repo || !v.reader.take(c)) continue;
      // Beside the one worked on, a box shown is read again as it stands; one out of sight, when it is shown.
      if (key !== repo) { if (shown.includes(key)) { v.stale = true; viewOf(key); layout(); } else v.stale = true; continue; }
      clearTimeout(again);
      again = window.setTimeout(() => readAgain(), 150);
    }
  });

  // What the Remote holds is learnt a moment after: ⊕ counts it once it is. The pills stay as they
  // are (and the one with the keyboard keeps it): what the Remote holds does not change the band.
  const offSync = onSync(() => paintAdd());

  /** The repo worked on as Forge last knew it: chosen anew elsewhere (Git, Home, File), Forge follows. */
  let known = ctx.repo;
  let first = true;
  const enter = () => {
    restoring = true;
    revealing = false;
    work.settle();
    requestAnimationFrame(() => {
      if (!revealing) for (const n of shown) { const v = views.get(n); if (v) v.flow.scrollTop = v.top; }
      for (const [el, top] of tops) { if (el.isConnected) el.scrollTop = top; else tops.delete(el); }
      restoring = false;
    });
    void store.list().then((repos) => {
      all = repos.map((r) => r.name);
      band = parseBand(first ? getState('band') : JSON.stringify(band), all, ctx.repo);
      first = false;
      readIssues();
      for (const name of [...views.keys()]) if (!all.includes(repoOf(name))) { views.get(name)?.col.remove(); views.delete(name); }
      // What stood side by side, as far as it is still on the band.
      shown = shown.filter((n) => band.includes(repoOf(n)));
      for (const n of shown) viewOf(n);
      const asked = pending;
      pending = null;
      const chosen = ctx.repo !== known;
      known = ctx.repo;
      // Opened for a repo (from File, Home or a new repo), or one chosen to work on elsewhere: it goes on the band.
      if (ctx.repo && all.includes(ctx.repo) && (asked || chosen)) { show(ctx.repo, asked?.path ?? '', asked?.write ?? false, asked?.line ?? 0, false); return; }
      if (repo && all.includes(repoOf(repo)) && shown.includes(repo)) { layout(); paintBand(); track(false); return; }
      repo = null;
      const open = ctx.repo && band.includes(ctx.repo) ? ctx.repo : shown[0] ?? band[0];
      if (open && fileOf(open) !== null) { activate(open); paintBand(); track(false); } else if (open) show(open); else none();
    });
  };
  // Forge's head is its band; its name is still the page's heading, for those who hear the page.
  work.element.prepend(h('h1', {class: 'sr-only'}, t('Forge')));
  return {element: work.element, enter, drop: () => { offChange(); offSync(); }};
}
