import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {production} from './verify.ts';

// verify:remote's guard: what it takes for production, before it connects
// to anything. Neon is never asked here (`ask` stands in for it).

const neon = (endpoint: string, pooled = false) => new URL(`postgresql://owner:pw@${endpoint}${pooled ? '-pooler' : ''}.us-east-2.aws.neon.tech/neondb`);
const none = async () => null;

test('this machine is never production; a host named so, or one not reached with the Worker\'s driver, is refused', async () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'db.localhost']) assert.equal(await production(new URL(`postgresql://u:p@${h}:5432/x`), {}, none), null, h);
  assert.match(await production(new URL('postgresql://u:p@db-prod.example.com/x'), {}, none) ?? '', /named as production/);
  assert.match(await production(new URL('postgresql://u:p@ep-x-1.production.neon.tech/x'), {}, none) ?? '', /named as production/);
  assert.match(await production(new URL('postgresql://u:p@db.example.com/x'), {}, none) ?? '', /not a Neon host/);
});

test('a Neon endpoint is production when Neon or REMOTE_PRODUCTION_HOSTS says it is the default branch\'s, pooled or not; with neither, it cannot tell', async () => {
  const main = 'ep-quiet-sea-111111', branch = 'ep-bold-hill-222222';
  assert.match(await production(neon(main, true), {REMOTE_PRODUCTION_HOSTS: main}, none) ?? '', /REMOTE_PRODUCTION_HOSTS/);
  assert.match(await production(neon(main), {REMOTE_PRODUCTION_HOSTS: ` other , ${main}-pooler.us-east-2.aws.neon.tech`}, none) ?? '', /REMOTE_PRODUCTION_HOSTS/);
  assert.equal(await production(neon(branch, true), {REMOTE_PRODUCTION_HOSTS: main}, none), null);
  const ask = async () => neon(main).toString();
  assert.match(await production(neon(main, true), {}, ask) ?? '', /default branch/);
  assert.equal(await production(neon(branch), {}, ask), null);
  assert.match(await production(neon(branch), {}, none) ?? '', /cannot tell/);
});

test('refused, it says why and never the URL, its host or its password', () => {
  const r = spawnSync(process.execPath, [new URL('./verify.ts', import.meta.url).pathname], {encoding: 'utf8',
    env: {PATH: process.env.PATH ?? '', DATABASE_URL: 'postgresql://owner:s3cretpass@ep-bold-hill-222222-pooler.us-east-2.aws.neon.tech/neondb'}});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refused: this looks like production \(it cannot tell/);
  assert.doesNotMatch(r.stdout + r.stderr, /s3cretpass|bold-hill|neon\.tech/);
  const flag = spawnSync(process.execPath, [new URL('./verify.ts', import.meta.url).pathname, '--yes'], {encoding: 'utf8', env: {PATH: process.env.PATH ?? ''}});
  assert.deepEqual([flag.status, flag.stderr.trim()], [2, 'verify:remote: not a flag: --yes (only --production)']);
});
