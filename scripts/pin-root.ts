// Pin the why this tree releases: its entry is why/core/src/root/pins.rs's RELEASES,
// the whole of its pin for both ways in: the root (the bundle the
// desktop app installs, by sha256 and size) and `web`, the sha256 of the
// index the browser reads the same root by (scripts/webroot.ts, made from that
// bundle). why and the app built from this tree install that root (and no
// other new one), and the web build takes only that index
// (scripts/prompt-files.ts). The release does it before building what
// ships beside the root, so the app in a release trusts that release's
// root; the same entry is then committed, so the source says what was
// released. Only this release is pinned: a device installs the newest pin
// alone and keeps the root it had beside it, and the releases no longer
// pinned are deleted (.github/workflows/prune-releases.yml).
//
//   node scripts/pin-root.ts OUT/os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst [WEB] [--rs FILE]
//
// WEB is the web root made from that root (public/webroot); its webroot.json
// must name this root. --rs writes another root/ (for a test).

import {createHash} from 'node:crypto';
import {readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';

const args = process.argv.slice(2);
const rsAt = args.includes('--rs') ? args.splice(args.indexOf('--rs'), 2)[1] : new URL('../why/core/src/root/pins.rs', import.meta.url).pathname;
const [file, web] = args;
const name = file ? basename(file) : '';
const m = /^os-length3-linux-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-x86_64-[0-9a-f]{64}\.tar\.zst$/.exec(name);
if (!m) { console.error('node scripts/pin-root.ts OUT/os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst [WEB] [--rs FILE]'); process.exit(2); }
const version = m[1];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sha256 = sha(readFileSync(file));
const bytes = statSync(file).size.toLocaleString('en').replace(/,/g, '_');

// The web's index, checked: made from this very root, and its file the digest webroot.json says.
let webSha = '';
if (web) {
  const about = JSON.parse(readFileSync(join(web, 'webroot.json'), 'utf8'));
  if (about.sha256 !== sha256 || about.version !== version) throw new Error(`${web}/webroot.json is why ${about.version} from root ${about.sha256}, not ${version} from ${sha256}`);
  const got = sha(readFileSync(join(web, about.index.path)));
  if (got !== about.index.sha256) throw new Error(`${web}/${about.index.path}: sha256 ${got}, webroot.json says ${about.index.sha256}`);
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
} else {
  const end = src.indexOf('}];', src.indexOf(head));
  if (end < 0) throw new Error(`${rsAt}: RELEASES has no end ("}];")`);
  writeFileSync(rsAt, `${src.slice(0, src.indexOf(head))}${head}${entry}];${src.slice(end + 3)}`);
}
console.log(`${name}: pinned (${sha256}, ${bytes} bytes${webSha ? `, web ${webSha}` : ''})`);
