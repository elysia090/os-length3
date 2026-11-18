import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const core = process.env.SODS_LINUX_WASM;
const translator = process.env.SODS_CURRENT_TRANSLATOR_WASM ?? process.env.SODS_PATH_TRANSLATOR_WASM;
const provenance = process.env.SODS_CURRENT_TRANSLATOR_WASM ? 'current-source' : 'explicit external';

test(`${provenance} managed CLI guest opens, reads and closes its canonical executable through Rust`, {
  skip: !core || !translator || process.platform !== 'linux', timeout: 30_000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sods-managed-open-'));
  try {
    const source = fileURLToPath(new URL('../fixtures/managed-open/program.S', import.meta.url));
    const cli = fileURLToPath(new URL('../../runtime/run.ts', import.meta.url));
    const program = join(dir, 'program.elf');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
      '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', source, '-o', program,
    ], {stdio: 'pipe', timeout: 30_000});
    const native = spawnSync(program, [], {input: '', timeout: 10_000});
    assert.equal(native.error, undefined); assert.equal(native.signal, null);
    assert.equal(native.status, 0, native.stderr.toString());
    assert.deepEqual(native.stdout, Buffer.from([127, 69, 76, 70])); assert.equal(native.stderr.length, 0);
    const managed = spawnSync(process.execPath, [cli, '--managed', program], {
      input: '', timeout: 20_000,
      env: {...process.env, SODS_LINUX_WASM: core!, SODS_CURRENT_TRANSLATOR_WASM: translator!, NODE_NO_WARNINGS: '1'},
    });
    assert.equal(managed.error, undefined); assert.equal(managed.signal, null);
    assert.equal(managed.status, native.status, managed.stderr.toString());
    assert.deepEqual(managed.stdout, native.stdout); assert.deepEqual(managed.stderr, native.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test(`${provenance} lost Worker reply after FD publication does not replay open and retires on observed exit`, {
  skip: !core || !translator || process.platform !== 'linux', timeout: 30_000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sods-managed-open-reply-'));
  try {
    const source = fileURLToPath(new URL('../fixtures/managed-open/program.S', import.meta.url));
    const runner = fileURLToPath(new URL('../fixtures/managed-open/lost-reply.ts', import.meta.url));
    const program = join(dir, 'program.elf');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
      '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', source, '-o', program,
    ], {stdio: 'pipe', timeout: 30_000});
    const result = spawnSync(process.execPath, [runner, core!, translator!, program], {
      input: 'untouched', timeout: 20_000, env: {...process.env, NODE_NO_WARNINGS: '1'},
    });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), 'retired 2 lost-open-replies\n'); assert.equal(result.stderr.length, 0);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test(`${provenance} pathname capture does not invoke mutable constructor/species or expose guest backing`, {
  skip: !core || !translator || process.platform !== 'linux', timeout: 30_000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sods-managed-open-species-'));
  try {
    const source = fileURLToPath(new URL('../fixtures/managed-open/program.S', import.meta.url));
    const runner = fileURLToPath(new URL('../fixtures/managed-open/species.ts', import.meta.url));
    const program = join(dir, 'program.elf');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
      '-DSODS_OPEN_NO_OUTPUT', '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', source, '-o', program,
    ], {stdio: 'pipe', timeout: 30_000});
    const result = spawnSync(process.execPath, [runner, core!, translator!, program], {
      input: '', timeout: 20_000, env: {...process.env, NODE_NO_WARNINGS: '1'},
    });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), 'species-safe 2 captures\n'); assert.equal(result.stderr.length, 0);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
