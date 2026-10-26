import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import * as remote from '../../remote/connection.ts';
import {signInBox} from './sign-in.ts';
import {answers} from '../common.ts';
import {errorText} from '../../app/errors.ts';

// The page a device's code opens (?device&user_code=…): l3 or the app asks
// to join this account. The person signs in here if not already (and comes
// back here from the provider), sees which device asks and its code, and
// lets it in or not.

const client = (id: string) => (id === 'l3' ? t('l3 (the command line)') : id === 'length3-app' ? t('the Length³ OS app') : id);

/** The page for the code `given` (none: it is typed here first). */
export function devicePage(given: string): HTMLElement {
  let code = given.trim().toUpperCase();
  const body = h('div', {class: 'remote-join'});
  // The same place as signing in on the Remote page, for every step: the code, signing in, letting it in.
  const page = h('main', {class: 'device-page sign-in-place'},
    h('section', {class: 'sign-in-card', 'aria-labelledby': 'device-title'}, h('h1', {id: 'device-title'}, t('Connect a device')), body));
  const error = h('p', {class: 'error', role: 'alert'});
  const finish = (text: string) => body.replaceChildren(h('p', {}, text), h('p', {class: 'muted'}, t('You can close this tab.')));
  const ask = async () => {
    if (!code) { body.replaceChildren(...typing((typed) => { code = typed; void ask(); })); return; }
    if (!remote.connection() && !(await remote.claim())) {
      body.replaceChildren(signInBox(() => void ask(), remote.signedInURL()));
      return;
    }
    let who: {clientId: string; status: string};
    try { who = await remote.deviceAsking(code); } catch (e) {
      // The device flow's own words (invalid_request, expired_token) are not for reading: said as what they mean, and
      // the way on, another code.
      const why = errorText(e);
      const another = h('button', {class: 'button', type: 'button'}, t('Type another code'));
      another.addEventListener('click', () => { code = ''; void ask(); });
      body.replaceChildren(h('p', {class: 'error', role: 'alert'}, t('This code cannot be used.')),
        h('p', {class: 'muted small'}, /^[a-z_]+$/.test(why) ? t('It has run out or was typed wrong: the device shows a new one when it is asked again.') : why), another);
      return;
    }
    body.replaceChildren(...letIn(code, who.clientId, error, finish));
  };
  void ask();
  return page;
}

/** No code given: the one the device shows, typed here, and Next (`next`, with the code). */
function typing(next: (code: string) => void): Node[] {
  const typed = h('input', {class: 'line-in mono', placeholder: 'XXXXXXXX', 'aria-label': t('The device\'s code'), autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
  const go = () => { const code = typed.value.trim().toUpperCase(); if (code) next(code); };
  const on = h('button', {class: 'button primary', type: 'button'}, t('Next'));
  on.addEventListener('click', go);
  typed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
  return [h('p', {}, t('Enter the code the device shows.')), h('div', {class: 'row'}, typed, on)];
}

/** Which device asks (`clientId`) and its code, to check against the device's; Connect or Refuse, then `finish`. */
function letIn(code: string, clientId: string, error: HTMLElement, finish: (text: string) => void): Node[] {
  const yes = h('button', {class: 'button primary', type: 'button'}, t('Connect')) as HTMLButtonElement;
  const no = h('button', {class: 'button', type: 'button'}, t('Refuse')) as HTMLButtonElement;
  yes.addEventListener('click', async () => {
    yes.disabled = no.disabled = true;
    try { await remote.approveDevice(code); finish(t('Connected. Go back to the device.')); } catch (e) { error.textContent = errorText(e); yes.disabled = no.disabled = false; }
  });
  no.addEventListener('click', async () => {
    yes.disabled = no.disabled = true;
    // Refused only once the Remote says so; until then the device could still be let in.
    try { await remote.denyDevice(code); finish(t('Refused.')); } catch (e) { error.textContent = errorText(e); yes.disabled = no.disabled = false; }
  });
  return [h('p', {}, t('{client} asks to join this account. Check that the device shows the same code.', {client: client(clientId)})),
    h('p', {class: 'device-code mono'}, code), answers(no, yes), error];
}
