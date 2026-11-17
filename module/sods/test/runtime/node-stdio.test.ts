import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const adapter = new URL('../../runtime/host/node/stdio.ts', import.meta.url).href;
function child(source: string, input: Uint8Array) {
  const directory = mkdtempSync(join(tmpdir(), 'sods-stdio-'));
  const descriptors: number[] = [];
  try {
    writeFileSync(join(directory, 'input'), input);
    for (const [name, mode] of [['input', 'r'], ['output', 'w+'], ['error', 'w+']] as const) descriptors.push(openSync(join(directory, name), mode));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import {captureStdio} from ${JSON.stringify(adapter)}; const transfer=(io, endpoint, bytes)=>{ io.prepareView(bytes); return io.transfer(endpoint,bytes); }; ${source}`], {
      stdio: descriptors as [number, number, number], timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, readFileSync(join(directory, 'error'), 'utf8'));
    return {out: readFileSync(join(directory, 'output')), err: readFileSync(join(directory, 'error'))};
  } finally {
    for (const fd of descriptors) closeSync(fd);
    rmSync(directory, {recursive: true, force: true});
  }
}

test('borrowed stdio uses SAB views, exact prefixes and EOF without closing descriptors', {skip: process.platform !== 'linux'}, () => {
  const result = child(`
    const io = captureStdio(), bytes = new Uint8Array(new SharedArrayBuffer(8));
    assert.deepEqual(transfer(io, 1, bytes.subarray(0, 4)), {kind:'count',count:4});
    assert.deepEqual(transfer(io, 2, bytes.subarray(0, 4)), {kind:'count',count:4});
    assert.deepEqual(transfer(io, 1, bytes.subarray(0, 4)), {kind:'count',count:2});
    assert.deepEqual(transfer(io, 3, bytes.subarray(0, 2)), {kind:'count',count:2});
    assert.deepEqual(transfer(io, 1, bytes), {kind:'count',count:0});
    assert.throws(() => transfer(io, 4, bytes), /Unknown standard endpoint/);
    const {writeSync} = await import('node:fs');
    assert.equal(writeSync(1, new Uint8Array([33])), 1);
  `, new TextEncoder().encode('abcdef'));
  assert.equal(result.out.toString(), 'abcd!');
  assert.equal(result.err.toString(), 'ef');
});

test('native bad descriptor is known-zero and no adapter retry occurs', {skip: process.platform !== 'linux'}, () => {
  child(`
    const io = captureStdio();
    const {closeSync} = await import('node:fs');
    closeSync(0);
    const bytes = new Uint8Array([5,6,7]);
    assert.deepEqual(transfer(io, 1, bytes), {kind:'zero',code:'EBADF'});
    assert.deepEqual(Array.from(bytes), [5,6,7]);
  `, new Uint8Array());
});


test('prepared private view avoids mutable byteLength prototype callbacks', {skip: process.platform !== 'linux'}, () => {
  child(`
    const io = captureStdio(), bytes = new Uint8Array(new SharedArrayBuffer(3));
    io.prepareView(bytes);
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    const names = ['byteLength', 'byteOffset', 'buffer', 'length'];
    const originals = names.map(name => [name, Object.getOwnPropertyDescriptor(prototype, name)]);
    let called = false;
    for (const name of names) Object.defineProperty(prototype, name, {get() { called = true; throw new Error('unexpected callback'); }, configurable:true});
    let receipt;
    try { receipt = io.transfer(1, bytes); }
    finally { for (const [name, original] of originals) Object.defineProperty(prototype, name, original); }
    assert.equal(called, false);
    assert.deepEqual(receipt, {kind:'count',count:3});
    assert.deepEqual(Array.from(bytes), [97,98,99]);
  `, new TextEncoder().encode('abc'));
});

test('TTY admission is rejected before any stream operation', {skip: process.platform !== 'linux'}, t => {
  let tty: number;
  try { tty = openSync('/dev/ptmx', 'r+'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') { t.skip('No accessible PTY master'); return; }
    throw error;
  }
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {captureStdio} from ${JSON.stringify(adapter)};
      assert.throws(() => captureStdio(), /does not support TTYs/);
    `], {stdio: [tty, 'pipe', 'pipe'], timeout: 10000});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.toString());
  } finally { closeSync(tty); }
});

test('unclassified native failure stays Unknown, rather than fabricated zero', {skip: process.platform !== 'linux'}, t => {
  let full: number;
  try { full = openSync('/dev/full', 'w'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') { t.skip('No accessible full device'); return; }
    throw error;
  }
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {captureStdio} from ${JSON.stringify(adapter)};
      const io = captureStdio(), bytes = new Uint8Array([1]);
      io.prepareView(bytes);
      const result = io.transfer(2, bytes);
      assert.equal(result.kind, 'unknown');
      assert.equal(result.error.code, 'ENOSPC');
    `], {stdio: ['ignore', full, 'pipe'], timeout: 10000});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.toString());
  } finally { closeSync(full); }
});
