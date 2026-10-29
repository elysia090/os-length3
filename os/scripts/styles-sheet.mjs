// The stylesheet as the scripts that prune it and split it read it (styles-prune.mjs, styles-split.mjs,
// styles-check.mjs): its rules in order, each with the comments written over it, and each rule's selectors (and
// what they weigh) and declarations.
//
// Read as the browser reads it, but only as far as these need: a rule is a selector and a body of declarations; an
// at-rule that holds rules (@media, @supports, @container) holds them as the sheet does; any other at-rule
// (@keyframes, @font-face) is one thing, read by its name.

/** At-rules whose block holds rules, read as the sheet is: conditions on them. */
const GROUPS = new Set(['media', 'supports', 'container', 'starting-style']);
/** At-rules that change how the cascade weighs what is in them: a sheet with one is not read here. */
const UNREAD = new Set(['layer', 'scope', 'import']);

/** Where the comment at `i` ends (the index after it). */
function commentEnd(text, i) {
  const e = text.indexOf('*/', i + 2);
  if (e < 0) throw new Error(`a comment is never closed (at ${where(text, i)})`);
  return e + 2;
}

/** Where the string at `i` ends (the index after its closing quote). */
function stringEnd(text, i) {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === q) return j + 1;
    if (text[j] === '\n') break;
  }
  throw new Error(`a string is never closed (at ${where(text, i)})`);
}

/** Line and column of index `i`, to say where something is. */
export function where(text, i) {
  const before = text.slice(0, i).split('\n');
  return `${before.length}:${before.at(-1).length + 1}`;
}

/**
 * The first index from `i` (before `to`) where `text` has one of `stops`, outside comments, strings, (), [] and
 * {} opened after `i`; -1 if none.
 */
function findTop(text, i, to, stops) {
  let depth = 0;
  for (let j = i; j < to; j++) {
    const c = text[j];
    if (c === '/' && text[j + 1] === '*') { j = commentEnd(text, j) - 1; continue; }
    if (c === '"' || c === "'") { j = stringEnd(text, j) - 1; continue; }
    if (c === '\\') { j++; continue; }
    if (depth === 0 && stops.includes(c)) return j;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return -1;
}

/** The index of the `}` closing the block opened at `open`. */
function blockEnd(text, open, to) {
  const e = findTop(text, open + 1, to, '}');
  if (e < 0) throw new Error(`a block is never closed (opened at ${where(text, open)})`);
  return e;
}

/**
 * The rules from `from` to `to`, in order. Each node keeps its own text exactly: `lead` (the room and comments
 * before it: what is written over it), `text` (the rule) and `trail` (a comment after it on its own line, which
 * is about it), so the nodes' texts joined, then `tail`, are the text again.
 *   {kind: 'rule', selector, body}
 *   {kind: 'group', name, prelude, head (up to its `{`), nodes, tail (from its last rule to its `}`)}
 *   {kind: 'at', name, prelude}
 */
export function parseRules(text, from = 0, to = text.length, lines = lineStarts(text)) {
  const nodes = [];
  let i = from;
  for (;;) {
    const leadStart = i;
    while (i < to) {
      if (/\s/.test(text[i])) i++;
      else if (text.startsWith('/*', i)) i = commentEnd(text, i);
      else break;
    }
    if (i >= to) return {nodes, tail: text.slice(leadStart, to)};
    const start = i;
    let node;
    if (text[i] === '@') {
      const name = /^@([-\w]+)/.exec(text.slice(i, i + 64))[1].toLowerCase();
      const j = findTop(text, i, to, ';{');
      if (j < 0) throw new Error(`@${name} never ends (at ${where(text, i)})`);
      const prelude = text.slice(i + 1 + name.length, j).trim();
      if (UNREAD.has(name)) throw new Error(`@${name} weighs rules in a way these scripts do not read (at ${where(text, i)})`);
      if (text[j] === ';') node = {kind: 'at', name, prelude, end: j + 1};
      else {
        const k = blockEnd(text, j, to);
        if (GROUPS.has(name)) {
          const inner = parseRules(text, j + 1, k, lines);
          node = {kind: 'group', name, prelude, head: text.slice(start, j + 1), nodes: inner.nodes, tail: inner.tail + '}', end: k + 1};
        } else node = {kind: 'at', name, prelude, end: k + 1};
      }
    } else {
      const j = findTop(text, i, to, '{;}');
      if (j < 0 || text[j] !== '{') throw new Error(`a rule has no block (at ${where(text, i)})`);
      const k = blockEnd(text, j, to);
      node = {kind: 'rule', selector: text.slice(i, j).trim(), body: text.slice(j + 1, k), end: k + 1};
    }
    node.start = start;
    node.line = lineAt(lines, start);
    node.lead = text.slice(leadStart, start);
    node.text = text.slice(start, node.end);
    // A comment after the rule on the rule's own last line is about the rule.
    let e = node.end;
    for (;;) {
      const m = /^[ \t]*\/\*/.exec(text.slice(e, Math.min(to, e + 256)));
      if (!m) break;
      const ce = commentEnd(text, e + m[0].length - 2);
      if (ce > to) break;
      e = ce;
    }
    node.trail = text.slice(node.end, e);
    i = e;
    delete node.end;
    nodes.push(node);
  }
}

/** Where each line of `text` starts. */
function lineStarts(text) {
  const out = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}

/** The line (from 1) index `i` is on. */
function lineAt(starts, i) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

/** The nodes' text again, as it was read. */
export function textOf(nodes, tail = '') {
  return nodes.map((n) => n.lead + (n.kind === 'group' ? n.head + textOf(n.nodes, n.tail) : n.text) + n.trail).join('') + tail;
}

/** The whole sheet: its nodes and what comes after the last. */
export function readSheet(text) {
  return parseRules(text);
}

/**
 * An entry sheet, one that starts (after its comments) with @imports: {files, head, rest}, the files it imports in
 * order (as written: `./styles/rail.css`), its text up to the last of them, and what follows them (rules written in
 * the entry itself, or nothing); null for a sheet of rules.
 */
export function entryOf(text) {
  const files = [];
  let end = 0;
  for (let i = 0; ;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith('/*', i)) { i = commentEnd(text, i); continue; }
    const m = /^@import\s+(?:url\(\s*)?(['"])([^'"\n]+)\1\s*\)?\s*;/.exec(text.slice(i, i + 512));
    if (!m) break;
    files.push(m[2]);
    end = i += m[0].length;
  }
  // Only parts beside it: an @import of anything else (a font's sheet) is not an entry's.
  if (!files.length || files.some((f) => !/^\.{1,2}\/[^:]*\.css$/.test(f))) return null;
  return {files, head: text.slice(0, end), rest: text.slice(end)};
}

/**
 * Every rule of the sheet in order, with the groups (@media…) it stands in, outermost first: {node, parents}. A
 * group's rules are leaves; an at-rule that is not a group (@keyframes) is a leaf of its own.
 */
export function leavesOf(nodes, parents = []) {
  return nodes.flatMap((n) => (n.kind === 'group' ? leavesOf(n.nodes, [...parents, n]) : [{node: n, parents}]));
}

// ---- Declarations ----

/** Text with its comments taken out. */
export const uncommented = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** The pieces of `s` between each `sep` outside strings and brackets, with where each starts and ends (trimmed). */
export function splitTop(s, sep) {
  const out = [];
  let i = 0;
  for (;;) {
    const j = findTop(s, i, s.length, sep);
    const end = j < 0 ? s.length : j;
    const raw = s.slice(i, end);
    const lead = raw.length - raw.trimStart().length;
    out.push({text: raw.trim(), start: i + lead, end: i + lead + raw.trim().length});
    if (j < 0) return out;
    i = j + 1;
  }
}

/** A rule's declarations: {prop (lower case; a custom property as written), value, important}. */
export function declarations(body) {
  return splitTop(uncommented(body), ';').filter((p) => p.text).map((p) => {
    const c = p.text.indexOf(':');
    if (c < 0) throw new Error(`a declaration without a colon: ${p.text}`);
    const name = p.text.slice(0, c).trim();
    let value = p.text.slice(c + 1).trim();
    const imp = /!\s*important\s*$/i.exec(value);
    if (imp) value = value.slice(0, imp.index).trim();
    return {prop: name.startsWith('--') ? name : name.toLowerCase(), value, important: !!imp};
  });
}

// ---- Selectors ----

const IDENT = /^(?:[-\w\u0080-\uffff]|\\.)+/;
/** The old pseudo-elements still written with one colon. */
const LEGACY_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
/** Pseudo-classes whose argument is a list of selectors. */
const SELECTOR_ARGS = new Set(['is', 'where', 'not', 'has', 'matches', '-webkit-any', 'host', 'host-context', 'slotted']);

/**
 * A complex selector: its compounds in order, each {parts, combinator (to the compound before it: ' ', '>', '+',
 * '~', or '' for the first; a relative selector's first may have one)}. A part is
 *   {kind: 'type'|'universal'|'id'|'class'|'attr'|'pseudo-class'|'pseudo-element', name, text, start, end,
 *    args?: string, list?: [{text, start, end, complex}] (an argument that is a list of selectors),
 *    attr?: {name, op, value}}
 * with start and end its place in `s` (from `offset`).
 */
export function parseComplex(s, offset = 0) {
  const compounds = [];
  let parts = [], combinator = '', i = 0;
  const flush = () => { if (parts.length) { compounds.push({parts, combinator}); parts = []; combinator = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j < s.length && !'>+~'.includes(s[j]) && parts.length) { flush(); combinator = ' '; }
      i = j;
      continue;
    }
    if ('>+~'.includes(c)) { flush(); combinator = c; i++; continue; }
    const start = i;
    let part;
    if (c === '*') { part = {kind: 'universal', name: '*'}; i++; }
    else if (c === '#' || c === '.') {
      const m = IDENT.exec(s.slice(i + 1));
      if (!m) throw new Error(`a selector this cannot read: ${s}`);
      part = {kind: c === '#' ? 'id' : 'class', name: m[0].replace(/\\(.)/g, '$1')};
      i += 1 + m[0].length;
    } else if (c === '[') {
      const e = findTop(s, i + 1, s.length, ']');
      if (e < 0) throw new Error(`a selector this cannot read: ${s}`);
      const inner = s.slice(i + 1, e).trim();
      const m = /^([-\w|*]+)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]]+)\s*([is])?)?$/i.exec(inner);
      if (!m) throw new Error(`an attribute selector this cannot read: [${inner}]`);
      const value = m[3] === undefined ? undefined : /^['"]/.test(m[3]) ? m[3].slice(1, -1) : m[3];
      part = {kind: 'attr', name: m[1].toLowerCase(), attr: {name: m[1].toLowerCase(), op: m[2] ?? '', value, flag: m[4] ?? ''}};
      i = e + 1;
    } else if (c === ':') {
      const element = s[i + 1] === ':';
      const m = IDENT.exec(s.slice(i + (element ? 2 : 1)));
      if (!m) throw new Error(`a selector this cannot read: ${s}`);
      const name = m[0].toLowerCase();
      i += (element ? 2 : 1) + m[0].length;
      part = {kind: element || LEGACY_ELEMENTS.has(name) ? 'pseudo-element' : 'pseudo-class', name};
      if (s[i] === '(') {
        const e = findTop(s, i + 1, s.length, ')');
        if (e < 0) throw new Error(`a selector this cannot read: ${s}`);
        part.args = s.slice(i + 1, e);
        const argsAt = i + 1;
        // Each argument with where it stands in the whole selector (start, end), as a part does.
        const args = (pieces, from = 0) => pieces.map((p) => ({text: p.text, start: offset + argsAt + from + p.start,
          end: offset + argsAt + from + p.end, complex: parseComplex(p.text, offset + argsAt + from + p.start)}));
        if (part.kind === 'pseudo-class' && SELECTOR_ARGS.has(name)) part.list = args(splitTop(part.args, ','));
        else if (part.kind === 'pseudo-class' && /^nth-(last-)?child$/.test(name)) {
          const of = /\bof\b/i.exec(part.args);
          if (of) part.list = args(splitTop(part.args.slice(of.index + of[0].length), ','), of.index + of[0].length);
        }
        i = e + 1;
      }
    } else {
      const m = /^(?:[-\w]+|\*)?\|?[-\w]+/.exec(s.slice(i));
      if (!m || c === '&') throw new Error(`a selector this cannot read: ${s}`);
      part = {kind: 'type', name: m[0].toLowerCase()};
      i += m[0].length;
    }
    part.start = offset + start;
    part.end = offset + i;
    part.text = s.slice(start, i);
    parts.push(part);
  }
  flush();
  return {text: s, compounds};
}

/** A rule's selector list: each complex selector with where it stands in the list's text. */
export function selectorList(selector) {
  return splitTop(selector, ',').map((p) => ({...p, complex: parseComplex(p.text, p.start)}));
}

/**
 * The text that takes `pieces[k]` out of a list of pieces (a selector list, or the arguments of :is()), as
 * [start, end]: the piece and the separator after it, or, for the last, the separator before it.
 */
export function cutOf(pieces, k) {
  if (pieces.length < 2) throw new Error('a list cannot lose its only piece');
  return k < pieces.length - 1 ? [pieces[k].start, pieces[k + 1].start] : [pieces[k - 1].end, pieces[k].end];
}

/** `text` with each [start, end, by] put in (the ranges may come in any order; they must not overlap). */
export function spliced(text, edits) {
  let out = text;
  for (const [s, e, by = ''] of [...edits].sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + by + out.slice(e);
  return out;
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const compareSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const maxSpec = (list) => list.reduce((m, s) => (compareSpec(s, m) > 0 ? s : m), [0, 0, 0]);
/** The weight :is(), :not() or :has() of these arguments has: the heaviest of them. */
export const listSpec = (list) => maxSpec(list.map((a) => specificity(a.complex)));

/** The specificity of a complex selector, as [ids, classes, types] (Selectors 4). */
export function specificity(complex) {
  let s = [0, 0, 0];
  for (const {parts} of complex.compounds) for (const p of parts) s = add(s, partSpec(p));
  return s;
}

function partSpec(p) {
  switch (p.kind) {
    case 'id': return [1, 0, 0];
    case 'class': case 'attr': return [0, 1, 0];
    case 'type': return [0, 0, 1];
    case 'universal': return [0, 0, 0];
    case 'pseudo-element': return [0, 0, 1];
    default:
      if (p.name === 'where') return [0, 0, 0];
      if (p.list && /^nth-/.test(p.name)) return add([0, 1, 0], maxSpec(p.list.map((a) => specificity(a.complex))));
      if (p.list) return maxSpec(p.list.map((a) => specificity(a.complex)));
      return [0, 1, 0];
  }
}

// ---- A rule, read ----

/** What a leaf is, read once: its complex selectors and its declarations; or the at-rule it is. */
export function readLeaf(leaf) {
  if (leaf.read) return leaf.read;
  const n = leaf.node;
  leaf.read = n.kind === 'rule' ? {kind: 'rule', sels: selectorList(n.selector).map((s) => s.complex), decls: declarations(n.body)}
    : {kind: 'at', name: n.name, prelude: n.prelude.replace(/\s+/g, ' ')};
  return leaf.read;
}
