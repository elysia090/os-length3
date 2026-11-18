import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
const core = process.env.SODS_LINUX_WASM;
const translator = process.env.SODS_CURRENT_TRANSLATOR_WASM ?? process.env.SODS_PATH_TRANSLATOR_WASM;
const provenance = process.env.SODS_CURRENT_TRANSLATOR_WASM ? 'current-source' : 'explicit external';
for (const mode of ['normal', 'tid', 'leave'] as const) test(`${provenance} single-task ${mode === 'normal' ? 'registration and group exit preserve the selected identity contract' : `lost ${mode} publication is not a successful guest exit`}`, {
  skip: !core || !translator || process.platform !== 'linux', timeout: 30_000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sods-managed-task-'));
  try {
    const program = join(dir, 'program.elf');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [...(mode === 'normal' ? [] : ['-DSODS_TASK_NO_OUTPUT']),
      '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start',
      fileURLToPath(new URL('../fixtures/managed-task/program.S', import.meta.url)), '-o', program]);
    const native = spawnSync(program, [], {input: '', timeout: 5000});
    assert.equal(native.error, undefined); assert.equal(native.signal, null); assert.equal(native.status, 23);
    assert.equal(native.stderr.length, 0);
    if (mode === 'normal') {
      assert.equal(native.stdout.subarray(0, 8).toString(), 'tid-ok!\n');
      assert.equal(native.stdout.length, 16); assert.equal(native.stdout.readBigUInt64LE(8), BigInt(native.pid));
    } else assert.equal(native.stdout.length, 0);
    const script = mode === 'normal' ? new URL('../../runtime/run.ts', import.meta.url) : new URL('../fixtures/managed-task/lost-reply.ts', import.meta.url);
    const args = mode === 'normal' ? ['--managed', program] : [resolve(core!), resolve(translator!), program, mode];
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], {input: '', timeout: 20_000,
      env: {...process.env, SODS_LINUX_WASM: resolve(core!), SODS_CURRENT_TRANSLATOR_WASM: resolve(translator!), NODE_NO_WARNINGS: '1'}});
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, mode === 'normal' ? native.status : 0, result.stderr.toString()); assert.equal(result.stderr.length, 0);
    if (mode === 'normal') {
      assert.deepEqual(result.stdout.subarray(0, 8), native.stdout.subarray(0, 8));
      assert.equal(result.stdout.length, 16); assert.equal(result.stdout.readBigUInt64LE(8), 1n, 'execution-local guest task identity, not the native child PID');
    } else assert.equal(result.stdout.toString(), `retired 2 lost-task-${mode}; fresh task exited23\n`);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
