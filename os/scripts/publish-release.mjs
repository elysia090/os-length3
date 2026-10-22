// Publish what scripts/release.sh made: the release os-length3-linux-vX.Y.Z at the commit it was made
// from, its notes OUT/../notes.md and every file in OUT. A version published already is left as it is
// (exit 0), and only a commit main has is released.
//
//   GITHUB_TOKEN=… node scripts/publish-release.mjs OUT
//
// The version is RELEASE ($VERSION overrides); the commit is HEAD ($GITHUB_SHA overrides). GITHUB_REPOSITORY
// names the repository when it is not this one (and GITHUB_API_URL the API, as on GitHub Actions).
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';

const here = new URL('..', import.meta.url).pathname;
const [outArg] = process.argv.slice(2);
if (!outArg) { console.error('usage: node scripts/publish-release.mjs OUT'); process.exit(2); }
const out = resolve(outArg);
const version = process.env.VERSION || readFileSync(join(here, 'RELEASE'), 'utf8').trim();
const sha = process.env.GITHUB_SHA || execFileSync('git', ['-C', here, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
const repo = process.env.GITHUB_REPOSITORY || 'elysia090/os-length3';
const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const tag = `os-length3-linux-v${version}`;
const headers = {accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'length3-release', ...(token ? {authorization: `Bearer ${token}`} : {})};

async function ask(path, init = {}) {
  const r = await fetch(path.startsWith('http') ? path : `${api}/repos/${repo}${path}`, {...init, headers: {...headers, ...init.headers}});
  return r;
}
async function must(r, what) {
  if (r.ok) return r;
  throw new Error(`${what}: ${r.status} ${await r.text()}`);
}

if ((await ask(`/releases/tags/${tag}`)).ok) { console.log(`${tag} is published already`); process.exit(0); }
const on = (await (await must(await ask(`/compare/main...${sha}`), 'where the commit is')).json()).status;
if (on !== 'identical' && on !== 'behind') throw new Error(`${sha} is not on main (${on}): releases are made from main`);

const files = readdirSync(out).filter((f) => statSync(join(out, f)).isFile()).sort();
for (const want of [`-${version}-web.zip`, `-${version}-l3-web.tar`, `-${version}-desktop-amd64.deb`, `-${version}-desktop-x86_64.AppImage`, 'SHA256SUMS', 'manifest']) {
  if (!files.some((f) => f.endsWith(want))) throw new Error(`${out} holds no …${want}: run scripts/release.sh first`);
}
const notes = readFileSync(join(out, '..', 'notes.md'), 'utf8');
const made = await (await must(await ask('/releases', {method: 'POST', headers: {'content-type': 'application/json'},
  body: JSON.stringify({tag_name: tag, target_commitish: sha, name: `OS Length3 Linux ${version}`, body: notes})}), `the release ${tag}`)).json();
const upload = made.upload_url.replace(/\{.*\}$/, '');
for (const f of files) {
  const bytes = readFileSync(join(out, f));
  await must(await ask(`${upload}?name=${encodeURIComponent(f)}`, {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: bytes}), f);
  console.log(`${f}: ${bytes.length} bytes`);
}
console.log(made.html_url);
