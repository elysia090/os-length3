// l3: the one thing the Prompt depends on. It carries the distribution's
// root (BusyBox from the distribution's pinned source and config, its /etc),
// the l3 command, and the xlat translator with each program's translation
// made ahead of time, in one gzip'd file named by its digest in l3.json, so
// one verified download (resumable through a proxy that cuts it) is all a
// Prompt needs. It is served as l3-<digest>.bin: octet-stream is a type no
// server or proxy compresses again (which would make byte offsets not the
// file's, and a cut transfer could not be continued), and a name that is
// its digest can be cached for good.
//
//   node scripts/bundle.mjs STAGE OUT
//
// STAGE holds xlat.wasm, busybox(.wasm), l3(.wasm) and applets (see
// scripts/userland.sh); OUT receives l3-<digest>.bin and l3.json.
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

const [stage, out] = process.argv.slice(2);
if (!stage || !out) { console.error('usage: bundle.mjs STAGE OUT'); process.exit(2); }
const here = fileURLToPath(new URL('..', import.meta.url));
const repo = join(here, '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const env = (file) => Object.fromEntries(readFileSync(file, 'utf8').split('\n')
  .map((l) => /^([A-Z_0-9]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
const crate = (file) => /^version = "(.*)"/m.exec(readFileSync(file, 'utf8'))[1];

const sources = env(join(repo, 'distribution/sources.env'));
const profile = env(join(repo, 'distribution/packaging/profile.env'));
const root = {name: 'OS Length3 Linux', version: profile.DISTRIBUTION_RELEASE_VERSION, profile: profile.DISTRIBUTION_PROFILE_ID};
const applets = readFileSync(join(stage, 'applets'), 'utf8').split('\n').filter((a) => a && a !== 'busybox');

const blobs = [];
let at = 0;
const put = (bytes) => { const p = {at, size: bytes.length}; blobs.push(bytes); at += bytes.length; return p; };
const program = (name, path) => {
  const bytes = readFileSync(join(stage, name));
  const translated = join(stage, `${name}.wasm`);
  return {path, mode: 0o755, sha256: sha(bytes), ...put(bytes), ...(existsSync(translated) ? {translation: put(readFileSync(translated))} : {})};
};
const text = (path, s) => ({path, mode: 0o644, ...put(Buffer.from(s))});

const translator = {name: 'xlat', version: crate(join(repo, 'xlat/Cargo.toml')), ...put(readFileSync(join(stage, 'xlat.wasm')))};
const busybox = program('busybox', '/bin/busybox');
const l3 = program('l3', '/bin/l3');
const files = [busybox, l3,
  // The distribution's accounts and names, as its root has them.
  ...['passwd', 'group', 'hosts'].map((f) => text(`/etc/${f}`, readFileSync(join(repo, 'distribution/config', f), 'utf8'))),
  text('/etc/os-release', [
    `NAME="${root.name}"`, `ID=length3`, `VERSION_ID=${root.version}`, `PRETTY_NAME="${root.name} ${root.version}"`,
    `VARIANT="Prompt"`, `VARIANT_ID=prompt`, `BUILD_ID=${root.profile}`, '']. join('\n'))];

const index = {
  name: 'l3', version: crate(join(here, 'cli/Cargo.toml')), root,
  base: {name: 'BusyBox', version: sources.BUSYBOX_VERSION, from: 'distribution/sources.env', sha256: busybox.sha256, applets: applets.length},
  translator, files, dirs: ['/etc', '/tmp'],
  links: applets.map((a) => ({path: `/bin/${a}`, target: 'busybox'})),
};
const json = Buffer.from(JSON.stringify(index));
const head = Buffer.alloc(12);
head.write('L3BUNDLE', 0, 'latin1');
head.writeUInt32LE(json.length, 8);
const raw = Buffer.concat([head, json, ...blobs]);
const packed = gzipSync(raw, {level: 9});
mkdirSync(out, {recursive: true});
const name = `l3-${sha(packed).slice(0, 16)}.bin`;
// The l3 before this one goes; only its own name is touched.
for (const f of readdirSync(out)) if (/^l3-[0-9a-f]{16}\.bin$|^l3\.bundle$/.test(f) && f !== name) rmSync(join(out, f));
writeFileSync(join(out, name), packed);
const {files: _f, links: _l, dirs: _d, translator: {at: _a, size: _s, ...tool}, ...about} = index;
writeFileSync(join(out, 'l3.json'), `${JSON.stringify({
  ...about, translator: tool, l3: {sha256: l3.sha256},
  bundle: {path: name, size: packed.length, bytes: raw.length, sha256: sha(packed)},
}, null, 2)}\n`);
console.log(`${name} ${packed.length} bytes (${raw.length} unpacked), ${files.length} files, ${applets.length} links`);
