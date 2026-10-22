import {h} from './dom.ts';
import {isNative} from './host.ts';
import {icon} from './icons.ts';
import {placeholder} from './pages/common.ts';
import type {Context} from './pages/context.ts';
import {forge, keptForge, revealNext, showInForge} from './pages/forge.ts';
import {git} from './pages/git.ts';
import {currentProfile, home, startEditing} from './pages/home.ts';
import {Me} from './pages/me.ts';
import {newRepo} from './pages/new-repo.ts';
import {remote} from './pages/remote.ts';
import {inboxPage} from './pages/inbox.ts';
import {ServerLayer} from './pages/server-layer.ts';
import {runtime} from './pages/runtime.ts';
import {FileTree} from './pages/tree.ts';
import {begin} from './lifecycle.ts';
import {keepFocus} from './focus.ts';
import {onPlugins, pluginsOpen, setPluginsOpen} from './plugins.ts';
import {learnHome} from './inbox.ts';
import {begin as lookForNews, look, marks, news, onNews} from './news.ts';
import {devicePage} from './pages/device.ts';
import {about, claim, connection, enterWith, onConnection, onReach, remoteAway} from './remote.ts';
import {heldInvite, holdInvite, inviteIn} from './servers.ts';
import {getState, loadState} from './state.ts';
import {onLang, t, useLang} from './i18n.ts';
import {NEW_REPO, PURPOSES, purpose, restorePurpose, stepPurpose, type PurposeId} from './purposes.ts';

const PURPOSE_KEY = 'length3.os.purpose';
const REPO_KEY = 'length3.os.repo';

const $ = (id: string) => document.getElementById(id)!;
const tabs = new Map<PurposeId, HTMLButtonElement>();
let current: PurposeId = 'home';

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
  go: (id) => (id === 'server' ? serverLayer.open(true) : select(id)),
  openRepo(name, path = '', write = false) {
    if (current === 'forge' && showInForge(name, path, write)) return;
    ctx.remember(name);
    revealNext(path, write);
    select('forge');
  },
  remember(name) { openRepo = name; save(REPO_KEY, name); fileTree.mark(name); },
  reading(path) { readingPath = path; if (current === 'forge') fileTree.markFile(openRepo, path); },
  get repo() { return openRepo; },
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
// Server is laid over the page the same way: people one knows, their boards, each board's talk and TODO.
const serverLayer = new ServerLayer(ctx);

function railButton(id: PurposeId): HTMLButtonElement {
  const p = purpose(id), button = document.createElement('button');
  button.type = 'button';
  button.id = `purpose-${id}`;
  button.className = id === 'new-repo' ? 'rail-item rail-new' : 'rail-item';
  button.setAttribute('aria-label', t(p.label));
  button.append(icon(id), h('span', {class: 'rail-tag', 'aria-hidden': 'true'}, t(p.label)));
  if (id === 'file') {
    fileTree.attach(button);
  } else if (id === 'server') {
    serverLayer.attach(button);
  } else if (id === 'plugin') {
    // The plug opens the plugin area at the top of the center, and closes it; elsewhere it opens it in Forge.
    button.setAttribute('aria-expanded', 'false');
    onPlugins(() => button.setAttribute('aria-expanded', String(pluginsOpen())));
    button.addEventListener('click', () => {
      const work = current === 'forge' || current === 'git';
      if (!work) select('forge');
      setPluginsOpen(!work || !pluginsOpen());
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

function select(id: PurposeId) {
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
  if (id !== 'new-repo') save(PURPOSE_KEY, id);
}

/** The page's name where the host lists it (a tab, history, the window list): the place, then the OS. */
const named = () => {
  document.title = `${t(purpose(current).label)} · Length³ OS`;
  // The app's window is named the same in the host's window list; not renamed, it keeps the OS's name.
  if (isNative) void import('@tauri-apps/api/window').then(({getCurrentWindow}) => getCurrentWindow().setTitle(document.title)).catch(() => {});
};

function render() {
  const page = $('page');
  page.classList.toggle('page-work', current === 'forge' || current === 'git');
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
let askAgain = 0;
onReach(() => {
  reach();
  // Signed in, sync's own looking finds the Remote again; signed out, nothing asks, so this does.
  clearInterval(askAgain);
  if (remoteAway() && !connection()) askAgain = window.setInterval(() => void about(), 15000);
});
// Signed in or out, here or from another device: the page is drawn again for who is here now (Remote's draws itself).
onConnection(() => { void look(); if (current === 'remote') me.paint(); else render(); });
// Changing the language redraws the page and the rail's names in place.
onLang(() => {
  for (const id of tabs.keys()) mark(id);
  document.querySelector('.rail')?.setAttribute('aria-label', t('Purposes'));
  named();
  render();
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
    // Back from a provider: take up the session it made, then go on as usual.
    if (asking.has('signed-in')) {
      await claim();
      const u = new URL(location.href);
      u.searchParams.delete('signed-in');
      history.replaceState(null, '', u);
      save(PURPOSE_KEY, 'remote');
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
  void loadState().then(() => { useLang(getState('lang')); if (current === 'home') render(); else me.paint(); });
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
