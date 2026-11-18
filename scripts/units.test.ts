import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {RICEBOX_UNITS, UNITS, check, dependencyViolations, entryViolations, reaches, unitOf} from './units.ts';

test('every file of code is one unit\'s, or a test, a script or something made (scripts/units.ts)', () => {
  assert.deepEqual(check().homeless, []);
});

test('every unit follows the dependency table without exceptions', () => {
  assert.deepEqual(check().crossings, []);
});

test('the hosted Remote depends on shared contracts, not product adapters', () => {
  const server = 'why/shipto/remote/serve/fixture.ts';
  assert.equal(unitOf(server)?.name, 'remote');
  for (const name of ['connection', 'inbox', 'lifecycle', 'news', 'passkeys.desktop', 'plan', 'policy', 'servers', 'settings']) {
    assert.equal(unitOf(`why/shipto/${name}.ts`)?.name, 'app');
  }
  assert.deepEqual(dependencyViolations([[server, "import {SCOPES} from '../../../api/ssh-scope.ts';"]]), []);
  assert.deepEqual(dependencyViolations([[server, "import pins from '../../desktop-releases.json' with {type: 'json'};"]]), []);
  assert.deepEqual(dependencyViolations([[server, "import {api} from '../../connection.ts';"]]), [['remote', 'app', server]]);
  assert.deepEqual(dependencyViolations([['why/api/ssh-scope.ts', "import {core} from './host.ts';"]]),
    [['remote-contracts', 'app', 'why/api/ssh-scope.ts']]);
});

test('the distribution owns native and web execution; Why owns its product adapters', () => {
  const unit = (name: string) => UNITS.find((u) => u.name === name)!;
  assert.deepEqual(unit('muk').holds, ['ricebox/muk']);
  for (const f of ['src/bundle.rs', 'src/run.rs', 'src/held.rs', 'src/unpack.rs', 'terminal/src/main.rs', 'runtime/worker.ts', 'runtime/pretranslate.ts', 'runtime/startup-programs.ts', 'runtime/directory-tree.ts']) {
    const path = `ricebox/distribution/${f}`;
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
    assert.equal(unitOf(path)?.name, 'ricebox');
  }
  for (const f of ['start.rs', 'running.rs', 'writes.rs', 'userland.ts']) assert.equal(unitOf(`why/prompt/${f}`)?.name, 'app');
  assert.equal(unitOf('why/api/indexeddb.ts')?.name, 'app');
  assert.equal(unitOf('why/ssh/host.ts')?.name, 'app');
  assert.equal(unitOf('why/device/storage/free.rs')?.name, 'app');
});

test('Muk and Sods have no internal dependency on one another', () => {
  const unit = (name: string) => UNITS.find((u) => u.name === name)!;
  assert.ok(!unit('muk').takes.includes('sods'));
  assert.ok(!unit('sods').takes.includes('muk'));
  assert.deepEqual(check().crossings.filter(([from, to]) =>
    (from === 'muk' && to === 'sods') || (from === 'sods' && to === 'muk')), []);
});

test('muk is a command and sods is imported only through its public entries', () => {
  const unit = (name: string) => UNITS.find((u) => u.name === name)!;
  assert.deepEqual(reaches(), []);
  assert.deepEqual(unit('muk').entries, []);
  assert.deepEqual(unit('sods').entries, ['translate', 'linux', 'host', 'targets'].map((name) => `ricebox/sods/runtime/${name}.ts`));
  // (what reads an image's layers is the distribution's, not the machine's: muk holds no TypeScript that runs)
  assert.equal(unitOf('ricebox/distribution/format/mount.ts')?.name, 'ricebox');
  assert.equal(unitOf('ricebox/sods/src/cache.rs')?.name, 'sods');
});

test('entry checks follow the owner, even outside module/ and under another unit', () => {
  for (const prefix of ['module', 'foundation']) {
    const parent = UNITS.find(unit => unit.name === 'ricebox')!;
    const sods = UNITS.find(unit => unit.name === 'sods')!;
    const units = [
      {...parent, holds: [prefix]},
      {...sods, holds: [`${prefix}/sods`], entries: [`${prefix}/sods/api.ts`]},
    ];
    assert.deepEqual(entryViolations([
      [`${prefix}/caller.ts`, "export {internal} from './sods/private.ts';"],
      [`${prefix}/consumer.ts`, "import('./sods/api.ts');"],
      [`${prefix}/sods/api.ts`, "export {internal} from './private.ts';"],
      ['scripts/check.ts', `import('../${prefix}/sods/private.ts');`],
    ], units), [
      [`${prefix}/caller.ts`, `${prefix}/sods/private.ts`],
      ['scripts/check.ts', `${prefix}/sods/private.ts`],
    ]);
  }
});

test('the table is one: each name once, each path held by one unit, each unit taken from is in it', () => {
  const names = UNITS.map((u) => u.name), paths = UNITS.flatMap((u) => u.holds);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(paths).size, paths.length);
  for (const u of UNITS) for (const t of u.takes) assert.ok(t === '*' || names.includes(t), `${u.name} takes ${t}`);
  // A unit's folder is its own; the longest path decides where one unit holds part of another's folder (the hosted Remote inside Why).
  assert.equal(unitOf('ricebox/sods/runtime/translation/translator.ts')?.name, 'sods');
  assert.equal(unitOf('ricebox/sods/runtime/linux/process.ts')?.name, 'sods');
  assert.equal(unitOf('ricebox/distribution/build/package-database.ts')?.name, 'ricebox');
});

test('Ricebox can be used without the Why product', () => {
  for (const unit of UNITS.filter(u => RICEBOX_UNITS.includes(u.name))) {
    assert.ok(unit.holds.every(path => path.startsWith('ricebox/')), unit.name);
    assert.deepEqual(unit.takes.filter(name => !RICEBOX_UNITS.includes(name)), [], unit.name);
  }
  assert.deepEqual(check().crossings.filter(([from, to]) => RICEBOX_UNITS.includes(from) && !RICEBOX_UNITS.includes(to)), []);
  assert.deepEqual(UNITS.find(unit => unit.name === 'muk')?.takes, ['toolchain']);
});
