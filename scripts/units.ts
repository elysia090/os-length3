// Repository ownership and allowed TypeScript dependencies. The longest declared path owns a file.
// Ricebox is reusable without the Why product. Public entry checks use owners, not directory prefixes.
// Rust linkage and freestanding C builds are checked by their toolchains, not this TypeScript scanner.
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
  {name: 'toolchain', says: 'Freestanding C headers and a static x86-64 Linux build command',
    holds: ['ricebox/toolchain'], takes: []},
  {name: 'muk', says: 'Starts and waits for a sandboxed OCI bundle on Linux',
    holds: ['ricebox/muk'], takes: ['toolchain'], entries: []},
  {name: 'sods', says: 'Translates guest instructions, provides Linux services, and adapts host capabilities',
    holds: ['ricebox/sods'], takes: ['toolchain'],
    entries: ['translate', 'linux', 'host', 'targets'].map(name => `ricebox/sods/runtime/${name}.ts`)},
  {name: 'ricebox', says: 'Assembles and verifies a pinned Linux distribution, and loads and runs it for an embedding host',
    holds: ['ricebox/distribution'], takes: ['toolchain', 'muk', 'sods', 'you', 'otter']},
  {name: 'everyday', says: 'Theme values; the independent Wayland display and input foundation is not implemented',
    holds: ['ricebox/everyday'], takes: []},
  {name: 'you', says: 'Freestanding C implementations of directory history and tree search',
    holds: ['ricebox/you'], takes: ['toolchain']},
  {name: 'otter', says: 'Command help and acquisition of explicitly pinned package catalogs',
    holds: ['ricebox/otter'], takes: ['toolchain']},
  {name: 'cowboy', says: 'Guest networking and relay protocol, without Why account or service policy',
    holds: ['ricebox/cowboy'], takes: ['sods']},
  {name: 'shipto', says: 'The Why service, identity, policy, synchronization and deliveries',
    holds: ['why/shipto', 'why/api/ssh-scope.ts', 'why/cli/src/cmd/sync.rs', 'why/cli/src/cmd/git.rs', 'why/cli/src/cmd/remote.rs'],
    takes: ['ricebox', 'muk', 'cowboy']},
  {name: 'app', says: 'Why product core, platform adapters, and app surfaces',
    holds: ['why'], takes: ['*']},
  {name: 'why', says: 'The Why command-line frontend',
    holds: ['why/cli'], takes: ['*']},
];

/** Reusable components that may not depend on the Why product. */
export const RICEBOX_UNITS = ['toolchain', 'muk', 'sods', 'ricebox', 'everyday', 'you', 'otter', 'cowboy'];

/** What is no unit's: the tests, the scripts that build and check (the root's own among them), what is made, and notes. */
export const NOT_UNITS = ['scripts', 'why/test', 'ricebox/sods/test', 'ricebox/muk/test', 'ricebox/sods/examples', 'ricebox/otter/test', 'ricebox/cowboy/test', 'ricebox/cowboy/target',
  'why/api/web/src/tests', 'node_modules', 'target', 'dist', 'public', 'ricebox/sods/target', 'ricebox/distribution/terminal/target', 'research_notes', 'reports',
  'temp', '.github', '.claude'];
const isTest = (rel: string) => /\.test\.(ts|rs)$|(^|\/)tests?\/|\/testing[^/]*\.ts$|\.d\.ts$/.test(rel);

/** Existing product service imports that are exceptions to the allowed dependency table. */
export const OWED: [string, string, string][] = [
  ...['connection', 'inbox', 'lifecycle', 'news', 'passkeys.desktop', 'plan', 'policy', 'servers', 'settings']
    .map((name): [string, string, string] => ['shipto', 'app', `why/shipto/${name}.ts`]),
];

/** The unit of a file (a path from the root): the unit holding the longest path that holds it, or null. */
export function unitOf(rel: string, units: readonly Unit[] = UNITS): Unit | null {
  let best: Unit | null = null, length = -1;
  for (const u of units) for (const h of u.holds) {
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
export function entryViolations(
  sources: Iterable<readonly [string, string]>,
  units: readonly Unit[] = UNITS,
): [string, string][] {
  const found: [string, string][] = [];
  for (const [file, source] of sources) {
    const from = unitOf(file, units);
    for (const m of source.matchAll(IMPORT)) {
      const target = relative(ROOT, resolve(ROOT, dirname(file), m[1] ?? m[2] ?? '')).split(sep).join('/');
      const owner = unitOf(target, units);
      if (owner?.entries && owner !== from && !owner.entries.includes(target)) found.push([file, target]);
    }
  }
  return found;
}

export function reaches(): [string, string][] {
  return entryViolations(everyTs().map(file => [file, readFileSync(join(ROOT, file), 'utf8')] as const));
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
