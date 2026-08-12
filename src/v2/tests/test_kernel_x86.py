"""x86-64 basic blocks use the shared state-step and machine-event route."""

import gzip
import hashlib
import json
import os
import struct
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import patch

from kernel import browser
from kernel.machine import MachineEvent
from kernel.x86 import (BOOT_PARAMS_ADDRESS, COMMAND_LINE_ADDRESS,
                        CPUID_PSE, CPUID_RDRAND, CPUID_RDSEED,
                        CR0_PAGING, E820_TABLE_OFFSET, IA32_GS_BASE,
                        IA32_KERNEL_GS_BASE,
                        IA32_TIME_STAMP_COUNTER,
                        PRESENT, RFLAGS_CARRY, WRITABLE,
                        _ALTERNATIVE_BUG_ADDRESS,
                        _ALTERNATIVE_CAPABILITY_PROBE,
                        _ALTERNATIVE_DEBUG_TEST,
                        _ALTERNATIVE_ENTRY_CORE,
                        _ALTERNATIVE_NOP_ADDRESS,
                        _ALTERNATIVE_SCAN_PREFIX,
                        _AFFINE_PAGE_RECORD_CORE,
                        _BIT_SCAN_FIRST_BODY,
                        _BIT_SCAN_FIRST_DIRECT_BODY,
                        _BIT_SCAN_FIRST_DIRECT_HEAD,
                        _BIT_SCAN_NEXT_BODY,
                        _BIT_SCAN_NEXT_DIRECT,
                        _BIT_SCAN_NEXT_RESULT,
                        _BOUNDED_STRING_COMPARE_BODY,
                        _BOUNDED_STRING_COMPARE_DIRECT,
                        _ENTRY_NOP_PREFIX,
                        _RELATIVE_RECORD_PROJECTION_CORE,
                        _RELATIVE_RECORD_PROJECTION_FORWARD_CORE,
                        _RANDOM_U32_CACHE_ENTRY,
                        _RANDOM_U32_CACHE_CORE,
                        _RANDOM_U32_CACHE_READY,
                        _RANDOM_U32_BELOW_CORE,
                        _RANDOM_PERMUTATION_LOOP,
                        _RANGE_TABLE_QUERY_PREFIX,
                        _RANGE_TABLE_QUERY_SUFFIX,
                        _RANGE_TABLE_QUERY_TYPED,
                        _RANGE_COMPACT_COUNT,
                        _RANGE_COMPACT_CORE,
                        _RANGE_COMPACT_DIRECT,
                        _RANGE_COMPACT_ENTRY,
                        _RANGE_COMPARE_BODY,
                        _RANGE_COMPARE_DIRECT,
                        _LENGTH_PREFIX_SKIP_LOOP,
                        _SMP_LOCK_LOOP_CORE,
                        _SYMBOL_POSITION_ENTRY,
                        _SYMBOL_POSITION_SEARCH,
                        _TOKEN_EXPANSION_CORE,
                        _TOKEN_STREAM_ENTRY,
                        _RETURN_ENTRY_CORE, _RETURN_FEATURE_JUMP,
                        _RETURN_SCAN_LOOP, _RETURN_SCAN_PREFIX,
                        _RETURN_TARGET_COMPARE,
                        _STATIC_CALL_NOP5,
                        _STATIC_CALL_WRAPPER_ARGUMENTS,
                        _STATIC_CALL_WRAPPER_SITE,
                        _STATIC_CALL_WRAPPER_TYPE,
                        _STATIC_CALL_ZERO5,
                        _SORT_WRAPPER_CORE,
                        _VOID_COPY_ARGUMENTS,
                        _VOID_COPY_BYTE_LOOP,
                        _VOID_COPY_REP,
                        MASK32, MASK64, X86DBT, X86Error, X86Machine,
                        _result_flags,
                        advance_virtual_clock,
                        initial_state,
                        load_bzimage, load_bzimage_kernel, parse_bzimage,
                        load_virtual, read_virtual, translate, write_virtual)
from qm.laneops import evaluate as evaluate_lane
from qm.memorycut import MemoryCut
from qm.steppage import (compile_mapped_executor,
                         unpack as unpack_step)
from qm.wasmstate import PagedMemory


class OracleX86DBT(X86DBT):
    """Keep retired function recognizers available only as test oracles."""

    def __init__(self, *arguments, **options):
        options.setdefault('enable_function_oracles', True)
        super().__init__(*arguments, **options)


X86DBT = OracleX86DBT


def memory_with(*writes):
    memory = PagedMemory(b'', 65536)
    for address, payload in writes:
        memory = memory.write(address, payload)
    return memory


def synthetic_bzimage():
    setup_sectors = 4
    payload_offset = (setup_sectors + 1) * 512
    payload = b'K' * 4096
    image = bytearray(payload_offset + len(payload))
    image[0x1f1] = setup_sectors
    struct.pack_into('<H', image, 0x1fe, 0xaa55)
    image[0x200:0x202] = b'\xeb\x66'
    image[0x202:0x206] = b'HdrS'
    struct.pack_into('<H', image, 0x206, 0x20f)
    image[0x211] = 1
    struct.pack_into('<I', image, 0x214, 0x100000)
    struct.pack_into('<I', image, 0x22c, 0x0fffffff)
    struct.pack_into('<I', image, 0x230, 0x200000)
    image[0x234] = 1
    struct.pack_into('<H', image, 0x236, 1)
    struct.pack_into('<I', image, 0x238, 2048)
    struct.pack_into('<Q', image, 0x258, 0x200000)
    struct.pack_into('<I', image, 0x260, 0x400000)
    image[payload_offset:] = payload
    return bytes(image)


def synthetic_kernel_bzimage():
    elf = bytearray(0x104)
    elf[:16] = b'\x7fELF\x02\x01\x01' + bytes(9)
    struct.pack_into(
        '<HHIQQQIHHHHHH', elf, 16,
        2, 62, 1, 0x200000, 64, 0, 0, 64, 56, 1, 0, 0, 0)
    struct.pack_into(
        '<IIQQQQQQ', elf, 64,
        1, 5, 0x100, 0xffffffff81000000, 0x200000,
        4, 4, 0x100)
    elf[0x100:0x104] = b'qm\xf4\0'
    compressed = gzip.compress(bytes(elf), mtime=0)
    setup_bytes = 5 * 512
    image = bytearray(synthetic_bzimage()[:setup_bytes])
    struct.pack_into('<I', image, 0x248, 0)
    struct.pack_into('<I', image, 0x24c, len(compressed))
    image.extend(compressed)
    return bytes(image)


class TestX86StateStep(unittest.TestCase):
    def test_x86_flags_lane_matches_the_architectural_reference(self):
        operations = (
            ('and', 0, False), ('or', 0, False), ('xor', 0, False),
            ('add', 1, False), ('adc', 2, False),
            ('sub', 3, False), ('cmp', 3, False), ('sbb', 4, False),
            ('add', 1, True), ('sub', 3, True),
        )
        for bits in (8, 16, 32, 64):
            mask = (1 << bits) - 1
            values = (0, 1, mask >> 1, 1 << (bits - 1), mask - 1, mask)
            for prior in (0, 1, 0x8d5, 0x123456789abcdef1):
                for name, mode, preserve_carry in operations:
                    carry_in = int(bool(prior & 1)) \
                        if name in ('adc', 'sbb') else 0
                    descriptor = (bits | (mode << 8)
                                  | (int(preserve_carry) << 11))
                    for left in values:
                        for right in values:
                            result = {
                                'and': left & right,
                                'or': left | right,
                                'xor': left ^ right,
                                'add': left + right + carry_in,
                                'adc': left + right + carry_in,
                                'sub': left - right - carry_in,
                                'cmp': left - right,
                                'sbb': left - right - carry_in,
                            }[name] & mask
                            expected = _result_flags(
                                prior, name, left, right, result, bits,
                                preserve_carry=preserve_carry,
                                carry_in=carry_in)
                            actual = evaluate_lane(
                                'lane64.X86_FLAGS',
                                (prior, left, right, result, descriptor))
                            self.assertEqual(
                                actual, expected,
                                (bits, prior, name, preserve_carry,
                                 left, right, result))

    def test_browser_vm_registers_each_x86_step_page_once(self):
        installed = []
        executed = []
        js = ModuleType('js')

        def install(page):
            installed.append(page)
            return 7

        def execute(token, values, _read_page, _write_page):
            executed.append((int(token), values))
            return values

        js.installX86StateStep = install
        js.executeX86StateStep = execute
        with patch.dict(sys.modules, {'js': js}):
            step = browser._wasm_x86_step_executor(b'STEP')
            first, stack = step((1, MASK64), (), object())
            second, _stack = step((2, 3), (), object())

        self.assertEqual(len(installed), 1)
        self.assertEqual([token for token, _values in executed], [7, 7])
        self.assertEqual(first, (1, MASK64))
        self.assertEqual(second, (2, 3))
        self.assertEqual(stack, ())

    def test_decoded_pure_slice_can_use_the_external_vm_executor(self):
        created = []
        executed = []

        def factory(packed):
            created.append(bytes(packed))
            reference = compile_mapped_executor(unpack_step(packed))

            def execute(inputs, stack, memory):
                executed.append((tuple(inputs), tuple(stack)))
                return reference(inputs, stack, memory)

            return execute

        # add rax,rbx; hlt. Arithmetic belongs to the packed STEP page; hlt
        # remains the following machine barrier.
        memory = memory_with((0x100, bytes.fromhex('48 01 d8 f4')))
        state = initial_state(memory, 0x100, {'rax': 7, 'rbx': 11})

        state, boundary, _cost = X86DBT(
            step_executor_factory=factory).run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 18)
        self.assertTrue(created)
        self.assertTrue(executed)

    def test_runtime_mode_cannot_fall_back_to_the_python_executor(self):
        with self.assertRaisesRegex(
                X86Error, 'resident state-page executor'):
            X86DBT(allow_reference_executor=False)

        created = []

        def factory(packed):
            created.append(bytes(packed))
            return compile_mapped_executor(unpack_step(packed))

        memory = memory_with((0x100, bytes.fromhex('48 01 d8 f4')))
        dbt = X86DBT(
            step_executor_factory=factory,
            allow_reference_executor=False)
        state, boundary, _cost = dbt.run(
            initial_state(memory, 0x100, {'rax': 7, 'rbx': 11}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 18)
        self.assertTrue(created)
        self.assertEqual(dbt.layout()['reference_state_pages'], 0)
        self.assertGreater(dbt.layout()['resident_state_pages'], 0)

    def test_cpuid_advertises_the_large_pages_the_walker_executes(self):
        # mov eax,1; cpuid; hlt
        memory = memory_with((0x100, bytes.fromhex(
            'b8 01 00 00 00 0f a2 f4')))
        state = initial_state(memory, 0x100)

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertTrue(state.register('rdx') & CPUID_PSE)
        self.assertTrue(state.register('rcx') & CPUID_RDRAND)

    def test_cpuid_advertises_the_entropy_event_route(self):
        # mov eax,7; xor ecx,ecx; cpuid; hlt
        memory = memory_with((0x100, bytes.fromhex(
            'b8 07 00 00 00 31 c9 0f a2 f4')))

        state, boundary, _cost = X86DBT().run(
            initial_state(memory, 0x100))

        self.assertEqual(boundary.operation, 'halt')
        self.assertTrue(state.register('rbx') & CPUID_RDSEED)

    def test_rex_accumulator_immediate_keeps_the_64_bit_coordinate(self):
        # mov rax,0xffff888000100000; sub rax,-0x80000000; hlt
        code = bytes.fromhex(
            '48 b8 00 00 10 00 80 88 ff ff '
            '48 2d 00 00 00 80 f4')
        state = initial_state(memory_with((0x100, code)), 0x100)

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0xffff888080100000)

    def test_cdq_sign_extends_eax_into_edx(self):
        # mov eax,-2; cdq; hlt
        code = bytes.fromhex('b8 fe ff ff ff 99 f4')
        state = initial_state(memory_with((0x100, code)), 0x100,
                              {'rdx': MASK64})

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rdx'), MASK32)

    def test_leave_restores_the_64_bit_frame_and_stack(self):
        memory = memory_with(
            (0x100, bytes.fromhex('c9 f4')),
            (0x400, struct.pack('<Q', 0x123456789abcdef0)))
        state = initial_state(
            memory, 0x100, {'rbp': 0x400, 'rsp': 0x800})

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rbp'), 0x123456789abcdef0)
        self.assertEqual(state.register('rsp'), 0x408)

    def test_bzimage_enters_the_direct_64_bit_boot_protocol(self):
        image = synthetic_bzimage()
        header = parse_bzimage(image)
        boot = load_bzimage(image, memory_bytes=16 << 20,
                            command_line='console=ttyS0 nokaslr')
        state = boot.state

        self.assertEqual(header.payload_offset, 5 * 512)
        self.assertEqual(boot.load_address, 0x200000)
        self.assertEqual(state.rip, 0x200200)
        self.assertEqual(state.register('rsi'), BOOT_PARAMS_ADDRESS)
        self.assertEqual(translate(state, state.rip), state.rip)
        self.assertEqual(read_virtual(state, 0x200000, 4), b'KKKK')
        self.assertEqual(state.memory.read(COMMAND_LINE_ADDRESS, 22),
                         b'console=ttyS0 nokaslr\0')
        self.assertEqual(state.memory.read(BOOT_PARAMS_ADDRESS + 0x210, 1),
                         b'\xff')
        self.assertEqual(state.memory.read(BOOT_PARAMS_ADDRESS + 0x228, 4),
                         struct.pack('<I', COMMAND_LINE_ADDRESS))
        self.assertEqual(state.memory.read(BOOT_PARAMS_ADDRESS + 0x1e8, 1),
                         b'\x03')
        first_e820 = state.memory.read(
            BOOT_PARAMS_ADDRESS + E820_TABLE_OFFSET, 20)
        self.assertEqual(struct.unpack('<QQI', first_e820),
                         (0, 0x9f000, 1))

    def test_bzimage_rejects_a_missing_setup_signature(self):
        image = bytearray(synthetic_bzimage())
        image[0x202:0x206] = b'nope'
        with self.assertRaises(X86Error):
            parse_bzimage(image)

    def test_bzimage_places_an_optional_initramfs_below_its_ceiling(self):
        boot = load_bzimage(
            synthetic_bzimage(), memory_bytes=16 << 20,
            command_line='rdinit=/init console=ttyS0',
            initrd=b'070701' + b'R' * 4090)

        self.assertEqual(boot.initrd_bytes, 4096)
        self.assertEqual(boot.initrd_address % 4096, 0)
        self.assertEqual(boot.state.memory.read(boot.initrd_address, 6),
                         b'070701')
        params = boot.state.memory
        self.assertEqual(
            params.read(BOOT_PARAMS_ADDRESS + 0x218, 4),
            struct.pack('<I', boot.initrd_address))
        self.assertEqual(
            params.read(BOOT_PARAMS_ADDRESS + 0x21c, 4),
                         struct.pack('<I', 4096))

    def test_bzimage_normalizes_elf_segments_before_kernel_entry(self):
        boot = load_bzimage_kernel(
            synthetic_kernel_bzimage(), memory_bytes=16 << 20)

        self.assertEqual(boot.state.rip, 0x200000)
        self.assertEqual(boot.state.memory.read(0x200000, 4), b'qm\xf4\0')
        self.assertEqual(boot.state.register('rsi'), BOOT_PARAMS_ADDRESS)

    def test_kernel_elf_uses_virtual_not_physical_alignment_congruence(self):
        image = bytearray(synthetic_kernel_bzimage())
        setup_bytes = 5 * 512
        payload_bytes = struct.unpack_from('<I', image, 0x24c)[0]
        elf = bytearray(gzip.decompress(
            image[setup_bytes:setup_bytes + payload_bytes]))
        # p_offset and p_vaddr stay congruent modulo 0x100. p_paddr is a
        # separate physical load coordinate and may have another residue.
        struct.pack_into('<Q', elf, 64 + 24, 0x200080)
        struct.pack_into('<Q', elf, 24, 0x200080)
        compressed = gzip.compress(bytes(elf), mtime=0)
        del image[setup_bytes:]
        image.extend(compressed)
        struct.pack_into('<I', image, 0x24c, len(compressed))

        boot = load_bzimage_kernel(bytes(image), memory_bytes=16 << 20)

        self.assertEqual(boot.state.rip, 0x200000)
        self.assertEqual(boot.state.memory.read(0x200000, 4), b'qm\xf4\0')

    def test_browser_x86_boot_accepts_an_initramfs_artifact(self):
        with tempfile.NamedTemporaryFile(dir='.', delete=False) as initrd:
            initrd.write(b'070701' + b'I' * 250)
            initrd_path = initrd.name
        try:
            handle = browser.boot_x86_bytes(
                synthetic_kernel_bzimage(), {
                    'memory_bytes': 16 << 20,
                    'initrd_path': initrd_path,
                })
            try:
                memory = browser._SESSIONS[handle].state.cpu.memory
                self.assertEqual(
                    memory.read(BOOT_PARAMS_ADDRESS + 0x21c, 4),
                    struct.pack('<I', 256))
            finally:
                browser.release(handle)
        finally:
            os.unlink(initrd_path)

    def test_browser_x86_requires_the_wasm_sponge_cut_under_emscripten(self):
        js = ModuleType('js')
        js.mixSpongeRecords = lambda *_arguments: None
        js.installX86StateStep = lambda _page: 1
        js.executeX86StateStep = lambda _token, values: values
        with patch.object(browser.sys, 'platform', 'emscripten'), \
                patch.dict(sys.modules, {'js': js}):
            handle = browser.boot_x86_bytes(
                synthetic_kernel_bzimage(), {'memory_bytes': 16 << 20})
        try:
            self.assertIs(
                browser._SESSIONS[handle].runtime.dbt.sponge_records,
                browser._wasm_sponge_records)
            self.assertIs(
                browser._SESSIONS[handle].runtime.dbt.step_executor_factory,
                browser._wasm_x86_step_executor)
            self.assertFalse(
                browser._SESSIONS[handle].runtime.dbt
                .allow_reference_executor)
        finally:
            browser.release(handle)

        missing = ModuleType('js')
        with patch.object(browser.sys, 'platform', 'emscripten'), \
                patch.dict(sys.modules, {'js': missing}):
            with self.assertRaisesRegex(RuntimeError, 'vm.wasm state kernels'):
                browser.boot_x86_bytes(
                    synthetic_kernel_bzimage(), {'memory_bytes': 16 << 20})

    def test_browser_console_input_stays_in_the_x86_worker_state(self):
        handle = browser.boot_x86_bytes(
            synthetic_kernel_bzimage(), {'memory_bytes': 16 << 20})
        try:
            result = browser.console_input(handle, data='ls\n')
            self.assertEqual(
                json.loads(result)['state']['console_input_bytes'], 3)
        finally:
            browser.release(handle)

    def test_browser_x86_clock_stays_inside_one_replayable_machine_step(self):
        # rdtsc; hlt -- the worker must not make one JS round trip per clock.
        runtime = X86Machine()
        session = browser.X86BrowserSession(
            runtime,
            runtime.start(initial_state(
                memory_with((0x100, bytes.fromhex('0f 31 f4'))), 0x100)),
            clock_step=7,
            clock_variation_bits=0)

        boundary = session.step()

        self.assertIsNone(boundary)
        self.assertTrue(session.state.stopped)
        self.assertEqual(session.state.cpu.register('rax'), 7)
        self.assertEqual(
            dict(session.state.cpu.msrs)[IA32_TIME_STAMP_COUNTER], 7)
        self.assertEqual(runtime.affine_clock_events, 1)

    def test_register_block_is_qm_normalized_before_return(self):
        # mov rax,rdi; add rax,1; ret
        code = bytes.fromhex('48 89 f8 48 83 c0 01 c3')
        memory = memory_with(
            (0x100, code),
            (0x800, struct.pack('<Q', 0x200)),
            (0x200, b'\xf4'))
        state = initial_state(
            memory, 0x100, {'rdi': 41, 'rsp': 0x800})
        dbt = X86DBT(enable_function_oracles=False)

        state, boundary, cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertTrue(state.halted)
        self.assertEqual(state.register('rax'), 42)
        self.assertEqual(state.register('rsp'), 0x808)
        first = dbt.blocks[0x100]
        self.assertEqual((first.instructions, first.plan.waves.work,
                          first.plan.waves.span), (2, 1, 1))
        self.assertEqual(dbt.layout()['register_cuts'], 1)
        self.assertTrue(dbt._register_cuts[0x100][1].virtual_memory)
        self.assertEqual(
            dbt._register_cuts[0x100][1].boundary.operation,
            'dynamic_branch')
        self.assertGreater(cost.barriers, 0)

    def test_call_and_return_share_the_general_stack_memory_grammar(self):
        caller = bytes.fromhex('e8 fb 00 00 00 f4')
        callee = bytes.fromhex('b8 2a 00 00 00 c3')
        dbt = X86DBT(enable_function_oracles=False)
        state = initial_state(
            memory_with((0x100, caller), (0x200, callee),
                        (0x800, bytes(8))),
            0x100, {'rsp': 0x808})

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)
        self.assertEqual(state.register('rsp'), 0x808)
        self.assertEqual(read_virtual(state, 0x800, 8),
                         struct.pack('<Q', 0x105))
        self.assertEqual(dbt.layout()['stack_cuts'], 2)
        self.assertEqual(
            {block.boundary.operation
             for _source, block in dbt._stack_cuts.values()},
            {'branch', 'dynamic_branch'})
        self.assertTrue(all(
            block.virtual_memory
            for _source, block in dbt._stack_cuts.values()))

    def test_straight_memory_function_is_one_normalized_state_page(self):
        body = bytes.fromhex(
            'f30f1efa 0f1f440000 55 4889e5 4889f8 4829f0 '
            '8b0e 29c1 8b17 01c2 890f 8b4e04 29c1 '
            '448b4704 4101c0 894f04 488b4e08 4829c1 '
            '48034708 48894f08 8916 44894604 48894608 5d e9')
        body += struct.pack('<i', 0x300 - (0x100 + len(body) + 4))

        def start(left=0x400, right=0x500):
            return initial_state(memory_with(
                (0x100, body), (0x300, b'\xc3'),
                (0x400, bytes(range(16))),
                (0x500, bytes(range(16, 32))),
                (0x700, b'\xf4'),
                (0x800, struct.pack('<Q', 0x700))),
                0x100, {'rdi': left, 'rsi': right,
                        'rsp': 0x800, 'rbp': 0x123})

        optimized = X86DBT(enable_function_oracles=False)
        for left, right in ((0x400, 0x500), (0x400, 0x404),
                            (0x404, 0x400), (0x400, 0x400),
                            (0x7f8, 0x400), (0x400, 0x7f8)):
            fast_start = start(left, right)
            slow_start = fast_start
            fast, fast_boundary, _cost = optimized.run(fast_start)
            scalar = X86DBT(enable_function_oracles=False)
            scalar._compose_register_cut = lambda _state, block: block
            slow, slow_boundary, _cost = scalar.run(slow_start)

            self.assertEqual(fast_boundary.operation, slow_boundary.operation)
            self.assertEqual(repr(fast_boundary.detail),
                             repr(slow_boundary.detail))
            self.assertEqual(fast.registers, slow.registers)
            self.assertEqual(fast.rflags, slow.rflags)
            self.assertEqual(read_virtual(fast, 0x3f0, 0x130),
                             read_virtual(slow, 0x3f0, 0x130))
        cut = optimized._register_cuts[0x100][1]
        self.assertEqual((cut.plan.waves.work, cut.plan.waves.span),
                         (9, 4))
        self.assertEqual(cut.boundary.operation, 'dynamic_branch')
        self.assertEqual(
            sum(node.op == 'lane64.X86_FLAGS'
                for node in cut.plan.nodes), 0)
        self.assertEqual(
            sum(node.op == 'memory.i64.relative_exchange'
                for node in cut.plan.nodes), 1)
        self.assertFalse(any(node.op == 'memory.i64.store'
                             for node in cut.plan.nodes))

    def test_relative_key_compare_loads_each_absolute_address_once(self):
        body = bytes.fromhex(
            'f30f1efa 0f1f440000 55 4889e5 '
            '488b4708 4883e0fc 488d0c38 4883c108 '
            '488b4608 4883e0fc 488d1430 4883c208 '
            'b8ffffffff 4839d1 7223 b801000000 771c '
            '48630f 4801f9 486316 4801f2 '
            'b8ffffffff 4839d1 7206 0f97c0 0fb6c0 5d e9')
        body += struct.pack('<i', 0x300 - (0x100 + len(body) + 4))

        def start(left_relative, right_relative,
                  left_delta, right_delta,
                  left_address=0x400, right_address=0x500):
            return initial_state(memory_with(
                (0x100, body), (0x300, b'\xc3'),
                (left_address, struct.pack(
                    '<i4xQ', left_delta, left_relative)),
                (right_address, struct.pack(
                    '<i4xQ', right_delta, right_relative)),
                (0x700, b'\xf4'),
                (0x800, struct.pack('<Q', 0x700))),
                0x100, {'rdi': left_address, 'rsi': right_address,
                        'rsp': 0x800, 'rbp': 0x123})

        optimized = X86DBT(enable_function_oracles=False)
        cases = (
            (0, 0, 0, 0, 0x400, 0x500, MASK32),
            (0x200, 0, 0, 0, 0x400, 0x500, 1),
            (0x100, 0, 0, 0, 0x400, 0x500, MASK32),
            (0x100, 0, 0x100, 0, 0x400, 0x500, 0),
            (0x100, 0, 0x200, 0, 0x400, 0x500, 1),
            (0, 0, 0, 0, 0x7f0, 0x500, 1),
            (0, 0, 0, 0, 0x400, 0x7f0, MASK32),
        )
        for (left_relative, right_relative, left_delta, right_delta,
             left_address, right_address, expected) in cases:
            initial = start(left_relative, right_relative,
                            left_delta, right_delta,
                            left_address, right_address)
            fast, fast_boundary, _cost = optimized.run(initial)
            scalar = X86DBT(enable_function_oracles=False)
            scalar._compose_register_cut = lambda _state, block: block
            slow, slow_boundary, _cost = scalar.run(initial)

            self.assertEqual(fast_boundary, slow_boundary)
            self.assertEqual(fast.registers, slow.registers)
            self.assertEqual(fast.rflags, slow.rflags)
            self.assertEqual(fast.register('rax'), expected)

        first_compare = optimized._register_cuts[0x100][1]
        self.assertEqual((first_compare.plan.waves.work,
                          first_compare.plan.waves.span), (4, 3))
        self.assertEqual(sum(
            node.op == 'memory.i64.relative_address'
            for node in first_compare.plan.nodes), 2)
        self.assertEqual(sum(
            node.op == 'memory.i64.load'
            for node in first_compare.plan.nodes), 0)
        self.assertEqual(sum(
            node.op == 'memory.i64.pre_store'
            for node in first_compare.plan.nodes), 1)
        self.assertEqual(sum(
            node.op == 'lane64.X86_COMPARE'
            for node in first_compare.plan.nodes), 1)

    def test_signed_test_branch_uses_one_direct_predicate_lane(self):
        code = bytes.fromhex(
            '85c0 7f06 b801000000 f4 b802000000 f4')
        dbt = X86DBT(enable_function_oracles=False)

        for value, expected in (
                (0, 1), (1, 2), (0x7fffffff, 2),
                (0x80000000, 1), (0xffffffff, 1)):
            state, boundary, _cost = dbt.run(initial_state(
                memory_with((0x100, code)), 0x100, {'rax': value}))
            self.assertEqual(boundary.operation, 'halt')
            self.assertEqual(state.register('rax'), expected)

        predicate = dbt._predicate_cuts[0x100][1]
        self.assertEqual((predicate.plan.waves.work,
                          predicate.plan.waves.span), (4, 3))
        self.assertEqual(sum(node.op == 'lane32.GT_S'
                             for node in predicate.plan.nodes), 1)
        self.assertFalse(any(node.op in (
            'lane64.BIT', 'lane64.BITZ')
            for node in predicate.plan.nodes))

    def test_two_sentinel_byte_loop_is_one_persistent_find_cut(self):
        # load byte; stop at NUL or '%'; otherwise increment and repeat.
        code = bytes.fromhex(
            '0f b6 34 0f 85 f6 74 0a 83 fe 25 74 05 '
            '48 ff c1 eb ee f4')
        dbt = X86DBT(enable_function_oracles=False)

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, b'abc%tail\0')),
            0x100, {'rdi': 0x400}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rcx'), 3)
        self.assertEqual(state.register('rsi'), ord('%'))
        self.assertEqual(dbt.layout()['find_cuts'], 1)
        self.assertEqual((dbt.layout()['find_cut_work'],
                          dbt.layout()['find_cut_span']), (6, 4))
        cut = next(iter(dbt._find_cuts.values()))[1][1]
        self.assertTrue(cut.virtual_memory)
        self.assertIn('memory.i64.find2',
                      tuple(node.op for node in cut.plan.nodes))

    def test_bounded_nul_copy_is_one_five_op_physical_cut(self):
        # The loop copies source[index] while it is nonzero, but stops writes
        # at target_end and continues scanning to the exclusive index limit.
        code = bytes.fromhex(
            'eb08 49ffc1 4439ce 7430 4e8d040f 460fb61408 '
            '4584d2 741d 4939d0 73e5 458810 ebe0 '
            '4489ce eb06 4c01cf 4889f9 4889cf 4889c1 eb0e '
            '4489ce eb06 4c01cf 4989f8 4c89c7 e8fb1b0000')

        def initial(source, target_end, limit=8):
            return initial_state(memory_with(
                (0x100, code), (0x400, source), (0x500, bytes(16)),
                (0x800, bytes(8)), (0x1d45, b'\xf4')),
                0x100, {'rax': 0x400, 'rdi': 0x500,
                        'rdx': target_end, 'rsi': limit, 'rsp': 0x808})

        for source, target_end, limit, expected in (
                (b'abc\0tail', 0x508, 8, b'abc' + bytes(5)),
                (b'abcdefghZ', 0x503, 8, b'abc' + bytes(5)),
                (b'abc\0tail', 0x508, MASK32, b'abc' + bytes(5))):
            optimized = X86DBT(enable_function_oracles=False)
            fast, fast_boundary, _cost = optimized.run(
                initial(source, target_end, limit))
            scalar = X86DBT(enable_function_oracles=False)
            scalar._collapse_copy_until = lambda state, branch: state
            slow, slow_boundary, _cost = scalar.run(
                initial(source, target_end, limit))

            self.assertEqual(fast_boundary, slow_boundary)
            self.assertEqual(fast.registers, slow.registers)
            self.assertEqual(fast.rflags, slow.rflags)
            self.assertEqual(read_virtual(fast, 0x500, 8), expected)
            self.assertEqual(read_virtual(fast, 0x500, 8),
                             read_virtual(slow, 0x500, 8))
            self.assertEqual(optimized.layout()['copy_cuts'], 1)
            self.assertEqual((optimized.layout()['copy_cut_work'],
                              optimized.layout()['copy_cut_span']), (5, 4))
            cut = next(iter(optimized._copy_cuts.values()))[1][1]
            self.assertEqual([node.op for node in cut.plan.nodes], [
                'memory.i64.copy_until', 'lane64.BEXTR',
                'lane64.BEXTR', 'lane64.ADDR',
                'lane64.X86_FLAGS_SELECT'])

    def test_qm_register_result_updates_the_following_branch_flags(self):
        # xor eax,eax; jne bad; mov eax,42; hlt; bad: mov eax,99; hlt
        code = bytes.fromhex(
            '31 c0 75 06 b8 2a 00 00 00 f4 b8 63 00 00 00 f4')
        dbt = X86DBT(enable_function_oracles=False)

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)
        layout = dbt.layout()
        self.assertFalse(layout['function_oracles_enabled'])
        self.assertGreaterEqual(layout['frontend_raw_work'],
                                layout['physical_work'])
        self.assertIn(('conditional_branch', 1),
                      layout['frontend_boundaries'])

    def test_compare_branch_predicate_enters_the_shared_qm_cut(self):
        # The adjacent form becomes one PureSlice terminal predicate.  A NOP
        # between CMP and Jcc supplies the scalar-boundary reference without
        # changing architectural semantics.
        values = (
            (0, 0), (0, 1), (1, 0),
            (MASK64, 0), (0, MASK64),
            (1 << 63, 1), ((1 << 63) - 1, MASK64),
        )
        for condition in range(16):
            fused_code = (bytes.fromhex('48 39 d8')
                          + bytes((0x70 + condition, 6))
                          + bytes.fromhex(
                              'b9 2a 00 00 00 f4 b9 63 00 00 00 f4'))
            scalar_code = (bytes.fromhex('48 39 d8 90')
                           + bytes((0x70 + condition, 6))
                           + bytes.fromhex(
                               'b9 2a 00 00 00 f4 b9 63 00 00 00 f4'))
            for left, right in values:
                registers = {'rax': left, 'rbx': right}
                fused = X86DBT()
                fused_state, fused_boundary, _cost = fused.run(
                    initial_state(
                        memory_with((0x100, fused_code)), 0x100,
                        registers))
                scalar_state, scalar_boundary, _cost = X86DBT().run(
                    initial_state(
                        memory_with((0x100, scalar_code)), 0x100,
                        registers))

                self.assertEqual(fused_boundary.operation, 'halt')
                self.assertEqual(scalar_boundary.operation, 'halt')
                self.assertEqual(
                    fused_state.register('rcx'),
                    scalar_state.register('rcx'))
                self.assertEqual(fused_state.rflags, scalar_state.rflags)
                self.assertEqual(
                    fused.blocks[0x100].boundary.operation, 'compare')
                self.assertEqual(
                    fused._predicate_cuts[0x100][1].flag_cut, ('cmp', 64))
                self.assertEqual(fused.layout()['predicate_cuts'], 1)

    def test_memory_compare_is_one_external_coordinate_predicate_cut(self):
        # cmpq $2,(rdi); jne bad. The load remains an exact byte-coordinate
        # input while the comparison and branch enter the common QM plan.
        fused_code = bytes.fromhex(
            '48 83 3f 02 75 06 '
            'b9 2a 00 00 00 f4 b9 63 00 00 00 f4')
        scalar_code = bytes.fromhex(
            '48 83 3f 02 90 75 06 '
            'b9 2a 00 00 00 f4 b9 63 00 00 00 f4')
        for value in (0, 2, MASK64):
            data = struct.pack('<Q', value)
            fused = X86DBT()
            fused_state, fused_boundary, _cost = fused.run(initial_state(
                memory_with((0x100, fused_code), (0x400, data)),
                0x100, {'rdi': 0x400}))
            scalar_state, scalar_boundary, _cost = X86DBT().run(
                initial_state(
                    memory_with((0x100, scalar_code), (0x400, data)),
                    0x100, {'rdi': 0x400}))

            self.assertEqual(fused_boundary.operation, 'halt')
            self.assertEqual(scalar_boundary.operation, 'halt')
            self.assertEqual(
                fused_state.register('rcx'), scalar_state.register('rcx'))
            self.assertEqual(fused_state.rflags, scalar_state.rflags)
            composed = fused._predicate_cuts[0x100][1]
            self.assertEqual(composed.flag_cut, ('cmp', 64))
            self.assertEqual(len(composed.cut_inputs), 0)
            self.assertTrue(composed.virtual_memory)

    def test_memory_binary_result_and_branch_share_one_qm_cut(self):
        # andb (rdi),al; jne bad
        fused_code = bytes.fromhex(
            '22 07 75 06 '
            'b9 2a 00 00 00 f4 b9 63 00 00 00 f4')
        scalar_code = bytes.fromhex(
            '22 07 90 75 06 '
            'b9 2a 00 00 00 f4 b9 63 00 00 00 f4')
        for left, right in ((0, 0xff), (0xf0, 0x0f), (0xf3, 0x0f)):
            fused = X86DBT()
            fused_state, fused_boundary, _cost = fused.run(initial_state(
                memory_with((0x100, fused_code), (0x400, bytes((right,)))),
                0x100, {'rax': left, 'rdi': 0x400}))
            scalar_state, scalar_boundary, _cost = X86DBT().run(
                initial_state(
                    memory_with(
                        (0x100, scalar_code), (0x400, bytes((right,)))),
                    0x100, {'rax': left, 'rdi': 0x400}))

            self.assertEqual(fused_boundary.operation, 'halt')
            self.assertEqual(scalar_boundary.operation, 'halt')
            self.assertEqual(fused_state.registers, scalar_state.registers)
            self.assertEqual(fused_state.rflags, scalar_state.rflags)
            composed = fused._predicate_cuts[0x100][1]
            self.assertEqual(composed.flag_cut, ('and', 8))
            self.assertEqual(len(composed.cut_inputs), 0)
            self.assertTrue(composed.virtual_memory)

    def test_setcc_memory_chain_is_one_backward_residual_cut(self):
        # cmpq $2,(rdi); sete dl; andb (rsi),dl; jne bad
        fused_code = bytes.fromhex(
            '48 83 3f 02 0f 94 c2 22 16 75 06 '
            'b9 2a 00 00 00 f4 b9 63 00 00 00 f4')
        scalar_code = bytes.fromhex(
            '48 83 3f 02 90 0f 94 c2 22 16 90 75 06 '
            'b9 2a 00 00 00 f4 b9 63 00 00 00 f4')
        for compared, mask in ((2, 1), (2, 0), (3, 1)):
            writes = ((0x400, struct.pack('<Q', compared)),
                      (0x500, bytes((mask,))))
            registers = {'rdi': 0x400, 'rsi': 0x500,
                         'rdx': 0x123456789abcdeff}
            fused = X86DBT()
            fused_state, fused_boundary, _cost = fused.run(initial_state(
                memory_with((0x100, fused_code), *writes),
                0x100, registers))
            scalar_state, scalar_boundary, _cost = X86DBT().run(
                initial_state(
                    memory_with((0x100, scalar_code), *writes),
                    0x100, registers))

            self.assertEqual(fused_boundary.operation, 'halt')
            self.assertEqual(scalar_boundary.operation, 'halt')
            self.assertEqual(fused_state.registers, scalar_state.registers)
            self.assertEqual(fused_state.rflags, scalar_state.rflags)
            proof_blocks, composed = fused._predicate_cuts[0x100]
            self.assertEqual(len(proof_blocks), 4)
            self.assertEqual(composed.flag_cut, ('and', 8))
            self.assertEqual(len(composed.cut_inputs), 0)
            self.assertTrue(composed.virtual_memory)
            self.assertEqual(
                fused.blocks[0x100].boundary.operation, 'immediate_alu')

    def test_qm_flags_use_the_renamed_operand_inside_the_same_slice(self):
        # mov r8d,1; mov ecx,8; mov esi,r8d; sub esi,ecx; jbe good
        # bad: mov eax,99; hlt; good: mov eax,42; hlt
        code = bytes.fromhex(
            '41 b8 01 00 00 00 b9 08 00 00 00 44 89 c6 29 ce '
            '76 06 b8 63 00 00 00 f4 b8 2a 00 00 00 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100,
            {'rsi': 0x3d5eaa4}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)
        self.assertEqual(state.register('rsi'), 0xfffffff9)

    def test_proven_byte_fill_loop_collapses_to_one_memory_cut(self):
        # mov [rax+rdi],sil; mov [rax+rdi+1],sil; add rdi,2;
        # cmp rdx,rdi; jne loop; hlt
        code = bytes.fromhex(
            '40 88 34 38 40 88 74 38 01 48 83 c7 02 '
            '48 39 fa 75 ee f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100,
            {'rax': 0x400, 'rsi': 0xab, 'rdx': 256, 'rdi': 0}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.memory.read(0x400, 256), b'\xab' * 256)
        self.assertEqual(state.register('rdi'), 256)
        self.assertEqual(dbt.layout()['collapsed_fill_bytes'], 254)
        self.assertEqual(dbt.layout()['collapsed_fill_iterations'], 127)

    def test_invariant_word_store_loop_collapses_to_pattern_repeat(self):
        # mov [r10],dx; add r10,2; inc r12; cmp r14,r12; jne loop; hlt
        code = bytes.fromhex(
            '66 41 89 12 49 83 c2 02 49 ff c4 4d 39 e6 75 f0 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100,
            {'rdx': 0x4241, 'r10': 0x400, 'r12': 0, 'r14': 128}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.memory.read(0x400, 256), b'AB' * 128)
        self.assertEqual(state.register('r10'), 0x500)
        self.assertEqual(state.register('r12'), 128)
        self.assertEqual(dbt.layout()['collapsed_repeat_bytes'], 254)
        self.assertEqual(dbt.layout()['collapsed_repeat_iterations'], 127)

    def test_unrolled_byte_copy_loop_collapses_to_direct_copy(self):
        # Two byte load/store lanes; add r10,2; cmp r8d,r10d; jne loop.
        code = bytes.fromhex(
            '46 0f b6 1c 11 46 88 1c 12 '
            '46 0f b6 5c 11 01 46 88 5c 12 01 '
            '49 83 c2 02 45 39 d0 75 e3 f4')
        dbt = X86DBT()
        source = bytes(range(256))

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, source)), 0x100,
            {'rcx': 0x400, 'rdx': 0x800, 'r8': 256, 'r10': 0}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.memory.read(0x800, 256), source)
        self.assertEqual(state.register('r10'), 256)
        self.assertEqual(dbt.layout()['collapsed_copy_bytes'], 254)
        self.assertEqual(dbt.layout()['collapsed_copy_iterations'], 127)

    def test_multiword_copy_loop_joins_only_the_last_source_chunk(self):
        code = bytes.fromhex(
            '48 83 ea 20 4c 8b 06 4c 8b 4e 08 4c 8b 56 10 '
            '4c 8b 5e 18 48 8d 76 20 4c 89 07 4c 89 4f 08 '
            '4c 89 57 10 4c 89 5f 18 48 8d 7f 20 73 d4 f4')
        payload = bytes(range(64))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, payload),
                        (0x500, bytes(64))),
            0x100, {'rdx': 32, 'rsi': 0x400, 'rdi': 0x500}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x500, 64), payload)
        self.assertEqual(state.register('rsi'), 0x440)
        self.assertEqual(state.register('rdi'), 0x540)
        self.assertEqual(state.register('rdx'), MASK64 - 31)
        self.assertEqual(state.register('r8'),
                         int.from_bytes(payload[32:40], 'little'))
        self.assertEqual(state.register('r11'),
                         int.from_bytes(payload[56:64], 'little'))
        self.assertEqual(dbt.layout()['collapsed_copy_bytes'], 32)
        self.assertEqual(dbt.layout()['collapsed_copy_iterations'], 1)

    def test_forward_copy_overlap_becomes_a_direct_repeat(self):
        code = bytes.fromhex(
            '46 0f b6 1c 11 46 88 1c 12 '
            '46 0f b6 5c 11 01 46 88 5c 12 01 '
            '49 83 c2 02 45 39 d0 75 e3 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, b'AB')), 0x100,
            {'rcx': 0x400, 'rdx': 0x402, 'r8': 256, 'r10': 0}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.memory.read(0x402, 256), b'AB' * 128)
        self.assertEqual(dbt.layout()['collapsed_copy_bytes'], 254)

    def test_indexed_string_compare_loop_uses_direct_byte_chunks(self):
        code = bytes.fromhex(
            '31 c0 0f b6 0c 07 3a 0c 06 75 0a '
            '48 ff c0 84 c9 75 f0 31 c0 f4 '
            'b8 01 00 00 00 f4')
        dbt = X86DBT()
        memory = memory_with(
            (0x100, code),
            (0x400, b'abcdefghijklmnopqrstuvwxyz\0'),
            (0x500, b'abcdefghijklmnopqrstuvwxyz\0'))

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'rdi': 0x400, 'rsi': 0x500}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0)
        self.assertEqual(state.register('rcx'), 0)
        self.assertGreaterEqual(
            dbt.layout()['collapsed_compare_bytes'], 26)

    def test_indexed_string_compare_stops_on_the_first_mismatch(self):
        code = bytes.fromhex(
            '31 c0 0f b6 0c 07 3a 0c 06 75 0a '
            '48 ff c0 84 c9 75 f0 31 c0 f4 '
            'b8 01 00 00 00 f4')
        dbt = X86DBT()
        memory = memory_with(
            (0x100, code), (0x400, b'abcX\0'), (0x500, b'abcY\0'))

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'rdi': 0x400, 'rsi': 0x500}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 1)

    def test_string_compare_call_projects_the_first_differing_byte(self):
        target = 0x200
        function = bytes.fromhex(
            'f3 0f 1e fa 55 48 89 e5 31 c0 '
            '0f b6 0c 07 3a 0c 06 75 10 48 ff c0 '
            '84 c9 75 f0 31 c0 5d 2e e9 00 00 00 00 '
            '0f 93 c0 0f b6 c0 8d 04 45 ff ff ff ff 5d '
            '2e e9 00 00 00 00')
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (0x400, b'abcX\0'), (0x500, b'abcY\0')),
            0x100, {'rdi': 0x400, 'rsi': 0x500, 'rsp': 0x8000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), MASK32)
        self.assertEqual(state.register('rcx'), ord('X'))
        self.assertTrue(state.rflags & RFLAGS_CARRY)
        self.assertEqual(state.register('rsp'), 0x8000)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_compare_calls'], 1)
        self.assertEqual(layout['collapsed_compare_bytes'], 4)

    def test_patched_string_compare_entry_uses_the_same_direct_cut(self):
        target = 0x200
        function = bytes.fromhex(
            '0f 1f 40 d6 55 48 89 e5 31 c0 '
            '0f b6 0c 07 3a 0c 06 75 10 48 ff c0 '
            '84 c9 75 f0 31 c0 5d 2e e9 00 00 00 00 '
            '0f 93 c0 0f b6 c0 8d 04 45 ff ff ff ff 5d '
            '2e e9 00 00 00 00')
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (0x400, b'same\0'), (0x500, b'same\0')),
            0x100, {'rdi': 0x400, 'rsi': 0x500, 'rsp': 0x8000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0)
        self.assertEqual(dbt.layout()['collapsed_compare_calls'], 1)

    def test_patched_string_compare_returns_use_the_same_direct_cut(self):
        target = 0x200
        function = bytes.fromhex(
            'f3 0f 1e fa 55 48 89 e5 31 c0 '
            '0f b6 0c 07 3a 0c 06 75 10 48 ff c0 '
            '84 c9 75 f0 31 c0 5d c3 cc cc cc cc cc '
            '0f 93 c0 0f b6 c0 8d 04 45 ff ff ff ff 5d '
            'c3 cc cc cc cc cc')
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (0x400, b'abcX\0'), (0x500, b'abcY\0')),
            0x100, {'rdi': 0x400, 'rsi': 0x500, 'rsp': 0x8000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), MASK32)
        self.assertEqual(dbt.layout()['collapsed_compare_calls'], 1)

    def test_normalized_parameter_compare_uses_direct_byte_coordinates(self):
        target = 0x200
        function = bytearray(0x58)
        function[:4] = bytes.fromhex('f3 0f 1e fa')
        function[4:0x17] = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 41 56 53 '
            '48 89 f3 49 89 fe e8')
        function[0x1b:0x58] = bytes.fromhex(
            '48 83 f8 ff 74 35 31 d2 be 5f 00 00 00 '
            '41 0f b6 3c 16 40 80 ff 2d 0f 44 fe '
            '44 0f b6 04 13 41 80 f8 2d 44 0f 44 c6 '
            '44 38 c7 0f 94 c1 48 39 d0 74 0c 48 ff c2 '
            '44 38 c7 74 d4 eb 02 b1 01')
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (0x400, b'log-level\0'),
                        (0x500, b'log_level\0')),
            0x100, {'rdi': 0x400, 'rsi': 0x500, 'rsp': 0x8000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 1)
        self.assertEqual(state.register('rsp'), 0x8000)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_normalized_compare_calls'], 1)
        self.assertEqual(layout['collapsed_normalized_compare_bytes'], 10)
        self.assertEqual(layout['normalized_compare_cache_misses'], 1)

    def test_bounded_normalized_compare_stops_at_the_abi_count(self):
        target = 0x200
        function = bytearray(0x58)
        function[:4] = bytes.fromhex('f3 0f 1e fa')
        function[4:0x45] = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 48 85 d2 74 3a '
            '48 ff ca 31 c9 41 b8 5f 00 00 00 '
            '0f b6 04 0f 3c 2d 41 0f 44 c0 '
            '44 0f b6 0c 0e 41 80 f9 2d 45 0f 44 c8 '
            '44 38 c8 0f 94 c0 75 09 48 39 ca '
            '48 8d 49 01 75 d8')
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (0x400, b'a-bX'), (0x500, b'a_bY')),
            0x100, {'rdi': 0x400, 'rsi': 0x500,
                    'rdx': 3, 'rsp': 0x8000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 1)
        self.assertEqual(
            dbt.layout()['collapsed_normalized_compare_bytes'], 3)

    def test_normalized_string_field_search_builds_one_direct_directory(self):
        compare_target = 0x200
        compare_function = bytearray(0x58)
        compare_function[:4] = bytes.fromhex('f3 0f 1e fa')
        compare_function[4:0x17] = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 41 56 53 '
            '48 89 f3 49 89 fe e8')
        compare_function[0x1b:0x58] = bytes.fromhex(
            '48 83 f8 ff 74 35 31 d2 be 5f 00 00 00 '
            '41 0f b6 3c 16 40 80 ff 2d 0f 44 fe '
            '44 0f b6 04 13 41 80 f8 2d 44 0f 44 c6 '
            '44 38 c7 0f 94 c1 48 39 d0 74 0c 48 ff c2 '
            '44 38 c7 74 d4 eb 02 b1 01')
        loop = (bytes.fromhex('49 8b 34 24 48 89 df e8')
                + struct.pack('<i', compare_target - 0x10c)
                + bytes.fromhex(
                    '84 c0 75 46 49 83 c4 28 49 ff cf 75 e7'))
        records = bytearray(3 * 0x28)
        for index, address in enumerate((0x800, 0x820, 0x840)):
            struct.pack_into('<Q', records, index * 0x28, address)
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, loop), (0x119, b'\xf4'),
                        (0x156, b'\xf4'),
                        (compare_target, compare_function),
                        (0x500, records),
                        (0x700, b'trace-clock\0'),
                        (0x800, b'other\0'),
                        (0x820, b'trace_clock\0'),
                        (0x840, b'last\0')),
            0x100, {'r12': 0x500, 'r15': 3, 'rbx': 0x700,
                    'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('r12'), 0x528)
        self.assertEqual(state.register('r15'), 2)
        self.assertEqual(state.register('rax'), 1)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_normalized_field_entries'], 1)
        self.assertEqual(layout['normalized_field_directory_misses'], 1)

    def test_direct_u32_index_leaf_uses_the_table_coordinate(self):
        target = 0x200
        table = 0x800
        function = (bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 89 f8 '
            '8b 04 85') + struct.pack('<i', table)
            + bytes.fromhex('5d 2e e9 00 00 00 00'))
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        values = b''.join(struct.pack('<I', index * 17 + 3)
                          for index in range(256))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (table, values)),
            0x100, {'rdi': 201, 'rsp': 0x7000, 'rbp': 0x1234}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 201 * 17 + 3)
        self.assertEqual(state.register('rsp'), 0x7000)
        self.assertEqual(state.register('rbp'), 0x1234)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_direct_index_calls'], 1)
        self.assertEqual(layout['direct_index_cache_misses'], 1)

    def test_keccak_lane_permutation_uses_one_physical_state_cut(self):
        target = 0x200
        function = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 41 57 41 56 41 55 41 54 '
            '53 48 81 ec e8 00 00 00 48 8b 37 48 8b 4f 08')
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        expected = (
            0xf1258f7940e1dde7, 0x84d5ccf933c0478a,
            0xd598261ea65aa9ee, 0xbd1547306f80494d,
            0x8b284e056253d057, 0xff97a42d7f8e6fd4,
            0x90fee5a0a44647c4, 0x8c5bda0cd6192e76,
            0xad30a6f71b19059c, 0x30935ab7d08ffc64,
            0xeb5aa93f2317d635, 0xa9a6e6260d712103,
            0x81a57c16dbcf555f, 0x43b831cd0347c826,
            0x01f22f1a11a5569f, 0x05e5635a21d9ae61,
            0x64befef28cc970f2, 0x613670957bc46611,
            0xb87c5a554fd00ecb, 0x8c3ee88a1ccf32c8,
            0x940c7922ae3a2614, 0x1841f924a2c509e4,
            0x16f53526e70465c2, 0x75f644e97f30a13b,
            0xeaf1ff7b5ceca249,
        )
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (0x500, bytes(25 * 8))),
            0x100, {'rdi': 0x500, 'rsp': 0x9000, 'rbp': 0x1234}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(
            struct.unpack('<25Q', read_virtual(state, 0x500, 25 * 8)),
            expected)
        self.assertEqual(state.register('rsp'), 0x9000)
        self.assertEqual(state.register('rbp'), 0x1234)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_lane_permutation_calls'], 1)
        self.assertEqual(layout['collapsed_lane_permutation_lanes'], 25)

    def test_chacha_lane_waves_match_the_standard_twenty_round_block(self):
        initial = (
            0x61707865, 0x3320646e, 0x79622d32, 0x6b206574,
            0x03020100, 0x07060504, 0x0b0a0908, 0x0f0e0d0c,
            0x13121110, 0x17161514, 0x1b1a1918, 0x1f1e1d1c,
            0x00000001, 0x09000000, 0x4a000000, 0x00000000,
        )
        block = (
            0xe4e7f110, 0x15593bd1, 0x1fdd0f50, 0xc47120a3,
            0xc7f4d1c7, 0x0368c033, 0x9aaa2204, 0x4e6cd4c3,
            0x466482d2, 0x09aa9f07, 0x05d7c214, 0xa2028bd9,
            0xd19c12b5, 0xb94e16de, 0xe883d0cb, 0x4e3c50a2,
        )
        expected = tuple(
            (output - source) & MASK32
            for source, output in zip(initial, block))

        self.assertEqual(X86DBT._chacha_permute(initial, 20), expected)

    def test_interval_compare_call_uses_one_direct_state_cut(self):
        target, trace, return_thunk = 0x300, 0x500, 0x600
        body = bytes.fromhex(
            '55 48 8b 47 08 48 83 e0 fc 48 8d 54 07 08 '
            '48 8b 46 08 48 89 e5 48 83 e0 fc 48 8d 4c 06 08 '
            'b8 ff ff ff ff 48 39 ca 72 28 '
            'b8 01 00 00 00 48 39 d1 72 1e '
            '48 63 07 48 01 c7 48 63 06 48 01 c6 '
            'b8 ff ff ff ff 48 39 f7 72 08 '
            '31 c0 48 39 fe 0f 92 c0 5d e9')
        function = (bytes.fromhex('f3 0f 1e fa e8')
                    + struct.pack('<i', trace - (target + 9))
                    + body
                    + struct.pack('<i', return_thunk - (target + 0x5f)))
        self.assertEqual(len(function), 0x5f)
        tracing = (bytes.fromhex('f3 0f 1e fa') + b'\x90' * 10 + b'\xe9'
                   + struct.pack('<i', return_thunk - (trace + 19)))
        left = bytearray(16)
        right = bytearray(16)
        struct.pack_into('<i', left, 0, 0x200)
        struct.pack_into('<Q', left, 8, 0x10a)
        struct.pack_into('<i', right, 0, 0x100)
        struct.pack_into('<Q', right, 8, 0x00a)
        caller = (b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4')
        dbt = X86DBT()
        memory = memory_with(
            (0x100, caller), (target, function), (trace, tracing),
            (return_thunk, b'\xc3'), (0x800, left), (0x900, right))
        entry = initial_state(
            memory, 0x100,
            {'rdi': 0x800, 'rsi': 0x900, 'rsp': 0x1000})

        state, boundary, _cost = dbt.run(entry)

        class ScalarDBT(X86DBT):
            def _collapse_interval_compare_call(
                    self, state, following, target):
                return None

        scalar, scalar_boundary, _cost = ScalarDBT().run(entry)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(scalar_boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0)
        self.assertEqual(state.register('rax'), scalar.register('rax'))
        self.assertEqual(state.register('rsp'), 0x1000)
        self.assertEqual(state.register('rsp'), scalar.register('rsp'))
        self.assertEqual(dbt.layout()['collapsed_interval_compare_calls'], 1)

    def test_indirect_sponge_finalize_avoids_transient_block_state(self):
        target = 0x300
        entry = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 e4 f0 '
            '48 81 ec b0 00 00 00 48 89 cb 41 89 d6 '
            '48 89 34 24 49 89 ff')
        metadata = bytes.fromhex(
            '48 8b 07 48 8b 40 20 8b 48 f8 48 89 4c 24 08 '
            '44 8b 60 24 48 8d 7c 24 10 ba 90 00 00 00 31 f6')
        function = bytearray(0x3e + len(metadata))
        function[:len(entry)] = entry
        function[0x3e:] = metadata
        descriptor = bytearray(8 + 25 * 8)
        struct.pack_into('<Q', descriptor, 0, 0x700)
        transform = bytearray(0x28)
        struct.pack_into('<Q', transform, 0x20, 0x900)
        algorithm = bytearray(0x40)
        struct.pack_into('<I', algorithm, 0x08, 32)
        struct.pack_into('<I', algorithm, 0x34, 136)
        caller = bytes.fromhex('ff 15 fa 00 00 00 f4')
        expected = bytes.fromhex(
            '3a985da74fe225b2045c172d6bd390bd'
            '855f086e3e9d525b46bfe24511431532')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (0x200, struct.pack('<Q', target)),
                        (target, bytes(function)), (0x500, descriptor),
                        (0x700, transform), (0x8f0, algorithm),
                        (0xa00, b'abc'), (0xb00, bytes(32))),
            0x100, {'rdi': 0x500, 'rsi': 0xa00, 'rdx': 3,
                    'rcx': 0xb00, 'rsp': 0x2000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0xb00, 32), expected)
        self.assertEqual(read_virtual(state, 0x508, 32), expected)
        self.assertEqual(state.register('rax'), 0)
        self.assertEqual(state.register('rsp'), 0x2000)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_sponge_finalize_calls'], 1)
        self.assertEqual(layout['collapsed_sponge_finalize_bytes'], 35)

    def test_non_sponge_target_retains_its_negative_code_proof(self):
        target = 0x300
        state = initial_state(
            memory_with((target, bytes(0x80))), 0x100)
        dbt = X86DBT()

        self.assertFalse(dbt._is_sponge_finalize_function(state, target))
        cached = dbt._sponge_finalize_functions[target]
        self.assertFalse(cached[2])
        self.assertFalse(dbt._is_sponge_finalize_function(state, target))
        self.assertIs(dbt._sponge_finalize_functions[target], cached)

    def test_hash_wrapper_composes_finalize_and_context_erasure(self):
        wrapper_target = 0x300
        finalizer_target = 0x600
        wrapper = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 ec 38 '
            '41 89 d5 4c 8b 3f 48 8d 5f 08 49 8b 47 20 '
            '44 8b 70 20 41 f7 c6 00 00 00 01')
        entry = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 e4 f0 '
            '48 81 ec b0 00 00 00 48 89 cb 41 89 d6 '
            '48 89 34 24 49 89 ff')
        metadata = bytes.fromhex(
            '48 8b 07 48 8b 40 20 8b 48 f8 48 89 4c 24 08 '
            '44 8b 60 24 48 8d 7c 24 10 ba 90 00 00 00 31 f6')
        finalizer = bytearray(0x3e + len(metadata))
        finalizer[:len(entry)] = entry
        finalizer[0x3e:] = metadata
        descriptor = bytearray(8 + 337)
        struct.pack_into('<Q', descriptor, 0, 0x1200)
        descriptor[8 + 200:8 + 202] = b'ab'
        descriptor[8 + 336] = 2
        transform = bytearray(0x28)
        struct.pack_into('<Q', transform, 0x20, 0x1400)
        caller = (b'\xe8'
                  + struct.pack('<i', wrapper_target - 0x105)
                  + b'\xf4')
        expected = bytes.fromhex(
            '3a985da74fe225b2045c172d6bd390bd'
            '855f086e3e9d525b46bfe24511431532')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, caller), (wrapper_target, wrapper),
                (finalizer_target, bytes(finalizer)),
                (0x1000, descriptor), (0x1200, transform),
                (0x13a0, struct.pack('<Q', finalizer_target)),
                (0x13f0, struct.pack('<I', 337)),
                (0x13f8, struct.pack('<I', 32)),
                (0x1420, struct.pack('<I', 0x01000000)),
                (0x1424, struct.pack('<I', 136)),
                (0x1600, b'c'), (0x1700, bytes(32))),
            0x100, {'rdi': 0x1000, 'rsi': 0x1600, 'rdx': 1,
                    'rcx': 0x1700, 'rsp': 0x3000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x1700, 32), expected)
        self.assertEqual(read_virtual(state, 0x1008, 337), bytes(337))
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_hash_finalize_calls'], 1)
        self.assertEqual(layout['collapsed_hash_context_bytes'], 337)
        self.assertEqual(layout['collapsed_sponge_finalize_calls'], 1)

    def test_hash_init_wrapper_publishes_only_context_state(self):
        wrapper_target = 0x300
        initializer_target = 0x600
        wrapper = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 48 8b 0f '
            'b8 82 ff ff ff f6 41 04 01 75 27 '
            '48 8b 41 20 f6 40 23 01')
        initializer = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '48 83 c7 08 ba c8 00 00 00 31 f6')
        descriptor = bytearray(8 + 337)
        struct.pack_into('<Q', descriptor, 0, 0x1200)
        descriptor[8:] = b'\xaa' * 337
        transform = bytearray(0x28)
        struct.pack_into('<Q', transform, 0x20, 0x1400)
        caller = (b'\xe8'
                  + struct.pack('<i', wrapper_target - 0x105)
                  + b'\xf4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, caller), (wrapper_target, wrapper),
                (initializer_target, initializer),
                (0x1000, descriptor), (0x1200, transform),
                (0x1388, struct.pack('<Q', initializer_target)),
                (0x13f0, struct.pack('<I', 337)),
                (0x1420, struct.pack('<I', 0x01000000))),
            0x100, {'rdi': 0x1000, 'rsp': 0x3000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x1008, 200), bytes(200))
        self.assertEqual(read_virtual(state, 0x10d0, 136), b'\xaa' * 136)
        self.assertEqual(load_virtual(state, 0x1158, 1), 0)
        self.assertEqual(state.register('rax'), 0)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_hash_init_calls'], 1)
        self.assertEqual(layout['collapsed_hash_init_bytes'], 200)

    def test_hash_wrapper_appends_a_partial_update_directly(self):
        target = 0x300
        wrapper = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 ec 38 '
            '41 89 d5 4c 8b 3f 48 8d 5f 08 49 8b 47 20 '
            '44 8b 70 20 41 f7 c6 00 00 00 01')
        descriptor = bytearray(8 + 337)
        struct.pack_into('<Q', descriptor, 0, 0x1200)
        descriptor[8 + 200:8 + 202] = b'ab'
        descriptor[8 + 336] = 2
        transform = bytearray(0x28)
        struct.pack_into('<Q', transform, 0x20, 0x1400)
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, caller), (target, wrapper),
                (0x1000, descriptor), (0x1200, transform),
                (0x13a0, struct.pack('<Q', 0xdead)),
                (0x13f0, struct.pack('<I', 337)),
                (0x1420, struct.pack('<I', 0x01000000)),
                (0x1424, struct.pack('<I', 136)),
                (0x1600, b'cd')),
            0x100, {'rdi': 0x1000, 'rsi': 0x1600, 'rdx': 2,
                    'rcx': 0, 'rsp': 0x3000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x10d0, 4), b'abcd')
        self.assertEqual(load_virtual(state, 0x1158, 1), 4)
        self.assertEqual(state.register('rax'), 0)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_hash_update_calls'], 1)
        self.assertEqual(layout['collapsed_hash_update_bytes'], 2)
        self.assertEqual(layout['collapsed_hash_finalize_calls'], 0)

    def test_hash_stream_absorbs_full_rates_before_finalizing(self):
        wrapper_target = 0x300
        finalizer_target = 0x600
        updater_target = 0x800
        wrapper = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 ec 38 '
            '41 89 d5 4c 8b 3f 48 8d 5f 08 49 8b 47 20 '
            '44 8b 70 20 41 f7 c6 00 00 00 01')
        entry = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 e4 f0 '
            '48 81 ec b0 00 00 00 48 89 cb 41 89 d6 '
            '48 89 34 24 49 89 ff')
        metadata = bytes.fromhex(
            '48 8b 07 48 8b 40 20 8b 48 f8 48 89 4c 24 08 '
            '44 8b 60 24 48 8d 7c 24 10 ba 90 00 00 00 31 f6')
        finalizer = bytearray(0x3e + len(metadata))
        finalizer[:len(entry)] = entry
        finalizer[0x3e:] = metadata
        updater = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 ec 10 '
            '89 d3 49 89 f6 49 89 ff 48 8b 07 48 8b 40 20 '
            '44 8b 68 24')
        descriptor = bytearray(8 + 337)
        struct.pack_into('<Q', descriptor, 0, 0x1200)
        transform = bytearray(0x28)
        struct.pack_into('<Q', transform, 0x20, 0x1400)
        payload = bytes(range(140))
        caller = (b'\xe8'
                  + struct.pack('<i', wrapper_target - 0x105)
                  + b'\xf4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, caller), (wrapper_target, wrapper),
                (finalizer_target, bytes(finalizer)),
                (updater_target, updater), (0x1000, descriptor),
                (0x1200, transform),
                (0x1390, struct.pack('<Q', updater_target)),
                (0x13a0, struct.pack('<Q', finalizer_target)),
                (0x13f0, struct.pack('<I', 337)),
                (0x13f8, struct.pack('<I', 32)),
                (0x1420, struct.pack('<I', 0x01000000)),
                (0x1424, struct.pack('<I', 136)),
                (0x1600, payload), (0x1700, bytes(32))),
            0x100, {'rdi': 0x1000, 'rsi': 0x1600,
                    'rdx': len(payload), 'rcx': 0x1700,
                    'rsp': 0x3000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(
            read_virtual(state, 0x1700, 32),
            hashlib.sha3_256(payload).digest())
        self.assertEqual(read_virtual(state, 0x1008, 337), bytes(337))
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_sponge_absorb_blocks'], 1)
        self.assertEqual(layout['collapsed_sponge_absorb_bytes'], 136)
        self.assertEqual(layout['collapsed_hash_finalize_calls'], 1)

    def test_repeated_sponge_mix_publishes_only_the_pool_residual(self):
        target = 0x300
        finalizer_target = 0x600
        updater_target = 0x800
        function = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 e4 f0 '
            '48 81 ec d0 01 00 00')
        finalizer_entry = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 e4 f0 '
            '48 81 ec b0 00 00 00 48 89 cb 41 89 d6 '
            '48 89 34 24 49 89 ff')
        finalizer_metadata = bytes.fromhex(
            '48 8b 07 48 8b 40 20 8b 48 f8 48 89 4c 24 08 '
            '44 8b 60 24 48 8d 7c 24 10 ba 90 00 00 00 31 f6')
        finalizer = bytearray(0x3e + len(finalizer_metadata))
        finalizer[:len(finalizer_entry)] = finalizer_entry
        finalizer[0x3e:] = finalizer_metadata
        updater = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 ec 10 '
            '89 d3 49 89 f6 49 89 ff 48 8b 07 48 8b 40 20 '
            '44 8b 68 24')
        descriptor = bytearray(8 + 337)
        struct.pack_into('<Q', descriptor, 0, 0x1200)
        descriptor[8 + 200:8 + 204] = b'pool'
        descriptor[8 + 336] = 4
        transform = bytearray(0x28)
        struct.pack_into('<Q', transform, 0x20, 0x1400)
        seed = bytes(range(32))
        additional = b'addtl'
        expected_intermediary = seed
        for _unused in range(2):
            expected_intermediary = hashlib.sha3_256(
                expected_intermediary + additional).digest()
        expected = (b'pool' + expected_intermediary
                    + struct.pack('<Q', 0x1122334455667788))
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, caller), (target, function),
                (finalizer_target, bytes(finalizer)),
                (updater_target, updater), (0x1000, descriptor),
                (0x1200, transform),
                (0x1390, struct.pack('<Q', updater_target)),
                (0x13a0, struct.pack('<Q', finalizer_target)),
                (0x13f0, struct.pack('<I', 337)),
                (0x13f8, struct.pack('<I', 32)),
                (0x1424, struct.pack('<I', 136)),
                (0x1600, additional), (0x3e10, seed)),
            0x100, {'rdi': 0x1000,
                    'rsi': 0x1122334455667788,
                    'rdx': 0x1600, 'rcx': len(additional),
                    'r8': 2, 'r9': 0, 'rsp': 0x4000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x10d0, len(expected)), expected)
        self.assertEqual(load_virtual(state, 0x1158, 1), len(expected))
        self.assertEqual(read_virtual(state, 0x3e10, 32), bytes(32))
        self.assertEqual(state.register('rax'), 0)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_sponge_mix_calls'], 1)
        self.assertEqual(layout['collapsed_sponge_mix_rounds'], 2)

    def test_wrap_branch_normalizes_to_modular_delta(self):
        target = 0x200
        function = bytes.fromhex(
            '55 48 89 e5 48 83 ec 18 48 89 7d f8 '
            '48 89 75 f0 48 8b 45 f8 48 3b 45 f0 73 0e')
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function)),
            0x100, {'rdi': MASK64 - 3, 'rsi': 2, 'rsp': 0x3000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 6)
        self.assertEqual(state.register('rsp'), 0x3000)
        self.assertEqual(
            dbt.layout()['collapsed_modular_delta_calls'], 1)

    def test_wrapped_byte_walk_composes_the_remaining_coordinates(self):
        target = 0x100
        header = bytes.fromhex(
            '48 8b 45 e0 48 8b 4d f8 8b 49 3c 48 03 4d d8 '
            '48 39 c8 73 66')
        tail = bytes.fromhex(
            '48 8b 45 e0 48 83 c0 01 48 89 45 e0 eb 86')
        function = bytearray(0x7a)
        function[:len(header)] = header
        function[0x6c:0x6c + len(tail)] = tail
        collector = bytearray(0x40)
        struct.pack_into('<Q', collector, 0x28, 0x1000)
        struct.pack_into('<I', collector, 0x30, 1)
        struct.pack_into('<I', collector, 0x34, 4)
        struct.pack_into('<I', collector, 0x38, 8)
        struct.pack_into('<I', collector, 0x3c, 10)
        frame = bytearray(0x38)
        struct.pack_into('<Q', frame, 0x30, 0x500)
        struct.pack_into('<Q', frame, 0x18, 3)
        struct.pack_into('<Q', frame, 0x10, 2)
        dbt = X86DBT()
        state = initial_state(
            memory_with((target, bytes(function)), (0x500, collector),
                        (0x7c8, frame), (0x1000, bytes(32))),
            target, {'rbp': 0x800})

        state = dbt._collapse_wrapped_byte_walk(state)

        expected = bytearray(32)
        for coordinate in (1, 8, 15, 22, 29, 4, 11, 18, 25):
            expected[coordinate] = 1
        self.assertEqual(read_virtual(state, 0x1000, 32), bytes(expected))
        self.assertEqual(load_virtual(state, 0x530, 4), 0)
        self.assertEqual(load_virtual(state, 0x7e0, 8), 12)
        self.assertEqual(load_virtual(state, 0x7d0, 8), 0x1019)
        self.assertEqual(state.register('rax'), 12)
        self.assertEqual(state.register('rcx'), 12)
        self.assertEqual(state.rip, target + 0x7a)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_wrapped_byte_iterations'], 9)
        self.assertEqual(layout['collapsed_wrapped_byte_coordinates'], 9)

    def test_bit_partition_loop_joins_at_its_single_exit(self):
        target = 0x100
        loop = bytes.fromhex(
            '8b 45 ec 05 00 01 00 00 83 e8 01 31 d2 f7 75 ec '
            '3b 45 dc 76 2b 48 8b 45 f0 8b 4d d8 48 21 c8 '
            '48 33 45 e0 48 89 45 e0 48 8b 45 f0 8b 4d ec '
            '48 d3 e8 48 89 45 f0 8b 45 dc 83 c0 01 89 45 dc eb c0')
        frame = bytearray(0x40)
        struct.pack_into('<I', frame, 0x18, 0xff)
        struct.pack_into('<I', frame, 0x1c, 1)
        struct.pack_into('<Q', frame, 0x20, 0x88)
        struct.pack_into('<I', frame, 0x2c, 8)
        struct.pack_into('<Q', frame, 0x30, 0x11223344556677)
        dbt = X86DBT()
        state = initial_state(
            memory_with((target, loop), (0x7c0, frame)),
            target, {'rbp': 0x800})

        state = dbt._collapse_bit_partition_loop(state)

        self.assertEqual(load_virtual(state, 0x7f0, 8), 0)
        self.assertEqual(load_virtual(state, 0x7e0, 8), 0x88)
        self.assertEqual(load_virtual(state, 0x7dc, 4), 32)
        self.assertEqual(state.register('rax'), 32)
        self.assertEqual(state.register('rdx'), 7)
        self.assertEqual(state.register('rcx'), 8)
        self.assertEqual(state.rip, target + len(loop))
        self.assertEqual(
            dbt.layout()['collapsed_bit_partition_iterations'], 31)

    def test_memory_fill_leaf_uses_one_physical_state_cut(self):
        target = 0x200
        signature = bytes.fromhex(
            '49 89 fa 40 0f b6 ce 48 b8 01 01 01 01 01 01 01 01 '
            '48 0f af c1 41 89 f9 41 83 e1 07 75 74')
        function = bytearray(0x30 + len(signature))
        function[:6] = bytes.fromhex('f3 0f 1e fa eb 2a')
        function[0x30:] = signature
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, bytes(function)),
                        (0x700, bytes(96))),
            0x100, {'rdi': 0x700, 'rsi': 0xa5,
                    'rdx': 96, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x700, 96), b'\xa5' * 96)
        self.assertEqual(state.register('rax'), 0x700)
        self.assertEqual(state.register('rsp'), 0x9000)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_memory_fill_calls'], 1)
        self.assertEqual(layout['collapsed_memory_fill_call_bytes'], 96)

    def test_patched_retpoline_reenters_the_pure_call_route(self):
        thunk_target = 0x200
        fill_target = 0x400
        signature = bytes.fromhex(
            '49 89 fa 40 0f b6 ce 48 b8 01 01 01 01 01 01 01 01 '
            '48 0f af c1 41 89 f9 41 83 e1 07 75 74')
        function = bytearray(0x30 + len(signature))
        function[:6] = bytes.fromhex('f3 0f 1e fa eb 2a')
        function[0x30:] = signature
        caller = (b'\xe8' + struct.pack('<i', thunk_target - 0x105)
                  + b'\xf4')
        patched_thunk = bytes.fromhex(
            'e8 01 00 00 00 cc 4c 89 1c 24 c3')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (thunk_target, patched_thunk),
                        (fill_target, bytes(function)),
                        (0x700, bytes(32))),
            0x100, {'r11': fill_target, 'rdi': 0x700,
                    'rsi': 0x6d, 'rdx': 32, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x700, 32), b'\x6d' * 32)
        self.assertEqual(state.register('rsp'), 0x9000)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_indirect_calls'], 1)
        self.assertEqual(layout['collapsed_memory_fill_calls'], 1)

    def test_memory_copy_leaf_uses_one_physical_copy(self):
        target = 0x200
        wrapper = bytes.fromhex('f3 0f 1e fa eb 1a') + bytes(26)
        core = bytes.fromhex(
            '48 89 f8 48 83 fa 20 72 7e 40 38 fe 7c 35 '
            '48 83 ea 20')
        function = wrapper + core
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        payload = bytes(range(17))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (0x500, payload), (0x700, bytes(len(payload)))),
            0x100, {'rsi': 0x500, 'rdi': 0x700,
                    'rdx': len(payload), 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x700, len(payload)), payload)
        self.assertEqual(state.register('rax'), 0x700)
        self.assertEqual(state.register('rsi'), 0x500)
        self.assertEqual(state.register('rdi'), 0x700)
        self.assertEqual(state.register('rdx'), len(payload))
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_memory_copy_calls'], 1)
        self.assertEqual(
            layout['collapsed_memory_copy_call_bytes'], len(payload))

    def test_memory_move_leaf_uses_the_overlap_safe_physical_copy(self):
        target = 0x200
        function = bytes.fromhex(
            'f3 0f 1e fa 48 89 f8 48 39 fe 7d 0f '
            '49 89 f0 49 01 d0 49 39 f8 0f 8f b5 00 00 00 '
            '48 83 fa 20')
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        payload = bytes(range(128))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (0x500, payload)),
            0x100, {'rsi': 0x500, 'rdi': 0x520,
                    'rdx': 96, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x520, 96), payload[:96])
        self.assertEqual(state.register('rax'), 0x520)
        self.assertEqual(dbt.layout()['collapsed_memory_copy_calls'], 1)

    def test_text_patch_leaf_writes_one_executable_byte_span(self):
        target = 0x200
        function = (bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 53 48 0f ba 25') + bytes(4)
            + bytes.fromhex(
                '34 73 22 48 89 fb 49 89 d6 49 89 f7 e8')
            + bytes(4))
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        payload = bytes.fromhex('0f 1f 44 00 00')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (0x500, payload), (0x700, b'abcde')),
            0x100, {'rsi': 0x500, 'rdi': 0x700,
                    'rdx': len(payload), 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x700, len(payload)), payload)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_text_patch_calls'], 1)
        self.assertEqual(
            layout['collapsed_text_patch_bytes'], len(payload))

        sealed = bytearray(function)
        sealed[:4] = bytes.fromhex('0f 1f 40 d6')
        sealed_dbt = X86DBT()
        sealed_state, sealed_boundary, _cost = sealed_dbt.run(initial_state(
            memory_with((0x100, caller), (target, sealed),
                        (0x500, payload), (0x700, b'abcde')),
            0x100, {'rsi': 0x500, 'rdi': 0x700,
                    'rdx': len(payload), 'rsp': 0x9000}))
        self.assertEqual(sealed_boundary.operation, 'halt')
        self.assertEqual(
            read_virtual(sealed_state, 0x700, len(payload)), payload)
        self.assertEqual(
            sealed_dbt.layout()['collapsed_text_patch_calls'], 1)

    def test_feature_gated_void_copy_uses_one_direct_byte_cut(self):
        target, feature, feature_state = 0x200, 0x500, 0x800
        function = bytearray(b'\x90' * 0xc0)
        function[:4] = bytes.fromhex('f3 0f 1e fa')
        function[4] = 0xe8
        function[9:33] = _VOID_COPY_ARGUMENTS
        struct.pack_into('<i', function, 33, feature - (target + 37))
        function[0x30:0x30 + len(_VOID_COPY_BYTE_LOOP)] = \
            _VOID_COPY_BYTE_LOOP
        function[0x70:0x70 + len(_VOID_COPY_REP)] = _VOID_COPY_REP

        selector = bytearray(b'\x90' * 32)
        selector[:5] = bytes.fromhex('f3 0f 1e fa 55')
        selector[5:7] = bytes.fromhex('8b 05')
        struct.pack_into('<i', selector, 7, feature_state - (feature + 11))
        selector[14:28] = bytes.fromhex(
            '83 f8 01 74 18 83 f8 02 74 08 31 c0 5d e9')

        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        payload = bytes(range(64))
        dbt = X86DBT()
        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (feature, selector), (feature_state, bytes(4)),
                        (0x1000, payload), (0x1200, bytes(64))),
            0x100, {'rdi': 0x1200, 'rsi': 0x1000,
                    'rdx': len(payload), 'rax': MASK64, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x1200, len(payload)), payload)
        self.assertEqual(state.register('rax'), 0)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_void_memory_copy_calls'], 1)
        self.assertEqual(layout['collapsed_void_memory_copy_bytes'], 64)

    def test_feature_gated_rep_copy_uses_the_same_physical_cut(self):
        target, feature, feature_state = 0x200, 0x500, 0x800
        function = bytearray(b'\x90' * 0xc0)
        function[:9] = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00')
        function[9:0x20] = bytes.fromhex(
            '55 48 89 e5 41 57 41 56 53 48 89 d3 '
            '49 89 f7 49 89 fe bf 04 00 00 00')
        function[0x20] = 0xe8
        struct.pack_into('<i', function, 0x21, feature - (target + 0x25))
        function[0x25:0x29] = bytes.fromhex('84 c0 74 20')
        function[0x35:0x49] = bytes.fromhex(
            '41 8a 14 0f 41 88 14 0e 48 63 c8 ff c0 '
            '48 39 cb 77 ee eb 35')
        function[0x62:0x71] = bytes.fromhex(
            '48 89 d9 48 c1 e9 02 4c 89 fe 4c 89 f7 f3 a5')
        function[0x71:0x80] = bytes.fromhex(
            'f6 c3 02 74 02 66 a5 f6 c3 01 74 01 a4 5b 41')

        selector = bytearray(b'\x90' * 64)
        selector[:10] = bytes.fromhex(
            'f3 0f 1e fa 55 48 89 e5 8b 05')
        struct.pack_into('<i', selector, 10,
                         feature_state - (feature + 14))
        selector[14:32] = bytes.fromhex(
            '83 f8 02 74 11 83 f8 01 75 18 e8 33 00 00 00 5d 2e e9')

        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        payload = bytes(range(64))
        dbt = X86DBT()
        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (feature, selector), (feature_state, bytes(4)),
                        (0x1000, payload), (0x1200, bytes(64))),
            0x100, {'rdi': 0x1200, 'rsi': 0x1000,
                    'rdx': len(payload), 'rax': MASK64, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x1200, len(payload)), payload)
        self.assertEqual(state.register('rax'), 0)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_void_memory_copy_calls'], 1)
        self.assertEqual(layout['collapsed_void_memory_copy_bytes'], 64)

    def test_packed_range_table_query_uses_one_proved_directory(self):
        target, entry, entry_return = 0x200, 0x500, 0x600
        table_pointer, return_thunk, table = 0x700, 0x800, 0x1000
        function = bytearray(b'\x90' * 0x77)
        function[:4] = bytes.fromhex('f3 0f 1e fa')
        function[4] = 0xe8
        struct.pack_into('<i', function, 5, entry - (target + 9))
        function[9:12] = bytes.fromhex('49 89 f9')
        function[12:15] = bytes.fromhex('48 8b 3d')
        struct.pack_into(
            '<i', function, 15, table_pointer - (target + 0x13))
        function[0x13:0x48] = _RANGE_TABLE_QUERY_PREFIX
        function[0x48] = 0xe9
        struct.pack_into(
            '<i', function, 0x49, return_thunk - (target + 0x4d))
        function[0x4d:0x66] = _RANGE_TABLE_QUERY_TYPED
        function[0x66] = 0xe9
        struct.pack_into(
            '<i', function, 0x67, return_thunk - (target + 0x6b))
        function[0x6b:0x77] = _RANGE_TABLE_QUERY_SUFFIX

        entry_code = _ENTRY_NOP_PREFIX + struct.pack(
            '<i', entry_return - (entry + len(_ENTRY_NOP_PREFIX) + 4))
        records = (
            (0x1000, 0x100, 1),
            (0x2000, 0x200, 2),
            (0x4000, 0x80, 1),
        )
        payload = struct.pack('<I', len(records)) + b''.join(
            struct.pack('<QQI', *record) for record in records)
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        memory = memory_with(
            (0x100, caller), (target, function), (entry, entry_code),
            (entry_return, b'\xc3'),
            (table_pointer, struct.pack('<Q', table)),
            (return_thunk, b'\xc3'), (table, payload))

        cases = (
            ('matching-class', 0x1080, 0x1090, 1, 1),
            ('different-class', 0x1080, 0x1090, 2, 0),
            ('wildcard-class', 0x2080, 0x2090, 0, 1),
            ('outside', 0x3000, 0x3010, 0, 0),
        )
        for name, start, end, kind, expected in cases:
            with self.subTest(name=name):
                dbt = X86DBT()
                state, boundary, _cost = dbt.run(initial_state(
                    memory, 0x100,
                    {'rdi': start, 'rsi': end, 'rdx': kind,
                     'rax': MASK64, 'rsp': 0x9000}))

                self.assertEqual(boundary.operation, 'halt')
                self.assertEqual(state.register('rax'), expected)
                layout = dbt.layout()
                self.assertEqual(layout['collapsed_range_table_calls'], 1)
                self.assertEqual(layout['range_table_cache_misses'], 1)
                self.assertGreaterEqual(
                    layout['collapsed_range_table_records'], 1)

    def test_direct_range_table_query_uses_the_same_directory(self):
        target, table_pointer, table = 0x200, 0x700, 0x1000
        function = bytearray(b'\x90' * 0x77)
        function[:9] = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00')
        function[9:0x10] = bytes.fromhex(
            '55 48 89 e5 48 8b 0d')
        struct.pack_into(
            '<i', function, 0x10, table_pointer - (target + 0x14))
        function[0x14:0x53] = bytes.fromhex(
            '44 8b 01 31 c0 45 85 c0 74 35 48 83 c1 04 eb 07 '
            'ff c0 41 39 c0 74 2f 4c 63 c8 4f 8d 0c 89 '
            '4e 8d 0c 89 85 d2 74 06 41 39 51 10 75 e4 '
            '4d 8b 11 49 39 f2 73 dc 4d 03 51 08 49 39 fa '
            '76 d3 b0 01')
        function[0x53:0x5a] = bytes.fromhex(
            '5d 2e e9 00 00 00 00')
        function[0x5a:0x63] = bytes.fromhex(
            '31 c0 5d 2e e9 00 00 00 00')

        records = ((0x1000, 0x100, 1), (0x2000, 0x200, 2))
        payload = struct.pack('<I', len(records)) + b''.join(
            struct.pack('<QQI', *record) for record in records)
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()
        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, caller), (target, function),
                (table_pointer, struct.pack('<Q', table)), (table, payload)),
            0x100, {'rdi': 0x1080, 'rsi': 0x1090, 'rdx': 1,
                    'rax': MASK64, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 1)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_range_table_calls'], 1)
        self.assertEqual(layout['range_table_cache_misses'], 1)

    def test_sparse_range_compaction_and_sort_share_one_cut(self):
        target, entry, entry_return = 0x200, 0x500, 0x600
        compare, sort, return_thunk = 0x800, 0xa00, 0xc00
        function = bytearray(b'\x90' * 0xde)
        function[:4] = bytes.fromhex('f3 0f 1e fa')
        function[4] = 0xe8
        struct.pack_into('<i', function, 5, entry - (target + 9))
        function[9:0x22] = _RANGE_COMPACT_ENTRY
        function[0x22:0x8f] = _RANGE_COMPACT_CORE
        function[0x8f:0xbe] = _RANGE_COMPACT_COUNT
        function[0xbe:0xc1] = bytes.fromhex('48 c7 c1')
        struct.pack_into('<i', function, 0xc1, compare)
        function[0xc5:0xcd] = bytes.fromhex(
            'ba 10 00 00 00 4c 89 cf')
        function[0xcd] = 0xe8
        struct.pack_into('<i', function, 0xce, sort - (target + 0xd2))
        function[0xd2:0xd9] = bytes.fromhex('89 d8 48 8b 5d f8 c9')
        function[0xd9] = 0xe9
        struct.pack_into(
            '<i', function, 0xda, return_thunk - (target + 0xde))

        entry_code = _ENTRY_NOP_PREFIX + struct.pack(
            '<i', entry_return - (entry + len(_ENTRY_NOP_PREFIX) + 4))
        comparator = bytearray(b'\x90' * 0x2b)
        comparator[:4] = bytes.fromhex('f3 0f 1e fa')
        comparator[4] = 0xe8
        struct.pack_into('<i', comparator, 5, entry - (compare + 9))
        comparator[9:0x26] = _RANGE_COMPARE_BODY
        comparator[0x26] = 0xe9
        struct.pack_into(
            '<i', comparator, 0x27,
            return_thunk - (compare + 0x2b))
        sorter = bytearray(b'\x90' * 96)
        sorter[:len(_SORT_WRAPPER_CORE)] = _SORT_WRAPPER_CORE

        base = 0x1000
        records = (
            (30, 40), (0, 0), (10, 20),
            (0, 0), (20, 30), (0, 0),
        )
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        state = initial_state(memory_with(
            (0x100, caller), (target, function), (entry, entry_code),
            (entry_return, b'\xc3'), (compare, comparator),
            (sort, sorter), (return_thunk, b'\xc3'),
            (base, b''.join(struct.pack('<QQ', *record)
                            for record in records))),
            0x100, {'rdi': base, 'rsi': len(records), 'rsp': 0x9000})
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 3)
        self.assertEqual(
            read_virtual(state, base, len(records) * 16),
            b''.join(struct.pack('<QQ', *record) for record in (
                (10, 20), (20, 30), (30, 40),
                (0, 0), (0, 0), (0, 0))))
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_range_compactions'], 1)
        self.assertEqual(layout['collapsed_range_compaction_records'], 6)
        self.assertEqual(
            layout['collapsed_range_compaction_live_records'], 3)

    def test_direct_sparse_range_compaction_uses_the_same_cut(self):
        target, compare, sort = 0x200, 0x800, 0xa00
        function = bytearray(b'\x90' * 0xf1)
        function[:0xde] = _RANGE_COMPACT_DIRECT
        function[0xde:0xe1] = bytes.fromhex('48 c7 c1')
        struct.pack_into('<i', function, 0xe1, compare)
        function[0xe5:0xe8] = bytes.fromhex('45 31 c0')
        function[0xe8] = 0xe8
        struct.pack_into('<i', function, 0xe9, sort - (target + 0xed))
        function[0xed:0xf1] = bytes.fromhex('89 d8 5b 5d')
        sorter = bytearray(b'\x90' * 96)
        sorter[:len(_SORT_WRAPPER_CORE)] = _SORT_WRAPPER_CORE

        base = 0x1000
        records = (
            (30, 40), (0, 0), (10, 20),
            (0, 0), (20, 30), (0, 0),
        )
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        state = initial_state(memory_with(
            (0x100, caller), (target, function),
            (compare, _RANGE_COMPARE_DIRECT), (sort, sorter),
            (base, b''.join(struct.pack('<QQ', *record)
                            for record in records))),
            0x100, {'rdi': base, 'rsi': len(records), 'rsp': 0x9000})

        dbt = X86DBT()
        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 3)
        self.assertEqual(
            read_virtual(state, base, len(records) * 16),
            b''.join(struct.pack('<QQ', *record) for record in (
                (10, 20), (20, 30), (30, 40),
                (0, 0), (0, 0), (0, 0))))
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_range_compactions'], 1)
        self.assertEqual(layout['collapsed_range_compaction_records'], 6)
        self.assertEqual(
            layout['collapsed_range_compaction_live_records'], 3)

    def test_bounded_string_compare_stops_at_first_observed_byte(self):
        target, return_thunk = 0x200, 0x500
        function = bytearray(b'\x90' * 0x34)
        function[:4] = bytes.fromhex('f3 0f 1e fa')
        function[4:0x28] = _BOUNDED_STRING_COMPARE_BODY
        function[0x28] = 0xe9
        struct.pack_into(
            '<i', function, 0x29, return_thunk - (target + 0x2d))
        function[0x2d:0x30] = bytes.fromhex('31 c0 e9')
        struct.pack_into(
            '<i', function, 0x30, return_thunk - (target + 0x34))
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        cases = (
            ('equal', b'ab\0x', b'ab\0y', 4, 0, 3),
            ('less', b'abax', b'abbx', 4, MASK32, 3),
            ('greater', b'abcx', b'abbx', 4, 1, 3),
            ('bounded', b'abax', b'abbx', 2, 0, 2),
            ('empty', b'a', b'b', 0, 0, 0),
        )
        for name, left, right, count, expected, observed in cases:
            with self.subTest(name=name):
                dbt = X86DBT()
                state, boundary, _cost = dbt.run(initial_state(
                    memory_with(
                        (0x100, caller), (target, function),
                        (return_thunk, b'\xc3'),
                        (0x1000, left), (0x1100, right)),
                    0x100, {'rdi': 0x1000, 'rsi': 0x1100,
                            'rdx': count, 'rsp': 0x9000}))

                self.assertEqual(boundary.operation, 'halt')
                self.assertEqual(state.register('rax'), expected)
                layout = dbt.layout()
                self.assertEqual(
                    layout['collapsed_bounded_compare_calls'], 1)
                self.assertEqual(
                    layout['collapsed_bounded_compare_bytes'], observed)

    def test_direct_bounded_compare_uses_the_same_byte_prefix_cut(self):
        target, return_thunk = 0x200, 0x500
        function = bytearray(b'\x90' * 0x51)
        function[:4] = bytes.fromhex('f3 0f 1e fa')
        function[4:0x2d] = _BOUNDED_STRING_COMPARE_DIRECT
        function[0x2d:0x30] = bytes.fromhex('5d 2e e9')
        struct.pack_into(
            '<i', function, 0x30, return_thunk - (target + 0x34))
        function[0x34:0x39] = bytes.fromhex('31 c0 5d 2e e9')
        struct.pack_into(
            '<i', function, 0x39, return_thunk - (target + 0x3d))
        function[0x3d:0x4d] = bytes.fromhex(
            '0f 93 c0 0f b6 c0 8d 04 45 ff ff ff ff 5d 2e e9')
        struct.pack_into(
            '<i', function, 0x4d, return_thunk - (target + 0x51))
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'

        dbt = X86DBT()
        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, caller), (target, function),
                (return_thunk, b'\xc3'),
                (0x1000, b'abax'), (0x1100, b'abbx')),
            0x100, {'rdi': 0x1000, 'rsi': 0x1100,
                    'rdx': 4, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), MASK32)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_bounded_compare_calls'], 1)
        self.assertEqual(layout['collapsed_bounded_compare_bytes'], 3)

    def test_direct_strided_scan_skips_disproved_byte_coordinates(self):
        loop, compare, return_thunk = 0x200, 0x400, 0x500
        signature, base = 0x600, 0x1000
        comparator = bytearray(b'\x90' * 0x51)
        comparator[:4] = bytes.fromhex('f3 0f 1e fa')
        comparator[4:0x2d] = _BOUNDED_STRING_COMPARE_DIRECT
        comparator[0x2d:0x30] = bytes.fromhex('5d 2e e9')
        struct.pack_into(
            '<i', comparator, 0x30,
            return_thunk - (compare + 0x34))
        comparator[0x34:0x39] = bytes.fromhex('31 c0 5d 2e e9')
        struct.pack_into(
            '<i', comparator, 0x39,
            return_thunk - (compare + 0x3d))
        comparator[0x3d:0x4d] = bytes.fromhex(
            '0f 93 c0 0f b6 c0 8d 04 45 ff ff ff ff 5d 2e e9')
        struct.pack_into(
            '<i', comparator, 0x4d,
            return_thunk - (compare + 0x51))
        scan = (
            bytes.fromhex('48 83 c3 10 4c 39 f3 73 18 ba 08 00 00 00 '
                          '48 89 df 48 c7 c6')
            + struct.pack('<i', signature)
            + b'\xe8' + struct.pack('<i', compare - (loop + 0x1d))
            + bytes.fromhex('85 c0 75 df f4'))
        records = b''.join(
            byte + bytes(15) for byte in (b'x', b'y', b'z', b'q'))

        dbt = X86DBT()
        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (loop, scan), (compare, comparator),
                (return_thunk, b'\xc3'), (signature, b'RSD PTR '),
                (base, records)),
            loop, {'rbx': base - 16, 'r14': base + len(records),
                   'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rbx'), base + len(records))
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_bounded_compare_calls'], 1)
        self.assertEqual(layout['collapsed_strided_predicate_candidates'], 3)

    def test_fixed_signature_gate_recovers_only_required_coordinates(self):
        target, return_thunk = 0x200, 0x500
        function = bytearray(b'\x90' * 0x4c)
        function[:0x21] = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 53 '
            'b8 5f 53 4d 33 33 07 0f b6 4f 04 '
            '83 f1 5f 09 c1 bb 01 00 00 00 75 21')
        function[0x42:0x48] = bytes.fromhex('89 d8 5b 5d 2e e9')
        struct.pack_into(
            '<i', function, 0x48,
            return_thunk - (target + 0x4c))
        dbt = X86DBT()
        state = initial_state(memory_with(
            (target, function), (return_thunk, b'\xc3')), target)

        self.assertEqual(
            dbt._fixed_signature_gate_layout(state, target),
            ((0, b'_SM3_'),))

    def test_copy_validate_window_uses_one_signature_projection(self):
        target, copy, validator = 0x200, 0x400, 0x600
        base, stack = 0x1000, 0x2000
        loop = (
            bytes.fromhex('ba 10 00 00 00 4c 89 f7 4c 89 e6 e8')
            + struct.pack('<i', copy - (target + 0x10))
            + bytes.fromhex('4c 89 ff e8')
            + struct.pack('<i', validator - (target + 0x18))
            + bytes.fromhex(
                '85 c0 74 34 49 8b 06 49 8b 4e 08 '
                '48 89 4c 24 08 48 89 04 24 '
                '49 83 c4 10 4d 39 ec 72 cb f4'))
        self.assertEqual(len(loop), 0x36)
        records = tuple(
            bytes((value,)) * 16 for value in (1, 2, 3, 4))
        memory = memory_with(
            (target, loop), (base, b''.join(records)),
            (stack, records[0] + bytes(16)))

        class SignatureProjectionDBT(X86DBT):
            def _fixed_signature_gate_layout(self, state, address):
                return ((0, b'_SM3_'),) if address == validator else None

            def _is_void_memory_copy_function(self, state, address):
                return address == copy

        dbt = SignatureProjectionDBT()
        branch = dbt.block(initial_state(memory, target + 0x33))
        state = initial_state(
            memory, target,
            {'r12': base + 16, 'r13': base + 64,
             'r14': stack + 16, 'r15': stack, 'rsp': stack})

        exhausted = dbt._collapse_strided_copy_predicate_candidates(
            state, branch)

        self.assertEqual(exhausted.rip, target + 0x35)
        self.assertEqual(exhausted.register('r12'), base + 64)
        self.assertEqual(exhausted.register('rsi'), base + 48)
        self.assertEqual(exhausted.register('rdi'), stack)
        self.assertEqual(read_virtual(exhausted, stack, 16), records[-1])
        self.assertEqual(read_virtual(
            exhausted, stack + 16, 16), records[-1])
        self.assertEqual(
            dbt.layout()['collapsed_strided_predicate_candidates'], 3)

    def test_bitmap_scans_project_to_the_first_live_word(self):
        first_target, next_target, return_thunk = 0x200, 0x300, 0x500
        first = bytearray(b'\x90' * 0x3e)
        first[:4] = bytes.fromhex('f3 0f 1e fa')
        first[4:0x34] = _BIT_SCAN_FIRST_BODY
        first[0x34] = 0xe9
        struct.pack_into(
            '<i', first, 0x35, return_thunk - (first_target + 0x39))
        first[0x39] = 0xe9
        struct.pack_into(
            '<i', first, 0x3a, return_thunk - (first_target + 0x3e))

        next_ = bytearray(b'\x90' * 0x61)
        next_[:4] = bytes.fromhex('f3 0f 1e fa')
        next_[4:0x41] = _BIT_SCAN_NEXT_BODY
        next_[0x41] = 0xe9
        struct.pack_into(
            '<i', next_, 0x42, return_thunk - (next_target + 0x46))
        next_[0x46:0x5c] = _BIT_SCAN_NEXT_RESULT
        next_[0x5c] = 0xe9
        struct.pack_into(
            '<i', next_, 0x5d, return_thunk - (next_target + 0x61))

        bitmap = struct.pack('<QQQ', 0, (1 << 7) | (1 << 63), 2)
        functions = ((first_target, first), (next_target, next_))
        cases = (
            ('first', first_target, 130, 0, 71, 2),
            ('next-word', next_target, 130, 72, 127, 1),
            ('next-tail', next_target, 130, 128, 129, 1),
            ('bounded-miss', next_target, 70, 0, 70, 2),
            ('past-end', next_target, 130, 130, 130, 0),
        )
        for name, target, size, offset, expected, words in cases:
            with self.subTest(name=name):
                caller = b'\xe8' + struct.pack(
                    '<i', target - 0x105) + b'\xf4'
                dbt = X86DBT()
                state, boundary, _cost = dbt.run(initial_state(
                    memory_with(
                        (0x100, caller), *functions,
                        (return_thunk, b'\xc3'), (0x1000, bitmap)),
                    0x100, {'rdi': 0x1000, 'rsi': size,
                            'rdx': offset, 'rsp': 0x9000}))

                self.assertEqual(boundary.operation, 'halt')
                self.assertEqual(state.register('rax'), expected)
                layout = dbt.layout()
                self.assertEqual(layout['collapsed_bit_scan_calls'], 1)
                self.assertEqual(layout['collapsed_bit_scan_words'], words)

    def test_direct_bitmap_scans_use_the_same_live_word_cut(self):
        first_target, next_target, return_thunk = 0x200, 0x300, 0x500
        first = bytearray(b'\x90' * 0x55)
        first[:0x1e] = _BIT_SCAN_FIRST_DIRECT_HEAD
        first[0x1e:0x20] = bytes.fromhex('2e e9')
        struct.pack_into(
            '<i', first, 0x20,
            return_thunk - (first_target + 0x24))
        first[0x24:0x4f] = _BIT_SCAN_FIRST_DIRECT_BODY
        first[0x4f:0x51] = bytes.fromhex('2e e9')
        struct.pack_into(
            '<i', first, 0x51,
            return_thunk - (first_target + 0x55))
        next_ = bytearray(b'\x90' * 0x66)
        next_[:0x60] = _BIT_SCAN_NEXT_DIRECT
        next_[0x60:0x62] = bytes.fromhex('2e e9')
        struct.pack_into(
            '<i', next_, 0x62,
            return_thunk - (next_target + 0x66))
        bitmap = struct.pack('<QQQ', 0, 1 << 7, 2)

        for target, offset, expected in (
                (first_target, 0, 71), (next_target, 72, 129)):
            with self.subTest(target=target):
                caller = b'\xe8' + struct.pack(
                    '<i', target - 0x105) + b'\xf4'
                dbt = X86DBT()
                state, boundary, _cost = dbt.run(initial_state(
                    memory_with(
                        (0x100, caller), (first_target, first),
                        (next_target, next_), (return_thunk, b'\xc3'),
                        (0x1000, bitmap)),
                    0x100, {'rdi': 0x1000, 'rsi': 130,
                            'rdx': offset, 'rsp': 0x9000}))

                self.assertEqual(boundary.operation, 'halt')
                self.assertEqual(state.register('rax'), expected)
                self.assertEqual(dbt.layout()['collapsed_bit_scan_calls'], 1)

    def test_default_record_candidates_use_the_complement_directory(self):
        target, count_address = 0x200, 0x800
        pointer_address, table = 0x808, 0x1000
        code = bytearray.fromhex(
            '48 8d 14 8a 48 63 12 83 fa ff 74 0a 48 0f a3 15 '
            '00 00 00 00 73 27 83 c0 01 3b 05 00 00 00 00 73 '
            '3e 48 8b 15 00 00 00 00 48 63 c8 48 85 d2 75 d0 '
            '48 8b 14 cd 00 00 00 00 48 01 f2 eb c7 48 8b 15 '
            '00 00 00 00 48 85 d2 0f 84 00 00 00 00 c7 04 8a '
            'ff ff ff ff 83 c0 01 3b 05 00 00 00 00 72 c2 f4')
        struct.pack_into(
            '<i', code, 0x1b, count_address - (target + 0x1f))
        struct.pack_into(
            '<i', code, 0x24, pointer_address - (target + 0x28))
        records = struct.pack('<iiii', -1, -1, 7, -1)
        memory = memory_with(
            (target, code), (count_address, struct.pack('<I', 4)),
            (pointer_address, struct.pack('<Q', table)), (table, records))
        dbt = X86DBT()
        branch = dbt.block(initial_state(memory, target + 0x2e))

        state = initial_state(
            memory, target,
            {'rax': 0, 'rcx': 0, 'rdx': table})
        candidate = dbt._collapse_default_record_candidates(state, branch)
        self.assertEqual(candidate.rip, target)
        self.assertEqual(candidate.register('rax'), 2)
        self.assertEqual(candidate.register('rcx'), 2)
        self.assertEqual(candidate.register('rdx'), table)

        state = initial_state(
            memory, target,
            {'rax': 3, 'rcx': 3, 'rdx': table})
        exhausted = dbt._collapse_default_record_candidates(state, branch)
        self.assertEqual(exhausted.rip, target + 0x5f)
        self.assertEqual(exhausted.register('rax'), 4)
        self.assertEqual(exhausted.register('rcx'), 3)
        self.assertEqual(exhausted.register('rdx'), MASK64)
        self.assertEqual(
            dbt.layout()['collapsed_default_record_candidates'], 3)

    def test_pointer_backed_default_records_use_the_same_complement_cut(self):
        target, pointer_address, count_address = 0x200, 0x800, 0x808
        table = 0x1000
        code = bytearray.fromhex(
            '48 8b 3d 00 00 00 00 48 63 f0 48 85 ff 74 06 '
            '48 8d 3c b7 eb 0b 48 8b 3c f5 00 00 00 00 48 01 cf '
            '48 63 3f 48 83 ff ff 74 3b 48 0f a3 3d 00 00 00 00 '
            '72 31 48 8b 3d 00 00 00 00 48 85 ff 74 09 '
            'c7 04 b7 ff ff ff ff eb 1c '
            '48 8b 3c f5 00 00 00 00 89 97 c0 07 df 83 '
            '48 8b 34 f5 00 00 00 00 89 96 c0 0d e0 83 '
            'ff c0 3b 05 00 00 00 00 72 92 f4')
        self.assertEqual(len(code), 0x6f)
        struct.pack_into(
            '<i', code, 3, pointer_address - (target + 7))
        struct.pack_into(
            '<i', code, 0x36, pointer_address - (target + 0x3a))
        struct.pack_into(
            '<i', code, 0x68, count_address - (target + 0x6c))
        memory = memory_with(
            (target, code), (pointer_address, struct.pack('<Q', table)),
            (count_address, struct.pack('<I', 4)),
            (table, b'\xff' * 16))
        dbt = X86DBT()
        branch = dbt.block(initial_state(memory, target + 0x6c))

        state = initial_state(memory, target, {'rax': 1})
        exhausted = dbt._collapse_default_record_candidates(state, branch)

        self.assertEqual(exhausted.rip, target + 0x6e)
        self.assertEqual(exhausted.register('rax'), 4)
        self.assertEqual(exhausted.register('rsi'), 3)
        self.assertEqual(exhausted.register('rdi'), table + 12)
        self.assertEqual(
            dbt.layout()['collapsed_default_record_candidates'], 3)

    def test_static_call_wrapper_normalizes_each_five_byte_site(self):
        wrapper_address = 0x200
        transform_address = 0x400
        translator_address = 0x800
        return_zero = 0x1000
        zero_code = 0x1100
        nop_pointer = 0x1200
        nop_code = 0x1300
        translator_gate = 0x1400
        site = 0x1500
        function = 0x1600
        trampoline = 0x1700
        system_state = 0x1800

        wrapper = bytearray(b'\x90' * 0xa0)
        wrapper[:4] = bytes.fromhex('f3 0f 1e fa')
        wrapper[4] = 0xe8
        wrapper[9:23] = _STATIC_CALL_WRAPPER_ARGUMENTS
        wrapper[0x5c:0x5c + len(_STATIC_CALL_WRAPPER_SITE)] = \
            _STATIC_CALL_WRAPPER_SITE
        wrapper[0x72:0x72 + len(_STATIC_CALL_WRAPPER_TYPE)] = \
            _STATIC_CALL_WRAPPER_TYPE
        wrapper[0x86] = 0xe8
        struct.pack_into(
            '<i', wrapper, 0x87,
            transform_address - (wrapper_address + 0x8b))

        transform = bytearray(b'\x90' * 0x150)
        transform[0] = 0xe8
        transform[5:27] = bytes.fromhex(
            '55 48 89 d0 48 89 e5 41 57 41 56 41 55 41 54 '
            '41 89 cc 53 48 89 fb')
        transform[0x2e:0x39] = bytes.fromhex(
            '8d 56 fe 83 fa 01 76 50 83 fe 01')
        transform[0x49:0x4c] = bytes.fromhex('49 c7 c5')
        struct.pack_into('<I', transform, 0x4c, zero_code)
        transform[0x56] = 0xe8
        struct.pack_into(
            '<i', transform, 0x57,
            translator_address - (transform_address + 0x5b))
        transform[0x6b:0x6d] = bytes.fromhex('48 3d')
        struct.pack_into('<I', transform, 0x6d, return_zero)
        transform[0xd1:0xd3] = bytes.fromhex('8b 05')
        struct.pack_into(
            '<i', transform, 0xd3,
            system_state - (transform_address + 0xd7))
        transform[0x127:0x12a] = bytes.fromhex('4c 8b 2d')
        struct.pack_into(
            '<i', transform, 0x12a,
            nop_pointer - (transform_address + 0x12e))

        translator = bytearray(b'\x90' * 0x93)
        translator[:4] = bytes.fromhex('f3 0f 1e fa')
        translator[4] = 0xe8
        translator[9] = 0x55
        translator[10:12] = bytes.fromhex('80 3d')
        struct.pack_into(
            '<i', translator, 12,
            translator_gate - (translator_address + 17))
        translator[16] = 0

        base_memory = memory_with(
            (wrapper_address, wrapper),
            (transform_address, transform),
            (translator_address, translator),
            (zero_code, _STATIC_CALL_ZERO5),
            (nop_pointer, struct.pack('<Q', nop_code)),
            (nop_code, _STATIC_CALL_NOP5),
            (translator_gate, b'\0'),
            (system_state, bytes(4)))

        cases = (
            ('call', site, 0, function, b'\xe8' + struct.pack(
                '<i', function - (site + 5))),
            ('nop', site, 0, 0, _STATIC_CALL_NOP5),
            ('return-zero', site, 0, return_zero, _STATIC_CALL_ZERO5),
            ('trampoline', 0, trampoline, function, b'\xe9' + struct.pack(
                '<i', function - (trampoline + 5))),
        )
        for name, call_site, call_trampoline, target, expected in cases:
            with self.subTest(name=name):
                destination = call_site or call_trampoline
                initial = (b'\xe8\0\0\0\0' if call_site
                           else b'\xe9\0\0\0\0\x0f\xb9\xcc')
                caller = (b'\xe8' + struct.pack(
                    '<i', wrapper_address - 0x105) + b'\xf4')
                memory = base_memory.write(0x100, caller).write(
                    destination, initial)
                dbt = X86DBT()
                state, boundary, _cost = dbt.run(initial_state(
                    memory, 0x100,
                    {'rdi': call_site, 'rsi': call_trampoline,
                     'rdx': target, 'rcx': 0, 'rsp': 0x9000}))

                self.assertEqual(boundary.operation, 'halt')
                self.assertEqual(
                    read_virtual(state, destination, 5, 'execute'), expected)
                layout = dbt.layout()
                self.assertEqual(layout['collapsed_static_call_transforms'], 1)
                self.assertEqual(layout['collapsed_static_call_bytes'], 5)

    def test_seal_directory_patches_relative_code_coordinates_once(self):
        target = 0x200
        function = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 ec 10')
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        table = 0x500
        coordinates = (0x700, 0x710, 0x720)
        records = b''.join(struct.pack(
            '<i', coordinate - (table + index * 4))
            for index, coordinate in enumerate(coordinates))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (table, records),
                        *((coordinate, bytes.fromhex('f3 0f 1e fa'))
                          for coordinate in coordinates)),
            0x100, {'rdi': table, 'rsi': table + len(records),
                    'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        for coordinate in coordinates:
            self.assertEqual(
                read_virtual(state, coordinate, 4),
                bytes.fromhex('0f 1f 40 d6'))
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_seal_records'], 3)
        self.assertEqual(layout['collapsed_seal_bytes'], 12)

    def test_length_bounded_compare_uses_one_direct_coordinate_span(self):
        # Compiler-shaped strncmp: compare, NUL exit, then a one-past bound.
        code = bytes.fromhex(
            '44 0f b6 04 0f 44 3a 04 0e 75 11 '
            '31 c0 45 84 c0 74 09 48 39 ca 48 8d 49 01 75 e5 '
            'f4 b8 01 00 00 00 f4')
        left = b'abcdefghijklmnopqrstuvwxyz'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, left), (0x500, left)),
            0x100, {'rdi': 0x400, 'rsi': 0x500,
                    'rcx': 0, 'rdx': len(left) - 1}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0)
        self.assertEqual(state.register('rcx'), len(left))
        self.assertGreaterEqual(dbt.layout()['collapsed_compare_bytes'], 25)

    def test_length_bounded_compare_stops_at_the_first_mismatch(self):
        code = bytes.fromhex(
            '44 0f b6 04 0f 44 3a 04 0e 75 11 '
            '31 c0 45 84 c0 74 09 48 39 ca 48 8d 49 01 75 e5 '
            'f4 b8 01 00 00 00 f4')
        dbt = X86DBT()
        left, right = b'abcdefghij', b'abcDefghij'

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, left), (0x500, right)),
            0x100, {'rdi': 0x400, 'rsi': 0x500,
                    'rcx': 0, 'rdx': len(left) - 1}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 1)
        self.assertEqual(state.register('rcx'), 3)
        self.assertGreaterEqual(dbt.layout()['collapsed_compare_bytes'], 3)

    def test_byte_switch_loop_scans_only_qm_proven_inactive_classes(self):
        # A compiler-shaped byte switch: comma and percent update persistent
        # state, while every other nonzero byte returns to the induction edge.
        code = bytes.fromhex(
            'b8 ff ff ff ff ff c0 48 63 c8 0f b6 0c 0b '
            '44 0f b6 c1 45 85 c0 74 10 41 83 f8 2c 74 06 '
            '41 83 f8 25 75 e2 ff c2 eb de f4')
        dbt = X86DBT()
        payload = b'abcdefghijklmnopqrstuvwxyz,%tail\0'

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, payload)), 0x100,
            {'rbx': 0x400}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rdx'), 2)
        layout = dbt.layout()
        self.assertGreaterEqual(
            layout['collapsed_dispatch_bytes']
            + layout['collapsed_byte_state_bytes'], 28)
        self.assertEqual(dbt.layout()['compiled_byte_dispatches'], 1)
        self.assertGreater(layout['collapsed_residual_controls'], 0)

    def test_byte_state_slice_retains_active_parser_transitions(self):
        # Every input byte changes parser state, so a classifier-only scan
        # cannot skip it.  The pure comparison tree remains one retained
        # byte-state slice until the terminating byte reaches HLT.
        code = bytes.fromhex(
            'b8 ff ff ff ff ff c0 48 63 c8 0f b6 0c 0b '
            '44 0f b6 c1 45 85 c0 74 10 41 83 f8 2c 74 06 '
            '41 83 f8 25 75 e2 ff c2 eb de f4')
        payload = b',%' * 512
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, payload + b'\0')),
            0x100, {'rbx': 0x400}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rdx'), len(payload))
        layout = dbt.layout()
        self.assertGreaterEqual(
            layout['collapsed_byte_state_bytes'], len(payload) - 1)
        self.assertGreater(layout['collapsed_byte_state_controls'], 0)
        self.assertGreater(layout['collapsed_byte_state_slices'], 0)

    def test_residual_parser_state_jumps_to_the_next_active_byte(self):
        # Inside a quoted field only NUL, quote, and escape bytes can change
        # parser state.  Ordinary bytes are one direct-coordinate span.
        code = bytes.fromhex(
            '0f b6 03 83 f8 22 0f 84 83 00 00 00 '
            '83 f8 5c 74 69 85 c0 74 84 45 85 f6 75 dd')
        payload = b'abcdef"tail\0'
        dbt = X86DBT()
        state = initial_state(
            memory_with((0x100, code), (0x400, payload)), 0x100,
            {'rbx': 0x400, 'r14': 1})

        state = dbt._collapse_residual_byte_run(state)

        self.assertEqual(state.rip, 0x100)
        self.assertEqual(state.register('rbx'), 0x406)
        self.assertEqual(dbt.layout()['collapsed_residual_bytes'], 6)

        outside_quote = initial_state(
            memory_with((0x100, code), (0x400, payload)), 0x100,
            {'rbx': 0x400, 'r14': 0})
        outside_quote = dbt._collapse_residual_byte_run(outside_quote)
        self.assertEqual(outside_quote.register('rbx'), 0x400)

    def test_loaded_byte_state_slice_keeps_a_strided_attribute_run(self):
        # A console-style 16-bit cell run reads only the attribute lane.  Its
        # index is restored by the SSA plan before each byte load, rather than
        # by a source-level pointer increment at the backedge.
        code = bytes.fromhex(
            '49 89 de 41 0f b6 54 59 01 c1 e2 08 66 39 d7 74 60 '
            '4b 8d 1c 33 49 39 f4 76 4f 4c 8b 7d d0 '
            '49 8b 87 d8 01 00 00 4c 8b 58 30 4c 89 ea 48 29 f2 '
            '48 d1 ea 4c 89 ff 48 89 5d a8 4c 89 cb '
            '2e e8 06 d7 6b 00 4c 8b 5d b8 4c 8b 55 b0 49 89 d9 '
            '8b 4d cc 42 0f b6 7c 73 01 c1 e7 08 '
            '41 8b 87 a4 01 00 00 48 8b 55 a8 41 89 d0 eb 05 '
            '89 d7 41 89 d8 4c 89 e6 49 83 c4 02 43 8d 14 33 '
            'ff c2 4c 89 f3 48 ff c3 49 83 c5 02 39 c2 73 09 '
            '45 39 f2 0f 85 6e ff ff ff f4')
        cells = bytearray(128)
        cells[1::2] = bytes((7,)) * 64
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x500, cells)), 0x100,
            {'rax': 64, 'r9': 0x500, 'r10': 63,
             'rdi': 7 << 8, 'rbp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rbx'), 64)
        self.assertEqual(state.register('r14'), 63)
        self.assertGreaterEqual(
            dbt.layout()['collapsed_byte_state_bytes'], 63)
        self.assertEqual(dbt.layout()['collapsed_strided_byte_runs'], 1)

        mismatch_code = bytearray(code)
        mismatch_code[0x11:0x71] = b'\xf4' + b'\x90' * 95
        mismatch_cells = bytearray(cells)
        mismatch_cells[2 * 17 + 1] = 9
        initial = initial_state(
            memory_with((0x100, mismatch_code),
                        (0x500, mismatch_cells)),
            0x100, {'rax': 64, 'r9': 0x500, 'r10': 63,
                    'rdi': 7 << 8, 'rbp': 0x9000})
        optimized = X86DBT()
        expected = X86DBT()
        expected._collapse_strided_invariant_byte_run = \
            lambda current, _branch: current
        expected._collapse_loaded_byte_state_slice = \
            lambda current, _branch: current

        actual_state, actual_boundary, _cost = optimized.run(initial)
        expected_state, expected_boundary, _cost = expected.run(initial)

        self.assertEqual(actual_boundary.operation, 'halt')
        self.assertEqual(actual_boundary, expected_boundary)
        self.assertEqual(actual_state.registers, expected_state.registers)
        self.assertEqual(actual_state.rflags, expected_state.rflags)
        self.assertEqual(
            optimized.layout()['collapsed_strided_byte_runs'], 1)

    def test_byte_switch_classification_table_is_part_of_the_qm_proof(self):
        # The byte predicate uses a read-only ctype table after the induction
        # load.  Its table page is proof input, not a reason to scalarize the
        # otherwise pure span.
        table_address = 0x800
        code = bytearray(bytes.fromhex(
            '48 89 d9 48 ff c3 0f b6 41 01 '
            '48 83 f8 5f 74 f0 '
            '0f b6 90 00 00 00 00 80 e2 07 75 e4 f4'))
        struct.pack_into('<i', code, 19, table_address)
        classes = bytearray(256)
        for byte in b'abcdefghijklmnopqrstuvwxyz0123456789':
            classes[byte] = 7
        payload = b'abc_123!\0'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, payload),
                        (table_address, classes)),
            0x100, {'rbx': 0x3ff}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rbx'), 0x407)
        self.assertEqual(state.register('rax') & 0xff, ord('!'))
        self.assertEqual(dbt.layout()['compiled_byte_dispatches'], 1)
        self.assertGreaterEqual(dbt.layout()['collapsed_dispatch_bytes'], 6)

    def test_byte_state_header_skips_a_loop_invariant_predicate_span(self):
        # The state register is read by the byte DFA but never changed on the
        # inactive path.  QM retains it as a scalar proof input while the byte
        # coordinates are scanned directly.
        code = bytes.fromhex(
            '0f b6 03 45 85 f6 75 0d 3c 2c 74 09 '
            '84 c0 74 05 48 ff c3 eb eb f4')
        payload = b'abcdefghijklmnopqrstuvwxyz,tail\0'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, payload)), 0x100,
            {'rbx': 0x400, 'r14': 0}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rbx'), 0x400 + 26)
        self.assertGreaterEqual(dbt.layout()['collapsed_dispatch_bytes'], 23)

    def test_indirect_field_search_builds_one_proved_coordinate_index(self):
        code = bytes.fromhex(
            '49 ff c5 49 39 d5 7d 11 '
            '49 8b 4f 10 48 8b 09 4b 8b 34 ee 48 3b 0e 75 e8 '
            'f4 b8 02 00 00 00 f4')
        count, match = 64, 60
        system_slot, array_address = 0x700, 0x800
        needle = 0x1122334455667788
        pointers = bytearray()
        fields = []
        for index in range(count):
            address = 0x1000 + index * 16
            pointers.extend(struct.pack('<Q', address))
            value = needle if index == match else index + 1
            fields.append((address, struct.pack('<Q', value)))
        memory = memory_with(
            (system_slot, struct.pack('<Q', needle)),
            (0x610, struct.pack('<Q', system_slot)),
            (array_address, pointers), (0x100, code), *fields)
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100,
            {'r13': MASK64, 'rdx': count, 'r14': array_address,
             'r15': 0x600}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('r13'), match)
        self.assertEqual(state.register('rsi'), 0x1000 + match * 16)
        layout = dbt.layout()
        self.assertGreaterEqual(
            layout['collapsed_indirect_search_entries'], match - 1)
        self.assertEqual(layout['indirect_search_cache_misses'], 1)

    def test_token_directory_reuses_one_proved_format_parse(self):
        classes = bytearray(256)
        for byte in b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz':
            classes[byte] = 3
        for byte in b'0123456789':
            classes[byte] = 4
        payload = b'foo + bar.member + "hidden" + 12ULL + baz->field\0'
        state = initial_state(memory_with(
            (0x800, classes), (0x1000, payload)), 0x100)
        dbt = X86DBT()

        first = dbt._token_directory(state, 0x1000, 0, 0x800)
        second = dbt._token_directory(state, 0x1000, 0, 0x800)

        self.assertEqual(first, second)
        self.assertEqual(first[0], frozenset((b'foo', b'bar', b'baz')))
        self.assertEqual(first[1], 0x1000 + len(payload) - 1)
        self.assertEqual(dbt.layout()['token_directory_cache_misses'], 1)
        self.assertEqual(dbt.layout()['token_directory_cache_hits'], 1)

    def test_absent_token_uses_the_directory_to_exit_the_scalar_scan(self):
        target, exit_target = 0x100, 0x180
        code = bytearray(b'\x90' * 72)
        code[:6] = bytes.fromhex('0f b6 03 83 f8 22')
        code[17:20] = bytes.fromhex('85 c0 74')
        code[20] = exit_target - (target + 21)
        code[43:46] = bytes.fromhex('0f b6 80')
        struct.pack_into('<i', code, 46, 0x800)
        code[57:60] = bytes.fromhex('48 8b 45')
        code[60] = 0xb8
        code[61:64] = bytes.fromhex('48 8b 78')
        code[64] = 8
        classes = bytearray(256)
        for byte in b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz':
            classes[byte] = 3
        for byte in b'0123456789':
            classes[byte] = 4
        payload = b'foo + bar.member + "hidden"\0'
        memory = memory_with(
            (target, code), (0x4b8, struct.pack('<Q', 0x600)),
            (0x608, struct.pack('<Q', 0x700)), (0x700, b'absent\0'),
            (0x800, classes), (0x1000, payload))
        state = initial_state(
            memory, target,
            {'rbp': 0x500, 'rbx': 0x1000, 'r8': 6, 'r14': 0})
        dbt = X86DBT()

        collapsed = dbt._collapse_token_candidate_scan(
            state, target, 3)

        self.assertEqual(collapsed.rip, exit_target)
        self.assertEqual(collapsed.register('rbx'),
                         0x1000 + len(payload) - 1)
        self.assertGreater(
            dbt.layout()['collapsed_token_candidate_bytes'], 20)

    def test_present_token_replaces_the_complete_proved_format_suffix(self):
        target, exit_target = 0x100, 0x180
        code = bytearray(b'\x90' * 72)
        code[:6] = bytes.fromhex('0f b6 03 83 f8 22')
        code[17:20] = bytes.fromhex('85 c0 74')
        code[20] = exit_target - (target + 21)
        code[43:46] = bytes.fromhex('0f b6 80')
        struct.pack_into('<i', code, 46, 0x800)
        code[57:60] = bytes.fromhex('48 8b 45')
        code[60] = 0xb8
        code[61:64] = bytes.fromhex('48 8b 78')
        code[64] = 8
        classes = bytearray(256)
        for byte in b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz':
            classes[byte] = 3
        for byte in b'0123456789':
            classes[byte] = 4
        payload = b'foo + target + target.member + "target"\0'
        memory = memory_with(
            (target, code), (0x4b8, struct.pack('<Q', 0x600)),
            (0x608, struct.pack('<Q', 0x700)),
            (0x610, struct.pack('<Q', 7)), (0x700, b'target\0'),
            (0x800, classes), (0x1000, payload))
        state = initial_state(
            memory, target,
            {'rbp': 0x500, 'rbx': 0x1000, 'r8': 6, 'r14': 0})
        dbt = X86DBT()

        collapsed = dbt._collapse_token_candidate_scan(
            state, target, 3)

        expected = b'foo + 7 + 7.member + "target"\0'
        self.assertEqual(collapsed.rip, exit_target)
        self.assertEqual(
            read_virtual(collapsed, 0x1000, len(expected)), expected)
        self.assertEqual(collapsed.register('rbx'),
                         0x1000 + len(expected) - 1)
        self.assertEqual(dbt.layout()['collapsed_token_replacements'], 2)

    def test_substring_call_uses_a_proved_direct_byte_cut(self):
        target, caller = 0x100, 0x300
        signature = bytes.fromhex(
            'f3 0f 1e fa 48 c7 c1 ff ff ff ff '
            '80 7c 0e 01 00 48 8d 49 01 75 f5 48 85 c9 74 1f')
        call = b'\xe8' + struct.pack('<i', target - (caller + 5)) + b'\xf4'
        memory = memory_with(
            (target, signature), (caller, call),
            (0x500, b'physical-array-coordinate\0'),
            (0x600, b'array\0'))
        initial = initial_state(
            memory, caller, {'rdi': 0x500, 'rsi': 0x600,
                             'rsp': 0x8000})
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial)
        second, second_boundary, _cost = dbt.run(initial)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(second_boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x509)
        self.assertEqual(second.register('rax'), 0x509)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_substring_calls'], 2)
        self.assertEqual(layout['substring_cache_misses'], 1)
        self.assertEqual(layout['substring_cache_hits'], 1)

    def test_length_call_reuses_the_terminal_byte_proof(self):
        target, caller = 0x100, 0x300
        signature = bytes.fromhex(
            'f3 0f 1e fa 55 48 89 e5 48 c7 c0 ff ff ff ff '
            '80 7c 07 01 00')
        call = b'\xe8' + struct.pack('<i', target - (caller + 5)) + b'\xf4'
        memory = memory_with(
            (target, signature), (caller, call),
            (0x500, b'direct-coordinate\0'))
        initial = initial_state(
            memory, caller, {'rdi': 0x500, 'rsp': 0x8000})
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial)
        second, second_boundary, _cost = dbt.run(initial)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(second_boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 17)
        self.assertEqual(second.register('rax'), 17)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_length_calls'], 2)
        self.assertEqual(layout['length_cache_misses'], 1)
        self.assertEqual(layout['length_cache_hits'], 1)

    def test_inactive_linked_field_scan_uses_one_proved_directory(self):
        target, caller = 0x100, 0x300
        code = bytearray(b'\0' * 0x1cf)
        signature = bytes.fromhex(
            '55 48 89 e5 41 57 41 56 41 55 41 54 53 48 83 ec 30 '
            '48 89 75 b8 48 89 7d c8 f6 47 58 10')
        code[:len(signature)] = signature
        code[0x1c8:0x1cb] = bytes.fromhex('0f b6 89')
        struct.pack_into('<i', code, 0x1cb, 0xc00)
        call_code = (b'\xe8' + struct.pack('<i', target - (caller + 5))
                     + b'\xf4')
        call, event_class = 0x500, 0x600
        head, first, second = 0x630, 0x700, 0x740
        call_value = bytearray(0x60)
        struct.pack_into('<Q', call_value, 0x10, event_class)
        class_value = bytearray(0x38)
        struct.pack_into('<Q', class_value, 0x30, first)
        first_value = bytearray(0x20)
        second_value = bytearray(0x20)
        struct.pack_into('<Q', first_value, 0, second)
        struct.pack_into('<Q', first_value, 0x18, 0x900)
        struct.pack_into('<Q', second_value, 0, head)
        struct.pack_into('<Q', second_value, 0x18, 0x940)
        mapping = bytearray(24)
        struct.pack_into('<Q', mapping, 8, 0xb00)
        classes = bytearray(256)
        for byte in b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz':
            classes[byte] = 3
        for byte in b'0123456789':
            classes[byte] = 4
        memory = memory_with(
            (target, code), (caller, call_code), (call, call_value),
            (event_class, class_value), (first, first_value),
            (second, second_value), (0x900, b'uint32_t value[alpha]\0'),
            (0x940, b'char plain\0'), (0xa00, mapping),
            (0xb00, b'missing\0'), (0xc00, classes))
        initial = initial_state(
            memory, caller,
            {'rdi': call, 'rsi': 0xa00, 'rsp': 0x8000})
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial)
        second_state, second_boundary, _cost = dbt.run(initial)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(second_boundary.operation, 'halt')
        self.assertEqual(state.register('rsp'), 0x8000)
        self.assertEqual(second_state.register('rsp'), 0x8000)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_field_scans'], 2)
        self.assertEqual(layout['collapsed_field_entries'], 4)
        self.assertEqual(layout['field_directory_cache_misses'], 1)
        self.assertEqual(layout['field_directory_cache_hits'], 1)

    def test_btf_nonmodifier_range_stops_before_the_call_barrier(self):
        target, branch_address = 0x100, 0x215
        code = bytearray(b'\x90' * 0x11b)
        code[:15] = bytes.fromhex(
            '41 8b 87 98 00 00 00 4c 89 f9 41 39 c6 73 15')
        displacement = target - (branch_address + 6)
        code[0x115:0x11b] = b'\x0f\x85' + struct.pack('<i', displacement)
        btf, table = 0x1000, 0x2000
        kinds = (1, 2, 8, 1, 2, 3)
        btf_value = bytearray(0xa0)
        struct.pack_into('<Q', btf_value, 8, table)
        struct.pack_into('<I', btf_value, 0x48, len(kinds))
        pointers = bytearray()
        types = []
        for index, kind in enumerate(kinds):
            address = 0x3000 + index * 16
            pointers.extend(struct.pack('<Q', address))
            value = bytearray(12)
            struct.pack_into('<I', value, 4, kind << 24)
            types.append((address, value))
        memory = memory_with(
            (target, code), (btf, btf_value), (table, pointers), *types)
        dbt = X86DBT()
        branch = dbt.block(initial_state(memory, branch_address))
        state = initial_state(
            memory, target,
            {'r12': len(kinds), 'r14': 0, 'r15': btf})

        first = dbt._collapse_btf_nonmodifier_span(state, branch)
        second_state = initial_state(
            memory, target,
            {'r12': len(kinds), 'r14': 3, 'r15': btf})
        second = dbt._collapse_btf_nonmodifier_span(second_state, branch)

        self.assertEqual(first.rip, target)
        self.assertEqual(first.register('r14'), 2)
        self.assertEqual(second.rip, branch_address + 6)
        self.assertEqual(second.register('r14'), len(kinds))
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_btf_types'], 5)
        self.assertEqual(layout['btf_directory_cache_misses'], 1)
        self.assertEqual(layout['btf_directory_cache_hits'], 1)

    @staticmethod
    def _btf_name_memory(*writes):
        btf, table, strings = 0x1000, 0x2000, 0x2800
        btf_value = bytearray(0xa0)
        struct.pack_into('<Q', btf_value, 8, table)
        struct.pack_into('<Q', btf_value, 0x20, strings)
        struct.pack_into('<I', btf_value, 0x44, 9)
        struct.pack_into('<I', btf_value, 0x48, 4)
        pointers = struct.pack('<4Q', 0, 0x3000, 0x3020, 0x3040)
        types = []
        for address, name_offset, kind in (
                (0x3000, 1, 4), (0x3020, 5, 4), (0x3040, 1, 5)):
            value = bytearray(12)
            struct.pack_into('<II', value, 0, name_offset, kind << 24)
            types.append((address, value))
        return memory_with(
            (btf, btf_value), (table, pointers),
            (strings, b'\0foo\0bar\0'), *types, *writes)

    def test_btf_name_call_uses_one_proved_kind_name_index(self):
        target, caller = 0x100, 0x500
        signature = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 50 48 89 75 d0')
        call = b'\xe8' + struct.pack('<i', target - (caller + 5)) + b'\xf4'
        memory = self._btf_name_memory(
            (target, signature), (caller, call), (0x4000, b'bar\0'))
        initial = initial_state(
            memory, caller,
            {'rdi': 0x1000, 'rsi': 0x4000, 'rdx': 4,
             'rsp': 0x8000})
        dbt = X86DBT()

        first, first_boundary, _cost = dbt.run(initial)
        second, second_boundary, _cost = dbt.run(initial)

        self.assertEqual(first_boundary.operation, 'halt')
        self.assertEqual(second_boundary.operation, 'halt')
        self.assertEqual(first.register('rax'), 2)
        self.assertEqual(second.register('rax'), 2)
        self.assertEqual(first.register('rsp'), 0x8000)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_btf_name_searches'], 2)
        self.assertEqual(layout['btf_name_index_misses'], 1)
        self.assertEqual(layout['btf_name_index_hits'], 1)

    def test_inflight_btf_name_search_finishes_at_the_backedge(self):
        target, branch_address = 0x100, 0x200
        signature = bytes.fromhex(
            'ff c3 44 39 e3 74 78 4c 89 f8')
        branch_code = b'\x0f\x85' + struct.pack(
            '<i', target - (branch_address + 6))
        stack = bytearray(0x40)
        struct.pack_into('<Q', stack, 0x10, 0x4000)
        memory = self._btf_name_memory(
            (target, signature), (branch_address, branch_code),
            (0x4000, b'bar\0'), (0x7fc0, stack))
        dbt = X86DBT()
        branch = dbt.block(initial_state(memory, branch_address))
        state = initial_state(
            memory, target,
            {'rbx': 0, 'rbp': 0x8000, 'r14': 4, 'r15': 0x1000})

        collapsed = dbt._collapse_btf_name_loop(state, branch)

        self.assertEqual(collapsed.rip, target + 0x84)
        self.assertEqual(collapsed.register('rbx'), 2)
        self.assertEqual(dbt.layout()['collapsed_btf_name_searches'], 1)

    def test_scalar_prefix_joins_the_byte_state_dispatch(self):
        target = 0x100
        code = bytearray(bytes.fromhex(
            '41 be 01 00 00 00 48 ff c3 0f b6 03 '
            '83 f8 22 74 0d 85 c0 74 09 45 85 f6 0f 85 00 00 00 00 f4'))
        branch_address = target + 0x18
        struct.pack_into(
            '<i', code, branch_address - target + 2,
            target - (branch_address + 6))
        payload = b'x' * 48 + b'"\0'
        memory = memory_with((target, code), (0x500, payload))
        dbt = X86DBT()
        branch = dbt.block(initial_state(memory, branch_address))
        state = initial_state(
            memory, target,
            {'rbx': 0x500, 'r14': 1})

        collapsed = dbt._collapse_prefixed_header_byte_dispatch(
            state, branch)

        self.assertEqual(collapsed.rip, target + 9)
        self.assertEqual(collapsed.register('rbx'), 0x500 + 48)
        self.assertGreaterEqual(
            dbt.layout()['collapsed_dispatch_bytes'], 46)

    def test_indexed_nul_scan_uses_one_minimized_byte_class(self):
        code = bytes.fromhex(
            '48 c7 c1 ff ff ff ff 80 7c 0e 01 00 '
            '48 8d 49 01 75 f5 48 89 c8 f4')
        dbt = X86DBT()
        payload = b'abcdefghijklmnopqrstuvwxyz\0'

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, payload)), 0x100,
            {'rsi': 0x400}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 26)
        self.assertGreaterEqual(dbt.layout()['collapsed_zero_scan_bytes'], 25)

    def test_bounded_zero_word_scan_joins_only_the_first_nonzero_word(self):
        code = bytes.fromhex(
            '48 83 c2 40 48 39 c2 73 0d 48 8b 31 48 83 c1 08 '
            '48 85 f6 74 eb f4 f4')
        words = struct.pack('<QQQQ', 0, 0, 0, 1 << 40)
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, words)), 0x100,
            {'rax': 256, 'rcx': 0x400,
             'rdx': MASK64 - 63}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.rip, 0x116)
        self.assertEqual(state.register('rdx'), 192)
        self.assertEqual(state.register('rcx'), 0x420)
        self.assertEqual(state.register('rsi'), 1 << 40)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_zero_word_bytes'], 24)
        self.assertEqual(layout['collapsed_zero_word_iterations'], 3)

    def test_bounded_zero_word_scan_preserves_the_limit_exit(self):
        code = bytes.fromhex(
            '48 83 c2 40 48 39 c2 73 0d 48 8b 31 48 83 c1 08 '
            '48 85 f6 74 eb f4 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, bytes(32))), 0x100,
            {'rax': 256, 'rcx': 0x400,
             'rdx': MASK64 - 63}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.rip, 0x117)
        self.assertEqual(state.register('rdx'), 256)
        self.assertEqual(state.register('rcx'), 0x420)
        self.assertEqual(state.register('rsi'), 0)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_zero_word_bytes'], 24)
        self.assertEqual(layout['collapsed_zero_word_iterations'], 3)

    def test_affine_page_records_materialize_once_between_sparse_barriers(self):
        target, record_entry = 0x100, 0x200
        base_pointer, records = 0x800, 0x1000
        code = bytearray(0x300)
        code[:3] = bytes.fromhex('45 85 ed')
        code[3:5] = bytes.fromhex('0f 85')
        struct.pack_into('<i', code, 5, record_entry - (target + 9))

        at = record_entry - target
        code[at:at + 3] = bytes.fromhex('48 8b 05')
        struct.pack_into('<i', code, at + 3,
                         base_pointer - (record_entry + 7))
        at += 7
        code[at:at + len(_AFFINE_PAGE_RECORD_CORE)] = \
            _AFFINE_PAGE_RECORD_CORE
        at += len(_AFFINE_PAGE_RECORD_CORE) + 20
        code[at:at + 7] = bytes.fromhex('4c 89 e0 48 c1 e0 37')
        at += 7
        code[at:at + 2] = bytes.fromhex('75 15')
        at += 2 + 21
        induction = target + at
        code[at:at + 6] = bytes.fromhex('49 ff c4 49 39 dc')
        at += 6
        outer_branch = target + at
        code[at:at + 2] = bytes.fromhex('0f 82')
        struct.pack_into('<i', code, at + 2,
                         target - (outer_branch + 6))
        code[at + 6] = 0xf4

        memory = memory_with(
            (target, code), (base_pointer, struct.pack('<Q', records)))
        dbt = X86DBT()
        for address in (target, target + 3, induction,
                        induction + 3, outer_branch):
            dbt.block(initial_state(memory, address))
        branch = dbt.blocks[outer_branch]
        state = initial_state(
            memory, target,
            {'rbx': 4, 'rsi': 0x1234, 'r12': 1, 'r13': 2})

        collapsed = dbt._collapse_affine_page_records(state, branch)

        self.assertEqual(collapsed.rip, outer_branch + 6)
        self.assertEqual(collapsed.register('r12'), 4)
        self.assertEqual(collapsed.register('rcx'), 3 * 64)
        self.assertEqual(collapsed.register('rdi'), records + 3 * 64)
        self.assertEqual(collapsed.register('rdx'), records + 3 * 64 + 8)
        for index in range(1, 4):
            record = records + index * 64
            self.assertEqual(load_virtual(collapsed, record, 8), 0x1234)
            self.assertEqual(load_virtual(collapsed, record + 8, 8),
                             record + 8)
            self.assertEqual(load_virtual(collapsed, record + 16, 8),
                             record + 8)
            self.assertEqual(load_virtual(collapsed, record + 24, 24), 0)
            self.assertEqual(load_virtual(collapsed, record + 48, 8),
                             0x00000001ffffffff)
            self.assertEqual(load_virtual(collapsed, record + 56, 8), 0)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_affine_records'], 3)
        self.assertEqual(layout['collapsed_affine_record_bytes'], 192)

    def test_relative_record_projection_batches_sorted_group_publish(self):
        loop = bytearray(_RELATIVE_RECORD_PROJECTION_CORE)
        start = 0x100
        target = start + 17
        branch_rip = start + 92
        records = 0x1000
        end = records + 48
        lower, upper = 0x2000, 0x3000
        struct.pack_into('<I', loop, 7, upper)
        struct.pack_into('<I', loop, 46, end)
        struct.pack_into('<I', loop, 82, lower)
        values = ((0x3100, 0x4000, 3),
                  (0x2100, 0x4000, 1),
                  (0x2200, 0x5000, 0))

        def encoded(index, value):
            slot = records + index * 16
            first, node, flags = value
            return struct.pack(
                '<IIQ', (first - slot) & MASK32, 0,
                ((node - slot - 8) & MASK64) | flags)

        payload = b''.join(encoded(index, value)
                           for index, value in enumerate(values))
        memory = memory_with(
            (start, loop), (records, payload),
            (0x4000, bytes(8) + struct.pack('<Q', 1)),
            (0x5000, bytes(8) + struct.pack('<Q', 3)))
        dbt = X86DBT()
        branch = dbt.block(initial_state(memory, branch_rip))
        current_raw = struct.unpack_from('<Q', payload, 8)[0]
        state = initial_state(
            memory, target,
            {'rax': records, 'rcx': values[0][0],
             'rdx': values[0][1], 'rdi': 0,
             'rsi': current_raw & ~2})

        collapsed = dbt._collapse_relative_record_projection(state, branch)

        self.assertEqual(collapsed.rip, start + len(loop))
        self.assertEqual(collapsed.register('rax'), end)
        self.assertEqual(collapsed.register('rdi'), 0x4000)
        self.assertEqual(collapsed.register('rdx'), 0x5000)
        flags = [load_virtual(
            collapsed, records + index * 16 + 8, 8) & 3
                 for index in range(3)]
        self.assertEqual(flags, [1, 3, 2])
        self.assertEqual(load_virtual(collapsed, 0x4008, 8), records | 1)
        self.assertEqual(
            load_virtual(collapsed, 0x5008, 8), records + 32 | 3)
        layout = dbt.layout()
        self.assertEqual(
            layout['collapsed_relative_record_projections'], 1)
        self.assertEqual(layout['collapsed_relative_projection_records'], 3)

    def test_forward_relative_records_collapse_before_scalar_materialization(self):
        loop = bytearray(_RELATIVE_RECORD_PROJECTION_FORWARD_CORE)
        target = 0x100
        branch_rip = target + len(loop) - 2
        storage, coordinate = 0x1000, 0x2000
        end = storage + 48
        lower, upper = 0x3000, 0x4000
        struct.pack_into('<I', loop, 30, lower)
        struct.pack_into('<I', loop, 47, upper)
        struct.pack_into('<I', loop, 106, end)
        values = ((0x4100, 0x5000, 3),
                  (0x3100, 0x5000, 1),
                  (0x3200, 0x6000, 0))

        def encoded(index, value):
            slot = coordinate + index * 16
            first, node, flags = value
            return struct.pack(
                '<IIQ', (first - slot) & MASK32, 0,
                ((node - slot - 8) & MASK64) | flags)

        payload = b''.join(encoded(index, value)
                           for index, value in enumerate(values))
        memory = memory_with(
            (target, loop), (storage, payload),
            (0x5000, bytes(8) + struct.pack('<Q', 1)),
            (0x6000, bytes(8) + struct.pack('<Q', 3)))
        dbt = X86DBT()
        branch = dbt.block(initial_state(memory, branch_rip))
        state = initial_state(
            memory, target,
            {'rax': storage, 'rbx': coordinate, 'rcx': 0})

        collapsed = dbt._collapse_relative_record_projection(state, branch)

        self.assertEqual(collapsed.rip, target + len(loop))
        self.assertEqual(collapsed.register('rax'), end)
        self.assertEqual(collapsed.register('rbx'), coordinate + 48)
        self.assertEqual(collapsed.register('rcx'), 0x6000)
        self.assertEqual(collapsed.register('rdx'), 0x6000)
        self.assertEqual(collapsed.register('rdi'), 1)
        flags = [load_virtual(
            collapsed, storage + index * 16 + 8, 8) & 3
                 for index in range(3)]
        self.assertEqual(flags, [1, 3, 2])
        self.assertEqual(load_virtual(collapsed, 0x5008, 8), coordinate | 1)
        self.assertEqual(
            load_virtual(collapsed, 0x6008, 8), coordinate + 32 | 3)
        self.assertEqual(
            dbt.layout()['collapsed_relative_projection_records'], 3)

    def test_trace_locations_append_as_one_strided_record_span(self):
        target, accepted, exit_target = 0x100, 0x16a, 0x300
        input_address, page, data = 0x600, 0x800, 0x1000
        code = bytearray(0x240)
        code[:3] = bytes.fromhex('4d 39 c1')
        code[3:5] = bytes.fromhex('0f 83')
        struct.pack_into('<i', code, 5, exit_target - (target + 9))
        code[9:22] = bytes.fromhex(
            '4d 8b 29 4d 85 ed 74 e8 4d 85 ff 75 54')
        append = bytearray(bytes.fromhex(
            '41 8b 42 10 8d 50 01 48 63 f2 48 c1 e6 04 '
            '41 0f b6 4a 14 bf 00 10 00 00 48 d3 e7 48 39 fe 76 17 '
            '49 8b 0a 48 85 c9 0f 84 ab 00 00 00 8b 41 10 '
            '8d 50 01 49 89 ca eb 03 4c 89 d1 48 8b 71 08 '
            '89 51 10 48 98 48 c1 e0 04 4c 89 2c 06 '
            '49 83 c1 08 e9 00 00 00 00'))
        direct_branch = accepted + len(append) - 5
        struct.pack_into('<i', append, len(append) - 4,
                         target - (direct_branch + 5))
        offset = accepted - target
        code[offset:offset + len(append)] = append

        header = bytearray(24)
        struct.pack_into('<Q', header, 8, data)
        struct.pack_into('<I', header, 16, 1)
        locations = (0x1111, 0x2222, 0x3333)
        records = bytearray(64)
        for index in range(1, 4):
            struct.pack_into('<Q', records, index * 16 + 8,
                             0xaaaa0000 + index)
        memory = memory_with(
            (target, code),
            (input_address, struct.pack('<QQQ', *locations)),
            (page, header), (data, records))
        dbt = X86DBT()
        branch = dbt.block(initial_state(memory, direct_branch))
        state = initial_state(
            memory, target,
            {'r8': input_address + 24, 'r9': input_address,
             'r10': page, 'r15': 1})

        collapsed = dbt._collapse_ftrace_location_span(state, branch)

        self.assertEqual(collapsed.rip, exit_target)
        self.assertEqual(collapsed.register('r9'), input_address + 24)
        self.assertEqual(collapsed.register('r13'), locations[-1])
        self.assertEqual(collapsed.register('rax'), 48)
        self.assertEqual(collapsed.register('rdx'), 4)
        self.assertEqual(load_virtual(collapsed, page + 16, 4), 4)
        for index, location in enumerate(locations, 1):
            self.assertEqual(load_virtual(
                collapsed, data + index * 16, 8), location)
            self.assertEqual(load_virtual(
                collapsed, data + index * 16 + 8, 8),
                0xaaaa0000 + index)
        self.assertEqual(dbt.layout()['collapsed_ftrace_locations'], 3)

    def test_indirect_string_table_uses_one_proved_suffix_directory(self):
        target, comparator = 0x200, 0x1000
        table, table_stop = 0x800, 0x818
        exit_target, update = 0x290, 0x270
        match_target = exit_target + 2
        code = bytearray(0x100)
        code[:3] = bytes.fromhex('49 c7 c6')
        struct.pack_into('<i', code, 3, table)
        at = 7
        code[at:at + 3] = bytes.fromhex('49 81 fe')
        struct.pack_into('<i', code, at + 3, table_stop)
        at += 7
        code[at:at + 2] = bytes.fromhex('0f 83')
        struct.pack_into('<i', code, at + 2,
                         exit_target - (target - 7 + at + 6))
        at += 6
        code[at:at + 9] = bytes.fromhex(
            '49 8b 1e 4c 8b 3b 4d 85 ff')
        at += 9
        code[at:at + 2] = bytes.fromhex('0f 84')
        struct.pack_into('<i', code, at + 2,
                         update - (target - 7 + at + 6))
        at += 6
        code[at:at + 12] = bytes.fromhex(
            '49 83 c7 03 48 8d 7c 24 03 4c 89 fe')
        at += 12
        call_address = target - 7 + at
        code[at] = 0xe8
        struct.pack_into('<i', code, at + 1,
                         comparator - (call_address + 5))
        at += 5
        code[at:at + 3] = bytes.fromhex('85 c0 74')
        code[at + 3] = (match_target - (target - 7 + at + 4)) & 0xff
        update_offset = update - (target - 7)
        code[update_offset:update_offset + 4] = bytes.fromhex(
            '49 83 c6 08')
        direct_branch = update + 4
        code[update_offset + 4] = 0xe9
        struct.pack_into('<i', code, update_offset + 5,
                         target - (direct_branch + 5))
        code[exit_target - (target - 7):
             exit_target - (target - 7) + 3] = bytes.fromhex('31 db f4')

        compare_function = bytes.fromhex(
            'f3 0f 1e fa 55 48 89 e5 31 c0 '
            '0f b6 0c 07 3a 0c 06 75 10 48 ff c0 '
            '84 c9 75 f0 31 c0 5d 2e e9 00 00 00 00 '
            '0f 93 c0 0f b6 c0 8d 04 45 ff ff ff ff 5d '
            '2e e9 00 00 00 00')
        metadata = (0x900, 0x920, 0x940)
        names = (0xa00, 0xa20, 0xa40)
        memory = memory_with(
            (target - 7, code), (comparator, compare_function),
            (table, struct.pack('<QQQ', *metadata)),
            (metadata[0], struct.pack('<Q', names[0])),
            (metadata[1], struct.pack('<Q', names[1])),
            (metadata[2], struct.pack('<Q', names[2])),
            (names[0], b'sys_close\0'),
            (names[1], b'sys_open\0'),
            (names[2], b'sys_read\0'),
            (0x1200, b'__x64_sys_open\0'))
        dbt = X86DBT()
        branch = dbt.block(initial_state(memory, direct_branch))

        for _unused in range(2):
            state = initial_state(
                memory, target,
                {'r14': table, 'rsp': 0x1200})
            collapsed = dbt._collapse_indirect_string_table_span(
                state, branch)
            self.assertEqual(collapsed.rip, match_target)
            self.assertEqual(collapsed.register('rbx'), metadata[1])
            self.assertEqual(collapsed.register('r14'), table + 8)
            self.assertEqual(collapsed.register('r15'), names[1] + 3)
            self.assertEqual(collapsed.register('rdi'), 0x1200 + 9)
            self.assertEqual(collapsed.register('rsi'), names[1] + 3)

        layout = dbt.layout()
        self.assertEqual(layout['collapsed_indirect_string_entries'], 4)
        self.assertEqual(layout['indirect_string_cache_misses'], 1)
        self.assertEqual(layout['indirect_string_cache_hits'], 1)

    def test_invariant_record_lane_is_one_strided_store_span(self):
        code = bytes.fromhex(
            '49 8b 74 24 08 4c 89 3c 0e 48 ff c2 '
            '49 63 74 24 10 48 83 c1 10 48 39 f2 7c e6 f4')
        header, data = 0x400, 0x800
        metadata = bytearray(24)
        struct.pack_into('<Q', metadata, 8, data)
        struct.pack_into('<I', metadata, 16, 4)
        records = bytearray(64)
        for index in range(4):
            struct.pack_into('<Q', records, index * 16,
                             0x1000 + index)
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (header, metadata), (data, records)),
            0x100,
            {'rcx': 8, 'rdx': 0, 'r12': header,
             'r15': 0xfeedfacecafebeef}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rdx'), 4)
        self.assertEqual(state.register('rcx'), 8 + 4 * 16)
        for index in range(4):
            self.assertEqual(load_virtual(
                state, data + index * 16, 8), 0x1000 + index)
            self.assertEqual(load_virtual(
                state, data + index * 16 + 8, 8),
                0xfeedfacecafebeef)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_strided_store_bytes'], 24)
        self.assertEqual(layout['collapsed_strided_store_iterations'], 3)

    def test_in_place_word_scale_is_one_physical_record_map(self):
        code = bytes.fromhex(
            '48 8b 93 d0 00 00 00 8b 34 82 0f af 73 20 89 34 82 '
            '48 8b 93 d0 00 00 00 8b 74 82 04 0f af 73 20 '
            '89 74 82 04 48 83 c0 02 48 39 c1 75 d3 f4')
        metadata, words = 0x800, 0x1000
        values = tuple(range(1, 9))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, code),
                (metadata + 0x20, struct.pack('<I', 7)),
                (metadata + 0xd0, struct.pack('<Q', words)),
                (words, struct.pack('<8I', *values))),
            0x100, {'rbx': metadata, 'rax': 0, 'rcx': len(values)}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), len(values))
        self.assertEqual(state.register('rdx'), words)
        self.assertEqual(state.register('rsi'), values[-1] * 7)
        self.assertEqual(
            tuple(struct.unpack('<8I', read_virtual(state, words, 32))),
            tuple(value * 7 for value in values))
        self.assertEqual(
            dbt.layout()['collapsed_record_multiply_words'], 6)

    def test_sequential_freelist_is_one_encoded_link_projection(self):
        code = bytes.fromhex(
            '44 8b 6b 20 4f 8d 3c 2c 66 90 4c 8b 5b 50 '
            '4d 85 db 75 3f 45 85 ed 0f 84 7d 03 00 00 '
            '8b 43 30 4a 8d 0c 20 48 0f c9 '
            '48 8b 93 c0 00 00 00 4c 31 fa 48 31 ca '
            '4a 89 14 20 41 ff c6 0f b7 46 2a '
            '25 ff 7f 00 00 ff c8 4d 89 fc 41 39 c6 7c b3 f4')
        metadata, slab, objects = 0x800, 0xc00, 0x1000
        stride, offset, secret, count = 16, 8, 0x123456789abcdef0, 4
        header = bytearray(256)
        struct.pack_into('<I', header, 0x20, stride)
        struct.pack_into('<I', header, 0x30, offset)
        struct.pack_into('<Q', header, 0xc0, secret)
        slab_record = bytearray(64)
        struct.pack_into('<H', slab_record, 0x2a, count)
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (metadata, header),
                        (slab, slab_record), (objects, bytes(128))),
            0x100, {'rbx': metadata, 'r12': objects,
                    'r14': 0, 'rsi': slab}))

        def byte_swap(value):
            return int.from_bytes(value.to_bytes(8, 'little'), 'big')

        self.assertEqual(boundary.operation, 'halt')
        for index in range(count - 1):
            current = objects + index * stride
            following = current + stride
            expected = secret ^ following ^ byte_swap(current + offset)
            self.assertEqual(load_virtual(state, current + offset, 8),
                             expected & MASK64)
        self.assertEqual(state.register('r12'), objects + 3 * stride)
        self.assertEqual(state.register('r15'), objects + 3 * stride)
        self.assertEqual(state.register('r14'), count - 1)
        self.assertEqual(
            dbt.layout()['collapsed_sequential_freelist_links'], 2)

    def test_random_freelist_is_one_selected_coordinate_scatter(self):
        code = bytes.fromhex(
            '48 8b 83 d0 00 00 00 46 8b 3c a0 49 ff c4 '
            '49 39 fc 4d 0f 43 e2 45 39 f8 76 ed 4d 01 cf '
            '66 90 4c 8b 5b 50 4d 85 db 75 3d 4d 39 fd '
            '0f 84 bd 01 00 00 8b 43 30 4a 8d 0c 28 48 0f c9 '
            '48 8b 93 c0 00 00 00 4c 31 fa 48 31 ca '
            '4a 89 14 28 49 ff c6 0f b7 46 2a 25 ff 7f 00 00 '
            '4d 89 fd 49 39 c6 72 a0 f4')
        metadata, slab, start, sequence = 0x800, 0xc00, 0x1000, 0x1400
        offsets = (0, 16, 32, 48)
        offset, secret = 8, 0x123456789abcdef0
        header = bytearray(256)
        struct.pack_into('<I', header, 0x30, offset)
        struct.pack_into('<Q', header, 0xc0, secret)
        struct.pack_into('<Q', header, 0xd0, sequence)
        slab_record = bytearray(64)
        struct.pack_into('<H', slab_record, 0x2a, len(offsets))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, code), (metadata, header), (slab, slab_record),
                (start, bytes(128)),
                (sequence, struct.pack('<4I', *offsets))),
            0x100, {
                'rbx': metadata, 'rsi': slab, 'rdi': len(offsets),
                'r8': 64, 'r9': start, 'r10': 0,
                'r12': 1, 'r13': start, 'r14': 1,
            }))

        def byte_swap(value):
            return int.from_bytes(value.to_bytes(8, 'little'), 'big')

        self.assertEqual(boundary.operation, 'halt')
        for current_offset, next_offset in zip(offsets, offsets[1:]):
            current = start + current_offset
            following = start + next_offset
            expected = secret ^ following ^ byte_swap(current + offset)
            self.assertEqual(load_virtual(state, current + offset, 8),
                             expected & MASK64)
        self.assertEqual(state.register('r12'), 0)
        self.assertEqual(state.register('r13'), start + offsets[-1])
        self.assertEqual(state.register('r14'), len(offsets))
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_random_freelist_links'], 2)
        self.assertEqual(layout['collapsed_random_freelist_words'], 2)

    def test_sparse_record_words_share_one_physical_projection(self):
        # btrq $13,(%rdx); movl $0,0x34(%rdx); add $64,%rdx;
        # dec %ecx; jne loop; hlt
        code = bytes.fromhex(
            '48 0f ba 32 0d c7 42 34 00 00 00 00 '
            '48 83 c2 40 ff c9 75 ec f4')
        data = 0x800
        records = bytearray(4 * 64)
        expected_flags = []
        for index in range(4):
            flags = (0x1000000000000000 | (1 << 13) | index)
            expected_flags.append(flags & ~(1 << 13))
            struct.pack_into('<Q', records, index * 64, flags)
            struct.pack_into('<Q', records, index * 64 + 16,
                             0xfeedface00000000 + index)
            struct.pack_into('<I', records, index * 64 + 52, 0xdeadbeef)
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (data, records)), 0x100,
            {'rdx': data, 'rcx': 4}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rdx'), data + 4 * 64)
        self.assertEqual(state.register('rcx'), 0)
        for index in range(4):
            record = data + index * 64
            self.assertEqual(load_virtual(state, record, 8),
                             expected_flags[index])
            self.assertEqual(load_virtual(state, record + 16, 8),
                             0xfeedface00000000 + index)
            self.assertEqual(load_virtual(state, record + 52, 4), 0)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_strided_store_bytes'], 36)
        self.assertEqual(layout['collapsed_strided_store_iterations'], 3)

    def test_page_reservation_uses_sparse_record_bit_projection(self):
        target = 0x100
        code = bytearray(bytes.fromhex(
            '4d 39 f7 73 5a 4d 89 fd 49 c1 e5 06 '
            '4c 03 2d 00 00 00 00 4c 0f a3 25 00 00 00 00 73 1b '
            '4a 8b 04 e5 00 00 00 00 '
            '4c 3b b8 80 1a 02 00 72 0a 4c 89 ff 89 de '
            'e8 00 00 00 00 49 0f ba 6d 00 0d 49 ff c7 '
            '4d 39 f7 73 19 4c 89 f8 48 c1 e0 37 75 b1'))
        vmemmap_slot, node_states, node_data_base = 0x500, 0x508, 0x600
        struct.pack_into('<i', code, 15, vmemmap_slot - (target + 19))
        struct.pack_into('<i', code, 23, node_states - (target + 27))
        struct.pack_into('<i', code, 33, node_data_base)
        code.extend(bytes(0x5f - len(code)))
        code.append(0xf4)
        vmemmap = 0x1000
        records = bytearray(6 * 64)
        for pfn in range(1, 6):
            struct.pack_into('<Q', records, pfn * 64,
                             0x1000000000000000 | pfn)
        memory = memory_with(
            (target, code),
            (vmemmap_slot, struct.pack('<Q', vmemmap)),
            (node_states, struct.pack('<Q', 0)),
            (vmemmap, records),
        )
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory, target, {'r12': 0, 'r14': 6, 'r15': 1}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('r15'), 6)
        self.assertEqual(state.register('r13'), vmemmap + 5 * 64)
        for pfn in range(1, 6):
            self.assertEqual(
                load_virtual(state, vmemmap + pfn * 64, 8),
                0x1000000000000000 | (1 << 13) | pfn)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_strided_store_bytes'], 32)
        self.assertEqual(layout['collapsed_strided_store_iterations'], 4)

    def test_byte_or_nul_search_stops_at_the_requested_coordinate(self):
        code = bytes.fromhex(
            '48 89 f8 0f b6 0f 40 38 f1 74 10 84 c9 74 0d '
            '0f b6 48 01 48 ff c0 40 38 f1 75 f0 f4 31 c0 f4')
        dbt = X86DBT()
        payload = b'abcdefghijklmnopqrstuvwxyz\0'

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, payload)), 0x100,
            {'rdi': 0x400, 'rsi': ord('z')}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x400 + 25)
        self.assertGreaterEqual(dbt.layout()['collapsed_search_bytes'], 24)

    def test_byte_or_nul_search_preserves_the_not_found_result(self):
        code = bytes.fromhex(
            '48 89 f8 0f b6 0f 40 38 f1 74 10 84 c9 74 0d '
            '0f b6 48 01 48 ff c0 40 38 f1 75 f0 f4 31 c0 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, b'ordinary\0')), 0x100,
            {'rdi': 0x400, 'rsi': ord('!')}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0)

    def test_outer_substring_loop_skips_disproved_candidate_coordinates(self):
        code = bytes.fromhex(
            '49 89 f8 49 89 f1 48 83 f9 01 '
            '41 0f b6 18 41 3a 19 74 0c '
            '48 ff ca 48 ff c7 48 39 ca 73 e2 f4 f4')
        dbt = X86DBT()
        payload = b'abcdefghijklmnopqrstuvwxyz'

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, payload), (0x500, b'z')),
            0x100, {'rcx': 1, 'rdx': len(payload),
                    'rdi': 0x400, 'rsi': 0x500}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rdi'), 0x400 + 25)
        self.assertGreaterEqual(
            dbt.layout()['collapsed_substring_candidates'], 24)

    def test_legacy_high_byte_register_is_not_rex_low_byte(self):
        # mov eax,0; mov ah,0x12; mov [rbx],ah; mov ah,0;
        # mov ah,[rbx]; hlt
        code = bytes.fromhex(
            'b8 00 00 00 00 b4 12 88 23 b4 00 8a 23 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100, {'rbx': 0x400}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x1200)
        self.assertEqual(state.memory.read(0x400, 1), b'\x12')

    def test_32_bit_register_move_clears_the_upper_half(self):
        # mov eax,edi; hlt
        code = bytes.fromhex('89 f8 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100,
            {'rdi': 0x11223344aabbccdd}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0xaabbccdd)

    def test_word_immediate_does_not_consume_the_following_instruction(self):
        code = bytes.fromhex(
            '66 81 63 54 20 fe '
            '48 89 9b e8 00 00 00 f4')
        memory = memory_with(
            (0x100, code),
            (0x454, b'\xff\xff'))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'rbx': 0x400}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.memory.read(0x454, 2), b' \xfe')
        self.assertEqual(state.memory.read(0x4e8, 8),
                         struct.pack('<Q', 0x400))
        self.assertEqual(state.rip, 0x10e)

    def test_register_exchange_is_a_pure_renaming(self):
        dbt = X86DBT()
        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('48 87 d8 f4'))), 0x100,
            {'rax': 1, 'rbx': 2}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual((state.register('rax'), state.register('rbx')),
                         (2, 1))

    def test_memory_exchange_uses_one_byte_ssa_cut(self):
        dbt = X86DBT()
        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, bytes.fromhex('48 87 03 f4')),
                (0x400, struct.pack('<Q', 2))),
            0x100, {'rax': 1, 'rbx': 0x400}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 2)
        self.assertEqual(state.memory.read(0x400, 8), struct.pack('<Q', 1))
        self.assertEqual(dbt.layout()['persistent_cuts'], 1)

    def test_cdqe_sign_extends_the_accumulator(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex(
                'b8 ff ff ff ff 48 98 f4'))), 0x100))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), MASK64)

    def test_long_mode_indirect_jump_reads_a_64_bit_target(self):
        target = 0xffffffff81234567
        memory = memory_with(
            (0x100, bytes.fromhex('ff 25 00 00 00 00')),
            (0x106, struct.pack('<Q', target)))
        dbt = X86DBT()

        state, boundary, _cost = dbt.step(initial_state(memory, 0x100))

        self.assertIsNone(boundary)
        self.assertEqual(state.rip, target)

    def test_endbr64_is_a_state_free_landing_marker(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('f3 0f 1e fa f4'))), 0x100))

        self.assertEqual(boundary.operation, 'halt')
        self.assertTrue(state.halted)

    def test_push_flags_uses_the_regular_stack_state(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('9c 58 f4'))), 0x100,
            {'rsp': 0x800}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 2)
        self.assertEqual(state.register('rsp'), 0x800)

    def test_four_level_translation_reaches_one_physical_page(self):
        flags = PRESENT | WRITABLE
        memory = memory_with(
            (0x1000, struct.pack('<Q', 0x2000 | flags)),
            (0x2000, struct.pack('<Q', 0x3000 | flags)),
            (0x3000, struct.pack('<Q', 0x4000 | flags)),
            (0x4000 + 8, struct.pack('<Q', 0x5000 | flags)),
            (0x5000 + 0x234, b'qm'))
        state = initial_state(
            memory, cr0=CR0_PAGING, cr3=0x1000)

        self.assertEqual(translate(state, 0x1234), 0x5234)
        self.assertEqual(read_virtual(state, 0x1234, 2), b'qm')
        self.assertEqual(len(state.translations), 1)

    def test_clock_uses_the_same_request_response_event(self):
        memory = memory_with((0x100, bytes.fromhex('0f 31 f4')))
        runtime = X86Machine()
        state = runtime.start(initial_state(memory, 0x100))

        state, request = runtime.machine_step(state)
        self.assertEqual(request.operation, 'clock')
        self.assertIs(state.pending, request)

        state, boundary = runtime.machine_step(
            state, MachineEvent('clock', request.coordinate,
                                0x1122334455667788))
        self.assertIsNone(boundary)
        self.assertTrue(state.stopped)
        self.assertEqual(state.cpu.register('rax'), 0x55667788)
        self.assertEqual(state.cpu.register('rdx'), 0x11223344)
        self.assertEqual(dict(state.cpu.msrs)[IA32_TIME_STAMP_COUNTER],
                         0x1122334455667788)

    def test_affine_clock_sequence_stays_inside_one_persistent_cut(self):
        memory = memory_with((0x100, bytes.fromhex('0f 31 0f 31 f4')))
        runtime = X86Machine()
        state = runtime.start(initial_state(memory, 0x100))

        state, event = runtime.machine_step(state, clock_step=7)

        self.assertIsNone(event)
        self.assertTrue(state.stopped)
        self.assertEqual(state.cpu.register('rax'), 14)
        self.assertEqual(dict(state.cpu.msrs)[IA32_TIME_STAMP_COUNTER], 14)
        self.assertEqual(runtime.affine_clock_events, 2)

    def test_replayable_clock_variation_changes_successive_deltas(self):
        memory = memory_with((0x100, bytes.fromhex('0f 31 0f 31 f4')))
        runtime = X86Machine()
        state = runtime.start(initial_state(memory, 0x100))

        state, event = runtime.machine_step(
            state, clock_step=1 << 20, clock_variation_bits=12)

        first = advance_virtual_clock(0, 1 << 20, 12)
        second = advance_virtual_clock(first, 1 << 20, 12)
        self.assertIsNone(event)
        self.assertTrue(state.stopped)
        self.assertNotEqual(first, second - first)
        self.assertEqual(
            dict(state.cpu.msrs)[IA32_TIME_STAMP_COUNTER], second)

    def test_clock_response_composes_the_proved_store_return_slice(self):
        continuation = bytes.fromhex(
            '48 c1 e2 20 48 09 c2 75 08 '
            'e8 00 00 00 00 48 89 c2 48 89 13 5b 5d c3')
        stack = struct.pack('<QQQ', 0xaaaa, 0xbbbb, 0x200)
        memory = memory_with(
            (0x100, bytes.fromhex('0f 31') + continuation),
            (0x200, bytes.fromhex('f4')), (0x800, stack))
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory, 0x100,
            {'rbx': 0x900, 'rbp': 0x808, 'rsp': 0x800}))

        state, event = runtime.machine_step(
            state, clock_step=0x1122334455667788)

        self.assertIsNone(event)
        self.assertTrue(state.stopped)
        self.assertEqual(
            load_virtual(state.cpu, 0x900, 8), 0x1122334455667788)
        self.assertEqual(state.cpu.register('rax'), 0x55667788)
        self.assertEqual(state.cpu.register('rdx'), 0x1122334455667788)
        self.assertEqual(state.cpu.register('rbx'), 0xaaaa)
        self.assertEqual(state.cpu.register('rbp'), 0xbbbb)
        self.assertEqual(state.cpu.register('rsp'), 0x818)
        self.assertEqual(
            runtime.dbt.layout()['collapsed_clock_store_returns'], 1)

    def test_affine_clock_rejects_a_nonprogressing_step(self):
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory_with((0x100, bytes.fromhex('f4'))), 0x100))
        with self.assertRaises(ValueError):
            runtime.machine_step(state, clock_step=0)

    def test_rdrand_uses_one_entropy_request_response_event(self):
        # rdrand rax; hlt
        memory = memory_with((0x100, bytes.fromhex('48 0f c7 f0 f4')))
        runtime = X86Machine()
        state = runtime.start(initial_state(memory, 0x100))

        state, request = runtime.machine_step(state)
        self.assertEqual(request.operation, 'entropy')
        self.assertIs(state.pending, request)

        state, boundary = runtime.machine_step(
            state, MachineEvent('entropy', request.coordinate,
                                0x1122334455667788))
        self.assertIsNone(boundary)
        self.assertTrue(state.stopped)
        self.assertEqual(state.cpu.register('rax'), 0x1122334455667788)
        self.assertTrue(state.cpu.rflags & RFLAGS_CARRY)

    def test_entropy_event_forks_one_retained_physical_cut(self):
        # mov [rbx],1; rdrand rax; mov [rbx+1],2; hlt
        code = bytes.fromhex(
            'c6 03 01 48 0f c7 f0 c6 43 01 02 f4')
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory_with((0x100, code)), 0x100, {'rbx': 0x400}))

        observed, request = runtime.machine_step(state)

        self.assertEqual(request.operation, 'entropy')
        self.assertIsInstance(observed.cpu.memory, MemoryCut)
        self.assertTrue(observed.cpu.memory.sealed)
        self.assertEqual(observed.cpu.memory.read(0x400, 2), b'\x01\0')
        following, boundary = runtime.machine_step(
            observed, MachineEvent('entropy', request.coordinate, 7))
        self.assertIsNone(boundary)
        self.assertTrue(following.stopped)
        self.assertIsNot(following.cpu.memory, observed.cpu.memory)
        self.assertEqual(observed.cpu.memory.read(0x400, 2), b'\x01\0')
        self.assertEqual(following.cpu.memory.read(0x400, 2), b'\x01\x02')
        layout = runtime.dbt.layout()
        self.assertEqual(layout['persistent_cuts'], 2)
        self.assertEqual(layout['published_pages'], 2)
        self.assertEqual(layout['retained_cut_pages'], 2)
        self.assertEqual(layout['materialized_pages'], 0)

    def test_model_specific_registers_remain_in_machine_state(self):
        # wrmsr IA32_GS_BASE; clear eax/edx; rdmsr; hlt
        code = bytes.fromhex(
            'b9 01 01 00 c0 b8 88 77 66 55 ba 44 33 22 11 '
            '0f 30 31 c0 31 d2 0f 32 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x55667788)
        self.assertEqual(state.register('rdx'), 0x11223344)
        self.assertEqual(dict(state.msrs)[0xc0000101],
                         0x1122334455667788)

    def test_swapgs_exchanges_user_and_kernel_bases(self):
        state, boundary, _cost = X86DBT().run(initial_state(
            memory_with((0x100, bytes.fromhex('0f 01 f8 f4'))), 0x100,
            msrs=((IA32_GS_BASE, 0x1111),
                  (IA32_KERNEL_GS_BASE, 0x2222))))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(dict(state.msrs)[IA32_GS_BASE], 0x2222)
        self.assertEqual(dict(state.msrs)[IA32_KERNEL_GS_BASE], 0x1111)

    def test_bit_test_reset_publishes_the_selected_bit_as_carry(self):
        # mov edx,4; btr edx,2; jb good; bad: mov eax,99; hlt;
        # good: mov eax,42; hlt
        code = bytes.fromhex(
            'ba 04 00 00 00 0f ba f2 02 72 06 '
            'b8 63 00 00 00 f4 b8 2a 00 00 00 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)
        self.assertEqual(state.register('rdx'), 0)

    def test_memory_bit_set_updates_memory_and_carry(self):
        # bts qword [rbx],63 twice; the second operation must set carry.
        code = bytes.fromhex(
            '48 0f ba 2b 3f 48 0f ba 2b 3f 72 06 '
            'b8 63 00 00 00 f4 b8 2a 00 00 00 f4')
        dbt = X86DBT()
        memory = memory_with((0x100, code), (0x400, bytes(8)))

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'rbx': 0x400}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)
        self.assertEqual(read_virtual(state, 0x400, 8),
                         struct.pack('<Q', 1 << 63))

    def test_gs_override_adds_the_model_specific_base(self):
        # mov qword ptr gs:[rip+disp32],rax
        code = bytes.fromhex('65 48 89 05 f8 00 00 00 f4')
        dbt = X86DBT()
        memory = memory_with((0x100, code), (0x300, bytes(8)))

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'rax': 42}, msrs=((IA32_GS_BASE, 0x100),)))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x300, 8),
                         struct.pack('<Q', 42))

    def test_two_operand_imul_is_a_pure_multiply_with_signed_overflow(self):
        # imul rax,rcx; jo good; bad: mov eax,99; hlt; good: ...
        code = bytes.fromhex(
            '48 b8 ff ff ff ff ff ff ff 7f b9 02 00 00 00 '
            '48 0f af c1 70 06 b8 63 00 00 00 f4 '
            'b8 2a 00 00 00 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)

    def test_counted_unrolled_memset_publishes_one_direct_repeat(self):
        # dec rcx; two qword stores; lea rdi,[rdi+16]; jne loop; hlt
        code = bytes.fromhex(
            '48 ff c9 48 89 07 48 89 47 08 '
            '48 8d 7f 10 75 f0 f4')
        pattern = 0x0102030405060708
        dbt = X86DBT(enable_function_oracles=False)
        memory = memory_with((0x100, code), (0x400, bytes(64)))

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100,
            {'rax': pattern, 'rcx': 4, 'rdi': 0x400}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rcx'), 0)
        self.assertEqual(state.register('rdi'), 0x440)
        self.assertEqual(read_virtual(state, 0x400, 64),
                         struct.pack('<Q', pattern) * 8)
        self.assertEqual(dbt.layout()['collapsed_repeat_bytes'], 48)
        self.assertEqual(dbt.layout()['collapsed_repeat_iterations'], 3)
        self.assertEqual(dbt.layout()['recurrence_cuts'], 1)
        self.assertEqual((dbt.layout()['recurrence_cut_work'],
                          dbt.layout()['recurrence_cut_span']), (4, 2))

    def test_single_store_counted_memset_folds_the_branch_block_lea(self):
        # dec ecx; mov [rdi],rax; lea rdi,[rdi+8]; jne loop; hlt
        code = bytes.fromhex('ff c9 48 89 07 48 8d 7f 08 75 f5 f4')
        pattern = 0x0102030405060708
        dbt = X86DBT()
        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code), (0x400, bytes(32))), 0x100,
            {'rax': pattern, 'rcx': 4, 'rdi': 0x400}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rcx'), 0)
        self.assertEqual(state.register('rdi'), 0x420)
        self.assertEqual(read_virtual(state, 0x400, 32),
                         struct.pack('<Q', pattern) * 4)
        self.assertEqual(dbt.layout()['collapsed_repeat_bytes'], 24)
        self.assertEqual(dbt.layout()['collapsed_repeat_iterations'], 3)

    def test_direct_jump_to_return_thunk_is_one_control(self):
        code = bytes.fromhex('e9 fb 00 00 00 f4')
        memory = memory_with(
            (0x100, code), (0x200, b'\xc3'),
            (0x8000, struct.pack('<Q', 0x105)))
        dbt = X86DBT(enable_function_oracles=False)

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'rsp': 0x8000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rsp'), 0x8008)
        self.assertEqual(dbt.layout()['collapsed_return_branches'], 1)

    def test_register_projection_call_is_one_pure_state_cut(self):
        target, return_thunk = 0x200, 0x300
        function = (
            bytes.fromhex('f3 0f 1e fa 48 89 f8 e9')
            + struct.pack('<i', return_thunk - (target + 12)))
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (return_thunk, b'\xc3')),
            0x100, {'rdi': 0x123456789abcdef0, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x123456789abcdef0)
        self.assertEqual(state.register('rsp'), 0x9000)
        self.assertEqual(
            dbt.layout()['collapsed_register_projection_calls'], 1)

    def test_machine_flags_leaf_calls_do_not_materialize_the_stack(self):
        save, disable, return_thunk = 0x200, 0x300, 0x400
        caller = (
            b'\xe8' + struct.pack('<i', save - 0x105)
            + b'\xe8' + struct.pack('<i', disable - 0x10a)
            + b'\xf4')
        save_leaf = (bytes.fromhex('f3 0f 1e fa 9c 58 e9')
                     + struct.pack('<i', return_thunk - (save + 11)))
        disable_leaf = (bytes.fromhex('f3 0f 1e fa fa e9')
                        + struct.pack('<i', return_thunk - (disable + 10)))
        flags = 2 | (1 << 9) | (1 << 6)
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (save, save_leaf),
                        (disable, disable_leaf), (return_thunk, b'\xc3')),
            0x100, {'rsp': 0}, rflags=flags))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), flags)
        self.assertEqual(state.register('rsp'), 0)
        self.assertFalse(state.rflags & (1 << 9))
        self.assertEqual(dbt.layout()['collapsed_machine_leaf_calls'], 2)

    def test_page_bootmem_leaf_projects_only_metadata_lanes(self):
        target, return_thunk, page = 0x200, 0x400, 0x800
        function = bytearray(bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '83 fa 10 73 26 48 89 f8 48 c1 e8 3c 75 1f '
            'f0 80 4e 01 40 48 c1 e7 04 89 d0 48 09 f8 '
            '48 89 46 28 f0 ff 46 34 5d 2e e9 00 00 00 00 '
            '0f 0b 0f 0b'))
        struct.pack_into('<i', function, 52,
                         return_thunk - (target + 56))
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        record = bytearray(64)
        record[1] = 1
        struct.pack_into('<I', record, 0x34, 2)
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (return_thunk, b'\xc3'), (page, record)),
            0x100, {'rdi': 0x123, 'rsi': page,
                    'rdx': 3, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(load_virtual(state, page + 1, 1), 0x41)
        self.assertEqual(load_virtual(state, page + 0x28, 8), 0x1233)
        self.assertEqual(load_virtual(state, page + 0x34, 4), 3)
        self.assertEqual(state.register('rax'), 0x1233)
        self.assertEqual(state.register('rdi'), 0x1230)
        self.assertEqual(state.register('rsp'), 0x9000)
        self.assertEqual(dbt.layout()['collapsed_page_bootmem_calls'], 1)

    def test_page_bootmem_loop_is_one_physical_record_projection(self):
        target, return_thunk, pages = 0x500, 0x700, 0x1000
        function = bytearray(bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '83 fa 10 73 26 48 89 f8 48 c1 e8 3c 75 1f '
            'f0 80 4e 01 40 48 c1 e7 04 89 d0 48 09 f8 '
            '48 89 46 28 f0 ff 46 34 5d 2e e9 00 00 00 00 '
            '0f 0b 0f 0b'))
        struct.pack_into('<i', function, 52,
                         return_thunk - (target + 56))
        caller = bytearray(bytes.fromhex(
            '4c 8d 7e 40 4c 89 f7 ba 01 00 00 00 '
            'e8 00 00 00 00 4c 89 fe ff cb 75 e8 f4'))
        struct.pack_into('<i', caller, 13, target - (0x100 + 17))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (return_thunk, b'\xc3'), (pages, bytes(256))),
            0x100, {'rsi': pages, 'r14': 3,
                    'rbx': 4, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        for index in range(4):
            page = pages + index * 64
            self.assertEqual(load_virtual(state, page + 1, 1), 0x40)
            self.assertEqual(load_virtual(state, page + 0x28, 8), 0x31)
            self.assertEqual(load_virtual(state, page + 0x34, 4), 1)
        self.assertEqual(state.register('rsi'), pages + 256)
        self.assertEqual(state.register('r15'), pages + 256)
        self.assertEqual(state.register('rbx'), 0)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_page_bootmem_calls'], 4)
        self.assertEqual(layout['collapsed_page_bootmem_records'], 3)

    def test_stack_shaped_store_leaf_is_one_word_projection(self):
        target, return_thunk, address = 0x200, 0x400, 0x800
        function = bytearray(bytes.fromhex(
            'f3 0f 1e fa 55 48 89 e5 50 48 89 75 f8 '
            '48 8b 45 f8 48 89 07 48 83 c4 08 5d 2e e9 '
            '00 00 00 00'))
        struct.pack_into('<i', function, 27,
                         return_thunk - (target + 31))
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        value = 0x123456789abcdef0
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function),
                        (return_thunk, b'\xc3'), (address, bytes(8))),
            0x100, {'rdi': address, 'rsi': value, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(load_virtual(state, address, 8), value)
        self.assertEqual(state.register('rax'), value)
        self.assertEqual(state.register('rsp'), 0x9000)
        self.assertEqual(dbt.layout()['collapsed_store_word_calls'], 1)

    def test_indirect_store_loop_is_one_physical_repeat(self):
        function_address, return_thunk = 0x500, 0x700
        function = bytearray(bytes.fromhex(
            'f3 0f 1e fa 55 48 89 e5 50 48 89 75 f8 '
            '48 8b 45 f8 48 89 07 48 83 c4 08 5d 2e e9 '
            '00 00 00 00'))
        struct.pack_into('<i', function, 27,
                         return_thunk - (function_address + 31))
        function_slot, frame, page = 0x400, 0x800, 0x1000
        caller = bytearray(bytes.fromhex(
            '48 8b 45 c8 4a 8d 3c 30 4c 89 fe '
            'ff 15 00 00 00 00 49 83 c6 08 '
            '49 81 fe 00 10 00 00 75 e2 f4'))
        struct.pack_into('<i', caller, 13,
                         function_slot - (0x100 + 17))
        frame_bytes = bytearray(128)
        struct.pack_into('<Q', frame_bytes, 0x48, page)
        value = 0x123456789abcdef0
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with(
                (0x100, caller),
                (function_slot, struct.pack('<Q', function_address)),
                (function_address, function), (return_thunk, b'\xc3'),
                (frame, frame_bytes), (page, bytes(4096))),
            0x100, {'rbp': frame + 0x80, 'r14': 0,
                    'r15': value, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, page, 4096),
                         struct.pack('<Q', value) * 512)
        self.assertEqual(state.register('r14'), 4096)
        self.assertEqual(state.register('rdi'), page + 4088)
        self.assertEqual(state.register('rsi'), value)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_store_word_calls'], 512)
        self.assertEqual(layout['collapsed_repeated_store_calls'], 511)

    def test_random_u32_cache_hit_projects_only_the_selected_word(self):
        target, below, permutation, return_thunk = (
            0x2000, 0x3000, 0x4000, 0x500)
        cpu_slot, generation_slot = 0x600, 0x700
        ready_slot, guard_slot = 0x720, 0x730
        cache_offset, index_offset = 0x1000, 0x1068
        entry = bytearray(_RANDOM_U32_CACHE_ENTRY)
        core = bytearray(_RANDOM_U32_CACHE_CORE)
        ready = bytearray(_RANDOM_U32_CACHE_READY)
        core_address = target + len(entry)
        struct.pack_into('<i', entry, 26, guard_slot - (target + 30))
        struct.pack_into('<i', core, 19,
                         cpu_slot - (core_address + 23))
        struct.pack_into('<i', core, 26, cache_offset)
        struct.pack_into('<i', core, 33,
                         generation_slot - (core_address + 37))
        struct.pack_into('<i', core, 39, index_offset)
        struct.pack_into('<i', core, 103,
                         cpu_slot - (core_address + 107))
        struct.pack_into('<i', core, 125,
                         guard_slot - (core_address + 129))
        struct.pack_into('<i', core, 149,
                         return_thunk - (core_address + 153))
        struct.pack_into('<i', ready, 2,
                         ready_slot - (target + 0xcc))

        cache = bytearray(0x70)
        value = 0x89abcdef
        struct.pack_into('<I', cache, 8, value)
        struct.pack_into('<I', cache, 12, MASK32)
        struct.pack_into('<I', cache, 20, 1)
        struct.pack_into('<Q', cache, 0x60, 9)
        struct.pack_into('<I', cache, 0x68, 2)
        bounded = bytearray(_RANDOM_U32_BELOW_CORE)
        struct.pack_into('<i', bounded, 19, target - (below + 23))
        struct.pack_into('<i', bounded, 54,
                         return_thunk - (below + 58))
        struct.pack_into('<i', bounded, 73, target - (below + 77))
        array = 0x1200
        caller = bytearray(
            b'\xe8' + struct.pack('<i', target - 0x105)
            + b'\xbf\x0a\x00\x00\x00'
            + b'\xe8' + struct.pack('<i', below - 0x10f)
            + b'\xbb\x04\x00\x00\x00'
            + b'\x49\xc7\xc7\x02\x00\x00\x00'
            + b'\x49\xc7\xc4\x02\x00\x00\x00'
            + b'\x49\xc7\xc6\x00\x12\x00\x00'
            + b'\xe9\x00\x00\x00\x00')
        struct.pack_into('<i', caller, len(caller) - 4,
                         permutation - (0x100 + len(caller)))
        permutation_code = bytearray(_RANDOM_PERMUTATION_LOOP)
        struct.pack_into('<i', permutation_code, 3,
                         below - (permutation + 7))
        memory = memory_with(
            (0x100, caller), (return_thunk, b'\xc3'),
            (cpu_slot, struct.pack('<Q', 0)),
            (generation_slot, struct.pack('<Q', 9)),
            (ready_slot, struct.pack('<I', 2)),
            (guard_slot, struct.pack('<Q', 0xfeedface)),
            (cache_offset, cache),
            (array, struct.pack('<4I', 0, 1, 2, 3)),
            (target, entry), (core_address, core),
            (target + 0xc5, ready), (below, bounded),
            (permutation, permutation_code + b'\xf4'))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'rsp': 0}, rflags=2 | (1 << 9)))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0)
        self.assertEqual(state.register('rbx'), 1)
        self.assertEqual(state.register('r15'), MASK64)
        self.assertEqual(load_virtual(state, cache_offset + 8, 4), 0)
        self.assertEqual(load_virtual(state, cache_offset + 12, 4), 0)
        self.assertEqual(load_virtual(state, index_offset, 4), 7)
        self.assertEqual(read_virtual(state, array, 16),
                         struct.pack('<4I', 1, 2, 3, 0))
        self.assertEqual(dbt.layout()['collapsed_random_u32_cache_hits'], 5)
        self.assertEqual(dbt.layout()['collapsed_random_u32_below_calls'], 4)
        self.assertEqual(
            dbt.layout()['collapsed_random_permutation_iterations'], 2)

    def test_page_record_predicate_reads_only_its_fixed_lanes(self):
        target, record = 0x200, 0x400
        function = bytes.fromhex(
            '8b 47 30 83 f8 ff 75 46 48 63 47 34 '
            '48 0b 47 18 48 0b 47 38 '
            '48 b9 7c 00 00 00 80 ff ff ff 48 23 4f 08 '
            '48 ba 40 00 00 00 00 00 ad de 31 f6 48 39 d1 '
            '40 0f 94 c6 48 8b 0f 81 e1 23 e1 14 00 '
            '48 09 c1 48 09 f1 75 08 31 c0 2e e9 00 00 00 00')
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        page = bytearray(64)
        struct.pack_into('<I', page, 0x30, MASK32)
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, caller), (target, function), (record, page)),
            0x100, {'rdi': record, 'rsp': 0x9000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0)
        self.assertEqual(state.register('rsp'), 0x9000)
        self.assertEqual(
            dbt.layout()['collapsed_page_record_predicates'], 1)

    def test_page_record_run_stays_in_sparse_physical_projection(self):
        branch, check, predicate, exit_target = 0x200, 0x220, 0x400, 0x300
        head = bytes.fromhex(
            '80 7d bc 00 48 89 4d c0 74 05 4d 89 fd eb 3b')
        good = bytearray(bytes.fromhex(
            '4d 89 ef 48 8b 4d c0 41 81 64 0d 00 00 00 a0 ff '
            '48 83 c1 40 48 39 c8 75 9b e9 00 00 00 00'))
        struct.pack_into('<i', good, len(good) - 4,
                         exit_target - check)
        validation = bytearray(bytes.fromhex(
            '89 7d d4 48 8b 45 c0 4a 8d 3c 28 48 89 5d a0 '
            '4c 89 e3 45 89 c4 41 89 d7 49 89 f6 '
            'e8 00 00 00 00 8b 7d d4 4c 89 f6 44 89 fa '
            '45 89 e0 49 89 dc 48 8b 5d a0 4c 8b 75 c8 '
            '84 c0 48 8b 45 a8 74 a3 ff c7 4d 89 ef '
            '48 8b 4d c0 eb a8'))
        struct.pack_into('<i', validation, 28, predicate - (check + 32))
        predicate_code = bytes.fromhex(
            '8b 47 30 83 f8 ff 75 46 48 63 47 34 '
            '48 0b 47 18 48 0b 47 38 '
            '48 b9 7c 00 00 00 80 ff ff ff 48 23 4f 08 '
            '48 ba 40 00 00 00 00 00 ad de 31 f6 48 39 d1 '
            '40 0f 94 c6 48 8b 0f 81 e1 23 e1 14 00 '
            '48 09 c1 48 09 f1 75 08 31 c0 '
            '2e e9 00 00 00 00')
        frame, records = 0x900, 0x1000
        stack = bytearray(0x80)
        stack_base = frame - len(stack)
        stack[frame - 0x44 - stack_base] = 1
        struct.pack_into('<Q', stack, frame - 0x40 - stack_base, 64)
        struct.pack_into('<Q', stack, frame - 0x58 - stack_base, 256)
        pages = bytearray(4 * 64)
        initial_flags = 0x1000000081000000
        for index in range(1, 4):
            offset = index * 64
            struct.pack_into('<Q', pages, offset, initial_flags)
            struct.pack_into('<I', pages, offset + 0x30, MASK32)
        dbt = X86DBT()
        memory = memory_with(
            (branch - 0x4a, head),
            (branch, b'\xeb\x1e' + bytes(good) + bytes(validation)),
            (exit_target, b'\xf4'),
            (predicate, predicate_code),
            (stack_base, stack),
            (records, pages))

        state, boundary, _cost = dbt.run(initial_state(
            memory, branch,
            {'rbp': frame, 'r13': records, 'r15': records,
             'rax': 256, 'rcx': 64}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 256)
        self.assertEqual(state.register('rcx'), 256)
        self.assertEqual(state.register('r15'), records)
        self.assertEqual(load_virtual(state, frame - 0x40, 8), 192)
        for index in range(1, 4):
            self.assertEqual(
                load_virtual(state, records + index * 64, 8),
                initial_flags & (~MASK32 | 0xffa00000))
        layout = dbt.layout()
        self.assertEqual(
            layout['collapsed_page_record_projection_iterations'], 3)
        self.assertEqual(layout['collapsed_page_record_predicates'], 0)

    def test_entry_nop_tail_return_call_is_one_state_step(self):
        target, return_thunk = 0x200, 0x300
        caller = b'\xe8' + struct.pack('<i', target - 0x105) + b'\xf4'
        entry = (bytes.fromhex('f3 0f 1e fa') + b'\x90' * 10 + b'\xe9'
                 + struct.pack('<i', return_thunk - (target + 19)))
        memory = memory_with(
            (0x100, caller), (target, entry),
            (return_thunk, b'\xc3'))
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'rsp': 0x8000, 'rax': 0x1234}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rsp'), 0x8000)
        self.assertEqual(state.register('rax'), 0x1234)
        self.assertEqual(dbt.layout()['collapsed_entry_nop_calls'], 1)

    def test_retpoline_call_is_one_register_indirect_state_step(self):
        caller = bytes.fromhex('e8 fb 00 00 00 f4')
        thunk = bytes.fromhex(
            'e8 01 00 00 00 cc 4c 89 1c 24 e9 f1 00 00 00')
        memory = memory_with(
            (0x100, caller), (0x200, thunk),
            (0x300, b'\xc3'), (0x400, b'\xc3'))
        dbt = X86DBT(enable_function_oracles=False)

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'r11': 0x400, 'rsp': 0x8000}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rsp'), 0x8000)
        self.assertEqual(dbt.layout()['collapsed_indirect_calls'], 1)

    def test_byte_accumulator_immediate_preserves_the_upper_register(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('24 01 f4'))), 0x100,
            {'rax': 0x1234}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x1200)

    def test_sbb_byte_accumulator_consumes_carry_and_preserves_upper_bits(self):
        # cmp al,1; sbb al,0; hlt
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('3c 01 1c 00 f4'))), 0x100,
            {'rax': 0x1200}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x12ff)
        self.assertTrue(state.rflags & RFLAGS_CARRY)

    def test_execution_frame_freezes_without_mutating_the_input_cut(self):
        dbt = X86DBT()
        memory = memory_with((0x100, bytes.fromhex('83 c0 01 f4')))
        initial = initial_state(memory, 0x100, {'rax': 41})

        state, boundary, _cost = dbt.run(initial)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)
        self.assertEqual(initial.register('rax'), 41)
        self.assertEqual(initial.rip, 0x100)
        self.assertIs(initial.memory, memory)

    def test_segment_selector_read_zero_extends_a_register(self):
        # mov eax,ss; hlt
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('8c d0 f4'))), 0x100,
            {'rax': MASK64}, ss=0x18))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x18)

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('66 8c d0 f4'))), 0x100,
            {'rax': 0x123456789abcffff}, ss=0x18))
        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x123456789abc0018)

    def test_segment_selector_moves_to_and_from_memory(self):
        # mov [rax],ss; mov ss,[rbx]; hlt
        dbt = X86DBT()
        memory = memory_with((0x100, bytes.fromhex('8c 10 8e 13 f4')),
                             (0x400, b'\0\0'),
                             (0x500, b'4\x12'))

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'rax': 0x400, 'rbx': 0x500}, ss=0x18))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x400, 2), b'\x18\0')
        self.assertEqual(state.ss, 0x1234)

    def test_push_stack_pointer_uses_its_pre_instruction_value(self):
        # push rsp; pop rax; hlt
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('54 58 f4'))), 0x100,
            {'rsp': 0x800}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x800)
        self.assertEqual(state.register('rsp'), 0x800)

    def test_legacy_data_segment_overrides_are_ignored_in_long_mode(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex(
                '26 90 36 90 3e 90 f4'))), 0x100))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.rip, 0x107)

    def test_unsigned_divide_uses_the_implicit_double_width_accumulator(self):
        # div esi; hlt
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('f7 f6 f4'))), 0x100,
            {'rax': 0, 'rdx': 1, 'rsi': 2}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x80000000)
        self.assertEqual(state.register('rdx'), 0)

    def test_signed_divide_truncates_toward_zero(self):
        # idiv esi; hlt; -7 / 3 = -2 remainder -1
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('f7 fe f4'))), 0x100,
            {'rax': (-7) & MASK32, 'rdx': MASK32, 'rsi': 3}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), (-2) & MASK32)
        self.assertEqual(state.register('rdx'), MASK32)

    def test_implicit_multiply_publishes_both_halves_and_overflow(self):
        # mul esi; hlt
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('f7 e6 f4'))), 0x100,
            {'rax': MASK32, 'rsi': 2}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0xfffffffe)
        self.assertEqual(state.register('rdx'), 1)
        self.assertTrue(state.rflags & RFLAGS_CARRY)

    def test_divide_error_retains_the_faulting_instruction(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('f7 f6 f4'))), 0x100,
            {'rax': 1, 'rsi': 0}))

        self.assertEqual(boundary.operation, 'divide_error')
        self.assertEqual(state.rip, 0x100)

    def test_ud2_raises_the_architectural_invalid_opcode_exception(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('0f 0b f4'))), 0x100))

        self.assertEqual(boundary.operation, 'exception')
        self.assertEqual(boundary.detail, (6, None))
        self.assertEqual(state.rip, 0x100)

    def test_invalidate_page_uses_the_demand_translated_memory_route(self):
        # invlpg [rax]; hlt
        dbt = X86DBT()

        state = initial_state(
            memory_with((0x100, bytes.fromhex('0f 01 38 f4'))), 0x100,
            {'rax': 0x400})
        translate(state, 0x400)
        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.rip, 0x104)
        self.assertNotIn((0, 'read', False), state.translations)

    def test_prefetch_hint_does_not_touch_the_addressed_page(self):
        # prefetcht0 [rax]; hlt
        state = initial_state(
            memory_with((0x100, bytes.fromhex('0f 18 08 f4'))),
            0x100, {'rax': 1 << 48})

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.rip, 0x104)

    def test_store_gdt_uses_the_ten_byte_long_mode_descriptor(self):
        # sgdt [rax+0x10]; hlt
        memory = memory_with((0x100, bytes.fromhex('0f 01 40 10 f4')))
        state = initial_state(memory, 0x100, {'rax': 0x400},
                              gdtr=(0x1122334455667788, 0x99aa))

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x410, 10),
                         bytes.fromhex('aa 99 88 77 66 55 44 33 22 11'))

    def test_load_task_register_is_retained_in_cpu_state(self):
        # mov eax,0x40; ltr ax; hlt
        code = bytes.fromhex('b8 40 00 00 00 0f 00 d8 f4')
        state = initial_state(memory_with((0x100, code)), 0x100)

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.tr, 0x40)

    def test_debug_register_moves_round_trip_through_cpu_state(self):
        # mov esi,0x400; mov dr7,rsi; mov rax,dr7; hlt
        code = bytes.fromhex(
            'be 00 04 00 00 0f 23 fe 0f 21 f8 f4')
        state = initial_state(memory_with((0x100, code)), 0x100)

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.debug[7], 0x400)
        self.assertEqual(state.register('rax'), 0x400)

    def test_adc_register_retains_carry_across_full_width_wrap(self):
        # cmp eax,1; adc eax,ecx; hlt
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('83 f8 01 11 c8 f4'))),
            0x100, {'rax': 0, 'rcx': 0xffffffff}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0)
        self.assertTrue(state.rflags & RFLAGS_CARRY)

    def test_register_indexed_bit_test_publishes_carry(self):
        # bt rsi,rcx; jb good; bad: mov eax,99; hlt; good: ...
        code = bytes.fromhex(
            '48 0f a3 ce 72 06 b8 63 00 00 00 f4 '
            'b8 2a 00 00 00 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100,
            {'rsi': 1 << 9, 'rcx': 9}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)

    def test_byte_immediate_shift_only_updates_the_selected_byte(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('c0 e9 06 f4'))), 0x100,
            {'rcx': 0xffaa}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rcx'), 0xff02)

    def test_byte_shift_by_one_uses_the_same_shift_state_step(self):
        # shr r8b,1; hlt
        state = initial_state(
            memory_with((0x100, bytes.fromhex('41 d0 e8 f4'))),
            0x100, {'r8': 0x12346})

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('r8'), 0x12323)

    def test_locked_compare_exchange_is_one_memory_state_step(self):
        # lock cmpxchg qword [rbx],rcx; je good; bad: ...
        code = bytes.fromhex(
            'f0 48 0f b1 0b 74 06 b8 63 00 00 00 f4 '
            'b8 2a 00 00 00 f4')
        dbt = X86DBT()
        memory = memory_with((0x100, code), (0x400, bytes(8)))

        state, boundary, _cost = dbt.run(initial_state(
            memory, 0x100, {'rbx': 0x400, 'rcx': 0x1122}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)
        self.assertEqual(read_virtual(state, 0x400, 8),
                         struct.pack('<Q', 0x1122))

    def test_locked_exchange_add_is_one_memory_state_step(self):
        # lock xadd qword [rbx],rax; hlt
        code = bytes.fromhex('f0 48 0f c1 03 f4')
        memory = memory_with(
            (0x100, code), (0x400, struct.pack('<Q', 1)))
        state = initial_state(memory, 0x100,
                              {'rbx': 0x400, 'rax': MASK64})

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 1)
        self.assertEqual(read_virtual(state, 0x400, 8), bytes(8))
        self.assertTrue(state.rflags & RFLAGS_CARRY)

    def test_byte_increment_preserves_the_upper_register(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('fe c0 f4'))), 0x100,
            {'rax': 0x12ff}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x1200)

    def test_three_operand_imul_is_lowered_to_physical_multiply(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('48 6b c1 05 f4'))), 0x100,
            {'rcx': MASK64 - 2}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), MASK64 - 14)
        self.assertEqual(dbt.blocks[0x100].plan.waves.work, 1)

    def test_rotate_is_a_physical_operation_with_x86_carry(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('48 c1 c0 01 f4'))), 0x100,
            {'rax': 1 << 63}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 1)
        self.assertEqual(state.rflags & (1 | (1 << 11)), 1 | (1 << 11))
        self.assertEqual(dbt.blocks[0x100].plan.waves.work, 1)

    def test_byte_swap_is_one_physical_lane(self):
        # mov ecx,0x44332211; bswap ecx; hlt
        code = bytes.fromhex('b9 11 22 33 44 0f c9 f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rcx'), 0x11223344)
        self.assertEqual(dbt.blocks[0x100].plan.waves.work, 1)

    def test_reverse_bit_scan_returns_the_highest_set_coordinate(self):
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, bytes.fromhex('0f bd c1 f4'))), 0x100,
            {'rcx': 1 << 17}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 17)
        self.assertFalse(state.rflags & (1 << 6))

    def test_hot_blocks_reuse_the_direct_page_proof_without_byte_loads(self):
        # dec rcx; jne loop; hlt
        code = bytes.fromhex('48 ff c9 75 fb f4')
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100, {'rcx': 100}))

        self.assertEqual(boundary.operation, 'halt')
        self.assertGreater(dbt.layout()['block_proof_hits'], 100)
        self.assertEqual(dbt.layout()['block_proof_misses'], 0)

    def test_instruction_budget_has_no_hidden_basic_block_ceiling(self):
        dbt = X86DBT()
        state = initial_state(
            memory_with((0x100, bytes.fromhex('eb fe'))), 0x100)

        _state, boundary, cost = dbt.run(state, budget=65540)

        self.assertEqual(boundary.operation, 'timeslice')
        self.assertEqual(cost.instructions, 65540)

    def test_zero_work_control_states_thread_inside_one_step(self):
        code = bytes.fromhex('b0 01 b3 02 b1 03 eb f8')
        dbt = X86DBT()

        state, boundary, cost = dbt.run(initial_state(
            memory_with((0x100, code)), 0x100), budget=16)

        self.assertEqual(boundary.operation, 'timeslice')
        self.assertEqual(state.register('rax'), 1)
        self.assertEqual(state.register('rbx'), 2)
        self.assertEqual(state.register('rcx'), 3)
        self.assertEqual(cost.instructions, 16)
        self.assertGreaterEqual(
            dbt.layout()['register_cut_instructions'], 3)
        self.assertLess(dbt.layout()['threaded_controls'], 8)

    def test_direct_page_proof_invalidates_self_modifying_code(self):
        first = bytes.fromhex('b8 01 00 00 00 f4')
        second = bytes.fromhex('b8 02 00 00 00 f4')
        dbt = X86DBT()
        state, boundary, _cost = dbt.run(initial_state(
            memory_with((0x100, first)), 0x100))
        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 1)

        changed = state.memory.write(0x100, second)
        state = initial_state(changed, 0x100)
        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 2)
        self.assertGreater(dbt.layout()['block_proof_misses'], 0)

    def test_code_patch_invalidates_decoded_physical_page_immediately(self):
        first = bytes.fromhex('b8 01 00 00 00 f4')
        second = bytes.fromhex('b8 02 00 00 00 f4')
        memory = memory_with((0x100, first))
        state = initial_state(MemoryCut(memory), 0x100)
        dbt = X86DBT()
        dbt.block(state)

        state = dbt._patch_code_batch(state, ((0x100, second),))

        self.assertNotIn(0x100, dbt.blocks)
        state, boundary, _cost = dbt.run(state)
        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 2)
        self.assertEqual(dbt.layout()['invalidated_code_blocks'], 1)

    def test_direct_page_proof_skips_unchanged_loop_revalidation(self):
        # inc eax; jmp -4
        code = bytes.fromhex('ff c0 eb fc')
        dbt = X86DBT()
        state = initial_state(memory_with((0x100, code)), 0x100)

        state, boundary, _cost = dbt.run(state, budget=100)

        self.assertEqual(boundary.operation, 'timeslice')
        self.assertEqual(state.register('rax'), 50)
        self.assertGreater(dbt.layout()['block_proof_fast_hits'], 40)

    def test_memory_operands_share_one_normalized_state_page(self):
        # mov rax,[rbx]; add rax,1; mov [rbx+8],rax; hlt
        code = bytes.fromhex(
            '48 8b 03 48 83 c0 01 48 89 43 08 f4')
        memory = memory_with(
            (0x100, code),
            (0x400, struct.pack('<Q', 41)))
        state = initial_state(memory, 0x100, {'rbx': 0x400})
        dbt = X86DBT(enable_function_oracles=False)

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)
        self.assertEqual(read_virtual(state, 0x408, 8),
                         struct.pack('<Q', 42))
        self.assertEqual(dbt.blocks[0x103].plan.waves.work, 1)
        composed = dbt._register_cuts[0x100][1]
        self.assertTrue(composed.virtual_memory)
        self.assertEqual(
            [node.op for node in composed.plan.nodes
             if node.op.startswith('memory.')],
            ['memory.i64.load', 'memory.i64.store'])
        self.assertEqual(_cost.barriers, 1)

    def test_hot_non_loop_branch_reuses_negative_collapse_recipe(self):
        # xor eax,eax; test eax,eax; je -4
        code = bytes.fromhex('31 c0 85 c0 74 fc')
        dbt = X86DBT()
        state = initial_state(memory_with((0x100, code)), 0x100)

        state, boundary, _cost = dbt.run(state, budget=64)

        self.assertEqual(boundary.operation, 'timeslice')
        layout = dbt.layout()
        self.assertEqual(layout['collapse_recipe_misses'], 1)
        self.assertGreaterEqual(layout['collapse_recipe_hits'], 1)
        self.assertGreater(layout['collapse_recipe_negative'], 0)
        self.assertEqual(layout['collapse_recipe_attempts'], 0)

    def test_length_prefixed_byte_directory_skips_remaining_entries(self):
        directory = (b'\x02aa' + b'\x81\x01' + b'b' * 129
                     + b'\x01c' + b'\x03ddd')
        code = _LENGTH_PREFIX_SKIP_LOOP + b'\xf4'
        dbt = X86DBT()
        memory = memory_with((0x100, code), (0x1000, directory))

        for _unused in range(2):
            state, boundary, _cost = dbt.run(initial_state(
                memory, 0x100,
                {'rax': 4, 'rcx': 0x1000, 'rdx': 1, 'rsi': 2}))
            self.assertEqual(boundary.operation, 'halt')
            self.assertEqual(state.register('rcx'), 0x1000 + len(directory))
            self.assertEqual(state.register('rdx'), 5)
            self.assertEqual(state.register('rsi'), 4)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_length_prefix_entries'], 4)
        self.assertEqual(layout['length_prefix_cache_misses'], 1)
        self.assertEqual(layout['length_prefix_cache_hits'], 1)

    def test_token_expansion_uses_direct_index_and_output_coordinates(self):
        token_index, token_table = 0x2000, 0x2200
        core = bytearray(_TOKEN_EXPANSION_CORE)
        struct.pack_into('<i', core, 16, token_index)
        struct.pack_into('<i', core, 24, token_table)
        tail = bytes.fromhex('48 85 f6 74 03 c6 02 00 f4')
        current_token, compressed, output = 0x2300, 0x2400, 0x3000
        indexes = bytearray(512)
        struct.pack_into('<H', indexes, 2, 0x10)
        code_address = 0x100
        inner_loop = code_address + 0x50
        state = initial_state(
            memory_with((code_address, bytes(core) + tail),
                        (token_index, indexes),
                        (token_table + 0x10, b'de\0'),
                        (current_token, b'bc\0'),
                        (compressed, b'\0\x01')),
            inner_loop,
            {'rax': 2, 'rcx': compressed, 'rdx': output,
             'rsi': 10, 'r8': current_token + 1,
             'r9': ord('b'), 'r10': 10})
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, output, 5), b'bcde\0')
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_token_entries'], 2)
        self.assertEqual(layout['collapsed_token_bytes'], 3)

    def test_token_stream_is_normalized_before_the_outer_scalar_loop(self):
        code_address = 0x100
        core_start = code_address + 0x0f
        token_index, token_table = 0x2000, 0x2200
        core = bytearray(_TOKEN_EXPANSION_CORE)
        struct.pack_into('<i', core, 16, token_index)
        struct.pack_into('<i', core, 24, token_table)
        code = bytearray(b'\x90' * 0x90)
        code[:len(_TOKEN_STREAM_ENTRY)] = _TOKEN_STREAM_ENTRY
        code[0x0c:0x0f] = b'\x4c\x89\xd6'
        code[0x0f:0x0f + len(core)] = core
        code[0x0f + 0x75] = 0xf4
        compressed, output = 0x2400, 0x3000
        indexes = bytearray(512)
        struct.pack_into('<H', indexes, 2, 0x10)
        state = initial_state(
            memory_with((code_address, code),
                        (token_index, indexes),
                        (token_table, b'T\0'),
                        (token_table + 0x10, b'ab\0'),
                        (compressed, b'\0\x01')),
            code_address,
            {'rax': 2, 'rbx': output, 'rcx': compressed,
             'rsp': 0x8000})
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, output, 3), b'ab\0')
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_token_entries'], 2)
        self.assertEqual(layout['collapsed_token_bytes'], 2)

    def test_classified_identifier_scan_uses_one_byte_class_cut(self):
        # The loop accepts '_' and '.', stops on any other byte or NUL, and
        # checks a one-past bound before its pointer increment.
        code = bytes.fromhex(
            '44 0f b6 c7 40 80 ff 5f 74 06 '
            '41 83 f8 2e 75 11 '
            '0f b6 3a 48 39 f2 73 08 48 ff c2 40 84 ff 75 e0 '
            'f4 f4')
        data = b'._._X\0zz'
        dbt = X86DBT()
        state = initial_state(
            memory_with((0x100, code), (0x300, data)), 0x100,
            {'rdi': ord('_'), 'rdx': 0x300, 'rsi': 0x308})

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rdx'), 0x305)
        self.assertEqual(state.register('rdi') & 0xff, ord('X'))
        self.assertEqual(dbt.layout()['compiled_classified_scans'], 1)
        self.assertEqual(dbt.layout()['collapsed_classified_bytes'], 4)

    def test_kallsyms_search_retains_one_compact_offset_directory(self):
        target, caller = 0x100, 0x500
        num_address, relative_address, offsets = 0x2000, 0x2010, 0x3000
        size_pointer, offset_pointer = 0x4000, 0x4010
        code = bytearray(b'\x90' * 0xd9)
        code[:len(_SYMBOL_POSITION_ENTRY)] = _SYMBOL_POSITION_ENTRY
        struct.pack_into(
            '<i', code, 0x10, num_address - (target + 0x14))
        struct.pack_into(
            '<i', code, 0x1d, relative_address - (target + 0x21))
        code[0x2b:0x58] = _SYMBOL_POSITION_SEARCH
        struct.pack_into('<I', code, 0x47, offsets)
        code[0xa0:0xa3] = b'\x4c\x8b\x15'
        struct.pack_into(
            '<i', code, 0xa3, relative_address - (target + 0xa7))
        code[0xb1:0xb5] = b'\x46\x8b\x04\x85'
        struct.pack_into('<I', code, 0xb5, offsets)
        code[0xd2:0xd5] = b'\x41\x8b\x9b'
        struct.pack_into('<I', code, 0xd5, offsets)
        call = b'\xe8' + struct.pack('<i', target - (caller + 5)) + b'\xf4'
        relative = 0x100000
        table = struct.pack('<IIII', 0x10, 0x20, 0x20, 0x30)
        memory = memory_with(
            (target, code), (caller, call),
            (num_address, struct.pack('<I', 4)),
            (relative_address, struct.pack('<Q', relative)),
            (offsets, table))
        registers = {
            'rdi': relative + 0x25,
            'rsi': size_pointer,
            'rdx': offset_pointer,
            'rsp': 0x8000,
        }
        dbt = X86DBT()

        for _unused in range(2):
            state, boundary, _cost = dbt.run(
                initial_state(memory, caller, registers))
            self.assertEqual(boundary.operation, 'halt')
            self.assertEqual(state.register('rax'), 1)
            self.assertEqual(load_virtual(state, size_pointer, 8), 0x10)
            self.assertEqual(load_virtual(state, offset_pointer, 8), 5)

        layout = dbt.layout()
        self.assertEqual(layout['collapsed_symbol_lookups'], 2)
        self.assertEqual(layout['symbol_lookup_cache_misses'], 0)
        self.assertEqual(layout['symbol_lookup_cache_hits'], 0)
        self.assertEqual(layout['symbol_position_directory_misses'], 1)
        self.assertEqual(layout['symbol_position_directory_hits'], 1)
        self.assertEqual(layout['symbol_lookup_offset_loads'], 0)
        self.assertEqual(layout['symbol_offset_page_misses'], 0)

    def test_kernel_symbol_query_composes_its_direct_array_residuals(self):
        caller, target, wrapper, position_target = 0x700, 0x800, 0xa00, 0x1200
        num_address, relative_address, offsets = 0x2000, 0x2010, 0x3000
        token_index, token_table = 0x5000, 0x5200
        names, markers = 0x6000, 0x6100
        size_pointer, offset_pointer = 0x6200, 0x6210
        modname, build_id, output = 0x6220, 0x6230, 0x6300
        relative = 0x100000

        position_code = bytearray(b'\x90' * 0xd9)
        position_code[:len(_SYMBOL_POSITION_ENTRY)] = _SYMBOL_POSITION_ENTRY
        struct.pack_into(
            '<i', position_code, 0x10,
            num_address - (position_target + 0x14))
        struct.pack_into(
            '<i', position_code, 0x1d,
            relative_address - (position_target + 0x21))
        position_code[0x2b:0x58] = _SYMBOL_POSITION_SEARCH
        struct.pack_into('<I', position_code, 0x47, offsets)
        position_code[0xa0:0xa3] = b'\x4c\x8b\x15'
        struct.pack_into(
            '<i', position_code, 0xa3,
            relative_address - (position_target + 0xa7))
        position_code[0xb1:0xb5] = b'\x46\x8b\x04\x85'
        struct.pack_into('<I', position_code, 0xb5, offsets)
        position_code[0xd2:0xd5] = b'\x41\x8b\x9b'
        struct.pack_into('<I', position_code, 0xd5, offsets)

        signature = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 41 57 41 56 41 55 41 54 '
            '53 50 4c 89 cb 41 c6 01 00')
        lookup = bytearray(b'\x90' * 0x1a7)
        lookup[:len(signature)] = signature
        for offset, value in ((0x32, relative),
                              (0x3c, relative + 0x1000),
                              (0x4c, 0x300000),
                              (0x56, 0x400000)):
            lookup[offset:offset + 3] = b'\x48\x81\xff'
            struct.pack_into('<I', lookup, offset + 3, value)
        lookup[0x90] = 0xe8
        struct.pack_into(
            '<i', lookup, 0x91,
            position_target - (target + 0x95))
        lookup[0x9c:0x9f] = b'\x8b\x0c\x8d'
        struct.pack_into('<I', lookup, 0x9f, markers)
        lookup[0xe4:0xe7] = b'\x48\xc7\xc0'
        struct.pack_into('<I', lookup, 0xe7, names)
        token_core = bytearray(_TOKEN_EXPANSION_CORE)
        struct.pack_into('<I', token_core, 16, token_index)
        struct.pack_into('<I', token_core, 24, token_table)
        lookup[0x132:0x132 + len(token_core)] = token_core

        indexes = bytearray(512)
        struct.pack_into('<H', indexes, 0, 16)
        struct.pack_into('<H', indexes, 2, 0)
        struct.pack_into('<H', indexes, 4, 8)
        tokens = b'Tone\0\0\0\0Name\0\0\0\0Tzero\0'
        compressed_names = b'\x01\x00\x02\x01\x02'
        wrapper_prefix = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 41 56 53 '
            '4c 89 c3 45 31 f6 45 31 c0 49 89 d9 e8')
        wrapper_code = (wrapper_prefix + struct.pack(
            '<i', target - (wrapper + len(wrapper_prefix) + 4)))
        call = (b'\xe8' + struct.pack('<i', wrapper - (caller + 5))
                + b'\xf4')
        memory = memory_with(
            (caller, call), (target, lookup), (wrapper, wrapper_code),
            (position_target, position_code),
            (num_address, struct.pack('<I', 4)),
            (relative_address, struct.pack('<Q', relative)),
            (offsets, struct.pack('<IIII', 0x10, 0x20, 0x20, 0x30)),
            (token_index, indexes), (token_table, tokens),
            (names, compressed_names), (markers, struct.pack('<I', 0)))
        registers = {
            'rdi': relative + 0x25,
            'rsi': size_pointer, 'rdx': offset_pointer,
            'rcx': modname, 'r8': output,
            'rsp': 0x8000,
        }
        dbt = X86DBT()

        for _unused in range(2):
            state, boundary, _cost = dbt.run(
                initial_state(memory, caller, registers))
            self.assertEqual(boundary.operation, 'halt')
            self.assertEqual(state.register('rax'), output)
            self.assertEqual(read_virtual(state, output, 8), b'oneName\0')
            self.assertEqual(load_virtual(state, size_pointer, 8), 0x10)
            self.assertEqual(load_virtual(state, offset_pointer, 8), 5)
            self.assertEqual(load_virtual(state, modname, 8), 0)
            self.assertEqual(load_virtual(state, build_id, 8), 0)

        layout = dbt.layout()
        self.assertEqual(layout['collapsed_symbol_resolutions'], 2)
        self.assertEqual(layout['collapsed_symbol_wrappers'], 2)
        self.assertEqual(layout['symbol_name_directory_misses'], 1)
        self.assertEqual(layout['symbol_name_directory_hits'], 1)

    def test_ftrace_record_span_retains_only_the_symbol_size_bit(self):
        target, wrapper, resolver = 0x100, 0x700, 0x800
        position_target = 0x1000
        num_address, relative_address, offsets = 0x2000, 0x2010, 0x3000
        node, records = 0x4000, 0x4100
        relative = 0x100000
        loop = bytearray(bytes.fromhex(
            '49 8b 5f 08 4a 8b 7c 23 f8 31 f6 48 8d 54 24 08 '
            '31 c9 4d 89 f0 e8 00 00 00 00 48 85 c0 74 08 '
            '48 83 7c 24 08 05 72 06 42 80 4c 23 03 02 '
            '49 ff c5 49 63 47 10 49 83 c4 10 49 39 c5 7c c3'))
        struct.pack_into('<i', loop, 22, wrapper - (target + 26))

        position_code = bytearray(b'\x90' * 0xd9)
        position_code[:len(_SYMBOL_POSITION_ENTRY)] = _SYMBOL_POSITION_ENTRY
        struct.pack_into(
            '<i', position_code, 0x10,
            num_address - (position_target + 0x14))
        struct.pack_into(
            '<i', position_code, 0x1d,
            relative_address - (position_target + 0x21))
        position_code[0x2b:0x58] = _SYMBOL_POSITION_SEARCH
        struct.pack_into('<I', position_code, 0x47, offsets)
        position_code[0xa0:0xa3] = b'\x4c\x8b\x15'
        struct.pack_into(
            '<i', position_code, 0xa3,
            relative_address - (position_target + 0xa7))
        position_code[0xb1:0xb5] = b'\x46\x8b\x04\x85'
        struct.pack_into('<I', position_code, 0xb5, offsets)
        position_code[0xd2:0xd5] = b'\x41\x8b\x9b'
        struct.pack_into('<I', position_code, 0xd5, offsets)

        node_value = bytearray(0x18)
        struct.pack_into('<Q', node_value, 8, records)
        struct.pack_into('<I', node_value, 0x10, 3)
        record_values = bytearray(48)
        for index, address in enumerate(
                (relative + 0x11, relative + 0x11,
                 relative + 0x15)):
            struct.pack_into('<Q', record_values, index * 16, address)
        memory = memory_with(
            (target, loop), (position_target, position_code),
            (num_address, struct.pack('<I', 4)),
            (relative_address, struct.pack('<Q', relative)),
            (offsets, struct.pack('<IIII', 0x10, 0x13, 0x20, 0x30)),
            (node, node_value), (records, record_values))
        dbt = X86DBT()
        config = (0, 0, 0, 0, 0)
        dbt._symbol_wrapper_functions[wrapper] = config, (), resolver
        dbt._symbol_resolution_functions[resolver] = (
            config, (),
            ((relative, relative + 0x1000, 0x300000, 0x400000),
             position_target, 0, 0, 0, 0))
        branch = dbt.block(initial_state(memory, target + 59))
        state = initial_state(
            memory, target,
            {'r12': 24, 'r13': 1, 'r14': 0x9000,
             'r15': node, 'rsp': 0x8000})

        collapsed = dbt._collapse_ftrace_record_span(state, branch)

        self.assertEqual(collapsed.rip, target + 61)
        self.assertEqual(collapsed.register('r13'), 3)
        self.assertEqual(collapsed.register('r12'), 56)
        self.assertEqual(load_virtual(collapsed, records + 16 + 11, 1), 0)
        self.assertEqual(load_virtual(collapsed, records + 32 + 11, 1), 2)
        self.assertEqual(dbt.layout()['collapsed_ftrace_records'], 2)

    def test_repeated_call_reuses_proved_negative_code_recipe(self):
        # Three different call sites target the same ordinary function.
        code = bytes.fromhex(
            'e8 fb 00 00 00 e8 f6 00 00 00 e8 f1 00 00 00 f4')
        memory = memory_with((0x100, code), (0x200, bytes.fromhex('c3')))
        dbt = X86DBT()
        state = initial_state(memory, 0x100, {'rsp': 0x8000})

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        layout = dbt.layout()
        self.assertEqual(layout['code_recipe_misses'], 1)
        self.assertEqual(layout['code_recipe_hits'], 2)
        self.assertEqual(layout['code_recipe_negative'], 1)

    def test_pop_rsp_switches_to_the_popped_stack(self):
        memory = memory_with(
            (0x100, bytes.fromhex('5c f4')),
            (0x8000, struct.pack('<Q', 0x9000)))
        state = initial_state(memory, 0x100, {'rsp': 0x8000})

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rsp'), 0x9000)

    def test_pop_memory_uses_the_advanced_rsp_for_its_address(self):
        # popq 8(%rsp); hlt
        memory = memory_with(
            (0x100, bytes.fromhex('8f 44 24 08 f4')),
            (0x8000, struct.pack('<Q', 0x1122334455667788)))
        state = initial_state(memory, 0x100, {'rsp': 0x8000})

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rsp'), 0x8008)
        self.assertEqual(load_virtual(state, 0x8010, 8),
                         0x1122334455667788)

    def test_fninit_is_an_explicit_integer_state_transition(self):
        state = initial_state(
            memory_with((0x100, bytes.fromhex('db e3 f4'))), 0x100)

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.rip, 0x103)

    def test_fxsave_writes_the_architectural_reset_control_fields(self):
        # fxsave 0x110(%rip); hlt
        code = bytes.fromhex('0f ae 05 09 00 00 00 f4')
        state = initial_state(memory_with((0x100, code)), 0x100)

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(load_virtual(state, 0x110, 2), 0x037f)
        self.assertEqual(load_virtual(state, 0x128, 4), 0x1f80)
        self.assertEqual(load_virtual(state, 0x12c, 4), 0x0000ffff)

    def test_memory_fence_starts_a_new_pure_slice(self):
        # lfence; mov eax,42; hlt
        state = initial_state(
            memory_with((0x100, bytes.fromhex(
                '0f ae e8 b8 2a 00 00 00 f4'))), 0x100)

        state, boundary, cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 42)
        self.assertGreaterEqual(cost.slices, 1)

    def test_shrd_joins_the_two_registers_without_materializing_bytes(self):
        # shrd %cl,%rdx,%rax; hlt
        state = initial_state(
            memory_with((0x100, bytes.fromhex('48 0f ad d0 f4'))),
            0x100,
            {'rax': 0x2233445566778899,
             'rdx': 0xaabbccddeeff0011, 'rcx': 8})

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x1122334455667788)

    def test_shld_immediate_joins_the_two_registers(self):
        # shld $8,%rdx,%rax; hlt
        state = initial_state(
            memory_with((0x100, bytes.fromhex('48 0f a4 d0 08 f4'))),
            0x100,
            {'rax': 0x2233445566778899,
             'rdx': 0xaabbccddeeff0011})

        state, boundary, _cost = X86DBT().run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.register('rax'), 0x33445566778899aa)

    def test_int3_trap_enters_the_guest_idt_and_resumes_after_opcode(self):
        memory = memory_with(
            (0x100, bytes.fromhex('cc f4')),
            (0x200, bytes.fromhex('c7 07 01 00 00 00 cf')))
        gate = bytearray(16)
        struct.pack_into('<H', gate, 0, 0x200)
        struct.pack_into('<H', gate, 2, 0x10)
        gate[5] = 0x8e
        memory = memory.write(0x5000 + 3 * 16, gate)
        state = initial_state(
            memory, 0x100, {'rdi': 0x400, 'rsp': 0x8000},
            idtr=(0x5000, 0x1000 - 1), cs=0x10)
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(load_virtual(state, 0x400, 4), 1)
        self.assertEqual(state.register('rsp'), 0x8000)
        self.assertEqual(dbt.layout()['delivered_exceptions'], 1)

    def test_stable_memory_poll_yields_at_its_persistent_cut(self):
        # cmp [0x110],rax; je 0x100; hlt
        memory = memory_with(
            (0x100, bytes.fromhex('48 3b 05 09 00 00 00 74 f7 f4')),
            (0x110, struct.pack('<Q', 0)))
        dbt = X86DBT()
        state = initial_state(memory, 0x100, {'rax': 0})

        state, boundary, cost = dbt.run(state, budget=1 << 20)

        self.assertEqual(boundary.operation, 'timeslice')
        self.assertEqual(state.rip, 0x100)
        self.assertLess(cost.instructions, 16)
        self.assertEqual(dbt.layout()['collapsed_spin_waits'], 1)

        state = write_virtual(state, 0x110, struct.pack('<Q', 1))
        state, boundary, _cost = dbt.run(state)
        self.assertEqual(boundary.operation, 'halt')

    def test_relative_record_sort_uses_direct_byte_radix_coordinates(self):
        wrapper = bytes.fromhex(
            '48 89 4d e8 4c 89 45 f0 4c 8d 4d e8 '
            '41 b8 03 00 00 00 31 c9 6a 00 e8')
        compare = bytes.fromhex(
            '48 63 47 04 48 01 f8 48 83 c0 04 48 83 e0 fc '
            '48 63 4e 04 48 01 f1 48 83 c1 04 48 83 e1 fc')
        swap = bytes.fromhex(
            '89 f8 29 f0 8b 0e 29 c1 8b 17 01 c2 89 0f '
            '8b 4e 04 29 c1 03 47 04')
        base = 0x1000
        values = ((0x2100, 0x1800),
                  (0x2200, 0x1400),
                  (0x2300, 0x1600))

        def encoded(index, value):
            slot = base + index * 8
            address, key = value
            return struct.pack(
                '<II', (address - slot) & MASK32,
                (key - slot - 4) & MASK32)

        def signed32(value):
            return value - (1 << 32) if value & (1 << 31) else value

        records = b''.join(encoded(index, value)
                           for index, value in enumerate(values))
        memory = memory_with(
            (0x100, bytes.fromhex('e8 fb 00 00 00 f4')),
            (0x200, wrapper), (0x300, compare), (0x400, swap),
            (base, records))
        dbt = X86DBT()
        state = initial_state(
            memory, 0x100,
            {'rdi': base, 'rsi': len(values), 'rdx': 8,
             'rcx': 0x300, 'r8': 0x400, 'rsp': 0x8000})

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        decoded = []
        for index in range(len(values)):
            slot = base + index * 8
            first, second = struct.unpack(
                '<II', state.memory.read(slot, 8))
            decoded.append(((slot + signed32(first)) & MASK64,
                            (slot + 4 + signed32(second)) & MASK64))
        self.assertEqual(decoded,
                         [(0x2200, 0x1400),
                          (0x2300, 0x1600),
                          (0x2100, 0x1800)])
        self.assertEqual(dbt.layout()['collapsed_record_sorts'], 1)
        self.assertEqual(dbt.layout()['collapsed_sort_records'], 3)
        self.assertEqual(dbt.layout()['collapsed_sort_passes'], 8)

    def test_current_kernel_interval_sort_collapses_before_scalar_dispatch(self):
        wrapper = bytes.fromhex(
            '4c 8d 4d e8 48 89 4d e8 31 c9 4c 89 45 f0 '
            '41 b8 03 00 00 00 e8')
        target, trace, return_thunk = 0x300, 0x500, 0x600
        compare_body = bytes.fromhex(
            '55 48 8b 47 08 48 83 e0 fc 48 8d 54 07 08 '
            '48 8b 46 08 48 89 e5 48 83 e0 fc 48 8d 4c 06 08 '
            'b8 ff ff ff ff 48 39 ca 72 28 '
            'b8 01 00 00 00 48 39 d1 72 1e '
            '48 63 07 48 01 c7 48 63 06 48 01 c6 '
            'b8 ff ff ff ff 48 39 f7 72 08 '
            '31 c0 48 39 fe 0f 92 c0 5d e9')
        compare = (bytes.fromhex('f3 0f 1e fa e8')
                   + struct.pack('<i', trace - (target + 9))
                   + compare_body
                   + struct.pack('<i', return_thunk - (target + 0x5f)))
        tracing = (bytes.fromhex('f3 0f 1e fa') + b'\x90' * 10 + b'\xe9'
                   + struct.pack('<i', return_thunk - (trace + 19)))
        swap = bytes.fromhex(
            '44 8b 06 48 89 f8 8b 0f 55 48 29 f0 8b 57 04 4c 8b 4f 08 '
            '41 29 c0 01 c1 44 89 07 44 8b 46 04 01 c2 48 89 e5 5d '
            '41 29 c0 44 89 47 04 4c 8b 46 08 49 29 c0 4c 01 c8 '
            '4c 89 47 08 89 0e 89 56 04 48 89 46 08')
        base = 0x1000
        values = ((0x2100, 0x2200, 0x1803),
                  (0x2300, 0x2400, 0x1402),
                  (0x2500, 0x2600, 0x1601))

        def encoded(index, value):
            slot = base + index * 16
            first, second, third = value
            return struct.pack(
                '<IIQ', (first - slot) & MASK32,
                (second - slot - 4) & MASK32,
                (third - slot - 8) & MASK64)

        def signed(value, bits):
            return value - (1 << bits) if value & (1 << (bits - 1)) else value

        records = b''.join(encoded(index, value)
                           for index, value in enumerate(values))
        memory = memory_with(
            (0x100, bytes.fromhex('e8 fb 00 00 00 f4')),
            (0x200, wrapper), (target, compare), (trace, tracing),
            (return_thunk, b'\xc3'), (0x700, swap), (base, records))
        dbt = X86DBT()
        state = initial_state(
            memory, 0x100,
            {'rdi': base, 'rsi': len(values), 'rdx': 16,
             'rcx': target, 'r8': 0x700, 'rsp': 0x8000})

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        decoded = []
        for index in range(len(values)):
            slot = base + index * 16
            first, second, third = struct.unpack(
                '<IIQ', state.memory.read(slot, 16))
            decoded.append(((slot + signed(first, 32)) & MASK64,
                            (slot + 4 + signed(second, 32)) & MASK64,
                            (slot + 8 + signed(third, 64)) & MASK64))
        self.assertEqual(decoded, [values[1], values[2], values[0]])
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_record_sorts'], 1)
        self.assertEqual(layout['collapsed_sort_records'], 3)
        self.assertEqual(layout['collapsed_sort_passes'], 16)

    def test_current_kernel_relative_sort_collapses_before_scalar_dispatch(self):
        wrapper = bytes.fromhex(
            '4c 8d 4d e8 48 89 4d e8 31 c9 4c 89 45 f0 '
            '41 b8 03 00 00 00 e8')
        compare = bytes.fromhex(
            '48 63 47 04 b9 ff ff ff ff 48 63 56 04 '
            '48 8d 44 38 04 48 8d 54 32 04 48 83 e0 fc '
            '48 89 e5 48 83 e2 fc 48 39 d0')
        swap = bytes.fromhex(
            '44 8b 06 48 89 f8 8b 0f 55 48 29 f0 8b 57 04 '
            '41 29 c0 01 c1 44 89 07 44 8b 46 04 48 89 e5 5d '
            '41 29 c0 01 d0 44 89 47 04 89 0e 89 46 04')
        base = 0x1000
        values = ((0x2100, 0x1803),
                  (0x2200, 0x1402),
                  (0x2300, 0x1601))

        def encoded(index, value):
            slot = base + index * 8
            address, key = value
            return struct.pack(
                '<II', (address - slot) & MASK32,
                (key - slot - 4) & MASK32)

        def signed32(value):
            return value - (1 << 32) if value & (1 << 31) else value

        records = b''.join(encoded(index, value)
                           for index, value in enumerate(values))
        memory = memory_with(
            (0x100, bytes.fromhex('e8 fb 00 00 00 f4')),
            (0x200, wrapper), (0x300, compare), (0x400, swap),
            (base, records))
        dbt = X86DBT()
        state = initial_state(
            memory, 0x100,
            {'rdi': base, 'rsi': len(values), 'rdx': 8,
             'rcx': 0x300, 'r8': 0x400, 'rsp': 0x8000})

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        decoded = []
        for index in range(len(values)):
            slot = base + index * 8
            first, second = struct.unpack(
                '<II', state.memory.read(slot, 8))
            decoded.append(((slot + signed32(first)) & MASK64,
                            (slot + 4 + signed32(second)) & MASK64))
        self.assertEqual(decoded,
                         [(0x2200, 0x1402),
                          (0x2300, 0x1601),
                          (0x2100, 0x1803)])
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_record_sorts'], 1)
        self.assertEqual(layout['collapsed_sort_records'], 3)
        self.assertEqual(layout['collapsed_sort_passes'], 8)

    def test_relative_return_sites_normalize_in_one_direct_page_cut(self):
        function = bytearray(0x300)
        function[:len(_RETURN_SCAN_PREFIX)] = _RETURN_SCAN_PREFIX
        function[0x30:0x30 + len(_RETURN_SCAN_LOOP)] = _RETURN_SCAN_LOOP
        function[0x40:0x40 + len(_RETURN_ENTRY_CORE)] = _RETURN_ENTRY_CORE
        function[0x50:0x50 + len(_RETURN_FEATURE_JUMP)] = \
            _RETURN_FEATURE_JUMP
        feature_stub = 0x600
        jump = 0x50 + len(_RETURN_FEATURE_JUMP) - 1
        struct.pack_into('<i', function, jump + 1,
                         feature_stub - (0x200 + jump + 5))
        expected = 0x900
        function[0x80:0x83] = _RETURN_TARGET_COMPARE
        struct.pack_into('<i', function, 0x83, expected)

        feature_address = 0x700
        feature = bytearray(bytes.fromhex('f6 05 00 00 00 00 40'))
        struct.pack_into('<i', feature, 2,
                         feature_address - (feature_stub + 7))
        table = 0x1000
        count = 64
        entries = bytearray(count * 4)
        writes = [(0x100, bytes.fromhex('e8 fb 00 00 00 f4')),
                  (0x200, function), (feature_stub, feature),
                  (feature_address, b'\0')]
        for index in range(count):
            slot = table + index * 4
            site = 0x2000 + index * 16
            struct.pack_into('<i', entries, index * 4, site - slot)
            prefix = b'\x2e' if index & 1 else b''
            length = len(prefix) + 5
            writes.append((site, prefix + b'\xe9' + struct.pack(
                '<i', expected - (site + length))))
        trampoline = 0x2000 + (count - 1) * 16
        writes[-1] = (trampoline, b'\xe9' + struct.pack(
            '<i', 0xa00 - (trampoline + 5)) + b'\x0f\xb9\xcc')
        writes.append((table, entries))
        state = initial_state(
            memory_with(*writes), 0x100,
            {'rdi': table, 'rsi': table + len(entries), 'rsp': 0x8000})
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        for index in range(count):
            if index == count - 1:
                self.assertEqual(read_virtual(
                    state, 0x2000 + index * 16, 8), writes[-2][1])
                continue
            length = 6 if index & 1 else 5
            self.assertEqual(read_virtual(
                state, 0x2000 + index * 16, length),
                b'\xc3' + b'\xcc' * (length - 1))
        self.assertEqual(dbt.layout()['collapsed_return_sites'], count)
        self.assertEqual(dbt.layout()['collapsed_return_bytes'],
                         count * 5 + count // 2 - 6)

    def test_linux_alternative_table_is_one_direct_coordinate_cut(self):
        function_address = 0x200
        function = bytearray(0x500)
        function[:len(_ALTERNATIVE_SCAN_PREFIX)] = \
            _ALTERNATIVE_SCAN_PREFIX
        function[0x40:0x40 + len(_ALTERNATIVE_ENTRY_CORE)] = \
            _ALTERNATIVE_ENTRY_CORE
        debug_address = 0x800
        debug = bytearray(_ALTERNATIVE_DEBUG_TEST + b'\0\0\0\0\x01')
        struct.pack_into('<i', debug, 2,
                         debug_address - (function_address + 0x80 + 7))
        function[0x80:0x87] = debug
        capabilities_address = 0x900
        capability = bytearray(_ALTERNATIVE_CAPABILITY_PROBE + b'\0\0\0\0')
        struct.pack_into('<i', capability, 4,
                         capabilities_address -
                         (function_address + 0x90 + 8))
        function[0x90:0x98] = capability
        bug_address = 0xa00
        function[0xa0:0xa7] = _ALTERNATIVE_BUG_ADDRESS + \
            struct.pack('<i', bug_address)
        nop_address = 0xb00
        function[0xb0:0xb6] = _ALTERNATIVE_NOP_ADDRESS + \
            struct.pack('<i', nop_address)

        table_address = 0x1000
        table = bytearray()
        writes = [(0x100, bytes.fromhex('e8 fb 00 00 00 f4')),
                  (function_address, function),
                  (debug_address, b'\0'),
                  (capabilities_address, b'\x02' + b'\0' * 95)]

        def entry(site, replacement, feature, flags,
                  instruction_bytes, replacement_code):
            slot = table_address + len(table)
            table.extend(struct.pack(
                '<iiIBB', site - slot, replacement - (slot + 4),
                (flags << 16) | feature,
                instruction_bytes, len(replacement_code)))
            writes.append((replacement, replacement_code))

        branch_site, branch_replacement, branch_target = 0x3000, 0x4000, 0x6000
        entry(branch_site, branch_replacement, 1, 0, 5,
              b'\xe9' + struct.pack(
                  '<i', branch_target - (branch_replacement + 5)))
        writes.append((branch_site, b'\x90' * 5))

        not_site, not_replacement = 0x3020, 0x4020
        entry(not_site, not_replacement, 2, 1, 6,
              bytes.fromhex('48 89 f8'))
        writes.append((not_site, b'\xcc' * 6))

        direct_site, direct_replacement = 0x3040, 0x4040
        direct_pointer, direct_target = 0x5000, 0x5100
        entry(direct_site, direct_replacement, 1, 2, 6,
              b'\xe8' + struct.pack(
                  '<i', bug_address - (direct_replacement + 5)))
        writes.append((direct_site, b'\xff\x15' + struct.pack(
            '<i', direct_pointer - (direct_site + 6))))
        writes.append((direct_pointer, struct.pack('<Q', direct_target)))

        unchanged_site, unchanged_replacement = 0x3060, 0x4060
        unchanged = bytes.fromhex('0f 1f 44 00 00')
        entry(unchanged_site, unchanged_replacement, 2, 0, 5, b'')
        writes.append((unchanged_site, unchanged))

        nested_site = 0x3080
        entry(nested_site, 0x4080, 2, 0, 5, b'')
        entry(nested_site, 0x4090, 2, 1, 6, b'\xc3')
        writes.append((nested_site, b'\xcc' * 6))
        writes.append((table_address, table))

        state = initial_state(
            memory_with(*writes), 0x100,
            {'rdi': table_address,
             'rsi': table_address + len(table), 'rsp': 0xf000})
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, branch_site, 5),
                         b'\xe9' + struct.pack(
                             '<i', branch_target - (branch_site + 5)))
        self.assertEqual(read_virtual(state, not_site, 6),
                         bytes.fromhex('48 89 f8 90 90 90'))
        self.assertEqual(read_virtual(state, direct_site, 6),
                         b'\xe8' + struct.pack(
                             '<i', direct_target - (direct_site + 5))
                         + b'\x90')
        self.assertEqual(read_virtual(state, unchanged_site, 5), unchanged)
        self.assertEqual(read_virtual(state, nested_site, 6),
                         b'\xc3' + b'\x90' * 5)
        self.assertEqual(load_virtual(state, table_address + 4 * 14 + 12, 1),
                         6)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_alternative_tables'], 1)
        self.assertEqual(layout['collapsed_alternative_entries'], 6)
        self.assertEqual(layout['collapsed_alternative_bytes'], 23)

    def test_smp_lock_table_patches_only_proved_text_coordinates(self):
        target = 0x500
        code = bytearray(_SMP_LOCK_LOOP_CORE)
        code.extend(struct.pack('<i', target))
        code.extend(bytes.fromhex('4c 89 ea'))
        call = 0x100 + len(code)
        code.extend(b'\xe8' + struct.pack('<i', target - (call + 5)))
        following = 0x100 + len(code)
        code.append(0xf4)

        table_address = 0x1000
        text_start, text_end = 0x2000, 0x3000
        records = bytearray()
        for index, address in enumerate((0x2000, None, 0x3100, 0x2010)):
            slot = table_address + index * 4
            relative = 0 if address is None else address - slot
            records.extend(struct.pack('<i', relative))
        source = 0x1800
        state = initial_state(
            memory_with((0x100, code), (table_address, records),
                        (source, b'\x3e'), (0x2000, b'\xf0'),
                        (0x2010, b'\x90')),
            call,
            {'r12': table_address,
             'r15': table_address + len(records),
             'r14': text_start, 'rbx': text_end,
             'rsi': 0x2000, 'rdx': source, 'rcx': 1,
             'rsp': 0xf000})
        dbt = X86DBT()

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(read_virtual(state, 0x2000, 1), b'\x3e')
        self.assertEqual(read_virtual(state, 0x2010, 1), b'\x90')
        self.assertEqual(state.register('r12'),
                         table_address + len(records) - 4)
        layout = dbt.layout()
        self.assertEqual(layout['collapsed_smp_lock_tables'], 1)
        self.assertEqual(layout['collapsed_smp_lock_sites'], 1)

    def test_debug_port_is_the_shared_console_event(self):
        # mov eax,'A'; out 0xe9,al; hlt
        memory = memory_with(
            (0x100, bytes.fromhex('b8 41 00 00 00 e6 e9 f4')))
        runtime = X86Machine()
        state = runtime.start(initial_state(memory, 0x100))

        state, event = runtime.machine_step(state)
        self.assertEqual((event.operation, event.data),
                         ('console_write', b'A'))
        state, event = runtime.machine_step(state)
        self.assertIsNone(event)
        self.assertTrue(state.stopped)

    def test_uart_line_status_is_internal_machine_state(self):
        memory = memory_with((0x100, bytes.fromhex('ec f4')))
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory, 0x100, {'rdx': 0x3fd}))

        state, event = runtime.machine_step(state)
        self.assertIsNone(event)
        self.assertEqual(state.cpu.register('rax'), 0x60)
        state, event = runtime.machine_step(state)
        self.assertIsNone(event)
        self.assertTrue(state.stopped)

    def test_uart_transmit_uses_the_console_barrier(self):
        memory = memory_with((0x100, bytes.fromhex('ee f4')))
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory, 0x100, {'rax': ord('L'), 'rdx': 0x3f8}))

        state, event = runtime.machine_step(state)

        self.assertEqual((event.operation, event.data),
                         ('console_write', b'L'))

    def test_console_bytes_share_one_machine_cut_until_end_of_line(self):
        code = bytes.fromhex(
            'c6 03 01 b0 48 e6 e9 '
            'c6 43 01 02 b0 69 e6 e9 '
            'b0 0a e6 e9 f4')
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory_with((0x100, code)), 0x100, {'rbx': 0x400}))

        state, event = runtime.machine_step(state)

        self.assertEqual((event.operation, event.data),
                         ('console_write', b'Hi\n'))
        self.assertIsInstance(state.cpu.memory, MemoryCut)
        self.assertTrue(state.cpu.memory.sealed)
        self.assertEqual(state.cpu.memory.read(0x400, 2), b'\x01\x02')
        self.assertEqual(runtime.dbt.layout()['persistent_cuts'], 1)
        self.assertEqual(runtime.dbt.layout()['published_pages'], 1)
        self.assertEqual(runtime.dbt.layout()['materialized_pages'], 0)

    def test_internal_timeslices_retain_the_same_physical_memory_cut(self):
        code = bytes.fromhex(
            'c6 03 01 c6 43 01 02 c6 43 02 03 c6 43 03 04 f4')
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory_with((0x100, code)), 0x100, {'rbx': 0x400}))

        state, event = runtime.machine_step(
            state, budget=2, max_internal=1)

        self.assertIsNone(event)
        self.assertIsInstance(state.cpu.memory, MemoryCut)
        # A maximal physical page may now reach HLT in this first quantum.
        # If it does, the one dirty byte cut is already the terminal root;
        # otherwise it remains unpublished across the internal timeslice.
        self.assertEqual(
            runtime.dbt.layout()['persistent_cuts'], int(state.stopped))
        for _unused in range(8):
            state, event = runtime.machine_step(
                state, budget=2, max_internal=1)
            self.assertIsNone(event)
            if state.stopped:
                break
        self.assertTrue(state.stopped)
        self.assertIsInstance(state.cpu.memory, MemoryCut)
        self.assertTrue(state.cpu.memory.sealed)
        self.assertEqual(state.cpu.memory.read(0x400, 4), b'\x01\x02\x03\x04')
        self.assertEqual(runtime.dbt.layout()['persistent_cuts'], 1)
        self.assertEqual(runtime.dbt.layout()['published_pages'], 1)
        self.assertEqual(runtime.dbt.layout()['materialized_pages'], 0)

    def test_pit_channel_two_advances_inside_one_machine_step(self):
        code = bytes.fromhex(
            'b0 b0 e6 43 b0 ff e6 42 e6 42 '
            'e4 42 e4 42 e4 42 e4 42 f4')
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory_with((0x100, code)), 0x100))

        state, event = runtime.machine_step(state)

        self.assertIsNone(event)
        self.assertTrue(state.stopped)
        self.assertNotEqual(state.cpu.register('rax') & 0xff, 0xff)

    def test_legacy_pic_retains_its_interrupt_mask(self):
        # Unmask IRQ0 and read the master interrupt mask back.
        code = bytes.fromhex('b0 fe e6 21 e4 21 f4')
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory_with((0x100, code)), 0x100))

        state, event = runtime.machine_step(state)

        self.assertIsNone(event)
        self.assertEqual(state.cpu.register('rax') & 0xff, 0xfe)

    def test_timer_interrupt_is_a_replayable_machine_barrier(self):
        # Unmask IRQ0, enable interrupts, and wait in a pure loop.
        memory = memory_with(
            (0x100, bytes.fromhex('b0 fe e6 21 fb eb fe')),
            (0x200, bytes.fromhex('b8 2a 00 00 00 cf')))
        gate = bytearray(16)
        struct.pack_into('<H', gate, 0, 0x200)
        struct.pack_into('<H', gate, 2, 0x10)
        gate[5] = 0x8e
        memory = memory.write(0x5000 + 0x30 * 16, gate)
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory, 0x100, {'rsp': 0x8000},
            idtr=(0x5000, 0x1000 - 1), cs=0x10))

        state, request = runtime.machine_step(state, budget=16)

        self.assertEqual(request.operation, 'interrupt')
        self.assertEqual(request.coordinate, (0x30,))
        self.assertIs(state.pending, request)

        state, following = runtime.machine_step(
            state, MachineEvent('interrupt', request.coordinate), budget=16)

        self.assertEqual(following.operation, 'interrupt')
        self.assertEqual(state.cpu.register('rax'), 42)
        self.assertEqual(state.cpu.register('rsp'), 0x8000)
        self.assertEqual(runtime.dbt.layout()['delivered_interrupts'], 1)

    def test_cmos_clock_is_valid_and_never_reports_update_in_progress(self):
        # Select register A, read it, then select and read the BCD year.
        code = bytes.fromhex(
            'b0 0a e6 70 e4 71 88 c3 '
            'b0 09 e6 70 e4 71 f4')
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory_with((0x100, code)), 0x100))

        state, event = runtime.machine_step(state)

        self.assertIsNone(event)
        self.assertTrue(state.stopped)
        self.assertEqual(state.cpu.register('rbx') & 0x80, 0)
        self.assertEqual(state.cpu.register('rax') & 0xff, 0x26)

    def test_cmos_guest_write_is_snapshot_state(self):
        # Select seconds, write 42 BCD, then read the same register.
        code = bytes.fromhex(
            'b0 00 e6 70 b0 42 e6 71 b0 00 e6 70 e4 71 f4')
        runtime = X86Machine()
        state = runtime.start(initial_state(
            memory_with((0x100, code)), 0x100))

        state, event = runtime.machine_step(state)

        self.assertIsNone(event)
        self.assertEqual(state.cpu.register('rax') & 0xff, 0x42)
        self.assertTrue(state.io_ports)

    def test_internal_stores_share_one_persistent_memory_cut(self):
        # mov [rbx],al; mov [rbx+1],al; hlt
        memory = memory_with(
            (0x100, bytes.fromhex('88 03 88 43 01 f4')))
        dbt = X86DBT()
        state = initial_state(
            memory, 0x100, {'rax': ord('A'), 'rbx': 0x400})

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.memory.read(0x400, 2), b'AA')
        self.assertEqual(dbt.layout()['persistent_cuts'], 1)
        self.assertEqual(dbt.layout()['materialized_pages'], 1)

    def test_scalar_load_keeps_cross_page_bytes_in_direct_coordinates(self):
        memory = memory_with((0xffe, b'\x11\x22\x33\x44'))
        cut = MemoryCut(memory)
        cut.write(0xfff, b'\xaa\xbb')
        state = initial_state(cut)

        value = load_virtual(state, 0xffe, 4)

        self.assertEqual(value, 0x44bbaa11)
        self.assertEqual(cut.loads, 2)
        self.assertEqual(cut.merged_loads, 2)

    def test_virtual_page_fault_enters_the_guest_idt(self):
        code = bytes.fromhex('48 89 18 f4')
        memory = memory_with((0x100, code), (0x200, b'\xf4'))
        gate = bytearray(16)
        struct.pack_into('<H', gate, 0, 0x200)
        struct.pack_into('<H', gate, 2, 0x10)
        gate[5] = 0x8e
        memory = memory.write(0x5000 + 14 * 16, gate)
        dbt = X86DBT()
        state = initial_state(
            memory, 0x100,
            {'rax': 0x10000, 'rbx': 1, 'rsp': 0x4000},
            idtr=(0x5000, 0x1000 - 1), cs=0x10)

        state, boundary, _cost = dbt.run(state)

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(state.cr2, 0x10000)
        self.assertEqual(dbt.layout()['delivered_exceptions'], 1)
        self.assertEqual(state.memory.read(0x3fd0, 8), struct.pack('<Q', 2))
        self.assertEqual(state.memory.read(0x3fd8, 8), struct.pack('<Q', 0x100))
        self.assertEqual(state.memory.read(0x3ff0, 8),
                         struct.pack('<Q', 0x4000))


if __name__ == '__main__':
    unittest.main()
