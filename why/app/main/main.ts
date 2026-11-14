import {activateOnPress} from '../ui/press.ts';
import {h} from '../ui/dom.ts';
import {setWindowTitle} from '../host/tauri.ts';
import {icon} from '../ui/icons.ts';
import {placeholder} from '../pages/kit/common.ts';
import type {Context, Writing} from '../pages/kit/context.ts';
import {currentProfile, home, startEditing} from '../pages/home/home.ts';
import {Me} from '../pages/me/me.ts';
import {ServerSwitcher} from '../pages/server/switcher.ts';
import {FileTree} from '../pages/file/tree.ts';
import {onRenamed} from '../repos/repos.ts';
import {begin} from '../remote/lifecycle.ts';
import {writeLeftBack} from '../pages/bench/repo-copy.ts';
import {forgetExcept} from '../prompt/webroot-fetch.ts';
import {keepFocus} from '../ui/focus.ts';
import {onPlugins, pluginsOpen, setPluginsOpen} from '../host/plugins.ts';
import {learnHome} from '../remote/inbox.ts';
import {begin as lookForNews, look, marks, news, onNews} from '../remote/news.ts';
import {about, claim, connection, enterWith, holdAsk, justSignedIn, mayAsk, onConnection, onReach, remoteAway, signInFailed} from '../remote/connection.ts';
import {cameBackFromStripe, isPaidTier} from '../remote/plan.ts';
import {every} from '../host/runs.ts';
import {heldInvite, holdInvite, inviteIn, openBoards} from '../remote/servers.ts';
import {getState, loadState, onState} from '../home/state.ts';
import {inEffect} from '../home/dotfiles.ts';
import {NAME as LOOK, wear} from '../ui/look.ts';
import {onLang, t, useLang} from '../i18n/i18n.ts';
import {NEW_REPO, PURPOSES, RAIL, purpose, restorePurpose, stepPurpose, type PurposeId} from '../host/purposes.ts';
import {glide, morph, stage, stopStage, travel, where, type Carry} from '../ui/glide.ts';
import {letGo, touch} from '../ui/touch.ts';
import {prime} from '../ui/keys.ts';
import {caret} from '../ui/caret.ts';
import {optical} from '../ui/optical.ts';
import {scrollbars} from '../ui/scrollbars.ts';

const PURPOSE_KEY = 'why.os.purpose';
const REPO_KEY = 'why.os.repo';
/** The file last read in Forge, and its repo: where Home says the person left off. */
const FILE_KEY = 'why.os.file';

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
let forgeOf: typeof import('../pages/forge/forge.ts') | null = null;
/**
 * Each place's page but Home's, brought when it is first drawn (all of them once Home stands, in the time the page
 * has to spare): the code of the places not shown is no part of what the page must fetch and run before it draws.
 */
const BRING: Partial<Record<PurposeId, () => Promise<Drawn>>> = {
  'forge': () => import('../pages/forge/forge.ts').then((m) => { forgeOf = m; return m.forge; }),
  'git': () => import('../pages/git/git.ts').then((m) => m.git),
  'new-repo': () => import('../pages/new-repo/new-repo.ts').then((m) => m.newRepo),
  'runtime': () => import('../pages/runtime/runtime.ts').then((m) => m.runtime),
  'remote': () => import('../pages/remote/remote.ts').then((m) => m.remote),
  'inbox': () => import('../pages/inbox/inbox.ts').then((m) => m.inboxPage),
  'server': () => import('../pages/server/page.ts').then((m) => (c: Context) => m.serverPage(c, () => { if (current === 'server') render(); })),
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
/**
 * `name` opened in Forge (see Context.openRepo), `keyboard` where the keyboard was when it was asked: read then, not
 * once Forge's code has come, so a keyboard put elsewhere meanwhile is not taken back (forge.ts revealNext).
 */
function openRepoFrom(keyboard: Element | null, name: string, path: string, write: Writing, grownFrom: Element | undefined, line: number, carried: Carry | undefined) {
  const bringing = brought('forge');
  if (bringing) { void bringing.then(() => openRepoFrom(keyboard, name, path, write, grownFrom, line, carried)); return; }
  const f = forgeOf!;
  if (current === 'forge' && f.showInForge(name, path, write, line)) return;
  ctx.remember(name);
  f.revealNext(path, write, line, keyboard);
  // Pressed on its card or its row (or made from a form, which says so), the repo grows from there into its box in Forge.
  const from = grownFrom?.isConnected ? grownFrom.getBoundingClientRect()
    : pressedOn?.isConnected && performance.now() - pressedAt < 1500 ? pressedOn.getBoundingClientRect() : null;
  pressedOn = null;
  select('forge', !!from && morph(from, () => document.querySelector<HTMLElement>(`.col[data-repo="${CSS.escape(name)}"]:not([hidden]) .file`),
    340, '', 40, grownFrom?.isConnected ? carried : undefined));
}

const ctx: Context = {
  // Server, like File, is laid over the page rather than being one.
  go: (id) => select(id),
  openRepo(name, path = '', write = false, grownFrom, line = 0, carried) { openRepoFrom(document.activeElement, name, path, write, grownFrom, line, carried); },
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
// The look as the person at this device has changed it (their .everyday, of the dotfiles taken here: ui/look.ts): worn
// once what Home keeps is read, and again whenever the dotfiles move. With none, the page is as its sheets have it.
const worn = () => { wear(inEffect()[LOOK]); };
onState((key) => { if (key === 'dotfiles' || key === 'trusted') worn(); });
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
    // Signed out, what its page shows first is asked as the pointer comes onto it, a moment before the press: the
    // page drawn takes that answer (servers.ts), not waiting on one of its own.
    button.addEventListener('pointerenter', () => { if (!connection()) void openBoards().catch(() => {}); });
  } else if (id === 'plugin') {
    // The plug opens the plugin area, and closes it, where there is one: over what waits on Home, at the top of Git's
    // pane; elsewhere (Forge is all desk, and has none) it opens it on Home. It says the area is out only where the
    // area is: on another page it is kept for coming back, not out. Escape on the plug puts it away, as Escape does
    // File's tree.
    plugState = () => button.setAttribute('aria-expanded', String(pluginsOpen() && (current === 'git' || current === 'home')));
    plugState();
    onPlugins(() => plugState());
    button.addEventListener('click', () => {
      const there = current === 'git' || current === 'home';
      if (!there) select('home');
      setPluginsOpen(!there || !pluginsOpen());
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') { event.preventDefault(); setPluginsOpen(false); }
    });
  } else {
    // A place in the rail is a link to a page, the one shown marked current; File and Server open over it. Pressed
    // with a mouse it goes as the button goes down, as a browser's tab does: on the click, the page stood still for
    // the press's length (some 80 ms and more) before the pan set off. A touch keeps the click (it may be a scroll).
    activateOnPress(button, () => { void select(id); });
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

/** Newer navigation supersedes unresolved loading; animation never delays the destination or input. */
let asked = 0;
function select(id: PurposeId, quiet = false): Promise<void> {
  const bringing = brought(id), mine = ++asked;
  if (bringing) return bringing.then(() => { if (mine === asked) return select(id, quiet); });
  letGo($('page'));
  stopStage($('page'));
  draw(id, quiet);
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

function draw(id: PurposeId, quiet: boolean) {
  const from = current;
  // To another place: the world goes up or down to it, the way it lies along the rail (the place left kept in sight
  // as it was, from before anything of it changes).
  const order = RAIL.map((p) => p.id);
  const arrived = opened && !quiet && from !== id ? travel($('page'), Math.sign(order.indexOf(id) - order.indexOf(from)) || 1) : null;
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
  // The first content surface arrives without delaying the frame or staggering its data.
  if (first && !quiet) { stage($('page'), 1); return; }
  if (from !== id) {
    // The rail's ink goes from the place left to the place come to, and the page comes from that side of the rail.
    glide(inkWas, tabs.get(id)?.getAttribute('aria-current') ? tabs.get(id)! : null, $('rail-tabs'), 'var(--r-place)', 220);
    arrived?.();
  }
}

/** The frame is immediately available at startup; only the content surface arrives. */
function railOpening() { document.documentElement.classList.remove('opening'); }

/** The page's name where the host lists it (a tab, history, the window list): the place, then the OS. */
const named = () => {
  document.title = `${t(purpose(current).label)} · why*`;
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
  if (from && to && from !== to) glide(from.getBoundingClientRect(), to, $('rail-tabs'), 'var(--r-place)', 220);
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
// comes back, so what why changed meanwhile is what the page shows.
// Then what the Remote has is taken in; the page shows as it comes.
// A device's code (?device&user_code=…, from why or the app) opens only the page that approves it.
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
    const {devicePage} = await import('../pages/remote/device-page.ts');
    document.body.replaceChildren(devicePage(asking.get('user_code') ?? ''));
  });
} else {
  void loadState().finally(async () => {
    await useLang(getState('lang'));
    worn();
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
        const {checkoutBackPage} = await import('../pages/remote/stripe.ts');
        await new Promise<void>((goOn) => document.body.replaceChildren(checkoutBackPage(how, isPaidTier(tier) ? tier : null, goOn)));
        location.reload();
        return;
      }
      cameBackFromStripe(how, tier);
      save(PURPOSE_KEY, 'remote');
      try { localStorage.setItem('why.part.remote', 'plan'); } catch { /* the part kept, then */ }
    }
    // Opened by the app at what only the browser does (a passkey's deeds, a provider's): Remote's page, at the part
    // that does it; a repo's ask opens at its card once the repos are drawn (signed in first, if this browser is not).
    const asked = holdAsk(asking.get('account'), asking.get('repo'));
    if (asked) {
      const u = new URL(location.href);
      for (const k of ['account', 'repo']) u.searchParams.delete(k);
      history.replaceState(null, '', u);
      save(PURPOSE_KEY, 'remote');
      try { localStorage.setItem('why.part.remote', asked === 'sign-in' ? 'sign-in' : 'repos'); } catch { /* the part kept, then */ }
    }
    // Which domain is this Remote's, so a name on it is shown alone (`ren`), not as a domain's.
    void learnHome();
    select(restorePurpose(load(PURPOSE_KEY)));
    if (heldInvite()) void select('server');
    // Busy until what the Remote has is taken in and the page drawn from it (the first look). Signed out, that look
    // reads the repos' names alone, and what shows where a repo stands follows it (onSync): the page drawn as the OS
    // opened is the page, not drawn whole a second time.
    // What an earlier build kept of why goes; why now keeps its own copies, by digest, and lets them go itself (userland.ts).
    void forgetExcept(new Set());
    // What the shell of a page reloaded mid-write left to write back, written before the repos are read (repo-copy.ts).
    void writeLeftBack().then(() => begin()).then(() => brought(current)).then(() => { if (connection()) render(); }).finally(() => {
      $('page').removeAttribute('aria-busy');
      // The other places' pages, brought while the person reads the first: a place pressed later is drawn at once.
      // (And the key sounds, fetched and decoded before the first of them is asked for: keys.ts.)
      const rest = () => { prime(); for (const id of Object.keys(BRING) as PurposeId[]) void brought(id)?.catch(() => {}); };
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
