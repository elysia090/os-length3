// The rSUBLEQ machine, compiled.
//
// `qm.browser.artifact` normalizes the minimized program into one canonical
// signed image and hands over `pack(code(z))`. This runs it — `open`, `feed`,
// `read`, and nothing else. Whether the paste was C, an x86-64 listing or a
// wasm32 listing stops mattering here: all three arrive as the same artifact.
//
// `vm/wasm/vm.c` is the source; `vm/wasm/build.py` compiles it and
// `tests/test_vm.py` holds it against the Python reference in `vm/machine.py`.

const MODULE_URL = new URL('./vm.wasm', import.meta.url);

// Outcomes, shared with the C and the Python.
const BOTTOM = -1;
const UNFINISHED = -2;
const DEAD = 0;

let instance = null;
let compiled = null;

export class MachineUnavailable extends Error {}

export async function compile() {
  if (compiled) return compiled;
  let response;
  try {
    response = await fetch(MODULE_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    throw new MachineUnavailable(`cannot fetch vm.wasm (${err.message})`);
  }
  compiled = await WebAssembly.compile(await response.arrayBuffer());
  return compiled;
}

export async function load(precompiled = null) {
  if (instance) return instance;
  const module = precompiled || await compile();
  instance = await WebAssembly.instantiate(module, {});
  return instance;
}

/**
 * Bind one minimized artifact to the VM's scalar-kernel ABI.
 *
 * The returned function is a WebAssembly export. Passing it as the driver's
 * kernel import keeps calls inside wasm; JavaScript is not on the per-byte or
 * per-kernel path. `vm_prepare_eval` also enables the VM's exact finite-domain
 * cache (and its stronger right-zero Byte* form when proved at load time).
 */
export async function prepareEvaluator(artifact, plan, precompiled = null) {
  const loaded = await load(precompiled);
  const E = loaded.exports;
  const memory = new Uint8Array(E.memory.buffer);
  memory.set(artifact, E.vm_buffer());
  if (!E.vm_prepare_eval(
    artifact.length, plan.input_bits, plan.in_bytes, plan.out_bytes,
  )) {
    if (E.vm_table_full && E.vm_table_full()) {
      throw new Error('the image is larger than this machine has room for');
    }
    throw new Error('the artifact did not open as a canonical image');
  }

  const input = plan.input_bits > 32 ? 'i64' : 'i32';
  const output = plan.output_bits > 32 ? 'i64' : 'i32';
  const fn = E[`vm_eval_${input}_${output}`];
  if (typeof fn !== 'function') throw new Error('the VM has no matching kernel ABI');
  return {
    fn,
    calls: () => Number(E.vm_eval_calls()),
    misses: () => Number(E.vm_eval_misses()),
    ok: () => Boolean(E.vm_eval_ok()),
  };
}

/**
 * Evaluate a kernel-shaped artifact on one input.
 *
 * The framing is the one `vm/lower.py` writes: the input little-endian, then
 * the output a byte at a time with one feed between each. `read` never
 * commits, so only a feed moves the stream on.
 *
 * @param {Uint8Array} artifact
 * @param {number[]} feedBytes  the input, already little-endian
 * @param {number} outBytes
 * @returns {bigint} the output word
 */
export async function evaluate(artifact, feedBytes, outBytes) {
  await load();
  return evaluateLoaded(artifact, feedBytes, outBytes);
}

/**
 * The same call, synchronously, once `load()` has been awaited.
 *
 * A wasm import cannot be async, and the driver's kernel *is* a wasm import:
 * `main` calls the kernel, and what answers is this machine running the
 * artifact. So the module is loaded first and the call itself does no waiting.
 *
 * @param {Uint8Array} artifact
 * @param {number[]} feedBytes  the input, already little-endian
 * @param {number} outBytes
 * @returns {bigint} the output word
 */
export function evaluateLoaded(artifact, feedBytes, outBytes) {
  if (!instance) throw new Error('vm.wasm is not loaded yet');
  const E = instance.exports;
  const memory = new Uint8Array(E.memory.buffer);
  memory.set(artifact, E.vm_buffer());
  if (!E.vm_load(artifact.length)) {
    // Running out of table is this module's limit, not a statement about the
    // artifact. Reporting the two the same way blamed a perfectly canonical
    // image for a size the machine happened not to have room for.
    if (E.vm_table_full && E.vm_table_full()) {
      throw new Error('the image is larger than this machine has room for');
    }
    throw new Error('the artifact did not open as a canonical image');
  }

  for (const byte of feedBytes) {
    const status = E.vm_feed(byte);
    if (status === UNFINISHED) throw new Error('the machine did not finish');
    if (status === DEAD) throw new Error('the machine refused an input byte');
  }

  let out = 0n;
  for (let k = 0; k < outBytes; k += 1) {
    const byte = E.vm_read();
    if (byte === UNFINISHED) throw new Error('the machine did not finish');
    if (byte === BOTTOM) throw new Error('the machine emitted no byte');
    out |= BigInt(byte) << BigInt(8 * k);
    if (k + 1 < outBytes) E.vm_feed(0);
  }
  return out;
}

export function decodeArtifact(base64) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
