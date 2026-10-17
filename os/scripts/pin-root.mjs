// Pin a root this tree releases: its entry goes first in core/src/root.rs's
// RELEASES, so l3 and the app built from this tree install it (and no other
// new one). The release does it before building what ships beside the root,
// so the app in a release trusts that release's root; the same entry is then
// committed, so the source says what was released.
//
//   node scripts/pin-root.mjs OUT/os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst

import {createHash} from 'node:crypto';
import {readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename} from 'node:path';

const file = process.argv[2];
const name = file ? basename(file) : '';
const m = /^os-length3-linux-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-x86_64-[0-9a-f]{64}\.tar\.zst$/.exec(name);
if (!m) { console.error('node scripts/pin-root.mjs OUT/os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst'); process.exit(2); }
const version = m[1];
const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
const bytes = statSync(file).size.toLocaleString('en').replace(/,/g, '_');

const at = new URL('../core/src/root.rs', import.meta.url);
const src = readFileSync(at, 'utf8');
if (src.includes(`sha256: "${sha256}"`)) { console.log(`${name}: pinned already`); process.exit(0); }
const head = 'pub const RELEASES: &[Release] = &[';
if (!src.includes(head)) throw new Error(`core/src/root.rs has no "${head}"`);
const entry = `Release {
    name: "OS Length3 Linux",
    version: "${version}",
    sha256: "${sha256}",
    bytes: ${bytes},
    file: "${name}",
    tag: "os-length3-linux-v${version}",
}, `;
writeFileSync(at, src.replace(head, head + entry));
console.log(`${name}: pinned (${sha256}, ${bytes} bytes)`);
