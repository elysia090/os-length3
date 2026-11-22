import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {planDynamicExec, type DynamicExecPlan} from '../../runtime/linux/exec/dynamic-plan.ts';
import {E, FsError, MNT, Mount, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
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
