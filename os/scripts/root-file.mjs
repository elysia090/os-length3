// A release root this tree pins (core/src/root.rs RELEASES): VERSION's, or
// the newest pinned, as a file: from DIR when it is there already, else from
// the GitHub release that published it, and kept only at the pinned digest
// and size. Prints its path. For building l3 for the browser
// (scripts/l3.sh) and checking it against the native root (l3-parity.mjs).
//
//   node scripts/root-file.mjs DIR [VERSION]
//
// The repository is public: the file is taken from the release's own
// download link (LENGTH3_RELEASES: where releases are downloaded from, for a
// test; GITHUB_REPOSITORY names the repository when it is not this one).
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pinnedRoots} from '../service/releases.ts';

const here = new URL('..', import.meta.url).pathname;
const [dir, asked] = process.argv.slice(2);
if (!dir) { console.error('usage: root-file.mjs DIR [VERSION]'); process.exit(2); }
const roots = pinnedRoots(readFileSync(join(here, 'core/src/root.rs'), 'utf8'));
const pin = asked ? roots.find((r) => r.version === asked) : roots[0];
if (!pin) throw new Error(`core/src/root.rs pins no root for ${asked}`);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const at = join(dir, pin.file);
const ok = (b) => b.length === pin.bytes && sha(b) === pin.sha256;
if (existsSync(at) && ok(readFileSync(at))) { console.log(at); process.exit(0); }

const repo = process.env.GITHUB_REPOSITORY || 'elysia090/os-length3';
const releases = process.env.LENGTH3_RELEASES || `https://github.com/${repo}/releases/download`;
const r = await fetch(`${releases}/${pin.tag}/${pin.file}`, {headers: {'user-agent': 'length3-build'}});
if (!r.ok) throw new Error(`${pin.file} of ${pin.tag}: ${r.status}`);
const bytes = Buffer.from(await r.arrayBuffer());
if (!ok(bytes)) throw new Error(`${pin.file}: sha256 ${sha(bytes)}, ${bytes.length} bytes; this tree pins ${pin.sha256}, ${pin.bytes} bytes`);
mkdirSync(dir, {recursive: true});
writeFileSync(`${at}.part`, bytes);
renameSync(`${at}.part`, at);
console.log(at);
