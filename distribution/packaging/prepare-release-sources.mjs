// Publication plumbing: preserve compressed, authenticated source inputs.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, renameSync,
  rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (process.argv.length !== 3 || !process.argv[2].endsWith('.tar')) {
  throw new Error('usage: node prepare-release-sources.mjs OUTPUT.tar');
}
const output = resolve(process.argv[2]);
if (existsSync(output)) throw new Error('refusing to replace an existing source asset');

function run(command, args, cwd = repo) {
  const result = spawnSync(command, args, {
    cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
  return result.stdout;
}
function declarations(file) {
  const values = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\s]+)$/.exec(line);
    if (!match || values.has(match[1])) throw new Error(`invalid source lock: ${file}`);
    values.set(match[1], match[2]);
  }
  return values;
}
async function digest(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

// The recipe must describe the shipped population, not a newer upstream lock.
const receipt = join(repo, 'releases/native/verification/sources.env');
if (readFileSync(receipt, 'utf8').replaceAll('\r\n', '\n') !==
    readFileSync(join(repo, 'distribution/sources.env'), 'utf8').replaceAll('\r\n', '\n')) {
  throw new Error('source receipt and current recipe differ');
}
run('git', ['diff', '--quiet', 'HEAD']);
const commit = run('git', ['rev-parse', '--verify', 'HEAD']).trim();
const decoder = join(repo, 'compiler/x86/third_party/zydis');
const core = join(decoder, 'dependencies/zycore');
for (const path of [decoder, core]) run('git', ['diff', '--quiet', 'HEAD'], path);
const decoderCommit = run('git', ['rev-parse', 'HEAD'], decoder).trim();
const coreCommit = run('git', ['rev-parse', 'HEAD'], core).trim();
const decoderPin = run('git', ['ls-tree', 'HEAD', 'compiler/x86/third_party/zydis']).split(/\s+/)[2];
const corePin = run('git', ['ls-tree', 'HEAD', 'dependencies/zycore'], decoder).split(/\s+/)[2];
if (decoderCommit !== decoderPin || coreCommit !== corePin) {
  throw new Error('decoder checkout differs from the recipe gitlinks');
}
const members = new Map();
for (const lock of [receipt, join(repo, 'distribution/bootstrap/tzcode.env')]) {
  const values = declarations(lock);
  for (const [key, value] of values) {
    if (!key.endsWith('_URL')) continue;
    const name = basename(new URL(value).pathname);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('unsafe source filename');
    const file = join(repo, 'distribution/upstream', name);
    const prefix = key.slice(0, -4);
    let checked = false;
    for (const algorithm of ['sha256', 'sha512']) {
      const expected = values.get(`${prefix}_${algorithm.toUpperCase()}`);
      if (!expected) continue;
      if (await digest(file, algorithm) !== expected) throw new Error(`source checksum: ${name}`);
      checked = true;
    }
    if (!checked) throw new Error(`unpinned source: ${name}`);
    members.set(name, `distribution/upstream/${name}`);
  }
}
const stage = mkdtempSync(join(dirname(output), '.release-sources-'));
try {
  run('git', ['archive', '--format=tar', '--prefix=recipe/',
    `--output=${join(stage, 'recipe.tar')}`, 'HEAD']);
  run('git', ['archive', '--format=tar', '--prefix=recipe/compiler/x86/third_party/zydis/',
    `--output=${join(stage, 'zydis.tar')}`, 'HEAD'], decoder);
  run('git', ['archive', '--format=tar',
    '--prefix=recipe/compiler/x86/third_party/zydis/dependencies/zycore/',
    `--output=${join(stage, 'zycore.tar')}`, 'HEAD'], core);
  writeFileSync(join(stage, 'RELEASE-SOURCE.txt'), [
    'format=release-source-inputs-v1', `recipe.commit=${commit}`,
    `zydis.commit=${decoderCommit}`, `zycore.commit=${coreCommit}`,
    `upstream.inputs=${members.size}`, '',
    'Original upstream archives retain their individual license notices.',
    'recipe.tar contains the publication checkpoint: sources, configurations,',
    'patches, compiler, build scripts and the exact bundle verification receipt.',
    'The decoder submodules are included separately, without Git internals.',
    'Unpack recipe.tar, zydis.tar and zycore.tar into the same directory.',
    'Copy distribution/upstream into recipe/distribution/upstream.',
    'Follow recipe/distribution/README.md to build.',
    'No private signing key, scratch root or build-host disk is included.',
    'Package signatures use a local test key; rebuild with your own authority.',
    'This is not a claim of hash-identical reproduction on a different host.', '',
  ].join('\n'));
  const temporary = join(stage, 'sources.tar');
  run('tar', ['--format=pax', '-cf', temporary,
    '-C', repo, ...[...members.values()].sort(),
    '-C', stage, 'recipe.tar', 'zydis.tar', 'zycore.tar', 'RELEASE-SOURCE.txt']);
  // Stored archives are already compressed: never inflate another source forest.
  run('tar', ['-tf', temporary]);
  renameSync(temporary, output);
  console.log(`release sources: ${members.size} authenticated inputs, recipe ${commit}`);
  console.log(`${await digest(output, 'sha256')}  ${basename(output)}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
