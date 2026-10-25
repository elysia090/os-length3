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
import {about} from '../userland.ts';
import {askFoot, copying, pageHead, parts, SETTLE} from './common.ts';
import type {Context} from './context.ts';
import {openRepoPlace, syncWord} from './remote.ts';
import {repoGear} from './repo-gear.ts';
import {allSessions, type Session} from './terminal.ts';
import {getState, setState} from '../state.ts';
import {every} from '../runs.ts';

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
// In parts, as Remote's page is: this device (the bar and the box), the
// Prompts running (offered while one runs), the environments (SSH, the
// environment in effect and, on the web, the desktop app, side by side), and
// the dotfiles. Only the part chosen shows; the others are hidden, never
// stopped or emptied (a Prompt runs on, a dotfile half written stays).

/** How a figure is known, in one word; a counted figure needs none. */
const known = (c: Certainty) => (c === 'Verified' ? '' : c === 'Estimated' ? t('estimated') : t('unknown'));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The environments a Prompt can run on, in one card: the one in effect at its
 * top (its name, its version in the mono face, what it is here, its digest),
 * then the others, a row each, quiet: Ubuntu and Debian (their makers' roots,
 * pinned by digest), and a root of one's own. In the app each other one can be
 * used with a press (Use, at its right): fetched if it is not here, then the
 * one Prompts run on, set up from .packages and .setup at the next Prompt. In
 * a browser only l3 runs (through xlat, which does not link programs as they
 * run); the others say where they do. Custom is not yet.
 */
function environment(): HTMLElement {
  const card = h('div', {class: 'card small-card env-card'}, h('span', {class: 'muted small'}, t('Reading…')));
  const version = (v: string) => (v ? h('span', {class: 'version'}, v) : null);
  /** The one in effect: the card's head. */
  const top = (name: string, v: string, note: string, sha: string) => [
    h('span', {class: 'card-title'}, name, ' ', version(v)), h('span', {class: 'muted small'}, note),
    ...(sha ? [h('code', {class: 'muted small env-sha', title: sha}, sha.slice(0, 12))] : [])];
  /** Another: its name and version, what it is (or its state), and at its right what can be done (or nothing). */
  const other = (name: string, v: string, note: string | Node, end: Node | null) =>
    h('div', {class: 'env-row', role: 'listitem'}, h('span', {class: 'env-name'}, name, ' ', version(v)),
      typeof note === 'string' ? h('span', {class: 'muted small env-note'}, note) : note, end);
  const others = (...rows: HTMLElement[]) => h('div', {class: 'env-rows', role: 'list', 'aria-label': t('Other environments')}, ...rows);
  const notYet = () => h('span', {class: 'muted small'}, t('Not yet'));
  const paint = async () => {
    let root: Awaited<ReturnType<typeof rootStatus>> = null;
    try { root = await rootStatus(); } catch (e) { card.replaceChildren(h('p', {class: 'error'}, message(e))); return; }
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
      const l3 = root.current && now === 'l3' ? root.current : null;
      const all = [
        {id: 'l3', name: 'l3', version: l3?.version ?? root.release.version, what: l3 ? t('{name} · {size}', {name: l3.name, size: bytes(l3.bytes)}) : root.release.name, sha: l3?.sha256 ?? ''},
        ...root.distros.map((d) => {
          const held = root.current?.distro === d.id ? root.current : null;
          return {id: d.id, name: d.name, version: d.version, what: held ? t('{name} · {size}', {name: d.name, size: bytes(held.bytes)}) : t('apt; .packages and .setup set it up'), sha: held?.sha256 ?? ''};
        })];
      const current = all.find((e) => e.id === now);
      card.replaceChildren(...(current ? top(current.name, current.version, current.what, current.sha) : [h('span', {class: 'card-title'}, t('Environment in effect'))]),
        others(...all.filter((e) => e !== current).map((e) => { const note = h('span', {class: 'muted small env-note'}, e.what); return other(e.name, e.version, note, use(e.id, note)); }),
          other(t('Custom'), '', t('Your own root (.tar)'), notYet())));
      return;
    }
    let a: Awaited<ReturnType<typeof about>>;
    try { a = await about(); } catch (e) { card.replaceChildren(h('p', {class: 'error'}, message(e))); return; }
    // The same l3 as the app's: its version, and the digest of the root it is (core/src/root.rs), run here through xlat.
    // A build that carries no l3 says so in l3's own row: Ubuntu, Debian and Custom are under it all the same.
    card.replaceChildren(...(a ? top('l3', a.version, t('{name} · through xlat', {name: a.root.name}), a.sha256)
      : top('l3', '', t('There is no l3 (npm run l3)'), '')),
      others(other('Ubuntu', '24.04.5 LTS', t('In the app only'), null),
        other('Debian', '13', t('In the app only'), null),
        other(t('Custom'), '', t('Your own root (.tar)'), notYet())));
  };
  void paint();
  return card;
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

  // A repo, in whichever column: its name is the repo itself (its own place), its gear Forge or Free, as on Home.
  const repoName = (name: string) => {
    const b = h('button', {type: 'button', class: 'link-name'}, name);
    b.addEventListener('click', () => openRepoPlace(ctx, name));
    return b;
  };
  let freed: Freed | null = null;
  const gearOf = (name: string, why: string | null, bring_ = false) => repoGear(name, {
    forge: async () => { if (bring_) await bring(name); ctx.openRepo(name); },
    why: async () => why,
    // Freed from its row: what it came to is said over the box, as Free all's is, and the columns read again.
    free: async () => { const r = await free([`repo:${name}`]); if (r.kept.length && !r.removed.length) throw new Error(r.kept[0][1]); freed = r; },
    freed: () => again(freed),
  });

  // On this device: everything, largest first, and why what stays stays.
  const here = u.items.map((i) => {
    const repo = i.id.startsWith('repo:');
    const repoNote = repo ? syncWord(repoState(i.what)) : '';
    // l3 is a command's name, written as code is (in the sans face its l reads as a capital I).
    const name = repo ? repoName(i.what) : i.id === 'l3' ? h('code', {class: 'mono'}, i.what) : i.what;
    return thing(name, i.allocated, [i.detail, repoNote].filter(Boolean).join(' · '), null,
      i.room === 'Keep' ? i.why : '', repo ? gearOf(i.what, i.room === 'Keep' ? i.why : null) : undefined);
  });

  // Can be freed: Free; a repo's changes go to the Remote first, as they would anyway.
  const freeable = u.items.filter((i) => i.room !== 'Keep');
  const going = freeable.map((i) => {
    const b = button(t('Free'));
    b.title = i.why;
    buttons.push(b);
    b.addEventListener('click', () => go([i.id], [b]));
    const repo = i.id.startsWith('repo:');
    return thing(repo ? repoName(i.what) : i.what, i.allocated, '', b, i.why, repo ? gearOf(i.what, null) : undefined);
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
    return thing(repoName(r.name), r.bytes, t('repo · comes here, then opens'), b, '', gearOf(r.name, t('It is only on the Remote: nothing of it is here to free'), true));
  });
  // What is only there, not all it holds: its size is what would come here.
  const remoteCol = column('remote-col', t('Only on the Remote'), remoteOnly().reduce((n, r) => n + r.bytes, 0), coming,
    connection() ? t('All of it is here too') : t('Sign in to see what the Remote holds'));
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
      remoteCol,
      // Nothing to free, the reason is each one's own (not on the Remote yet, a Prompt in it): said on its row.
      column('free-col', t('Can be freed'), u.freeable, going, t('Nothing to free: what stays here says why'),
        freeable.length > 1 ? [h('span', {class: 'muted small grow'}, t('Repos stay on the Remote and come back when opened.')), all] : [])),
    error);
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

/** A small card: what it is, quietly what it holds, and its action at the bottom right. */
function card(name: string, lines: (string | Node)[], act: Node | null, extra = ''): HTMLElement {
  return h('div', {class: `card small-card ${extra}`.trim()},
    h('span', {class: 'card-title'}, name),
    ...lines.filter(Boolean).map((l) => (typeof l === 'string' ? h('span', {class: 'muted small'}, l) : l)),
    act ? h('div', {class: 'card-foot'}, h('span', {class: 'grow'}), act) : null);
}

/** The repos whose Prompt was stopped from its card just now, until their card says so (and lights what it gave back). */
const stoppedNow = new Set<string>();

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

/**
 * The Prompts running. `shown(n, any)` hears how many run and whether there is any to show (running, or stopped
 * here with what it gave back); `changed` hears when which repos have a Prompt running changes (one stopped, or
 * started), so what holds a repo is read again then, not at the next page.
 */
function prompts(shown_: (running: number, any: boolean) => void = () => {}, changed: () => void = () => {}): HTMLElement {
  const section = h('section', {class: 'section prompts-part', 'aria-label': t('Prompts running'), hidden: ''});
  let had = '';
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
    shown_(running, shown.length > 0);
    const now = shown.filter(([, s]) => s.running).map(([repo]) => repo).sort().join('\n');
    if (now !== had) { const before = had; had = now; if (before || now) changed(); }
    section.replaceChildren(
      h('div', {class: 'grid small-grid'}, ...shown.map(([repo, s]) => {
        if (!watched.has(s)) watched.set(s, s.watch(paint));
        if (!s.running && s.stopped) {
          const st = s.stopped;
          // Stopped just now from here: what it gave back is lit a moment, the reward for stopping it.
          const now = !st.left && stoppedNow.delete(repo);
          return card(repo, [st.left ? tn('{n} left', '{n} left', st.left)
            : `${t('Stopped · gave back {size}', {size: bytes(st.before.memory)})}${st.ms !== null ? ` · ${st.ms} ms` : ''}`], null, now ? 'quiet just-stopped' : 'quiet');
        }
        const stop = button(t('Stop'), 'small-button');
        stop.addEventListener('click', () => { stoppedNow.add(repo); s.stop(); });
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
 * SSH into a repo's Prompt. SSH is the desktop app's: a device turns it on
 * itself, and where it is reached never leaves it. In the app, this device's
 * card says, plainly, what it is: each repo's destination (copied by a
 * press), who may connect (this device only, or PCs on the same network
 * too), how many keys are let in, and the host key ssh shows the first time;
 * its power switch asks from where before it turns on (this device only
 * first). Every other device of the account that listens is a small card of
 * its own, its name and to whom, with nothing of where, and its switch turns
 * it off: that device stops taking connections and ends its sessions within
 * seconds. On the web, one line says SSH is the app's, over those cards.
 * Read again every few seconds while shown, so a device turned off elsewhere
 * goes.
 */
function sshSection(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'ssh-title', hidden: ''});
  const power = (on: boolean, label: string, act: () => Promise<unknown> | void, said: HTMLElement) => {
    const b = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on), 'aria-label': label}, h('span', {class: 'knob'})) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      b.disabled = true;
      said.textContent = '';
      try { const done = act(); if (done) { await done; void paint(); } else b.disabled = false; } catch (e) { said.textContent = message(e); b.disabled = false; }
    });
    return b;
  };
  const whom = (s: ssh.Scope) => (s === 'network' ? t('Listens for SSH from its network\'s PCs too') : t('Listens for SSH from that device only'));
  /** This device's card, in the app: what it is, plainly, worked out here (core ssh::Here). */
  const mine = (m: ssh.Here): HTMLElement => {
    const said = h('p', {class: 'error small', role: 'alert'});
    const keys = tn('{n} key let in (.authorized_keys)', '{n} keys let in (.authorized_keys)', m.keys);
    if (!m.on) {
      let el: HTMLElement | null = null;
      // Pressed, it asks from where first, in the card, as the network grant asks (the scope kept is offered first).
      const ask = () => {
        const was = [...el!.childNodes];
        const choose = (scope: ssh.Scope, label: string) => {
          const b = button(label, `small-button${scope === m.scope ? ' primary' : ''}`);
          b.addEventListener('click', () => {
            for (const x of el!.querySelectorAll('button')) (x as HTMLButtonElement).disabled = true;
            void ssh.setHere(true, scope).then(() => paint(), (e) => { el!.replaceChildren(...was); said.textContent = message(e); });
          });
          return b;
        };
        const not = button(t('Not now'), 'small-button');
        not.addEventListener('click', () => el!.replaceChildren(...was));
        el!.replaceChildren(h('span', {class: 'card-title'}, t('This device')),
          h('span', {class: 'muted small'}, t('Who may connect?')),
          choose('device', t('This device only')), h('span', {class: 'muted small'}, t('No other PC finds it.')),
          choose('network', t('The same network too')), h('span', {class: 'muted small'}, t('PCs on this LAN or VPN; never the Internet.')),
          said, h('div', {class: 'card-foot'}, not, h('span', {class: 'grow'})));
      };
      el = card(t('This device'), [t('SSH off. On, each repo here is reached with ssh, by a key in the .authorized_keys dotfile.'), keys, said],
        power(false, t('Turn SSH on on this device'), ask, said), 'ssh-card');
      return el;
    }
    const dests = m.destinations.map((d) => { const b = h('button', {type: 'button', class: 'record-value'}, d); copying(b, d); return b; });
    const lan = ssh.lan(m);
    const scope = m.scope === 'network'
      ? (lan.length ? t('From PCs on the same network too ({list}); never from the Internet', {list: lan.join(', ')})
        : t('From PCs on the same network too (no LAN or VPN address here now)'))
      : t('From this device only (127.0.0.1): no other PC finds it');
    const print = m.fingerprint ? h('button', {type: 'button', class: 'record-value'}, m.fingerprint) : null;
    if (print && m.fingerprint) copying(print, m.fingerprint);
    const el = card(t('This device'), [...dests, scope, keys,
      ...(print ? [h('span', {class: 'muted small'}, t('Host key, as ssh shows it the first time:')), print] : []),
      m.started ? t('On since {when}', {when: ago(m.started)}) : '', said], null, 'ssh-card');
    // The other scope, at once (its sessions from elsewhere end when it narrows); off at the right.
    const other: ssh.Scope = m.scope === 'network' ? 'device' : 'network';
    const change = button(other === 'network' ? t('The same network too') : t('This device only'));
    change.addEventListener('click', () => { change.disabled = true; void ssh.setHere(true, other).then(() => paint(), (e) => { said.textContent = message(e); change.disabled = false; }); });
    el.append(h('div', {class: 'card-foot'}, change, h('span', {class: 'grow'}), power(true, t('Turn SSH off on {device}', {device: t('This device')}), () => ssh.setHere(false), said)));
    return el;
  };
  const paint = async () => {
    if (!section.isConnected && section.dataset.drawn) return;
    section.dataset.drawn = '1';
    if (!connection()) { section.hidden = true; return; }
    const [list, here] = await Promise.all([ssh.listening().catch(() => null), ssh.here().catch(() => null)]);
    if (!list) return;
    // This device's own is the app's card, from what it has here; the Remote's row for it says no more.
    const others = list.filter((l) => !(isNative && l.current));
    const cards = others.map((l) => {
      const said = h('p', {class: 'error small', role: 'alert'});
      const name = deviceWord(l.agent);
      const lines: (string | Node)[] = [whom(l.scope), ssh.quiet(l) ? t('Not heard from since {when}', {when: ago(l.seen)}) : t('On since {when}', {when: ago(l.since)}), said];
      return card(name, lines, power(true, t('Turn SSH off on {device}', {device: name}), () => ssh.turnOff(l.device), said), 'ssh-card');
    });
    if (isNative && here) cards.unshift(mine(here));
    const count = others.length + (here?.on ? 1 : 0);
    section.hidden = false;
    section.replaceChildren(h('h2', {id: 'ssh-title'}, h('span', {}, 'SSH', count ? h('small', {}, `${count}`) : null)),
      ...(isNative ? [] : [h('p', {class: 'muted small'}, t('SSH is the desktop app\'s: a device turns it on there, and its addresses stay on it.'))]),
      ...(cards.length ? [h('div', {class: 'grid small-grid'}, ...cards)] : []));
  };
  // Drawn again now and then while it is on screen, not while the page or app is hidden, slower while nobody is at it,
  // and not at all once nobody has been for ten minutes (when each device was last heard is the database's to say,
  // not the mark's: service/mark.ts), until someone is back, when it is drawn at once.
  void paint().then(() => every(15_000, paint, {alive: () => section.isConnected, restsWhenAway: true}));
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
function dotfilesSection(restarted: () => void, counted: (n: number) => void = () => {}): HTMLElement {
  const section = h('section', {class: 'section dotfiles-part', 'aria-label': t('Dotfiles')});
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
    counted(names.length);
    section.replaceChildren(h('div', {class: 'grid small-grid'}, ...cards, make), editor);
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
 * The desktop app, on the web only: one small card, saying what it is (Length³,
 * its version apart in the mono face) and which file with its size, and
 * Download (its icon and the word, a size smaller than a small button) at its
 * bottom left, as a deed that leaves the page for this computer. Download
 * gives the .deb (Debian, Ubuntu: most of x86-64 Linux), or the AppImage when
 * the Remote has no .deb; one download only. Both come from the Remote (the
 * deploy puts the pinned files there), and one is offered only once the Remote
 * says it has it: without either the section is not shown.
 */
function desktopApp(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'app-title', hidden: ''});
  const pins = (desktopPins as Record<string, Partial<Record<'deb' | 'appimage', {file: string; bytes: number}>>>)[RELEASE] ?? {};
  const url = (file: string) => `${REMOTE_URL}/v1/desktop/${encodeURIComponent(file)}`;
  const there = async (file: string) => { try { return (await fetch(url(file), {method: 'HEAD'})).ok; } catch { return false; } };
  void (async () => {
    const deb = pins.deb && (await there(pins.deb.file)) ? pins.deb : null;
    const first = deb ?? (pins.appimage && (await there(pins.appimage.file)) ? pins.appimage : null);
    if (!first) return;
    const what = first === deb ? t('x86-64 Linux · .deb · {size}', {size: bytes(first.bytes)}) : t('x86-64 Linux · AppImage · {size}', {size: bytes(first.bytes)});
    const get = h('a', {class: 'button primary small-button download', href: url(first.file), download: first.file, title: `${first.file} · ${bytes(first.bytes)}`},
      mark('download'), h('span', {}, t('Download')));
    // Beside the environments, the same small card: what it is, which file and its size, and Download at its bottom left.
    section.replaceChildren(h('h2', {id: 'app-title'}, t('Desktop app')),
      h('div', {class: 'card small-card app-card'},
        // The product's name, and its version apart: a name and a number are two things.
        h('span', {class: 'card-title'}, 'Length³', ' ', h('span', {class: 'version'}, RELEASE)),
        h('span', {class: 'muted small'}, what),
        h('div', {class: 'card-foot'}, get, h('span', {class: 'grow'}))));
    section.hidden = false;
  })();
  return section;
}

/**
 * Runtime, in parts as Remote's page is: this device and what can go from it and come to it, the Prompts
 * running (offered while there is one), the environments, and the dotfiles. Hidden parts go on: a Prompt runs,
 * what is read is read again, a dotfile half written stays.
 */
export function runtime(ctx: Context): Node[] {
  const page = parts<'device' | 'prompts' | 'environments' | 'dotfiles'>('runtime', [
    {id: 'device', label: isNative ? t('This device') : t('This browser')}, {id: 'prompts', label: t('Prompts running')},
    {id: 'environments', label: t('Environments')}, {id: 'dotfiles', label: t('Dotfiles')}]);
  const holder = h('div', {}, h('section', {class: 'section'}, h('p', {class: 'muted'}, t('Measuring…'))));
  let last: Freed | null = null;
  const read = (): void => void readSpace(allSessions().filter(([, s]) => s.running).map(([repo]) => repo)).then((u) => {
    // A repo's gear list out is not drawn away under the pointer: read again once it is put away.
    if (holder.isConnected && holder.querySelector('.repo-gear-pop:not([hidden])')) { setTimeout(read, 1000); return; }
    holder.replaceChildren(device(ctx, u, last, (r) => { last = r; read(); }));
  },
    (e) => holder.replaceChildren(h('section', {class: 'section'}, h('p', {class: 'error'}, t('Could not measure ({why})', {why: message(e)})))));
  read();
  // What the Remote holds changes what can come here.
  const stop = onSync(() => { if (!holder.isConnected) { stop(); return; } read(); });
  // Prompts started again from Dotfiles are new sessions: the section is drawn again to follow them. Its part is
  // offered while one runs (or one stopped here says what it gave back); a Prompt stopped or started reads again
  // what holds each repo, so its row says at once whether it can be freed.
  const heard = (n: number, any: boolean) => { page.count('prompts', n); page.offer('prompts', any); };
  const following = () => { if (holder.isConnected) read(); };
  let running = prompts(heard, following);
  const restarted = () => { const next = prompts(heard, following); running.replaceWith(next); running = next; };
  page.panel('device').append(holder);
  page.panel('prompts').append(running);
  // The environments and, on the web, the desktop app one to their right: how this device runs, or becomes the
  // app. SSH, how it is reached, under the two. (The desktop app is offered on the web; the app itself is it.)
  page.panel('environments').append(h('div', {class: 'section-row'},
    h('section', {class: 'section', 'aria-labelledby': 'env-title'}, h('h2', {id: 'env-title'}, t('Environment in effect')), environment()),
    ...(isNative ? [] : [desktopApp()])), sshSection());
  page.panel('dotfiles').append(dotfilesSection(restarted, (n) => page.count('dotfiles', n)));
  return [pageHead('runtime'), h('div', {class: 'part-bar'}, page.switch),
    page.panel('device'), page.panel('prompts'), page.panel('environments'), page.panel('dotfiles')];
}
