import {ago, arrowKeys, bytes, h} from '../ui/dom.ts';
import {t} from '../i18n.ts';
import {icon} from '../ui/icons.ts';
import {store, type RepoSummary} from '../repos/repos.ts';
import {bring, onSync, remoteOnly, repoState} from '../remote/lifecycle.ts';
import {free, readSpace} from '../app/space.ts';
import {syncWord} from './remote/repo-card.ts';
import {repoGear} from './repo-gear.ts';
import {allSessions} from './bench/sessions.ts';
import type {Context} from './context.ts';
import {errorText} from '../app/errors.ts';

// The repos as large cards, about three across: on Home, and under the New
// repo form so a repo just made is seen joining the others.

// A card says what Remote's says, in its order: size and when it changed,
// then where it stands.
const sizeAndWhen = (size: number, modified: number) => `${bytes(size)} · ${t('Updated {when}', {when: ago(modified)})}`;

/**
 * Why `name` stays on this device now (no Remote, something running in its Prompt…), or null when it can be freed
 * (space.ts). A Prompt waiting at its prompt line does not keep it: the gear stops it first, saying so.
 */
async function whyKept(name: string): Promise<string | null> {
  const u = await readSpace(allSessions().filter(([, s]) => s.running && s.runs.at(-1)?.ms === null).map(([repo]) => repo));
  const it = u.items.find((i) => i.id === `repo:${name}`);
  return !it ? t('Remote-only: no local storage to free') : it.room === 'Keep' ? it.why : null;
}

/**
 * A repo's card: its body is the repo itself, opened in Forge where all of it is (only on the Remote, brought here
 * first, its card saying so meanwhile); its gear, at the top right, offers what is done to the repo itself (its card on
 * the Remote, Rename, Free from this device, Delete: repo-gear.ts). `again` draws the list once something changed.
 */
function gearCard(ctx: Context, name: string, lines: Node[], away: boolean, again: () => Promise<void>): HTMLElement {
  const body = h('button', {type: 'button', class: 'card-open'}, h('span', {class: 'card-title'}, name), ...lines);
  const sync = () => body.querySelector('.card-sync') as HTMLElement;
  body.addEventListener('click', async () => {
    if (!away) { ctx.openRepo(name); return; }
    if (card.getAttribute('aria-busy') === 'true') return;
    card.setAttribute('aria-busy', 'true');
    sync().textContent = t('Fetching…');
    try { await bring(name); ctx.openRepo(name); } catch (e) { sync().textContent = errorText(e); card.removeAttribute('aria-busy'); }
  });
  const {gear, list} = repoGear(ctx, name, {
    why: () => whyKept(name),
    free: async () => {
      const r = await free([`repo:${name}`]);
      if (r.kept.length) throw new Error(r.kept[0][1]);
    },
    // Gone from here, or renamed: drawn again (freed, its card now the Remote's: Only on the Remote).
    freed: () => void again(),
  }, !away);
  const card = h('div', {class: `card repo gear-card${away ? ' away' : ''}`, 'data-repo': name, role: 'group', 'aria-label': name},
    body, h('span', {class: 'repo-gear'}, gear), list);
  return card;
}

function repoCard(ctx: Context, name: string, size: number, modified: number, again: () => Promise<void>): HTMLElement {
  // What it is, in the words it was made with: its README's first plain line, under its name, once read.
  const what = h('span', {class: 'card-summary'});
  void summaryOf(name).then((line) => { what.textContent = line; });
  return gearCard(ctx, name, [what, h('span', {class: 'muted'}, sizeAndWhen(size, modified)),
    // Where it stands against the Remote; filled in once it is known.
    h('span', {class: 'muted card-sync'})], false, again);
}

/** A repo's README's first line that is neither a heading nor empty ('' when there is none): Home's and Remote's cards. */
export async function summaryOf(name: string): Promise<string> {
  const c = await store.read(name, 'README.md').catch(() => null);
  return c?.text?.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
}

/** A repo on the Remote and not here: pressed, it is brought here and opened. */
function awayCard(ctx: Context, name: string, size: number, modified: number, again: () => Promise<void>): HTMLElement {
  return gearCard(ctx, name, [h('span', {class: 'muted'}, sizeAndWhen(size, modified)),
    h('span', {class: 'muted card-sync'}, t('Remote only'))], true, again);
}

function newRepoCard(ctx: Context): HTMLElement {
  const card = h('button', {class: 'card new', type: 'button'}, icon('new-repo'), t('New repo'));
  card.addEventListener('click', () => ctx.go('new-repo'));
  return card;
}

interface RepoList {
  element: HTMLElement;
  /** Read the repos again; `light` brings that card into view and lights it a moment. Their list as read, the one changed last first (null: not read). */
  refresh(light?: string | null): Promise<RepoSummary[] | null>;
}

export function repoList(ctx: Context, options: {newCard: boolean; counted?: (n: number) => void}): RepoList {
  // The same cards wherever the list is (Home, New repo): one size, one title.
  const grid = h('div', {class: 'grid repo-grid'}, h('p', {class: 'muted'}, t('Loading…')));
  arrowKeys(grid, '.card-open, .card.new');
  const refresh = async (light?: string | null): Promise<RepoSummary[] | null> => {
    let repos;
    try { repos = await store.list(); } catch (e) {
      grid.replaceChildren(h('p', {class: 'muted'}, t('Failed to load repos: {why}', {why: errorText(e)})));
      return null;
    }
    options.counted?.(repos.length + remoteOnly().length);
    const again = async () => { await refresh(); };
    // A repo's gear list out is not drawn away under the pointer: the cards are drawn once it is put away.
    if (grid.isConnected && grid.querySelector('.repo-gear-pop:not([hidden])')) { setTimeout(() => void refresh(light), 1000); return repos; }
    // What is drawn of the Remote is what a change is told from (signed out, its cards go at the next look).
    known = remoteOnly().map((r) => r.name).join('\n');
    grid.replaceChildren(...repos.map((r) => repoCard(ctx, r.name, r.bytes, r.modified, again)),
      ...remoteOnly().map((r) => awayCard(ctx, r.name, r.bytes, Date.parse(r.updatedAt), again)),
      ...(options.newCard ? [newRepoCard(ctx)] : []));
    if (!repos.length && !remoteOnly().length && !options.newCard) grid.replaceChildren(h('div', {class: 'empty'}, t('No repos yet')));
    marks();
    const shown = light ? grid.querySelector<HTMLElement>(`.card.repo[data-repo="${CSS.escape(light)}"]`) : null;
    // The page stays where it is: the new card only lights where it joins the list.
    if (shown) {
      shown.classList.add('revealed');
      setTimeout(() => shown.classList.remove('revealed'), 1600);
    }
    return repos;
  };
  /** Where each repo stands, written on its card as it changes. */
  const marks = () => {
    for (const card of grid.querySelectorAll<HTMLElement>('.card.repo:not(.away)')) {
      const slot = card.querySelector('.card-sync');
      const s = repoState(card.dataset.repo!);
      if (slot) slot.textContent = syncWord(s);
      // Held back by the plan: its edge dashed and its words in ink, not one of the others with a quiet line.
      card.classList.toggle('held', s?.where === 'waits');
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
