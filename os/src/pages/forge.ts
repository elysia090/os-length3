import {addToBand, offBand, parseBand, removeFromBand} from '../band.ts';
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

/**
 * Forge, the place you work. The repos out to work on run as pills in a band
 * on the top line; ⊕ brings the rest out and each
 * pill comes off with its ×. The large center is the open repo's files one
 * after another, an endless page you scroll through and edit in place,
 * opened at the file chosen in File; there are no tabs. A prompt box sits at
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

/** One repo's page in the center: what reads it, where it was scrolled to, and whether it must be read again. */
interface View { reader: Reader; root: HTMLElement; top: number; stale: boolean }

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
  const view = () => (repo ? views.get(repo) ?? null : null);
  const strip = h('nav', {class: 'repo-strip', 'aria-label': 'repo'});
  const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': t('The repo\'s contents')});
  /** What the center says with no repo out. */
  const nothing = h('div', {class: 'empty forge-none', hidden: ''}, t('Bring a repo out to the band with ⊕, or open one from File'));
  flow.append(nothing);
  /**
   * Each repo's page stays in the center once made, the others hidden: a text box taken
   * out of the document loses its Undo, so going to another repo and back keeps it.
   */
  const put = (root: HTMLElement | null) => {
    nothing.hidden = root !== null;
    for (const v of views.values()) v.root.hidden = v.root !== root;
    if (root && root.parentElement !== flow) flow.append(root);
  };

  const work = bench({strip, main: flow, reveal: (path, line, write) => void view()?.reader.reveal(path, line, write).then(() => track())});
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
  strip.append(add, pills);
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
    pills.replaceChildren(...band.map((name) => {
      const open = h('button', {type: 'button', class: 'pill-name'}, name);
      open.addEventListener('click', () => show(name));
      const close = h('button', {type: 'button', class: 'pill-close', 'aria-label': t('Take {name} off the band', {name})}, mark('close'));
      close.addEventListener('click', () => takeOff(name));
      const pill = h('span', {class: 'pill', 'data-repo': name}, open, close);
      // The pill shows it (ink); its button says it, which is what is heard.
      if (name === repo) { pill.setAttribute('aria-current', 'page'); open.setAttribute('aria-current', 'page'); }
      return pill;
    }));
    paintAdd();
  };
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
    // Off the band, its place is not kept: brought out again, it opens at its top.
    views.get(name)?.root.remove();
    views.delete(name);
    if (!r.active) none();
    else if (r.active !== repo) show(r.active);
    else paintBand();
  };

  /** Nothing on the band: the center says how to bring a repo out (Server is laid over any page, not kept here). */
  const none = () => {
    repo = null;
    work.setRepo(null);
    put(null);
    flow.scrollTop = 0;
    told(null);
    paintBand();
  };

  /** A repo's page, made the first time it is shown, or again once what it showed changed out of sight. */
  const viewOf = (name: string): View => {
    const had = views.get(name);
    if (had && !had.stale) return had;
    const reader = new Reader(name, flow);
    const v = {reader, root: reader.directory(''), top: had?.top ?? 0, stale: false};
    // Read again: the page it was takes its place.
    if (had) had.root.replaceWith(v.root);
    views.set(name, v);
    return v;
  };

  /** Show `name` in the band, the center and the terminal, in place; at `path` if given, ready to write with `write`. */
  const show = (name: string, path = '', write = false) => {
    band = addToBand(band, name);
    saveBand();
    if (repo !== name) {
      repo = name;
      known = name;
      ctx.remember(name);
      const v = viewOf(name);
      work.setRepo(name);
      put(v.root);
      flow.scrollTop = v.top;
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
    quiet = window.setTimeout(() => { const v = view(); if (v && flow.isConnected) told(v.reader.reading()); }, 120);
  };
  // Taken off the screen and put back, a place that scrolls starts at its top again: each comes back where it was.
  let restoring = false;
  /** A path was asked for since Forge came back on screen (File, Git, a search): that wins over where it was. */
  let revealing = false;
  const tops = new Map<Element, number>();
  work.element.addEventListener('scroll', (event) => {
    if (restoring || !work.element.isConnected) return;
    const el = event.target as Element;
    if (el === flow) { const v = view(); if (v) v.top = flow.scrollTop; track(); } else tops.set(el, el.scrollTop);
  }, true);

  // The repo changed through the store (the shell, l3's twin in the Prompt,
  // Git…): open files take the new text, new or removed entries redraw the
  // page where it was; a repo out of sight is read again when it is shown.
  let again = 0, putBack = 0;
  /** The open repo's page read again where it was read; `keep` false when it is about to be scrolled elsewhere. */
  const readAgain = (keep = true) => {
    again = 0;
    if (!repo) return;
    const top = views.get(repo)?.top ?? 0;
    const reader = new Reader(repo, flow);
    const fresh = {reader, root: reader.directory(''), top, stale: false};
    const was = views.get(repo);
    // The file being written keeps the keyboard and its caret through the page read again.
    const writing = was && document.activeElement instanceof HTMLTextAreaElement && was.root.contains(document.activeElement) ? document.activeElement : null;
    const at = writing?.closest<HTMLElement>('section.file')?.dataset.path;
    views.set(repo, fresh);
    if (was) was.root.replaceWith(fresh.root);
    put(fresh.root);
    if (keep) putBack = requestAnimationFrame(() => { flow.scrollTop = top; });
    if (writing && at) void reader.refocus(at, writing.selectionStart, writing.selectionEnd);
  };
  const offChange = onChange((c) => {
    const v = views.get(c.repo);
    if (!v || !v.reader.take(c)) return;
    if (c.repo !== repo) { v.stale = true; return; }
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
      const v = view();
      if (v && !revealing) flow.scrollTop = v.top;
      for (const [el, top] of tops) { if (el.isConnected) el.scrollTop = top; else tops.delete(el); }
      restoring = false;
    });
    void store.list().then((repos) => {
      all = repos.map((r) => r.name);
      band = parseBand(first ? getState('band') : JSON.stringify(band), all, ctx.repo);
      first = false;
      for (const name of [...views.keys()]) if (!all.includes(name)) { views.get(name)?.root.remove(); views.delete(name); }
      const asked = pending;
      pending = null;
      const chosen = ctx.repo !== known;
      known = ctx.repo;
      // Opened for a repo (from File, Home or a new repo), or one chosen to work on elsewhere: it goes on the band.
      if (ctx.repo && all.includes(ctx.repo) && (asked || chosen)) { show(ctx.repo, asked?.path ?? '', asked?.write ?? false); return; }
      if (repo && all.includes(repo)) { paintBand(); track(); return; }
      repo = null;
      const open = ctx.repo && band.includes(ctx.repo) ? ctx.repo : band[0];
      if (open) show(open); else none();
    });
  };
  // Forge's head is its band; its name is still the page's heading, for those who hear the page.
  work.element.prepend(h('h1', {class: 'sr-only'}, t('Forge')));
  return {element: work.element, enter, drop: () => { offChange(); offSync(); }};
}
