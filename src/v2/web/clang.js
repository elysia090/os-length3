// Clang/WASM driver.
//
// The browser compiles C locally and QM works on the optimized output. Two
// artifacts come from one paste:
//
//   * wasm32 -O2, instantiated here and called over the input domain.  That is
//     the execution oracle: 65,536 inputs cost milliseconds because the kernel
//     runs as compiled code.
// That is the only thing it is for.  There was a second compile producing an
// assembly listing for a pane to show; the pane is gone, and with it the
// listing target and the optimization level, neither of which changed what the
// kernel computes.
//
// The bundle is fetched lazily, on the first run that asks for it, so the page
// is usable immediately and a user who never runs or edits a kernel never pays
// for it. If the bundle cannot be fetched the caller falls back to the built-in
// frontend; nothing here throws its way out to the UI.
//
// The default bundle
// ------------------
// `drivers/compiler-core.js` ships with the page and needs no configuration.
// On the first compile it fetches the pinned LLVM core and standard resources
// directly, then connects the core's 29 standard WASI Preview 1 imports to a
// small in-memory filesystem. No generated package wrapper or component-model
// adapter is loaded. This build has only the WebAssembly target, which is all
// the execution oracle needs.
//
// Configuring another bundle
// --------------------------
// A deployment points at its own build by setting, before this module loads:
//
//     window.QM_CLANG = {
//       // module exporting { compile(args, files) -> { files, stderr, status } }
//       driverUrl: 'https://example.com/clang-wasm/driver.mjs',
//     };
//
// or by passing ?clang=<url> in the query string.  The driver contract is
// deliberately tiny — one `compile` call — so that any clang-in-wasm build can
// be adapted with a short shim.

const DEFAULT_DRIVER = new URL('./drivers/compiler-core.js', import.meta.url).href;

const DEFAULT_CONFIG = {
  driverUrl: DEFAULT_DRIVER,
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
      bundle: this.info || null,
    };
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

  // --- the one artefact ----------------------------------------------------

  /**
   * The oracle: a wasm32 module, instantiated and called over the domain.
   * This is the only thing the compiler is asked for.
   */
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
export async function evaluateWasm(bytes, functionName, values, outputBits,
                                   inputBits) {
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

  // A wasm parameter wider than 32 bits is an i64, and the JS API takes a
  // BigInt for one — handing it a Number throws, which is why every 64-bit
  // kernel used to fail here. `values` arrive as decimal strings, so nothing
  // has passed through a double on the way.
  const wide = outputBits > 32;
  const asArgument = inputBits > 32 ? (v) => BigInt(v) : (v) => Number(BigInt(v));
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const y = fn(asArgument(values[i]));
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
