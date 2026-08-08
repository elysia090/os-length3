// Default Clang/WASM driver: the YoWASP LLVM/Clang/LLD toolchain.
//
// This is the bundle the page uses out of the box, so SPEC §2's "the browser
// compiles the input locally using Clang/WASM" is true without any deployment
// configuration.
//
// What it is
// ----------
// `@yowasp/clang` is a complete Clang and LLD built for WebAssembly.  It is
// about 105 MB, so it is *not* vendored into this repository: it is fetched
// from a CDN on the first compile and cached by the browser afterwards.  That
// also sidesteps the 25 MiB per-asset limit on Cloudflare Workers, which the
// 73 MB `llvm.core.wasm` would otherwise blow through.
//
// What it can and cannot do
// -------------------------
// The bundle is built with the WebAssembly target only:
//
//     clang --target=x86_64-unknown-linux-gnu -S
//     error: unable to create target: 'No available targets are compatible
//            with triple "x86_64-unknown-linux-gnu"'
//
// So the listing this driver produces is **wasm32**, not x86-64, and the UI
// says so.  That is a property of this bundle, not of the interface: a
// multi-target LLVM build can be dropped in through the same `compile()`
// contract and `listingTriple` config, and the x86-64 listing appears.
//
// Nothing about QM's own lowering depends on this. QM lowers to x86-64, BMI2,
// PCLMUL and portable scalar regardless, because it works from the extracted
// semantics rather than from whatever the compiler emitted.

const DEFAULT_VERSION = '22.0.0-git20542-10';

const BUNDLE_URLS = [
  (v) => `https://cdn.jsdelivr.net/npm/@yowasp/clang@${v}/gen/bundle.js`,
  (v) => `https://unpkg.com/@yowasp/clang@${v}/gen/bundle.js`,
];

export const info = {
  name: 'yowasp-clang',
  title: 'Clang/LLD (YoWASP)',
  package: '@yowasp/clang',
  version: DEFAULT_VERSION,
  approximateBytes: 105 * 1024 * 1024,
  // The listing the toolchain can emit. `null` in `listingTriple` means "the
  // toolchain default", which for this build is wasm32.
  listingTriple: null,
  listingIsa: 'wasm32',
  note: 'built with the WebAssembly target only; the compiled listing is '
        + 'wasm32, and x86-64 listings need a multi-target LLVM bundle',
};

let toolchain = null;
let loading = null;

function config() {
  const global = (typeof self !== 'undefined' && self.QM_CLANG) || {};
  return {
    version: global.yowaspVersion || DEFAULT_VERSION,
    bundleUrl: global.yowaspBundleUrl || null,
  };
}

async function load(onProgress) {
  if (toolchain) return toolchain;
  if (loading) return loading;

  const { version, bundleUrl } = config();
  const candidates = bundleUrl ? [bundleUrl] : BUNDLE_URLS.map((f) => f(version));

  loading = (async () => {
    let lastError = null;
    for (const url of candidates) {
      try {
        if (onProgress) onProgress(`loading Clang from ${new URL(url).host}…`);
        const mod = await import(/* webpackIgnore: true */ url);
        if (typeof mod.runClang !== 'function') {
          throw new Error('bundle does not export runClang');
        }
        toolchain = mod;
        return mod;
      } catch (err) {
        lastError = err;
      }
    }
    loading = null;
    throw new Error(
      `could not load ${info.package}@${version} (` +
        String((lastError && lastError.message) || lastError) + ')',
    );
  })();

  return loading;
}

export async function init(onProgress) {
  await load(onProgress);
  return info;
}

/**
 * Run clang once.
 *
 * @param {string[]} args   flags and file names, without the leading "clang"
 * @param {object} files    { 'in.c': '<source>' }
 * @param {function} [onProgress]
 * @returns {{status: number, stderr: string, files: object}}
 */
export async function compile(args, files, onProgress) {
  const mod = await load(onProgress);
  const decoder = new TextDecoder();
  let stderr = '';

  const options = {
    stderr: (bytes) => { if (bytes) stderr += decoder.decode(bytes); },
    // Progress is reported while the 105 MB bundle streams in, which is the
    // only part of a compile a user would otherwise sit through blind.
    fetchProgress: onProgress
      ? (e) => onProgress(
          `fetching Clang ${Math.round((100 * e.doneLength) / Math.max(e.totalLength, 1))}%`)
      : undefined,
  };

  try {
    const out = await mod.runClang(['clang', ...args], files, options);
    return { status: 0, stderr, files: out || {} };
  } catch (err) {
    // YoWASP throws `Exit` with a code and whatever files were produced.
    if (err && typeof err.code === 'number') {
      return { status: err.code, stderr, files: err.files || {} };
    }
    throw err;
  }
}
