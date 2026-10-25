import {ago, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import * as account from '../../remote/connection.ts';
import {askFoot, SETTLE} from '../common.ts';
import {button, message, pressing} from './parts.ts';

// Remote's Devices part: the devices signed in to the account, and signing one out.

/**
 * The devices signed in: each and when it was last used, this one marked.
 * Any other is signed out from its row (the same Remote call as `l3 remote
 * devices rm N`), asked in the row first, Sign out where it was pressed and
 * Not now at the left; this one signs out from the person's menu.
 */
export function deviceSection(counted: (n: number) => void): HTMLElement {
  const section = h('div', {class: 'sub-part'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const list = await account.devices().catch((e) => { error.textContent = message(e); return []; });
    counted(list.length);
    section.replaceChildren(h('div', {class: 'rows'}, ...list.map((d) => deviceRow(d, paint))), error);
  };
  void paint();
  return section;
}

function deviceRow(d: account.Device, again: () => Promise<void>): HTMLElement {
  const name = account.deviceWord(d.userAgent);
  const out = d.current ? null : button(t('Sign out'), 'small-button');
  out?.setAttribute('aria-label', t('Sign out {name}', {name}));
  const row = h('div', {class: 'row-item usage-prompt'}, ...head(d, name), out);
  out?.addEventListener('click', () => askOut(d, name, row, out, again));
  return row;
}

/** Which one it is: its word and when it was last used (two browsers of a kind read the same). */
const head = (d: account.Device, name: string) => [h('span', {class: 'row-name'}, name), d.current ? h('span', {class: 'row-meta'}, t('This device')) : null,
  h('span', {class: 'row-meta'}, t('Used {when}', {when: ago(Date.parse(d.updatedAt))}))];

/** Signing `d` out, asked in its `row` first, pressed at `out`; signed out, the devices are read again (`again`). */
function askOut(d: account.Device, name: string, row: HTMLElement, out: HTMLButtonElement, again: () => Promise<void>) {
  const foot = askFoot(out, row);
  const error = h('p', {class: 'error small', role: 'alert'});
  const no = button(t('Not now'), 'small-button'), yes = button(t('Sign out'), 'small-button primary');
  const ask = h('div', {class: 'row-ask', role: 'group', 'aria-label': t('Sign out {name}', {name})},
    h('div', {class: 'row-item'}, ...head(d, name)),
    h('p', {class: 'muted small'}, t('It is signed out at once.')),
    h('p', {class: 'muted small'}, t('What is on it stays there; signing in again brings it back.')), error, foot(no, yes));
  no.addEventListener('click', () => { ask.replaceWith(row); out.focus(); });
  const shown = performance.now();
  yes.addEventListener('click', () => {
    if (performance.now() - shown < SETTLE) return;
    void pressing(yes, error, async () => { await account.endDevice(d); await again(); });
  });
  row.replaceWith(ask);
  yes.focus();
}
