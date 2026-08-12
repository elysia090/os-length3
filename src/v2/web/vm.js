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
    const opened = await readArtifact('vm');
    compiled = await WebAssembly.compile(opened.bytes);
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
});
const X86_PHYSICAL_PAGE_BYTES = 4096;

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
    };
    this.virtualClock = 0n;
    this.blockLoaded = false;
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
    while (completed < maxBlocks) {
      const status = E.vm_x86_execute(this.session);
      if (status === X86_STATUS.needBlock) {
        if (this.blockLoaded) {
          this.blockLoaded = false;
          completed += 1;
          if (completed >= maxBlocks) return this.status(X86_STATUS.yielded);
        }
        const cached = E.vm_x86_load_cached_block(this.session);
        if (cached === 2) {
          this.hostBarriers.blockCacheHit += 1;
          this.blockLoaded = true;
          continue;
        }
        if (cached !== 0) {
          throw new Error(
            `vm.wasm rejected its resident x86 block cache (${E.vm_x86_error(this.session)})`,
          );
        }
        this.hostBarriers.blockCacheMiss += 1;
        const rip = BigInt.asUintN(64, E.vm_x86_rip(this.session));
        this.hostBarriers.blockRead += 1;
        const record = await this.blocks.read(rip);
        if (record == null) {
          return { ...this.status(X86_STATUS.needBlock), missingBlock: rip };
        }
        if (!(record instanceof Uint8Array) || !record.length) {
          throw new Error(`x86 block 0x${rip.toString(16)} is malformed`);
        }
        new Uint8Array(
          E.memory.buffer, E.vm_step_buffer(this.session), record.length,
        ).set(record);
        if (E.vm_x86_load_block(this.session, record.length) !== 2) {
          throw new Error(
            `vm.wasm rejected x86 block 0x${rip.toString(16)} (${E.vm_x86_error(this.session)})`,
          );
        }
        this.blockLoaded = true;
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
        const byte = E.vm_x86_console_value(this.session, lease);
        this.hostBarriers.consoleWrite += 1;
        if (typeof this.devices.consoleWrite === 'function') {
          await this.devices.consoleWrite(Uint8Array.of(byte));
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
      if (status === X86_STATUS.yielded || status === X86_STATUS.halted) {
        this.blockLoaded = false;
        return this.status(status);
      }
      if (status === X86_STATUS.internal) {
        this.blockLoaded = false;
        continue;
      }
      throw new Error(
        `x86 machine trapped in vm.wasm (`
        + `x86=${E.vm_x86_error(this.session)}, `
        + `step=${E.vm_step_error(this.session)})`,
      );
    }
    return this.status(X86_STATUS.yielded);
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
      hostBarriers: { ...this.hostBarriers },
    };
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
    return {
      registers: words(E.vm_x86_registers(this.session), 16),
      rip: BigInt.asUintN(64, E.vm_x86_rip(this.session)),
      rflags: BigInt.asUintN(64, E.vm_x86_rflags(this.session)),
      cr0: BigInt.asUintN(64, E.vm_x86_cr0(this.session)),
      cr3: BigInt.asUintN(64, E.vm_x86_cr3(this.session)),
      cr4: BigInt.asUintN(64, E.vm_x86_cr4(this.session)),
      efer: BigInt.asUintN(64, E.vm_x86_efer(this.session)),
      system: words(E.vm_x86_system(this.session), 22),
      msrs: keys.map((key, index) => [key, values[index]]),
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
