import {ago, bytes, h} from '../dom.ts';
import {isNative, rootFetch, rootStatus, rootUse, type Certainty, type Freed, type Space} from '../host.ts';
import {t, tn} from '../i18n.ts';
import {bring, onSync, remoteOnly, repoState} from '../lifecycle.ts';
import {connection, deviceWord, REMOTE_URL} from '../remote.ts';
import {mark} from '../icons.ts';
import desktopPins from '../../shared/desktop-releases.json' with {type: 'json'};
import * as dotfiles from '../dotfiles.ts';
import * as ssh from '../ssh.ts';
import {free, readSpace} from '../space.ts';
import {about, loadWebRoot} from '../userland.ts';
import {askFoot, copying, pageHead, SETTLE} from './common.ts';
import type {Context} from './context.ts';
import {syncWord} from './remote.ts';
import {allSessions, type Session} from './terminal.ts';
import {getState, setState} from '../state.ts';

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
//
// On the web, at the foot, the desktop app: a box with Download.

/** How a figure is known, in one word; a counted figure needs none. */
const known = (c: Certainty) => (c === 'Verified' ? '' : c === 'Estimated' ? t('estimated') : t('unknown'));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The environments a Prompt can run on, one row each: l3 (this OS's own
 * root), Ubuntu and Debian (their makers' roots, pinned by digest), and a
 * root of one's own. The one in effect is the place, an ink edge over
 * raised. In the app every other one can be used with a press: fetched if
 * it is not here, then the one Prompts run on, set up from .packages and
 * .setup at the next Prompt. In a browser only l3 runs (through xlat, which
 * does not link programs as they run); the others say where they do.
 */
function environment(): HTMLElement {
  const body = h('div', {class: 'env-choices'}, h('p', {class: 'muted'}, t('Reading…')));
  const row = (name: string, version: string, note: string | Node, current: boolean, end: Node | null, sha = '') =>
    h('div', {class: current ? 'env-choice' : 'env-choice later', 'aria-current': current ? 'true' : 'false'},
      h('b', {}, name), h('span', {}, version), typeof note === 'string' ? h('span', {class: current ? 'muted' : ''}, note) : note,
      sha ? h('code', {class: 'muted', title: sha}, sha.slice(0, 12)) : end ?? h('span', {}));
  const paint = async () => {
    let root: Awaited<ReturnType<typeof rootStatus>> = null;
    try { root = await rootStatus(); } catch (e) { body.replaceChildren(h('p', {class: 'error'}, message(e))); return; }
    if (isNative && root) {
      const now = root.current?.distro ?? (root.current ? 'l3' : null);
      // Pressed: fetched if it is not here, then the one in effect.
      const use = (id: string, note: HTMLElement) => {
        const b = button(t('Use'), 'small-button');
        b.addEventListener('click', () => {
          b.disabled = true;
          void rootUse(id, (got, of, retry) => {
            note.textContent = retry ?? t('Fetching {got} / {of}', {got: bytes(got), of: bytes(of)});
          }).then(() => paint(), (e) => { note.textContent = message(e); b.disabled = false; });
        });
        return b;
      };
      const line = (id: string, name: string, version: string, what: string, sha?: string) => {
        const note = h('span', {}, what);
        return row(name, version, note, now === id, now === id ? null : use(id, note), now === id ? sha : '');
      };
      const l3 = root.current && now === 'l3' ? root.current : null;
      body.replaceChildren(
        line('l3', 'l3', l3?.version ?? root.release.version, l3 ? t('{name} · {size}', {name: l3.name, size: bytes(l3.bytes)}) : root.release.name, l3?.sha256),
        ...root.distros.map((d) => {
          const held = root.current?.distro === d.id ? root.current : null;
          return line(d.id, d.name, d.version, held ? t('{name} · {size}', {name: d.name, size: bytes(held.bytes)}) : t('apt; .packages and .setup set it up'), held?.sha256);
        }),
        row(t('Custom'), '', t('Your own root (.tar)'), false, h('span', {class: 'small'}, t('Not yet'))));
      return;
    }
    let a: Awaited<ReturnType<typeof about>>, web: Awaited<ReturnType<typeof loadWebRoot>>;
    try { [a, web] = await Promise.all([about(), isNative ? null : loadWebRoot()]); } catch (e) { body.replaceChildren(h('p', {class: 'error'}, message(e))); return; }
    if (!a) { body.replaceChildren(h('div', {class: 'empty'}, t('There is no l3 (npm run userland)'))); return; }
    // In a browser with the whole root: every program of it, through xlat; else l3 and its BusyBox.
    const note = web
      ? t('{name} · through xlat', {name: a.root.name})
      : t('{name} · {base} {version} · {size}', {name: a.root.name, base: a.base.name, version: a.base.version, size: bytes(a.bundle.size)});
    body.replaceChildren(row('l3', web?.index.version || a.root.version, note, true, null, a.bundle.sha256),
      row('Ubuntu', '24.04.5 LTS', t('In the app only'), false, null),
      row('Debian', '13', t('In the app only'), false, null),
      row(t('Custom'), '', t('Your own root (.tar)'), false, h('span', {class: 'small'}, t('Not yet'))));
  };
  void paint();
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
    }, (e) => { error.textContent = message(e); });
  }

  return h('section', {class: 'section', 'aria-labelledby': 'device-title'},
    h('h2', {id: 'device-title'}, isNative ? t('This device') : t('This browser')),
    meter(total, u.host_free, u.allocated, t('{os} of {total} is this OS', {os: bytes(u.allocated), total: bytes(u.host_total)})),
    h('div', {class: 'legend'},
      figure(bytes(u.allocated), t('this OS')),
      figure(bytes(u.host_free), t('free'), known(u.host)),
      figure(bytes(u.host_total), isNative ? t('in all') : t('allowed'), known(u.host))),
    ...(last ? [result(last)] : []),
    // What is here, what is on the Remote, then what can be freed.
    h('div', {class: 'space-box'},
      column('here-col', isNative ? t('On this device') : t('In this browser'), u.allocated, here, t('No repos yet')),
      remoteCol,
      column('free-col', t('Can be freed'), u.freeable, going, t('Nothing to free. A repo goes once the Remote has all of it.'),
        freeable.length > 1 ? [h('span', {class: 'muted small grow'}, t('Repos stay on the Remote and come back when opened.')), all] : [])),
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
// Which repos' Prompts may reach the network: this device's grant (core's home `network`, which l3 reads too).
const granted = (): string[] => { try { return JSON.parse(getState('network') ?? '[]') as string[]; } catch { return []; } };
async function grant(repo: string, on: boolean) {
  const all = new Set(granted());
  if (on) all.add(repo); else all.delete(repo);
  await setState('network', JSON.stringify([...all].sort()));
}

/**
 * The network for a Prompt on the root, as a plain switch: a namespace cannot
 * be given a network once made, so turning it on asks, then stops the Prompt
 * (it has the network from its next start); turning it off stops it at once.
 */
function networkSwitch(repo: string, s: Session, card: () => HTMLElement): HTMLElement {
  const on = granted().includes(repo);
  const sw = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on),
    'aria-label': on ? t('Take the network from {repo}\'s Prompt', {repo}) : t('Give {repo}\'s Prompt the network', {repo})}, h('span', {class: 'knob'})) as HTMLButtonElement;
  const error = h('p', {class: 'error small', role: 'alert'});
  sw.addEventListener('click', () => {
    const el = card();
    if (on) { void grant(repo, false).then(() => s.stop(), (e) => { error.textContent = message(e); }); return; }
    sw.setAttribute('aria-checked', 'true');
    const was = [...el.childNodes];
    const no = button(t('Not now'), 'small-button'), yes = button(t('Give it'), 'small-button primary');
    no.addEventListener('click', () => el.replaceChildren(...was, error));
    yes.addEventListener('click', () => void grant(repo, true).then(() => s.stop(), (e) => { el.replaceChildren(...was, error); error.textContent = message(e); }));
    el.replaceChildren(h('span', {class: 'card-title'}, repo),
      h('p', {class: 'muted small'}, t('Its programs reach the network from its next start; it stops now.')),
      h('div', {class: 'card-foot'}, no, h('span', {class: 'grow'}), yes));
  });
  return h('div', {class: 'net-row'}, h('span', {class: 'muted small'}, t('Network')), sw, error);
}

function prompts(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'prompts-title', hidden: ''});
  // Each session is watched once, for as long as the page is shown.
  const watched = new Map<Session, () => void>();
  let first = true;
  const paint = () => {
    if (!first && !section.isConnected) { for (const u of watched.values()) u(); watched.clear(); return; }
    first = false;
    // Every session is heard, so one still starting is shown once it runs.
    for (const [, s] of allSessions()) if (!watched.has(s)) watched.set(s, s.watch(paint));
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
        const lines: (string | Node)[] = [[s.on === 'root' ? `root · ${tn('{n} process', '{n} processes', s.processes)}` : 'l3', s.memory ? bytes(s.memory) : ''].filter(Boolean).join(' · ')];
        if (s.freed !== null) lines.push(t('Gave back {size}', {size: bytes(s.freed)}));
        // Only the root's Prompt can have a network: in a browser its programs have no sockets at all.
        let el: HTMLElement | null = null;
        if (s.on === 'root') lines.push(networkSwitch(repo, s, () => el!));
        // 空ける sits at the left as it does on every card (Remote's off one too); Stop at the right.
        el = card(repo, lines, null);
        el.append(h('div', {class: 'card-foot'}, free, h('span', {class: 'grow'}), stop));
        return el;
      })));
  };
  paint();
  return section;
}

/**
 * SSH into a repo's Prompt, per device: a small card for each device that
 * listens, its destinations (one a repo, `ssh -p 22000 notes@192.168.1.5`,
 * each copied by a press), and the power switch at its bottom right, on:
 * pressed, that device stops taking connections and ends its sessions
 * within seconds. A page can only turn a device's SSH off; it is turned on
 * at the device itself (`l3 address`), and in the app this device's card is
 * there off too, its switch running the same l3 here. Read again every few
 * seconds while shown, so a device turned off elsewhere goes.
 */
function sshSection(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'ssh-title', hidden: ''});
  const power = (on: boolean, label: string, act: () => Promise<unknown>, said: HTMLElement) => {
    const b = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on), 'aria-label': label}, h('span', {class: 'knob'})) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      b.disabled = true;
      said.textContent = '';
      try { await act(); void paint(); } catch (e) { said.textContent = message(e); b.disabled = false; }
    });
    return b;
  };
  let timer = 0;
  const paint = async () => {
    window.clearTimeout(timer);
    if (!section.isConnected && section.dataset.drawn) return;
    section.dataset.drawn = '1';
    timer = window.setTimeout(() => void paint(), 5000);
    if (!connection()) { section.hidden = true; return; }
    const [list, mine] = await Promise.all([ssh.listening().catch(() => null), ssh.here().catch(() => null)]);
    if (!list) return;
    const cards = list.map((l) => {
      const said = h('p', {class: 'error small', role: 'alert'});
      const name = l.current ? (isNative ? t('This device') : t('This browser')) : deviceWord(l.agent);
      const dests = l.destinations.map((d) => { const b = h('button', {type: 'button', class: 'record-value'}, d); copying(b, d); return b; });
      const lines: (string | Node)[] = [...dests, ssh.quiet(l) ? t('Not heard from since {when}', {when: ago(l.seen)}) : t('On since {when}', {when: ago(l.since)}), said];
      // This device's own, in the app, goes off here (the listener stops at once); any other is told by the Remote.
      const off = () => (isNative && l.current ? ssh.setHere(false) : ssh.turnOff(l.device));
      return card(name, lines, power(true, t('Turn SSH off on {device}', {device: name}), off, said), 'ssh-card');
    });
    // In the app, this device when it does not listen: its switch turns it on (l3 address ssh on).
    if (isNative && mine && !list.some((l) => l.current)) {
      const said = h('p', {class: 'error small', role: 'alert'});
      cards.unshift(card(t('This device'), [t('SSH off. On, each repo here is reached with ssh, by a key in the .authorized_keys dotfile.'), said],
        power(false, t('Turn SSH on on this device'), () => ssh.setHere(true), said), 'ssh-card'));
    }
    section.hidden = false;
    section.replaceChildren(h('h2', {id: 'ssh-title'}, h('span', {}, 'SSH', list.length ? h('small', {}, `${list.length}`) : null)),
      cards.length ? h('div', {class: 'grid small-grid'}, ...cards)
        : h('p', {class: 'muted small'}, t('No device listens for SSH. It is turned on at the device: l3 address, or Runtime in the app.')));
  };
  void paint();
  return section;
}

/**
 * Dotfiles: a small card each (name, size), a dashed one to make another;
 * a card opens its text under them to edit. Every Prompt starts with them
 * in /root, and the Remote keeps them in step across devices. A Prompt
 * already running has what it started with (its shell has read them, and
 * its /root is its own), so a save says so under the box, with Start again;
 * Remove asks in the box first, since it goes from every device.
 */
function dotfilesSection(restarted: () => void): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'dot-title'});
  const editor = h('div', {});
  const running = () => allSessions().filter(([, s]) => s.running);
  const paint = (open: string | null = null, saved = false) => {
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
    editor.replaceChildren(...(open && open in all ? [edit(open, all[open], false, saved)] : []));
  };
  // The file's text in a box like Forge's, its name above (editable when new), Save and Remove.
  const edit = (name: string, text: string, fresh: boolean, saved = false): HTMLElement => {
    const error = h('p', {class: 'error', role: 'alert'});
    const title = h('input', {class: 'line-in mono dot-name', value: name, 'aria-label': t('Name'), spellcheck: 'false'}) as HTMLInputElement;
    title.disabled = !fresh;
    const body = h('textarea', {class: 'line-in mono dot-text', rows: '12', spellcheck: 'false', 'aria-label': name}) as HTMLTextAreaElement;
    body.value = text;
    const save = button(t('Save'), 'primary');
    save.addEventListener('click', async () => {
      const n = title.value.trim();
      try { await dotfiles.save(n, body.value); } catch (e) { error.textContent = message(e); return; }
      paint(n, true);
    });
    const remove = button(t('Remove'));
    remove.hidden = fresh;
    const close = button(t('Close'));
    close.addEventListener('click', () => paint());
    const acts = h('div', {class: 'row work-act'}, remove, h('span', {class: 'grow'}), close, save);
    const box = h('div', {class: 'dot-editor'}, h('div', {class: 'row dot-head'}, h('span', {class: 'muted mono'}, '/root/'), title), body, error, acts);
    // Asked in the box, where its deeds were: it goes from every device. Remove stays under the pointer, Not now at the right.
    remove.addEventListener('click', () => {
      const foot = askFoot(remove, box);
      const no = button(t('Not now')), yes = button(t('Remove'), 'primary');
      const ask = h('div', {class: 'dot-ask', role: 'group', 'aria-label': t('Remove {name}', {name})},
        h('p', {class: 'muted small'}, t('{name} goes from every device.', {name})),
        running().length ? h('p', {class: 'muted small'}, t('Prompts running keep it until they start again.')) : null,
        foot(no, yes));
      no.addEventListener('click', () => { ask.replaceWith(acts); remove.focus(); });
      const shown = performance.now();
      yes.addEventListener('click', async () => {
        if (performance.now() - shown < SETTLE) return;
        yes.disabled = true;
        try { await dotfiles.remove(name); paint(); } catch (e) { error.textContent = message(e); yes.disabled = false; }
      });
      acts.replaceWith(ask);
      yes.focus();
    });
    // Saved while Prompts run: they have what they started with until they start again. Under the box, so Save stays put.
    const now = saved ? running() : [];
    if (now.length) {
      const again = button(t('Start again'));
      again.addEventListener('click', () => { for (const [, s] of running()) s.restart(); note.remove(); restarted(); });
      const note = h('p', {class: 'muted small dot-note', role: 'status'},
        tn('The Prompt in {list} gets it when it starts again', 'The Prompts in {list} get it when they start again', now.length, {list: now.map(([repo]) => repo).join(', ')}), ' ', again);
      box.append(note);
    }
    return box;
  };
  paint();
  return section;
}

/** The release this build ships (RELEASE, through vite.config.ts). */
const RELEASE = (import.meta as {env?: Record<string, string>}).env?.VITE_LENGTH3_RELEASE ?? '';

/**
 * The desktop app, on the web only: one box, not wide, saying what it is
 * with its version and size, and Download (its icon and the word) at its
 * bottom left, as a deed that leaves the page for this computer. Download
 * gives the .deb (Debian, Ubuntu: most of x86-64 Linux); the AppImage, for
 * any other, is the quiet second choice beside it. Both come from the Remote
 * (the deploy puts the pinned files there), and each is offered only once
 * the Remote says it has it: without them the section is not shown.
 */
function desktopApp(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'app-title', hidden: ''});
  const pins = (desktopPins as Record<string, Partial<Record<'deb' | 'appimage', {file: string; bytes: number}>>>)[RELEASE] ?? {};
  const url = (file: string) => `${REMOTE_URL}/v1/desktop/${encodeURIComponent(file)}`;
  const there = async (file: string) => { try { return (await fetch(url(file), {method: 'HEAD'})).ok; } catch { return false; } };
  void (async () => {
    const [deb, appimage] = await Promise.all([pins.deb, pins.appimage].map(async (p) => (p && (await there(p.file)) ? p : null)));
    const first = deb ?? appimage;
    if (!first) return;
    const other = deb && appimage ? appimage : null;
    const get = h('a', {class: 'button primary small-button download', href: url(first.file), download: first.file}, mark('download'), h('span', {}, t('Download')));
    const also = other ? h('a', {class: 'button small-button', href: url(other.file), download: other.file,
      title: t('AppImage · {size} · for any other x86-64 Linux', {size: bytes(other.bytes)})}, 'AppImage') : null;
    // Its card is the SSH card's size, beside it: what it is, what it takes, and Download at its bottom left.
    section.replaceChildren(h('h2', {id: 'app-title'}, t('Desktop app')),
      h('div', {class: 'card small-card app-card'},
        h('span', {class: 'card-title'}, t('Length³ OS {version}', {version: RELEASE})),
        h('span', {class: 'muted small'}, t('Runs on this computer as an app.')),
        h('span', {class: 'muted small'}, first === deb ? t('x86-64 Linux · .deb · {size}', {size: bytes(first.bytes)})
          : t('x86-64 Linux · AppImage · {size}', {size: bytes(first.bytes)})),
        h('div', {class: 'card-foot'}, get, also, h('span', {class: 'grow'}))));
    section.hidden = false;
  })();
  return section;
}

/** Runtime: this device and what can go from it and come to it, the Prompts running, and the environment in effect. */
export function runtime(ctx: Context): Node[] {
  const holder = h('div', {}, h('section', {class: 'section'}, h('p', {class: 'muted'}, t('Measuring…'))));
  let last: Freed | null = null;
  const read = () => void readSpace(allSessions().filter(([, s]) => s.running).map(([repo]) => repo)).then(
    (u) => holder.replaceChildren(device(ctx, u, last, (r) => { last = r; read(); })),
    (e) => holder.replaceChildren(h('section', {class: 'section'}, h('p', {class: 'error'}, t('Could not measure ({why})', {why: message(e)})))));
  read();
  // What the Remote holds changes what can come here.
  const stop = onSync(() => { if (!holder.isConnected) { stop(); return; } read(); });
  // Prompts started again from Dotfiles are new sessions: the section is drawn again to follow them.
  let running = prompts();
  const restarted = () => { const next = prompts(); running.replaceWith(next); running = next; };
  // SSH and, on the web, the desktop app side by side: two small things this device can be reached by or become.
  // (The desktop app is offered on the web; the app itself is it.)
  return [pageHead('runtime'), holder, running, h('div', {class: 'section-row'}, sshSection(), ...(isNative ? [] : [desktopApp()])),
    h('section', {class: 'section', 'aria-labelledby': 'env-title'}, h('h2', {id: 'env-title'}, t('Environment in effect')), environment()),
    dotfilesSection(restarted)];
}
