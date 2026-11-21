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
// Explicit missing/malformed artifacts fail rather than falling back to frozen fixtures.
const translatorModule = artifact === undefined ? undefined : new WebAssembly.Module(readFileSync(artifact));
const cases = ['JRCXZ zero', 'JRCXZ nonzero', 'JRCXZ upper-32-only', 'JECXZ lower zero', 'JECXZ lower nonzero',
  'CMP before JRCXZ, flags live', 'TEST before JECXZ, flags live',
  'CMP before JRCXZ, flags dead', 'TEST before JECXZ, flags dead', 'operand-prefixed JRCXZ'];
for (const [caseIndex, scenario] of cases.entries()) for (const clearFlags of (caseIndex >= 5 && caseIndex <= 8 ? [false] : [false, true])) for (const mode of ['whole', 'incremental'] as const) {
  test(`current-source ${scenario}, ${mode}, flags ${clearFlags ? 'clear' : 'set'}: branch, flags and counter preservation`, {
    skip: artifact === undefined,
    timeout: 30_000,
  }, async () => {
    assert.ok(translatorModule);
    const dir = mkdtempSync(join(tmpdir(), 'sods-branch-counter-'));
    try {
      const source = fileURLToPath(new URL('../fixtures/branch-counter/program.S', import.meta.url));
      const elfPath = join(dir, 'program.elf');
      execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
        '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start',
        `-DCASE=${caseIndex}`, ...(clearFlags ? ['-DCLEAR_FLAGS'] : []), source, '-o', elfPath,
      ], {stdio: 'pipe', timeout: 15_000});
      const elf = readFileSync(elfPath);
      const translator = await loadTranslator(translatorModule);
      const handles = new Set<Set<bigint>>();
      let additions = 0;
      const more = translator.more;
      translator.more = (bytes, seeds, known, base) => {
        additions++; handles.add(known); return more(bytes, seeds, known, base);
      };
      try {
        const vfs = new Vfs(), file = vfs.writeFile('/program', elf, 0o755);
        const kernel = new Kernel({vfs, translate: translator,
          console: {write() { assert.fail('unexpected guest output'); }, read: () => new Uint8Array(0)}});
        if (mode === 'whole') kernel.prebuilt(file, new WebAssembly.Module(translator.whole(elf)));
        kernel.start('/program', ['/program'], [], '/');
        assert.equal(kernel.pump().status, 0, `${scenario}: wrong branch, flags or counter`);
        assert.equal(additions, 0, 'these direct branch targets must be discovered initially');
      } finally { for (const known of handles) translator.close(known); }
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}
