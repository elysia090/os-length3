import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import * as remote from '../../remote/connection.ts';
import {signInBox} from './sign-in.ts';
import {answers} from '../common.ts';
import {errorText} from '../../app/errors.ts';

// The page a device's code opens (?device&user_code=…): l3 or the app asks
// to join this account. The person signs in here if not already (and comes
// back here from the provider), sees which device asks and its code, and
// lets it in or not. Remote's Devices takes a code the same way (joining).

const client = (id: string) => (id === 'l3' ? t('l3 (CLI)') : id === 'length3-app' ? t('Length³ OS App') : id);

/** The page for the code `given` (none: it is typed here first). */
export function devicePage(given: string): HTMLElement {
  const body = h('div', {class: 'remote-join'});
  // The same place as signing in on the Remote page, for every step: the code, signing in, letting it in.
  const page = h('main', {class: 'device-page sign-in-place'},
    h('section', {class: 'sign-in-card', 'aria-labelledby': 'device-title'}, h('h1', {id: 'device-title'}, t('Connect device')), body));
  joining(body, given, (text) => body.replaceChildren(h('p', {}, text), h('p', {class: 'muted'}, t('You may close this tab.'))));
  return page;
}

/** Where the steps are: the code to type, which device asks (to let in or not), or what came of it. */
type JoinStep = 'code' | 'asking' | 'done';

/**
 * A device's code taken in `body`, step by step, as the page its link opens does it and Remote's Devices: the code
 * (typed, none `given`), signing in when no one is, which device asks and its code, then Connect or Refuse; `finish`
 * says what came of it in `body`, and `stepped` hears each step as it is shown.
 */
export function joining(body: HTMLElement, given: string, finish: (text: string) => void, stepped: (s: JoinStep) => void = () => {}) {
  let code = given.trim().toUpperCase();
  const error = h('p', {class: 'error', role: 'alert'});
  const done = (text: string) => { finish(text); stepped('done'); };
  const ask = async () => {
    if (!code) { body.replaceChildren(...typing((typed) => { code = typed; void ask(); })); stepped('code'); return; }
    if (!remote.connection() && !(await remote.claim())) {
      body.replaceChildren(signInBox(() => void ask(), remote.signedInURL()));
      return;
    }
    let who: {clientId: string; status: string};
    try { who = await remote.deviceAsking(code); } catch (e) {
      // The device flow's own words (invalid_request, expired_token) are not for reading: said as what they mean, and
      // the way on, another code.
      const why = errorText(e);
      const another = h('button', {class: 'button', type: 'button'}, t('Enter another code'));
      another.addEventListener('click', () => { code = ''; void ask(); });
      body.replaceChildren(h('p', {class: 'error', role: 'alert'}, t('Invalid code.')),
        h('p', {class: 'muted small'}, /^[a-z_]+$/.test(why) ? t('Code expired or mistyped. Request a new code on the device.') : why), another);
      stepped('code');
      return;
    }
    body.replaceChildren(...letIn(code, who.clientId, error, done));
    stepped('asking');
  };
  void ask();
}

/** No code given: the one the device shows, typed here, and Next (`next`, with the code). */
function typing(next: (code: string) => void): Node[] {
  const typed = h('input', {class: 'line-in mono', placeholder: 'XXXXXXXX', 'aria-label': t('Device pairing code'), autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
  const go = () => { const code = typed.value.trim().toUpperCase(); if (code) next(code); };
  const on = h('button', {class: 'button primary', type: 'button'}, t('Next'));
  on.addEventListener('click', go);
  typed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
  return [h('p', {}, t('Enter the code shown on the device.')), h('div', {class: 'row'}, typed, on)];
}

/** Which device asks (`clientId`) and its code, to check against the device's; Connect or Refuse, then `finish`. */
function letIn(code: string, clientId: string, error: HTMLElement, finish: (text: string) => void): Node[] {
  const yes = h('button', {class: 'button primary', type: 'button'}, t('Connect')) as HTMLButtonElement;
  const no = h('button', {class: 'button', type: 'button'}, t('Deny')) as HTMLButtonElement;
  yes.addEventListener('click', async () => {
    yes.disabled = no.disabled = true;
    try { await remote.approveDevice(code); finish(t('Connected. Return to your device.')); } catch (e) { error.textContent = errorText(e); yes.disabled = no.disabled = false; }
  });
  no.addEventListener('click', async () => {
    yes.disabled = no.disabled = true;
    // Refused only once the Remote says so; until then the device could still be let in.
    try { await remote.denyDevice(code); finish(t('Denied.')); } catch (e) { error.textContent = errorText(e); yes.disabled = no.disabled = false; }
  });
  return [h('p', {}, t('{client} is requesting access. Verify that both devices show matching codes.', {client: client(clientId)})),
    h('p', {class: 'device-code mono'}, code), answers(no, yes), error];
}
