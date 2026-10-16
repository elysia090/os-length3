import {icon} from './icons.ts';
import {NEW_REPO, PURPOSES, purpose, restorePurpose, stepPurpose, type PurposeId} from './purposes.ts';

const STORAGE_KEY = 'length3.os.purpose';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabs = new Map<PurposeId, HTMLButtonElement>();

function readStored(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function store(id: PurposeId) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* convenience only */ }
}

function railButton(id: PurposeId): HTMLButtonElement {
  const p = purpose(id), button = document.createElement('button');
  button.type = 'button';
  button.id = `purpose-${id}`;
  button.className = id === 'new-repo' ? 'rail-item rail-new' : 'rail-item';
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', 'target');
  button.title = `${p.label} — ${p.role}`;
  const label = document.createElement('span');
  label.className = 'rail-label';
  label.textContent = id === 'new-repo' ? 'New' : p.label;
  if (id === 'new-repo') button.setAttribute('aria-label', p.label);
  button.append(icon(id), label);
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

// Only the target column follows the rail. The center's scroll position and
// the right pane are separate elements that a purpose switch never rebuilds.
function select(id: PurposeId) {
  const p = purpose(id);
  for (const [tabId, tab] of tabs) {
    const selected = tabId === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  const target = $('target');
  target.setAttribute('aria-labelledby', `purpose-${id}`);
  target.dataset.purpose = id;
  $('target-title').textContent = p.label;
  $('target-role').textContent = p.role;
  $('target-detail').textContent = p.detail;
  $('target-state').textContent = p.implemented ? '' : 'まだ実装していません。';
  $('target-state').hidden = p.implemented;
  if (id !== 'new-repo') store(id);
}

// The square-plus shares the tab list so arrow keys reach it, but sits apart at
// the foot of the rail because it starts something new rather than viewing.
$('rail-tabs').append(...PURPOSES.map((p) => railButton(p.id)), railButton(NEW_REPO.id));
select(restorePurpose(readStored()));
