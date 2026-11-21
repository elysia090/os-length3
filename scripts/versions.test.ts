// Why, the legacy OS Length3 release, and the independent Ricebox producer each have a version source.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {owed} from '../ricebox/sods/runtime/targets.ts';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test("why's version is why/VERSION's in each of its manifests", () => {
  const version = read('why/VERSION').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read('package.json')).version, version);
  const npmLock = JSON.parse(read('package-lock.json'));
  assert.equal(npmLock.version, version, 'npm lock');
  assert.equal(npmLock.packages[''].version, version, 'npm lock root package');
  assert.equal(JSON.parse(read('why/desktop/tauri.conf.json')).version, version);
  for (const crate of ['why', 'why/api/web', 'why/cli', 'why/desktop']) {
    assert.equal(/^version = "([^"]+)"/m.exec(read(`${crate}/Cargo.toml`))?.[1], version, crate);
  }
  const cargoLock = read('Cargo.lock').split('[[package]]');
  for (const name of ['why', 'why-core', 'why-core-web', 'why-desktop']) {
    const entry = cargoLock.find(section => section.includes(`\nname = "${name}"\n`));
    assert.equal(/^version = "([^"]+)"/m.exec(entry ?? '')?.[1], version, `Cargo.lock: ${name}`);
  }
});

test('Ricebox has its own version while Why keeps the legacy release default', () => {
  const version = read('ricebox/distribution/RELEASE').trim();
  const legacy = read('why/LEGACY_RELEASE').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(legacy, /^\d+\.\d+\.\d+$/);
  assert.equal(/^version = "([^"]+)"/m.exec(read('ricebox/distribution/Cargo.toml'))?.[1], version);
  const ricebox = read('Cargo.lock').split('[[package]]').find(section => section.includes('\nname = "ricebox"\n'));
  assert.equal(/^version = "([^"]+)"/m.exec(ricebox ?? '')?.[1], version);
  assert.match(read('.github/workflows/release.yml'), /paths: \['why\/LEGACY_RELEASE',/);
});

test('a local version does not bypass the public-release readiness gate', () => {
  const gate = fileURLToPath(new URL('../ricebox/sods/runtime/targets.ts', import.meta.url));
  const result = spawnSync(process.execPath, [gate, '--owed'], {encoding: 'utf8'});
  const outstanding = owed().length;
  assert.equal(result.status, outstanding ? 1 : 0, result.stderr);
  if (outstanding) assert.match(result.stderr, new RegExp(`${outstanding} owed`));
  assert.match(read('why/build/release.sh'), /0\.\[0-5\]\.\*\) node ricebox\/sods\/runtime\/targets\.ts --owed/);
});
