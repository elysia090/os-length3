import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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

for (const [option, value, flag] of [['SODS_RUN', '3', '--run=3'], ['SODS_BLOCKS', '1', '--trace']] as const) {
  test(`${option} invokes the native translator even with a newer Wasm artifact`, {skip: process.platform === 'win32'}, t => {
    const tmp = mkdtempSync(join(tmpdir(), 'sods-run-options-'));
    t.after(() => rmSync(tmp, {recursive: true, force: true}));
    const native = join(tmp, 'sods'), wasm = join(tmp, 'sods.wasm'), elf = join(tmp, 'elf'), log = join(tmp, 'arguments');
    writeFileSync(native, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(8);\n`);
    chmodSync(native, 0o755);
    utimesSync(native, 1, 1);
    writeFileSync(wasm, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
    writeFileSync(elf, Uint8Array.of(0x7f, 69, 76, 70, 1));
    const env = {...process.env, CARGO_TARGET_DIR: tmp, SODS_NATIVE: native, SODS_TRANSLATOR_WASM: wasm,
      SODS_RUN: '', SODS_BLOCKS: '', SODS_INLINE: '1', [option]: value};
    const result = spawnSync(process.execPath, [runner, elf], {env, encoding: 'utf8', timeout: 10_000});
    assert.ok(result.status !== null && result.status !== 0, result.error?.message ?? result.stderr);
    assert.ok(existsSync(log), result.stderr);
    assert.equal((JSON.parse(readFileSync(log, 'utf8')) as string[])[0], flag);
  });
}
