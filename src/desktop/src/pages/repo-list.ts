import {ago, bytes, h} from '../dom.ts';
import {icon} from '../icons.ts';
import {store} from '../repos.ts';
import * as sync from '../sync.ts';
import {STATE_WORD} from './remote.ts';
import type {Context} from './context.ts';

// The repos as large cards, about three across: on Home, and under the New
// repo form so a repo just made is seen joining the others.

function repoCard(ctx: Context, name: string, files: number, size: number, modified: number): HTMLElement {
  const card = h('button', {class: 'card repo', type: 'button', 'data-repo': name},
    h('span', {class: 'card-title'}, name),
    h('span', {class: 'muted'}, `${files} ファイル · ${bytes(size)}`),
    h('span', {class: 'muted'}, `${ago(modified)}に更新`),
    // Where it stands against the Remote; filled in once it is known.
    h('span', {class: 'muted card-sync'}));
  card.addEventListener('click', () => ctx.openRepo(name));
  return card;
}

function newRepoCard(ctx: Context): HTMLElement {
  const card = h('button', {class: 'card new', type: 'button'}, icon('new-repo'), '新しいrepo');
  card.addEventListener('click', () => ctx.go('new-repo'));
  return card;
}

export interface RepoList {
  element: HTMLElement;
  /** Read the repos again; `light` brings that card into view and lights it a moment. */
  refresh(light?: string | null): Promise<void>;
}

export function repoList(ctx: Context, options: {newCard: boolean; count?: HTMLElement}): RepoList {
  const grid = h('div', {class: 'grid'}, h('p', {class: 'muted'}, '読み込み中…'));
  const refresh = async (light?: string | null) => {
    let repos;
    try { repos = await store.list(); } catch (e) {
      grid.replaceChildren(h('p', {class: 'muted'}, `repoを読めませんでした: ${String(e)}`));
      return;
    }
    if (options.count) options.count.textContent = String(repos.length);
    grid.replaceChildren(...repos.map((r) => repoCard(ctx, r.name, r.files, r.bytes, r.modified)),
      ...(options.newCard ? [newRepoCard(ctx)] : []));
    if (!repos.length && !options.newCard) grid.replaceChildren(h('p', {class: 'muted note'}, 'repoはまだありません'));
    if (!store.persistent) grid.append(h('p', {class: 'muted note'}, 'このブラウザでは、repoはこのページを閉じると消えます。'));
    void sync.states().then((states) => {
      for (const card of grid.querySelectorAll<HTMLElement>('.card.repo')) {
        const s = states.get(card.dataset.repo!);
        const slot = card.querySelector('.card-sync');
        if (s && slot) slot.textContent = s.state === 'unpushed' ? `${STATE_WORD.unpushed} ${s.changed}` : STATE_WORD[s.state];
      }
    }, () => {});
    const shown = light ? grid.querySelector<HTMLElement>(`.card.repo[data-repo="${CSS.escape(light)}"]`) : null;
    if (shown) {
      shown.scrollIntoView({block: 'center', behavior: 'smooth'});
      shown.classList.add('revealed');
      setTimeout(() => shown.classList.remove('revealed'), 1600);
    }
  };
  return {element: grid, refresh};
}
