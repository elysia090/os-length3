import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {askFoot, SETTLE} from './common.ts';
import {errorText} from '../errors.ts';

// The pieces Server's parts share (server-layer, -gear, -dock, -repo).

/** A switch's knob moves this long before what it turns on is asked. */
export const MOVE = 240;

export const initials = (address: string) => [...address.split('@')[0]].slice(0, 2).join('').toUpperCase();
export const button = (text: string, kind = '') => h('button', {type: 'button', class: `button ${kind}`.trim()}, text) as HTMLButtonElement;

/** A board as the layer holds it: whose it is to write in. */
export interface Shown { id: string; name: string; member: boolean; guests: boolean; server: string }

/**
 * Asked in the card, as Remote asks before a repo is turned off: the card
 * gives way to what will happen and the two answers, the deed on the side
 * `from` was pressed and Not now on the other, and comes back as it was if
 * the answer is no.
 */
export function askIn(card: HTMLElement, from: Element, title: string | Node, what: string | string[], verb: string, act: () => Promise<void>, no_?: () => void) {
  const answers = askFoot(from, card);
  const was = [...card.childNodes];
  // The card keeps its size while it asks, so the answers come where its own deeds were.
  card.style.minHeight = `${card.offsetHeight}px`;
  const error = h('p', {class: 'error small', role: 'alert'});
  const no = button(t('Not now'), 'small-button'), yes = button(verb, 'small-button primary');
  // The card comes back, and the keyboard with it to what asked (its switch), not dropped to the page.
  no.addEventListener('click', () => { card.style.minHeight = ''; card.replaceChildren(...was); no_?.(); if (from.isConnected) (from as HTMLElement).focus(); });
  const shown = performance.now();
  yes.addEventListener('click', async () => {
    if (performance.now() - shown < SETTLE) return;
    yes.disabled = true;
    try { await act(); } catch (e) { error.textContent = errorText(e); yes.disabled = false; }
  });
  // What will happen, a short line each: a line breaks where the sentence does, not where the card ends.
  card.replaceChildren(h('div', {class: 'off-ask'}, h('span', {class: 'card-title'}, title), ...[what].flat().map((l) => h('p', {class: 'muted small'}, l)), error,
    answers(no, yes)));
  yes.focus();
}

/** A small card, as Runtime's and Remote's: its title, a line or two, then what can be done at its foot. */
export const smallCard = (title: string | Node, ...rest: (Node | null)[]) => h('div', {class: 'card small-card'}, h('span', {class: 'card-title'}, title), ...rest);
/** A board's name as its own head writes it: the # quiet before it. */
export const boardName = (name: string) => h('span', {}, h('span', {class: 'muted', 'aria-hidden': 'true'}, '# '), name);
export const line = (text: string) => (text ? h('span', {class: 'muted small'}, text) : null);
/** A card's foot with the deed the card is for: at the right. */
export const foot = (...xs: (Node | null)[]) => h('div', {class: 'card-foot'}, h('span', {class: 'grow'}), ...xs);
/** A card's foot with what goes against what the card is for (a person taken out of it): at the left. */
export const footLeft = (...xs: (Node | null)[]) => h('div', {class: 'card-foot'}, ...xs, h('span', {class: 'grow'}));
