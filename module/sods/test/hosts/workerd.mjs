#!/usr/bin/env node
// Run the execution prerequisites inside an ordinary workerd isolate, not Node or
// a browser Worker. No eval permission, node compatibility or Dynamic Worker is
// enabled. A green result proves the probe ran, NOT that sods runs on Workers.
// Usage: node module/sods/test/hosts/workerd.mjs [path/to/workerd]
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const executable = process.argv[2] || 'workerd';
const directory = mkdtempSync(join(tmpdir(), 'sods-workerd-'));
// (module (func (export "answer") (result i32) i32.const 42))
const wasm = Uint8Array.from([
  0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,
  7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11,
]);
const worker = `import compiled from './answer.wasm';
import bytes from './answer.bin';
const check = async (operation) => {
  try { return {ok: true, result: await operation()}; }
  catch (error) { return {ok: false, name: error.name, message: error.message}; }
};
export default {
  async test() {
    const precompiled = new WebAssembly.Instance(compiled).exports.answer();
    if (precompiled !== 42) throw new Error('Precompiled Wasm did not execute');
    const result = {
      precompiled: {ok: true, result: precompiled},
      // translator.ts loadTranslator(BufferSource), root.ts hot translations.
      compile: await check(async () => (await WebAssembly.instantiate(await WebAssembly.compile(bytes))).exports.answer()),
      // translation/kept.ts taken(), Linux translation miss and incremental code.
      module: await check(() => new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.answer()),
      // linux.ts already selects inline scheduling without shared threads.
      worker: typeof Worker === 'function',
      sharedMemory: typeof SharedArrayBuffer === 'function',
      // host.ts rangeNow(): a lazy file read currently needs synchronous XHR.
      synchronousFetch: typeof XMLHttpRequest === 'function',
    };
    console.log('SODS_WORKERD_CAPABILITIES ' + JSON.stringify(result));
    console.log('Probe only: no Linux program or ricebox session was executed.');
  }
};`;
try {
  writeFileSync(join(directory, 'answer.wasm'), wasm);
  writeFileSync(join(directory, 'probe.js'), worker);
  writeFileSync(join(directory, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "probe", worker = (
  compatibilityDate = "2026-10-01",
  modules = [
    (name = "probe.js", esModule = embed "probe.js"),
    (name = "answer.wasm", wasm = embed "answer.wasm"),
    (name = "answer.bin", data = embed "answer.wasm")
  ]
))]);
`);
  const result = spawnSync(executable, ['test', join(directory, 'config.capnp')], {encoding: 'utf8'});
  if (result.error) throw result.error;
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) process.exitCode = result.status || 1;
  else if (!((result.stdout || '') + (result.stderr || '')).includes('SODS_WORKERD_CAPABILITIES ')) {
    throw new Error('workerd did not run the capability probe');
  }
} finally {
  rmSync(directory, {recursive: true, force: true});
}
