import {h} from '../../ui/dom.ts';
import {wayOut} from '../../ui/way-out.ts';
import {bytes} from '../../../text/format.ts';
import {isNative, rootFetch, rootHere, rootStatus, type Certainty, type Freed, type Item, type RootStatus, type Space} from '../../../api/host.ts';
import {t, tn} from '../../../text/i18n.ts';
import {bring, remoteOnly, repoState} from '../../../shipto/lifecycle.ts';
import {connection} from '../../../shipto/connection.ts';
import {free} from '../../../device/space.ts';
import type {Context} from '../kit/context.ts';
import {syncWord} from '../remote/repo-card.ts';
import {repoGear} from '../remote/repo-gear.ts';
import {errorText} from '../../../api/errors.ts';
import {button} from './parts.ts';
import {answers, askFoot, menuItem, SETTLE} from '../kit/common.ts';
import {rowActions} from '../kit/row-actions.ts';
import {promptHolds} from '../bench/sessions.ts';

const known = (c: Certainty) => c === 'Verified' ? '' : c === 'Estimated' ? t('Estimated') : t('Unknown');
const focusKey = (el: HTMLElement, key: string) => { el.dataset.spaceFocus = key; return el; };
type RowMenu = ReturnType<typeof rowActions> | ReturnType<typeof repoGear>;
type Redraw = (receipt: Freed | null, focus?: string) => void;

function capacity(u: Space) {
  const capacityKnown = u.host !== 'Unknown' && u.host_total > 0;
  const sized = (room: Item['room']) => u.items.filter((i) => i.room === room).reduce((n, i) => n + i.allocated, 0);
  const ready = sized('Free'), sync = sized('SyncFree');
  const estimated = u.items.find((i) => i.id === 'other')?.allocated ?? 0;
  // Only the local inventory partitions these bytes. The browser's host quota has no part in this scale.
  const slices = [
    {id: 'free', size: ready, label: t('Ready to free')},
    {id: 'sync', size: sync, label: t('Send, then free')},
    {id: 'keep', size: Math.max(0, u.allocated - ready - sync - estimated), label: t('Kept here')},
    {id: 'estimate', size: estimated, label: t('Other (estimated)')},
  ].filter(({size}) => size > 0);
  const strip = h('div', {class: 'storage-meter', 'aria-hidden': 'true'});
  for (const {id, size} of slices) {
    const part = h('span', {'data-capacity': id});
    part.style.flexGrow = String(size);
    strip.append(part);
  }
  return h('div', {class: 'storage-hero'},
    h('div', {class: 'storage-figures'},
      h('p', {class: 'storage-amount'}, h('strong', {}, bytes(u.allocated)), h('span', {}, t('Stored here'))),
      h('p', {class: 'storage-host'},
        capacityKnown ? h('span', {}, h('b', {}, bytes(u.host_free)), ' ', t('Available')) : t('Storage capacity unavailable'),
        capacityKnown ? h('span', {class: 'muted'}, bytes(u.host_total), ' ', isNative ? t('Total') : t('Quota'),
          u.host === 'Estimated' ? ` · ${t('Estimated')}` : '') : null)),
    ...(slices.length ? [strip, h('dl', {class: 'storage-key'},
      ...slices.map(({id, label, size}) => h('div', {'data-capacity': id}, h('dt', {}, label), h('dd', {}, bytes(size)))))] : []));
}

function region(id: string, title: string, rows: Node[], empty: string, action?: Node) {
  return h('section', {class: 'storage-group', 'aria-labelledby': id},
    h('div', {class: 'storage-caption'},
      focusKey(h('h3', {id, tabindex: '-1'}, title), id), action),
    h('div', {class: 'space-list'}, ...(rows.length ? rows : [h('p', {class: 'muted space-empty'}, empty)])));
}

function row(id: string, name: Node | string, size: number, notes: string | readonly string[], action?: RowMenu, room?: Item['room']) {
  const copy = typeof notes === 'string' ? [notes] : notes;
  const mark = room === 'SyncFree' ? 'sync' : room === 'Free' ? 'free' : '';
  return h('div', {class: 'space-row', 'data-space-item': id},
    h('div', {class: 'space-what'},
      h('span', {class: 'space-name'}, name),
      ...copy.filter(Boolean).map((note) => h('span', {class: 'muted space-note'}, note))),
    h('span', {class: 'space-measure'},
      mark ? h('span', {class: 'space-mark', 'data-capacity': mark, 'aria-hidden': 'true'}) : null,
      mark ? h('span', {class: 'sr-only'}, mark === 'sync' ? t('Send, then free') : t('Ready to free')) : null,
      h('span', {class: 'space-size'}, bytes(size))),
    action ? focusKey(action.gear, `actions:${id}`) : null, action?.list);
}

/** A single inventory. A repo's readiness belongs to its existing row; it is not listed again as a recommendation. */
export function device(ctx: Context, u: Space, last: Freed | null, again: Redraw): HTMLElement {
  const error = h('p', {class: 'error storage-error', role: 'alert'});
  const repo = repoParts(ctx, again, error);
  const local = u.items.map((i) => {
    const isRepo = i.id.startsWith('repo:'), home = i.id === 'home', other = i.id === 'other';
    const sync = isRepo ? syncWord(repoState(i.what)) : '';
    const note = isRepo ? (sync === t('Synced') || i.room === 'SyncFree' ? '' : sync) : home ? t('Settings and TODO') : other ? '' : i.detail;
    const reason = home || other || isRepo && i.room === 'Free' ? '' : i.why;
    const notes = [...new Set([note, reason])];
    const name = isRepo ? repo.name(i.what) : other ? t('Other (estimated)')
      : i.id === 'why' ? h('code', {class: 'mono'}, i.what) : i.what;
    return row(i.id, name, i.allocated, notes, isRepo ? repo.gear(i.what, i) : i.room !== 'Keep' ? releaseActions(i, again) : undefined, i.room);
  });
  const freeable = u.items.filter((i) => i.room !== 'Keep');
  const here = region('here-col', isNative ? t('On this device') : t('In this browser'), local, t('No repos yet'),
    freeable.length > 1 ? batch(freeable, u.freeable, again) : undefined);
  const remote = remoteRegion(repo, again, error);
  return h('section', {class: 'section device-part', 'aria-label': isNative ? t('This device') : t('This browser')},
    capacity(u),
    h('div', {class: 'storage-inventory'},
      last ? result(last) : null,
      here, remote, error));
}

/** The only bulk deed is for the measured list. Core free rechecks each item, sends first and never releases a kept copy. */
function batch(items: Item[], available: number, again: Redraw) {
  const trigger = focusKey(button(t('Free all')), 'batch');
  const proposal = h('div', {class: 'storage-batch'});
  proposal.append(trigger);
  trigger.addEventListener('click', () => {
    const title = t('Free {size}', {size: bytes(available)});
    const no = wayOut(button(t('Cancel')));
    const yes = button(t('Free space'), 'primary');
    const error = h('p', {class: 'error storage-error', role: 'alert'});
    const repos = items.some((i) => i.id.startsWith('repo:'));
    const unsent = items.some((i) => i.room === 'SyncFree');
    const ask = h('div', {class: 'storage-batch-ask', role: 'group', 'aria-label': title},
      h('p', {}, title, ' · ', tn('{n} item', '{n} items', items.length)),
      unsent ? h('p', {class: 'muted'}, t('Pending changes are sent before their local copies are freed.')) : null,
      repos ? h('p', {class: 'muted'}, t('Copies stay on Remote.')) : null,
      error, answers(no, yes));
    const shown = performance.now();
    no.addEventListener('click', () => { proposal.replaceChildren(trigger); trigger.focus(); });
    yes.addEventListener('click', async () => {
      if (yes.disabled || performance.now() - shown < SETTLE) return;
      yes.disabled = no.disabled = true;
      try {
        const receipt = await free(items.map((i) => i.id));
        proposal.replaceChildren(trigger);
        again(receipt, 'batch');
      } catch (e) {
        yes.disabled = no.disabled = false;
        error.textContent = errorText(e);
        yes.focus();
      }
    });
    proposal.replaceChildren(ask);
    no.focus();
  });
  return proposal;
}

/** Keep the file opening route and the shared repo actions independent of one another. */
function repoParts(ctx: Context, again: Redraw, error: HTMLElement) {
  return {
    name(name: string) {
      const b = focusKey(h('button', {type: 'button', class: 'link-name'}, name), `item:repo:${name}`);
      b.addEventListener('click', async () => {
        if (b.hasAttribute('aria-busy')) return;
        error.textContent = '';
        if (remoteOnly().some((r) => r.name === name)) {
          b.setAttribute('aria-busy', 'true');
          try { await bring(name); }
          catch (e) { error.textContent = errorText(e); return; }
          finally { b.removeAttribute('aria-busy'); }
        }
        ctx.openRepo(name);
      });
      return b;
    },
    gear(name: string, item?: Item) {
      let receipt: Freed | null = null;
      return repoGear(ctx, name, {
        arrowKeys: true,
        backedHere: item?.room === 'Free',
        afterSend: item?.room === 'SyncFree' ? item.why : undefined,
        fetch: item ? undefined : async () => { await bring(name); },
        why: async () => promptHolds(name) === 'busy' ? t('Locked by an active Prompt')
          : item?.room === 'Keep' ? item.why : null,
        free: async () => {
          if (promptHolds(name)) throw new Error(t('Locked by an active Prompt'));
          const r = await free([`repo:${name}`]);
          if (r.kept.length && !r.removed.length) throw new Error(r.kept[0][1]);
          receipt = r;
        },
        freed: () => again(receipt, `actions:repo:${name}`),
      }, !!item);
    },
  };
}

function releaseActions(i: Item, committed: Redraw) {
  const popup = rowActions(i.what, () => {
    const {list, show} = popup;
    const deed = menuItem(t('Free space'), 'free');
    list.replaceChildren(deed);
    deed.focus();
    deed.addEventListener('click', () => {
      const foot = askFoot(deed, list);
      const no = button(t('Cancel')), yes = button(t('Free space'), 'primary');
      const problem = h('p', {class: 'error storage-error', role: 'alert'});
      const word = t('Free the local storage for {what}?', {what: i.what});
      const ask = h('div', {class: 'pop-ask', role: 'group', 'aria-label': word},
        h('p', {}, word), i.why ? h('p', {class: 'muted'}, i.why) : null, problem, foot(no, yes));
      no.addEventListener('click', () => { ask.replaceWith(deed); deed.focus(); });
      const shown = performance.now();
      yes.addEventListener('click', async () => {
        if (yes.disabled || performance.now() - shown < SETTLE) return;
        yes.disabled = no.disabled = true;
        try { const receipt = await free([i.id]); show(false); committed(receipt, `actions:${i.id}`); }
        catch (e) { problem.textContent = errorText(e); yes.disabled = no.disabled = false; yes.focus(); }
      });
      deed.replaceWith(ask);
      no.focus();
    });
  }, true);
  return popup;
}

/** Remote items have not changed the local bar. Their row can be fetched without opening it. */
function remoteRegion(repo: ReturnType<typeof repoParts>, again: Redraw, error: HTMLElement) {
  const repos = remoteOnly();
  const remote = region('remote-col', t('Remote only'),
    repos.map((r) => row(`repo:${r.name}`, repo.name(r.name), r.bytes, '', repo.gear(r.name))),
    connection() ? t('Nothing to fetch') : t('Sign in to view Remote data'));
  // The release root is offered only on a native host whose Prompts run on it.
  if (isNative) void rootHere().then((here) => here.native ? rootStatus() : null).then((root) => {
    if (!root || root.current || !remote.isConnected) return;
    remote.querySelector('.space-empty')?.remove();
    remote.querySelector('.space-list')?.prepend(rootRow(root, again));
  }, (e) => { error.textContent = errorText(e); });
  return remote;
}

function rootRow(root: RootStatus, again: Redraw) {
  const id = 'root:fetch';
  const progress = h('span', {class: 'muted', role: 'status'});
  const name = h('span', {}, `${root.release.name} ${root.release.version}`, progress);
  const menu = rowActions(root.release.name, () => {
    const fetch = menuItem(t('Fetch'), 'download');
    menu.list.replaceChildren(fetch);
    fetch.focus();
    fetch.addEventListener('click', async () => {
      if (fetch.disabled || name.hasAttribute('aria-busy')) return;
      fetch.disabled = true;
      name.setAttribute('aria-busy', 'true');
      try {
        await rootFetch((got, of, retry) => {
          progress.textContent = retry ? t('{why}; resuming from breakpoint', {why: retry}) : t('Fetching {got} / {of}', {got: bytes(got), of: bytes(of)});
        });
        name.removeAttribute('aria-busy');
        menu.show(false);
        again(null, 'here-col');
      } catch (e) {
        name.removeAttribute('aria-busy');
        progress.textContent = errorText(e);
        fetch.disabled = false;
        fetch.focus();
      }
    });
  }, true);
  return row(id, name, root.release.bytes, t('Root environment for Prompts'), menu);
}

/** Accounted blocks and observed changes in the host's free space are different facts. */
function result(r: Freed): HTMLElement {
  const change = r.host_free_after - r.host_free_before;
  const seen = r.reflected_ms === null ? (isNative ? t('Not yet reflected on device') : '')
    : t('Observed free space: {sign}{size} ({how} · {ms} ms)', {sign: change >= 0 ? '+' : '−', size: bytes(Math.abs(change)), how: known(r.host_change) || t('Verified'), ms: r.reflected_ms});
  return h('div', {class: 'reclaimed', role: 'status'},
    r.removed.length ? h('p', {}, t('Released {size}', {size: bytes(r.freed)}), ' · ', tn('{n} item', '{n} items', r.removed.length)) : null,
    seen ? h('p', {class: 'muted'}, seen) : null,
    ...r.kept.map(([id, why]) => h('p', {class: 'muted'}, t('Retained {what}: {why}', {what: id.replace(/^(repo|root|path):/, '').split('/').at(-1) ?? id, why}))));
}
