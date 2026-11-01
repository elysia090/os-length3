// The base a release is made from (shared/root-base.json, root-release.sh) is published in that release beside its
// own root (release.sh), so the release holding it is this one from now on: the releases before it may go
// (.github/workflows/releases-prune.yml) and the next release still finds its base. Proposed to main with the
// release's other pins (release.yml).
//
//   node scripts/pin-base.mjs VERSION [--json FILE]
import {readFileSync, writeFileSync} from 'node:fs';

const args = process.argv.slice(2);
const at = args.includes('--json') ? args.splice(args.indexOf('--json'), 2)[1] : new URL('../shared/root-base.json', import.meta.url).pathname;
const [version] = args;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? '')) { console.error('node scripts/pin-base.mjs VERSION [--json FILE]'); process.exit(2); }
const base = JSON.parse(readFileSync(at, 'utf8'));
base.tag = `os-length3-linux-v${version}`;
writeFileSync(at, `${JSON.stringify(base, null, 2)}\n`);
console.log(`${at}: the base ${base.version} is in ${base.tag}`);
