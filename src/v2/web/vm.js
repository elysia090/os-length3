// The rSUBLEQ machine, compiled.
//
// `qm.browser.artifact` normalizes the minimized program into one canonical
// signed image and hands over `pack(code(z))`. This runs it — `open`, `feed`,
// `read`, and nothing else. Whether the paste was C, an x86-64 listing or a
// wasm32 listing stops mattering here: all three arrive as the same artifact.
//
// `vm/wasm/vm.c` is the source; `vm/wasm/build.py` compiles it and
// `tests/test_vm.py` holds it against the Python reference in `vm/machine.py`.

import { readArtifact } from './artifact.js';

// Outcomes, shared with the C and the Python.
const BOTTOM = -1;
const UNFINISHED = -2;
const DEAD = 0;

let instance = null;
let compiled = null;
let stepMemorySource = null;
let stepQueue = Promise.resolve();

function publishRuntimeAbi(module) {
  globalThis.QM_X86_CLASS_ABI = WebAssembly.Module.exports(module).some(
    ({ name }) => name === 'vm_x86_resident_abi',
  );
  return module;
}

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
  // Native regression runners may inject an already compiled candidate.  The
  // browser never defines this hook and still has one content-addressed
  // artifact route; keeping the hook at the module boundary lets a candidate
  // VM be measured without publishing it as the new canonical artifact first.
  if (globalThis.QM_TEST_VM_MODULE instanceof WebAssembly.Module) {
    compiled = publishRuntimeAbi(globalThis.QM_TEST_VM_MODULE);
    return compiled;
  }
  try {
    const opened = await readArtifact('vm');
    compiled = publishRuntimeAbi(await WebAssembly.compile(opened.bytes));
    opened.fabric.release();
    return compiled;
  } catch (err) {
    throw new MachineUnavailable(`cannot load vm artifact (${err.message})`);
  }
}

export async function load(precompiled = null) {
  if (instance) return instance;
  const module = precompiled || await compile();
  instance = await WebAssembly.instantiate(module, {});
  return instance;
}

const X86_STATUS = Object.freeze({
  needBlock: 4,
  yielded: 5,
  halted: 6,
  needPhysical: 7,
  dirtyPhysical: 8,
  internal: 9,
  consoleWrite: 10,
  clock: 11,
  entropy: 12,
  codeMismatch: 13,
});
const X86_PHYSICAL_PAGE_BYTES = 4096;
const X86_EXECUTABLE_INDEX = 1;
const X86_EXECUTABLE_MODULE = 2;
const X86_EXECUTABLE_INSTALL = 3;
const X86_EXECUTABLE_READY = 4;
const X86_EXECUTABLE_RESOURCE = 5;
const X86_EXECUTABLE_PAGE_READY = 6;
const X86_EXECUTABLE_CODE_READY = 7;
const X86_EXECUTABLE_MAP_READY = 8;
const X86_EXECUTABLE_RESIDUAL_READY = 9;
const X86_EXECUTABLE_KERNEL_READY = 10;
const X86_EXECUTABLE_INSTANTIATION_READY = 11;

function directObjectSource(source) {
  if (!source || typeof source.read !== 'function') {
    throw new TypeError('direct executable needs a digest-coordinate source');
  }
  return source;
}

function directRequestDigest(E, session) {
  const at = E.vm_x86_executable_request_digest(session);
  if (!at) throw new Error('vm.wasm omitted the requested object digest');
  return Array.from(
    new Uint8Array(E.memory.buffer, at, 32),
    value => value.toString(16).padStart(2, '0'),
  ).join('');
}

function directSafeNumber(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is outside the browser integer range`);
  }
  return number;
}

async function instantiateDirectModule(E, table, base, bytes) {
  await WebAssembly.instantiate(bytes, {
    env: {
      memory: E.memory,
      table,
      table_base: new WebAssembly.Global(
        { value: 'i32', mutable: false }, base,
      ),
      direct_memory: E.vm_x86_direct_memory,
      direct_memory_result: E.vm_x86_direct_memory_result,
      direct_memory_region: E.vm_x86_direct_memory_region,
      direct_memory_region_value: E.vm_x86_direct_memory_region_value,
      direct_memory_repeat: E.vm_x86_direct_memory_repeat,
      direct_memory_copy: E.vm_x86_direct_memory_copy,
      direct_memory_find2: E.vm_x86_direct_memory_find2,
      direct_memory_commit: E.vm_x86_direct_memory_commit,
      direct_x86_divide: E.vm_x86_direct_divide,
      direct_x86_divide_result: E.vm_x86_direct_divide_result,
      direct_x86_segment_base: E.vm_x86_direct_segment_base,
      direct_x86_rotate_carry: E.vm_x86_direct_rotate_carry,
      direct_x86_rotate_carry_result: E.vm_x86_direct_rotate_carry_result,
      direct_memory_store_if: E.vm_x86_direct_memory_store_if,
      direct_memory_frame: E.vm_x86_direct_memory_frame,
      direct_x86_crc32: E.vm_x86_direct_crc32,
      direct_x86_write_msr: E.vm_x86_direct_write_msr,
      direct_x86_far_return: E.vm_x86_direct_far_return,
      direct_x86_write_control: E.vm_x86_direct_write_control,
      direct_x86_read_control: E.vm_x86_direct_read_control,
      direct_x86_write_segment: E.vm_x86_direct_write_segment,
      direct_x86_descriptor_table: E.vm_x86_direct_descriptor_table,
      direct_x86_pop_flags: E.vm_x86_direct_pop_flags,
      direct_x86_read_msr: E.vm_x86_direct_read_msr,
      direct_x86_cpuid: E.vm_x86_direct_cpuid,
      direct_x86_interrupt_flag: E.vm_x86_direct_interrupt_flag,
      direct_x86_port_io: E.vm_x86_direct_port_io,
      direct_x86_swap_gs: E.vm_x86_direct_swap_gs,
      direct_x86_invalidate_page: E.vm_x86_direct_invalidate_page,
      direct_x86_system_transfer: E.vm_x86_direct_system_transfer,
      direct_x86_interrupt_return: E.vm_x86_direct_interrupt_return,
      direct_x86_atomic: E.vm_x86_direct_atomic,
      direct_x86_vector: E.vm_x86_direct_vector,
      direct_x86_read_selector: E.vm_x86_direct_read_selector,
      direct_x86_software_interrupt: E.vm_x86_direct_software_interrupt,
      direct_x86_far_transfer: E.vm_x86_direct_far_transfer,
      direct_x86_x87: E.vm_x86_direct_x87,
      direct_x86_time: E.vm_x86_direct_time,
      direct_x86_validate_selector: E.vm_x86_direct_validate_selector,
      direct_x86_string: E.vm_x86_direct_string,
      direct_x86_memory_order: E.vm_x86_direct_memory_order,
      direct_x86_debug_register: E.vm_x86_direct_debug_register,
      direct_x86_system_selector: E.vm_x86_direct_system_selector,
      direct_x86_cr0_status: E.vm_x86_direct_cr0_status,
      direct_x86_segment_stack: E.vm_x86_direct_segment_stack,
      direct_x86_entropy: E.vm_x86_direct_entropy,
    },
  });
}

/**
 * Admit one compiler-produced executable through vm.wasm's C state machine.
 *
 * JavaScript sees only `(digest, total bytes, offset, length)` requests.  C
 * authenticates index structure and row semantics, hashes the module stream,
 * and publishes table geometry.  The verified bounded module installs its own
 * functions through an element segment; no export enumeration or block record
 * reconstruction exists in this path.
 */
export async function admitX86Executable(E, session, root, source) {
  if (!(root instanceof Uint8Array)) {
    throw new TypeError('direct executable root must be bytes');
  }
  source = directObjectSource(source);
  const table = E.__indirect_function_table;
  if (!(table instanceof WebAssembly.Table)
      || !(E.memory instanceof WebAssembly.Memory)) {
    throw new Error('vm.wasm omitted its shared executable ABI');
  }
  const rootAt = E.vm_x86_executable_buffer(session);
  const rootBytes = E.vm_x86_executable_buffer_bytes();
  if (!rootAt || root.length !== rootBytes) {
    throw new Error('vm.wasm rejected the fixed executable root extent');
  }
  new Uint8Array(E.memory.buffer, rootAt, rootBytes).set(root);
  const tableBase = table.length;
  if (!E.vm_x86_executable_begin(session, BigInt(rootBytes), tableBase)) {
    throw new Error('vm.wasm rejected the executable root');
  }

  let moduleBytes = null;
  let moduleDigest = null;
  try {
    for (;;) {
      const kind = E.vm_x86_executable_request_kind(session);
      if (kind === X86_EXECUTABLE_READY) break;
      if (kind === X86_EXECUTABLE_INDEX
          || kind === X86_EXECUTABLE_MODULE) {
        const digest = directRequestDigest(E, session);
        const total = directSafeNumber(
          E.vm_x86_executable_request_bytes(session),
          'direct executable object extent',
        );
        const offset = directSafeNumber(
          E.vm_x86_executable_request_offset(session),
          'direct executable object offset',
        );
        const count = E.vm_x86_executable_request_buffer_bytes(session);
        const bufferAt = E.vm_x86_executable_request_buffer(session);
        if (!count || !bufferAt || offset + count > total) {
          throw new Error('vm.wasm requested an invalid object range');
        }
        const bytes = await source.read(digest, offset, count, total);
        if (!(bytes instanceof Uint8Array) || bytes.length !== count) {
          throw new Error(`object ${digest} returned the wrong range`);
        }
        new Uint8Array(E.memory.buffer, bufferAt, count).set(bytes);
        if (kind === X86_EXECUTABLE_MODULE) {
          if (moduleDigest !== digest) {
            moduleDigest = digest;
            moduleBytes = new Uint8Array(total);
          }
          moduleBytes.set(bytes, offset);
        }
        if (!E.vm_x86_executable_supply(session, count)) {
          throw new Error(`vm.wasm rejected object ${digest}`);
        }
        continue;
      }
      if (kind === X86_EXECUTABLE_INSTALL) {
        const digest = directRequestDigest(E, session);
        const base = E.vm_x86_executable_module_table_base(session);
        const functions = E.vm_x86_executable_module_function_count(session);
        if (!moduleBytes || moduleDigest !== digest || !base || !functions
            || base + functions < base) {
          throw new Error('vm.wasm published invalid module geometry');
        }
        if (base + functions > table.length) {
          table.grow(base + functions - table.length);
        }
        await instantiateDirectModule(E, table, base, moduleBytes);
        moduleBytes = null;
        moduleDigest = null;
        if (!E.vm_x86_executable_module_installed(session)) {
          throw new Error('vm.wasm rejected module installation');
        }
        continue;
      }
      throw new Error(`vm.wasm entered executable admission state ${kind}`);
    }
    if (!E.vm_x86_executable_commit(session)) {
      throw new Error('vm.wasm rejected executable publication');
    }
    return { tableBase };
  } catch (error) {
    E.vm_x86_executable_abort(session);
    throw error;
  }
}

/** Resolve one compiled RIP to its authenticated page-dispatch function. */
export async function supplyX86ExecutableCode(E, session, source) {
  source = directObjectSource(source);
  const table = E.__indirect_function_table;
  const started = E.vm_x86_executable_resolve_begin(session);
  if (started === 2) return;
  if (started !== 1 || !(table instanceof WebAssembly.Table)) {
    throw new Error('vm.wasm rejected the direct code-page request');
  }
  let moduleBytes = null;
  let moduleDigest = null;
  try {
    for (;;) {
      const kind = E.vm_x86_executable_request_kind(session);
      if (kind === X86_EXECUTABLE_CODE_READY) break;
      if (kind === X86_EXECUTABLE_INDEX
          || kind === X86_EXECUTABLE_MODULE) {
        const digest = directRequestDigest(E, session);
        const total = directSafeNumber(
          E.vm_x86_executable_request_bytes(session),
          'direct code object extent',
        );
        const offset = directSafeNumber(
          E.vm_x86_executable_request_offset(session),
          'direct code object offset',
        );
        const count = E.vm_x86_executable_request_buffer_bytes(session);
        const bufferAt = E.vm_x86_executable_request_buffer(session);
        if (!count || !bufferAt || offset + count > total) {
          throw new Error('vm.wasm requested an invalid code object range');
        }
        const bytes = await source.read(digest, offset, count, total);
        if (!(bytes instanceof Uint8Array) || bytes.length !== count) {
          throw new Error(`code object ${digest} returned the wrong range`);
        }
        new Uint8Array(E.memory.buffer, bufferAt, count).set(bytes);
        if (kind === X86_EXECUTABLE_MODULE) {
          if (moduleDigest !== digest) {
            moduleDigest = digest;
            moduleBytes = new Uint8Array(total);
          }
          moduleBytes.set(bytes, offset);
        }
        if (!E.vm_x86_executable_supply(session, count)) {
          throw new Error(`vm.wasm rejected code object ${digest}`);
        }
        continue;
      }
      if (kind === X86_EXECUTABLE_INSTALL) {
        const digest = directRequestDigest(E, session);
        const base = E.vm_x86_executable_module_table_base(session);
        const functions = E.vm_x86_executable_module_function_count(session);
        if (!moduleBytes || moduleDigest !== digest || !base || !functions
            || base + functions < base) {
          throw new Error('vm.wasm published invalid cold-module geometry');
        }
        if (base + functions > table.length) {
          table.grow(base + functions - table.length);
        }
        await instantiateDirectModule(E, table, base, moduleBytes);
        moduleBytes = null;
        moduleDigest = null;
        if (!E.vm_x86_executable_module_installed(session)) {
          throw new Error('vm.wasm rejected cold-module installation');
        }
        continue;
      }
      throw new Error(`vm.wasm entered code admission state ${kind}`);
    }
    if (!E.vm_x86_executable_resolve_commit(session)) {
      throw new Error('vm.wasm rejected page-dispatch publication');
    }
  } catch (error) {
    E.vm_x86_executable_resolve_abort(session);
    throw error;
  }
}

/**
 * Satisfy the VM's current cold physical-page cut from a direct executable.
 *
 * C owns the resource-index walk, row validation, complete page digest and
 * zero-tail publication. JavaScript forwards only the opaque object request
 * that C exposes; it cannot select an extent or manufacture a sparse page.
 */
export async function supplyX86ExecutablePhysical(E, session, source) {
  source = directObjectSource(source);
  if (!E.vm_x86_executable_physical_begin(session)) {
    throw new Error('vm.wasm rejected the direct physical-page request');
  }
  try {
    for (;;) {
      const kind = E.vm_x86_executable_request_kind(session);
      if (kind === X86_EXECUTABLE_PAGE_READY) break;
      if (kind !== X86_EXECUTABLE_INDEX
          && kind !== X86_EXECUTABLE_RESOURCE) {
        throw new Error(`vm.wasm entered physical admission state ${kind}`);
      }
      const digest = directRequestDigest(E, session);
      const total = directSafeNumber(
        E.vm_x86_executable_request_bytes(session),
        'direct physical object extent',
      );
      const offset = directSafeNumber(
        E.vm_x86_executable_request_offset(session),
        'direct physical object offset',
      );
      const count = E.vm_x86_executable_request_buffer_bytes(session);
      const bufferAt = E.vm_x86_executable_request_buffer(session);
      if (!count || !bufferAt || offset + count > total) {
        throw new Error('vm.wasm requested an invalid physical object range');
      }
      const bytes = await source.read(digest, offset, count, total);
      if (!(bytes instanceof Uint8Array) || bytes.length !== count) {
        throw new Error(`physical object ${digest} returned the wrong range`);
      }
      new Uint8Array(E.memory.buffer, bufferAt, count).set(bytes);
      if (!E.vm_x86_executable_supply(session, count)) {
        throw new Error(`vm.wasm rejected physical object ${digest}`);
      }
    }
    if (!E.vm_x86_executable_physical_commit(session)) {
      throw new Error('vm.wasm rejected direct physical-page publication');
    }
  } catch (error) {
    E.vm_x86_executable_physical_abort(session);
    throw error;
  }
}

/** Admit one cold physical entry-map row selected by a dispatcher token. */
export async function supplyX86ExecutableMap(E, session, source, result) {
  source = directObjectSource(source);
  const started = E.vm_x86_executable_map_begin(session, result);
  if (started === 2) return;
  if (started !== 1) {
    throw new Error('vm.wasm rejected the direct entry-map request');
  }
  try {
    for (;;) {
      const kind = E.vm_x86_executable_request_kind(session);
      if (kind === X86_EXECUTABLE_MAP_READY) break;
      if (kind !== X86_EXECUTABLE_INDEX
          && kind !== X86_EXECUTABLE_RESOURCE) {
        throw new Error(`vm.wasm entered entry-map admission state ${kind}`);
      }
      const digest = directRequestDigest(E, session);
      const total = directSafeNumber(
        E.vm_x86_executable_request_bytes(session),
        'direct entry-map object extent',
      );
      const offset = directSafeNumber(
        E.vm_x86_executable_request_offset(session),
        'direct entry-map object offset',
      );
      const count = E.vm_x86_executable_request_buffer_bytes(session);
      const bufferAt = E.vm_x86_executable_request_buffer(session);
      if (!count || !bufferAt || offset + count > total) {
        throw new Error('vm.wasm requested an invalid entry-map object range');
      }
      const bytes = await source.read(digest, offset, count, total);
      if (!(bytes instanceof Uint8Array) || bytes.length !== count) {
        throw new Error(`entry-map object ${digest} returned the wrong range`);
      }
      new Uint8Array(E.memory.buffer, bufferAt, count).set(bytes);
      if (!E.vm_x86_executable_supply(session, count)) {
        throw new Error(`vm.wasm rejected entry-map object ${digest}`);
      }
    }
    if (!E.vm_x86_executable_map_commit(session)) {
      throw new Error('vm.wasm rejected direct entry-map publication');
    }
  } catch (error) {
    E.vm_x86_executable_map_abort(session);
    throw error;
  }
}

/** Admit one successor-free kernel/edge descriptor page selected by C. */
export async function supplyX86ExecutableResidual(E, session, source, result) {
  source = directObjectSource(source);
  const started = E.vm_x86_executable_residual_begin(session, result);
  if (started === 2) return;
  if (started !== 1) {
    throw new Error('vm.wasm rejected the residual descriptor request');
  }
  try {
    for (;;) {
      const kind = E.vm_x86_executable_request_kind(session);
      if (kind === X86_EXECUTABLE_RESIDUAL_READY) break;
      if (kind !== X86_EXECUTABLE_INDEX
          && kind !== X86_EXECUTABLE_RESOURCE) {
        throw new Error(`vm.wasm entered residual admission state ${kind}`);
      }
      const digest = directRequestDigest(E, session);
      const total = directSafeNumber(
        E.vm_x86_executable_request_bytes(session),
        'residual descriptor object extent',
      );
      const offset = directSafeNumber(
        E.vm_x86_executable_request_offset(session),
        'residual descriptor object offset',
      );
      const count = E.vm_x86_executable_request_buffer_bytes(session);
      const bufferAt = E.vm_x86_executable_request_buffer(session);
      if (!count || !bufferAt || offset + count > total) {
        throw new Error('vm.wasm requested an invalid residual object range');
      }
      const bytes = await source.read(digest, offset, count, total);
      if (!(bytes instanceof Uint8Array) || bytes.length !== count) {
        throw new Error(`residual object ${digest} returned the wrong range`);
      }
      new Uint8Array(E.memory.buffer, bufferAt, count).set(bytes);
      if (!E.vm_x86_executable_supply(session, count)) {
        throw new Error(`vm.wasm rejected residual object ${digest}`);
      }
    }
    if (!E.vm_x86_executable_residual_commit(session)) {
      throw new Error('vm.wasm rejected residual descriptor publication');
    }
  } catch (error) {
    E.vm_x86_executable_residual_abort(session);
    throw error;
  }
}

/** Admit one exact-identity or parameter page selected by C. */
export async function supplyX86ExecutableInstantiation(
  E, session, source, result,
) {
  source = directObjectSource(source);
  const started = E.vm_x86_executable_instantiation_begin(session, result);
  if (started === 2) return;
  if (started !== 1) {
    throw new Error('vm.wasm rejected the instantiation page request');
  }
  try {
    for (;;) {
      const kind = E.vm_x86_executable_request_kind(session);
      if (kind === X86_EXECUTABLE_INSTANTIATION_READY) break;
      if (kind !== X86_EXECUTABLE_INDEX
          && kind !== X86_EXECUTABLE_RESOURCE) {
        throw new Error(
          `vm.wasm entered instantiation admission state ${kind}`,
        );
      }
      const digest = directRequestDigest(E, session);
      const total = directSafeNumber(
        E.vm_x86_executable_request_bytes(session),
        'instantiation page object extent',
      );
      const offset = directSafeNumber(
        E.vm_x86_executable_request_offset(session),
        'instantiation page object offset',
      );
      const count = E.vm_x86_executable_request_buffer_bytes(session);
      const bufferAt = E.vm_x86_executable_request_buffer(session);
      if (!count || !bufferAt || offset + count > total) {
        throw new Error('vm.wasm requested an invalid instantiation object');
      }
      const bytes = await source.read(digest, offset, count, total);
      if (!(bytes instanceof Uint8Array) || bytes.length !== count) {
        throw new Error(`instantiation object ${digest} has wrong range`);
      }
      new Uint8Array(E.memory.buffer, bufferAt, count).set(bytes);
      if (!E.vm_x86_executable_supply(session, count)) {
        throw new Error(`vm.wasm rejected instantiation object ${digest}`);
      }
    }
    if (!E.vm_x86_executable_instantiation_commit(session)) {
      throw new Error('vm.wasm rejected instantiation page publication');
    }
  } catch (error) {
    E.vm_x86_executable_instantiation_abort(session);
    throw error;
  }
}

/** Admit one bounded cold module selected by a residual kernel rank. */
export async function supplyX86ExecutableKernel(E, session, source, result) {
  source = directObjectSource(source);
  const table = E.__indirect_function_table;
  const started = E.vm_x86_executable_kernel_begin(session, result);
  if (started === 2) return;
  if (started !== 1 || !(table instanceof WebAssembly.Table)) {
    throw new Error('vm.wasm rejected the residual kernel request');
  }
  let moduleBytes = null;
  let moduleDigest = null;
  try {
    for (;;) {
      const kind = E.vm_x86_executable_request_kind(session);
      if (kind === X86_EXECUTABLE_KERNEL_READY) break;
      if (kind === X86_EXECUTABLE_INDEX
          || kind === X86_EXECUTABLE_MODULE) {
        const digest = directRequestDigest(E, session);
        const total = directSafeNumber(
          E.vm_x86_executable_request_bytes(session),
          'residual kernel object extent',
        );
        const offset = directSafeNumber(
          E.vm_x86_executable_request_offset(session),
          'residual kernel object offset',
        );
        const count = E.vm_x86_executable_request_buffer_bytes(session);
        const bufferAt = E.vm_x86_executable_request_buffer(session);
        if (!count || !bufferAt || offset + count > total) {
          throw new Error('vm.wasm requested an invalid kernel object range');
        }
        const bytes = await source.read(digest, offset, count, total);
        if (!(bytes instanceof Uint8Array) || bytes.length !== count) {
          throw new Error(`kernel object ${digest} returned the wrong range`);
        }
        new Uint8Array(E.memory.buffer, bufferAt, count).set(bytes);
        if (kind === X86_EXECUTABLE_MODULE) {
          if (moduleDigest !== digest) {
            moduleDigest = digest;
            moduleBytes = new Uint8Array(total);
          }
          moduleBytes.set(bytes, offset);
        }
        if (!E.vm_x86_executable_supply(session, count)) {
          throw new Error(`vm.wasm rejected kernel object ${digest}`);
        }
        continue;
      }
      if (kind === X86_EXECUTABLE_INSTALL) {
        const digest = directRequestDigest(E, session);
        const base = E.vm_x86_executable_module_table_base(session);
        const functions = E.vm_x86_executable_module_function_count(session);
        if (!moduleBytes || moduleDigest !== digest || !base || !functions
            || base + functions < base) {
          throw new Error('vm.wasm published invalid kernel module geometry');
        }
        if (base + functions > table.length) {
          table.grow(base + functions - table.length);
        }
        await instantiateDirectModule(E, table, base, moduleBytes);
        moduleBytes = null;
        moduleDigest = null;
        if (!E.vm_x86_executable_module_installed(session)) {
          throw new Error('vm.wasm rejected kernel module installation');
        }
        continue;
      }
      throw new Error(`vm.wasm entered kernel admission state ${kind}`);
    }
    if (!E.vm_x86_executable_kernel_commit(session)) {
      throw new Error('vm.wasm rejected kernel module publication');
    }
  } catch (error) {
    E.vm_x86_executable_kernel_abort(session);
    throw error;
  }
}

/** Open a compiler-produced machine without decoding host-side state or rows. */
export async function openDirectX86Machine({
  root, source, devices = {},
}) {
  if (!(root instanceof Uint8Array)) {
    throw new TypeError('direct x86 machine needs fixed root bytes');
  }
  source = directObjectSource(source);
  const loaded = await load();
  const E = loaded.exports;
  const session = E.vm_step_acquire();
  if (session === 0n) throw new Error('vm.wasm has no free x86 lease');
  try {
    await admitX86Executable(E, session, root, source);
    const entry = E.vm_x86_executable_entry_function(session);
    if (!Number.isSafeInteger(entry) || entry < 0 || entry === 0xffffffff) {
      throw new Error('vm.wasm omitted the direct executable entry');
    }
    const residual = E.vm_x86_executable_entry_residual(session);
    const residualEntry = Number.isSafeInteger(residual)
      && residual >= 0 && residual !== 0xffffffff ? residual : null;
    return new DirectX86Machine(
      E, session, entry, residualEntry, source, devices,
    );
  } catch (error) {
    E.vm_step_release(session);
    throw error;
  }
}

class DirectX86Machine {
  constructor(exports, session, entry, residual, source, devices) {
    this.exports = exports;
    this.session = session;
    this.functionRank = entry;
    this.residualRank = residual;
    this.source = source;
    this.devices = devices;
    this.dirtyPages = new Map();
    this.virtualClock = 0n;
    this.hostBarriers = {
      entryMapRead: 0,
      physicalRead: 0,
      physicalWrite: 0,
      consoleWrite: 0,
      clock: 0,
      entropy: 0,
      residualRead: 0,
      instantiationRead: 0,
      parameterRead: 0,
      kernelRead: 0,
    };
    this.closed = false;
  }

  assertOpen() {
    if (this.closed) throw new Error('direct x86 machine is released');
  }

  async publishDirtyPage() {
    const E = this.exports;
    const page = BigInt.asUintN(
      64, E.vm_x86_first_dirty_physical_page(this.session),
    );
    if (page === 0xffffffffffffffffn) return false;
    const lease = E.vm_x86_physical_lease(this.session);
    const coordinate = BigInt.asUintN(
      64, E.vm_x86_physical_coordinate(this.session, lease),
    );
    const at = E.vm_x86_physical_buffer(this.session, lease);
    if (!lease || coordinate !== page || !at) {
      throw new Error('vm.wasm published an invalid direct COW page');
    }
    const bytes = new Uint8Array(
      E.memory.buffer, at, X86_PHYSICAL_PAGE_BYTES,
    ).slice();
    this.dirtyPages.set(page.toString(), bytes);
    if (typeof this.devices.physicalWrite === 'function') {
      await this.devices.physicalWrite(page, bytes);
    }
    this.hostBarriers.physicalWrite += 1;
    if (!E.vm_x86_ack_physical(this.session, lease, page)) {
      throw new Error(`vm.wasm rejected direct COW page ${page}`);
    }
    return true;
  }

  async satisfyPhysical() {
    const E = this.exports;
    const lease = E.vm_x86_physical_lease(this.session);
    const page = BigInt.asUintN(
      64, E.vm_x86_physical_coordinate(this.session, lease),
    );
    const dirty = this.dirtyPages.get(page.toString());
    if (dirty) {
      const at = E.vm_x86_physical_buffer(this.session, lease);
      if (!lease || !at) throw new Error('vm.wasm omitted the COW page buffer');
      new Uint8Array(E.memory.buffer, at, X86_PHYSICAL_PAGE_BYTES).set(dirty);
      if (!E.vm_x86_supply_physical(
        this.session, lease, page, X86_PHYSICAL_PAGE_BYTES,
      )) throw new Error(`vm.wasm rejected resident COW page ${page}`);
    } else {
      await supplyX86ExecutablePhysical(E, this.session, this.source);
    }
    this.hostBarriers.physicalRead += 1;
  }

  async satisfyConsole() {
    const E = this.exports;
    const lease = E.vm_x86_console_lease(this.session);
    const count = E.vm_x86_console_output_count(this.session, lease);
    if (!lease || !Number.isSafeInteger(count) || count <= 0 || count > 256) {
      throw new Error('vm.wasm published an invalid direct console cut');
    }
    const bytes = Uint8Array.from(
      { length: count }, (_unused, index) =>
        E.vm_x86_console_output_peek(this.session, lease, index),
    );
    if (typeof this.devices.consoleWrite === 'function') {
      await this.devices.consoleWrite(bytes);
    }
    this.hostBarriers.consoleWrite += 1;
    if (!E.vm_x86_ack_console(this.session, lease)) {
      throw new Error('vm.wasm rejected the direct console acknowledgement');
    }
  }

  async satisfyClock() {
    const E = this.exports;
    const lease = E.vm_x86_clock_lease(this.session);
    if (!lease) throw new Error('vm.wasm published an invalid direct clock cut');
    const value = typeof this.devices.clock === 'function'
      ? await this.devices.clock({
        retired: BigInt.asUintN(64, E.vm_x86_retired(this.session)),
        prior: this.virtualClock,
      }) : this.virtualClock + 1n;
    this.virtualClock = BigInt.asUintN(64, BigInt(value));
    this.hostBarriers.clock += 1;
    if (!E.vm_x86_supply_clock(this.session, lease, this.virtualClock)) {
      throw new Error('vm.wasm rejected the direct clock acknowledgement');
    }
  }

  async satisfyEntropy() {
    const E = this.exports;
    const lease = E.vm_x86_entropy_lease(this.session);
    if (!lease) throw new Error('vm.wasm published an invalid direct entropy cut');
    let value;
    if (typeof this.devices.entropy === 'function') {
      value = await this.devices.entropy({
        retired: BigInt.asUintN(64, E.vm_x86_retired(this.session)),
        rip: BigInt.asUintN(64, E.vm_x86_rip(this.session)),
      });
    } else {
      const words = new Uint32Array(2);
      globalThis.crypto.getRandomValues(words);
      value = (BigInt(words[1]) << 32n) | BigInt(words[0]);
    }
    this.hostBarriers.entropy += 1;
    if (!E.vm_x86_supply_entropy(
      this.session, lease, BigInt.asUintN(64, BigInt(value)),
    )) throw new Error('vm.wasm rejected the direct entropy acknowledgement');
  }

  async projectResidual() {
    const E = this.exports;
    for (;;) {
      const result = E.vm_x86_executable_project_residual(this.session);
      const kind = Number(result & 7n);
      const payload = result >> 3n;
      if (kind === 0) {
        const residual = Number(payload);
        if (!Number.isSafeInteger(residual) || residual < 0) {
          throw new Error('vm.wasm published an invalid residual projection');
        }
        this.residualRank = residual;
        return;
      }
      if (kind === 1) {
        await supplyX86ExecutableCode(E, this.session, this.source);
        continue;
      }
      if (kind === 6) {
        await supplyX86ExecutableMap(E, this.session, this.source, result);
        this.hostBarriers.entryMapRead += 1;
        continue;
      }
      if (kind === 3) {
        throw new Error(`residual projection fault ${payload}`);
      }
      if (kind === 5) {
        throw new Error('residual projection generation became stale');
      }
      throw new Error(`vm.wasm returned invalid residual projection ${kind}`);
    }
  }

  async advance(maxBlocks = 1 << 16) {
    this.assertOpen();
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks <= 0) {
      throw new RangeError('direct x86 block quantum must be positive');
    }
    const E = this.exports;
    let completed = 0;
    const finish = (status) => ({
      ...this.status(status), completedBlocks: completed,
    });
    while (completed < maxBlocks) {
      const requested = Math.min(maxBlocks - completed, 0xffffffff);
      const residualMode = this.residualRank !== null;
      const result = residualMode
        ? E.vm_x86_execute_residual(
          this.session, this.residualRank, requested,
        )
        : E.vm_x86_execute_direct(
          this.session, this.functionRank, requested,
        );
      const batch = E.vm_x86_direct_blocks(this.session);
      if (!Number.isSafeInteger(batch) || batch < 0 || batch > requested) {
        throw new Error('vm.wasm published invalid direct block accounting');
      }
      const kind = Number(result & 7n);
      const payload = result >> 3n;
      if (residualMode) {
        const residentResidual = E.vm_x86_direct_residual(this.session);
        if (!Number.isSafeInteger(residentResidual) || residentResidual < 0
            || residentResidual === 0xffffffff) {
          throw new Error('vm.wasm lost the residual continuation rank');
        }
        this.residualRank = residentResidual;
      } else {
        const residentFunction = E.vm_x86_direct_function(this.session);
        if (!Number.isSafeInteger(residentFunction) || residentFunction < 0
            || residentFunction === 0xffffffff) {
          throw new Error('vm.wasm lost the direct continuation rank');
        }
        this.functionRank = residentFunction;
      }
      /* The last invocation did not publish its architectural cut when it
       * returned a retryable barrier. Earlier functions in the same quantum
       * did complete and must not be replayed. */
      /* Physical/entry-map cuts precede the final instruction commit.  UART
       * output is deliberately published after OUT and its continuation are
       * committed, so it must count as completed and must not be replayed. */
      completed += batch - ((kind === 2
        && Number(payload) !== X86_STATUS.consoleWrite) || kind === 6 ? 1 : 0);
      if (kind === 0) {
        const next = Number(payload);
        if (!Number.isSafeInteger(next) || next < 0) {
          throw new Error('vm.wasm published an invalid direct continuation');
        }
        if (residualMode) this.residualRank = next;
        else this.functionRank = next;
        continue;
      }
      if (kind === 2) {
        const barrier = Number(payload);
        if (barrier === X86_STATUS.needPhysical) {
          await this.satisfyPhysical();
        } else if (barrier === X86_STATUS.dirtyPhysical) {
          await this.publishDirtyPage();
        } else if (barrier === X86_STATUS.consoleWrite) {
          await this.satisfyConsole();
        } else if (barrier === X86_STATUS.clock) {
          await this.satisfyClock();
        } else if (barrier === X86_STATUS.entropy) {
          await this.satisfyEntropy();
        } else {
          throw new Error(`vm.wasm published unknown direct barrier ${barrier}`);
        }
        continue;
      }
      if (kind === 4) return finish(X86_STATUS.halted);
      if (kind === 1) {
        await supplyX86ExecutableCode(E, this.session, this.source);
        if (residualMode) {
          await this.projectResidual();
          continue;
        }
        const resolved = E.vm_x86_direct_function(this.session);
        if (!Number.isSafeInteger(resolved) || resolved < 0
            || resolved === 0xffffffff) {
          throw new Error('vm.wasm lost the resolved page-dispatch rank');
        }
        this.functionRank = resolved;
        continue;
      }
      if (kind === 3) {
        throw new Error(`direct x86 fault vector ${payload}`);
      }
      if (kind === 5) throw new Error('direct executable generation became stale');
      if (kind === 6) {
        await supplyX86ExecutableMap(E, this.session, this.source, result);
        this.hostBarriers.entryMapRead += 1;
        continue;
      }
      if (kind === 7 && residualMode) {
        const column = Number(payload & 7n);
        if (column === 2) {
          await supplyX86ExecutableKernel(
            E, this.session, this.source, result,
          );
          this.hostBarriers.kernelRead += 1;
        } else if (column <= 1) {
          await supplyX86ExecutableResidual(
            E, this.session, this.source, result,
          );
          this.hostBarriers.residualRead += 1;
        } else if (column === 3 || column === 4) {
          await supplyX86ExecutableInstantiation(
            E, this.session, this.source, result,
          );
          if (column === 3) this.hostBarriers.instantiationRead += 1;
          else this.hostBarriers.parameterRead += 1;
        } else {
          throw new Error(`vm.wasm returned unknown residual column ${column}`);
        }
        continue;
      }
      throw new Error(`vm.wasm returned invalid direct result ${kind}`);
    }
    return finish(X86_STATUS.yielded);
  }

  status(status = null) {
    this.assertOpen();
    const E = this.exports;
    return {
      status,
      halted: Boolean(E.vm_x86_halted(this.session)),
      rip: BigInt.asUintN(64, E.vm_x86_rip(this.session)),
      retired: BigInt.asUintN(64, E.vm_x86_retired(this.session)),
      work: BigInt.asUintN(64, E.vm_x86_work(this.session)),
      span: BigInt.asUintN(64, E.vm_x86_span(this.session)),
      engine: {
        directBlocks: BigInt(E.vm_x86_direct_blocks(this.session)),
        indexStarts: BigInt(
          E.vm_x86_executable_index_starts(this.session),
        ),
        indexNodes: BigInt(E.vm_x86_executable_index_nodes(this.session)),
        indexCacheHits: BigInt(
          E.vm_x86_executable_index_cache_hits(this.session),
        ),
        indexCacheMisses: BigInt(
          E.vm_x86_executable_index_cache_misses(this.session),
        ),
        resourcePayloads: BigInt(
          E.vm_x86_executable_resource_payloads(this.session),
        ),
        moduleChunks: BigInt(
          E.vm_x86_executable_module_chunks(this.session),
        ),
        parameterMaterializations: BigInt(
          E.vm_x86_executable_parameter_materializations(this.session),
        ),
        parameterWords: BigInt(
          E.vm_x86_executable_parameter_words(this.session),
        ),
        physicalLookupProbes: BigInt(
          E.vm_x86_physical_lookup_probes(this.session),
        ),
        physicalVictimProbes: BigInt(
          E.vm_x86_physical_victim_probes(this.session),
        ),
      },
      hostBarriers: { ...this.hostBarriers },
    };
  }

  async flush() {
    this.assertOpen();
    while (await this.publishDirtyPage()) { /* bounded resident dirty set */ }
    return this.status();
  }

  feedConsole(bytes) {
    this.assertOpen();
    if (typeof bytes === 'string') bytes = new TextEncoder().encode(bytes);
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('x86 console input must be bytes or text');
    }
    for (const byte of bytes) {
      if (!this.exports.vm_x86_console_feed(this.session, byte)) {
        throw new Error('vm.wasm console input queue is full');
      }
    }
    this.exports.vm_x86_interrupt_event(this.session, 0);
    return bytes.length;
  }

  interrupt({ timer = false } = {}) {
    this.assertOpen();
    return Boolean(this.exports.vm_x86_interrupt_event(
      this.session, timer ? 1 : 0,
    ));
  }

  release() {
    if (this.closed) return;
    if (!this.exports.vm_step_release(this.session)) {
      throw new Error('vm.wasm rejected the direct x86 lease release');
    }
    this.dirtyPages.clear();
    this.closed = true;
  }
}

function x86Source(source, name, writable = false) {
  if (!source || !Number.isSafeInteger(source.length) || source.length <= 0
      || typeof source.read !== 'function'
      || (writable && typeof source.write !== 'function')) {
    throw new TypeError(`${name} needs a finite direct-coordinate source`);
  }
  return source;
}

/**
 * Open one x86 machine whose persistent state and MMU remain in vm.wasm.
 *
 * `blocks.read(rip)` supplies immutable X86B+STEP records. `memory` sees only
 * 4 KiB physical coordinates; virtual addresses, registers, flags and control
 * transitions never cross this host API. Python may have produced either
 * artifact ahead of time, but no Python interpreter participates here.
 */
export async function openX86Machine({ state, memory, blocks, devices = {} }) {
  if (!state || !Array.isArray(state.registers)
      || state.registers.length !== 16) {
    throw new TypeError('x86 state needs sixteen registers');
  }
  x86Source(memory, 'x86 physical memory', true);
  if (!blocks || typeof blocks.read !== 'function') {
    throw new TypeError('x86 machine needs a RIP-coordinate block source');
  }
  const loaded = await load();
  const E = loaded.exports;
  const session = E.vm_step_acquire();
  if (session === 0n) throw new Error('vm.wasm has no free x86 lease');
  const word = (name, fallback = 0n) => BigInt.asUintN(
    64, BigInt(state[name] ?? fallback),
  );
  let opened = false;
  try {
    opened = Boolean(E.vm_x86_open(
      session, word('rip'), word('rflags', 2n), word('cr0'), word('cr3'),
      word('cr4'), word('efer'), BigInt(memory.length),
    ));
    if (!opened) throw new Error('vm.wasm rejected the x86 state');
    const view = new DataView(E.memory.buffer);
    const registersAt = E.vm_x86_registers(session);
    state.registers.forEach((value, index) => view.setBigUint64(
      registersAt + index * 8, BigInt.asUintN(64, BigInt(value)), true,
    ));
    if (state.xmm !== undefined) {
      if (!Array.isArray(state.xmm) || state.xmm.length !== 32) {
        throw new TypeError('x86 vector state needs thirty-two words');
      }
      const xmmAt = E.vm_x86_xmm(session);
      state.xmm.forEach((value, index) => view.setBigUint64(
        xmmAt + index * 8, BigInt.asUintN(64, BigInt(value)), true,
      ));
    }
    if (state.system !== undefined) {
      if (!Array.isArray(state.system) || state.system.length !== 22) {
        throw new TypeError('x86 system state needs twenty-two words');
      }
      const systemAt = E.vm_x86_system(session);
      state.system.forEach((value, index) => view.setBigUint64(
        systemAt + index * 8, BigInt.asUintN(64, BigInt(value)), true,
      ));
    }
    if (state.msrs !== undefined) {
      if (!Array.isArray(state.msrs) || state.msrs.length > 32) {
        throw new TypeError('x86 MSR state is outside the resident bank');
      }
      const keysAt = E.vm_x86_msr_keys(session);
      const valuesAt = E.vm_x86_msr_values(session);
      state.msrs.forEach((pair, index) => {
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new TypeError(`x86 MSR ${index} is not a key/value pair`);
        }
        view.setBigUint64(
          keysAt + index * 8, BigInt.asUintN(64, BigInt(pair[0])), true,
        );
        view.setBigUint64(
          valuesAt + index * 8, BigInt.asUintN(64, BigInt(pair[1])), true,
        );
      });
      if (!E.vm_x86_msr_count(session, state.msrs.length)) {
        throw new Error('vm.wasm rejected the x86 MSR bank');
      }
    }
    if (state.ioPorts !== undefined) {
      if (!Array.isArray(state.ioPorts)) {
        throw new TypeError('x86 I/O state must be coordinate/value pairs');
      }
      for (const pair of state.ioPorts) {
        if (!Array.isArray(pair) || pair.length !== 2
            || !Number.isSafeInteger(pair[0]) || pair[0] < 0
            || pair[0] > 0xffffffff
            || !E.vm_x86_restore_io(session, pair[0], BigInt(pair[1]))) {
          throw new TypeError('x86 I/O state has an invalid coordinate');
        }
      }
    }
    if (state.consoleInput !== undefined) {
      const input = state.consoleInput instanceof Uint8Array
        ? state.consoleInput : Uint8Array.from(state.consoleInput);
      for (const byte of input) {
        if (!E.vm_x86_console_feed(session, byte)) {
          throw new TypeError('x86 console state exceeds the resident queue');
        }
      }
    }
    if (state.consoleOutput !== undefined) {
      const output = state.consoleOutput instanceof Uint8Array
        ? state.consoleOutput : Uint8Array.from(state.consoleOutput);
      for (const byte of output) {
        if (!E.vm_x86_restore_console_output(session, byte)) {
          throw new TypeError(
            'x86 console output state exceeds the resident buffer',
          );
        }
      }
    }
    const resident = new ResidentX86Machine(
      E, session, memory, blocks, devices,
    );
    const tsc = state.msrs?.find(
      ([key]) => BigInt.asUintN(32, BigInt(key)) === 0x10n,
    );
    resident.virtualClock = tsc
      ? BigInt.asUintN(64, BigInt(tsc[1])) : 0n;
    return resident;
  } catch (error) {
    E.vm_step_release(session);
    throw error;
  }
}

class ResidentX86Machine {
  constructor(exports, session, memory, blocks, devices) {
    this.exports = exports;
    this.session = session;
    this.memory = memory;
    this.blocks = blocks;
    this.devices = devices;
    this.hostBarriers = {
      blockRead: 0,
      blockCacheHit: 0,
      blockCacheMiss: 0,
      physicalRead: 0,
      physicalWrite: 0,
      consoleWrite: 0,
      clock: 0,
      entropy: 0,
    };
    this.virtualClock = 0n;
    this.blockCandidate = new Map();
    this.closed = false;
  }

  assertOpen() {
    if (this.closed) throw new Error('x86 machine is released');
  }

  async advance(maxBlocks = 1 << 16) {
    this.assertOpen();
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks <= 0) {
      throw new RangeError('x86 block quantum must be positive');
    }
    const E = this.exports;
    let completed = 0;
    const finish = (status) => ({
      ...this.status(status), completedBlocks: completed,
    });
    while (completed < maxBlocks) {
      const requested = Math.min(maxBlocks - completed, 0xffffffff);
      let status = E.vm_x86_execute_quantum(
        this.session, requested,
      );
      const batch = E.vm_x86_quantum_blocks(this.session);
      const cacheHits = E.vm_x86_quantum_cache_hits(this.session);
      if (!Number.isSafeInteger(batch) || batch < 0
          || batch > requested
          || !Number.isSafeInteger(cacheHits) || cacheHits < 0) {
        throw new Error('vm.wasm published an invalid x86 quantum');
      }
      completed += batch;
      this.hostBarriers.blockCacheHit += cacheHits;
      if (status === X86_STATUS.needBlock) {
        this.hostBarriers.blockCacheMiss += 1;
        const rip = BigInt.asUintN(64, E.vm_x86_rip(this.session));
        this.hostBarriers.blockRead += 1;
        const key = rip.toString();
        const candidate = this.blockCandidate.get(key) || 0;
        const record = await this.blocks.read(rip, candidate);
        if (record == null) {
          return { ...finish(X86_STATUS.needBlock), missingBlock: rip };
        }
        if (!(record instanceof Uint8Array) || !record.length) {
          throw new Error(`x86 block 0x${rip.toString(16)} is malformed`);
        }
        new Uint8Array(
          E.memory.buffer, E.vm_step_buffer(this.session), record.length,
        ).set(record);
        const loaded = E.vm_x86_load_block(this.session, record.length);
        if (loaded === X86_STATUS.codeMismatch) {
          this.blockCandidate.set(key, candidate + 1);
          continue;
        }
        if (loaded === X86_STATUS.needPhysical
            || loaded === X86_STATUS.dirtyPhysical) {
          status = loaded;
        } else if (loaded !== 2) {
          throw new Error(
            `vm.wasm rejected x86 block 0x${rip.toString(16)} (${E.vm_x86_error(this.session)})`,
          );
        } else {
          this.blockCandidate.delete(key);
          continue;
        }
      }
      if (status === X86_STATUS.codeMismatch) {
        const rip = BigInt.asUintN(64, E.vm_x86_rip(this.session));
        this.blockCandidate.set(rip.toString(), 0);
        continue;
      }
      if (status === X86_STATUS.needPhysical
          || status === X86_STATUS.dirtyPhysical) {
        const lease = E.vm_x86_physical_lease(this.session);
        const page = BigInt.asUintN(
          64, E.vm_x86_physical_coordinate(this.session, lease),
        );
        const offset = Number(page * BigInt(X86_PHYSICAL_PAGE_BYTES));
        if (!Number.isSafeInteger(offset)
            || offset < 0 || offset + X86_PHYSICAL_PAGE_BYTES > this.memory.length) {
          throw new Error(`x86 physical page ${page} is outside RAM`);
        }
        const bufferAt = E.vm_x86_physical_buffer(this.session, lease);
        if (status === X86_STATUS.needPhysical) {
          this.hostBarriers.physicalRead += 1;
          const bytes = await this.memory.read(offset, X86_PHYSICAL_PAGE_BYTES);
          if (!(bytes instanceof Uint8Array)
              || bytes.length !== X86_PHYSICAL_PAGE_BYTES) {
            throw new Error(`x86 physical page ${page} has the wrong extent`);
          }
          new Uint8Array(
            E.memory.buffer, bufferAt, X86_PHYSICAL_PAGE_BYTES,
          ).set(bytes);
          if (!E.vm_x86_supply_physical(
            this.session, lease, page, X86_PHYSICAL_PAGE_BYTES,
          )) throw new Error(`vm.wasm rejected physical page ${page}`);
        } else {
          this.hostBarriers.physicalWrite += 1;
          const bytes = new Uint8Array(
            E.memory.buffer, bufferAt, X86_PHYSICAL_PAGE_BYTES,
          ).slice();
          await this.memory.write(offset, bytes);
          if (!E.vm_x86_ack_physical(this.session, lease, page)) {
            throw new Error(`vm.wasm rejected dirty physical page ${page}`);
          }
        }
        continue;
      }
      if (status === X86_STATUS.consoleWrite) {
        const lease = E.vm_x86_console_lease(this.session);
        if (!lease) throw new Error('vm.wasm published an invalid console lease');
        const count = E.vm_x86_console_output_count(this.session, lease);
        if (!Number.isSafeInteger(count) || count <= 0 || count > 256) {
          throw new Error('vm.wasm published an invalid console batch');
        }
        const bytes = Uint8Array.from(
          { length: count }, (_unused, index) =>
            E.vm_x86_console_output_peek(this.session, lease, index),
        );
        this.hostBarriers.consoleWrite += 1;
        if (typeof this.devices.consoleWrite === 'function') {
          await this.devices.consoleWrite(bytes);
        }
        if (!E.vm_x86_ack_console(this.session, lease)) {
          throw new Error('vm.wasm rejected the console acknowledgement');
        }
        continue;
      }
      if (status === X86_STATUS.clock) {
        const lease = E.vm_x86_clock_lease(this.session);
        if (!lease) throw new Error('vm.wasm published an invalid clock lease');
        this.hostBarriers.clock += 1;
        let value;
        if (typeof this.devices.clock === 'function') {
          value = await this.devices.clock({
            retired: BigInt.asUintN(64, E.vm_x86_retired(this.session)),
            prior: this.virtualClock,
          });
        } else {
          value = this.virtualClock + 1n;
        }
        this.virtualClock = BigInt.asUintN(64, BigInt(value));
        if (!E.vm_x86_supply_clock(
          this.session, lease, this.virtualClock,
        )) throw new Error('vm.wasm rejected the clock acknowledgement');
        continue;
      }
      if (status === X86_STATUS.entropy) {
        const lease = E.vm_x86_entropy_lease(this.session);
        if (!lease) throw new Error('vm.wasm published an invalid entropy lease');
        this.hostBarriers.entropy += 1;
        let value;
        if (typeof this.devices.entropy === 'function') {
          value = await this.devices.entropy({
            retired: BigInt.asUintN(64, E.vm_x86_retired(this.session)),
            rip: BigInt.asUintN(64, E.vm_x86_rip(this.session)),
          });
        } else {
          const words = new Uint32Array(2);
          globalThis.crypto.getRandomValues(words);
          value = (BigInt(words[1]) << 32n) | BigInt(words[0]);
        }
        if (!E.vm_x86_supply_entropy(
          this.session, lease, BigInt.asUintN(64, BigInt(value)),
        )) throw new Error('vm.wasm rejected the entropy acknowledgement');
        continue;
      }
      if (status === X86_STATUS.yielded || status === X86_STATUS.halted) {
        return finish(status);
      }
      if (status === X86_STATUS.internal) {
        continue;
      }
      throw new Error(
        `x86 machine trapped in vm.wasm (`
        + `x86=${E.vm_x86_error(this.session)}, `
        + `step=${E.vm_step_error(this.session)})`,
      );
    }
    return finish(X86_STATUS.yielded);
  }

  status(status = null) {
    this.assertOpen();
    const E = this.exports;
    return {
      status,
      halted: Boolean(E.vm_x86_halted(this.session)),
      rip: BigInt.asUintN(64, E.vm_x86_rip(this.session)),
      retired: BigInt.asUintN(64, E.vm_x86_retired(this.session)),
      work: BigInt.asUintN(64, E.vm_x86_work(this.session)),
      span: BigInt.asUintN(64, E.vm_x86_span(this.session)),
      engine: {
        stepOpens: BigInt.asUintN(
          64, E.vm_step_profile_opens(this.session),
        ),
        stepRestores: BigInt.asUintN(
          64, E.vm_step_profile_restores(this.session),
        ),
        executeCalls: BigInt.asUintN(
          64, E.vm_step_profile_execute_calls(this.session),
        ),
        nodesExecuted: BigInt.asUintN(
          64, E.vm_step_profile_nodes(this.session),
        ),
        projectionQueries: BigInt.asUintN(
          64, E.vm_step_profile_projection_queries(this.session),
        ),
      },
      hostBarriers: { ...this.hostBarriers },
    };
  }

  async flush() {
    this.assertOpen();
    const E = this.exports;
    for (;;) {
      const page = BigInt.asUintN(
        64, E.vm_x86_first_dirty_physical_page(this.session),
      );
      if (page === 0xffffffffffffffffn) {
        if (E.vm_x86_error(this.session)) {
          throw new Error('vm.wasm failed to publish x86 dirty state');
        }
        break;
      }
      const lease = E.vm_x86_physical_lease(this.session);
      const published = BigInt.asUintN(
        64, E.vm_x86_physical_coordinate(this.session, lease),
      );
      const offset = Number(page * BigInt(X86_PHYSICAL_PAGE_BYTES));
      if (!lease || published !== page || !Number.isSafeInteger(offset)
          || offset < 0
          || offset + X86_PHYSICAL_PAGE_BYTES > this.memory.length) {
        throw new Error('vm.wasm published an invalid x86 flush page');
      }
      const bytes = new Uint8Array(
        E.memory.buffer,
        E.vm_x86_physical_buffer(this.session, lease),
        X86_PHYSICAL_PAGE_BYTES,
      ).slice();
      await this.memory.write(offset, bytes);
      this.hostBarriers.physicalWrite += 1;
      if (!E.vm_x86_ack_physical(this.session, lease, page)) {
        throw new Error(`vm.wasm rejected flushed physical page ${page}`);
      }
    }
    return this.status();
  }

  snapshot() {
    this.assertOpen();
    const E = this.exports;
    const view = new DataView(E.memory.buffer);
    const words = (address, count) => Array.from(
      { length: count }, (_unused, index) =>
        view.getBigUint64(address + index * 8, true),
    );
    const count = E.vm_x86_msr_extent(this.session);
    const keys = words(E.vm_x86_msr_keys(this.session), count);
    const values = words(E.vm_x86_msr_values(this.session), count);
    const ioPorts = [];
    const coordinates = [
      0x21, 0xa1,
      0x3f8, 0x3f9, 0x3fa, 0x3fb, 0x3fc, 0x3fd, 0x3fe, 0x3ff,
      0x10042, 0x10043, 0x10044, 0x10045, 0x10046, 0x10047,
    ];
    for (const coordinate of coordinates) {
      if (E.vm_x86_io_valid(this.session, coordinate)) {
        ioPorts.push([
          coordinate,
          BigInt.asUintN(64, E.vm_x86_io_value(this.session, coordinate)),
        ]);
      }
    }
    const consoleCount = E.vm_x86_console_count(this.session);
    const consoleInput = Uint8Array.from(
      { length: consoleCount }, (_unused, index) =>
        E.vm_x86_console_peek(this.session, index),
    );
    const consoleOutputCount = E.vm_x86_pending_console_output_count(
      this.session,
    );
    const consoleOutput = Uint8Array.from(
      { length: consoleOutputCount }, (_unused, index) =>
        E.vm_x86_pending_console_output_peek(this.session, index),
    );
    return {
      registers: words(E.vm_x86_registers(this.session), 16),
      xmm: words(E.vm_x86_xmm(this.session), 32),
      rip: BigInt.asUintN(64, E.vm_x86_rip(this.session)),
      rflags: BigInt.asUintN(64, E.vm_x86_rflags(this.session)),
      cr0: BigInt.asUintN(64, E.vm_x86_cr0(this.session)),
      cr3: BigInt.asUintN(64, E.vm_x86_cr3(this.session)),
      cr4: BigInt.asUintN(64, E.vm_x86_cr4(this.session)),
      efer: BigInt.asUintN(64, E.vm_x86_efer(this.session)),
      system: words(E.vm_x86_system(this.session), 22),
      msrs: keys.map((key, index) => [key, values[index]]),
      ioPorts,
      consoleInput,
      consoleOutput,
    };
  }

  feedConsole(bytes) {
    this.assertOpen();
    if (typeof bytes === 'string') bytes = new TextEncoder().encode(bytes);
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('x86 console input must be bytes or text');
    }
    for (const byte of bytes) {
      if (!this.exports.vm_x86_console_feed(this.session, byte)) {
        throw new Error('vm.wasm console input queue is full');
      }
    }
    return bytes.length;
  }

  release() {
    if (this.closed) return;
    if (!this.exports.vm_step_release(this.session)) {
      throw new Error('vm.wasm rejected the x86 lease release');
    }
    this.closed = true;
  }
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
async function executeGuestFunctionBatchExclusive(
  source, bodyStart, bodyEnd, argumentRows, quantum,
) {
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
  if (!Array.isArray(argumentRows)
      || argumentRows.some((row) => !Array.isArray(row))) {
    throw new TypeError('child Wasm batch needs argument rows');
  }
  const loaded = await load();
  const E = loaded.exports;
  if (!E.vm_guest_open(source.length, bodyStart, bodyEnd)) {
    throw new Error('vm.wasm rejected the child module extent');
  }
  const results = [];
  for (const args of argumentRows) {
    const valuesAt = E.vm_guest_values();
    const memory = new DataView(E.memory.buffer);
    args.forEach((value, index) => {
      memory.setBigUint64(
        valuesAt + index * 8, BigInt.asUintN(64, BigInt(value)), true,
      );
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
      if (status === 2) {
        results.push(E.vm_guest_result());
        break;
      }
      throw new Error(`child Wasm trapped in vm.wasm (${E.vm_guest_error()})`);
    }
  }
  return results;
}

/** Execute many calls while retaining code pages and VM state in vm.wasm. */
export function executeGuestFunctionBatch(source, bodyStart, bodyEnd,
                                          argumentRows, quantum = 1 << 16) {
  return serializeStep(() => executeGuestFunctionBatchExclusive(
    source, bodyStart, bodyEnd, argumentRows, quantum,
  ));
}

export async function executeGuestBody(source, bodyStart, bodyEnd,
                                       args = [], quantum = 1 << 16) {
  const results = await executeGuestFunctionBatch(
    source, bodyStart, bodyEnd, [args], quantum,
  );
  return results[0];
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
