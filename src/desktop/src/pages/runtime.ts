import {bytes, h} from '../dom.ts';
import {isNative, rootFetch, rootStatus, type Certainty, type Freed, type Space} from '../host.ts';
import {t, tn} from '../i18n.ts';
import {bring, onSync, remoteOnly, repoState} from '../lifecycle.ts';
import {connection} from '../remote.ts';
import * as dotfiles from '../dotfiles.ts';
import * as inbox from '../inbox.ts';
import {free, readSpace} from '../space.ts';
import {about, loadWebRoot} from '../userland.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';
import {syncWord} from './remote.ts';
import {allSessions, type Session} from './terminal.ts';

// Runtime: this device, then what the OS holds on it, then what is running,
// then the environment actually in effect (what runs, not what was asked for).
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
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The environments a Prompt can run on, one row each. l3 (this OS's own
 * root) is the one in effect: the place, an ink edge over raised. Ubuntu,
 * Debian and a root of one's own are not here yet; they say so, quiet and
 * dashed, with where each could run: their programs are linked when they
 * run, which xlat does not do, so not in a browser.
 */
function environment(): HTMLElement {
  const body = h('div', {class: 'env-choices'}, h('p', {class: 'muted'}, t('Reading…')));
  const row = (name: string, version: string, note: string, current: boolean, sha = '') =>
    h('div', {class: current ? 'env-choice' : 'env-choice later', 'aria-current': current ? 'true' : 'false'},
      h('b', {}, name), h('span', {}, version), h('span', {class: current ? 'muted' : ''}, note),
      sha ? h('code', {class: 'muted', title: sha}, sha.slice(0, 12)) : h('span', {class: 'small'}, current ? '' : t('Not yet')));
  const later = () => {
    const where = isNative ? t('Its own programs, on this device\'s kernel') : t('In the app only: its programs are linked as they run, which a browser does not do');
    return [
      row('Ubuntu', '24.04 LTS', where, false),
      row('Debian', '13', where, false),
      row(t('Custom'), '', t('A root of your own (.tar), known by its digest'), false),
    ];
  };
  void (async () => {
    const root = isNative ? await rootStatus().catch(() => null) : null;
    if (root?.current) {
      const r = root.current;
      body.replaceChildren(row('l3', r.version, t('{name} · {size} · on this device\'s kernel', {name: r.name, size: bytes(r.bytes)}), true, r.sha256), ...later());
      return;
    }
    const [a, web] = await Promise.all([about(), isNative ? null : loadWebRoot()]);
    if (!a) { body.replaceChildren(h('div', {class: 'empty'}, t('There is no l3 (npm run userland)'))); return; }
    // In a browser with the whole root: every program of it, through xlat; else l3 and its BusyBox.
    const note = web
      ? t('{name} · the whole root, each file fetched when a program first reads it · through xlat in this browser', {name: a.root.name})
      : t('{name} · l3 and {base} {version} · {size}, {how}', {name: a.root.name, base: a.base.name, version: a.base.version, size: bytes(a.bundle.size), how: isNative ? t('comes with the app') : t('fetched at each visit')});
    body.replaceChildren(row('l3', web?.index.version || a.root.version, note, true, a.bundle.sha256), ...later());
  })();
  return body;
}

/** A bar of the whole: this OS's part, everything else's, and what is free. */
function meter(total: number, free: number, mine: number, label: string) {
  const pct = (v: number) => `${Math.min(100, (v / total) * 100).toFixed(2)}%`;
  const app = h('span', {class: 'app'}); app.style.width = pct(mine);
  const other = h('span'); other.style.width = pct(Math.max(0, total - free - mine));
  return h('div', {class: 'meter', role: 'img', 'aria-label': label}, app, other);
}

const figure = (value: string, word: string, note = '') =>
  h('span', {}, h('b', {}, value), word, note ? h('small', {class: 'muted'}, ` ${note}`) : null);

function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {class: `button small-button ${kind}`.trim(), type: 'button'}, text) as HTMLButtonElement;
}

/** One column of the box: a heading with its total, its rows, and what goes at its foot. */
function column(id: string, title: string, total: number | null, rows: Node[], empty: string, foot: Node[] = []): HTMLElement {
  return h('section', {class: 'space-col', 'aria-labelledby': id},
    h('h3', {id}, h('span', {}, title), total === null ? null : h('b', {}, bytes(total))),
    h('div', {class: 'space-list'}, ...(rows.length ? rows : [h('p', {class: 'muted small space-empty'}, empty)])),
    ...(foot.length ? [h('div', {class: 'space-foot'}, ...foot)] : []));
}

const thing = (name: Node | string, size: number | null, note: string, act?: Node) =>
  h('div', {class: 'space-row'},
    h('div', {class: 'space-what'}, h('span', {class: 'space-name'}, name), h('span', {class: 'muted small'}, note)),
    size === null ? null : h('span', {class: 'space-size'}, bytes(size)), act ?? null);

/**
 * This device: the bar and its figures, then the box of three columns. What
 * the last 空ける did stays in view while the figures are read again.
 */
function device(ctx: Context, u: Space, last: Freed | null, again: (r: Freed | null) => void): HTMLElement {
  const total = u.host_total || 1;
  const error = h('p', {class: 'error', role: 'alert'});
  const buttons: HTMLButtonElement[] = [];
  const go = (ids: string[], held: HTMLButtonElement[]) => {
    for (const b of held) b.disabled = true;
    void free(ids).then(again, (e) => {
      for (const b of held) b.disabled = false;
      error.textContent = message(e);
    });
  };

  // On this device: everything, largest first; a repo opens in Forge.
  const here = u.items.map((i) => {
    const name: Node | string = i.id.startsWith('repo:') ? (() => {
      const b = h('button', {type: 'button', class: 'link-name'}, i.what);
      b.addEventListener('click', () => ctx.openRepo(i.what));
      return b;
    })() : i.what;
    const repoNote = i.id.startsWith('repo:') ? syncWord(repoState(i.what)) : '';
    return thing(name, i.allocated, [i.detail, repoNote, i.room === 'Keep' ? i.why : ''].filter(Boolean).join(' · '));
  });

  // Can be freed: Free; a repo's changes go to the Remote first, as they would anyway.
  const freeable = u.items.filter((i) => i.room !== 'Keep');
  const going = freeable.map((i) => {
    const b = button(t('Free'));
    b.title = i.why;
    buttons.push(b);
    b.addEventListener('click', () => go([i.id], [b]));
    return thing(i.what, i.allocated, i.why, b);
  });
  const all = h('button', {class: 'button', type: 'button'}, t('Free all')) as HTMLButtonElement;
  all.addEventListener('click', () => go(freeable.map((i) => i.id), [all, ...buttons]));

  // On the Remote: what can come here.
  const coming: Node[] = remoteOnly().map((r) => {
    const b = button(t('Fetch'));
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await bring(r.name); again(null); } catch (e) { error.textContent = message(e); b.disabled = false; }
    });
    return thing(r.name, r.bytes, t('repo · comes here, then opens'), b);
  });
  const remoteCol = column('remote-col', t('On the Remote'), remoteOnly().reduce((n, r) => n + r.bytes, 0), coming,
    connection() ? t('Everything on the Remote is here too.') : t('Sign in to the Remote to see what it holds.'));
  if (isNative) {
    void rootStatus().then((root) => {
      if (!root || root.current) return;
      const b = button(t('Fetch'));
      const note = h('span', {class: 'muted small'}, t('the root Prompts run on'));
      b.addEventListener('click', () => {
        b.disabled = true;
        void rootFetch((got, of, retry) => {
          note.textContent = retry ? t('{why}; continuing where it stopped', {why: retry}) : t('Fetching {got} / {of}', {got: bytes(got), of: bytes(of)});
        }).then(() => again(null), (e) => { note.textContent = message(e); b.disabled = false; });
      });
      const row = h('div', {class: 'space-row'},
        h('div', {class: 'space-what'}, h('span', {class: 'space-name'}, `${root.release.name} ${root.release.version}`), note),
        h('span', {class: 'space-size'}, bytes(root.release.bytes)), b);
      remoteCol.querySelector('.space-empty')?.remove();
      remoteCol.querySelector('.space-list')!.prepend(row);
    });
  }

  return h('section', {class: 'section', 'aria-labelledby': 'device-title'},
    h('h2', {id: 'device-title'}, isNative ? t('This device') : t('This browser')),
    meter(total, u.host_free, u.allocated, t('{os} of {total} is this OS', {os: bytes(u.allocated), total: bytes(u.host_total)})),
    h('div', {class: 'legend'},
      figure(bytes(u.allocated), t('this OS')),
      figure(bytes(u.host_free), t('free'), known(u.host)),
      figure(bytes(u.host_total), isNative ? t('in all') : t('allowed'), known(u.host))),
    ...(last ? [result(last)] : []),
    h('div', {class: 'space-box'},
      column('here-col', isNative ? t('On this device') : t('In this browser'), u.allocated, here, t('This OS keeps nothing here yet')),
      column('free-col', t('Can be freed'), u.freeable, going, t('Nothing to free. A repo goes once the Remote has all of it.'),
        freeable.length > 1 ? [h('span', {class: 'muted small grow'}, t('Repos stay on the Remote and come back when opened.')), all] : []),
      remoteCol),
    error);
}

/** What freeing did: counted bytes, and the host's free space as it was seen to change. */
function result(r: Freed): HTMLElement {
  const change = r.host_free_after - r.host_free_before;
  const seen = r.reflected_ms === null ? (isNative ? t('the device does not show it yet') : '')
    : t('device free space {sign}{size} ({how} · {ms} ms)', {sign: change >= 0 ? '+' : '−', size: bytes(Math.abs(change)), how: known(r.host_change) || t('counted'), ms: r.reflected_ms});
  return h('div', {class: 'reclaimed', role: 'status'},
    r.removed.length ? h('p', {}, h('b', {}, t('Freed {size}', {size: bytes(r.freed)})), ` · ${tn('{n} thing', '{n} things', r.removed.length)}`) : null,
    seen ? h('p', {class: 'muted small'}, seen) : null,
    ...r.kept.map(([id, why]) => h('p', {class: 'muted small'}, t('Kept {what}: {why}', {what: id.replace(/^(repo|root|path):/, '').split('/').at(-1) ?? id, why}))));
}

/** A small card: what it is, quietly what it holds, and its action at the bottom right. */
function card(name: string, lines: (string | Node)[], act: Node | null, extra = ''): HTMLElement {
  return h('div', {class: `card small-card ${extra}`.trim()},
    h('span', {class: 'card-title'}, name),
    ...lines.filter(Boolean).map((l) => (typeof l === 'string' ? h('span', {class: 'muted small'}, l) : l)),
    act ? h('div', {class: 'card-foot'}, h('span', {class: 'grow'}), act) : null);
}

/** The Prompts running, each a small card: where it runs, the memory it holds, and Stop. Shown only when one runs. */
function prompts(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'prompts-title', hidden: ''});
  // Each session is watched once, for as long as the page is shown.
  const watched = new Map<Session, () => void>();
  let first = true;
  const paint = () => {
    if (!first && !section.isConnected) { for (const u of watched.values()) u(); watched.clear(); return; }
    first = false;
    // Running ones, and ones stopped here, with what stopping gave back.
    const shown = allSessions().filter(([, s]) => s.running || s.stopped);
    section.hidden = !shown.length;
    const running = shown.filter(([, s]) => s.running).length;
    section.replaceChildren(h('h2', {id: 'prompts-title'}, h('span', {}, t('Prompts running'), running ? h('small', {}, `${running}`) : null)),
      h('div', {class: 'grid small-grid'}, ...shown.map(([repo, s]) => {
        if (!watched.has(s)) watched.set(s, s.watch(paint));
        if (!s.running && s.stopped) {
          const st = s.stopped;
          return card(repo, [st.left ? tn('{n} left', '{n} left', st.left)
            : `${t('Stopped · gave back {size}', {size: bytes(st.before.memory)})}${st.ms !== null ? ` · ${st.ms} ms` : ''}`], null, 'quiet');
        }
        const stop = button(t('Stop'), 'small-button');
        stop.addEventListener('click', () => s.stop());
        // In a browser, what it keeps for programs it ran can go without stopping it.
        const free = s.spare ? button(t('Free {size}', {size: bytes(s.spare)}), 'small-button') : null;
        free?.addEventListener('click', () => s.free());
        const lines = [[s.on === 'root' ? `root · ${tn('{n} process', '{n} processes', s.processes)}` : 'l3', s.memory ? bytes(s.memory) : ''].filter(Boolean).join(' · ')];
        if (s.freed !== null) lines.push(t('Gave back {size}', {size: bytes(s.freed)}));
        return card(repo, lines, free ? h('span', {class: 'row'}, free, stop) : stop);
      })));
  };
  paint();
  return section;
}

/**
 * SSH, per Inbox address: a power switch that says whether the address may
 * be reached over SSH. Turning it on records that it is allowed; connecting
 * over SSH is not built yet, and the card says so.
 */
function ssh(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'ssh-title', hidden: ''});
  const paint = async () => {
    if (!connection()) return;
    const me = await inbox.me().catch(() => null);
    if (!me?.addresses.length) return;
    section.hidden = false;
    section.replaceChildren(h('h2', {id: 'ssh-title'}, 'SSH'),
      h('div', {class: 'grid small-grid'}, ...me.addresses.map((a) => {
        const power = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(a.ssh),
          'aria-label': a.ssh ? t('Do not allow SSH to {address}', {address: a.address}) : t('Allow SSH to {address}', {address: a.address})}, h('span', {class: 'knob'})) as HTMLButtonElement;
        power.addEventListener('click', async () => { power.disabled = true; await inbox.setSsh(a.address, !a.ssh).catch(() => {}); void paint(); });
        return card(a.address, [t('Connecting is not built yet')], power, 'mono-title');
      })));
  };
  void paint();
  return section;
}

/**
 * Dotfiles: a small card each (name, size), a dashed one to make another;
 * a card opens its text under them to edit. Every Prompt starts with them
 * in /root, and the Remote keeps them in step across devices.
 */
function dotfilesSection(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'dot-title'});
  const editor = h('div', {});
  const paint = (open: string | null = null) => {
    const all = dotfiles.read();
    const names = Object.keys(all).sort();
    const cards = names.map((n) => {
      const c = card(n, [bytes(new TextEncoder().encode(all[n]).length)], null, `mono-title openable${n === open ? ' current' : ''}`);
      c.tabIndex = 0;
      c.setAttribute('role', 'button');
      c.addEventListener('click', () => paint(n));
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter') paint(n); });
      return c;
    });
    const make = h('button', {type: 'button', class: 'card small-card new'}, '+', h('span', {}, t('New dotfile')));
    make.addEventListener('click', () => {
      const name = dotfiles.COMMON.find((c) => !(c in all)) ?? '.config';
      editor.replaceChildren(edit(name, '', true));
      editor.querySelector<HTMLInputElement>('input')?.select();
    });
    section.replaceChildren(h('h2', {id: 'dot-title'}, h('span', {}, t('Dotfiles'), names.length ? h('small', {}, `${names.length}`) : null)),
      h('div', {class: 'grid small-grid'}, ...cards, make), editor);
    editor.replaceChildren(...(open && open in all ? [edit(open, all[open], false)] : []));
  };
  // The file's text in a box like Forge's, its name above (editable when new), Save and Remove.
  const edit = (name: string, text: string, fresh: boolean): HTMLElement => {
    const error = h('p', {class: 'error', role: 'alert'});
    const title = h('input', {class: 'line-in mono dot-name', value: name, 'aria-label': t('Name'), spellcheck: 'false'}) as HTMLInputElement;
    title.disabled = !fresh;
    const body = h('textarea', {class: 'line-in mono dot-text', rows: '12', spellcheck: 'false', 'aria-label': name}) as HTMLTextAreaElement;
    body.value = text;
    const save = button(t('Save'), 'primary');
    save.addEventListener('click', async () => {
      const n = title.value.trim();
      if (!dotfiles.validName(n)) { error.textContent = t('A dotfile is named with a dot first: .profile'); return; }
      const all = dotfiles.read();
      all[n] = body.value;
      await dotfiles.write(all);
      paint(n);
    });
    const remove = button(t('Remove'));
    remove.hidden = fresh;
    remove.addEventListener('click', async () => { const all = dotfiles.read(); delete all[name]; await dotfiles.write(all); paint(); });
    const close = button(t('Close'));
    close.addEventListener('click', () => paint());
    return h('div', {class: 'dot-editor'}, h('div', {class: 'row dot-head'}, h('span', {class: 'muted mono'}, '/root/'), title), body, error,
      h('div', {class: 'row work-act'}, remove, h('span', {class: 'grow'}), close, save));
  };
  paint();
  return section;
}

/** Runtime: this device and what can go from it and come to it, the Prompts running, and the environment in effect. */
export function runtime(ctx: Context): Node[] {
  const holder = h('div', {}, h('section', {class: 'section'}, h('p', {class: 'muted'}, t('Measuring…'))));
  let last: Freed | null = null;
  const read = () => void readSpace(allSessions().filter(([, s]) => s.running).map(([repo]) => repo)).then((u) => {
    holder.replaceChildren(u ? device(ctx, u, last, (r) => { last = r; read(); })
      : h('section', {class: 'section'}, h('p', {class: 'muted'}, t('Could not measure'))));
  });
  read();
  // What the Remote holds changes what can come here.
  const stop = onSync(() => { if (!holder.isConnected) { stop(); return; } read(); });
  return [pageHead('runtime'), holder, prompts(), ssh(),
    h('section', {class: 'section', 'aria-labelledby': 'env-title'}, h('h2', {id: 'env-title'}, t('Environment in effect')), environment()),
    dotfilesSection()];
}
