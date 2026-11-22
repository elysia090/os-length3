import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {prepareDynamicImage, type DetachedDynamicImage} from '../../runtime/linux/exec/dynamic-image.ts';
import {planDynamicExec, type DynamicExecPlan} from '../../runtime/linux/exec/dynamic-plan.ts';
import {ExecPreparationChangedError} from '../../runtime/linux/exec/source.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {E, FsError, MNT, Mount, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {captureMappedLibraries} from '../../runtime/linux/mapped-libraries.ts';
import {MappedVm} from '../../runtime/linux/mapped-vm.ts';
import type {Mem} from '../../runtime/linux/parts.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
import {captureExecutableSource} from '../../runtime/linux.ts';
import {ExecCommitError, ImageSourceChangedError, Kernel, Process} from '../../runtime/linux/process.ts';
import {loadTranslator} from '../../runtime/translate.ts';
import type {ElfLoadSpec} from '../../runtime/translation/dynamic-load.ts';

const root = process.env.SODS_TEST_DYNAMIC_ROOT;
const translatorPath = process.env.SODS_CURRENT_TRANSLATOR_WASM;
const mappedWasm = process.env.SODS_TEST_MAPPED_WASM;
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

function matchedSources(vfs: Vfs) {
  const f = fixture(), target = mountTarget(vfs), reads = new Map<string, number>();
  const mount = (path: string, bytes: Uint8Array, mode: number) => {
    const origin = sha(bytes);
    const file = target.file(path, mode, bytes.length, () => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return bytes;
    }, origin);
    return {file, grant: captureExecutableSource(vfs, path, {origin, size: bytes.length})};
  };
  const app = mount(mainPath, f.main, 0o755), ld = mount(interpreterPath, f.loader, 0o755);
  const library = mount(libraryPath, f.library, 0o644), libc = mount(libcPath, f.libc, 0o644);
  for (const [path, to] of f.links) vfs.symlink(to, path);
  const inputs = [library.grant, libc.grant], libraries = captureMappedLibraries(vfs, inputs);
  inputs.length = 0; // No dependence on the caller's mutable array after admission.
  return {f, app: app.file, library: library.file, reads, sources: {main: app.grant, interpreter: ld.grant, libraries}};
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
  const make = {vfs, base, pages: 2, reader: {
    describeDynamic() { assert.fail('this unit seeds plain data pages'); }, notProgram: () => false,
  }};
  const readOnly = {kind: 'load-data' as const, start: at, end: at + 4096, prot: 1,
    writes: [{at: at + 12, bytes: Uint8Array.of(20, 42)}]};
  assert.throws(() => MappedVm.detached(make, [readOnly, {...readOnly}], () => {}), hasErrno(E.INVAL));
  assert.throws(() => MappedVm.detached(make, [{...readOnly, prot: 7}], () => {}), hasErrno(E.INVAL));
  assert.throws(() => MappedVm.detached(make, [{...readOnly, prot: 5}], () => {}), hasErrno(E.INVAL));
  assert.throws(() => MappedVm.detached(make, [{...readOnly, kind: 'stack'}], () => {}), hasErrno(E.INVAL));
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
      // The loader, not the VM, derives RELRO's full pages from the ELF
      // headers. Read the real headers in guest memory, not new metadata.
      const phdr = new DataView(pages.read(object.bias + spec.phdr, spec.phent * spec.phnum).buffer);
      let relro = 0;
      for (let at = 0; at < phdr.byteLength; at += spec.phent) {
        if (phdr.getUint32(at, true) !== 0x6474e552) continue; // PT_GNU_RELRO
        const addr = object.bias + Number(phdr.getBigUint64(at + 16, true));
        const page = (n: number) => Math.floor(n / 4096) * 4096;
        const start = page(addr), end = page(addr + Number(phdr.getBigUint64(at + 40, true)));
        assert.ok(end > start, role + ' has full RELRO pages');
        assert.ok(spec.loads.some(load => (load.flags & 7) === 6 &&
          page(object.bias + load.vaddr) <= start && object.bias + load.vaddr + load.memSize >= end));
        assert.ok(pages.permits(start, end - start, 'write'), 'initial RELRO is writable before relocation');
        assert.equal(pages.hasText(BigInt(start)), false);
        relro++;
      }
      assert.equal(relro, 1, role + ' has a GNU RELRO header');
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

function freshHeld(k: Kernel) {
  const p = new Process(k, null, false, false, null, null, false);
  p.noNewPrivs = true;
  p.cred = p.cred.with({uid: 1001, euid: 1001, fsuid: 1001, gid: 1002, egid: 1002, fsgid: 1002,
    suid: 1003, sgid: 1004, effective: 0n, permitted: 0n, keep: true});
  p.comm = 'preparation'; p.dumpable = false;
  const task = k.newTask(p);
  p.pid = p.pgid = p.sid = task.tid;
  p.tasks.add(task); p.task = task;
  return {p, task};
}

const skipHeld = !root || !mappedWasm ? 'requires the staged dynamic fixture and mapped-code translator' : false;

test('ordinary exec metadata and descriptors commit only to the authenticated fresh Task, which remains held', {skip: skipHeld}, async () => {
  const translate = await loadTranslator(readFileSync(mappedWasm!)), compiler = translate.mapped!;
  assert.ok(compiler);
  const vfs = new Vfs(), mounted = matchedSources(vfs), {app: file, sources} = mounted;
  const k = new Kernel({vfs, translate, console: quiet});
  const rootRefs = k.root.mnt.refs, {p, task} = freshHeld(k), {fds: table, fs} = p;
  const fd = p.fds.install(new Description('file', {node: file}), {cloexec: true}), description = p.fds.get(fd)!;
  const survivor = new Description('console', {path: 'stdout'}), keptFd = table.install(survivor);
  const metadata = () => [p.fds, p.cred, p.argv, p.env, p.exe, p.exeAt, p.stackLow, p.stackTop, p.mapBase];
  const before = metadata(), installed: (true | Error | undefined)[] = [];
  let closed = 0;
  description.gone = () => {
    assert.equal(p.execTransition, true);
    assert.equal(p.memory, null, 'original scope remains intact while the descriptor closes');
    assert.equal(table.get(fd), null);
    metadata().forEach((value, i) => assert.equal(value, before[i]));
    closed++;
  };
  let pc = task.resumeAt;
  Object.defineProperty(task, 'resumeAt', {get: () => pc, set(next: bigint) {
    pc = next;
    if (next) installed.push(p.execTransition);
  }});
  const request = {path: mainPath, argv: ['ricebox-pie-fixture', '日本語'], env: ['LC_ALL=C']};
  const stage = () => prepareDynamicImage(p, request, sources, translate);
  const unpublished = () => {
    assert.deepEqual([k.procs.size, k.tasks.size, k.runq.length, k.blocked.size, p.cgroup.procs.size, k.images.size], [0, 0, 0, 0, 0, 0]);
    assert.equal(k.status, null);
    assert.equal(p.exitStatus, undefined);
    assert.equal(p.execTransition, undefined);
  };
  const uncommitted = () => {
    unpublished();
    assert.equal(p.memory, null);
    assert.equal(task.state, 'new');
    assert.equal(task.dead, false);
    assert.equal(p.fds.get(fd), description);
    assert.equal(p.fds.cloexec(fd), true);
    assert.equal(description.closed, false);
    metadata().forEach((value, i) => assert.equal(value, before[i], 'preparation does not publish ordinary exec metadata'));
    assert.equal(closed, 0);
  };
  const more = compiler.more;
  compiler.more = () => { assert.fail('no guest instruction is compiled by a held handoff'); };
  try {
    const rolled = stage(), canceled = task.prepareHeldMapped(rolled);
    uncommitted();
    assert.throws(() => k.ready(task), /held initial Task is disabled/);
    assert.throws(() => p.forkProcess(0n), /held initial Task is disabled/);
    assert.throws(() => p.newThread(0n, 0n, null), /held initial Task is disabled/);
    uncommitted();
    task.rollbackHeldMapped(canceled);
    assert.throws(() => rolled.pages.check(), /discarded/);
    assert.throws(() => task.commitHeldMapped(canceled), /lost its calling process or authority/);
    uncommitted();

    const stale = stage(), staleGrant = task.prepareHeldMapped(stale);
    const changed = p.fds.install(new Description('console', {path: 'stdout'}));
    assert.throws(() => task.commitHeldMapped(staleGrant), ExecPreparationChangedError);
    assert.throws(() => stale.pages.check(), /discarded/);
    assert.ok(p.fds.get(changed), 'rollback does not undo an independent descriptor change');
    p.fds.close(changed);
    uncommitted();

    const revoked = stage(), revokedGrant = task.prepareHeldMapped(revoked);
    k.root.mnt.flags |= MNT.NOEXEC;
    try { assert.throws(() => task.commitHeldMapped(revokedGrant), hasErrno(E.ACCES)); }
    finally { k.root.mnt.flags &= ~MNT.NOEXEC; }
    assert.throws(() => revoked.pages.check(), /discarded/);
    uncommitted();

    const image = stage(), grant = task.prepareHeldMapped(image);
    const receipt = task.commitHeldMapped(grant);
    try {
      assert.equal(mounted.reads.has(libraryPath) || mounted.reads.has(libcPath), false, 'no dependency payloads read for the held handoff');
      assert.equal(p.fds, table);
      assert.equal(table.get(keptFd), survivor);
      assert.equal(table.get(fd), null);
      assert.equal(description.closed, true);
      assert.equal(closed, 1);
      assert.equal(p.exe, mainPath);
      assert.equal(p.exeAt?.node, file);
      assert.equal(p.image, undefined, 'no substitute static Program');
      assert.deepEqual([p.argv, p.env], [request.argv, request.env]);
      assert.deepEqual([p.comm, p.dumpable, p.noNewPrivs], [null, true, true]);
      assert.deepEqual([p.cred.suid, p.cred.sgid, p.cred.permitted, p.cred.effective, p.cred.keep], [1001, 1002, 0n, 0n, false]);
      assert.deepEqual([p.stackLow, p.stackTop, p.mapBase, p.mapEnd, p.free, p.fixed],
        [image.stack.stackLow, image.stack.stackTop, image.stack.mapBase, image.stack.mapBase, [], []]);
      const memory = p.memory as Mem | null;
      assert.ok(memory?.mappedVm);
      assert.equal(receipt.kind, 'held-initial');
      assert.equal(task.memory, memory, 'the ordinary Task and Process own the same prepared backing');
      assert.equal(memory.users, 1);
      assert.equal(task.context().rip, BigInt(image.firstPc));
      assert.deepEqual(installed, [true], 'only the shared exec commit phase installs the initial context');
      assert.equal(task.reg(4), BigInt(image.stack.sp));
      assert.equal(task.context().regs.filter(r => r !== 0n).length, 1);
      assert.throws(() => image.pages.check(), /claimed/);
      image.pages.discard(); // Old inspection cannot close the claimed backing.
      const user = memory.mappedVm.userMemory(p);
      const word = (index: number) => Number(new DataView(user.copyIn(image.stack.sp + index * 8, 8).buffer).getBigUint64(0, true));
      assert.equal(word(0), p.argv.length);
      assert.deepEqual([user.cstring(word(1)), user.cstring(word(2)), word(3), user.cstring(word(4)), word(5)],
        [...p.argv, 0, ...p.env, 0]);
      const code = memory.mappedVm.code, generation = code.generation;
      assert.equal(code.find(BigInt(image.firstPc), generation)?.text.role, 'interpreter');
      assert.equal(code.find(BigInt(image.aux.entry), generation)?.text.role, 'main');
      assert.throws(() => task.commitHeldMapped(grant), /lost its calling process or authority/);
      assert.throws(() => task.setReg(4, 0n), /Held initial Task registers/);
      assert.throws(() => k.ready(task), /held initial Task is disabled/);
      assert.throws(() => k.run(task), /held initial Task is disabled/);
      assert.throws(() => p.syscall(39n, 0n, 0n, 0n, 0n, 0n, 0n), /held initial Task is disabled/);
      assert.throws(() => k.halt(), /held initial handoff still owns/);
      assert.throws(() => { p.memory = null; }, /Only the held handoff owner/);
      unpublished();
      receipt.discard();
      assert.equal(memory.users, 0);
      assert.equal(k.spareMemories.includes(memory), false);
      assert.equal(code.find(BigInt(image.firstPc), code.generation), undefined);
      assert.throws(() => user.check(), ReadLifetimeError);
    } finally { receipt.discard(); }
    assert.equal(p.memory, null);
    assert.equal(p.state, 'zombie', 'retired, but absent from the waitable process table');
    assert.equal(p.own, undefined);
    assert.equal(p.tasks.size, 0);
    assert.equal(task.dead, true);
    assert.equal(task.state, 'dead');
    assert.equal(survivor.closed, true);
    assert.equal(table.holders, 0);
    assert.equal(table.slots.size, 0);
    assert.equal(fs.users, 0);
    assert.equal(k.root.mnt.refs, rootRefs);
    assert.equal(closed, 1);
    unpublished();

    assert.equal(p.syscall(39n, 0n, 0n, 0n, 0n, 0n, 0n), BigInt(-E.SRCH));
    assert.throws(() => p.execve(request.path, request.argv, request.env), hasErrno(E.SRCH));
    assert.throws(() => p.forkProcess(0n), hasErrno(E.SRCH));
    assert.throws(() => p.newThread(0n, 0n, null), hasErrno(E.SRCH));
    k.ready(task);
    k.exitProcess(p, 0);
    receipt.discard();
    assert.deepEqual([p.own, table.holders, table.slots.size, fs.users, k.root.mnt.refs, closed],
      [undefined, 0, 0, 0, rootRefs, 1], 'ordinary calls and repeated disposal have no further ownership effects');
    unpublished();

    const newer = freshHeld(k);
    try {
      const outdated = prepareDynamicImage(newer.p, request, sources, translate), outdatedGrant = newer.task.prepareHeldMapped(outdated);
      // Identical data at a new inode version still needs fresh authorization.
      mounted.library.write(0, mounted.f.library.slice(0, 1));
      assert.throws(() => newer.task.commitHeldMapped(outdatedGrant), hasErrno(E.ACCES));
      assert.throws(() => outdated.pages.check(), /discarded/);
      assert.equal(newer.p.memory, null);
      unpublished();
    } finally { newer.p.fds.letGo(); newer.p.fs0.drop(); }
  } finally {
    compiler.more = more;
    if (p.fds.holders) p.fds.letGo();
    if (p.fs0.users) p.fs0.drop();
    k.halt();
  }
});

test('a held exec keeps unconfirmed descriptor ownership without retrying or publishing', {skip: skipHeld}, async () => {
  const translate = await loadTranslator(readFileSync(mappedWasm!)), vfs = new Vfs(), {sources} = matchedSources(vfs);
  const k = new Kernel({vfs, translate, console: quiet}), {p, task} = freshHeld(k), table = p.fds;
  const description = new Description('file'), unavailable = new Error('Descriptor cleanup not confirmed');
  let closes = 0;
  description.gone = () => { closes++; throw unavailable; };
  const fd = table.install(description, {cloexec: true});
  const image = prepareDynamicImage(p, {path: mainPath, argv: [], env: []}, sources, translate), grant = task.prepareHeldMapped(image);
  assert.throws(() => task.commitHeldMapped(grant), error => error instanceof ExecCommitError && error.phase === 'descriptors' &&
    error.cause === unavailable && error.owners.task === task && error.owners.newFds === table && !error.owners.newMemory);
  const failed = p.execFailure;
  assert.ok(failed && k.failedExecs?.has(failed));
  assert.throws(() => image.pages.check(), /discarded/, 'the independently retired detached VM is no longer owned');
  assert.equal(table.get(fd), null);
  assert.equal(p.memory, null);
  assert.equal(p.exe, '');
  assert.deepEqual([k.procs.size, k.tasks.size, k.runq.length, p.cgroup.procs.size, k.status], [0, 0, 0, 0, null]);
  assert.throws(() => p.forkProcess(0n), error => error === failed);
  assert.throws(() => p.newThread(0n, 0n, null), error => error === failed);
  assert.throws(() => task.rollbackHeldMapped(grant), error => error === failed);
  assert.throws(() => k.halt(), error => error === failed);
  assert.equal(k.retireInitialMounts(), false);
  assert.equal(closes, 1);
});

test('the same planned dependency catalogue authorizes lazy ordinary guest mmap in the checked VM', {
  skip: skipHeld,
}, async () => {
  const translate = await loadTranslator(readFileSync(mappedWasm!)), describeDynamic = translate.describeDynamic;
  assert.ok(describeDynamic && translate.mapped);
  const vfs = new Vfs(), {f, sources, reads, library} = matchedSources(vfs);
  const k = new Kernel({vfs, translate, console: quiet}), p = new Process(k, null);
  p.noNewPrivs = true;
  const call = (nr: number, ...args: number[]): bigint => p.syscall(BigInt(nr),
    ...[...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]);
  try {
    const plan = planDynamicExec(p, mainPath, sources, translate);
    assert.equal(plan.libraries, sources.libraries, 'no second catalogue or path-based adapter');
    assert.equal(reads.has(libraryPath) || reads.has(libcPath), false);
    assert.throws(() => captureMappedLibraries(vfs, Array(4097).fill(sources.main)), hasErrno(E.NOMEM));
    assert.throws(() => captureMappedLibraries(vfs, [sources.main, sources.main]), /Duplicate mapped library inode/);
    assert.throws(() => planDynamicExec(p, mainPath, {...sources, libraries: captureMappedLibraries(vfs, [sources.main])}, translate),
      hasErrno(E.ACCES));
    const {libraries} = plan, reader = {describeDynamic, notProgram: translate.notProgram};
    assert.throws(() => MappedVm.allocate({vfs: new Vfs(), base: 0x10000, pages: 1, libraries, reader}), /another Vfs/);

    // This is an ordinary checked arena, not a launch of the prepared image.
    p.mapBase = p.mapEnd = p.stackTop = 0x10000;
    p.stackLow = 4096; p.free = []; p.fixed = [];
    const vm = (p.memory = MappedVm.allocate({vfs, base: p.mapBase, pages: 1, libraries, reader})).mappedVm;
    const name = 0x10000;
    assert.equal(call(9, name, 4096, 3, 0x32, -1, 0), BigInt(name));
    const objects: readonly [string, Uint8Array, number][] = [[libraryPath, f.library, 0x20000], [libcPath, f.libc, 0x60000]];
    for (const [path, bytes, bias] of objects) {
      assert.equal(reads.get(path), undefined);
      vm.userMemory(p).copyOut(name, new TextEncoder().encode(path + '\0'));
      const fd = Number(call(257, -100, name, 0));
      assert.ok(fd >= 0, 'normal virtual openat selects the holding inode');
      const segment: ElfLoadSpec['loads'][number] | undefined = describeDynamic(bytes, 'library').loads.find(s => s.flags === 5);
      assert.ok(segment);
      const align = (n: number) => Math.floor(n / 4096) * 4096;
      const start: number = align(segment.vaddr) + bias, offset = align(segment.offset), pc: number = segment.vaddr + bias;
      const size: number = Math.ceil((pc + segment.fileSize) / 4096) * 4096 - start;
      assert.equal(call(9, start, size, 5, 0x12, fd, offset), BigInt(start));
      assert.equal(reads.get(path), 1, 'only ordinary mmap materializes this verified member');
      assert.equal(vm.code.find(BigInt(pc), vm.code.generation)?.text.role, 'library');
      assert.deepEqual(vm.userMemory(p).copyIn(pc, 16), bytes.slice(segment.offset, segment.offset + 16));
      if (path === libraryPath) {
        library.write(0, f.library.slice(0, 1));
        assert.equal(call(9, start, size, 5, 0x12, fd, offset), BigInt(-E.ACCES), 'the held FD does not renew an old inode grant');
        assert.equal(vm.code.find(BigInt(pc), vm.code.generation), undefined);
      }
      assert.equal(call(3, fd), 0n);
    }
    assert.equal(k.tasks.size, 0);
    assert.equal(k.runq.length, 0);
  } finally { k.exitProcess(p, 0); k.halt(); }
});
