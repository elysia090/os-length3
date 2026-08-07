// Clang/WASM driver.
//
// SPEC §2 puts Clang at the entry: the browser compiles the paste locally and
// QM works on the optimized output.  Two artefacts come from one paste:
//
//   * wasm32 -O2, instantiated here and called over the input domain.  That is
//     the execution oracle: 65,536 inputs cost milliseconds because the kernel
//     runs as compiled code.
//   * an -O2 assembly listing, shown in the UI and counted for "what did the
//     compiler generate?".  Which ISA that listing is in depends on the bundle;
//     the default one is WebAssembly-only, so it is wasm32, and the report says
//     which it was rather than assuming x86-64.
//
// The bundle is fetched lazily, on the first run that asks for it, so the page
// is usable immediately and a user who never presses Optimize never pays for
// it.  If the bundle cannot be fetched the caller falls back to the built-in
// frontend; nothing here throws its way out to the UI.
//
// The default bundle
// ------------------
// `drivers/yowasp-clang.js` ships with the page and needs no configuration.
// It is built with the WebAssembly target only, so the *listing* it produces
// is wasm32; QM's own lowering targets are unaffected, because they are derived
// from the extracted semantics rather than from the compiler's output.
//
// Configuring another bundle
// --------------------------
// A deployment points at its own build by setting, before this module loads:
//
//     window.QM_CLANG = {
//       // module exporting { compile(args, files) -> { files, stderr, status } }
//       driverUrl: 'https://example.com/clang-wasm/driver.mjs',
//       // set when that build has an x86 backend, to get an x86-64 listing
//       listingTriple: 'x86_64-unknown-linux-gnu',
//     };
//
// or by passing ?clang=<url> in the query string.  The driver contract is
// deliberately tiny — one `compile` call — so that any clang-in-wasm build can
// be adapted with a short shim.

const DEFAULT_DRIVER = new URL('./drivers/yowasp-clang.js', import.meta.url).href;

const DEFAULT_CONFIG = {
  driverUrl: DEFAULT_DRIVER,
  // Triple for the assembly listing.  `null` means the toolchain default,
  // which for the bundled driver is wasm32.
  listingTriple: null,
  // Flags shared by both compiles.  -ffreestanding + the prelude that qm/clang.py
  // injects is what removes the need for a sysroot, and with it tens of MB.
  common: ['-std=gnu11', '-ffreestanding', '-O2'],
};

export class ClangUnavailable extends Error {}

export class ClangDriver {
  constructor(config) {
    this.config = Object.assign({}, DEFAULT_CONFIG, config || {});
    this.module = null;
    this.info = null;
    this.state = 'idle'; // idle | loading | ready | unavailable
    this.reason = null;
  }

  describe() {
    return {
      name: 'clang-wasm',
      title: (this.info && this.info.title) || 'Clang -O2 (WebAssembly)',
      kind: 'compiler',
      available: this.state === 'ready',
      state: this.state,
      reason: this.reason,
      driverUrl: this.config.driverUrl,
      configured: this.configured(),
      listing: this.listingIsa(),
      bundle: this.info || null,
    };
  }

  listingIsa() {
    if (this.config.listingTriple) return this.config.listingTriple;
    return (this.info && this.info.listingIsa) || 'the toolchain default';
  }

  configured() {
    return Boolean(this.config.driverUrl);
  }

  async load(onProgress) {
    if (this.state === 'ready') return this.module;
    if (!this.configured()) {
      this.state = 'unavailable';
      this.reason =
        'no Clang/WASM bundle is configured for this deployment; set ' +
        'window.QM_CLANG.driverUrl or pass ?clang=<url>';
      throw new ClangUnavailable(this.reason);
    }
    if (this.loading) return this.loading;

    this.state = 'loading';
    if (onProgress) onProgress('fetching the Clang/WASM bundle…');

    this.loading = (async () => {
      try {
        const mod = await import(/* webpackIgnore: true */ this.config.driverUrl);
        if (typeof mod.compile !== 'function') {
          throw new Error('the driver module does not export compile()');
        }
        if (typeof mod.init === 'function') {
          this.info = await mod.init(onProgress);
        }
        this.info = this.info || mod.info || null;
        this.module = mod;
        this.state = 'ready';
        return mod;
      } catch (err) {
        this.state = 'unavailable';
        this.reason = String((err && err.message) || err);
        throw new ClangUnavailable(this.reason);
      } finally {
        this.loading = null;
      }
    })();

    return this.loading;
  }

  async run(args, files, onProgress) {
    const mod = await this.load(onProgress);
    const result = await mod.compile(args, files, onProgress);
    if (result.status !== 0) {
      const err = new Error('clang failed to compile the source');
      err.stderr = result.stderr || '';
      throw err;
    }
    return result;
  }

  // --- the two artefacts ---------------------------------------------------

  /**
   * The listing shown in the UI: what the compiler generated, for real.
   *
   * `-march` is only meaningful when an x86 triple is configured; asking a
   * WebAssembly-target build for `-march=x86-64-v3` is not a smaller listing,
   * it is an error.
   */
  async assembly(source, { opt = '-O2', target = 'x86-64' } = {}, onProgress) {
    const flags = this.config.common.filter((f) => !f.startsWith('-O'));
    const triple = this.config.listingTriple;
    const args = [...flags, opt];
    if (triple) args.push(`--target=${triple}`, `-march=${target}`);
    args.push('-S', '-fno-ident', '-o', 'out.s', 'in.c');

    const res = await this.run(args, { 'in.c': source }, onProgress);
    return {
      text: asText(res.files['out.s']),
      isa: this.listingIsa(),
      stderr: res.stderr || '',
    };
  }

  async wasm(source, { opt = '-O2' } = {}, onProgress) {
    const flags = this.config.common.filter((f) => !f.startsWith('-O'));
    const res = await this.run(
      [
        ...flags,
        opt,
        '-nostdlib',
        '-Wl,--no-entry',
        '-Wl,--export-all',
        '-Wl,--allow-undefined',
        '-o',
        'out.wasm',
        'in.c',
      ],
      { 'in.c': source },
      onProgress,
    );
    const bytes = res.files['out.wasm'];
    if (!bytes) throw new Error('clang produced no wasm module');
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }
}

function asText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return new TextDecoder().decode(value);
}

// ---------------------------------------------------------------------------
// Execution oracle
// ---------------------------------------------------------------------------

/**
 * Instantiate a compiled wasm32 module and evaluate the kernel over `values`.
 *
 * wasm32 has no 64-bit integer in its JS boundary before BigInt, so i64 results
 * arrive as BigInt and are normalized here.  Values wider than the declared
 * output width are masked on the Python side, not here — masking twice is how
 * a frontend quietly changes the semantics it is supposed to report.
 */
export async function evaluateWasm(bytes, functionName, values, outputBits) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const fn = instance.exports[functionName];
  if (typeof fn !== 'function') {
    const exported = Object.keys(instance.exports).filter(
      (k) => typeof instance.exports[k] === 'function',
    );
    throw new Error(
      `the compiled module does not export ${functionName} ` +
        `(exports: ${exported.join(', ') || 'none'})`,
    );
  }

  const wide = outputBits > 32;
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const y = fn(values[i]);
    out[i] = typeof y === 'bigint' ? y : BigInt.asUintN(64, BigInt(y));
  }
  // Python receives decimal strings: a JSON number cannot carry 64 bits.
  return out.map((v) => BigInt.asUintN(wide ? 64 : outputBits, v).toString());
}

export function readConfig(search) {
  const params = new URLSearchParams(search || '');
  const fromQuery = params.get('clang');
  const global = (typeof self !== 'undefined' && self.QM_CLANG) || {};
  return Object.assign({}, global, fromQuery ? { driverUrl: fromQuery } : {});
}
