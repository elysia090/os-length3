"""x86 checkpoints retain only canonical direct-page state."""

from dataclasses import replace
import json
import struct
import unittest

from kernel.machine import MachineEvent
from kernel.x86 import (BzImageBoot, BzImageHeader,
                        IA32_TIME_STAMP_COUNTER, REGISTER_INDEX,
                        MASK64, X86Boundary, X86DBT, X86Machine,
                        load_bzimage_kernel, initial_state)
from kernel.x86snapshot import (dump_native_x86_machine,
                                dump_x86_boot_cache, dump_x86_code_pages,
                                dump_x86_machine_state, dump_x86_state,
                                extend_native_x86_machine,
                                load_native_x86_machine,
                                load_x86_boot_cache, load_x86_code_pages,
                                load_x86_machine_state, load_x86_state,
                                pack_native_x86_block,
                                pack_native_x86_records, MAGIC,
                                native_x86_static_successors,
                                repack_native_x86_machine,
                                select_physical_cut,
                                split_native_x86_record,
                                NATIVE_BLOCK_HEADER, NATIVE_MACHINE_MAGIC)
from qm.steppage import (compile_mapped_executor, decode_plan,
                         unpack as unpack_step)
from qm.memorycut import MemoryCut
from qm.wasmwave import WaveCost
from qm.wasmstate import PagedMemory


def native_step(record):
    return split_native_x86_record(record)[2]


class TestX86Snapshot(unittest.TestCase):
    @staticmethod
    def bzimage():
        image = bytearray(4096)
        image[0x1f1] = 1
        image[0x1fe:0x200] = b'\x55\xaa'
        image[0x201] = 0x66
        image[0x202:0x206] = b'HdrS'
        image[0x206:0x208] = (0x20c).to_bytes(2, 'little')
        image[0x211] = 1
        image[0x214:0x218] = (0x100000).to_bytes(4, 'little')
        image[0x22c:0x230] = (0x7fffffff).to_bytes(4, 'little')
        image[0x230:0x234] = (0x200000).to_bytes(4, 'little')
        image[0x234] = 1
        image[0x236:0x238] = (1).to_bytes(2, 'little')
        image[0x238:0x23c] = (2048).to_bytes(4, 'little')
        image[0x258:0x260] = (0x200000).to_bytes(8, 'little')
        image[0x260:0x264] = (0x400000).to_bytes(4, 'little')
        return image

    def test_round_trip_retains_cpu_and_sparse_memory(self):
        memory = PagedMemory(b'base', 1 << 20)
        memory = memory.write(0x12340, b'changed')
        state = initial_state(
            memory, 0x123456789abcdef0,
            {'rax': 42, 'rsp': 0x8000},
            rflags=0x202, cr0=1, cr2=2, cr3=3, cr4=4, cr8=8,
            efer=0x500, gdtr=(0x1000, 31), idtr=(0x2000, 4095),
            cs=16, ds=24, es=24, ss=24, fs=32, gs=40,
            msrs=((0xc0000100, 0xfeed),), interrupts=(36,))

        payload = dump_x86_state(state)
        restored = load_x86_state(payload)

        self.assertEqual(restored, state)
        self.assertEqual(restored.memory.read(0x12340, 7), b'changed')
        self.assertLess(len(payload), 2048)

    def test_delta_retains_only_pages_changed_from_boot_memory(self):
        baseline = PagedMemory(b'', 1 << 20)
        baseline = baseline.write(0x10000, b'kernel' * 1000)
        memory = baseline.write(0x80000, b'dirty')
        state = initial_state(memory, 0x1234, {'rax': 42})

        payload = dump_x86_state(state, baseline)
        restored = load_x86_state(payload, baseline)

        self.assertEqual(restored, state)
        self.assertLess(len(payload), 2048)

    def test_sparse_page_record_is_domain_plus_dense_values(self):
        cut = MemoryCut(PagedMemory(bytes(range(256)), 1 << 20))
        cut.write(40, b'X')
        state = initial_state(cut.commit(), 0x1234)

        payload = dump_x86_state(state)
        header_bytes = struct.unpack_from('<I', payload, len(MAGIC))[0]
        header_start = len(MAGIC) + 4
        header = json.loads(
            payload[header_start:header_start + header_bytes])
        records = len(payload) - header_start - header_bytes \
            - header['base_bytes']

        self.assertEqual(records, 8 + 1 + 32 + 1)
        self.assertEqual(load_x86_state(payload), state)

    def test_delta_requires_its_boot_memory(self):
        baseline = PagedMemory(b'', 1024)
        payload = dump_x86_state(
            initial_state(baseline.write(1, b'x')), baseline)

        with self.assertRaises(ValueError):
            load_x86_state(payload)

    def test_non_canonical_page_order_is_rejected(self):
        state = initial_state(PagedMemory(b'', 1024).write(0, b'x'))
        payload = bytearray(dump_x86_state(state))
        header_bytes = int.from_bytes(
            payload[len(b'x86-state-v1\n'):len(b'x86-state-v1\n') + 4],
            'little')
        page = len(b'x86-state-v1\n') + 4 + header_bytes
        payload[page:page + 8] = (1 << 63).to_bytes(8, 'little')

        with self.assertRaises(ValueError):
            load_x86_state(payload)

    def test_machine_round_trip_retains_devices_input_and_pending_event(self):
        memory = PagedMemory(b'', 1 << 20).write(0x12340, b'changed')
        cpu = initial_state(
            memory, 0x100, msrs=((IA32_TIME_STAMP_COUNTER, 99),))
        pending = MachineEvent(
            'clock', (0x123,), thread=2,
            cost=WaveCost(3, 4, 5, 6, 7, 8))
        state = X86Machine().start(cpu)
        state = state.__class__(
            cpu, pending=pending, io_ports=((0x3f8, 65), (0x10042, 9)),
            console_input=b'ls\n', console_output=b'partial')

        payload = dump_x86_machine_state(state)
        restored = load_x86_machine_state(payload)

        self.assertEqual(restored, state)

    def test_machine_loader_accepts_legacy_cpu_only_checkpoint(self):
        cpu = initial_state(PagedMemory(b'', 4096), 0x123)

        restored = load_x86_machine_state(dump_x86_state(cpu))

        self.assertEqual(restored.cpu, cpu)
        self.assertEqual(restored.io_ports, ())

    def test_boot_artifact_restores_the_expanded_direct_page_baseline(self):
        image = self.bzimage()
        # A minimal ELF image is enough to exercise the portable boot format.
        elf = bytearray(0x180)
        elf[:6] = b'\x7fELF\x02\x01'
        import struct
        struct.pack_into('<16sHHIQQQIHHHHHH', elf, 0,
                         bytes(elf[:16]), 2, 62, 1, 0x100000,
                         64, 0, 0, 64, 56, 1, 0, 0, 0)
        struct.pack_into('<IIQQQQQQ', elf, 64,
                         1, 5, 0x100, 0x100000, 0x100000,
                         4, 0x1000, 0)
        elf[0x100:0x104] = b'\x90\x90\x90\xc3'
        import gzip
        compressed = gzip.compress(bytes(elf))
        payload_offset = 1024
        image[0x248:0x24c] = (0).to_bytes(4, 'little')
        image[0x24c:0x250] = len(compressed).to_bytes(4, 'little')
        image[payload_offset:payload_offset + len(compressed)] = compressed
        image = image[:payload_offset + len(compressed)]

        boot = load_bzimage_kernel(image, memory_bytes=8 << 20)
        wire = dump_x86_boot_cache(boot)
        restored = load_x86_boot_cache(memoryview(wire))

        self.assertEqual(
            restored.state.__class__(**{
                field: getattr(restored.state, field)
                for field in restored.state.__dataclass_fields__
                if field != 'memory'
            }, memory=boot.state.memory),
            boot.state)
        opened = restored.state.memory._backing.layout()
        self.assertEqual(opened['resident_spans'], 0)
        self.assertEqual(opened['mapped_records_materialized'], 0)
        self.assertEqual(restored.state.memory.read(0x200000, 4),
                         b'\x90\x90\x90\xc3')
        self.assertEqual(
            restored.state.memory._backing.layout()[
                'mapped_records_materialized'], 1)

        block = X86DBT().block(boot.state)
        native = dump_native_x86_machine(wire, boot.state, (block,))
        header_bytes = struct.unpack_from(
            '<I', native, len(NATIVE_MACHINE_MAGIC))[0]
        start = len(NATIVE_MACHINE_MAGIC) + 4
        native_header = json.loads(native[start:start + header_bytes])
        self.assertEqual(native_header['schema'], 5)
        self.assertEqual(native_header['state']['rip'],
                         '%016x' % boot.state.rip)
        self.assertEqual(native_header['memory']['length'],
                         len(boot.state.memory))
        self.assertEqual(native_header['block_count'],
                         len(pack_native_x86_records(block)))
        self.assertEqual(native_header['regions']['page_bytes'], 1 << 16)
        self.assertEqual(
            tuple(offset % (1 << 16) for offset, _length in (
                native_header['regions']['memory'],
                native_header['regions']['descriptors'],
                native_header['regions']['execution'])),
            (0, 0, 0))
        self.assertEqual(repack_native_x86_machine(native), native)

    def test_reached_code_pages_restore_without_decoding_x86_again(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('48 8b 00 48 83 c0 01 c3'))
        state = initial_state(memory, 0x100, {'rax': 0x200})
        source = X86DBT()
        expected = source.block(state)

        restored = load_x86_code_pages(
            dump_x86_code_pages(source), state)
        actual = restored.blocks[0x100]

        self.assertEqual(actual.source, expected.source)
        self.assertEqual(bytes(actual.mapped.data), bytes(expected.mapped.data))
        self.assertEqual(actual.boundary, expected.boundary)
        self.assertEqual(restored.layout()['decoded_basic_blocks'], 0)
        self.assertEqual(restored.layout()['restored_code_blocks'], 1)
        self.assertEqual(restored.layout()['resident_basic_blocks'], 1)

    def test_native_block_is_a_fixed_control_record_plus_physical_page(self):
        code = bytes.fromhex(
            '48 c7 c2 84 c0 8a 81 '
            '48 c7 c0 68 10 95 81 '
            '48 0f 45 c2 f4')
        state = initial_state(
            PagedMemory(b'', 4096).write(0x100, code), 0x100)
        dbt = X86DBT()
        dbt.run(state)
        block = dbt._register_cuts[0x100][1]

        record = pack_native_x86_block(block)
        (magic, version, header_bytes, rip, boundary_rip, page_bytes,
         control, following, _target, _condition) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        page = unpack_step(native_step(record))

        self.assertEqual((magic, version, header_bytes),
                         (b'X86B', 2, 64))
        self.assertEqual(rip, 0x100)
        self.assertEqual(boundary_rip, block.boundary_rip)
        self.assertEqual(page_bytes, len(native_step(record)))
        self.assertEqual(control, 4)
        self.assertEqual(following, block.boundary.detail)
        self.assertGreaterEqual(page.local_extent, 17)

    def test_native_machine_extension_preserves_memory_and_adds_one_cut(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('eb 0e') + bytes(14) + bytes.fromhex('f4'))
        state = initial_state(memory, 0x100)
        header = BzImageHeader(
            setup_sectors=1, protocol=0x20c, load_flags=1,
            code32_start=0, initrd_address_max=0,
            kernel_alignment=0x200000, relocatable=True, xload_flags=1,
            command_line_bytes=2048, preferred_address=0,
            init_bytes=4096)
        wire = dump_x86_boot_cache(BzImageBoot(
            state, header, 0, 0, 0))
        first = X86DBT().block(state)
        machine = dump_native_x86_machine(wire, state, (first,))
        second = X86DBT().block(replace(state, rip=0x110))
        extra = pack_native_x86_records(second)

        extended = extend_native_x86_machine(machine, extra)
        prefix = len(NATIVE_MACHINE_MAGIC)
        header_bytes = struct.unpack_from('<I', extended, prefix)[0]
        start = prefix + 4
        header = json.loads(extended[start:start + header_bytes])

        self.assertEqual(header['block_count'], 2)
        self.assertEqual(
            header['memory']['prefix_sha256'],
            json.loads(machine[
                start:start + struct.unpack_from('<I', machine, prefix)[0]
            ])['memory']['prefix_sha256'])
        self.assertEqual(
            extend_native_x86_machine(extended, extra), extended)

    def test_optimizer_extension_replaces_same_proved_coordinate(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('eb 0e') + bytes(14) + bytes.fromhex('f4'))
        state = initial_state(memory, 0x100)
        header = BzImageHeader(
            setup_sectors=1, protocol=0x20c, load_flags=1,
            code32_start=0, initrd_address_max=0,
            kernel_alignment=0x200000, relocatable=True, xload_flags=1,
            command_line_bytes=2048, preferred_address=0,
            init_bytes=4096)
        wire = dump_x86_boot_cache(BzImageBoot(state, header, 0, 0, 0))
        original = X86DBT().block(state)
        machine = dump_native_x86_machine(wire, state, (original,))
        stronger = replace(
            original, boundary=X86Boundary('branch', 0x120))
        replacement = pack_native_x86_records(stronger)

        extended = extend_native_x86_machine(
            machine, replacement, reject_conflicts=False,
            replace_proved=True)
        _metadata, _memory, records = load_native_x86_machine(extended)

        self.assertEqual(records, replacement)

    def test_general_dynamic_record_removes_state_specialized_variant(self):
        caller = bytes.fromhex('ff d0 f4')
        callee = bytes.fromhex('b8 2a 00 00 00 c3')
        memory = PagedMemory(b'', 4096).write(0x100, caller) \
            .write(0x200, callee).write(0x800, bytes(8))
        state = initial_state(
            memory, 0x100, {'rax': 0x200, 'rsp': 0x808})
        header = BzImageHeader(
            setup_sectors=1, protocol=0x20c, load_flags=1,
            code32_start=0, initrd_address_max=0,
            kernel_alignment=0x200000, relocatable=True, xload_flags=1,
            command_line_bytes=2048, preferred_address=0,
            init_bytes=4096)
        wire = dump_x86_boot_cache(BzImageBoot(state, header, 0, 0, 0))
        dynamic = X86DBT().physical_block(state)
        self.assertEqual(dynamic.boundary.operation, 'dynamic_branch')
        specialized = replace(
            dynamic,
            plan=replace(dynamic.plan, locals=dynamic.plan.locals[:-1]),
            scratch_count=0, boundary=X86Boundary('branch', 0x200),
            code_extents=((0x100, caller[:2]), (0x200, callee)),
            inlined_call_target=0x200)
        machine = dump_native_x86_machine(wire, state, (specialized,))

        extended = extend_native_x86_machine(
            machine, pack_native_x86_records(dynamic),
            reject_conflicts=False, replace_proved=True)
        _metadata, _memory, records = load_native_x86_machine(extended)

        self.assertEqual(len(records), 1)
        fields, guard, _step = split_native_x86_record(records[0][1])
        self.assertEqual(fields[6], 3)
        self.assertEqual(struct.unpack_from('<H', guard)[0], 1)

    def test_native_machine_shares_step_identity_between_descriptors(self):
        memory = PagedMemory(b'', 4096).write(0x100, bytes.fromhex('f4'))
        state = initial_state(memory, 0x100)
        header = BzImageHeader(
            setup_sectors=1, protocol=0x20c, load_flags=1,
            code32_start=0, initrd_address_max=0,
            kernel_alignment=0x200000, relocatable=True, xload_flags=1,
            command_line_bytes=2048, preferred_address=0,
            init_bytes=4096)
        wire = dump_x86_boot_cache(BzImageBoot(state, header, 0, 0, 0))
        record = pack_native_x86_block(X86DBT().block(state))
        fields = list(NATIVE_BLOCK_HEADER.unpack_from(record))
        fields[3] = 0x200
        fields[4] += 0x100
        _original_fields, original_guard, step = \
            split_native_x86_record(record)
        alias_guard = bytearray(original_guard)
        struct.pack_into('<Q', alias_guard, 2, 0x200)
        alias = NATIVE_BLOCK_HEADER.pack(*fields) + alias_guard + step

        machine = dump_native_x86_machine(
            wire, state, (X86DBT().block(state),))
        shared = extend_native_x86_machine(machine, ((0x200, alias),))
        metadata, _memory, records = load_native_x86_machine(shared)

        self.assertEqual(metadata['step_identity'], {
            'kind': 'template-parameter-rank', 'order': 'first-rip',
            'records': 2, 'shared': 1, 'unique': 1,
        })
        self.assertEqual(metadata['step_template_identity'], {
            'kind': 'normalized-ssa-frame-projection',
            'instances': 1, 'order': 'first-rip',
            'shared': 0, 'unique': 1,
        })
        self.assertEqual(metadata['continuation_identity'], {
            'kind': 'field-residual-tail-offset-csr',
            'order': 'first-rip', 'records': 2,
            'shared': 1, 'unique': 1,
        })
        self.assertEqual(
            metadata['descriptor_bytes'],
            2 * 20 + 16 + 8 + 2 * 8 + 2 * 4
            + metadata['continuation_bytes'])
        self.assertEqual(native_step(records[0][1]),
                         native_step(records[1][1]))

    def test_native_conditional_record_closes_both_static_successors(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('74 05 f4 90 90 90 90 f4')),
            0x100)
        record = pack_native_x86_block(X86DBT().block(state))

        self.assertEqual(
            native_x86_static_successors(record), (0x102, 0x107))

    def test_native_fninit_is_the_ordinary_next_rip_quotient(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('db e3 f4')), 0x100)

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)

        self.assertEqual((fields[6], fields[7]), (1, 0x102))
        self.assertEqual(native_x86_static_successors(record), (0x102,))

    def test_native_memory_fence_is_the_next_rip_barrier_quotient(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('0f ae e8 f4')), 0x100)

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)

        self.assertEqual((fields[6], fields[7]), (1, 0x103))
        self.assertEqual(native_x86_static_successors(record), (0x103,))

    def test_native_fxsave_is_one_sparse_general_memory_projection(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('0f ae 05 09 00 00 00 f4')), 0x100)

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        plan = decode_plan(mapped)
        memory = MemoryCut(state.memory)
        compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), memory)

        self.assertEqual((fields[6], fields[7]), (1, 0x107))
        self.assertEqual(
            tuple(node.op for node in plan.nodes).count(
                'memory.i64.repeat'), 1)
        self.assertEqual(memory.load(0x110, 2), 0x037f)
        self.assertEqual(memory.load(0x128, 4), 0x1f80)
        self.assertEqual(memory.load(0x12c, 4), 0x0000ffff)
        self.assertEqual(memory.read(0x110, 512)[32:], bytes(480))

    def test_native_fxrstor_stays_on_the_ordinary_next_rip_quotient(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('48 0f ae 4f 40 f4'))
        state = initial_state(
            memory.write(0x440, bytes(512)), 0x100, {'rdi': 0x400})

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)

        self.assertEqual((fields[6], fields[7]), (1, 0x105))
        self.assertEqual(native_x86_static_successors(record), (0x105,))

    def test_native_memory_push_uses_the_predecrement_source_coordinate(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('ff 74 24 28 f4'))
        memory = memory.write(
            0x828, (0x1122334455667788).to_bytes(8, 'little'))
        state = initial_state(memory, 0x100, {'rsp': 0x800})

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        cut = MemoryCut(state.memory)
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), cut)

        self.assertEqual((fields[6], fields[7]), (1, 0x104))
        self.assertEqual(locals_[REGISTER_INDEX['rsp']], 0x7f8)
        self.assertEqual(cut.load(0x7f8, 8), 0x1122334455667788)

    def test_native_repeat_store_is_one_general_memory_state_page(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(0x100, bytes.fromhex('f3 aa f4')),
            0x100, {'rax': 0xab, 'rcx': 32, 'rdi': 0x800})
        block = X86DBT().block(state)

        record = pack_native_x86_block(block)
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _target, _condition) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        page = unpack_step(native_step(record))

        self.assertEqual((control, following), (1, 0x102))
        self.assertEqual(page.instructions, 1)
        self.assertIn('memory.i64.repeat',
                      tuple(node.op for node in decode_plan(page).nodes))
        self.assertGreaterEqual(page.local_extent, 17)

    def test_native_repeat_move_is_one_overlap_safe_memory_lane(self):
        source = PagedMemory(b'', 4096).write(0x800, b'abcdef')
        state = initial_state(
            source.write(0x100, bytes.fromhex('f3 a4 f4')), 0x100,
            {'rcx': 6, 'rsi': 0x800, 'rdi': 0x900})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _target, _condition) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        plan = decode_plan(mapped)
        memory = MemoryCut(state.memory)
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), memory)

        self.assertEqual((control, following), (1, 0x102))
        self.assertIn('memory.i64.copy', tuple(node.op for node in plan.nodes))
        self.assertEqual(memory.read(0x900, 6), b'abcdef')
        self.assertEqual(locals_[REGISTER_INDEX['rcx']], 0)
        self.assertEqual(locals_[REGISTER_INDEX['rsi']], 0x806)
        self.assertEqual(locals_[REGISTER_INDEX['rdi']], 0x906)

    def test_native_single_movsb_uses_the_general_memory_ssa(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('a4 f4')).write(0x400, b'Z')
        state = initial_state(
            memory, 0x100, {'rsi': 0x400, 'rdi': 0x500, 'rcx': 7})

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        cut = MemoryCut(state.memory)
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), cut)

        self.assertEqual((fields[6], fields[7]), (1, 0x101))
        self.assertEqual(cut.read(0x500, 1), b'Z')
        self.assertEqual((locals_[REGISTER_INDEX['rsi']],
                          locals_[REGISTER_INDEX['rdi']],
                          locals_[REGISTER_INDEX['rcx']]),
                         (0x401, 0x501, 7))

    def test_native_terminal_immediate_multiply_is_closed_inside_ssa(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('48 6b c1 05 f4')),
            0x100, {'rcx': 1 << 62})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _target, _condition) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags, 0), (), MemoryCut(state.memory))

        self.assertEqual((control, following), (1, 0x104))
        self.assertEqual(locals_[REGISTER_INDEX['rax']], 1 << 62)
        self.assertEqual(locals_[16] & ((1 << 11) | 1), (1 << 11) | 1)

    def test_native_memory_immediate_multiply_is_four_physical_lanes(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('48 6b 01 05 f4'))
        state = initial_state(
            memory.write(0x400, struct.pack('<q', -3)), 0x100,
            {'rcx': 0x400})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _target, _condition) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        plan = decode_plan(mapped)
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), MemoryCut(state.memory))

        self.assertEqual((control, following), (1, 0x104))
        self.assertEqual(locals_[REGISTER_INDEX['rax']], (MASK64 - 14))
        self.assertFalse(locals_[16] & ((1 << 11) | 1))
        self.assertEqual(plan.waves.work, 4)
        self.assertEqual(tuple(node.op for node in plan.nodes), (
            'memory.i64.load', 'lane64.IMUL',
            'lane64.MUL_HIGH', 'lane64.X86_MUL_FLAGS'))

    def test_native_terminal_lea_is_closed_inside_register_ssa(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('ba 10 00 00 00 48 8d 7c 24 10 f4')),
            0x100, {'rsp': 0x800})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _target, _condition) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), MemoryCut(state.memory))

        self.assertEqual((control, following), (1, 0x10a))
        self.assertEqual(locals_[REGISTER_INDEX['rdx']], 16)
        self.assertEqual(locals_[REGISTER_INDEX['rdi']], 0x810)
        self.assertEqual(locals_[16], state.rflags)

    def test_native_terminal_compare_exchange_is_one_memory_ssa_page(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('f0 48 0f b1 0b f4'))
        state = initial_state(
            memory.write(0x400, bytes(8)), 0x100,
            {'rbx': 0x400, 'rcx': 0x1122})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _target, _condition) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        cut = MemoryCut(state.memory)
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), cut)

        self.assertEqual((control, following), (1, 0x105))
        self.assertEqual(locals_[REGISTER_INDEX['rax']], 0)
        self.assertTrue(locals_[16] & (1 << 6))
        self.assertEqual(cut.read(0x400, 8), struct.pack('<Q', 0x1122))

    def test_native_terminal_bit_scan_keeps_zero_destination_undefined(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('0f bd c1 f4')),
            0x100, {'rax': 0xfeed, 'rcx': 0})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _target, _condition) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), MemoryCut(state.memory))

        self.assertEqual((control, following), (1, 0x103))
        self.assertEqual(locals_[REGISTER_INDEX['rax']], 0xfeed)
        self.assertTrue(locals_[16] & (1 << 6))

    def test_native_terminal_negation_is_closed_inside_ssa(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('48 f7 d8 f4')),
            0x100, {'rax': 7})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _target, _condition) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), MemoryCut(state.memory))

        self.assertEqual((control, following), (1, 0x103))
        self.assertEqual(locals_[REGISTER_INDEX['rax']], (-7) & ((1 << 64) - 1))
        self.assertTrue(locals_[16] & 1)

    def test_native_terminal_wide_multiply_is_three_physical_lanes(self):
        cases = (
            ('48 f7 e2 f4', (1 << 64) - 1, 2,
             (1 << 64) - 2, 1, True),
            ('48 f7 ea f4', (1 << 64) - 2, 3,
             (1 << 64) - 6, (1 << 64) - 1, False),
        )
        for code, rax, rdx, low, high, overflow in cases:
            with self.subTest(code=code):
                state = initial_state(
                    PagedMemory(b'', 4096).write(
                        0x100, bytes.fromhex(code)),
                    0x100, {'rax': rax, 'rdx': rdx})

                record = pack_native_x86_block(X86DBT().block(state))
                (_magic, _version, header_bytes, _rip, _boundary_rip,
                 _page_bytes, control, following, _target, _condition) = \
                    NATIVE_BLOCK_HEADER.unpack_from(record)
                mapped = unpack_step(native_step(record))
                plan = decode_plan(mapped)
                locals_, _stack = compile_mapped_executor(mapped)(
                    state.registers + (state.rflags,), (),
                    MemoryCut(state.memory))

                self.assertEqual((control, following), (1, 0x103))
                self.assertEqual(locals_[REGISTER_INDEX['rax']], low)
                self.assertEqual(locals_[REGISTER_INDEX['rdx']], high)
                self.assertEqual(bool(locals_[16] & 0x801), overflow)
                self.assertEqual(
                    tuple(node.op for node in plan.nodes)[-3:],
                    ('lane64.MULR', 'lane64.MUL_HIGH',
                     'lane64.X86_MUL_FLAGS'))

    def test_native_segment_read_stays_inside_vm_control_state(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('8c d0 f4')),
            0x100, {'rax': (1 << 64) - 1})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, _header_bytes, _rip, _boundary_rip,
         _page_bytes, control, following, segment, target) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)

        self.assertEqual((control, following), (16, 0x102))
        self.assertEqual(segment, 2)
        self.assertEqual(target, 32 << 8)

    def test_native_segment_to_memory_uses_the_general_memory_ssa(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('8c 63 8d f4')),
            0x100, {'rbx': 0x400})
        state = replace(state, fs=0x1234)

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip,
         _page_bytes, control, following, segment, descriptor) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        cut = MemoryCut(state.memory)
        compile_mapped_executor(mapped)(
            state.registers + (state.rflags, state.fs), (), cut)

        self.assertEqual((control, following, segment), (16, 0x103, 4))
        self.assertEqual(descriptor, 17 | (16 << 8) | (1 << 16))
        self.assertEqual(mapped.local_extent, 18)
        self.assertIn('memory.i64.store16',
                      tuple(node.op for node in decode_plan(mapped).nodes))
        self.assertEqual(cut.read(0x38d, 2), b'\x34\x12')

    def test_native_invalidate_page_publishes_only_its_virtual_coordinate(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('0f 01 3f f4')),
            0x100, {'rdi': 0x12345000})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip,
         _page_bytes, control, following, address_local, _unused) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags, 0), (), MemoryCut(state.memory))

        self.assertEqual((control, following, address_local), (19, 0x103, 17))
        self.assertEqual(locals_[address_local], 0x12345000)
        self.assertFalse(any(
            node.op.startswith('memory.')
            for node in decode_plan(mapped).nodes))

    def test_native_clock_is_an_explicit_resident_barrier(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('0f 31 f4')),
            0x100)

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, _header_bytes, _rip, _boundary_rip,
         _page_bytes, control, following, _unused, _unused2) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)

        self.assertEqual((control, following), (20, 0x102))
        self.assertEqual(native_x86_static_successors(record), (0x102,))

    def test_native_debug_register_uses_the_shared_control_record(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('0f 21 c0 f4')),
            0x100)

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, _header_bytes, _rip, _boundary_rip,
         _page_bytes, control, following, descriptor, _unused) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)

        self.assertEqual((control, following), (21, 0x103))
        self.assertEqual(descriptor, 0x21)
        self.assertEqual(native_x86_static_successors(record), (0x103,))

    def test_native_store_descriptor_uses_general_memory_ssa(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('0f 01 44 24 0e f4')),
            0x100, {'rsp': 0x400})
        state = replace(state, gdtr=(0x1122334455667788, 0xabcd))

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip,
         _page_bytes, control, following, name, descriptor) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        cut = MemoryCut(state.memory)
        compile_mapped_executor(mapped)(
            state.registers + (state.rflags, 0xabcd,
                               0x1122334455667788), (), cut)

        self.assertEqual((control, following, name), (26, 0x105, 0))
        self.assertEqual(descriptor, 17 | (18 << 8))
        self.assertEqual(
            cut.read(0x40e, 10),
            bytes.fromhex('cdab8877665544332211'))
        operations = tuple(
            node.op for node in decode_plan(mapped).nodes)
        self.assertIn('memory.i64.store16', operations)
        self.assertIn('memory.i64.store', operations)

    def test_native_system_segment_register_has_one_control_shape(self):
        for code, name in (('0f 00 d0 f4', 0), ('0f 00 d8 f4', 1)):
            with self.subTest(code=code):
                state = initial_state(
                    PagedMemory(b'', 4096).write(
                        0x100, bytes.fromhex(code)),
                    0x100, {'rax': 0x1234})
                record = pack_native_x86_block(X86DBT().block(state))
                (_magic, _version, _header_bytes, _rip, _boundary_rip,
                 _page_bytes, control, following, coordinate, descriptor) = \
                    NATIVE_BLOCK_HEADER.unpack_from(record)

                self.assertEqual(
                    (control, following, coordinate, descriptor),
                    (27, 0x103, name, 0))
                self.assertEqual(native_x86_static_successors(record),
                                 (0x103,))

    def test_native_swapgs_has_one_resident_control_shape(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('0f 01 f8 f4')),
            0x100)

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, _header_bytes, _rip, _boundary_rip,
         _page_bytes, control, following, _unused, _unused2) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)

        self.assertEqual((control, following), (28, 0x103))
        self.assertEqual(native_x86_static_successors(record), (0x103,))

    def test_native_syscall_and_sysret_have_resident_control_shapes(self):
        for code, expected in (('0f 05 f4', (29, 0x102)),
                               ('48 0f 07 f4', (30, 0x103))):
            with self.subTest(code=code):
                state = initial_state(
                    PagedMemory(b'', 4096).write(
                        0x100, bytes.fromhex(code)), 0x100)
                record = pack_native_x86_block(X86DBT().block(state))
                fields = NATIVE_BLOCK_HEADER.unpack_from(record)

                self.assertEqual((fields[6], fields[7]), expected)
                self.assertEqual(native_x86_static_successors(record), ())

    def test_native_integer_vector_controls_are_resident(self):
        cases = (
            ('66 48 0f 6e c3 f4', 31, 0x105),
            ('66 0f 6c c0 f4', 32, 0x104),
            ('66 0f ef c0 f4', 35, 0x104),
        )
        for code, expected_control, following in cases:
            with self.subTest(code=code):
                state = initial_state(
                    PagedMemory(b'', 4096).write(
                        0x100, bytes.fromhex(code)), 0x100)
                record = pack_native_x86_block(X86DBT().block(state))
                fields = NATIVE_BLOCK_HEADER.unpack_from(record)
                self.assertEqual((fields[6], fields[7]),
                                 (expected_control, following))

    def test_native_vector_store_is_two_general_memory_lanes(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('0f 11 43 10 f4')),
            0x100, {'rbx': 0x400}, xmm=(0x1122, 0x3344) + (0,) * 30)

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        cut = MemoryCut(state.memory)
        inputs = state.registers + (state.rflags, 0x1122, 0x3344)
        compile_mapped_executor(mapped)(inputs, (), cut)

        self.assertEqual((fields[6], fields[7]), (33, 0x104))
        self.assertEqual(cut.read(0x410, 16),
                         struct.pack('<QQ', 0x1122, 0x3344))
        self.assertEqual(
            tuple(node.op for node in decode_plan(mapped).nodes).count(
                'memory.i64.store'), 2)

    def test_native_vector_load_is_two_general_memory_lanes(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('66 0f 6f 53 10 f4'))
        state = initial_state(
            memory.write(0x410, struct.pack('<QQ', 0x1122, 0x3344)),
            0x100, {'rbx': 0x400})

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags, 0, 0), (),
            MemoryCut(state.memory))

        self.assertEqual((fields[6], fields[7]), (36, 0x105))
        self.assertEqual(locals_[-2:], (0x1122, 0x3344))
        self.assertEqual(
            tuple(node.op for node in decode_plan(mapped).nodes),
            ('memory.i64.load_region',))

    def test_native_unaligned_vector_load_uses_the_same_two_lanes(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('f3 0f 6f 02 f4'))
        state = initial_state(
            memory.write(0x403, struct.pack('<QQ', 0x1122, 0x3344)),
            0x100, {'rdx': 0x403})

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags, 0, 0), (),
            MemoryCut(state.memory))

        self.assertEqual((fields[6], fields[7]), (36, 0x104))
        self.assertEqual(locals_[-2:], (0x1122, 0x3344))

    def test_native_fs_load_admits_one_segment_base_coordinate(self):
        code = bytes.fromhex('64 48 8b 04 25 00 00 00 00 f4')
        memory = PagedMemory(b'', 4096).write(0x100, code)
        state = initial_state(
            memory.write(0x400, struct.pack('<Q', 0x1122334455667788)),
            0x100, msrs=((0xc0000100, 0x400),))

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        inputs = state.registers + (state.rflags, 0x400)
        locals_, _stack = compile_mapped_executor(mapped)(
            inputs, (), MemoryCut(state.memory))

        self.assertEqual((fields[6], fields[7], fields[8], fields[9]),
                         (34, 0x109, 0, 17))
        self.assertEqual(locals_[REGISTER_INDEX['rax']],
                         0x1122334455667788)

    def test_native_fs_alu_reuses_the_segment_memory_control(self):
        code = bytes.fromhex('64 48 2b 14 25 28 00 00 00 f4')
        memory = PagedMemory(b'', 4096).write(0x100, code)
        state = initial_state(
            memory.write(0x428, struct.pack('<Q', 3)),
            0x100, {'rdx': 8}, msrs=((0xc0000100, 0x400),))

        record = pack_native_x86_block(X86DBT().block(state))
        fields = NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags, 0x400), (),
            MemoryCut(state.memory))

        self.assertEqual((fields[6], fields[7], fields[8], fields[9]),
                         (34, 0x109, 0, 17))
        self.assertEqual(locals_[REGISTER_INDEX['rdx']], 5)

    def test_native_exception_has_no_static_successor(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('0f 0b f4')),
            0x100)

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, _header_bytes, _rip, _boundary_rip,
         _page_bytes, control, following, vector, error_code) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)

        self.assertEqual((control, following, vector), (22, 0x100, 6))
        self.assertEqual(error_code, MASK64)
        self.assertEqual(native_x86_static_successors(record), ())

    def test_faultable_terminal_instruction_keeps_a_pure_prefix_cut(self):
        code = bytes.fromhex(
            '48 c7 c1 04 00 00 00 '
            '48 c7 c6 00 08 00 00 '
            '48 c7 c7 00 09 00 00 '
            'f3 a4 f4')
        state = initial_state(
            PagedMemory(b'', 4096).write(0x100, code), 0x100)
        block = X86DBT().block(state)

        records = pack_native_x86_records(block)
        headers = [NATIVE_BLOCK_HEADER.unpack_from(record)
                   for _rip, record in records]

        self.assertEqual(tuple(rip for rip, _record in records),
                         (0x100, block.boundary_rip))
        self.assertEqual(headers[0][6], 15)
        self.assertEqual(headers[0][7], block.boundary_rip)
        self.assertEqual(headers[1][6], 1)
        retirement = tuple(
            unpack_step(native_step(record)).instructions
            for _rip, record in records)
        self.assertEqual(retirement, (3, 1))
        self.assertEqual(sum(retirement), 4)
        terminal = decode_plan(unpack_step(native_step(records[1][1])))
        self.assertIn('memory.i64.copy',
                      tuple(node.op for node in terminal.nodes))

    def test_faultable_flag_terminal_packs_a_canonical_zero_width_identity(self):
        code = bytes.fromhex(
            '48 c7 c1 04 00 00 00 '
            '48 83 38 01 f4')
        state = initial_state(
            PagedMemory(b'', 4096).write(0x100, code), 0x100,
            {'rax': 0x800})

        records = pack_native_x86_records(X86DBT().block(state))
        terminal = records[-1][1]
        header = NATIVE_BLOCK_HEADER.unpack_from(terminal)
        mapped = unpack_step(native_step(terminal))

        self.assertEqual(mapped.end - mapped.start, mapped.instructions)
        self.assertEqual(mapped.instructions, 1)

    def test_native_interrupt_return_is_one_stack_state_page(self):
        frame = struct.pack('<5Q', 0x12345678, 0x10, 0x246, 0x900, 0x18)
        memory = PagedMemory(b'', 4096).write(0x100, b'\xcf\xf4')
        state = initial_state(
            memory.write(0x800, frame), 0x100, {'rsp': 0x800})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, target, selector, restored_ss) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,) + (0, 0, 0), (),
            MemoryCut(state.memory))

        self.assertEqual((control, target, selector, restored_ss),
                         (14, 17, 18, 19))
        self.assertEqual(locals_[REGISTER_INDEX['rsp']], 0x900)
        self.assertEqual(locals_[16], 0x246)
        self.assertEqual(locals_[17:20], (0x12345678, 0x10, 0x18))

    def test_native_pop_memory_uses_post_increment_stack_address(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('8f 04 24 f4'))
        memory = memory.write(0x800, struct.pack('<Q', 0x1122334455667788))
        state = initial_state(memory, 0x100, {'rsp': 0x800})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _unused, _unused2) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        cut = MemoryCut(state.memory)
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), cut)

        self.assertEqual((control, following), (1, 0x103))
        self.assertEqual(locals_[REGISTER_INDEX['rsp']], 0x808)
        self.assertEqual(
            cut.read(0x808, 8), struct.pack('<Q', 0x1122334455667788))

    def test_native_indirect_memory_control_is_a_dynamic_state_page(self):
        for opcode, expected_store in ((0x25, False), (0x15, True)):
            with self.subTest(opcode=opcode):
                code = bytes((0xff, opcode, 0, 0, 0, 0))
                memory = PagedMemory(b'', 4096).write(0x100, code)
                memory = memory.write(0x106, struct.pack('<Q', 0x300))
                state = initial_state(memory, 0x100, {'rsp': 0x800})

                record = pack_native_x86_block(X86DBT().block(state))
                (_magic, _version, header_bytes, _rip, _boundary_rip,
                 _page_bytes, control, local, _unused, _unused2) = \
                    NATIVE_BLOCK_HEADER.unpack_from(record)
                operations = tuple(
                    node.op for node in
                    decode_plan(unpack_step(native_step(record))).nodes)

                self.assertEqual((control, local), (3, 17))
                self.assertIn('memory.i64.load', operations)
                stores = any(operation.startswith(
                    ('memory.i64.store', 'memory.i64.pre_store'))
                    for operation in operations)
                self.assertEqual(stores, expected_store)

    def test_native_idiv_is_total_ssa_with_one_error_predicate(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('41 f7 fc f4')),
            0x100, {'rax': 84, 'rdx': 0, 'r12': 2})
        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, error_local, instruction) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        page = decode_plan(unpack_step(native_step(record)))

        self.assertEqual((control, following, error_local),
                         (13, 0x103, 17))
        self.assertEqual(instruction, 0x100)
        self.assertIn('lane64.DIV_S',
                      tuple(node.op for node in page.nodes))
        self.assertEqual(len(page.locals), 18)

    def test_native_memory_idiv_uses_the_same_total_ssa(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('f7 7c 24 04 f4'))
        memory = memory.write(0x204, struct.pack('<I', 2))
        state = initial_state(
            memory, 0x100, {'rax': 84, 'rdx': 0, 'rsp': 0x200})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, error_local, instruction) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        page = decode_plan(unpack_step(native_step(record)))

        self.assertEqual((control, following, error_local, instruction),
                         (13, 0x104, 17, 0x100))
        self.assertIn('memory.i64.load32_u',
                      tuple(node.op for node in page.nodes))

    def test_native_memory_multiply_uses_general_memory_ssa(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('48 0f af 7b 18 f4'))
        memory = memory.write(0x218, struct.pack('<Q', 7))
        state = initial_state(memory, 0x100, {'rdi': 6, 'rbx': 0x200})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _unused, _unused2) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), MemoryCut(state.memory))

        self.assertEqual((control, following), (1, 0x105))
        self.assertEqual(locals_[REGISTER_INDEX['rdi']], 42)
        self.assertIn('lane64.X86_MUL_FLAGS',
                      tuple(node.op for node in decode_plan(mapped).nodes))

    def test_native_wide_divide_is_one_architecture_primitive(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('48 f7 f7 f4')),
            0x100, {'rax': 84, 'rdx': 0, 'rdi': 2})
        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, _header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, instruction, descriptor) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)

        self.assertEqual((control, following, instruction, descriptor),
                         (23, 0x103, 0x100, 7))
        self.assertEqual(native_x86_static_successors(record), (0x103,))

    def test_native_entropy_is_an_explicit_host_barrier(self):
        state = initial_state(
            PagedMemory(b'', 4096).write(
                0x100, bytes.fromhex('48 0f c7 f8 f4')),
            0x100)
        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, _header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, descriptor, _unused) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)

        self.assertEqual((control, following, descriptor),
                         (25, 0x104, (64 << 8) | (1 << 16)))
        self.assertEqual(native_x86_static_successors(record), (0x104,))

    def test_native_memory_exchange_stays_in_general_memory_ssa(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('87 05 10 00 00 00 f4'))
        memory = memory.write(0x116, struct.pack('<I', 9))
        state = initial_state(memory, 0x100, {'rax': 7})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _unused, _unused2) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        cut = MemoryCut(state.memory)
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), cut)

        self.assertEqual((control, following), (1, 0x106))
        self.assertEqual(locals_[REGISTER_INDEX['rax']], 9)
        self.assertEqual(cut.read(0x116, 4), struct.pack('<I', 7))

    def test_native_memory_exchange_add_stays_in_general_memory_ssa(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('0f c1 05 10 00 00 00 f4'))
        memory = memory.write(0x117, struct.pack('<I', 9))
        state = initial_state(memory, 0x100, {'rax': 7})

        record = pack_native_x86_block(X86DBT().block(state))
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, _unused, _unused2) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        mapped = unpack_step(native_step(record))
        cut = MemoryCut(state.memory)
        locals_, _stack = compile_mapped_executor(mapped)(
            state.registers + (state.rflags,), (), cut)

        self.assertEqual((control, following), (1, 0x107))
        self.assertEqual(locals_[REGISTER_INDEX['rax']], 9)
        self.assertEqual(cut.read(0x117, 4), struct.pack('<I', 16))

    def test_native_countdown_loop_is_one_recurrence_record(self):
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('48 ff c8 75 fb 48 ff c8 f4'))
        state = initial_state(memory, 0x100, {'rax': 5})
        dbt = X86DBT(enable_function_oracles=False)

        final, boundary, _cost = dbt.run(state)
        cut = select_physical_cut(dbt, 0x100)
        record = pack_native_x86_block(cut)
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, descriptor, source_instructions) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        page = unpack_step(native_step(record))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(final.register('rax'), MASK64)
        self.assertEqual((control, following), (24, 0x105))
        self.assertEqual(descriptor, 17 | (64 << 8))
        self.assertEqual(source_instructions, 2)
        self.assertEqual((page.instructions, page.local_extent), (0, 18))

    def test_native_zero_scan_is_one_recurrence_record(self):
        code = bytes.fromhex('48 83 c0 01 80 38 00 75 f7 f4')
        memory = PagedMemory(b'', 4096).write(0x100, code)
        memory = memory.write(0x400, b'abc\0tail')
        state = initial_state(memory, 0x100, {'rax': 0x400})
        dbt = X86DBT(enable_function_oracles=False)

        final, boundary, _cost = dbt.run(state)
        cut = select_physical_cut(dbt, 0x100)
        record = pack_native_x86_block(cut)
        (_magic, _version, header_bytes, _rip, _boundary_rip, _page_bytes,
         control, following, descriptor, source_instructions) = \
            NATIVE_BLOCK_HEADER.unpack_from(record)
        page = unpack_step(native_step(record))

        self.assertEqual(boundary.operation, 'halt')
        self.assertEqual(final.register('rax'), 0x403)
        self.assertEqual((control, following), (24, 0x109))
        self.assertEqual(descriptor, 17 | (64 << 8))
        self.assertEqual(source_instructions, 3)
        self.assertEqual((page.instructions, page.local_extent), (0, 18))
        self.assertEqual(dbt.layout()['scan_source_instructions'], 6)

    def test_code_page_with_changed_source_is_not_restored(self):
        memory = PagedMemory(b'', 4096).write(0x100, b'\x90\xc3')
        state = initial_state(memory, 0x100)
        source = X86DBT()
        source.block(state)
        changed = initial_state(memory.write(0x100, b'\xcc'), 0x100)

        restored = load_x86_code_pages(
            dump_x86_code_pages(source), changed)

        self.assertEqual(restored.blocks, {})
        self.assertEqual(restored.layout()['rejected_code_blocks'], 1)


if __name__ == '__main__':
    unittest.main()
