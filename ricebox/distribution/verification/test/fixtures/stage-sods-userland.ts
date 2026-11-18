// Stage test inputs from a prepared distribution. Never modify the release.
import {existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDistribution} from '../../../deployment/local.ts';
import {canonicalExecutableSource} from '../../../format/executable-source.ts';
import {sha256} from '../../../host/node/hash.ts';

export function stageSodsUserland(web: string, destination: string) {
  const out = resolve(destination);
  if (existsSync(out)) throw new Error(`Sods userland fixture already exists: ${out}`);
  const release = openDistribution(web);
  try {
    const translations = release.index.translations.filter(t => t.path === '/usr/bin/busybox');
    if (translations.length !== 1) throw new Error('Expected one BusyBox translation in the release');
    const translation = translations[0];
    const source = canonicalExecutableSource(release.index, translation);
    const elf = release.blob(translation.elf), wasm = release.blob(translation.wasm);
    const translator = release.blob(release.index.translator);
    if (sha256(elf) !== source.sha256 || sha256(translator) !== release.index.translator.wasm) {
      throw new Error('Sods userland does not match its release identity');
    }

    mkdirSync(dirname(out), {recursive: true});
    const stage = mkdtempSync(join(dirname(out), '.sods-userland-'));
    try {
      writeFileSync(join(stage, 'busybox'), elf, {mode: 0o755});
      writeFileSync(join(stage, 'busybox.wasm'), wasm);
      writeFileSync(join(stage, 'sods.wasm'), translator);
      renameSync(stage, out);
    } finally { rmSync(stage, {recursive: true, force: true}); }
  } finally { release.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , web, out, ...extra] = process.argv;
  if (!web || !out || extra.length) throw new Error('Usage: stage-sods-userland.ts WEB_ROOT NEW_FIXTURE_DIR');
  stageSodsUserland(web, out);
}
