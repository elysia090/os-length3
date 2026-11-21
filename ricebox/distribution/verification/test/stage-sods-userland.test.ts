import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {openDistribution} from '../../deployment/local.ts';
import {makeWebroot, standIn} from '../../test/fixtures/distribution.ts';
import {stageSodsUserland} from './fixtures/stage-sods-userland.ts';

function fixture(t: TestContext) {
  const work = mkdtempSync(join(tmpdir(), 'sods userland '));
  t.after(() => rmSync(work, {recursive: true, force: true}));
  const web = join(work, 'web'), out = join(work, 'test artifacts');
  const made = makeWebroot(standIn(work, '1.2.3'), web, work);
  assert.equal(made.status, 0, made.stderr);
  const release = openDistribution(web);
  t.after(release.close);
  return {release, web, out};
}

test('stage only the verified BusyBox and its release translator', t => {
  const {release, web, out} = fixture(t);
  stageSodsUserland(web, out);
  const busybox = release.index.translations[0];
  assert.deepEqual(readdirSync(out).sort(), ['busybox', 'busybox.wasm', 'sods.wasm']);
  assert.deepEqual(readFileSync(join(out, 'busybox')), release.blob(busybox.elf));
  assert.deepEqual(readFileSync(join(out, 'busybox.wasm')), release.blob(busybox.wasm));
  assert.deepEqual(readFileSync(join(out, 'sods.wasm')), release.blob(release.index.translator));
  assert.throws(() => stageSodsUserland(web, out), /already exists/);
});

test('damaged release input does not create or replace a fixture', t => {
  const {release, web, out} = fixture(t);
  writeFileSync(join(web, release.index.translations[0].elf.path), 'corrupt');
  assert.throws(() => stageSodsUserland(web, out), /not the stored blob/);
  assert.equal(existsSync(out), false);
});
