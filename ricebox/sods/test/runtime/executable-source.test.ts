import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canRunApart} from '../../runtime/host.ts';
import {captureExecutableSource, Kernel, preparedLinux, PreparedLinuxError, RemoteKernel, Vfs, mountTarget, provide, type ExecutableSource} from '../../runtime/linux.ts';
import {E, File, FsError} from '../../runtime/linux/fs.ts';
import {executableSourceFor} from '../../runtime/linux/executable-source.ts';

const enc = new TextEncoder(), name = enc.encode('sods.facts'), facts = enc.encode('{}');
// Image parser fixture only, deliberately not an executable translation.
const wasm = Uint8Array.of(0,97,115,109,1,0,0,0,0,1+name.length+facts.length,name.length,...name,...facts);
const module = new WebAssembly.Module(wasm);
const quiet = {write() {}, read: () => new Uint8Array(0)};
function root(lazy = true) {
  const vfs = new Vfs(), bytes = Uint8Array.of(127, 69, 76, 70, 1);
  let reads = 0;
  const file = lazy ? mountTarget(vfs).file('/bin/p', 0o755, bytes.length, () => { reads++; return bytes.slice(); }, 'release/index/source')
    : vfs.writeFile('/bin/p', bytes, 0o755);
  file.origin = 'release/index/source';
  const capture = () => captureExecutableSource(vfs, '/bin/p', {origin: file.origin!, size: bytes.length});
  return {vfs, file, bytes, capture, reads: () => reads};
}

test('source capture and association retain an opaque exact source without reading it', () => {
  const r = root(), source = r.capture(), k = new Kernel({vfs: r.vfs, console: quiet});
  assert.equal(Object.getPrototypeOf(source), null); assert.equal(Object.isFrozen(source), true);
  assert.deepEqual(Object.keys(source), []);
  const image = k.prebuiltSource(source, module);
  assert.ok(image); assert.equal(k.translated(r.file), true); assert.equal(r.reads(), 0);
  assert.deepEqual(image.source!(), r.bytes); assert.equal(r.reads(), 1);
  assert.deepEqual(r.vfs.readFile('/bin/p'), r.bytes); assert.equal(r.reads(), 1);
});

test('capture rejects wrong metadata, missing/nonregular sources and noncanonical/symlink paths without payload reads', () => {
  const r = root();
  for (const expected of [{origin: 'wrong', size: 5}, {origin: r.file.origin!, size: 4}, {origin: '', size: 5},
    {origin: r.file.origin!, size: -1}, {origin: r.file.origin!, size: 1.5}])
    assert.throws(() => captureExecutableSource(r.vfs, '/bin/p', expected), TypeError);
  for (const path of ['/missing', '/bin', '/dev/null', '/bin//p', 'bin/p', '/bin/./p', '/bin/../bin/p', '/bin/p/', '/bin/p\0'])
    assert.throws(() => captureExecutableSource(r.vfs, path, {origin: r.file.origin!, size: 5}));
  r.vfs.symlink('p', '/bin/alias'); r.vfs.symlink('/bin', '/alias');
  for (const path of ['/bin/alias', '/alias/p']) assert.throws(() => captureExecutableSource(r.vfs, path, {origin: r.file.origin!, size: 5}), TypeError);
  r.file.version++;
  assert.throws(() => r.capture(), /canonical inode/);
  assert.equal(r.reads(), 0);
});

test('forged, cloned, foreign-registry and wrong-Vfs capabilities cannot authorize an association', async () => {
  const r = root(), source = r.capture(), k = new Kernel({vfs: r.vfs, console: quiet});
  const foreign = await import(new URL('../../runtime/linux/executable-source.ts?separate-realm', import.meta.url).href);
  const foreignSource = foreign.captureExecutableSource(r.vfs, '/bin/p', {origin: r.file.origin!, size: 5});
  for (const bad of [{}, Object.create(source), structuredClone(source), foreignSource, null, 1])
    assert.throws(() => k.prebuiltSource(bad as ExecutableSource, module), TypeError);
  assert.throws(() => new Kernel({console: quiet}).prebuiltSource(source, module), /another Vfs/);
  assert.equal(r.reads(), 0); assert.equal(k.translated(r.file), false);
});

test('same-sized replacement or overlay never inherits an image; surviving hardlink is the captured inode', () => {
  for (const overlay of [false, true]) {
    const r = root(), source = r.capture(); mountTarget(r.vfs).hardlink(r.file, '/bin/hard');
    const replacement = overlay ? provide(r.vfs, {path: '/bin/p', bytes: r.bytes.slice(), mode: 0o755})
      : r.vfs.writeFile('/bin/p', r.bytes.slice(), 0o755);
    replacement.origin = r.file.origin; // Equal labels and size still do not grant inode identity.
    const k = new Kernel({vfs: r.vfs, console: quiet});
    const image = k.prebuiltSource(source, module);
    assert.ok(image); assert.equal(k.image(r.vfs.file('/bin/hard')), image);
    assert.equal(k.translated(replacement), false); assert.equal(r.reads(), 0);
  }
});

test('changed captured revision/origin/size declines before payload access or relabeling', () => {
  for (const change of [(f: File) => { f.version++; }, (f: File) => { f.origin = 'replacement'; }, (f: File) => { f.size++; }]) {
    const r = root(), source = r.capture(); change(r.file);
    const k = new Kernel({vfs: r.vfs, console: quiet});
    assert.equal(k.prebuiltSource(source, module), null); assert.equal(k.translated(r.file), false); assert.equal(r.reads(), 0);
  }
});

test('captured metadata is immutable even through an internal registry import', () => {
  const r = root(), source = r.capture(), captured = executableSourceFor(source, r.vfs);
  assert.equal(Object.isFrozen(captured), true);
  r.file.version++;
  assert.throws(() => Object.assign(captured, {revision: r.file.version}), TypeError);
  assert.equal(captured.revision, 0);
  assert.equal(new Kernel({vfs: r.vfs, console: quiet}).prebuiltSource(source, module), null);
});

test('resident mapping settlement admits clean source and declines a dirty captured revision', () => {
  for (const dirty of [false, true]) {
    const r = root(false), source = r.capture(), m = {proc: {bytes: r.bytes.slice()}, start: 0, length: 5, off: 0};
    r.file.map(m); if (dirty) m.proc.bytes[4] = 2;
    const k = new Kernel({vfs: r.vfs, console: quiet}), image = k.prebuiltSource(source, module);
    assert.equal(!!image, !dirty); assert.equal(r.file.version, dirty ? 1 : 0);
    assert.equal(r.file.read(4, 5)[0], dirty ? 2 : 1); r.file.unmap(m);
  }
});

test('unusual lazy mapping declines conservatively, without materialization or automatic writeback', () => {
  const r = root(), source = r.capture(), m = {proc: {bytes: r.bytes.slice()}, start: 0, length: 5, off: 0};
  r.file.map(m); m.proc.bytes[4] = 2;
  const k = new Kernel({vfs: r.vfs, console: quiet});
  assert.equal(k.prebuiltSource(source, module), null); assert.equal(r.reads(), 0); assert.equal(r.file.version, 0);
  r.file.abandon(m);
});

test('partial mapped publication cannot reauthorize an old source, cached image or keeper after abandonment', () => {
  const r = root(false), source = r.capture(), failure = new Error('mapping publication failed');
  let observations = 0, translations = 0, keeperHas = 0, keeperTake = 0, translatedBytes: Uint8Array | undefined;
  const k = new Kernel({vfs: r.vfs, console: quiet,
    keeper: {has() { keeperHas++; return true; }, take() { keeperTake++; return {module, segments: null, size: wasm.length, more: []}; }},
    translate(bytes) { translations++; translatedBytes = bytes.slice(); return wasm; }});
  const old = k.prebuiltSource(source, module)!; old.origin = r.file.origin;
  const memory = r.bytes.slice(), mapping = {proc: {get bytes() {
    if (++observations === 3) throw failure;
    return memory;
  }}, start: 0, length: 5, off: 0};
  r.file.map(mapping); memory[4] = 2;
  assert.throws(() => k.prebuiltSource(source, module), (error: unknown) => error === failure);
  assert.equal(r.file.version, 1); assert.equal(r.file.data[4], 2);
  r.file.abandon(mapping);
  assert.equal(k.prebuiltSource(source, module), null);
  assert.throws(() => r.capture(), /canonical inode/);
  assert.equal(k.translated(r.file), false); assert.equal(k.keptFor(r.file), false);
  const replacement = k.image(r.file, true);
  assert.notEqual(replacement, old); assert.equal(translations, 1); assert.equal(translatedBytes![4], 2);
  assert.equal(keeperHas, 0); assert.equal(keeperTake, 0);
  assert.equal(old.source!()[4], 2); assert.equal(old.changed, true); assert.equal(old.origin, undefined);
});

test('mutation after attachment follows existing invalidation and readLater provenance/COW behavior', () => {
  const r = root(), source = r.capture(), k = new Kernel({vfs: r.vfs, console: quiet});
  const image = k.prebuiltSource(source, module)!; image.origin = r.file.origin;
  r.file.write(4, Uint8Array.of(2)); assert.equal(k.translated(r.file), false);
  const view = image.source!(); assert.equal(view[4], 2); assert.equal(image.changed, true); assert.equal(image.origin, undefined);
  r.file.write(4, Uint8Array.of(3)); assert.equal(image.source!(), view); assert.equal(view[4], 2);
});

test('source revision changed during Image preparation is not attached or relabeled', () => {
  const r = root(), source = r.capture(), k = new Kernel({vfs: r.vfs, console: quiet});
  const sections = WebAssembly.Module.customSections;
  WebAssembly.Module.customSections = (m, name) => { r.file.version++; return sections(m, name); };
  try { assert.equal(k.prebuiltSource(source, module), null); }
  finally { WebAssembly.Module.customSections = sections; }
  assert.equal(k.translated(r.file), false); assert.equal(r.reads(), 0);
});


test('unavailable lazy source is not demanded by association; deliberate demand fails honestly and can retry', () => {
  const vfs = new Vfs(); let available = false, reads = 0;
  const file = mountTarget(vfs).file('/p', 0o755, 5, () => { reads++; if (!available) throw new Error('unavailable'); return Uint8Array.of(127,69,76,70,1); }, 'source');
  const k = new Kernel({vfs, console: quiet}), source = captureExecutableSource(vfs, '/p', {origin: 'source', size: 5});
  const image = k.prebuiltSource(source, module)!; assert.equal(reads, 0);
  assert.throws(() => image.source!(), (e: unknown) => e instanceof FsError && e.errno === E.IO);
  available = true; assert.equal(image.source!()[4], 1); assert.equal(reads, 2); assert.equal(file.version, 0);
});

test('factory validates duplicate keys/inodes, foreign sources, memory modes and malformed artifacts before constructing a kernel', () => {
  const r = root(), source = r.capture(), second = mountTarget(r.vfs).file('/other', 0o755, 5, () => r.bytes, 'second');
  const other = captureExecutableSource(r.vfs, '/other', {origin: second.origin!, size: 5});
  const record = {key: 'p', source, module};
  for (const executables of [[record, record], [record, {...record, key: 'alias'}], [record, {key: 'second', source: other, module, shared: true}],
    [{...record, source: {} as ExecutableSource}], [{...record, module: new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))}],
    [{...record, segments: [{offset: -1, bytes: r.bytes}]}]]) {
    const before = r.vfs.who.root;
    assert.throws(() => preparedLinux({vfs: r.vfs, console: quiet, executables}));
    assert.equal(r.vfs.who.root, before, 'no Kernel constructor mutated the tree'); assert.equal(r.reads(), 0);
  }
});

test('factory reports only accepted images and keeps ordinary fallback for stale sources', () => {
  const r = root(), source = r.capture(); r.file.version++;
  const {kernel, attached} = preparedLinux({vfs: r.vfs, console: quiet, executables: [{key: 'p', source, module}]});
  assert.equal(kernel.constructor, Kernel); assert.equal(attached.size, 0); assert.equal(r.reads(), 0);
});

test('post-construction association failure retains kernel and earlier attachments, without claiming rollback', () => {
  const r = root(), first = r.capture(), file = mountTarget(r.vfs).file('/q', 0o755, 5, () => r.bytes, 'q');
  const second = captureExecutableSource(r.vfs, '/q', {origin: 'q', size: 5});
  file.given(r.bytes); const mapping = {proc: {bytes: r.bytes.slice()}, start: 0, length: 5, off: 0}; file.map(mapping);
  const failure = new Error('mapping observation failed'); file.settle = () => { throw failure; };
  let error: unknown;
  try { preparedLinux({vfs: r.vfs, console: quiet, executables: [{key: 'p', source: first, module}, {key: 'q', source: second, module}]}); }
  catch (caught) { error = caught; }
  assert.ok(error instanceof PreparedLinuxError); assert.equal(error.cause, failure);
  assert.equal(error.kernel.vfs, r.vfs); assert.equal(error.attached.size, 1); assert.ok(error.attached.get('p'));
  assert.equal(error.kernel.translated(file), false); assert.equal(r.reads(), 0); file.abandon(mapping);
});

test('typed partial failure preserves the actual Worker kernel for explicit observed retirement', {skip: !canRunApart()}, async () => {
  const r = root(false), source = r.capture(), mapping = {proc: {bytes: r.bytes.slice()}, start: 0, length: 5, off: 0};
  r.file.map(mapping); const failure = new Error('observation failed'); r.file.settle = () => { throw failure; };
  let error: unknown;
  try { preparedLinux({vfs: r.vfs, console: quiet, spares: 1, executables: [{key: 'p', source, module, shared: true}]}); }
  catch (caught) { error = caught; }
  assert.ok(error instanceof PreparedLinuxError); assert.equal(error.cause, failure); assert.equal(error.attached.size, 0);
  assert.ok(error.kernel instanceof RemoteKernel);
  error.kernel.close(); const evidence = await error.kernel.snapshotWorkerStops();
  assert.equal(evidence.captured, 1); assert.equal(evidence.unconfirmed, 0); assert.deepEqual(evidence.failures, []);
  r.file.abandon(mapping);
});
