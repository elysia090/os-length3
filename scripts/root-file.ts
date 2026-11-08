// A release root this tree pins (src/core/src/root/pins.rs RELEASES): VERSION's, or the
// newest pinned, as a file: from DIR when it is there already, else from the
// GitHub release that published it, and kept only at the pinned digest and size.
// Prints its path. For building the web root (scripts/webroot.sh) and checking
// it against the native root (webroot-parity.ts).
//
//   node scripts/root-file.ts DIR [VERSION]
//
// The repository is public: the file is taken from the release's own
// download link (LENGTH3_RELEASES: where releases are downloaded from, for a
// test; GITHUB_REPOSITORY names the repository when it is not this one).
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pinnedRoots} from '../src/remote/releases.ts';

const here = new URL('..', import.meta.url).pathname;
const [dir, asked] = process.argv.slice(2);
if (!dir) { console.error('usage: root-file.ts DIR [VERSION]'); process.exit(2); }
const roots = pinnedRoots(readFileSync(join(here, 'src/core/src/root/pins.rs'), 'utf8'));
const pin = asked ? roots.find((r) => r.version === asked) : roots[0];
if (!pin) throw new Error(`src/core/src/root/pins.rs pins no root for ${asked}`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const at = join(dir, pin.file);
const ok = (b: Buffer) => b.length === pin.bytes && sha(b) === pin.sha256;
if (existsSync(at) && ok(readFileSync(at))) { console.log(at); process.exit(0); }

const repo = process.env.GITHUB_REPOSITORY || 'elysia090/os-length3';
const releases = process.env.LENGTH3_RELEASES || `https://github.com/${repo}/releases/download`;
// A server's own trouble (5xx, a connection cut) is asked again, four times over a minute; anything else is final.
async function download(url: string, what: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {headers: {'user-agent': 'length3-build'}}).catch((e: unknown) => e as Error);
    const failed = r instanceof Error ? r.message : r.ok ? null : `${r.status}`;
    if (!failed) return Buffer.from(await (r as Response).arrayBuffer());
    if (attempt === 4 || (!(r instanceof Error) && r.status < 500)) throw new Error(`${what}: ${failed}`);
    console.error(`${what}: ${failed}; again in ${4 << attempt} s`);
    await new Promise((go) => setTimeout(go, 4000 << attempt));
  }
}
const bytes = await download(`${releases}/${pin.tag}/${pin.file}`, `${pin.file} of ${pin.tag}`);
if (!ok(bytes)) throw new Error(`${pin.file}: sha256 ${sha(bytes)}, ${bytes.length} bytes; this tree pins ${pin.sha256}, ${pin.bytes} bytes`);
mkdirSync(dir, {recursive: true});
writeFileSync(`${at}.part`, bytes);
renameSync(`${at}.part`, at);
console.log(at);
