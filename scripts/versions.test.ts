// The two versions, each said in one place: why's (why/VERSION), which every manifest of why's repeats, and
// ricebox's (module/ricebox/RELEASE), the root's. Neither is the other's.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {owed} from '../module/sods/runtime/targets.ts';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test("why's version is why/VERSION's in each of its manifests", () => {
  const version = read('why/VERSION').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read('package.json')).version, version);
  assert.equal(JSON.parse(read('why/desktop/tauri.conf.json')).version, version);
  for (const crate of ['why/core', 'why/core/web', 'why/cli', 'why/desktop']) {
    assert.equal(/^version = "([^"]+)"/m.exec(read(`${crate}/Cargo.toml`))?.[1], version, crate);
  }
});

test("ricebox's version is its own", () => {
  assert.match(read('module/ricebox/RELEASE').trim(), /^\d+\.\d+\.\d+$/);
});

test("ricebox's own line (0.0.1 on; 0.6.x is the line before the name) is begun owing nothing", () => {
  // What is put on a release under ricebox's name is used as it is taken: nothing in it unmade, unchecked or
  // made twice (module/sods/runtime/targets.ts). scripts/release.sh holds a release to the same.
  const [major, minor] = read('module/ricebox/RELEASE').trim().split('.').map(Number);
  if (major === 0 && minor < 6) assert.deepEqual(owed(), []);
  assert.match(read('scripts/release.sh'), /0\.\[0-5\]\.\*\) node module\/sods\/runtime\/targets\.ts --owed/);
});
