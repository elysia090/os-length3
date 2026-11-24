// Deploy-time composition from already-built packages. The source
// toolchain remains explicit until independently versioned build artifacts ship.
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, rmSync, renameSync, existsSync, lstatSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {requireStandardFileOwner} from '../format/manifest.ts';
import {fileURLToPath} from 'node:url';
import {releaseVersion} from './version.ts';
import {defaultPackages} from './default-packages.ts';

export {defaultPackages} from './default-packages.ts';

export interface PinnedTool { path: string; size: number; sha256: string }
export interface PrepareOptions {
  packages?: readonly string[]; packageCache: string; output: string;
  toolchain?: string;
  tools?: Record<'translator' | 'sods' | 'muk', PinnedTool>;
  version?: string; cache?: string;
  /** Retained for callers upgrading from selected translation. Web deployment prepares every program. */
  hot?: string[];
}
function verifiedTool(tool: PinnedTool, name: string) {
  if (!tool || !/^[0-9a-f]{64}$/.test(tool.sha256) || !Number.isSafeInteger(tool.size) || tool.size < 0) throw new Error(`ricebox: ${name} requires path, size and sha256`);
  const path = resolve(tool.path), bytes = readFileSync(path);
  if (bytes.length !== tool.size || createHash('sha256').update(bytes).digest('hex') !== tool.sha256) throw new Error(`ricebox: ${name} integrity mismatch`);
  return {path, bytes};
}

export function selectPackages(packages: readonly string[], packageCache: string, destination: string) {
  if (!Array.isArray(packages) || !packages.length || packages.some(n => typeof n !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(n)) || new Set(packages).size !== packages.length) {
    throw new Error('ricebox: packages must be a nonempty, unique list of package names');
  }
  const cache = resolve(packageCache);
  // Validate every package before writing any selection. Never rewrite the shared
  // build cache's record: simultaneous sites may choose different packages.
  const selected = packages.map(name => {
    const directory = join(cache, name);
    if (!lstatSync(join(directory, 'tree'), {throwIfNoEntry: false})?.isDirectory()) {
      throw new Error(`ricebox: missing package ${name} in ${cache}. Build or acquire it for this cache.`);
    }
    const metadata = ['version', 'source', 'key'].map(file => {
      const value = readFileSync(join(directory, file), 'utf8').trim();
      // A package built from tracked repository files has no upstream source digest.
      if ((!value && file !== 'source') || /\s/.test(value)) throw new Error(`ricebox: invalid ${name}/${file}`);
      return value;
    });
    return {name, directory, metadata};
  });
  mkdirSync(destination);
  for (const p of selected) symlinkSync(p.directory, join(destination, p.name), 'dir');
  writeFileSync(join(destination, 'record'), selected.map(p => `${p.name} ${p.metadata.join(' ')}`).join('\n') + '\n');
}
function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit'});
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`ricebox: ${command} failed (${signal || code})`)));
  });
}
export async function prepareDistribution(options: PrepareOptions) {
  requireStandardFileOwner(options);
  // Do not silently accept the former network-acquiring API in JavaScript callers.
  if ('catalog' in options) throw new Error('ricebox: acquire catalog packages first, then pass packages, packageCache and tools');
  const {packages = defaultPackages, packageCache, toolchain, tools, output, version = releaseVersion(), cache, hot = []} = options;
  if (!packageCache || !output) throw new Error('ricebox: packageCache and output are required for package composition');
  if (!toolchain && !tools) throw new Error('ricebox: provide pinned tools, or a source toolchain for development');
  if (!Array.isArray(hot) || hot.some(p => typeof p !== 'string' || !p.startsWith('/') || /[\s,]/.test(p))) throw new Error('ricebox: hot must contain absolute guest program paths');
  const target = resolve(output), source = toolchain ? resolve(toolchain) : fileURLToPath(new URL('../../../', import.meta.url));
  if (existsSync(target)) throw new Error(`ricebox: output already exists: ${target}`);
  mkdirSync(dirname(target), {recursive: true});
  const work = mkdtempSync(join(dirname(target), '.ricebox-build-'));
  try {
    selectPackages(packages, packageCache, join(work, 'packages'));
    await run('sh', [join(source, 'ricebox/distribution/build/assemble.sh'), join(work, 'packages'), join(work, 'root'), version, 'ricebox']);
    const archives = readdirSync(join(work, 'root')).filter(n => n.endsWith('.tar.zst'));
    if (archives.length !== 1) throw new Error('ricebox: assembler did not produce exactly one root');
    const verified = tools && Object.fromEntries((['translator', 'sods', 'muk'] as const).map(n => [n, verifiedTool(tools![n], n)]));
    const base = join(source, 'ricebox/distribution/build/distribution');
    const producer = verified ? (existsSync(`${base}.js`) ? `${base}.js` : `${base}.ts`) : `${base}.sh`;
    const args = [producer, join(work, 'root', archives[0]), join(work, 'layers'), '--name', 'ricebox', '--deploy'];
    if (verified) {
      const maker = join(work, 'muk');
      writeFileSync(maker, verified.muk.bytes);
      args.push('--translator', verified.translator.path, '--sods', verified.sods.path, '--maker', maker);
    }
    if (cache !== undefined) args.push('--cache', cache === '' ? '' : resolve(cache));
    if (hot.length) args.push('--hot', hot.join(','));
    await run(verified ? process.execPath : 'sh', args);
    // Publish only a complete successful generation, never a half-built directory.
    renameSync(join(work, 'layers'), target);
    return target;
  } finally { rmSync(work, {recursive: true, force: true}); }
}
