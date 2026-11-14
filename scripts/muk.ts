// muk for a web root: the box's maker (module/muk: one x86-64 Linux program of C, made by module/lib/build.sh),
// built from this tree when its sources are newer than what was built, and put beside a root's layers as a page
// reads it (module/ricebox/layers/root.ts): its bytes as a blob named by their digest, and muk.json, which says
// which. A root's programs run in a box muk makes, in a page as on Linux (the same program, translated there as
// the root's own are); it is served beside the root until a root is released that carries it.
//
//   node scripts/muk.ts [WEB]     WEB: the web root (public/webroot)
//
// By the Vite plugin (why/app/vite.config.ts) at each dev-server start and build, where there is a web root; and by
// what checks the root's programs in node (webroot-runnable.ts).
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const OS = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = ['module/muk/src', 'module/lib'].map((p) => join(OS, p));

/** Where muk is built (CARGO_TARGET_DIR is honoured, as what is made is kept there). */
export function mukPath(): string {
  return join(process.env.CARGO_TARGET_DIR ? resolve(OS, process.env.CARGO_TARGET_DIR) : join(OS, 'target'), 'muk', 'muk');
}

function newest(path: string): number {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return s.mtimeMs;
  return Math.max(s.mtimeMs, ...readdirSync(path).map((e) => newest(join(path, e))));
}

/** muk, built first unless it is newer than every source; what cannot build it is said with why. */
export function buildMuk(): string {
  const out = mukPath();
  if (existsSync(out) && statSync(out).mtimeMs > Math.max(...SOURCES.map(newest))) return out;
  mkdirSync(join(out, '..'), {recursive: true});
  const r = spawnSync('sh', [join(OS, 'module/lib/build.sh'), join(OS, 'module/muk/src/muk.c'), out], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  if (r.error || r.status !== 0) {
    throw new Error(`why: muk (module/muk) was not built: it is made on Linux, for x86-64, by a C compiler (module/lib/build.sh)\n${r.error?.message ?? r.stderr}`);
  }
  return out;
}

/** muk put beside the web root at `web`, as a page reads it: its blob and muk.json. What muk.json says. */
export function putMuk(web: string): {path: string; sha256: string; size: number} {
  const bytes = readFileSync(buildMuk()), sha256 = createHash('sha256').update(bytes).digest('hex');
  const said = {path: `blobs/${sha256}.bin`, sha256, size: bytes.length};
  mkdirSync(join(web, 'blobs'), {recursive: true});
  if (!existsSync(join(web, said.path))) writeFileSync(join(web, said.path), bytes);
  const json = `${JSON.stringify(said)}\n`;
  if (!existsSync(join(web, 'muk.json')) || readFileSync(join(web, 'muk.json'), 'utf8') !== json) writeFileSync(join(web, 'muk.json'), json);
  return said;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const web = resolve(process.argv[2] ?? join(OS, 'public', 'webroot'));
  console.log(`muk: ${putMuk(web).path} in ${web}`);
}
