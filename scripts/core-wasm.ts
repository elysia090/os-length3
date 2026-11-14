// The core as the browser runs it (why/core/web), built with cargo when its sources are newer than the
// module: by the Vite plugin (vite.config.ts) at each dev-server start and build, and by wasi.test.ts.

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const OS = fileURLToPath(new URL('..', import.meta.url));
const TARGET = 'wasm32-wasip1';
// Its own profile (Cargo.toml [profile.web]): the release's, built small.
const PROFILE = 'web';
const BUILD = ['build', '--profile', PROFILE, '-p', 'why-core-web', '--target', TARGET];
// templates.json is compiled in (core/src/templates.rs include_str!).
// (and ricebox's own Rust, which the core is made with: the bundle a page asks it for is ricebox's to write)
const SOURCES = ['why/core/src', 'why/core/web/src', 'why/core/Cargo.toml', 'why/core/web/Cargo.toml', 'module/ricebox/src', 'module/ricebox/Cargo.toml', 'Cargo.toml', 'Cargo.lock', 'why/shared/templates.json'].map((p) => join(OS, p));

/** Where cargo puts the module (CARGO_TARGET_DIR is honoured, as cargo honours it). */
export function coreWasmPath(): string {
  const target = process.env.CARGO_TARGET_DIR ? resolve(OS, process.env.CARGO_TARGET_DIR) : join(OS, 'target');
  return join(target, TARGET, PROFILE, 'why_core_web.wasm');
}

function newest(path: string): number {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return s.mtimeMs;
  return Math.max(s.mtimeMs, ...readdirSync(path).map((e) => newest(join(path, e))));
}

/** Whether cargo can be run at all. */
export function hasCargo(): boolean {
  return !spawnSync('cargo', ['--version'], {stdio: 'ignore'}).error;
}

/** The module, built first unless it is newer than every source; a missing toolchain is said with its fix. */
export function buildCoreWasm(options: {quiet?: boolean} = {}): string {
  const wasm = coreWasmPath();
  if (existsSync(wasm) && statSync(wasm).mtimeMs > Math.max(...SOURCES.map(newest))) return wasm;
  if (!hasCargo()) throw new Error('why: the core (why/core/web) needs Rust to build: install it from https://rustup.rs');
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
