// Install the web distribution pinned by the product in why/prompt/roots/pins.rs.
// Usage from the checkout: node why/build/fetch-webroot.ts
// The release checksum, pinned index and pack contents are verified before the app's
// existing webroot is replaced. WHY_RELEASES overrides the release download URL;
// when it is unset, GITHUB_REPOSITORY selects the repository.

import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pinnedRoots} from '../shipto/release-pins.ts';
import {checkPacks} from '../../ricebox/distribution/format/pack.ts';
import {tarMembers} from '../../ricebox/distribution/host/node/tar.ts';
import {readReleaseIndex, releaseIndexAsset, type About} from '../../ricebox/distribution/format/manifest.ts';

const here = fileURLToPath(new URL('../..', import.meta.url));
const repo = process.env.GITHUB_REPOSITORY || 'elysia090/os-length3';
const releases = process.env.WHY_RELEASES || `https://github.com/${repo}/releases/download`;
// The pin this tree has comes first: without one, nothing is fetched or taken.
const pin = pinnedRoots(readFileSync(join(here, 'why/prompt/roots/pins.rs'), 'utf8'))[0];
if (!pin) throw new Error('why/prompt/roots/pins.rs does not pin a release');
const {version, tag} = pin;
if (!/^[0-9a-f]{64}$/.test(pin.web)) throw new Error(`why/prompt/roots/pins.rs pins root ${version} without a valid web index digest`);

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** One of the release's files, from its download link. Never waited on for good (a download that stalls holds the
 * build until it is killed): ten minutes, its body included. */
const file = async (name: string) => {
  const r = await fetch(`${releases}/${tag}/${name}`, {headers: {'user-agent': 'why-build'}, signal: AbortSignal.timeout(10 * 60_000)});
  if (!r.ok) throw new Error(`${name} of ${tag}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

const sums = (await file('SHA256SUMS')).toString('utf8');
const sumOf = (name: string) => sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, n]) => n === name)?.[0];
// A release before the web root had its name (0.6.4 and older) carries it as -l3-web.tar, its webroot.json as l3.json.
const asset = [`os-length3-linux-${version}-webroot.tar`, `os-length3-linux-${version}-l3-web.tar`].find(sumOf) ?? `os-length3-linux-${version}-webroot.tar`;
const listed = sumOf(asset);
const tar = await file(asset);
if (!listed || listed !== sha(tar)) throw new Error(`${asset}: sha256 ${sha(tar)}; SHA256SUMS of ${tag} says ${listed ?? 'nothing'}`);

// Only what why is made of comes out of it: webroot.json, its index, packs and blobs, each by a name it may have.
const NAMES = /^((?:webroot|l3|muk)\.json|index-[0-9a-f]{64}\.json|packs\/[0-9a-f]{64}\.pack|blobs\/[0-9a-f]{64}\.bin)$/;
const members = new Map<string, Buffer>();
for await (const m of tarMembers(Readable.from([tar]))) {
  const name = m.name.replace(/^\.\//, '');
  if (m.kind === '5' && /^(\.|packs|blobs)?\/?$/.test(name)) continue;
  if (m.kind !== '0' || !NAMES.test(name)) throw new Error(`${asset}: ${m.name} is not part of a web root`);
  const as = name === 'l3.json' ? 'webroot.json' : name;
  if (members.has(as)) throw new Error(`${asset}: ${m.name} twice`);
  members.set(as, m.bytes);
}
const about: About | null = JSON.parse(members.get('webroot.json')?.toString('utf8') ?? 'null');
if (!about) throw new Error(`${asset} has no webroot.json`);
if (about.version !== version || about.sha256 !== pin.sha256) throw new Error(`${asset}: webroot.json is why ${about.version} from root ${about.sha256}; this tree pins ${version} from ${pin.sha256}`);
const descriptor = releaseIndexAsset(about);
if (descriptor.sha256 !== pin.web) throw new Error(`${asset}: webroot.json names index ${descriptor.sha256}; this tree pins ${pin.web}`);
const indexBytes = members.get(descriptor.path);
if (!indexBytes || indexBytes.length !== descriptor.size || sha(indexBytes) !== pin.web) {
  throw new Error(`${asset}: ${descriptor.path} is not the index this tree pins (${pin.web})`);
}
const index = readReleaseIndex(indexBytes, about);
const named = [[index.translator.path, index.translator.sha256], ...index.translations.flatMap((t) => [[t.elf.path, t.elf.sha256], [t.wasm.path, t.wasm.sha256]])];
// Some releases carry the box maker beside the root, rather than inside its index.
// The archive checksum covers this descriptor; bind its blob's name, digest and size too.
const mukBytes = members.get('muk.json');
if (mukBytes) {
  const muk = JSON.parse(mukBytes.toString('utf8'));
  if (!muk || !/^[0-9a-f]{64}$/.test(muk.sha256) || muk.path !== `blobs/${muk.sha256}.bin`
      || !Number.isSafeInteger(muk.size) || muk.size <= 0) throw new Error(`${asset}: invalid muk.json`);
  const bytes = members.get(muk.path);
  if (!bytes || bytes.length !== muk.size) throw new Error(`${asset}: muk.json names a missing or wrongly sized blob`);
  named.push([muk.path, muk.sha256]);
}
for (const [path, digest] of named) {
  const bytes = members.get(path);
  if (!bytes) throw new Error(`${asset} has no ${path}, which its index names`);
  if (sha(bytes) !== digest) throw new Error(`${asset}: ${path} is sha256 ${sha(bytes)}, its index says ${digest}`);
}
// Each pack whole: its table against its name, each file it stores against its table, nothing else in it.
const pack = (name: string): Buffer => {
  const bytes = members.get(`packs/${name}`);
  if (!bytes) throw new Error(`${asset} has no packs/${name}, which its index names`);
  return bytes;
};
checkPacks(index, (name, at, len) => pack(name).subarray(at, at + len), name => pack(name).length,
  b => createHash('sha256').update(b).digest());
const known = new Set(['webroot.json', ...(mukBytes ? ['muk.json'] : []), descriptor.path, ...named.map(([path]) => path), ...index.packs.map((p) => `packs/${p.name}`)]);
const unnamed = [...members.keys()].filter((name) => !known.has(name));
if (unnamed.length) throw new Error(`${asset} holds ${unnamed.join(', ')}, which its index does not name`);

// Stage outside public so an interrupted build cannot serve the old copy
// or partial files. Moving a nonempty directory is not an atomic exchange.
const work = mkdtempSync(join(here, 'why/app', '.webroot-'));
const next = join(work, 'next'), previous = join(work, 'previous');
const installed = join(here, 'why/app/public/webroot');
let keepBackup = false;
try {
  for (const [name, bytes] of members) {
    mkdirSync(join(next, name, '..'), {recursive: true});
    writeFileSync(join(next, name), bytes);
  }
  let backedUp = false;
  try {
    renameSync(installed, previous);
    backedUp = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    renameSync(next, installed);
  } catch (error) {
    if (backedUp) {
      try { renameSync(previous, installed); }
      catch (restore) {
        keepBackup = true;
        throw new AggregateError([error, restore], `Could not replace or restore the web root; its previous copy is at ${previous}`);
      }
    }
    throw error;
  }
} finally {
  if (!keepBackup) rmSync(work, {recursive: true, force: true});
}
console.log(`why ${version} for the browser (root ${pin.sha256.slice(0, 12)}…, index ${pin.web.slice(0, 12)}…, ${(tar.length / 1e6).toFixed(1)} MB) is in why/app/public/webroot`);
