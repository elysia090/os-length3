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
import {runtime} from './pages/runtime.ts';
import {FileTree} from './pages/tree.ts';
import {begin} from './lifecycle.ts';
import {devicePage} from './pages/device.ts';
import {loadState} from './state.ts';
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
  go: (id) => select(id),
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

function railButton(id: PurposeId): HTMLButtonElement {
  const p = purpose(id), button = document.createElement('button');
  button.type = 'button';
  button.id = `purpose-${id}`;
  button.className = id === 'new-repo' ? 'rail-item rail-new' : 'rail-item';
  button.setAttribute('aria-label', p.label);
  button.append(icon(id), h('span', {class: 'rail-tag', 'aria-hidden': 'true'}, p.label));
  if (id === 'file') {
    fileTree.attach(button);
  } else {
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'page');
    button.addEventListener('click', () => select(id));
  }
  button.addEventListener('keydown', (event) => {
    const next = stepPurpose(id, event.key);
    if (next === null) return;
    event.preventDefault();
    // Arrows move along the rail; passing File only focuses it.
    if (next !== 'file') select(next);
    tabs.get(next)?.focus();
  });
  tabs.set(id, button);
  return button;
}

function select(id: PurposeId) {
  current = id;
  for (const [tabId, tab] of tabs) {
    const selected = tabId === id;
    if (tabId !== 'file') tab.setAttribute('aria-selected', String(selected));
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
    : current === 'runtime' ? runtime()
    : current === 'git' ? git(ctx)
    : current === 'remote' ? remote(ctx)
    : placeholder(current);
  page.replaceChildren(...nodes);
  me.paint();
}

const me = new Me(ctx, currentProfile, {editProfile: () => startEditing(ctx)});
$('rail-me').append(me.element);

$('rail-tabs').append(...PURPOSES.map((p) => railButton(p.id)), railButton(NEW_REPO.id));
// Home's state is read before the first page, and again when the window
// comes back, so what l3 changed meanwhile is what the page shows.
// Then what the Remote has is taken in; the page shows as it comes.
// A device's code (?device&user_code=…, from l3 or the app) opens only the page that approves it.
const asking = new URLSearchParams(location.search);
if (asking.has('device')) {
  void loadState().finally(() => document.body.replaceChildren(devicePage(asking.get('user_code') ?? '')));
} else {
  void loadState().finally(() => {
    select(restorePurpose(load(PURPOSE_KEY)));
    void begin().then(() => render());
  });
}
window.addEventListener('focus', () => {
  void loadState().then(() => { if (current === 'home') render(); else me.paint(); });
});
