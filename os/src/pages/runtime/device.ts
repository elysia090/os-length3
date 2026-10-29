import {bytes, h} from '../../ui/dom.ts';
import {isNative, rootFetch, rootStatus, type Certainty, type Freed, type RootStatus, type Space} from '../../app/host.ts';
import {t, tn} from '../../i18n.ts';
import {bring, remoteOnly, repoState} from '../../remote/lifecycle.ts';
import {connection} from '../../remote/connection.ts';
import {free} from '../../app/space.ts';
import type {Context} from '../context.ts';
import {syncWord} from '../remote/repo-card.ts';
import {repoGear} from '../repo-gear.ts';
import {errorText} from '../../app/errors.ts';
import {button} from './parts.ts';

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
const known = (c: Certainty) => (c === 'Verified' ? '' : c === 'Estimated' ? t('estimated') : t('unknown'));

/** A bar of the whole: this OS's part, everything else's, and what is free. */
function meter(total: number, free: number, mine: number, label: string) {
  const pct = (v: number) => `${Math.min(100, (v / total) * 100).toFixed(2)}%`;
  const app = h('span', {class: 'app'}); app.style.width = pct(mine);
  const other = h('span'); other.style.width = pct(Math.max(0, total - free - mine));
  return h('div', {class: 'meter space-meter', role: 'img', 'aria-label': label}, app, other);
}

const figure = (value: string, word: string, note = '') =>
  h('span', {}, h('b', {}, value), word, note ? h('small', {class: 'muted'}, ` ${note}`) : null);

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
    // A row with no gear keeps the gear's room, so every size in a column stands on one line.
    size === null ? null : h('span', {class: 'space-size'}, bytes(size)), gear?.gear ?? (act ? null : h('span', {class: 'gear-room', 'aria-hidden': 'true'})), act ?? null, gear?.list ?? null);

/**
 * This device: the bar and its figures, then the box of three columns. What
 * the last 空ける did stays in view while the figures are read again.
 */
export function device(ctx: Context, u: Space, last: Freed | null, again: (r: Freed | null) => void): HTMLElement {
  const total = u.host_total || 1;
  const error = h('p', {class: 'error', role: 'alert'});
  const go = (ids: string[], held: HTMLButtonElement[]) => {
    for (const b of held) b.disabled = true;
    void free(ids).then(again, (e) => {
      for (const b of held) b.disabled = false;
      error.textContent = errorText(e);
    });
  };
  const repo = repoParts(ctx, again);
  const here = hereRows(u, repo);
  const freeCol = freeColumn(u, repo, go);
  const remoteCol = remoteColumn(repo, again, error);
  return h('section', {class: 'section device-part', 'aria-label': isNative ? t('This device') : t('This browser')},
    meter(total, u.host_free, u.allocated, t('{os} of {total} is this OS', {os: bytes(u.allocated), total: bytes(u.host_total)})),
    h('div', {class: 'legend'},
      figure(bytes(u.allocated), t('this OS')),
      figure(bytes(u.host_free), t('free'), known(u.host)),
      figure(bytes(u.host_total), isNative ? t('in all') : t('allowed'), known(u.host))),
    ...(last ? [result(last)] : []),
    // What is here, what is on the Remote, then what can be freed.
    h('div', {class: 'space-box'},
      column('here-col', isNative ? t('On this device') : t('In this browser'), u.allocated, here, t('No repos yet')),
      remoteCol, freeCol),
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
      why: async () => why,
      // Freed from its row: what it came to is said over the box, as Free all's is, and the columns read again.
      free: async () => { const r = await free([`repo:${name}`]); if (r.kept.length && !r.removed.length) throw new Error(r.kept[0][1]); freed = r; },
      freed: () => again(freed),
    }, !away),
  };
}

/** On this device: everything, largest first, and why what stays stays. */
function hereRows(u: Space, repo: RepoParts): HTMLElement[] {
  return u.items.map((i) => {
    const isRepo = i.id.startsWith('repo:');
    const repoNote = isRepo ? syncWord(repoState(i.what)) : '';
    // l3 is a command's name, written as code is (in the sans face its l reads as a capital I).
    const name = isRepo ? repo.name(i.what) : i.id === 'l3' ? h('code', {class: 'mono'}, i.what) : i.what;
    return thing(name, i.allocated, [i.detail, repoNote].filter(Boolean).join(' · '), null,
      i.room === 'Keep' ? i.why : '', isRepo ? repo.gear(i.what, i.room === 'Keep' ? i.why : null) : undefined);
  });
}

/**
 * Can be freed: Free; a repo's changes go to the Remote first, as they would anyway. Free all at its foot when there
 * is more than one; `go` frees what it is given, holding the buttons given while it does.
 */
function freeColumn(u: Space, repo: RepoParts, go: (ids: string[], held: HTMLButtonElement[]) => void): HTMLElement {
  const freeable = u.items.filter((i) => i.room !== 'Keep');
  const buttons: HTMLButtonElement[] = [];
  const going = freeable.map((i) => {
    const b = button(t('Free'));
    b.title = i.why;
    buttons.push(b);
    b.addEventListener('click', () => go([i.id], [b]));
    const isRepo = i.id.startsWith('repo:');
    return thing(isRepo ? repo.name(i.what) : i.what, i.allocated, '', b, i.why, isRepo ? repo.gear(i.what, null) : undefined);
  });
  const all = h('button', {class: 'button', type: 'button'}, t('Free all')) as HTMLButtonElement;
  all.addEventListener('click', () => go(freeable.map((i) => i.id), [all, ...buttons]));
  // Nothing to free, the reason is each one's own (not on the Remote yet, a Prompt in it): said on its row.
  return column('free-col', t('Can be freed'), u.freeable, going, t('Nothing to free: what stays here says why'),
    freeable.length > 1 ? [h('span', {class: 'muted small grow'}, t('Repos stay on the Remote and come back when opened.')), all] : []);
}

/** On the Remote: what can come here, each with Fetch; in the app, the release root too when it is not installed. */
function remoteColumn(repo: RepoParts, again: (r: Freed | null) => void, error: HTMLElement): HTMLElement {
  const coming: Node[] = remoteOnly().map((r) => {
    const b = button(t('Fetch'));
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await bring(r.name); again(null); } catch (e) { error.textContent = errorText(e); b.disabled = false; }
    });
    return thing(repo.name(r.name), r.bytes, t('repo · comes here, then opens'), b, '', repo.gear(r.name, t('It is only on the Remote: nothing of it is here to free'), true));
  });
  // What is only there, not all it holds: its size is what would come here.
  const col = column('remote-col', t('Only on the Remote'), remoteOnly().reduce((n, r) => n + r.bytes, 0), coming,
    connection() ? t('All of it is here too') : t('Sign in to see what the Remote holds'));
  if (isNative) void rootStatus().then((root) => { if (root && !root.current) rootRow(col, root, again); }, (e) => { error.textContent = errorText(e); });
  return col;
}

/** The release root, not installed: at the top of the column, with Fetch, its progress said in its row. */
function rootRow(col: HTMLElement, root: RootStatus, again: (r: Freed | null) => void) {
  const b = button(t('Fetch'));
  const note = h('span', {class: 'muted small'}, t('the root Prompts run on'));
  b.addEventListener('click', () => {
    b.disabled = true;
    void rootFetch((got, of, retry) => {
      note.textContent = retry ? t('{why}; continuing where it stopped', {why: retry}) : t('Fetching {got} / {of}', {got: bytes(got), of: bytes(of)});
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
  const seen = r.reflected_ms === null ? (isNative ? t('the device does not show it yet') : '')
    : t('device free space, observed: {sign}{size} ({how} · {ms} ms)', {sign: change >= 0 ? '+' : '−', size: bytes(Math.abs(change)), how: known(r.host_change) || t('counted'), ms: r.reflected_ms});
  return h('div', {class: 'reclaimed', role: 'status'},
    r.removed.length ? h('p', {}, h('b', {}, t('Let go of {size} allocated here', {size: bytes(r.freed)})), ` · ${tn('{n} thing', '{n} things', r.removed.length)}`) : null,
    seen ? h('p', {class: 'muted small'}, seen) : null,
    ...r.kept.map(([id, why]) => h('p', {class: 'muted small'}, t('Kept {what}: {why}', {what: id.replace(/^(repo|root|path):/, '').split('/').at(-1) ?? id, why}))));
}
