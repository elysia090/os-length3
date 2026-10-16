import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {icon} from '../icons.ts';
import {purpose, type PurposeId} from '../purposes.ts';

export function pageHead(id: PurposeId): HTMLElement {
  const p = purpose(id);
  return h('header', {class: 'page-head'}, icon(id), h('h1', {}, t(p.label)), h('p', {}, t(p.role)));
}

/** A page whose surface is not built yet: what it will hold, plainly. */
export function placeholder(id: PurposeId): Node[] {
  return [pageHead(id), h('div', {class: 'empty'}, t(purpose(id).detail))];
}
