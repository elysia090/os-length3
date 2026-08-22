import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const arguments_ = process.argv.slice(2);
const requireCompleteness
  = arguments_.at(-1) === '--require-completeness';
if (requireCompleteness) arguments_.pop();
const [vmPath, emittedPath, coldPath, rootPath, residualRootPath, ...nodePaths]
  = arguments_;
if (!vmPath || !emittedPath || !coldPath || !rootPath || !residualRootPath
    || nodePaths.length !== 10) {
  throw new Error(
    'usage: emitter_vm.mjs VM_WASM EMITTED_WASM COLD_WASM EXECUTABLE_ROOT '
      + 'RESIDUAL_ROOT BINDING.node MODULE.node RESOURCE.node RESOURCE.page '
      + 'ENTRY_PAGE.rows ENTRY_TAIL.row RESIDUAL_STATE.page '
      + 'RESIDUAL_EDGE.page INSTANTIATION.page PARAMETER.page',
  );
}

const vmModule = await WebAssembly.compile(await readFile(vmPath));
globalThis.QM_TEST_VM_MODULE = vmModule;
const vm = await WebAssembly.instantiate(vmModule, {});
const E = vm.exports;
const table = E.__indirect_function_table;
if (!(table instanceof WebAssembly.Table)
    || !(E.memory instanceof WebAssembly.Memory)) {
  throw new Error('vm.wasm did not publish its shared table and memory');
}

const instantiateFixtureModule = async (base, bytes) => {
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
};

const hexDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const objectPaths = [emittedPath, coldPath, ...nodePaths];
const objects = new Map();
for (const path of objectPaths) {
  const bytes = new Uint8Array(await readFile(path));
  const digest = hexDigest(bytes);
  if (objects.has(digest)) throw new Error(`duplicate fixture object ${digest}`);
  objects.set(digest, bytes);
}
const root = new Uint8Array(await readFile(rootPath));
const residualRoot = new Uint8Array(await readFile(residualRootPath));

const exactNumber = (value, label) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds fixture integer range`);
  }
  return Number(value);
};

let rejectedResource = false;
let resourcePayloads = 0;
const supplyMemoryPage = async (machineSession, result) => {
  if (Number(result & 7n) !== 2) {
    throw new Error('direct memory did not return a delivery barrier');
  }
  const lease = E.vm_x86_physical_lease(machineSession);
  const page = E.vm_x86_physical_coordinate(machineSession, lease);
  if (!lease || (page !== 3n && page !== 4n && page !== 5n)) {
    throw new Error('direct memory requested the wrong physical page');
  }
  if (!E.vm_x86_executable_physical_begin(machineSession)) {
    throw new Error('C resource loader rejected the physical cut');
  }
  for (;;) {
    const kind = E.vm_x86_executable_request_kind(machineSession);
    if (kind === 6) break;
    if (kind !== 1 && kind !== 5) {
      throw new Error(`unexpected physical admission state ${kind}`);
    }
    const digest = requestedDigest();
    const object = objects.get(digest);
    if (!object) throw new Error(`storage has no physical object ${digest}`);
    const total = exactNumber(
      E.vm_x86_executable_request_bytes(machineSession),
      'physical object extent',
    );
    const offset = exactNumber(
      E.vm_x86_executable_request_offset(machineSession),
      'physical object offset',
    );
    const count = E.vm_x86_executable_request_buffer_bytes(machineSession);
    const bufferAt = E.vm_x86_executable_request_buffer(machineSession);
    if (!bufferAt || object.length !== total || !count
        || offset + count > total) {
      throw new Error(`invalid physical request for ${digest}`);
    }
    new Uint8Array(E.memory.buffer, bufferAt, count)
      .set(object.subarray(offset, offset + count));
    if (kind === 5) {
      resourcePayloads += 1;
      if (!rejectedResource) {
        new Uint8Array(E.memory.buffer, bufferAt, count)[0] ^= 1;
        if (E.vm_x86_executable_supply(machineSession, count)) {
          throw new Error('C admitted a corrupted physical page');
        }
        rejectedResource = true;
        continue;
      }
    }
    if (!E.vm_x86_executable_supply(machineSession, count)) {
      throw new Error(`C rejected physical object ${digest}`);
    }
  }
  if (!E.vm_x86_executable_physical_commit(machineSession)) {
    throw new Error('C resource loader did not publish the physical page');
  }
};

const acknowledgeDirtyPages = (machineSession) => {
  const seen = new Set();
  for (;;) {
    const page = E.vm_x86_first_dirty_physical_page(machineSession);
    if (page === -1n) break;
    const lease = E.vm_x86_physical_lease(machineSession);
    const at = E.vm_x86_physical_buffer(machineSession, lease);
    const offset = page === 3n ? 4092 : 0;
    const observed = at
      ? new DataView(E.memory.buffer, at + offset, 4).getUint32(0, true)
      : -1;
    const copied = at && page === 5n
      ? new DataView(E.memory.buffer, at + 0x10, 1).getUint8(0)
      : 1;
    if ((page !== 3n && page !== 4n && page !== 5n) || !lease || !at
        || observed !== 1 || copied !== 1
        || !E.vm_x86_ack_physical(machineSession, lease, page)) {
      throw new Error(
        `direct repeat dirty extent page=${page} value=${observed}`,
      );
    }
    seen.add(page);
  }
  if (seen.size !== 3) {
    throw new Error('direct repeat/copy did not publish all dirty pages');
  }
};

const session = E.vm_step_acquire();
if (session === 0n) throw new Error('vm.wasm did not acquire a machine lease');
const requestedDigest = () => {
  const at = E.vm_x86_executable_request_digest(session);
  if (!at) throw new Error('C admission state omitted a requested digest');
  return Buffer.from(new Uint8Array(E.memory.buffer, at, 32)).toString('hex');
};

/* Entry-map misses use the same authenticated resource index as physical
 * pages.  JavaScript is only a digest/range courier: C chooses the object,
 * verifies it and publishes the direct-map cache tag. */
const supplyEntryMap = async (result) => {
  const started = E.vm_x86_executable_map_begin(session, result);
  if (started === 2) return;
  if (started !== 1) throw new Error('C rejected an entry-map miss token');
  for (;;) {
    const kind = E.vm_x86_executable_request_kind(session);
    if (kind === 8) break;
    if (kind !== 1 && kind !== 5) {
      throw new Error(`unexpected entry-map admission state ${kind}`);
    }
    const digest = requestedDigest();
    const object = objects.get(digest);
    if (!object) throw new Error(`storage has no entry-map object ${digest}`);
    const total = exactNumber(
      E.vm_x86_executable_request_bytes(session), 'entry-map object extent',
    );
    const offset = exactNumber(
      E.vm_x86_executable_request_offset(session), 'entry-map object offset',
    );
    const count = E.vm_x86_executable_request_buffer_bytes(session);
    const bufferAt = E.vm_x86_executable_request_buffer(session);
    if (!bufferAt || object.length !== total || !count
        || offset + count > total) {
      throw new Error(`invalid entry-map request for ${digest}`);
    }
    new Uint8Array(E.memory.buffer, bufferAt, count)
      .set(object.subarray(offset, offset + count));
    if (!E.vm_x86_executable_supply(session, count)) {
      throw new Error(`C rejected entry-map object ${digest}`);
    }
  }
  if (!E.vm_x86_executable_map_commit(session)) {
    throw new Error('C did not publish the authenticated entry-map row');
  }
};

try {
  const stageAt = E.vm_x86_executable_buffer(session);
  const stageBytes = E.vm_x86_executable_buffer_bytes();
  if (!stageAt || stageBytes !== root.length) {
    throw new Error('vm.wasm did not publish the exact root staging range');
  }
  new Uint8Array(E.memory.buffer, stageAt, stageBytes).set(root);

  const tableBase = table.length;
  if (!E.vm_x86_executable_begin(session, BigInt(root.length), tableBase)) {
    throw new Error('C loader rejected the emitted fixed executable root');
  }
  if (E.vm_x86_executable_commit(session)) {
    throw new Error('fixed root was published before its cold proofs');
  }

  let rejectedNode = false;
  let rejectedModule = false;
  for (;;) {
    const kind = E.vm_x86_executable_request_kind(session);
    if (kind === 4) break;
    if (kind === 1 || kind === 2) {
      const digest = requestedDigest();
      const object = objects.get(digest);
      if (!object) throw new Error(`storage has no requested object ${digest}`);
      const total = exactNumber(
        E.vm_x86_executable_request_bytes(session), 'requested object',
      );
      const offset = exactNumber(
        E.vm_x86_executable_request_offset(session), 'requested offset',
      );
      const count = E.vm_x86_executable_request_buffer_bytes(session);
      const bufferAt = E.vm_x86_executable_request_buffer(session);
      if (!bufferAt || object.length !== total || !count
          || offset + count > object.length) {
        throw new Error(`invalid opaque request for ${digest}`);
      }
      new Uint8Array(E.memory.buffer, bufferAt, count)
        .set(object.subarray(offset, offset + count));
      if (kind === 1 && !rejectedNode) {
        new Uint8Array(E.memory.buffer, bufferAt, count)[0] ^= 1;
        if (E.vm_x86_executable_supply(session, count)) {
          throw new Error('C admitted a corrupted index node');
        }
        rejectedNode = true;
        continue;
      }
      if (kind === 2 && !rejectedModule && offset + count === total) {
        new Uint8Array(E.memory.buffer, bufferAt, count)[count - 1] ^= 1;
        if (E.vm_x86_executable_supply(session, count)) {
          throw new Error('C admitted a corrupted module payload');
        }
        rejectedModule = true;
        continue;
      }
      if (!E.vm_x86_executable_supply(session, count)) {
        throw new Error(`C rejected requested object ${digest}`);
      }
      continue;
    }
    if (kind === 3) {
      const digest = requestedDigest();
      const object = objects.get(digest);
      if (!object) throw new Error(`storage lost verified module ${digest}`);
      const moduleBase = E.vm_x86_executable_module_table_base(session);
      const functions = E.vm_x86_executable_module_function_count(session);
      const needed = moduleBase + functions;
      if (!moduleBase || !functions || needed < moduleBase) {
        throw new Error('C published invalid module table geometry');
      }
      if (needed > table.length) table.grow(needed - table.length);
      await WebAssembly.instantiate(object, {
        env: {
          memory: E.memory,
          table,
          table_base: new WebAssembly.Global(
            { value: 'i32', mutable: false }, moduleBase,
          ),
          direct_memory: E.vm_x86_direct_memory,
          direct_memory_result: E.vm_x86_direct_memory_result,
          direct_memory_region: E.vm_x86_direct_memory_region,
          direct_memory_region_value:
            E.vm_x86_direct_memory_region_value,
          direct_memory_repeat: E.vm_x86_direct_memory_repeat,
          direct_memory_copy: E.vm_x86_direct_memory_copy,
          direct_memory_find2: E.vm_x86_direct_memory_find2,
          direct_memory_commit: E.vm_x86_direct_memory_commit,
          direct_x86_divide: E.vm_x86_direct_divide,
          direct_x86_divide_result: E.vm_x86_direct_divide_result,
          direct_x86_segment_base: E.vm_x86_direct_segment_base,
          direct_x86_rotate_carry: E.vm_x86_direct_rotate_carry,
          direct_x86_rotate_carry_result:
            E.vm_x86_direct_rotate_carry_result,
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
      if (!E.vm_x86_executable_module_installed(session)) {
        throw new Error('C rejected verified module installation');
      }
      continue;
    }
    throw new Error(`unexpected C admission state ${kind}`);
  }

  if (!rejectedNode || !rejectedModule) {
    throw new Error('negative admission checks did not run');
  }

  if (!E.vm_x86_executable_commit(session)) {
    throw new Error('C loader rejected authenticated executable publication');
  }
  const faultFunction = table.get(tableBase + 2);
  const faultResult = faultFunction(
    E.vm_x86_machine_state(session), E.vm_x86_executable_context(session),
  );
  if (faultResult !== 3n) {
    throw new Error('guarded integer divide did not return the #DE fault cut');
  }
  let directFunction = 0;
  let result = E.vm_x86_execute_direct(session, directFunction, 8);
  let barriers = 0;
  let completedBlocks = E.vm_x86_direct_blocks(session)
    - (Number(result & 7n) === 2 ? 1 : 0);
  while (Number(result & 7n) === 2 && barriers < 4) {
    directFunction = E.vm_x86_direct_function(session);
    if (directFunction !== 1) {
      throw new Error('vm.wasm lost the post-prelude continuation rank');
    }
    await supplyMemoryPage(session, result);
    barriers += 1;
    result = E.vm_x86_execute_direct(session, directFunction, 8);
    completedBlocks += E.vm_x86_direct_blocks(session)
      - (Number(result & 7n) === 2 ? 1 : 0);
  }
  const registersAt = E.vm_x86_registers(session);
  const registers = new BigUint64Array(E.memory.buffer, registersAt, 16);
  const observedCut = {
    kind: Number(result & 7n), payload: (result >> 3n).toString(),
    blocks: E.vm_x86_direct_blocks(session), completedBlocks,
    rax: registers[0].toString(), rflags: E.vm_x86_rflags(session).toString(),
    rip: E.vm_x86_rip(session).toString(),
    retired: E.vm_x86_retired(session).toString(),
    work: E.vm_x86_work(session).toString(),
    span: E.vm_x86_span(session).toString(), barriers,
  };
  if (Number(result & 7n) !== 4 || result >> 3n !== 0n
      || E.vm_x86_direct_blocks(session) !== 1
      || completedBlocks !== 2
      || registers[0] !== 3n
      || registers[1] !== 0x2d7n
      || registers[2] !== 0x11223344556677abn
      || registers[3] !== 0x5566cd88n
      || registers[4] !== 2n
      || registers[5] !== 1n
      || registers[6] !== 0xffffffffffffffffn
      || registers[7] !== 0xff0n
      || registers[8] !== 0xefcdab8967452301n
      || registers[9] !== 0x78563412n
      || registers[10] !== 42n
      || registers[11] !== 0x80000000n
      || registers[12] !== 0x802n
      || registers[13] !== 0xffen
      || registers[14] !== 0x80000001n
      || E.vm_x86_rip(session) !== 0x2001n
      || E.vm_x86_rflags(session) !== 0x246n
      || E.vm_x86_retired(session) !== 11n
      || E.vm_x86_work(session) !== 28n
      || E.vm_x86_span(session) !== 10n
      || barriers !== 3
      || !rejectedResource
      || resourcePayloads !== 2
      || !E.vm_x86_halted(session)) {
    throw new Error(
      `C-emitted blocks produced the wrong machine cut ${JSON.stringify(observedCut)}`,
    );
  }
  registers[6] = 0x5000n;
  registers[7] = 0x5010n;
  const stringFunction = table.get(tableBase + 4);
  const stringResult = stringFunction(
    E.vm_x86_machine_state(session), E.vm_x86_executable_context(session),
  );
  if (stringResult !== 4n || registers[6] !== 0x5001n
      || registers[7] !== 0x5011n || E.vm_x86_rip(session) !== 0x5001n) {
    throw new Error('direct movsb published the wrong residual state');
  }
  acknowledgeDirtyPages(session);
  const divideFunction = table.get(tableBase + 3);
  const divideResult = divideFunction(
    E.vm_x86_machine_state(session), E.vm_x86_executable_context(session),
  );
  if (divideResult !== 4n
      || registers[0] !== 21n
      || registers[2] !== 0xffffffffffffffffn
      || E.vm_x86_rip(session) !== 0x4001n) {
    throw new Error(
      'atomic signed 128-by-64 divide published the wrong quotient cut',
    );
  }
  const branchFunction = table.get(tableBase + 5);
  registers[0] = 0n;
  let branchResult = branchFunction(
    E.vm_x86_machine_state(session), E.vm_x86_executable_context(session),
  );
  if (branchResult !== 1n || E.vm_x86_rip(session) !== 0x6200n) {
    throw new Error('mixed conditional lost its page-resolved false arm');
  }
  if (E.vm_x86_executable_resolve_begin(session) !== 1) {
    throw new Error('vm.wasm did not begin the cold page-dispatch proof');
  }
  for (;;) {
    const kind = E.vm_x86_executable_request_kind(session);
    if (kind === 7) break;
    if (kind === 3) {
      const digest = requestedDigest();
      const object = objects.get(digest);
      const moduleBase = E.vm_x86_executable_module_table_base(session);
      const functions = E.vm_x86_executable_module_function_count(session);
      if (!object || !moduleBase || !functions) {
        throw new Error('C published invalid cold dispatcher module');
      }
      if (moduleBase + functions > table.length) {
        table.grow(moduleBase + functions - table.length);
      }
      await instantiateFixtureModule(moduleBase, object);
      if (!E.vm_x86_executable_module_installed(session)) {
        throw new Error('C rejected cold dispatcher installation');
      }
      continue;
    }
    if (kind !== 1 && kind !== 2) {
      throw new Error(`unexpected page-dispatch admission state ${kind}`);
    }
    const digest = requestedDigest();
    const object = objects.get(digest);
    if (!object) throw new Error(`storage lost code proof ${digest}`);
    const count = E.vm_x86_executable_request_buffer_bytes(session);
    const bufferAt = E.vm_x86_executable_request_buffer(session);
    const offset = exactNumber(
      E.vm_x86_executable_request_offset(session), 'code-proof offset',
    );
    if (!count || !bufferAt || offset + count > object.length) {
      throw new Error('C requested an invalid code-proof range');
    }
    new Uint8Array(E.memory.buffer, bufferAt, count)
      .set(object.subarray(offset, offset + count));
    if (!E.vm_x86_executable_supply(session, count)) {
      throw new Error(`C rejected code proof ${digest}`);
    }
  }
  if (!E.vm_x86_executable_resolve_commit(session)
      || E.vm_x86_direct_function(session) !== 20) {
    throw new Error('vm.wasm did not publish the page dispatcher rank');
  }
  if (E.vm_x86_executable_resolve_begin(session) !== 2
      || E.vm_x86_direct_function(session) !== 20) {
    throw new Error('resident page dispatch repeated its index walk');
  }
  registers[0] = 1n;
  branchResult = branchFunction(
    E.vm_x86_machine_state(session), E.vm_x86_executable_context(session),
  );
  if (branchResult !== 8n || E.vm_x86_rip(session) !== 0x6100n) {
    throw new Error('direct conditional lost its true successor');
  }
  registers[0] = 0x89abcdefn;
  registers[1] = 0xc0000101n;
  registers[2] = 0x01234567n;
  const writeMsrFunction = table.get(tableBase + 6);
  const writeMsrResult = writeMsrFunction(
    E.vm_x86_machine_state(session), E.vm_x86_executable_context(session),
  );
  const machine = E.vm_x86_machine_state(session);
  const msrCount = E.vm_x86_msr_extent(session);
  const msrKeys = new BigUint64Array(
    E.memory.buffer, E.vm_x86_msr_keys(session), msrCount,
  );
  const msrValues = new BigUint64Array(
    E.memory.buffer, E.vm_x86_msr_values(session), msrCount,
  );
  const gsBase = Array.from(msrKeys).findIndex(
    (key) => key === 0xc0000101n,
  );
  if (writeMsrResult !== 4n || gsBase < 0
      || msrValues[gsBase] !== 0x0123456789abcdefn
      || E.vm_x86_rip(session) !== 0x6100n) {
    throw new Error('typed WRMSR block did not publish the canonical MSR cut');
  }
  const store64 = (address, value, block) => {
    E.vm_x86_direct_memory(
      machine, address, value, 0n, 0x10008n, 155, block, 0,
    );
    const memoryResult = E.vm_x86_direct_memory_result(machine);
    if (memoryResult !== 0n) {
      throw new Error(`far-return fixture store stopped at ${memoryResult}`);
    }
    E.vm_x86_direct_memory_commit(machine, block, 1);
    if (E.vm_x86_direct_memory_result(machine) !== 0n) {
      throw new Error('far-return fixture store did not commit');
    }
  };
  const load64 = (address, block) => {
    const value = E.vm_x86_direct_memory(
      machine, address, 0n, 0n, 0x10008n, 145, block, 0,
    );
    const memoryResult = E.vm_x86_direct_memory_result(machine);
    if (memoryResult !== 0n) {
      throw new Error(`direct fixture load stopped at ${memoryResult}`);
    }
    E.vm_x86_direct_memory_commit(machine, block, 1);
    if (E.vm_x86_direct_memory_result(machine) !== 0n) {
      throw new Error('direct fixture load did not commit');
    }
    return value;
  };
  store64(0x5600n, 0x1122334455667788n, 0x7fff0270);
  store64(0x5608n, 0x0102030405060708n, 0x7fff0271);
  registers[1] = 2n;
  registers[6] = 0x5600n;
  registers[7] = 0x5700n;
  if (!E.vm_x86_direct_string(
    machine, 8n | (64n << 8n) | (3n << 16n), 0n,
  ) || registers[1] !== 0n || registers[6] !== 0x5610n
      || registers[7] !== 0x5710n
      || load64(0x5700n, 0x7fff0272) !== 0x1122334455667788n
      || load64(0x5708n, 0x7fff0273) !== 0x0102030405060708n) {
    throw new Error('typed REP MOVSQ did not publish its complete residual cut');
  }
  store64(0x5800n, 0x0000000700000005n, 0x7fff0278);
  store64(0x5808n, 0x000000000000000bn, 0x7fff0279);
  store64(0x5900n, 0x0000000900000005n, 0x7fff027a);
  store64(0x5908n, 0x000000000000000bn, 0x7fff027b);
  registers[1] = 3n;
  registers[6] = 0x5800n;
  registers[7] = 0x5900n;
  if (!E.vm_x86_direct_string(
    machine, 4n | (64n << 8n) | (3n << 16n) | (3n << 24n), 0n,
  ) || registers[1] !== 1n || registers[6] !== 0x5808n
      || registers[7] !== 0x5908n
      || (E.vm_x86_rflags(session) & 0x40n) !== 0n) {
    throw new Error('typed REPE CMPSD did not stop at the first unequal lane');
  }
  store64(0x5900n, 0x0000000700000005n, 0x7fff027c);
  store64(0x5908n, 0x0000000000000009n, 0x7fff027d);
  registers[0] = 7n;
  registers[1] = 3n;
  registers[7] = 0x5900n;
  if (!E.vm_x86_direct_string(
    machine, 4n | (64n << 8n) | (4n << 24n) | (1n << 27n), 0n,
  ) || registers[1] !== 1n || registers[7] !== 0x5908n
      || (E.vm_x86_rflags(session) & 0x40n) === 0n) {
    throw new Error('typed REPNE SCASD did not stop at the first equal lane');
  }
  store64(0x5980n, 0x0000000000424141n, 0x7fff027e);
  registers[0] = 0x41n;
  registers[1] = 4n;
  registers[7] = 0x5980n;
  if (!E.vm_x86_direct_string(
    machine, 1n | (64n << 8n) | (4n << 24n), 0n,
  ) || registers[1] !== 1n || registers[7] !== 0x5983n
      || (E.vm_x86_rflags(session) & 0x40n) !== 0n) {
    throw new Error('typed REPE SCASB did not stop at the first unequal byte');
  }
  store64(0x5880n, 0x0000000000030201n, 0x7fff027f);
  registers[0] = 0x1122334455667788n;
  registers[1] = 3n;
  registers[6] = 0x5880n;
  if (!E.vm_x86_direct_string(
    machine, 1n | (64n << 8n) | (3n << 16n) | (2n << 24n), 0n,
  ) || registers[0] !== 0x1122334455667703n
      || registers[1] !== 0n || registers[6] !== 0x5883n) {
    throw new Error('typed REPNE LODSB did not publish its final accumulator');
  }
  /* Ring-0 LRETQ is the first boot transfer after startup_64's temporary GDT.
   * Build its stack and descriptor in guest physical pages, then enter the
   * compiler-emitted block.  The helper owns CS/RSP/RIP and returns only the
   * total-dispatch token; no RET-shaped SSA or JavaScript state transition is
   * permitted. */
  store64(0x4010n, 0x00af9a000000ffffn, 0x7fff0100);
  store64(0x4018n, 0x00cf92000000ffffn, 0x7fff0105);
  store64(0x5000n, 0x7000n, 0x7fff0101);
  store64(0x5008n, 0x10n, 0x7fff0102);
  store64(0x5020n, (0x4000n << 16n) | 0x100n, 0x7fff0103);
  store64(0x5028n, 0n, 0x7fff0104);
  const system = new BigUint64Array(
    E.memory.buffer, E.vm_x86_system(session), 22,
  );
  system[2] = 0x4000n;
  system[3] = 0x100n;
  system[7] = 0x8n;
  system[8] = 0x18n;
  const loadGdtFunction = table.get(tableBase + 9);
  const loadGdtResult = loadGdtFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (loadGdtResult !== 4n || system[2] !== 0x4000n
      || system[3] !== 0x100n || E.vm_x86_rip(session) !== 0x7200n) {
    throw new Error('typed LGDT did not publish the descriptor-table cut');
  }
  if (!E.vm_x86_direct_descriptor_table(machine, 0x5060n, 2n)
      || load64(0x5060n, 0x7fff0269) !== 0x40000100n
      || load64(0x5068n, 0x7fff026a) !== 0n) {
    throw new Error('typed SGDT did not store one canonical 10-byte image');
  }
  system[4] = 0x123456789abcdef0n;
  system[5] = 0x3456n;
  if (!E.vm_x86_direct_descriptor_table(machine, 0x5070n, 3n)
      || load64(0x5070n, 0x7fff026b) !== 0x56789abcdef03456n
      || (load64(0x5078n, 0x7fff026c) & 0xffffn) !== 0x1234n) {
    throw new Error('typed SIDT did not store one canonical 10-byte image');
  }
  if (!(E.vm_x86_cr0(session) & 1n)
      && !E.vm_x86_direct_write_control(
        machine, 0n, E.vm_x86_cr0(session) | 1n,
      )) {
    throw new Error('VERW fixture could not enter protected mode');
  }
  if (!E.vm_x86_direct_validate_selector(machine, 0x18n, 1n)
      || !(E.vm_x86_rflags(session) & 0x40n)
      || !E.vm_x86_direct_validate_selector(machine, 0x10n, 1n)
      || (E.vm_x86_rflags(session) & 0x40n)
      || !E.vm_x86_direct_validate_selector(machine, 0xffffn, 1n)
      || (E.vm_x86_rflags(session) & 0x40n)
      || E.vm_x86_exception_pending(session)) {
    throw new Error('typed VERW did not publish non-faulting selector validity');
  }
  store64(0x5050n, 0x18n, 0x7fff026f);
  if (!E.vm_x86_direct_validate_selector(machine, 0x5050n, 3n)
      || !(E.vm_x86_rflags(session) & 0x40n)) {
    throw new Error('typed VERW memory form did not use the precise MMU cut');
  }
  registers[1] = 0xffffffffffffffffn;
  if (!E.vm_x86_direct_system_selector(
    machine, 0x18n, (1n << 24n) | (32n << 32n),
  ) || registers[1] !== 0x00c09200n
      || !(E.vm_x86_rflags(session) & 0x40n)
      || !E.vm_x86_direct_system_selector(
        machine, 0x5050n,
        1n | (1n << 8n) | (2n << 24n) | (32n << 32n),
      ) || registers[2] !== 0xffffffffn
      || !(E.vm_x86_rflags(session) & 0x40n)) {
    throw new Error('typed LAR/LSL did not project descriptor access and limit');
  }
  store64(0x4020n, 0x00008200480000ffn, 0x7fff0285);
  store64(0x4028n, 0n, 0x7fff0286);
  store64(0x4808n, 0x00cf92000000ffffn, 0x7fff0287);
  if (!E.vm_x86_direct_system_selector(machine, 0x20n, 2n)
      || system[12] !== 0x20n
      || !E.vm_x86_direct_system_selector(
        machine, 0x0cn, (3n << 24n) | (32n << 32n),
      ) || registers[3] !== 0x00c09200n
      || !(E.vm_x86_rflags(session) & 0x40n)) {
    throw new Error('typed LLDT did not publish and resolve the long-mode LDT');
  }
  store64(0x4030n, 0x0000890050000067n, 0x7fff0289);
  store64(0x4038n, 0n, 0x7fff028a);
  if (!E.vm_x86_direct_system_selector(machine, 0x30n, 3n)
      || system[13] !== 0x30n
      || (load64(0x4030n, 0x7fff028b) & 0x0000ff0000000000n)
         !== 0x00008b0000000000n) {
    throw new Error('typed LTR did not publish TR and the descriptor busy bit');
  }
  store64(0x4040n, 0x0000890050000067n, 0x7fff028c);
  store64(0x4048n, 0n, 0x7fff028d);
  store64(0x5058n, 0x40n, 0x7fff028e);
  if (!E.vm_x86_direct_system_selector(
    machine, 0x5058n, 3n | (1n << 8n),
  ) || system[13] !== 0x40n
      || (load64(0x4040n, 0x7fff028f) & 0x0000ff0000000000n)
         !== 0x00008b0000000000n) {
    throw new Error('typed LTR memory form did not use the precise MMU cut');
  }
  registers[0] = 0x18n;
  const writeDsFunction = table.get(tableBase + 10);
  const writeDsResult = writeDsFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (writeDsResult !== 4n || system[9] !== 0x18n
      || E.vm_x86_rip(session) !== 0x7300n) {
    throw new Error('typed MOV DS did not validate the guest descriptor');
  }
  store64(0x5060n, 0x0000001812345678n, 0x7fff0105);
  registers[6] = 0xffffffffffffffffn;
  const lfsDescriptor = 4n | (1n << 16n) | (1n << 17n)
    | (6n << 24n) | (32n << 32n);
  if (!E.vm_x86_direct_write_segment(machine, lfsDescriptor, 0x5060n)
      || system[10] !== 0x18n || registers[6] !== 0x12345678n) {
    throw new Error('typed LFS did not atomically publish selector and offset');
  }
  registers[1] = 0xffffffffffffffffn;
  const readCr4Function = table.get(tableBase + 11);
  const readCr4Result = readCr4Function(
    machine, E.vm_x86_executable_context(session),
  );
  if (readCr4Result !== 4n || registers[1] !== E.vm_x86_cr4(session)
      || E.vm_x86_rip(session) !== 0x7400n) {
    throw new Error('typed MOV from CR4 did not publish the GPR cut');
  }
  store64(0x5040n, 0x3201n, 0x7fff0106);
  registers[4] = 0x5040n;
  const popFlagsFunction = table.get(tableBase + 12);
  const popFlagsResult = popFlagsFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (popFlagsResult !== 4n || registers[4] !== 0x5048n
      || E.vm_x86_rflags(session) !== 0x3203n
      || E.vm_x86_rip(session) !== 0x7500n) {
    throw new Error('typed POPFQ did not atomically publish RSP and RFLAGS');
  }
  registers[1] = 0xc0000101n;
  const readMsrFunction = table.get(tableBase + 13);
  const readMsrResult = readMsrFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (readMsrResult !== 4n || registers[0] !== 0x89abcdefn
      || registers[2] !== 0x01234567n
      || E.vm_x86_rip(session) !== 0x7600n) {
    throw new Error('typed RDMSR did not publish EDX:EAX from the MSR bank');
  }
  if (!E.vm_x86_direct_write_msr(
    machine, 0xc0000102n, 0xfedcba9876543210n,
  ) || !E.vm_x86_direct_swap_gs(machine, 0n, 0n)) {
    throw new Error('typed SWAPGS helper rejected the ring-0 exchange');
  }
  const swappedCount = E.vm_x86_msr_extent(session);
  const swappedKeys = new BigUint64Array(
    E.memory.buffer, E.vm_x86_msr_keys(session), swappedCount,
  );
  const swappedValues = new BigUint64Array(
    E.memory.buffer, E.vm_x86_msr_values(session), swappedCount,
  );
  const swappedGs = Array.from(swappedKeys).findIndex(
    (key) => key === 0xc0000101n,
  );
  const swappedKernelGs = Array.from(swappedKeys).findIndex(
    (key) => key === 0xc0000102n,
  );
  if (swappedGs < 0 || swappedKernelGs < 0
      || swappedValues[swappedGs] !== 0xfedcba9876543210n
      || swappedValues[swappedKernelGs] !== 0x0123456789abcdefn) {
    throw new Error('typed SWAPGS did not exchange canonical GS bases');
  }
  registers[0] = 0n;
  registers[1] = 0n;
  const cpuidFunction = table.get(tableBase + 14);
  const cpuidResult = cpuidFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (cpuidResult !== 4n || registers[0] !== 7n
      || registers[3] !== 0x756e6547n
      || registers[1] !== 0x6c65746en
      || registers[2] !== 0x49656e69n
      || E.vm_x86_rip(session) !== 0x7700n) {
    throw new Error('typed CPUID did not publish the shared CPU projection');
  }
  const retiredAtRdtsc = BigInt.asUintN(64, E.vm_x86_retired(session));
  if (!E.vm_x86_direct_time(machine, 0n, 0n)
      || (registers[0] | (registers[2] << 32n)) !== retiredAtRdtsc) {
    throw new Error('typed RDTSC did not use the source-instruction clock');
  }
  if (!E.vm_x86_direct_write_msr(machine, 0xc0000103n, 0x89abcdefn)
      || !E.vm_x86_direct_time(machine, 1n, 0n)
      || registers[1] !== 0x89abcdefn
      || (registers[0] | (registers[2] << 32n)) !== retiredAtRdtsc) {
    throw new Error('typed RDTSCP did not publish TSC_AUX with the virtual clock');
  }
  const entropyDescriptor = 2n | (64n << 8n);
  if (E.vm_x86_direct_entropy(machine, entropyDescriptor, 0n)) {
    throw new Error('typed RDRAND skipped its entropy barrier');
  }
  const entropyLease = E.vm_x86_entropy_lease(session);
  if (!entropyLease || !E.vm_x86_supply_entropy(
    session, entropyLease, 0x0123456789abcdefn,
  ) || !E.vm_x86_direct_entropy(machine, entropyDescriptor, 0n)
      || registers[2] !== 0x0123456789abcdefn
      || (E.vm_x86_rflags(session) & 0x8d5n) !== 1n) {
    throw new Error('typed RDRAND did not consume exactly one supplied value');
  }
  const cliFunction = table.get(tableBase + 15);
  const cliResult = cliFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (cliResult !== 4n || E.vm_x86_rflags(session) !== 0x3003n
      || E.vm_x86_rip(session) !== 0x7800n) {
    throw new Error('typed CLI did not enforce and publish RFLAGS.IF');
  }
  registers[4] = 0x5000n;
  const farReturnFunction = table.get(tableBase + 7);
  const farReturnResult = farReturnFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (farReturnResult !== 1n || E.vm_x86_rip(session) !== 0x7000n
      || registers[4] !== 0x5010n || system[7] !== 0x10n
      || E.vm_x86_exception_pending(session)) {
    throw new Error('typed LRETQ did not publish one canonical machine cut');
  }
  registers[0] = 0x3000n;
  const writeCr3Function = table.get(tableBase + 8);
  const writeCr3Result = writeCr3Function(
    machine, E.vm_x86_executable_context(session),
  );
  if (writeCr3Result !== 4n || E.vm_x86_cr3(session) !== 0x3000n
      || E.vm_x86_rip(session) !== 0x7100n) {
    throw new Error('typed MOV CR3 did not publish the MMU generation cut');
  }
  registers[0] = 0n;
  branchResult = branchFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (branchResult !== 1n || E.vm_x86_rip(session) !== 0x6200n) {
    throw new Error('post-LRETQ test did not restore dispatcher coordinate');
  }
  /* Page dispatch remains a normal table function.  A cold row returns one
   * bounded token to C; only authenticated 64-byte/1-KiB rows become hot. */
  const dispatcher = table.get(tableBase + 20);
  let dispatchResult = dispatcher(
    E.vm_x86_machine_state(session), E.vm_x86_executable_context(session),
  );
  if (dispatchResult !== 6n) {
    throw new Error(`page dispatcher did not request page row: ${dispatchResult}`);
  }
  await supplyEntryMap(dispatchResult);
  dispatchResult = dispatcher(
    E.vm_x86_machine_state(session), E.vm_x86_executable_context(session),
  );
  if (dispatchResult !== 14n) {
    throw new Error(`page dispatcher did not request tail row: ${dispatchResult}`);
  }
  await supplyEntryMap(dispatchResult);
  dispatchResult = dispatcher(
    E.vm_x86_machine_state(session), E.vm_x86_executable_context(session),
  );
  if (dispatchResult !== 24n) {
    throw new Error('total page dispatcher did not return the physical rank');
  }
  /* A second lookup is the steady-state two-load path: no host request. */
  dispatchResult = dispatcher(
    E.vm_x86_machine_state(session), E.vm_x86_executable_context(session),
  );
  if (dispatchResult !== 24n) {
    throw new Error('resident entry map repeated cold admission');
  }
  const indexStarts = E.vm_x86_executable_index_starts(session);
  const indexNodes = E.vm_x86_executable_index_nodes(session);
  const indexCacheHits = E.vm_x86_executable_index_cache_hits(session);
  const indexCacheMisses = E.vm_x86_executable_index_cache_misses(session);
  const physicalLookupProbes = E.vm_x86_physical_lookup_probes(session);
  const physicalVictimProbes = E.vm_x86_physical_victim_probes(session);
  if (!indexCacheHits || indexNodes >= indexStarts
      || indexCacheMisses > indexNodes || physicalLookupProbes > 256n
      || physicalVictimProbes) {
    throw new Error(
      `resident caches did not remove repeated scans `
        + `(starts=${indexStarts}, nodes=${indexNodes}, `
        + `hits=${indexCacheHits}, misses=${indexCacheMisses}, `
        + `physical=${physicalLookupProbes}/${physicalVictimProbes})`,
    );
  }
  system[7] = 0n;
  if (!E.vm_x86_direct_write_control(
    machine, 0n, E.vm_x86_cr0(session) | 1n,
  ) || !E.vm_x86_direct_write_msr(machine, 0xc0000080n, 0x401n)
      || !E.vm_x86_direct_write_msr(
        machine, 0xc0000081n, (0x20n << 48n) | (0x8n << 32n),
      ) || !E.vm_x86_direct_write_msr(machine, 0xc0000082n, 0x8000n)
      || !E.vm_x86_direct_write_msr(machine, 0xc0000084n, 0x200n)) {
    throw new Error('typed system-transfer fixture rejected its MSR state');
  }
  registers[11] = 0n;
  if (!E.vm_x86_direct_system_transfer(machine, 0n, 0x9000n)
      || E.vm_x86_rip(session) !== 0x8000n
      || registers[1] !== 0x9000n || system[7] !== 0x8n
      || system[8] !== 0x10n || (E.vm_x86_rflags(session) & 0x200n)) {
    throw new Error('typed SYSCALL did not publish the STAR/LSTAR cut');
  }
  store64(0x5080n, 0xb000n, 0x7fff0110);
  store64(0x5088n, 0x10n, 0x7fff0111);
  store64(0x5090n, 0x202n, 0x7fff0112);
  store64(0x5098n, 0x6000n, 0x7fff0113);
  store64(0x50a0n, 0x18n, 0x7fff0114);
  registers[4] = 0x5080n;
  if (!E.vm_x86_direct_interrupt_return(machine, 64n, 0n)
      || E.vm_x86_rip(session) !== 0xb000n
      || registers[4] !== 0x6000n || system[7] !== 0x10n
      || system[8] !== 0x18n
      || (E.vm_x86_rflags(session) & 0x202n) !== 0x202n) {
    throw new Error('typed IRETQ did not atomically restore its frame');
  }
  store64(0x50b0n, (0x10n << 32n) | 0xd000n, 0x7fff0400);
  store64(0x50b8n, (0x7000n << 32n) | 0x246n, 0x7fff0401);
  store64(0x50c0n, 0x18n, 0x7fff0402);
  registers[4] = 0x50b0n;
  if (!E.vm_x86_direct_interrupt_return(machine, 32n, 0n)
      || E.vm_x86_rip(session) !== 0xd000n
      || registers[4] !== 0x7000n || system[7] !== 0x10n
      || system[8] !== 0x18n
      || (E.vm_x86_rflags(session) & 0x246n) !== 0x246n) {
    throw new Error('typed IRETD did not atomically restore its frame');
  }
  store64(0x50d0n, 0xc000n, 0x7fff0117);
  store64(0x50d8n, 0x10n, 0x7fff0118);
  registers[4] = 0x5200n;
  if (!E.vm_x86_direct_far_transfer(
    machine, 0x50d0n, 1n | (80n << 8n), 0xc100n,
  ) || E.vm_x86_rip(session) !== 0xc000n
      || registers[4] !== 0x51f0n || system[7] !== 0x10n
      || load64(0x51f0n, 0x7fff0119) !== 0xc100n
      || load64(0x51f8n, 0x7fff011a) !== 0x10n) {
    throw new Error('typed far CALL did not atomically publish its frame');
  }
  store64(0x50e0n, 0xc200n, 0x7fff011b);
  store64(0x50e8n, 0x10n, 0x7fff011c);
  if (!E.vm_x86_direct_far_transfer(
    machine, 0x50e0n, 80n << 8n, 0n,
  ) || E.vm_x86_rip(session) !== 0xc200n
      || registers[4] !== 0x51f0n || system[7] !== 0x10n) {
    throw new Error('typed far JMP did not publish the descriptor transition');
  }
  store64(0x50f0n, 0x0000000000101234n, 0x7fff011d);
  registers[4] = 0x5200n;
  if (!E.vm_x86_direct_far_transfer(
    machine, 0x50f0n, 1n | (32n << 8n), 0xabcden,
  ) || E.vm_x86_rip(session) !== 0x1234n
      || registers[4] !== 0x51fcn || system[7] !== 0x10n
      || (load64(0x51fcn, 0x7fff011e) & 0xffffffffn)
         !== 0x0010bcden) {
    throw new Error('typed m16:16 far CALL did not publish its 16-bit frame');
  }
  store64(0x50c0n, 5n, 0x7fff0115);
  registers[3] = 7n;
  if (!E.vm_x86_direct_atomic(
    machine, 0x50c0n, 1n | (8n << 8n) | (3n << 16n),
  ) || registers[3] !== 5n
      || load64(0x50c0n, 0x7fff0116) !== 12n
      || !(E.vm_x86_rflags(session) & 4n)) {
    throw new Error('typed LOCK XADD did not publish memory, GPR and flags');
  }
  const carryBeforeInc = E.vm_x86_rflags(session) & 1n;
  if (!E.vm_x86_direct_atomic(machine, 0x50c0n, 11n | (8n << 8n))
      || load64(0x50c0n, 0x7fff011d) !== 13n
      || (E.vm_x86_rflags(session) & 1n) !== carryBeforeInc
      || !E.vm_x86_direct_atomic(machine, 0x50c0n, 12n | (8n << 8n))
      || load64(0x50c0n, 0x7fff011e) !== 12n
      || (E.vm_x86_rflags(session) & 1n) !== carryBeforeInc) {
    throw new Error('typed LOCK INC/DEC did not preserve CF atomically');
  }
  store64(0x50c8n, 0n, 0x7fff0300);
  registers[7] = 5n;
  const bitDescriptor = (8n << 8n) | (7n << 16n);
  if (!E.vm_x86_direct_atomic(machine, 0x50c8n, 14n | bitDescriptor)
      || load64(0x50c8n, 0x7fff0301) !== 32n
      || (E.vm_x86_rflags(session) & 1n)
      || !E.vm_x86_direct_atomic(machine, 0x50c8n, 16n | bitDescriptor)
      || load64(0x50c8n, 0x7fff0302) !== 0n
      || !(E.vm_x86_rflags(session) & 1n)
      || !E.vm_x86_direct_atomic(machine, 0x50c8n, 15n | bitDescriptor)
      || load64(0x50c8n, 0x7fff0303) !== 0n
      || (E.vm_x86_rflags(session) & 1n)) {
    throw new Error('typed LOCK BTS/BTR/BTC did not publish one bit-string cut');
  }
  store64(0x50f0n, 0xfffffffffffffff0n, 0x7fff011f);
  const immediateTag = 1n << 25n;
  const byteImmediateStatus = E.vm_x86_direct_atomic(
    machine, 0x50f0n,
    4n | (1n << 8n) | immediateTag | (0x0fn << 32n),
  );
  const byteImmediateValue = load64(0x50f0n, 0x7fff0120);
  if (!byteImmediateStatus || byteImmediateValue !== -1n) {
    throw new Error(
      `typed LOCK ADD byte immediate: status=${byteImmediateStatus}`
      + ` value=0x${byteImmediateValue.toString(16)}`,
    );
  }
  store64(0x5100n, 0xffffffffffffffffn, 0x7fff0121);
  if (!E.vm_x86_direct_atomic(
    machine, 0x5100n,
    8n | (4n << 8n) | immediateTag | (0x12345678n << 32n),
  ) || load64(0x5100n, 0x7fff0122)
      !== BigInt.asIntN(64, 0xffffffff12345678n)) {
    throw new Error('typed LOCK AND dword immediate did not preserve neighbors');
  }
  store64(0x5110n, 5n, 0x7fff0123);
  if (!E.vm_x86_direct_atomic(
    machine, 0x5110n,
    9n | (8n << 8n) | immediateTag | (0xffffffffn << 32n),
  ) || load64(0x5110n, 0x7fff0124) !== 6n) {
    throw new Error('typed LOCK SUB qword did not sign-extend imm8');
  }
  store64(0x5120n, 0x1122334455667788n, 0x7fff0125);
  registers[0] = 0x55667788n;
  registers[2] = 0x11223344n;
  registers[3] = 0xaabbccddn;
  registers[1] = 0xeeff0011n;
  if (!E.vm_x86_direct_atomic(machine, 0x5120n, 13n | (8n << 8n))
      || BigInt.asUintN(64, load64(0x5120n, 0x7fff0126))
         !== 0xeeff0011aabbccddn
      || !(E.vm_x86_rflags(session) & 0x40n)) {
    throw new Error('typed CMPXCHG8B success did not publish ECX:EBX');
  }
  store64(0x5120n, 0x123456789abcdef0n, 0x7fff0127);
  registers[0] = 0n;
  registers[2] = 0n;
  if (!E.vm_x86_direct_atomic(machine, 0x5120n, 13n | (8n << 8n))
      || registers[0] !== 0x9abcdef0n
      || registers[2] !== 0x12345678n
      || BigInt.asUintN(64, load64(0x5120n, 0x7fff0128))
         !== 0x123456789abcdef0n
      || (E.vm_x86_rflags(session) & 0x40n)) {
    throw new Error('typed CMPXCHG8B failure did not publish EDX:EAX');
  }
  store64(0x54d0n, 0x0123456789abcdefn, 0x7fff0283);
  if (!E.vm_x86_direct_memory_order(machine, 0n, 0n)
      || !E.vm_x86_direct_memory_order(machine, 0n, 1n)
      || !E.vm_x86_direct_memory_order(machine, 0n, 2n)
      || !E.vm_x86_direct_memory_order(machine, 0n, 3n)
      || !E.vm_x86_direct_memory_order(machine, 0x54d0n, 4n)
      || !E.vm_x86_direct_memory_order(machine, 0n, 5n)
      || !E.vm_x86_direct_memory_order(machine, 0n, 6n)
      || !E.vm_x86_direct_memory_order(machine, 0x54d0n, 7n)) {
    throw new Error('typed memory-order/cache cut rejected a valid CPL0 state');
  }
  registers[5] = 0x123456789abcdef0n;
  if (!E.vm_x86_direct_debug_register(
    machine, 1n | (3n << 8n) | (5n << 16n), 0n,
  ) || system[17] !== 0x123456789abcdef0n) {
    throw new Error('typed MOV DR3,RBP did not publish debug state');
  }
  registers[5] = 0n;
  if (!E.vm_x86_direct_debug_register(
    machine, (3n << 8n) | (5n << 16n), 0n,
  ) || registers[5] !== 0x123456789abcdef0n) {
    throw new Error('typed MOV RBP,DR3 did not restore debug state');
  }
  const xmm = new BigUint64Array(
    E.memory.buffer, E.vm_x86_xmm(session), 32,
  );
  xmm[2] = 0x0123456789abcdefn;
  xmm[3] = 0xfedcba9876543210n;
  if (!E.vm_x86_direct_vector(machine, 1n << 16n, 0n)
      || xmm[0] !== xmm[2] || xmm[1] !== xmm[3]
      || !E.vm_x86_direct_vector(machine, 1n, 0n)
      || xmm[0] || xmm[1]) {
    throw new Error('typed MOVDQA/PXOR did not publish two parallel XMM lanes');
  }
  xmm[0] = 0xffffffff00000001n;
  xmm[1] = 0x00000002fffffff0n;
  xmm[2] = 0x0000000200000003n;
  xmm[3] = 0xffffffff00000020n;
  if (!E.vm_x86_direct_vector(machine, 4n | (1n << 16n), 0n)
      || xmm[0] !== 0x0000000100000004n
      || xmm[1] !== 0x0000000100000010n) {
    throw new Error('typed PADDD did not publish four physical u32 lanes');
  }
  xmm[6] = 0xfeffffff01000001n;
  xmm[7] = 0x0000000180000000n;
  if (!E.vm_x86_direct_vector(
    machine, 16n | (2n << 8n) | (3n << 16n), 0n,
  ) || xmm[4] !== 0xcb8000004b800000n
      || xmm[5] !== 0x3f800000cf000000n) {
    throw new Error('typed CVTDQ2PS converted four signed lanes in one wave');
  }
  xmm[6] = 0x4000000040800000n;
  xmm[7] = 0xbf80000080000000n;
  if (!E.vm_x86_direct_vector(
    machine, 18n | (4n << 8n) | (3n << 16n), 0n,
  ) || xmm[8] !== 0x3fb504f340000000n
      || xmm[9] !== 0xffc0000080000000n) {
    throw new Error('typed SQRTPS did not resolve four binary32 lanes');
  }
  store64(0x5450n, 0x4000000040800000n, 0x7fff0279);
  store64(0x5458n, 0xbf80000080000000n, 0x7fff027a);
  if (!E.vm_x86_direct_vector(
    machine, 18n | (5n << 8n) | (1n << 24n), 0x5450n,
  ) || xmm[10] !== 0x3fb504f340000000n
      || xmm[11] !== 0xffc0000080000000n) {
    throw new Error('typed SQRTPS did not resolve its m128 source wave');
  }
  xmm[6] = 0x400000003f800000n;
  xmm[7] = 0x4180000040800000n;
  if (!E.vm_x86_direct_vector(
    machine, 37n | (4n << 8n) | (3n << 16n), 0n,
  ) || xmm[8] !== 0x3f0000003f800000n
      || xmm[9] !== 0x3d8000003e800000n) {
    throw new Error('typed RCPPS did not resolve four reciprocal lanes');
  }
  xmm[6] = 0x408000003f800000n;
  xmm[7] = 0x7f80000041800000n;
  if (!E.vm_x86_direct_vector(
    machine, 38n | (4n << 8n) | (3n << 16n), 0n,
  ) || xmm[8] !== 0x3f0000003f800000n
      || xmm[9] !== 0x000000003e800000n) {
    throw new Error('typed RSQRTPS did not resolve four reciprocal-root lanes');
  }
  xmm[0] = 0xbf8000003f800000n;
  xmm[1] = 0x000000007fc00000n;
  xmm[6] = 0x000000003f800000n;
  xmm[7] = 0x8000000040000000n;
  if (!E.vm_x86_direct_vector(
    machine, 19n | (3n << 16n), 0n,
  ) || xmm[0] !== 0x00000000ffffffffn
      || xmm[1] !== 0xffffffff00000000n) {
    throw new Error('typed CMPPS EQ did not classify four binary32 lanes');
  }
  xmm[0] = 0xbf8000003f800000n;
  xmm[1] = 0x000000007fc00000n;
  if (!E.vm_x86_direct_vector(
    machine, 19n | (3n << 16n) | (5n << 32n), 0n,
  ) || xmm[0] !== 0x00000000ffffffffn
      || xmm[1] !== 0xffffffffffffffffn) {
    throw new Error('typed CMPPS NLT did not include unordered lanes');
  }
  xmm[0] = 0x111111113f800000n;
  xmm[6] = 0x2222222240000000n;
  if (!E.vm_x86_direct_vector(
    machine, 25n | (3n << 16n), 0n,
  ) || (E.vm_x86_rflags(session) & 0x8d5n) !== 1n) {
    throw new Error('typed UCOMISS did not publish the scalar less relation');
  }
  store64(0x55b0n, 0xaaaaaaaa3f800000n, 0x7fff028a);
  if (!E.vm_x86_direct_vector(
    machine, 25n | (1n << 24n), 0x55b0n,
  ) || (E.vm_x86_rflags(session) & 0x8d5n) !== 0x40n) {
    throw new Error('typed UCOMISS did not publish its m32 equal relation');
  }
  xmm[0] = 0x000000003f800000n;
  xmm[1] = 0x7fc123457f7fffffn;
  xmm[6] = 0x8000000040000000n;
  xmm[7] = 0x3f8000007f7fffffn;
  if (!E.vm_x86_direct_vector(
    machine, 20n | (3n << 16n), 0n,
  ) || xmm[0] !== 0x0000000040400000n
      || xmm[1] !== 0x7fc123457f800000n) {
    throw new Error('typed ADDPS did not add four binary32 lanes atomically');
  }
  xmm[12] = 0xbf8000003f800000n;
  xmm[13] = 0x008000003f800000n;
  store64(0x5590n, 0xb380000033800000n, 0x7fff0287);
  store64(0x5598n, 0x807fffffbf800000n, 0x7fff0288);
  if (!E.vm_x86_direct_vector(
    machine, 20n | (6n << 8n) | (1n << 24n), 0x5590n,
  ) || xmm[12] !== 0xbf8000003f800000n
      || xmm[13] !== 0x0000000100000000n) {
    throw new Error('typed ADDPS missed rounding, cancellation or m128 input');
  }
  xmm[0] = 0x800000003f800000n;
  xmm[1] = 0x408000007fc11111n;
  xmm[6] = 0x0000000040000000n;
  xmm[7] = 0x7fc2222240400000n;
  if (!E.vm_x86_direct_vector(
    machine, 26n | (3n << 16n) | (1n << 32n), 0n,
  ) || xmm[0] !== 0x0000000040000000n
      || xmm[1] !== 0x7fc2222240400000n) {
    throw new Error('typed MAXPS did not select source on equal/NaN lanes');
  }
  xmm[0] = 0x800000003f800000n;
  xmm[1] = 0x408000007fc11111n;
  if (!E.vm_x86_direct_vector(
    machine, 26n | (3n << 16n), 0n,
  ) || xmm[0] !== 0x000000003f800000n
      || xmm[1] !== 0x7fc2222240400000n) {
    throw new Error('typed MINPS did not select source on equal/NaN lanes');
  }
  xmm[0] = 0x0807060504030201n;
  xmm[1] = 0x100f0e0d0c0b0a09n;
  if (!E.vm_x86_direct_vector(
    machine, 23n | (32n << 32n) | (4n << 32n), 0n,
  ) || xmm[0] !== 0x0403020100000000n
      || xmm[1] !== 0x0c0b0a0908070605n) {
    throw new Error('typed PSLLDQ did not shift one complete XMM lane');
  }
  xmm[0] = 0x0807060504030201n;
  xmm[1] = 0x100f0e0d0c0b0a09n;
  if (!E.vm_x86_direct_vector(
    machine, 23n | (8n << 32n), 0n,
  ) || xmm[0] !== 0x100f0e0d0c0b0a09n || xmm[1]) {
    throw new Error('typed PSRLDQ did not shift across the physical u64 cut');
  }
  xmm[0] = 0x2222222211111111n;
  xmm[1] = 0x3333333344444444n;
  xmm[2] = 0xbbbbbbbbaaaaaaaan;
  xmm[3] = 0xccccccccddddddddn;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (1n << 16n) | (18n << 32n), 0n,
  ) || xmm[0] !== 0xaaaaaaaa11111111n
      || xmm[1] !== 0xbbbbbbbb22222222n) {
    throw new Error('typed PUNPCKLDQ/UNPCKLPS did not share the low-dword wave');
  }
  xmm[0] = 0x2222222211111111n;
  xmm[1] = 0x3333333344444444n;
  xmm[2] = 0xbbbbbbbbaaaaaaaan;
  xmm[3] = 0xccccccccddddddddn;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (1n << 16n) | (19n << 32n), 0n,
  ) || xmm[0] !== 0x3333333344444444n
      || xmm[1] !== 0xccccccccddddddddn) {
    throw new Error('typed PUNPCKHQDQ did not select two physical high lanes');
  }
  xmm[0] = 0n;
  xmm[1] = 0x0807060504030201n;
  xmm[2] = 0n;
  xmm[3] = 0x1817161514131211n;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (1n << 16n) | (13n << 32n), 0n,
  ) || xmm[0] !== 0x1404130312021101n
      || xmm[1] !== 0x1808170716061505n) {
    throw new Error('typed XMM PUNPCKHBW did not publish two parallel u64 lanes');
  }
  xmm[0] = 0x1111111122222222n;
  xmm[1] = 0x3333333344444444n;
  xmm[2] = 0xaaaaaaaa55555555n;
  xmm[3] = 0xbbbbbbbb66666666n;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (1n << 16n) | (22n << 32n), 0n,
  ) || xmm[0] !== 0x1111111122222222n
      || xmm[1] !== 0xaaaaaaaa55555555n) {
    throw new Error('typed PUNPCKLQDQ did not select two low qword lanes');
  }
  xmm[4] = 0x0002000000000000n;
  xmm[5] = 0x0000000000020000n;
  if (!E.vm_x86_direct_vector(
    machine, 11n | (2n << 8n) | (2n << 16n) | (17n << 32n), 0n,
  ) || xmm[4] !== 0x0000000100000000n || xmm[5] !== 1n) {
    throw new Error('typed PSRLQ shifted two physical qword lanes');
  }
  registers[7] = 0xfedcba9876543210n;
  if (!E.vm_x86_direct_vector(
    machine, 13n | (1n << 8n) | (14n << 32n), 0n,
  ) || xmm[2] !== 0xfedcba9876543210n || xmm[3]
      || !E.vm_x86_direct_vector(
        machine, 13n | (1n << 16n) | (15n << 32n), 0n,
      ) || registers[7] !== 0xfedcba9876543210n) {
    throw new Error('typed MOVQ did not share the direct XMM/GPR transfer');
  }
  xmm[0] = 0x1122334455667788n;
  xmm[1] = 0x99aabbccddeeff00n;
  if (!E.vm_x86_direct_vector(machine, 14n | (2n << 24n), 0x5130n)
      || BigInt.asUintN(64, load64(0x5130n, 0x7fff0129))
         !== 0x1122334455667788n) {
    throw new Error('typed MOVLPS stored only the low physical XMM lane');
  }
  store64(0x5140n, 0x0f1e2d3c4b5a6978n, 0x7fff012a);
  if (!E.vm_x86_direct_vector(
    machine, 14n | (1n << 24n) | (1n << 32n), 0x5140n,
  ) || xmm[0] !== 0x1122334455667788n
      || xmm[1] !== 0x0f1e2d3c4b5a6978n) {
    throw new Error('typed MOVHPS replaced only the high physical XMM lane');
  }
  registers[7] = 0xabcdn;
  xmm[0] = 0x1111222233334444n;
  xmm[1] = 0x5555666677778888n;
  if (!E.vm_x86_direct_vector(
    machine, 15n | (7n << 16n) | (5n << 32n), 0n,
  ) || xmm[0] !== 0x1111222233334444n
      || xmm[1] !== 0x55556666abcd8888n) {
    throw new Error('typed XMM PINSRW did not touch one selected word lane');
  }
  store64(0x54b0n, 0x0000000200000003n, 0x7fff0277);
  store64(0x54b8n, 0xffffffff00000020n, 0x7fff0278);
  xmm[0] = 0xffffffff00000001n;
  xmm[1] = 0x00000002fffffff0n;
  if (!E.vm_x86_direct_vector(machine, 4n | (5n << 24n), 0x54b0n)
      || xmm[0] !== 0x0000000100000004n
      || xmm[1] !== 0x0000000100000010n) {
    throw new Error('typed memory PADDD did not reuse the two-lane m128 path');
  }
  store64(0x5480n, 0xff00ff00ff00ff00n, 0x7fff0261);
  store64(0x5488n, 0x0f0f0f0f0f0f0f0fn, 0x7fff0262);
  xmm[0] = 0xffff0000ffff0000n;
  xmm[1] = 0x3333333333333333n;
  const andpsAdmitted = E.vm_x86_direct_vector(
    machine, 2n | (5n << 24n), 0x5480n,
  );
  const andpsLow = xmm[0];
  const andpsHigh = xmm[1];
  const movdqaAdmitted = E.vm_x86_direct_vector(
    machine, 6n << 24n, 0x5490n,
  );
  const storedLow = BigInt.asUintN(64, load64(0x5490n, 0x7fff0263));
  const storedHigh = BigInt.asUintN(64, load64(0x5498n, 0x7fff0264));
  if (!andpsAdmitted || andpsLow !== 0xff000000ff000000n
      || andpsHigh !== 0x0303030303030303n || !movdqaAdmitted
      || storedLow !== andpsLow || storedHigh !== andpsHigh) {
    throw new Error(
      'typed ANDPS/MOVDQA did not use one aligned physical m128 transaction:'
      + ` admitted=${andpsAdmitted}/${movdqaAdmitted}`
      + ` lane=0x${andpsHigh.toString(16)}${andpsLow.toString(16)}`
      + ` stored=0x${storedHigh.toString(16)}${storedLow.toString(16)}`,
    );
  }
  xmm[0] = 0xf0f0f0f0f0f0f0f0n;
  xmm[1] = 0xaaaaaaaaaaaaaaaan;
  xmm[2] = 0xffff0000ffff0000n;
  xmm[3] = 0xffffffffffffffffn;
  if (!E.vm_x86_direct_vector(
    machine, 24n | (1n << 16n), 0n,
  ) || xmm[0] !== 0x0f0f00000f0f0000n
      || xmm[1] !== 0x5555555555555555n) {
    throw new Error('typed ANDNPS did not complement both destination lanes');
  }
  store64(0x54a0n, 0x1122334455667788n, 0x7fff0265);
  store64(0x54a8n, 0x99aabbccddeeff00n, 0x7fff0266);
  if (!E.vm_x86_direct_vector(
    machine, (1n << 8n) | (1n << 24n), 0x54a0n,
  ) || xmm[2] !== 0x1122334455667788n
      || xmm[3] !== 0x99aabbccddeeff00n) {
    throw new Error('typed MOVDQU loaded one unaligned-capable m128 cut');
  }
  xmm[4] = 0x8000000012345000n;
  xmm[5] = 0xffffffff00001000n;
  if (!E.vm_x86_direct_vector(
    machine, 5n | (2n << 8n) | (2n << 16n) | (12n << 32n), 0n,
  ) || xmm[4] !== 0x0008000000012345n
      || xmm[5] !== 0x000fffff00000001n) {
    throw new Error('typed PSRLD shifted four physical u32 lanes in one wave');
  }
  xmm[6] = 0x0000000200000001n;
  xmm[7] = 0x1000000000000003n;
  if (!E.vm_x86_direct_vector(
    machine, 6n | (3n << 8n) | (3n << 16n) | (4n << 32n), 0n,
  ) || xmm[6] !== 0x0000002000000010n
      || xmm[7] !== 0x0000000000000030n) {
    throw new Error('typed PSLLD shifted four physical u32 lanes in one wave');
  }
  xmm[8] = 0xffffffffffffffffn;
  xmm[9] = 0xffffffffffffffffn;
  if (!E.vm_x86_direct_vector(
    machine, 5n | (4n << 8n) | (4n << 16n) | (32n << 32n), 0n,
  ) || xmm[8] || xmm[9]) {
    throw new Error('typed PSRLD normalized an out-of-range count to zero');
  }
  store64(0x54c0n, 0x0000000200000001n, 0x7fff027d);
  store64(0x54c8n, 0x0000000400000003n, 0x7fff027e);
  if (!E.vm_x86_direct_vector(
    machine, 7n | (5n << 8n) | (5n << 24n) | (0x1bn << 32n),
    0x54c0n,
  ) || xmm[10] !== 0x0000000300000004n
      || xmm[11] !== 0x0000000100000002n) {
    throw new Error('typed PSHUFD projected four m128 lanes without scalar state');
  }
  xmm[12] = 0x0000000b0000000an;
  xmm[13] = 0x0000000d0000000cn;
  xmm[14] = 0x0000001500000014n;
  xmm[15] = 0x0000001700000016n;
  if (!E.vm_x86_direct_vector(
    machine, 8n | (6n << 8n) | (7n << 16n) | (0x1bn << 32n), 0n,
  ) || xmm[12] !== 0x0000000c0000000dn
      || xmm[13] !== 0x0000001400000015n) {
    throw new Error('typed SHUFPS selected both physical XMM source lanes');
  }
  registers[7] = 0x11223344cafebaben;
  if (!E.vm_x86_direct_vector(
    machine, 9n | (8n << 8n) | (14n << 32n), 0n,
  ) || xmm[16] !== 0xcafebaben || xmm[17]
      || !E.vm_x86_direct_vector(
        machine, 9n | (8n << 16n) | (15n << 32n), 0n,
      ) || registers[7] !== 0xcafebaben) {
    throw new Error('typed XMM MOVD register transfer did not zero-extend dword state');
  }
  store64(0x54e0n, 0x8877665544332211n, 0x7fff0284);
  if (!E.vm_x86_direct_vector(
    machine, 9n | (9n << 8n) | (1n << 24n), 0x54e0n,
  ) || xmm[18] !== 0x44332211n || xmm[19]) {
    throw new Error('typed XMM MOVD loaded one physical dword from memory');
  }
  const x87Environment = new Uint16Array(
    E.memory.buffer, E.vm_x86_x87_environment(session), 4,
  );
  if (x87Environment[0] !== 0x037f || x87Environment[1] !== 0
      || x87Environment[2] !== 0xffff
      || !E.vm_x86_direct_x87(machine, 0n, 0n)) {
    throw new Error('typed FWAIT did not observe canonical persistent x87 state');
  }
  store64(0x50f0n, BigInt.asUintN(64, -37n), 0x7fff011f);
  if (!E.vm_x86_direct_x87(
    machine, 0x50f0n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || ((x87Environment[1] >> 11) & 7) !== 7
      || ((x87Environment[2] >> 14) & 3) === 3) {
    throw new Error('typed FILD did not push the canonical x87 stack');
  }
  const fisttpAdmitted = E.vm_x86_direct_x87(
    machine, 0x50f8n, 2n | (8n << 8n) | (0x138n << 16n),
  );
  const fisttpValue = load64(0x50f8n, 0x7fff0120);
  const fisttpTop = (x87Environment[1] >> 11) & 7;
  if (!fisttpAdmitted
      || BigInt.asIntN(64, fisttpValue) !== -37n
      || fisttpTop !== 0 || x87Environment[2] !== 0xffff) {
    throw new Error(
      `typed FISTTP did not store/pop: admitted=${fisttpAdmitted}`
      + ` value=0x${BigInt.asUintN(64, fisttpValue).toString(16)}`
      + ` top=${fisttpTop}`
      + ` status=0x${x87Environment[1].toString(16)}`
      + ` tag=0x${x87Environment[2].toString(16)}`,
    );
  }
  store64(0x5100n, 2n, 0x7fff0121);
  store64(0x5108n, 5n, 0x7fff0122);
  if (!E.vm_x86_direct_x87(
    machine, 0x5100n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5108n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 5n | (0x7e9n << 16n) | (1n << 32n),
  ) || (E.vm_x86_rflags(session) & 0x8d5n)
      || ((x87Environment[1] >> 11) & 7) !== 7) {
    throw new Error('typed FUCOMIP did not compare and pop the x87 stack');
  }
  if (!E.vm_x86_direct_x87(
    machine, 0x5110n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x5110n, 0x7fff0123) !== 2n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FUCOMIP did not leave the surviving ST1 value');
  }
  store64(0x5118n, 2n, 0x7fff0123);
  store64(0x5120n, 5n, 0x7fff0124);
  if (!E.vm_x86_direct_x87(
    machine, 0x5118n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5120n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 19n | (0x7f1n << 16n) | (1n << 32n),
  ) || (E.vm_x86_rflags(session) & 0x8d5n)
      || !E.vm_x86_direct_x87(
        machine, 0x5128n, 2n | (8n << 8n) | (0x138n << 16n),
      ) || load64(0x5128n, 0x7fff0125) !== 2n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FCOMIP did not use signaling compare and pop');
  }
  store64(0x5130n, BigInt.asUintN(64, -3n), 0x7fff0126);
  store64(0x5138n, 5n, 0x7fff0127);
  if (!E.vm_x86_direct_x87(
    machine, 0x5130n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5138n, 7n | (4n << 8n) | (0x208n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5140n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || BigInt.asIntN(64, load64(0x5140n, 0x7fff0128)) !== -15n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FIMUL did not multiply the canonical x87 lane');
  }
  store64(0x5140n, 3n, 0x7fff0127);
  store64(0x5148n, 0x4000000000000000n, 0x7fff0128);
  if (!E.vm_x86_direct_x87(
    machine, 0x5140n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5148n, 8n | (8n << 8n) | (0x400n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5150n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x5150n, 0x7fff0129) !== 5n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FADD did not add the canonical x87 lanes');
  }
  store64(0x5160n, 3n, 0x7fff012a);
  store64(0x5168n, 0x4000000000000000n, 0x7fff012b);
  if (!E.vm_x86_direct_x87(
    machine, 0x5160n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5168n, 9n | (8n << 8n) | (0x408n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5170n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x5170n, 0x7fff012c) !== 6n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FMUL did not multiply the canonical x87 lanes');
  }
  store64(0x5178n, 4n, 0x7fff012d);
  store64(0x5180n, 3n, 0x7fff012e);
  if (!E.vm_x86_direct_x87(
    machine, 0x5178n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5180n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 9n | (0x6c9n << 16n) | (1n << 36n)
      | (1n << 40n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5188n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x5188n, 0x7fff012f) !== 12n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FMULP did not multiply and pop physical lanes');
  }
  store64(0x5180n, 0x4000000000000000n, 0x7fff012d);
  if (!E.vm_x86_direct_x87(
    machine, 0x5180n, 10n | (8n << 8n) | (0x100n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5188n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x5188n, 0x7fff012e) !== 2n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FLD did not push the canonical x87 lane');
  }
  store64(0x5180n, 7n, 0x7fff0130);
  store64(0x5188n, 2n, 0x7fff0131);
  if (!E.vm_x86_direct_x87(
    machine, 0x5180n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5188n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 21n | (0x1c9n << 16n) | (1n << 32n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5190n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x5190n, 0x7fff0132) !== 7n
      || !E.vm_x86_direct_x87(
        machine, 0x5198n, 2n | (8n << 8n) | (0x138n << 16n),
      ) || load64(0x5198n, 0x7fff0133) !== 2n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FXCH did not exchange complete physical lanes');
  }
  store64(0x5198n, 11n, 0x7fff0134);
  if (!E.vm_x86_direct_x87(
    machine, 0x5198n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 22n | (0x5c0n << 16n),
  ) || ((x87Environment[1] >> 11) & 7) !== 7
      || x87Environment[2] !== 0xffff
      || !E.vm_x86_direct_x87(
        machine, 0n, 22n | (0x7c0n << 16n) | (1n << 40n),
      ) || ((x87Environment[1] >> 11) & 7) !== 0) {
    throw new Error('typed FFREE(P) did not update only tag and TOP');
  }
  store64(0x5190n, 5n, 0x7fff012f);
  store64(0x5198n, 0x4000000000000000n, 0x7fff0130);
  if (!E.vm_x86_direct_x87(
    machine, 0x5190n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5198n, 11n | (8n << 8n) | (0x418n << 16n)
      | (1n << 36n),
  ) || (x87Environment[1] & 0x4500)
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FCOMP did not publish condition codes and pop');
  }
  store64(0x51a0n, 2n, 0x7fff0131);
  store64(0x51a8n, 5n, 0x7fff0132);
  if (!E.vm_x86_direct_x87(
    machine, 0x51a0n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x51a8n, 11n | (2n << 8n) | (0x618n << 16n)
      | (5n << 36n),
  ) || (x87Environment[1] & 0x4500) !== 0x0100
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FICOMP did not compare an exact signed integer');
  }
  store64(0x51b0n, 3n, 0x7fff0133);
  store64(0x51b8n, 5n, 0x7fff0134);
  if (!E.vm_x86_direct_x87(
    machine, 0x51b0n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x51b8n, 12n | (4n << 8n) | (0x200n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x51c0n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x51c0n, 0x7fff0135) !== 8n) {
    throw new Error('typed FIADD did not reuse the canonical x87 sum');
  }
  store64(0x51c8n, 3n, 0x7fff0136);
  store64(0x51d0n, 5n, 0x7fff0137);
  if (!E.vm_x86_direct_x87(
    machine, 0x51c8n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x51d0n, 12n | (2n << 8n) | (0x628n << 16n)
      | (3n << 36n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x51d8n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x51d8n, 0x7fff0138) !== 2n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FISUBR did not reverse the canonical x87 sum');
  }
  store64(0x51e0n, 5n, 0x7fff0139);
  store64(0x51e8n, 2n, 0x7fff013a);
  if (!E.vm_x86_direct_x87(
    machine, 0x51e0n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x51e8n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 13n | (0x6e9n << 16n) | (1n << 36n)
      | (2n << 40n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x51f0n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x51f0n, 0x7fff013b) !== 3n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FSUBP did not subtract and pop physical lanes');
  }
  store64(0x5200n, 3n, 0x7fff013c);
  if (!E.vm_x86_direct_x87(
    machine, 0x5200n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5208n, 14n | (8n << 8n) | (0x518n << 16n)
      | (1n << 40n),
  ) || load64(0x5208n, 0x7fff013d) !== 0x4008000000000000n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FSTP did not round, store and pop binary64');
  }
  store64(0x5210n, 5n, 0x7fff013e);
  if (!E.vm_x86_direct_x87(
    machine, 0x5210n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 14n | (0x7d1n << 16n) | (1n << 36n)
      | (1n << 40n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5218n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x5218n, 0x7fff013f) !== 5n
      || ((x87Environment[1] >> 11) & 7) !== 1
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed register FSTP did not copy and pop physical lanes');
  }
  store64(0x5220n, 6n, 0x7fff0140);
  store64(0x5228n, 2n, 0x7fff0141);
  if (!E.vm_x86_direct_x87(
    machine, 0x5220n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5228n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 15n | (0x6f9n << 16n) | (1n << 36n)
      | (2n << 40n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5230n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x5230n, 0x7fff0142) !== 3n
      || ((x87Environment[1] >> 11) & 7) !== 1
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FDIVP did not divide and pop physical lanes');
  }
  const divisionCorpus = [
    [1n, 3n], [2n, 3n], [7n, 3n], [17n, 5n], [37n, 11n],
    [0x7fffffffn, 97n], [-37n, 5n], [37n, -5n], [-37n, -5n],
    [0x1fffffffffffffn, 3n], [0x3fffffffffffffffn, 0x7fffffffn],
  ];
  for (let index = 0; index < divisionCorpus.length; index += 1) {
    const [numerator, denominator] = divisionCorpus[index];
    const block = 0x7fff0200 + index * 5;
    store64(0x5240n, BigInt.asUintN(64, numerator), block);
    store64(0x5248n, BigInt.asUintN(64, denominator), block + 1);
    if (!E.vm_x86_direct_x87(
      machine, 0x5240n, 1n | (8n << 8n) | (0x528n << 16n),
    ) || !E.vm_x86_direct_x87(
      machine, 0x5248n, 1n | (8n << 8n) | (0x528n << 16n),
    ) || !E.vm_x86_direct_x87(
      machine, 0n, 15n | (0x6f9n << 16n) | (1n << 36n)
        | (2n << 40n),
    ) || !E.vm_x86_direct_x87(
      machine, 0x5250n, 2n | (8n << 8n) | (0x138n << 16n),
    )) {
      throw new Error(`typed FDIVP corpus case ${index} was not admitted`);
    }
    const actual = BigInt.asIntN(
      64, load64(0x5250n, block + 2),
    );
    if (actual !== numerator / denominator
        || ((x87Environment[1] >> 11) & 7) !== 1
        || x87Environment[2] !== 0xffff) {
      throw new Error(
        `typed FDIVP corpus case ${index}: ${numerator}/${denominator}`
        + ` -> ${actual}, expected ${numerator / denominator}`,
      );
    }
  }
  store64(0x5260n, 2n, 0x7fff0240);
  store64(0x5268n, 6n, 0x7fff0241);
  if (!E.vm_x86_direct_x87(
    machine, 0x5260n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5268n, 16n | (4n << 8n) | (0x238n << 16n)
      | (1n << 36n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5270n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x5270n, 0x7fff0242) !== 3n
      || ((x87Environment[1] >> 11) & 7) !== 1
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FIDIVR did not reuse the canonical x87 division');
  }
  const packedBcdValue = 123456789012345678n;
  store64(0x52d0n, 0x3456789012345678n, 0x7fff024c);
  store64(0x52d8n, 0x12n, 0x7fff024d);
  if (!E.vm_x86_direct_x87(
    machine, 0x52d0n, 27n | (10n << 8n) | (0x720n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x52e0n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x52e0n, 0x7fff024e) !== packedBcdValue) {
    throw new Error('typed FBLD did not decode eighteen packed decimal digits');
  }
  store64(0x52e8n, packedBcdValue, 0x7fff024f);
  store64(0x52f8n, 0n, 0x7fff0250);
  if (!E.vm_x86_direct_x87(
    machine, 0x52e8n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x52f0n, 28n | (10n << 8n) | (0x730n << 16n),
  ) || load64(0x52f0n, 0x7fff0251) !== 0x3456789012345678n
      || (load64(0x52f8n, 0x7fff0252) & 0xffffn) !== 0x12n
      || ((x87Environment[1] >> 11) & 7) !== 1
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FBSTP did not encode, store and pop packed BCD');
  }
  store64(0x5300n, 42n, 0x7fff0253);
  if (!E.vm_x86_direct_x87(
    machine, 0x5300n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5310n, 34n | (108n << 8n),
  ) || x87Environment[0] !== 0x037f
      || x87Environment[1] !== 0 || x87Environment[2] !== 0xffff
      || !E.vm_x86_direct_x87(
        machine, 0x5310n, 35n | (108n << 8n),
      ) || !E.vm_x86_direct_x87(
        machine, 0x5380n, 2n | (8n << 8n) | (0x138n << 16n),
      ) || load64(0x5380n, 0x7fff0254) !== 42n
      || ((x87Environment[1] >> 11) & 7) !== 1
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FNSAVE/FRSTOR did not roundtrip logical x87 lanes');
  }
  store64(0x5390n, 0x0b40n, 0x7fff0255);
  if (!E.vm_x86_direct_x87(
    machine, 0x5390n, 30n | (2n << 8n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5398n, 29n | (2n << 8n),
  ) || (load64(0x5398n, 0x7fff0256) & 0xffffn) !== 0x0b40n
      || !E.vm_x86_direct_x87(
        machine, 0x53a0n, 32n | (28n << 8n),
      ) || x87Environment[0] !== 0x0b7f
      || (load64(0x53a0n, 0x7fff0257) & 0xffffn) !== 0x0b40n
      || !E.vm_x86_direct_x87(
        machine, 0x53a0n, 33n | (28n << 8n),
      ) || x87Environment[0] !== 0x0b40) {
    throw new Error('typed x87 control/environment codec was not reversible');
  }
  registers[0] = 0x1234000000000000n;
  if (!E.vm_x86_direct_x87(machine, 0x53c0n, 31n | (2n << 8n))
      || (load64(0x53c0n, 0x7fff0258) & 0xffffn)
         !== BigInt(x87Environment[1])
      || !E.vm_x86_direct_x87(machine, 0n, 31n)
      || registers[0] !== (0x1234000000000000n
                           | BigInt(x87Environment[1]))) {
    throw new Error('typed FNSTSW did not publish memory and AX projections');
  }
  store64(0x53c8n, 0x037fn, 0x7fff0259);
  if (!E.vm_x86_direct_x87(machine, 0x53c8n, 30n | (2n << 8n))) {
    throw new Error('typed FLDCW did not restore the default control word');
  }
  store64(0x53d0n, 4n, 0x7fff025a);
  store64(0x53d8n, 3n, 0x7fff025b);
  if (!E.vm_x86_direct_x87(
    machine, 0x53d0n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x53d8n, 1n | (8n << 8n) | (0x528n << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 8n | (0x6c1n << 16n) | (1n << 36n)
      | (1n << 40n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x53e0n, 2n | (8n << 8n) | (0x138n << 16n),
  ) || load64(0x53e0n, 0x7fff025c) !== 7n
      || ((x87Environment[1] >> 11) & 7) !== 1
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FADDP did not add and pop complete x87 lanes');
  }
  store64(0x53e8n, 3n, 0x7fff025d);
  store64(0x53f0n, 5n, 0x7fff025e);
  if ((E.vm_x86_rflags(session) & 1n)
      || !E.vm_x86_direct_x87(
        machine, 0x53e8n, 1n | (8n << 8n) | (0x528n << 16n),
      ) || !E.vm_x86_direct_x87(
        machine, 0x53f0n, 1n | (8n << 8n) | (0x528n << 16n),
      ) || !E.vm_x86_direct_x87(
        machine, 0n, 36n | (0x3c1n << 16n) | (1n << 32n)
          | (3n << 44n),
      ) || !E.vm_x86_direct_x87(
        machine, 0x53f8n, 2n | (8n << 8n) | (0x138n << 16n),
      ) || load64(0x53f8n, 0x7fff025f) !== 3n
      || !E.vm_x86_direct_x87(
        machine, 0x5400n, 2n | (8n << 8n) | (0x138n << 16n),
      ) || load64(0x5400n, 0x7fff0260) !== 3n
      || ((x87Environment[1] >> 11) & 7) !== 1
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed FCMOVNB did not select and copy a complete x87 lane');
  }
  const mmx = new BigUint64Array(
    E.memory.buffer, E.vm_x86_x87_significand(session), 8,
  );
  xmm[6] = 0xc020000040700000n;
  if (!E.vm_x86_direct_vector(
    machine, 17n | (3n << 16n), 0n,
  ) || mmx[0] !== 0xfffffffe00000003n
      || ((x87Environment[1] >> 11) & 7) !== 0
      || x87Environment[2] !== 0) {
    throw new Error('typed CVTTPS2PI did not truncate two XMM float lanes');
  }
  store64(0x5580n, 0xcf0000007fc00000n, 0x7fff0286);
  if (!E.vm_x86_direct_vector(
    machine, 17n | (1n << 8n) | (1n << 24n), 0x5580n,
  ) || mmx[1] !== 0x8000000080000000n) {
    throw new Error('typed CVTTPS2PI did not publish the masked invalid lane');
  }
  xmm[6] = 0xc020000040600000n;
  if (!E.vm_x86_direct_vector(
    machine, 21n | (2n << 8n) | (3n << 16n), 0n,
  ) || mmx[2] !== 0xfffffffe00000004n) {
    throw new Error('typed CVTPS2PI did not apply nearest-even to two lanes');
  }
  store64(0x55a0n, 0x3fc000003f000000n, 0x7fff0289);
  if (!E.vm_x86_direct_vector(
    machine, 21n | (3n << 8n) | (1n << 24n), 0x55a0n,
  ) || mmx[3] !== 0x0000000200000000n) {
    throw new Error('typed CVTPS2PI did not round its m64 source');
  }
  mmx[4] = 0xfffffffe00000003n;
  xmm[12] = 0n;
  xmm[13] = 0x1122334455667788n;
  if (!E.vm_x86_direct_vector(
    machine, 30n | (6n << 8n) | (4n << 16n), 0n,
  ) || xmm[12] !== 0xc000000040400000n
      || xmm[13] !== 0x1122334455667788n) {
    throw new Error('typed CVTPI2PS converted MMX lanes and preserved XMM high64');
  }
  xmm[6] = 0xc02000003fc00000n;
  if (!E.vm_x86_direct_vector(
    machine, 31n | (7n << 8n) | (3n << 16n), 0n,
  ) || xmm[14] !== 0x3ff8000000000000n
      || xmm[15] !== 0xc004000000000000n) {
    throw new Error('typed CVTPS2PD widened two binary32 lanes exactly');
  }
  xmm[0] = 0x4080000040400000n;
  xmm[1] = 0x4100000040c00000n;
  xmm[2] = 0x4000000040000000n;
  xmm[3] = 0x3f0000003f800000n;
  if (!E.vm_x86_direct_vector(machine, 34n | (1n << 16n), 0n)
      || xmm[0] !== 0x4100000040c00000n
      || xmm[1] !== 0x4080000040c00000n) {
    throw new Error('typed packed binary32 multiply was not exact');
  }
  xmm[0] = 0x4080000040400000n;
  xmm[1] = 0x4100000040c00000n;
  if (!E.vm_x86_direct_vector(machine, 35n | (1n << 16n), 0n)
      || xmm[0] !== 0x400000003f800000n
      || xmm[1] !== 0x40f0000040a00000n) {
    throw new Error('typed packed binary32 subtract was not exact');
  }
  xmm[0] = 0x4080000040400000n;
  xmm[1] = 0x4100000040c00000n;
  if (!E.vm_x86_direct_vector(machine, 36n | (1n << 16n), 0n)
      || xmm[0] !== 0x400000003fc00000n
      || xmm[1] !== 0x4180000040c00000n) {
    throw new Error('typed packed binary32 mul/sub/div did not publish four exact lanes');
  }
  xmm[2] = 0x400e000000000000n;
  xmm[3] = 0xc004000000000000n;
  if (!E.vm_x86_direct_vector(
    machine, 32n | (3n << 8n) | (1n << 16n), 0n,
  ) || mmx[3] !== 0xfffffffe00000003n) {
    throw new Error('typed CVTTPD2PI truncated two binary64 lanes exactly');
  }
  store64(0x55b0n, 0x7ff8000000000000n, 0x7fff028a);
  store64(0x55b8n, 0x41e0000000000000n, 0x7fff028b);
  if (!E.vm_x86_direct_vector(
    machine, 32n | (4n << 8n) | (1n << 24n), 0x55b0n,
  ) || mmx[4] !== 0x8000000080000000n) {
    throw new Error('typed CVTTPD2PI did not publish masked invalid lanes');
  }
  mmx[0] = 0x8877665544332211n;
  mmx[1] = 0x8000008000000080n;
  store64(0x55c0n, 0xaaaaaaaaaaaaaaaan, 0x7fff028c);
  const maskmovAccepted = E.vm_x86_direct_vector(
    machine, 33n | (1n << 16n) | (11n << 32n), 0x55c0n,
  );
  const maskmovValue = load64(0x55c0n, 0x7fff028d);
  if (!maskmovAccepted
      || BigInt.asUintN(64, maskmovValue) !== 0x88aaaa55aaaaaa11n) {
    throw new Error('typed MASKMOVQ did not store only selected byte lanes');
  }
  mmx[1] = 0n;
  if (!E.vm_x86_direct_vector(
    machine, 33n | (1n << 16n) | (11n << 32n), 0xffffffffffffffffn,
  )) {
    throw new Error('typed MASKMOVQ touched an address with an empty mask');
  }
  mmx[3] = 0x1122334455667788n;
  if (!E.vm_x86_direct_vector(
    machine, 22n | (4n << 8n) | (3n << 16n) | (11n << 32n), 0n,
  ) || registers[4] !== 0x1122n) {
    throw new Error('typed PEXTRW did not extract the selected MMX word');
  }
  xmm[6] = 0x1122334455667788n;
  xmm[7] = 0x99aabbccddeeff00n;
  if (!E.vm_x86_direct_vector(
    machine, 22n | (5n << 8n) | (3n << 16n) | (7n << 32n), 0n,
  ) || registers[5] !== 0x99aan) {
    throw new Error('typed PEXTRW did not extract the selected XMM word');
  }
  registers[7] = 0x0123456789abcdefn;
  if (!E.vm_x86_direct_x87(
    machine, 0n, 45n | (0x6cfn << 16n) | (1n << 36n) | (7n << 44n),
  ) || mmx[1] !== 0x0123456789abcdefn
      || !E.vm_x86_direct_x87(
        machine, 0n, 45n | (0x7cfn << 16n) | (1n << 32n)
          | (1n << 40n) | (6n << 44n),
      ) || registers[6] !== 0x0123456789abcdefn) {
    throw new Error('typed MMX/GPR MOVQ did not publish one u64 lane');
  }
  registers[7] = 0xabcdn;
  mmx[0] = 0x1111222233334444n;
  if (!E.vm_x86_direct_x87(
    machine, 0n, 46n | (0x4c7n << 16n) | (7n << 44n) | (3n << 48n),
  ) || mmx[0] !== 0xabcd222233334444n) {
    throw new Error('typed MMX PINSRW did not touch one selected word lane');
  }
  store64(0x5280n, 0x0000000200000001n, 0x7fff0243);
  store64(0x5288n, 0x0000000400000003n, 0x7fff0244);
  if (!E.vm_x86_direct_x87(
    machine, 0x5280n, 17n | (8n << 8n) | (0x76fn << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x5288n, 17n | (8n << 8n) | (0x76fn << 16n)
      | (1n << 36n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 18n | (0x7fen << 16n) | (1n << 32n),
  ) || mmx[0] !== 0x0000000600000004n
      || x87Environment[2] !== 0
      || !E.vm_x86_direct_x87(
        machine, 0x5290n, 17n | (8n << 8n) | (0x77fn << 16n)
          | (1n << 40n),
  ) || load64(0x5290n, 0x7fff0245) !== 0x0000000600000004n) {
    throw new Error('typed MMX MOVQ/PADDD did not publish physical u32 lanes');
  }
  if (!E.vm_x86_direct_x87(
    machine, 0n, 23n | (0x7efn << 16n) | (1n << 32n),
  ) || mmx[0] !== 0x0000000200000007n) {
    throw new Error('typed MMX PXOR did not publish one physical u64 lane');
  }
  store64(0x52a0n, 0x0807060504030201n, 0x7fff0246);
  store64(0x52a8n, 0x0800060004030001n, 0x7fff0247);
  if (!E.vm_x86_direct_x87(
    machine, 0x52a0n, 17n | (8n << 8n) | (0x76fn << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x52a8n, 24n | (8n << 8n) | (0x740n << 16n),
  ) || mmx[0] !== 0xff00ff00ffff00ffn) {
    throw new Error('typed PCMPEQB did not expand eight physical byte lanes');
  }
  store64(0x52b0n, 0xffffffff00000005n, 0x7fff0248);
  store64(0x52b8n, 0xfffffffe00000007n, 0x7fff0249);
  if (!E.vm_x86_direct_x87(
    machine, 0x52b0n, 17n | (8n << 8n) | (0x76fn << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x52b8n, 17n | (8n << 8n) | (0x76fn << 16n)
      | (1n << 36n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 25n | (0x7c1n << 16n) | (1n << 32n),
  ) || mmx[0] !== 0xffffffff00000000n) {
    throw new Error('typed PCMPGTD did not compare two signed dword lanes');
  }
  const packed37 = (operation) => 37n | (0x7c1n << 16n)
    | (1n << 32n) | (BigInt(operation & 3) << 40n)
    | (BigInt(operation >> 2) << 44n);
  const packedCases = [
    [9, 0x0807060504030201n, 0x0102030405060708n, 0x20n],
    [10, 0x0807060504030201n, 0x0102030405060708n,
      0x07050301fffdfbf9n],
    [11, 0xfffa0005ffff0002n, 0xfff9000700000001n,
      0xffff00000000ffffn],
    [12, 0xf0f0f0f0f0f0f0f0n, 0xffffffffffffffffn,
      0x0f0f0f0f0f0f0f0fn],
    [13, 0x0807060504030201n, 0x1817161514131211n,
      0x1808170716061505n],
    [14, 0x0004fffd00020001n, 0x00080007fffa0005n,
      0x0000000bfffffff9n],
    [15, 0xffffffffffffffffn, 2n, 1n],
    [16, 0x000112348000ffffn, 0xffff10000002ffffn,
      0x000001230001fffen],
    [17, 0xfffa0005ffff0002n, 0xfff9000700000001n,
      0xfff90005ffff0001n],
    [18, 0xaaaabbbbccccddddn, 0x1111222233334444n,
      0x33334444ccccddddn],
    [20, 0x0004000300020001n, 0x0014001300120011n,
      0x0014000400130003n],
    [21, 0x0004000300020001n, 0x0005000400010000n,
      0xffffffff00010001n],
    [23, 0x00000000ffffffffn, 2n, 0x00000001fffffffen],
    [24, 0xf807fa05fc03ff01n, 0xf908f905fb040000n,
      0x0000ff00ff0000ffn],
    [25, 0x4000ffff80007fffn, 0x4000800000020002n,
      0x10000000ffff0000n],
    [26, 0x010000ff0000ffffn, 0x7fff007f00018000n,
      0xff7f0100ffff0000n],
    [27, 0x8ad0753080007fffn, 0xd8f02710ffff0001n,
      0x80007fff80007fffn],
    [28, 0x1234ffff80010001n, 4n, 0x2340fff000100010n],
    [29, 0x0004000300020001n, 0x0014001300120011n,
      0x0012000200110001n],
    [30, 0xfffa0005ffff0002n, 0xfff9000700000001n,
      0xfffa000700000002n],
    [31, 0x640afffa03020100n, 0x3214fa0502030101n,
      0x320005f501000000n],
    [32, 0xfafafafafafafafan, 0x0a0a0a0a0a0a0a0an,
      0xffffffffffffffffn],
    [33, 0x00020406080a0c0en, 0x020406080a0c0e10n,
      0x01030507090b0d0fn],
    [34, 0x0007000500030001n, 0x0008000600040002n,
      0x0008000600040002n],
    [35, 0xff00aa5510203040n, 0x00ff55aa40103020n,
      0xffffaaaa40203040n],
    [36, 0x7fffffff80000000n, 4n, 0x07fffffff8000000n],
    [38, 0xaaaabbbbccccddddn, 0x1111222233334444n,
      0x11112222aaaabbbbn],
    [39, 0x0807060504030201n, 0x1817161514131211n,
      0x1404130312021101n],
    [40, 0x00008000ffff7fffn, 0x00007fff00010000n,
      0x7fff7fff7fff8000n],
    [41, 0x7f7f7f7f80808080n, 0x01010101ffffffffn,
      0x7f7f7f7f80808080n],
    [42, 0xfff000010002ffffn, 0x0020ffff0001ffffn,
      0xffffffff0003ffffn],
    [43, 0xff00aa5510203040n, 0x00ff55aa40103020n,
      0x0000555510103020n],
    [44, 0x7fff8000f0000001n, 4n, 0x07fff800ff000000n],
    [45, 0x7fff8000f0000001n, 4n, 0x07ff08000f000000n],
    [46, 0x0080007fffff0001n, 0x0100ff807fff0000n,
      0x7f807f007f7fff01n],
    [47, 0xffff000400030002n, 0x0001000500020003n,
      0xfffe000000010000n],
  ];
  for (const [operation, left, right, expected] of packedCases) {
    mmx[0] = left;
    mmx[1] = right;
    if (!E.vm_x86_direct_x87(machine, 0n, packed37(operation))
        || mmx[0] !== expected) {
      throw new Error(
        `typed packed-lane operation ${operation}: `
        + `0x${mmx[0].toString(16)} != 0x${expected.toString(16)}`,
      );
    }
  }
  xmm[20] = 0x00020406080a0c0en;
  xmm[21] = 0x10121416181a1c1en;
  xmm[22] = 0x020406080a0c0e10n;
  xmm[23] = 0x121416181a1c1e20n;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (10n << 8n) | (11n << 16n) | (33n << 32n), 0n,
  ) || xmm[20] !== 0x01030507090b0d0fn
      || xmm[21] !== 0x11131517191b1d1fn) {
    throw new Error('typed XMM PAVGB did not share both physical u64 lanes');
  }
  xmm[20] = 0x010000ff0000ffffn;
  xmm[21] = 0x0001007f0080002an;
  xmm[22] = 0x7fff007f00018000n;
  xmm[23] = 0x000000ffffff0100n;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (10n << 8n) | (11n << 16n) | (26n << 32n), 0n,
  ) || xmm[20] !== 0x017f802affff0000n
      || xmm[21] !== 0x00ff00ffff7f0100n) {
    throw new Error('typed XMM PACKUSWB preserved its cross-u64 lane order');
  }
  xmm[20] = 0x0004000300020001n;
  xmm[21] = 0x0008000700060005n;
  xmm[22] = 4n;
  xmm[23] = 0xffffffffffffffffn;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (10n << 8n) | (11n << 16n) | (28n << 32n), 0n,
  ) || xmm[20] !== 0x0040003000200010n
      || xmm[21] !== 0x0080007000600050n) {
    throw new Error('typed XMM PSLLW used one physical count for every lane');
  }
  xmm[20] = 0x0004000300020001n;
  xmm[21] = 0xffffffffffffffffn;
  xmm[22] = 0x0014001300120011n;
  xmm[23] = 0xeeeeeeeeeeeeeeeen;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (10n << 8n) | (11n << 16n) | (29n << 32n), 0n,
  ) || xmm[20] !== 0x0012000200110001n
      || xmm[21] !== 0x0014000400130003n) {
    throw new Error('typed XMM PUNPCKLWD ignored the untouched upper source');
  }
  xmm[20] = 0x1111222233334444n;
  xmm[21] = 0x5555666677778888n;
  xmm[22] = 0x9999aaaabbbbccccn;
  xmm[23] = 0xddddeeeeffff0000n;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (10n << 8n) | (11n << 16n) | (37n << 32n), 0n,
  ) || xmm[20] !== 0xffff000077778888n
      || xmm[21] !== 0xddddeeee55556666n) {
    throw new Error('typed XMM UNPCKHPS selected the two high dword lanes');
  }
  xmm[20] = 0x0807060504030201n;
  xmm[21] = 0x1817161514131211n;
  xmm[22] = 0x2827262524232221n;
  xmm[23] = 0x3837363534333231n;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (10n << 8n) | (11n << 16n) | (39n << 32n), 0n,
  ) || xmm[20] !== 0x2404230322022101n
      || xmm[21] !== 0x2808270726062505n) {
    throw new Error('typed XMM PUNPCKLBW selected only the low eight bytes');
  }
  xmm[20] = 0x00008000ffff7fffn;
  xmm[21] = 0x00007fff00010000n;
  xmm[22] = 0xffffffff00000001n;
  xmm[23] = 0x00010000ffff0000n;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (10n << 8n) | (11n << 16n) | (40n << 32n), 0n,
  ) || xmm[20] !== 0x7fff7fff7fff8000n
      || xmm[21] !== 0x7fff8000ffff0001n) {
    throw new Error('typed XMM PACKSSDW preserved its cross-u64 lane order');
  }
  xmm[20] = 0x0807060504030201n;
  xmm[21] = 0x1817161514131211n;
  xmm[22] = 0x0800060004000200n;
  xmm[23] = 0x1810161014101210n;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (10n << 8n) | (11n << 16n) | (48n << 32n), 0n,
  ) || xmm[20] !== 0xff00ff00ff00ff00n
      || xmm[21] !== 0xff00ff00ff00ff00n) {
    throw new Error('typed XMM PCMPEQB compared sixteen byte lanes');
  }
  xmm[20] = 0x0004000300020001n;
  xmm[21] = 0x0008000700060005n;
  xmm[22] = 0x0008000700060005n;
  xmm[23] = 0x0004000300020001n;
  if (!E.vm_x86_direct_vector(
    machine, 10n | (10n << 8n) | (11n << 16n) | (49n << 32n), 0n,
  ) || xmm[20] !== 0x00200015000c0005n
      || xmm[21] !== 0x00200015000c0005n) {
    throw new Error('typed XMM PMULLW multiplied eight word lanes');
  }
  xmm[20] = 0x7777666655554444n;
  xmm[21] = 0x3333222211110000n;
  if (!E.vm_x86_direct_vector(
    machine, 27n | (10n << 8n) | (10n << 16n) | (0x50n << 32n), 0n,
  ) || xmm[20] !== 0x7777666655554444n
      || xmm[21] !== 0x1111111100000000n) {
    throw new Error('typed PSHUFHW preserved low words and selected high words');
  }
  xmm[10] = 0x0123456789abcdefn;
  xmm[11] = 0xfedcba9876543210n;
  xmm[12] = 0x1111222233334444n;
  xmm[13] = 0x5555666677778888n;
  if (!E.vm_x86_direct_vector(
    machine, 29n | (6n << 8n) | (5n << 16n), 0n,
  ) || xmm[12] !== 0xfedcba9876543210n
      || xmm[13] !== 0x5555666677778888n) {
    throw new Error('typed MOVHLPS projected the source high qword once');
  }
  mmx[7] = 0x80ff7f018000ff7fn;
  registers[7] = 0xffffffffffffffffn;
  if (!E.vm_x86_direct_x87(
    machine, 0n, 55n | (0x7d7n << 16n) | (7n << 32n) | (7n << 44n),
  ) || registers[7] !== 0xcan) {
    throw new Error('typed PMOVMSKB projected eight sign bits to one GPR');
  }
  if (!E.vm_x86_direct_vector(machine, 28n | (1n << 25n), 0x5338n)) {
    throw new Error('typed STMXCSR did not preserve the prior control word');
  }
  store64(0x5340n, 0x0000000000009fc0n, 0x7fff0291);
  store64(0x5348n, 0xfeedfacecafebeefn, 0x7fff0292);
  if (!E.vm_x86_direct_vector(machine, 28n | (1n << 24n), 0x5340n)
      || !E.vm_x86_direct_vector(machine, 28n | (1n << 25n), 0x5348n)
      || (load64(0x5348n, 0x7fff0293) & 0xffffffffn) !== 0x9fc0n) {
    throw new Error('typed LDMXCSR/STMXCSR shared one canonical control word');
  }
  if (!E.vm_x86_direct_vector(
    machine, 28n | (1n << 24n), 0x5338n,
  )) {
    throw new Error('typed LDMXCSR did not restore the prior control word');
  }
  store64(0x5ff8n, 0x11223344aabbccddn, 0x7fff0280);
  mmx[0] = 0xaaaabbbbccccddddn;
  if (!E.vm_x86_direct_x87(
    machine, 0x5ffcn,
    37n | (4n << 8n) | (0x762n << 16n)
      | (2n << 40n) | (4n << 44n),
  ) || mmx[0] !== 0x11223344ccccddddn) {
    throw new Error('typed MMX PUNPCKLDQ read exactly one m32 at a page tail');
  }
  x87Environment[0] = 0;
  x87Environment[1] = 0xffff;
  x87Environment[2] = 0;
  if (!E.vm_x86_direct_x87(machine, 0n, 44n)
      || x87Environment[0] !== 0x037f
      || x87Environment[1] !== 0 || x87Environment[2] !== 0xffff) {
    throw new Error('typed FNINIT did not reset the complete x87 environment');
  }
  const trigSignExponent = new Uint16Array(
    E.memory.buffer, E.vm_x86_x87_sign_exponent(session), 8,
  );
  const doubleAsX87 = (bits) => {
    const sign = Number(bits >> 63n);
    const exponent = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & 0x000fffffffffffffn;
    return {
      significand: ((1n << 52n) | fraction) << 11n,
      signExponent: (sign << 15) | (exponent - 1023 + 0x3fff),
    };
  };
  const resetTrigInput = (bits) => {
    if (!E.vm_x86_direct_x87(machine, 0n, 44n)) {
      throw new Error('typed x87 reset failed before trig operation');
    }
    const input = doubleAsX87(bits);
    mmx[0] = input.significand;
    trigSignExponent[0] = input.signExponent;
    x87Environment[2] &= 0xfffc;
  };
  const setTrigSecond = (bits) => {
    const input = doubleAsX87(bits);
    mmx[1] = input.significand;
    trigSignExponent[1] = input.signExponent;
    x87Environment[2] &= 0xfff3;
  };
  const expectX87 = (physical, bits, label) => {
    const expected = doubleAsX87(bits);
    if (mmx[physical] !== expected.significand
        || trigSignExponent[physical] !== expected.signExponent) {
      throw new Error(
        `${label}: ${trigSignExponent[physical].toString(16)}:`
          + `${mmx[physical].toString(16)} != `
          + `${expected.signExponent.toString(16)}:`
          + expected.significand.toString(16),
      );
    }
  };
  resetTrigInput(0x3ff0000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 54n | (0x1e0n << 16n))) {
    throw new Error('typed FCHS rejected a finite x87 lane');
  }
  expectX87(0, 0xbff0000000000000n, 'typed FCHS');
  if (!E.vm_x86_direct_x87(
    machine, 0n, 54n | (0x1e1n << 16n) | (1n << 44n),
  )) {
    throw new Error('typed FABS rejected a finite x87 lane');
  }
  expectX87(0, 0x3ff0000000000000n, 'typed FABS');
  resetTrigInput(0x3fe0000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 58n | (0x1f0n << 16n))) {
    throw new Error('typed F2XM1 rejected its bounded finite input');
  }
  expectX87(0, 0x3fda827999fcef34n, 'typed F2XM1');
  resetTrigInput(0x4010000000000000n);
  setTrigSecond(0x4008000000000000n);
  if (!E.vm_x86_direct_x87(
    machine, 0n, 58n | (0x1f1n << 16n) | (1n << 44n),
  ) || ((x87Environment[1] >> 11) & 7) !== 1) {
    throw new Error('typed FYL2X rejected its two-lane log product');
  }
  expectX87(1, 0x4018000000000000n, 'typed FYL2X');
  resetTrigInput(0x3fd0000000000000n);
  setTrigSecond(0x4000000000000000n);
  if (!E.vm_x86_direct_x87(
    machine, 0n, 58n | (0x1f9n << 16n) | (2n << 44n),
  ) || ((x87Environment[1] >> 11) & 7) !== 1) {
    throw new Error('typed FYL2XP1 rejected its two-lane log1p product');
  }
  expectX87(1, 0x3fe49a784bcd1b8bn, 'typed FYL2XP1');
  resetTrigInput(0x3ff0000000000000n);
  setTrigSecond(0x3ff0000000000000n);
  if (!E.vm_x86_direct_x87(
    machine, 0n, 58n | (0x1f3n << 16n) | (3n << 44n),
  ) || ((x87Environment[1] >> 11) & 7) !== 1) {
    throw new Error('typed FPATAN rejected its two-lane atan2 input');
  }
  expectX87(1, 0x3fe921fb54442d18n, 'typed FPATAN');
  resetTrigInput(0x3ff0000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 48n | (0x1ffn << 16n))) {
    throw new Error('typed FCOS rejected a finite x87 input');
  }
  expectX87(0, 0x3fe14a280fb5068cn, 'typed FCOS');
  resetTrigInput(0x3ff0000000000000n);
  if (!E.vm_x86_direct_x87(
    machine, 0n, 48n | (0x1fen << 16n) | (1n << 44n),
  )) {
    throw new Error('typed FSIN rejected a finite x87 input');
  }
  expectX87(0, 0x3feaed548f090ceen, 'typed FSIN');
  resetTrigInput(0x43b0000000000000n);
  if (!E.vm_x86_direct_x87(
    machine, 0n, 48n | (0x1fen << 16n) | (1n << 44n),
  )) {
    throw new Error('typed FSIN rejected its large reduced domain');
  }
  expectX87(0, 0xbfea94adab06665cn, 'typed large-domain FSIN');
  resetTrigInput(0x3ff0000000000000n);
  if (!E.vm_x86_direct_x87(
    machine, 0n, 48n | (0x1fbn << 16n) | (2n << 44n),
  ) || ((x87Environment[1] >> 11) & 7) !== 7) {
    throw new Error('typed FSINCOS did not publish its parallel stack result');
  }
  expectX87(0, 0x3feaed548f090ceen, 'typed FSINCOS sine');
  expectX87(7, 0x3fe14a280fb5068cn, 'typed FSINCOS cosine');
  resetTrigInput(0x3ff0000000000000n);
  if (!E.vm_x86_direct_x87(
    machine, 0n, 48n | (0x1f2n << 16n) | (3n << 44n),
  ) || ((x87Environment[1] >> 11) & 7) !== 7) {
    throw new Error('typed FPTAN did not publish its parallel stack result');
  }
  expectX87(0, 0x3ff8eb245cbee3a6n, 'typed FPTAN tangent');
  expectX87(7, 0x3ff0000000000000n, 'typed FPTAN pushed one');
  resetTrigInput(0x43f0000000000000n);
  const outside = mmx[0];
  if (!E.vm_x86_direct_x87(machine, 0n, 48n | (0x1ffn << 16n))
      || mmx[0] !== outside || !(x87Environment[1] & 0x400)) {
    throw new Error('typed FCOS did not preserve an out-of-range residual');
  }
  const roundCases = [
    [0x4004000000000000n, 0, 0x4000000000000000n, 'nearest-even 2.5'],
    [0x400c000000000000n, 0, 0x4010000000000000n, 'nearest-even 3.5'],
    [0xc002000000000000n, 1, 0xc008000000000000n, 'downward -2.25'],
    [0xc002000000000000n, 2, 0xc000000000000000n, 'upward -2.25'],
    [0x4006000000000000n, 3, 0x4000000000000000n, 'toward-zero 2.75'],
  ];
  for (const [input, rounding, expected, label] of roundCases) {
    resetTrigInput(input);
    x87Environment[0] = (x87Environment[0] & ~0xc00) | (rounding << 10);
    if (!E.vm_x86_direct_x87(machine, 0n, 49n | (0x1fcn << 16n))) {
      throw new Error(`typed FRNDINT rejected ${label}`);
    }
    expectX87(0, expected, `typed FRNDINT ${label}`);
    if (!(x87Environment[1] & 0x20)) {
      throw new Error(`typed FRNDINT omitted precision status for ${label}`);
    }
  }
  resetTrigInput(0x4000000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 49n | (0x1fcn << 16n))
      || (x87Environment[1] & 0x20)) {
    throw new Error('typed FRNDINT changed an exact integral lane');
  }
  resetTrigInput(0x4014000000000000n);
  if (!E.vm_x86_direct_x87(
    machine, 0n, 14n | (0x1d8n << 16n) | (1n << 40n),
  ) || ((x87Environment[1] >> 11) & 7) !== 1
      || (x87Environment[2] & 3) !== 3) {
    throw new Error('typed FSTPNCE did not retire exactly the current x87 lane');
  }
  const setScaleSource = (bits) => {
    const input = doubleAsX87(bits);
    mmx[1] = input.significand;
    trigSignExponent[1] = input.signExponent;
    x87Environment[2] &= ~0xc;
  };
  resetTrigInput(0x3ff8000000000000n);
  setScaleSource(0x4008000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 50n | (0x1fdn << 16n))) {
    throw new Error('typed FSCALE rejected an exact finite exponent shift');
  }
  expectX87(0, 0x4028000000000000n, 'typed FSCALE exact finite result');
  resetTrigInput(0x3ff0000000000000n);
  mmx[0] = 0x8000000000000000n;
  trigSignExponent[0] = 1;
  setScaleSource(0xbff0000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 50n | (0x1fdn << 16n))
      || mmx[0] !== 0x4000000000000000n || trigSignExponent[0] !== 0) {
    throw new Error('typed FSCALE did not preserve an exact subnormal lane');
  }
  resetTrigInput(0x3ff0000000000000n);
  mmx[0] = 0xffffffffffffffffn;
  trigSignExponent[0] = 0x7ffe;
  setScaleSource(0x3ff0000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 50n | (0x1fdn << 16n))
      || mmx[0] !== 0x8000000000000000n
      || trigSignExponent[0] !== 0x7fff
      || (x87Environment[1] & 0x28) !== 0x28) {
    throw new Error('typed FSCALE did not publish canonical overflow status');
  }
  resetTrigInput(0x4010000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 52n | (0x1fan << 16n))) {
    throw new Error('typed FSQRT rejected an exact square');
  }
  expectX87(0, 0x4000000000000000n, 'typed FSQRT exact result');
  resetTrigInput(0x4000000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 52n | (0x1fan << 16n))
      || mmx[0] !== 0xb504f333f9de6484n
      || trigSignExponent[0] !== 0x3fff
      || !(x87Environment[1] & 0x20)) {
    throw new Error('typed FSQRT did not round sqrt(2) to 64-bit precision');
  }
  resetTrigInput(0x4000000000000000n);
  x87Environment[0] = (x87Environment[0] & ~0xc00) | 0x800;
  if (!E.vm_x86_direct_x87(machine, 0n, 52n | (0x1fan << 16n))
      || mmx[0] !== 0xb504f333f9de6485n
      || trigSignExponent[0] !== 0x3fff) {
    throw new Error('typed FSQRT ignored the upward x87 rounding mode');
  }
  resetTrigInput(0xc010000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 52n | (0x1fan << 16n))
      || mmx[0] !== 0xc000000000000000n
      || trigSignExponent[0] !== 0xffff
      || (x87Environment[1] & 0x401) !== 0x401) {
    throw new Error('typed FSQRT did not publish the negative-domain cut');
  }
  if (!E.vm_x86_direct_x87(machine, 0n, 44n)) {
    throw new Error('typed x87 reset failed before denormal FSQRT');
  }
  mmx[0] = 1n;
  trigSignExponent[0] = 0;
  x87Environment[2] &= 0xfffc;
  if (!E.vm_x86_direct_x87(machine, 0n, 52n | (0x1fan << 16n))
      || mmx[0] !== 0xb504f333f9de6484n
      || trigSignExponent[0] !== 0x1fe0
      || (x87Environment[1] & 0x22) !== 0x22) {
    throw new Error('typed FSQRT did not normalize a positive denormal lane');
  }
  resetTrigInput(0x4016000000000000n);
  setScaleSource(0x4000000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 53n | (0x1f8n << 16n))) {
    throw new Error('typed FPREM rejected a complete quotient');
  }
  expectX87(0, 0x3ff8000000000000n, 'typed FPREM exact remainder');
  if ((x87Environment[1] & 0x4700) !== 0x4000) {
    throw new Error('typed FPREM did not publish quotient bits 010');
  }
  resetTrigInput(0x4016000000000000n);
  setScaleSource(0x4000000000000000n);
  if (!E.vm_x86_direct_x87(
    machine, 0n, 53n | (0x1f5n << 16n) | (1n << 44n),
  )) {
    throw new Error('typed FPREM1 rejected a nearest-even quotient');
  }
  expectX87(0, 0xbfe0000000000000n, 'typed FPREM1 exact remainder');
  if ((x87Environment[1] & 0x4700) !== 0x4200) {
    throw new Error('typed FPREM1 did not publish quotient bits 011');
  }
  resetTrigInput(0x4630000000000000n);
  setScaleSource(0x4008000000000000n);
  if (!E.vm_x86_direct_x87(machine, 0n, 53n | (0x1f8n << 16n))
      || (x87Environment[1] & 0x4700) !== 0x0400
      || trigSignExponent[0] >= 0x4063) {
    throw new Error('typed FPREM did not consume one bounded partial quotient');
  }
  resetTrigInput(0x4014000000000000n);
  xmm[0] = 0x1122334455667788n;
  xmm[1] = 0x99aabbccddeeff00n;
  const fxsaveAdmitted = E.vm_x86_direct_x87(
    machine, 0x5600n, 51n | (1n << 44n),
  );
  const fxHeader = BigInt.asUintN(64, load64(0x5600n, 0x7fff0290));
  const fxControl = fxHeader & 0xffffn;
  const fxTag = (fxHeader >> 32n) & 0xffn;
  const fxMxcsr = BigInt.asUintN(64, load64(0x5618n, 0x7fff0292));
  const fxSt0 = BigInt.asUintN(64, load64(0x5620n, 0x7fff0293));
  const fxXmm0 = BigInt.asUintN(64, load64(0x56a0n, 0x7fff0294));
  const fxXmm1 = BigInt.asUintN(64, load64(0x56a8n, 0x7fff0295));
  if (!fxsaveAdmitted || fxControl !== 0x037fn || (fxTag & 1n) !== 1n
      || fxMxcsr !== 0x0000ffff00001fabn || fxSt0 !== mmx[0]
      || fxXmm0 !== xmm[0] || fxXmm1 !== xmm[1]) {
    throw new Error(
      `typed FXSAVE64 state mismatch: admitted=${fxsaveAdmitted}`
      + ` header=0x${fxHeader.toString(16)}`
      + ` mxcsr=0x${fxMxcsr.toString(16)}`
      + ` st0=0x${fxSt0.toString(16)}`
      + ` xmm=0x${fxXmm1.toString(16)}:${fxXmm0.toString(16)}`,
    );
  }
  mmx[0] = 0n;
  trigSignExponent[0] = 0;
  x87Environment[0] = 0;
  x87Environment[2] = 0xffff;
  xmm[0] = 0n;
  xmm[1] = 0n;
  if (!E.vm_x86_direct_x87(
    machine, 0x5600n, 51n | (1n << 40n) | (1n << 44n),
  ) || mmx[0] !== 0xa000000000000000n
      || trigSignExponent[0] !== 0x4001
      || x87Environment[0] !== 0x037f
      || (x87Environment[2] & 3) === 3
      || xmm[0] !== 0x1122334455667788n
      || xmm[1] !== 0x99aabbccddeeff00n) {
    throw new Error('typed FXRSTOR64 did not restore x87, MXCSR, and XMM lanes');
  }
  x87Environment[1] = 0xffff;
  if (!E.vm_x86_direct_x87(machine, 0n, 47n)
      || x87Environment[1] !== 0x7f00) {
    throw new Error('typed FNCLEX did not preserve only TOP/condition state');
  }
  store64(0x52c0n, 0x80000000ffffffffn, 0x7fff024a);
  store64(0x52c8n, 4n, 0x7fff024b);
  if (!E.vm_x86_direct_x87(
    machine, 0x52c0n, 17n | (8n << 8n) | (0x76fn << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x52c8n, 17n | (8n << 8n) | (0x76fn << 16n)
      | (1n << 36n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 26n | (0x7d1n << 16n) | (1n << 32n),
  ) || mmx[0] !== 0x080000000fffffffn
      || !E.vm_x86_direct_x87(
        machine, 0x52c0n, 17n | (8n << 8n) | (0x76fn << 16n),
      ) || !E.vm_x86_direct_x87(
        machine, 0x52c8n, 26n | (8n << 8n) | (0x7f2n << 16n)
          | (1n << 40n),
      ) || mmx[0] !== 0x00000000fffffff0n) {
    throw new Error('typed PSRLD/PSLLD did not shift two physical dword lanes');
  }
  store64(0x52c0n, 0x8000000012345000n, 0x7fff0267);
  if (!E.vm_x86_direct_x87(
    machine, 0x52c0n, 17n | (8n << 8n) | (0x76fn << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 26n | (0x772n << 16n) | (4n << 32n)
      | (2n << 40n) | (1n << 44n),
  ) || mmx[0] !== 0x0008000000012345n) {
    throw new Error('typed immediate PSRLD normalized two MMX dword lanes');
  }
  store64(0x52c0n, 0x0000000200000001n, 0x7fff0268);
  if (!E.vm_x86_direct_x87(
    machine, 0x52c0n, 17n | (8n << 8n) | (0x76fn << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 26n | (0x772n << 16n) | (4n << 32n)
      | (3n << 40n) | (2n << 44n),
  ) || mmx[0] !== 0x0020000000100000n) {
    throw new Error('typed immediate PSLLD normalized two MMX dword lanes');
  }
  store64(0x52d0n, 0x0000000100000005n, 0x7fff0279);
  store64(0x52d8n, 0x0000000200000003n, 0x7fff027a);
  if (!E.vm_x86_direct_x87(
    machine, 0x52d0n, 17n | (8n << 8n) | (0x76fn << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x52d8n, 17n | (8n << 8n) | (0x76fn << 16n)
      | (1n << 36n),
  ) || !E.vm_x86_direct_x87(
    machine, 0n, 37n | (0x7fan << 16n) | (1n << 32n),
  ) || mmx[0] !== 0xffffffff00000002n) {
    throw new Error('typed PSUBD subtracted two physical dword lanes');
  }
  store64(0x52d0n, 0xff9c006480007fffn, 0x7fff027b);
  store64(0x52d8n, 0x7fff80000001ffffn, 0x7fff027c);
  if (!E.vm_x86_direct_x87(
    machine, 0x52d0n, 17n | (8n << 8n) | (0x76fn << 16n),
  ) || !E.vm_x86_direct_x87(
    machine, 0x52d8n, 37n | (8n << 8n) | (0x7e9n << 16n)
      | (1n << 44n),
  ) || mmx[0] !== 0x80007fff80007fffn) {
    throw new Error('typed PSUBSW saturated four signed word lanes');
  }
  store64(0x52e0n, 0x4444333322221111n, 0x7fff027f);
  if (!E.vm_x86_direct_x87(
    machine, 0x52e0n,
    38n | (8n << 8n) | (0x700n << 16n) | (2n << 36n)
      | (0x1bn << 48n),
  ) || mmx[2] !== 0x1111222233334444n) {
    throw new Error('typed PSHUFW projected four MMX word lanes directly');
  }
  mmx[0] = 0x8000000000000000n;
  mmx[1] = 4n;
  const psrlqAdmitted = E.vm_x86_direct_x87(
    machine, 0n, 39n | (1n << 32n),
  );
  const psrlqValue = mmx[0];
  const psllqAdmitted = E.vm_x86_direct_x87(
    machine, 0n, 39n | (3n << 40n) | (8n << 44n),
  );
  const psllqValue = mmx[0];
  if (!psrlqAdmitted || psrlqValue !== 0x0800000000000000n
      || !psllqAdmitted || psllqValue !== 0n) {
    throw new Error(
      'typed PSRLQ/PSLLQ normalized one physical qword lane '
        + `(admitted=${psrlqAdmitted}/${psllqAdmitted}, `
        + `value=${psrlqValue.toString(16)}/${psllqValue.toString(16)})`,
    );
  }
  store64(0x52f0n, 0x11223344deadbeefn, 0x7fff0280);
  if (!E.vm_x86_direct_x87(
    machine, 0x52f0n, 40n | (4n << 8n) | (3n << 36n),
  ) || mmx[3] !== 0xdeadbeefn) {
    throw new Error('typed MOVD loaded one zero-extended MMX lane');
  }
  store64(0x52f8n, 0x1122334455667788n, 0x7fff0281);
  if (!E.vm_x86_direct_x87(
    machine, 0x52f8n, 40n | (4n << 8n) | (3n << 32n)
      | (1n << 40n),
  ) || BigInt.asUintN(64, load64(0x52f8n, 0x7fff0282))
      !== 0x11223344deadbeefn) {
    throw new Error('typed MOVD stored exactly one physical dword');
  }
  mmx[0] = 0xffff000100020003n;
  mmx[1] = 0x0001000200030004n;
  if (!E.vm_x86_direct_x87(
    machine, 0n, 37n | (1n << 32n) | (3n << 40n) | (1n << 44n),
  ) || mmx[0] !== 0x0000000300050007n) {
    throw new Error('typed PADDW added four physical word lanes');
  }
  mmx[0] = 5n;
  mmx[1] = 3n;
  if (!E.vm_x86_direct_x87(
    machine, 0n, 37n | (1n << 32n) | (2n << 44n),
  ) || mmx[0] !== 2n || !E.vm_x86_direct_x87(machine, 0n, 41n)
      || x87Environment[2] !== 0xffff) {
    throw new Error('typed PSUBQ/EMMS did not close and retire MMX state');
  }
  const x87SignExponent = new Uint16Array(
    E.memory.buffer, E.vm_x86_x87_sign_exponent(session), 8,
  );
  const constantTop = (x87Environment[1] >> 11) & 7;
  const oneAt = (constantTop + 7) & 7;
  const piAt = (constantTop + 6) & 7;
  if (!E.vm_x86_direct_x87(machine, 0n, 42n)
      || !E.vm_x86_direct_x87(
        machine, 0n, 42n | (3n << 32n),
      ) || mmx[oneAt] !== 0x8000000000000000n
      || x87SignExponent[oneAt] !== 0x3fff
      || mmx[piAt] !== 0xc90fdaa22168c235n
      || x87SignExponent[piAt] !== 0x4000
      || !E.vm_x86_direct_x87(
        machine, 0n, 11n | (1n << 32n) | (3n << 36n) | (1n << 40n),
      ) || ((x87Environment[1] >> 11) & 7) !== constantTop
      || (x87Environment[1] & 0x4500) || x87Environment[2] !== 0xffff) {
    throw new Error('typed x87 constants/FUCOMPP did not push, compare and pop exact lanes');
  }
  if (!E.vm_x86_direct_x87(machine, 0n, 42n | (6n << 32n))
      || !E.vm_x86_direct_x87(
        machine, 0n, 56n | (0x1e5n << 16n),
      ) || (x87Environment[1] & 0x4700) !== 0x4000
      || !E.vm_x86_direct_x87(
        machine, 0n, 11n | (0x1e4n << 16n) | (1n << 44n),
      ) || (x87Environment[1] & 0x4500) !== 0x4000
      || !E.vm_x86_direct_x87(
        machine, 0n, 22n | (0x7c0n << 16n) | (1n << 40n),
      ) || ((x87Environment[1] >> 11) & 7) !== constantTop) {
    throw new Error('typed FXAM/FTST did not classify and compare physical zero');
  }
  if (!E.vm_x86_direct_x87(machine, 0n, 42n)
      || !E.vm_x86_direct_x87(machine, 0n, 42n | (3n << 32n))
      || !E.vm_x86_direct_x87(
        machine, 0n, 11n | (0x6d9n << 16n) | (1n << 32n)
          | (1n << 36n) | (1n << 40n),
      ) || ((x87Environment[1] >> 11) & 7) !== constantTop
      || (x87Environment[1] & 0x4500)) {
    throw new Error('typed FCOMPP did not compare and double-pop exact lanes');
  }
  if (!E.vm_x86_direct_x87(machine, 0n, 42n | (3n << 32n))
      || !E.vm_x86_direct_x87(
        machine, 0n, 57n | (0x1f4n << 16n),
      )) {
    throw new Error('typed FXTRACT rejected a finite x87 lane');
  }
  const extractedTop = (x87Environment[1] >> 11) & 7;
  if (extractedTop !== ((constantTop + 6) & 7)
      || mmx[extractedTop] !== 0xc90fdaa22168c235n
      || x87SignExponent[extractedTop] !== 0x3fff
      || mmx[(extractedTop + 1) & 7] !== 0x8000000000000000n
      || x87SignExponent[(extractedTop + 1) & 7] !== 0x3fff
      || !E.vm_x86_direct_x87(
        machine, 0n, 22n | (0x7c0n << 16n) | (1n << 40n),
      ) || !E.vm_x86_direct_x87(
        machine, 0n, 22n | (0x7c0n << 16n) | (1n << 40n),
      ) || ((x87Environment[1] >> 11) & 7) !== constantTop) {
    throw new Error('typed FXTRACT did not publish physical exponent/significand lanes');
  }
  x87Environment[1] |= 0x4700;
  if (!E.vm_x86_direct_x87(
    machine, 0n, 43n | (0x1f7n << 16n) | (1n << 32n),
  ) || ((x87Environment[1] >> 11) & 7) !== ((constantTop + 1) & 7)
      || (x87Environment[1] & 0x4700)
      || !E.vm_x86_direct_x87(
        machine, 0n, 43n | (0x1f6n << 16n),
      ) || ((x87Environment[1] >> 11) & 7) !== constantTop) {
    throw new Error('typed FINCSTP/FDECSTP did not rotate the physical TOP lane');
  }
  registers[1] = 0xa000n;
  registers[11] = 0x202n;
  if (!E.vm_x86_direct_system_transfer(machine, 1n, 0n)
      || E.vm_x86_rip(session) !== 0xa000n
      || system[7] !== 0x33n || system[8] !== 0x2bn
      || (E.vm_x86_rflags(session) & 0x202n) !== 0x202n) {
    throw new Error('typed SYSRETQ did not publish the user return cut');
  }
  system[7] = 0n;
  if (!E.vm_x86_direct_write_msr(machine, 0x174n, 0x20n)
      || !E.vm_x86_direct_write_msr(machine, 0x175n, 0x5800n)
      || !E.vm_x86_direct_write_msr(machine, 0x176n, 0xd000n)
      || !E.vm_x86_direct_system_transfer(machine, 2n, 0n)
      || E.vm_x86_rip(session) !== 0xd000n || registers[4] !== 0x5800n
      || system[7] !== 0x20n || system[8] !== 0x28n
      || (E.vm_x86_rflags(session) & ((1n << 9n) | (1n << 16n)
                                      | (1n << 17n)))) {
    throw new Error('typed SYSENTER did not publish its MSR privilege cut');
  }
  registers[1] = 0x5900n;
  registers[2] = 0xd100n;
  if (!E.vm_x86_direct_system_transfer(machine, 3n, 0n)
      || E.vm_x86_rip(session) !== 0xd100n || registers[4] !== 0x5900n
      || system[7] !== 0x33n || system[8] !== 0x3bn) {
    throw new Error('typed SYSEXIT did not publish its 32-bit user cut');
  }
  system[7] = 0n;
  registers[1] = 0x0000000100005900n;
  registers[2] = 0x000000010000d100n;
  if (!E.vm_x86_direct_system_transfer(machine, 4n, 0n)
      || E.vm_x86_rip(session) !== 0x000000010000d100n
      || registers[4] !== 0x0000000100005900n
      || system[7] !== 0x43n || system[8] !== 0x4bn) {
    throw new Error('typed REX.W SYSEXIT did not publish its 64-bit user cut');
  }
  system[7] = 0x8n;
  const statusBase = E.vm_x86_cr0(session) | 0xfn;
  if (!E.vm_x86_direct_write_control(machine, 0n, statusBase)
      || !E.vm_x86_direct_cr0_status(machine, 0n, 0n)
      || (E.vm_x86_cr0(session) & 0xfn) !== 1n) {
    throw new Error('typed LMSW register form did not preserve established PE');
  }
  store64(0x50f0n, 4n, 0x7fff0288);
  const lmswFunction = table.get(tableBase + 17);
  const lmswResult = lmswFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (lmswResult !== 4n || (E.vm_x86_cr0(session) & 0xfn) !== 5n
      || E.vm_x86_rip(session) !== 0x7a00n) {
    throw new Error('typed LMSW memory form did not use the precise MMU cut');
  }
  if (!E.vm_x86_direct_write_control(
    machine, 0n, E.vm_x86_cr0(session) | 8n,
  )) {
    throw new Error('CLTS fixture could not set CR0.TS');
  }
  const cltsFunction = table.get(tableBase + 18);
  const cltsResult = cltsFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (cltsResult !== 4n || (E.vm_x86_cr0(session) & 8n)
      || E.vm_x86_rip(session) !== 0x7b00n) {
    throw new Error('typed CLTS did not clear only CR0.TS');
  }
  system[11] = 0x18n;
  registers[4] = 0x5400n;
  const pushGsFunction = table.get(tableBase + 19);
  const pushGsResult = pushGsFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (pushGsResult !== 4n || registers[4] !== 0x53f8n
      || load64(0x53f8n, 0x7fff0290) !== 0x18n
      || E.vm_x86_rip(session) !== 0x7c00n
      || !E.vm_x86_direct_segment_stack(
        machine, 1n | (5n << 8n) | (64n << 16n), 0n,
      ) || registers[4] !== 0x5400n || system[11] !== 0x18n) {
    throw new Error('typed PUSH/POP GS did not publish one restartable stack cut');
  }
  if (requireCompleteness) {
    const failures = [];
    const machine = E.vm_x86_machine_state(session);
    const systemAt = E.vm_x86_system(session);
    if (!machine || !systemAt) {
      failures.push('canonical machine/system state is not observable');
    } else {
      const system = new BigUint64Array(E.memory.buffer, systemAt, 22);
      const sentinel = 0xa5a5a5a5a5a5a5a5n;
      system[7] = 0x8n;
      store64(0x5600n, 0x1112131415161718n, 0x7fff0274);
      store64(0x5608n, 0x2122232425262728n, 0x7fff0275);
      registers[1] = 2n;
      registers[6] = 0x5600n;
      registers[7] = 0x5ff8n;
      const moveAdmitted = E.vm_x86_direct_string(
        machine, 8n | (64n << 8n) | (3n << 16n), 0n,
      );
      const moveCut = E.vm_x86_direct_memory_result(machine);
      const copiedPrefix = BigInt.asUintN(
        64, load64(0x5ff8n, 0x7fff0276),
      );
      if (moveAdmitted || moveCut === 0n || registers[1] !== 1n
          || registers[6] !== 0x5608n || registers[7] !== 0x6000n
          || copiedPrefix !== 0x1112131415161718n) {
        failures.push(
          'REP MOVS did not retain the exact completed-prefix residual '
            + `(admitted=${moveAdmitted}, cut=${moveCut}, `
            + `rcx=${registers[1]}, rsi=${registers[6].toString(16)}, `
            + `rdi=${registers[7].toString(16)}, `
            + `prefix=${copiedPrefix.toString(16)})`,
        );
      }
      store64(0x5ff8n, sentinel, 0x7fff026d);
      const admitted = E.vm_x86_direct_descriptor_table(
        machine, 0x5fffn, 2n,
      );
      const crossPageCut = E.vm_x86_direct_memory_result(machine);
      const unchanged = BigInt.asUintN(
        64, load64(0x5ff8n, 0x7fff026e),
      );
      if (admitted || crossPageCut === 0n || unchanged !== sentinel) {
        failures.push(
          'cross-page descriptor store committed before its full MMU cut '
            + `(admitted=${admitted}, cut=${crossPageCut}, `
            + `value=${unchanged.toString(16)})`,
        );
      }
      const faultAddress = 0x10000n;
      system[0] = 0xfeedfacecafebeefn;
      E.vm_x86_direct_memory(
        machine, faultAddress, 0n, 0n, 0x10008n,
        145, 0x7fff0000, 0,
      );
      const fault = E.vm_x86_direct_memory_result(machine);
      if ((fault & 7n) !== 3n || fault >> 3n !== 14n) {
        failures.push(`unmapped direct load returned ${fault}, not #PF`);
      }
      if (system[0] !== faultAddress) {
        failures.push(
          `direct #PF left CR2=${system[0].toString(16)}, `
            + `expected ${faultAddress.toString(16)}`,
        );
      }
    }
    for (const observer of [
      'vm_x86_exception_pending',
      'vm_x86_exception_vector',
      'vm_x86_exception_has_error',
      'vm_x86_exception_error',
    ]) {
      if (typeof E[observer] !== 'function') {
        failures.push(`missing canonical exception observer ${observer}`);
      }
    }
    if (failures.length) {
      throw new Error(
        `direct MMU completeness: RED\n  ${failures.join('\n  ')}`,
      );
    }
    console.log('direct MMU completeness: green');
  }
  system[7] = 0x8n;
  registers[1] = 0n;
  const rdpmcFunction = table.get(tableBase + 16);
  const rdpmcResult = rdpmcFunction(
    machine, E.vm_x86_executable_context(session),
  );
  if (rdpmcResult !== 107n || !E.vm_x86_exception_pending(session)
      || E.vm_x86_exception_vector(session) !== 13) {
    throw new Error(
      'typed RDPMC did not close the fixed no-PMU CPU contract as #GP',
    );
  }
  console.log(
    'C root/index admission -> verified self-installing module -> vm.wasm: '
      + `ok (2 blocks, ${indexStarts} index starts -> ${indexNodes} `
      + `supplied nodes, ${indexCacheHits} resident hits; `
      + `${physicalLookupProbes} physical probes)`,
  );
} finally {
  E.vm_step_release(session);
}

// Exercise the browser product helper over the same opaque content store.
// The low-level pass above owns the negative corruption checks; this pass
// prevents the browser bridge from drifting into row parsing or export walks.
const { openDirectX86Machine } = await import(
  new URL('../../web/vm.js', import.meta.url)
);
const browserSource = {
  async read(digest, offset, length, total) {
    const object = objects.get(digest);
    if (!object || object.length !== total) {
      throw new Error(`browser store has no requested object ${digest}`);
    }
    return object.subarray(offset, offset + length);
  },
};
const browserMachine = await openDirectX86Machine({
  root, source: browserSource,
});
try {
  const result = await browserMachine.advance(8);
  const browserE = browserMachine.exports;
  const browserSession = browserMachine.session;
  const registers = new BigUint64Array(
    browserE.memory.buffer,
    browserE.vm_x86_registers(browserSession), 16,
  );
  if (!result.halted || registers[0] !== 3n
      || registers[5] !== 1n
      || registers[6] !== 0xffffffffffffffffn
      || registers[11] !== 0x80000000n
      || registers[12] !== 0x802n
      || registers[13] !== 0xffen
      || registers[14] !== 0x80000001n
      || browserE.vm_x86_rflags(browserSession) !== 0x246n
      || result.completedBlocks !== 2
      || result.hostBarriers.physicalRead !== 3) {
    throw new Error('browser opaque admission produced the wrong machine cut');
  }
  await browserMachine.flush();
  console.log(
    'browser direct machine -> C state/resource admission -> self-install: '
      + 'ok (no root, function, or physical-row semantics in JavaScript)',
  );
} finally {
  browserMachine.release();
}

/* The v4 root selects shared topology functions through exact instantiation
 * and parameter pages.  Every cold object must arrive before architectural
 * work, and static successors must not re-enter the RIP/page dispatcher. */
const residualMachine = await openDirectX86Machine({
  root: residualRoot, source: browserSource,
});
try {
  const result = await residualMachine.advance(8);
  const residualE = residualMachine.exports;
  const residualSession = residualMachine.session;
  const registers = new BigUint64Array(
    residualE.memory.buffer,
    residualE.vm_x86_registers(residualSession), 16,
  );
  if (!result.halted || result.completedBlocks !== 3
      || result.hostBarriers.residualRead !== 2
      || result.hostBarriers.instantiationRead !== 1
      || result.hostBarriers.parameterRead !== 1
      || result.hostBarriers.kernelRead !== 1
      || result.hostBarriers.entryMapRead !== 0
      || result.hostBarriers.physicalRead !== 0
      || registers[0] !== 7n
      || residualE.vm_x86_rip(residualSession) !== 0x3001n
      || residualE.vm_x86_retired(residualSession) !== 3n) {
    throw new Error(
      `residual runner produced the wrong canonical cut ${JSON.stringify({
        halted: result.halted,
        completed: result.completedBlocks,
        barriers: result.hostBarriers,
        rip: residualE.vm_x86_rip(residualSession).toString(),
        retired: residualE.vm_x86_retired(residualSession).toString(),
      })}`,
    );
  }
  console.log(
    'browser residual graph -> exact instantiation -> shared topology: '
      + 'ok (3 blocks, one parameter page, no static RIP redispatch)',
  );
} finally {
  residualMachine.release();
}
