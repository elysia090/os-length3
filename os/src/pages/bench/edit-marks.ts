import {h} from '../../ui/dom.ts';
import {LAND, paced, still} from '../../ui/glide.ts';
import {lineOf, lineStarts, type Mark} from '../../repos/edit.ts';

// What the box's Edit shows on the file in front (edit-box.ts): marks drawn under the editor's words, in a layer of
// their own laid over it, where its letters are; what was just done lit a moment; the line pointed at ringed; and a
// mark out of view brought into it.

/** A line's words up to a place in it as they are drawn: each tab to the next stop of `tab`. */
function drawn(line: string, tab: number): string {
  let out = '';
  for (const c of line) out += c === '\t' ? ' '.repeat(tab - (out.length % tab)) : c;
  return out;
}
const measures = new WeakMap<HTMLTextAreaElement, CanvasRenderingContext2D>();
/** How wide `words` are in the editor's face. */
function widthIn(area: HTMLTextAreaElement, words: string): number {
  let c = measures.get(area);
  if (!c) { c = document.createElement('canvas').getContext('2d')!; c.font = getComputedStyle(area).font; measures.set(area, c); }
  return c.measureText(words).width;
}

/** An editor's lines as they are drawn: its words and where each line starts, a line's height, its tab stop, its padding. */
interface Lines { text: string; starts: number[]; lh: number; tab: number; top: number; left: number }
function linesOf(area: HTMLTextAreaElement): Lines {
  const cs = getComputedStyle(area), text = area.value;
  return {text, starts: lineStarts(text), lh: parseFloat(cs.lineHeight) || 1.6 * parseFloat(cs.fontSize), tab: Number(cs.tabSize) || 4,
    top: parseFloat(cs.paddingTop) || 0, left: parseFloat(cs.paddingLeft) || 0};
}

/** The layer `layer` laid over `area`, made if there is none; with no marks to draw (`any` false) it goes, and is none. */
function layerOf(area: HTMLTextAreaElement, layer: string, any: boolean): HTMLElement | null {
  const sheet = area.parentElement;
  if (!sheet) return null;
  let el = sheet.querySelector<HTMLElement>(`:scope > .${layer}`);
  if (!any) { el?.remove(); return null; }
  if (!el) { el = h('div', {class: `edit-layer ${layer}`, 'aria-hidden': 'true'}); sheet.insertBefore(el, area); }
  return el;
}

/** Mark `m` as it is drawn over `area` (its lines `l`): a rule between lines, whole lines, or words in a line. */
function markOf(area: HTMLTextAreaElement, l: Lines, m: Mark): HTMLElement {
  const line = lineOf(l.starts, m.from);
  const span = h('span', {class: `edit-mark ${m.kind}${m.now ? ' now' : ''}${m.gone ? ' gone' : ''}`});
  if (m.kind === 'rule') span.style.top = `${l.top + (line + (m.under ? 1 : 0)) * l.lh}px`;
  else if (m.kind === 'lines') {
    const last = lineOf(l.starts, Math.max(m.from, m.to));
    Object.assign(span.style, {top: `${l.top + line * l.lh}px`, height: `${(last - line + 1) * l.lh}px`});
  } else {
    const x = (offset: number) => l.left - area.scrollLeft + widthIn(area, drawn(l.text.slice(l.starts[line], offset), l.tab));
    const a = x(m.from), b = x(m.to);
    Object.assign(span.style, {top: `${l.top + line * l.lh}px`, height: `${l.lh}px`, left: `${a - 2}px`, width: `${Math.max(4, b - a + 4)}px`});
  }
  return span;
}

/**
 * `marks` drawn on the editor `area`, under its words (its ground is clear), in a layer of its own laid over it
 * (`layer` names it: what a line would do, or what was just done); none, the layer goes. Returns the lead mark's
 * element (the first now-mark, else the first).
 */
export function drawMarks(area: HTMLTextAreaElement, marks: Mark[], layer = 'edit-marks'): HTMLElement | null {
  const el = layerOf(area, layer, marks.length > 0);
  if (!el) return null;
  const l = linesOf(area);
  Object.assign(el.style, {left: `${area.offsetLeft}px`, top: `${area.offsetTop}px`, width: `${area.offsetWidth}px`, height: `${area.offsetHeight}px`});
  const els = marks.slice(0, 2000).map((m) => markOf(area, l, m));
  // One mark of a line going to another line (the ring under the hand, the line the caret is on, where + would put
  // a line) goes there on a short curve, from where it was seen: not gone from one line and there on the next at once.
  const before = el.childElementCount === 1 ? el.firstElementChild as HTMLElement : null;
  const was = before?.getBoundingClientRect();
  el.replaceChildren(...els);
  const now = els.length === 1 && marks[0].kind !== 'words' ? els[0] : null;
  if (was && now && before!.className === now.className && !still()) {
    const r = now.getBoundingClientRect(), dy = was.top - r.top;
    if (Math.abs(dy) > .5 && Math.abs(was.height - r.height) < .5) now.animate([{translate: `0 ${dy}px`}, {translate: '0 0'}], {duration: paced(140), easing: LAND});
  }
  return els[Math.max(0, marks.findIndex((m) => m.now))] ?? null;
}

/** The mark of line `line` (of lines starting at `starts`), soft: the caret's line, or the line pointed at. */
export const lineMark = (starts: number[], line: number): Mark[] => [{from: starts[line], to: starts[line], kind: 'lines'}];

/** What was just done, lit a moment on the file, as a place landed on is. */
export function flash(area: HTMLTextAreaElement, lit: Mark[]) {
  if (!lit.length || still()) return;
  area.parentElement?.querySelector(':scope > .edit-flash')?.remove();
  drawMarks(area, lit, 'edit-flash');
  const layer = area.parentElement?.querySelector<HTMLElement>(':scope > .edit-flash');
  if (!layer) return;
  const gone = () => layer.remove();
  layer.animate([{opacity: 1}, {opacity: 1, offset: .35}, {opacity: 0}], {duration: paced(900), easing: 'ease-out'}).finished.then(gone, gone);
}

/** `el` (a mark on the file) brought into view if it is out of it, a third down what is clear of the box (`clear`, its top). */
export function bring(el: HTMLElement, area: HTMLTextAreaElement, clear: number) {
  const flow = area.closest<HTMLElement>('.flow');
  if (!flow) return;
  const r = el.getBoundingClientRect(), f = flow.getBoundingClientRect(), bottom = Math.min(f.bottom, clear) - 12;
  if (r.top < f.top + 12 || r.bottom > bottom)
    flow.scrollTo({top: flow.scrollTop + r.top - f.top - (bottom - f.top) / 3, behavior: still() ? 'auto' : 'smooth'});
  // A word far along a long line: the editor scrolls along to it (its marks with it). A line's mark (or a rule) is as
  // wide as the file, starting left of its words, so it asks for none; told only when it did scroll, so the marks
  // drawn again for it (show, on its scroll) do not ask again.
  const w = area.getBoundingClientRect();
  if (!el.matches('.lines, .rule') && (r.right > w.right - 8 || r.left < w.left)) {
    const was = area.scrollLeft;
    area.scrollLeft = Math.max(0, area.scrollLeft + r.left - w.left - w.width / 3);
    if (area.scrollLeft !== was) area.dispatchEvent(new Event('scroll'));
  }
}

/** The lead of what is shown on `area` now (the caret's line, a line taken) brought into view (`clear`: as for bring). */
export function bringLead(area: HTMLTextAreaElement, clear: number) {
  const lead = area.parentElement?.querySelector<HTMLElement>(':scope > .edit-marks > .now');
  if (lead) bring(lead, area, clear);
}

/** The place in `area` the pointer is over, at (`x`, `y`): the nearest gap between two letters of its line (its end, beside the text). */
export function offsetAt(area: HTMLTextAreaElement, x: number, y: number): {line: number; at: number} {
  const r = area.getBoundingClientRect(), {text, starts, lh, tab, top, left} = linesOf(area);
  const line = Math.min(starts.length - 1, Math.max(0, Math.floor((y - r.top - top) / lh)));
  const from = starts[line], to = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  if (x < r.left) return {line, at: to};
  const want = x - r.left - left + area.scrollLeft;
  let was = 0;
  for (let i = from; i < to; i++) {
    const w = widthIn(area, drawn(text.slice(from, i + 1), tab));
    if (w >= want) return {line, at: want - was < w - want ? i : i + 1};
    was = w;
  }
  return {line, at: to};
}

/** The line pointed at, ringed, to say it can be pressed. */
export class Ring {
  #at: {area: HTMLTextAreaElement; line: number} | null = null;

  /** The ring on line `line` of `area` (none: the ring goes). */
  on(area: HTMLTextAreaElement | null, line: number) {
    const was = this.#at;
    // Off the file, or onto another, the ring goes; along the same file it moves to the line now under the hand.
    if (was && (was.area !== area || !area)) drawMarks(was.area, [], 'edit-ring');
    this.#at = area ? {area, line} : null;
    if (!area || (was?.area === area && was.line === line)) return;
    drawMarks(area, lineMark(lineStarts(area.value), line), 'edit-ring');
  }
}
