// The units os-length3 is made of, each one responsibility: the files it holds and the units it may take from. Three
// things, one inside the next. muk is the thinnest: an OCI-compatible VMM, in C on lib alone. ricebox is the neutral
// distribution, as BusyBox is one: muk, what makes a browser its machine (sods, its kernel), its own tools (you,
// otter) and the root's packages; no window, a command line that is ordinary POSIX, served from any web host as it is.
// It knows no service, so it can be cut out whole and put under another's: nothing of it takes from what is not of it
// (RICEBOX, checked). root3 is the product, as Alpine stands on BusyBox: ricebox and the modules over it, of which
// shipto alone holds what a service wants. A face (the app's pages and window, root3's words) holds no judgement of
// its own and takes from any unit.
//
//   node scripts/units.ts        what each file is, and every import from one unit to another the table does not allow
//
// Only TypeScript's imports are followed here, by their paths; the Rust and the C are placed by their files, and each
// is checked by its own (layers.ts for the core, lib/build.sh for the units of C) until it moves into its unit. An import a unit
// may not make and still makes is owed: listed below with the step that takes it away, so a new one fails and an
// owed one gone must be struck from the list.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

/** The repository's root. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface Unit {
  name: string;
  /** What it is for, in a line. */
  says: string;
  /** Its files and folders, from the repository's root; the longest path that holds a file is its unit's. */
  holds: string[];
  /** The units it may take from ('*': any, a face's). */
  takes: string[];
}

export const UNITS: Unit[] = [
  {name: 'lib', says: "what the units of C stand on: system calls, words, output; no C library", holds: ['module/lib'], takes: []},
  {name: 'muk', says: 'the thinnest: an OCI-compatible VMM. An image\'s layers at rest, named by their digest, each byte fetched when first touched, and a bundle run from them (created, started, signalled, deleted); no KVM and no Firecracker under it, C on lib as you is',
    holds: ['module/muk', 'src/core/src/prompt', 'src/core/src/compute'],
    takes: ['lib']},
  {name: 'sods', says: 'instructions: x86-64 made wasm ahead of the run, kept and shared by digest, never crossing to JS',
    holds: ['module/sods/src', 'module/sods/runtime'],
    takes: []},
  {name: 'ricebox', says: 'the neutral distribution, as BusyBox is one: the smallest UNIX a browser runs (processes, memory and its page cache, files, descriptors, the terminal, signals) and the root\'s packages, what #80 lists; no window, ordinary POSIX, and no service known to it',
    holds: ['module/ricebox/runtime', 'root'],
    takes: ['lib', 'muk', 'sods']},
  {name: 'you', says: 'the tools a person reaches for: z, rg, fd, fzf', holds: ['module/you'], takes: ['lib']},
  {name: 'otter', says: 'to see and to decide: every floor counted at its hook, small bounded policies put at the hooks, each said; never the work itself',
    holds: ['module/otter', 'src/core/src/storage'],
    takes: ['lib', 'ricebox', 'muk', 'sods']},
  {name: 'funk', says: 'what is on its way: links out of a box and between boxes (HTTP, TCP, DNS, WebSocket, SSH)',
    holds: ['src/core/src/ssh', 'src/cli/src/cmd/ssh.rs', 'src/cli/src/cmd/address.rs'],
    takes: ['ricebox']},
  {name: 'shipto', says: 'what a service wants, all of it and nowhere else: who one is, what one may use, deliveries (commits, reviews, merges, messages, releases), the Remote that receives them, and its own deploy',
    holds: ['src/remote', 'src/core/src/remote', 'src/cli/src/cmd/sync.rs', 'src/cli/src/cmd/git.rs', 'src/cli/src/cmd/remote.rs',
      'src/shared/desktop-releases.json'],
    takes: ['ricebox', 'muk', 'funk']},
  {name: 'm8', says: 'where and how many boxes run: a state wanted, and one loop that makes it so (none yet: it is made when boxes run on more than one machine)',
    holds: [], takes: ['ricebox', 'muk', 'shipto']},
  {name: 'app', says: 'a face: the pages, the window and what the core says to them; no judgement of its own',
    holds: ['src/app', 'src/desktop', 'src/core', 'src/shared'], takes: ['*']},
  {name: 'root3', says: "a face: root3's words, read against its one table, and what it prints; no judgement of its own",
    holds: ['src/cli'], takes: ['*']},
];

/** The units ricebox is made of: what is cut out with it. None takes from a unit that is not one of them. */
export const RICEBOX = ['lib', 'muk', 'sods', 'ricebox', 'you', 'otter'];

/** What is no unit's: the tests, the scripts that build and check, what is made, and notes. */
export const NOT_UNITS = ['scripts', 'tests', 'module/ricebox/runtime/run.ts', 'module/ricebox/tests', 'module/sods/examples', 'module/otter/test',
  'src/core/web/src/tests', 'node_modules', 'target', 'dist', 'public', 'module/sods/target', 'module/ricebox/target', 'research_notes', 'reports',
  'temp', '.github', '.claude'];
const isTest = (rel: string) => /\.test\.(ts|rs)$|(^|\/)tests?\/|\/testing[^/]*\.ts$|\.d\.ts$/.test(rel);

/**
 * Imports a unit makes that the table does not allow, each with the step of the work that takes it away (README.md,
 * Units: 2 sods out, 3 ricebox, 4 otter's hooks, 6 muk, 7 shipto, 8 funk). [from, to, file].
 */
export const OWED: [string, string, string][] = [];

/** The unit of a file (a path from the root): the unit holding the longest path that holds it, or null. */
export function unitOf(rel: string): Unit | null {
  let best: Unit | null = null, length = -1;
  for (const u of UNITS) for (const h of u.holds) {
    if ((rel === h || rel.startsWith(h + '/')) && h.length > length) best = u, length = h.length;
  }
  return best;
}
const notUnit = (rel: string) => NOT_UNITS.some((n) => rel === n || rel.startsWith(n + '/')) || isTest(rel);

/** Every file of code (TypeScript, Rust, C) under the root that is some unit's to be, by its path from the root. */
export function codeFiles(dir = ROOT): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name), rel = relative(ROOT, p).split(sep).join('/');
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (notUnit(rel)) continue;
    if (e.isDirectory()) out.push(...codeFiles(p));
    else if (/\.(ts|rs|c|h)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/** Files no unit holds, and every import from one unit to another the table does not allow: [from, to, file]. */
export function check(): {homeless: string[]; crossings: [string, string, string][]} {
  const homeless: string[] = [], crossings: [string, string, string][] = [];
  for (const rel of codeFiles()) {
    const from = unitOf(rel);
    if (!from) { homeless.push(rel); continue; }
    if (!rel.endsWith('.ts')) continue;
    const seen = new Set<string>();
    for (const m of readFileSync(join(ROOT, rel), 'utf8').matchAll(IMPORT)) {
      let target = relative(ROOT, resolve(ROOT, dirname(rel), m[1] ?? m[2] ?? '')).split(sep).join('/');
      try { if (statSync(join(ROOT, target)).isDirectory()) target += '/index.ts'; } catch { /* a file, as written */ }
      const to = notUnit(target) ? null : unitOf(target);
      if (!to || to === from || from.takes.includes('*') || from.takes.includes(to.name)) continue;
      const key = `${from.name}>${to.name}`;
      if (!seen.has(key)) seen.add(key), crossings.push([from.name, to.name, rel]);
    }
  }
  return {homeless, crossings};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {homeless, crossings} = check();
  for (const f of homeless) console.log(`no unit's: ${f}`);
  const owed = new Set(OWED.map((o) => o.join(' ')));
  for (const c of crossings) console.log(`${owed.has(c.join(' ')) ? 'owed' : 'NOT ALLOWED'}: ${c[0]} -> ${c[1]}\t${c[2]}`);
  for (const o of OWED) if (!crossings.some((c) => c.join(' ') === o.join(' '))) console.log(`owed, but no longer made (strike it): ${o.join(' ')}`);
  const counts = new Map<string, number>();
  for (const f of codeFiles()) { const u = unitOf(f)?.name ?? '-'; counts.set(u, (counts.get(u) ?? 0) + 1); }
  console.log([...counts].map(([u, n]) => `${u} ${n}`).join(', '));
}
