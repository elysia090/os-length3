// Execution and distribution boundary imports, separate from why's own layer order.
// Host build/deployment entrances are checked too, with explicit facilities and no reverse runtime dependency.
import {readdirSync, readFileSync} from 'node:fs';
import {posix} from 'node:path';
import {references} from './imports.ts';

export const ROOTS = ['ricebox/distribution/verification', 'ricebox/distribution/host/node', 'ricebox/distribution/build', 'ricebox/distribution/deployment', 'ricebox/distribution/integrations', 'ricebox/distribution/format', 'ricebox/distribution/runtime', 'ricebox/sods/runtime', 'ricebox/cowboy/host'];
const indexedDb = 'why/api/indexeddb.ts';
const inside = (path: string, root: string) => path.startsWith(root + '/');
const publicSods = new Set(['ricebox/sods/runtime/host.ts', 'ricebox/sods/runtime/linux.ts', 'ricebox/sods/runtime/translate.ts']);
// Adapters are allowed host facilities explicitly, not forbidden. Add a new adapter and its facilities here
// when its contract lands; do not allow node:* throughout the core to accommodate one adapter.
const hostImports: Record<string, readonly string[]> = {
  'ricebox/distribution/verification/language-cases.ts': ['node:fs'],
  'ricebox/distribution/verification/distribution.ts': ['node:fs','node:path'],
  'ricebox/distribution/verification/programs.ts': ['node:child_process','node:crypto','node:fs','node:os','node:path','node:url'],
  'ricebox/distribution/verification/commands.ts': ['node:child_process','node:fs','node:os','node:url','node:util'],
  'ricebox/distribution/host/node/hash.ts': ['node:crypto'],
  'ricebox/distribution/host/node/tar.ts': ['node:fs','node:zlib','node:stream'],
  'ricebox/distribution/verification/inventory.ts': ['node:fs','node:path'],
  'ricebox/distribution/deployment/local.ts': ['node:fs','node:path','node:zlib'],
  'ricebox/distribution/build/npm.ts': ['node:fs','node:path','node:url'],
  'ricebox/distribution/build/publish-tree.ts': ['node:fs','node:path','node:url'],
  'ricebox/distribution/build/distribution.ts': ['node:crypto','node:fs','node:path','node:url','node:zlib'],
  'ricebox/distribution/build/compression-pool.ts': ['node:worker_threads'],
  'ricebox/distribution/build/compress.worker.ts': ['node:worker_threads','node:zlib'],
  'ricebox/distribution/build/aot-cache.ts': ['node:child_process','node:crypto','node:fs','node:os','node:path'],
  'ricebox/distribution/build/muk-artifact.ts': ['node:child_process','node:crypto','node:fs','node:path','node:url'],
  'ricebox/distribution/build/package-database.ts': ['node:crypto','node:fs','node:path'],
  'ricebox/distribution/build/script-interpreters.ts': ['node:fs','node:path','node:url'],
  'ricebox/distribution/build/prepare.ts': ['node:fs','node:path','node:child_process','node:crypto','node:url'],
  'ricebox/distribution/deployment/assets.ts': ['node:crypto','node:fs','node:path'],
  'ricebox/sods/runtime/host.ts': ['node:worker_threads', 'node:os', 'node:fs'],
  // The existing CLI is executable but must not become an importable runtime dependency.
  'ricebox/sods/runtime/run.ts': ['node:child_process', 'node:crypto', 'node:fs', 'node:path', 'node:url'],
};

export function allowed(from: string, specifier: string): boolean {
  // The storage adapter uses only the database supplied by its caller.
  if (from === indexedDb) return false;
  // Host facilities belong only to the concrete host entrances listed above, never the portable formats.
  if (hostImports[from]?.includes(specifier)) return true;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const target = posix.normalize(posix.join(posix.dirname(from), specifier.split(/[?#]/)[0]!));
  const owner = ROOTS.find(root => inside(from, root));
  if (!owner || target === 'ricebox/sods/runtime/run.ts' || target.includes('/test/') || /\.(test|spec)\./.test(target)) return false;
  if (inside(target, owner)) return true;
  if (owner === 'ricebox/distribution/verification') return ['ricebox/distribution/format','ricebox/distribution/deployment','ricebox/distribution/host/node','ricebox/distribution/runtime'].some(root => inside(target,root)) || publicSods.has(target) || target === 'ricebox/distribution/build/muk-artifact.ts';
  if (owner === 'ricebox/distribution/integrations') return inside(target, 'ricebox/distribution/build') || inside(target, 'ricebox/distribution/deployment');
  if (owner === 'ricebox/distribution/host/node') return inside(target, 'ricebox/distribution/format');
  if (from === 'ricebox/distribution/build/npm.ts' && target === 'ricebox/toolchain/package-typescript.ts') return true;
  if (owner === 'ricebox/distribution/build' || owner === 'ricebox/distribution/deployment') return inside(target, 'ricebox/distribution/format') || inside(target, 'ricebox/distribution/host/node');
  if (owner === 'ricebox/distribution/runtime') return inside(target, 'ricebox/distribution/format') || publicSods.has(target);
  return owner === 'ricebox/cowboy/host' && target === 'ricebox/sods/runtime/linux.ts';
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
  sources[indexedDb] = readFileSync(posix.join(repository, indexedDb), 'utf8');
  return sources;
}
