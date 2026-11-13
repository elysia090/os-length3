// The units os-length3 is made of, each one responsibility: the files it holds and the units it may take from. Three
// things, each thinner than the one over it, none holding another (docs/STRUCTURE.md). muk is the machine: an
// OCI-compatible VMM, a box run from layers by its namespaces on Linux and by answering its calls itself in a browser.
// ricebox is the neutral distribution, as BusyBox is one and as thin: the root and the command line #80 lists; no
// window, ordinary POSIX, served from any web host as it is. It knows no service, so it can be cut out with the units
// under it and put under another's: none
// of them takes from one over them (UNDER_RICEBOX, checked). why is the product, as Alpine stands on BusyBox:
// ricebox, the root's packages and the modules over it, of which shipto alone holds what a service wants. A face (the
// app's pages and window, why's words) holds no judgement of its own and takes from any unit.
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
  /**
   * Its files that what is outside its folder may import; none besides. Not said: any of them. What a unit is made of
   * can then change without anyone else's code changing (`reaches`, below).
   */
  entries?: string[];
}

export const UNITS: Unit[] = [
  {name: 'lib', says: "what the units of C stand on: system calls, words, output; no C library", holds: ['module/lib'], takes: []},
  {name: 'muk', says: 'the machine: an OCI bundle\'s box made, isolated, started and waited for (`muk run`), in C on lib and nothing else. Where there is no Linux under it, the Linux it asks for is sods\'; no image, no terminal\'s other end, no KVM and no Firecracker',
    holds: ['module/muk', 'why/core/src/prompt/launch.rs', 'why/core/src/prompt/seccomp.rs', 'why/core/src/compute'],
    takes: ['lib'], entries: []},
  {name: 'prompt', says: "a terminal attached: the other end of the one muk makes in a box, given as one descriptor (`prompt attach FD`): what is typed and shown, its size, the frontend's terminal put back. It starts no process and keeps no box: whoever runs muk owns those",
    holds: ['module/prompt', 'why/core/src/prompt'],
    takes: [], entries: []},
  {name: 'sods', says: 'a program run where its machine, its kernel or its system is absent: translation and what a translation is kept by, the Linux a program asks for, and every difference between hosts (#191: its table is runtime/targets.ts); no image, no OCI and no product policy',
    holds: ['module/sods'],
    takes: ['lib'],
    entries: ['module/sods/runtime/translate.ts', 'module/sods/runtime/linux.ts', 'module/sods/runtime/host.ts', 'module/sods/runtime/targets.ts']},
  {name: 'ricebox', says: 'the neutral distribution, as BusyBox is one and as thin: the root, each package from its pinned source by its recipe, the command line #80 lists, and the root as layers (their form, and what reads them); no window, ordinary POSIX, and no service known to it',
    holds: ['module/ricebox'],
    takes: ['lib', 'muk', 'sods', 'everyday']},
  {name: 'everyday', says: 'the look and feel, changed by the one who uses it: what a face is drawn through. A sheet of names and values, a person\'s lines held to it, the way back the file itself; no window of its own',
    holds: ['module/everyday'], takes: []},
  {name: 'you', says: 'the tools a person reaches for: z, rg, fd, fzf', holds: ['module/you'], takes: ['lib']},
  {name: 'otter', says: 'to see and to decide: every floor counted at its hook, small bounded policies put at the hooks, each said; never the work itself',
    holds: ['module/otter', 'why/core/src/storage'],
    takes: ['lib', 'ricebox', 'muk', 'sods']},
  {name: 'cowboy', says: 'what is on its way: links out of a box and between boxes (HTTP, TCP, DNS, WebSocket, SSH)',
    holds: ['why/core/src/ssh', 'why/cli/src/cmd/ssh.rs', 'why/cli/src/cmd/address.rs'],
    takes: ['sods', 'ricebox']},
  {name: 'shipto', says: 'what a service wants, all of it and nowhere else: who one is, what one may use, deliveries (commits, reviews, merges, messages, releases), the Remote that receives them, and its own deploy',
    holds: ['why/remote', 'why/core/src/remote', 'why/cli/src/cmd/sync.rs', 'why/cli/src/cmd/git.rs', 'why/cli/src/cmd/remote.rs',
      'why/shared/desktop-releases.json'],
    takes: ['ricebox', 'muk', 'cowboy']},
  {name: 'm8', says: 'where and how many boxes run: a state wanted, and one loop that makes it so (none yet: it is made when boxes run on more than one machine)',
    holds: [], takes: ['ricebox', 'muk', 'shipto']},
  {name: 'app', says: 'a face: the pages, the window and what the core says to them; no judgement of its own',
    holds: ['why/app', 'why/desktop', 'why/core', 'why/shared'], takes: ['*']},
  {name: 'why', says: "a face: why's words, read against its one table, and what it prints; no judgement of its own",
    holds: ['why/cli'], takes: ['*']},
];

/** ricebox and the units under it: what is cut out with it. None takes from a unit over them. */
export const UNDER_RICEBOX = ['lib', 'muk', 'sods', 'everyday', 'ricebox'];

/** What is no unit's: the tests, the scripts that build and check (the root's own among them), what is made, and notes. */
export const NOT_UNITS = ['scripts', 'tests', 'module/sods/test', 'module/muk/test', 'module/sods/examples', 'module/otter/test',
  'why/core/web/src/tests', 'node_modules', 'target', 'dist', 'public', 'module/sods/target', 'module/prompt/target', 'research_notes', 'reports',
  'temp', '.github', '.claude'];
const isTest = (rel: string) => /\.test\.(ts|rs)$|(^|\/)tests?\/|\/testing[^/]*\.ts$|\.d\.ts$/.test(rel);

/**
 * Imports a unit makes that the table does not allow, each with the step of the work that takes it away (README.md,
 * Units: 2 sods out, 3 ricebox, 4 otter's hooks, 6 muk, 7 shipto, 8 cowboy). [from, to, file].
 */
export const OWED: [string, string, string][] = [
];

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

/** Every TypeScript file under the root, a unit's or not (tests and scripts too), but for what is made or fetched. */
function everyTs(dir = ROOT): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    if (e.name.startsWith('.') || ['node_modules', 'target', 'dist', 'public'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...everyTs(p));
    else if (e.name.endsWith('.ts')) out.push(relative(ROOT, p).split(sep).join('/'));
  }
  return out;
}

/**
 * Every import that goes into a unit past its entries: [file, what it imports]. A unit that says its entries is
 * taken from through them alone by everything outside its own folder, tests and scripts included; its own files and
 * its own tests reach where they like.
 */
export function reaches(): [string, string][] {
  const found: [string, string][] = [];
  const guarded = UNITS.filter((u) => u.entries).map((u) => ({unit: u, folders: u.holds.filter((h) => h.startsWith('module/'))}));
  for (const rel of everyTs()) {
    for (const m of readFileSync(join(ROOT, rel), 'utf8').matchAll(IMPORT)) {
      const target = relative(ROOT, resolve(ROOT, dirname(rel), m[1] ?? m[2] ?? '')).split(sep).join('/');
      for (const {unit, folders} of guarded) {
        const inside = (path: string) => folders.some((f) => path.startsWith(f + '/'));
        if (inside(target) && !inside(rel) && !unit.entries!.includes(target)) found.push([rel, target]);
      }
    }
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [file, target] of reaches()) console.log(`NOT AN ENTRY: ${file} -> ${target}`);
  const {homeless, crossings} = check();
  for (const f of homeless) console.log(`no unit's: ${f}`);
  const owed = new Set(OWED.map((o) => o.join(' ')));
  for (const c of crossings) console.log(`${owed.has(c.join(' ')) ? 'owed' : 'NOT ALLOWED'}: ${c[0]} -> ${c[1]}\t${c[2]}`);
  for (const o of OWED) if (!crossings.some((c) => c.join(' ') === o.join(' '))) console.log(`owed, but no longer made (strike it): ${o.join(' ')}`);
  const counts = new Map<string, number>();
  for (const f of codeFiles()) { const u = unitOf(f)?.name ?? '-'; counts.set(u, (counts.get(u) ?? 0) + 1); }
  console.log([...counts].map(([u, n]) => `${u} ${n}`).join(', '));
}
