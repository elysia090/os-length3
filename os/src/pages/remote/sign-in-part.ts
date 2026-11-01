import {ago, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import * as account from '../../remote/connection.ts';
import {errorText} from '../../app/errors.ts';
import {atSignIn, button, pressing} from './parts.ts';

// Remote's Sign-in part: what keeps the account: the passkeys, and the providers it can sign in with.

/**
 * What the Sign-in part holds: the passkeys and the providers; a Remote entered by its link (`enter`) has none to
 * manage. `ways`: what the Remote said it offers, just asked (Remote's page asks before drawing the part), which the
 * providers are drawn from.
 */
export function signInBody(ways: account.Ways): Node[] {
  return ways.enter ? [h('p', {class: 'muted'}, t('Accessed via invite link; session is valid for 24 hours.'))]
    : [passkeySection(), providerSection(ways)];
}

/** The passkeys this account has, each with when it was made and Remove; and Add a passkey. */
function passkeySection(): HTMLElement {
  const section = h('section', {class: 'sub-part', 'aria-labelledby': 'remote-keys'});
  const error = h('p', {class: 'error', role: 'alert'});
  const note = h('p', {class: 'muted small', role: 'status'});
  const paint = async () => {
    const list = await account.passkeys().catch((e) => { error.textContent = errorText(e); return []; });
    // Made where passkeys are: here on the web, in the browser from the app. Removed from either.
    const add = button(account.deedsHere() ? t('Add passkey') : t('Add in browser'), 'small-button');
    add.addEventListener('click', () => void pressing(add, error, async () => {
      if (!account.deedsHere()) { await atSignIn(note, paint); return; }
      await account.addPasskey(); await paint();
    }));
    section.replaceChildren(h('h3', {id: 'remote-keys'}, h('span', {}, t('Passkeys'), list.length ? h('small', {}, `${list.length}`) : null), add),
      h('div', {class: 'rows'}, ...(list.length ? list.map((k) => {
        const remove = button(t('Remove'), 'small-button');
        remove.addEventListener('click', () => void pressing(remove, error, async () => { await account.removePasskey(k.id); await paint(); }));
        return h('div', {class: 'row-item usage-prompt'}, h('span', {class: 'row-name'}, k.name || t('Passkey')),
          h('span', {class: 'row-meta'}, `${t('Created {when}', {when: ago(Date.parse(k.createdAt))})}${k.backedUp ? ` · ${t('Synced passkey')}` : ''}`), remove);
      }) : [h('div', {class: 'row-item muted'}, t('No passkeys registered'))])), note, error);
  };
  void paint();
  return section;
}

/** The providers this account signs in with: each is also the way back in; `ways`, those the Remote offers. */
function providerSection(ways: account.Ways): HTMLElement {
  const section = h('section', {class: 'sub-part', 'aria-labelledby': 'remote-providers'});
  const error = h('p', {class: 'error', role: 'alert'});
  const note = h('p', {class: 'muted small', role: 'status'});
  const paint = async () => {
    let mine: Awaited<ReturnType<typeof account.linked>>, offered: Awaited<ReturnType<typeof account.about>>;
    // What the Remote offers, as it said just before: asked again only when it could not say then.
    try { [mine, offered] = await Promise.all([account.linked(), ways.trouble ? account.about() : ways]); } catch (e) { error.textContent = errorText(e); return; }
    const have = new Set(mine.map((a) => a.providerId));
    const rows = mine.map((a) => {
      // The last provider is the way back in: it stays, with nothing to press.
      const off = mine.length > 1 ? button(t('Unlink'), 'small-button') : null;
      off?.addEventListener('click', () => void pressing(off, error, async () => { await account.unlink(a.providerId); await paint(); }));
      return h('div', {class: 'row-item usage-prompt'},
        h('span', {class: 'row-name'}, account.PROVIDER_NAME[a.providerId as account.Provider] ?? a.providerId),
        h('span', {class: 'row-meta'}, t('Linked {when}', {when: ago(Date.parse(a.createdAt))})), off);
    });
    const more = offered.providers.filter((p) => !have.has(p)).map((p) => {
      const b = button(t('Link {name}', {name: account.PROVIDER_NAME[p]}), 'small-button');
      // Linked where a provider comes back to: this page on the web, the browser from the app.
      b.addEventListener('click', () => void pressing(b, error, () => (account.deedsHere() ? account.link(p) : atSignIn(note, paint))));
      return b;
    });
    section.replaceChildren(h('h3', {id: 'remote-providers'}, h('span', {}, t('Sign-in providers'))), h('div', {class: 'rows'}, ...rows),
      ...(more.length ? [h('div', {class: 'row work-act'}, ...more)] : []), note, error);
  };
  void paint();
  return section;
}
