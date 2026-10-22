// The release root this tree pins for the version RELEASE names
// (core/src/root.rs RELEASES), as a file: from DIR when it is there already,
// else from the GitHub release that published it, and kept only at the
// pinned digest and size. Prints its path. For building l3 for the browser
// (scripts/l3.sh) and checking it against the native root (l3-parity.mjs).
//
//   node scripts/root-file.mjs DIR [VERSION]
//
// GITHUB_TOKEN: a token that can read this repository's releases (it is
// private), read-only. GITHUB_REPOSITORY names it when it is not this one
// (and GITHUB_API_URL the API, as on GitHub Actions).
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pinnedRoots} from '../service/releases.ts';

const here = new URL('..', import.meta.url).pathname;
const [dir, asked] = process.argv.slice(2);
if (!dir) { console.error('usage: root-file.mjs DIR [VERSION]'); process.exit(2); }
const version = asked ?? readFileSync(join(here, 'RELEASE'), 'utf8').trim();
const pin = pinnedRoots(readFileSync(join(here, 'core/src/root.rs'), 'utf8')).find((r) => r.version === version);
if (!pin) throw new Error(`core/src/root.rs pins no root for ${version}`);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const at = join(dir, pin.file);
const ok = (b) => b.length === pin.bytes && sha(b) === pin.sha256;
if (existsSync(at) && ok(readFileSync(at))) { console.log(at); process.exit(0); }

const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const repo = process.env.GITHUB_REPOSITORY || 'elysia090/os-length3';
const token = process.env.GITHUB_TOKEN;
const ask = (path, accept = 'application/vnd.github+json') => fetch(`${api}/repos/${repo}${path}`, {
  headers: {accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'length3-build', ...(token ? {authorization: `Bearer ${token}`} : {})},
});
const must = (r, what) => { if (r.ok) return r; throw new Error(`${what}: ${r.status}${r.status === 404 && !token ? ' (a private repository needs GITHUB_TOKEN)' : ''}`); };
const release = await must(await ask(`/releases/tags/${pin.tag}`), `the release ${pin.tag}`).json();
const a = release.assets.find((x) => x.name === pin.file);
if (!a) throw new Error(`${pin.tag} has no ${pin.file}`);
const bytes = Buffer.from(await must(await ask(`/releases/assets/${a.id}`, 'application/octet-stream'), pin.file).arrayBuffer());
if (!ok(bytes)) throw new Error(`${pin.file}: sha256 ${sha(bytes)}, ${bytes.length} bytes; this tree pins ${pin.sha256}, ${pin.bytes} bytes`);
mkdirSync(dir, {recursive: true});
writeFileSync(`${at}.part`, bytes);
renameSync(`${at}.part`, at);
console.log(at);
