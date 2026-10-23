import assert from 'node:assert/strict';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, isAbsolute, relative, sep} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {deployWorker} from './deploy-worker.ts';

// Deliberately fake values, including characters JSON must escape.
const give = {DATABASE_URL: 'postgresql://fake:password@example.test/db', BETTER_AUTH_SECRET: 'fake "secret"\nwith a newline'};
const repo = fileURLToPath(new URL('../../', import.meta.url));

test('deploy: code and secrets go together through a private regular file, kept until the deploy finishes, then removed', async (t) => {
  const log = t.mock.method(console, 'log', () => {}), error = t.mock.method(console, 'error', () => {});
  let file = '', calls = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const pending = deployWorker(give, async (...call) => {
    calls++;
    assert.equal(call.length, 1, 'no secret JSON on standard input');
    const [args] = call;
    assert.deepEqual(args.slice(0, 2), ['deploy', '--secrets-file']);
    assert.equal(args.length, 3);
    file = args[2];
    assert.ok(isAbsolute(file));
    assert.notEqual(file, '/dev/stdin');
    const fromRepo = relative(repo, file);
    assert.ok(fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo), 'outside the source and asset tree');
    assert.ok(statSync(file).isFile());
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
    }
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), give);
    for (const value of Object.values(give)) assert.ok(!args.join(' ').includes(value));
    await finished;
    assert.ok(existsSync(file), 'the asynchronous deploy still has its file');
  });
  try {
    assert.ok(existsSync(file));
  } finally {
    finish();
  }
  await pending;
  assert.equal(calls, 1);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(dirname(file)), false);
  assert.equal(log.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});

test('deploy: a failed deploy propagates its error and removes the secrets file and its directory', async () => {
  const failed = new Error('wrangler deploy: 1');
  let file = '';
  await assert.rejects(deployWorker(give, async (args) => {
    file = args[2];
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), give);
    await Promise.resolve();
    throw failed;
  }), (e) => e === failed);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(dirname(file)), false);
});

test('deploy: a synchronous runner failure also removes the secrets', async () => {
  let file = '';
  await assert.rejects(deployWorker(give, (args) => {
    file = args[2];
    throw new Error('could not start wrangler');
  }), /could not start wrangler/);
  assert.equal(existsSync(dirname(file)), false);
});

test('deploy: with no new secrets the existing plain deploy is unchanged', async () => {
  const calls: string[][] = [];
  await deployWorker({}, async (args) => { calls.push(args); });
  assert.deepEqual(calls, [['deploy']]);
});

test('deploy: concurrent deploys do not share a secrets file', async () => {
  const files: string[] = [];
  await Promise.all([give, {ENTER_KEY: 'another-fake-secret'}].map((secrets) => deployWorker(secrets, async (args) => {
    files.push(args[2]);
    await Promise.resolve();
    assert.deepEqual(JSON.parse(readFileSync(args[2], 'utf8')), secrets);
  })));
  assert.equal(new Set(files).size, 2);
  for (const file of files) assert.equal(existsSync(dirname(file)), false);
});
