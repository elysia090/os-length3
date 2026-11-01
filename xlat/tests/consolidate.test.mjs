import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Vfs} from '../runtime/fs.mjs';
import {Kernel, PROFILE} from '../runtime/process.mjs';
import {loadTranslator} from '../runtime/translator.mjs';

// tests/c/reexec.c as run.sh builds it (stripped: its first translation cannot see what it calls through pointers),
// here with the counts that say what happened to it: the code it reached later gathered into one module once it ran
// again, memories taken from the processes before (one with its program's read-only bytes in it already), and what
// it printed the same as it printed natively.

const out = new URL('out/', import.meta.url);
const wasm = new URL('../target/wasm32-unknown-unknown/release/xlat.wasm', import.meta.url);
const have = existsSync(new URL('reexec', out)) && existsSync(new URL('reexec.native', out)) && existsSync(wasm);

test('a program run again is one module, on a memory let go of, and says what it said natively', {skip: !have}, async () => {
  const vfs = new Vfs();
  vfs.writeFile('/bin/reexec', readFileSync(new URL('reexec', out)), 0o755);
  let said = '';
  const k = new Kernel({
    vfs, translate: await loadTranslator(readFileSync(wasm)),
    console: {interactive: false, write: (_, b) => { said += new TextDecoder().decode(b); }, read: () => null, ready: () => false},
  });
  const before = {...PROFILE};
  assert.equal(k.spawn('/bin/reexec', ['/bin/reexec', 'a', 'b'], [], '/'), 0);
  assert.equal(said, readFileSync(new URL('reexec.native', out), 'utf8'));
  assert.ok(PROFILE.consolidated > before.consolidated, 'its later code was gathered into one module');
  assert.ok(PROFILE.memoriesReused > before.memoriesReused, 'a process took a memory let go of');
  assert.ok(PROFILE.imagesKept > before.imagesKept, 'one with the program read-only bytes in it already');
});
