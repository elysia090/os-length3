// Deploy-time composition of an explicit, already-built package set. The source
// toolchain remains explicit until independently versioned build artifacts ship.
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, rmSync, renameSync, existsSync, lstatSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

function verifiedTool(tool, name) {
  if (!tool || !/^[0-9a-f]{64}$/.test(tool.sha256) || !Number.isSafeInteger(tool.size) || tool.size < 0) throw new Error(`ricebox: ${name} requires path, size and sha256`);
  const path = resolve(tool.path), bytes = readFileSync(path);
  if (bytes.length !== tool.size || createHash('sha256').update(bytes).digest('hex') !== tool.sha256) throw new Error(`ricebox: ${name} integrity mismatch`);
  return {path, bytes};
}

export function selectPackages(packages, packageCache, destination) {
  if (!Array.isArray(packages) || !packages.length || packages.some(n => typeof n !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(n)) || new Set(packages).size !== packages.length) {
    throw new Error('ricebox: packages must be a nonempty, unique list of package names');
  }
  const cache = resolve(packageCache);
  // Validate every package before writing any selection. Never rewrite the shared
  // build cache's record: simultaneous sites may choose different packages.
  const selected = packages.map(name => {
    const directory = join(cache, name);
    if (!lstatSync(join(directory, 'tree')).isDirectory()) throw new Error(`ricebox: ${name} has no package tree`);
    const metadata = ['version', 'source', 'key'].map(file => {
      const value = readFileSync(join(directory, file), 'utf8').trim();
      if (!value || /\s/.test(value)) throw new Error(`ricebox: invalid ${name}/${file}`);
      return value;
    });
    return {name, directory, metadata};
  });
  mkdirSync(destination);
  for (const p of selected) symlinkSync(p.directory, join(destination, p.name), 'dir');
  writeFileSync(join(destination, 'record'), selected.map(p => `${p.name} ${p.metadata.join(' ')}`).join('\n') + '\n');
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit'});
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`ricebox: ${command} failed (${signal || code})`)));
  });
}
export async function prepareDistribution({packages, packageCache, toolchain, tools, output, version = '0.0.1', cache, hot = []}) {
  if (!packageCache || !output) throw new Error('ricebox: packageCache and output are required for package composition');
  if (!toolchain && !tools) throw new Error('ricebox: provide pinned tools, or a source toolchain for development');
  if (!Array.isArray(hot) || hot.some(p => typeof p !== 'string' || !p.startsWith('/') || /[\s,]/.test(p))) throw new Error('ricebox: hot must contain absolute guest program paths');
  const target = resolve(output), source = toolchain ? resolve(toolchain) : fileURLToPath(new URL('../../../', import.meta.url));
  if (existsSync(target)) throw new Error(`ricebox: output already exists: ${target}`);
  mkdirSync(dirname(target), {recursive: true});
  const work = mkdtempSync(join(dirname(target), '.ricebox-build-'));
  try {
    selectPackages(packages, packageCache, join(work, 'packages'));
    await run('sh', [join(source, 'module/ricebox/make/assemble.sh'), join(work, 'packages'), join(work, 'root'), version, 'ricebox']);
    const archives = readdirSync(join(work, 'root')).filter(n => n.endsWith('.tar.zst'));
    if (archives.length !== 1) throw new Error('ricebox: assembler did not produce exactly one root');
    const verified = tools && Object.fromEntries(['translator', 'sods', 'muk'].map(n => [n, verifiedTool(tools[n], n)]));
    const args = [join(source, verified ? 'module/ricebox/make/layers.ts' : 'module/ricebox/make/layers.sh'), join(work, 'root', archives[0]), join(work, 'layers'), '--name', 'ricebox'];
    if (verified) args.push('--translator', verified.translator.path, '--sods', verified.sods.path);
    if (cache !== undefined) args.push('--cache', cache === '' ? '' : resolve(cache));
    if (hot.length) args.push('--hot', hot.join(','));
    await run(verified ? process.execPath : 'sh', args);
    if (verified) {
      const path = `blobs/${tools.muk.sha256}.bin`;
      mkdirSync(join(work, 'layers/blobs'), {recursive: true});
      writeFileSync(join(work, 'layers', path), verified.muk.bytes);
      writeFileSync(join(work, 'layers/muk.json'), JSON.stringify({path, sha256: tools.muk.sha256, size: tools.muk.size}) + '\n');
    }
    // Publish only a complete successful generation, never a half-built directory.
    renameSync(join(work, 'layers'), target);
    return target;
  } finally { rmSync(work, {recursive: true, force: true}); }
}
