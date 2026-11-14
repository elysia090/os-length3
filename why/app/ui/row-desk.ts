// A desk turned along a row of pieces (Server's boards, Inbox's conversation), and the row's map at the window's foot
// (every row's, Forge's too): the page's side of the numbers in row.ts.

import {h} from './dom.ts';
import {still} from './glide.ts';
import {CELL, eased, moveTime} from './law.ts';
import {atRest, ground, pieceWidth, turnedTo} from './row.ts';

/** A piece's shadow: half a cell. */
const SHADE = CELL / 2;

/** A piece of a row, as its map shows it. */
export interface Piece {
  /** Where it starts from the desk's edge, and how wide it is. */
  x: number;
  w: number;
  /** In the hand. */
  held: boolean;
  /** What it is, said by its mark. */
  name: string;
  /** Go to it. */
  go(): void;
}

/** The row drawn this many times smaller is its map. */
const MAP = 12;

/**
 * The row's map, at the window's foot from the desk's edge (DESIGN §6): the row twelve times smaller, a bar for each
 * piece (the one in the hand in ink), a line under the part of it that is in sight. It is there while some of the row
 * is out of sight, and says what is: how many pieces, which way, how far. A bar pressed goes to its piece, so nothing
 * on a row is reached by scrolling alone. Drawn again by `paint` (as the desk turns, or its pieces change).
 */
export function rowMap(stage: HTMLElement, pieces: () => Piece[]): {element: HTMLElement; paint(): void} {
  const sight = h('span', {class: 'row-sight', 'aria-hidden': 'true'});
  const element = h('div', {class: 'row-map', role: 'group', hidden: ''}, sight);
  let drawn = '';
  const paint = () => {
    const all = pieces(), face = stage.clientWidth, last = all[all.length - 1];
    const whole = last ? last.x + last.w : 0;
    // All of it in sight (with the last piece's shadow): nothing to say.
    if (!last || !face || whole + SHADE <= face) { element.hidden = true; return; }
    element.hidden = false;
    const by = Math.min(1 / MAP, (face - 2 * CELL) / whole);
    const key = JSON.stringify([by, all.map((p) => [p.x, p.w, p.held, p.name])]);
    if (key !== drawn) {
      drawn = key;
      element.replaceChildren(sight, ...all.map((p) => {
        const b = h('button', {type: 'button', class: 'row-piece', 'aria-label': p.name, title: p.name, 'aria-current': String(p.held)});
        b.style.left = `${Math.round(p.x * by)}px`;
        b.style.width = `${Math.max(4, Math.round(p.w * by))}px`;
        b.addEventListener('click', () => p.go());
        return b;
      }));
      element.style.width = `${Math.round(whole * by)}px`;
    }
    sight.style.left = `${Math.round(stage.scrollLeft * by)}px`;
    sight.style.width = `${Math.round(Math.min(face, whole - stage.scrollLeft) * by)}px`;
  };
  return {element, paint};
}

/**
 * A desk turned along a row of pieces laid side by side in `track` (its children, those not hidden), scrolled in
 * `stage`: a piece's width is set on it (--piece) as the desk's room allows, the ground goes with it, it rests at a
 * piece (the browser's snapping), `show` turns it to a piece by the rule above, and its map stands at the window's
 * foot. `named` says what each piece is and whether it is in the hand; `go` takes one into the hand.
 */
export class RowDesk {
  readonly map: {element: HTMLElement; paint(): void};
  private glide: {to: number} | null = null;
  private readonly stage: HTMLElement;
  private readonly track: HTMLElement;

  constructor(stage: HTMLElement, track: HTMLElement, said: {name(el: HTMLElement): string; held(el: HTMLElement): boolean; go(el: HTMLElement): void}, relaid: () => void = () => {}) {
    this.stage = stage;
    this.track = track;
    this.map = rowMap(stage, () => this.pieces().map((el) => ({x: el.offsetLeft - track.offsetLeft, w: el.offsetWidth, held: said.held(el), name: said.name(el), go: () => said.go(el)})));
    stage.addEventListener('scroll', () => { ground(stage.scrollLeft, CELL); this.map.paint(); }, {passive: true});
    new ResizeObserver(() => {
      const w = stage.clientWidth;
      if (!w) return;
      const piece = `${pieceWidth(w)}px`;
      if (stage.style.getPropertyValue('--piece') !== piece) { stage.style.setProperty('--piece', piece); relaid(); }
      this.map.paint();
    }).observe(stage);
  }

  /** The pieces, in their order. */
  pieces(): HTMLElement[] {
    return ([...this.track.children] as HTMLElement[]).filter((el) => !el.hidden && el.offsetWidth > 0);
  }

  /** Where each piece starts, from the desk's edge. */
  starts(): number[] {
    return this.pieces().map((el) => el.offsetLeft - this.track.offsetLeft);
  }

  /** The desk turned to show `piece` whole, or left where it is while it is whole in sight. */
  show(piece: HTMLElement, moving = true) {
    if (!this.stage.clientWidth || !piece.offsetWidth) return;
    const starts = this.starts(), x = piece.offsetLeft - this.track.offsetLeft;
    const now = atRest(this.glide?.to ?? this.stage.scrollLeft, starts);
    this.turn(turnedTo(now, x, piece.offsetWidth, this.stage.clientWidth, starts, SHADE), moving);
  }

  /** The desk turned to `to`: over the law's time, or at once. */
  turn(to: number, moving = true) {
    const el = this.stage;
    moving = moving && !still();
    if (moving && this.glide) { this.glide.to = to; return; }
    this.glide = null;
    el.style.scrollSnapType = '';
    const from = el.scrollLeft;
    if (!moving || Math.abs(to - from) < .5) { if (Math.abs(to - from) >= .5) el.scrollLeft = to; this.map.paint(); return; }
    // (On its way the desk is taken where it is told: it comes to rest at a piece by going to one.)
    el.style.scrollSnapType = 'none';
    const glide = this.glide = {to}, t0 = performance.now(), ms = moveTime(to - from, el.clientWidth);
    el.animate([{}, {}], {duration: ms, id: 'desk-camera'});
    const step = (now: number) => {
      if (this.glide !== glide) return;
      const u = Math.max(0, Math.min(1, (now - t0) / ms));
      el.scrollLeft = u >= 1 ? glide.to : from + (glide.to - from) * eased(u);
      if (u < 1) requestAnimationFrame(step);
      else { this.glide = null; el.style.scrollSnapType = ''; }
    };
    requestAnimationFrame(step);
  }
}
