import {h} from '../dom.ts';
import * as remote from '../remote.ts';
import {signInBox} from './remote.ts';

// The page a device's code opens (?device&user_code=…): l3 or the app asks
// to join this account. The person signs in here with a passkey if not
// already, sees which device asks and its code, and lets it in or not.

const CLIENT: Record<string, string> = {l3: 'l3（コマンド）', 'length3-app': 'Length³ OS アプリ'};

export function devicePage(code: string): HTMLElement {
  code = code.trim().toUpperCase();
  const body = h('div', {class: 'remote-join'});
  const page = h('main', {class: 'device-page'}, h('h1', {}, '端末をつなぐ'), body);
  const error = h('p', {class: 'error', role: 'alert'});
  const finish = (text: string) => body.replaceChildren(h('p', {}, text), h('p', {class: 'muted'}, 'このタブは閉じてかまいません。'));
  const ask = async () => {
    if (!code) {
      const typed = h('input', {class: 'line-in mono', placeholder: 'XXXXXXXX', 'aria-label': '端末のコード', autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
      const next = h('button', {class: 'button primary', type: 'button'}, '次へ');
      const go = () => { code = typed.value.trim().toUpperCase(); if (code) void ask(); };
      next.addEventListener('click', go);
      typed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
      body.replaceChildren(h('p', {}, '端末に出ているコードを入れてください。'), h('div', {class: 'row'}, typed, next));
      return;
    }
    if (!remote.connection()) {
      body.replaceChildren(h('p', {}, '承認するアカウントに入ってください。'), signInBox(() => void ask(), 'つなぐのは、あなたの Remote のアカウントです。'));
      return;
    }
    let who: {clientId: string; status: string};
    try { who = await remote.deviceAsking(code); } catch (e) {
      body.replaceChildren(h('p', {class: 'error'}, `このコードは使えません（${e instanceof Error ? e.message : String(e)}）`));
      return;
    }
    const yes = h('button', {class: 'button primary', type: 'button'}, 'つなぐ') as HTMLButtonElement;
    const no = h('button', {class: 'button', type: 'button'}, '断る') as HTMLButtonElement;
    yes.addEventListener('click', async () => {
      yes.disabled = no.disabled = true;
      try { await remote.approveDevice(code); finish('つなぎました。端末の画面に戻ってください。'); } catch (e) { error.textContent = String(e); yes.disabled = no.disabled = false; }
    });
    no.addEventListener('click', async () => {
      yes.disabled = no.disabled = true;
      await remote.denyDevice(code).catch(() => {});
      finish('断りました。');
    });
    body.replaceChildren(
      h('p', {}, `${CLIENT[who.clientId] ?? who.clientId} がこのアカウントにつなごうとしています。端末に出ているコードと同じか確かめてください。`),
      h('p', {class: 'device-code mono'}, code),
      h('div', {class: 'row'}, yes, no), error);
  };
  void ask();
  return page;
}
