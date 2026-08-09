#!/usr/bin/env node

// Run the extracted YoWASP LLVM core through Node's standard WASI Preview 1
// implementation.  This file deliberately does not import @yowasp/clang or
// any of its generated JavaScript adapters.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { WASI } from 'node:wasi';

function usage() {
  console.error(
    'usage: node run_compiler_core.mjs CORE.wasm ROOT SOURCE.c OUTPUT.wasm [clang flags...]',
  );
  process.exit(2);
}

if (process.argv.length < 6) usage();

const [, , coreArg, rootArg, sourceArg, outputArg, ...extraFlags] = process.argv;
const root = resolve(rootArg);
const work = join(root, 'work');
const source = resolve(sourceArg);
const output = resolve(outputArg);
const virtualSource = `/work/${basename(source)}`;
const virtualOutput = `/work/${basename(output)}`;

mkdirSync(work, { recursive: true });
mkdirSync(join(root, 'tmp'), { recursive: true });
writeFileSync(join(work, basename(source)), readFileSync(source));

const module = await WebAssembly.compile(readFileSync(resolve(coreArg)));
let invocation = 0;

async function runCore(args) {
  const tag = `${process.pid}-${invocation++}`;
  const stdoutPath = join(work, `.compiler-${tag}.stdout`);
  const stderrPath = join(work, `.compiler-${tag}.stderr`);
  const stdout = openSync(stdoutPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  let status;
  try {
    const wasi = new WASI({
      version: 'preview1',
      args,
      env: { PATH: '/usr/bin', PWD: '/work' },
      preopens: { '/': root },
      stdout,
      stderr,
      returnOnExit: true,
    });
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    status = wasi.start(instance);
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  const captured = {
    status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
  unlinkSync(stdoutPath);
  unlinkSync(stderrPath);
  return captured;
}

// A Clang driver cannot spawn child processes in WASI.  Ask it for the exact
// cc1 and linker commands, then execute those commands with fresh instances of
// the same multi-call compiler module.
function parseCommands(text) {
  const commands = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(' "')) continue;
    const command = Array.from(
      line.matchAll(/ (?:([^ "\n]+)|"((?:[^"\\$]|\\["\\$])*)")/g),
      (match) => match[1] ?? match[2].replaceAll(/\\["$\\]/g, (item) => item[1]),
    );
    if (command.length) commands.push(command);
  }
  return commands;
}

const flags = [
  '-std=gnu11',
  '-ffreestanding',
  '-O2',
  '-nostdlib',
  '-Wl,--no-entry',
  '-Wl,--export-all',
  '-Wl,--allow-undefined',
  ...extraFlags,
  '-o',
  virtualOutput,
  virtualSource,
];

const plan = await runCore(['clang', '-###', ...flags]);
if (plan.status !== 0) {
  process.stderr.write(plan.stdout + plan.stderr);
  process.exit(plan.status);
}
const commands = parseCommands(plan.stdout + plan.stderr);
if (!commands.length) {
  process.stderr.write(plan.stdout + plan.stderr);
  throw new Error('clang produced no executable cc1/linker commands');
}

for (const command of commands) {
  const result = await runCore(command);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, readFileSync(join(work, basename(output))));
console.log(`compiler core wrote ${output}`);
