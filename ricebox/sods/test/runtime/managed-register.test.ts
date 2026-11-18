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
for (const mode of ['normal', 'ack', 'return'] as const) test(`${provenance} Worker FS ${mode === 'normal' ? 'applies two actual bases before returning success' : `lost ${mode} does not replay or resume`}`, {
  skip: !core || !translator || process.platform !== 'linux', timeout: 30_000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sods-managed-register-'));
  try {
    const program = join(dir, 'program.elf');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', ['-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none',
      '-Wl,-e,_start', fileURLToPath(new URL('../fixtures/managed-register/program.S', import.meta.url)), '-o', program]);
    const native = spawnSync(program, [], {input: '', timeout: 5000});
    assert.equal(native.error, undefined); assert.equal(native.signal, null); assert.equal(native.status, 0);
    assert.equal(native.stdout.toString(), 'one\ntwo\n'); assert.equal(native.stderr.length, 0);
    const script = mode === 'normal' ? new URL('../../runtime/run.ts', import.meta.url) : new URL('../fixtures/managed-register/lost-reply.ts', import.meta.url);
    const args = mode === 'normal' ? ['--managed', program] : [resolve(core!), resolve(translator!), program, mode];
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], {input: '', timeout: 20_000,
      env: {...process.env, SODS_LINUX_WASM: resolve(core!), SODS_CURRENT_TRANSLATOR_WASM: resolve(translator!), NODE_NO_WARNINGS: '1'}});
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stderr.length, 0);
    assert.equal(result.stdout.toString(), mode === 'normal' ? native.stdout.toString() : `stopped lost-fs-${mode}, retired=${mode === 'return'}\n`);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
