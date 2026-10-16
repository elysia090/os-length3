import {ago, bytes, h} from '../dom.ts';
import {t, tn} from '../i18n.ts';
import {icon} from '../icons.ts';
import {store} from '../repos.ts';
import {bring, onSync, remoteOnly, repoState} from '../lifecycle.ts';
import {syncWord} from './remote.ts';
import type {Context} from './context.ts';

// The repos as large cards, about three across: on Home, and under the New
// repo form so a repo just made is seen joining the others.

function repoCard(ctx: Context, name: string, files: number, size: number, modified: number): HTMLElement {
  const card = h('button', {class: 'card repo', type: 'button', 'data-repo': name},
    h('span', {class: 'card-title'}, name),
    h('span', {class: 'muted'}, `${tn('{n} file', '{n} files', files)} · ${bytes(size)}`),
    h('span', {class: 'muted'}, t('Changed {when}', {when: ago(modified)})),
    // Where it stands against the Remote; filled in once it is known.
    h('span', {class: 'muted card-sync'}));
  card.addEventListener('click', () => ctx.openRepo(name));
  return card;
}

/** A repo on the Remote and not here: opening it brings it. */
function awayCard(ctx: Context, name: string, size: number, modified: number): HTMLElement {
  const card = h('button', {class: 'card repo away', type: 'button', 'data-repo': name},
    h('span', {class: 'card-title'}, name),
    h('span', {class: 'muted'}, t('On the Remote · {size}', {size: bytes(size)})),
    h('span', {class: 'muted'}, t('Changed {when}', {when: ago(modified)})),
    h('span', {class: 'muted card-sync'}, t('Opening brings it here')));
  card.addEventListener('click', async () => {
    card.setAttribute('aria-busy', 'true');
    (card.querySelector('.card-sync') as HTMLElement).textContent = t('Bringing it…');
    try { await bring(name); ctx.openRepo(name); } catch (e) {
      (card.querySelector('.card-sync') as HTMLElement).textContent = e instanceof Error ? e.message : String(e);
      card.removeAttribute('aria-busy');
    }
  });
  return card;
}

function newRepoCard(ctx: Context): HTMLElement {
  const card = h('button', {class: 'card new', type: 'button'}, icon('new-repo'), t('New repo'));
  card.addEventListener('click', () => ctx.go('new-repo'));
  return card;
}

export interface RepoList {
  element: HTMLElement;
  /** Read the repos again; `light` brings that card into view and lights it a moment. */
  refresh(light?: string | null): Promise<void>;
}

export function repoList(ctx: Context, options: {newCard: boolean; count?: HTMLElement}): RepoList {
  const grid = h('div', {class: 'grid'}, h('p', {class: 'muted'}, t('Reading…')));
  const refresh = async (light?: string | null) => {
    let repos;
    try { repos = await store.list(); } catch (e) {
      grid.replaceChildren(h('p', {class: 'muted'}, t('Could not read the repos: {why}', {why: String(e)})));
      return;
    }
    if (options.count) options.count.textContent = String(repos.length);
    grid.replaceChildren(...repos.map((r) => repoCard(ctx, r.name, r.files, r.bytes, r.modified)),
      ...remoteOnly().map((r) => awayCard(ctx, r.name, r.bytes, Date.parse(r.updatedAt))),
      ...(options.newCard ? [newRepoCard(ctx)] : []));
    if (!repos.length && !remoteOnly().length && !options.newCard) grid.replaceChildren(h('p', {class: 'muted note'}, t('No repos yet')));
    if (!store.persistent) grid.append(h('p', {class: 'muted note'}, t('In this browser, repos go when this page closes.')));
    marks();
    const shown = light ? grid.querySelector<HTMLElement>(`.card.repo[data-repo="${CSS.escape(light)}"]`) : null;
    if (shown) {
      shown.scrollIntoView({block: 'center', behavior: 'smooth'});
      shown.classList.add('revealed');
      setTimeout(() => shown.classList.remove('revealed'), 1600);
    }
  };
  /** Where each repo stands, written on its card as it changes. */
  const marks = () => {
    for (const card of grid.querySelectorAll<HTMLElement>('.card.repo:not(.away)')) {
      const slot = card.querySelector('.card-sync');
      if (slot) slot.textContent = syncWord(repoState(card.dataset.repo!));
    }
  };
  let known = '';
  const stop = onSync(() => {
    if (!grid.isConnected) { stop(); return; }
    // A repo that came or went from the Remote redraws the grid; otherwise only the words move.
    const now = remoteOnly().map((r) => r.name).join('\n');
    if (now !== known) { known = now; void refresh(); } else marks();
  });
  return {element: grid, refresh};
}
