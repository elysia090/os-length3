/** Optional integration check against a locally supplied historical release. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {openDistribution} from '../../deployment/local.ts';

const source = process.env.RICEBOX_RELEASE_DIR;
const muk = process.env.RICEBOX_MUK_FILE;
const expectedMuk = process.env.RICEBOX_MUK_SHA256;

test('a release root runs its shell through Muk', {skip: !source || !muk || !expectedMuk}, () => {
  assert.equal(createHash('sha256').update(readFileSync(muk!)).digest('hex'), expectedMuk);
  const web = resolve(source!);
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
