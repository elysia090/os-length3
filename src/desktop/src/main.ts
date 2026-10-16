import {h} from './dom.ts';
import {icon} from './icons.ts';
import {placeholder} from './pages/common.ts';
import type {Context} from './pages/context.ts';
import {file} from './pages/file.ts';
import {home} from './pages/home.ts';
import {newRepo} from './pages/new-repo.ts';
import {runtime} from './pages/runtime.ts';
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
  openRepo(name) { ctx.remember(name); select('file'); },
  remember(name) { openRepo = name; save(REPO_KEY, name); },
  get repo() { return openRepo; },
  rerender: () => render(),
};

function railButton(id: PurposeId): HTMLButtonElement {
  const p = purpose(id), button = document.createElement('button');
  button.type = 'button';
  button.id = `purpose-${id}`;
  button.className = id === 'new-repo' ? 'rail-item rail-new' : 'rail-item';
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', 'page');
  button.setAttribute('aria-label', p.label);
  button.append(icon(id), h('span', {class: 'rail-tag', 'aria-hidden': 'true'}, p.label));
  button.addEventListener('click', () => select(id));
  button.addEventListener('keydown', (event) => {
    const next = stepPurpose(id, event.key);
    if (next === null) return;
    event.preventDefault();
    select(next);
    tabs.get(next)?.focus();
  });
  tabs.set(id, button);
  return button;
}

function select(id: PurposeId) {
  current = id;
  for (const [tabId, tab] of tabs) {
    const selected = tabId === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $('page').setAttribute('aria-labelledby', `purpose-${id}`);
  render();
  if (id !== 'new-repo') save(PURPOSE_KEY, id);
}

function render() {
  const page = $('page');
  page.classList.toggle('page-work', current === 'file');
  const nodes = current === 'home' ? home(ctx)
    : current === 'file' ? file(ctx)
    : current === 'new-repo' ? newRepo(ctx)
    : current === 'runtime' ? runtime()
    : placeholder(current);
  page.replaceChildren(...nodes);
}

$('rail-tabs').append(...PURPOSES.map((p) => railButton(p.id)), railButton(NEW_REPO.id));
select(restorePurpose(load(PURPOSE_KEY)));
