// Print the local path to a pinned root archive, downloading it if needed.
// Usage: node why/build/fetch-root.ts DIR [VERSION]
// Omit VERSION to use the first pin in why/prompt/roots/pins.rs. Archives are
// accepted only at the pinned size and digest. WHY_RELEASES can override the
// download URL; otherwise GITHUB_REPOSITORY selects the repository.

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pinnedRoots} from '../shipto/release-pins.ts';

const here = fileURLToPath(new URL('../..', import.meta.url));
const [dir, asked] = process.argv.slice(2);
if (!dir) { console.error('usage: fetch-root.ts DIR [VERSION]'); process.exit(2); }
const roots = pinnedRoots(readFileSync(join(here, 'why/prompt/roots/pins.rs'), 'utf8'));
const pin = asked ? roots.find((r) => r.version === asked) : roots[0];
if (!pin) throw new Error(`why/prompt/roots/pins.rs pins no root for ${asked}`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const at = join(dir, pin.file);
const ok = (b: Buffer) => b.length === pin.bytes && sha(b) === pin.sha256;
if (existsSync(at) && ok(readFileSync(at))) { console.log(at); process.exit(0); }

const repo = process.env.GITHUB_REPOSITORY || 'elysia090/os-length3';
const releases = process.env.WHY_RELEASES || `https://github.com/${repo}/releases/download`;
// A server's own trouble (5xx, a connection cut) is asked again, four times over a minute; anything else is final.
async function download(url: string, what: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    let failed: string;
    let retry = true;
    try {
      const r = await fetch(url, {headers: {'user-agent': 'why-build'}});
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      failed = `${r.status}`;
      retry = r.status >= 500;
      // Release an error response before retrying, including terminal HTTP failures.
      await r.body?.cancel().catch(() => {});
    } catch (e) {
      // Receiving headers is not a completed download: body failures retry too.
      failed = e instanceof Error ? e.message : String(e);
    }
    if (attempt === 4 || !retry) throw new Error(`${what}: ${failed}`);
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

