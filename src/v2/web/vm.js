// The rSUBLEQ machine, compiled.
//
// `qm.browser.artifact` normalizes the minimized program into one canonical
// signed image and hands over `pack(code(z))`. This runs it — `open`, `feed`,
// `read`, and nothing else. Whether the paste was C, an x86-64 listing or a
// wasm32 listing stops mattering here: all three arrive as the same artifact.
//
// `vm/wasm/vm.c` is the source; `vm/wasm/build.py` compiles it and
// `tests/test_vm.py` holds it against the Python reference in `vm/machine.py`.

import { openPageBundle } from './page-fabric.js';

const MANIFEST_URL = new URL('./vm.json', import.meta.url);

// Outcomes, shared with the C and the Python.
const BOTTOM = -1;
const UNFINISHED = -2;
const DEAD = 0;

let instance = null;
let compiled = null;
let stepMemorySource = null;
let stepQueue = Promise.resolve();

const runtimeIncarnation = (() => {
  const words = new Uint32Array(4);
  globalThis.crypto.getRandomValues(words);
  return Array.from(words, word => word.toString(16).padStart(8, '0')).join('');
})();

function serializeStep(work) {
  const result = stepQueue.then(work, work);
  stepQueue = result.catch(() => {});
  return result;
}

export class MachineUnavailable extends Error {}

export async function compile() {
  if (compiled) return compiled;
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
    const manifest = await response.json();
    const vm = manifest?.vm;
    const delivery = vm?.delivery;
    if (!vm || !delivery) throw new Error('vm delivery manifest is invalid');
    const fabric = await openPageBundle({
      url: new URL(delivery.file, MANIFEST_URL).href,
      prefixBytes: delivery.prefix_bytes,
      prefixSha256: delivery.prefix_sha256,
      objectSha256: vm.sha256,
    });
    if (fabric.length !== vm.bytes) throw new Error('vm delivery length is invalid');
    const bytes = await fabric.read(0, fabric.length);
    compiled = await WebAssembly.compile(bytes);
    fabric.release();
    return compiled;
  } catch (err) {
    throw new MachineUnavailable(`cannot load vm.wasm delivery (${err.message})`);
  }
}

export async function load(precompiled = null) {
  if (instance) return instance;
  const module = precompiled || await compile();
  instance = await WebAssembly.instantiate(module, {});
  return instance;
}

/** Release this worker's linear memory while retaining compiled code. */
export function release() {
  instance = null;
  stepMemorySource = null;
}

/**
 * Run one normalized, flat integer function body as a child of vm.wasm.
 *
 * `source` is the same direct-coordinate reader used by PageBundle: it owns
 * `length` and an async `read(offset, length)`. Child code is never handed to
 * WebAssembly.compile. A page miss returns to this outer barrier, is filled,
 * and resumes the retained machine state.
 */
export async function executeGuestBody(source, bodyStart, bodyEnd,
                                       args = [], quantum = 1 << 16) {
  if (!source || !Number.isSafeInteger(source.length)
      || typeof source.read !== 'function') {
    throw new TypeError('child Wasm needs a direct-coordinate byte source');
  }
  if (!Number.isSafeInteger(bodyStart) || !Number.isSafeInteger(bodyEnd)
      || bodyStart < 0 || bodyEnd <= bodyStart || bodyEnd > source.length) {
    throw new RangeError('child Wasm body extent is invalid');
  }
  if (!Number.isSafeInteger(quantum) || quantum <= 0) {
    throw new RangeError('child Wasm quantum must be positive');
  }
  const loaded = await load();
  const E = loaded.exports;
  if (!E.vm_guest_open(source.length, bodyStart, bodyEnd)) {
    throw new Error('vm.wasm rejected the child module extent');
  }
  const valuesAt = E.vm_guest_values();
  const memory = new DataView(E.memory.buffer);
  args.forEach((value, index) => {
    memory.setBigUint64(valuesAt + index * 8, BigInt.asUintN(64, BigInt(value)), true);
  });
  if (!E.vm_guest_begin(args.length)) {
    throw new Error('vm.wasm rejected the child arguments');
  }

  for (;;) {
    const status = E.vm_guest_step(quantum);
    if (status === 0) continue;
    if (status === 1) {
      const page = E.vm_guest_requested_page();
      const offset = page * 65536;
      const length = Math.min(65536, source.length - offset);
      const bytes = await source.read(offset, length);
      if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
        throw new Error('child Wasm code page has the wrong extent');
      }
      new Uint8Array(E.memory.buffer, E.vm_guest_page_buffer(), length).set(bytes);
      if (!E.vm_guest_supply_code(page, length)) {
        throw new Error('vm.wasm rejected the requested child code page');
      }
      continue;
    }
    if (status === 2) return E.vm_guest_result();
    throw new Error(`child Wasm trapped in vm.wasm (${E.vm_guest_error()})`);
  }
}

/**
 * Execute one authenticated QM STEP page directly inside vm.wasm.
 *
 * The source owns physical coordinates and may be a PageBundle, blob, or a
 * test reader. No decoded Wasm instruction or SSA object crosses JavaScript;
 * only the entry cut and the terminal cut do.
 */
export function executeStateStep(source, offset, length,
                                 locals = [], stack = [], options = {}) {
  return serializeStep(() => executeStateStepExclusive(
    source, offset, length, locals, stack, options,
  ));
}

/**
 * Execute a resident pure STEP page synchronously.
 *
 * This is the state-cut bridge used by the x86 decoder while it is still a
 * migration frontend. The worker loads vm.wasm before exposing the bridge,
 * and only the packed page plus its entry/exit cut crosses that boundary.
 * A memory request is rejected: load/store must remain an explicit machine
 * barrier instead of silently falling back to JavaScript or Python.
 */
export function executePureStateStepLoaded(page, locals = [], stack = []) {
  if (!instance) throw new MachineUnavailable('vm.wasm is not loaded yet');
  if (!(page instanceof Uint8Array) || !page.length) {
    throw new TypeError('pure state step must be a packed byte page');
  }
  const E = instance.exports;
  const session = E.vm_step_acquire();
  if (session === 0n) throw new Error('vm.wasm has no free state-step lease');
  try {
    const stepAt = E.vm_step_buffer(session);
    new Uint8Array(E.memory.buffer, stepAt, page.length).set(page);
    if (!E.vm_step_open(session, page.length)) {
      throw new Error(`vm.wasm rejected the state-step page (${E.vm_step_error(session)})`);
    }
    const localSize = E.vm_step_local_size(session);
    const stackSize = E.vm_step_input_stack_size(session);
    if (locals.length !== localSize || stack.length !== stackSize) {
      throw new Error('pure state-step entry cut has the wrong extent');
    }
    const memory = new DataView(E.memory.buffer);
    const localsAt = E.vm_step_locals(session);
    const stackAt = E.vm_step_stack(session);
    locals.forEach((value, index) => {
      memory.setBigUint64(
        localsAt + index * 8, BigInt.asUintN(64, BigInt(value)), true,
      );
    });
    stack.forEach((value, index) => {
      memory.setBigUint64(
        stackAt + index * 8, BigInt.asUintN(64, BigInt(value)), true,
      );
    });
    const status = E.vm_step_execute(session, locals.length, stack.length);
    if (status === 1 || status === 3) {
      throw new Error('pure state step crossed a memory barrier');
    }
    if (status !== 2) {
      throw new Error(`pure state step trapped in vm.wasm (${E.vm_step_error(session)})`);
    }
    return {
      functionIndex: E.vm_step_function(session),
      nextPc: E.vm_step_next_pc(session),
      locals: Array.from({ length: E.vm_step_local_size(session) },
        (_unused, index) => memory.getBigUint64(localsAt + index * 8, true)),
      stack: Array.from({ length: E.vm_step_stack_size(session) },
        (_unused, index) => memory.getBigUint64(stackAt + index * 8, true)),
      work: E.vm_step_work(session),
      span: E.vm_step_span(session),
    };
  } finally {
    if (!E.vm_step_release(session)) {
      stepMemorySource = null;
      throw new Error('vm.wasm rejected the state-step lease release');
    }
  }
}

function encodeBytes(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/**
 * Execute one x86 virtual-memory state page wholly inside vm.wasm.
 *
 * Only demanded 4 KiB virtual coordinates cross this synchronous bridge.
 * The callbacks are the frontend's MMU view; arithmetic, memory ordering,
 * flags, and the complete SSA cut remain resident in vm.wasm.
 */
export function executeVirtualStateStepLoaded(
  page, locals = [], stack = [], readPage, writePage,
) {
  if (!instance) throw new MachineUnavailable('vm.wasm is not loaded yet');
  if (!(page instanceof Uint8Array) || !page.length) {
    throw new TypeError('virtual state step must be a packed byte page');
  }
  if (typeof readPage !== 'function' || typeof writePage !== 'function') {
    throw new TypeError('virtual state step needs memory callbacks');
  }
  const E = instance.exports;
  const session = E.vm_step_acquire();
  if (session === 0n) throw new Error('vm.wasm has no free state-step lease');
  const noCoordinate = 0xffffffffffffffffn;
  try {
    if (!E.vm_step_memory_open_virtual(session, 12)) {
      throw new Error('vm.wasm rejected the x86 virtual address space');
    }
    const stepAt = E.vm_step_buffer(session);
    new Uint8Array(E.memory.buffer, stepAt, page.length).set(page);
    if (!E.vm_step_open(session, page.length)) {
      throw new Error(`vm.wasm rejected the state-step page (${E.vm_step_error(session)})`);
    }
    const localSize = E.vm_step_local_size(session);
    const stackSize = E.vm_step_input_stack_size(session);
    if (locals.length !== localSize || stack.length !== stackSize) {
      throw new Error('virtual state-step entry cut has the wrong extent');
    }
    const memory = new DataView(E.memory.buffer);
    const localsAt = E.vm_step_locals(session);
    const stackAt = E.vm_step_stack(session);
    locals.forEach((value, index) => memory.setBigUint64(
      localsAt + index * 8, BigInt.asUintN(64, BigInt(value)), true,
    ));
    stack.forEach((value, index) => memory.setBigUint64(
      stackAt + index * 8, BigInt.asUintN(64, BigInt(value)), true,
    ));

    const transfer = (dirty) => {
      const lease = E.vm_step_memory_lease(session);
      const coordinate = BigInt.asUintN(
        64, E.vm_step_memory_coordinate(session, lease),
      );
      if (coordinate === noCoordinate) {
        throw new Error('vm.wasm returned an invalid virtual coordinate');
      }
      const pageBytes = E.vm_step_memory_page_size(session, lease);
      const address = BigInt.asUintN(64, coordinate << 12n).toString();
      const bufferAt = E.vm_step_memory_page_buffer(session, lease);
      if (dirty) {
        const bytes = new Uint8Array(
          E.memory.buffer, bufferAt, pageBytes,
        ).slice();
        writePage(address, encodeBytes(bytes));
        if (!E.vm_step_ack_memory_coordinate(session, lease, coordinate)) {
          throw new Error('vm.wasm rejected a dirty virtual page');
        }
      } else {
        const bytes = decodeArtifact(String(readPage(address, pageBytes)));
        if (bytes.length !== pageBytes) {
          throw new Error('x86 virtual page has the wrong extent');
        }
        new Uint8Array(E.memory.buffer, bufferAt, pageBytes).set(bytes);
        if (!E.vm_step_supply_memory_coordinate(
          session, lease, coordinate, pageBytes,
        )) {
          throw new Error('vm.wasm rejected a supplied virtual page');
        }
      }
    };

    for (;;) {
      const status = E.vm_step_execute(session, locals.length, stack.length);
      if (status === 2) break;
      if (status === 1) transfer(false);
      else if (status === 3) transfer(true);
      else throw new Error(
        `virtual state step trapped in vm.wasm (${E.vm_step_error(session)})`,
      );
    }
    for (;;) {
      const coordinate = BigInt.asUintN(
        64, E.vm_step_first_dirty_memory_coordinate(session),
      );
      if (coordinate === noCoordinate) break;
      transfer(true);
    }
    return {
      functionIndex: E.vm_step_function(session),
      nextPc: E.vm_step_next_pc(session),
      locals: Array.from({ length: E.vm_step_local_size(session) },
        (_unused, index) => memory.getBigUint64(localsAt + index * 8, true)),
      stack: Array.from({ length: E.vm_step_stack_size(session) },
        (_unused, index) => memory.getBigUint64(stackAt + index * 8, true)),
      work: E.vm_step_work(session),
      span: E.vm_step_span(session),
    };
  } finally {
    if (!E.vm_step_release(session)) {
      throw new Error('vm.wasm rejected the virtual state-step lease release');
    }
  }
}

async function executeStateStepExclusive(source, offset, length,
                                         locals, stack, options) {
  if (!source || typeof source.read !== 'function'
      || !Number.isSafeInteger(source.length) || source.length < 0) {
    throw new TypeError('state step needs a direct-coordinate byte source');
  }
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length <= 0 || offset + length > source.length) {
    throw new RangeError('state-step page extent is invalid');
  }
  const loaded = await load();
  const E = loaded.exports;
  const session = E.vm_step_acquire();
  if (session === 0n) throw new Error('vm.wasm has no free state-step lease');
  let completed = false;
  try {
    const stepAt = E.vm_step_buffer(session);
    const guestMemory = options.memory ?? null;
    if (guestMemory) {
      if (!Number.isSafeInteger(guestMemory.length)
          || guestMemory.length <= 0 || guestMemory.length > 0xffffffff
          || typeof guestMemory.read !== 'function') {
        throw new TypeError('state-step memory needs a finite coordinate reader');
      }
      if (stepMemorySource !== guestMemory) {
        if (!E.vm_step_memory_open(session, guestMemory.length)) {
          throw new Error('vm.wasm rejected the state-step memory extent');
        }
        stepMemorySource = guestMemory;
      }
    }
    const bytes = await source.read(offset, length);
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
      throw new Error('state-step page has the wrong extent');
    }
    new Uint8Array(E.memory.buffer, stepAt, length).set(bytes);
    if (!E.vm_step_open(session, length)) {
      throw new Error(`vm.wasm rejected the state-step page (${E.vm_step_error(session)})`);
    }
    const localSize = E.vm_step_local_size(session);
    const entryLocals = options.initializeLocals && locals.length <= localSize
      ? [...locals, ...Array(localSize - locals.length).fill(0n)]
      : locals;
    if (entryLocals.length !== localSize
        || stack.length !== E.vm_step_input_stack_size(session)) {
      throw new Error('state-step entry cut has the wrong extent');
    }
    const memory = new DataView(E.memory.buffer);
    const localsAt = E.vm_step_locals(session);
    const stackAt = E.vm_step_stack(session);
    entryLocals.forEach((value, index) => {
      memory.setBigUint64(localsAt + index * 8,
        BigInt.asUintN(64, BigInt(value)), true);
    });
    stack.forEach((value, index) => {
      memory.setBigUint64(stackAt + index * 8,
        BigInt.asUintN(64, BigInt(value)), true);
    });
    const memoryGeneration = E.vm_step_memory_generation(session);
    const transfer = (lease, page) => ({
      incarnation: runtimeIncarnation,
      memoryGeneration: memoryGeneration.toString(),
      session: session.toString(),
      lease: lease.toString(),
      page,
    });
    for (;;) {
      const status = E.vm_step_execute(session, entryLocals.length, stack.length);
      if (status === 2) break;
      if (status === 1) {
        if (!guestMemory) throw new Error('state-step needs guest memory');
        const lease = E.vm_step_memory_lease(session);
        const page = E.vm_step_memory_page(session, lease);
        const pageBytes = E.vm_step_memory_page_size(session, lease);
        const bytes = await guestMemory.read(
          page * 65536, pageBytes, transfer(lease, page),
        );
        if (!(bytes instanceof Uint8Array) || bytes.length !== pageBytes) {
          throw new Error('state-step memory page has the wrong extent');
        }
        new Uint8Array(
          E.memory.buffer,
          E.vm_step_memory_page_buffer(session, lease),
          pageBytes,
        ).set(bytes);
        if (!E.vm_step_supply_memory_page(
          session, lease, page, pageBytes,
        )) {
          throw new Error('vm.wasm rejected the supplied memory page');
        }
        continue;
      }
      if (status === 3) {
        if (!guestMemory || typeof guestMemory.write !== 'function') {
          throw new Error('state-step dirty memory needs a COW writer');
        }
        const lease = E.vm_step_memory_lease(session);
        const page = E.vm_step_memory_page(session, lease);
        const pageBytes = E.vm_step_memory_page_size(session, lease);
        const bytes = new Uint8Array(
          E.memory.buffer,
          E.vm_step_memory_page_buffer(session, lease),
          pageBytes,
        ).slice();
        await guestMemory.write(
          page * 65536, bytes, transfer(lease, page),
        );
        if (!E.vm_step_ack_memory_page(session, lease, page)) {
          throw new Error('vm.wasm rejected the persisted dirty page');
        }
        continue;
      }
      throw new Error(`state-step trapped in vm.wasm (${E.vm_step_error(session)})`);
    }
    if (guestMemory) {
      for (;;) {
        const page = E.vm_step_first_dirty_memory_page(session);
        if (page === -1 || page === 0xffffffff) break;
        if (typeof guestMemory.write !== 'function') {
          throw new Error('state-step dirty memory needs a COW writer');
        }
        const lease = E.vm_step_memory_lease(session);
        const pageBytes = E.vm_step_memory_page_size(session, lease);
        const bytes = new Uint8Array(
          E.memory.buffer,
          E.vm_step_memory_page_buffer(session, lease),
          pageBytes,
        ).slice();
        await guestMemory.write(
          page * 65536, bytes, transfer(lease, page),
        );
        if (!E.vm_step_ack_memory_page(session, lease, page)) {
          throw new Error('vm.wasm rejected the persisted dirty page');
        }
      }
    }
    const nextLocals = Array.from({ length: E.vm_step_local_size(session) },
      (_unused, index) => memory.getBigUint64(localsAt + index * 8, true));
    const nextStack = Array.from({ length: E.vm_step_stack_size(session) },
      (_unused, index) => memory.getBigUint64(stackAt + index * 8, true));
    const result = {
      functionIndex: E.vm_step_function(session),
      nextPc: E.vm_step_next_pc(session),
      locals: nextLocals,
      stack: nextStack,
      work: E.vm_step_work(session),
      span: E.vm_step_span(session),
    };
    completed = true;
    return result;
  } finally {
    if (!completed) stepMemorySource = null;
    if (!E.vm_step_release(session)) {
      stepMemorySource = null;
      throw new Error('vm.wasm rejected the state-step lease release');
    }
  }
}

export async function executeGuestFunction(source, regions, functionIndex,
                                           args = [], quantum = 1 << 16) {
  if (!regions || typeof regions.body !== 'function') {
    throw new TypeError('child Wasm needs a function-region view');
  }
  const body = await regions.body(functionIndex);
  if (!body) throw new Error(`child Wasm function ${functionIndex} has no body`);
  return executeGuestBody(source, body.start, body.end, args, quantum);
}

/**
 * Apply one batch of fixed SHA3 records inside vm.wasm.
 *
 * All byte arrays are copied once at the residual boundary. The 25 lanes,
 * intermediate digests and complete rate blocks never cross into JavaScript.
 */
export function mixSpongeRecordsLoaded(
  lanes, tail, seed, records, rounds = 8,
) {
  if (!instance) throw new Error('vm.wasm is not loaded yet');
  if (lanes.length !== 200) throw new Error('sponge state needs 25 u64 lanes');
  if (tail.length >= 136) throw new Error('sponge tail must be incomplete');
  if (seed.length !== 32) throw new Error('sponge seed must be 32 bytes');
  if (records.length % 24) throw new Error('sponge records must be 24 bytes');
  const E = instance.exports;
  const memory = new Uint8Array(E.memory.buffer);
  const lanesAt = E.vm_sponge_lanes();
  const tailAt = E.vm_sponge_tail();
  const inputAt = E.vm_buffer();
  memory.set(lanes, lanesAt);
  memory.set(tail, tailAt);
  memory.set(seed, inputAt);
  memory.set(records, inputAt + 32);
  if (!E.vm_set_sponge_tail_size(tail.length)
      || !E.vm_sponge_records(records.length / 24, rounds)) {
    throw new Error('vm.wasm rejected the sponge residual');
  }
  const tailSize = E.vm_sponge_tail_size();
  return {
    lanes: memory.slice(lanesAt, lanesAt + 200),
    tail: memory.slice(tailAt, tailAt + tailSize),
  };
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
 * Bind a 16-bit-to-8-bit artifact to the VM's vector combine operation.
 *
 * Each source byte is the low input byte and the corresponding `fixedBytes`
 * entry is the high byte. The first vector assigns the target; later vectors
 * XOR into it. This is the hot shape used by GF(2^8) erasure recovery, but the
 * VM executes the supplied artifact rather than embedding a second field-math
 * implementation in JavaScript.
 */
export async function prepareByteCombiner(artifact, precompiled = null) {
  const loaded = await load(precompiled);
  const E = loaded.exports;
  const memory = new Uint8Array(E.memory.buffer);
  const artifactAt = E.vm_buffer();
  const sourceAt = E.vm_eval_source();
  const targetAt = E.vm_eval_target();
  const capacity = Number(E.vm_eval_batch_capacity());
  if (artifact.length > sourceAt - artifactAt) {
    throw new RangeError('the artifact overlaps the byte-combine workspace');
  }
  memory.set(artifact, artifactAt);
  if (!E.vm_prepare_eval(artifact.length, 16, 2, 1)) {
    throw new Error('the artifact did not open as a 16-to-8-bit kernel');
  }

  return {
    capacity,
    combine(sources, fixedBytes) {
      if (!Array.isArray(sources) || !sources.length
          || !Array.isArray(fixedBytes)
          || fixedBytes.length !== sources.length) {
        throw new TypeError('byte combine needs equally sized source and fixed-byte arrays');
      }
      const count = sources[0] instanceof Uint8Array ? sources[0].length : -1;
      if (count < 0 || count > capacity) {
        throw new RangeError('byte-combine extent exceeds the VM workspace');
      }
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const fixed = fixedBytes[index];
        if (!(source instanceof Uint8Array) || source.length !== count
            || !Number.isInteger(fixed) || fixed < 0 || fixed > 255) {
          throw new TypeError('byte-combine inputs must have one shared extent and byte coefficients');
        }
        memory.set(source, sourceAt);
        if (!E.vm_eval_byte_combine(count, fixed, Number(index === 0))) {
          throw new Error('the VM rejected the byte-combine operation');
        }
      }
      return memory.slice(targetAt, targetAt + count);
    },
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
