// Run the shell from a prepared release using the Muk shipped alongside it.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {openDistribution} from '../../deployment/local.ts';
import {blobAsset} from '../../format/manifest.ts';

test('a release root runs its shell through Muk', {timeout: 60_000}, () => {
  const source = process.env.RICEBOX_RELEASE_DIR;
  assert.ok(source, 'Set RICEBOX_RELEASE_DIR to a prepared web root');
  const web = resolve(source);
  const descriptor = blobAsset(JSON.parse(readFileSync(join(web, 'muk.json'), 'utf8')));
  const muk = join(web, descriptor.path);
  const bytes = readFileSync(muk);
  assert.equal(bytes.length, descriptor.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
  const release = openDistribution(web);
  try { release.checkAll(); }
  finally { release.close(); }
  const request = {web, path: '/usr/bin/sh', args: ['-c', 'printf root-ok'], translator: '', fresh: false, kept: null, muk};
  const script = fileURLToPath(new URL('../programs.ts', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [script, '--child', JSON.stringify(request)], {
    env: {...process.env, SODS_INLINE: '1'}, encoding: 'utf8', timeout: 60_000, maxBuffer: 1 << 20,
  }));
  assert.deepEqual({status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error},
    {status: 0, stdout: 'root-ok', stderr: '', error: null});
});
