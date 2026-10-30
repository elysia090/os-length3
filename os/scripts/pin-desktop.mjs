// Pin the desktop app a release made: its .deb and AppImage, by name, size and sha256, under the version in
// shared/desktop-releases.json, where the web offers them and the Remote's deploy takes them (service/releases.ts).
// The release does it beside pin-root.mjs, and both are proposed to main as one change (release.yml), so the
// source says what was released.
//
//   node scripts/pin-desktop.mjs VERSION DEB APPIMAGE [--json FILE]
//
// --json writes another file (for a test).

import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {basename} from 'node:path';

const args = process.argv.slice(2);
const at = args.includes('--json') ? args.splice(args.indexOf('--json'), 2)[1] : new URL('../shared/desktop-releases.json', import.meta.url).pathname;
const [version, deb, appimage] = args;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? '') || !deb || !appimage) {
  console.error('node scripts/pin-desktop.mjs VERSION DEB APPIMAGE [--json FILE]');
  process.exit(2);
}
const pin = (file) => {
  const bytes = readFileSync(file);
  if (!basename(file).includes(`-${version}-`)) throw new Error(`${file} is not of ${version}`);
  return {file: basename(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
};
const pins = JSON.parse(readFileSync(at, 'utf8'));
pins[version] = {deb: pin(deb), appimage: pin(appimage)};
// As the file is written by hand: versions oldest first, each file of a version on one line.
const versions = Object.keys(pins).sort((a, b) => a.localeCompare(b, 'en', {numeric: true}));
const line = (p) => `{"file": ${JSON.stringify(p.file)}, "bytes": ${p.bytes}, "sha256": ${JSON.stringify(p.sha256)}}`;
writeFileSync(at, `{\n${versions.map((v) => `  ${JSON.stringify(v)}: {\n${Object.entries(pins[v]).map(([kind, p]) => `    ${JSON.stringify(kind)}: ${line(p)}`).join(',\n')}\n  }`).join(',\n')}\n}\n`);
console.log(`${at}: ${version} pinned`);
