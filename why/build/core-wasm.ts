// The core as the browser runs it (why/api/web), built with cargo when its sources are newer than the
// module: by the Vite plugin (vite.config.ts) at each dev-server start and build, and by wasi.test.ts.

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const OS = fileURLToPath(new URL('../..', import.meta.url));
/** why's parts (docs/STRUCTURE.md): each a folder of why/ holding its Rust and its TypeScript side by side. */
export const CORE_PARTS = ['text', 'agent', 'api', 'ssh', 'repo', 'home', 'shipto', 'prompt', 'device'];
const TARGET = 'wasm32-wasip1';
// Its own profile (Cargo.toml [profile.web]): the release's, built small.
const PROFILE = 'web';
const BUILD = ['build', '--profile', PROFILE, '-p', 'why-core-web', '--target', TARGET];
// The core is why's parts as Rust has them (why/lib.rs and each part's .rs; a part's TypeScript is the page's, and
// changes nothing here), the door built for a browser (why/api/web), and ricebox's own Rust, which the core is made
// with: the bundle a page asks it for is ricebox's to write. A part's .json is compiled in (repo/templates.rs
// include_str!).
export const CORE_INPUTS = ['why/lib.rs', 'why/Cargo.toml', ...CORE_PARTS.map((part) => `why/${part}`),
  'ricebox/distribution/src', 'ricebox/distribution/Cargo.toml', 'ricebox/distribution/build.rs',
  'Cargo.toml', 'Cargo.lock', '.cargo/config.toml'];
const SOURCES = CORE_INPUTS.map((p) => join(OS, p));
/** What of a part makes the core: its Rust, what Rust compiles in, a manifest. */
const MAKES = /\.(rs|json|toml|lock)$/;

/** Where cargo puts the module (CARGO_TARGET_DIR is honoured, as cargo honours it). */
export function coreWasmPath(): string {
  const target = process.env.CARGO_TARGET_DIR ? resolve(OS, process.env.CARGO_TARGET_DIR) : join(OS, 'target');
  return join(target, TARGET, PROFILE, 'why_core_web.wasm');
}

function newest(path: string): number {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return MAKES.test(path) ? s.mtimeMs : 0;
  return Math.max(0, ...readdirSync(path).map((e) => newest(join(path, e))));
}

/** Whether cargo can be run at all. */
export function hasCargo(): boolean {
  return !spawnSync('cargo', ['--version'], {stdio: 'ignore'}).error;
}

/** The module, built first unless it is newer than every source; a missing toolchain is said with its fix. */
export function buildCoreWasm(options: {quiet?: boolean} = {}): string {
  const wasm = coreWasmPath();
  if (existsSync(wasm) && statSync(wasm).mtimeMs > Math.max(...SOURCES.map(newest))) return wasm;
  if (!hasCargo()) throw new Error('why: the core (why/api/web) needs Rust to build: install it from https://rustup.rs');
  const targets = spawnSync('rustup', ['target', 'list', '--installed'], {encoding: 'utf8'});
  // Without rustup the toolchain is the system's; cargo says itself whether it has the target.
  if (!targets.error && !targets.stdout.split('\n').includes(TARGET)) {
    throw new Error(`why: the core is built for ${TARGET}, which this Rust lacks: run \`rustup target add ${TARGET}\``);
  }
  if (!options.quiet) console.log(`why: building the core for the browser (cargo ${BUILD.join(' ')})`);
  const r = spawnSync('cargo', BUILD, {cwd: OS, encoding: 'utf8', stdio: ['ignore', 'pipe', options.quiet ? 'pipe' : 'inherit']});
  if (r.status !== 0) {
    const said = r.stderr ?? '';
    if (/can't find crate for `std`|target may not be installed/.test(said)) {
      throw new Error(`why: the core is built for ${TARGET}, which this Rust lacks: run \`rustup target add ${TARGET}\``);
    }
    throw new Error(`why: building the core failed (cargo ${BUILD.join(' ')})\n${said}`);
  }
  return wasm;
}
