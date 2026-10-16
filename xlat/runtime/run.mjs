#!/usr/bin/env node
// node runtime/run.mjs PROGRAM.wasm [args...] — run a translated program,
// with stdin/stdout/stderr attached to this process.
import {readFileSync} from 'node:fs';
import {Linux} from './linux.mjs';

const [file, ...args] = process.argv.slice(2);
const started = performance.now();
const module = await WebAssembly.compile(readFileSync(file));
const compiled = performance.now();
let stdin = new Uint8Array(0);
try { if (!process.stdin.isTTY) stdin = readFileSync(0); } catch {}
const linux = await new Linux({
  argv: [file.replace(/\.wasm$/, ''), ...args],
  env: ['HOME=/root', 'PATH=/bin', 'LANG=C.UTF-8'],
  stdin,
  stdout: (b) => process.stdout.write(b),
  stderr: (b) => process.stderr.write(b),
}).load(module);
let code;
try {
  code = linux.run();
} catch (error) {
  if (process.env.XLAT_TRACE) process.stderr.write('recent blocks: ' + linux.recent().join(' ') + '\n');
  throw error;
}
if (process.env.XLAT_TIMING) {
  process.stderr.write(JSON.stringify({compileMs: compiled - started, runMs: performance.now() - compiled, syscalls: linux.syscalls}) + '\n');
}
process.exitCode = code;
