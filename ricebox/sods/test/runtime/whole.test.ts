import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Vfs} from '../../runtime/linux/fs.ts';
import {Kernel, PROFILE} from '../../runtime/linux/process.ts';
import {loadTranslator} from '../../runtime/translation/translator.ts';
import {nativeTranslator, translatorWasm} from '../fixtures/runtime.ts';

// A program translated whole ahead of time (sods --whole) runs without translating anything more, though it keeps no
// symbols and no relocations (as a distribution ships it, BusyBox among them): the cases its switches jump to through
// tables and the functions it passes by address are found from its code. Built both ways a compiler makes such
// tables: position-independent (static-pie, entries relative to the table) and not (entries the addresses).

const switches = fileURLToPath(new URL('../programs/switches.c', import.meta.url));
const cc = spawnSync('musl-gcc', ['--version']).status === 0;
const ready = cc && existsSync(nativeTranslator) && existsSync(translatorWasm);

for (const [name, flags] of [['pie', ['-static-pie', '-fPIE']], ['absolute', ['-static', '-fno-pie', '-no-pie']]]) {
  test(`whole: a stripped ${name} program's switches and callbacks are translated ahead of time`, {skip: !ready && 'needs musl-gcc and the built Sods translators'}, async t => {
    const out = mkdtempSync(join(tmpdir(), 'sods-whole-'));
    t.after(() => rmSync(out, {recursive: true, force: true}));
    const elf = join(out, `switches-${name}`);
    execFileSync('musl-gcc', [...flags, '-O2', '-s', switches, '-o', elf]);
    execFileSync(nativeTranslator, ['--whole', elf, `${elf}.wasm`], {stdio: 'ignore'});
    const native = execFileSync(elf, ['a'], {encoding: 'utf8'});
    const vfs = new Vfs();
    vfs.writeFile('/bin/switches', readFileSync(elf), 0o755);
    let said = '';
    const kernel = new Kernel({vfs, translate: await loadTranslator(readFileSync(translatorWasm)),
      console: {interactive: false, write: (_, b) => { said += new TextDecoder().decode(b); }, read: () => null, ready: () => false}});
    kernel.prebuilt(vfs.file('/bin/switches'), new WebAssembly.Module(readFileSync(`${elf}.wasm`)));
    const before = PROFILE.modules;
    kernel.start('/bin/switches', [elf, 'a'], [], '/');
    const r = kernel.pump();
    assert.equal(r.status, 0);
    assert.equal(said, native);
    assert.equal(PROFILE.modules - before, 0, 'nothing was translated as it ran');
  });
}

test('whole resolves predecessor table bases and guards of copied or loaded indices', {skip: !ready}, t => {
  const out = mkdtempSync(join(tmpdir(), 'sods-switch-base-'));
  t.after(() => rmSync(out, {recursive: true, force: true}));
  const asm = join(out, 'switch.S'), elf = join(out, 'switch');
  writeFileSync(asm, `
    .globl _start
    .text
    reject:
      mov $43, %edi
      mov $60, %eax
      syscall
      ud2
    _start:
      xor %eax, %eax
      test %eax, %eax
      jz choose
      lea other(%rip), %r15
      mov $43, %edi
      jmp finish
    choose:
      lea table(%rip), %r15
      mov $7, %edx
      jmp dispatch
    dispatch:
      and $3, %edx
      movslq (%r15,%rdx,4), %rdx
      add %r15, %rdx
      jmp *%rdx
    target:
      mov $3, %r8d
      cmp $3, %r8w
      ja reject
      movzwl %r8w, %eax
      lea next_table(%rip), %rcx
      movslq (%rcx,%rax,4), %rax
      add %rcx, %rax
      jmp *%rax
    done:
      sub $8, %rsp
      movl $3, (%rsp)
      cmpl $3, (%rsp)
      ja reject
      mov (%rsp), %eax
      lea last_table(%rip), %rcx
      movslq (%rcx,%rax,4), %rax
      add %rcx, %rax
      jmp *%rax
    success:
      xor %edi, %edi
    finish:
      mov $60, %eax
      syscall
      ud2
    .section .rodata
    table:
      .long finish-table, finish-table, finish-table, target-table
    next_table:
      .long reject-next_table, reject-next_table, reject-next_table, done-next_table
    last_table:
      .long reject-last_table, reject-last_table, reject-last_table, success-last_table
    other:
      .long 0
  `);
  execFileSync('musl-gcc', ['-static-pie', '-nostdlib', '-s', asm, '-o', elf]);
  execFileSync(nativeTranslator, ['--whole', elf, `${elf}.wasm`], {stdio: 'ignore'});
  const vfs = new Vfs();
  vfs.writeFile('/bin/switch', new Uint8Array(0), 0o755);
  const kernel = new Kernel({vfs, x87: new WebAssembly.Module(readFileSync(translatorWasm)), console: {write() {}, read: () => null}});
  kernel.prebuilt(vfs.file('/bin/switch'), new WebAssembly.Module(readFileSync(`${elf}.wasm`)));
  kernel.start('/bin/switch', ['switch'], [], '/');
  assert.equal(kernel.pump().status, 0);
});
