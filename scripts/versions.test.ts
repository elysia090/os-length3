// The two versions, each said in one place: root3's (root3/VERSION), which every manifest of root3's repeats, and
// ricebox's (module/ricebox/RELEASE), the root's. Neither is the other's.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test("root3's version is root3/VERSION's in each of its manifests", () => {
  const version = read('root3/VERSION').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read('package.json')).version, version);
  assert.equal(JSON.parse(read('root3/desktop/tauri.conf.json')).version, version);
  for (const crate of ['root3/core', 'root3/core/web', 'root3/cli', 'root3/desktop']) {
    assert.equal(/^version = "([^"]+)"/m.exec(read(`${crate}/Cargo.toml`))?.[1], version, crate);
  }
});

test("ricebox's version is its own", () => {
  assert.match(read('module/ricebox/RELEASE').trim(), /^\d+\.\d+\.\d+$/);
});
