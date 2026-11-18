import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const printer = fileURLToPath(new URL('./native-panel.ts', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [printer, ...args], {
  encoding: 'utf8', timeout: 5000,
  env: {...process.env, DISPLAY: ':invalid', WAYLAND_DISPLAY: 'not-a-session'},
});

test('prints exactly one output-bound, noninteractive clock panel without a session', () => {
  for (const output of ['eDP-1', 'HDMI-A-1', 'DP-1-2', 'HEADLESS-1', 'Virtual_1.0']) {
    const result = run(output);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /usage:/);
    assert.deepEqual(JSON.parse(result.stdout), {
      output, layer: 'top', position: 'top', exclusive: false, passthrough: true, ipc: false,
      'modules-left': [], 'modules-center': ['clock'], 'modules-right': [],
      clock: {format: '{:%H:%M}', tooltip: false},
    });
  }
});

test('refuses missing, broad, negated or multiple selectors without printing configuration', () => {
  for (const args of [[], [''], [' '], ['all'], ['ALL'], ['*'], ['DP-*'], ['DP-?'], ['DP-[12]'],
    ['!eDP-1'], ['eDP-1,DP-1'], ['eDP-1 DP-1'], ['eDP-1', 'DP-1'], ['["eDP-1"]'],
    ['eDP-1\n'], ['--help'], ['../eDP-1'], ['x'.repeat(129)]]) {
    const result = run(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^usage:/m);
  }
});
