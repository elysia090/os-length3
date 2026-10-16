import {ago, bytes, h} from '../dom.ts';
import {icon} from '../icons.ts';
import {LIMITS, initials, normalize, parse, type Profile} from '../profile.ts';
import {store} from '../repos.ts';
import {todoBox} from './todo-box.ts';
import type {Context} from './context.ts';

const PROFILE_KEY = 'length3.os.profile';

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function save(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

let profile: Profile = parse(load(PROFILE_KEY));
let editing = false;

/** The profile as it stands, for the rail's own icon. */
export const currentProfile = (): Profile => profile;

/** Open Home with the profile form out. */
export function startEditing(ctx: Context) {
  editing = true;
  ctx.go('home');
  document.getElementById('profile-name')?.focus();
}

/** Home: a profile that reads the same for its owner and for anyone else. */
export function home(ctx: Context): Node[] {
  const owner = true;
  const count = h('b', {}, '…');
  const grid = h('div', {class: 'grid'}, h('p', {class: 'muted'}, '読み込み中…'));
  void store.list().then((repos) => {
    count.textContent = String(repos.length);
    grid.replaceChildren(...repos.map((r) => repoCard(ctx, r.name, r.files, r.bytes, r.modified, r.git)), newRepoCard(ctx));
    if (!store.persistent) grid.append(h('p', {class: 'muted note'}, 'このブラウザでは、repoはこのページを閉じると消えます。'));
  }, (e: unknown) => grid.replaceChildren(h('p', {class: 'muted'}, `repoを読めませんでした: ${String(e)}`)));
  const header = h('section', {class: 'profile'},
    h('div', {class: 'avatar', 'aria-hidden': 'true'}, initials(profile)),
    editing ? editForm(ctx) : identity(count),
    owner && !editing ? editButton(ctx) : null,
  );
  return [header, todoBox(),
    h('section', {class: 'section', 'aria-labelledby': 'repos-title'}, h('h2', {id: 'repos-title'}, 'repo'), grid),
    h('section', {class: 'section', 'aria-labelledby': 'posts-title'},
      h('h2', {id: 'posts-title'}, '投稿'), h('p', {class: 'muted'}, 'まだ投稿はありません'))];
}

function identity(repoCount: HTMLElement): HTMLElement {
  const named = profile.name || profile.handle;
  return h('div', {class: 'identity'},
    named ? h('h1', {}, profile.name || `@${profile.handle}`) : h('h1', {class: 'unset'}, '名前が未設定です'),
    profile.handle && profile.name ? h('p', {class: 'handle'}, `@${profile.handle}`) : null,
    profile.bio ? h('p', {class: 'bio'}, profile.bio) : null,
    h('p', {class: 'counts'}, h('span', {}, repoCount, ' repo'), h('span', {}, h('b', {}, '0'), ' 投稿')),
  );
}

function editButton(ctx: Context): HTMLElement {
  const b = h('button', {class: 'button', type: 'button'}, 'プロフィールを編集');
  b.addEventListener('click', () => { editing = true; ctx.rerender(); document.getElementById('profile-name')?.focus(); });
  return b;
}

function editForm(ctx: Context): HTMLElement {
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
    if (result.error) { error.textContent = 'ハンドルは英小文字・数字・- _ の32文字以内です'; handle.focus(); return; }
    if (!save(PROFILE_KEY, JSON.stringify(result.profile))) { error.textContent = 'この端末に保存できませんでした'; return; }
    profile = result.profile;
    editing = false;
    ctx.rerender();
  });
  form.querySelector('[data-cancel]')!.addEventListener('click', () => { editing = false; ctx.rerender(); });
  return form;
}

function repoCard(ctx: Context, name: string, files: number, size: number, modified: number, git: boolean): HTMLElement {
  const card = h('button', {class: 'card repo', type: 'button'},
    h('span', {class: 'card-title'}, name),
    h('span', {class: 'muted'}, `${files} ファイル · ${bytes(size)}`),
    h('span', {class: 'muted'}, `${ago(modified)}に更新${git ? '' : ' · gitなし'}`));
  card.addEventListener('click', () => ctx.openRepo(name));
  return card;
}

function newRepoCard(ctx: Context): HTMLElement {
  const card = h('button', {class: 'card new', type: 'button'}, icon('new-repo'), '新しいrepo');
  card.addEventListener('click', () => ctx.go('new-repo'));
  return card;
}
