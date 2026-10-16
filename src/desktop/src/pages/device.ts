import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import * as remote from '../remote.ts';
import {signInBox} from './remote.ts';

// The page a device's code opens (?device&user_code=…): l3 or the app asks
// to join this account. The person signs in here if not already (and comes
// back here from the provider), sees which device asks and its code, and
// lets it in or not.

const client = (id: string) => (id === 'l3' ? t('l3 (the command line)') : id === 'length3-app' ? t('the Length³ OS app') : id);

export function devicePage(given: string): HTMLElement {
  let code = given.trim().toUpperCase();
  const body = h('div', {class: 'remote-join'});
  const page = h('main', {class: 'device-page'}, h('h1', {}, t('Connect a device')), body);
  const error = h('p', {class: 'error', role: 'alert'});
  const finish = (text: string) => body.replaceChildren(h('p', {}, text), h('p', {class: 'muted'}, t('You can close this tab.')));
  const ask = async () => {
    if (!code) {
      const typed = h('input', {class: 'line-in mono', placeholder: 'XXXXXXXX', 'aria-label': t('The device\'s code'), autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
      const next = h('button', {class: 'button primary', type: 'button'}, t('Next'));
      const go = () => { code = typed.value.trim().toUpperCase(); if (code) void ask(); };
      next.addEventListener('click', go);
      typed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
      body.replaceChildren(h('p', {}, t('Enter the code the device shows.')), h('div', {class: 'row'}, typed, next));
      return;
    }
    if (!remote.connection() && !(await remote.claim())) {
      body.replaceChildren(h('p', {}, t('Sign in to the account the device will join.')), signInBox(() => void ask(), t('The device joins your account on the Remote.'), remote.signedInURL()));
      return;
    }
    let who: {clientId: string; status: string};
    try { who = await remote.deviceAsking(code); } catch (e) {
      body.replaceChildren(h('p', {class: 'error'}, t('This code cannot be used ({why}).', {why: e instanceof Error ? e.message : String(e)})));
      return;
    }
    const yes = h('button', {class: 'button primary', type: 'button'}, t('Connect')) as HTMLButtonElement;
    const no = h('button', {class: 'button', type: 'button'}, t('Refuse')) as HTMLButtonElement;
    yes.addEventListener('click', async () => {
      yes.disabled = no.disabled = true;
      try { await remote.approveDevice(code); finish(t('Connected. Go back to the device.')); } catch (e) { error.textContent = String(e); yes.disabled = no.disabled = false; }
    });
    no.addEventListener('click', async () => {
      yes.disabled = no.disabled = true;
      await remote.denyDevice(code).catch(() => {});
      finish(t('Refused.'));
    });
    body.replaceChildren(
      h('p', {}, t('{client} asks to join this account. Check that the device shows the same code.', {client: client(who.clientId)})),
      h('p', {class: 'device-code mono'}, code),
      h('div', {class: 'row'}, yes, no), error);
  };
  void ask();
  return page;
}
