import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Vfs} from '../../runtime/linux/fs.ts';
import {Kernel} from '../../runtime/linux/process.ts';
import {loadTranslator} from '../../runtime/translation/translator.ts';

const artifact = process.env.SODS_CURRENT_TRANSLATOR_WASM;
// Missing/malformed explicit artifacts fail outside the known-defect TODO.
const translatorModule = artifact === undefined ? undefined : new WebAssembly.Module(readFileSync(artifact));
test('current-source JRCXZ uses RCX for both taken and fallthrough paths', {
  skip: artifact === undefined,
  todo: artifact === undefined ? false : 'Known translator defect: generic ConditionCode::None lowering takes JRCXZ with nonzero RCX; separate from call-flag acceptance',
  timeout: 30_000,
}, async () => {
  assert.ok(artifact, 'SODS_CURRENT_TRANSLATOR_WASM must name an artifact');
  // Explicit source artifact only; absence skips, a configured defect is TODO.
  assert.ok(translatorModule);
  const dir = mkdtempSync(join(tmpdir(), 'sods-branch-counter-'));
  try {
    const source = fileURLToPath(new URL('../fixtures/branch-counter/program.S', import.meta.url));
    const elfPath = join(dir, 'program.elf');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
      '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', source, '-o', elfPath,
    ], {stdio: 'pipe', timeout: 15_000});
    const elf = readFileSync(elfPath);
    const translator = await loadTranslator(translatorModule);
    const vfs = new Vfs(), file = vfs.writeFile('/program', elf, 0o755);
    const kernel = new Kernel({vfs, translate: translator,
      console: {write() { assert.fail('unexpected guest output'); }, read: () => new Uint8Array(0)}});
    kernel.prebuilt(file, new WebAssembly.Module(translator.whole(elf)));
    kernel.start('/program', ['/program'], [], '/');
    assert.equal(kernel.pump().status, 0, 'JRCXZ must fall through for RCX=1, then branch for RCX=0');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
