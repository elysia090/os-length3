import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runOwnedStdoutProgram, type OwnedStdoutPin} from '../../runtime/host/node/run.ts';
import {memoryHost} from '../../runtime/linux/memory-host.ts';

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
    assert.throws(() => memoryHost(module, 1, 1), /owned stdout is not this admission role/);
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
