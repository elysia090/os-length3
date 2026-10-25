import {day, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {shown as named} from '../../remote/inbox.ts';
import * as servers from '../../remote/servers.ts';
import {copying} from '../common.ts';
import {errorText} from '../../app/errors.ts';
import type {GearWays} from './gear.ts';
import {askIn, button, foot, smallCard} from './parts.ts';

// Behind the gear, a board's guests, where it takes them: any of its people invites someone, by a link they pass on
// themselves (the Remote sends nothing), for one person, shown only when it is made. Each revokes their own
// invitations and removes whom they invited; its owner, any. Narrowing is at once; a guest removed, with what they
// wrote, is asked in the card first.

/** The card of board `b`'s guests and invitations, with Invite a guest at its foot. */
export function guestsCard(b: servers.BoardRef, w: GearWays): HTMLElement {
  const rows = h('div', {class: 'guest-rows'});
  const made = h('div', {class: 'guest-link'});
  const said = h('p', {class: 'error small', role: 'alert'});
  const ask = button(t('Invite a guest'), 'small-button primary');
  const c = smallCard(t('Guests of #{board}', {board: b.name}), rows, made, said, foot(ask));
  const fill = async () => {
    try {
      const {invites, guests} = await servers.guestsOf(b.id);
      if (!w.still()) return;
      const people = guests.map((g) => guestRow(c, b, g, w));
      const out = invites.map((x) => inviteRow(b, x, said, fill));
      rows.replaceChildren(...people, ...out);
      if (!people.length && !out.length) rows.append(h('span', {class: 'muted small'}, t('No guests yet.')));
    } catch (e) { rows.replaceChildren(h('p', {class: 'error small'}, errorText(e))); }
  };
  ask.addEventListener('click', async () => {
    ask.disabled = true;
    said.textContent = '';
    try {
      const got = await servers.invite(b.id);
      // The link is said once: pressed, it is copied; the Remote keeps only its digest.
      const link = h('button', {type: 'button', class: 'button small-button mono guest-link-text', 'aria-label': t('The invitation\'s link')}, got.link) as HTMLButtonElement;
      copying(link, got.link);
      made.replaceChildren(link, h('span', {class: 'muted small'}, t('Pass it on yourself, to one person. It lets them in once, until {date}, and is shown only now.', {date: day(got.until)})));
      await fill();
    } catch (e) { said.textContent = errorText(e); }
    ask.disabled = false;
  });
  void fill();
  return c;
}

/** A line of the card: who or what, quietly what more, and its deed at the right. */
const row = (text: string, sub: string, act: HTMLButtonElement | null) =>
  h('div', {class: 'card-row'}, h('span', {class: 'grow'}, text, sub ? h('span', {class: 'muted small'}, ` · ${sub}`) : null), act);

/** A guest, and who invited them; Remove, asked in card `c`, where they may be removed. */
function guestRow(c: HTMLElement, b: servers.BoardRef, g: servers.Guest, w: GearWays): HTMLElement {
  const out = g.mayRemove ? button(t('Remove'), 'small-button') : null;
  out?.addEventListener('click', () => askIn(c, out, g.name, [t('{name} no longer writes in #{board}.', {name: g.name, board: b.name}), t('What they wrote there is taken down.')],
    t('Remove'), async () => { await servers.removeGuest(b.id, g.id); w.again(); }));
  return row(`${g.name} (${t('guest')})`, t('invited by {who}', {who: named(g.by)}), out);
}

/** An invitation not used yet, until when; Revoke, at once, where it may be revoked, and the card read again. */
function inviteRow(b: servers.BoardRef, x: servers.Invitation, said: HTMLElement, fill: () => Promise<void>): HTMLElement {
  const revoke = x.mayRevoke ? button(t('Revoke'), 'small-button') : null;
  revoke?.addEventListener('click', async () => {
    revoke.disabled = true;
    try { await servers.revokeInvite(b.id, x.id); await fill(); } catch (e) { revoke.disabled = false; said.textContent = errorText(e); }
  });
  return row(t('An invitation from {who}', {who: named(x.by)}), t('until {date}', {date: day(x.until)}), revoke);
}
