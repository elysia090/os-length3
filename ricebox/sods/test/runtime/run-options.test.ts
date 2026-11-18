import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const runner = fileURLToPath(new URL('../../runtime/run.ts', import.meta.url));

test('the CLI rejects unsupported or incomplete options before loading program artifacts', () => {
  for (const [args, message] of [
    [['--unknown', '/no-program'], /Unknown runner option: --unknown/],
    [['--root'], /--root requires a value/],
    [['--cwd', '--tty'], /--cwd requires a value/],
    [[], /Expected a program to run/],
  ] as const) {
    const result = spawnSync(process.execPath, [runner, ...args], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, '');
  }
});
