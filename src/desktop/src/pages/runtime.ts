import {bytes, h} from '../dom.ts';
import {readCapacity} from '../host.ts';
import {pageHead} from './common.ts';

interface Manifest {
  base: {name: string; version: string; from: string; sha256: string; applets: number};
  tools: {name: string; version: string; sha256: string}[];
  dotfiles: {path: string; from: string}[];
}

/** The environment the Prompt actually runs, from the manifest written with it. */
function environment(): HTMLElement {
  const body = h('div', {}, h('p', {class: 'muted'}, '読み込み中…'));
  void fetch('/userland/manifest.json').then((r) => (r.ok ? r.json() as Promise<Manifest> : null)).catch(() => null).then((m) => {
    if (!m) { body.replaceChildren(h('div', {class: 'empty'}, 'Prompt の環境がありません（npm run userland）')); return; }
    const row = (name: string, version: string, note: string, sha: string) =>
      h('div', {class: 'env-row'}, h('b', {}, name), h('span', {}, version), h('span', {class: 'muted'}, note),
        h('code', {class: 'muted', title: sha}, sha.slice(0, 12)));
    body.replaceChildren(
      h('div', {class: 'env-rows'},
        row(m.base.name, m.base.version, `base · ${m.base.applets} コマンド · ${m.base.from}`, m.base.sha256),
        ...m.tools.map((t) => row(t.name, t.version, 'ツール', t.sha256))),
      ...m.dotfiles.map((d) => row(d.path, '', `Dotfiles · ${d.from}`, '')),
      ...(m.dotfiles.length ? [] : [h('p', {class: 'muted small env-note'}, 'Dotfiles はまだありません')]));
  });
  return body;
}

/** Runtime: what this device holds, measured, and the environment actually in effect. */
export function runtime(): Node[] {
  const storage = h('section', {class: 'section', 'aria-labelledby': 'storage-title'},
    h('h2', {id: 'storage-title'}, 'この端末の容量'),
    h('p', {class: 'muted'}, '計測中…'));
  void readCapacity().then((c) => {
    if (!c) { storage.lastChild!.textContent = '計測できませんでした'; return; }
    const used = c.total - c.free;
    const pct = (v: number) => `${Math.min(100, (v / c.total) * 100).toFixed(2)}%`;
    const app = h('span', {class: 'app'}); app.style.width = pct(c.app);
    const other = h('span'); other.style.width = pct(Math.max(0, used - c.app));
    storage.lastChild!.replaceWith(
      h('div', {class: 'meter', role: 'img', 'aria-label': `全体 ${bytes(c.total)} のうち ${bytes(used)} 使用`}, app, other),
      h('div', {class: 'legend'},
        h('span', {}, h('b', {}, bytes(c.app)), 'このアプリ'),
        h('span', {}, h('b', {}, bytes(used)), '使用中'),
        h('span', {}, h('b', {}, bytes(c.free)), '空き'),
        h('span', {}, h('b', {}, bytes(c.total)), c.layer === 'browser-origin' ? 'このブラウザの割当' : '全体')),
    );
  });
  return [pageHead('runtime'), storage,
    h('section', {class: 'section', 'aria-labelledby': 'env-title'}, h('h2', {id: 'env-title'}, '有効な環境'), environment())];
}
