import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';

const global = (name: string, version: number | string, id: number | string) => `interface: '${name}',  version:  ${version}, name:  ${id}\n`;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'everyday-registry-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const path = join(root, 'preflight.json');
  const write = (stdout: string, stderr = '') => writeFileSync(path, JSON.stringify({kind: 'everyday-native-preflight',
    visualAcceptance: 'not-tested', protocolCompatibility: 'not-validated', registry: {stdout, stderr}}));
  const run = (...requirements: string[]) => spawnSync(process.execPath,
    [fileURLToPath(new URL('./native-registry.ts', import.meta.url)), path, ...requirements], {encoding: 'utf8', timeout: 5000});
  const invalid = (...requirements: string[]) => {
    const result = run(...requirements); assert.equal(result.status, 2, result.stderr); assert.equal(result.stdout, '');
  };
  return {root, path, write, run, invalid};
}

test('actual CLI compares only global headers and takes the highest distinct instance', t => {
  const {write, run} = fixture(t);
  write(global('wl_output', 2, 1) + '\tname: panel, version: 999\n' + global('wl_output', 4, 2) + global('wl_seat', 8, 3));
  const result = run('wl_output=4', 'wl_seat=8');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: 'everyday-native-registry-comparison', visualAcceptance: 'not-tested', protocolCompatibility: 'not-validated',
    matching: 'at-least-one-instance', satisfied: true, requirements: [
      {name: 'wl_output', minimum: 4, advertised: 4, status: 'met'},
      {name: 'wl_seat', minimum: 8, advertised: 8, status: 'met'},
    ],
  });
});

test('missing and too-old requirements give a report but nonzero status', t => {
  const {write, run} = fixture(t); write(global('wl_seat', 4, 1));
  const result = run('wl_seat=5', 'xdg_wm_base=1');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).requirements, [
    {name: 'wl_seat', minimum: 5, advertised: 4, status: 'too-old'},
    {name: 'xdg_wm_base', minimum: 1, advertised: null, status: 'missing'},
  ]);
});

test('invalid global captures produce no comparison report', t => {
  const {write, invalid} = fixture(t);
  for (const capture of ['', '\tname: 1\n', "interface: 'wl_seat', version: 4\n", 'not a global\n',
    global('wl_seat', 0, 1), global('wl_seat', -1, 1), global('wl_seat', '1.5', 1),
    global('wl_seat', 4294967296, 1), global('wl_seat', 1, 4294967296),
    global('wl_seat', 1, 1) + global('wl_output', 2, '01')]) {
    write(capture); invalid('wl_seat=1');
  }
});

test('requirements are explicit, unique and positive U32 versions', t => {
  const {write, run, invalid} = fixture(t); write(global('wl_seat', 4294967295, 0));
  assert.equal(run('wl_seat=4294967295').status, 0);
  for (const requirements of [[], ['wl_seat'], ['*=1'], ['wl_seat=0'], ['wl_seat=-1'], ['wl_seat=1.5'],
    ['wl_seat=4294967296'], ['wl_seat=1', 'wl_seat=2']]) invalid(...requirements);
});

test('input must be bounded regular preflight JSON, not a link or another report', t => {
  const {root, path, write, invalid} = fixture(t);
  invalid('wl_seat=1');
  for (const bytes of ['{', 'null', '{}', JSON.stringify({kind: 'everyday-native-preflight', registry: {stdout: 42}})]) {
    writeFileSync(path, bytes); invalid('wl_seat=1');
  }
  truncateSync(path, 40 * 1024 * 1024 + 1); invalid('wl_seat=1');
  write(global('wl_seat', 1, 1));
  const other = join(root, 'other.json'); writeFileSync(other, '{}'); rmSync(path); symlinkSync(other, path); invalid('wl_seat=1');
  rmSync(path); symlinkSync(root, path); invalid('wl_seat=1');
});

test('the JSON envelope allows expansion of a recorder-sized stream', t => {
  const {write, run} = fixture(t);
  write(global('wl_seat', 1, 1), '\0'.repeat(1024 * 1024));
  const result = run('wl_seat=1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).satisfied, true);
});
