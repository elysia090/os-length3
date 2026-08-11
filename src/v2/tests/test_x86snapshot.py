"""x86 checkpoints retain only canonical direct-page state."""

import json
import struct
import unittest

from kernel.machine import MachineEvent
from kernel.x86 import (IA32_TIME_STAMP_COUNTER, X86DBT, X86Machine,
                        load_bzimage_kernel, initial_state)
from kernel.x86snapshot import (dump_x86_boot_cache, dump_x86_code_pages,
                                dump_x86_machine_state, dump_x86_state,
                                load_x86_boot_cache, load_x86_code_pages,
                                load_x86_machine_state, load_x86_state,
                                MAGIC)
from qm.memorycut import MemoryCut
from qm.wasmwave import WaveCost
from qm.wasmstate import PagedMemory


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
