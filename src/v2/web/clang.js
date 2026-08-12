// Clang/WASM driver.
//
// The browser compiles C locally and QM works on the optimized output. Two
// artifacts come from one paste:
//
//   * wasm32 -O2, whose selected function body is called over the input domain
//     by vm.wasm. The compiled module is not instantiated as a second runtime.
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
import { executeGuestFunctionBatch } from './vm.js';
import { openWasmFunction } from './wasm-function.js';

const DEFAULT_CONFIG = {
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
      configured: this.configured(),
      bundle: this.info || null,
    };
  }


  configured() {
    return true;
  }

  async load(onProgress) {
    if (this.state === 'ready') return this.module;
    if (this.loading) return this.loading;

    this.state = 'loading';
    if (onProgress) onProgress('fetching the Clang/WASM bundle…');

    this.loading = (async () => {
      try {
        // Keep the 100 MiB compiler cold, but keep executable-code ownership
        // static. An arbitrary driver URL is an unprovable second runtime.
        const mod = await import('./drivers/compiler-core.js');
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
   * The oracle input: a wasm32 module whose selected body runs in vm.wasm.
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
 * Evaluate one compiled wasm32 function over `values` inside vm.wasm.
 *
 * Coordinates stay as decimal strings until they enter the VM's integer
 * argument bank, so no 64-bit value passes through a JavaScript Number.
 */
export async function evaluateWasm(bytes, functionName, values, outputBits,
                                   inputBits, parameters = null) {
  const opened = openWasmFunction(bytes, functionName);

  // A wasm parameter wider than 32 bits is an i64, and the JS API takes a
  // BigInt for one — handing it a Number throws, which is why every 64-bit
  // kernel used to fail here. `values` arrive as decimal strings, so nothing
  // has passed through a double on the way.
  const wide = outputBits > 32;
  const layout = parameters || [
    { bits: inputBits, offset: 0 },
  ];
  const argumentsFor = (value) => {
    const coordinate = BigInt(value);
    return layout.map((parameter) => {
      const bits = BigInt(parameter.bits);
      const raw = (coordinate >> BigInt(parameter.offset))
        & ((1n << bits) - 1n);
      return parameter.bits > 32 ? raw : Number(raw);
    });
  };
  const out = await executeGuestFunctionBatch(
    opened.source, opened.start, opened.end,
    values.map(argumentsFor),
  );
  // Python receives decimal strings: a JSON number cannot carry 64 bits.
  return out.map((v) => BigInt.asUintN(wide ? 64 : outputBits, v).toString());
}

export function readConfig(search) {
  const global = (typeof self !== 'undefined' && self.QM_CLANG) || {};
  const { driverUrl: _untrustedExecutable, ...config } = global;
  return config;
}
