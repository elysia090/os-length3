import {h} from './dom.ts';
import {icon} from './icons.ts';
import {placeholder} from './pages/common.ts';
import type {Context} from './pages/context.ts';
import {forge, revealNext, showInForge} from './pages/forge.ts';
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
import {learnHome} from './inbox.ts';
import {devicePage} from './pages/device.ts';
import {onConnection, onReach, remoteAway} from './remote.ts';
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
const ctx: Context = {
  // Server, like File, is laid over the page rather than being one.
  go: (id) => (id === 'server' ? serverLayer.open(true) : select(id)),
  openRepo(name, path = '') {
    if (current === 'forge' && showInForge(name, path)) return;
    ctx.remember(name);
    revealNext(path);
    select('forge');
  },
  remember(name) { openRepo = name; save(REPO_KEY, name); fileTree.mark(name); },
  get repo() { return openRepo; },
  rerender: () => render(),
};

// File lays the tree of "/" over the page; it never replaces the page.
const fileTree = new FileTree({
  choose: (repo, path) => ctx.openRepo(repo, path),
  current: () => (current === 'forge' ? openRepo : null),
});
document.body.append(fileTree.element);
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
  } else {
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'page');
    button.addEventListener('click', () => select(id));
  }
  button.addEventListener('keydown', (event) => {
    const next = stepPurpose(id, event.key);
    if (next === null) return;
    event.preventDefault();
    // Arrows move along the rail; passing File or Server only focuses it.
    if (next !== 'file' && next !== 'server') select(next);
    tabs.get(next)?.focus();
  });
  tabs.set(id, button);
  return button;
}

function select(id: PurposeId) {
  current = id;
  serverLayer.close();
  for (const [tabId, tab] of tabs) {
    const selected = tabId === id;
    if (tabId !== 'file' && tabId !== 'server') tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $('page').setAttribute('aria-labelledby', `purpose-${id}`);
  render();
  if (id !== 'new-repo') save(PURPOSE_KEY, id);
}

function render() {
  const page = $('page');
  page.classList.toggle('page-work', current === 'forge' || current === 'git');
  fileTree.mark(current === 'forge' ? openRepo : null);
  const nodes = current === 'home' ? home(ctx)
    : current === 'forge' ? forge(ctx)
    : current === 'new-repo' ? newRepo(ctx)
    : current === 'runtime' ? runtime(ctx)
    : current === 'git' ? git(ctx)
    : current === 'remote' ? remote(ctx)
    : current === 'inbox' ? inboxPage(ctx)
    : placeholder(current);
  page.replaceChildren(...nodes);
  me.paint();
}

const me = new Me(ctx, currentProfile, {editProfile: () => startEditing(ctx)});
$('rail-me').append(me.element);

$('rail-tabs').append(...PURPOSES.map((p) => railButton(p.id)), railButton(NEW_REPO.id));
// The Remote not answering is said in one place, on the Remote's own: a red dot, and its name says why.
const reach = () => {
  const b = tabs.get('remote');
  if (!b) return;
  const label = remoteAway() ? t('The Remote cannot be reached') : t(purpose('remote').label);
  b.classList.toggle('away', remoteAway());
  b.setAttribute('aria-label', label);
  const tag = b.querySelector('.rail-tag');
  if (tag) tag.textContent = label;
};
onReach(reach);
// Signed in or out, here or from another device: the page is drawn again for who is here now (Remote's draws itself).
onConnection(() => { if (current === 'remote') me.paint(); else render(); });
// Home's state is read before the first page, and again when the window
// comes back, so what l3 changed meanwhile is what the page shows.
// Then what the Remote has is taken in; the page shows as it comes.
// A device's code (?device&user_code=…, from l3 or the app) opens only the page that approves it.
// Changing the language redraws the page and the rail's names in place.
onLang(() => {
  for (const [id, b] of tabs) {
    const label = t(purpose(id).label);
    b.setAttribute('aria-label', label);
    const tag = b.querySelector('.rail-tag');
    if (tag) tag.textContent = label;
  }
  for (const id of ['rail-tabs']) document.getElementById(id)?.setAttribute('aria-label', t('Purposes'));
  reach();
  render();
});
const asking = new URLSearchParams(location.search);
if (asking.has('device')) {
  void loadState().finally(() => { useLang(getState('lang')); document.body.replaceChildren(devicePage(asking.get('user_code') ?? '')); });
} else {
  void loadState().finally(async () => {
    useLang(getState('lang'));
    // Back from a provider: take up the session it made, then go on as usual.
    if (asking.has('signed-in')) {
      const {claim} = await import('./remote.ts');
      await claim().catch(() => false);
      const u = new URL(location.href);
      u.searchParams.delete('signed-in');
      history.replaceState(null, '', u);
      save(PURPOSE_KEY, 'remote');
    }
    // Which domain is this Remote's, so a name on it is shown alone (`ren`), not as a domain's.
    void learnHome();
    select(restorePurpose(load(PURPOSE_KEY)));
    void begin().then(() => render());
  });
}
window.addEventListener('focus', () => {
  void loadState().then(() => { useLang(getState('lang')); if (current === 'home') render(); else me.paint(); });
});
