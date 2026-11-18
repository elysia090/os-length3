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
test(`${provenance} translated path guest uses Rust stdio authority and real Node standard descriptors`, {
  skip: !core || !translator || process.platform !== 'linux', timeout: 30_000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sods-path-stdio-'));
  try {
    const source = fileURLToPath(new URL('../fixtures/managed-stdio/program.S', import.meta.url));
    const runner = fileURLToPath(new URL('../fixtures/managed-stdio/run.ts', import.meta.url));
    const program = join(dir, 'program.elf');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
      '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', source, '-o', program,
    ], {stdio: 'pipe', timeout: 30_000});
    const input = Buffer.from([0, 255, 65, 10]);
    for (const selection of ['absolute', 'relative']) {
      const result = spawnSync(process.execPath, [runner, core!, translator!, program, selection], {
        input, timeout: 20_000, maxBuffer: 1024 * 1024,
        env: {...process.env, NODE_NO_WARNINGS: '1'},
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 23, result.stderr.toString());
      assert.deepEqual(result.stdout, input);
      assert.equal(result.stderr.toString(), 'err\n');
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
