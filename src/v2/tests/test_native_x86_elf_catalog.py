"""Content-addressed ELF catalogs never confuse equal virtual addresses."""

import hashlib
from pathlib import Path
import struct
import tempfile
import unittest

from kernel.x86 import initial_state
from qm.wasmstate import PagedMemory
from tools.close_native_x86_runtime import (load_seed_catalog,
                                            load_seed_coordinates,
                                            linear_seed_coordinates,
                                            match_seed_catalog,
                                            reachable_seed_coordinates)
from tools.build_native_x86_seed_addresses import (call_entries_from_lines,
                                                   control_entries_from_lines,
                                                   executable_segments)
from tools.index_native_x86_elf import (compact_catalog, ELF_HEADER,
                                        PROGRAM_HEADER,
                                        executable_pages)


class TestNativeX86ElfCatalog(unittest.TestCase):
    def test_control_entries_include_call_and_conditional_fallthroughs(self):
        entries = control_entries_from_lines((
            ' 100: call 200 <callee>\n',
            ' 105: jne 120 <branch>\n',
            ' 107: jmp 130 <tail>\n',
            ' 10c: ret\n',
        ))

        self.assertEqual(entries, (0x105, 0x107, 0x120, 0x130, 0x200))

    def test_call_entries_exclude_unrelated_branch_coordinates(self):
        entries = call_entries_from_lines((
            ' 100: call 200 <callee>\n',
            ' 105: jne 120 <branch>\n',
            ' 107: jmp 130 <tail>\n',
            ' 10c: ret\n',
        ))

        self.assertEqual(entries, (0x105, 0x200))

    def test_compact_catalog_keeps_instruction_offsets_lazy(self):
        encoded = compact_catalog(({
            'identity': (b'a' * 32).hex(),
            'pages': ({
                'virtual_page': '0x401000',
                'sha256': (b'b' * 32).hex(),
                'entries': (0, 3, 4095),
            },),
        },))
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'catalog.bin'
            path.write_bytes(encoded)
            objects = load_seed_catalog(path)

        identity, pages = objects[0]
        coordinate, digest, entries = pages[0]
        self.assertEqual(identity, b'a' * 32)
        self.assertEqual((coordinate, digest), (0x401000, b'b' * 32))
        self.assertEqual(tuple(entries), (0, 3, 4095))
        self.assertNotIsInstance(entries, tuple)

    def test_linear_seed_walk_keeps_only_real_instruction_entries(self):
        # nop; call +1; ret; ret.  The return continuation at 0x106 is a
        # required entry, while none of the four immediate bytes are.
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('90 e8 01 00 00 00 c3 c3'))
        state = initial_state(memory, 0x100)

        coordinates, stopped = linear_seed_coordinates(
            state, 0x100, 0x108)

        self.assertEqual(coordinates, (0x100, 0x106, 0x107))
        self.assertIsNone(stopped)

    def test_linear_seed_walk_includes_direct_branch_targets(self):
        # jne 0x104; nop; ret; ret.  The fallthrough block reaches 0x104 as
        # an interior coordinate, but the direct branch still makes it an
        # independent physical entry.
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('75 02 90 c3 c3'))
        state = initial_state(memory, 0x100)

        coordinates, stopped = linear_seed_coordinates(
            state, 0x100, 0x105)

        self.assertEqual(coordinates, (0x100, 0x102, 0x104))
        self.assertIsNone(stopped)

    def test_reachable_seed_walk_crosses_direct_call_spans(self):
        # call 0x200; ret.  The callee is outside the caller's symbol span,
        # but both immutable executable ranges belong to the matched ELF.
        memory = PagedMemory(b'', 4096).write(
            0x100, bytes.fromhex('e8 fb 00 00 00 c3')).write(0x200, b'\xc3')
        state = initial_state(memory, 0x100)

        coordinates, stopped, truncated = reachable_seed_coordinates(
            state, (0x100,), ((0x100, 0x106), (0x200, 0x201)), 16)

        self.assertEqual(coordinates, (0x100, 0x105, 0x200))
        self.assertEqual(stopped, ())
        self.assertFalse(truncated)

    def test_system_map_loads_only_executable_symbols(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'System.map'
            path.write_text(
                'ffffffff81000000 T _text\n'
                'ffffffff81000010 t local_entry\n'
                'ffffffff81001000 D kernel_data\n'
                'ffffffff81002000 W weak_entry\n',
                encoding='utf-8')

            coordinates = load_seed_coordinates(path)

        self.assertEqual(coordinates, (
            0xffffffff81000000,
            0xffffffff81000010,
            0xffffffff81002000,
        ))

    def test_executable_load_segment_becomes_one_canonical_page(self):
        payload = bytearray(0x2000)
        ELF_HEADER.pack_into(
            payload, 0, b'\x7fELF\x02\x01' + b'\0' * 10,
            2, 62, 1, 0x401000, ELF_HEADER.size, 0, 0,
            ELF_HEADER.size, PROGRAM_HEADER.size, 1, 0, 0, 0)
        PROGRAM_HEADER.pack_into(
            payload, ELF_HEADER.size,
            1, 5, 0x1000, 0x401000, 0x401000, 2, 2, 0x1000)
        payload[0x1000:0x1002] = b'\x90\xc3'

        pages = executable_pages(bytes(payload))

        self.assertEqual(tuple(pages), (0x401000,))
        self.assertEqual(pages[0x401000][:4], b'\x90\xc3\0\0')
        self.assertEqual(len(pages[0x401000]), 4096)

    def test_executable_load_segment_is_available_before_demand_paging(self):
        payload = bytearray(0x2000)
        ELF_HEADER.pack_into(
            payload, 0, b'\x7fELF\x02\x01' + b'\0' * 10,
            2, 62, 1, 0x401000, ELF_HEADER.size, 0, 0,
            ELF_HEADER.size, PROGRAM_HEADER.size, 1, 0, 0, 0)
        PROGRAM_HEADER.pack_into(
            payload, ELF_HEADER.size,
            1, 5, 0x1000, 0x401000, 0x401000, 2, 0x1000, 0x1000)
        payload[0x1000:0x1002] = b'\x90\xc3'

        self.assertEqual(
            executable_segments(bytes(payload)),
            ((0x401000, b'\x90\xc3'),))

    def test_runtime_page_identity_rebases_only_the_matching_object(self):
        image = b'\x90\xc3' + b'\0' * 4094
        other = b'\xcc' + b'\0' * 4095
        memory = PagedMemory(b'', 0x8000).write(0x4000, image)
        state = initial_state(memory, 0x4023)
        catalog = (
            (b'a' * 32, ((0x1000, hashlib.sha256(image).digest(),
                          (0x23, 0x40)),)),
            (b'b' * 32, ((0x1000, hashlib.sha256(other).digest(),
                          (0x23,)),)),
        )

        coordinates, report = match_seed_catalog(
            state, state.rip, catalog)

        self.assertEqual(coordinates, (0x4023, 0x4040))
        self.assertEqual((report['objects'], report['pages'],
                          report['coordinates']), (1, 1, 2))
        self.assertEqual(report['identity_sample'], [(b'a' * 32).hex()])


if __name__ == '__main__':
    unittest.main()
