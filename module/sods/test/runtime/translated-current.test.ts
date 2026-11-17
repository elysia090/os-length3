import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {loadTranslator} from '../../runtime/translate.ts';
import {memoryHost} from '../../runtime/linux/memory-host.ts';

// Explicit current-build input only. Never substitute the frozen historical ABI
// fixture. CI supplies both artifacts; an explicitly missing input is a failure.
const translatorPath = process.env.SODS_CURRENT_TRANSLATOR_WASM;
test('current-source translator ELF runs through Rust read/exit authority', {
  skip: translatorPath === undefined,
}, async () => {
  assert.ok(translatorPath, 'SODS_CURRENT_TRANSLATOR_WASM must name an artifact');
  const linuxPath = process.env.SODS_LINUX_WASM;
  assert.ok(linuxPath, 'SODS_LINUX_WASM is required for current-source integration');
  const translatorBytes = readFileSync(translatorPath);
  const linux = new WebAssembly.Module(readFileSync(linuxPath));
  const directory = mkdtempSync(join(tmpdir(), 'sods-current-read-'));
  try {
    const source = fileURLToPath(new URL('../fixtures/managed-read-exit/program.S', import.meta.url));
    const elfPath = join(directory, 'read-exit.elf');
    // Uses the compiler already installed by the existing CI toolchain step.
    // No shell interpolation, libc startup, or native execution of this guest.
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
      '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start',
      source, '-o', elfPath,
    ], {stdio: 'pipe', timeout: 30_000});
    const translator = await loadTranslator(translatorBytes);
    const bytes = translator.whole(new Uint8Array(readFileSync(elfPath)));
    const module = new WebAssembly.Module(bytes);
    const sections = WebAssembly.Module.customSections(module, 'sods.facts');
    assert.equal(sections.length, 1);
    // Same loader facts as Image, without creating a legacy Kernel or its state.
    const facts: {entry: number; imageEnd: number} = JSON.parse(new TextDecoder().decode(sections[0]));
    assert.ok(Number.isSafeInteger(facts.entry) && facts.entry >= 0);
    assert.ok(Number.isSafeInteger(facts.imageEnd) && facts.imageEnd > facts.entry);
    const pages = Math.ceil(facts.imageEnd / 65536);
    assert.ok(pages > 0 && pages <= 65536);
    for (const scenario of ['resident', 'lazy', 'source-failure'] as const) {
      const host = memoryHost(linux, 2, 8);
      const root = host.prepareFiles({inodes: 8, entries: 8, fileBytes: 32, tables: 1, descriptions: 8, slots: 8, reads: 8});
      const name = new TextEncoder().encode('data');
      const file = scenario === 'resident'
        ? host.file(root, name, new TextEncoder().encode('abcd'))
        : host.lazyFile(root, name, 1, 0);
      host.sealFiles(8);
      for (let fd = 0; fd < 4; fd++) assert.equal(host.open(file), fd);
      const execution = host.translatedExecution(bytes, pages);
      let loads = 0;
      const outcome = await host.runTranslated(execution, BigInt(facts.entry), async source => {
        assert.equal(source, 1); loads++;
        if (scenario === 'source-failure') throw new Error('source unavailable');
        return new TextEncoder().encode('abcd');
      });
      const failed = scenario === 'source-failure';
      assert.deepEqual(outcome, {status: failed ? 1 : 0, sourceFailures: failed ? 1 : 0}, scenario);
      assert.equal(host.offset(3), failed ? 0n : 4n, scenario);
      assert.equal(loads, scenario === 'resident' ? 0 : 1, scenario);
    }
    // This is fixed-memory, preopened-FD integration, not full Node/ELF loading,
    // stack setup, muk, threads, or a proof of general syscall compatibility.
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
