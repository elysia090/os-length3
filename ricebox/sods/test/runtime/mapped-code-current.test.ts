import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {buildMappedCode} from '../../../distribution/build/mapped-code.ts';
import {loadMappedCode} from '../../../distribution/runtime/mapped-code.ts';
import {MappedCodeChanged, MappedCodeSpace, type ExecutableMapping} from '../../runtime/linux/exec/mapped-code-space.ts';
import {mappedPieceMetadata} from '../../runtime/linux/exec/mapped-code-table.ts';
import {MappedDispatcher} from '../../runtime/linux/exec/mapped-dispatcher.ts';
import {MAPPED_ENTRY_BYTES, MappedEntries} from '../../runtime/linux/exec/mapped-entries.ts';
import {planDynamicExec} from '../../runtime/linux/exec/dynamic-plan.ts';
import {preparedMappedCodeFor} from '../../runtime/linux/exec/prepared-mapped-code.ts';
import {E, FsError, MNT, Mount, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
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

test('source and mount mutations retire only the executable bindings that depend on them', () => {
  const vfs = new Vfs(), memory = new WebAssembly.Memory({initial: 1}), space = new MappedCodeSpace(vfs, memory);
  const bytes = Uint8Array.of(1, 2, 3, 4), first = 0x1000, alias = 0x2000, other = 0x3000;
  const source = install(vfs, '/object', bytes), neighbor = install(vfs, '/neighbor', bytes);
  const mount = new Mount(vfs.mount.sb);
  const {file} = source;
  const bind = (at: number, object: typeof source, mnt: Mount) => {
    new Uint8Array(memory.buffer).set(bytes, at);
    space.bind({...object, mount: mnt, prot: 5, private: true,
      text: {role: 'library', bias: at, address: at, offset: 0, length: bytes.length}});
  };
  const text = (pc: number) => space.find(BigInt(pc), space.generation);
  const clear = () => space.invalidate(0, memory.buffer.byteLength);
  const initialMode = file.mode;
  const writeback = {proc: {bytes}, start: 0, length: bytes.length, off: 0};
  const mutations = [
    () => { file.mode |= 0o4000; file.mode = initialMode; },
    () => { file.version++; file.version--; },
    () => { const origin = file.origin; file.origin = 'changed'; file.origin = origin; },
    () => { file.size++; file.size--; },
    () => { file.map(writeback); file.abandon(writeback); },
  ];
  for (const change of mutations) {
    bind(first, source, mount); bind(alias, source, vfs.mount); bind(other, neighbor, vfs.mount);
    const saved = space.generation, survive = text(other);
    change();
    assert.throws(() => space.find(BigInt(first), saved), MappedCodeChanged);
    assert.equal(text(first), undefined);
    assert.equal(text(alias), undefined);
    assert.equal(text(other), survive);
    clear();
  }
  for (const change of [
    () => { mount.flags |= MNT.NOEXEC; mount.flags &= ~MNT.NOEXEC; },
    () => { mount.parent = vfs.mount; mount.parent = null; },
    () => { mount.point = file; mount.point = null; },
    () => { mount.space = {}; mount.space = null; },
  ]) {
    bind(first, source, mount); bind(alias, source, vfs.mount); bind(other, neighbor, mount);
    const saved = space.generation, survive = text(alias);
    change();
    assert.throws(() => space.find(BigInt(first), saved), MappedCodeChanged);
    assert.equal(text(first), undefined);
    assert.equal(text(alias), survive);
    assert.equal(text(other), undefined);
    clear();
  }

  bind(first, source, mount);
  const saved = space.generation;
  const metadata = {offset: 0, length: 1, publish() {}};
  file.mapReadOnly(metadata);
  file.mode ^= 0o100;
  mount.flags |= MNT.NOSUID;
  space.invalidate(first + bytes.length, 1);
  assert.equal(space.generation, saved);
  assert.ok(text(first));
  file.unmapReadOnly(metadata);
  clear();
  const retired = space.generation;
  file.write(0, bytes);
  assert.equal(space.generation, retired, 'retired bindings have no remaining observers');
});

test('a source mutation during VM preparation leaves the old extent installed', () => {
  const vfs = new Vfs(), memory = new WebAssembly.Memory({initial: 1}), space = new MappedCodeSpace(vfs, memory);
  const at = 0x1000, data = Uint8Array.of(42);
  const old = install(vfs, '/old', data), next = install(vfs, '/next', data);
  const map = {mount: vfs.mount, prot: 5, private: true,
    text: {role: 'library' as const, bias: at, address: at, offset: 0, length: 1}};
  new Uint8Array(memory.buffer)[at] = 42;
  space.bind({...old, ...map});
  const saved = space.generation, original = space.find(BigInt(at), saved);
  let installed = false;
  assert.throws(() => space.replace(at, 1, {...next, ...map}, () => { installed = true; }, {ready() {
    next.file.mode ^= 0o4000;
    next.file.mode ^= 0o4000;
  }}), MappedCodeChanged);
  assert.equal(installed, false);
  assert.equal(space.find(BigInt(at), saved), original);
  const bytes = Uint8Array.of(13, 14, 15, 16), placed = install(vfs, '/placed', bytes);
  const text = {...map.text, address: at + 1, offset: 1, length: 2};
  space.replace(at, bytes.length, {...placed, ...map, text}, pages => {
    assert.equal(space.find(BigInt(at), space.generation), undefined);
    assert.ok(pages);
    new Uint8Array(memory.buffer, at, bytes.length).set(pages);
  });
  assert.deepEqual(new Uint8Array(memory.buffer, at, bytes.length), bytes);
  assert.equal(space.find(BigInt(at), space.generation), undefined);
  assert.deepEqual(space.find(BigInt(at + 1), space.generation)?.text, text);
  space.invalidate(at, bytes.length);
});

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

test('the mapped core resolves published PCs through collisions, growth and reindexing without a host call', {skip}, async () => {
  const translate = await loadTranslator(readFileSync(wasm!)), compiler = translate.mapped!;
  const index = new MappedEntries(), misses: bigint[] = [];
  const memory = new WebAssembly.Memory({initial: 1, maximum: 65536});
  const module = new WebAssembly.Module(compiler.core());
  assert.ok(!WebAssembly.Module.exports(module).some(e => e.name === 'entries' || e.name === 'access_pages'));
  const accessPages = new WebAssembly.Memory({initial: 1, maximum: 1});
  const core = new WebAssembly.Instance(module, {dispatcher: {entries: index.memory, access_pages: accessPages}, env: {
    ...ordinaryImports(() => assert.fail('no guest syscall')), memory,
    miss(pc: bigint) { misses.push(pc); return -1n; },
    mapped_access() { assert.fail('no guest data access'); },
  }}).exports as {resolve(pc: bigint): bigint};
  const a = 0x1000, bucket = (pc: number) => Math.imul(pc, 0x9e3779b1) >>> 20;
  const second = (pc: number) => {
    do { pc++; } while (bucket(pc) !== bucket(a));
    return pc;
  };
  const b = second(a), absent = second(b);
  const rows = new DataView(new ArrayBuffer(2 * MAPPED_ENTRY_BYTES));
  rows.setUint32(0, a, true);
  rows.setUint32(MAPPED_ENTRY_BYTES, b, true);
  rows.setUint32(MAPPED_ENTRY_BYTES + 4, 0xffff_ffff, true);
  rows.setUint32(MAPPED_ENTRY_BYTES + 8, 2, true);
  index.reserve(2);
  index.publish(rows, 0);
  const find = (pc: number) => core.resolve(BigInt(pc));
  assert.equal(find(a), 0n);
  assert.equal(find(b), 0x2_ffff_ffffn);
  index.reserve(4096);
  assert.equal(find(a), 0n);
  assert.equal(find(b), 0x2_ffff_ffffn);
  assert.deepEqual(misses, []);
  assert.equal(find(absent), -1n);
  assert.equal(core.resolve(BigInt(a) + (1n << 32n)), -1n);
  assert.equal(find(0), -1n);
  index.clear();
  index.publish(new DataView(rows.buffer, MAPPED_ENTRY_BYTES, MAPPED_ENTRY_BYTES), 3);
  assert.equal(find(a), -1n);
  assert.equal(find(b), 0x5_ffff_ffffn);
  assert.deepEqual(misses, [BigInt(absent), BigInt(a) + (1n << 32n), 0n, BigInt(a)]);
});

test('the packed access check preserves widths and unsigned endpoints through the slow path', {skip}, async () => {
  const compiler = (await loadTranslator(readFileSync(wasm!))).mapped!;
  const memory = new WebAssembly.Memory({initial: 1, maximum: 65536});
  const pages = new WebAssembly.Memory({initial: 1, maximum: 1}), entries = new MappedEntries();
  const calls: [bigint, number][] = [];
  const core = new WebAssembly.Instance(new WebAssembly.Module(compiler.core()), {
    dispatcher: {entries: entries.memory, access_pages: pages},
    env: {memory, trap: () => assert.fail(), miss: () => assert.fail(), mapped_access(address: bigint, access: number) {
      calls.push([BigInt.asUintN(64, address), access]);
      return -1;
    }},
  }).exports as {mapped_address(address: bigint, access: number): number};
  const rights = new Uint8Array(pages.buffer), lastPage = rights.length - 1;
  rights[16] = 3; rights[17] = 1; rights[lastPage] = 3;
  const write16 = (15 << 2) | 2, read16 = (15 << 2) | 3;
  assert.equal(core.mapped_address(0x10ff0n, write16), 0x10ff0);
  for (const width of [1, 2, 4, 8, 16]) {
    const at = 0x11000 - width, write = ((width - 1) << 2) | 2;
    assert.equal(core.mapped_address(BigInt(at), write), at);
  }
  assert.equal(core.mapped_address(0x10ff1n, read16), 0x10ff1);
  assert.equal(core.mapped_address(0x10ff1n, write16), -1);
  rights[17] = 3;
  assert.equal(core.mapped_address(0x10ff1n, write16), 0x10ff1);
  assert.equal(core.mapped_address(0x0fff_fff0n, write16), 0x0fff_fff0);
  assert.equal(core.mapped_address(0x0fff_fff1n, write16), -1);
  const wrapped = (1n << 64n) - 8n;
  assert.equal(core.mapped_address(wrapped, read16), -1);
  assert.deepEqual(calls, [[0x10ff1n, write16], [0x0fff_fff1n, write16], [wrapped, read16]]);
});

test('prepared mapped code passes flags across replay parts and falls back for a missing PC or artifact', {skip}, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sods-mapped-replay-'));
  try {
    const src = fileURLToPath(new URL('../fixtures/mapped-code/replay.S', import.meta.url)), dst = join(scratch, 'replay.so');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-nostdlib', '-shared', '-fPIC', '-s',
      '-Wl,-e,replay,--build-id=none', src, '-o', dst], {timeout: 6_000});
    const elf = readFileSync(dst), translator = readFileSync(wasm!);
    const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const description = await loadTranslator(translator), spec = description.describeDynamic!(elf, 'library');
    const text = mappedDescription(spec, 0x10000);
    const pc = text.bias + Number(new DataView(elf.buffer, elf.byteOffset).getBigUint64(24, true));
    assert.equal(text.address, pc);
    const path = '/replay.so', pack = 'a'.repeat(64), generation = 'b'.repeat(64);
    const at = 32, len = elf.length, origin = `${pack}_${at}_${len}`;
    const root = {about: {index: {sha256: generation, path: `index-${generation}.json`, size: 1}},
      index: {files: [{path, mode: 0o755, size: len, pack: 0, at, len, raw: true}],
        packs: [{name: `${pack}.pack`, owner: 'fixture', bytes: at + len}]}, read: () => elf};
    const artifacts = new Map<string, Uint8Array<ArrayBuffer>>();
    const trace = {path, sourceSha256: sha256(elf), text, pcs: [pc, pc + 64]};
    const manifest = await buildMappedCode(root, translator, loadTranslator, [trace], (hash, bytes) => artifacts.set(hash, bytes));
    assert.equal(manifest.pieces.length, 1);
    assert.equal(manifest.pieces[0].origin, origin);
    await assert.rejects(() => buildMappedCode(root, translator, loadTranslator, [{...trace, sourceSha256: pack}], () => assert.fail()), /source changed/);

    for (const supply of ['prepared', 'missing', 'corrupt', 'revoked'] as const) {
      const vfs = new Vfs(), memory = new WebAssembly.Memory({initial: 8, maximum: 65536});
      const file = mountTarget(vfs).file(path, 0o755, len, () => elf, origin);
      const source = captureExecutableSource(vfs, path, {origin, size: len});
      const sources = new Map([[origin, source]]);
      new Uint8Array(memory.buffer).set(elf.subarray(text.offset, text.offset + text.length), text.address);
      if (supply === 'prepared') {
        const piece = {...manifest.pieces[0], sourceSize: len + 1};
        await assert.rejects(loadMappedCode({vfs, sources, generation}, translator, {...manifest, pieces: [piece]},
          () => assert.fail('A mismatched source has no prepared reader'), sha256), /authenticated root/);
      }
      let reads = 0;
      const translatorInput = Uint8Array.from(translator);
      const loading = loadMappedCode({vfs, sources, generation}, translatorInput, manifest, hash => {
        reads++;
        if (supply === 'missing') return;
        const bytes = artifacts.get(hash)!;
        if (supply === 'revoked') vfs.mount.flags |= MNT.NOEXEC;
        if (supply !== 'corrupt') return bytes;
        const altered = bytes.slice();
        altered[altered.length - 1] ^= 1;
        return altered;
      }, sha256);
      if (supply === 'prepared') translatorInput.fill(0);
      const {translate, preparedCode} = await loading;
      assert.ok(preparedCode && translate.mapped);
      const compiler = translate.mapped, lookup = preparedMappedCodeFor(preparedCode, vfs, compiler)!;
      assert.equal(lookup(file, {...text, bias: text.bias + 1}), undefined);
      assert.throws(() => preparedMappedCodeFor(preparedCode, new Vfs(), compiler), /another Vfs/);
      const space = new MappedCodeSpace(vfs, memory, lookup);
      space.bind({file, source, text, mount: vfs.mount, prot: 5, private: true});
      const misses: bigint[] = [], more = compiler.more;
      compiler.more = (elf, text, pc, known) => {
        misses.push(pc);
        if (supply === 'prepared') assert.ok(known.has(BigInt(text.address)) && known.has(BigInt(text.address + 64)));
        return more(elf, text, pc, known);
      };
      const accessPages = new WebAssembly.Memory({initial: 1, maximum: 1}), sp = 6 * 65536;
      new Uint8Array(accessPages.buffer)[(sp - 1) >>> 12] = 3;
      const vm = {memory, accessPages, get generation() { return space.generation; }, find: space.find.bind(space),
        permits: () => true, beginRead: () => false, beginWrite: () => false, string: () => assert.fail('no string operations')};
      const dispatcher = new MappedDispatcher(vm, compiler, ordinaryImports((nr, value) => {
        if (nr === 39n) return 19n;
        assert.equal(nr, 60n);
        throw new Completed(value);
      }));
      try {
        dispatcher.setReg('r4', BigInt(sp));
        dispatcher.setReg('r7', BigInt(pc + 64));
        dispatcher.setReg('r6', BigInt(pc + 128));
        if (supply === 'corrupt') {
          assert.throws(() => dispatcher.run(BigInt(pc)), /artifact digest/);
          assert.deepEqual(misses, []);
        } else if (supply === 'revoked') {
          assert.throws(() => dispatcher.run(BigInt(pc)), MappedCodeChanged);
          assert.deepEqual(misses, []);
        } else {
          assert.throws(() => dispatcher.run(BigInt(pc)), error => error instanceof Completed && error.value === 42n);
          assert.deepEqual(misses, (supply === 'prepared' ? [pc + 128] : [pc, pc + 64, pc + 128]).map(BigInt));
        }
        assert.equal(reads, 1);
      } finally { dispatcher.close(); space.close(); }
    }
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});

test('compiled objects share registers, evict withdrawn text and reuse the surviving table entries', {skip, timeout: 20_000}, async () => {
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
    assert.throws(() => compiler.more(a, {...aText.text, offset: aText.text.offset + 1}, pc, known), translate.notProgram);

    let compileCalls = 0, retired = 0, exits = 0;
    let mode: 'normal' | 'invalidate' | 'noexec' | 'owner-lost' = 'normal';
    let ownerLive = true;
    const tracked: MappedTranslate = {...compiler, close(key) { retired++; compiler.close(key); },
      more(...args) { compileCalls++; return compiler.more(...args); }};
    const first = space.find(pc, space.generation);
    assert.ok(first);
    assert.throws(() => first.compile(space.generation, tracked, target, known, () => assert.fail()), MappedCodeChanged);
    assert.equal(compileCalls, 0, 'a different file cannot supply code for the requested PC');
    // This code-only fixture grants no data access. The VM-backed tests
    // use the actual address-space authority for stack and data operations.
    const accessPages = new WebAssembly.Memory({initial: 1, maximum: 1});
    const noData = {memory, accessPages, get generation() { return space.generation; }, find: space.find.bind(space),
      permits: (_a: bigint, length: bigint) => length === 0n && ownerLive,
      beginRead: () => false,
      beginWrite: () => false,
      string: () => assert.fail('no string VM in this code-only fixture')};
    const unused = ordinaryImports(() => assert.fail('an over-budget fragment cannot run'));
    assert.throws(() => new MappedDispatcher(noData, compiler, unused, undefined, 0), /Invalid mapped translation budget/);
    let refusedHandles = 0;
    const bounded = new MappedDispatcher(noData, {...compiler, close(key) { refusedHandles++; compiler.close(key); }}, unused, undefined, 1);
    try { assert.throws(() => bounded.run(pc), /Mapped translation budget exhausted/); }
    finally { bounded.close(); }
    assert.equal(refusedHandles, 1);
    const dispatcher = new MappedDispatcher(noData, tracked, ordinaryImports((nr, value) => {
      if (nr === 39n) {
        if (mode === 'invalidate') space.invalidate(aText.text.address, 1);
        if (mode === 'noexec') vfs.mount.flags |= MNT.NOEXEC;
        if (mode === 'owner-lost') ownerLive = false;
        return 19n;
      }
      assert.equal(nr, 60n);
      exits++;
      throw new Completed(value);
    }));
    const completed = (value: bigint) => (e: unknown) => e instanceof Completed && e.value === value;
    const enter = () => { dispatcher.setReg('r7', target); dispatcher.run(pc); };
    try {
      let inspected = 0;
      const imports = WebAssembly.Module.imports;
      WebAssembly.Module.imports = module => { inspected++; return imports(module); };
      try { assert.throws(enter, completed(42n)); }
      finally { WebAssembly.Module.imports = imports; }
      assert.equal(inspected, 1, 'both pieces share one byte-identical import shape');
      assert.throws(enter, completed(42n));
      assert.equal(compileCalls, 2, 'same-generation calls reuse both compiled objects');
      const wide = pc + (1n << 32n);
      assert.throws(() => dispatcher.run(wide), e => e instanceof UnmappedPc && e.pc === wide);
      mode = 'owner-lost';
      assert.throws(enter, MappedCodeChanged);
      assert.equal(exits, 2, 'a lost data owner cannot return to Wasm even when code is still live');
      ownerLive = true;
      mode = 'normal';
      const older = space.generation, oldText = space.find(target, older);
      assert.ok(oldText);
      space.invalidate(bText.text.address, 1);
      assert.throws(() => space.find(target, older), MappedCodeChanged);
      assert.throws(() => oldText.compile(space.generation, tracked, target, known, () => assert.fail()), MappedCodeChanged);
      assert.equal(compileCalls, 2, 'an old file cannot be recompiled through a retained mapping record');
      assert.throws(enter, e => e instanceof UnmappedPc && e.pc === target);
      assert.equal(exits, 2);
      assert.equal(compileCalls, 2, 'the surviving caller needs no retranslation');
      assert.equal(retired, 1);

      const replaced = binding('/replacement.so', newer, bText.text.bias);
      space.bind(replaced);
      assert.throws(enter, completed(44n));
      assert.equal(compileCalls, 3, 'only the new mapping needs compilation');
      assert.equal(retired, 1);

      mode = 'invalidate';
      assert.throws(enter, e => e instanceof UnmappedPc && e.pc > pc && e.pc < pc + BigInt(aText.text.length));
      assert.equal(exits, 3, 'the old Wasm frame may not continue after a host mapping update');
      assert.throws(enter, e => e instanceof UnmappedPc && e.pc === pc);
      dispatcher.setReg('r0', 10n);
      assert.throws(() => dispatcher.run(target), completed(32n));
      assert.equal(compileCalls, 3, 'the surviving callee still runs after its table slots move');
      assert.equal(retired, 2);

      space.bind(aText);
      mode = 'noexec';
      assert.throws(enter, e => e instanceof UnmappedPc && e.pc > pc && e.pc < pc + BigInt(aText.text.length));
      vfs.mount.flags &= ~MNT.NOEXEC;
      assert.throws(enter, e => e instanceof UnmappedPc && e.pc === pc, 'resetting a mount flag does not revive an old generation');
      assert.equal(exits, 4);

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
        const module = bound.compile(space.generation, compiler, pc, known, code => new WebAssembly.Module(code));
        const {entries} = mappedPieceMetadata(module);
        assert.ok(entries.byteLength);
        let found = false;
        for (let i = 0; i < entries.byteLength; i += MAPPED_ENTRY_BYTES) {
          const at = entries.getUint32(i, true);
          assert.ok(at >= text.address && at < text.address + text.length, 'every function remains in its file extent');
          found ||= BigInt(at) === pc;
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
