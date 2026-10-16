import {h} from '../dom.ts';
import {isNative} from '../host.ts';
import {onSync, takeIn} from '../lifecycle.ts';
import * as sync from '../sync.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';

// Remote: where the canonical copy is. Without an account, one line says
// what that means here and the two ways in. With one: each repo with where
// it stands against the Remote, Home's settings the same way, and the
// account at the foot.

export const STATE_WORD: Record<sync.RepoState['state'], string> = {
  pushed: 'push 済み', unpushed: '未 push', behind: 'Remote が先', local: 'ここだけ',
};
const HOME_WORD: Record<sync.HomeState, string> = {pushed: 'push 済み', unpushed: '未 push', conflict: '食い違い', local: 'ここだけ'};
const HOME_NAME = {profile: 'プロフィール', todo: 'TODO'} as const;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** While the new token is on screen nothing repaints over it: it is shown this once. */
let showingToken = false;

function joinForm(done: () => void): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const make = h('button', {class: 'button', type: 'button'}, 'アカウントを作る') as HTMLButtonElement;
  const token = h('input', {class: 'line-in', placeholder: 'トークン', 'aria-label': 'トークン', spellcheck: 'false', autocomplete: 'off'}) as HTMLInputElement;
  const join = h('button', {class: 'button', type: 'button'}, 'つなぐ') as HTMLButtonElement;
  const body = h('div', {class: 'remote-join'},
    h('p', {class: 'muted'}, isNative
      ? '正本は Remote に置かれます。この端末の repo は、区切って push するまでここだけです。'
      : '正本は Remote に置かれます。このブラウザの写しは、push 済みならタブを閉じると消えます。'),
    h('div', {class: 'row'}, make), h('div', {class: 'row'}, token, join), error);
  make.addEventListener('click', async () => {
    make.disabled = true;
    try {
      showingToken = true;
      const t = await sync.signUp();
      const shown = h('input', {class: 'line-in mono', readonly: '', value: t, 'aria-label': 'トークン'}) as HTMLInputElement;
      const copy = h('button', {class: 'button', type: 'button'}, 'コピー');
      copy.addEventListener('click', () => { shown.select(); void navigator.clipboard?.writeText(t); });
      const next = h('button', {class: 'button', type: 'button'}, '続ける');
      next.addEventListener('click', () => { showingToken = false; done(); });
      // The token is the account's only key, and it is shown this once.
      body.replaceChildren(h('p', {}, 'ほかの端末ではこのトークンでつなぎます。表示はこの一度だけです。'),
        h('div', {class: 'row'}, shown, copy), h('div', {class: 'row'}, next));
      shown.select();
    } catch (e) { showingToken = false; error.textContent = message(e); make.disabled = false; }
  });
  const go = async () => {
    join.disabled = true;
    try { await sync.connect(token.value); await takeIn(); done(); } catch (e) { error.textContent = message(e); join.disabled = false; }
  };
  join.addEventListener('click', () => void go());
  token.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) void go(); });
  return body;
}

export function remote(ctx: Context): Node[] {
  const holder = h('div', {});
  let alive = true;

  const paint = async () => {
    if (showingToken) return;
    const c = sync.connection();
    if (!c) { holder.replaceChildren(h('section', {class: 'section'}, joinForm(() => void paint()))); return; }
    const error = h('p', {class: 'error', role: 'alert'});
    const states = await sync.states().catch((e) => { error.textContent = message(e); return new Map<string, sync.RepoState>(); });
    if (!alive) return;
    const repoRows = [...states].map(([name, s]) => {
      const act: Node[] = [];
      if (s.state === 'behind') {
        const take = h('button', {class: 'button small-button', type: 'button'}, '取り込む') as HTMLButtonElement;
        take.addEventListener('click', async () => {
          take.disabled = true;
          try { await sync.pull(name); } catch (e) { error.textContent = message(e); }
          void paint();
        });
        act.push(take);
      } else if (s.state === 'unpushed' || s.state === 'local') {
        const cut = h('button', {class: 'button small-button', type: 'button'}, 'Git で区切る');
        cut.addEventListener('click', () => { ctx.remember(name); ctx.go('git'); });
        act.push(cut);
      }
      return h('div', {class: 'row-item usage-prompt', 'data-state': s.state},
        h('span', {class: 'row-name'}, name),
        h('span', {class: 'row-meta'}, s.state === 'unpushed' ? `${STATE_WORD.unpushed} ${s.changed}` : STATE_WORD[s.state]), ...act);
    });
    const homeRows = sync.HOME_KEYS.map((k) =>
      h('div', {class: 'row-item'}, h('span', {class: 'row-name'}, HOME_NAME[k]), h('span', {class: 'row-meta'}, HOME_WORD[sync.homeState(k)])));
    const leave = h('button', {class: 'button small-button', type: 'button'}, '切る');
    leave.addEventListener('click', async () => { await sync.disconnect(); void paint(); });
    holder.replaceChildren(
      h('section', {class: 'section', 'aria-labelledby': 'remote-repos'},
        h('h2', {id: 'remote-repos'}, 'repo'),
        repoRows.length ? h('div', {class: 'rows'}, ...repoRows) : h('div', {class: 'empty'}, 'repoはまだありません'), error),
      h('section', {class: 'section', 'aria-labelledby': 'remote-home'},
        h('h2', {id: 'remote-home'}, 'Home'), h('div', {class: 'rows'}, ...homeRows)),
      h('section', {class: 'section'},
        h('div', {class: 'row reclaim-act'}, h('span', {class: 'muted grow'}, `つながっています · ${new URL(c.url).host}`), leave)));
  };

  void paint();
  const stop = onSync(() => { if (!holder.isConnected) { alive = false; stop(); return; } void paint(); });
  return [pageHead('remote'), holder];
}
