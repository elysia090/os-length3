// The caret, drawn by the OS rather than by the browser, so that it moves as a thing does: from where it was to
// where it is (a letter typed, a line gone down, a press elsewhere in the text) in a short glide, and blinks only
// once it rests. The eye follows writing as it follows the pointer: what is written is seen being written, and
// Enter sweeps it to the next line's start. A selection is the browser's own, as it was; a field too long to measure
// at every key (a file of more than 100k characters) keeps the browser's caret, and so does less motion asked for.

const FIELDS = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"]';
const LONGEST = 100_000;
/** What a copy of a field must share with it to lay its text out the same. */
const COPIED = ['direction', 'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight',
  'fontFamily', 'fontFeatureSettings', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace',
  'overflowWrap', 'wordBreak'] as const;

type Field = HTMLTextAreaElement | HTMLInputElement;

/** The copy laid out as `f` lays its text out: taken once a field, and again when the field changes size. */
function copyStyle(f: Field, copy: HTMLElement) {
  const cs = getComputedStyle(f);
  for (const p of COPIED) copy.style[p] = cs[p];
  // A one-line field never wraps; a box of lines wraps where it does.
  if (f instanceof HTMLInputElement) copy.style.whiteSpace = 'pre';
}

/** Where the caret of `f` is on the screen: the top left of its letter's height, and that height. */
function caretAt(f: Field, copy: HTMLElement): {x: number; y: number; h: number} {
  const cs = getComputedStyle(f);
  const at = f.selectionEnd ?? 0;
  copy.textContent = f.value.slice(0, at);
  const mark = document.createElement('span');
  // The letter after the caret (or nothing that takes room) gives the mark its letter's height.
  mark.textContent = f.value.slice(at, at + 1).replace('\n', '') || '\u200b';
  copy.append(mark);
  const r = f.getBoundingClientRect();
  const h = mark.offsetHeight || parseFloat(cs.fontSize) * 1.25;
  const x = r.left + parseFloat(cs.borderLeftWidth) + mark.offsetLeft - f.scrollLeft;
  // A one-line field holds its line in the middle of its height.
  const y = f instanceof HTMLInputElement ? r.top + (r.height - h) / 2 : r.top + parseFloat(cs.borderTopWidth) + mark.offsetTop - f.scrollTop;
  return {x, y, h};
}

/** The part of the screen `el` can be seen in: its own box, cut by every box above it that clips. */
function seenIn(el: Element): DOMRect | null {
  let r = el.getBoundingClientRect();
  let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p);
    if (o.overflowX === 'visible' && o.overflowY === 'visible') continue;
    r = p.getBoundingClientRect();
    left = Math.max(left, r.left); top = Math.max(top, r.top); right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
  }
  return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : null;
}

export function caret() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const mark = document.createElement('span');
  mark.className = 'os-caret';
  mark.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('div');
  copy.className = 'caret-copy';
  copy.setAttribute('aria-hidden', 'true');
  document.body.append(mark, copy);
  let field: Field | null = null;
  let frame = 0, rest = 0, shown = false;
  /** The field the copy is laid out as; none once it changes size (or the window does). */
  let styled: Field | null = null;
  const resized = new ResizeObserver(() => { styled = null; });

  const hide = () => {
    mark.classList.remove('on');
    shown = false;
  };
  /** Where the field stood when the caret was last put in it. A field that moves with nothing typed (a page still
   * coming in, a pill sliding, what is above it growing) carries the caret with it: looked at every frame while it
   * moves, and a little while apart while it stands still. One watch at a time, the latest. */
  let stood: DOMRect | null = null;
  let watching = 0;
  const watch = (n: number) => {
    const f = field;
    if (n !== watching || !f || !stood || !mark.classList.contains('on')) return;
    const r = f.getBoundingClientRect();
    if (r.left !== stood.left || r.top !== stood.top) { shown = false; later(); return; }
    window.setTimeout(() => requestAnimationFrame(() => watch(n)), 200);
  };
  const draw = () => {
    frame = 0;
    const f = field;
    if (!f || document.activeElement !== f || f.selectionStart !== f.selectionEnd) { hide(); return; }
    if (styled !== f) { copyStyle(f, copy); styled = f; }
    const p = caretAt(f, copy);
    const seen = seenIn(f);
    if (!seen || p.x < seen.left - 1 || p.x > seen.right + 1 || p.y + p.h / 2 < seen.top || p.y + p.h / 2 > seen.bottom) { hide(); return; }
    // Come to a field, it is put there; moving in it, it glides.
    mark.classList.toggle('jump', !shown);
    mark.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    mark.style.height = `${Math.round(p.h)}px`;
    mark.classList.add('on');
    shown = true;
    stood = f.getBoundingClientRect();
    const n = ++watching;
    requestAnimationFrame(() => watch(n));
    // Solid while it moves; blinking once it has rested a moment.
    mark.classList.remove('resting');
    clearTimeout(rest);
    rest = window.setTimeout(() => mark.classList.add('resting'), 500);
  };
  const later = () => { frame ||= requestAnimationFrame(draw); };

  const take = (f: Field | null) => {
    if (field) resized.unobserve(field);
    field?.classList.remove('os-caret-field');
    field = f && f.matches(FIELDS) && !f.readOnly && !f.disabled && f.value.length <= LONGEST ? f : null;
    field?.classList.add('os-caret-field');
    if (field) resized.observe(field);
    styled = null;
    shown = false;
    later();
  };
  document.addEventListener('focusin', (e) => take(e.target as Field));
  document.addEventListener('focusout', () => { take(null); hide(); });
  // A file grown past what can be measured at every key goes back to the browser's caret.
  document.addEventListener('input', (e) => {
    if (field && e.target === field && field.value.length > LONGEST) take(null);
    later();
  }, true);
  for (const name of ['selectionchange', 'keydown', 'keyup', 'pointerup']) addEventListener(name, later, true);
  // What scrolls carries the caret with it at once, not a glide behind the text.
  for (const name of ['scroll', 'resize']) addEventListener(name, () => { shown = false; later(); }, true);
  document.addEventListener('selectionchange', later);
}
