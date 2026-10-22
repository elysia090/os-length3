// Pin the l3 this tree releases: its entry goes first in core/src/root.rs's
// RELEASES, the whole of its pin for both ways in: the root (the bundle the
// desktop app installs, by sha256 and size) and `web`, the sha256 of the
// index the browser reads the same root by (scripts/l3.mjs, made from that
// bundle). l3 and the app built from this tree install that root (and no
// other new one), and the web build takes only that index
// (scripts/prompt-files.mjs). The release does it before building what
// ships beside the root, so the app in a release trusts that release's
// root; the same entry is then committed, so the source says what was
// released.
//
//   node scripts/pin-root.mjs OUT/os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst [WEB] [--rs FILE]
//
// WEB is l3 for the browser made from that root (public/l3); its l3.json
// must name this root. --rs writes another root.rs (for a test).

import {createHash} from 'node:crypto';
import {readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';

const args = process.argv.slice(2);
const rsAt = args.includes('--rs') ? args.splice(args.indexOf('--rs'), 2)[1] : new URL('../core/src/root.rs', import.meta.url).pathname;
const [file, web] = args;
const name = file ? basename(file) : '';
const m = /^os-length3-linux-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-x86_64-[0-9a-f]{64}\.tar\.zst$/.exec(name);
if (!m) { console.error('node scripts/pin-root.mjs OUT/os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst [WEB] [--rs FILE]'); process.exit(2); }
const version = m[1];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sha256 = sha(readFileSync(file));
const bytes = statSync(file).size.toLocaleString('en').replace(/,/g, '_');

// The web's index, checked: made from this very root, and its file the digest l3.json says.
let webSha = '';
if (web) {
  const about = JSON.parse(readFileSync(join(web, 'l3.json'), 'utf8'));
  if (about.sha256 !== sha256 || about.version !== version) throw new Error(`${web}/l3.json is l3 ${about.version} from root ${about.sha256}, not ${version} from ${sha256}`);
  const got = sha(readFileSync(join(web, about.index.path)));
  if (got !== about.index.sha256) throw new Error(`${web}/${about.index.path}: sha256 ${got}, l3.json says ${about.index.sha256}`);
  webSha = got;
}

const src = readFileSync(rsAt, 'utf8');
const head = 'pub const RELEASES: &[Release] = &[';
if (!src.includes(head)) throw new Error(`${rsAt} has no "${head}"`);
const entry = `Release {
    name: "OS Length3 Linux",
    version: "${version}",
    sha256: "${sha256}",
    bytes: ${bytes},
    file: "${name}",
    tag: "os-length3-linux-v${version}",
    web: "${webSha}",
}`;
// Pinned before: the same root keeps its place; a web pin is only ever added to it, never changed.
const before = new RegExp(`Release \\{\\s*name: "[^"]*",\\s*version: "[^"]*",\\s*sha256: "${sha256}",[^}]*web: "([0-9a-f]*)",\\s*\\}`).exec(src);
if (before) {
  if (before[1] === webSha || !webSha) { console.log(`${name}: pinned already${before[1] ? ` (web ${before[1]})` : ''}`); process.exit(0); }
  if (before[1]) throw new Error(`${name} is pinned with web ${before[1]}; this one is ${webSha}: a released index is never changed`);
  writeFileSync(rsAt, src.replace(before[0], entry));
} else writeFileSync(rsAt, src.replace(head, `${head}${entry}, `));
console.log(`${name}: pinned (${sha256}, ${bytes} bytes${webSha ? `, web ${webSha}` : ''})`);
