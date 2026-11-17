import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {canRunApart} from '../../runtime/host.ts';
import {captureExecutableSource, Kernel, preparedLinux, RemoteKernel, Vfs, mountTarget} from '../../runtime/linux.ts';
import {E, FsError, MNT} from '../../runtime/linux/fs.ts';
import {prepare} from '../../runtime/translation/share.ts';
import {loadTranslator} from '../../runtime/translation/translator.ts';

// Like the current translator regressions, CI supplies a source-built translator,
// never a historical fixture fallback. This fixture deliberately has an indirect
// call (incremental demand) and copies the complete /proc/self/exe on request.
const artifact = process.env.SODS_CURRENT_TRANSLATOR_WASM;
const assembly = `
.global _start
.section .text
_start:
  mov target(%rip), %rax
  call *%rax
  cmp $123, %r14
  jne failed
  cmpq $1, (%rsp)
  ja copy
  mov $1, %eax
  mov $1, %edi
  lea message(%rip), %rsi
  mov $13, %edx
  syscall
  jmp done
copy:
  mov $2, %eax
  lea executable(%rip), %rdi
  xor %esi, %esi
  xor %edx, %edx
  syscall
  test %rax, %rax
  js failed
  mov %rax, %r12
again:
  xor %eax, %eax
  mov %r12, %rdi
  lea buffer(%rip), %rsi
  mov $4096, %edx
  syscall
  test %rax, %rax
  js failed
  jz done
  mov %rax, %rdx
  mov $1, %eax
  mov $1, %edi
  syscall
  jmp again
done:
  mov $60, %eax
  xor %edi, %edi
  syscall
  ud2
failed:
  mov $60, %eax
  mov $1, %edi
  syscall
  ud2
cold:
  mov $123, %r14
  ret
.section .data
.balign 8
target: .quad cold
.section .rodata
message: .ascii "source-bound\n"
executable: .asciz "/proc/self/exe"
.section .bss
.balign 16
buffer: .skip 4096
`;

let built: Promise<{elf: Uint8Array; translator: Awaited<ReturnType<typeof loadTranslator>>}> | undefined;
function fixture() {
  return built ??= (async () => {
    assert.ok(artifact);
    const dir = mkdtempSync(join(tmpdir(), 'sods-source-bound-'));
    let elf: Uint8Array;
    try {
      writeFileSync(join(dir, 'program.S'), assembly);
      execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start',
        join(dir, 'program.S'), '-o', join(dir, 'program')], {timeout: 15_000, stdio: 'pipe'});
      elf = new Uint8Array(readFileSync(join(dir, 'program')));
    } finally { rmSync(dir, {recursive: true, force: true}); }
    return {elf, translator: await loadTranslator(readFileSync(artifact))};
  })();
}

function root(elf: Uint8Array, unavailable = false) {
  const vfs = new Vfs(); let reads = 0;
  const file = mountTarget(vfs).file('/bin/program', 0o755, elf.length, () => {
    reads++; if (unavailable) throw new Error('a successful whole-AOT start must not ask for source'); return elf.slice();
  }, 'verified-release/index/program');
  vfs.symlink('program', '/bin/alias');
  const source = captureExecutableSource(vfs, '/bin/program', {origin: file.origin!, size: elf.length});
  return {vfs, file, source, reads: () => reads};
}
async function stopped(k: Kernel) {
  if (k instanceof RemoteKernel) {
    k.close(); const evidence = await k.snapshotWorkerStops();
    assert.equal(evidence.unconfirmed, 0); assert.deepEqual(evidence.failures, []);
  }
}
const profiles = [{name: 'inline unshared', shared: false, inline: true}, {name: 'inline shared', shared: true, inline: true},
  {name: 'apart shared', shared: true, inline: false}];

test('source-bound whole AOT runs without source, in both memory modes and the supported Worker backend', {skip: !artifact}, async t => {
  const {elf, translator} = await fixture(), whole = translator.whole(elf);
  for (const profile of profiles) await t.test(profile.name, {skip: !profile.inline && !canRunApart()}, async () => {
    const r = root(elf, true), chunks: Uint8Array[] = [];
    const {wasm, segments} = prepare(whole, {shared: profile.shared});
    const {kernel, attached} = preparedLinux({vfs: r.vfs, inline: profile.inline, spares: 0, x87: translator.module,
      console: {write: (_, b) => chunks.push(b.slice()), read: () => new Uint8Array(0)},
      executables: [{key: 'program', source: r.source, module: new WebAssembly.Module(wasm), segments, shared: profile.shared}]});
    try {
      assert.equal(kernel instanceof RemoteKernel, !profile.inline); assert.equal(kernel.shared, profile.shared);
      assert.equal(attached.size, 1); assert.equal(r.reads(), 0);
      assert.equal(await kernel.spawn('/bin/alias', ['/bin/alias'], [], '/'), 0);
      assert.equal(Buffer.concat(chunks).toString(), 'source-bound\n'); assert.equal(r.reads(), 0);
    } finally { await stopped(kernel); }
  });
});

test('whole AOT later /proc/self/exe and ordinary reads demand the exact complete canonical ELF', {skip: !artifact}, async t => {
  const {elf, translator} = await fixture(), whole = translator.whole(elf);
  for (const profile of profiles) await t.test(profile.name, {skip: !profile.inline && !canRunApart()}, async () => {
    const r = root(elf), chunks: Uint8Array[] = [], {wasm, segments} = prepare(whole, {shared: profile.shared});
    const {kernel} = preparedLinux({vfs: r.vfs, inline: profile.inline, spares: 0, x87: translator.module,
      console: {write: (_, b) => chunks.push(b.slice()), read: () => new Uint8Array(0)},
      executables: [{key: 'program', source: r.source, module: new WebAssembly.Module(wasm), segments, shared: profile.shared}]});
    try {
      assert.equal(r.reads(), 0);
      assert.equal(await kernel.spawn('/bin/program', ['/bin/program', 'copy'], [], '/'), 0);
      assert.deepEqual(new Uint8Array(Buffer.concat(chunks)), elf); assert.equal(r.reads(), 1);
      assert.deepEqual(r.vfs.readFile('/bin/program'), elf); assert.equal(r.reads(), 1);
    } finally { await stopped(kernel); }
  });
});

test('source-bound incremental miss uses normal readLater once and attaches the newly translated code', {skip: !artifact}, async () => {
  const {elf} = await fixture(), translator = await loadTranslator(readFileSync(artifact!)), r = root(elf);
  let misses = 0; const known = new Set<Set<bigint>>();
  const translate = Object.assign((bytes: Uint8Array) => translator(bytes), {
    more(bytes: Uint8Array, seeds: (number | bigint)[], starts: Set<bigint>, base: number) {
      misses++; known.add(starts); return translator.more(bytes, seeds, starts, base);
    },
  });
  const {wasm, segments} = prepare(translator(elf));
  const {kernel, attached} = preparedLinux({vfs: r.vfs, translate, inline: true, x87: translator.module,
    console: {write() {}, read: () => new Uint8Array(0)},
    executables: [{key: 'p', source: r.source, module: new WebAssembly.Module(wasm), segments}]});
  try {
    assert.equal(r.reads(), 0); assert.equal(await kernel.spawn('/bin/program', ['/bin/program'], [], '/'), 0);
    assert.ok(misses > 0); assert.equal(r.reads(), 1); assert.ok(attached.get('p')!.extras.length > 0);
    assert.notEqual(attached.get('p')!.changed, true);
  } finally { for (const starts of known) translator.close(starts); }
});

test('attached source does not bypass executable mode or mount noexec', {skip: !artifact}, async () => {
  const {elf, translator} = await fixture(), module = new WebAssembly.Module(translator.whole(elf));
  for (const reason of ['mode', 'noexec']) {
    const r = root(elf, true);
    if (reason === 'mode') r.file.mode &= ~0o111;
    else r.vfs.mount.flags |= MNT.NOEXEC;
    const {kernel, attached} = preparedLinux({vfs: r.vfs, inline: true, console: {write() {}, read: () => new Uint8Array(0)},
      executables: [{key: 'p', source: r.source, module}]});
    assert.equal(attached.size, 1);
    assert.throws(() => kernel.start('/bin/program', ['/bin/program'], [], '/'),
      (e: unknown) => e instanceof FsError && e.errno === E.ACCES, reason);
    assert.equal(r.reads(), 0);
  }
});
