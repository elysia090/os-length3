// Takes out of the stylesheet the rules no element can match: a selector that asks for a class, an id or an
// element the app never puts on the page. Run from anywhere:
//
//   node scripts/styles-prune.ts [--dry] [--report FILE] [SHEET]
//
// SHEET is app/styles.css unless named; when it is the entry styles-split.ts writes (only @imports), its parts are
// pruned each in place. --dry changes nothing and only says what it would take out; --report also writes what it
// says to FILE. Run it again and it finds nothing more.
//
// What the app can put on the page is read from its sources, not from a page drawn (styles-classes.ts): each place
// a class or an id is given, followed back to the strings it is made of; an element, any word a string holds.
// Anything this cannot read as never there stays.
//
// What goes:
//   - a selector of a rule's list whose compounds ask, somewhere, for what is never there (all of a rule's: the rule,
//     with the comment over it when that comment is over nothing that stays);
//   - an argument of :is(), :where(), :not() or :has() that can never match, when the others are as heavy (or it is
//     :where()), so what is left weighs the same.
// What is not looked at: two classes no element is given together (.section.offer), declarations a later rule
// always overrides. Those stay.

import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {madeBy, pageWords} from './styles-classes.ts';
import {compareSpec, cutOf, entryOf, leavesOf, listSpec, readSheet, selectorList, spliced, textOf, type Complex, type Piece, type SheetNode} from './styles-sheet.ts';

/** What the app can put on the page (styles-classes.ts): the classes, ids and elements a rule is read against. */
type App = Pick<ReturnType<typeof pageWords>, 'classes' | 'ids' | 'tags'>;
/** A piece taken out of a rule, and why. */
interface Said { what: string; why: string }
/** What a prune took out: a rule or a piece of one (where, what, why), or a comment that stays over the rule after. */
type Out = {line: number; what: string; why: string; whole: true} | {line: number; what: string; why: string; in: string; whole?: false}
  | {line: number; comment: string};

const OS = fileURLToPath(new URL('..', import.meta.url));

/** The page's own elements, there whatever the sources say. */
const ALWAYS = new Set(['html', 'head', 'body']);

/**
 * Why a complex selector can never match: the first thing it asks for that is never there (`.note`, `#x`, `kbd`,
 * `:is(…)` when none of its arguments can be), or '' when it can.
 */
export function neverMatches(app: App, complex: Complex): string {
  for (const {parts} of complex.compounds) {
    for (const p of parts) {
      if (p.kind === 'class' && !madeBy(app.classes, p.name)) return `.${p.name}`;
      if (p.kind === 'id' && !madeBy(app.ids, p.name)) return `#${p.name}`;
      if (p.kind === 'type' && !p.name.includes('|') && !ALWAYS.has(p.name) && !madeBy(app.tags, p.name)) return p.name;
      if (p.list && p.name !== 'not') {
        const why = p.list.map((a) => neverMatches(app, a.complex));
        if (why.every(Boolean)) return `${p.text.replace(/\s+/g, ' ')} (${[...new Set(why)].join(', ')})`;
      }
    }
  }
  return '';
}

/**
 * What to take out of one rule: {gone: true} for the whole rule, else the edits to its text ([start, end]) and what
 * each takes out, with why. Positions are in the rule's text, which starts with its selector.
 */
export function pruneRule(app: App, selector: string): {gone: true; why: string[]} | {gone: false; edits: [number, number][]; said: Said[]} {
  const list = selectorList(selector);
  const dead = list.map((s) => neverMatches(app, s.complex));
  if (dead.every(Boolean)) return {gone: true, why: [...new Set(dead)]};
  const edits: [number, number][] = [], said: Said[] = [];
  edits.push(...cuts(list, dead));
  list.forEach((s, k) => { const why = dead[k]; if (why) said.push({what: s.text, why}); });
  // Inside what stays: an argument that can never match, when taking it leaves the weight as it was.
  list.forEach((s, k) => {
    if (dead[k]) return;
    for (const {parts} of s.complex.compounds) {
      for (const p of parts) {
        if (!p.list || p.list.length < 2 || !['is', 'where', 'not', 'has', 'matches', '-webkit-any'].includes(p.name)) continue;
        const why = p.list.map((a) => neverMatches(app, a.complex));
        const keep = p.list.filter((_, i) => !why[i]);
        if (!keep.length || keep.length === p.list.length) continue;
        if (p.name !== 'where' && compareSpec(listSpec(keep), listSpec(p.list)) !== 0) continue;
        edits.push(...cuts(p.list, why));
        p.list.forEach((a, i) => { const w = why[i]; if (w) said.push({what: `${a.text} in :${p.name}()`, why: w}); });
      }
    }
  });
  return {gone: false, edits, said};
}

/** The cuts that take each piece marked in `out` out of `pieces`, from the last, each made against the list left. */
function cuts(pieces: Piece[], out: string[]): [number, number][] {
  const edits: [number, number][] = [];
  let left = [...pieces];
  for (let i = pieces.length - 1; i >= 0; i--) {
    const piece = pieces[i];
    if (!out[i] || !piece) continue;
    const at = left.indexOf(piece);
    edits.push(cutOf(left, at));
    left = left.filter((_, j) => j !== at);
  }
  return edits;
}

/** Every rule of a sheet's text pruned: {text, out: [{line, what, why}]}. */
export function pruneText(app: App, text: string): {text: string; out: Out[]} {
  const sheet = readSheet(text);
  const out: Out[] = [];
  /** The nodes that go: rules no element can match, and groups all of whose rules go. */
  const gone = new Set<SheetNode>();
  const prune = (nodes: SheetNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'group') { prune(n.nodes); if (n.nodes.every((c) => gone.has(c))) gone.add(n); continue; }
      if (n.kind !== 'rule') continue;
      const r = pruneRule(app, n.selector);
      if (r.gone) { gone.add(n); out.push({line: n.line, what: n.selector.replace(/\s+/g, ' '), why: r.why.join(', '), whole: true}); continue; }
      if (!r.edits.length) continue;
      n.text = spliced(n.text, r.edits);
      for (const s of r.said) out.push({line: n.line, what: s.what.replace(/\s+/g, ' '), why: s.why, in: n.selector.replace(/\s+/g, ' ')});
    }
  };
  prune(sheet.nodes);
  const keep = (nodes: SheetNode[]): SheetNode[] => {
    const left: SheetNode[] = [];
    const alone = (lead: string) => /\/\*|\n\s*\n/.test(lead);
    nodes.forEach((n, i) => {
      if (!gone.has(n)) { left.push(n); return; }
      let j = i + 1;
      for (let x = nodes[j]; x && gone.has(x) && !alone(x.lead); x = nodes[++j]);
      const next = nodes[j];
      // The comment over it goes with it when every rule it may be over (up to the next comment or blank line) goes;
      // else it stays, over the rule after it.
      if (/\/\*/.test(n.lead) && next && !gone.has(next) && !alone(next.lead)) {
        next.lead = n.lead;
        out.push({line: n.line, comment: (n.lead.match(/\/\*[\s\S]*?\*\//g) ?? []).join(' ').replace(/\s+/g, ' ')});
        return;
      }
      // A blank line before it stays before what comes after it.
      const after = nodes.slice(i + 1).find((x) => !gone.has(x));
      if (/^\s*\n\s*\n/.test(n.lead) && after && !/^\s*\n\s*\n/.test(after.lead)) after.lead = `\n${after.lead}`;
    });
    for (const n of left) if (n.kind === 'group') n.nodes = keep(n.nodes);
    return left;
  };
  const nodes = keep(sheet.nodes);
  return {text: textOf(nodes, sheet.tail), out};
}

/** The sheets SHEET stands for: itself, or the parts it imports and itself after them. */
export function sheetsOf(sheet: string): string[] {
  const entry = entryOf(readFileSync(sheet, 'utf8'));
  return entry ? [...entry.files.map((p) => resolve(dirname(sheet), p)), sheet] : [sheet];
}

function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {dry: {type: 'boolean'}, report: {type: 'string'}}});
  const entry = resolve(positionals[0] ?? join(OS, 'src', 'app', 'styles.css'));
  const app = pageWords(OS);
  const lines: string[] = [];
  let rules = 0, pieces = 0;
  const built: string[] = [];
  for (const file of sheetsOf(entry)) {
    const before = readFileSync(file, 'utf8');
    // An entry's own rules, after its @imports, are pruned as a sheet of their own.
    const own = entryOf(before);
    const pruned = pruneText(app, own ? own.rest : before);
    const text = own ? own.head + pruned.text : pruned.text;
    const out = pruned.out.map((o) => ({...o, line: o.line + (own ? own.head.split('\n').length - 1 : 0)}));
    const name = file.startsWith(OS) ? relative(OS, file) : file;
    for (const o of out) {
      if ('comment' in o) { lines.push(`${name}:${o.line}  the comment over it stays, over the rule after it: ${o.comment.slice(0, 100)}`); continue; }
      if (o.whole) rules++; else pieces++;
      lines.push(o.whole ? `${name}:${o.line}  ${o.what}\n    never matches: no source puts ${o.why} on the page`
        : `${name}:${o.line}  ${o.what}, out of ${o.in}\n    never matches: no source puts ${o.why} on the page`);
    }
    if (text !== before && !values.dry) writeFileSync(file, text);
    // What may be built rather than written whole: kept, and said, so the trust it rests on can be seen.
    for (const leaf of leavesOf(readSheet(pruned.text).nodes)) {
      if (leaf.node.kind !== 'rule') continue;
      for (const m of leaf.node.selector.matchAll(/([.#])(-?[_a-zA-Z][-\w]*)/g)) {
        const how = madeBy(m[1] === '.' ? app.classes : app.ids, m[2] ?? '');
        if (how !== 'word') built.push(`${m[0]} (${how})`);
      }
    }
  }
  const head = `${values.dry ? 'Would take out' : 'Took out'} ${rules} rule(s) and ${pieces} selector(s) or argument(s) no element can match`
    + ` (what the app can put on the page read from ${app.files.length} sources; lines as they were).`;
  const kept = [...new Set(built)].sort();
  const unread = (what: 'class' | 'id', head: string, most = Infinity) => {
    const all = app.unread.filter((u) => u.what === what).map((u) => `  ${u.at}`);
    return all.length ? ['', head, ...all.slice(0, most), ...(all.length > most ? [`  and ${all.length - most} more`] : [])] : [];
  };
  const report = [head, '', ...lines,
    ...(kept.length ? ['', 'Kept, as a value written after (or before) a word may make them:', ...kept.map((k) => `  ${k}`)] : []),
    ...unread('class', 'Where a class is given from what could not be followed (any word of a string may then be a class):'),
    ...unread('id', 'Ids given from what could not be followed (so any word of a string may be an id):', 8),
  ].join('\n') + '\n';
  process.stdout.write(report);
  if (values.report) writeFileSync(values.report, report);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
