import {addToBand, offBand, parseBand, removeFromBand} from '../band.ts';
import {t} from '../i18n.ts';
import {getState, setState} from '../state.ts';
import {h} from '../dom.ts';
import {mark} from '../icons.ts';
import {bring, onSync, remoteOnly} from '../lifecycle.ts';
import {onChange, store} from '../repos.ts';
import type {Context} from './context.ts';
import {bench} from './bench.ts';
import {Reader} from './reader.ts';

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
 */

/** Set when Forge is opened for a repo: the path to scroll to ('' for the top). */
let pending: string | null = null;

/** The Forge on screen, so File can move it in place. */
let live: {element: HTMLElement; show(repo: string, path: string): void} | null = null;

/** Show `repo` at `path` in the Forge on screen; false when Forge is not showing. */
export function showInForge(repo: string, path: string): boolean {
  if (!live?.element.isConnected) return false;
  live.show(repo, path);
  return true;
}

/** Forge is next drawn for the repo just asked for, at `path` ('' for its top). */
export function revealNext(path: string) { pending = path; }

export function forge(ctx: Context): Node[] {
  let reader: Reader | null = null;
  let repo: string | null = null;
  const strip = h('nav', {class: 'repo-strip', 'aria-label': 'repo'});
  const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': t('The repo\'s contents')});

  const work = bench({strip, main: flow, reveal: (path, line) => void reader?.reveal(path, line)});

  // The band: ⊕ at its left, then the repos out to work on, each a pill that
  // comes off with its ×. One press of ⊕ brings every repo not on the band
  // out at once, on the right; this is not adding tabs one by one. With no
  // pill left the center says how to bring one out.
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
    add.disabled = true;
    try {
      for (const name of rest.filter((n) => !all.includes(n))) { await bring(name); all = [...all, name]; }
    } catch (e) { add.disabled = false; add.title = e instanceof Error ? e.message : String(e); return; }
    for (const name of rest) band = addToBand(band, name);
    saveBand();
    if (repo) paintBand(); else show(rest[0]);
  });

  const paintBand = () => {
    pills.replaceChildren(...band.map((name) => {
      const open = h('button', {type: 'button', class: 'pill-name'}, name);
      open.addEventListener('click', () => show(name));
      const close = h('button', {type: 'button', class: 'pill-close', 'aria-label': t('Take {name} off the band', {name})}, mark('close'));
      close.addEventListener('click', () => takeOff(name));
      const pill = h('span', {class: 'pill', 'data-repo': name}, open, close);
      if (name === repo) pill.setAttribute('aria-current', 'page');
      return pill;
    }));
    const rest = offBand(band, every()).length;
    add.disabled = rest === 0;
    add.title = rest ? t('Bring every repo out to the band ({n} more)', {n: rest}) : t('Every repo is on the band');
  };

  const takeOff = (name: string) => {
    const r = removeFromBand(band, name, repo);
    band = r.band;
    saveBand();
    if (!r.active) none();
    else if (r.active !== repo) show(r.active);
    else paintBand();
  };

  /** Nothing on the band: the center says how to bring a repo out (Server is laid over any page, not kept here). */
  const none = () => {
    repo = null;
    reader = null;
    work.setRepo(null);
    flow.replaceChildren(h('div', {class: 'empty forge-none'}, t('Bring a repo out to the band with ⊕, or open one from File')));
    flow.scrollTop = 0;
    paintBand();
  };

  /** Show `name` in the band, the center and the terminal, in place. */
  const show = (name: string, path = '') => {
    band = addToBand(band, name);
    saveBand();
    if (repo !== name) {
      repo = name;
      ctx.remember(name);
      reader = new Reader(name, flow);
      work.setRepo(name);
      flow.replaceChildren(reader.directory(''));
      flow.scrollTop = 0;
    }
    paintBand();
    if (path) void reader!.reveal(path);
  };
  live = {element: work.element, show};

  // The repo changed through the store (the shell, l3's twin in the Prompt,
  // Git…): open files take the new text, new or removed entries redraw the
  // page where it was.
  let again = 0;
  const stop = onChange((c) => {
    if (!work.element.isConnected) { stop(); return; }
    if (c.repo !== repo || !reader || !reader.take(c)) return;
    clearTimeout(again);
    again = window.setTimeout(() => {
      if (!repo) return;
      const top = flow.scrollTop;
      reader = new Reader(repo, flow);
      flow.replaceChildren(reader.directory(''));
      requestAnimationFrame(() => { flow.scrollTop = top; });
    }, 150);
  });

  // What the Remote holds is learnt a moment after: ⊕ counts it once it is.
  const stopSync = onSync(() => { if (!work.element.isConnected) { stopSync(); return; } paintBand(); });
  void store.list().then((repos) => {
    all = repos.map((r) => r.name);
    band = parseBand(getState('band'), all, ctx.repo);
    const asked = pending;
    pending = null;
    // Opened for a repo (from File, Home or a new repo): it goes on the band.
    if (asked !== null && ctx.repo && all.includes(ctx.repo)) { show(ctx.repo, asked); return; }
    const first = ctx.repo && band.includes(ctx.repo) ? ctx.repo : band[0];
    if (first) show(first); else none();
  });
  return [work.element];
}
