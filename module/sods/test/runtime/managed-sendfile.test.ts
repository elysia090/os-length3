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
// Real normal core/translator/Worker negative gate only. Physical capability
// acceptance, source-view output and successful sendfile/cat are NOT tested.
for (const mode of ['lazy-six', 'lazy-zero', 'resident-eof'] as const) {
  test(`${provenance} Worker sendfile ${mode} rejects capability before source/output, retires and runs fresh control42`, {
    skip: !core || !translator || process.platform !== 'linux', timeout: 45_000,
  }, t => {
    const directory = mkdtempSync(join(tmpdir(), 'sods-managed-sendfile-'));
    try {
      const source = fileURLToPath(new URL('../fixtures/managed-sendfile/program.S', import.meta.url));
      const runner = fileURLToPath(new URL('../fixtures/managed-sendfile/negative.ts', import.meta.url));
      const negative = join(directory, 'negative.elf'), control = join(directory, 'control.elf');
      const flags = ['-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start'];
      const compiler = process.env.SODS_FIXTURE_CC ?? 'musl-gcc';
      execFileSync(compiler, [`-DSODS_SENDFILE_COUNT=${mode === 'lazy-zero' ? 0 : 6}`, ...flags, source, '-o', negative], {
        stdio: 'pipe', timeout: 30_000, env: {...process.env, TMPDIR: directory},
      });
      execFileSync(compiler, ['-DSODS_SENDFILE_CONTROL', ...flags, source, '-o', control], {
        stdio: 'pipe', timeout: 30_000, env: {...process.env, TMPDIR: directory},
      });
      const result = spawnSync(process.execPath, [runner, core!, translator!, negative, control, mode], {
        input: '', stdio: ['pipe', 'pipe', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1024 * 1024,
        env: {...process.env, NODE_NO_WARNINGS: '1'},
      });
      assert.equal(result.error, undefined);assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr?.toString());
      assert.equal(result.stdout?.length, 0, 'guest returned after sendfile rejection or emitted source bytes');
      assert.equal(result.stderr?.length, 0);
      const evidence = JSON.parse(result.output[3]!.toString());
      assert.equal(evidence.mode, mode);
      assert.ok(evidence.programBytes > 0 && evidence.controlBytes > 0);
      assert.equal(evidence.registeredInputBytes, mode === 'resident-eof' ? 0 : 6);
      assert.deepEqual([evidence.sourceLoads, evidence.sourceBytes, evidence.reads, evidence.writes, evidence.written], [0, 0, 0, 0, 0]);
      assert.equal(evidence.workers, 2);assert.equal(evidence.observerBeforeStdioImport, true);
      const retired = {created: true, exited: true, resourcesRetired: true, pendingRequest: false};
      assert.deepEqual(evidence.rejected, {error: 'Unsupported Rust Worker command: 3 (value 40, syscall 40)', ...retired});
      assert.deepEqual(evidence.control, {status: 42, sourceFailures: 0, ...retired});
      t.diagnostic(JSON.stringify(evidence));
    } finally {rmSync(directory, {recursive: true, force: true});}
  });
}
