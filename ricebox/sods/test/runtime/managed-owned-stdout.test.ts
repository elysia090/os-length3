import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runOwnedStdoutProgram, runOwnedStdoutRoot, type OwnedStdoutPin} from '../../runtime/host/node/run.ts';
import {memoryHost, type RootSourceTransport} from '../../runtime/linux/memory-host.ts';
import {loadTranslator} from '../../runtime/translation/translator.ts';

const ownedPath = process.env.SODS_OWNED_STDOUT_WASM;
const translatorPath = process.env.SODS_CURRENT_TRANSLATOR_WASM;
const skip = process.platform === 'linux' && process.arch === 'x64' && ownedPath && translatorPath ? false
  : 'Requires explicit pinned owned stdout Core/current translator artifacts and Linux x86-64 fixture compiler';
const pinForNegativeControl = (bytes: Uint8Array): OwnedStdoutPin => ({kind: 'sods-linux-owned-stdout-v1',
  byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex')});

function buildProgram(directory: string): string {
  const program = join(directory, 'owned.elf');
  const fixture = fileURLToPath(new URL('../fixtures/managed-sendfile/captured-order.S', import.meta.url));
  execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-DSODS_OWNED_STDOUT_ONLY',
    '-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', '-Wl,-e,_start', fixture, '-o', program],
    {stdio: 'pipe', timeout: 30_000});
  return program;
}

test('pinned non-probe owned stdout runs the actual Worker synchronously without lending stdin/stderr', {skip, timeout: 30_000}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sods-owned-stdout-'));
  try {
    const candidate = readFileSync(ownedPath!), translator = new WebAssembly.Module(readFileSync(translatorPath!));
    const pin: OwnedStdoutPin = {kind: 'sods-linux-owned-stdout-v1', byteLength: Number(process.env.SODS_OWNED_STDOUT_BYTES),
      sha256: process.env.SODS_OWNED_STDOUT_SHA256!};
    const module = new WebAssembly.Module(candidate);
    assert.throws(() => memoryHost(module, 1, 1), /Owned stdout artifact requires owned-stdout admission/);
    const exports = WebAssembly.Module.exports(module).map(v => v.name);
    for (const name of ['linux_startup_begin_stdio', 'linux_sendfile_cap_start', 'linux_sendfile_cap_finish', 'linux_sendfile_probe']) {
      assert.ok(!exports.includes(name), name);
    }

    const program = buildProgram(directory), output = join(directory, 'output'), next = join(directory, 'next');

    await assert.rejects(runOwnedStdoutProgram(program, [], translator, output, candidate, {...pin, sha256: '0'.repeat(64)}), /digest mismatch/);
    assert.equal(existsSync(output), false);
    for (const otherPath of [process.env.SODS_LINUX_WASM, process.env.SODS_CAPTURE_RESULT_WASM, process.env.SODS_QUEUED_WORKER_PROBE_WASM]) {
      if (!otherPath) continue;
      const other = readFileSync(otherPath);
      // A correct digest for the wrong role still cannot create a File.
      await assert.rejects(runOwnedStdoutProgram(program, [], translator, output, other, pinForNegativeControl(other)),
        /admission module|artifact identity|Synthetic sendfile probe/);
      assert.equal(existsSync(output), false);
    }

    const existing = join(directory, 'existing'), link = join(directory, 'link');
    writeFileSync(existing, 'preserve'); symlinkSync(existing, link);
    for (const path of [existing, link]) {
      await assert.rejects(runOwnedStdoutProgram(program, [], translator, path, candidate, pin), {code: 'EEXIST'});
      assert.equal(readFileSync(existing, 'utf8'), 'preserve');
    }

    let first: Promise<number> | undefined;
    const reentrantPin = {...pin, get sha256() {
      const result = first = runOwnedStdoutProgram(program, [], translator, output, candidate, pin);
      void result.catch(() => {}); // Keep it observed if an outer assertion fails.
      return pin.sha256;
    }};
    // The outer call initially sees a free owner, but pin reading starts an
    // inner valid run. Only the latter can acquire a File.
    await assert.rejects(runOwnedStdoutProgram(program, [], translator, next, candidate, reentrantPin), /already running/);
    await assert.rejects(runOwnedStdoutProgram(program, [], translator, next, candidate, pin), /already running/);
    assert.equal(existsSync(next), false);
    assert.equal(await first, 42, 'guest checked missing stdio, all returned counts and original source cursor');
    assert.deepEqual(readFileSync(output), Buffer.from([65, 127, 67]));
    assert.equal(await runOwnedStdoutProgram(program, [], translator, next, candidate, pin), 42);
    assert.deepEqual(readFileSync(next), Buffer.from([65, 127, 67]));
    for (const fd of readdirSync('/proc/self/fd')) {
      let path: string;
      try { path = readlinkSync(`/proc/self/fd/${fd}`); } catch { continue; }
      assert.ok(path !== output && path !== next, 'observed retirement released the physical File');
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

// Independent, single-pack prepared-root fixture. The installed image uses AOT
// while self-open still sees a cold strictly sized source in the Rust catalog.
const guestPath = new TextEncoder().encode('/bin/owned.elf');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
function coldWire(elf: Uint8Array, prepared: Uint8Array, translator: Uint8Array) {
  const dir = new TextEncoder().encode('/bin');
  const out = new Uint8Array(72 + 40 + 8 + dir.length + 40 + guestPath.length + 104 + guestPath.length);
  const view = new DataView(out.buffer);
  let at = 0;
  const bytes = (b: Uint8Array) => { out.set(b, at); at += b.length; };
  const u32 = (n: number) => { view.setUint32(at, n, true); at += 4; };
  const u64 = (n: number) => { view.setBigUint64(at, BigInt(n), true); at += 8; };
  const content = sha(elf), image = sha(prepared), generation = sha(new Uint8Array([42])), translatorSha = sha(translator);
  bytes(new TextEncoder().encode('SODSROOT')); u32(1); u32(0); bytes(generation);
  u32(1); u32(1); u32(0); u32(1); u32(1); u32(0);
  bytes(content); u64(elf.length);
  u32(dir.length); u32(0o755); bytes(dir);
  u32(guestPath.length); u32(0o755); u64(elf.length);
  u32(0); u32(1); u64(0); u64(elf.length); bytes(guestPath);
  u32(guestPath.length); u32(1); bytes(content); bytes(image); bytes(translatorSha); bytes(guestPath);
  assert.equal(at, out.length);
  return {out, generation, image, content, translatorSha};
}

test('the selected owned host loads a cold sealed source once; bad or stopped delivery cannot write',
  {skip, timeout: 30_000}, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sods-owned-cold-'));
    try {
      const candidate = readFileSync(ownedPath!), translatorBytes = readFileSync(translatorPath!);
      const pin: OwnedStdoutPin = {kind: 'sods-linux-owned-stdout-v1', byteLength: Number(process.env.SODS_OWNED_STDOUT_BYTES),
        sha256: process.env.SODS_OWNED_STDOUT_SHA256!};
      const elf = new Uint8Array(readFileSync(buildProgram(directory)));
      const translator = await loadTranslator(translatorBytes), translated = translator.whole(elf);
      const {out: wire, generation, image, content, translatorSha} = coldWire(elf, translated, translatorBytes);
      const limits = {inodes: 3, entries: 2, fileBytes: elf.length, tables: 1, descriptions: 8, slots: 8,
        reads: 1, contexts: 2, views: 1, holds: 24, policy: {noExec: false, noSuid: false, noSymfollow: false}};
      for (const mode of ['success', 'transport', 'length', 'shared', 'stopped-load', 'stopped-offer', 'mutated-after-stage', 'recovery'] as const) {
        const output = join(directory, mode), stop = new AbortController();
        const ready = Promise.withResolvers<void>(), blocked = Promise.withResolvers<Uint8Array>();
        let reads = 0, artifacts = 0;
        const transport: RootSourceTransport = locator => {
          reads++;
          assert.ok(Object.isFrozen(locator));
          assert.deepEqual(locator, {pack: 0, at: 0, stored: elf.length, size: elf.length, raw: true});
          assert.deepEqual(readFileSync(output), Buffer.from('A'), 'no preload during AOT startup and no send before delivery');
          if (mode === 'transport') throw new Error('Trusted source transport failed');
          if (mode === 'length') return elf.subarray(1);
          if (mode === 'shared') {
            const shared = new Uint8Array(new SharedArrayBuffer(elf.length)); shared.set(elf);
            return shared;
          }
          if (mode.startsWith('stopped-') || mode === 'mutated-after-stage') { ready.resolve(); return blocked.promise; }
          return elf;
        };
        const running = runOwnedStdoutRoot({wire, limits, fdLimit: 8, path: guestPath, argv: [guestPath], env: [],
          options: {random: new Uint8Array(16), preparedArtifact: request => {
            artifacts++;
            assert.deepEqual([request.rootGeneration, request.sourceSha256, request.artifactSha256, request.translatorSha256],
              [generation, content, image, translatorSha].map(entry => entry.toString('hex')));
            assert.equal(reads, 0);
            return translated;
          }}, readSource: transport, stop: stop.signal}, output, candidate, pin);
        void running.catch(() => {});
        if (mode === 'stopped-load' || mode === 'stopped-offer') {
          await Promise.race([ready.promise, running.then(() => assert.fail('guest did not wait for its cold source'))]);
          if (mode === 'stopped-load') { stop.abort(); blocked.resolve(elf); }
          else {
            // Delivery resumes first; the queued stop beats physical dispatch
            // from that already prepared offer on the following continuation.
            blocked.resolve(elf);
            queueMicrotask(() => stop.abort());
          }
          await assert.rejects(running);
        } else if (mode === 'mutated-after-stage') {
          await Promise.race([ready.promise, running.then(() => assert.fail('guest did not wait for its cold source'))]);
          const delivery = new Uint8Array(elf);
          blocked.resolve(delivery);
          queueMicrotask(() => delivery.fill(0));
          assert.equal(await running, 42, 'staging is already Rust-owned before the delivery buffer can change');
        } else if (mode === 'transport') await assert.rejects(running, /Trusted source transport failed/);
        else if (mode === 'length') await assert.rejects(running, /wrong decoded size/);
        else if (mode === 'shared') await assert.rejects(running, TypeError);
        else assert.equal(await running, 42, 'later read reuses the source and validates the committed cursor');
        assert.deepEqual([artifacts, reads], [1, 1], 'one artifact and at most one exact source attempt');
        assert.deepEqual(readFileSync(output), ['success', 'recovery', 'mutated-after-stage'].includes(mode) ? Buffer.from([65, 127, 67]) : Buffer.from('A'));
        for (const fd of readdirSync('/proc/self/fd')) {
          let path: string;
          try { path = readlinkSync('/proc/self/fd/' + fd); } catch { continue; }
          assert.notEqual(path, output, 'settled absent effect does not quarantine this File');
        }
      }
    } finally { rmSync(directory, {recursive: true, force: true}); }
  });

// Separate process: an unresolved native owner is intentionally not reused.
// A real file-size limit allows A but makes the next physical call throw EFBIG,
// which is outside the reviewed known-zero contract for this adapter.
const limitedSkip = skip || (spawnSync('prlimit', ['--version']).status !== 0 ? 'Requires Linux prlimit' : false);
test('a real unclassified owned output error retains the exact File and forbids another allocation', {skip: limitedSkip, timeout: 30_000}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'sods-owned-limit-'));
  try {
    const program = buildProgram(directory), output = join(directory, 'limited'), other = join(directory, 'unexpected');
    const entry = new URL('../../runtime/host/node/run.ts', import.meta.url).href;
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
const [entry, program, output, other, owned, source] = process.argv.slice(2);
const {runOwnedStdoutProgram} = await import(entry);
process.on('SIGXFSZ', () => {});
const bytes = fs.readFileSync(owned), translator = new WebAssembly.Module(fs.readFileSync(source));
const pin = {kind: 'sods-linux-owned-stdout-v1', byteLength: Number(process.env.SODS_OWNED_STDOUT_BYTES),
  sha256: process.env.SODS_OWNED_STDOUT_SHA256};
await assert.rejects(runOwnedStdoutProgram(program, [], translator, output, bytes, pin), error =>
  error instanceof AggregateError && error.errors.some(e => e.code === 'EFBIG') &&
  error.errors.some(e => /retirement remains unconfirmed/.test(e.message)));
assert.deepEqual(fs.readFileSync(output), Buffer.from('A'));
assert.ok(fs.readdirSync('/proc/self/fd').some(fd => {
  try { return fs.readlinkSync('/proc/self/fd/' + fd) === output; } catch { return false; }
}), 'the exact physical File was not closed');
await assert.rejects(runOwnedStdoutProgram(program, [], translator, other, bytes, pin), /remains unconfirmed/);
assert.equal(fs.existsSync(other), false);
`;
    // A script file avoids carrying --input-type into the real Worker.
    const scriptPath = join(directory, 'limit.ts');
    writeFileSync(scriptPath, script);
    execFileSync('prlimit', ['--fsize=1:1', '--', process.execPath, scriptPath,
      entry, program, output, other, ownedPath!, translatorPath!], {stdio: 'pipe', timeout: 20_000});
    assert.deepEqual(readFileSync(output), Buffer.from('A'));
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
