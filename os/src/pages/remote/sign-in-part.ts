import {ago, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import * as account from '../../remote/connection.ts';
import {errorText} from '../../app/errors.ts';
import {atSignIn, button, pressing} from './parts.ts';

// Remote's Sign-in part: what keeps the account, the passkeys, the code a repo is turned off with, and the
// providers it can sign in with.

/**
 * What the Sign-in part holds: the passkeys, the code and the providers; a Remote entered by its link (`enter`) has
 * no passkeys or providers to manage, only the code a repo is turned off with. `ways`: what the Remote said it offers,
 * just asked (Remote's page asks before drawing the part), which the providers are drawn from.
 */
export function signInBody(ways: account.Ways): Node[] {
  return ways.enter ? [h('p', {class: 'muted'}, t('You came in by the link you were given; each time lasts a day.')), codeSection()]
    : [passkeySection(), codeSection(), providerSection(ways)];
}

/** The code turning a repo off asks for: five letters or digits, set with a passkey. */
function codeSection(): HTMLElement {
  const section = h('section', {class: 'sub-part', 'aria-labelledby': 'remote-code'});
  const error = h('p', {class: 'error', role: 'alert'});
  const note = h('p', {class: 'muted small', role: 'status'});
  const paint = async () => {
    const now = await account.offCode().catch(() => ({set: false, setAt: null}));
    // Set with a passkey: typed here on the web; in the app, in the browser, where the passkey is.
    const five = account.deedsHere() ? h('input', {class: 'line-in mono code-in', maxlength: '5', placeholder: t('New code'), 'aria-label': t('Code'), autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement : null;
    const set = button(five ? now.set ? t('Set another') : t('Set') : now.set ? t('Set another in the browser') : t('Set in the browser'), 'small-button');
    set.addEventListener('click', () => void pressing(set, error, async () => {
      if (!five) { await atSignIn(note, paint); return; }
      if (!/^[A-Za-z0-9]{5}$/.test(five.value)) throw new Error(t('Five letters or digits.'));
      await account.setOffCode(five.value);
      await paint();
    }));
    section.replaceChildren(h('h3', {id: 'remote-code'}, h('span', {}, t('Code to turn a repo off'))),
      h('div', {class: 'rows'}, h('div', {class: 'row-item usage-prompt'},
        h('span', {class: 'row-name'}, now.set ? t('Set {when}', {when: ago(now.setAt ?? 0)}) : t('Not set')), five, set)), note, error);
  };
  void paint();
  return section;
}

/** The passkeys this account has, each with when it was made and Remove; and Add a passkey. */
function passkeySection(): HTMLElement {
  const section = h('section', {class: 'sub-part', 'aria-labelledby': 'remote-keys'});
  const error = h('p', {class: 'error', role: 'alert'});
  const note = h('p', {class: 'muted small', role: 'status'});
  const paint = async () => {
    const list = await account.passkeys().catch((e) => { error.textContent = errorText(e); return []; });
    // Made where passkeys are: here on the web, in the browser from the app. Removed from either.
    const add = button(account.deedsHere() ? t('Add a passkey') : t('Add in the browser'), 'small-button');
    add.addEventListener('click', () => void pressing(add, error, async () => {
      if (!account.deedsHere()) { await atSignIn(note, paint); return; }
      await account.addPasskey(); await paint();
    }));
    section.replaceChildren(h('h3', {id: 'remote-keys'}, h('span', {}, t('Passkeys'), list.length ? h('small', {}, `${list.length}`) : null), add),
      h('div', {class: 'rows'}, ...(list.length ? list.map((k) => {
        const remove = button(t('Remove'), 'small-button');
        remove.addEventListener('click', () => void pressing(remove, error, async () => { await account.removePasskey(k.id); await paint(); }));
        return h('div', {class: 'row-item usage-prompt'}, h('span', {class: 'row-name'}, k.name || t('Passkey')),
          h('span', {class: 'row-meta'}, `${t('Made {when}', {when: ago(Date.parse(k.createdAt))})}${k.backedUp ? ` · ${t('synced passkey')}` : ''}`), remove);
      }) : [h('div', {class: 'row-item muted'}, t('No passkeys yet'))])), note, error);
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
