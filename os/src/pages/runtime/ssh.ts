import {ago, h} from '../../ui/dom.ts';
import {isNative} from '../../app/host.ts';
import {t, tn} from '../../i18n.ts';
import {connection, deviceWord} from '../../remote/connection.ts';
import * as ssh from '../../prompt/ssh.ts';
import {copying} from '../common.ts';
import {every} from '../../app/runs.ts';
import {errorText} from '../../app/errors.ts';
import {button, card} from './parts.ts';

// Runtime's SSH: who listens for it on this account's devices, and this device's own, in the app.

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
export function sshSection(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'ssh-title', hidden: ''});
  const again = () => void paint();
  const paint = async () => {
    if (!section.isConnected && section.dataset.drawn) return;
    section.dataset.drawn = '1';
    if (!connection()) { section.hidden = true; return; }
    const [list, here] = await Promise.all([ssh.listening().catch(() => null), ssh.here().catch(() => null)]);
    if (!list) return;
    // This device's own is the app's card, from what it has here; the Remote's row for it says no more.
    const others = list.filter((l) => !(isNative && l.current));
    const cards = others.map((l) => otherCard(l, again));
    if (isNative && here) cards.unshift(hereCard(here, again));
    const count = others.length + (here?.on ? 1 : 0);
    section.hidden = false;
    section.replaceChildren(h('h2', {id: 'ssh-title'}, h('span', {}, 'SSH', count ? h('small', {}, `${count}`) : null)),
      ...(isNative ? [] : [h('p', {class: 'muted small'}, t('SSH is desktop-exclusive. Enabled locally; network addresses are not published.'))]),
      ...(cards.length ? [h('div', {class: 'grid small-grid'}, ...cards)] : []));
  };
  // Drawn again now and then while it is on screen, not while the page or app is hidden, slower while nobody is at it,
  // and not at all once nobody has been for ten minutes (when each device was last heard is the database's to say,
  // not the mark's: service/mark.ts), until someone is back, when it is drawn at once.
  void paint().then(() => every(15_000, paint, {alive: () => section.isConnected, restsWhenAway: true}));
  return section;
}

/**
 * A device's SSH switch: pressed, `act`; once what it does is done the section is read again (`again`), and what
 * failed is said in `said`. An `act` that only asks first (nothing to wait for) leaves the switch to be pressed again.
 */
function power(on: boolean, label: string, act: () => Promise<unknown> | void, said: HTMLElement, again: () => void) {
  const b = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on), 'aria-label': label}, h('span', {class: 'knob'})) as HTMLButtonElement;
  b.addEventListener('click', async () => {
    b.disabled = true;
    said.textContent = '';
    try { const done = act(); if (done) { await done; again(); } else b.disabled = false; } catch (e) { said.textContent = errorText(e); b.disabled = false; }
  });
  return b;
}

const whom = (s: ssh.Scope) => (s === 'network' ? t('Listening for SSH from local network devices') : t('Listening for SSH from this device only'));

/** Another device of the account that listens: its name and to whom, and its switch, which turns it off there. */
function otherCard(l: ssh.Listening, again: () => void): HTMLElement {
  const said = h('p', {class: 'error small', role: 'alert'});
  const name = deviceWord(l.agent);
  const lines: (string | Node)[] = [whom(l.scope), ssh.quiet(l) ? t('No signal since {when}', {when: ago(l.seen)}) : t('Active since {when}', {when: ago(l.since)}), said];
  return card(name, lines, power(true, t('Disable SSH on {device}', {device: name}), () => ssh.turnOff(l.device), said, again), 'ssh-card');
}

/** This device's card, in the app: what it is, plainly, worked out here (core ssh::Here). */
function hereCard(m: ssh.Here, again: () => void): HTMLElement {
  const said = h('p', {class: 'error small', role: 'alert'});
  const keys = tn('{n} key authorized (.authorized_keys)', '{n} keys authorized (.authorized_keys)', m.keys);
  return m.on ? onCard(m, keys, said, again) : offCard(m, keys, said, again);
}

/** Off: what it would be, and its switch. */
function offCard(m: ssh.Here, keys: string, said: HTMLElement, again: () => void): HTMLElement {
  let el: HTMLElement | null = null;
  // Pressed, it asks from where first, in the card, as the network grant asks (the scope kept is offered first).
  el = card(t('This device'), [t('SSH is disabled. When enabled, access repos via SSH using keys in .authorized_keys.'), keys, said],
    power(false, t('Enable SSH on this device'), () => askScope(el!, m, said, again), said, again), 'ssh-card');
  return el;
}

/** Who may connect, asked in the card `el` before SSH goes on: this device only, or the same network too; or Not now. */
function askScope(el: HTMLElement, m: ssh.Here, said: HTMLElement, again: () => void) {
  const was = [...el.childNodes];
  const choose = (scope: ssh.Scope, label: string) => {
    const b = button(label, `small-button${scope === m.scope ? ' primary' : ''}`);
    b.addEventListener('click', () => {
      for (const x of el.querySelectorAll('button')) (x as HTMLButtonElement).disabled = true;
      void ssh.setHere(true, scope).then(() => again(), (e) => { el.replaceChildren(...was); said.textContent = errorText(e); });
    });
    return b;
  };
  const not = button(t('Cancel'), 'small-button');
  not.addEventListener('click', () => el.replaceChildren(...was));
  el.replaceChildren(h('span', {class: 'card-title'}, t('This device')),
    h('span', {class: 'muted small'}, t('Allowed connections')),
    choose('device', t('This device only')), h('span', {class: 'muted small'}, t('Inaccessible to other machines.')),
    choose('network', t('Local network')), h('span', {class: 'muted small'}, t('Allows local LAN or VPN devices; blocked from Internet.')),
    said, h('div', {class: 'card-foot'}, not, h('span', {class: 'grow'})));
}

/** On: each repo's destination and the host key (copied by a press), who may connect, the keys let in; the other scope, and off. */
function onCard(m: ssh.Here, keys: string, said: HTMLElement, again: () => void): HTMLElement {
  const dests = m.destinations.map((d) => { const b = h('button', {type: 'button', class: 'record-value'}, d); copying(b, d); return b; });
  const print = m.fingerprint ? h('button', {type: 'button', class: 'record-value'}, m.fingerprint) : null;
  if (print && m.fingerprint) copying(print, m.fingerprint);
  const el = card(t('This device'), [...dests, reachedFrom(m), keys,
    ...(print ? [h('span', {class: 'muted small'}, t('Host key (presented on initial SSH connection):')), print] : []),
    m.started ? t('Active since {when}', {when: ago(m.started)}) : '', said], null, 'ssh-card');
  // The other scope, at once (its sessions from elsewhere end when it narrows); off at the right.
  const other: ssh.Scope = m.scope === 'network' ? 'device' : 'network';
  const change = button(other === 'network' ? t('Local network') : t('This device only'));
  change.addEventListener('click', () => { change.disabled = true; void ssh.setHere(true, other).then(() => again(), (e) => { said.textContent = errorText(e); change.disabled = false; }); });
  el.append(h('div', {class: 'card-foot'}, change, h('span', {class: 'grow'}),
    power(true, t('Disable SSH on {device}', {device: t('This device')}), () => ssh.setHere(false), said, again)));
  return el;
}

/** Who may connect, in words: this device only, or the same network too (and its addresses here, if any). */
function reachedFrom(m: ssh.Here): string {
  const lan = ssh.lan(m);
  return m.scope === 'network'
    ? (lan.length ? t('Local network devices allowed ({list}); blocked from Internet', {list: lan.join(', ')})
      : t('Local network devices allowed (no active LAN/VPN address detected)'))
    : t('Localhost only (127.0.0.1): invisible to network');
}
