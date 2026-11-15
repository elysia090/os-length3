// Words on the ground take the whole cells they stand in (DESIGN §3, whole cells): the dots of those cells are under
// them, so no dot is nearer a word than half a cell, none is cut by the words' patch, and none reads as a stop that was
// never written ("1 repo · 1 server·"). Their patch, of the ground's own colour, is brought up to the grid's next line at
// their right (ui/row.ts wholeCells; styles/fit.css .clearing); their left is a line of the grid already, as every
// thing's edge is. Every such word is named here, once, and taken as it comes into the page.

import {wholeCells} from './row.ts';

/** What is set on the ground and read: its words, not a sheet's. */
export const GROUND_WORDS = [
  '.identity > :is(.counts, .handle, .bio)', '.home-repos-sec > h2', '.home-repos .card.new', '.lately > h2',
  '.desk-label', '.issue-name', '.issues-new > .issue-where', '.side-part h3', '.nr-label',
  // (A name on the ground too: the person's, a repo's, main's; its capitals stand clear of the dots as words do.)
  '.identity h1', '.home-repos > .gear-card > .card-open > .card-title', '.section.main-part > h2',
].join(', ');

const taken = new WeakSet<Element>();

function take(el: Element) {
  if (taken.has(el) || !(el instanceof HTMLElement)) return;
  taken.add(el);
  el.classList.add('clearing');
  wholeCells(el, 'wide');
}

function within(root: Element) {
  if (root.matches(GROUND_WORDS)) take(root);
  for (const el of root.querySelectorAll(GROUND_WORDS)) take(el);
}

export function clearings(): void {
  within(document.body);
  new MutationObserver((changes) => {
    for (const c of changes) for (const n of c.addedNodes) if (n instanceof Element) within(n);
  }).observe(document.body, {childList: true, subtree: true});
}
