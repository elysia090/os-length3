import {addToBand, closeBeside, moveTo, offBand, openBeside, parseBand, removeFromBand, showIn} from '../band.ts';
import {currentLang, t} from '../i18n.ts';
import {getState, setState} from '../state.ts';
import {h} from '../dom.ts';
import {mark} from '../icons.ts';
import {bring, onSync, remoteOnly} from '../lifecycle.ts';
import {onChange, store} from '../repos.ts';
import type {Context} from './context.ts';
import {bench} from './bench.ts';
import {Reader} from './reader.ts';
import {startIssue} from './issue-form.ts';
import {arrive, glide, LAND, where} from '../glide.ts';

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
let pending: {path: string; write: boolean} | null = null;

/** The Forge on screen, so File can move it in place. */
let live: {element: HTMLElement; show(repo: string, path: string, write: boolean): void} | null = null;

/** Show `repo` at `path` in the Forge on screen (the caret at its start with `write`); false when Forge is not showing. */
export function showInForge(repo: string, path: string, write = false): boolean {
  if (!live?.element.isConnected) return false;
  live.show(repo, path, write);
  return true;
}

/** Forge is next drawn for the repo just asked for, at `path` ('' for its top). */
export function revealNext(path: string, write = false) { pending = {path, write}; }

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
    }
    saveBeside(shown);
  };

  const work = bench({strip, main: cols, reveal: (path, line, write) => void view()?.reader.reveal(path, line, write).then(() => track())});
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
  acts.addEventListener('click', () => { if (repo) ctx.actOn(repo, reading ?? ''); });
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

  const paintBand = () => {
    const was = new Map([...pills.querySelectorAll<HTMLElement>('.pill')].map((p) => [p.dataset.repo!, p.getBoundingClientRect()]));
    const inkWas = where(pills.querySelector('.pill[aria-current]'));
    pills.replaceChildren(...band.map((name) => {
      // Pressed, it is worked on in the box worked on; with Ctrl (⌘), it opens beside (as a link opens in a new tab).
      const open = h('button', {type: 'button', class: 'pill-name', title: t('Ctrl+click: open beside')}, name);
      open.addEventListener('click', (event) => { if (event.ctrlKey || event.metaKey) beside(name); else show(name); });
      const close = h('button', {type: 'button', class: 'pill-close', 'aria-label': t('Take {name} off the band', {name})}, mark('close'));
      close.addEventListener('click', () => takeOff(name));
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
      if (name === repo) { pill.setAttribute('aria-current', 'page'); open.setAttribute('aria-current', 'page'); }
      else if (shown.includes(name)) pill.classList.add('beside');
      return pill;
    }));
    if (!still()) {
      // What moved along the band glides to where it is now; the ink goes from the pill it was on to the one it is on.
      for (const p of pills.querySelectorAll<HTMLElement>('.pill')) {
        const from = was.get(p.dataset.repo!), to = p.getBoundingClientRect();
        if (from && Math.abs(from.left - to.left) > 1) p.animate([{transform: `translateX(${from.left - to.left}px)`}, {transform: 'none'}], {duration: 240, easing: LAND});
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
    const r = removeFromBand(band, name, repo);
    band = r.band;
    saveBand();
    // Off the band, its box goes from the row too; its place is not kept: brought out again, it opens at its top.
    const c = closeBeside(shown, name, repo);
    shown = c.shown;
    views.get(name)?.col.remove();
    views.delete(name);
    if (!r.active) { none(); return; }
    const next = c.active && band.includes(c.active) ? c.active : r.active;
    if (next !== repo || !shown.includes(next)) show(next); else { layout(); paintBand(); }
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
  const viewOf = (name: string): View => {
    const had = views.get(name);
    if (had && !had.stale) return had;
    if (had) {
      // Read again: the page it was takes its place, in the same box.
      const reader = new Reader(name, had.flow);
      const v = {...had, reader, root: reader.directory(''), stale: false};
      had.root.replaceWith(v.root);
      views.set(name, v);
      return v;
    }
    // Its head says whose it is and closes it, side by side only; pressed, or dragged along the row, it moves.
    const label = h('button', {type: 'button', class: 'col-name'}, name);
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
    const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': t('The files of {name}', {name})});
    const col = h('div', {class: 'col', 'data-repo': name, hidden: ''}, head, flow);
    cols.append(col);
    const reader = new Reader(name, flow);
    const root = reader.directory('');
    flow.append(root);
    const v = {col, flow, reader, root, top: 0, stale: false};
    views.set(name, v);
    return v;
  };

  /** `name`, shown, is the one worked on: the prompt, the search and File follow it, the row as it is. */
  const activate = (name: string) => {
    if (name === repo || !shown.includes(name)) return;
    repo = name;
    known = name;
    ctx.remember(name);
    work.setRepo(name);
    layout();
    paintBand();
    track();
  };

  /** A box coming into the row grows from nothing as the others make room; going, it gives its room back. */
  const grow = (col: HTMLElement, on: boolean) => new Promise<void>((done) => {
    if (still() || (!cols.classList.contains('split') && on)) { done(); return; }
    // From (or to) no width, by the same transition that hands the width from box to box (styles.css .col).
    col.classList.add('nothing');
    if (on) { void col.offsetWidth; requestAnimationFrame(() => { col.classList.remove('nothing'); done(); }); } else setTimeout(done, 360);
  });

  /** `name` opened beside what is shown (at `at`, an index among the boxes), and worked on. */
  const beside = (name: string, at?: number) => {
    if (matchMedia('(max-width: 760px)').matches) { show(name); return; }
    band = addToBand(band, name);
    saveBand();
    const before = shown;
    shown = openBeside(shown, name, repo, at);
    const v = viewOf(name);
    const fresh = !before.includes(name);
    for (const gone of before.filter((n) => !shown.includes(n))) { const g = views.get(gone); if (g) g.top = g.flow.scrollTop; }
    repo = null;
    activate(name);
    v.flow.scrollTop = v.top;
    if (fresh) void grow(v.col, true);
  };

  /** `name`'s box closed (the repo stays on the band); the last one stays. */
  const closeCol = (name: string) => {
    if (shown.length < 2 || !shown.includes(name)) return;
    const v = views.get(name);
    const c = closeBeside(shown, name, repo);
    const done = () => {
      shown = c.shown;
      if (c.active && c.active !== repo) { repo = null; activate(c.active); } else { layout(); paintBand(); }
    };
    if (v) { v.top = v.flow.scrollTop; v.col.classList.add('going'); void grow(v.col, false).then(() => { v.col.classList.remove('going', 'nothing'); done(); }); } else done();
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
    const left = d.instead ? r.left : d.at <= shown.indexOf(d.over?.dataset.repo ?? '') ? r.left : r.left + r.width / 2;
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
    if (c?.dataset.repo && !el.closest('.col-close')) activate(c.dataset.repo);
  }, true);
  cols.addEventListener('focusin', (event) => {
    const el = event.target as HTMLElement;
    const c = el.closest<HTMLElement>('.col');
    if (c?.dataset.repo && !el.closest('.col-close')) activate(c.dataset.repo);
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
  const show = (name: string, path = '', write = false) => {
    band = addToBand(band, name);
    saveBand();
    if (repo !== name || !shown.includes(name)) {
      const from = repo;
      const was = views.get(from ?? '');
      if (was) was.top = was.flow.scrollTop;
      const fresh = !shown.includes(name);
      shown = showIn(shown.filter((n) => views.has(n) || n === name), name, from);
      const v = viewOf(name);
      repo = null;
      activate(name);
      v.flow.scrollTop = v.top;
      // Coming into a box another stood in, it slides in from the side its pill is on along the band.
      if (fresh && from) arrive(v.flow, Math.sign(band.indexOf(name) - band.indexOf(from)), 'x', 32, 260);
    }
    paintBand();
    // A file just made (from File) is read in now, so the caret lands in it, not in the page about to be read again.
    if (path && again) { clearTimeout(again); readAgain(false); }
    // Nor does a page just read again put it back where it was, over the place asked for.
    if (path) cancelAnimationFrame(putBack);
    // A place asked for is where the center goes: coming back does not put it back where it was.
    if (path) { revealing = true; void view()?.reader.reveal(path, 0, write).then(() => track()); }
    else track();
  };
  live = {element: work.element, show};

  // Where the center is read is kept for its repo at each scroll, and the
  // file being read is said to File, which marks it.
  let reading: string | null = null;
  const told = (path: string | null) => { if (path !== reading) { reading = path; ctx.reading(path); } };
  let quiet = 0;
  const track = () => {
    clearTimeout(quiet);
    quiet = window.setTimeout(() => { const v = view(); if (v && v.flow.isConnected) told(v.reader.reading()); }, 120);
  };
  // Taken off the screen and put back, a place that scrolls starts at its top again: each comes back where it was.
  let restoring = false;
  /** A path was asked for since Forge came back on screen (File, Git, a search): that wins over where it was. */
  let revealing = false;
  const tops = new Map<Element, number>();
  work.element.addEventListener('scroll', (event) => {
    if (restoring || !work.element.isConnected) return;
    const el = event.target as Element;
    const v = el.classList.contains('flow') ? [...views.values()].find((w) => w.flow === el) : undefined;
    if (v) { v.top = el.scrollTop; if (v === view()) track(); } else tops.set(el, el.scrollTop);
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
    const reader = new Reader(repo, was.flow);
    const fresh = {...was, reader, root: reader.directory(''), top, stale: false};
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
    const v = views.get(c.repo);
    if (!v || !v.reader.take(c)) return;
    // Beside the one worked on, a box shown is read again as it stands; one out of sight, when it is shown.
    if (c.repo !== repo) { if (shown.includes(c.repo)) { v.stale = true; viewOf(c.repo); layout(); } else v.stale = true; return; }
    clearTimeout(again);
    again = window.setTimeout(() => readAgain(), 150);
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
      for (const name of [...views.keys()]) if (!all.includes(name)) { views.get(name)?.col.remove(); views.delete(name); }
      // What stood side by side, as far as it is still on the band.
      shown = shown.filter((n) => band.includes(n));
      for (const n of shown) viewOf(n);
      const asked = pending;
      pending = null;
      const chosen = ctx.repo !== known;
      known = ctx.repo;
      // Opened for a repo (from File, Home or a new repo), or one chosen to work on elsewhere: it goes on the band.
      if (ctx.repo && all.includes(ctx.repo) && (asked || chosen)) { show(ctx.repo, asked?.path ?? '', asked?.write ?? false); return; }
      if (repo && all.includes(repo) && shown.includes(repo)) { layout(); paintBand(); track(); return; }
      repo = null;
      const open = ctx.repo && band.includes(ctx.repo) ? ctx.repo : shown[0] ?? band[0];
      if (open) show(open); else none();
    });
  };
  // Forge's head is its band; its name is still the page's heading, for those who hear the page.
  work.element.prepend(h('h1', {class: 'sr-only'}, t('Forge')));
  return {element: work.element, enter, drop: () => { offChange(); offSync(); }};
}
