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

// Source-built translator supplied by CI, never a historical fixture fallback.
// Existing Kernel/Image.more/Task.attach exercise real incremental integration;
// this does not claim the new Rust-managed runner supports incremental code yet.
const artifact = process.env.SODS_CURRENT_TRANSLATOR_WASM;
for (const [caseIndex, scenario] of ['preserved', 'callee output', 'partial CF', 'incoming CF',
  'AF preserved', 'AF callee output', 'AF INC preserves CF', 'AF ADC input', 'AF POPFQ preserved', 'AF recursive depth unwind',
  'pure redirected caller entry', 'pure redirected external entry', 'nested pure redirected return',
  'read-only callee', 'normal and pure callees mixed'].entries()) {
  for (const indirect of [false, true]) {
    test(`current call flags: ${scenario}, ${indirect ? 'indirect' : 'direct'}, whole and incremental`, {
      skip: artifact === undefined, timeout: 30_000,
    }, async t => {
      assert.ok(artifact, 'SODS_CURRENT_TRANSLATOR_WASM must name an artifact');
      const translatorBytes = readFileSync(artifact);
      const directory = mkdtempSync(join(tmpdir(), 'sods-call-flags-'));
      try {
        const source = fileURLToPath(new URL('../fixtures/call-flags/program.S', import.meta.url));
        const output = join(directory, 'program.elf');
        execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
          '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start',
          `-DCASE=${caseIndex}`, ...(indirect ? ['-DINDIRECT'] : []), source, '-o', output,
        ], {stdio: 'pipe', timeout: 15_000});
        const elf = readFileSync(output);
        for (const mode of ['whole', 'incremental'] as const) await t.test(mode, async () => {
          const translator = await loadTranslator(translatorBytes);
          const knownHandles = new Set<Set<bigint>>();
          let additions = 0, preemptions = 0;
          const originalMore = translator.more;
          translator.more = (bytes, seeds, known, base) => {
            additions++; knownHandles.add(known);
            return originalMore(bytes, seeds, known, base);
          };
          try {
            const vfs = new Vfs();
            const file = vfs.writeFile('/program', elf, 0o755);
            const kernel = new Kernel({vfs, translate: translator,
              console: {write() { assert.fail('unexpected guest output'); }, read: () => new Uint8Array(0),
                flush() { preemptions++; }}});
            if (mode === 'whole') kernel.prebuilt(file, new WebAssembly.Module(translator.whole(elf)));
            kernel.start('/program', ['/program'], [], '/');
            const result = kernel.pump();
            // This callback is emitted by Kernel's Preempted handling. The 450
            // calls exceed depth 400 but not its initial 65536-call budget.
            if (caseIndex === 9) assert.ok(preemptions > 0, 'recursive case must cross a real unwind');
            if (mode === 'whole') assert.equal(additions, 0, 'whole must contain all fixture entries');
            else if (caseIndex < 10 || !indirect) {
              // Initial translation also leaves these redirected continuations cold.
              const coldReturn = caseIndex === 10 || caseIndex === 12 || caseIndex === 14;
              assert.equal(additions, indirect || coldReturn ? 1 : 0,
                'incremental must actually translate the cold entry');
            } else {
              assert.ok(additions >= 1, 'cold indirect entry must require real incremental translation');
            }
            assert.equal(result.status, 0, `${scenario}/${mode}: guest flag check failed`);
          } finally {
            for (const known of knownHandles) translator.close(known);
          }
        });
      } finally { rmSync(directory, {recursive: true, force: true}); }
    });
  }
}
