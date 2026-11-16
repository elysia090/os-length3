import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {E, FsError} from '../../runtime/linux/fs.ts';
import {Kernel} from '../../runtime/linux/process.ts';
import {NotAProgram, loadTranslator} from '../../runtime/translation/translator.ts';
import {have, shell} from './busybox.ts';

// A file that is run and is no program the translator takes: the exec's own failure (ENOEXEC, as Linux says of a
// file it cannot run), not the host's error, and the shell that ran it goes on. The numbers in the names are the
// issues'.

const translator = new URL('../../target/wasm32-unknown-unknown/release/sods.wasm', import.meta.url);
const built = existsSync(translator);
const quiet = {write() {}, read: () => null};

/** An ELF header of 64 bytes: little-endian ELF64, x86-64, an executable with nothing more in it; `change` makes it something else. */
function header(change: (h: Uint8Array, v: DataView) => void = () => {}): Uint8Array {
  const h = new Uint8Array(64), v = new DataView(h.buffer);
  h.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  v.setUint16(16, 2, true);  // ET_EXEC
  v.setUint16(18, 62, true); // EM_X86_64
  v.setUint32(20, 1, true);
  v.setUint16(52, 64, true); // e_ehsize
  v.setUint16(54, 56, true); // e_phentsize
  change(h, v);
  return h;
}
/** The errno an exec of `bytes` fails with (where the kernel makes a program of a file), or what else is thrown. */
function refused(kernel: Kernel, bytes: Uint8Array): number | unknown {
  const file = kernel.vfs.writeFile('/program', bytes, 0o755);
  try { kernel.image(file); } catch (e) { return e instanceof FsError ? e.errno : e; }
  return 0;
}

test('#143: what the translator says is no program it takes is ENOEXEC; what else it throws stays its own', () => {
  // No translator loaded, nor its error type: an unrelated implementation supplies its own rejection test.
  class RejectedInput extends Error {}
  const refusing = new Kernel({console: quiet, translate: Object.assign(() => { throw new RejectedInput('truncated at 0x12+0x2'); }, {
    notProgram: (error: unknown) => error instanceof RejectedInput,
  })});
  assert.equal(refused(refusing, header()), E.NOEXEC);
  // The translator's own fault is not the file's: it is not said to the program as ENOEXEC.
  const broken = new Kernel({console: quiet, translate: () => { throw new Error('the translator broke'); }});
  const thrown = refused(broken, header());
  assert.ok(thrown instanceof Error && !(thrown instanceof FsError) && thrown.message === 'the translator broke');
  // A file with no ELF header is refused before the translator is asked, as it was.
  assert.equal(refused(broken, new TextEncoder().encode('#\n')), E.NOEXEC);
});

test('a translator identifies its own rejected input; the kernel does not infer it from an error class or name', () => {
  for (const error of [new NotAProgram('not this translator\'s'), Object.assign(new Error('a failure'), {name: 'NotAProgram'})]) {
    for (const notProgram of [undefined, () => false]) {
      const kernel = new Kernel({console: quiet, translate: Object.assign(() => { throw error; }, {notProgram})});
      assert.equal(refused(kernel, header()), error);
    }
  }
});

test('only a failed translation asks whether its input was rejected, not a missing ELF header or invalid output', () => {
  let calls = 0, classifications = 0;
  const kernel = new Kernel({console: quiet, translate: Object.assign(() => { calls++; return new Uint8Array(); }, {
    notProgram: () => { classifications++; return true; },
  })});
  assert.equal(refused(kernel, new Uint8Array()), E.NOEXEC);
  assert.equal(calls, 0);
  assert.ok(refused(kernel, header()) instanceof WebAssembly.CompileError);
  assert.equal(calls, 1);
  assert.equal(classifications, 0, 'a translator that produced invalid wasm is broken, not rejecting the input');
});

test('the sods wrapper supplies its rejected-input test without taking a kernel error type', async () => {
  // Loading the wrapper needs memory and the optional budget/run setters. This fixture has no translation
  // functions: classification belongs to the wrapper, and does not require a built translator.
  const name = (text: string): number[] => [text.length, ...new TextEncoder().encode(text)];
  const exports = [3, ...name('memory'), 2, 0, ...name('sods_budget'), 0, 0, ...name('sods_run'), 0, 0];
  const memoryOnly = new WebAssembly.Module(Uint8Array.of(
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 96, 1, 127, 0, // one (i32) -> () type
    3, 2, 1, 0, // one function, used for both settings
    5, 3, 1, 0, 1,
    7, exports.length, ...exports,
    10, 4, 1, 2, 0, 11, // its body does nothing
  ));
  const translate = await loadTranslator(memoryOnly);
  assert.equal(translate.notProgram(new NotAProgram('an unreadable ELF')), true);
  assert.equal(translate.notProgram(new Error('the translator broke')), false);
  assert.equal(translate.notProgram(Object.assign(new Error('another error'), {name: 'NotAProgram'})), false);
  assert.equal(translate.notProgram(null), false);
  assert.equal(translate.notProgram('NotAProgram'), false);
});

test('#143: an ELF cut short, of another class or machine, not an executable, or dynamically linked is ENOEXEC', {skip: !built && 'needs the translator built (tests/programs/run.sh)'}, async () => {
  const kernel = new Kernel({console: quiet, translate: await loadTranslator(readFileSync(translator))});
  const cases: [string, Uint8Array][] = [
    ['six bytes of a header', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1])],
    ['a header cut short', header().subarray(0, 40)],
    ['a 32-bit ELF', header((h) => { h[4] = 1; })],
    ['a big-endian ELF', header((h) => { h[5] = 2; })],
    ['an ELF of another machine', header((_, v) => v.setUint16(18, 183, true))],
    ['an object file, not an executable', header((_, v) => v.setUint16(16, 1, true))],
    ['a header table past the end of the file', header((_, v) => { v.setBigUint64(32, 64n, true); v.setUint16(56, 3, true); })],
  ];
  // One linked against shared libraries (the host's own, where it has one): Linux would look for its interpreter;
  // here none is translated, and it is refused as it is read.
  for (const path of ['/bin/true', '/usr/bin/true', '/bin/ls']) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    if (bytes[4] === 2 && bytes.includes(0x2f) && bytes.subarray(0, 4096).toString('latin1').includes('/ld-')) { cases.push([`a dynamically linked program (${path})`, bytes]); break; }
  }
  for (const [what, bytes] of cases) assert.equal(refused(kernel, bytes), E.NOEXEC, what);
  // (And a header alone that is an executable's, with nothing to load, is not refused as a file: it is read.)
  assert.notEqual(refused(kernel, header()), E.NOEXEC);
});

test('#143: a shell that runs such a file is told, and goes on to its next command', {skip: !have && 'needs BusyBox staged (scripts/userland.sh)'}, async () => {
  const {kernel, out} = await shell('/bad-elf; echo "status $?"; echo survived', ['sh', 'echo']);
  kernel.vfs.writeFile('/bad-elf', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1]), 0o755);
  // (Before: the translator's error was thrown out of the kernel, and nothing after the file ran.)
  // As BusyBox's shell does on Linux with the same file: refused as a program, it is read as a script, whose first
  // word is no command (127), and the shell goes on.
  assert.deepEqual(kernel.pump(), {status: 0});
  assert.match(out(), /^\/bad-elf: line 1: .*: not found\nstatus 127\nsurvived\n$/s);
});
