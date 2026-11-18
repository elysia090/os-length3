// why's layers, in order, and every import against that order: a module of a tree (a directory under it, or the
// files directly in it, '.') takes from the modules before it in its tree's order and from nothing after it. A tree
// may hold a tree of its own (app/, and pages/ in it), ordered the same way within it. A type taken counts as much
// as a value: what a module names of another, it depends on.
//
//   node scripts/layers.ts          the imports against the order, each with the file that makes it; fails if any
//
// Tests (*.test.ts, why/app/testing/) are left out: a test may take from any layer it puts together.
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const OS = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each tree, its modules from the bottom up. A module not named is wrong in its tree until it is. */
export const TREES: {root: string; order: string[]; skip?: string[]; build?: string[]; buildHosts?: string[]}[] = [
  // why's parts (docs/STRUCTURE.md), each a folder of all it is whatever it is written in, then the window: a part
  // takes nothing from a face. cli/ and desktop/ are Rust's (below, and cargo's own), test/ drives the whole. build/ composes the release; runtime code must never take from it.
  {root: 'why', order: ['text', 'agent', 'api', 'ssh', 'repo', 'home', 'shipto', 'prompt', 'device', 'app'], skip: ['cli', 'desktop', 'test'], build: ['build'],
    buildHosts: ['why/app/vite.config.ts', 'why/app/testing/', 'why/test/']},
  // The window: what is drawn with (ui), what a host is asked for a page (host), the pages, and what starts them.
  {root: 'why/app', order: ['ui', 'host', 'pages', 'main', '.'], skip: ['styles', 'shims', 'testing']},
  // The pages: what they share (kit), the bench Forge and Git work at (with its search), then each page.
  {root: 'why/app/pages', order: ['kit', 'bench', 'git', 'forge', 'file', 'remote', 'runtime', 'server', 'inbox', 'home', 'new-repo',
    'me']},
];

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.ts$/.test(e.name) && !/\.(test|d)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The module of `file` in `tree`: the first directory under its root, or '.'. */
const moduleOf = (tree: (typeof TREES)[number], file: string) => {
  const parts = relative(join(OS, tree.root), file).split(sep);
  return parts.length > 1 ? parts[0] : '.';
};

/** Every import against the order: [tree, from module, to module, file, what it imports]. */
export function violations(): [string, string, string, string, string][] {
  const found: [string, string, string, string, string][] = [];
  for (const tree of TREES) {
    const root = join(OS, tree.root);
    for (const file of files(root)) {
      const from = moduleOf(tree, file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? '';
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(root + sep)) continue;
        const to = moduleOf(tree, target);
        if (to === from) continue;
        if (tree.build?.includes(to)) {
          const source = relative(OS, file).split(sep).join('/');
          if (!tree.buildHosts?.some((host) => host.endsWith('/') ? source.startsWith(host) : source === host)) {
            found.push([tree.root, from, to, source, spec]);
          }
          continue;
        }
        if (tree.build?.includes(from) || tree.skip?.includes(from) || tree.skip?.includes(to)) continue;
        const a = tree.order.indexOf(from), b = tree.order.indexOf(to);
        if (a < 0 || b < 0 || b > a) found.push([tree.root, from, to, relative(OS, file), spec]);
      }
    }
  }
  return found;
}

/**
 * Files that reach each other, which the order between modules does not see: every set of them, each a cycle (a file
 * takes from another that takes back from it, however far round), in any of ACYCLIC. None is allowed: within a module
 * too, what a file stands on is under it.
 */
/** Where no file may reach back to itself: why (its parts, its window, the Remote), these scripts, sods' runtime and ricebox's layers. */
export const ACYCLIC = [...TREES[0]!.order.map((part) => `why/${part}`), ...(TREES[0]!.build ?? []).map((part) => `why/${part}`), 'scripts', 'ricebox/sods/runtime', 'ricebox/distribution/runtime'];

export function cycles(): string[][] {
  const all = ACYCLIC.flatMap((root) => files(join(OS, root)));
  const takes = new Map(all.map((f) => [f, new Set<string>()]));
  for (const f of all) {
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) {
      const t = resolve(dirname(f), m[1] ?? m[2] ?? '');
      if (takes.has(t)) takes.get(f)?.add(t);
    }
  }
  return loops(takes).map((c) => c.map((f) => relative(OS, f)).sort());
}

/**
 * The sets of nodes of `takes` that reach each other (Tarjan's strongly connected components), each of more than one
 * node: the cycles.
 */
function loops(takes: Map<string, Set<string>>): string[][] {
  let n = 0;
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), found: string[][] = [];
  const visit = (v: string) => {
    index.set(v, n); low.set(v, n); n++; stack.push(v); on.add(v);
    for (const w of takes.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const c: string[] = [];
    let w: string | undefined;
    do { w = stack.pop(); if (w === undefined) break; on.delete(w); c.push(w); } while (w !== v);
    if (c.length > 1) found.push(c);
  };
  for (const k of takes.keys()) if (!index.has(k)) visit(k);
  return found;
}

// ---- the core (Rust) ----
//
// Its layers are why/lib.rs's `pub mod` lines, in that order, each a folder: the part's own (why/<name>), or a
// folder inside the part it belongs to, where lib.rs says so (#[path]). A layer's units take from their own layer
// and the layers before it, never after (the tr! macro is the text layer's). Within a layer, no unit reaches back to
// itself through its siblings. Tests (NAME.test.rs, beside what each tests) are left out.

const WHY = join(OS, 'why');

/** The core's layers, from the bottom up, as lib.rs declares them: each with the folder that holds it. */
const coreFolders = (): {layer: string; dir: string}[] =>
  [...readFileSync(join(WHY, 'lib.rs'), 'utf8').matchAll(/^(?:#\[path = "([^"]+)\/mod\.rs"\]\n)?(?:#\[cfg\([^\n]*\)\]\n)?pub mod ([a-z_]+);/gm)]
    .map((m) => ({layer: m[2] ?? '', dir: join(WHY, m[1] ?? m[2] ?? '')}));

/** The core's layers, from the bottom up. */
export const coreLayers = (): string[] => coreFolders().map((f) => f.layer);

/** The core's files of code (not tests), each with its layer and its unit: a layer's folder, less the folders in it that are another layer's or a crate of their own. */
function coreFiles(): {file: string; layer: string; unit: string}[] {
  const folders = coreFolders(), own = new Set(folders.map((f) => f.dir));
  const out: {file: string; layer: string; unit: string}[] = [];
  for (const {layer, dir} of folders) {
    const walk = (at: string) => {
      for (const e of readdirSync(at, {withFileTypes: true})) {
        const p = join(at, e.name);
        if (e.isDirectory()) { if (!own.has(p) && !existsSync(join(p, 'Cargo.toml')) && e.name !== 'tests') walk(p); }
        else if (e.name.endsWith('.rs') && !e.name.endsWith('.test.rs')) out.push({file: p, layer, unit: relative(dir, p).replace(/\.rs$/, '').split(sep)[0] ?? 'mod'});
      }
    };
    walk(dir);
  }
  return out;
}

/** A file's code without its comments and strings: what it names, not what it says. */
const codeOf = (src: string) => src.replace(/r(#*)"[\s\S]*?"\1/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/[^\n]*/g, '');

/** Every use of a later layer in the core: [from, to, file]. */
export function coreViolations(): [string, string, string][] {
  const order = coreLayers(), found: [string, string, string][] = [];
  for (const {file, layer} of coreFiles()) {
    const code = codeOf(readFileSync(file, 'utf8'));
    const takes = new Set([...code.matchAll(/\bcrate::([a-z_]+)/g)].map((m) => m[1] ?? ''));
    if (/\btr!\(/.test(code)) takes.add('text');
    for (const to of takes) {
      if (to === layer || !order.includes(to)) continue;
      if (order.indexOf(to) > order.indexOf(layer) || !order.includes(layer)) found.push([layer, to, relative(OS, file)]);
    }
  }
  return found;
}

/** Units of a core layer that reach back to themselves through their siblings: each set, by layer/unit. */
export function coreCycles(): string[][] {
  const all = coreFiles(), takes = new Map(all.map((f) => [`${f.layer}/${f.unit}`, new Set<string>()]));
  for (const {file, layer, unit} of all) {
    const code = codeOf(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(new RegExp(`\\b(?:super|crate::${layer})::([a-z_]+)`, 'g'))) {
      const to = `${layer}/${m[1]}`;
      if (unit !== 'mod' && takes.has(to) && m[1] !== unit) takes.get(`${layer}/${unit}`)?.add(to);
    }
  }
  return loops(takes).map((c) => c.sort());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [from, to, file] of coreViolations()) console.log(`core: ${from} -> ${to}\t${file}`);
  for (const units of coreCycles()) console.log(`a cycle in the core: ${units.join(' ')}`);
  const v = violations(), c = cycles();
  for (const [tree, from, to, file, spec] of v) console.log(`${tree}: ${from} -> ${to}\t${file} -> ${spec}`);
  for (const files of c) console.log(`a cycle: ${files.join(' ')}`);
  if (v.length || c.length) { console.error(`${v.length} imports against the layers' order, ${c.length} cycles of files`); process.exit(1); }
  console.log('the layers are in order, and no file reaches back to itself');
}
