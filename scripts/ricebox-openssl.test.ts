import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';

test('OpenSSL recipe installs its source config and checks certificate generation with that config', t => {
  const version = spawnSync('openssl', ['version'], {encoding: 'utf8'});
  if (version.status !== 0) return t.skip('host OpenSSL required for the recipe-check fixture');
  const tool = spawnSync('sh', ['-c', 'command -v openssl'], {encoding: 'utf8'}).stdout.trim();
  const work = mkdtempSync(join(tmpdir(), 'ricebox-openssl-'));
  const recipe = resolve(import.meta.dirname, '../module/ricebox/packages/openssl/recipe.sh');
  const dest = join(work, 'dest');
  try {
    mkdirSync(join(work, 'apps'));
    mkdirSync(join(work, 'bin'));
    // The source/build are fixtures; the recipe's install and check use real sh,
    // filesystem operations and OpenSSL, rather than a mocked successful req.
    const config = '[req]\ndistinguished_name=dn\n[dn]\ncommonName=Common Name\n';
    writeFileSync(join(work, 'apps/openssl.cnf'), config);
    writeFileSync(join(work, 'Configure'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
    writeFileSync(join(work, 'bin/make'), '#!/bin/sh\nmkdir -p "$dest/usr/bin"\nln -sf "$TEST_OPENSSL" "$dest/usr/bin/openssl"\n', {mode: 0o755});
    const env = {...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH}`, dest, jobs: '1',
      TEST_OPENSSL: tool, OPENSSL_VERSION: version.stdout.split(' ')[1]};
    const run = (command: string) => spawnSync('sh', ['-ec', `. "$1"; ${command}`, 'recipe-check', recipe], {cwd: work, env, encoding: 'utf8'});
    const result = run('build; check');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(dest, 'etc/ssl/openssl.cnf'), 'utf8'), config);
    assert.equal(statSync(join(dest, 'etc/ssl/openssl.cnf')).mode & 0o777, 0o644);
    rmSync(join(dest, 'etc/ssl/openssl.cnf'));
    assert.notEqual(run('check').status, 0, 'missing staged config must not pass using the host config');
  } finally { rmSync(work, {recursive: true, force: true}); }
});
