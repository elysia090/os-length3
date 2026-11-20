import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Kernel} from '../../runtime/linux.ts';
import {loadTranslator} from '../../runtime/translate.ts';

const translatorPath = process.env.SODS_CURRENT_TRANSLATOR_WASM;
const skip = !translatorPath ? 'requires the current Sods translator artifact'
  : process.platform !== 'linux' || process.arch !== 'x64' ? 'compares with native Linux x86-64' : false;

// At native and Sods startup, find the *actual* auxiliary vector after envp.
// AT_BASE = 0 is a present record; that is different from an absent key.
const program = `
.global _start
.section .text
_start:
  mov (%rsp), %rcx
  lea 16(%rsp,%rcx,8), %rax
envp:
  add $8, %rax
  cmpq $0, -8(%rax)
  jne envp
  xor %edi, %edi
aux:
  mov (%rax), %rcx
  test %rcx, %rcx
  jz done
  cmp $7, %rcx
  jne next
  cmpq $0, 8(%rax)
  jne bad
  inc %edi
next:
  add $16, %rax
  jmp aux
done:
  cmp $1, %edi
  jne bad
  xor %edi, %edi
  jmp exit
bad:
  mov $62, %edi
exit:
  mov $60, %eax
  syscall
.section .note.GNU-stack,"",@progbits
`;

test('a static executable sees one zero-valued AT_BASE entry as on Linux', {skip, timeout: 15_000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sods-static-auxv-'));
  try {
    const src = join(dir, 'aux.S'), bin = join(dir, 'aux');
    writeFileSync(src, program);
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none',
      '-Wl,-e,_start', src, '-o', bin], {timeout: 8_000});
    const native = spawnSync(bin, ['plain'], {env: {LC_ALL: 'C', CHECK: '1'}, timeout: 4_000});
    assert.equal(native.error, undefined);
    assert.equal(native.status, 0);
    const translate = await loadTranslator(readFileSync(translatorPath!));
    const k = new Kernel({translate, console: {read: () => null, write: () => assert.fail('the guest only checks auxv')}});
    try {
      k.vfs.writeFile('/aux', new Uint8Array(readFileSync(bin)), 0o755);
      assert.equal(await k.spawn('/aux', ['/aux', 'plain'], ['LC_ALL=C', 'CHECK=1'], '/'), 0);
    } finally { k.halt(); }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
