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
    for (const runner of ['inline', 'worker'] as const) for (const scenario of ['resident', 'lazy', 'source-failure'] as const) {
      const host = memoryHost(linux, 2, 8);
      const root = host.prepareFiles({inodes: 8, entries: 8, fileBytes: 32, tables: 1, descriptions: 8, slots: 8, reads: 8});
      const name = new TextEncoder().encode('data');
      const file = scenario === 'resident'
        ? host.file(root, name, new TextEncoder().encode('abcd'))
        : host.lazyFile(root, name, 1, 0);
      host.sealFiles(8);
      for (let fd = 0; fd < 4; fd++) assert.equal(host.open(file), fd);
      const execution = runner === 'worker'
        ? await host.workerExecution(bytes, pages)
        : host.translatedExecution(bytes, pages);
      let loads = 0;
      const load = async (source: number) => {
        assert.equal(source, 1); loads++;
        if (scenario === 'source-failure') throw new Error('source unavailable');
        return new TextEncoder().encode('abcd');
      };
      let outcome;
      try {
        outcome = runner === 'worker'
          ? await host.runWorker(execution, BigInt(facts.entry), load)
          : await host.runTranslated(execution, BigInt(facts.entry), load);
        if (runner === 'worker') assert.equal(host.workerEvidence(execution).exited, true);
      } finally {
        if (runner === 'worker') { host.stopWorker(execution); await host.workerSettled(execution); }
      }
      const failed = scenario === 'source-failure';
      assert.deepEqual(outcome, {status: failed ? 1 : 0, sourceFailures: failed ? 1 : 0}, `${runner}/${scenario}`);
      assert.equal(host.offset(3), failed ? 0n : 4n, `${runner}/${scenario}`);
      assert.equal(loads, scenario === 'resident' ? 0 : 1, `${runner}/${scenario}`);
    }
    // This is fixed-memory, preopened-FD integration, not full Node/ELF loading,
    // stack setup, muk, threads, or a proof of general syscall compatibility.
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('current-source guest checks the Rust initial stack through a real Node Worker', {
  skip: translatorPath === undefined,
}, async () => {
  assert.ok(translatorPath);
  assert.ok(process.env.SODS_LINUX_WASM);
  const directory = mkdtempSync(join(tmpdir(), 'sods-current-stack-'));
  try {
    const source = fileURLToPath(new URL('../fixtures/managed-startup/program.S', import.meta.url));
    const elfPath = join(directory, 'startup.elf');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
      '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', source, '-o', elfPath,
    ], {stdio: 'pipe', timeout: 30_000});
    const translator = await loadTranslator(readFileSync(translatorPath));
    const wasm = translator.whole(new Uint8Array(readFileSync(elfPath)));
    const sections = WebAssembly.Module.customSections(new WebAssembly.Module(wasm), 'sods.facts');
    assert.equal(sections.length, 1);
    const facts = JSON.parse(new TextDecoder().decode(sections[0])) as {entry: number; imageEnd: number; phdr: number; phent: number; phnum: number};
    assert.ok(Number.isSafeInteger(facts.imageEnd) && facts.imageEnd > facts.entry);
    const low = Math.ceil(facts.imageEnd / 65536) * 65536, top = low + 65536;
    const host = memoryHost(new WebAssembly.Module(readFileSync(process.env.SODS_LINUX_WASM)), 2, 8);
    host.prepareFiles({inodes: 2, entries: 2, fileBytes: 32, tables: 1, descriptions: 2, slots: 2, reads: 2});
    host.sealFiles(2);
    const encode = (s: string) => new TextEncoder().encode(s);
    const execution = await host.workerExecution(wasm, top / 65536, {low, top, facts,
      credentials: {uid: 11, euid: 12, gid: 13, egid: 14, secure: true},
      execfn: encode('/bin/startup'), argv: [encode('alias'), new Uint8Array([255, 254])],
      env: [encode('A=1'), encode('A=2')], random: new Uint8Array(16).fill(7)});
    try {
      assert.deepEqual(await host.runWorker(execution, BigInt(facts.entry)), {status: 0, sourceFailures: 0});
      assert.equal(host.workerEvidence(execution).exited, true);
    } finally { host.stopWorker(execution); await host.workerSettled(execution); }
    // Explicit aux inputs are transport evidence, not implemented exec credentials,
    // path authorization, ordinary Node startup, or a deleted legacy TS authority.
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
