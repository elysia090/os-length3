#!/usr/bin/env node
// Exercise the browser's lazy outer-bundle -> native-machine admission path.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';


const [rawIndex] = process.argv.slice(2);
if (!rawIndex) {
  throw new Error('usage: inspect_native_x86_delivery.mjs ARTIFACT_INDEX');
}
const indexPath = resolve(rawIndex);
const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
const delivery = index.deliveries?.[index.preferred];
if (!delivery) throw new Error('artifact index has no preferred delivery');
const root = new URL('../web/', import.meta.url);
const { openPageBundle } = await import(new URL('page-fabric.js', root));
const { openNativeX86Artifact } = await import(
  new URL('x86-machine.js', root)
);
const wire = new Uint8Array(readFileSync(resolve(dirname(indexPath), delivery.file)));
const outer = await openPageBundle({
  blob: new Blob([wire]),
  prefixBytes: delivery.prefix_bytes,
  prefixSha256: delivery.prefix_sha256,
  objectSha256: index.identity.digest,
  wavePages: 4,
  cachePages: 16,
});
const machine = await openNativeX86Artifact(outer);
const record = await machine.blocks.read(machine.state.rip);
if (!(record instanceof Uint8Array) || record.length < 64) {
  throw new Error('initial native x86 execution record is unavailable');
}
process.stdout.write(`${JSON.stringify({
  initialRip: machine.state.rip.toString(16).padStart(16, '0'),
  initialRecordBytes: record.length,
  machine: machine.layout(),
  delivery: outer.layout(),
}, null, 2)}\n`);
machine.release();
outer.release();
