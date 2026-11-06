// The app's layers, in order, and every import against that order: a module of a tree (a directory under it, or the
// files directly in it, '.') takes from the modules before it in its tree's order and from nothing after it. A tree
// may hold a tree of its own (pages/), ordered the same way within it. A type taken counts as much as a value: what
// a module names of another, it depends on.
//
//   node scripts/layers.mjs          the imports against the order, each with the file that makes it; fails if any
//
// Tests (*.test.ts, app/testing/) are left out: a test may take from any layer it puts together.
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const OS = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each tree, its modules from the bottom up. A module not named is wrong in its tree until it is. */
export const TREES = [
  {root: 'app', order: ['i18n', 'agent', 'core', 'ui', 'host', 'repos', 'home', 'remote', 'prompt', 'account', 'pages', '.'],
    skip: ['styles', 'shims', 'testing']},
  // The pages: what they share (kit), the bench Forge and Git work at (with its search), then each page.
  {root: 'app/pages', order: ['kit', 'bench', 'git', 'forge', 'file', 'remote', 'runtime', 'server', 'inbox', 'home', 'new-repo',
    'me']},
];

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(ts|mjs)$/.test(e.name) && !/\.(test|d)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The module of `file` in `tree`: the first directory under its root, or '.'. */
const moduleOf = (tree, file) => {
  const parts = relative(join(OS, tree.root), file).split(sep);
  return parts.length > 1 ? parts[0] : '.';
};

/** Every import against the order: [tree, from module, to module, file, what it imports]. */
export function violations() {
  const found = [];
  for (const tree of TREES) {
    const root = join(OS, tree.root);
    for (const file of files(root)) {
      const from = moduleOf(tree, file);
      if (tree.skip?.includes(from)) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(IMPORT)) {
        const target = resolve(dirname(file), m[1] ?? m[2]);
        if (!target.startsWith(root + sep)) continue;
        const to = moduleOf(tree, target);
        if (to === from || tree.skip?.includes(to)) continue;
        const a = tree.order.indexOf(from), b = tree.order.indexOf(to);
        if (a < 0 || b < 0 || b > a) found.push([tree.root, from, to, relative(OS, file), m[1] ?? m[2]]);
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
/** Where no file may reach back to itself: the app, the Remote, these scripts, and xlat's runtime the Prompt runs. */
export const ACYCLIC = ['app', 'remote', 'scripts', '../xlat/runtime'];

export function cycles() {
  const all = ACYCLIC.flatMap((root) => files(join(OS, root)));
  const takes = new Map(all.map((f) => [f, new Set()]));
  for (const f of all) {
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) {
      const t = resolve(dirname(f), m[1] ?? m[2]);
      if (takes.has(t)) takes.get(f).add(t);
    }
  }
  // Tarjan's strongly connected components; any of more than one file is a cycle.
  let n = 0;
  const index = new Map(), low = new Map(), stack = [], on = new Set(), found = [];
  const visit = (v) => {
    index.set(v, n); low.set(v, n); n++; stack.push(v); on.add(v);
    for (const w of takes.get(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    const c = [];
    let w;
    do { w = stack.pop(); on.delete(w); c.push(relative(OS, w)); } while (w !== v);
    if (c.length > 1) found.push(c.sort());
  };
  for (const f of all) if (!index.has(f)) visit(f);
  return found;
}

// ---- the core (Rust) ----
//
// Its layers are lib.rs's `pub mod` lines, in that order, each a folder: a layer's units take from their own layer
// and the layers before it, never after (the tr! macro is the text layer's). Within a layer, no unit reaches back to
// itself through its siblings. Tests (each layer's tests/) are left out.

const CORE = join(OS, 'core/src');

/** The core's layers, from the bottom up, as lib.rs declares them. */
export const coreLayers = () => [...readFileSync(join(CORE, 'lib.rs'), 'utf8').matchAll(/^pub mod ([a-z_]+);/gm)].map((m) => m[1]);

/** The core's files of code (not lib.rs, not tests), each with its layer and its unit. */
function coreFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests') walk(p); } else if (e.name.endsWith('.rs') && p !== join(CORE, 'lib.rs')) out.push(p);
    }
  };
  walk(CORE);
  return out.map((file) => {
    const parts = relative(CORE, file).replace(/\.rs$/, '').split(sep);
    return {file, layer: parts[0], unit: parts[1] ?? 'mod'};
  });
}

/** A file's code without its comments and strings: what it names, not what it says. */
const codeOf = (src) => src.replace(/r(#*)"[\s\S]*?"\1/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/[^\n]*/g, '');

/** Every use of a later layer in the core: [from, to, file]. */
export function coreViolations() {
  const order = coreLayers(), found = [];
  for (const {file, layer} of coreFiles()) {
    const code = codeOf(readFileSync(file, 'utf8'));
    const takes = new Set([...code.matchAll(/\bcrate::([a-z_]+)/g)].map((m) => m[1]));
    if (/\btr!\(/.test(code)) takes.add('text');
    for (const to of takes) {
      if (to === layer || !order.includes(to)) continue;
      if (order.indexOf(to) > order.indexOf(layer) || !order.includes(layer)) found.push([layer, to, relative(OS, file)]);
    }
  }
  return found;
}

/** Units of a core layer that reach back to themselves through their siblings: each set, by layer/unit. */
export function coreCycles() {
  const all = coreFiles(), takes = new Map(all.map((f) => [`${f.layer}/${f.unit}`, new Set()]));
  for (const {file, layer, unit} of all) {
    const code = codeOf(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(new RegExp(`\\b(?:super|crate::${layer})::([a-z_]+)`, 'g'))) {
      const to = `${layer}/${m[1]}`;
      if (unit !== 'mod' && takes.has(to) && m[1] !== unit) takes.get(`${layer}/${unit}`).add(to);
    }
  }
  let n = 0;
  const index = new Map(), low = new Map(), stack = [], on = new Set(), found = [];
  const visit = (v) => {
    index.set(v, n); low.set(v, n); n++; stack.push(v); on.add(v);
    for (const w of takes.get(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    const c = [];
    let w;
    do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
    if (c.length > 1) found.push(c.sort());
  };
  for (const k of takes.keys()) if (!index.has(k)) visit(k);
  return found;
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
