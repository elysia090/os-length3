import {bytes, h} from '../dom.ts';
import {readCapacity} from '../host.ts';
import {purpose} from '../purposes.ts';
import {pageHead} from './common.ts';

/** Runtime: what this device holds, measured. */
export function runtime(): Node[] {
  const p = purpose('runtime');
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
    h('section', {class: 'section'}, h('h2', {}, '有効な環境'), h('div', {class: 'empty'}, p.detail))];
}
