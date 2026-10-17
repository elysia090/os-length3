// The Prompt's own files, taken from the release RELEASE names: what the
// browser's Prompt runs (public/userland: l3, BusyBox, the translator) and
// the root it reads (public/root). They are made where Rust is, by the
// release (.github/workflows/release.yml), and are the OS that version is; a
// build that only has Node (Cloudflare's Workers Builds) takes them from it,
// checked against the release's SHA256SUMS, so the web app ships a released
// Prompt. Shipping a newer Prompt is releasing it (a new version in RELEASE).
//
//   node scripts/prompt-files.mjs
//
// GITHUB_TOKEN: a token that can read this repository's releases (it is
// private), read-only. GITHUB_REPOSITORY names it when it is not this one
// (and GITHUB_API_URL the API, as on GitHub Actions).

import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const here = new URL('..', import.meta.url).pathname;
const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const repo = process.env.GITHUB_REPOSITORY || 'elysia090/os-length3';
const token = process.env.GITHUB_TOKEN;
const version = readFileSync(join(here, 'RELEASE'), 'utf8').trim();
const tag = `os-length3-linux-v${version}`;
const zip = `os-length3-linux-${version}-web.zip`;

const ask = (path, accept = 'application/vnd.github+json') => fetch(`${api}/repos/${repo}${path}`, {
  headers: {accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'length3-build', ...(token ? {authorization: `Bearer ${token}`} : {})},
});
const must = async (r, what) => {
  if (r.ok) return r;
  throw new Error(`${what}: ${r.status}${r.status === 404 && !token ? ' (a private repository needs GITHUB_TOKEN)' : ''}`);
};

const release = await (await must(await ask(`/releases/tags/${tag}`), `the release ${tag}`)).json();
/** One of the release's files; the API answers with where its bytes are, and fetch follows it there without the token. */
const asset = async (name) => {
  const a = release.assets.find((x) => x.name === name);
  if (!a) throw new Error(`${tag} has no ${name}`);
  return Buffer.from(await (await must(await ask(`/releases/assets/${a.id}`, 'application/octet-stream'), name)).arrayBuffer());
};

const sums = (await asset('SHA256SUMS')).toString('utf8');
const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === zip)?.[0];
if (!want) throw new Error(`SHA256SUMS of ${tag} does not name ${zip}`);
const bytes = await asset(zip);
const got = createHash('sha256').update(bytes).digest('hex');
if (got !== want) throw new Error(`${zip}: sha256 ${got}, the release says ${want}`);

const work = mkdtempSync(join(tmpdir(), 'prompt-'));
try {
  writeFileSync(join(work, zip), bytes);
  // What the app's build copies from public/ as it is; the rest of the zip is that version's app, not this one.
  for (const dir of ['userland', 'root']) rmSync(join(here, 'public', dir), {recursive: true, force: true});
  execFileSync('unzip', ['-q', '-o', join(work, zip), 'userland/*', 'root/*', '-d', join(here, 'public')], {stdio: 'inherit'});
} finally {
  rmSync(work, {recursive: true, force: true});
}
console.log(`the Prompt of ${tag} (${(bytes.length / 1e6).toFixed(1)} MB, sha256 ${got.slice(0, 12)}…) is in public/userland and public/root`);
