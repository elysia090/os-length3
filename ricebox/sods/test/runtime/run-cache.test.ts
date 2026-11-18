import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {nativeTranslator, translatorWasm} from '../fixtures/runtime.ts';

const runner = fileURLToPath(new URL('../../runtime/run.ts', import.meta.url));
const execute = promisify(execFile);
const ready = process.platform === 'linux' && process.arch === 'x64' && existsSync(nativeTranslator) && existsSync(translatorWasm);

test('two runners never expose an in-progress native translation', {timeout: 20_000, skip: !ready && 'needs the built Sods translators on x86-64 Linux'}, async t => {
  const work = mkdtempSync(join(tmpdir(), 'sods-run-cache-'));
  const native = join(work, 'sods'), elf = join(work, 'guest'), assembly = join(work, 'guest.s');
  const elected = join(work, 'leader'), partial = join(work, 'partial'), release = join(work, 'release');
  t.after(() => rmSync(work, {recursive: true, force: true}));
  writeFileSync(assembly, '.globl _start\n.text\n_start: mov $60,%eax\nxor %edi,%edi\nsyscall\n');
  execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none', assembly, '-o', elf]);
  writeFileSync(native, `#!${process.execPath}
const {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync}=require('node:fs');
const {execFileSync}=require('node:child_process');
const inputs=process.argv.slice(2), output=inputs.pop(), own=output+'.full';
execFileSync(${JSON.stringify(nativeTranslator)},[...inputs,own]);
const bytes=readFileSync(own); rmSync(own);
let first=true;
try { mkdirSync(${JSON.stringify(elected)}); } catch (error) { if (error.code!=='EEXIST') throw error; first=false; }
if (first) {
  writeFileSync(output,bytes.subarray(0,4)); writeFileSync(${JSON.stringify(partial)},'');
  const sleep=new Int32Array(new SharedArrayBuffer(4));
  for (let i=0; i<200 && !existsSync(${JSON.stringify(release)}); i++) Atomics.wait(sleep,0,0,50);
}
writeFileSync(output,bytes);
`);
  chmodSync(native, 0o755);
  const env = {...process.env, CARGO_TARGET_DIR: work, SODS_NATIVE: native, SODS_TRANSLATOR_WASM: translatorWasm,
    SODS_INLINE: '1', SODS_RUN: '3', SODS_BLOCKS: '', SODS_TIMING: ''};
  const run = () => execute(process.execPath, [runner, elf], {env, timeout: 12_000}).then(
    result => ({ok: true, stderr: result.stderr}), error => ({ok: false, stderr: String(error.stderr || error)}));
  const first = run();
  let original: Awaited<ReturnType<typeof run>>, second: Awaited<ReturnType<typeof run>>;
  try {
    for (let i = 0; i < 100 && !existsSync(partial); i++) await delay(30);
    assert.ok(existsSync(partial), 'first translator reached the controlled partial write');
    second = await run();
  } finally {
    try { writeFileSync(release, ''); }
    finally { original = await first; }
  }
  assert.equal(original.ok, true, original.stderr);
  assert.equal(second.ok, true, second.stderr);
  const cache = join(work, 'sods-run-cache'), [translator] = readdirSync(cache);
  const files = readdirSync(join(cache, translator));
  assert.equal(files.length, 1, 'both calls publish the same cache identity');
  assert.match(files[0], /^[a-f0-9]{64}\.wasm$/);
});
