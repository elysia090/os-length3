// Actual current Linux core + translator + Worker. The synthetic authenticated
// pack holds the same ELF used by the native comparator; no TS Vfs or Kernel is
// constructed. Preparation reads that ELF to produce the fixture AOT, separately
// from the source-free Rust startup window measured by the callback counters.
import assert from 'node:assert/strict';
import {createHook} from 'node:async_hooks';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {gzipSync, gunzipSync} from 'node:zlib';
import {managedRoot, type ExecutionBinding, type PreparedArtifactRequest} from '../../../sods/runtime/linux.ts';
import {loadTranslator} from '../../../sods/runtime/translate.ts';
import {canonicalExecutableSource} from '../../distribution/executable-source.ts';
import type {Blob, Index} from '../../distribution/manifest.ts';
import {checkedRange, packOf} from '../../distribution/pack.ts';
import {managedRootWire} from '../managed-root-wire.ts';

const corePath = process.env.SODS_LINUX_WASM;
const translatorPath = process.env.SODS_CURRENT_TRANSLATOR_WASM ?? process.env.SODS_PATH_TRANSLATOR_WASM;
const provenance = process.env.SODS_CURRENT_TRANSLATOR_WASM ? 'current-source' : 'explicit external';
const encode = (value: string) => new TextEncoder().encode(value);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());
const guestPath = '/bin/program.elf';
const descriptions = {
  lazy: 'root AOT startup leaves canonical ELF lazy, then the actual guest opens/reads/closes it',
  cancel: 'cancelled artifact late shared/valid success and rejection publish no Worker and permit root reuse',
  invalid: 'invalid artifact byte classes fail before source/Worker publication and permit root reuse',
  size: 'wrong decoded source length fails the exact Rust source, retires, and retries without metadata drift',
  malformed: 'malformed root wire publishes no partial root and the same host accepts a valid root',
} as const;
type Scenario = keyof typeof descriptions;
type Host = Awaited<ReturnType<typeof managedRoot>>;

async function stopped(host: Host, execution: ExecutionBinding): Promise<void> {
  host.stopWorker(execution);
  await host.workerSettled(execution);
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const evidence = host.workerEvidence(execution);
    if (evidence.exited && evidence.resourcesRetired && !evidence.pendingRequest) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const evidence = host.workerEvidence(execution);
  assert.equal(evidence.created, true);
  assert.equal(evidence.exited, true, 'a termination request is not exit evidence');
  assert.equal(evidence.resourcesRetired, true, 'the sole FD table and context must be returned');
  assert.equal(evidence.pendingRequest, false);
}

async function child(scenario: Scenario, programPath: string): Promise<void> {
  assert.ok(corePath, 'SODS_LINUX_WASM must name the current core');
  assert.ok(translatorPath, 'an explicit translator artifact is required');
  const elf = new Uint8Array(readFileSync(programPath));
  const translatorBytes = new Uint8Array(readFileSync(translatorPath));
  const translator = await loadTranslator(translatorBytes);
  const rawWasm = translator.whole(elf);
  const blob = (bytes: Uint8Array): Blob => {
    const stored = new Uint8Array(gzipSync(bytes));
    const sha256 = hash(stored);
    return {path: `blobs/${sha256}.bin`, sha256, size: stored.length, bytes: bytes.length};
  };
  const pack = packOf([elf], digest);
  const sourceAt = pack.at[0]!;
  const translation = {path: guestPath, sha256: hash(elf), elf: blob(elf), wasm: blob(rawWasm),
    association: {version: 1 as const, origin: `${pack.name.slice(0, -5)}_${sourceAt}_${elf.length}`,
      sourceSha256: hash(elf), sourceBytes: elf.length, mode: 'whole' as const}};
  const index: Index = {name: 'managed-root-current-fixture', version: '1', sha256: hash(elf), codec: 'raw',
    packs: [{name: pack.name, owner: 'fixture', bytes: pack.bytes.length}],
    dirs: [{path: '/root', mode: 0o755}, {path: '/bin', mode: 0o755}], links: [],
    files: [{path: guestPath, mode: 0o755, size: elf.length, pack: 0, at: sourceAt, len: elf.length, raw: true}],
    translator: {...blob(translatorBytes), name: 'sods', version: 'current-fixture', wasm: hash(translatorBytes)},
    translations: [translation]};
  const generation = hash(encode(JSON.stringify(index)));
  assert.notEqual(generation, index.sha256);
  assert.equal(canonicalExecutableSource(index, translation).binding, 'explicit');
  const prepared = managedRootWire(index, generation, true);
  const limits = {...prepared.limits, tables: 1, descriptions: 64, slots: 64, reads: 1,
    contexts: 2, views: 1, holds: 71, policy: {noExec: false, noSuid: false, noSymfollow: false}};
  // Normal self-open needs the live Fs plus a copied lookup snapshot. With two
  // contexts, one leaked cancelled context would make that control require
  // three and fail; lowering this legitimate runtime capacity to one is wrong.
  // Capacity also bounds monotonic startup-admission history, including failed
  // artifacts that never bind physical memory. The invalid case needs exactly
  // four failed admissions plus its successful control. Neither these IDs nor
  // physical bindings are reclaimed by run retirement; table/context limits
  // below remain one/two, so their reuse is tested independently of history.
  const core = new WebAssembly.Module(readFileSync(corePath));
  const host = await managedRoot(core, {memories: scenario === 'invalid' ? 5 : 4, actions: 16});
  assert.equal(Object.isFrozen(host), true);
  assert.deepEqual(Object.keys(host).sort(), ['prepareRoot', 'rootSource', 'pathExecution', 'runPath',
    'stopWorker', 'workerSettled', 'workerEvidence'].sort(), 'no diagnostic memory/read/grow or bare-inode entrance');
  if (scenario === 'malformed') {
    const malformed = new Uint8Array(prepared.wire.length + 1);
    malformed.set(prepared.wire);
    assert.throws(() => host.prepareRoot(malformed, limits, 64), /Linux memory admission failed/);
    assert.throws(() => host.rootSource(1), /Linux memory admission failed/, 'no catalog survived the rejected root');
  }
  host.prepareRoot(prepared.wire, limits, 64);
  assert.throws(() => host.rootSource(0), /Linux memory admission failed/);
  assert.deepEqual(host.rootSource(1), {pack: 0, at: sourceAt, stored: elf.length, size: elf.length, raw: true});
  assert.throws(() => host.rootSource(2), /Linux memory admission failed/);

  let loads = 0, artifacts = 0, workers = 0, runs = 0, lateControls = 0;
  const source = checkedRange(index, (name, at, length) => {
    assert.equal(name, pack.name);
    return pack.bytes.slice(at, at + length);
  }, digest);
  const loadFrom = (owner: Host, id: number): Uint8Array => {
    loads++;
    const locator = owner.rootSource(id);
    assert.equal(id, 1);
    assert.deepEqual(locator, {pack: 0, at: sourceAt, stored: elf.length, size: elf.length, raw: true});
    const bytes = new Uint8Array(source(locator.pack, locator.at, locator.stored));
    assert.equal(bytes.length, locator.size);
    assert.equal(hash(bytes), translation.sha256);
    return bytes;
  };
  const load = (id: number): Uint8Array => loadFrom(host, id);
  const storedArtifact = new Uint8Array(gzipSync(rawWasm));
  const validArtifact = (): Uint8Array<ArrayBuffer> => {
    // Trusted fixture transport authenticates the stored gzip and returns owned
    // decoded bytes. This is not Rust crypto or a proof of translation semantics.
    assert.equal(hash(storedArtifact), translation.wasm.sha256);
    const decoded = new Uint8Array(gunzipSync(storedArtifact));
    assert.equal(decoded.length, translation.wasm.bytes);
    return decoded;
  };
  const startFor = (owner: Host, artifact: () => Uint8Array | Promise<Uint8Array> = validArtifact, signal?: AbortSignal) =>
    owner.pathExecution(encode(guestPath), [encode(guestPath)], [encode('A=1')], {
      preparedArtifact: async (request: PreparedArtifactRequest) => {
        artifacts++;
        assert.deepEqual(request, {rootGeneration: generation, sourceSha256: translation.sha256,
          artifactSha256: translation.wasm.sha256, translatorSha256: index.translator.sha256,
          source: 1, sourceBytes: elf.length, shared: true});
        return artifact();
      },
      load: id => loadFrom(owner, id), signal, random: new Uint8Array(16).fill(7), cwd: encode('/root'), stdio: true,
    });
  const start = (artifact: () => Uint8Array | Promise<Uint8Array> = validArtifact, signal?: AbortSignal) =>
    startFor(host, artifact, signal);
  const succeed = async (owner: Host = host): Promise<void> => {
    const before = loads, execution = await startFor(owner);
    assert.equal(loads, before, 'prepared AOT startup must not call the canonical ELF loader');
    try {
      assert.deepEqual(await owner.runPath(execution, id => loadFrom(owner, id)), {status: 0, sourceFailures: 0});
      runs++;
    } finally { await stopped(owner, execution); }
  };
  if (scenario === 'lazy') {
    // Equal core/module and likely equal numerical IDs are not owner identity.
    // Use a real foreign binding, not merely a structurally similar object.
    const foreign = await managedRoot(core, {memories: 1, actions: 8});
    foreign.prepareRoot(prepared.wire, limits, 64);
    const execution = await foreign.pathExecution(encode(guestPath), [encode(guestPath)], [], {
      preparedArtifact: async () => validArtifact(),
      load: () => { throw new Error('foreign AOT startup must not load ELF'); },
      random: new Uint8Array(16).fill(7), cwd: encode('/root'), stdio: true,
    });
    try {
      assert.throws(() => host.runPath(execution, load), /Unknown Worker execution/);
      assert.throws(() => host.stopWorker(execution), /Unknown Worker execution/);
      assert.throws(() => host.workerSettled(execution), /Unknown Worker execution/);
      assert.throws(() => host.workerEvidence(execution), /Unknown Worker execution/);
      assert.equal(foreign.workerEvidence(execution).created, true);
    } finally { await stopped(foreign, execution); }
  }
  // This observes real Node Worker construction rather than substituting a fake
  // runner. Every negative case has a subsequent successful positive control.
  const hook = createHook({init(_id, type) { if (type === 'WORKER') workers++; }});
  hook.enable();
  try {
    if (scenario === 'cancel') {
      const controller = new AbortController(), reason = new Error('cancel-held-artifact');
      let enter!: () => void, release!: (bytes: Uint8Array) => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const delayed = new Promise<Uint8Array>(resolve => { release = resolve; });
      let settled = false;
      const pending = start(() => { enter(); return delayed; }, controller.signal);
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const rejected = assert.rejects(pending, error => error === reason);
      await entered;
      assert.equal(loads, 0); assert.equal(workers, 0);
      controller.abort(reason);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'cancellation is not evidence that an outstanding artifact callback stopped');
      // An unsupported shared result would fail admission if captured. The exact
      // cancellation reason must win before any late-byte adoption/validation.
      release(new Uint8Array(new SharedArrayBuffer(rawWasm.length)));
      await rejected;
      assert.equal(artifacts, 1); assert.equal(loads, 0); assert.equal(workers, 0);
      for (const mode of ['valid', 'reject'] as const) {
        const fresh = await managedRoot(core, {memories: 2, actions: 16});
        fresh.prepareRoot(prepared.wire, limits, 64);
        const before: {loads: number; artifacts: number; workers: number; runs: number} = {loads, artifacts, workers, runs};
        const controller = new AbortController(), reason = new Error(`cancel-late-${mode}`);
        const lateFailure = new Error('late artifact transport rejection');
        let enter!: () => void, release!: (bytes: Uint8Array) => void, reject!: (error: Error) => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const delayed = new Promise<Uint8Array>((resolve, fail) => { release = resolve; reject = fail; });
        let settled = false;
        const pending = startFor(fresh, () => { enter(); return delayed; }, controller.signal);
        void pending.then(() => { settled = true; }, () => { settled = true; });
        // A resolved valid result must still lose to cancellation. A rejected
        // transport preserves its exact late failure, but can publish no Live.
        const rejected = assert.rejects(pending, error => error === (mode === 'valid' ? reason : lateFailure));
        await entered;
        controller.abort(reason);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false, 'cancelled preparation retains its outstanding callback');
        if (mode === 'valid') release(validArtifact()); else reject(lateFailure);
        await rejected;
        assert.deepEqual({loads, artifacts, workers, runs}, {...before, artifacts: before.artifacts + 1},
          'late valid bytes or a rejection cannot create/run a Worker or demand source');
        await succeed(fresh);
        assert.deepEqual({loads, artifacts, workers, runs}, {loads: before.loads + 1, artifacts: before.artifacts + 2,
          workers: before.workers + 1, runs: before.runs + 1}, 'the same cancelled root supports an actual self-read and retirement');
        lateControls++;
      }
    } else if (scenario === 'invalid') {
      const shared = new Uint8Array(new SharedArrayBuffer(rawWasm.length));
      shared.set(rawWasm);
      const compiled = new WebAssembly.Module(rawWasm);
      for (const returned of [Uint8Array.of(1, 2, 3), compiled, {module: compiled, segments: [], facts: {}}, shared]) {
        // Deliberately violate the typed transport contract at this trust boundary.
        await assert.rejects(start(() => returned as unknown as Uint8Array));
        assert.equal(loads, 0); assert.equal(workers, 0);
      }
      assert.equal(artifacts, 4, 'each failure returned the sole startup table/context for reuse');
    } else if (scenario === 'size') {
      const execution = await start();
      assert.equal(loads, 0); assert.equal(workers, 1);
      try {
        await assert.rejects(host.runPath(execution, id => load(id).slice(0, -1)), /Source completion failed/);
      } finally { await stopped(host, execution); }
      assert.equal(loads, 1);
      assert.equal(host.rootSource(1).size, elf.length, 'failed delivery cannot replace sealed decoded-size metadata');
    }
    await succeed();
    if (scenario === 'invalid') {
      const before = {loads, artifacts, workers, runs};
      await assert.rejects(start(), /Linux startup admission failed: -1/);
      assert.deepEqual({loads, artifacts, workers, runs}, before, 'sixth admission exceeds the five-ID history before callbacks or Worker creation');
    }
    const successfulRuns = scenario === 'cancel' ? 3 : 1;
    assert.equal(loads, scenario === 'size' ? 2 : successfulRuns, 'one canonical load per root, not per open or independent OFD');
    assert.equal(workers, scenario === 'size' ? 2 : successfulRuns, 'positive control confirms actual Worker observation');
    assert.equal(runs, successfulRuns);
    assert.equal(lateControls, scenario === 'cancel' ? 2 : 0);
    writeFileSync(3, JSON.stringify({scenario, loads, artifacts, workers, runs, lateControls, retired: true}));
  } finally { hook.disable(); }
}

if (process.argv[2] === '--managed-root-child') {
  const scenario = process.argv[3];
  assert.ok(scenario !== undefined && Object.hasOwn(descriptions, scenario));
  const program = process.argv[4];
  assert.ok(program);
  await child(scenario as Scenario, program);
} else {
  for (const scenario of Object.keys(descriptions) as Scenario[]) test(`${provenance} ${descriptions[scenario]}`, {
    skip: translatorPath === undefined || process.platform !== 'linux', timeout: 45_000,
  }, () => {
    assert.ok(corePath, 'SODS_LINUX_WASM is required for the actual root integration');
    assert.ok(translatorPath, 'an explicitly missing artifact is a failure');
    const target = fileURLToPath(new URL('../../../../target', import.meta.url));
    mkdirSync(target, {recursive: true});
    const directory = mkdtempSync(join(target, 'managed-root-current-'));
    try {
      const source = fileURLToPath(new URL('../../../sods/test/fixtures/managed-open/program.S', import.meta.url));
      const program = join(directory, 'program.elf');
      execFileSync(process.env.SODS_FIXTURE_CC ?? 'musl-gcc', [
        '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', source, '-o', program,
      ], {stdio: 'pipe', timeout: 30_000, env: {...process.env, TMPDIR: directory}});
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--managed-root-child', scenario, program], {
        input: '', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: {...process.env, NODE_NO_WARNINGS: '1'},
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr?.toString());
      const successfulRuns = scenario === 'cancel' ? 3 : 1;
      assert.deepEqual(result.stdout, Buffer.concat(Array.from({length: successfulRuns}, () => Buffer.from([127, 69, 76, 70]))));
      assert.equal(result.stderr.length, 0);
      const report = result.output[3];
      assert.ok(report);
      assert.deepEqual(JSON.parse(report.toString()), {scenario, loads: scenario === 'size' ? 2 : successfulRuns,
        artifacts: scenario === 'invalid' ? 5 : scenario === 'cancel' ? 6 : scenario === 'size' ? 2 : 1,
        workers: scenario === 'size' ? 2 : successfulRuns, runs: successfulRuns,
        lateControls: scenario === 'cancel' ? 2 : 0, retired: true});
      if (scenario === 'lazy') {
        const native = spawnSync(program, [], {input: '', timeout: 10_000});
        assert.equal(native.error, undefined); assert.equal(native.signal, null);
        assert.equal(native.status, result.status, native.stderr.toString());
        assert.deepEqual(native.stdout, result.stdout); assert.deepEqual(native.stderr, result.stderr);
        // Same binary/bytes; native argv[0]/parent directory is its own host
        // fixture path, whereas managed argv[0] is the Rust /bin inventory path.
      }
    } finally { rmSync(directory, {recursive: true, force: true}); }
  });
}
