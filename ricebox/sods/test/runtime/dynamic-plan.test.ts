import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {prepareDynamicImage, type DetachedDynamicImage} from '../../runtime/linux/exec/dynamic-image.ts';
import {planDynamicExec, type DynamicExecPlan} from '../../runtime/linux/exec/dynamic-plan.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {E, FsError, MNT, Mount, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {MappedVm} from '../../runtime/linux/mapped-vm.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
import {captureExecutableSource} from '../../runtime/linux.ts';
import {ImageSourceChangedError, Kernel, Process} from '../../runtime/linux/process.ts';
import {loadTranslator} from '../../runtime/translate.ts';
import type {ElfLoadSpec} from '../../runtime/translation/dynamic-load.ts';

const root = process.env.SODS_TEST_DYNAMIC_ROOT;
const translatorPath = process.env.SODS_CURRENT_TRANSLATOR_WASM;
const skip = !root || !translatorPath ? 'requires the staged dynamic fixture and current Sods translator' : false;
const mainPath = '/usr/bin/ricebox-pie-fixture', builtin = '/lib64/ld-linux-x86-64.so.2';
const lib = '/usr/lib/x86_64-linux-gnu', interpreterPath = lib + '/ld-linux-x86-64.so.2';
const libraryPath = lib + '/libricebox-pie-fixture.so.1';
const libcPath = lib + '/libc.so.6';
const quiet = {write() {}, read: () => null};
const hasErrno = (n: number) => (error: unknown) => error instanceof FsError && error.errno === n;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  assert.ok(root);
  const bytes = (file: string) => {
    const path = join(root, file);
    assert.equal(lstatSync(path).isFile(), true, 'not a regular staged fixture member');
    return new Uint8Array(readFileSync(path));
  };
  const loader = bytes(interpreterPath), libc = bytes(libcPath);
  assert.equal(sha(loader), '8642358c60bdf4579911381070c69cc7b1a447809b73d483ce799c4421609d21');
  assert.equal(sha(libc), 'cc7377e8816cefadbb4ee083f5387f67a4a883d90bc273160842a6ac075af662');
  const links = [['/lib', 'usr/lib'], ['/lib64', 'usr/lib64'], ['/usr/lib64/ld-linux-x86-64.so.2', '../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2']] as const;
  for (const [path, target] of links) assert.equal(readlinkSync(join(root, path)), target);
  return {main: bytes(mainPath), loader, libc, library: bytes(libraryPath), links};
}

test('the actual PIE and pinned guest linker produce an ordinary, source-bound two-object plan', {skip}, async () => {
  const f = fixture(), translate = await loadTranslator(readFileSync(translatorPath!));
  const describe = translate.describeDynamic;
  assert.ok(describe, 'use a translator built with the dynamic load-spec reader');
  const vfs = new Vfs(), at = mountTarget(vfs);
  let mainReads = 0, loaderReads = 0;
  const main = at.file(mainPath, 0o755, f.main.length, () => { mainReads++; return f.main; }, 'test-main');
  const loader = at.file(interpreterPath, 0o755, f.loader.length, () => { loaderReads++; return f.loader; }, 'signed-debian-loader');
  for (const [path, target] of f.links) vfs.symlink(target, path);
  const sources = {
    main: captureExecutableSource(vfs, mainPath, {origin: 'test-main', size: f.main.length}),
    interpreter: captureExecutableSource(vfs, interpreterPath, {origin: 'signed-debian-loader', size: f.loader.length}),
  };
  const k = new Kernel({vfs, translate, console: quiet});
  const p = new Process(k, null);
  try {
    assert.throws(() => planDynamicExec(p, mainPath, sources, translate), hasErrno(E.PERM));
    assert.equal(mainReads + loaderReads, 0);
    p.noNewPrivs = true;
    const plan: DynamicExecPlan = planDynamicExec(p, mainPath, sources, translate);
    assert.equal(plan.main.source.at.node, main);
    assert.equal(plan.interpreter.source.at.node, loader);
    assert.equal(plan.interpreter.path, interpreterPath);
    assert.equal(plan.main.spec.interpreter, builtin);
    const appHeader = new DataView(f.main.buffer), loaderHeader = new DataView(f.loader.buffer);
    assert.equal(plan.aux.entry - plan.main.bias, Number(appHeader.getBigUint64(24, true)));
    assert.equal(plan.aux.phnum, appHeader.getUint16(56, true));
    assert.equal(plan.firstPc - plan.aux.base, Number(loaderHeader.getBigUint64(24, true)));
    assert.ok(plan.main.end < plan.interpreter.start);
    assert.equal(plan.firstPc, plan.interpreter.bias + plan.interpreter.spec.entry);
    assert.ok(plan.interpreter.mappings.some(m => m.flags & 1 && plan.firstPc >= m.at && plan.firstPc < m.at + m.fileSize));
    assert.deepEqual(plan.aux, {base: plan.interpreter.bias, entry: plan.main.bias + plan.main.spec.entry,
      phdr: plan.main.bias + plan.main.spec.phdr, phent: 56, phnum: plan.main.spec.phnum});
    assert.ok(plan.main.mappings.some(m => plan.aux.phdr >= m.at
      && plan.aux.phdr + plan.aux.phent * plan.aux.phnum <= m.at + m.fileSize));
    assert.equal(mainReads, 1);
    assert.equal(loaderReads, 1);
    assert.equal(p.image, undefined);
    assert.equal(p.memory, null);
    assert.equal(k.procs.size, 0);
    assert.equal(k.images.size, 0, 'inspection does not publish AOT or runnable code');

    for (const dso of [f.library, f.libc]) {
      const spec: ElfLoadSpec = describe(dso, 'library');
      assert.equal(spec.entry, 0);
      assert.equal(spec.interpreter, null, "a DSO's optional PT_INTERP is not used");
    }
    assert.throws(() => describe(f.main, 'library'), translate.notProgram);
    assert.throws(() => describe(f.main, 'interpreter'), translate.notProgram);
    assert.throws(() => describe(f.loader, 'main'), translate.notProgram);
    assert.throws(() => describe(f.main.subarray(0, 96), 'main'), translate.notProgram);

    // Validation is not enabling execution. Even an authenticated fixture is
    // rejected by the unchanged public/default static exec path.
    assert.throws(() => k.start(mainPath, [mainPath, 'check'], []), hasErrno(E.NOEXEC));
    assert.equal(k.procs.size, 0);

    const loaderMode = loader.mode;
    loader.mode &= ~0o111;
    assert.throws(() => planDynamicExec(p, mainPath, sources, translate), hasErrno(E.ACCES));
    loader.mode = loaderMode;
    const canonical = vfs.dir('/usr/lib64');
    canonical.entries.delete('ld-linux-x86-64.so.2');
    assert.throws(() => planDynamicExec(p, mainPath, sources, translate), hasErrno(E.NOENT));
    vfs.symlink('../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/usr/lib64/ld-linux-x86-64.so.2');

    // A bind of the same file through a noexec mount is not made executable
    // by the exact, otherwise admissible canonical inode or by its alias.
    const loaderMount = new Mount(vfs.mount.sb, vfs.dir(lib), MNT.NOEXEC);
    k.mount(lib, loaderMount);
    assert.throws(() => planDynamicExec(p, mainPath, sources, translate), hasErrno(E.ACCES));
    loaderMount.flags &= ~MNT.NOEXEC;
    assert.equal(planDynamicExec(p, mainPath, sources, translate).interpreter.source.at.node, loader);

    loader.write(0, f.loader.subarray(0, 1));
    assert.throws(() => plan.check(), ImageSourceChangedError);
    assert.throws(() => planDynamicExec(p, mainPath, sources, translate), hasErrno(E.ACCES));
    assert.equal(p.memory, null);
  } finally { p.fs0.drop(); p.cgroup.procs.delete(p); k.halt(); }
});

test('detached VM seeds only owned nonoverlapping pages and lends no raw memory', () => {
  const vfs = new Vfs(), base = 0x20000, at = 0x10000;
  const make = {vfs, base, pages: 2, sources: [], reader: {
    describeDynamic() { assert.fail('this unit seeds plain data pages'); }, notProgram: () => false,
  }};
  const readOnly = {start: at, end: at + 4096, prot: 1, writes: [{at: at + 12, bytes: Uint8Array.of(20, 42)}]};
  assert.throws(() => MappedVm.detached(make, [readOnly, {...readOnly}], () => {}), hasErrno(E.INVAL));
  assert.throws(() => MappedVm.detached(make, [{...readOnly, prot: 7}], () => {}), hasErrno(E.INVAL));
  assert.throws(() => MappedVm.detached(make, [{...readOnly, prot: 5}], () => {}), hasErrno(E.INVAL));
  assert.throws(() => MappedVm.detached(make, [{...readOnly, writes: [{at: readOnly.end, bytes: Uint8Array.of(1)}]}], () => {}),
    hasErrno(E.INVAL));
  const pages = MappedVm.detached(make, [readOnly], () => {});
  try {
    assert.equal(Reflect.has(pages, 'memory'), false);
    assert.equal(Reflect.has(pages, 'find'), false);
    assert.equal(pages.hasText(BigInt(at)), false);
    assert.equal(pages.permits(at + 12, 2, 'write'), false);
    assert.deepEqual(pages.read(at + 11, 4), Uint8Array.of(0, 20, 42, 0));
    pages.read(at + 12, 2).fill(255);
    assert.deepEqual(pages.read(at + 12, 2), Uint8Array.of(20, 42));
    assert.throws(() => pages.read(readOnly.end, 1), hasErrno(E.FAULT), 'linear memory is not mapping authority');
  } finally { pages.discard(); pages.discard(); }
  assert.throws(() => pages.read(at, 1), /discarded/);
});

test('the authenticated PIE and real interpreter lay detached Linux PT_LOAD and an initial SysV stack', {skip}, async () => {
  const f = fixture(), translate = await loadTranslator(readFileSync(translatorPath!));
  assert.ok(translate.describeDynamic);
  const vfs = new Vfs(), target = mountTarget(vfs);
  const app = target.file(mainPath, 0o755, f.main.length, () => f.main, 'fixture-main');
  const ld = target.file(interpreterPath, 0o755, f.loader.length, () => f.loader, 'signed-loader');
  for (const [path, to] of f.links) vfs.symlink(to, path);
  const command = '/usr/bin/fixture-alias';
  vfs.symlink('ricebox-pie-fixture', command);
  const sources = {
    main: captureExecutableSource(vfs, mainPath, {origin: 'fixture-main', size: f.main.length}),
    interpreter: captureExecutableSource(vfs, interpreterPath, {origin: 'signed-loader', size: f.loader.length}),
  };
  const k = new Kernel({vfs, translate, console: quiet}), p = new Process(k, null);
  p.noNewPrivs = true;
  p.cred = p.cred.with({uid: 1001, euid: 1001, fsuid: 1001, gid: 1002, egid: 1002, fsgid: 1002,
    effective: 0n, permitted: 0n});
  p.stackLow = 4096; p.stackTop = p.mapBase = p.mapEnd = 65536;
  p.free = []; p.fixed = [];
  const old = p.memory = p.newMemory(1);
  p.bytes[8192] = 77;
  const fd = p.fds.install(new Description('file', {node: app}), {cloexec: true});
  const description = p.fds.get(fd);
  const argv = ['temporary-argv0', '日本語'], env = ['LC_ALL=C', 'FIXTURE=detached'];
  const request = {path: command, argv, env};
  const unchanged = () => {
    assert.equal(p.memory, old);
    assert.equal(p.bytes[8192], 77);
    assert.equal(p.image, undefined);
    assert.equal(p.fds.get(fd), description);
    assert.equal(p.fds.cloexec(fd), true);
    assert.deepEqual([k.procs.size, k.tasks.size, k.runq.length, k.images.size], [0, 0, 0, 0]);
  };
  let staged: DetachedDynamicImage | undefined;
  try {
    staged = prepareDynamicImage(p, request, sources, translate);
    unchanged();
    const {main, interpreter, stack, aux, pages, firstPc} = staged;
    assert.equal(main.path, mainPath);
    assert.equal(interpreter.path, interpreterPath);
    assert.ok(main.end < interpreter.start && interpreter.end < stack.stackLow && stack.stackTop < stack.mapBase);
    assert.equal(stack.sp % 16, 0);
    assert.equal(aux.base, interpreter.bias);
    const appHdr = new DataView(f.main.buffer), ldHdr = new DataView(f.loader.buffer);
    assert.equal(firstPc, interpreter.bias + Number(ldHdr.getBigUint64(24, true)));
    assert.equal(aux.entry, main.bias + Number(appHdr.getBigUint64(24, true)));
    assert.notEqual(firstPc, aux.entry, 'the first PC and application entry are independently placed');
    assert.equal(aux.phnum, appHdr.getUint16(56, true));
    const phoff = Number(appHdr.getBigUint64(32, true)), phbytes = aux.phent * aux.phnum;
    assert.deepEqual(pages.read(aux.phdr, phbytes), f.main.slice(phoff, phoff + phbytes));

    let liveBss = 0, w = 0, rx = 0;
    for (const [object, role, file] of [[main, 'main', f.main], [interpreter, 'interpreter', f.loader]] as const) {
      const spec = translate.describeDynamic(file, role);
      for (const segment of spec.loads) {
        const at = object.bias + segment.vaddr;
        if (segment.flags & 6) {
          assert.deepEqual(pages.read(at, segment.fileSize), file.slice(segment.offset, segment.offset + segment.fileSize));
          const prefix = at % 4096;
          if (prefix && segment.fileSize) assert.deepEqual(pages.read(at - prefix, prefix), file.slice(segment.offset - prefix, segment.offset));
          const bss = segment.memSize - segment.fileSize;
          if (bss) {
            liveBss += bss;
            assert.deepEqual(pages.read(at + segment.fileSize, bss), new Uint8Array(bss));
          }
        }
        assert.equal(pages.permits(at, 1, 'write'), !!(segment.flags & 2));
        if (segment.flags & 2) w++;
        if (segment.flags & 1) {
          rx++;
          assert.ok(pages.hasText(BigInt(at)));
          assert.equal(pages.hasText(BigInt(at + segment.fileSize)), false, 'padding is not executable text');
        } else {
          assert.equal(pages.hasText(BigInt(at)), false);
        }
      }
    }
    assert.ok(liveBss > 0 && w >= 2 && rx >= 2, 'both genuine objects include mapped code and data');
    assert.equal(pages.hasText(BigInt(firstPc)), true);
    assert.equal(pages.hasText(BigInt(aux.entry)), true);
    assert.equal(pages.hasText(BigInt(stack.sp)), false);
    assert.equal(pages.permits(stack.sp, 8, 'write'), true);
    for (const gap of [0x100, main.end, interpreter.end, stack.stackLow - 1, stack.stackTop]) {
      assert.equal(pages.permits(gap, 1, 'read'), false);
      assert.equal(pages.permits(gap, 1, 'write'), false);
      assert.throws(() => pages.read(gap, 1), hasErrno(E.FAULT));
    }
    let cursor = stack.sp;
    const word = () => {
      const n = new DataView(pages.read(cursor, 8).buffer).getBigUint64(0, true);
      cursor += 8;
      return Number(n);
    };
    const checkString = (ptr: number, expected: string) => {
      assert.ok(ptr >= stack.sp && ptr < stack.stackTop);
      assert.deepEqual(pages.read(ptr, new TextEncoder().encode(expected).length + 1), new TextEncoder().encode(expected + '\0'));
    };
    assert.equal(word(), argv.length);
    for (const arg of argv) checkString(word(), arg);
    assert.equal(word(), 0);
    for (const val of env) checkString(word(), val);
    assert.equal(word(), 0);
    const tags = new Map<number, number>();
    for (let i = 0; i < 14; i++) tags.set(word(), word());
    assert.deepEqual([tags.get(3), tags.get(4), tags.get(5), tags.get(6), tags.get(7), tags.get(9)],
      [aux.phdr, aux.phent, aux.phnum, 4096, aux.base, aux.entry]);
    assert.deepEqual([tags.get(11), tags.get(12), tags.get(13), tags.get(14), tags.get(23), tags.get(0)], [1001, 1001, 1002, 1002, 0, 0]);
    const entropy = tags.get(25)!;
    assert.ok(entropy >= cursor && entropy + 16 < stack.stackTop);
    assert.equal(pages.read(entropy, 16).length, 16);
    checkString(tags.get(31)!, command); // AT_EXECFN is the named path, not argv[0] or the interpreter.
    assert.deepEqual(argv, ['temporary-argv0', '日本語']);
    assert.deepEqual(env, ['LC_ALL=C', 'FIXTURE=detached']);

    assert.throws(() => prepareDynamicImage(p, {...request, argv: ['bad\0arg']}, sources, translate), hasErrno(E.INVAL));
    assert.throws(() => prepareDynamicImage(p, {...request, env: ['X=' + 'a'.repeat(32 * 4096)]}, sources, translate), hasErrno(E.TOOBIG));
    unchanged();

    // A trusted embedding revokes and restores the holding mount during
    // the final binding callback, after detached byte writes began.
    const originalShare = ld.share.bind(ld);
    let shares = 0;
    ld.share = () => {
      const bytes = originalShare();
      if (++shares === 3) {
        k.root.mnt.flags |= MNT.NOEXEC;
        k.root.mnt.flags &= ~MNT.NOEXEC;
      }
      return bytes;
    };
    try { assert.throws(() => prepareDynamicImage(p, request, sources, translate), hasErrno(E.ACCES)); }
    finally { ld.share = originalShare; }
    assert.equal(shares, 3, 'the change landed in publication, not early ELF discovery');
    unchanged();
    assert.throws(() => pages.check(), hasErrno(E.ACCES), 'a discarded mount generation cannot regain a prepared image');
    assert.throws(() => pages.read(stack.sp, 8), /discarded/);
    const staleOwner = prepareDynamicImage(p, request, sources, translate);
    try {
      p.memory = old; // Re-publishing the very same backing still changes the caller's lifetime.
      assert.throws(() => staleOwner.pages.check(), ReadLifetimeError);
      assert.throws(() => staleOwner.pages.hasText(BigInt(firstPc)), /discarded/);
    } finally { staleOwner.pages.discard(); }
    assert.throws(() => k.start(command, argv, env), hasErrno(E.NOEXEC), 'normal exec still refuses PT_INTERP');
    unchanged();
  } finally {
    staged?.pages.discard();
    k.exitProcess(p, 0);
    k.halt();
  }
});

test('ordinary native exec succeeds inside the exact matched Debian fixture root', {
  skip: !root || process.env.SODS_TEST_DYNAMIC_NATIVE !== '1' ? 'requires an authorized native runner with access to the exact fixture root' : false,
}, () => {
  fixture();
  const result = spawnSync('chroot', [resolve(root!), mainPath, 'check'], {env: {PATH: '/usr/sbin:/usr/bin', LC_ALL: 'C'}, encoding: 'utf8', timeout: 8_000});
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'dynamic-pie:42\n');
});
