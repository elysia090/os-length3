import {h} from './ui/dom.ts';
import {setWindowTitle} from './app/tauri.ts';
import {icon} from './ui/icons.ts';
import {placeholder} from './pages/common.ts';
import type {Context} from './pages/context.ts';
import {currentProfile, home, startEditing} from './pages/home.ts';
import {Me} from './pages/me.ts';
import {ServerSwitcher} from './pages/server/switcher.ts';
import {FileTree} from './pages/tree.ts';
import {onRenamed} from './repos/repos.ts';
import {begin} from './remote/lifecycle.ts';
import {keepFocus} from './ui/focus.ts';
import {onPlugins, pluginsOpen, setPluginsOpen} from './app/plugins.ts';
import {learnHome} from './remote/inbox.ts';
import {begin as lookForNews, look, marks, news, onNews} from './remote/news.ts';
import {about, claim, connection, enterWith, holdAsk, justSignedIn, mayAsk, onConnection, onReach, remoteAway, signInFailed} from './remote/connection.ts';
import {cameBackFromStripe, isPaidTier} from './remote/plan.ts';
import {every} from './app/runs.ts';
import {heldInvite, holdInvite, inviteIn} from './remote/servers.ts';
import {getState, loadState} from './home/state.ts';
import {onLang, t, useLang} from './i18n.ts';
import {NEW_REPO, PURPOSES, RAIL, purpose, restorePurpose, stepPurpose, type PurposeId} from './app/purposes.ts';
import {LAND, glide, morph, paced, paneOut, stage, still, where} from './ui/glide.ts';
import {letGo, touch} from './ui/touch.ts';
import {caret} from './ui/caret.ts';
import {optical} from './ui/optical.ts';
import {scrollbars} from './ui/scrollbars.ts';

const PURPOSE_KEY = 'length3.os.purpose';
const REPO_KEY = 'length3.os.repo';
/** The file last read in Forge, and its repo: where Home says the person left off. */
const FILE_KEY = 'length3.os.file';

const $ = (id: string) => document.getElementById(id)!;
const tabs = new Map<PurposeId, HTMLButtonElement>();
let current: PurposeId = 'home';
/** Whether a page has been drawn yet: before the first, the page holds only what says the scripts did not run. */
let opened = false;
/** Who is in (the Remote and the account), as the page was last drawn for them. */
const whoIsIn = () => { const c = connection(); return c ? `${c.url}\n${c.user ?? ''}` : null; };
let wasIn: string | null = null;
/** The plug's state in the rail, said again whenever the page or the plugin area changes. */
let plugState = () => {};

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* convenience only */ }
}

/** A place's page, drawn for the shell. */
type Drawn = (ctx: Context) => Node[];
/** Forge's module once brought: what the shell asks of Forge besides its page (what it keeps, what it shows next). */
let forgeOf: typeof import('./pages/forge/forge.ts') | null = null;
/**
 * Each place's page but Home's, brought when it is first drawn (all of them once Home stands, in the time the page
 * has to spare): the code of the places not shown is no part of what the page must fetch and run before it draws.
 */
const BRING: Partial<Record<PurposeId, () => Promise<Drawn>>> = {
  'forge': () => import('./pages/forge/forge.ts').then((m) => { forgeOf = m; return m.forge; }),
  'git': () => import('./pages/git/git.ts').then((m) => m.git),
  'new-repo': () => import('./pages/new-repo.ts').then((m) => m.newRepo),
  'runtime': () => import('./pages/runtime/runtime.ts').then((m) => m.runtime),
  'remote': () => import('./pages/remote/remote.ts').then((m) => m.remote),
  'inbox': () => import('./pages/inbox.ts').then((m) => m.inboxPage),
  'server': () => import('./pages/server/page.ts').then((m) => (c: Context) => m.serverPage(c, () => { if (current === 'server') render(); })),
};
const pages: Partial<Record<PurposeId, Drawn>> = {home};
const bringing = new Map<PurposeId, Promise<void>>();
/** The place's page being brought, or null once it is here (or the place has none of its own). */
function brought(id: PurposeId): Promise<void> | null {
  const bring = BRING[id];
  if (pages[id] || !bring) return null;
  let p = bringing.get(id);
  if (!p) {
    p = bring().then((drawn) => { pages[id] = drawn; });
    // Not brought (the line went): asked again the next time.
    p.catch(() => bringing.delete(id));
    bringing.set(id, p);
  }
  return p;
}

let openRepo = load(REPO_KEY);
/** The file Forge's center is reading. */
let readingPath: string | null = null;
const ctx: Context = {
  // Server, like File, is laid over the page rather than being one.
  go: (id) => select(id),
  openRepo(name, path = '', write = false, grownFrom, line = 0) {
    const bringing = brought('forge');
    if (bringing) { void bringing.then(() => ctx.openRepo(name, path, write, grownFrom, line)); return; }
    const f = forgeOf!;
    if (current === 'forge' && f.showInForge(name, path, write, line)) return;
    ctx.remember(name);
    f.revealNext(path, write, line);
    // Pressed on its card or its row (or made from a form, which says so), the repo grows from there into its box in Forge.
    const from = grownFrom?.isConnected ? grownFrom.getBoundingClientRect()
      : pressedOn?.isConnected && performance.now() - pressedAt < 1500 ? pressedOn.getBoundingClientRect() : null;
    pressedOn = null;
    select('forge', !!from && morph(from, () => document.querySelector<HTMLElement>(`.col[data-repo="${CSS.escape(name)}"]:not([hidden]) .file`)));
  },
  remember(name) { openRepo = name; save(REPO_KEY, name); fileTree.mark(name); },
  reading(path) { readingPath = path; if (current === 'forge') fileTree.markFile(openRepo, path); },
  leftAt(repo, path, at) { save(FILE_KEY, JSON.stringify({repo, path, at})); },
  get repo() { return openRepo; },
  get leftOff() {
    try {
      const was = JSON.parse(load(FILE_KEY) ?? 'null') as {repo?: unknown; path?: unknown; at?: unknown} | null;
      return was && typeof was.repo === 'string' && typeof was.path === 'string' ? {repo: was.repo, path: was.path, at: typeof was.at === 'number' ? was.at : null} : null;
    } catch { return null; }
  },
  rerender: () => render(),
};

// A repo renamed: the repo worked on and where one left off follow it (each page's own holds follow it there).
onRenamed((from, to) => {
  if (openRepo === from) ctx.remember(to);
  const was = ctx.leftOff;
  if (was?.repo === from) save(FILE_KEY, JSON.stringify({...was, repo: to}));
});

// File lays the tree of "/" over the page; it never replaces the page. A
// file chosen there is the one to work on: the tree goes and the caret is in it.
const fileTree = new FileTree({
  choose: (repo, path, file) => { if (file) fileTree.close(); ctx.openRepo(repo, path, file); },
  current: () => (current === 'forge' ? openRepo : null),
  currentFile: () => (current === 'forge' ? readingPath : null),
});
document.body.append(fileTree.element);
// A control drawn again or held while its deed runs gives the keyboard back, never to the body (focus.ts).
keepFocus();
touch();
caret();
optical();
scrollbars();
// Server glanced at: a rest on its icon brings one's servers out beside the rail, to jump to; a press goes to its page.
const serverSwitch = new ServerSwitcher(ctx);

/** How long the pointer rests on another place on the rail before what a rest on File or Server brought out goes. */
const PASSED = 200;
let passing = 0;

function railButton(id: PurposeId): HTMLButtonElement {
  const p = purpose(id), button = document.createElement('button');
  button.type = 'button';
  button.id = `purpose-${id}`;
  button.className = id === 'new-repo' ? 'rail-item rail-new' : 'rail-item';
  button.setAttribute('aria-label', t(p.label));
  button.append(icon(id), h('span', {class: 'rail-tag', 'aria-hidden': 'true'}, t(p.label)));
  // The pointer resting on another place on the rail: File's tree that a rest only brought out (not pressed), or the
  // servers beside Server, go, so reading the rail's names never leaves one over the page. Only a
  // rest: the hand crossing the icons on its way from File into the tree must not put the tree away under it.
  button.addEventListener('pointerenter', () => {
    clearTimeout(passing);
    passing = window.setTimeout(() => { if (id !== 'file') fileTree.passedBy(); if (id !== 'server') serverSwitch.passedBy(); }, PASSED);
  });
  button.addEventListener('pointerleave', () => clearTimeout(passing));
  if (id === 'file') {
    fileTree.attach(button);
  } else if (id === 'server') {
    serverSwitch.attach(button);
  } else if (id === 'plugin') {
    // The plug opens the plugin area at the top of the center, and closes it; elsewhere it opens it in Forge.
    // It says the area is out only where the area is (Forge's, Git's center): on another page it is kept for
    // coming back, not out. Escape on the plug puts it away, as Escape does File's tree.
    plugState = () => button.setAttribute('aria-expanded', String(pluginsOpen() && (current === 'forge' || current === 'git' || current === 'home')));
    plugState();
    onPlugins(() => plugState());
    button.addEventListener('click', () => {
      // Home, Forge and Git have the right pane the area is at the top of; elsewhere it opens in Forge.
      const work = current === 'forge' || current === 'git' || current === 'home';
      if (!work) select('forge');
      setPluginsOpen(!work || !pluginsOpen());
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') { event.preventDefault(); setPluginsOpen(false); }
    });
  } else {
    // A place in the rail is a link to a page, the one shown marked current; File and Server open over it. Pressed
    // with a mouse it goes as the button goes down, as a browser's tab does: on the click, the page stood still for
    // the press's length (some 80 ms and more) before the pan set off. A touch keeps the click (it may be a scroll).
    let downed = false;
    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      downed = true;
      void select(id);
    });
    button.addEventListener('click', () => { if (downed) { downed = false; return; } void select(id); });
  }
  button.addEventListener('keydown', (event) => {
    const next = stepPurpose(id, event.key);
    if (next === null) return;
    event.preventDefault();
    // Arrows move along the rail; passing File or Server only focuses it. The keyboard stays on the
    // rail, after whatever the page just drawn asks for (New repo's name), until Enter or Tab goes in.
    if (next !== 'file' && next !== 'plugin') select(next);
    tabs.get(next)?.focus();
    queueMicrotask(() => tabs.get(next)?.focus());
  });
  tabs.set(id, button);
  return button;
}

/** What a repo was last opened from (its card, its row in File), to grow from. */
let pressedOn: HTMLElement | null = null;
let pressedAt = 0;
document.addEventListener('pointerdown', (event) => {
  const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('.card.repo, .tree-row');
  if (el) { pressedOn = el; pressedAt = performance.now(); }
}, true);

type Pass = {updateCallbackDone: Promise<void>; ready: Promise<void>; finished: Promise<void>; skipTransition(): void};
type Panning = Document & {startViewTransition?(update: () => void): Pass};

/**
 * The pan going now (select): the page it left (`left`, taken as a picture as it stood at `was`, its floor's top at
 * `top`, still short of its place by `off` if it was itself coming in), the page it brings (`to`, drawn once the
 * picture is taken: `drawn`), which way and how far (`dir`, `by`, the page come to starting `from` there), and the
 * moves of each, set going together once the picture is there (`ready`): `parts`, the page come to's, rising, each part
 * with its cut; `old`, the picture's.
 */
type Pan = {pass: Pass; left: PurposeId; to: PurposeId; dir: number; by: number; from: number; was: DOMRect; top: number; off: number;
  drawn: boolean; ready: boolean; parts: Animation[]; old: Animation[]};
let panning: Pan | null = null;

/** Which way along the rail `to` is from `from`: 1 down, -1 up, 0 the same place. */
const way = (from: PurposeId, to: PurposeId) => { const order = RAIL.map((p) => p.id); return Math.sign(order.indexOf(to) - order.indexOf(from)); };

/** `inset()` cutting a box at `r` to the window from `top` to `foot` and to the sides of `side` (a negative inset
 * reaches past the box). A cut is a thing's own, in its own place, so it goes with it as it moves. */
const cut = (r: DOMRect, top: number, foot: number, side = r) =>
  `inset(${top - r.top}px ${r.right - side.right}px ${r.bottom - foot}px ${side.left - r.left}px)`;

/** How far the page `p` brings still is from its place (null: none of it is on the screen). */
function short(p: Pan): number | null {
  const el = p.parts.map((a) => (a.effect as KeyframeEffect).target).find((t): t is HTMLElement => t instanceof HTMLElement && t.isConnected && !t.hidden);
  return el ? new DOMMatrix(getComputedStyle(el).transform).f : null;
}

/** The page `p` brings, set below the page left going down the rail (above it going up), its parts held there until
 * the picture sets off with them. */
function rise(p: Pan) {
  const page = $('page');
  for (const a of p.parts) a.cancel();
  const now = page.getBoundingClientRect(), top = Math.max(0, now.top);
  // Going down, its top starts at the foot of the floor left; going up, its foot at that floor's top.
  p.by = p.dir > 0 ? innerHeight + p.off - top : innerHeight - p.top;
  p.from = p.dir * p.by;
  const ms = paced(330);
  p.parts = [...page.children].flatMap((part) => {
    // Each part is cut where the window's edges will be on it, the cut its own, so it goes with the part (on the
    // compositor, as the part does: a cut moved frame by frame would lag it under load, and bite into it).
    const r = part.getBoundingClientRect(), edge = cut(r, top, innerHeight, now);
    return [part.animate([{transform: `translateY(${p.from}px)`}, {transform: 'none'}], {duration: ms, easing: LAND}),
      ...r.height ? [part.animate([{clipPath: edge}, {clipPath: edge}], {duration: ms})] : []];
  });
  if (!p.ready) for (const a of p.parts) a.pause();
}

/** The picture of the page left sets off with the page come to, the two as one sheet (set off again, turned, if
 * another place was pressed before they had moved). */
function setOff(p: Pan) {
  const root = document.documentElement, old = '::view-transition-old(page)', ms = paced(330);
  for (const a of p.old) a.cancel();
  // The picture is cut at the window's edges as it was, the cut its own, going with it.
  const edge = cut(p.was, p.top, innerHeight + p.off);
  p.old = [root.animate([{transform: 'none'}, {transform: `translateY(${-p.dir * p.by}px)`}], {duration: ms, easing: LAND, fill: 'forwards', pseudoElement: old}),
    root.animate([{clipPath: edge}, {clipPath: edge}], {duration: ms, fill: 'forwards', pseudoElement: old})];
  for (const a of p.parts) a.play();
}

/** The latest place asked for: a place whose page was still being brought gives way to one asked after it. */
let asked = 0;

/**
 * Going along the rail, the camera pans with it (styles.css ::view-transition): the page left goes off the way the rail
 * was gone along as the page come to rises in after it, the rail and the window's edges staying where they are, a
 * floor passed in a lift. Where the browser cannot, or less motion is asked for, the page is drawn in place.
 * Settles once the page is drawn. `quiet`: something else carries the eye (a repo growing into its box), so the page
 * does not come from its side.
 *
 * Each floor is what the window shows of its page, from its top line (or the window's top, read down) to the window's
 * foot, cut there; the one come to adjoins the one left (under its foot going down the rail, over its top going up),
 * and both go by the same length, the one that brings it to its place. Pages are of their own heights (Home runs past
 * the window, Git's stops short of its foot): a floor as long as its page would run the one over the other, or leave
 * a band of nothing between them.
 *
 * Pressed again on the way (the rail, or its keys held down): before the pan has been seen to move, it goes to the
 * place pressed now instead, from where it began, as if that had been pressed (and pressed back to where it began,
 * it simply stays); once moving, the page it was bringing is taken as it stands, and the next pan sets off from there.
 */
function select(id: PurposeId, quiet = false): Promise<void> {
  const bringing = brought(id), mine = ++asked;
  if (bringing) return bringing.then(() => { if (mine === asked) return select(id, quiet); });
  const p = panning, root = document.documentElement, page = $('page');
  const begin = (document as Panning).startViewTransition;
  const moving = !!begin && !quiet && !!page.childElementCount && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Something else carries the eye now (a repo growing into its box from what was pressed): the pan gives way at once.
  if (p && !moving) { panning = null; for (const a of p.parts) a.cancel(); p.pass.skipTransition(); root.classList.remove('panning', 'arriving'); }
  if (p && moving) {
    if (id === p.to) return p.pass.updateCallbackDone.catch(() => {});
    const off = p.ready ? short(p) : null;
    if (off === null || Math.abs(off - p.from) < 2) return turn(p, id);
  }
  const dir = way(current, id);
  if (!moving || !dir) { draw(id, quiet, false); return Promise.resolve(); }
  // A pan still going gives way: its page is taken as it stands, held where it is in the frame the picture is taken
  // in (a page still moving as it is taken can keep the picture from being taken for seconds), and the next adjoins it.
  if (p) requestAnimationFrame(() => { for (const a of p.parts) a.pause(); });
  root.classList.remove('arriving');
  root.classList.add('panning');
  letGo(page);
  const was = page.getBoundingClientRect();
  // Only the page left is taken as a picture. The page come to is itself, coming up after it as one sheet with it,
  // so a press on it lands on what is under the hand as it comes: a picture of it would take no press until it
  // had landed. Its parts stand below the window from the first frame, and set off with the picture together.
  const q: Pan = {pass: null!, left: current, to: id, dir, by: 0, from: 0, was, top: Math.max(0, was.top), off: 0, drawn: false, ready: false, parts: [], old: []};
  q.pass = begin!.call(document, () => {
    if (panning !== q) return;
    if (p) {
      // Where it stood as it was taken.
      q.off = short(p) ?? 0;
      q.top += q.off;
      for (const a of p.parts) a.cancel();
    }
    draw(q.to, false, true);
    q.drawn = true;
    // Turned back to the page it left before that was drawn: it stays, as it was.
    if (!q.dir) { q.pass.skipTransition(); return; }
    root.classList.add('arriving');
    rise(q);
  });
  panning = q;
  void q.pass.ready.then(() => { q.ready = true; if (panning === q) setOff(q); }, () => {});
  // Given way to a pan begun since, what it brought is taken as it stands; the marks are the new pan's own.
  const done = () => {
    for (const a of q.old) a.cancel();
    if (panning !== q) return;
    for (const a of q.parts) a.finish();
    panning = null;
    root.classList.remove('panning', 'arriving');
  };
  q.pass.finished.then(done, done);
  return q.pass.updateCallbackDone.catch(() => {});
}

/** Another place pressed before the pan `p` was seen to move: it goes there instead, from the page it left. */
function turn(p: Pan, id: PurposeId): Promise<void> {
  p.to = id;
  p.dir = way(p.left, id);
  // Not drawn yet: it is drawn as the place pressed now, from its side.
  if (!p.drawn) return p.pass.updateCallbackDone.catch(() => {});
  draw(id, false, true);
  // Back to the page it left: there it is, as it was.
  if (!p.dir) { for (const a of p.parts) a.cancel(); p.pass.skipTransition(); return Promise.resolve(); }
  rise(p);
  if (p.ready) setOff(p);
  return Promise.resolve();
}

/** How far down each page was read, as it was left (pages that scroll the window: Home, Runtime, Remote, Inbox). */
const readTo = new Map<PurposeId, number>();

/**
 * Come back to, a page is where it was read to. Still coming in (its lists drawn once they are read), it is put there
 * once it is that long, unless the hand scrolls first; one that went to a place asked for keeps that place.
 */
function readAgain(id: PurposeId) {
  const at = readTo.get(id) ?? 0, doc = document.scrollingElement;
  if (!at || !doc || doc.scrollTop) return;
  doc.scrollTop = at;
  if (doc.scrollTop >= at - 1) return;
  const grows = new ResizeObserver(() => { if (current !== id) stop(); else { doc.scrollTop = at; if (doc.scrollTop >= at - 1) stop(); } });
  const stop = () => { grows.disconnect(); clearTimeout(late); for (const e of ['wheel', 'touchmove', 'keydown', 'pointerdown']) removeEventListener(e, stop, true); };
  const late = window.setTimeout(stop, 1500);
  for (const e of ['wheel', 'touchmove', 'keydown', 'pointerdown']) addEventListener(e, stop, {capture: true, passive: true});
  grows.observe($('page'));
}

function draw(id: PurposeId, quiet: boolean, panned: boolean) {
  const from = current;
  // The page left keeps where it was read to; the one come to starts at its top, never where the last was read to.
  const doc = document.scrollingElement;
  if (opened && from !== id && doc) { readTo.set(from, doc.scrollTop); doc.scrollTop = 0; }
  // The first page the OS opens on: nothing drawn before it.
  const first = !opened;
  opened = true;
  // Who is in, as the first page is drawn for them (onConnection draws it again only for another).
  if (first) wasIn = whoIsIn();
  // Where the ink is: the page's own place, or the one whose tree, servers or area is out over it.
  const inkWas = where(inked(expanded()));
  current = id;
  serverSwitch.close();
  for (const [tabId, tab] of tabs) {
    const selected = tabId === id;
    if (tabId !== 'file' && tabId !== 'plugin') { if (selected) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); }
    tab.tabIndex = selected ? 0 : -1;
  }
  $('page').setAttribute('aria-labelledby', `purpose-${id}`);
  named();
  render();
  if (from !== id) readAgain(id);
  plugState();
  if (id !== 'new-repo') save(PURPOSE_KEY, id);
  // The first page comes in as any page come to does, its parts a beat apart, rising from below as the OS opens.
  if (first && !quiet) { pageOpening(); stage($('page'), 1); return; }
  if (from !== id) {
    // The rail's ink goes from the place left to the place come to, and the page comes from that side of the rail.
    glide(inkWas, tabs.get(id)?.getAttribute('aria-current') ? tabs.get(id)! : null, $('rail-tabs'), 'var(--r-place)');
    const order = RAIL.map((p) => p.id);
    // Panned, the page comes as one, carried by the camera: its parts staged on top of that would leave it standing
    // half empty as it lands. Not panned, its parts come in a beat apart, heading first, from that side (glide.ts stage).
    if (!quiet && !panned) {
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) $('page').animate([{opacity: 0}, {opacity: 1}], {duration: paced(160), easing: 'ease-out'});
      stage($('page'), Math.sign(order.indexOf(id) - order.indexOf(from)));
    }
  }
}

/**
 * The OS opening, once, from its first frame: the frame's line is drawn down the rail's edge from the top (styles.css
 * .opening) as the rail's places come in one after another down it, each from the window's edge, the person last at
 * its foot; the first page comes up after them (pageOpening).
 */
function railOpening() {
  const root = document.documentElement, rail = $('rail-tabs').parentElement!;
  if (still()) { root.classList.remove('opening'); return; }
  const drawn = (e: AnimationEvent) => { if (e.pseudoElement === '::after') { root.classList.remove('opening'); rail.removeEventListener('animationend', drawn); } };
  rail.addEventListener('animationend', drawn);
  [...$('rail-tabs').children, ...$('rail-me').children].forEach((el, i) => el.animate([{opacity: 0, translate: '-14px 0'}, {opacity: 1, translate: '0 0'}],
    {duration: paced(380), delay: paced(60 + i * 34), easing: LAND, fill: 'backwards'}));
}

/** The first page, as the OS opens: its parts a beat apart (stage), its right pane's words from the right as when it
 * is brought out, nothing of it there before its turn. */
function pageOpening() {
  if (still()) return;
  const page = $('page');
  page.animate([{opacity: 0}, {opacity: 1}], {duration: paced(280), delay: paced(120), easing: 'ease-out', fill: 'backwards'});
  const side = page.querySelector<HTMLElement>('.home-side, .side'), toggle = page.querySelector<HTMLElement>('.pane-toggle');
  if (side?.getClientRects().length && toggle) paneOut(side, toggle);
}

/** The page's name where the host lists it (a tab, history, the window list): the place, then the OS. */
const named = () => {
  document.title = `${t(purpose(current).label)} · Length³ OS`;
  // The app's window is named the same in the host's window list (a browser's tab already is); not renamed, it keeps the OS's name.
  void setWindowTitle(document.title).catch(() => {});
};

/** Asked to draw while its page is still being brought: drawn once it is here. */
let toDraw = false;

function render() {
  const bringing = brought(current);
  if (bringing) {
    if (!toDraw) void bringing.then(() => { toDraw = false; render(); });
    toDraw = true;
    return;
  }
  const page = $('page');
  page.classList.toggle('page-work', current === 'forge' || current === 'git' || current === 'server');
  page.dataset.place = current;
  page.classList.toggle('page-inbox', current === 'inbox');
  fileTree.mark(current === 'forge' ? openRepo : null);
  fileTree.markFile(current === 'forge' ? openRepo : null, current === 'forge' ? readingPath : null);
  const drawn = pages[current];
  const nodes = drawn ? drawn(ctx) : placeholder(current);
  // Forge, once made, stays in the document, hidden while another page shows: a text box taken out
  // of the document loses its Undo, so what was written there can still be taken back on return.
  const kept = forgeOf?.keptForge() ?? null;
  for (const n of [...page.childNodes]) if (n !== kept) n.remove();
  if (kept && kept.parentNode !== page) page.prepend(kept);
  page.append(...nodes.filter((n) => n !== kept));
  if (kept) kept.hidden = current !== 'forge';
  me.paint();
}

const me = new Me(ctx, currentProfile, {editProfile: () => startEditing(ctx)});
$('rail-me').append(me.element);

$('rail-tabs').append(...PURPOSES.map((p) => railButton(p.id)), railButton(NEW_REPO.id));
// Where the window is short the places scroll in a box of their own (rail.css), whose edge would cut a place's name
// off: there the name stands in the window, beside the place under the pointer or the keyboard, which says where.
const tagAt = (e: Event) => {
  const b = e.target instanceof Element ? e.target.closest<HTMLElement>('.rail-item') : null;
  if (!b) return;
  const r = b.getBoundingClientRect();
  b.style.setProperty('--tag-x', `${r.right}px`);
  b.style.setProperty('--tag-y', `${r.top + r.height / 2}px`);
};
$('rail-tabs').addEventListener('pointerover', tagAt);
$('rail-tabs').addEventListener('focusin', tagAt);
/** The rail's places out over the page now (File's tree, Server's servers beside the rail, the plug's area). */
const expanded = () => new Set<HTMLElement>([...tabs.values()].filter((b) => b.getAttribute('aria-expanded') === 'true'));
/** The one place the rail's ink is on: the one out over the page, else the page's own; none while two are out (each
 * is inked). */
function inked(out: Set<HTMLElement>): HTMLElement | null {
  if (out.size > 1) return null;
  const [one] = out;
  return one ?? [...tabs.values()].find((b) => b.getAttribute('aria-current')) ?? null;
}
// File's tree, Server's servers or the plug's area out or away: the ink goes from where it was to where it is, as it
// does between pages, rather than one fading out as the other fills (the page's icon, its fill fading, would be ink
// on ink a moment).
new MutationObserver((records) => {
  const now = expanded(), before = new Set(now), seen = new Set<Node>();
  for (const r of records) {
    if (seen.has(r.target)) continue;
    seen.add(r.target);
    if (r.oldValue === 'true') before.add(r.target as HTMLElement); else before.delete(r.target as HTMLElement);
  }
  const from = inked(before), to = inked(now);
  if (from && to && from !== to) glide(from.getBoundingClientRect(), to, $('rail-tabs'), 'var(--r-place)');
}).observe($('rail-tabs'), {subtree: true, attributes: true, attributeFilter: ['aria-expanded'], attributeOldValue: true});
railOpening();
// The rail's name, in the language the OS starts in (index.html has the English).
document.querySelector('.rail')?.setAttribute('aria-label', t('Purposes'));
// The Remote not answering is said in one place, on the Remote's own: a red dot, and its name says why.
// Something come in and not seen yet is said the same way on Inbox and Server: a dot in the colour
// of the place (ink, or ground on ink when it is current), gone once it is seen.
const railName = (id: PurposeId): string => {
  if (id === 'remote' && remoteAway()) return t('Cannot connect to Remote');
  if (id === 'inbox' && marks(news()).inbox) return t('Unread messages in Inbox');
  if (id === 'server' && marks(news()).server) return t('New posts in server');
  return t(purpose(id).label);
};
const mark = (id: PurposeId) => {
  const b = tabs.get(id);
  if (!b) return;
  b.classList.toggle('away', id === 'remote' && remoteAway());
  b.classList.toggle('news', (id === 'inbox' && marks(news()).inbox) || (id === 'server' && marks(news()).server));
  const label = railName(id);
  b.setAttribute('aria-label', label);
  const tag = b.querySelector('.rail-tag');
  if (tag) tag.textContent = label;
};
const reach = () => mark('remote');
onNews(() => { mark('inbox'); mark('server'); });
let askAgain: {stop(): void} | null = null;
onReach(() => {
  reach();
  // Signed in, sync's own looking finds the Remote again; signed out, nothing asks, so this does: in view, less often
  // each time it is still away (remote.ts mayAsk), and slower while nobody is at it.
  askAgain?.stop();
  askAgain = remoteAway() && !connection() ? every(15_000, () => (mayAsk() ? about() : undefined), {paced: true}) : null;
});
// Signed in or out, here or from another device: the page is drawn again for who is here now (Remote's draws itself).
// Not before the first page is: back from a provider, the session is taken up before Remote is chosen, and Home
// would show a moment first. A passkey that confirms a deed signs the same account in again: nothing is drawn again
// for it, so the deed's ask (a repo's gear asking for the code) stays where it is.
onConnection(() => {
  void look();
  const now = whoIsIn(), same = now !== null && now === wasIn && !!connection()?.user;
  wasIn = now;
  if (current === 'remote') me.paint(); else if (opened && !same) render();
});
// Changing the language redraws the page and the rail's names in place.
onLang(() => {
  for (const id of tabs.keys()) mark(id);
  document.querySelector('.rail')?.setAttribute('aria-label', t('Purposes'));
  named();
  // The language taken up as the OS starts comes before its first page, which is drawn in it once chosen.
  if (opened) render();
});
// Home's state is read before the first page, and again when the window
// comes back, so what l3 changed meanwhile is what the page shows.
// Then what the Remote has is taken in; the page shows as it comes.
// A device's code (?device&user_code=…, from l3 or the app) opens only the page that approves it.
const asking = new URLSearchParams(location.search);
// A link for research (…/#enter=KEY): the key is taken out of the address before anything else runs,
// so it is not left in the history, a bookmark or a screenshot, and is sent once (remote.ts enterWith).
const entering = /(?:^#|&)enter=([^&]+)/.exec(location.hash)?.[1];
// An invitation to write in a board as a guest (…/#guest=BOARD.INVITE), handed on by one of its people:
// taken out of the address the same way, held for this tab until it is used, and its board shown.
const invitation = inviteIn(location.hash);
if (invitation) holdInvite(invitation.board, invitation.code);
if (entering || invitation) history.replaceState(null, '', location.pathname + location.search);
if (asking.has('device')) {
  void loadState().finally(async () => {
    await useLang(getState('lang'));
    const {devicePage} = await import('./pages/remote/device-page.ts');
    document.body.replaceChildren(devicePage(asking.get('user_code') ?? ''));
  });
} else {
  void loadState().finally(async () => {
    await useLang(getState('lang'));
    if (entering) await enterWith(decodeURIComponent(entering));
    // Back from a provider: take up the session it made, then go on where the person began (the page they signed
    // in from is the one kept; Remote's page offers a passkey next, and a tier chosen signed out goes on to Checkout).
    if (asking.has('signed-in')) {
      if (await claim()) justSignedIn();
      const u = new URL(location.href);
      u.searchParams.delete('signed-in');
      history.replaceState(null, '', u);
    }
    // Back from a provider without a session (cancelled there, refused, or run out): the card they began on says why.
    if (asking.has('sign-in-failed')) {
      signInFailed(asking.get('error'));
      const u = new URL(location.href);
      for (const k of ['sign-in-failed', 'error', 'error_description']) u.searchParams.delete(k);
      history.replaceState(null, '', u);
      // Said on a sign-in card: Inbox's or Remote's, whichever it began on; Remote's if neither is kept.
      if (load(PURPOSE_KEY) !== 'inbox') save(PURPOSE_KEY, 'remote');
    }
    // Back from Stripe: Remote's Plan says how it went (paid, and to what; cancelled with nothing charged; what
    // changed in the portal). In a browser not signed in here (the app sent it to pay), a page that says so, and
    // to go back to the app.
    const how = asking.get('plan');
    if (how === 'paid' || how === 'cancelled' || how === 'managed') {
      const tier = asking.get('tier');
      const u = new URL(location.href);
      for (const k of ['plan', 'tier']) u.searchParams.delete(k);
      history.replaceState(null, '', u);
      if (!connection()) {
        const {checkoutBackPage} = await import('./pages/remote/stripe.ts');
        await new Promise<void>((goOn) => document.body.replaceChildren(checkoutBackPage(how, isPaidTier(tier) ? tier : null, goOn)));
        location.reload();
        return;
      }
      cameBackFromStripe(how, tier);
      save(PURPOSE_KEY, 'remote');
      try { localStorage.setItem('length3.part.remote', 'plan'); } catch { /* the part kept, then */ }
    }
    // Opened by the app at what only the browser does (a passkey's deeds, a provider's): Remote's page, at the part
    // that does it; a repo's ask opens at its card once the repos are drawn (signed in first, if this browser is not).
    const asked = holdAsk(asking.get('account'), asking.get('repo'));
    if (asked) {
      const u = new URL(location.href);
      for (const k of ['account', 'repo']) u.searchParams.delete(k);
      history.replaceState(null, '', u);
      save(PURPOSE_KEY, 'remote');
      try { localStorage.setItem('length3.part.remote', asked === 'sign-in' ? 'sign-in' : 'repos'); } catch { /* the part kept, then */ }
    }
    // Which domain is this Remote's, so a name on it is shown alone (`ren`), not as a domain's.
    void learnHome();
    select(restorePurpose(load(PURPOSE_KEY)));
    if (heldInvite()) void select('server');
    // Busy until what the Remote has is taken in and the page drawn from it (the first look). Signed out, that look
    // reads the repos' names alone, and what shows where a repo stands follows it (onSync): the page drawn as the OS
    // opened is the page, not drawn whole a second time.
    void begin().then(() => brought(current)).then(() => { if (connection()) render(); }).finally(() => {
      $('page').removeAttribute('aria-busy');
      // The other places' pages, brought while the person reads the first: a place pressed later is drawn at once.
      const rest = () => { for (const id of Object.keys(BRING) as PurposeId[]) void brought(id)?.catch(() => {}); };
      if ('requestIdleCallback' in window) requestIdleCallback(rest, {timeout: 3000}); else setTimeout(rest, 1000);
    });
    // What came in meanwhile, for the rail's marks: now, and every little while.
    lookForNews();
  });
}
window.addEventListener('focus', () => {
  // Not before the first page is drawn (the window comes back focused from a provider before it is chosen).
  void loadState().then(() => { void useLang(getState('lang')); if (!opened) return; if (current === 'home') render(); else me.paint(); });
});
// An invitation's link opened in a tab already showing the app (pasted into its address) changes only
// the fragment: it is taken the same way, and Server's page opens afresh at its board.
window.addEventListener('hashchange', () => {
  const came = inviteIn(location.hash);
  if (!came) return;
  holdInvite(came.board, came.code);
  history.replaceState(null, '', location.pathname + location.search);
  serverSwitch.close();
  if (current === 'server') render(); else void select('server');
});
