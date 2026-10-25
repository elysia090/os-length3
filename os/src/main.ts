import {h} from './ui/dom.ts';
import {setWindowTitle} from './app/tauri.ts';
import {icon} from './ui/icons.ts';
import {placeholder} from './pages/common.ts';
import type {Context} from './pages/context.ts';
import {forge, keptForge, revealNext, showInForge} from './pages/forge/forge.ts';
import {git} from './pages/git/git.ts';
import {currentProfile, home, startEditing} from './pages/home.ts';
import {Me} from './pages/me.ts';
import {newRepo} from './pages/new-repo.ts';
import {remote} from './pages/remote/remote.ts';
import {inboxPage} from './pages/inbox.ts';
import {ServerLayer} from './pages/server/layer.ts';
import {runtime} from './pages/runtime.ts';
import {FileTree} from './pages/tree.ts';
import {begin} from './remote/lifecycle.ts';
import {keepFocus} from './ui/focus.ts';
import {onPlugins, pluginsOpen, setPluginsOpen} from './app/plugins.ts';
import {learnHome} from './remote/inbox.ts';
import {begin as lookForNews, look, marks, news, onNews} from './remote/news.ts';
import {devicePage} from './pages/remote/device-page.ts';
import {checkoutBackPage} from './pages/remote/stripe.ts';
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

const PURPOSE_KEY = 'length3.os.purpose';
const REPO_KEY = 'length3.os.repo';
/** The file last read in Forge, and its repo: where Home says the person left off. */
const FILE_KEY = 'length3.os.file';

const $ = (id: string) => document.getElementById(id)!;
const tabs = new Map<PurposeId, HTMLButtonElement>();
let current: PurposeId = 'home';
/** Whether a page has been drawn yet: before the first, the page holds only what says the scripts did not run. */
let opened = false;
/** The plug's state in the rail, said again whenever the page or the plugin area changes. */
let plugState = () => {};

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* convenience only */ }
}

let openRepo = load(REPO_KEY);
/** The file Forge's center is reading. */
let readingPath: string | null = null;
const ctx: Context = {
  // Server, like File, is laid over the page rather than being one.
  go: (id) => { if (id === 'server') { serverLayer.open(true); return Promise.resolve(); } return select(id); },
  openRepo(name, path = '', write = false, grownFrom, line = 0) {
    if (current === 'forge' && showInForge(name, path, write, line)) return;
    ctx.remember(name);
    revealNext(path, write, line);
    // Pressed on its card or its row (or made from a form, which says so), the repo grows from there into its box in Forge.
    const from = grownFrom?.isConnected ? grownFrom.getBoundingClientRect()
      : pressedOn?.isConnected && performance.now() - pressedAt < 1500 ? pressedOn.getBoundingClientRect() : null;
    pressedOn = null;
    select('forge', !!from && morph(from, () => document.querySelector<HTMLElement>(`.col[data-repo="${CSS.escape(name)}"]:not([hidden]) .file`)));
  },
  remember(name) { openRepo = name; save(REPO_KEY, name); fileTree.mark(name); },
  actOn(repo, path) { void fileTree.actOn(repo, path); },
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
// Server is laid over the page the same way: people one knows, their boards, each board's talk and TODO.
const serverLayer = new ServerLayer(ctx);

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
  // The pointer resting on another place on the rail: File's tree or Server's layer that a rest only brought out
  // (not pressed, nothing written in it) goes, so reading the rail's names never leaves one over the page. Only a
  // rest: the hand crossing the icons on its way from File into the tree must not put the tree away under it.
  button.addEventListener('pointerenter', () => {
    clearTimeout(passing);
    passing = window.setTimeout(() => { if (id !== 'file') fileTree.passedBy(); if (id !== 'server') serverLayer.passedBy(); }, PASSED);
  });
  button.addEventListener('pointerleave', () => clearTimeout(passing));
  if (id === 'file') {
    fileTree.attach(button);
  } else if (id === 'server') {
    serverLayer.attach(button);
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
    // A place in the rail is a link to a page, the one shown marked current; File and Server open over it.
    button.addEventListener('click', () => select(id));
  }
  button.addEventListener('keydown', (event) => {
    const next = stepPurpose(id, event.key);
    if (next === null) return;
    event.preventDefault();
    // Arrows move along the rail; passing File or Server only focuses it. The keyboard stays on the
    // rail, after whatever the page just drawn asks for (New repo's name), until Enter or Tab goes in.
    if (next !== 'file' && next !== 'server' && next !== 'plugin') select(next);
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

/** `quiet`: something else carries the eye (a repo growing into its box), so the page does not come from its side. */
type Panning = Document & {startViewTransition?(update: () => void): {updateCallbackDone: Promise<void>; ready: Promise<void>; finished: Promise<void>}};
/** The pan going now (select). */
let panning: object | null = null;

/**
 * Going along the rail, the camera pans with it (styles.css ::view-transition): the page left goes off the way the rail
 * was gone along as the page come to rises in after it, the rail and the window's edges staying where they are, a
 * floor passed in a lift. Where the browser cannot, or less motion is asked for, the page is drawn in place.
 * Settles once the page is drawn.
 */
function select(id: PurposeId, quiet = false): Promise<void> {
  const order = RAIL.map((p) => p.id);
  const pan = Math.sign(order.indexOf(id) - order.indexOf(current));
  const begin = (document as Panning).startViewTransition;
  if (begin && !quiet && pan && $('page').childElementCount && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const root = document.documentElement, page = $('page');
    // A pan still going (the rail pressed again on the way) gives way: its page is taken as it stands.
    root.classList.remove('arriving');
    root.classList.add('panning');
    letGo(page);
    // Only the page left is taken as a picture. The page come to is itself, coming up after it as one sheet with it,
    // so a press on it lands on what is under the hand as it comes: a picture of it would take no press until it
    // had landed. Its parts stand below the window from the first frame, and set off with the picture together.
    let parts: Animation[] = [];
    const pass = begin.call(document, () => {
      draw(id, quiet, true);
      if (panning !== pass) return;
      root.classList.add('arriving');
      const from = `translateY(${pan * page.getBoundingClientRect().height}px)`;
      parts = [...page.children].map((part) => part.animate([{transform: from}, {transform: 'none'}], {duration: paced(330), easing: LAND}));
      for (const a of parts) a.pause();
    });
    panning = pass;
    void pass.ready.then(() => {
      root.animate([{transform: 'none'}, {transform: `translateY(${-pan * 100}%)`}],
        {duration: paced(330), easing: LAND, fill: 'forwards', pseudoElement: '::view-transition-old(page)'});
      for (const a of parts) a.play();
    }, () => {});
    // Given way to a pan begun since, its page stands where it lands; the marks are the new pan's own.
    const done = () => { for (const a of parts) a.finish(); if (panning !== pass) return; panning = null; root.classList.remove('panning', 'arriving'); };
    pass.finished.then(done, done);
    return pass.updateCallbackDone.catch(() => {});
  }
  draw(id, quiet, false);
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
  const inkWas = where(tabs.get(from)?.getAttribute('aria-current') ? tabs.get(from) : null);
  current = id;
  serverLayer.close();
  for (const [tabId, tab] of tabs) {
    const selected = tabId === id;
    if (tabId !== 'file' && tabId !== 'server' && tabId !== 'plugin') { if (selected) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); }
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

function render() {
  const page = $('page');
  page.classList.toggle('page-work', current === 'forge' || current === 'git');
  page.classList.toggle('page-inbox', current === 'inbox');
  fileTree.mark(current === 'forge' ? openRepo : null);
  fileTree.markFile(current === 'forge' ? openRepo : null, current === 'forge' ? readingPath : null);
  const nodes = current === 'home' ? home(ctx)
    : current === 'forge' ? forge(ctx)
    : current === 'new-repo' ? newRepo(ctx)
    : current === 'runtime' ? runtime(ctx)
    : current === 'git' ? git(ctx)
    : current === 'remote' ? remote(ctx)
    : current === 'inbox' ? inboxPage(ctx)
    : placeholder(current);
  // Forge, once made, stays in the document, hidden while another page shows: a text box taken out
  // of the document loses its Undo, so what was written there can still be taken back on return.
  const kept = keptForge();
  for (const n of [...page.childNodes]) if (n !== kept) n.remove();
  if (kept && kept.parentNode !== page) page.prepend(kept);
  page.append(...nodes.filter((n) => n !== kept));
  if (kept) kept.hidden = current !== 'forge';
  me.paint();
}

const me = new Me(ctx, currentProfile, {editProfile: () => startEditing(ctx)});
$('rail-me').append(me.element);

$('rail-tabs').append(...PURPOSES.map((p) => railButton(p.id)), railButton(NEW_REPO.id));
railOpening();
// The rail's name, in the language the OS starts in (index.html has the English).
document.querySelector('.rail')?.setAttribute('aria-label', t('Purposes'));
// The Remote not answering is said in one place, on the Remote's own: a red dot, and its name says why.
// Something come in and not seen yet is said the same way on Inbox and Server: a dot in the colour
// of the place (ink, or ground on ink when it is current), gone once it is seen.
const railName = (id: PurposeId): string => {
  if (id === 'remote' && remoteAway()) return t('The Remote cannot be reached');
  if (id === 'inbox' && marks(news()).inbox) return t('Inbox has messages not read');
  if (id === 'server' && marks(news()).server) return t('Server has new posts');
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
// would show a moment first.
onConnection(() => { void look(); if (current === 'remote') me.paint(); else if (opened) render(); });
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
  void loadState().finally(() => { useLang(getState('lang')); document.body.replaceChildren(devicePage(asking.get('user_code') ?? '')); });
} else {
  void loadState().finally(async () => {
    useLang(getState('lang'));
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
    if (heldInvite()) serverLayer.open(true);
    // Busy until what the Remote has is taken in and the page drawn from it (the first look).
    void begin().then(() => render()).finally(() => $('page').removeAttribute('aria-busy'));
    // What came in meanwhile, for the rail's marks: now, and every little while.
    lookForNews();
  });
}
window.addEventListener('focus', () => {
  // Not before the first page is drawn (the window comes back focused from a provider before it is chosen).
  void loadState().then(() => { useLang(getState('lang')); if (!opened) return; if (current === 'home') render(); else me.paint(); });
});
// An invitation's link opened in a tab already showing the app (pasted into its address) changes only
// the fragment: it is taken the same way, and Server comes out afresh at its board.
window.addEventListener('hashchange', () => {
  const came = inviteIn(location.hash);
  if (!came) return;
  holdInvite(came.board, came.code);
  history.replaceState(null, '', location.pathname + location.search);
  serverLayer.close();
  serverLayer.open(true);
});
