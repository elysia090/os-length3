import {bytes, h} from '../dom.ts';
import {isNative, readCapacity, readUsage, reclaim, rootFetch, rootStatus, type Certainty, type Reclaim, type RootHeld, type Usage} from '../host.ts';
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

/**
 * What comes by itself, what closing ends and what goes to the Remote, for
 * each thing this OS holds, as it is on this host (lifecycle.ts). The
 * canonical copy of each is on the Remote, or for the OS its release.
 */
function holding(): HTMLElement {
  const close = isNative ? '窓を閉じると' : 'タブを閉じると';
  const rows: [string, string, string, string][] = isNative ? [
    ['OS（root）', '入れるとき Remote から', '残る', 'リリース'],
    ['repo', '開く・戻るたびに取り込む', '残る', '区切るたびに push'],
    ['Home', '開く・戻るたびに取り込む', '残る', '変わるたびに push'],
    ['Prompt', 'repo を開くと起動', '終わる', '—'],
  ] : [
    ['OS（l3）', '開くたびに取る', '消える', 'リリース'],
    ['repo', '開くたびに取り込む', 'push 済みなら消える', '区切るたびに push'],
    ['Home', '開くたびに取り込む', 'push 済みなら消える', '変わるたびに push'],
    ['Prompt', 'repo を開くと起動', '終わる', '—'],
  ];
  const row = (cells: string[], head = false) => h('div', {class: head ? 'hold-row row-head' : 'hold-row'}, ...cells.map((c) => h('span', {}, c)));
  return h('section', {class: 'section', 'aria-labelledby': 'hold-title'},
    h('h2', {id: 'hold-title'}, '持ち方'),
    h('div', {class: 'rows'}, row(['', '取ってくる', close, 'Remote'], true), ...rows.map((r) => row(r))),
    h('p', {class: 'muted small env-note'}, '未 push のものは、push するまで消えません。'));
}

const HELD: Record<RootHeld, string> = {Current: '使用中', Previous: '戻すために残す', Older: '空けられる'};

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
  // The roots, each with why it is here: that is what decides whether it can go.
  if (u.system.length) {
    here.append(h('div', {class: 'rows usage-rows'},
      ...u.system.map((r) => h('div', {class: 'row-item', title: r.sha256},
        h('span', {class: 'row-name'}, `${r.name} ${r.version}`),
        h('span', {class: 'row-meta'}, HELD[r.held]),
        h('span', {class: 'row-meta usage-size'}, bytes(r.allocated))))));
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
      // What each is, grouped: the reason it can go is the reason it is listed.
      const groups = new Map<string, {n: number; bytes: number}>();
      for (const l of u.leftovers) {
        const g = groups.get(l.what) ?? {n: 0, bytes: 0};
        g.n++; g.bytes += l.allocated;
        groups.set(l.what, g);
      }
      body.push(h('div', {class: 'rows'}, ...[...groups].map(([what, g]) => h('div', {class: 'row-item'},
        h('span', {class: 'row-name'}, g.n > 1 ? `${what} ${g.n}` : what),
        h('span', {class: 'row-meta usage-size'}, bytes(g.bytes))))));
      body.push(h('div', {class: 'row work-act reclaim-act'},
        h('span', {class: 'grow'}, h('b', {}, bytes(u.reclaimable))), go));
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
    h('p', {}, h('b', {}, `${bytes(r.freed)} 空けました`), ` · ${r.removed} 件`),
    h('p', {class: 'muted small'}, seen),
    ...r.kept.map(([path, why]) => h('p', {class: 'muted small'}, `残したもの: ${path.split('/').at(-1)} — ${why}`)));
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
  return [pageHead('runtime'), holding(), holder, prompts(),
    h('section', {class: 'section', 'aria-labelledby': 'env-title'}, h('h2', {id: 'env-title'}, '有効な環境'), environment())];
}
