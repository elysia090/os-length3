import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {askFoot, SETTLE} from '../common.ts';
import {errorText} from '../../app/errors.ts';
import type {Server} from '../../remote/servers.ts';

// The pieces Server's parts share (its view, band, boards, gear, dock and the rest in this folder).

/** Where Server was last, or is to open next: a server and its board, or a board alone (one written in as a guest). */
export interface At { server?: string; board?: string }
const AT = 'length3.server.at';
export function remembered(): At {
  try { return JSON.parse(localStorage.getItem(AT) ?? '{}') as At; } catch { return {}; }
}
/** Server opens at `at` next (pages that lead to a server or a board say where, then bring Server out). */
export function remember(at: At) {
  try { localStorage.setItem(AT, JSON.stringify(at)); } catch { /* a convenience */ }
}

/** A switch's knob moves this long before what it turns on is asked. */
export const MOVE = 240;

export const button = (text: string, kind = '') => h('button', {type: 'button', class: `button ${kind}`.trim()}, text) as HTMLButtonElement;

/** A board as the layer holds it: whose it is to write in. */
export interface Shown { id: string; name: string; member: boolean; guests: boolean; server: string }

/**
 * What Server has chosen and holds while it is out: view.ts keeps it, and the parts it draws read it as it is when
 * they need it (pressed, or answered), never a copy taken before.
 */
export interface Here {
  readonly signedIn: boolean;
  /** The servers one is in. */
  list: Server[];
  /** The boards in the row, in its order. */
  shown: Shown[];
  /** The server chosen, if one is. */
  serverId: string | null;
  /** A board shown alone, outside the servers one is in: one written in as a guest, or invited to. */
  alone: string | null;
  /** A server being named: its chip, in the band where it will stand once made (new-server.ts). */
  naming: HTMLElement | null;
}

/** The server chosen, as the list has it. */
export const current = (here: Here) => here.list.find((s) => s.id === here.serverId) ?? null;

/** Where something is being written (a board's TODO, a name): the layer stays out while `busy` says so. */
export type Writer = (at: Element, busy: () => boolean) => void;

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

/** Each field as wide as what is written in it (or its placeholder), as a chip is. */
export function fitting(...fields: HTMLInputElement[]): () => void {
  const pen = document.createElement('canvas').getContext('2d');
  const wide = (f: HTMLInputElement) => {
    if (!pen || !f.isConnected) return;
    pen.font = getComputedStyle(f).font;
    f.style.width = `${Math.ceil(pen.measureText(f.value || f.placeholder).width) + 2}px`;
  };
  return () => { for (const f of fields) wide(f); };
}
