import {h} from '../../ui/dom.ts';
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
import {askFoot, menuItem, SETTLE} from '../kit/common.ts';
import {rowActions} from '../kit/row-actions.ts';
import {promptHolds} from '../bench/sessions.ts';

// Runtime's This device (This browser, on the web): what the OS holds here.
//
// Under the bar of the whole, one tall box in three columns, read left to
// right as room flows:
//
//   On this device   everything this OS holds here, by size: each repo (all
//                    its copies), the roots, Home; and why what stays stays
//   Can be freed     what can go now, by size: Free (a repo's changes not
//                    on the Remote yet are sent first); and Free all
//   On the Remote    what can come here: repos only on the Remote, and the
//                    release root when it is not installed; Fetch

/** How a figure is known, in one word; a counted figure needs none. */
const known = (c: Certainty) => (c === 'Verified' ? '' : c === 'Estimated' ? t('Estimated') : t('Unknown'));

/** A bar of the whole: this OS's part, everything else's, and what is free. */
function meter(total: number, free: number, mine: number, label: string) {
  const pct = (v: number) => `${Math.min(100, (v / total) * 100).toFixed(2)}%`;
  const app = h('span', {class: 'app'}); app.style.width = pct(mine);
  const other = h('span'); other.style.width = pct(Math.max(0, total - free - mine));
  return h('div', {class: 'meter space-meter', role: 'img', 'aria-label': label}, app, other);
}

const figure = (value: string, word: string, caveat = false) =>
  h('span', caveat ? {'aria-describedby': 'runtime-storage-estimate'} : {}, h('b', {}, value), word);

function capacity(u: Space) {
  const measured = u.host !== 'Unknown' && u.host_total > 0;
  const note = !measured ? t('Storage capacity unavailable') : u.host === 'Estimated' ? t('Estimated') : '';
  return [
    measured ? meter(u.host_total, u.host_free, u.allocated, t('{os} of {total} used by this OS', {os: bytes(u.allocated), total: bytes(u.host_total)}))
      : h('div', {class: 'meter space-meter', role: 'img', 'aria-label': t('Storage capacity unavailable')}),
    h('div', {class: 'legend'},
      figure(bytes(u.allocated), t('This OS')),
      figure(measured ? bytes(u.host_free) : '—', t('Available'), !!note),
      figure(measured ? bytes(u.host_total) : '—', isNative ? t('Total') : t('Quota'), !!note),
      note ? h('p', {id: 'runtime-storage-estimate', class: 'muted small space-caveat'}, note) : null),
  ];
}

/** One column of the box: a heading with its total, its rows, and what goes at its foot. */
function column(id: string, title: string, total: number | null, rows: Node[], empty: string, foot: Node[] = []): HTMLElement {
  return h('section', {class: 'space-col', 'aria-labelledby': id},
    h('h3', {id}, h('span', {}, title), total === null ? null : h('b', {}, bytes(total))),
    h('div', {class: 'space-list'}, ...(rows.length ? rows : [h('p', {class: 'muted small space-empty'}, empty)])),
    ...(foot.length ? [h('div', {class: 'space-foot'}, ...foot)] : []));
}

/**
 * A row: the thing, its facts on one line, and on a line of its own (whole, as long as it is) why it stays or
 * what freeing it does; its size, a repo's gear, and at its end what can be done. A repo's gear list opens under
 * the row, in its own place.
 */
const thing = (name: Node | string, size: number | null, note: string, act?: Node | null, why = '', gear?: {gear: HTMLElement; list: HTMLElement}) =>
  h('div', {class: 'space-row'},
    h('div', {class: 'space-what'}, h('span', {class: 'space-name'}, name), note ? h('span', {class: 'muted small'}, note) : null,
      why ? h('span', {class: 'muted small space-why'}, why) : null),
    // (What it takes stands against the column's right edge whether the row has a gear or not: runtime-space.css.)
    size === null ? null : h('span', {class: 'space-size'}, bytes(size)), gear?.gear ?? null, act ?? null, gear?.list ?? null);

/**
 * This device: the bar and its figures, then the box of three columns. What
 * the last 空ける did stays in view while the figures are read again.
 */
export function device(ctx: Context, u: Space, last: Freed | null, again: (r: Freed | null) => void): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const go = (ids: string[], control: HTMLButtonElement) => {
    control.disabled = true;
    void free(ids).then(again, (e) => { control.disabled = false; error.textContent = errorText(e); });
  };
  const repo = repoParts(ctx, again);
  const here = hereRows(u, repo);
  const freeCol = freeColumn(u, repo, go, again);
  const remoteCol = remoteColumn(repo, again, error);
  return h('section', {class: 'section device-part', 'aria-label': isNative ? t('This device') : t('This browser')},
    ...capacity(u),
    ...(last ? [result(last)] : []),
    // What is here, the part of it that can go, then what is only on the Remote.
    h('div', {class: 'space-box'},
      column('here-col', isNative ? t('On this device') : t('In this browser'), null, here, t('No repos yet')),
      freeCol, remoteCol),
    error);
}

/** A repo in whichever column: its name is the repo itself (opened in Forge), its gear what is done to it, as on Home. */
interface RepoParts {
  name(name: string): HTMLElement;
  /** Its gear: `why` it cannot be freed (null: it can), and `away`, when it is only on the Remote. */
  gear(name: string, why: string | null, away?: boolean): {gear: HTMLButtonElement; list: HTMLElement};
}

function repoParts(ctx: Context, again: (r: Freed | null) => void): RepoParts {
  let freed: Freed | null = null;
  return {
    name: (name) => {
      const b = h('button', {type: 'button', class: 'link-name'}, name);
      // Only on the Remote, it is brought here first.
      b.addEventListener('click', async () => { if (remoteOnly().some((r) => r.name === name)) await bring(name); ctx.openRepo(name); });
      return b;
    },
    gear: (name, why, away = false) => repoGear(ctx, name, {
      arrowKeys: true,
      why: async () => promptHolds(name) === 'busy' ? t('Locked by an active Prompt') : why,
      // Freed from its row: what it came to is said over the box, as Free all's is, and the columns read again.
      free: async () => {
        if (promptHolds(name)) throw new Error(t('Locked by an active Prompt'));
        const r = await free([`repo:${name}`]);
        if (r.kept.length && !r.removed.length) throw new Error(r.kept[0][1]);
        freed = r;
      },
      freed: () => again(freed),
    }, !away),
  };
}

/** On this device: everything, largest first, and why what stays stays. */
function hereRows(u: Space, repo: RepoParts): HTMLElement[] {
  return u.items.map((i) => {
    const isRepo = i.id.startsWith('repo:');
    const repoNote = isRepo ? syncWord(repoState(i.what)) : '';
    // Normal repos need no repeated type, file count or sync label. An exception still says what is happening.
    const other = i.id === 'other', home = i.id === 'home';
    const name = isRepo ? repo.name(i.what) : other ? t('Other (estimated)')
      : i.id === 'why' ? h('code', {class: 'mono'}, i.what) : i.what;
    const note = isRepo ? (repoNote === t('Synced') ? '' : repoNote) : other ? '' : home ? t('Settings and TODO') : i.detail;
    const reason = !home && i.room === 'Keep' ? i.why : '';
    return thing(name, i.allocated, note, null, reason, isRepo ? repo.gear(i.what, reason || null) : undefined);
  });
}

/**
 * One command on its row, the same as a repo's other deeds in Files. Reasons that differ are read in the row;
 * a synced repo's ordinary restoration is said once at the foot, even when there is only one such repo.
 */
function freeColumn(u: Space, repo: RepoParts, go: (ids: string[], control: HTMLButtonElement) => void,
  again: (r: Freed) => void): HTMLElement {
  const freeable = u.items.filter((i) => i.room !== 'Keep');
  const going = freeable.map((i) => {
    const isRepo = i.id.startsWith('repo:');
    const reason = !isRepo || i.room === 'SyncFree' ? i.why : '';
    return thing(isRepo ? repo.name(i.what) : i.what, i.allocated, '', null, reason,
      isRepo ? repo.gear(i.what, null) : releaseActions(i, again));
  });
  const backed = freeable.some((i) => i.id.startsWith('repo:'));
  const all = h('button', {class: 'button', type: 'button', ...(backed ? {'aria-describedby': 'runtime-remote-retention'} : {})}, t('Free all')) as HTMLButtonElement;
  all.addEventListener('click', () => go(freeable.map((i) => i.id), all));
  const foot = [
    ...(freeable.length > 1 ? [all] : []),
    ...(backed ? [h('p', {id: 'runtime-remote-retention', class: 'muted small release-note'}, t('Copies stay on Remote.'))] : []),
  ];
  return column('free-col', t('Reclaimable space'), going.length > 1 ? u.freeable : null, going, t('Nothing to free'), foot);
}

/** Native roots and caches keep a real single-item command; no repo or Remote is claimed for them. */
function releaseActions(i: Item, committed: (r: Freed) => void) {
  const popup = rowActions(i.what, () => {
    const {list, show} = popup;
    const deed = menuItem(t('Free space'), 'free');
    list.replaceChildren(deed);
    deed.focus();
    deed.addEventListener('click', () => {
      const foot = askFoot(deed, list);
      const no = button(t('Cancel'), 'small-button');
      const yes = button(t('Free space'), 'small-button primary');
      const problem = h('p', {class: 'error small', role: 'alert'});
      const word = t('Free the local storage for {what}?', {what: i.what});
      const ask = h('div', {class: 'pop-ask', role: 'group', 'aria-label': word},
        h('p', {}, word), i.why ? h('p', {class: 'muted small'}, i.why) : null, problem, foot(no, yes));
      no.addEventListener('click', () => { ask.replaceWith(deed); deed.focus(); });
      const shown = performance.now();
      yes.addEventListener('click', async () => {
        if (yes.disabled || performance.now() - shown < SETTLE) return;
        yes.disabled = no.disabled = true;
        try { const receipt = await free([i.id]); show(false); committed(receipt); }
        catch (e) { problem.textContent = errorText(e); yes.disabled = no.disabled = false; }
      });
      deed.replaceWith(ask);
      no.focus();
    });
  }, true);
  return popup;
}

/** On the Remote: what can come here, each with Fetch; in the app, the release root too when it is not installed. */
function remoteColumn(repo: RepoParts, again: (r: Freed | null) => void, error: HTMLElement): HTMLElement {
  const repos = remoteOnly();
  const coming: Node[] = repos.map((r) => {
    const b = button(t('Fetch'));
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await bring(r.name); again(null); } catch (e) { error.textContent = errorText(e); b.disabled = false; }
    });
    return thing(repo.name(r.name), r.bytes, '', b, '', repo.gear(r.name, t('Remote-only: no local storage to free'), true));
  });
  // Say a combined amount only for several repos. A single row has already said its own amount.
  const total = repos.length > 1 ? repos.reduce((n, r) => n + r.bytes, 0) : null;
  const col = column('remote-col', t('Remote only'), total, coming,
    connection() ? t('Nothing to fetch') : t('Sign in to view Remote data'));
  // The release root is fetched only where Prompts run on it; elsewhere they run translated, and why comes as it is read.
  void rootHere().then((here) => (here.native ? rootStatus() : null)).then((root) => { if (root && !root.current) rootRow(col, root, again); }, (e) => { error.textContent = errorText(e); });
  return col;
}

/** The release root, not installed: at the top of the column, with Fetch, its progress said in its row. */
function rootRow(col: HTMLElement, root: RootStatus, again: (r: Freed | null) => void) {
  const b = button(t('Fetch'));
  const note = h('span', {class: 'muted small'}, t('Root environment for Prompts'));
  b.addEventListener('click', () => {
    b.disabled = true;
    void rootFetch((got, of, retry) => {
      note.textContent = retry ? t('{why}; resuming from breakpoint', {why: retry}) : t('Fetching {got} / {of}', {got: bytes(got), of: bytes(of)});
    }).then(() => again(null), (e) => { note.textContent = errorText(e); b.disabled = false; });
  });
  const row = h('div', {class: 'space-row'},
    h('div', {class: 'space-what'}, h('span', {class: 'space-name'}, `${root.release.name} ${root.release.version}`), note),
    h('span', {class: 'space-size'}, bytes(root.release.bytes)), b);
  col.querySelector('.space-empty')?.remove();
  col.querySelector('.space-list')!.prepend(row);
}

/**
 * What freeing did, as two things that are not one: what this device had allocated and let go (counted
 * from the files' blocks), and the host's free space as it was seen to change, which can be less (a file
 * still linked from elsewhere, or held open, is given back only when the last goes; other programs write).
 */
function result(r: Freed): HTMLElement {
  const change = r.host_free_after - r.host_free_before;
  const seen = r.reflected_ms === null ? (isNative ? t('Not yet reflected on device') : '')
    : t('Observed free space: {sign}{size} ({how} · {ms} ms)', {sign: change >= 0 ? '+' : '−', size: bytes(Math.abs(change)), how: known(r.host_change) || t('Verified'), ms: r.reflected_ms});
  return h('div', {class: 'reclaimed', role: 'status'},
    r.removed.length ? h('p', {}, t('Released {size}', {size: bytes(r.freed)}), ` · ${tn('{n} item', '{n} items', r.removed.length)}`) : null,
    seen ? h('p', {class: 'muted small'}, seen) : null,
    ...r.kept.map(([id, why]) => h('p', {class: 'muted small'}, t('Retained {what}: {why}', {what: id.replace(/^(repo|root|path):/, '').split('/').at(-1) ?? id, why}))));
}
