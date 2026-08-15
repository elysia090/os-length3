"""Content-addressed ELF catalogs never confuse equal virtual addresses."""

import hashlib
from pathlib import Path
import struct
import tempfile
import unittest

from kernel.x86 import initial_state
from qm.wasmstate import PagedMemory
from tools.close_native_x86_runtime import (load_seed_coordinates,
                                            match_seed_catalog)
from tools.index_native_x86_elf import (ELF_HEADER, PROGRAM_HEADER,
                                        executable_pages)


class TestNativeX86ElfCatalog(unittest.TestCase):
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
