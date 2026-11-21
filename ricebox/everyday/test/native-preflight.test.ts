import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {preflight} from './native-preflight.ts';

const entry = fileURLToPath(new URL('./native-preflight.ts', import.meta.url));

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'everyday-preflight-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const runtime = join(root, 'session'); mkdirSync(runtime);
  const child = (name: string, code: string) => {
    const path = join(root, `${name}.mjs`);
    writeFileSync(path, `#!${process.execPath}\n${code}\n`); chmodSync(path, 0o755); return path;
  };
  const program = child('inspect', `console.log(JSON.stringify({args:process.argv.slice(2),env:Object.fromEntries(
    ['DISPLAY','WAYLAND_DISPLAY','WAYLAND_SOCKET','XDG_RUNTIME_DIR'].map(k=>[k,process.env[k]??null]))}));`);
  const args = [runtime, 'wayland-proof', program, program, program];
  const cli = (selected: string[]) => spawnSync(process.execPath,
    [entry, ...selected], {encoding: 'utf8', timeout: 10000});
  return {runtime, program, child, args, cli};
}
const socket = () => ({isSocket: () => true, isSymbolicLink: () => false});

test('only registry subprocess receives the explicit session; versions are version-only', t => {
  const {args, runtime} = fixture(t);
  for (const key of ['DISPLAY','WAYLAND_DISPLAY','WAYLAND_SOCKET','XDG_RUNTIME_DIR']) {
    const previous = process.env[key]; process.env[key] = 'unselected';
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  let checked = '';
  const evidence = preflight(args, path => {checked = path; return socket();});
  assert.equal(checked, join(runtime, 'wayland-proof'));
  assert.equal(evidence.visualAcceptance, 'not-tested');
  assert.equal(evidence.protocolCompatibility, 'not-validated');
  for (const result of Object.values(evidence.clients)) {
    assert.deepEqual(JSON.parse(result.stdout), {args: ['--version'], env: {
      DISPLAY: null, WAYLAND_DISPLAY: null, WAYLAND_SOCKET: null, XDG_RUNTIME_DIR: null,
    }});
  }
  assert.deepEqual(JSON.parse(evidence.registry.stdout), {args: [], env: {
    DISPLAY: null, WAYLAND_DISPLAY: 'wayland-proof', WAYLAND_SOCKET: null, XDG_RUNTIME_DIR: runtime,
  }});
});

test('CLI refuses missing, regular and symbolic-link sockets without a report', t => {
  const {args, runtime, cli, child} = fixture(t);
  const ran = join(runtime, 'child-ran');
  const marker = child('must-not-run', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ran)}, 'ran');`);
  for (let i = 2; i < args.length; i++) args[i] = marker;
  const refuse = () => { const r = cli(args); assert.equal(r.status, 1, r.stderr); assert.equal(r.stdout, ''); };
  refuse();
  writeFileSync(join(runtime, args[1]), 'not a socket'); refuse();
  rmSync(join(runtime, args[1])); symlinkSync('/unselected/socket', join(runtime, args[1])); refuse();
  assert.equal(existsSync(ran), false, 'reject an unverified socket before executing any subprocess');
});

test('the CLI reached through a symlink still rejects an invalid invocation', t => {
  const {runtime} = fixture(t), alias = join(runtime, 'preflight.ts');
  symlinkSync(entry, alias);
  const result = spawnSync(process.execPath, [alias], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^usage:/m);
});

test('malformed or incomplete selection is refused before any socket inspection', t => {
  const {args} = fixture(t);
  for (const selected of [[], args.slice(0, 4), [...args, 'extra'], ['relative', ...args.slice(1)],
    ...['', '*', '!wayland-0', '../wayland-0', '/tmp/wayland-0', 'wayland-0 other'].map(name => [args[0], name, ...args.slice(2)]),
    [args[0], args[1], 'foot', ...args.slice(3)]]) {
    assert.throws(() => preflight(selected, () => {throw new Error('must not inspect');}), /usage:/);
  }
});

test('failed or empty children cannot yield partial success evidence', t => {
  const {args, child} = fixture(t);
  const failed = child('failed', 'console.log("partial evidence"); console.error("permission denied\\nsecond line"); process.exit(7);');
  const empty = child('empty', '');
  for (const index of [2, 3, 4]) {
    const selected = [...args]; selected[index] = failed;
    assert.throws(() => preflight(selected, socket), /failed \(exit 7\): "[^\r\n]*permission denied\\nsecond line"; no evidence/);
  }
  const selected = [...args]; selected[4] = empty;
  assert.throws(() => preflight(selected, socket), /returned no evidence/);
});

test('registry output and elapsed time are bounded', t => {
  const {args, child} = fixture(t);
  for (const [name, code] of [
    ['too-large', 'process.stdout.write("x".repeat(2 * 1024 * 1024));'],
    ['stalled', 'setInterval(() => {}, 1000);'],
  ]) {
    const selected = [...args]; selected[4] = child(name, code);
    assert.throws(() => preflight(selected, socket), /Wayland registry failed/);
  }
});
