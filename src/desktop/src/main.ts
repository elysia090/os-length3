import {readCapacity} from './host.ts';
import {icon} from './icons.ts';
import {LIMITS, initials, normalize, parse, type Profile} from './profile.ts';
import {NEW_REPO, PURPOSES, purpose, restorePurpose, stepPurpose, type PurposeId} from './purposes.ts';

const PURPOSE_KEY = 'length3.os.purpose';
const PROFILE_KEY = 'length3.os.profile';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabs = new Map<PurposeId, HTMLButtonElement>();
let current: PurposeId = 'home';

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function save(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

type Child = Node | string | null | undefined | false;

/** Build an element; text is always set as text, never parsed as HTML. */
function h(tag: string, props: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v; else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

// ---- Rail ----

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
  page.replaceChildren(...(current === 'home' ? home() : current === 'runtime' ? runtime() : placeholder(current)));
}

// ---- Home: the profile ----

let profile: Profile = parse(load(PROFILE_KEY));
let editing = false;

function home(): Node[] {
  // Everyone sees this page the same way; the owner also gets "edit".
  const owner = true;
  const header = h('section', {class: 'profile'},
    h('div', {class: 'avatar', 'aria-hidden': 'true'}, initials(profile)),
    editing ? editForm() : identity(),
    owner && !editing ? editButton() : null,
  );
  const repos = h('section', {class: 'section', 'aria-labelledby': 'repos-title'},
    h('h2', {id: 'repos-title'}, 'repo'),
    h('div', {class: 'grid'}, newRepoCard()),
  );
  const posts = h('section', {class: 'section', 'aria-labelledby': 'posts-title'},
    h('h2', {id: 'posts-title'}, '投稿'),
    h('p', {class: 'muted'}, 'まだ投稿はありません'),
  );
  return [header, repos, posts];
}

function identity(): HTMLElement {
  const named = profile.name || profile.handle;
  return h('div', {class: 'identity'},
    named ? h('h1', {}, profile.name || `@${profile.handle}`) : h('h1', {class: 'unset'}, '名前が未設定です'),
    profile.handle && profile.name ? h('p', {class: 'handle'}, `@${profile.handle}`) : null,
    profile.bio ? h('p', {class: 'bio'}, profile.bio) : null,
    h('p', {class: 'counts'}, h('span', {}, h('b', {}, '0'), ' repo'), h('span', {}, h('b', {}, '0'), ' 投稿')),
  );
}

function editButton(): HTMLElement {
  const b = h('button', {class: 'button', type: 'button'}, 'プロフィールを編集');
  b.addEventListener('click', () => { editing = true; render(); ($('profile-name') as HTMLInputElement).focus(); });
  return b;
}

function editForm(): HTMLElement {
  const name = h('input', {id: 'profile-name', maxlength: String(LIMITS.name), autocomplete: 'name'}) as HTMLInputElement;
  const handle = h('input', {id: 'profile-handle', maxlength: String(LIMITS.handle), autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
  const bio = h('textarea', {id: 'profile-bio', maxlength: String(LIMITS.bio), rows: '3'}) as HTMLTextAreaElement;
  name.value = profile.name; handle.value = profile.handle; bio.value = profile.bio;
  const error = h('p', {class: 'error', role: 'alert'});
  const form = h('form', {class: 'edit'},
    h('label', {}, '名前', name),
    h('label', {}, 'ハンドル', h('span', {class: 'handle-field'}, '@', handle)),
    h('label', {}, '自己紹介', bio),
    error,
    h('div', {class: 'row'},
      h('button', {class: 'button primary', type: 'submit'}, '保存'),
      h('button', {class: 'button', type: 'button', 'data-cancel': ''}, 'キャンセル')),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const result = normalize({name: name.value, handle: handle.value, bio: bio.value});
    if (result.error) {
      error.textContent = 'ハンドルは英小文字・数字・- _ の32文字以内です';
      handle.focus();
      return;
    }
    if (!save(PROFILE_KEY, JSON.stringify(result.profile))) {
      error.textContent = 'この端末に保存できませんでした';
      return;
    }
    profile = result.profile;
    editing = false;
    render();
  });
  form.querySelector('[data-cancel]')!.addEventListener('click', () => { editing = false; render(); });
  return form;
}

function newRepoCard(): HTMLElement {
  const card = h('button', {class: 'card new', type: 'button'}, icon('new-repo'), '新しいrepo');
  card.addEventListener('click', () => select('new-repo'));
  return card;
}

// ---- Runtime: what this device holds ----

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function bytes(n: number): string {
  let i = 0;
  while (n >= 1000 && i < UNITS.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${UNITS[i]}`;
}

function runtime(): Node[] {
  const p = purpose('runtime');
  const storage = h('section', {class: 'section', 'aria-labelledby': 'storage-title'},
    h('h2', {id: 'storage-title'}, 'この端末の容量'),
    h('p', {class: 'muted'}, '計測中…'));
  void readCapacity().then((c) => {
    if (!c) { storage.lastChild!.textContent = '計測できませんでした'; return; }
    const used = c.total - c.free;
    const pct = (v: number) => `${Math.min(100, (v / c.total) * 100).toFixed(2)}%`;
    const app = h('span', {class: 'app'}); app.style.width = pct(c.app);
    const other = h('span'); other.style.width = pct(Math.max(0, used - c.app));
    storage.lastChild!.replaceWith(
      h('div', {class: 'meter', role: 'img', 'aria-label': `全体 ${bytes(c.total)} のうち ${bytes(used)} 使用`}, app, other),
      h('div', {class: 'legend'},
        h('span', {}, h('b', {}, bytes(c.app)), 'このアプリ'),
        h('span', {}, h('b', {}, bytes(used)), '使用中'),
        h('span', {}, h('b', {}, bytes(c.free)), '空き'),
        h('span', {}, h('b', {}, bytes(c.total)), c.layer === 'browser-origin' ? 'このブラウザの割当' : '全体')),
    );
  });
  return [pageHead('runtime', p.label, p.role), storage,
    h('section', {class: 'section'}, h('h2', {}, '有効な環境'), h('div', {class: 'empty'}, p.detail))];
}

// ---- Not built yet ----

function pageHead(id: PurposeId, label: string, role: string): HTMLElement {
  return h('header', {class: 'page-head'}, icon(id), h('h1', {}, label), h('p', {}, role));
}

function placeholder(id: PurposeId): Node[] {
  const p = purpose(id);
  return [pageHead(id, p.label, p.role), h('div', {class: 'empty'}, p.detail)];
}

// ---- Start ----

$('rail-tabs').append(...PURPOSES.map((p) => railButton(p.id)), railButton(NEW_REPO.id));
select(restorePurpose(load(PURPOSE_KEY)));
