import {bytes, h} from '../dom.ts';
import {readCapacity, readUsage, reclaim, type Certainty, type Reclaim, type Usage} from '../host.ts';
import {has} from '../fetch.ts';
import {about} from '../userland.ts';
import {pageHead} from './common.ts';
import {allSessions} from './terminal.ts';

/** How a figure is known, in one word; a counted figure needs none. */
const known = (c: Certainty) => (c === 'Verified' ? '' : c === 'Estimated' ? '推定' : '不明');

/**
 * What the Prompt runs, from l3.json written with it: l3 is the one thing it
 * depends on, and what l3 carries (the distribution's root, its BusyBox, the
 * translator) is shown inside it, so it cannot claim what is not there.
 */
function environment(): HTMLElement {
  const body = h('div', {}, h('p', {class: 'muted'}, '読み込み中…'));
  void about().then(async (a) => {
    if (!a) { body.replaceChildren(h('div', {class: 'empty'}, 'l3 がありません（npm run userland）')); return; }
    const here = await has(a.bundle.sha256);
    const part = (name: string, version: string, note: string, sha = '') =>
      h('div', {class: 'env-row env-part'}, h('span', {}, name), h('span', {}, version), h('span', {class: 'muted'}, note),
        h('code', {class: 'muted', title: sha}, sha.slice(0, 12)));
    body.replaceChildren(h('div', {class: 'env-one'},
      h('div', {class: 'env-row env-head'}, h('b', {}, a.name), h('span', {}, a.version),
        h('span', {class: 'muted'}, `${bytes(a.bundle.size)} · ${here ? 'この端末にあります' : '最初の Prompt で読み込みます'}`),
        h('code', {class: 'muted', title: a.bundle.sha256}, a.bundle.sha256.slice(0, 12))),
      part(a.root.name, a.root.version, 'root'),
      part(a.base.name, a.base.version, `${a.base.applets} コマンド · ${a.base.from}`, a.base.sha256),
      part('l3', a.version, 'コマンド', a.l3.sha256),
      part(a.translator.name, a.translator.version, '翻訳器')),
      h('p', {class: 'muted small env-note'}, 'Dotfiles はまだありません'));
  });
  return body;
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

/**
 * The desktop: what this OS holds, counted from the filesystem (allocated
 * blocks, so a sparse file counts what it holds); each repo with how much of
 * it is history; and its own dead temporaries, which 空ける gives back.
 */
function device(u: Usage, last: Reclaim | null, again: (r: Reclaim) => void): HTMLElement[] {
  const total = u.host_total || 1;
  const here = h('section', {class: 'section', 'aria-labelledby': 'device-title'},
    h('h2', {id: 'device-title'}, 'この端末'),
    meter(total, u.host_free, u.allocated, `全体 ${bytes(u.host_total)} のうち このOS ${bytes(u.allocated)}`),
    h('div', {class: 'legend'},
      figure(bytes(u.allocated), 'このOS'),
      figure(bytes(u.host_free), '空き', known(u.host)),
      figure(bytes(u.host_total), '全体', known(u.host))));
  if (u.repos.length) {
    here.append(h('div', {class: 'rows usage-rows'},
      ...u.repos.map((r) => h('div', {class: 'row-item', title: `中身 ${bytes(r.logical)} · ${r.files} ファイル`},
        h('span', {class: 'row-name'}, r.name),
        r.history ? h('span', {class: 'row-meta'}, `履歴 ${bytes(r.history)}`) : null,
        h('span', {class: 'row-meta usage-size'}, bytes(r.allocated)))),
      u.home ? h('div', {class: 'row-item'}, h('span', {class: 'row-name'}, '設定'), h('span', {class: 'row-meta usage-size'}, bytes(u.home))) : null));
  }

  const free = h('section', {class: 'section', 'aria-labelledby': 'reclaim-title'});
  const paintFree = (done: Reclaim | null) => {
    const body: Node[] = [];
    if (done) body.push(result(done));
    if (u.leftovers.length) {
      const go = h('button', {class: 'button', type: 'button'}, '空ける') as HTMLButtonElement;
      go.addEventListener('click', () => {
        go.disabled = true;
        void reclaim().then(again, (e) => {
          go.disabled = false;
          free.append(h('p', {class: 'error', role: 'alert'}, e instanceof Error ? e.message : String(e)));
        });
      });
      body.push(h('div', {class: 'row work-act reclaim-act'},
        h('span', {class: 'grow'}, h('b', {}, bytes(u.reclaimable)), ` · 残った一時ファイル ${u.leftovers.length}`), go));
    }
    free.hidden = !body.length;
    free.replaceChildren(h('h2', {id: 'reclaim-title'}, '空けられるもの'), ...body);
  };
  paintFree(last);
  return [here, free];
}

/** What 空ける did: counted bytes, and the host's free space as it was seen to change. */
function result(r: Reclaim): HTMLElement {
  const change = r.host_free_after - r.host_free_before;
  const seen = r.reflected_ms === null ? '端末にはまだ出ていません'
    : `端末の空き ${change >= 0 ? '+' : '−'}${bytes(Math.abs(change))}（${known(r.host_change) || '確定'} · ${r.reflected_ms} ms）`;
  return h('div', {class: 'reclaimed', role: 'status'},
    h('p', {}, h('b', {}, `${bytes(r.freed)} 空けました`), ` · ${r.removed} ファイル`),
    h('p', {class: 'muted small'}, seen),
    ...r.kept.map(([path, why]) => h('p', {class: 'muted small'}, `残したもの: ${path.split('/').at(-1)} — ${why}`)));
}

/** Prompts running in this window, each with what it holds and 止める. Shown only when one runs. */
function prompts(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'prompts-title', hidden: ''});
  const unwatch: (() => void)[] = [];
  let first = true;
  const paint = () => {
    for (const u of unwatch.splice(0)) u();
    // Once the page is gone, it stops listening.
    if (!first && !section.isConnected) return;
    first = false;
    const live = allSessions().filter(([, s]) => s.running);
    section.hidden = !live.length;
    section.replaceChildren(h('h2', {id: 'prompts-title'}, '動いている Prompt'),
      h('div', {class: 'rows'}, ...live.map(([repo, s]) => {
        unwatch.push(s.watch(paint));
        const stop = h('button', {class: 'button', type: 'button'}, '止める');
        stop.addEventListener('click', () => s.stop());
        return h('div', {class: 'row-item usage-prompt'},
          h('span', {class: 'row-name'}, repo),
          h('span', {class: 'row-meta usage-size'}, s.memory ? bytes(s.memory) : ''), stop);
      })));
  };
  paint();
  return section;
}

/** Runtime: what this device holds, measured, what can be given back, and the environment in effect. */
export function runtime(): Node[] {
  const holder = h('div', {}, h('section', {class: 'section'}, h('p', {class: 'muted'}, '計測中…')));
  // What 空ける last did stays in view while the figures are read again.
  let last: Reclaim | null = null;
  const read = () => void readUsage().then((u) => {
    if (u) { holder.replaceChildren(...device(u, last, (r) => { last = r; read(); })); return; }
    // In a browser only the origin's share is known, and nothing here is the OS's to give back.
    void readCapacity().then((c) => {
      const s = h('section', {class: 'section', 'aria-labelledby': 'device-title'}, h('h2', {id: 'device-title'}, 'このブラウザ'));
      if (!c) s.append(h('p', {class: 'muted'}, '計測できませんでした'));
      else s.append(meter(c.total, c.free, c.app, `割当 ${bytes(c.total)} のうち ${bytes(c.app)}`),
        h('div', {class: 'legend'}, figure(bytes(c.app), '保存済み'), figure(bytes(c.free), '空き', '推定'), figure(bytes(c.total), '割当', '推定')));
      holder.replaceChildren(s);
    });
  });
  read();
  return [pageHead('runtime'), holder, prompts(),
    h('section', {class: 'section', 'aria-labelledby': 'env-title'}, h('h2', {id: 'env-title'}, '有効な環境'), environment())];
}
