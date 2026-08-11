#!/usr/bin/env node
// Exercise the browser compiler's physical-page path against local files.

import { open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
let requests = 0;
let fetchedBytes = 0;
const paths = new Map();

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.protocol !== 'file:') throw new Error(`unexpected URL ${url}`);
  const path = fileURLToPath(url);
  const range = new Headers(options.headers || {}).get('range');
  let bytes;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) return new Response('', { status: 416 });
    const start = Number(match[1]);
    const length = Number(match[2]) - start + 1;
    const handle = await open(path, 'r');
    try {
      bytes = new Uint8Array(length);
      const result = await handle.read(bytes, 0, length, start);
      if (result.bytesRead !== length) throw new Error(`${path}: short range`);
    } finally {
      await handle.close();
    }
    status = 206;
  } else {
    bytes = new Uint8Array(await readFile(path));
  }
  requests += 1;
  fetchedBytes += bytes.length;
  paths.set(path, (paths.get(path) || 0) + 1);
  return new Response(bytes, { status });
};

const driverUrl = new URL('web/drivers/compiler-core.js', root);
const driver = await import(driverUrl.href);
const withHeaders = process.argv.includes('--headers');
const before = process.memoryUsage();
const progress = [];
const started = performance.now();
await driver.init((message) => progress.push(message));
const loaded = performance.now();
const result = await driver.compile([
  '-std=gnu11', '-ffreestanding', '-O2', '-nostdlib',
  '-Wl,--no-entry', '-Wl,--export-all', '-o', 'out.wasm', 'in.c',
], {
  'in.c': withHeaders
    ? '#include <stdint.h>\nuint64_t add7(uint64_t x) { return x + 7u; }\n'
    : 'unsigned add7(unsigned x) { return x + 7u; }\n',
}, (message) => progress.push(message));
const finished = performance.now();
const after = process.memoryUsage();

console.log(JSON.stringify({
  ok: result.status === 0 && Boolean(result.files['out.wasm']),
  source: withHeaders ? 'stdint' : 'freestanding',
  outputBytes: result.files['out.wasm']?.length || 0,
  requests,
  fetchedBytes,
  paths: Object.fromEntries(Array.from(paths, ([path, count]) => [
    path.slice(fileURLToPath(root).length), count,
  ])),
  loadMs: loaded - started,
  compileMs: finished - loaded,
  memory: {
    rssBefore: before.rss,
    rssAfter: after.rss,
    arrayBuffersBefore: before.arrayBuffers,
    arrayBuffersAfter: after.arrayBuffers,
  },
  progress,
  physical: result.physical,
}, null, 2));
