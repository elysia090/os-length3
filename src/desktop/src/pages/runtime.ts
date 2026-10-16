import {bytes, h} from '../dom.ts';
import {isNative, rootFetch, rootStatus, type Certainty, type Freed, type Item, type Space} from '../host.ts';
import {free, readSpace} from '../space.ts';
import {about} from '../userland.ts';
import {pageHead} from './common.ts';
import {allSessions, type Session} from './terminal.ts';

/** How a figure is known, in one word; a counted figure needs none. */
const known = (c: Certainty) => (c === 'Verified' ? '' : c === 'Estimated' ? '推定' : '不明');

/**
 * What the Prompt actually runs. In the app with a root installed: that
 * root, on this machine's kernel. Otherwise l3, from l3.json written with
 * it: what it carries (the distribution's BusyBox, the l3 command, the
 * translator) is shown inside it, so it cannot claim what is not there;
 * and in the app, how to get the whole root.
 */
function environment(): HTMLElement {
  const body = h('div', {}, h('p', {class: 'muted'}, '読み込み中…'));
  void rootStatus().then((root) => {
    if (root?.current) {
      const r = root.current;
      body.replaceChildren(h('div', {class: 'env-one'},
        h('div', {class: 'env-row env-head'}, h('b', {}, r.name), h('span', {}, r.version),
          h('span', {class: 'muted'}, `${bytes(r.bytes)} · ${r.files} ファイル · この端末のカーネルで`),
          h('code', {class: 'muted', title: r.sha256}, r.sha256.slice(0, 12)))),
        h('p', {class: 'muted small env-note'}, 'Dotfiles はまだありません'));
      return;
    }
    showL3(root);
  });
  const showL3 = (root: Awaited<ReturnType<typeof rootStatus>>) => void about().then((a) => {
    if (!a) { body.replaceChildren(h('div', {class: 'empty'}, 'l3 がありません（npm run userland）')); return; }
    const part = (name: string, version: string, note: string, sha = '') =>
      h('div', {class: 'env-row env-part'}, h('span', {}, name), h('span', {}, version), h('span', {class: 'muted'}, note),
        h('code', {class: 'muted', title: sha}, sha.slice(0, 12)));
    body.replaceChildren(h('div', {class: 'env-one'},
      h('div', {class: 'env-row env-head'}, h('b', {}, a.name), h('span', {}, a.version),
        h('span', {class: 'muted'}, `${bytes(a.bundle.size)} · ${isNative ? 'アプリと一緒' : '開くたびに取ります'}`),
        h('code', {class: 'muted', title: a.bundle.sha256}, a.bundle.sha256.slice(0, 12))),
      part(a.root.name, a.root.version, 'root'),
      part(a.base.name, a.base.version, `${a.base.applets} コマンド · ${a.base.from}`, a.base.sha256),
      part('l3', a.version, 'コマンド', a.l3.sha256),
      part(a.translator.name, a.translator.version, '翻訳器')),
      ...(root ? [installRoot(root.release)] : []),
      h('p', {class: 'muted small env-note'}, 'Dotfiles はまだありません'));
  });
  return body;
}

/** In the app without a root: fetch the whole one, saying how far it is. */
function installRoot(release: {name: string; version: string; bytes: number}): HTMLElement {
  const words = h('span', {class: 'grow'}, `${release.name} ${release.version} を入れると、Prompt はこの端末のカーネルで root 全体を動かします（${bytes(release.bytes)}）`);
  const go = h('button', {class: 'button', type: 'button'}, '入れる') as HTMLButtonElement;
  const row = h('div', {class: 'row work-act reclaim-act'}, words, go);
  go.addEventListener('click', () => {
    go.disabled = true;
    void rootFetch((got, of, retry) => {
      words.textContent = retry ? `${retry}。続きから取ります` : `取得中 ${bytes(got)} / ${bytes(of)}`;
    }).then((r) => {
      words.textContent = `${r.name} ${r.version} を入れました。次に開く Prompt から使われます`;
      go.remove();
    }, (e) => {
      words.textContent = `入れられませんでした（${e instanceof Error ? e.message : String(e)}）`;
      go.disabled = false;
    });
  });
  return row;
}

/** A bar of the whole: this OS's part, everything else's, and what is free. */
function meter(total: number, free: number, mine: number, label: string) {
  const pct = (v: number) => `${Math.min(100, (v / total) * 100).toFixed(2)}%`;
  const app = h('span', {class: 'app'}); app.style.width = pct(mine);
  const other = h('span'); other.style.width = pct(Math.max(0, total - free - mine));
  return h('div', {class: 'meter', role: 'img', 'aria-label': label}, app, other);
}

const figure = (value: string, word: string, note = '') =>
  h('span', {}, h('b', {}, value), word, note ? h('small', {class: 'muted'}, ` ${note}`) : null);

const ACT: Record<Item['room'], string> = {Free: '空ける', SyncFree: '同期して空ける', Keep: ''};

/**
 * この端末 → 空けられるもの, as one list: everything this OS holds here,
 * largest first, each with what can be done with it. Whatever can go says
 * how (空ける, or 同期して空ける when its changes go to the Remote first);
 * whatever stays says why.
 */
function device(u: Space, last: Freed | null, again: (r: Freed) => void): HTMLElement {
  const total = u.host_total || 1;
  const error = h('p', {class: 'error', role: 'alert'});
  const go = (ids: string[], buttons: HTMLButtonElement[]) => {
    for (const b of buttons) b.disabled = true;
    void free(ids).then(again, (e) => {
      for (const b of buttons) b.disabled = false;
      error.textContent = e instanceof Error ? e.message : String(e);
    });
  };
  const buttons: HTMLButtonElement[] = [];
  const rows = u.items.map((i) => {
    const act: Node = i.room === 'Keep' ? h('span', {class: 'row-meta space-why'}, i.why) : (() => {
      const b = h('button', {class: `button small-button`, type: 'button', title: i.why}, ACT[i.room]) as HTMLButtonElement;
      buttons.push(b);
      b.addEventListener('click', () => go([i.id], [b]));
      return b;
    })();
    return h('div', {class: 'row-item usage-prompt', 'data-room': i.room, title: i.why},
      h('span', {class: 'row-name'}, i.what, h('small', {class: 'muted'}, `  ${i.detail}`)),
      h('span', {class: 'row-meta usage-size'}, bytes(i.allocated)), act);
  });
  const all = h('button', {class: 'button', type: 'button'}, '全部空ける') as HTMLButtonElement;
  all.addEventListener('click', () => go(u.items.filter((i) => i.room !== 'Keep').map((i) => i.id), [all, ...buttons]));
  return h('section', {class: 'section', 'aria-labelledby': 'device-title'},
    h('h2', {id: 'device-title'}, isNative ? 'この端末' : 'このブラウザ'),
    meter(total, u.host_free, u.allocated, `全体 ${bytes(u.host_total)} のうち このOS ${bytes(u.allocated)}`),
    h('div', {class: 'legend'},
      figure(bytes(u.allocated), 'このOS'),
      figure(bytes(u.host_free), '空き', known(u.host)),
      figure(bytes(u.host_total), isNative ? '全体' : '割当', known(u.host))),
    ...(last ? [result(last)] : []),
    h('div', {class: 'rows usage-rows'}, ...(rows.length ? rows : [h('div', {class: 'row-item muted'}, isNative ? 'このOSはこの端末に何も置いていません' : 'このブラウザには何も置いていません。repo は Remote にあり、開けばまた来ます')])),
    ...(u.freeable ? [h('div', {class: 'row work-act reclaim-act'},
      h('span', {class: 'grow'}, '空けられるもの ', h('b', {}, bytes(u.freeable)), h('small', {class: 'muted'}, '  repo は Remote に残り、開けばまた来ます')), all)] : []),
    error);
}

/** What 空ける did: counted bytes, and the host's free space as it was seen to change. */
function result(r: Freed): HTMLElement {
  const change = r.host_free_after - r.host_free_before;
  const seen = r.reflected_ms === null ? (isNative ? '端末にはまだ出ていません' : '')
    : `端末の空き ${change >= 0 ? '+' : '−'}${bytes(Math.abs(change))}（${known(r.host_change) || '確定'} · ${r.reflected_ms} ms）`;
  return h('div', {class: 'reclaimed', role: 'status'},
    r.removed.length ? h('p', {}, h('b', {}, `${bytes(r.freed)} 空けました`), ` · ${r.removed.length} 件`) : null,
    seen ? h('p', {class: 'muted small'}, seen) : null,
    ...r.kept.map(([id, why]) => h('p', {class: 'muted small'}, `残したもの: ${id.replace(/^(repo|root|path):/, '').split('/').at(-1)} — ${why}`)));
}

/** Prompts running in this window, each with what it holds and 止める. Shown only when one runs. */
function prompts(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'prompts-title', hidden: ''});
  // Each session is watched once, for as long as the page is shown.
  const watched = new Map<Session, () => void>();
  let first = true;
  const paint = () => {
    if (!first && !section.isConnected) { for (const u of watched.values()) u(); watched.clear(); return; }
    first = false;
    // Running ones, and ones stopped here, with what stopping gave back.
    const shown = allSessions().filter(([, s]) => s.running || s.stopped);
    section.hidden = !shown.length;
    section.replaceChildren(h('h2', {id: 'prompts-title'}, '動いている Prompt'),
      h('div', {class: 'rows'}, ...shown.map(([repo, s]) => {
        if (!watched.has(s)) watched.set(s, s.watch(paint));
        if (!s.running && s.stopped) {
          const t = s.stopped;
          return h('div', {class: 'row-item usage-prompt', 'data-state': 'stopped'},
            h('span', {class: 'row-name'}, repo),
            h('span', {class: 'row-meta'}, t.left ? `${t.left} 個残っています` : `止めました · ${bytes(t.before.memory)} を返しました${t.ms !== null ? ` · ${t.ms} ms` : ''}`));
        }
        const stop = h('button', {class: 'button', type: 'button'}, '止める');
        stop.addEventListener('click', () => s.stop());
        return h('div', {class: 'row-item usage-prompt'},
          h('span', {class: 'row-name'}, repo),
          h('span', {class: 'row-meta'}, s.on === 'root' ? `root · ${s.processes} プロセス` : 'l3'),
          h('span', {class: 'row-meta usage-size'}, s.memory ? bytes(s.memory) : ''), stop);
      })));
  };
  paint();
  return section;
}

/** Runtime: この端末 and what can go from it, the Prompts running, and the environment in effect. */
export function runtime(): Node[] {
  const holder = h('div', {}, h('section', {class: 'section'}, h('p', {class: 'muted'}, '計測中…')));
  // What 空ける last did stays in view while the figures are read again.
  let last: Freed | null = null;
  const read = () => void readSpace(allSessions().filter(([, s]) => s.running).map(([repo]) => repo)).then((u) => {
    holder.replaceChildren(u ? device(u, last, (r) => { last = r; read(); }) : h('section', {class: 'section'}, h('p', {class: 'muted'}, '計測できませんでした')));
  });
  read();
  return [pageHead('runtime'), holder, prompts(),
    h('section', {class: 'section', 'aria-labelledby': 'env-title'}, h('h2', {id: 'env-title'}, '有効な環境'), environment())];
}
