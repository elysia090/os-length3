import {h} from '../dom.ts';
import {t, tn} from '../i18n.ts';
import {LIMITS, initials, normalize, parse, type Profile} from '../profile.ts';
import {connection} from '../remote.ts';
import {getState, setState} from '../state.ts';
import * as servers from '../servers.ts';
import {repoList} from './repo-list.ts';
import {todoBox} from './todo-box.ts';
import type {Context} from './context.ts';

let editing = false;

/** The profile as it stands (Home's state, see state.ts), for Home and the rail's own icon. */
export const currentProfile = (): Profile => parse(getState('profile'));

/** Open Home with the profile form out. */
export function startEditing(ctx: Context) {
  editing = true;
  ctx.go('home');
  document.getElementById('profile-name')?.focus();
}

/** Home: a profile that reads the same for its owner and for anyone else. */
export function home(ctx: Context): Node[] {
  const profile = currentProfile();
  const owner = true;
  const count = h('span', {});
  const list = repoList(ctx, {newCard: true, counted: (n) => counting(count, n, 'repo', 'repos')});
  void list.refresh();
  const grid = list.element;
  const header = h('section', {class: 'profile'},
    h('div', {class: 'avatar', 'aria-hidden': 'true'}, initials(profile)),
    editing ? editForm(ctx) : identity(count),
    owner && !editing ? editButton(ctx) : null,
  );
  return [header, todoBox(),
    h('section', {class: 'section', 'aria-labelledby': 'repos-title'}, h('h2', {id: 'repos-title'}, t('Repos')), grid),
    h('section', {class: 'section', 'aria-labelledby': 'servers-title'},
      h('h2', {id: 'servers-title'}, t('Servers')), ownServers(ctx))];
}

/** The servers the person is in (Server holds them), and how many in the counts. */
function ownServers(ctx: Context): HTMLElement {
  const box = h('div', {class: 'home-servers'}, h('p', {class: 'muted'}, t('In no server yet')));
  if (!connection()) return box;
  void servers.servers().then((list) => {
    const n = document.getElementById('server-count');
    if (n) counting(n, list.length, 'server', 'servers');
    if (!list.length) return;
    box.replaceChildren(...list.map((s) => {
      const b = h('button', {type: 'button', class: 'chip'}, s.name);
      b.addEventListener('click', () => { try { localStorage.setItem('length3.server.at', JSON.stringify({server: s.id})); } catch { /* a convenience */ } ctx.go('server'); });
      return b;
    }));
  }).catch(() => {});
  return box;
}

const servers0 = () => { const el = h('span', {id: 'server-count'}); counting(el, 0, 'server', 'servers'); return el; };

/** A count and its word: one repo, 2 repos (Japanese tells them apart by the number alone). */
function counting(el: HTMLElement, n: number, one: string, many: string) {
  el.replaceChildren(h('b', {}, String(n)), ' ', tn(one, many, n));
}

function identity(repoCount: HTMLElement): HTMLElement {
  const profile = currentProfile();
  const named = profile.name || profile.handle;
  return h('div', {class: 'identity'},
    named ? h('h1', {}, profile.name || `@${profile.handle}`) : h('h1', {class: 'unset'}, t('No name yet')),
    profile.handle && profile.name ? h('p', {class: 'handle'}, `@${profile.handle}`) : null,
    profile.bio ? h('p', {class: 'bio'}, profile.bio) : null,
    h('p', {class: 'counts'}, repoCount, servers0()),
  );
}

function editButton(ctx: Context): HTMLElement {
  const b = h('button', {class: 'button', type: 'button'}, t('Edit profile'));
  b.addEventListener('click', () => { editing = true; ctx.rerender(); document.getElementById('profile-name')?.focus(); });
  return b;
}

function editForm(ctx: Context): HTMLElement {
  const profile = currentProfile();
  const name = h('input', {id: 'profile-name', maxlength: String(LIMITS.name), autocomplete: 'name'}) as HTMLInputElement;
  const handle = h('input', {id: 'profile-handle', maxlength: String(LIMITS.handle), autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
  const bio = h('textarea', {id: 'profile-bio', maxlength: String(LIMITS.bio), rows: '3'}) as HTMLTextAreaElement;
  name.value = profile.name; handle.value = profile.handle; bio.value = profile.bio;
  const error = h('p', {class: 'error', role: 'alert'});
  const form = h('form', {class: 'edit'},
    h('label', {}, t('Name'), name),
    h('label', {}, t('Handle'), h('span', {class: 'handle-field'}, '@', handle)),
    h('label', {}, t('Bio'), bio),
    error,
    h('div', {class: 'row'},
      h('button', {class: 'button primary', type: 'submit'}, t('Save')),
      h('button', {class: 'button', type: 'button', 'data-cancel': ''}, t('Cancel'))),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = normalize({name: name.value, handle: handle.value, bio: bio.value});
    if (result.error) { error.textContent = t('A handle is up to 32 lowercase letters, digits, - and _'); handle.focus(); return; }
    try { await setState('profile', JSON.stringify(result.profile)); } catch (e) {
      error.textContent = t('Could not save: {message}', {message: e instanceof Error ? e.message : String(e)});
      return;
    }
    editing = false;
    ctx.rerender();
  });
  form.querySelector('[data-cancel]')!.addEventListener('click', () => { editing = false; ctx.rerender(); });
  return form;
}

