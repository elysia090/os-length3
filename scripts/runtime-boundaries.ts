// Execution and distribution boundary imports, separate from why's own layer order.
// Host build/deployment entrances are checked too, with explicit facilities and no reverse runtime dependency.
import {readdirSync, readFileSync} from 'node:fs';
import {posix} from 'node:path';

export const ROOTS = ['module/ricebox/verification', 'module/ricebox/host/node', 'module/ricebox/build', 'module/ricebox/deployment', 'module/ricebox/integrations', 'module/ricebox/distribution', 'module/ricebox/runtime', 'module/sods/runtime', 'module/cowboy/host', 'module/disk'];
const inside = (path: string, root: string) => path.startsWith(root + '/');
const publicSods = new Set(['module/sods/runtime/host.ts', 'module/sods/runtime/linux.ts', 'module/sods/runtime/translate.ts']);
// Adapters are allowed host facilities explicitly, not forbidden. Add a new adapter and its facilities here
// when its contract lands; do not allow node:* throughout the core to accommodate one adapter.
const hostImports: Record<string, readonly string[]> = {
  'module/ricebox/verification/language-cases.ts': ['node:fs'],
  'module/ricebox/verification/distribution.ts': ['node:fs','node:path'],
  'module/ricebox/verification/programs.ts': ['node:child_process','node:crypto','node:fs','node:os','node:path','node:url'],
  'module/ricebox/verification/commands.ts': ['node:child_process','node:fs','node:os','node:url','node:util'],
  'module/ricebox/host/node/hash.ts': ['node:crypto'],
  'module/ricebox/host/node/tar.ts': ['node:fs','node:zlib','node:stream'],
  'module/ricebox/host/node/inventory.ts': ['node:fs','node:path'],
  'module/ricebox/deployment/local.ts': ['node:fs','node:path','node:zlib'],
  'module/ricebox/build/distribution.ts': ['node:crypto','node:fs','node:path','node:url','node:worker_threads','node:zlib'],
  'module/ricebox/build/compress.worker.ts': ['node:worker_threads','node:zlib'],
  'module/ricebox/build/aot-cache.ts': ['node:child_process','node:crypto','node:fs','node:os','node:path'],
  'module/ricebox/build/file-store-artifact.ts': ['node:crypto'],
  'module/ricebox/build/muk-artifact.ts': ['node:child_process','node:crypto','node:fs','node:path','node:url'],
  'module/ricebox/build/package-database.ts': ['node:crypto','node:fs','node:path'],
  'module/ricebox/build/script-interpreters.ts': ['node:fs','node:path','node:url'],
  'module/ricebox/build/prepare.ts': ['node:fs','node:path','node:child_process','node:crypto','node:url'],
  'module/ricebox/deployment/assets.ts': ['node:crypto','node:fs','node:path','node:zlib'],
  'module/sods/runtime/host.ts': ['node:worker_threads', 'node:os', 'node:fs'],
  // The existing CLI is executable but must not become an importable runtime dependency.
  'module/sods/runtime/run.ts': ['node:child_process', 'node:crypto', 'node:fs', 'node:path', 'node:url'],
};

// Preserve quoted strings but skip comments. Templates stay opaque: a computed import must not conceal an edge.
function tokens(source: string): string[] {
  return [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g)]
    .map(m => m[0]).filter(t => !t.startsWith('//') && !t.startsWith('/*'));
}
const quoted = (token: string | undefined) => token !== undefined && (token[0] === "'" || token[0] === '"');

/** Literal imports, re-exports (types included), and source URLs used by Worker constructors. */
export function references(source: string): string[] {
  const ts = tokens(source), found: string[] = [];
  const add = (token: string | undefined) => {
    if (!quoted(token) || token!.includes('\\')) { found.push('<computed or escaped module reference>'); return; }
    found.push(token!.slice(1, -1));
  };
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t?.startsWith('`') && /\b(?:import|require)\s*\(|\bnew\s+(?:Worker|SharedWorker|NodeWorker)\b/.test(t)) {
      found.push('<code dependency inside template>');
      continue;
    }
    if (t === 'import' && ts.slice(i + 1, i + 4).join('') === '.meta.' && /^glob/.test(ts[i + 4] ?? '')) {
      found.push('<bundler glob dependency>');
      continue;
    }
    if ((t === 'import' || t === 'require') && ts[i - 1] !== '.' && ts[i + 1] === '(') {
      if (ts[i + 3] !== ')' && ts[i + 3] !== ',') found.push('<computed module reference>');
      else add(ts[i + 2]);
    } else if ((t === 'import' || (t === 'export' && (['{', '*'].includes(ts[i + 1] ?? '') || (ts[i + 1] === 'type' && ['{', '*'].includes(ts[i + 2] ?? ''))))) && ts[i - 1] !== '.' && ts[i + 1] !== '.') {
      if (quoted(ts[i + 1])) add(ts[i + 1]);
      else for (let j = i + 1; j < ts.length && ts[j] !== ';'; j++) {
        if (ts[j] === 'from') { add(ts[j + 1]); break; }
        if (j > i + 1 && (ts[j] === 'import' || ts[j] === 'export')) break;
      }
    } else if (t === 'new' && ['Worker', 'SharedWorker', 'NodeWorker'].includes(ts[i + 1] ?? '') && ts[i + 2] === '(') {
      // Worker URLs are code, unlike ordinary distribution/pack URLs. A computed code source needs an
      // explicit adapter contract and corresponding check; do not silently let it bypass the graph.
      if (quoted(ts[i + 3]) && [',', ')'].includes(ts[i + 4] ?? '')) add(ts[i + 3]);
      else if (ts[i + 3] === 'new' && ts[i + 4] === 'URL' && ts[i + 5] === '(' && quoted(ts[i + 6]) && ts[i + 7] === ',') add(ts[i + 6]);
      else found.push('<computed worker source>');
    } else if (t === 'new' && ts[i + 1] === 'URL' && ts[i + 2] === '(' && quoted(ts[i + 3]) && /\.[cm]?[jt]s(?:[?#][^"']*)?["']$/.test(ts[i + 3]!)) {
      add(ts[i + 3]);
    }
  }
  return [...new Set(found)];
}

export function allowed(from: string, specifier: string): boolean {
  // Host facilities belong only to the concrete host entrances listed above, never portable format or disk logic.
  if (hostImports[from]?.includes(specifier)) return true;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const target = posix.normalize(posix.join(posix.dirname(from), specifier.split(/[?#]/)[0]!));
  const owner = ROOTS.find(root => inside(from, root));
  if (!owner || target === 'module/sods/runtime/run.ts' || target.includes('/test/') || /\.(test|spec)\./.test(target)) return false;
  if (inside(target, owner)) return true;
  if (owner === 'module/ricebox/verification') return ['module/ricebox/distribution','module/ricebox/deployment','module/ricebox/host/node','module/ricebox/runtime'].some(root => inside(target,root)) || publicSods.has(target) || target === 'module/ricebox/build/muk-artifact.ts';
  if (owner === 'module/ricebox/integrations') return inside(target, 'module/ricebox/build') || inside(target, 'module/ricebox/deployment');
  if (owner === 'module/ricebox/host/node') return inside(target, 'module/ricebox/distribution');
  if (from === 'module/ricebox/build/file-store-artifact.ts' && target === 'module/sods/runtime/linux.ts') return true;
  if (owner === 'module/ricebox/build' || owner === 'module/ricebox/deployment') return inside(target, 'module/ricebox/distribution') || inside(target, 'module/ricebox/host/node');
  if (owner === 'module/ricebox/runtime') return inside(target, 'module/ricebox/distribution') || publicSods.has(target);
  return owner === 'module/cowboy/host' && target === 'module/sods/runtime/linux.ts';
}

export function violations(sources: Record<string, string>): string[] {
  return Object.entries(sources).flatMap(([file, source]) => references(source)
    .filter(specifier => !allowed(file, specifier)).map(specifier => `${file} -> ${specifier}`)).sort();
}

/** Missing roots fail, rather than silently passing a partial checkout. */
export function runtimeSources(repository: string): Record<string, string> {
  const sources: Record<string, string> = {};
  const walk = (path: string) => {
    for (const e of readdirSync(posix.join(repository, path), {withFileTypes: true})) {
      const file = posix.join(path, e.name);
      if (e.isDirectory()) { if (e.name !== 'test') walk(file); }
      else if (/\.ts$/.test(e.name) && !/\.(test|spec|d)\.ts$/.test(e.name)) sources[file] = readFileSync(posix.join(repository, file), 'utf8');
    }
  };
  for (const root of ROOTS) walk(root);
  return sources;
}
