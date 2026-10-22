// The browser's l3 is the native one: the same paths, types, modes, link
// targets and bytes (sha256). Reads the release root as l3 installs it on
// a device and l3 as the browser reads it, file by file from its packs, and
// says where they differ; exits 1 when they do.
//
//   node scripts/l3-parity.mjs ROOT WEB [--manifests DIR]
//
// ROOT  the release root (os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst),
//       or a root installed from it (<data>/system/<sha256>/root)
// WEB   l3 for the browser (public/l3, scripts/l3.mjs); a root of packs of
//       before (root.json) is read too, to say how far it was from native
// --manifests DIR  writes native.txt and web.txt there, one line a path
import {mkdirSync, statSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {counts, differences, manifestOf, nativeTree, sha256, webTree} from './l3-tree.mjs';
import {readFileSync} from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const manifests = flag('--manifests');
const [rootAt, webAt] = args;
if (!rootAt || !webAt) { console.error('usage: l3-parity.mjs ROOT WEB [--manifests DIR]'); process.exit(2); }

const native = await nativeTree(rootAt);
const web = webTree(webAt);
// The web's l3 names the root it was made from: a tarball given is that one, by its digest.
if (web.about && !statSync(rootAt).isDirectory()) {
  const got = sha256(readFileSync(rootAt));
  if (got !== web.about.sha256) { console.error(`${basename(rootAt)} is sha256 ${got}; l3.json says it was made from ${web.about.sha256}`); process.exit(1); }
}
if (manifests) {
  mkdirSync(manifests, {recursive: true});
  writeFileSync(join(manifests, 'native.txt'), manifestOf(native));
  writeFileSync(join(manifests, 'web.txt'), manifestOf(web));
}
const d = differences(native, web);
const n = counts(native), w = counts(web);
const say = (c) => `${c.files} files, ${c.dirs} directories, ${c.links} links, ${c.bytes} bytes`;
console.log(`native  ${say(n)}`);
console.log(`web     ${say(w)}`);
if (d.same) { console.log(`same: every path, type, mode, link target and sha256 (${native.entries.length} paths)`); process.exit(0); }
const some = (list, f = (x) => x) => list.slice(0, 20).map((x) => `  ${f(x)}`).join('\n') + (list.length > 20 ? `\n  … ${list.length - 20} more` : '');
if (d.missing.length) console.log(`only native (${d.missing.length}):\n${some(d.missing)}`);
if (d.extra.length) console.log(`only web (${d.extra.length}):\n${some(d.extra)}`);
if (d.changed.length) console.log(`different (${d.changed.length}):\n${some(d.changed, (c) => `${c.a}\n  ${c.b.replace(/^[^\t]*/, ' '.repeat(c.path.length))}`)}`);
process.exit(1);
