import {h} from '../dom.ts';
import {icon} from '../icons.ts';
import {purpose, type PurposeId} from '../purposes.ts';

export function pageHead(id: PurposeId): HTMLElement {
  const p = purpose(id);
  return h('header', {class: 'page-head'}, icon(id), h('h1', {}, p.label), h('p', {}, p.role));
}

/** A page whose surface is not built yet: what it will hold, plainly. */
export function placeholder(id: PurposeId): Node[] {
  return [pageHead(id), h('div', {class: 'empty'}, purpose(id).detail)];
}
