// Build-time cache of the one translation mode used by layers: sods --whole.
// One atomic entry binds source bytes, both translator artifacts and the complete
// fixed invocation contract to checked output bytes. It is not a user disk.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
const hash = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const MAGIC = 'ricebox-aot-v1\n';
const OPTIONS = ['--whole'];

export function translateWhole(sods: string, translator: Uint8Array, input: Uint8Array, cache: string | null): Buffer {
  const executable = resolve(sods), native = hash(readFileSync(executable));
  const key = hash(JSON.stringify({format: 1, input: hash(input), native, translator: hash(translator),
    options: OPTIONS, inputABI: 'x86_64-linux-elf', outputABI: 'sods-wasm', host: [process.platform, process.arch]}));
  const target = cache ? join(cache, `${key}.aot`) : null;
  if (target) {
    try {
      const entry = readFileSync(target), prefix = `${MAGIC}${key}\n`;
      const bytes = entry.subarray(prefix.length + 65);
      if (entry.subarray(0, prefix.length).toString() === prefix && entry[prefix.length + 64] === 10 &&
          entry.subarray(prefix.length, prefix.length + 64).toString() === hash(bytes) && wasm(bytes)) return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const work = mkdtempSync(join(tmpdir(), 'ricebox-aot-'));
  try {
    const elf = join(work, 'in'), output = join(work, 'out.wasm');
    writeFileSync(elf, input);
    execFileSync(executable, [...OPTIONS, elf, output], {stdio: ['ignore', 'ignore', 'inherit']});
    if (hash(readFileSync(executable)) !== native) throw new Error('sods changed during translation; retry the build');
    const bytes = readFileSync(output);
    if (!wasm(bytes)) throw new Error('sods did not produce a WebAssembly module');
    if (target && cache) {
      mkdirSync(cache, {recursive: true});
      const pending = mkdtempSync(join(cache, '.aot-'));
      try {
        const file = join(pending, 'entry');
        writeFileSync(file, Buffer.concat([Buffer.from(`${MAGIC}${key}\n${hash(bytes)}\n`), bytes]), {mode: 0o600});
        // Same-filesystem rename: concurrent readers see a complete old or new entry.
        renameSync(file, target);
      } finally { rmSync(pending, {recursive: true, force: true}); }
    }
    return bytes;
  } finally { rmSync(work, {recursive: true, force: true}); }
}
function wasm(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
}
