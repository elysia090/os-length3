"""Compact physical forms used by the four-layer page delivery path."""

from pathlib import Path
import unittest

from qm.isa import run
from qm.pipeline import solve
from qm.scalarpage import execute, pack, unpack


ROOT = Path(__file__).resolve().parents[3]


def source(name):
    return (ROOT / 'corpus' / 'storage' / (name + '.c')).read_text(
        encoding='utf-8')


def target(result, name):
    return next(item for item in result['targets'] if item['name'] == name)


class TestStoragePrimitives(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rle = solve(source('rle_run_starts8'),
                        function='rle_run_starts8')
        cls.gf = solve(source('erasure_gf256_mul'),
                       function='erasure_gf256_mul')
        cls.arx = solve(source('arx_round64'), function='arx_round64')
        cls.slots = solve(source('canonical_region_slots8'),
                          function='canonical_region_slots8')
        cls.offsets = solve(
            source('canonical_region_block_offsets4'),
            function='canonical_region_block_offsets4',
            targets=['x86-64-bmi2-pclmul'])
        cls.row_class = solve(
            source('ciphertext_row_class64'),
            function='ciphertext_row_class64',
            targets=['x86-64-bmi2-pclmul'])
        cls.root_ready = solve(
            source('root_publish_ready5'),
            function='root_publish_ready5',
            targets=['x86-64-bmi2-pclmul'])
        cls.changed = solve(source('canonical_region_changed1'),
                            function='canonical_region_changed1')
        cls.value = solve(
            source('canonical_region_value1'),
            function='canonical_region_value1',
            targets=['x86-64-bmi2-pclmul'],
            options={'exhaustive_limit': 17, 'future_quotient_limit': 8})
        cls.dirty = solve(
            source('canonical_region_dirty1'),
            function='canonical_region_dirty1',
            targets=['x86-64-bmi2-pclmul'],
            options={'exhaustive_limit': 18, 'future_quotient_limit': 8})

    def test_run_compression_is_linear_predicate_affine(self):
        self.assertEqual(self.rle['program']['solver'],
                         'linear-lane-affine')
        pclmul = target(self.rle, 'x86-64-bmi2-pclmul')
        wasm = target(self.rle, 'wasm32')
        self.assertEqual((pclmul['span'], pclmul['work']), (7, 7))
        self.assertEqual((wasm['span'], wasm['work']), (9, 9))
        self.assertNotIn('LUT', pclmul['instructions'])

    def test_erasure_product_is_arithmetic_not_a_half_megabyte_table(self):
        self.assertEqual(self.gf['program']['solver'], 'gf256-product')
        pclmul = target(self.gf, 'x86-64-bmi2-pclmul')
        self.assertEqual((pclmul['span'], pclmul['work']), (7, 11))
        self.assertEqual(pclmul['instructions'].count('CLMULR'), 1)
        self.assertEqual(pclmul['instructions'].count('CLMUL'), 2)
        self.assertTrue(pclmul['verification']['exhaustive'])
        self.assertNotIn('LUT', pclmul['instructions'])

    def test_arx_round_retains_native_rotate_lanes(self):
        self.assertEqual(self.arx['program']['solver'], 'arx32')
        physical = target(self.arx, 'wasm32')
        self.assertEqual((physical['span'], physical['work']), (7, 10))
        self.assertIn('ROR32', physical['instructions'])
        self.assertIn('ROL32', physical['instructions'])

    def test_canonical_region_slots_are_a_shared_four_op_ssa_dag(self):
        self.assertEqual(self.slots['program']['solver'],
                         'support-masked-conv')
        physical = target(self.slots, 'x86-64-bmi2-pclmul')
        self.assertEqual((physical['span'], physical['work']), (3, 4))
        self.assertEqual(physical['instructions'],
                         ['PDEP', 'IMUL', 'IMUL', 'ANDR'])
        self.assertTrue(physical['verification']['exhaustive'])

    def test_block_prefix_substitutes_padding_before_closed_form_search(self):
        self.assertEqual(self.offsets['program']['solver'],
                         'deposit+conv[IMUL]')
        physical = target(self.offsets, 'x86-64-bmi2-pclmul')
        self.assertEqual((physical['span'], physical['work']), (2, 2))
        self.assertEqual(physical['instructions'], ['PDEP', 'IMUL'])
        self.assertTrue(physical['verification']['exhaustive'])
        self.assertEqual(physical['verification']['matched'], 1 << 16)

    def test_ciphertext_row_class_is_the_two_op_ceiling(self):
        physical = target(self.row_class, 'x86-64-bmi2-pclmul')
        self.assertEqual((physical['span'], physical['work']), (2, 2))
        self.assertEqual(physical['instructions'], ['ADD', 'SHR'])
        self.assertTrue(physical['verification']['exhaustive'])
        self.assertEqual(physical['verification']['matched'], 1 << 16)

    def test_root_publish_conditions_stay_one_packed_field(self):
        self.assertEqual(self.root_ready['program']['solver'],
                         'field-all-one')
        physical = target(self.root_ready, 'x86-64-bmi2-pclmul')
        self.assertEqual((physical['span'], physical['work']), (3, 3))
        self.assertEqual(physical['instructions'], ['AND', 'ADD', 'SHR'])
        self.assertTrue(physical['verification']['exhaustive'])
        self.assertEqual(physical['verification']['matched'], 1 << 8)

    def test_canonical_region_pointwise_conditions_are_exhaustive(self):
        changed = target(self.changed, 'x86-64-bmi2-pclmul')
        value = target(self.value, 'x86-64-bmi2-pclmul')
        dirty = target(self.dirty, 'x86-64-bmi2-pclmul')
        self.assertEqual(self.changed['program']['solver'], 'field-neq')
        self.assertEqual(self.value['program']['solver'], 'bit-select-ssa')
        self.assertEqual(self.dirty['program']['solver'], 'bit-select-ssa')
        self.assertEqual((value['span'], value['work']), (4, 7))
        self.assertEqual((dirty['span'], dirty['work']), (7, 10))
        self.assertEqual(value['verification']['matched'], 1 << 17)
        self.assertEqual(dirty['verification']['matched'], 1 << 18)
        self.assertTrue(changed['verification']['exhaustive'])
        self.assertTrue(value['verification']['exhaustive'])
        self.assertTrue(dirty['verification']['exhaustive'])

    def test_new_lanes_round_trip_through_the_physical_page(self):
        for result, name, values in (
                (self.gf, 'x86-64-bmi2-pclmul',
                 (0, 1, 0x0101, 0x1234, 0xFFFF)),
                (self.arx, 'wasm32',
                 (0, 1, 0x0123456789ABCDEF, (1 << 64) - 1))):
            record = target(result, name)
            mapped = unpack(pack(record['seq']))
            for value in values:
                self.assertEqual(execute(mapped, value),
                                 run(record['seq'], value))


if __name__ == '__main__':
    unittest.main()
