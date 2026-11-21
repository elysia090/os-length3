import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';

function fixture(t: TestContext) {
  const work = mkdtempSync(join(tmpdir(), 'why-release-'));
  t.after(() => rmSync(work, {recursive: true, force: true}));
  const checkout = join(work, 'checkout with spaces');
  const source = join(checkout, 'why/build');
  const ricebox = join(checkout, 'ricebox/distribution');
  mkdirSync(source, {recursive: true});
  mkdirSync(ricebox, {recursive: true});
  const publisher = join(source, 'publish-release.ts');
  copyFileSync(new URL('./publish-release.ts', import.meta.url), publisher);
  writeFileSync(join(checkout, 'why/LEGACY_RELEASE'), '0.6.5\n');
  writeFileSync(join(ricebox, 'RELEASE'), '0.0.1\n');
  const preload = join(work, 'fake-fetch.mjs');
  writeFileSync(preload, `
globalThis.fetch = async (url, {method = 'GET'} = {}) => {
  console.log(method + ' ' + url);
  if (method === 'GET' && url === 'https://example.invalid/repos/test/why/releases/tags/os-length3-linux-v0.6.5') {
    const status = Number(process.env.FIXTURE_RELEASE_STATUS);
    return new Response('', {status});
  }
  if (method === 'GET' && url === 'https://example.invalid/repos/test/why/compare/main...fixture-commit') {
    return Response.json({status: 'ahead'});
  }
  throw new Error('unexpected fetch: ' + url);
};
`);
  const run = (status: number, release = '') => spawnSync(
    process.execPath, ['--import', preload, publisher, join(work, 'out')],
    {
      cwd: work, encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env, VERSION: release, GITHUB_SHA: 'fixture-commit',
        GITHUB_REPOSITORY: 'test/why', GITHUB_API_URL: 'https://example.invalid',
        GITHUB_TOKEN: '', GH_TOKEN: '', FIXTURE_RELEASE_STATUS: String(status),
      },
    },
  );
  return {run};
}

test('the publisher reads the legacy Why root version, not the independent Ricebox version', t => {
  const {run} = fixture(t);
  const result = run(200);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split('\n'), [
    'GET https://example.invalid/repos/test/why/releases/tags/os-length3-linux-v0.6.5',
    'os-length3-linux-v0.6.5 is published already',
  ]);
});

test('the publisher rejects a commit outside main before inspecting or uploading release files', t => {
  const {run} = fixture(t);
  const result = run(404);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture-commit is not on main \(ahead\)/);
  assert.doesNotMatch(result.stdout, /POST/);
});

test('the publisher rejects a malformed version before contacting GitHub', t => {
  const {run} = fixture(t);
  const result = run(404, 'not a version');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Not a release version/);
  assert.equal(result.stdout, '');
});
