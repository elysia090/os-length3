import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {MappedCodeChanged, MappedCodeSpace, type ExecutableMapping} from '../../runtime/linux/exec/mapped-code-space.ts';
import {MappedDispatcher} from '../../runtime/linux/exec/mapped-dispatcher.ts';
import {planDynamicExec} from '../../runtime/linux/exec/dynamic-plan.ts';
import {E, FsError, MNT, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {captureExecutableSource} from '../../runtime/linux.ts';
import {loadTranslator} from '../../runtime/translate.ts';
import type {ElfLoadSpec} from '../../runtime/translation/dynamic-load.ts';
import type {MappedText, MappedTranslate} from '../../runtime/translation/mapped.ts';

const wasm = process.env.SODS_TEST_MAPPED_WASM;
const skip = !wasm ? 'requires a translator built with mapped-code' : false;
const officialRoot = process.env.SODS_TEST_DYNAMIC_ROOT;
const baseLib = '/usr/lib/x86_64-linux-gnu';
const exec = '/usr/bin/ricebox-pie-fixture', loader = baseLib + '/ld-linux-x86-64.so.2';
const mappedDescription = (spec: ElfLoadSpec, bias: number): MappedText => {
  const text = spec.loads.find(s => s.flags === 5);
  assert.ok(text);
  return {role: spec.role, address: bias + text.vaddr, bias, offset: text.offset, length: text.fileSize};
};

function install(vfs: Vfs, path: string, bytes: Uint8Array, mode = 0o755) {
  const origin = createHash('sha256').update(bytes).digest('hex');
  const file = mountTarget(vfs).file(path, mode, bytes.length, () => bytes, origin);
  return {file, source: captureExecutableSource(vfs, path, {origin, size: bytes.length})};
}

function layout(vfs: Vfs, memory: WebAssembly.Memory, path: string, bytes: Uint8Array, text: MappedText): ExecutableMapping {
  const input = install(vfs, path, bytes);
  new Uint8Array(memory.buffer).set(bytes.subarray(text.offset, text.offset + text.length), text.address);
  return {...input, mount: vfs.mount, text, prot: 5, private: true};
}

function ordinaryImports(syscall: (...args: bigint[]) => bigint): WebAssembly.ModuleImports {
  // Only syscall and permission-refusal paths are reached by the explicit
  // backend fixture. This is not a replacement for Linux or a loader.
  return {syscall, trap: (pc: bigint) => { throw new UnmappedPc(pc); },
    div128() { assert.fail('unused div128'); }, fpu() { assert.fail('unused fpu'); },
    clock: () => 0n, time: () => NaN, trace() {}};
}

class Completed {
  declare readonly value: bigint;
  constructor(value: bigint) { this.value = value; }
}

class UnmappedPc extends Error {
  declare readonly pc: bigint;
  constructor(pc: bigint) { super('No executable mapping for PC'); this.pc = pc; }
}

const hasErrno = (n: number) => (e: unknown): boolean => e instanceof FsError && e.errno === n;

test('two compiled objects share registers, with private table entries scoped to the live mapping generation', {skip, timeout: 20_000}, async () => {
  const translate = await loadTranslator(readFileSync(wasm!)), compiler = translate.mapped, describe = translate.describeDynamic;
  assert.ok(compiler && describe);
  const scratch = mkdtempSync(join(tmpdir(), 'sods-mapped-'));
  try {
    const vfs = new Vfs(), memory = new WebAssembly.Memory({initial: 8, maximum: 65536}), space = new MappedCodeSpace(vfs, memory);
    assert.throws(() => new MappedCodeSpace(vfs, new WebAssembly.Memory({initial: 1, maximum: 2, shared: true})), /inline/);
    const object = (name: 'bridge' | 'result', amount: number) => {
      const src = fileURLToPath(new URL(`../fixtures/mapped-code/${name}.S`, import.meta.url)), dst = join(scratch, name + amount);
      execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-nostdlib', '-shared', '-fPIC', '-s',
        `-DAMOUNT=${amount}`, `-Wl,-e,${name},--build-id=none`, src, '-o', dst], {timeout: 6_000});
      return new Uint8Array(readFileSync(dst));
    };
    const a = object('bridge', 0), b = object('result', 20), newer = object('result', 22);
    const binding = (path: string, bytes: Uint8Array, bias: number) => layout(vfs, memory, path, bytes, mappedDescription(describe(bytes, 'library'), bias));
    const aText = binding('/bridge.so', a, 0x10000), bText = binding('/result.so', b, 0x20000);
    const entry = (bytes: Uint8Array, bias: number): bigint => BigInt(bias) + new DataView(bytes.buffer).getBigUint64(24, true);
    const pc = entry(a, aText.text.bias), target = entry(b, bText.text.bias);
    // Registration needs the inode that supplied the bytes and an RX,
    // private mapping. None of these refusals enter the compiler.
    assert.throws(() => space.bind({...aText, source: bText.source}), hasErrno(E.ACCES));
    assert.throws(() => space.bind({...aText, prot: 7}), hasErrno(E.ACCES));
    assert.throws(() => space.bind({...aText, private: false}), hasErrno(E.ACCES));
    space.bind(aText); space.bind(bText);
    assert.throws(() => space.bind(bText), hasErrno(E.INVAL));
    const known = new Set<bigint>();
    assert.throws(() => compiler.more(a, {...aText.text, offset: aText.text.offset + 1}, pc, known, 0), translate.notProgram);

    let compileCalls = 0, retired = 0, exits = 0;
    let mode: 'normal' | 'invalidate' | 'noexec' = 'normal';
    const tracked: MappedTranslate = {...compiler, close(key) { retired++; compiler.close(key); },
      more(...args) { compileCalls++; return compiler.more(...args); }};
    const first = space.find(pc, space.generation);
    assert.ok(first);
    assert.throws(() => first.compile(space.generation, tracked, target, known, 0), MappedCodeChanged);
    assert.equal(compileCalls, 0, 'a different file cannot supply code for the requested PC');
    const dispatcher = new MappedDispatcher(space, tracked, ordinaryImports((nr, value) => {
      if (nr === 39n) {
        if (mode === 'invalidate') space.invalidate(aText.text.address, 1);
        if (mode === 'noexec') vfs.mount.flags |= MNT.NOEXEC;
        return 19n;
      }
      assert.equal(nr, 60n);
      exits++;
      throw new Completed(value);
    }));
    const completed = (value: bigint) => (e: unknown) => e instanceof Completed && e.value === value;
    const enter = () => { dispatcher.setReg('r7', target); dispatcher.run(pc); };
    try {
      assert.throws(enter, completed(42n));
      assert.throws(enter, completed(42n));
      assert.equal(compileCalls, 2, 'same-generation calls reuse both compiled objects');
      const older = space.generation, oldText = space.find(target, older);
      assert.ok(oldText);
      space.invalidate(bText.text.address, 1);
      assert.throws(() => space.find(target, older), MappedCodeChanged);
      assert.throws(() => oldText.compile(space.generation, tracked, target, known, 0), MappedCodeChanged);
      assert.equal(compileCalls, 2, 'an old file cannot be recompiled through a retained mapping record');
      assert.throws(enter, e => e instanceof UnmappedPc && e.pc === target);
      assert.equal(exits, 2);
      assert.equal(compileCalls, 3, 'the missing file contributes no code; the surviving one is compiled in the new generation');

      const replaced = binding('/replacement.so', newer, bText.text.bias);
      space.bind(replaced);
      assert.throws(enter, completed(44n));
      assert.ok(retired >= 3, 'old code handles are retired before new dispatch');

      mode = 'invalidate';
      assert.throws(enter, e => e instanceof UnmappedPc && e.pc > pc && e.pc < pc + BigInt(aText.text.length));
      assert.equal(exits, 3, 'the old Wasm frame may not continue after a host mapping update');
      assert.throws(enter, e => e instanceof UnmappedPc && e.pc === pc);

      space.bind(aText);
      mode = 'noexec';
      assert.throws(enter, e => e instanceof UnmappedPc && e.pc > pc && e.pc < pc + BigInt(aText.text.length));
      vfs.mount.flags &= ~MNT.NOEXEC;
      assert.throws(enter, e => e instanceof UnmappedPc && e.pc === pc, 'resetting a mount flag does not revive an old generation');
      assert.equal(exits, 3);

      space.bind(aText);
      const revision = space.generation;
      assert.ok(space.find(pc, revision));
      aText.file.write(0, a.subarray(0, 1));
      assert.throws(() => space.find(pc, revision), MappedCodeChanged);
      assert.throws(() => space.bind(aText), hasErrno(E.ACCES), 'the old inode capability is not reissued after a write');

      space.bind(replaced);
      const installing = space.generation, failure = new Error('VM installation failed');
      assert.throws(() => space.replace(replaced.text.address, replaced.text.length, replaced, () => {
        assert.throws(() => space.find(target, installing), MappedCodeChanged);
        assert.equal(space.find(target, space.generation), undefined, 'revoke before the first write');
        throw failure;
      }), error => error === failure);
      assert.equal(space.find(target, space.generation), undefined, 'a failed installation publishes no replacement code');
    } finally { dispatcher.close(); }
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});

test('the signed Debian PIE/interpreter plan and actual DSO produce biased, file-bounded code, not an app run', {
  skip: !officialRoot || !wasm ? 'requires the staged official fixture and mapped-code translator' : false,
}, async () => {
  const translate = await loadTranslator(readFileSync(wasm!)), compiler = translate.mapped, describe = translate.describeDynamic;
  assert.ok(compiler && describe);
  const bytes = (path: string) => new Uint8Array(readFileSync(join(officialRoot!, path)));
  const ap = bytes(exec), ld = bytes(loader);
  const dsoPath = baseLib + '/libricebox-pie-fixture.so.1', lib = bytes(dsoPath);
  assert.equal(createHash('sha256').update(ld).digest('hex'), '8642358c60bdf4579911381070c69cc7b1a447809b73d483ce799c4421609d21');
  const vfs = new Vfs(), main = install(vfs, exec, ap), interpreter = install(vfs, loader, ld), library = install(vfs, dsoPath, lib, 0o644);
  vfs.symlink('usr/lib64', '/lib64');
  vfs.symlink('../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/usr/lib64/ld-linux-x86-64.so.2');
  const k = new Kernel({vfs, translate, console: {read: () => null, write() {}}}), p = new Process(k, null);
  p.noNewPrivs = true;
  try {
    const plan = planDynamicExec(p, exec, {main: main.source, interpreter: interpreter.source}, translate);
    const memory = new WebAssembly.Memory({initial: 128, maximum: 65536}), space = new MappedCodeSpace(vfs, memory);
    const dsoBias = Math.ceil(plan.interpreter.end / 65536) * 65536;
    const candidates = [
      {bytes: ap, source: main, specification: plan.main.spec, bias: plan.main.bias, pc: plan.aux.entry},
      {bytes: ld, source: interpreter, specification: plan.interpreter.spec, bias: plan.interpreter.bias, pc: plan.firstPc},
      {bytes: lib, source: library, specification: describe(lib, 'library'), bias: dsoBias},
    ];
    for (const input of candidates) {
      const text = mappedDescription(input.specification, input.bias);
      new Uint8Array(memory.buffer).set(input.bytes.subarray(text.offset, text.offset + text.length), text.address);
      space.bind({...input.source, mount: k.root.mnt, text, prot: 5, private: true});
    }
    for (const input of candidates) {
      const text = mappedDescription(input.specification, input.bias), pc = BigInt(input.pc ?? text.address);
      const bound = space.find(pc, space.generation);
      assert.ok(bound);
      const known = new Set<bigint>();
      try {
        const module = new WebAssembly.Module(bound.compile(space.generation, compiler, pc, known, 0));
        const [section] = WebAssembly.Module.customSections(module, 'sods.entries');
        const rows = new BigUint64Array(section);
        assert.ok(rows.length);
        let found = false;
        for (let i = 0; i < rows.length; i += 2) {
          assert.ok(rows[i] >= BigInt(text.address) && rows[i] < BigInt(text.address + text.length), 'every function remains in its file extent');
          found ||= rows[i] === pc;
        }
        assert.ok(found, 'translation at the actual biased entry');
      } finally { compiler.close(known); }
    }
    assert.equal(k.images.size, 0);
    assert.equal(k.procs.size, 0);
    assert.equal(p.memory, null);
    assert.throws(() => k.start(exec, [exec, 'check'], []), hasErrno(E.NOEXEC), 'ordinary exec is still static-only');
  } finally { p.fs0.drop(); p.cgroup.procs.delete(p); k.halt(); }
});
