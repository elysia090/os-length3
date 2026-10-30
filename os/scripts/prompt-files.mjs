// l3 for the browser's Prompt (public/l3), taken from the release of the
// newest l3 this tree pins: the same root the desktop app installs, as the browser reads it
// (scripts/l3.mjs). It is made where Rust is, by the release
// (.github/workflows/release.yml), and is the OS that version is; a build
// that only has Node (Cloudflare's Workers Builds) takes it from it, and
// takes only the l3 this tree pins: core/src/root.rs
// RELEASES, whose entry is the whole of l3's pin (the root, by sha256, and
// `web`, the sha256 of the index the browser reads it by). The release's
// SHA256SUMS must say the same of the file it is in; l3.json must name that
// root and that index; the index must be that digest, and every pack and
// blob it names the digest its name is. Anything else is refused, and
// nothing is put in public/l3. Shipping a newer Prompt is releasing it (a
// new version in RELEASE): the release proposes the entry it pinned to main.
//
//   node scripts/prompt-files.mjs
//
// The repository is public: each file is taken from the release's own
// download link, which anyone may read (LENGTH3_RELEASES: where releases are
// downloaded from, for a test; GITHUB_REPOSITORY names the repository when it
// is not this one).

import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pinnedRoots} from '../service/releases.ts';
import {tarMembers} from './l3-tree.mjs';

const here = new URL('..', import.meta.url).pathname;
const repo = process.env.GITHUB_REPOSITORY || 'elysia090/os-length3';
const releases = process.env.LENGTH3_RELEASES || `https://github.com/${repo}/releases/download`;
// The pin this tree has comes first: without one, nothing is fetched or taken.
const pin = pinnedRoots(readFileSync(join(here, 'core/src/root.rs'), 'utf8'))[0];
if (!pin) throw new Error('core/src/root.rs pins no l3: release one, and merge the change it proposes');
const {version, tag} = pin;
const asset = `os-length3-linux-${version}-l3-web.tar`;
if (!/^[0-9a-f]{64}$/.test(pin.web)) throw new Error(`core/src/root.rs pins l3 ${version}'s root but no index for the web (web: "${pin.web}"): a release since l3.mjs pins both`);

const sha = (b) => createHash('sha256').update(b).digest('hex');
/** One of the release's files, from its download link. Never waited on for good (a download that stalls holds the
 * build until it is killed): ten minutes, its body included. */
const file = async (name) => {
  const r = await fetch(`${releases}/${tag}/${name}`, {headers: {'user-agent': 'length3-build'}, signal: AbortSignal.timeout(10 * 60_000)});
  if (!r.ok) throw new Error(`${name} of ${tag}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

const sums = (await file('SHA256SUMS')).toString('utf8');
const listed = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === asset)?.[0];
const tar = await file(asset);
if (!listed || listed !== sha(tar)) throw new Error(`${asset}: sha256 ${sha(tar)}; SHA256SUMS of ${tag} says ${listed ?? 'nothing'}`);

// Only what l3 is made of comes out of it: l3.json, its index, packs and blobs, each by a name it may have.
const NAMES = /^(l3\.json|index-[0-9a-f]{64}\.json|packs\/[0-9a-f]{64}\.pack|blobs\/[0-9a-f]{64}\.bin)$/;
const members = new Map();
for await (const m of tarMembers(Readable.from([tar]))) {
  const name = m.name.replace(/^\.\//, '');
  if (m.kind === '5' && /^(\.|packs|blobs)?\/?$/.test(name)) continue;
  if (m.kind !== '0' || !NAMES.test(name)) throw new Error(`${asset}: ${m.name} is not part of l3 for the web`);
  members.set(name, m.bytes);
}
const about = JSON.parse(members.get('l3.json')?.toString('utf8') ?? 'null');
if (!about) throw new Error(`${asset} has no l3.json`);
if (about.version !== version || about.sha256 !== pin.sha256) throw new Error(`${asset}: l3.json is l3 ${about.version} from root ${about.sha256}; this tree pins ${version} from ${pin.sha256}`);
if (about.index?.sha256 !== pin.web) throw new Error(`${asset}: l3.json names index ${about.index?.sha256}; this tree pins ${pin.web}`);
const indexBytes = members.get(about.index.path);
if (!indexBytes || sha(indexBytes) !== pin.web) throw new Error(`${asset}: ${about.index.path} is not the index this tree pins (${pin.web})`);
const index = JSON.parse(indexBytes.toString('utf8'));
if (index.sha256 !== pin.sha256 || index.version !== version) throw new Error(`${asset}: its index is of root ${index.sha256} ${index.version}`);
const named = [...index.packs.map((p) => [`packs/${p.name}`, p.name.slice(0, 64)]), [index.translator.path, index.translator.sha256], ...index.translations.flatMap((t) => [[t.elf.path, t.elf.sha256], [t.wasm.path, t.wasm.sha256]])];
for (const [path, digest] of named) {
  const bytes = members.get(path);
  if (!bytes) throw new Error(`${asset} has no ${path}, which its index names`);
  if (sha(bytes) !== digest) throw new Error(`${asset}: ${path} is sha256 ${sha(bytes)}, its index says ${digest}`);
}
const known = new Set(['l3.json', about.index.path, ...named.map(([path]) => path)]);
const unnamed = [...members.keys()].filter((name) => !known.has(name));
if (unnamed.length) throw new Error(`${asset} holds ${unnamed.join(', ')}, which its index does not name`);

// Checked, all of it: then it is what public/l3 is, in one rename.
const work = mkdtempSync(join(here, 'public', '.l3-'));
try {
  for (const [name, bytes] of members) { mkdirSync(join(work, name, '..'), {recursive: true}); writeFileSync(join(work, name), bytes); }
  rmSync(join(here, 'public', 'l3'), {recursive: true, force: true});
  renameSync(work, join(here, 'public', 'l3'));
} catch (e) { rmSync(work, {recursive: true, force: true}); throw e; }
console.log(`l3 ${version} for the browser (root ${pin.sha256.slice(0, 12)}…, index ${pin.web.slice(0, 12)}…, ${(tar.length / 1e6).toFixed(1)} MB) is in public/l3`);
