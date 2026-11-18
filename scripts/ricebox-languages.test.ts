import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {LANGUAGE_LINES} from '../ricebox/distribution/verification/language-cases.ts';

// Tests the workloads themselves on the test machine. Actual distribution
// support is measured by commands.ts in native and translated copies of a root.
const expected = ['42\n', 'python-project-ok\n', 'node-project-ok\n', 'npm-project-ok\n', '42\n', 'cargo-project-ok\n', 'go-project-ok\n'];
test('language workloads are valid POSIX shell and require actual tools', () => {
  for (const {uses,line} of LANGUAGE_LINES) {
    assert.equal(spawnSync('sh', ['-n', '-c', line]).status, 0, uses.join(', '));
    assert.ok(uses.length > 0);
    assert.ok(!line.includes('--version'));
  }
});
for (const [i, {uses,line}] of LANGUAGE_LINES.entries()) {
  test(`host smoke of ${uses.join('/')} project fixture (not distribution support)`, (t) => {
    const missing = uses.filter((name) => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name]).status !== 0);
    if (missing.length) { t.skip(`test host has no ${missing.join(', ')}`); return; }
    const result = spawnSync('sh', ['-c', line], {encoding: 'utf8', timeout: 120000});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, expected[i]);
  });
}
