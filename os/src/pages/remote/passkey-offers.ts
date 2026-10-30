import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import * as account from '../../remote/connection.ts';
import {putAway} from '../../ui/glide.ts';
import {answers} from '../common.ts';
import {atSignIn, button, pressing} from './parts.ts';

// A passkey offered while the account has none: once at the top of Remote's page just after a provider's
// sign-in, and under the repos until there is one (it is what lets a repo be turned off).

/**
 * Just back from a provider, with no passkey yet: the next step offered once, at the top of Remote's page, saying
 * what it is for (the next sign-in, without the provider; and it confirms turning a repo off) and what to do if
 * the device is lost. Later puts it off: the offer under the repos stays until there is one.
 */
export function passkeyNext(done: () => void, later: () => void): HTMLElement {
  const box = h('section', {class: 'sub-part passkey-next', hidden: '', 'aria-labelledby': 'passkey-next'});
  if (!account.passkeysHere()) return box;
  const error = h('p', {class: 'error', role: 'alert'});
  void account.passkeys().then((list) => {
    if (list.length) { account.passkeyOfferDone(); return; }
    const no = button(t('Later')), add = button(t('Add passkey'), 'primary');
    // Put off: gone from the top; the offer under the repos stays until there is a passkey.
    no.addEventListener('click', () => { account.passkeyOfferDone(); putAway(box, () => { box.hidden = true; }, {fold: true}); later(); });
    add.addEventListener('click', () => void pressing(add, error, async () => {
      await account.addPasskey();
      account.passkeyOfferDone();
      box.replaceChildren(h('p', {class: 'sign-in-step done', role: 'status'}, t('Passkey added')));
      // Said, then gone: the page is the repos again.
      setTimeout(() => putAway(box, () => { box.hidden = true; }, {fold: true}), 6000);
      done();
    }));
    box.hidden = false;
    box.replaceChildren(h('h3', {id: 'passkey-next'}, h('span', {}, t('Add passkey'))),
      h('p', {class: 'muted'}, t('You can now sign in using only this passkey.')),
      answers(no, add), error);
  }, () => {});
  return box;
}

/** No passkey yet: the button, which says it; shown once what it stands under is there (`after`), not before it to be pushed down. */
export function passkeyOffer(added: () => void, after: Promise<void>): HTMLElement {
  const box = h('section', {class: 'offer-holder', hidden: ''});
  const error = h('p', {class: 'error', role: 'alert'});
  void Promise.all([account.passkeys(), after]).then(([list]) => {
    if (list.length) return;
    // An offer beside the page's work, not the work: the page's ink stays on its repos.
    const add = button(t('Add passkey'), 'small-button');
    const note = h('p', {class: 'muted small', role: 'status'});
    // In the app, made in the browser: gone once the account has one, when the window comes back.
    const seen = async () => { if ((await account.passkeys().catch(() => [])).length) { box.hidden = true; added(); } };
    add.addEventListener('click', () => void pressing(add, error, async () => {
      if (!account.deedsHere()) { await atSignIn(note, seen); return; }
      await account.addPasskey(); box.hidden = true; added();
    }));
    box.hidden = false;
    // An offer goes on: at the right, as every deed that goes on is.
    box.replaceChildren(answers(null, add), note, error);
  }, () => {});
  return box;
}
