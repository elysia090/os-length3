import {ago, h} from '../../ui/dom.ts';
import {isNative} from '../../app/host.ts';
import {t, tn} from '../../i18n.ts';
import {connection, deviceWord} from '../../remote/connection.ts';
import * as ssh from '../../prompt/ssh.ts';
import {copying} from '../common.ts';
import {every} from '../../app/runs.ts';
import {button, card, message} from './parts.ts';

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
