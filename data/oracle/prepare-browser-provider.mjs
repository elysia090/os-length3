// Generated diagnostic artifacts, not a Linux delivery catalog or UI build.
import { readFile, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const [provider, records] = process.argv.slice(2);
if (!provider || !records) throw new Error('usage: node prepare-browser-provider.mjs VM.WASM NATIVE-MEMORY-RECORDS');
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/v2/vm/check/browser/generated');
const meta = JSON.parse(await readFile(resolve(records, 'memory-0.json'), 'utf8'));
if (meta.bytes !== 8 || meta.access !== 1 || meta.prefixEntry !== meta.entry || meta.returning || !meta.sourceBytes)
  throw new Error('expected the actual native MOV rax,[rdi] fixture');
await mkdir(output, { recursive: true });
const inputs = {
  'vm.wasm': provider, 'cut.wasm': resolve(records, 'memory-0.wasm'),
  'cases.bin': resolve(records, 'memory-0.cases'), 'cut.json': resolve(records, 'memory-0.json'),
  'source-page.bin': resolve(records, 'memory-0.source-page'),
};
const files = {};
for (const [name, source] of Object.entries(inputs)) {
  const bytes = await readFile(source);
  files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await copyFile(source, resolve(output, name));
}
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({
  format: 'c-provider-diagnostic-v2', linuxBoot: 'not-tested', files,
}) + '\n');
console.log(`Prepared actual C-Wasm diagnostic: ${output}; no Linux boot claim`);
