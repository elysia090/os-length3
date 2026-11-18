import {CORE_INPUTS} from '../../build/core-wasm.ts';

// The selftest's browser build includes the same Rust inputs as the normal
// build, plus its frontend, build adapters and portable execution dependencies.
export const BROWSER_INPUTS = [...CORE_INPUTS, 'why/app', 'why/build',
  'package.json', 'package-lock.json', 'wrangler.toml', 'ricebox/sods/runtime',
  'ricebox/everyday/src', 'ricebox/distribution/runtime', 'ricebox/distribution/format',
  'ricebox/distribution/build', 'ricebox/distribution/host', 'ricebox/muk/src', 'ricebox/toolchain'];
