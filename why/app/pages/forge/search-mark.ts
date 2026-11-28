import {h} from '../../ui/dom.ts';
import {fieldCarried} from '../../ui/caret.ts';
import {stillAt} from '../../../repo/search.ts';
import {lineHeight, lineStart} from './editor.ts';

interface Word {line: number; start: number; from: number; to: number}

/** A found line can move between the indexed text and the live paper. Use its words, not its old offset. */
function foundWord(value: string, query: string, wanted: number): Word | null {
  const line = stillAt(value, query, wanted);
  if (line === null) return null;
  const rows = value.split('\n'), text = rows[line - 1], start = lineStart(rows, line - 1);
  const lower = text.toLowerCase(), q = query.toLowerCase(), at = lower.indexOf(q);
  if (!q || at < 0) return null;
  // Lowercasing a letter can add code units (İ). A mark ends at the actual written letter.
  const fromLow = (offset: number) => {
    if (lower.length === text.length) return offset;
    let written = 0, read = 0;
    for (const ch of text) {
      read += ch.toLowerCase().length;
      if (offset < read) return written;
      written += ch.length;
    }
    return written;
  };
  const last = fromLow(at + q.length - 1);
  return {line, start, from: start + fromLow(at), to: start + last + (text.codePointAt(last)! > 0xffff ? 2 : 1)};
}

interface PaperMark {place(): void; clear(): void}

/** A line in sight does not move. A line not yet in sight comes in with context, whole, without scrolling through. */
function showLine(port: HTMLElement, y: number, step: number) {
  const height = port.clientHeight, first = port.scrollTop;
  if (height > 0 && (y < first || y + step > first + height))
    port.scrollTop = Math.max(0, y - Math.floor(height / 3 / step) * step);
}

/** Paint just the found words without changing the textarea, caret or selection underneath. */
export function searchMark(area: HTMLTextAreaElement, port: HTMLElement, line: number, query: string): PaperMark | null {
  const match = foundWord(area.value, query, line);
  if (!match) return null;
  const {from, to, start} = match, before = area.value.slice(0, to);
  const word = h('mark', {class: 'desk-match', 'data-line': String(match.line)}, area.value.slice(from, to));
  // Invisible prefix keeps the textarea's tab stops and character spacing, even well along a scrolled line.
  const row = h('span', {class: 'desk-match-row'}, h('span', {class: 'desk-match-prefix'}, area.value.slice(start, from)), word);
  const clip = h('div', {class: 'desk-match-layer', 'aria-hidden': 'true'}, row);
  area.after(clip);
  const listen = new AbortController();
  let top = 0;
  const clear = () => { listen.abort(); clip.remove(); };
  const write = () => {
    if (!area.value.startsWith(before)) { clear(); return; }
    row.style.left = `${-area.scrollLeft}px`;
    row.style.top = `${top - area.scrollTop}px`;
    const a = area.selectionStart, b = area.selectionEnd;
    // Native user selection stays visible. A native caret inside the mark does too.
    const nativeCaret = a === b && a >= from && a < to && !area.classList.contains('os-caret-field');
    word.hidden = document.activeElement === area && (nativeCaret || a < b && a < to && b > from);
  };
  const place = () => {
    if (!clip.isConnected) return;
    const cs = getComputedStyle(area), step = lineHeight(area);
    Object.assign(clip.style, {left: `${area.offsetLeft + area.clientLeft}px`, top: `${area.offsetTop + area.clientTop}px`,
      width: `${area.clientWidth}px`, height: `${area.clientHeight}px`, font: cs.font});
    top = (match.line - 1) * step;
    write();
  };
  place();
  const step = lineHeight(area), viewport = area.getBoundingClientRect(), ink = word.getBoundingClientRect();
  if (ink.width && (ink.left < viewport.left || ink.right > viewport.right)) {
    const scale = viewport.width / area.offsetWidth || 1;
    const lead = Math.min((area.clientWidth - ink.width / scale) / 2, 4 * parseFloat(getComputedStyle(area).fontSize) * .6);
    area.scrollLeft = Math.max(0, area.scrollLeft + (ink.left - viewport.left) / scale - Math.max(0, lead));
    write();
  }
  showLine(port, area.offsetTop + (match.line - 1) * step - area.scrollTop, step);
  fieldCarried();
  for (const event of ['scroll', 'selectionchange', 'select', 'focus', 'blur', 'keyup', 'pointerup'])
    area.addEventListener(event, write, {signal: listen.signal});
  return {place, clear};
}

/** The ordinary read-only paper is already DOM text. It does not need a second visual layer. */
export function searchPreview(pre: HTMLElement, port: HTMLElement, line: number, query: string): PaperMark | null {
  const text = pre.textContent ?? '', match = foundWord(text, query, line);
  if (!match) return null;
  const word = h('mark', {class: 'desk-match', 'data-line': String(match.line)}, text.slice(match.from, match.to));
  pre.replaceChildren(text.slice(0, match.from), word, text.slice(match.to));
  const field = pre.getBoundingClientRect(), ink = word.getBoundingClientRect();
  if (ink.left < field.left || ink.right > field.right) {
    const scale = field.width / pre.offsetWidth || 1;
    pre.scrollLeft = Math.max(0, pre.scrollLeft + (ink.left - field.left) / scale);
  }
  const step = parseFloat(getComputedStyle(pre).lineHeight);
  showLine(port, pre.offsetTop + (match.line - 1) * step, step);
  return {place() {}, clear() { word.replaceWith(word.textContent ?? ''); pre.normalize(); }};
}
