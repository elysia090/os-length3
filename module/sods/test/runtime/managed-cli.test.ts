import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const core = process.env.SODS_LINUX_WASM;
const translator = process.env.SODS_CURRENT_TRANSLATOR_WASM ?? process.env.SODS_PATH_TRANSLATOR_WASM;
const provenance = process.env.SODS_CURRENT_TRANSLATOR_WASM ? 'current-source' : 'explicit external';
test(`${provenance} managed CLI runs a rootless static guest with real stdio`, {
  skip: !core || !translator || process.platform !== 'linux', timeout: 30_000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sods-managed-cli-'));
  try {
    const cli = fileURLToPath(new URL('../../runtime/run.ts', import.meta.url));
    const program = join(dir, 'program.elf');
    const env = {...process.env, SODS_LINUX_WASM: core!, SODS_CURRENT_TRANSLATOR_WASM: translator!, NODE_NO_WARNINGS: '1'};
    for (const [fixture, status] of [['managed-stdio', 23], ['managed-cli', 0]] as const) {
      const source = fileURLToPath(new URL(`../fixtures/${fixture}/program.S`, import.meta.url));
      execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
        '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', source, '-o', program,
      ], {stdio: 'pipe', timeout: 30_000});
      const input = Buffer.from([0, 255, 65, 10]);
      const result = spawnSync(process.execPath, [cli, '--managed', program, 'a', 'b'], {
        input, timeout: 20_000, maxBuffer: 1024 * 1024, env,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, status, result.stderr.toString());
      assert.deepEqual(result.stdout, status === 23 ? input : Buffer.alloc(0));
      assert.equal(result.stderr.toString(), status === 23 ? 'err\n' : '');
    }
    // Artifact failure cannot select the legacy runner or execute the guest.
    const emptyWasm = join(dir, 'empty.wasm');
    writeFileSync(emptyWasm, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    const artifactInput = join(dir, 'artifact-input');
    writeFileSync(artifactInput, 'untouched');
    for (const override of [
      {SODS_LINUX_WASM: join(dir, 'missing.wasm')},
      {SODS_LINUX_WASM: emptyWasm},
      {SODS_CURRENT_TRANSLATOR_WASM: emptyWasm},
    ]) {
      const fd = openSync(artifactInput, 'r');
      try {
        const rejected = spawnSync(process.execPath, [cli, '--managed', program, 'a', 'b'], {
          stdio: [fd, 'pipe', 'pipe'], timeout: 5000, env: {...env, ...override},
        });
        assert.equal(rejected.error, undefined);
        assert.equal(rejected.signal, null);
        assert.notEqual(rejected.status, 0);
        assert.equal(rejected.stdout.length, 0);
        assert.match(rejected.stderr.toString(), /Error/);
        const remaining = Buffer.alloc(9);
        assert.equal(readSync(fd, remaining, 0, remaining.length, null), 9);
        assert.equal(remaining.toString(), 'untouched');
      } finally { closeSync(fd); }
    }
    const unsupportedSource = fileURLToPath(new URL('../fixtures/managed-cli/unsupported.S', import.meta.url));
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
      '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', unsupportedSource, '-o', program,
    ], {stdio: 'pipe', timeout: 30_000});
    const unsupported = spawnSync(process.execPath, [cli, '--managed', program], {input: '', timeout: 5000, env});
    assert.equal(unsupported.error, undefined);
    assert.equal(unsupported.signal, null);
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr.toString(), /Unsupported Rust Worker command: 3 \(value 39, syscall 39\)/);
    writeFileSync(program, 'not an ELF');
    const rejected = spawnSync(process.execPath, [cli, '--managed', program], {input: '', timeout: 5000, env});
    assert.equal(rejected.error, undefined);
    assert.equal(rejected.signal, null);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr.toString(), /NotAProgram|program|ELF/i);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('managed CLI rejects unsupported modes before opening inputs or consuming stdin', {timeout: 30_000}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sods-managed-reject-'));
  const cli = fileURLToPath(new URL('../../runtime/run.ts', import.meta.url));
  const modes = ['SODS_RUN', 'SODS_BLOCKS', 'SODS_INLINE', 'SODS_TIMING', 'SODS_FREE', 'SODS_UNSUPPORTED', 'SODS_BUDGET'];
  const base: NodeJS.ProcessEnv = {...process.env, NODE_NO_WARNINGS: '1', SODS_LINUX_WASM: join(dir, 'missing-core')};
  for (const mode of modes) delete base[mode];
  const program = join(dir, 'missing-program');
  const cases: {args: string[]; env: NodeJS.ProcessEnv; message: string}[] = [
    {args: [], env: base, message: 'requires a host PROGRAM'},
    ...['--root', '--cwd', '--tty', '--unknown'].map(flag => ({args: [flag], env: base, message: 'accepts no runner options'})),
    ...modes.map(mode => ({args: [program], env: {...base, [mode]: ''}, message: `does not support ${mode}`})),
    {args: [program], env: {...base, SODS_LINUX_WASM: ''}, message: 'requires SODS_LINUX_WASM'},
  ];
  try {
    const input = join(dir, 'stdin');
    writeFileSync(input, 'untouched');
    for (const c of cases) {
      const fd = openSync(input, 'r');
      try {
        const result = spawnSync(process.execPath, [cli, '--managed', ...c.args], {
          stdio: [fd, 'pipe', 'pipe'], env: c.env, timeout: 2000,
        });
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.toString().includes(c.message), result.stderr.toString());
        assert.ok(!result.stderr.toString().includes('ENOENT'), result.stderr.toString());
        const remaining = Buffer.alloc(9);
        assert.equal(readSync(fd, remaining, 0, remaining.length, null), 9);
        assert.equal(remaining.toString(), 'untouched');
      } finally { closeSync(fd); }
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
