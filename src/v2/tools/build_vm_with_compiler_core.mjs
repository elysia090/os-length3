#!/usr/bin/env node

// Rebuild vm.wasm with the same content-addressed compiler used by the page.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [sourceArg, outputArg, artifactRoot = 'http://127.0.0.1:8000/artifact/'] =
  process.argv.slice(2);
if (!sourceArg || !outputArg) {
  throw new Error(
    'usage: build_vm_with_compiler_core.mjs VM_C OUTPUT_WASM [ARTIFACT_ROOT]',
  );
}

globalThis.QM_ARTIFACT_ROOT = artifactRoot;
const { compile } = await import('../web/drivers/compiler-core.js');
const source = readFileSync(resolve(sourceArg), 'utf8');
const result = await compile([
  '--target=wasm32',
  '-O2',
  '-ffreestanding',
  '-nostdlib',
  '-Wl,--no-entry',
  '-Wl,--export-dynamic',
  '-Wl,--initial-memory=33554432',
  '-Wall',
  '-Wextra',
  '-o',
  'vm.wasm',
  'vm.c',
], { 'vm.c': source }, (message) => process.stderr.write(`${message}\n`));
if (result.status !== 0 || !result.files['vm.wasm']) {
  process.stderr.write(result.stderr || 'compiler produced no vm.wasm\n');
  process.exit(result.status || 1);
}
if (result.stderr.trim()) {
  process.stderr.write(result.stderr);
  process.exit(1);
}
writeFileSync(resolve(outputArg), result.files['vm.wasm']);
process.stdout.write(
  `compiler core wrote ${outputArg} (${result.files['vm.wasm'].length} bytes)\n`,
);
