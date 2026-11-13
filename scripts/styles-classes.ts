// What the app can put on the page, read from its sources rather than from a page drawn (styles-prune.ts): the
// classes, the ids and the elements. Every place a class is given is followed back to the words it is made of:
//
//   h('div', {class: …}), el.className = …, el.classList.add(…) / toggle / replace, setAttribute('class', …)
//   (ids: an `id` property, el.id = …, setAttribute('id', …)); and the page (why/app/index.html), and public/'s scripts.
//
// What is given is read as far as it is written: a string, a template, a choice (a ? b : c, a ?? b), a + b, .trim();
// a name given a value in its file; a function's parameter, from what each call gives it (or its type, when that is a
// few strings); a property, from its type, or from every value an object anywhere gives a property of that name.
// Where a template or a + puts a value right after a word, every class starting with the word may be made
// (`tier-${tier}`: tier-…), and so on for one right before a word, or between two.
//
// What cannot be followed (a value from a call, from data) may be any word written in a string anywhere in the
// sources: that is the one thing taken on trust, that a class is never put together from parts none of which is a
// word written whole (from what a person typed). The tests and why/app/testing/ are not the app; the Japanese of
// why/app/i18n/ and the English given to t() are words said, not classes, unless a class is ever made from t().

import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {parseSync, type ESTree} from 'vite';

/** The app's page, under the tree it is read from. */
const PAGE = 'why/app/index.html';
/** A word as it may be a class, an id or an element's name. */
const WORD = /[-\w]+/g;
const lower = (s: string) => s.toLowerCase();

type Node = ESTree.Node;
/** What a given value may be: words whole, and parts of words (a word a value runs into the end, start or both of). */
export interface Words { words: Set<string>; prefixes: Set<string>; suffixes: Set<string>; infixes: Set<string>; unknown: boolean }
/** A value read: its words, and while they are few, the strings it may be exactly. */
interface Value extends Words { strings?: Set<string> }
const PARTS = ['words', 'prefixes', 'suffixes', 'infixes'] as const;
const empty = (): Value => ({words: new Set(), prefixes: new Set(), suffixes: new Set(), infixes: new Set(), unknown: false});
const merge = <T extends Words>(into: T, from: Words): T => {
  for (const k of PARTS) for (const w of from[k]) into[k].add(w);
  into.unknown ||= from.unknown;
  return into;
};
const UNKNOWN = (): Value => ({...empty(), unknown: true});

/** A source of the app, parsed, with what is declared, imported and read as a value in it. */
interface Source {
  file: string; text: string; program: ESTree.Program;
  /** Each name's values as declared or assigned (null: a function's own name). */
  decls: Map<string, (Node | null)[]>;
  imports: Map<string, {from: string; name: string | null}>;
  values: Set<string>;
  namespaces: Map<string, string>;
}
/** A place a class or an id is given. */
interface Sink { what: 'class' | 'id'; file: Source; value: Node }
/** A call of a function: by its name, after a dot, or on a module read whole. */
interface Call { file: Source; call: ESTree.CallExpression; by: 'name' | 'member' | 'module' }
/** A value a property is given, or the type it is declared with. */
type Given = {file: Source; value: Node; typed?: false} | {file: Source; typed: true; type: ESTree.TSType | undefined};
interface Index {
  sinks: Sink[]; calls: Map<string, Call[]>; props: Map<string, Given[]>; types: Map<string, (ESTree.TSType | ESTree.TSInterfaceBody)[]>;
  memberValues: Set<string>; reexported: Set<string>; named: Map<string, Call[]>; escaped: Set<string>; unseen: boolean;
  words: Set<string>; files: Source[]; tInClass: boolean;
}
interface Ctx { index: Index; memo: Map<string, Value>; busy: Set<string> }
type Fn = ESTree.Function | ESTree.ArrowFunctionExpression;

/** The sources of the app: why/'s modules (not its tests, why/app/testing/ or why/app/i18n/), and public/'s scripts. */
export function appSources(os: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (p !== join(os, 'why', 'app', 'testing') && p !== join(os, 'why', 'app', 'i18n')) walk(p); }
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
    }
  };
  walk(join(os, 'why', 'app'));
  const pub = join(os, 'public');
  if (existsSync(pub)) for (const e of readdirSync(pub, {withFileTypes: true})) if (e.isFile() && /\.m?js$/.test(e.name)) out.push(join(pub, e.name));
  return out.sort();
}

const isNode = (x: unknown): x is Node => !!x && typeof x === 'object' && typeof (x as {type?: unknown}).type === 'string';

/** Each node under `node`, with `parent` set on it; `visit` returning false keeps out of the node's children. */
function walk(node: unknown, parent: Node | null, visit: (n: Node) => boolean): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) walk(x, parent, visit); return; }
  const here = isNode(node) ? node : null;
  if (here) {
    Object.defineProperty(here, 'parent', {value: parent, enumerable: false, configurable: true, writable: true});
    if (visit(here) === false) return;
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, here ?? parent, visit);
}

const isFunction = (n: Node | null | undefined): n is Fn => n?.type === 'FunctionDeclaration' || n?.type === 'FunctionExpression' || n?.type === 'ArrowFunctionExpression';
const keyName = (k: Node | null | undefined): string | null => (k?.type === 'Identifier' ? k.name : k?.type === 'Literal' && typeof k.value === 'string' ? k.value : null);
const stringLiteral = (n: Node | null | undefined): n is ESTree.StringLiteral => n?.type === 'Literal' && typeof n.value === 'string';
/** The name a member expression reads (`o.name`), when it is not computed. */
const memberName = (n: Node | null | undefined): string | null => (n?.type === 'MemberExpression' && !n.computed ? n.property.name : null);
/** The type a parameter or a property is declared with, if any. */
const annotated = (n: Node | null | undefined): ESTree.TSType | undefined => {
  const a = n && 'typeAnnotation' in n ? n.typeAnnotation : null;
  return a?.type === 'TSTypeAnnotation' ? a.typeAnnotation : undefined;
};

/**
 * The words the app can put on the page: {classes, ids, tags}, each {words, prefixes, suffixes, infixes} in lower
 * case, with `unread`: each place a class or an id is given that could not be followed ({what: 'class' | 'id', at}).
 */
export function pageWords(os: string) {
  const files = appSources(os).map((file): Source => {
    const text = readFileSync(file, 'utf8');
    const r = parseSync(file, text, {lang: file.endsWith('.ts') ? 'ts' : 'js'});
    if (r.errors.length) throw new Error(`${relative(os, file)} cannot be read: ${r.errors[0]?.message}`);
    return {file, text, program: r.program, decls: new Map(), imports: new Map(), values: new Set(), namespaces: new Map()};
  });
  const index = indexOf(files);
  const ctx: Ctx = {index, memo: new Map(), busy: new Set()};

  const classes = empty(), ids = empty(), unread: {what: 'class' | 'id'; at: string}[] = [];
  for (const s of index.sinks) {
    const v = valueOf(ctx, s.file, s.value, 0);
    merge(s.what === 'class' ? classes : ids, wordsOf(v));
    const e = s.value;
    if (v.unknown) unread.push({what: s.what, at: `${relative(os, s.file.file)}:${lineOf(s.file.text, e.start)}  ${s.file.text.slice(e.start, e.end).replace(/\s+/g, ' ').slice(0, 120)}`});
  }
  const html = readFileSync(join(os, PAGE), 'utf8');
  for (const m of html.matchAll(/\b(class|id)="([^"]*)"/g)) for (const w of m[2]?.match(WORD) ?? []) (m[1] === 'class' ? classes : ids).words.add(lower(w));

  // Whatever could not be followed may be any word of a string; an element, any word at all that names one.
  const said = empty();
  for (const w of index.words) said.words.add(w);
  for (const w of html.match(WORD) ?? []) said.words.add(lower(w));
  if (classes.unknown) merge(classes, said);
  if (ids.unknown) merge(ids, said);
  return {classes, ids, tags: said, unread, files: files.map((f) => relative(os, f.file)).concat(PAGE)};
}

const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length;

/** What the analysis looks things up in: where classes and ids are given, declarations, functions, calls, properties. */
function indexOf(files: Source[]): Index {
  const index: Index = {sinks: [], calls: new Map(), props: new Map(), types: new Map(), memberValues: new Set(), reexported: new Set(),
    named: new Map(), escaped: new Set(), unseen: false, words: new Set(), files, tInClass: false};
  const add = <K, V>(map: Map<K, V[]>, k: K, v: V) => { const at = map.get(k); if (at) at.push(v); else map.set(k, [v]); };
  for (const file of files) {
    // Every node's parent first, so what is read below may look up from any node.
    walk(file.program, null, () => true);
    walk(file.program, null, (n) => {
      const sink = (what: 'class' | 'id', value: Node) => index.sinks.push({what, file, value});
      // A `class` (or className, as Object.assign gives it) or `id` in any object: h()'s props, and any other.
      if (n.type === 'Property' && !n.computed && ['class', 'className'].includes(keyName(n.key) ?? '')) sink('class', n.value);
      if (n.type === 'Property' && !n.computed && keyName(n.key) === 'id') sink('id', n.value);
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed) {
        const p = n.left.property.name, on = n.left.object;
        // h() itself (ui/dom.ts) gives className what its caller's `class` property holds, read there already.
        if (p === 'className' && !fromEntries(n.right)) sink('class', n.right);
        if (p === 'value' && memberName(on) === 'classList') sink('class', n.right);
        if (p === 'id') sink('id', n.right);
        if (p === 'innerHTML' || p === 'outerHTML') { sink('class', n.right); sink('id', n.right); }
        add(index.props, p, {file, value: n.right});
      }
      // A function's name read as a value (passed on, kept) is called where this cannot see.
      if (n.type === 'Identifier' && n.parent && !(n.parent.type === 'CallExpression' && n.parent.callee === n) && !declares(n)) file.values.add(n.name);
      if (n.type === 'MemberExpression' && !n.computed && !(n.parent?.type === 'CallExpression' && n.parent.callee === n)) index.memberValues.add(n.property.name);
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed) {
        const m = n.callee.property.name, on = n.callee.object;
        if (memberName(on) === 'classList') {
          const given = m === 'add' ? n.arguments : m === 'toggle' ? n.arguments.slice(0, 1) : m === 'replace' ? n.arguments.slice(1, 2) : [];
          for (const a of given) index.sinks.push({what: 'class', file, value: a});
        }
        const [name, value] = n.arguments;
        if (m === 'setAttribute' && value) {
          if (stringLiteral(name)) { if (name.value === 'class' || name.value === 'id') sink(name.value, value); }
          // An attribute named by a value may be either, but for what h() copies from its props (read there).
          else if (!fromEntries(value)) { sink('class', value); sink('id', value); }
        }
        if (m === 'insertAdjacentHTML' && value) { sink('class', value); sink('id', value); }
      }
      if (n.type === 'CallExpression') {
        if (n.callee.type === 'Identifier') add(index.calls, n.callee.name, {file, call: n, by: 'name'});
        else if (n.callee.type === 'MemberExpression' && !n.callee.computed) add(index.calls, n.callee.property.name, {file, call: n, by: 'member'});
      }
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') add(file.decls, n.id.name, n.init);
      if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') add(file.decls, n.left.name, n.right);
      if (n.type === 'FunctionDeclaration' && n.id) add(file.decls, n.id.name, null);
      const key = 'key' in n && !('computed' in n && n.computed) ? keyName(n.key) : null;
      if (n.type === 'Property' && key) add(index.props, key, {file, value: n.value});
      if (n.type === 'PropertyDefinition' && key && n.value) add(index.props, key, {file, value: n.value});
      if (n.type === 'TSPropertySignature' && key) add(index.props, key, {file, typed: true, type: annotated(n)});
      if (n.type === 'TSTypeAliasDeclaration') add(index.types, n.id.name, n.typeAnnotation);
      if (n.type === 'TSInterfaceDeclaration') add(index.types, n.id.name, n.body);
      // A module imported as it runs: its functions are called as m.f() on the name it is given, or anyhow.
      if (n.type === 'ImportExpression') {
        if (!stringLiteral(n.source)) index.unseen = true;
        else if (n.source.value.startsWith('.')) {
          const from = moduleAt(file, n.source.value), p = n.parent?.type === 'AwaitExpression' ? n.parent.parent : n.parent;
          const then = memberName(p) === 'then' && p?.parent?.type === 'CallExpression' ? p.parent.arguments[0] : null;
          const first = isFunction(then) ? then.params[0] : null;
          if (p?.type === 'VariableDeclarator' && p.id.type === 'Identifier') file.namespaces.set(p.id.name, from);
          else if (first?.type === 'Identifier') file.namespaces.set(first.name, from);
          else index.escaped.add(from);
        }
      }
      // A function exported again (from here or from another module) is called by a name this does not follow.
      if (n.type === 'ExportSpecifier') {
        const source = n.parent?.type === 'ExportNamedDeclaration' ? n.parent.source : null;
        const from = source ? moduleAt(file, source.value) : file.file;
        index.reexported.add(`${from}:${keyName(n.local)}`);
      }
      if (n.type === 'ImportDeclaration') {
        const from = moduleAt(file, n.source.value);
        for (const s of n.specifiers) {
          if (s.type === 'ImportSpecifier') file.imports.set(s.local.name, {from, name: keyName(s.imported)});
          // A module read whole (import * as m), or its default: its functions are called as m.f().
          else file.namespaces.set(s.local.name, from);
        }
      }
      // Every word a string holds, for what cannot be followed: but not t()'s English.
      if (stringLiteral(n) && !(n.parent?.type === 'CallExpression' && n.parent.callee.type === 'Identifier' && n.parent.callee.name === 't' && n.parent.arguments[0] === n)) {
        for (const w of n.value.match(WORD) ?? []) index.words.add(lower(w));
      }
      if (n.type === 'TemplateElement') for (const w of (n.value.cooked ?? n.value.raw).match(WORD) ?? []) index.words.add(lower(w));
      return true;
    });
  }
  // What each module read whole is given as: m.f() a call of its f, m.f read a value, m itself passed on all of it.
  for (const file of files) {
    if (!file.namespaces.size) continue;
    walk(file.program, null, (n) => {
      if (n.type !== 'Identifier' || !file.namespaces.has(n.name) || declares(n)) return true;
      const from = file.namespaces.get(n.name), p = n.parent;
      if (p?.type === 'MemberExpression' && p.object === n && !p.computed) {
        const key = `${from}:${p.property.name}`;
        if (p.parent?.type === 'CallExpression' && p.parent.callee === p) add(index.named, key, {file, call: p.parent, by: 'module'});
        else index.reexported.add(key);
      } else if (!(isFunction(p) && (p.params as Node[]).includes(n)) && from) index.escaped.add(from);
      return true;
    });
  }
  // A class made from t(): its English is then a class's words too.
  for (const s of index.sinks) {
    walk(s.value, s.value.parent ?? null, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 't') index.tInClass = true;
      return true;
    });
  }
  if (index.tInClass) {
    for (const file of files) walk(file.program, null, (n) => { if (stringLiteral(n)) for (const w of n.value.match(WORD) ?? []) index.words.add(lower(w)); return true; });
  }
  return index;
}

/** The file a module specifier names from `file`. */
function moduleAt(file: Source, spec: string): string {
  const at = resolve(dirname(file.file), spec);
  return /\.[mc]?[jt]s$/.test(at) ? at : `${at}.ts`;
}

/** Whether identifier `n` is where a name is declared, or a key, rather than a name read. */
function declares(n: Node): boolean {
  const p = n.parent;
  if (!p) return true;
  if ((p.type === 'VariableDeclarator' || p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' || p.type === 'ClassDeclaration') && p.id === n) return true;
  if ((p.type === 'Property' || p.type === 'PropertyDefinition' || p.type === 'MethodDefinition' || p.type === 'TSPropertySignature') && p.key === n && !p.computed && !(p.type === 'Property' && p.shorthand)) return true;
  if (p.type === 'MemberExpression' && p.property === n && !p.computed) return true;
  if (/^(Import|Export)\w*Specifier$/.test(p.type) || p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') return true;
  if (isFunction(p) && (p.params as Node[]).includes(n)) return true;
  if (p.type === 'AssignmentPattern' && p.left === n) return true;
  if (/^TS/.test(p.type)) return true;
  return false;
}

/** Whether `e` is a name bound by `for (const [k, v] of Object.entries(…))`: what h() copies from its props. */
function fromEntries(e: Node): boolean {
  if (e.type !== 'Identifier') return false;
  for (let p: Node | null | undefined = e.parent; p; p = p.parent) {
    if (p.type !== 'ForOfStatement') continue;
    const d = p.left.type === 'VariableDeclaration' ? p.left.declarations[0] : undefined;
    const right = p.right;
    if (d?.id.type === 'ArrayPattern' && d.id.elements.some((x) => x?.type === 'Identifier' && x.name === e.name)
      && right.type === 'CallExpression' && right.callee.type === 'MemberExpression' && !right.callee.computed
      && right.callee.object.type === 'Identifier' && right.callee.object.name === 'Object' && right.callee.property.name === 'entries') return true;
  }
  return false;
}

/** The words an expression may hold. */
function valueOf(ctx: Ctx, file: Source, e: Node | null | undefined, depth: number): Value {
  if (!e) return exactly('');
  const key = `${file.file}:${e.start}:${e.end}:${e.type}`;
  const known = ctx.memo.get(key);
  if (known) return known;
  if (ctx.busy.has(key) || depth > 12) return UNKNOWN();
  ctx.busy.add(key);
  const v = read(ctx, file, e, depth + 1);
  ctx.busy.delete(key);
  ctx.memo.set(key, v);
  return v;
}

/** At most this many strings are kept as they are; past that, only their words. */
const CAP = 256;
/** A value that is one of these strings. */
const exactly = (...strings: string[]): Value => ({...empty(), strings: new Set(strings)});

/** A value as words: what a value of known strings holds, its words. */
function wordsOf(v: Value): Value {
  if (!v.strings) return v;
  const out = empty();
  for (const s of v.strings) for (const w of s.match(WORD) ?? []) out.words.add(lower(w));
  return out;
}

/** One value or the other. */
function either(a: Value, b: Value): Value {
  if (a.strings && b.strings && a.strings.size + b.strings.size <= CAP) return {...empty(), strings: new Set([...a.strings, ...b.strings])};
  return merge(merge(empty(), wordsOf(a)), wordsOf(b));
}

/**
 * Values put one after another (a template, a + b): every string they make, when they are few; else their words,
 * a word at an edge where an unknown value meets it being the start (or end) of whatever class it runs into.
 */
function concat(values: Value[]): Value {
  const known = values.map((v) => v.strings);
  if (known.every((s) => s !== undefined) && known.reduce((n, s) => n * s.size, 1) <= CAP) {
    let out = [''];
    for (const s of known) out = out.flatMap((a) => [...s].map((b) => a + b));
    return {...empty(), strings: new Set(out)};
  }
  const out = empty();
  values.forEach((v, i) => {
    merge(out, wordsOf(v));
    if (!v.strings) return;
    const before = i > 0, after = i < values.length - 1;
    for (const s of v.strings) {
      const words = s.match(WORD) ?? [];
      const first = words[0], last = words.at(-1);
      const startsWord = /^[-\w]/.test(s), endsWord = /[-\w]$/.test(s);
      if (before && after && words.length === 1 && startsWord && endsWord && first) out.infixes.add(lower(first));
      else {
        if (before && startsWord && first) out.suffixes.add(lower(first));
        if (after && endsWord && last) out.prefixes.add(lower(last));
      }
    }
  });
  return out;
}

function plusItems(e: Node): Node[] {
  if (e.type === 'BinaryExpression' && e.operator === '+') return [...plusItems(e.left), ...plusItems(e.right)];
  return [e];
}

/** What a falsy value is, written as a class: a && b may be a. */
const FALSY = exactly('', 'false', '0', 'null', 'undefined', 'NaN');
/** The string methods that keep a string's words as they are, but for case or room at its ends. */
const CASE: Record<string, (s: string) => string> = {trim: (s) => s.trim(), trimStart: (s) => s.trimStart(), trimEnd: (s) => s.trimEnd(),
  toLowerCase: (s) => s.toLowerCase(), toUpperCase: (s) => s.toUpperCase()};

function read(ctx: Ctx, file: Source, e: Node, depth: number): Value {
  switch (e.type) {
    case 'Literal': return exactly(e.value === null ? 'null' : String(e.value));
    case 'TemplateLiteral': {
      const items: Value[] = [];
      e.quasis.forEach((q, i) => {
        items.push(exactly(q.value.cooked ?? q.value.raw));
        if (i < e.expressions.length) items.push(valueOf(ctx, file, e.expressions[i], depth));
      });
      return concat(items);
    }
    case 'BinaryExpression': return e.operator === '+' ? concat(plusItems(e).map((x) => valueOf(ctx, file, x, depth))) : UNKNOWN();
    case 'ConditionalExpression': return either(valueOf(ctx, file, e.consequent, depth), valueOf(ctx, file, e.alternate, depth));
    case 'LogicalExpression': return either(e.operator === '&&' ? FALSY : valueOf(ctx, file, e.left, depth), valueOf(ctx, file, e.right, depth));
    case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSNonNullExpression': case 'TSSatisfiesExpression': case 'ChainExpression':
      return valueOf(ctx, file, e.expression, depth);
    // An array's words (it is a class only once joined).
    case 'ArrayExpression': return e.elements.reduce((o, x) => merge(o, wordsOf(x?.type === 'SpreadElement' ? valueOf(ctx, file, x.argument, depth) : x ? valueOf(ctx, file, x, depth) : FALSY)), empty());
    case 'UnaryExpression': return e.operator === '!' ? exactly('true', 'false') : e.operator === 'void' ? exactly('undefined') : UNKNOWN();
    case 'CallExpression': {
      const c = e.callee;
      if (c.type === 'MemberExpression' && !c.computed) {
        const m = c.property.name, v = () => valueOf(ctx, file, c.object, depth);
        const change = CASE[m];
        if (change) {
          const x = v();
          return x.strings ? {...empty(), strings: new Set([...x.strings].map(change))} : x;
        }
        if (m === 'filter') return v();
        // Words joined by a space stay words; joined by anything else, each may run into the next.
        if (m === 'join') {
          const sep = e.arguments[0];
          return !sep || (stringLiteral(sep) && /^\s*$/.test(sep.value)) ? wordsOf(v()) : UNKNOWN();
        }
      }
      if (c.type === 'Identifier' && c.name === 'String') return valueOf(ctx, file, e.arguments[0], depth);
      return UNKNOWN();
    }
    case 'Identifier': return nameValue(ctx, file, e, depth);
    case 'MemberExpression': return e.computed ? UNKNOWN() : propertyValue(ctx, file, e, depth);
    default: return UNKNOWN();
  }
}

/** The value of each declaration given, one or another. */
const anyOf = (values: Value[]) => (values.length ? values.reduce(either) : UNKNOWN());

/** The words a name may hold where it is read: a parameter of the function it is in, or what its file gives it. */
function nameValue(ctx: Ctx, file: Source, e: Extract<Node, {type: 'Identifier'}>, depth: number): Value {
  if (e.name === 'undefined') return exactly('undefined');
  for (let p: Node | null | undefined = e.parent; p; p = p.parent) {
    if (!isFunction(p)) continue;
    const at = p.params.findIndex((x) => paramName(x) === e.name);
    if (at >= 0) return paramValue(ctx, file, p, at, depth);
  }
  const decls = file.decls.get(e.name);
  if (decls) return anyOf(decls.map((d) => (d ? valueOf(ctx, file, d, depth) : UNKNOWN())));
  const imported = file.imports.get(e.name);
  if (imported) {
    const from = ctx.index.files.find((f) => f.file === imported.from);
    const there = imported.name === null ? undefined : from?.decls.get(imported.name);
    if (from && there) return anyOf(there.map((d) => (d ? valueOf(ctx, from, d, depth) : UNKNOWN())));
  }
  return UNKNOWN();
}

const paramName = (x: Node): string | null => (x.type === 'Identifier' ? x.name : x.type === 'AssignmentPattern' && x.left.type === 'Identifier' ? x.left.name
  : x.type === 'TSParameterProperty' ? paramName(x.parameter) : null);

/** Strings a type names (`'a' | 'b'`), or null when it names anything else. */
function typeWords(t: ESTree.TSType | null | undefined): string[] | null {
  if (!t) return null;
  if (t.type === 'TSLiteralType' && stringLiteral(t.literal)) return [t.literal.value];
  if (t.type === 'TSUnionType') {
    const parts = t.types.map(typeWords);
    return parts.every((p) => p !== null) ? parts.flat() : null;
  }
  if (t.type === 'TSUndefinedKeyword') return ['undefined'];
  if (t.type === 'TSNullKeyword') return ['null'];
  return null;
}

/** The words parameter `at` of function `fn` may hold: its type's strings, else its default and what each call gives. */
function paramValue(ctx: Ctx, file: Source, fn: Fn, at: number, depth: number): Value {
  const param = fn.params[at];
  if (!param) return UNKNOWN();
  const base = param.type === 'AssignmentPattern' ? param.left : param;
  const typed = typeWords(annotated(base));
  if (typed) return exactly(...typed);
  const calls = callsOf(ctx, file, fn);
  if (!calls) return UNKNOWN();
  const given = param.type === 'AssignmentPattern' ? [valueOf(ctx, file, param.right, depth)] : [];
  for (const {file: f, call} of calls) {
    if (call.arguments.slice(0, at + 1).some((a) => a.type === 'SpreadElement')) return UNKNOWN();
    const a = call.arguments[at];
    given.push(a ? valueOf(ctx, f, a, depth) : exactly('undefined'));
  }
  return anyOf(given);
}

/**
 * Every call of function `fn` (declared in `file`), or null when it may be called where this cannot see: one named
 * (by its own name or its variable's) is called by that name in its file and in the files that import it; a method
 * or a property's function, by that name after a dot anywhere. Read as a value anywhere (passed on), it is not known.
 */
function callsOf(ctx: Ctx, file: Source, fn: Fn): Call[] | null {
  const p = fn.parent;
  // A module's default is called by whatever name each importer gives it.
  if (p?.type === 'ExportDefaultDeclaration') return null;
  const named = fn.type === 'FunctionDeclaration' ? fn.id?.name : p?.type === 'VariableDeclarator' && p.id.type === 'Identifier' ? p.id.name : null;
  if (named) {
    if (ctx.index.unseen || ctx.index.escaped.has(file.file) || ctx.index.reexported.has(`${file.file}:${named}`)) return null;
    const there = new Set([file, ...ctx.index.files.filter((f) => [...f.imports.values()].some((i) => i.from === file.file && i.name === named))]);
    if ([...there].some((f) => f.values.has(named))) return null;
    const calls = [...(ctx.index.calls.get(named) ?? []).filter((c) => c.by === 'name' && there.has(c.file)), ...(ctx.index.named.get(`${file.file}:${named}`) ?? [])];
    return calls.length ? calls : null;
  }
  const name = (p?.type === 'MethodDefinition' || p?.type === 'Property' || p?.type === 'PropertyDefinition') && !p.computed ? keyName(p.key) : null;
  if (name) {
    if (ctx.index.memberValues.has(name)) return null;
    const calls = (ctx.index.calls.get(name) ?? []).filter((c) => c.by === 'member');
    return calls.length ? calls : null;
  }
  return null;
}

/**
 * The words property `o.p` may hold: when `o` is a parameter, what each call's object gives `p`; else from the type
 * `o` is declared with; else every value any object anywhere gives a `p`.
 */
function propertyValue(ctx: Ctx, file: Source, e: ESTree.StaticMemberExpression | ESTree.PrivateFieldExpression, depth: number): Value {
  const p = e.property.name;
  const given = optionValue(ctx, file, e.object, p, depth);
  if (given) return given;
  const m = declaredMembers(ctx, e.object)?.find((x) => x.type === 'TSPropertySignature' && keyName(x.key) === p);
  const words = typeWords(annotated(m));
  if (words) return exactly(...words);
  return anyOf((ctx.index.props.get(p) ?? []).map((g) => {
    if (!g.typed) return valueOf(ctx, g.file, g.value, depth);
    const words = typeWords(g.type);
    return words ? exactly(...words) : UNKNOWN();
  }));
}

/** What property `p` of parameter `o` holds, from the object each call (or the default) gives it; null if not that. */
function optionValue(ctx: Ctx, file: Source, o: Node, p: string, depth: number): Value | null {
  if (o.type !== 'Identifier') return null;
  for (let fn: Node | null | undefined = o.parent; fn; fn = fn.parent) {
    if (!isFunction(fn)) continue;
    const at = fn.params.findIndex((x) => paramName(x) === o.name);
    if (at < 0) continue;
    const calls = callsOf(ctx, file, fn);
    if (!calls) return null;
    const param = fn.params[at];
    const of = (obj: Node | null | undefined, f: Source): Value | null => {
      if (obj?.type !== 'ObjectExpression') return null;
      if (obj.properties.some((x) => x.type === 'SpreadElement' || x.computed)) return UNKNOWN();
      const prop = obj.properties.find((x) => x.type === 'Property' && keyName(x.key) === p);
      return prop?.type === 'Property' ? valueOf(ctx, f, prop.value, depth) : exactly('undefined');
    };
    const values: Value[] = [];
    for (const {file: f, call} of calls) {
      if (call.arguments.slice(0, at + 1).some((a) => a.type === 'SpreadElement')) return null;
      const a = call.arguments[at];
      const v = a ? of(a, f) : param?.type === 'AssignmentPattern' ? of(param.right, file) : exactly('undefined');
      if (!v) return null;
      values.push(v);
    }
    return anyOf(values);
  }
  return null;
}

/**
 * The members of the type a parameter is declared with, when that is an object type written there or named in the
 * project (`m: Mark`, `m: {kind: 'a' | 'b'}`, `o: Partial<{kind: …}>`); else null.
 */
function declaredMembers(ctx: Ctx, o: Node): ESTree.TSSignature[] | null {
  if (o.type !== 'Identifier') return null;
  for (let p: Node | null | undefined = o.parent; p; p = p.parent) {
    if (!isFunction(p)) continue;
    const x = p.params.find((q) => paramName(q) === o.name);
    if (x) return membersOf(ctx, annotated(x.type === 'AssignmentPattern' ? x.left : x));
  }
  return null;
}

function membersOf(ctx: Ctx, t: ESTree.TSType | ESTree.TSInterfaceBody | null | undefined): ESTree.TSSignature[] | null {
  if (!t) return null;
  if (t.type === 'TSTypeLiteral') return t.members;
  if (t.type === 'TSInterfaceBody') return t.body;
  if (t.type !== 'TSTypeReference' || t.typeName.type !== 'Identifier') return null;
  const args = t.typeArguments?.params ?? [];
  if (['Partial', 'Readonly', 'Required'].includes(t.typeName.name) && args.length === 1) return membersOf(ctx, args[0]);
  const decls = ctx.index.types.get(t.typeName.name);
  return decls?.length === 1 ? membersOf(ctx, decls[0]) : null;
}

/** How the sources may put `name` on the page: 'word', the prefix, suffix or infix that may make it, or '' (never). */
export function madeBy(words: Words, name: string): string {
  const n = lower(name);
  if (words.words.has(n)) return 'word';
  for (const p of words.prefixes) if (n.startsWith(p)) return `${p}…`;
  for (const s of words.suffixes) if (n.endsWith(s)) return `…${s}`;
  for (const i of words.infixes) if (n.includes(i)) return `…${i}…`;
  return '';
}
