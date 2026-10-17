// Exercise the actual embedded mount predicates without remounting a real OS.
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm, realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';

const awk = process.argv[2] ?? 'awk';
const source = await readFile(new URL('../packaging/boot/ready', import.meta.url), 'utf8');
const programs = [...source.matchAll(/\bawk\b[^']*'([^']+)'\s*(?:\\\s*)?\/proc\/mounts/g)].map(m => m[1]);
assert.equal(programs.length, 2, 'one API mount predicate and one root predicate');
const requirements = [['/dev', 'devtmpfs'], ['/proc', 'proc'], ['/sys', 'sysfs'], ['/run', 'tmpfs']];
const base = requirements.map(([path, kind]) => `${kind} ${path} ${kind} rw,relatime 0 0`)
  .concat(['overlay / overlay rw,relatime 0 0', 'system /run/release squashfs ro,relatime 0 0']);
const cases = [];
for (let mask = 0; mask < 16; ++mask)
  cases.push({name: `api-population-${mask}`, rows: base.filter((_, i) => i >= 4 || (mask & (1 << i))), api: mask === 15, root: true});
for (let i = 0; i < requirements.length; ++i) {
  const [path, kind] = requirements[i];
  for (const [name, replacement] of [['wrong-type', `none ${path} wrongfs rw 0 0`], ['path-prefix', `${kind} ${path}/suffix ${kind} rw 0 0`]]) {
    const rows = base.slice(); rows[i] = replacement;
    cases.push({name: `${name}-${i}`, rows, api: false, root: true});
  }
  cases.push({name: `duplicate-${i}`, rows: [`none ${path} wrongfs rw 0 0`, ...base], api: true, root: true});
}
for (const [flags, accepted] of [['ro', true], ['nodev,ro', true], ['ro,nodev', true], ['nodev,ro,relatime', true],
  ['rw', false], ['errors=remount-ro', false], ['root=ro', false], ['rofoo', false], ['foobar-ro', false], ['', false]]) {
  const rows = base.slice(); rows[5] = `system /run/release squashfs ${flags || 'rw'} 0 0`;
  cases.push({name: `readonly-${flags || 'empty'}`, rows, api: true, root: accepted});
}
for (const i of [4, 5]) {
  cases.push({name: `root-missing-${i}`, rows: base.filter((_, n) => n !== i), api: true, root: false});
  const rows = base.slice(); rows[i] = rows[i].replace(' overlay ', ' ext4 ').replace(' squashfs ', ' ext4 ');
  cases.push({name: `root-wrong-type-${i}`, rows, api: true, root: false});
}
cases.push({name: 'unrelated', rows: [...base, 'none /proc/suffix proc ro 0 0', 'none /run/other squashfs ro 0 0'], api: true, root: true});
const directory = await mkdtemp(join(tmpdir(), 'readiness-mounts-'));
const temporaryRoot = await realpath(tmpdir());
const createdDirectory = await realpath(directory);
assert.equal(createdDirectory, resolve(directory));
assert.equal(dirname(createdDirectory), temporaryRoot);
try {
  for (const [i, test] of cases.entries()) {
    const file = join(directory, `${i}.mounts`);
    await writeFile(file, test.rows.join('\n') + '\n');
    for (const [n, expected] of [test.api, test.root].entries()) {
      const result = spawnSync(awk, [programs[n], file], {encoding: 'utf8', windowsHide: true});
      assert.ifError(result.error);
      assert.equal(result.status, expected ? 0 : 1, `${test.name}/${n}: ${result.stderr}`);
    }
  }
  console.log(JSON.stringify({format: 'readiness-mount-fixtures-v1', status: 'pass', cases: cases.length,
    scope: 'actual mount predicates and negative filesystem/path/readonly fixtures; not full cold Linux boot'}));
} finally {
  const target = await realpath(directory);
  assert.equal(target, createdDirectory, 'cleanup stays in the directory created by this test');
  assert.equal(dirname(target), temporaryRoot);
  await rm(target, {recursive: true, force: true});
}
