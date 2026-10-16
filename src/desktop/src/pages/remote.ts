import {ago, bytes, h} from '../dom.ts';
import {isNative} from '../host.ts';
import {bring, onSync, remoteOnly, repoState, type RepoSync} from '../lifecycle.ts';
import * as account from '../remote.ts';
import {store} from '../repos.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';

// Remote: where the canonical copy is, and who this device is there.
//
// Not in yet: one sentence on what it means, and the ways in. A browser
// makes the account with a passkey (はじめる) or uses one it has (パスキーで
// 入る), or the recovery code when every passkey is gone; the app and l3
// show a code that a browser approves.
//
// In: the repos, here and on the Remote only, each with where it stands;
// then what keeps the account: passkeys, the recovery code, the devices.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where a repo stands, in words. */
export function syncWord(s: RepoSync | undefined): string {
  if (!s) return '';
  if (s.where === 'local') return 'この端末だけ';
  if (s.where === 'sending') return '送っています';
  if (s.where === 'offline') return `まだ送れていません${s.changed ? `（${s.changed} 件）` : ''}`;
  if (s.unsynced.length) return `同期済み · 送れないもの ${s.unsynced.length}`;
  return '同期済み';
}

function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {class: `button ${kind}`.trim(), type: 'button'}, text) as HTMLButtonElement;
}

/** Run `f` with `b` pressed down, saying any failure in `error`. */
async function pressing(b: HTMLButtonElement, error: HTMLElement, f: () => Promise<void>) {
  b.disabled = true;
  error.textContent = '';
  try { await f(); } catch (e) { error.textContent = message(e); } finally { b.disabled = false; }
}

/** A recovery code, shown this once, to keep. */
function shownCode(code: string, done: () => void): HTMLElement {
  const text = h('input', {class: 'line-in mono', readonly: '', value: code, 'aria-label': '復旧コード'}) as HTMLInputElement;
  const copy = button('コピー');
  copy.addEventListener('click', () => { text.select(); void navigator.clipboard?.writeText(code); copy.textContent = 'コピーしました'; });
  const kept = button('控えました', 'primary');
  kept.addEventListener('click', done);
  queueMicrotask(() => text.select());
  return h('div', {class: 'remote-join'},
    h('p', {}, 'パスキーがすべて使えなくなったとき、このコードで一度だけ入れます。表示はこの一度だけです。パスワードマネージャーか紙に控えてください。'),
    h('div', {class: 'row'}, text, copy), h('div', {class: 'row'}, kept));
}

/**
 * The ways in. On the web: はじめる, パスキーで入る, 復旧コード. In the app: a
 * code approved in the browser. `done` runs once this device is in.
 */
export function signInBox(done: () => void, words = isNative
  ? '正本は Remote に置かれます。つなぐと、変えたものはすぐ送られ、ほかの端末でも開けます。'
  : '正本は Remote に置かれます。変えたものはすぐ送られ、このタブを閉じるとこのブラウザの写しは消えます。'): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const box = h('div', {class: 'remote-join'}, h('p', {class: 'muted'}, words));
  if (isNative) {
    const go = button('ブラウザでつなぐ', 'primary');
    const waiting = h('div', {class: 'remote-join', hidden: ''});
    go.addEventListener('click', () => void pressing(go, error, async () => {
      const s = await account.appSignIn();
      waiting.hidden = false;
      waiting.replaceChildren(
        h('p', {}, '開いたブラウザで、このコードと同じか確かめて承認してください。'),
        h('p', {class: 'device-code mono'}, s.code),
        h('p', {class: 'muted small'}, s.url));
      go.hidden = true;
      await s.wait.finally(() => { go.hidden = false; waiting.hidden = true; });
      done();
    }));
    box.append(h('div', {class: 'row'}, go), waiting, error);
    return box;
  }
  const start = button('はじめる', 'primary');
  const enter = button('パスキーで入る');
  const lost = button('復旧コードで入る', 'link');
  const code = h('input', {class: 'line-in mono', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', 'aria-label': '復旧コード', spellcheck: 'false', autocomplete: 'off'}) as HTMLInputElement;
  const use = button('入る');
  const recovering = h('div', {class: 'row', hidden: ''}, code, use);
  start.addEventListener('click', () => void pressing(start, error, async () => { await account.start(); done(); }));
  enter.addEventListener('click', () => void pressing(enter, error, async () => { await account.signIn(); done(); }));
  lost.addEventListener('click', () => { recovering.hidden = false; lost.hidden = true; code.focus(); });
  const recover = () => void pressing(use, error, async () => {
    await account.recover(code.value);
    // The code is spent: a new passkey, then a new code.
    box.replaceChildren(afterRecovery(done));
  });
  use.addEventListener('click', recover);
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) recover(); });
  box.append(
    h('div', {class: 'row'}, start, h('span', {class: 'muted small'}, 'パスキーをひとつ作るだけです。名前もメールもいりません。')),
    h('div', {class: 'row'}, enter),
    h('div', {class: 'row'}, lost), recovering, error);
  return box;
}

/** In by the recovery code: make a passkey now, then a new code to keep. */
function afterRecovery(finish: () => void): HTMLElement {
  const done = () => { account.joined(); finish(); };
  const error = h('p', {class: 'error', role: 'alert'});
  const make = button('パスキーを作る', 'primary');
  const later = button('あとで', 'link');
  later.addEventListener('click', done);
  const box = h('div', {class: 'remote-join'},
    h('p', {}, '入りました。復旧コードは使い切りです。この端末でパスキーを作り、新しい復旧コードを控えてください。'),
    h('div', {class: 'row'}, make, later), error);
  make.addEventListener('click', () => void pressing(make, error, async () => {
    await account.addPasskey();
    box.replaceChildren(shownCode(await account.makeRecovery(), done));
  }));
  return box;
}

function repoSection(ctx: Context): HTMLElement {
  const rows = h('div', {class: 'rows'});
  const section = h('section', {class: 'section', 'aria-labelledby': 'remote-repos'}, h('h2', {id: 'remote-repos'}, 'repo'), rows);
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const here = await store.list().catch(() => []);
    const items: Node[] = here.map((r) => {
      const s = repoState(r.name);
      const row = h('button', {type: 'button', class: 'row-item', 'data-where': s?.where ?? ''},
        h('span', {class: 'row-name'}, r.name), h('span', {class: 'row-meta'}, syncWord(s)));
      if (s?.error) row.title = s.error;
      row.addEventListener('click', () => ctx.openRepo(r.name));
      return row;
    });
    for (const t of remoteOnly()) {
      const open = button('開く', 'small-button');
      open.addEventListener('click', () => void pressing(open, error, async () => { await bring(t.name); ctx.openRepo(t.name); }));
      items.push(h('div', {class: 'row-item usage-prompt'}, h('span', {class: 'row-name'}, t.name),
        h('span', {class: 'row-meta'}, `Remote だけ · ${bytes(t.bytes)}`), open));
    }
    rows.replaceChildren(...(items.length ? items : [h('div', {class: 'row-item muted'}, 'repoはまだありません')]));
  };
  section.append(error);
  void paint();
  const stop = onSync(() => { if (!section.isConnected) { stop(); return; } void paint(); });
  return section;
}

function passkeySection(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'remote-keys'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const list = await account.passkeys().catch((e) => { error.textContent = message(e); return []; });
    const add = button('パスキーを足す', 'small-button');
    add.addEventListener('click', () => void pressing(add, error, async () => { await account.addPasskey(); await paint(); }));
    section.replaceChildren(h('h2', {id: 'remote-keys'}, h('span', {}, 'パスキー', h('small', {}, `${list.length}`)), add),
      h('div', {class: 'rows'}, ...(list.length ? list.map((k) => {
        const remove = button('外す', 'small-button');
        // The last way in is not taken away from here.
        remove.disabled = list.length < 2;
        if (remove.disabled) remove.title = '最後のパスキーは外せません';
        remove.addEventListener('click', () => void pressing(remove, error, async () => { await account.removePasskey(k.id); await paint(); }));
        return h('div', {class: 'row-item usage-prompt'}, h('span', {class: 'row-name'}, k.name || 'パスキー'),
          h('span', {class: 'row-meta'}, `${ago(Date.parse(k.createdAt))}に作成${k.backedUp ? ' · 同期されるパスキー' : ''}`), remove);
      }) : [h('div', {class: 'row-item muted'}, 'パスキーがありません。足しておくと、ほかの端末からも入れます')])), error);
  };
  void paint();
  return section;
}

function recoverySection(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'remote-recovery'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const has = await account.hasRecovery().catch(() => null);
    const make = button(has ? '作り直す' : '作る', has ? 'small-button' : 'primary');
    make.addEventListener('click', () => void pressing(make, error, async () => {
      const code = await account.makeRecovery();
      section.replaceChildren(h('h2', {id: 'remote-recovery'}, '復旧コード'), shownCode(code, () => void paint()));
    }));
    section.replaceChildren(h('h2', {id: 'remote-recovery'}, '復旧コード'),
      h('div', {class: 'row reclaim-act'}, h('span', {class: 'grow muted'}, has === null ? '' : has
        ? 'あります。作り直すと前のコードは使えなくなります。'
        : 'まだありません。パスキーをすべてなくしたとき、これがないと入れません。'), make), error);
  };
  void paint();
  return section;
}

function deviceSection(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'remote-devices'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const list = await account.devices().catch((e) => { error.textContent = message(e); return []; });
    section.replaceChildren(h('h2', {id: 'remote-devices'}, h('span', {}, '端末', h('small', {}, `${list.length}`))),
      h('div', {class: 'rows'}, ...list.map((d) => {
        const act: Node = d.current ? h('span', {class: 'row-meta'}, 'この端末') : (() => {
          const end = button('外す', 'small-button');
          end.addEventListener('click', () => void pressing(end, error, async () => { await account.endDevice(d.token); await paint(); }));
          return end;
        })();
        return h('div', {class: 'row-item usage-prompt'}, h('span', {class: 'row-name'}, account.deviceWord(d.userAgent)),
          h('span', {class: 'row-meta'}, `${ago(Date.parse(d.updatedAt))}に使用`), act);
      })), error);
  };
  void paint();
  return section;
}

export function remote(ctx: Context): Node[] {
  const holder = h('div', {});
  let shown: string | null = null;
  const paint = () => {
    const c = account.connection();
    const now = c ? c.token : '';
    if (now === shown) return;
    shown = now;
    if (!c) {
      holder.replaceChildren(h('section', {class: 'section'}, signInBox(() => paint())));
      return;
    }
    const leave = button('この端末を外す', 'small-button');
    leave.addEventListener('click', () => void account.signOut());
    holder.replaceChildren(
      repoSection(ctx),
      ...(isNative ? [] : [passkeySection(), recoverySection()]),
      deviceSection(),
      h('section', {class: 'section'},
        h('div', {class: 'row reclaim-act'}, h('span', {class: 'muted grow'}, `つながっています · ${new URL(c.url || location.origin).host}${isNative ? ' · パスキーと復旧コードはブラウザで扱います' : ''}`), leave)));
  };
  paint();
  const stop = account.onConnection(() => { if (!holder.isConnected) { stop(); return; } paint(); });
  return [pageHead('remote'), holder];
}
