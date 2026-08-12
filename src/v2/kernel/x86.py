"""x86-64 state steps in front of the Linux machine-event boundary.

The decoder stops at control, interrupt, clock and port-I/O observations.
Straight-line register work before that boundary is renamed into the same
physical SSA page used by the Wasm state-step engine. RAM is the shared
immutable paged value, and four-level translation names physical bytes before
the byte cut is committed.
"""

from dataclasses import dataclass, field, replace as _dataclass_replace
import gzip
import hashlib
from math import gcd
import struct

from qm.memorycut import MemoryCut
from qm.laneops import select as select_lane
from qm.steppage import (compile_mapped_executor,
                         decode_projection_coordinate, memory_shape,
                         projection_coordinate,
                         pack as pack_step, unpack as unpack_step)
from qm.stepnormalize import compose_plans, normalize_plan, physical_work
from qm.transducer import compile_byte_classes
from qm.wasmphysical import DependencyWaves
from qm.wasmstate import MEMORY_PAGE as PHYSICAL_PAGE_BYTES, PagedMemory
from qm.wasmwave import Operand, PureSlice, WaveCost, WaveNode

from .machine import MachineEvent


MASK32 = (1 << 32) - 1
MASK64 = (1 << 64) - 1
PAGE_BYTES = 4096
CR0_PAGING = 1 << 31
CR0_PROTECTED_MODE = 1
CR4_PAE = 1 << 5
EFER_LME = 1 << 8
EFER_LMA = 1 << 10
EFER_NXE = 1 << 11
IA32_FS_BASE = 0xc0000100
IA32_GS_BASE = 0xc0000101
IA32_KERNEL_GS_BASE = 0xc0000102
IA32_TIME_STAMP_COUNTER = 0x10
CPUID_PSE = 1 << 3
CPUID_RDRAND = 1 << 30
CPUID_RDSEED = 1 << 18
PRESENT = 1
WRITABLE = 1 << 1
USER = 1 << 2
LARGE = 1 << 7


def advance_virtual_clock(value, step, variation_bits=0):
    """Advance a replayable virtual TSC with optional bounded variation."""
    value = int(value) & MASK64
    step = max(1, int(step))
    bits = int(variation_bits)
    if bits < 0 or bits > 32:
        raise ValueError('virtual clock variation must be in 0..32 bits')
    variation = 0
    if bits:
        mixed = value ^ (value >> 17) ^ (value >> 43)
        variation = mixed & ((1 << bits) - 1)
    return (value + step + variation) & MASK64
NO_EXECUTE = 1 << 63
ADDRESS_MASK = ((1 << 52) - 1) & ~(PAGE_BYTES - 1)

BOOT_PARAMS_ADDRESS = 0x90000
COMMAND_LINE_ADDRESS = 0x20000
PAGE_TABLE_ADDRESS = 0x1000
GDT_ADDRESS = 0x8000
E820_TABLE_OFFSET = 0x2d0
E820_ENTRY_BYTES = 20
E820_RAM = 1
E820_RESERVED = 2

RFLAGS_CARRY = 1 << 0
RFLAGS_PARITY = 1 << 2
RFLAGS_AUXILIARY = 1 << 4
RFLAGS_ZERO = 1 << 6
RFLAGS_SIGN = 1 << 7
RFLAGS_INTERRUPT = 1 << 9
RFLAGS_DIRECTION = 1 << 10
RFLAGS_OVERFLOW = 1 << 11
RFLAGS_ARITHMETIC = (RFLAGS_CARRY | RFLAGS_PARITY | RFLAGS_ZERO
                     | RFLAGS_SIGN | RFLAGS_OVERFLOW)
_PIT_COUNTER = 0x10042
_PIT_READ_PHASE = 0x10043
_PIT_WRITE_PHASE = 0x10044
_PIT_LOW_LATCH = 0x10045
_CMOS_INDEX = 0x10070
_CMOS_REGISTER_BASE = 0x10100

# A fixed, valid BCD clock keeps reset and replay deterministic. Guest writes
# are stored separately in the machine state and override these reset values.
_CMOS_RESET = {
    0x00: 0x00,  # seconds
    0x02: 0x00,  # minutes
    0x04: 0x00,  # hours
    0x06: 0x04,  # Thursday
    0x07: 0x01,  # day of month
    0x08: 0x01,  # month
    0x09: 0x26,  # year (2026)
    0x0a: 0x26,  # 32 kHz oscillator, 1024 Hz rate, update not in progress
    0x0b: 0x02,  # 24-hour BCD mode
    0x0c: 0x00,
    0x0d: 0x80,  # CMOS RAM and time are valid
}

_FXSAVE_RESET = bytearray(512)
struct.pack_into('<H', _FXSAVE_RESET, 0, 0x037f)
struct.pack_into('<I', _FXSAVE_RESET, 24, 0x1f80)
struct.pack_into('<I', _FXSAVE_RESET, 28, 0x0000ffff)
_FXSAVE_RESET = bytes(_FXSAVE_RESET)

_SORT_WRAPPER_CORE = bytes.fromhex(
    '48 89 4d e8 4c 89 45 f0 4c 8d 4d e8 '
    '41 b8 03 00 00 00 31 c9 6a 00 e8')
_SORT_WRAPPER_DIRECT_CORE = bytes.fromhex(
    '4c 8d 4d e8 48 89 4d e8 31 c9 4c 89 45 f0 '
    '41 b8 03 00 00 00 e8')
_STATIC_CALL_COMPARE_CORE = bytes.fromhex(
    '48 63 47 04 48 01 f8 48 83 c0 04 48 83 e0 fc '
    '48 63 4e 04 48 01 f1 48 83 c1 04 48 83 e1 fc')
_STATIC_CALL_COMPARE_DIRECT_CORE = bytes.fromhex(
    '48 63 47 04 b9 ff ff ff ff 48 63 56 04 '
    '48 8d 44 38 04 48 8d 54 32 04 48 83 e0 fc '
    '48 89 e5 48 83 e2 fc 48 39 d0')
_STATIC_CALL_SWAP_CORE = bytes.fromhex(
    '89 f8 29 f0 8b 0e 29 c1 8b 17 01 c2 89 0f '
    '8b 4e 04 29 c1 03 47 04')
_STATIC_CALL_SWAP_DIRECT_CORE = bytes.fromhex(
    '44 8b 06 48 89 f8 8b 0f 55 48 29 f0 8b 57 04 '
    '41 29 c0 01 c1 44 89 07 44 8b 46 04 48 89 e5 5d '
    '41 29 c0 01 d0 44 89 47 04 89 0e 89 46 04')
_JUMP_LABEL_COMPARE_CORE = bytes.fromhex(
    '48 8b 47 08 48 83 e0 fc 48 8d 0c 38 48 83 c1 08 '
    '48 8b 46 08 48 83 e0 fc 48 8d 14 30 48 83 c2 08')
_JUMP_LABEL_SWAP_CORE = bytes.fromhex(
    '48 89 f8 48 29 f0 8b 0e 29 c1 8b 17 01 c2 89 0f '
    '8b 4e 04 29 c1 44 8b 47 04')
_JUMP_LABEL_SWAP_DIRECT_CORE = bytes.fromhex(
    '44 8b 06 48 89 f8 8b 0f 55 48 29 f0 8b 57 04 4c 8b 4f 08 '
    '41 29 c0 01 c1 44 89 07 44 8b 46 04 01 c2 48 89 e5 5d '
    '41 29 c0 44 89 47 04 4c 8b 46 08 49 29 c0 4c 01 c8 '
    '4c 89 47 08 89 0e 89 56 04 48 89 46 08')
_RETURN_SCAN_PREFIX = bytes.fromhex(
    'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
    '41 57 41 56 41 55 41 54 53')
_RETURN_SCAN_LOOP = bytes.fromhex('49 83 c6 04 49 39 de')
_RETURN_ENTRY_CORE = bytes.fromhex('4d 63 2e 4d 01 f5')
_RETURN_FEATURE_JUMP = bytes.fromhex('48 89 84 24 a0 00 00 00 e9')
_RETURN_TARGET_COMPARE = bytes.fromhex('49 81 fc')
_ENTRY_NOP_PREFIX = bytes.fromhex(
    'f3 0f 1e fa 90 90 90 90 90 90 90 90 90 90 e9')
_STATIC_CALL_WRAPPER_ARGUMENTS = bytes.fromhex(
    '55 48 89 e5 41 56 49 89 f6 41 55 49 89 fd')
_STATIC_CALL_WRAPPER_SITE = bytes.fromhex(
    '4d 85 ed 74 2a 45 0f b6 e4 31 d2 4c 89 ef 44 89 e6')
_STATIC_CALL_WRAPPER_TYPE = bytes.fromhex(
    '31 c0 48 85 db 48 89 da 0f 94 c0 4c 89 ef 31 c9 '
    '42 8d 34 60')
_STATIC_CALL_NOP5 = bytes.fromhex('0f 1f 44 00 00')
_STATIC_CALL_ZERO5 = bytes.fromhex('2e 2e 2e 31 c0')
_STATIC_CALL_WARN5 = bytes.fromhex('0f 0b 0f 1f 00')
_STATIC_CALL_TABLE_PREFIX = bytes.fromhex(
    '55 48 89 e5 41 57 41 56 41 55 41 54 53 48 83 ec 08 '
    '48 89 55 d0 48 39 d6 0f 84 9b 01 00 00 4c 8b 75 d0 '
    '49 89 f7 48 89 fb ba 08 00 00 00')
_STATIC_CALL_TABLE_ENTRY = bytes.fromhex(
    '4d 39 f7 0f 83 63 01 00 00 4d 8d 77 04 45 31 ed '
    '4d 63 0f 49 63 0e 4f 8d 24 0f 48 85 db '
    '0f 84 ea 00 00 00')
_STATIC_CALL_TABLE_RANGE = bytes.fromhex(
    '49 81 fc 00 00 00 00 72 77 49 8d 44 24 01 4c 01 f1 '
    '48 3d 00 00 00 00 76 5b 48 89 c8 48 83 e0 fc 4c 39 e8 '
    '74 14 4c 89 fa 49 89 c5 48 83 ca 01 48 89 50 08 '
    '49 63 0e 4c 01 f1')
_STATIC_CALL_TABLE_PATCH = bytes.fromhex(
    '49 8b 55 00 83 e1 01 31 f6 4c 89 e7 '
    '49 83 c7 08 49 83 c6 08 e8')
_STATIC_CALL_TABLE_FINISH = bytes.fromhex(
    '48 8b 45 d0 49 39 c7 0f 82 a4 fe ff ff 31 c0 '
    '48 83 c4 08 5b 41 5c 41 5d 41 5e 41 5f 5d')
_STATIC_CALL_TABLE_MARK_INSIDE = bytes.fromhex(
    '83 c9 02 44 29 f1 41 89 0e 48 63 c9 4c 01 f1 '
    '48 89 c8 48 83 e0 fc 4c 39 e8 75 96 eb a8')
_STATIC_CALL_TABLE_MARK_AFTER = bytes.fromhex(
    '4c 01 f1 83 c9 02 44 29 f1 41 89 0e 48 63 c9 '
    'e9 a9 fe ff ff')
_VOID_COPY_ARGUMENTS = bytes.fromhex(
    '55 48 89 e5 41 55 49 89 fd bf 04 00 00 00 '
    '41 54 49 89 f4 53 48 89 d3 e8')
_VOID_COPY_BYTE_LOOP = bytes.fromhex(
    '31 d2 31 c0 48 85 db 74 16 49 8d 0c 04 8a 09 83 c2 01 '
    '41 88 4c 05 00 48 63 c2 48 39 d8 72 ea')
_VOID_COPY_REP = bytes.fromhex(
    '48 89 d9 4c 89 ef 4c 89 e6 48 c1 e9 02 f3 a5')
_RANGE_TABLE_QUERY_PREFIX = bytes.fromhex(
    '55 44 8b 17 48 89 e5 45 85 d2 74 44 31 c9 '
    '48 63 c1 85 d2 75 25 48 8d 04 80 4c 8d 04 87 '
    '49 8b 40 04 48 39 f0 73 32 49 03 40 0c 49 39 c1 73 29 '
    'b8 01 00 00 00 5d')
_RANGE_TABLE_QUERY_TYPED = bytes.fromhex(
    '48 63 c1 4c 8d 04 80 42 3b 54 87 14 74 cd '
    '83 c1 01 44 39 d1 75 ea 31 c0 5d')
_RANGE_TABLE_QUERY_SUFFIX = bytes.fromhex(
    '83 c1 01 44 39 d1 75 ae 31 c0 eb ee')
_RANGE_COMPACT_ENTRY = bytes.fromhex(
    '55 8d 56 ff 49 89 f9 89 f0 48 83 c7 08 31 f6 '
    '48 89 e5 53 85 d2 7f 0d eb 6d')
_RANGE_COMPACT_CORE = bytes.fromhex(
    '83 c6 01 48 83 c7 10 39 f2 7e 62 48 83 3f 00 75 ef '
    '39 d6 7d 1e 48 63 ca 48 c1 e1 04 4c 01 c9 eb 0b '
    '83 ea 01 48 83 e9 10 39 f2 74 41 48 83 79 08 00 74 ee '
    '39 d6 74 36 48 63 ca 83 c6 01 83 ea 01 48 83 c7 10 '
    '48 c1 e1 04 4c 01 c9 4c 8b 01 4c 89 47 e8 '
    '4c 8b 41 08 4c 89 47 f0 48 c7 01 00 00 00 00 '
    '48 c7 41 08 00 00 00 00 39 f2 7f 9e')
_RANGE_COMPACT_COUNT = bytes.fromhex(
    '48 63 c8 31 f6 85 c0 7f 0b eb 1c 48 83 c6 01 48 39 f1 '
    '74 13 48 89 f2 48 c1 e2 04 49 83 7c 11 08 00 75 e8 '
    '89 f3 eb 05 48 89 ce 89 c3 45 31 c0')
_RANGE_COMPACT_DIRECT = bytes.fromhex(
    'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 53 8d 4e ff '
    '89 f0 85 c9 0f 8e 98 00 00 00 48 8d 57 08 45 31 c0 '
    'eb 0f 49 ff c0 4c 63 c9 4d 39 c8 0f 8d 80 00 00 00 '
    '4d 89 c1 49 c1 e1 04 4a 83 7c 0f 08 00 75 e2 4c 63 d9 '
    '4d 39 d8 7d 24 49 c1 e3 04 49 01 d3 41 89 ca 49 83 3b 00 '
    '75 19 41 ff ca 49 63 da 49 83 c3 f0 49 39 d8 7c eb '
    '45 89 c2 eb 08 41 89 ca eb 03 44 89 d1 45 89 d2 4d 39 d0 '
    '74 35 49 01 f9 48 63 c9 49 89 ca 49 c1 e2 04 '
    '4e 8b 1c 17 4d 89 19 4e 8b 5c 17 08 4d 89 59 08 ff c9 '
    '4a c7 44 17 08 00 00 00 00 4a c7 04 17 00 00 00 00 '
    'e9 71 ff ff ff 85 f6 7e 1c 48 8d 57 08 31 c9 48 83 3a 00 '
    '74 0e 48 ff c1 48 83 c2 10 48 39 c8 75 ee eb 02 89 c8 '
    '48 63 d8 ba 10 00 00 00 48 89 de')
_RANGE_COMPARE_DIRECT = bytes.fromhex(
    'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 48 8b 07 '
    '48 3b 06 0f 97 c0 1c 00 0f be c0 5d')
_RANGE_COMPARE_BODY = bytes.fromhex(
    '48 8b 17 48 8b 0e 55 b8 ff ff ff ff 48 89 e5 '
    '48 39 ca 72 08 31 c0 48 39 d1 0f 92 c0 5d')
_BOUNDED_STRING_COMPARE_BODY = bytes.fromhex(
    '48 85 d2 74 24 31 c0 eb 0d 84 c9 74 1c '
    '48 83 c0 01 48 39 d0 74 13 0f b6 0c 07 '
    '3a 0c 06 74 ea 19 c0 83 c8 01')
_BOUNDED_STRING_COMPARE_DIRECT = bytes.fromhex(
    '55 48 89 e5 48 85 d2 74 27 48 ff ca 31 c9 '
    '44 0f b6 04 0f 44 3a 04 0e 75 20 31 c0 '
    '45 84 c0 74 09 48 39 ca 48 8d 49 01 75 e5')
_BIT_SCAN_FIRST_BODY = bytes.fromhex(
    '48 89 f0 48 85 f6 74 2d 31 d2 eb 0d '
    '48 83 c2 40 48 83 c7 08 48 39 c2 73 1c '
    '48 8b 0f 48 85 c9 74 eb f3 48 0f bc c9 '
    '48 01 ca 48 39 d0 48 0f 47 c2')
_BIT_SCAN_NEXT_BODY = bytes.fromhex(
    '48 89 d1 48 39 f2 73 32 48 89 d0 '
    '48 c7 c2 ff ff ff ff 48 c1 e8 06 48 d3 e2 '
    '48 23 14 c7 74 0b eb 21 48 8b 14 c7 48 85 d2 75 18 '
    '48 83 c0 01 48 89 c2 48 c1 e2 06 48 39 f2 72 e7 '
    '48 89 f0')
_BIT_SCAN_NEXT_RESULT = bytes.fromhex(
    '48 c1 e0 06 f3 48 0f bc d2 48 01 d0 '
    '48 39 c6 48 0f 47 f0 48 89 f0')
_BIT_SCAN_FIRST_DIRECT_HEAD = bytes.fromhex(
    'f3 0f 1e fa 48 85 f6 74 13 55 48 89 e5 48 89 f0 '
    '48 8b 17 48 85 d2 74 0c 31 c9 eb 23 31 c0')
_BIT_SCAN_FIRST_DIRECT_BODY = bytes.fromhex(
    '48 83 c7 08 31 c9 48 83 c1 40 48 39 c1 73 1b '
    '48 8b 17 48 83 c7 08 48 85 d2 74 eb '
    'f3 48 0f bc d2 48 01 ca 48 39 c2 48 0f 42 c2 5d')
_BIT_SCAN_NEXT_DIRECT = bytes.fromhex(
    'f3 0f 1e fa 48 89 f0 48 39 f2 73 54 55 48 89 e5 '
    '48 89 d1 48 c1 ea 06 48 8b 34 d7 48 d3 ee 48 d3 e6 '
    '48 85 f6 74 09 48 83 e1 c0 48 89 ca eb 21 '
    '48 8d 0c d7 48 83 c1 08 48 c1 e2 06 48 83 c2 40 '
    '48 39 c2 73 1b 48 8b 31 48 83 c1 08 48 85 f6 74 eb '
    'f3 48 0f bc ce 48 01 d1 48 39 c1 48 0f 42 c1 5d')
_STRIDED_VALIDATOR_PREFIX = bytes.fromhex(
    '55 ba 08 00 00 00 48 c7 c6')
_STRIDED_VALIDATOR_ARGUMENT = bytes.fromhex(
    '48 89 e5 53 48 89 fb')
_STRIDED_VALIDATOR_MISMATCH = bytes.fromhex(
    '89 c2 b8 01 20 00 00 85 d2 75 19')
_STRIDED_VALIDATOR_RETURN = bytes.fromhex('48 8b 5d f8 c9')
_STRIDED_PREDICATE_LOOP = bytes.fromhex(
    '48 83 c3 10 49 39 de 74 6a 48 89 df e8')
_ALTERNATIVE_ENTRY = struct.Struct('<iiIBB')
_ALTERNATIVE_SCAN_PREFIX = bytes.fromhex(
    'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
    '41 57 41 56 41 55 41 54 53 48 83 e4 f0')
_ALTERNATIVE_ENTRY_CORE = bytes.fromhex(
    '49 8d 77 0e 48 39 de 73 32 48 89 f0 48 63 08 '
    '48 01 c1 49 63 17 4c 01 fa 48 39 d1')
_ALTERNATIVE_CAPABILITY_PROBE = bytes.fromhex('48 0f a3 05')
_ALTERNATIVE_DEBUG_TEST = bytes.fromhex('f6 05')
_ALTERNATIVE_BUG_ADDRESS = bytes.fromhex('48 c7 c2')
_ALTERNATIVE_NOP_ADDRESS = bytes.fromhex('48 3d')
_ALTERNATIVE_POSITION_INDEPENDENT = frozenset((
    b'', bytes.fromhex('0f ae e8'), bytes.fromhex('0f ae e8 0f 31'),
    bytes.fromhex('48 89 f8'), bytes.fromhex('fb'),
    bytes.fromhex('9c 58'), bytes.fromhex('fa'),
    bytes.fromhex('c6 07 00'), bytes.fromhex('0f 20 d8'),
    bytes.fromhex('0f 22 df'), bytes.fromhex('0f 20 d0'),
    bytes.fromhex('48 31 c0'), bytes.fromhex('c3'),
))
_SMP_LOCK_LOOP_CORE = bytes.fromhex(
    '49 83 c4 04 4d 39 fc 73 35 49 63 04 24 49 8d 34 04 '
    '48 39 de 73 ea 85 c0 74 e6 4c 39 f6 72 e1 80 3e f0 '
    '75 dc c6 45 cf 3e b9 01 00 00 00 48 c7 c7')
_LENGTH_PREFIX_SKIP_LOOP = bytes.fromhex(
    '89 f6 48 01 f1 48 ff c1 48 63 f2 8d 56 01 48 39 f0 '
    '76 18 0f b6 31 40 84 f6 79 e5 83 e6 7f 0f b6 79 01 '
    'c1 e7 07 01 fe ff c6 eb d5')
_TOKEN_EXPANSION_CORE = bytes.fromhex(
    '48 ff c1 ff c8 74 66 44 0f b6 01 '
    '47 0f b7 84 00 50 e1 a3 82 '
    '45 0f b6 88 b8 dd a3 82 45 84 c9 74 df 85 ff 74 0f '
    '48 83 fe 02 72 42 44 88 0a 48 ff c2 48 ff ce '
    '45 0f b6 88 b9 dd a3 82 bf 01 00 00 00 45 84 c9 74 ba '
    '4d 8d 80 ba dd a3 82 49 89 f2 49 83 fa 02 72 17 '
    '44 88 0a 48 ff c2 49 ff ca 45 0f b6 08 49 ff c0 '
    '45 84 c9 75 e5 eb 90')
_TOKEN_STREAM_ENTRY = bytes.fromhex(
    'be 00 02 00 00 31 ff 48 89 da eb 0a')
_TOKEN_STREAM_BRANCH = bytes.fromhex('48 89 da eb 0a')
_SYMBOL_POSITION_ENTRY = bytes.fromhex(
    '0f 1f 44 00 00 55 48 89 e5 41 57 41 56 53 '
    '8b 0d 00 00 00 00 48 83 f9 02 72 7a '
    '4c 8b 05 00 00 00 00 31 c0 49 89 c9 49 89 ca eb 0f')
_SYMBOL_POSITION_SEARCH = bytes.fromhex(
    '4c 89 c8 4d 89 d1 49 29 c1 49 83 f9 01 76 1e '
    '49 d1 e9 49 01 c1 4d 63 d9 46 8b 1c 9d 00 00 00 00 '
    '4d 01 c3 49 39 fb 76 d8 4d 89 ca eb d9')
_AFFINE_PAGE_RECORD_CORE = bytes.fromhex(
    '4c 89 e1 48 c1 e1 06 48 8d 3c 08 '
    '48 c7 44 08 30 00 00 00 00 48 c7 44 08 38 00 00 00 00 '
    '48 c7 44 08 28 00 00 00 00 48 c7 44 08 20 00 00 00 00 '
    '48 c7 44 08 18 00 00 00 00 48 89 34 08 '
    'c7 44 08 34 01 00 00 00 c7 44 08 30 ff ff ff ff '
    '48 8d 14 08 48 83 c2 08 48 89 54 08 08 48 89 54 08 10 '
    '41 83 fd 01 75 14')
_PAGE_RESERVATION_CORE = bytes.fromhex(
    '4d 39 f7 73 5a 4d 89 fd 49 c1 e5 06 4c 03 2d 00 00 00 00 '
    '4c 0f a3 25 00 00 00 00 73 1b '
    '4a 8b 04 e5 00 00 00 00 4c 3b b8 80 1a 02 00 72 0a '
    '4c 89 ff 89 de e8 00 00 00 00 '
    '49 0f ba 6d 00 0d 49 ff c7 4d 39 f7 73 19 '
    '4c 89 f8 48 c1 e0 37 75 b1')
_PAGE_RECORD_PREDICATE_CORE = bytes.fromhex(
    '8b 47 30 83 f8 ff 75 46 48 63 47 34 48 0b 47 18 '
    '48 0b 47 38 48 b9 7c 00 00 00 80 ff ff ff '
    '48 23 4f 08 48 ba 40 00 00 00 00 00 ad de '
    '31 f6 48 39 d1 40 0f 94 c6 48 8b 0f '
    '81 e1 23 e1 14 00 48 09 c1 48 09 f1 75 08 '
    '31 c0 2e e9 00 00 00 00')
_PAGE_RECORD_RELEASE_HEAD = bytes.fromhex(
    '80 7d bc 00 48 89 4d c0 74 05 4d 89 fd eb 3b')
_PAGE_RECORD_RELEASE_GOOD = bytes.fromhex(
    '4d 89 ef 48 8b 4d c0 41 81 64 0d 00 00 00 a0 ff '
    '48 83 c1 40 48 39 c8 75 9b e9 00 00 00 00')
_PAGE_RECORD_RELEASE_CHECK = bytes.fromhex(
    '89 7d d4 48 8b 45 c0 4a 8d 3c 28 48 89 5d a0 '
    '4c 89 e3 45 89 c4 41 89 d7 49 89 f6 e8 00 00 00 00 '
    '8b 7d d4 4c 89 f6 44 89 fa 45 89 e0 49 89 dc '
    '48 8b 5d a0 4c 8b 75 c8 84 c0 48 8b 45 a8 74 a3 '
    'ff c7 4d 89 ef 48 8b 4d c0 eb a8')
_RANDOM_U32_CACHE_ENTRY = bytes.fromhex(
    'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 41 57 41 56 53 '
    '48 83 ec 50 65 48 8b 05 00 00 00 00 48 89 45 e0 '
    'e9 9e 00 00 00')
_RANDOM_U32_CACHE_CORE = bytes.fromhex(
    'ff 15 00 00 00 00 48 89 c3 ff 15 00 00 00 00 '
    '65 48 8b 05 00 00 00 00 4c 8d b0 00 00 00 00 '
    '4c 8b 3d 00 00 00 00 8b 80 00 00 00 00 '
    '83 f8 17 77 06 4d 3b 7e 60 74 1b be 60 00 00 00 '
    '4c 89 f7 e8 00 00 00 00 41 c7 46 68 00 00 00 00 '
    '4d 89 7e 60 31 c0 89 c0 41 8b 0c 86 '
    '41 c7 04 86 00 00 00 00 41 ff 46 68 '
    '65 48 8b 05 00 00 00 00 f7 c3 00 02 00 00 74 06 '
    'ff 15 00 00 00 00 65 48 8b 05 00 00 00 00 '
    '48 3b 45 e0 75 12 89 c8 48 83 c4 50 5b 41 5e 41 5f 5d '
    '2e e9 00 00 00 00')
_RANDOM_U32_CACHE_READY = bytes.fromhex(
    '83 3d 00 00 00 00 01 0f 87 55 ff ff ff')
_RANDOM_U32_BELOW_CORE = bytes.fromhex(
    'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 41 56 53 89 fb '
    'e8 00 00 00 00 89 c1 85 db 74 11 41 89 de 89 c9 '
    '49 0f af ce 39 cb 77 10 48 c1 e9 20 89 c8 '
    '5b 41 5e 5d 2e e9 00 00 00 00 89 d8 f7 d8 31 d2 '
    'f7 f3 39 ca 76 e4 89 d3 e8 00 00 00 00 89 da 89 c1 '
    '49 0f af ce 39 cb 76 d1 eb eb')
_RANDOM_PERMUTATION_LOOP = bytes.fromhex(
    '89 df e8 00 00 00 00 43 8b 4c be 04 89 c0 '
    '41 8b 14 86 43 89 54 be 04 41 89 0c 86 '
    'ff cb 49 ff cc 45 85 ff 4d 89 e7 75 d8')
_CHACHA_PERMUTATION_SHA256 = bytes.fromhex(
    '57adb5468be1cc53f20a752dfa990b3f4ee752049bee9846c55a906e9c9053cc')
_RELATIVE_RECORD_PROJECTION_CORE = bytes.fromhex(
    '48 83 c1 01 48 81 f9 00 00 00 00 77 4b 48 83 ce 02 '
    '48 89 70 08 48 39 fa 74 0e 48 8b 4a 08 83 e1 03 '
    '48 09 c1 48 89 4a 08 48 83 c0 10 48 3d 00 00 00 00 '
    '73 2a 48 8b 70 08 48 89 d7 48 89 f2 48 83 e2 fc '
    '48 8d 54 10 08 8b 0a 48 63 08 48 01 c1 '
    '48 81 f9 00 00 00 00 73 a8 48 83 e6 fd eb b3')
_RELATIVE_RECORD_PROJECTION_FORWARD_CORE = bytes.fromhex(
    '48 8b 70 08 48 89 f2 48 83 e2 fc 48 01 da 48 83 c2 08 '
    '8b 3a 48 63 38 4c 8d 04 3b 49 81 f8 00 00 00 00 '
    '41 0f 93 c0 48 01 df 48 ff c7 48 81 ff 00 00 00 00 '
    '40 0f 96 c7 44 20 c7 48 83 e6 fd 40 0f b6 ff '
    '48 8d 34 7e 48 89 70 08 48 39 d1 74 11 '
    '48 8b 4a 08 83 e1 03 48 09 d9 48 89 4a 08 48 89 d1 '
    '48 83 c0 10 48 83 c3 10 48 3d 00 00 00 00 72 90')


def _signed_integer(value, bits):
    value = int(value) & ((1 << bits) - 1)
    sign = 1 << (bits - 1)
    return value - (1 << bits) if value & sign else value


def _relocated_alternative(payload, instruction, replacement,
                           replacement_bytes):
    """Relocate the bounded PC-relative forms emitted in alt records."""
    payload = bytearray(payload)
    instruction = int(instruction) & MASK64
    replacement = int(replacement) & MASK64
    replacement_bytes = int(replacement_bytes)

    def relocate(offset, following, width):
        raw = int.from_bytes(payload[offset:offset + width], 'little')
        relative = _signed_integer(raw, width * 8)
        target = (replacement + following + relative) & MASK64
        source_end = (replacement + replacement_bytes) & MASK64
        if replacement <= target <= source_end:
            return True
        adjusted = target - ((instruction + following) & MASK64)
        minimum = -(1 << (width * 8 - 1))
        maximum = (1 << (width * 8 - 1)) - 1
        if adjusted < minimum or adjusted > maximum:
            return False
        payload[offset:offset + width] = int(adjusted).to_bytes(
            width, 'little', signed=True)
        return True

    active = bytes(payload[:replacement_bytes])
    if replacement_bytes == 5 and active[:1] in (b'\xe8', b'\xe9'):
        return bytes(payload) if relocate(1, 5, 4) else None
    if (replacement_bytes == 7
            and active[:3] == b'\x0f\x00\x2d'):
        return bytes(payload) if relocate(3, 7, 4) else None
    if (replacement_bytes == 12
            and active[:3] == b'\x48\x8d\x3d'
            and active[7:8] == b'\xe8'):
        if not relocate(3, 7, 4) or not relocate(8, 12, 4):
            return None
        return bytes(payload)
    if (replacement_bytes == 43
            and active[:7] == b'\x49\xc7\xc4\x10\x00\x00\x00'
            and active[31:35] == b'\x65\x48\xc7\x05'):
        return bytes(payload) if relocate(35, 43, 4) else None
    if active in _ALTERNATIVE_POSITION_INDEPENDENT:
        return bytes(payload)
    return None


def _radix_record_order(records, key_count):
    """Stable Byte* order for unsigned fixed-width tuple keys."""
    order = list(range(len(records)))
    scratch = [0] * len(order)
    for key in range(int(key_count) - 1, -1, -1):
        for shift in range(0, 64, 8):
            counts = [0] * 256
            for record in order:
                counts[(records[record][key] >> shift) & 0xff] += 1
            total = 0
            for byte, count in enumerate(counts):
                counts[byte] = total
                total += count
            for record in order:
                byte = (records[record][key] >> shift) & 0xff
                scratch[counts[byte]] = record
                counts[byte] += 1
            order, scratch = scratch, order
    return order

REGISTER_NAMES = (
    'rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
    'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
)
REGISTER_INDEX = dict((name, index)
                      for index, name in enumerate(REGISTER_NAMES))


class X86Error(ValueError):
    """Malformed or unsupported x86 machine state."""


class PageFault(X86Error):
    """One virtual coordinate that cannot be translated."""

    def __init__(self, address, access='read', present=False):
        self.address = int(address) & MASK64
        self.access = access
        self.present = bool(present)
        super().__init__(
            'x86 page fault at 0x%016x during %s' %
            (self.address, self.access))


@dataclass(frozen=True)
class BzImageHeader:
    """Fields needed to enter a modern 64-bit Linux kernel."""

    setup_sectors: int
    protocol: int
    load_flags: int
    code32_start: int
    initrd_address_max: int
    kernel_alignment: int
    relocatable: bool
    xload_flags: int
    command_line_bytes: int
    preferred_address: int
    init_bytes: int

    @property
    def payload_offset(self):
        return (self.setup_sectors + 1) * 512


@dataclass(frozen=True)
class BzImageBoot:
    """Prepared Linux entry state and the image fields that produced it."""

    state: object
    header: BzImageHeader
    load_address: int
    boot_params_address: int
    command_line_address: int
    initrd_address: object = None
    initrd_bytes: int = 0


def _image_integer(image, offset, size):
    end = int(offset) + int(size)
    if offset < 0 or end > len(image):
        raise X86Error('Linux boot header is truncated')
    return int.from_bytes(image[offset:end], 'little')


def parse_bzimage(image):
    """Validate and read the standard Linux/x86 setup header."""
    image = bytes(image)
    if len(image) < 0x268:
        raise X86Error('Linux bzImage header is truncated')
    if _image_integer(image, 0x1fe, 2) != 0xaa55:
        raise X86Error('Linux bzImage boot flag is missing')
    if image[0x202:0x206] != b'HdrS':
        raise X86Error('Linux bzImage setup signature is missing')
    protocol = _image_integer(image, 0x206, 2)
    if protocol < 0x20c:
        raise X86Error('Linux kernel does not support 64-bit boot metadata')
    setup_sectors = image[0x1f1] or 4
    payload_offset = (setup_sectors + 1) * 512
    if payload_offset >= len(image):
        raise X86Error('Linux bzImage has no protected-mode payload')
    xload_flags = _image_integer(image, 0x236, 2)
    if not xload_flags & 1:
        raise X86Error('Linux bzImage does not contain a 64-bit kernel')
    header = BzImageHeader(
        setup_sectors=setup_sectors,
        protocol=protocol,
        load_flags=image[0x211],
        code32_start=_image_integer(image, 0x214, 4),
        initrd_address_max=_image_integer(image, 0x22c, 4),
        kernel_alignment=_image_integer(image, 0x230, 4),
        relocatable=bool(image[0x234]),
        xload_flags=xload_flags,
        command_line_bytes=_image_integer(image, 0x238, 4),
        preferred_address=_image_integer(image, 0x258, 8),
        init_bytes=_image_integer(image, 0x260, 4),
    )
    if header.init_bytes < len(image) - payload_offset:
        raise X86Error('Linux bzImage initialization extent is too small')
    return header


def _write_u64(memory, address, value):
    return memory.write(address, struct.pack('<Q', int(value) & MASK64))


def _identity_page_tables(memory, extent):
    """Build four-level identity mappings with 2 MiB leaves."""
    two_megabytes = 1 << 21
    one_gigabyte = 1 << 30
    directory_count = max(1, (int(extent) + one_gigabyte - 1)
                          // one_gigabyte)
    if directory_count > 512:
        raise X86Error('initial identity map exceeds one PML4 entry')
    pml4 = PAGE_TABLE_ADDRESS
    pdpt = pml4 + PAGE_BYTES
    first_directory = pdpt + PAGE_BYTES
    memory = _write_u64(memory, pml4, pdpt | PRESENT | WRITABLE)
    for directory in range(directory_count):
        table = first_directory + directory * PAGE_BYTES
        memory = _write_u64(
            memory, pdpt + directory * 8, table | PRESENT | WRITABLE)
        base = directory * one_gigabyte
        entries = min(512, max(0, (int(extent) - base
                                  + two_megabytes - 1)
                               // two_megabytes))
        for slot in range(entries):
            physical = base + slot * two_megabytes
            memory = _write_u64(
                memory, table + slot * 8,
                physical | PRESENT | WRITABLE | LARGE)
    return memory, pml4


def _boot_gdt(memory):
    # Selectors 0x10 and 0x18 are the code and data entries required by the
    # Linux boot protocol. The interpreter retains the selector values while
    # the guest remains responsible for later descriptor-table changes.
    descriptors = (
        0,
        0,
        0x00af9a000000ffff,
        0x00cf92000000ffff,
    )
    payload = b''.join(struct.pack('<Q', value) for value in descriptors)
    return memory.write(GDT_ADDRESS, payload), (GDT_ADDRESS, len(payload) - 1)


def load_bzimage(image, memory_bytes=None, command_line=None,
                 load_address=None, initrd=None):
    """Prepare the direct 64-bit Linux boot-protocol entry state.

    Firmware setup is intentionally absent. The kernel starts in long mode at
    ``load_address + 0x200`` with identity mappings and ``RSI`` pointing at a
    zero page populated from the image setup header.
    """
    from qm.wasmstate import PagedMemory

    image = bytes(image)
    initrd = b'' if initrd is None else bytes(initrd)
    header = parse_bzimage(image)
    payload = image[header.payload_offset:]
    if load_address is None:
        load_address = (header.preferred_address
                        if header.relocatable and header.preferred_address
                        else header.code32_start)
    load_address = int(load_address)
    alignment = header.kernel_alignment if header.relocatable else 0
    if alignment and load_address % alignment:
        raise X86Error('Linux kernel load address is not aligned')
    if load_address < 1 << 20:
        raise X86Error('Linux kernel load address overlaps low boot memory')

    command_line = ('console=ttyS0 earlycon=uart,io,0x3f8,115200n8 '
                    'nokaslr' if command_line is None else str(command_line))
    command = command_line.encode('utf-8') + b'\0'
    if header.command_line_bytes and len(command) > header.command_line_bytes:
        raise X86Error('Linux kernel command line is too long')
    if COMMAND_LINE_ADDRESS + len(command) >= BOOT_PARAMS_ADDRESS:
        raise X86Error('Linux kernel command line overlaps boot parameters')

    kernel_extent = max(
        load_address + header.init_bytes,
        load_address + len(payload),
        BOOT_PARAMS_ADDRESS + 4096,
    )
    if memory_bytes is None:
        memory_bytes = max(128 << 20,
                           kernel_extent + len(initrd) + (2 << 20))
    memory_bytes = int(memory_bytes)
    if memory_bytes < kernel_extent:
        raise X86Error('physical memory is smaller than the Linux boot extent')

    initrd_address = None
    if initrd:
        ceiling = min(memory_bytes, header.initrd_address_max + 1)
        initrd_address = (ceiling - len(initrd)) & ~(PAGE_BYTES - 1)
        if initrd_address < kernel_extent:
            raise X86Error('initial RAM filesystem overlaps the Linux kernel')
    required = max(kernel_extent,
                   0 if initrd_address is None
                   else initrd_address + len(initrd))

    memory = PagedMemory(b'', memory_bytes)
    memory = memory.write(load_address, payload)

    # struct boot_params begins zeroed. Only the setup header is copied from
    # the image; firmware data is supplied explicitly below.
    header_end = 0x202 + image[0x201]
    if header_end < 0x268 or header_end > header.payload_offset:
        raise X86Error('Linux setup header length is invalid')
    setup = bytearray(4096)
    setup[0x1f1:header_end] = image[0x1f1:header_end]
    setup[0x210] = 0xff
    struct.pack_into('<I', setup, 0x214, load_address & MASK32)
    struct.pack_into('<I', setup, 0x228, COMMAND_LINE_ADDRESS)
    if initrd_address is not None:
        struct.pack_into('<I', setup, 0x218,
                         initrd_address & MASK32)
        struct.pack_into('<I', setup, 0x21c, len(initrd) & MASK32)
        struct.pack_into('<I', setup, 0x0c0,
                         initrd_address >> 32)
        struct.pack_into('<I', setup, 0x0c4,
                         len(initrd) >> 32)
    setup[0x1e8] = 3
    e820 = (
        (0, 0x9f000, E820_RAM),
        (0x9f000, 0x61000, E820_RESERVED),
        (0x100000, memory_bytes - 0x100000, E820_RAM),
    )
    for index, entry in enumerate(e820):
        struct.pack_into('<QQI', setup,
                         E820_TABLE_OFFSET + index * E820_ENTRY_BYTES,
                         *entry)
    memory = memory.write(BOOT_PARAMS_ADDRESS, setup)
    memory = memory.write(COMMAND_LINE_ADDRESS, command)
    if initrd_address is not None:
        memory = memory.write(initrd_address, initrd)
    memory, cr3 = _identity_page_tables(memory, required)
    memory, gdtr = _boot_gdt(memory)

    state = initial_state(
        memory,
        rip=load_address + 0x200,
        registers={'rsi': BOOT_PARAMS_ADDRESS},
        cr0=CR0_PROTECTED_MODE | CR0_PAGING,
        cr3=cr3,
        cr4=CR4_PAE,
        efer=EFER_LME | EFER_LMA | EFER_NXE,
        gdtr=gdtr,
        cs=0x10,
        ds=0x18,
        es=0x18,
        ss=0x18,
    )
    return BzImageBoot(
        state, header, load_address, BOOT_PARAMS_ADDRESS,
        COMMAND_LINE_ADDRESS, initrd_address, len(initrd))


def expand_bzimage(image):
    """Return the standard compressed payload as its canonical ELF image."""
    image = bytes(image)
    header = parse_bzimage(image)
    offset = _image_integer(image, 0x248, 4)
    length = _image_integer(image, 0x24c, 4)
    start = header.payload_offset + offset
    end = start + length
    if not length or end > len(image):
        raise X86Error('Linux compressed payload extent is invalid')
    try:
        return gzip.decompress(image[start:end])
    except (EOFError, OSError) as error:
        raise X86Error('Linux compressed payload is not a gzip stream') \
            from error


def _load_kernel_elf(memory, image, load_address):
    """Place PT_LOAD segments at one relocatable physical base."""
    if len(image) < 64 or image[:6] != b'\x7fELF\x02\x01':
        raise X86Error('expanded Linux kernel is not ELF64 little-endian')
    fields = struct.unpack_from('<16sHHIQQQIHHHHHH', image, 0)
    (_ident, elf_type, machine, _version, entry, program_offset,
     _section_offset, _flags, header_bytes, program_bytes, program_count,
     _section_bytes, _section_count, _strings) = fields
    if elf_type != 2 or machine != 62 or header_bytes != 64 \
            or program_bytes != 56:
        raise X86Error('expanded Linux kernel has an unsupported ELF ABI')
    program_end = program_offset + program_count * program_bytes
    if program_end > len(image):
        raise X86Error('expanded Linux program table is truncated')

    segments = []
    for index in range(program_count):
        values = struct.unpack_from(
            '<IIQQQQQQ', image, program_offset + index * program_bytes)
        (kind, _segment_flags, offset, _virtual, physical, file_bytes,
         memory_bytes, alignment) = values
        if kind != 1:
            continue
        if file_bytes > memory_bytes or offset + file_bytes > len(image):
            raise X86Error('expanded Linux load segment is truncated')
        # ELF requires p_vaddr and p_offset to be congruent modulo p_align.
        # p_paddr is an image-specific load coordinate and is not subject to
        # that rule; current Linux images use a deliberately incongruent
        # physical address for one zero-based virtual segment.
        if alignment and _virtual % alignment != offset % alignment:
            raise X86Error('expanded Linux load segment is misaligned')
        segments.append((physical, offset, file_bytes, memory_bytes))
    if not segments:
        raise X86Error('expanded Linux kernel has no loadable segments')
    linked_base = min(segment[0] for segment in segments)
    cut = MemoryCut(memory)
    for physical, offset, file_bytes, memory_bytes in segments:
        target = int(load_address) + physical - linked_base
        if target < 0 or target + memory_bytes > len(memory):
            raise X86Error('expanded Linux load segment exceeds RAM')
        cut.write(target, image[offset:offset + file_bytes])
        if memory_bytes > file_bytes:
            cut.fill(target + file_bytes, memory_bytes - file_bytes, 0)
    entry_address = int(load_address) + int(entry) - linked_base
    if not any(
            int(load_address) + physical - linked_base <= entry_address
            < int(load_address) + physical - linked_base + memory_bytes
            for physical, _offset, _file_bytes, memory_bytes in segments):
        raise X86Error('expanded Linux entry is outside loadable memory')
    return cut.commit(), entry_address


def load_bzimage_kernel(image, memory_bytes=None, command_line=None,
                        load_address=None, initrd=None):
    """Normalize a bzImage once and enter the real x86 kernel directly."""
    header = parse_bzimage(image)
    # ``code32_start`` names the compressed protected-mode payload.  Once the
    # payload has been expanded offline, its ELF PT_LOAD image belongs at the
    # preferred physical base even for a non-relocatable kernel.  Reusing the
    # compressed coordinate can violate the kernel's 2 MiB startup invariant.
    if load_address is None:
        load_address = header.preferred_address or header.code32_start
    boot = load_bzimage(
        image, memory_bytes=memory_bytes, command_line=command_line,
        load_address=load_address, initrd=initrd)
    memory, entry = _load_kernel_elf(
        boot.state.memory, expand_bzimage(image), boot.load_address)
    state = replace(boot.state, memory=memory, rip=entry)
    return replace(boot, state=state)


@dataclass(frozen=True)
class X86State:
    registers: tuple
    rip: int
    memory: PagedMemory
    rflags: int = 2
    cr0: int = 0
    cr2: int = 0
    cr3: int = 0
    cr4: int = 0
    cr8: int = 0
    efer: int = 0
    gdtr: tuple = (0, 0)
    idtr: tuple = (0, 0)
    cs: int = 0
    ds: int = 0
    es: int = 0
    ss: int = 0
    fs: int = 0
    gs: int = 0
    ldtr: int = 0
    tr: int = 0
    debug: tuple = (0,) * 8
    msrs: tuple = ()
    halted: bool = False
    interrupts: tuple = ()
    translations: object = field(default_factory=dict, compare=False,
                                 repr=False)

    def __post_init__(self):
        if len(self.registers) != len(REGISTER_NAMES):
            raise ValueError('x86 state needs sixteen general registers')

    def register(self, name):
        return self.registers[REGISTER_INDEX[name]]

    def with_register(self, name, value):
        registers = list(self.registers)
        registers[REGISTER_INDEX[name]] = int(value) & MASK64
        return replace(self, registers=tuple(registers))


_X86_STATE_FIELDS = (
    'registers', 'rip', 'memory', 'rflags', 'cr0', 'cr2', 'cr3', 'cr4',
    'cr8', 'efer', 'gdtr', 'idtr', 'cs', 'ds', 'es', 'ss', 'fs', 'gs',
    'ldtr', 'tr', 'debug', 'msrs', 'halted', 'interrupts', 'translations')


class _X86Frame(object):
    """One mutable physical CPU frame retained only inside a state cut."""

    __slots__ = _X86_STATE_FIELDS

    def __init__(self, state):
        for name in _X86_STATE_FIELDS:
            setattr(self, name, getattr(state, name))

    def register(self, name):
        return self.registers[REGISTER_INDEX[name]]

    def with_register(self, name, value):
        registers = list(self.registers)
        registers[REGISTER_INDEX[name]] = int(value) & MASK64
        self.registers = tuple(registers)
        return self


def _freeze_state(state):
    if not isinstance(state, _X86Frame):
        return state
    return X86State(*(getattr(state, name) for name in _X86_STATE_FIELDS))


def replace(instance, /, **changes):
    """Update the transient CPU frame; copy persistent public values."""
    if isinstance(instance, _X86Frame):
        for name, value in changes.items():
            if name not in _X86_STATE_FIELDS:
                raise TypeError('unknown x86 state field %r' % name)
            setattr(instance, name, value)
        return instance
    return _dataclass_replace(instance, **changes)


def initial_state(memory, rip=0, registers=(), **control):
    values = [0] * len(REGISTER_NAMES)
    for name, value in dict(registers).items():
        values[REGISTER_INDEX[name]] = int(value) & MASK64
    return X86State(tuple(values), int(rip) & MASK64, memory, **control)


def _physical_u64(memory, address):
    try:
        return int.from_bytes(memory.read(address, 8), 'little')
    except Exception as error:
        raise PageFault(address) from error


def translate(state, address, access='read', user=False):
    """Translate one canonical x86-64 virtual byte coordinate."""
    address = int(address) & MASK64
    upper = address >> 48
    if upper not in (0, 0xffff) or bool(upper) != bool(address & (1 << 47)):
        raise PageFault(address, access)
    virtual_page = address >> 12
    cache_key = virtual_page, str(access), bool(user)
    physical_page = state.translations.get(cache_key)
    if physical_page is not None:
        physical = physical_page | (address & (PAGE_BYTES - 1))
        if physical >= len(state.memory):
            raise PageFault(address, access, present=True)
        return physical
    if not state.cr0 & CR0_PAGING:
        if address >= len(state.memory):
            raise PageFault(address, access)
        state.translations[cache_key] = address & ~(PAGE_BYTES - 1)
        return address

    table = state.cr3 & ADDRESS_MASK
    for level, shift in enumerate((39, 30, 21, 12)):
        slot = (address >> shift) & 0x1ff
        entry = _physical_u64(state.memory, table + slot * 8)
        if not entry & PRESENT:
            raise PageFault(address, access)
        if access == 'write' and not entry & WRITABLE:
            raise PageFault(address, access, present=True)
        if user and not entry & USER:
            raise PageFault(address, access, present=True)
        if (access == 'execute' and state.efer & EFER_NXE
                and entry & NO_EXECUTE):
            raise PageFault(address, access, present=True)
        if level in (1, 2) and entry & LARGE:
            page_shift = shift
            base_mask = ((1 << 52) - 1) & ~((1 << page_shift) - 1)
            physical = (entry & base_mask) | (
                address & ((1 << page_shift) - 1))
            if physical >= len(state.memory):
                raise PageFault(address, access, present=True)
            state.translations[cache_key] = physical & ~(PAGE_BYTES - 1)
            return physical
        table = entry & ADDRESS_MASK

    physical = table | (address & (PAGE_BYTES - 1))
    if physical >= len(state.memory):
        raise PageFault(address, access, present=True)
    state.translations[cache_key] = physical & ~(PAGE_BYTES - 1)
    return physical


def read_virtual(state, address, size, access='read'):
    size = int(size)
    if size < 0:
        raise ValueError('x86 read size cannot be negative')
    chunks = []
    end = int(address) + size
    while address < end:
        physical = translate(state, address, access)
        count = min(end - address, PAGE_BYTES - (physical & 0xfff))
        chunks.append(state.memory.read(physical, count))
        address += count
    return b''.join(chunks)


def load_virtual(state, address, size, access='read'):
    """Load one little-endian integer from direct physical coordinates.

    Ordinary scalar loads stay integers through the shared byte-SSA cut.
    Only an access crossing a guest page needs to join multiple coordinates;
    no temporary byte payload is materialized on the common path.
    """
    size = int(size)
    if size < 0:
        raise ValueError('x86 load size cannot be negative')
    value = 0
    shift = 0
    end = int(address) + size
    while address < end:
        physical = translate(state, address, access)
        count = min(end - address, PAGE_BYTES - (physical & 0xfff))
        part = (state.memory.load(physical, count)
                if isinstance(state.memory, MemoryCut)
                else int.from_bytes(
                    state.memory.read(physical, count), 'little'))
        value |= part << shift
        shift += count * 8
        address += count
    return value


def find_virtual(state, address, size, values):
    """Find a byte without observing coordinates after the first match."""
    size = int(size)
    if size < 0:
        raise ValueError('x86 find size cannot be negative')
    start = int(address)
    end = start + size
    address = start
    while address < end:
        physical = translate(state, address)
        count = min(end - address, PAGE_BYTES - (physical & 0xfff))
        if isinstance(state.memory, MemoryCut):
            found = state.memory.find(physical, count, values)
        else:
            payload = state.memory.read(physical, count)
            found = min((coordinate for value in values
                         for coordinate in (payload.find(bytes((value,))),)
                         if coordinate >= 0), default=None)
        if found is not None:
            return address - start + found
        address += count
    return None


def find_virtual_not(state, address, size, value):
    """Find the first unequal byte through the shared physical cut."""
    size = int(size)
    if size < 0:
        raise ValueError('x86 complement find size cannot be negative')
    start = int(address)
    end = start + size
    address = start
    while address < end:
        physical = translate(state, address)
        count = min(end - address, PAGE_BYTES - (physical & 0xfff))
        if isinstance(state.memory, MemoryCut):
            found = state.memory.find_not(physical, count, value)
        else:
            payload = state.memory.read(physical, count)
            found = next((coordinate for coordinate, byte in enumerate(
                payload) if byte != value), None)
        if found is not None:
            return address - start + found
        address += count
    return None


def find_virtual_sequence(state, address, size, needle):
    """Find a byte sequence through direct first-coordinate projection."""
    needle = bytes(needle)
    if not needle:
        return 0
    candidates = int(size) - len(needle) + 1
    position = 0
    while position < candidates:
        found = find_virtual(
            state, int(address) + position, candidates - position,
            (needle[0],))
        if found is None:
            return None
        position += found
        if read_virtual(
                state, int(address) + position, len(needle)) == needle:
            return position
        position += 1
    return None


def _execution_proof(state, address, size):
    """Name every direct page that proves one executable virtual extent."""
    config = (state.cr0, state.cr3, state.cr4, state.efer, state.cs)
    pages = {}

    def retain(physical, count):
        index, offset = divmod(int(physical), PHYSICAL_PAGE_BYTES)
        key = index, offset, int(count)
        if key in pages:
            return True
        token = state.memory.proof_token(index, offset, count)
        if token is None:
            return False
        pages[key] = token
        return True

    def proven_translate(virtual):
        virtual = int(virtual) & MASK64
        if not state.cr0 & CR0_PAGING:
            return virtual if virtual < len(state.memory) else None
        table = state.cr3 & ADDRESS_MASK
        for level, shift in enumerate((39, 30, 21, 12)):
            slot = (virtual >> shift) & 0x1ff
            entry_address = table + slot * 8
            if not retain(entry_address, 8):
                return None
            entry = _physical_u64(state.memory, entry_address)
            if not entry & PRESENT:
                return None
            if (state.efer & EFER_NXE) and entry & NO_EXECUTE:
                return None
            if level in (1, 2) and entry & LARGE:
                mask = ((1 << 52) - 1) & ~((1 << shift) - 1)
                return ((entry & mask)
                        | (virtual & ((1 << shift) - 1)))
            table = entry & ADDRESS_MASK
        return table | (virtual & (PAGE_BYTES - 1))

    at = 0
    while at < int(size):
        virtual = int(address) + at
        physical = proven_translate(virtual)
        if physical is None or physical >= len(state.memory):
            return config, None
        count = min(int(size) - at,
                    PHYSICAL_PAGE_BYTES
                    - (physical % PHYSICAL_PAGE_BYTES),
                    PAGE_BYTES - (physical & (PAGE_BYTES - 1)))
        if not retain(physical, count):
            return config, None
        at += count
    return config, tuple(
        (index, offset, count, token[0], token[1])
        for (index, offset, count), token in sorted(pages.items()))


class _VirtualProofReader(object):
    """Load sparse virtual coordinates and retain only their source pages."""

    __slots__ = ('state', 'pages', 'loads', 'translations')

    def __init__(self, state):
        self.state = state
        self.pages = {}
        self.loads = 0
        self.translations = {}

    def _retain(self, physical):
        index = int(physical) // PHYSICAL_PAGE_BYTES
        if index in self.pages:
            return
        token = self.state.memory.proof_token(index)
        if token is None:
            raise PageFault(physical)
        self.pages[index] = token

    def _translate(self, virtual):
        virtual = int(virtual) & MASK64
        upper = virtual >> 48
        if (upper not in (0, 0xffff)
                or bool(upper) != bool(virtual & (1 << 47))):
            raise PageFault(virtual)
        virtual_page = virtual >> 12
        cached = self.translations.get(virtual_page)
        if cached is not None:
            return cached | (virtual & (PAGE_BYTES - 1))
        if not self.state.cr0 & CR0_PAGING:
            if virtual >= len(self.state.memory):
                raise PageFault(virtual)
            self.translations[virtual_page] = \
                virtual & ~(PAGE_BYTES - 1)
            return virtual
        table = self.state.cr3 & ADDRESS_MASK
        for level, shift in enumerate((39, 30, 21, 12)):
            slot = (virtual >> shift) & 0x1ff
            entry_address = table + slot * 8
            self._retain(entry_address)
            entry = _physical_u64(self.state.memory, entry_address)
            if not entry & PRESENT:
                raise PageFault(virtual)
            if level in (1, 2) and entry & LARGE:
                mask = ((1 << 52) - 1) & ~((1 << shift) - 1)
                physical = ((entry & mask)
                            | (virtual & ((1 << shift) - 1)))
                if physical >= len(self.state.memory):
                    raise PageFault(virtual, present=True)
                self.translations[virtual_page] = \
                    physical & ~(PAGE_BYTES - 1)
                return physical
            table = entry & ADDRESS_MASK
        physical = table | (virtual & (PAGE_BYTES - 1))
        if physical >= len(self.state.memory):
            raise PageFault(virtual, present=True)
        self.translations[virtual_page] = physical & ~(PAGE_BYTES - 1)
        return physical

    def absorb(self, config, proof):
        current = (self.state.cr0, self.state.cr3, self.state.cr4,
                   self.state.efer, self.state.cs)
        if config != current or _proof_mismatch(
                self.state, config, proof) is not None:
            return False
        for index, _offset, _count, source, coordinate in proof:
            token = source, coordinate
            prior = self.pages.get(index)
            if prior is not None and prior != token:
                return False
            self.pages[index] = token
        return True

    def read(self, address, size):
        chunks = []
        address = int(address) & MASK64
        end = address + int(size)
        while address < end:
            physical = self._translate(address)
            count = min(end - address,
                        PAGE_BYTES - (physical & (PAGE_BYTES - 1)),
                        PHYSICAL_PAGE_BYTES
                        - (physical % PHYSICAL_PAGE_BYTES))
            self._retain(physical)
            chunks.append(self.state.memory.read(physical, count))
            address += count
            self.loads += 1
        return b''.join(chunks)

    def load(self, address, size):
        value = 0
        shift = 0
        address = int(address) & MASK64
        end = address + int(size)
        while address < end:
            physical = self._translate(address)
            count = min(end - address,
                        PAGE_BYTES - (physical & (PAGE_BYTES - 1)),
                        PHYSICAL_PAGE_BYTES
                        - (physical % PHYSICAL_PAGE_BYTES))
            self._retain(physical)
            memory = self.state.memory
            part = (memory.load(physical, count)
                    if isinstance(memory, MemoryCut)
                    else int.from_bytes(memory.read(physical, count),
                                        'little'))
            value |= part << shift
            shift += count * 8
            address += count
            self.loads += 1
        return value

    def proof(self):
        config = (self.state.cr0, self.state.cr3, self.state.cr4,
                  self.state.efer, self.state.cs)
        return config, tuple(
            (index, 0, PHYSICAL_PAGE_BYTES, token[0], token[1])
            for index, token in sorted(self.pages.items()))


def _proof_mismatch(state, config, proof):
    if proof is None:
        return 'unavailable'
    if config != (state.cr0, state.cr3, state.cr4, state.efer, state.cs):
        return 'config'
    for index, offset, count, source, coordinate in proof:
        token = state.memory.proof_token(index, offset, count)
        if token is None:
            return 'dirty'
        if token[0] is not source or token[1] != coordinate:
            return 'version'
    return None


def write_virtual(state, address, payload):
    payload = bytes(payload)
    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    at = 0
    while at < len(payload):
        virtual = int(address) + at
        physical = translate(state, virtual, 'write')
        count = min(len(payload) - at, PAGE_BYTES - (physical & 0xfff))
        cut.write(physical, payload[at:at + count])
        at += count
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


class _VirtualMemoryCut(object):
    """Present x86 virtual bytes to the shared physical state-page executor."""

    __slots__ = ('state',)

    def __init__(self, state, cut):
        self.state = replace(_freeze_state(state), memory=cut)

    def load(self, address, width):
        return load_virtual(self.state, int(address) & MASK64, int(width))

    def read(self, address, width):
        return read_virtual(self.state, int(address) & MASK64, int(width))

    def write(self, address, payload):
        write_virtual(self.state, int(address) & MASK64, bytes(payload))

    def repeat(self, address, size, pattern):
        repeat_virtual(
            self.state, int(address) & MASK64, int(size), bytes(pattern))

    def find2(self, address, first, second):
        start = int(address) & MASK64
        distance = 0
        values = (int(first) & 0xff, int(second) & 0xff)
        while True:
            virtual = start + distance
            if virtual > MASK64:
                raise X86Error('x86 virtual find coordinate wrapped')
            physical = translate(self.state, virtual, 'read')
            count = PAGE_BYTES - (virtual & (PAGE_BYTES - 1))
            found = self.state.memory.find(physical, count, values)
            if found is not None:
                return (distance + found,
                        self.state.memory.load(physical + found, 1))
            distance += count

    def copy_until(self, source, target, start, limit, target_end, sentinel):
        """Run one indexed byte-copy residual through virtual page cuts."""
        source, target = int(source) & MASK64, int(target) & MASK64
        index, limit = int(start), int(limit)
        target_end, sentinel = int(target_end) & MASK64, int(sentinel) & 0xff
        dependency = (target - source) & MASK64
        last = 0
        while index < limit:
            virtual = (source + index) & MASK64
            count = min(limit - index,
                        PAGE_BYTES - (virtual & (PAGE_BYTES - 1)))
            target_at = (target + index) & MASK64
            if target_at > MASK64 - (count - 1):
                count = MASK64 - target_at + 1
            if (target_at < target_end and dependency
                    and dependency < count):
                count = dependency
            payload = read_virtual(self.state, virtual, count)
            found = payload.find(bytes((sentinel,)))
            observed = count if found < 0 else found
            eligible = min(observed, target_end - target_at) \
                if target_at < target_end else 0
            if eligible:
                write_virtual(self.state, target_at, payload[:eligible])
            if found >= 0:
                return index + found, sentinel, True
            last = payload[-1]
            index += count
        return index, last, False


def write_virtual_batch(state, writes):
    """Publish virtual byte slices only after every mapping is proved."""
    segments = []
    for address, payload in writes:
        payload = bytes(payload)
        at = 0
        while at < len(payload):
            virtual = (int(address) + at) & MASK64
            physical = translate(state, virtual, 'write')
            count = min(
                len(payload) - at, PAGE_BYTES - (physical & 0xfff))
            segments.append((physical, payload[at:at + count]))
            at += count
    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    for physical, payload in segments:
        cut.write(physical, payload)
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


def increment_virtual_bytes(state, increments):
    """Join virtual byte deltas into one direct physical projection."""
    physical = {}
    for address, delta in increments:
        coordinate = translate(state, int(address) & MASK64, 'write')
        physical[coordinate] = (
            physical.get(coordinate, 0) + int(delta)) & 0xff
    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    cut.increment_bytes(physical.items())
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


def _physical_virtual_records(state, address, count, stride, extent,
                              read_offset=None, write_offset=None):
    """Resolve fixed records once per virtual page to physical coordinates."""
    address, count, stride, extent = (
        int(address), int(count), int(stride), int(extent))
    if count < 0 or stride <= 0:
        raise ValueError('virtual record coordinates have an invalid extent')
    if extent <= 0 or extent > stride:
        raise ValueError('virtual record coordinates exceed their stride')
    offsets = tuple(offset for offset in (read_offset, write_offset)
                    if offset is not None)
    if not offsets or min(offsets) < 0 or max(offsets) >= extent:
        raise ValueError('virtual record access offset is invalid')

    physical_pages = {}
    records = []
    for index in range(count):
        record = (address + index * stride) & MASK64
        page_offset = record & (PAGE_BYTES - 1)
        if page_offset + extent > PAGE_BYTES:
            raise ValueError('virtual record crosses a page boundary')
        page = record >> 12
        physical_page = physical_pages.get(page)
        if physical_page is None:
            mappings = []
            if read_offset is not None:
                mappings.append(translate(
                    state, record + read_offset, 'read') - (
                        page_offset + read_offset))
            if write_offset is not None:
                mappings.append(translate(
                    state, record + write_offset, 'write') - (
                        page_offset + write_offset))
            if len(set(mappings)) != 1:
                raise ValueError(
                    'virtual record read/write mappings disagree')
            physical_page = physical_pages[page] = mappings[0]
        records.append(physical_page + page_offset)
    return tuple(records)


def project_virtual_records(state, address, count, stride, lanes):
    """Project sparse record lanes through one translation per virtual page."""
    address, count, stride = int(address), int(count), int(stride)
    lanes = tuple(tuple(int(value) for value in lane) for lane in lanes)
    if count < 0 or stride <= 0:
        raise ValueError('virtual record projection has an invalid extent')
    if not count or not lanes:
        return state
    extent = max(lane[0] + lane[1] for lane in lanes)
    if min(lane[0] for lane in lanes) < 0 \
            or extent > stride:
        raise ValueError('virtual record lanes exceed their stride')
    read_lane = next((lane for lane in lanes if lane[2]), None)
    records = _physical_virtual_records(
        state, address, count, stride, extent,
        None if read_lane is None else read_lane[0], lanes[0][0])

    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    cut.project_records(records, lanes)
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


def multiply_virtual_records(
        state, address, count, stride, offset, width, multiplier):
    """Multiply a strided virtual lane through the physical record array."""
    address, count, stride, offset, width = (
        int(address), int(count), int(stride), int(offset), int(width))
    if count < 0 or stride <= 0 or offset < 0 or offset + width > stride:
        raise ValueError('virtual record multiply has an invalid extent')
    if not count:
        return state
    records = _physical_virtual_records(
        state, address + offset, count, stride, width, 0, 0)
    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    cut.multiply_records(records, 0, width, multiplier)
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


def store_virtual_record_values(
        state, address, count, stride, offset, width, values):
    """Publish computed record lanes after resolving their page directory."""
    address, count, stride, offset, width = (
        int(address), int(count), int(stride), int(offset), int(width))
    values = tuple(int(value) for value in values)
    if count < 0 or stride <= 0 or offset < 0 or offset + width > stride:
        raise ValueError('virtual record values have an invalid extent')
    if len(values) != count:
        raise ValueError('virtual record values have the wrong count')
    if not count:
        return state
    records = _physical_virtual_records(
        state, address + offset, count, stride, width, None, 0)
    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    cut.store_record_values(records, 0, width, values)
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


def store_virtual_values(state, addresses, width, values):
    """Scatter selected virtual coordinates through one physical page cut."""
    addresses = tuple(int(address) & MASK64 for address in addresses)
    values = tuple(int(value) for value in values)
    width = int(width)
    if width <= 0 or len(addresses) != len(values):
        raise ValueError('virtual values have an invalid shape')
    physical = []
    for address in addresses:
        coordinate = translate(state, address, 'write')
        if coordinate & (PAGE_BYTES - 1) > PAGE_BYTES - width:
            raise ValueError('virtual value crosses a page boundary')
        physical.append(coordinate)
    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    cut.store_record_values(physical, 0, width, values)
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


def project_matching_virtual_records(
        state, address, count, stride, predicates, lanes):
    """Validate and project the matching prefix in direct physical SSA."""
    address, count, stride = int(address), int(count), int(stride)
    predicates = tuple(tuple(predicate) for predicate in predicates)
    lanes = tuple(tuple(int(value) for value in lane) for lane in lanes)
    if count < 0 or stride <= 0:
        raise ValueError('virtual record projection has an invalid extent')
    if not count or not predicates or not lanes:
        return state, 0
    extent = max(
        max(offset + width for offset, width, *_rest in predicates),
        max(lane[0] + lane[1] for lane in lanes))
    if (min(offset for offset, _width, *_rest in predicates) < 0
            or min(lane[0] for lane in lanes) < 0
            or extent > stride):
        raise ValueError('virtual record lanes exceed their stride')
    records = _physical_virtual_records(
        state, address, count, stride, extent,
        predicates[0][0], lanes[0][0])
    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    matching = cut.matching_record_prefix(records, predicates)
    if not matching:
        return state, 0
    cut.project_records(records[:matching], lanes)
    if isinstance(state.memory, MemoryCut):
        return state, matching
    return replace(state, memory=cut.commit()), matching


def copy_virtual(state, source, target, size):
    """Copy proved virtual extents through direct physical coordinates."""
    source = int(source) & MASK64
    target = int(target) & MASK64
    size = int(size)
    if size < 0:
        raise ValueError('x86 copy size cannot be negative')
    if not size or source == target:
        return state
    extents = []
    at = 0
    while at < size:
        source_virtual = (source + at) & MASK64
        target_virtual = (target + at) & MASK64
        source_physical = translate(state, source_virtual, 'read')
        target_physical = translate(state, target_virtual, 'write')
        count = min(
            size - at,
            PAGE_BYTES - (source_physical & (PAGE_BYTES - 1)),
            PAGE_BYTES - (target_physical & (PAGE_BYTES - 1)))
        extents.append((source_physical, target_physical, count))
        at += count

    source_ranges = tuple((start, start + count)
                          for start, _target, count in extents)
    target_ranges = tuple((start, start + count)
                          for _source, start, count in extents)
    overlap = any(left < right_end and right < left_end
                  for left, left_end in source_ranges
                  for right, right_end in target_ranges)
    if overlap:
        return write_virtual(state, target,
                             read_virtual(state, source, size))

    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    for source_physical, target_physical, count in extents:
        cut.copy(source_physical, target_physical, count)
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


def patch_virtual(state, address, payload):
    """Patch proved kernel text through its existing physical mapping."""
    payload = bytes(payload)
    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    at = 0
    while at < len(payload):
        virtual = int(address) + at
        physical = translate(state, virtual, 'read')
        count = min(len(payload) - at, PAGE_BYTES - (physical & 0xfff))
        cut.write(physical, payload[at:at + count])
        at += count
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


def fill_virtual(state, address, size, value):
    """Fill prevalidated virtual extents through the canonical memory cut."""
    size = int(size)
    if size < 0:
        raise ValueError('x86 fill size cannot be negative')
    extents = []
    at = 0
    while at < size:
        virtual = int(address) + at
        physical = translate(state, virtual, 'write')
        count = min(size - at, PAGE_BYTES - (physical & 0xfff))
        extents.append((physical, count))
        at += count
    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    for physical, count in extents:
        cut.fill(physical, count, int(value) & 0xff)
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


def repeat_virtual(state, address, size, pattern):
    """Repeat a physical byte pattern across prevalidated virtual extents."""
    pattern = bytes(pattern)
    if not pattern:
        raise ValueError('x86 repeat pattern cannot be empty')
    size = int(size)
    if size < 0:
        raise ValueError('x86 repeat size cannot be negative')
    extents = []
    at = 0
    while at < size:
        virtual = int(address) + at
        physical = translate(state, virtual, 'write')
        count = min(size - at, PAGE_BYTES - (physical & 0xfff))
        extents.append((physical, count, at % len(pattern)))
        at += count
    cut = state.memory if isinstance(state.memory, MemoryCut) \
        else MemoryCut(state.memory)
    for physical, count, phase in extents:
        rotated = pattern[phase:] + pattern[:phase]
        cut.repeat(physical, count, rotated)
    return state if isinstance(state.memory, MemoryCut) \
        else replace(state, memory=cut.commit())


def copy_forward_virtual(state, source, target, size):
    """Copy one proven forward loop, preserving LZ-style overlap semantics."""
    source, target, size = int(source), int(target), int(size)
    if size < 0:
        raise ValueError('x86 copy size cannot be negative')
    if not size or source == target:
        return state
    if source < target < source + size:
        distance = target - source
        pattern = read_virtual(state, source, min(distance, size))
        return repeat_virtual(state, target, size, pattern)

    identity = True
    for address, access in ((source, 'read'), (target, 'write')):
        at = 0
        while at < size:
            virtual = address + at
            physical = translate(state, virtual, access)
            identity = identity and physical == virtual
            at += min(size - at, PAGE_BYTES - (physical & 0xfff))
    if identity:
        cut = state.memory if isinstance(state.memory, MemoryCut) \
            else MemoryCut(state.memory)
        cut.copy(source, target, size)
        return state if isinstance(state.memory, MemoryCut) \
            else replace(state, memory=cut.commit())
    return write_virtual(state, target, read_virtual(state, source, size))


def _write_register(registers, index, value, bits):
    values = list(registers)
    mask = (1 << bits) - 1
    if bits == 32:
        values[index] = int(value) & MASK32
    elif bits < 32:
        values[index] = (values[index] & ~mask) | (int(value) & mask)
    else:
        values[index] = int(value) & MASK64
    return tuple(values)


@dataclass(frozen=True)
class X86Boundary:
    operation: str
    detail: object = None


@dataclass(frozen=True)
class MemoryOperand:
    base: object = None
    index: object = None
    scale: int = 1
    displacement: int = 0
    rip_relative: bool = False
    segment_msr: object = None

    def address(self, state, following):
        value = int(self.displacement)
        if self.rip_relative:
            value += int(following)
        elif self.base is not None:
            value += state.registers[self.base]
        if self.index is not None:
            value += state.registers[self.index] * self.scale
        if self.segment_msr is not None:
            value += dict(state.msrs).get(self.segment_msr, 0)
        return value & MASK64


@dataclass(frozen=True)
class HighByteRegister:
    index: int


def _byte_register(index, rex):
    return HighByteRegister(index - 4) if not rex and 4 <= index <= 7 \
        else index


def _register_operand_value(registers, operand, bits):
    if isinstance(operand, HighByteRegister):
        if bits != 8:
            raise X86Error('high byte register used outside an 8-bit operation')
        return (registers[operand.index] >> 8) & 0xff
    return registers[operand] & ((1 << bits) - 1)


def _write_register_operand(registers, operand, value, bits):
    if isinstance(operand, HighByteRegister):
        if bits != 8:
            raise X86Error('high byte register used outside an 8-bit operation')
        values = list(registers)
        values[operand.index] = ((values[operand.index] & ~0xff00)
                                 | ((int(value) & 0xff) << 8))
        return tuple(values)
    return _write_register(registers, operand, value, bits)


def _result_flags(rflags, operation, left, right, result, bits,
                  preserve_carry=False, carry_in=0):
    mask = (1 << bits) - 1
    sign = 1 << (bits - 1)
    left &= mask
    right &= mask
    result &= mask
    carry_in = int(bool(carry_in))
    flags = rflags & ~RFLAGS_ARITHMETIC
    if preserve_carry:
        flags |= rflags & RFLAGS_CARRY
    elif operation in ('add', 'adc') \
            and left + right + carry_in > mask:
        flags |= RFLAGS_CARRY
    elif operation in ('sub', 'cmp', 'sbb') \
            and left < right + carry_in:
        flags |= RFLAGS_CARRY
    if result == 0:
        flags |= RFLAGS_ZERO
    if result & sign:
        flags |= RFLAGS_SIGN
    if (result & 0xff).bit_count() % 2 == 0:
        flags |= RFLAGS_PARITY
    if operation in ('add', 'adc') and not ((left ^ right) & sign) \
            and ((left ^ result) & sign):
        flags |= RFLAGS_OVERFLOW
    elif operation in ('sub', 'cmp', 'sbb') and ((left ^ right) & sign) \
            and ((left ^ result) & sign):
        flags |= RFLAGS_OVERFLOW
    return flags | 2


def _condition(rflags, code):
    carry = bool(rflags & RFLAGS_CARRY)
    parity = bool(rflags & RFLAGS_PARITY)
    zero = bool(rflags & RFLAGS_ZERO)
    sign = bool(rflags & RFLAGS_SIGN)
    overflow = bool(rflags & RFLAGS_OVERFLOW)
    return (
        overflow,
        not overflow,
        carry,
        not carry,
        zero,
        not zero,
        carry or zero,
        not carry and not zero,
        sign,
        not sign,
        parity,
        not parity,
        sign != overflow,
        sign == overflow,
        zero or sign != overflow,
        not zero and sign == overflow,
    )[int(code) & 15]


@dataclass(frozen=True)
class DecodedBlock:
    rip: int
    boundary_rip: int
    source: bytes
    instructions: int
    plan: object
    mapped: object
    execute: object
    scratch_count: int
    boundary: X86Boundary
    proof_config: tuple
    proof: object
    flag_cut: object = None
    control_block: object = None
    cut_inputs: tuple = ()
    state_flags: bool = False
    virtual_memory: bool = False
    indirect_register: object = None
    tail_return: object = None
    inlined_call_target: object = None


class _CodeReader(object):
    __slots__ = ('data', 'at', 'segment_msr', 'locked')

    def __init__(self, data):
        self.data = data
        self.at = 0
        self.segment_msr = None
        self.locked = False

    def byte(self):
        if self.at >= len(self.data):
            raise X86Error('x86 instruction is truncated')
        value = self.data[self.at]
        self.at += 1
        return value

    def take(self, count):
        end = self.at + count
        if end > len(self.data):
            raise X86Error('x86 instruction immediate is truncated')
        raw = self.data[self.at:end]
        self.at = end
        return raw


class X86DBT(object):
    """Demand-decode x86 basic blocks into normalized physical state pages."""

    def __init__(self, max_block_bytes=256, profile_controls=False,
                 sponge_records=None, step_executor_factory=None,
                 allow_reference_executor=True,
                 enable_function_oracles=False):
        self.max_block_bytes = int(max_block_bytes)
        self.sponge_records = sponge_records
        self.step_executor_factory = step_executor_factory
        self.allow_reference_executor = bool(allow_reference_executor)
        self.enable_function_oracles = bool(enable_function_oracles)
        if (not self.allow_reference_executor
                and self.step_executor_factory is None):
            raise X86Error(
                'a resident state-page executor is required')
        self.resident_state_pages = 0
        self.reference_state_pages = 0
        self.blocks = {}
        self.decoded_blocks = 0
        self.source_instructions = 0
        self.frontend_raw_work = 0
        self.frontend_raw_span = 0
        self.frontend_boundary_only_slices = 0
        self._frontend_boundaries = {}
        self.physical_work = 0
        self.physical_span = 0
        self.persistent_cuts = 0
        self.materialized_pages = 0
        self.published_pages = 0
        self.retained_cut_pages = 0
        self.forwarded_loads = 0
        self.source_bytes_loaded = 0
        self.aliased_pages = 0
        self.elided_pages = 0
        self.delivered_exceptions = 0
        self.delivered_interrupts = 0
        self.last_page_fault = None
        self.last_page_fault_rip = None
        self.collapsed_fill_bytes = 0
        self.collapsed_fill_iterations = 0
        self.collapsed_repeat_bytes = 0
        self.collapsed_repeat_iterations = 0
        self.collapsed_copy_bytes = 0
        self.collapsed_copy_iterations = 0
        self.collapsed_compare_bytes = 0
        self.collapsed_compare_iterations = 0
        self.collapsed_zero_scan_bytes = 0
        self.collapsed_zero_word_bytes = 0
        self.collapsed_zero_word_iterations = 0
        self.collapsed_affine_record_bytes = 0
        self.collapsed_affine_records = 0
        self.collapsed_relative_record_projections = 0
        self.collapsed_relative_projection_records = 0
        self.collapsed_strided_store_bytes = 0
        self.collapsed_strided_store_iterations = 0
        self.collapsed_record_multiply_words = 0
        self.collapsed_sequential_freelist_links = 0
        self.collapsed_random_freelist_links = 0
        self.collapsed_random_freelist_words = 0
        self.collapsed_search_bytes = 0
        self.collapsed_substring_candidates = 0
        self.collapsed_strided_predicate_candidates = 0
        self.collapsed_default_record_candidates = 0
        self.collapsed_predicate_record_projections = 0
        self.collapsed_predicate_projection_records = 0
        self.collapsed_dispatch_bytes = 0
        self.collapsed_dispatch_iterations = 0
        self.collapsed_byte_state_bytes = 0
        self.collapsed_byte_state_controls = 0
        self.collapsed_byte_state_slices = 0
        self.collapsed_strided_byte_runs = 0
        self.collapsed_residual_bytes = 0
        self.collapsed_residual_controls = 0
        self.collapsed_wrapped_byte_iterations = 0
        self.collapsed_wrapped_byte_coordinates = 0
        self.collapsed_bit_partition_iterations = 0
        self.compiled_byte_dispatches = 0
        self.collapsed_indirect_search_entries = 0
        self.indirect_search_cache_hits = 0
        self.indirect_search_cache_misses = 0
        self.collapsed_indirect_string_entries = 0
        self.indirect_string_cache_hits = 0
        self.indirect_string_cache_misses = 0
        self.collapsed_token_candidate_bytes = 0
        self.collapsed_token_replacements = 0
        self.token_directory_cache_hits = 0
        self.token_directory_cache_misses = 0
        self.collapsed_substring_calls = 0
        self.substring_cache_hits = 0
        self.substring_cache_misses = 0
        self.collapsed_field_scans = 0
        self.collapsed_field_entries = 0
        self.field_directory_cache_hits = 0
        self.field_directory_cache_misses = 0
        self.collapsed_compare_calls = 0
        self.collapsed_bounded_compare_calls = 0
        self.collapsed_bounded_compare_bytes = 0
        self.collapsed_bit_scan_calls = 0
        self.collapsed_bit_scan_words = 0
        self.collapsed_prefix_validator_calls = 0
        self.collapsed_prefix_validator_bytes = 0
        self.collapsed_interval_compare_calls = 0
        self.collapsed_range_table_calls = 0
        self.collapsed_range_table_records = 0
        self.range_table_cache_hits = 0
        self.range_table_cache_misses = 0
        self.collapsed_range_compactions = 0
        self.collapsed_range_compaction_records = 0
        self.collapsed_range_compaction_live_records = 0
        self.collapsed_normalized_compare_calls = 0
        self.collapsed_normalized_compare_bytes = 0
        self.normalized_compare_cache_hits = 0
        self.normalized_compare_cache_misses = 0
        self.collapsed_normalized_field_entries = 0
        self.normalized_field_directory_hits = 0
        self.normalized_field_directory_misses = 0
        self.collapsed_direct_index_calls = 0
        self.collapsed_lane_permutation_calls = 0
        self.collapsed_lane_permutation_lanes = 0
        self.collapsed_chacha_rounds = 0
        self.collapsed_sponge_finalize_calls = 0
        self.collapsed_sponge_finalize_bytes = 0
        self.collapsed_hash_finalize_calls = 0
        self.collapsed_hash_context_bytes = 0
        self.collapsed_hash_update_calls = 0
        self.collapsed_hash_update_bytes = 0
        self.collapsed_hash_init_calls = 0
        self.collapsed_hash_init_bytes = 0
        self.collapsed_sponge_absorb_blocks = 0
        self.collapsed_sponge_absorb_bytes = 0
        self.collapsed_sponge_mix_calls = 0
        self.collapsed_sponge_mix_rounds = 0
        self.collapsed_modular_delta_calls = 0
        self.collapsed_clock_store_returns = 0
        self.collapsed_entropy_measurements = 0
        self.collapsed_entropy_clock_events = 0
        self.collapsed_entropy_memory_iterations = 0
        self.collapsed_entropy_startup_measurements = 0
        self.direct_index_cache_hits = 0
        self.direct_index_cache_misses = 0
        self.collapsed_memory_fill_calls = 0
        self.collapsed_memory_fill_call_bytes = 0
        self.collapsed_memory_copy_calls = 0
        self.collapsed_memory_copy_call_bytes = 0
        self.collapsed_void_memory_copy_calls = 0
        self.collapsed_void_memory_copy_bytes = 0
        self.collapsed_text_patch_calls = 0
        self.collapsed_text_patch_bytes = 0
        self.collapsed_static_call_transforms = 0
        self.collapsed_static_call_bytes = 0
        self.collapsed_static_call_tables = 0
        self.collapsed_static_call_table_records = 0
        self.collapsed_seal_records = 0
        self.collapsed_seal_bytes = 0
        self.collapsed_length_calls = 0
        self.length_cache_hits = 0
        self.length_cache_misses = 0
        self.collapsed_btf_types = 0
        self.btf_directory_cache_hits = 0
        self.btf_directory_cache_misses = 0
        self.collapsed_btf_name_searches = 0
        self.btf_name_index_hits = 0
        self.btf_name_index_misses = 0
        self.compiled_classified_scans = 0
        self.collapsed_classified_bytes = 0
        self.collapsed_record_sorts = 0
        self.collapsed_sort_records = 0
        self.collapsed_sort_passes = 0
        self.collapsed_spin_waits = 0
        self.collapsed_return_branches = 0
        self.collapsed_indirect_calls = 0
        self.collapsed_return_sites = 0
        self.collapsed_entry_nop_calls = 0
        self.collapsed_register_projection_calls = 0
        self.collapsed_machine_leaf_calls = 0
        self.collapsed_page_bootmem_calls = 0
        self.collapsed_page_bootmem_records = 0
        self.collapsed_store_word_calls = 0
        self.collapsed_repeated_store_calls = 0
        self.collapsed_random_u32_cache_hits = 0
        self.collapsed_random_u32_below_calls = 0
        self.collapsed_random_u32_below_words = 0
        self.collapsed_random_permutation_iterations = 0
        self.collapsed_page_record_predicates = 0
        self.collapsed_page_record_projection_iterations = 0
        self.collapsed_return_bytes = 0
        self.collapsed_alternative_tables = 0
        self.collapsed_alternative_entries = 0
        self.collapsed_alternative_bytes = 0
        self.collapsed_smp_lock_tables = 0
        self.collapsed_smp_lock_sites = 0
        self.collapsed_length_prefix_entries = 0
        self.collapsed_token_entries = 0
        self.collapsed_token_bytes = 0
        self.collapsed_symbol_lookups = 0
        self.collapsed_symbol_resolutions = 0
        self.collapsed_symbol_wrappers = 0
        self.collapsed_ftrace_locations = 0
        self.collapsed_ftrace_records = 0
        self.symbol_lookup_cache_hits = 0
        self.symbol_lookup_cache_misses = 0
        self.symbol_lookup_offset_loads = 0
        self.symbol_offset_page_hits = 0
        self.symbol_offset_page_misses = 0
        self.symbol_position_directory_hits = 0
        self.symbol_position_directory_misses = 0
        self.symbol_name_directory_hits = 0
        self.symbol_name_directory_misses = 0
        self.threaded_controls = 0
        self.predicate_cuts = 0
        self.register_cuts = 0
        self.register_cut_instructions = 0
        self.register_cut_work = 0
        self.register_cut_span = 0
        self.register_cut_cache_hits = 0
        self.register_cut_cache_misses = 0
        self.predicate_cut_cache_hits = 0
        self.predicate_cut_cache_misses = 0
        self.predicate_cut_work = 0
        self.predicate_cut_span = 0
        self.recurrence_cuts = 0
        self.recurrence_cut_cache_hits = 0
        self.recurrence_cut_cache_misses = 0
        self.recurrence_cut_work = 0
        self.recurrence_cut_span = 0
        self.recurrence_cut_executions = 0
        self.recurrence_cut_executed_work = 0
        self.recurrence_cut_executed_span = 0
        self.recurrence_source_instructions = 0
        self.prefix_cuts = 0
        self.prefix_cut_cache_hits = 0
        self.prefix_cut_cache_misses = 0
        self.prefix_cut_work = 0
        self.prefix_cut_span = 0
        self.prefix_cut_executions = 0
        self.prefix_cut_executed_work = 0
        self.prefix_cut_executed_span = 0
        self.prefix_source_instructions = 0
        self.stack_cuts = 0
        self.stack_cut_cache_hits = 0
        self.stack_cut_cache_misses = 0
        self.stack_cut_work = 0
        self.stack_cut_span = 0
        self.find_cuts = 0
        self.find_cut_cache_hits = 0
        self.find_cut_cache_misses = 0
        self.find_cut_work = 0
        self.find_cut_span = 0
        self.find_cut_executions = 0
        self.find_cut_executed_work = 0
        self.find_cut_executed_span = 0
        self.find_source_instructions = 0
        self.copy_cuts = 0
        self.copy_cut_cache_hits = 0
        self.copy_cut_cache_misses = 0
        self.copy_cut_work = 0
        self.copy_cut_span = 0
        self.copy_cut_bytes = 0
        self.copy_cut_executions = 0
        self.copy_cut_executed_work = 0
        self.copy_cut_executed_span = 0
        self.copy_source_instructions = 0
        self.direct_return_branches = 0
        self.direct_return_source_instructions = 0
        self.collapse_recipe_hits = 0
        self.collapse_recipe_misses = 0
        self.collapse_recipe_negative = 0
        self.collapse_recipe_attempts = 0
        self.pure_call_recipe_hits = 0
        self.pure_call_recipe_misses = 0
        self.backward_branch_recipe_hits = 0
        self.code_recipe_hits = 0
        self.code_recipe_misses = 0
        self.code_recipe_negative = 0
        self.block_proof_hits = 0
        self.block_proof_misses = 0
        self.block_proof_unavailable = 0
        self.block_proof_config_misses = 0
        self.block_proof_dirty_misses = 0
        self.block_proof_version_misses = 0
        self.block_proof_fast_hits = 0
        self.invalidated_code_blocks = 0
        self.restored_code_blocks = 0
        self.rejected_code_blocks = 0
        self._proof_cache_memory = None
        self._proof_cache_revision = 0
        self._proof_cache = {}
        self._predicate_cuts = {}
        self._register_cuts = {}
        self._recurrence_cuts = {}
        self._prefix_cuts = {}
        self._stack_cuts = {}
        self._find_cuts = {}
        self._copy_cuts = {}
        self._proof_dependents = {}
        self._block_pages = {}
        self._page_blocks = {}
        self._byte_dispatch_cache = {}
        self._state_dispatch_cache = {}
        self._residual_byte_recipes = {}
        self._indirect_search_cache = {}
        self._indirect_string_directories = {}
        self._token_directory_cache = {}
        self._token_scan_layouts = {}
        self._substring_functions = {}
        self._strided_validator_functions = {}
        self._fixed_signature_gate_functions = {}
        self._default_record_loops = {}
        self._predicate_record_loops = {}
        self._substring_cache = {}
        self._field_scan_functions = {}
        self._field_directory_cache = {}
        self._string_compare_functions = {}
        self._bounded_string_compare_functions = {}
        self._bit_scan_functions = {}
        self._prefix_validator_functions = {}
        self._interval_compare_functions = {}
        self._range_table_query_functions = {}
        self._range_table_directories = {}
        self._range_compaction_functions = {}
        self._relative_record_projection_loops = {}
        self._page_reservation_loops = {}
        self._page_record_projection_loops = {}
        self._entry_nop_functions = {}
        self._register_projection_functions = {}
        self._machine_leaf_functions = {}
        self._page_bootmem_functions = {}
        self._store_word_functions = {}
        self._random_u32_cache_functions = {}
        self._random_u32_below_functions = {}
        self._random_permutation_loops = {}
        self._page_record_predicate_functions = {}
        self._normalized_compare_functions = {}
        self._normalized_compare_cache = {}
        self._normalized_field_directories = {}
        self._direct_index_functions = {}
        self._lane_permutation_functions = {}
        self._chacha_permutation_functions = {}
        self._sponge_finalize_functions = {}
        self._hash_stream_functions = {}
        self._hash_init_functions = {}
        self._sponge_init_functions = {}
        self._sponge_update_functions = {}
        self._sponge_mix_functions = {}
        self._modular_delta_functions = {}
        self._clock_store_returns = {}
        self._memory_fill_functions = {}
        self._memory_copy_functions = {}
        self._void_memory_copy_functions = {}
        self._text_patch_functions = {}
        self._static_call_transform_functions = {}
        self._static_call_table_functions = {}
        self._seal_functions = {}
        self._length_functions = {}
        self._length_cache = {}
        self._btf_type_directories = {}
        self._btf_name_indexes = {}
        self._btf_name_functions = {}
        self._byte_class_cache = {}
        self._classified_scan_cache = {}
        self._collapse_recipes = {}
        self._direct_branch_recipes = {}
        self._pure_call_recipes = {}
        self._backward_branch_recipes = {}
        self._code_recipes = {}
        self._token_stream_layouts = {}
        self._symbol_position_functions = {}
        self._symbol_position_cache = {}
        self._symbol_offset_pages = {}
        self._symbol_position_directories = {}
        self._symbol_resolution_functions = {}
        self._symbol_wrapper_functions = {}
        self._symbol_name_directories = {}
        self._ftrace_record_loops = {}
        self._indirect_thunk_functions = {}
        self._control_profile = {} if profile_controls else None
        self._physical_profile = {} if profile_controls else None
        self._physical_boundary_profile = {} if profile_controls else None
        self._hash_stream_profile = {} if profile_controls else None
        self._pure_call_profile = {} if profile_controls else None
        self._entropy_recurrence_profile = {} if profile_controls else None
        self._string_compare_profile = {} if profile_controls else None

    def _bind_state_page(self, mapped, packed=None):
        """Bind one normalized page without an implicit runtime fallback.

        Native tests and artifact verification may use the Python reference
        executor explicitly.  A resident browser runtime disables that route,
        so every reached pure page must be accepted by vm.wasm.
        """
        if self.step_executor_factory is not None:
            if packed is None:
                packed = mapped.data
            execute = self.step_executor_factory(bytes(packed))
            self.resident_state_pages += 1
            return execute
        if not self.allow_reference_executor:
            raise X86Error('a resident state-page executor is required')
        self.reference_state_pages += 1
        return compile_mapped_executor(mapped)

    def publish(self, state):
        """Publish one byte-SSA memory cut and account for it once."""
        if not isinstance(state.memory, MemoryCut):
            return _freeze_state(state)
        cut = state.memory
        if cut.dirty:
            self.persistent_cuts += 1
            self.published_pages += len(cut.dirty)
            self.materialized_pages += cut.materialized_pages
        self.forwarded_loads += cut.forwarded_loads
        self.source_bytes_loaded += cut.source_bytes_loaded
        self.aliased_pages += cut.aliased_pages
        self.elided_pages += cut.elided_pages
        return _freeze_state(replace(state, memory=cut.commit()))

    def retain(self, state):
        """Publish an observable root while retaining direct byte SSA.

        External machine events need an immutable state value, but they do
        not need a storage artifact.  Sealing the physical directory keeps
        the same page proof and lets the response fork it copy-on-write.
        CanonicalPage composition remains reserved for an actual snapshot.
        """
        if not isinstance(state.memory, MemoryCut):
            return _freeze_state(state)
        cut = state.memory
        if cut.sealed:
            return _freeze_state(state)
        pages = cut.generation_pages
        if pages:
            self.persistent_cuts += 1
            self.published_pages += pages
            self.retained_cut_pages += pages
        self.forwarded_loads += cut.forwarded_loads
        self.source_bytes_loaded += cut.source_bytes_loaded
        self.aliased_pages += cut.aliased_pages
        self.elided_pages += cut.elided_pages
        cut.seal()
        return _freeze_state(state)

    def _sync_proof_cache(self, memory):
        if memory is not self._proof_cache_memory:
            self._proof_cache_memory = memory
            self._proof_cache_revision = 0
            self._proof_cache.clear()
            self._proof_dependents.clear()
        if not isinstance(memory, MemoryCut):
            return
        if memory.change_revision == self._proof_cache_revision:
            return
        revision, changed = memory.changed_pages_since(
            self._proof_cache_revision)
        for index in changed:
            for rip in self._proof_dependents.get(index, ()):
                self._proof_cache.pop(rip, None)
        self._proof_cache_revision = revision

    def _proof_is_cached(self, state, block):
        memory = state.memory
        if (memory is not self._proof_cache_memory
                or (isinstance(memory, MemoryCut)
                    and memory.change_revision
                    != self._proof_cache_revision)):
            self._sync_proof_cache(memory)
        cached = self._proof_cache.get(block.rip)
        config = (state.cr0, state.cr3, state.cr4, state.efer, state.cs)
        return cached is not None and cached == (block, config)

    def _cache_block_proof(self, state, block):
        self._sync_proof_cache(state.memory)
        if block.proof is None:
            self._proof_cache.pop(block.rip, None)
            return
        config = (state.cr0, state.cr3, state.cr4, state.efer, state.cs)
        self._proof_cache[block.rip] = block, config
        for index in {entry[0] for entry in block.proof}:
            self._proof_dependents.setdefault(index, set()).add(block.rip)

    def _discard_block(self, rip):
        """Forget one decoded block and its direct physical dependencies."""
        rip = int(rip) & MASK64
        block = self.blocks.pop(rip, None)
        pages = self._block_pages.pop(rip, ())
        for index in pages:
            dependents = self._page_blocks.get(index)
            if dependents is not None:
                dependents.discard(rip)
                if not dependents:
                    self._page_blocks.pop(index, None)
            proved = self._proof_dependents.get(index)
            if proved is not None:
                proved.discard(rip)
        self._proof_cache.pop(rip, None)
        for entry, cached in tuple(self._predicate_cuts.items()):
            proof_blocks, _composed = cached
            if any(rip == proved.rip for proved in proof_blocks):
                self._predicate_cuts.pop(entry, None)
        for entry, cached in tuple(self._register_cuts.items()):
            proof_blocks, _composed = cached
            if any(rip == proved.rip for proved in proof_blocks):
                self._register_cuts.pop(entry, None)
        return block

    def _remember_block(self, block):
        """Index a decoded block by every physical page proving its bytes."""
        self._discard_block(block.rip)
        self.blocks[block.rip] = block
        pages = frozenset(
            entry[0] for entry in (() if block.proof is None else block.proof))
        self._block_pages[block.rip] = pages
        for index in pages:
            self._page_blocks.setdefault(index, set()).add(block.rip)

    def _invalidate_code_pages(self, pages):
        """Drop decoded SSA whose executable physical coordinates changed."""
        victims = set()
        for index in set(int(page) for page in pages):
            victims.update(self._page_blocks.get(index, ()))
        for rip in victims:
            self._discard_block(rip)
        self.invalidated_code_blocks += len(victims)

    @staticmethod
    def _code_page_indices(state, address, size):
        """Name the smallest physical pages touched by one code extent."""
        pages = set()
        at = 0
        while at < int(size):
            virtual = (int(address) + at) & MASK64
            physical = translate(state, virtual, 'execute')
            count = min(
                int(size) - at,
                PAGE_BYTES - (physical & (PAGE_BYTES - 1)),
                PHYSICAL_PAGE_BYTES
                - (physical & (PHYSICAL_PAGE_BYTES - 1)))
            pages.add(physical // PHYSICAL_PAGE_BYTES)
            at += count
        return pages

    def _patch_code_batch(self, state, patches):
        """Publish code bytes and invalidate decoded SSA in one operation."""
        patches = tuple((int(address) & MASK64, bytes(payload))
                        for address, payload in patches if payload)
        pages = set()
        for address, payload in patches:
            pages.update(self._code_page_indices(
                state, address, len(payload)))
        for address, payload in patches:
            state = patch_virtual(state, address, payload)
        self._invalidate_code_pages(pages)
        return state

    @staticmethod
    def _modrm(reader, rex):
        byte = reader.byte()
        mode = byte >> 6
        reg = ((byte >> 3) & 7) | (((rex >> 2) & 1) << 3)
        group = (byte >> 3) & 7
        rm_low = byte & 7
        if mode == 3:
            return reg, rm_low | ((rex & 1) << 3), group

        base = None
        index = None
        scale = 1
        rip_relative = False
        if rm_low == 4:
            sib = reader.byte()
            scale = 1 << (sib >> 6)
            index_low = (sib >> 3) & 7
            if index_low != 4 or rex & 2:
                index = index_low | (((rex >> 1) & 1) << 3)
            base_low = sib & 7
            if mode != 0 or base_low != 5:
                base = base_low | ((rex & 1) << 3)
        elif mode == 0 and rm_low == 5:
            rip_relative = True
        else:
            base = rm_low | ((rex & 1) << 3)

        displacement = 0
        if mode == 1:
            displacement = int.from_bytes(
                reader.take(1), 'little', signed=True)
        elif mode == 2 or (mode == 0 and base is None
                           and not rip_relative):
            displacement = int.from_bytes(
                reader.take(4), 'little', signed=True)
        elif rip_relative:
            displacement = int.from_bytes(
                reader.take(4), 'little', signed=True)
        return reg, MemoryOperand(
            base, index, scale, displacement, rip_relative,
            reader.segment_msr), group

    def _decode(self, state):
        start = state.rip
        if not state.cr0 & CR0_PAGING:
            if start >= len(state.memory):
                raise PageFault(start, 'execute')
            available = min(self.max_block_bytes, len(state.memory) - start)
        else:
            # x86 instructions can cross a page boundary. Translation stays
            # demand-driven, but the decoder must retain enough following
            # bytes to decode the last instruction on the current page.
            available = self.max_block_bytes
        code = read_virtual(state, start, available, 'execute')
        reader = _CodeReader(code)
        locals_ = [Operand('local', index)
                   for index in range(len(REGISTER_NAMES))]
        nodes = []
        common = {}
        scratch = ()
        instruction_count = 0
        boundary = None

        def emit(operation, arguments):
            arguments = tuple(arguments)
            key = operation, arguments
            previous = common.get(key)
            if previous is not None:
                return previous
            value = len(nodes) + 1
            operand = Operand('node', value)
            nodes.append(WaveNode(value, operation, arguments))
            common[key] = operand
            return operand

        def write(register, value, bits):
            if bits == 32 and value.kind == 'const':
                value = Operand('const', value.value & MASK32)
            locals_[register] = value

        while reader.at < len(code):
            instruction_start = reader.at
            rex = 0
            first = reader.byte()
            repeat = False
            operand_override = False
            reader.segment_msr = None
            reader.locked = False
            while first in (0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65,
                            0x66, 0xf0, 0xf3):
                repeat = repeat or first == 0xf3
                operand_override = operand_override or first == 0x66
                reader.locked = reader.locked or first == 0xf0
                if first == 0x64:
                    reader.segment_msr = IA32_FS_BASE
                elif first == 0x65:
                    reader.segment_msr = IA32_GS_BASE
                first = reader.byte()
            if 0x40 <= first <= 0x4f:
                rex = first
                opcode = reader.byte()
            else:
                opcode = first
            bits = 16 if operand_override else (64 if rex & 8 else 32)
            prefix = 'i%d.' % bits

            if opcode == 0x90:
                instruction_count += 1
                continue
            if opcode in (0xfa, 0xfb, 0xfc, 0xfd):
                boundary = X86Boundary(
                    'flag_control', (start + reader.at, opcode))
                break
            if 0xb0 <= opcode <= 0xb7:
                low = opcode - 0xb0
                register = low | ((rex & 1) << 3)
                high_byte = not rex and 4 <= low <= 7
                immediate = reader.byte()
                boundary = X86Boundary(
                    'register_byte_immediate',
                    (start + reader.at, register, high_byte, immediate))
                break
            if 0xb8 <= opcode <= 0xbf:
                register = (opcode - 0xb8) | ((rex & 1) << 3)
                width = bits // 8 if bits in (16, 64) else 4
                immediate = int.from_bytes(reader.take(width), 'little')
                if bits == 16:
                    boundary = X86Boundary(
                        'register_immediate',
                        (start + reader.at, register, bits, immediate))
                    break
                write(register, Operand('const', immediate), bits)
                instruction_count += 1
                continue
            if opcode == 0x8c:
                segment, target, _group = self._modrm(reader, rex)
                if segment > 5:
                    boundary = X86Boundary(
                        'unsupported', (opcode, instruction_start))
                else:
                    target_bits = (16 if (operand_override or isinstance(
                        target, MemoryOperand))
                                   else (64 if rex & 8 else 32))
                    boundary = X86Boundary(
                        'read_segment',
                        (start + reader.at, segment, target, target_bits))
                break
            if opcode == 0x8e:
                segment, source, _group = self._modrm(reader, rex)
                if segment > 5 or segment == 1:
                    boundary = X86Boundary(
                        'unsupported', (opcode, instruction_start))
                else:
                    boundary = X86Boundary(
                        'segment', (start + reader.at, segment, source))
                break
            if opcode == 0x8f:
                _register, operand, group = self._modrm(reader, rex)
                if group != 0:
                    boundary = X86Boundary(
                        'unsupported', (opcode, instruction_start))
                else:
                    pop_bits = 16 if operand_override else 64
                    boundary = X86Boundary(
                        'pop_operand',
                        (start + reader.at, operand, pop_bits))
                break
            if opcode == 0x98:
                target_bits = 16 if operand_override else (64 if rex & 8
                                                           else 32)
                boundary = X86Boundary(
                    'accumulator_sign_extend',
                    (start + reader.at, target_bits // 2, target_bits))
                break
            if opcode == 0x99:
                target_bits = 16 if operand_override else (64 if rex & 8
                                                           else 32)
                boundary = X86Boundary(
                    'accumulator_high_sign_extend',
                    (start + reader.at, target_bits))
                break
            if opcode == 0xdb:
                extension = reader.byte()
                if extension == 0xe3:
                    boundary = X86Boundary(
                        'fpu_init', start + reader.at)
                else:
                    boundary = X86Boundary(
                        'unsupported', (opcode, instruction_start))
                break
            if opcode == 0x8d:
                register, operand, _group = self._modrm(reader, rex)
                if not isinstance(operand, MemoryOperand):
                    boundary = X86Boundary(
                        'unsupported', (opcode, instruction_start))
                else:
                    boundary = X86Boundary(
                        'lea', (start + reader.at, register, bits, operand))
                break
            if opcode == 0x63:
                register, operand, _group = self._modrm(reader, rex)
                boundary = X86Boundary(
                    'move_sign_extend',
                    (start + reader.at, register, 32,
                     64 if rex & 8 else 32, operand))
                break
            if opcode in (0x69, 0x6b):
                register, operand, _group = self._modrm(reader, rex)
                immediate_width = (1 if opcode == 0x6b else
                                   (2 if bits == 16 else 4))
                immediate = int.from_bytes(
                    reader.take(immediate_width), 'little', signed=True)
                following = start + reader.at
                if isinstance(operand, MemoryOperand):
                    boundary = X86Boundary(
                        'multiply_immediate',
                        (following, register, operand, bits, immediate))
                else:
                    source = locals_[operand]
                    result = emit(
                        'i%d.mul' % bits,
                        (source, Operand(
                            'const', immediate & ((1 << bits) - 1))))
                    write(register, result, bits)
                    scratch = (source,)
                    instruction_count += 1
                    boundary = X86Boundary(
                        'register_immediate_multiply_flags',
                        (following, register, bits, immediate))
                break
            if opcode in (0x88, 0x89, 0x8a, 0x8b):
                access_bits = 8 if opcode in (0x88, 0x8a) else bits
                reg, rm, _group = self._modrm(reader, rex)
                if access_bits == 8:
                    reg = _byte_register(reg, rex)
                    if isinstance(rm, int):
                        rm = _byte_register(rm, rex)
                if isinstance(rm, MemoryOperand):
                    following = start + reader.at
                    if opcode in (0x8a, 0x8b):
                        boundary = X86Boundary(
                            'load', (following, reg, access_bits, rm))
                    else:
                        boundary = X86Boundary(
                            'store', (following, reg, access_bits, rm))
                    break
                destination, source = ((rm, reg) if opcode in (0x88, 0x89)
                                       else (reg, rm))
                if access_bits not in (32, 64):
                    boundary = X86Boundary(
                        'register_move',
                        (start + reader.at, destination, source, access_bits))
                    break
                value = locals_[source]
                if access_bits == 32:
                    value = emit('i64.and',
                                 (value, Operand('const', MASK32)))
                write(destination, value, access_bits)
                instruction_count += 1
                continue
            if opcode in (0x86, 0x87):
                exchange_bits = 8 if opcode == 0x86 else bits
                register, operand, _group = self._modrm(reader, rex)
                if exchange_bits == 8:
                    register = _byte_register(register, rex)
                    if isinstance(operand, int):
                        operand = _byte_register(operand, rex)
                if (isinstance(operand, MemoryOperand)
                        or exchange_bits not in (32, 64)):
                    boundary = X86Boundary(
                        'exchange', (start + reader.at, register,
                                     operand, exchange_bits))
                    break
                left, right = locals_[register], locals_[operand]
                if exchange_bits == 32:
                    left = emit('i64.and',
                                (left, Operand('const', MASK32)))
                    right = emit('i64.and',
                                 (right, Operand('const', MASK32)))
                write(register, right, exchange_bits)
                write(operand, left, exchange_bits)
                instruction_count += 1
                continue
            binary = {
                0x00: ('add', False), 0x02: ('add', True),
                0x01: ('add', False), 0x03: ('add', True),
                0x10: ('adc', False), 0x12: ('adc', True),
                0x11: ('adc', False), 0x13: ('adc', True),
                0x18: ('sbb', False), 0x1a: ('sbb', True),
                0x19: ('sbb', False), 0x1b: ('sbb', True),
                0x28: ('sub', False), 0x2a: ('sub', True),
                0x29: ('sub', False), 0x2b: ('sub', True),
                0x20: ('and', False), 0x22: ('and', True),
                0x21: ('and', False), 0x23: ('and', True),
                0x08: ('or', False), 0x0a: ('or', True),
                0x09: ('or', False), 0x0b: ('or', True),
                0x30: ('xor', False), 0x32: ('xor', True),
                0x31: ('xor', False), 0x33: ('xor', True),
            }
            if opcode in binary:
                name, reverse = binary[opcode]
                operation_bits = 8 if not opcode & 1 else bits
                reg, rm, _group = self._modrm(reader, rex)
                if operation_bits == 8:
                    reg = _byte_register(reg, rex)
                    if isinstance(rm, int):
                        rm = _byte_register(rm, rex)
                if isinstance(rm, MemoryOperand):
                    boundary = X86Boundary(
                        'memory_binary',
                        (start + reader.at, name, reverse, reg,
                         operation_bits, rm))
                    break
                destination, source = ((reg, rm) if reverse else (rm, reg))
                if operation_bits in (8, 16) or name in ('adc', 'sbb'):
                    boundary = X86Boundary(
                        'register_binary',
                        (start + reader.at, name, destination, source,
                         operation_bits))
                    break
                left = locals_[destination]
                right = locals_[source]
                result = emit('i%d.%s' % (operation_bits, name),
                              (left, right))
                write(destination, result, operation_bits)
                scratch = (left, right)
                instruction_count += 1
                boundary = X86Boundary(
                    'register_result_flags',
                    (start + reader.at, name, destination, source,
                     operation_bits))
                break
            if opcode in (0x80, 0x81, 0x83):
                reg, rm, group = self._modrm(reader, rex)
                del reg
                name = {0: 'add', 1: 'or', 2: 'adc', 3: 'sbb', 4: 'and',
                        5: 'sub', 6: 'xor', 7: 'cmp'}.get(group)
                if name is None:
                    raise X86Error('x86 immediate group %d is not modelled'
                                   % group)
                immediate_bits = 8 if opcode == 0x80 else bits
                if immediate_bits == 8 and isinstance(rm, int):
                    rm = _byte_register(rm, rex)
                width = (1 if opcode in (0x80, 0x83)
                         else (2 if bits == 16 else 4))
                immediate = int.from_bytes(reader.take(width), 'little',
                                           signed=True)
                following = start + reader.at
                if (isinstance(rm, MemoryOperand)
                        or name in ('adc', 'sbb', 'cmp')):
                    boundary = X86Boundary(
                        'immediate_alu',
                        (following, name, rm, immediate_bits, immediate))
                    break
                if immediate_bits in (8, 16):
                    boundary = X86Boundary(
                        'register_immediate_alu',
                        (following, name, rm, immediate_bits, immediate))
                    break
                left = locals_[rm]
                result = emit('i%d.%s' % (immediate_bits, name), (
                    left,
                    Operand('const', immediate
                            & ((1 << immediate_bits) - 1))))
                write(rm, result, immediate_bits)
                scratch = (left,)
                instruction_count += 1
                boundary = X86Boundary(
                    'register_immediate_result_flags',
                    (following, name, rm, immediate_bits, immediate))
                break
            if opcode in (0x38, 0x39, 0x3a, 0x3b, 0x84, 0x85):
                reg, rm, _group = self._modrm(reader, rex)
                compare_bits = 8 if not opcode & 1 else bits
                if compare_bits == 8:
                    reg = _byte_register(reg, rex)
                    if isinstance(rm, int):
                        rm = _byte_register(rm, rex)
                boundary = X86Boundary(
                    'compare', (start + reader.at, opcode, reg, rm,
                                compare_bits))
                break
            if opcode in (0x04, 0x05, 0x0c, 0x0d, 0x14, 0x15,
                          0x1c, 0x1d, 0x24, 0x25, 0x2c, 0x2d,
                          0x34, 0x35, 0x3c, 0x3d):
                accumulator_bits = 8 if not opcode & 1 else bits
                immediate_width = (1 if accumulator_bits == 8 else
                                   (2 if accumulator_bits == 16 else 4))
                immediate = int.from_bytes(
                    reader.take(immediate_width), 'little',
                    signed=accumulator_bits == 64)
                name = {0x04: 'add', 0x05: 'add',
                        0x0c: 'or', 0x0d: 'or',
                        0x14: 'adc', 0x15: 'adc',
                        0x1c: 'sbb', 0x1d: 'sbb',
                        0x24: 'and', 0x25: 'and',
                        0x2c: 'sub', 0x2d: 'sub',
                        0x34: 'xor', 0x35: 'xor',
                        0x3c: 'cmp', 0x3d: 'cmp'}[opcode]
                boundary = X86Boundary(
                    'immediate_alu',
                    (start + reader.at, name,
                     REGISTER_INDEX['rax'], accumulator_bits, immediate))
                break
            if opcode in (0xa8, 0xa9):
                test_bits = 8 if opcode == 0xa8 else bits
                width = 1 if opcode == 0xa8 else (2 if bits == 16 else 4)
                immediate = int.from_bytes(reader.take(width), 'little')
                boundary = X86Boundary(
                    'accumulator_test',
                    (start + reader.at, test_bits, immediate))
                break
            if opcode in (0xc6, 0xc7):
                _reg, rm, group = self._modrm(reader, rex)
                move_bits = 8 if opcode == 0xc6 else bits
                if move_bits == 8 and isinstance(rm, int):
                    rm = _byte_register(rm, rex)
                immediate_width = (1 if opcode == 0xc6
                                   else (2 if bits == 16 else 4))
                immediate = int.from_bytes(reader.take(immediate_width), 'little',
                                           signed=move_bits == 64)
                if group != 0:
                    raise X86Error('x86 move immediate group is invalid')
                if isinstance(rm, MemoryOperand):
                    boundary = X86Boundary(
                        'store_immediate',
                        (start + reader.at, rm, move_bits, immediate))
                    break
                if move_bits == 8:
                    boundary = X86Boundary(
                        'register_immediate',
                        (start + reader.at, rm, move_bits, immediate))
                    break
                write(rm, Operand('const', immediate), move_bits)
                instruction_count += 1
                continue
            if opcode in (0xf6, 0xf7):
                _reg, rm, group = self._modrm(reader, rex)
                unary_bits = 8 if opcode == 0xf6 else bits
                if unary_bits == 8 and isinstance(rm, int):
                    rm = _byte_register(rm, rex)
                following = start + reader.at
                if group == 0:
                    width = 1 if opcode == 0xf6 \
                        else (2 if bits == 16 else 4)
                    immediate = int.from_bytes(reader.take(width), 'little')
                    boundary = X86Boundary(
                        'operand_test',
                        (start + reader.at, rm, unary_bits, immediate))
                    break
                if (group == 2 and unary_bits in (32, 64)
                        and not isinstance(rm, MemoryOperand)):
                    result = emit('i%d.xor' % unary_bits, (
                        locals_[rm],
                        Operand('const', (1 << unary_bits) - 1)))
                    write(rm, result, unary_bits)
                    instruction_count += 1
                    continue
                boundary = X86Boundary(
                    'unary', (following, group, rm, unary_bits,
                              start + instruction_start))
                break
            if opcode in (0xfe, 0xff):
                _reg, rm, group = self._modrm(reader, rex)
                group_bits = (8 if opcode == 0xfe else
                              (64 if group in (2, 4, 6)
                              and not operand_override else bits)
                              )
                if opcode == 0xfe and isinstance(rm, int):
                    rm = _byte_register(rm, rex)
                boundary = X86Boundary(
                    'group_ff',
                    (start + reader.at, group, rm, group_bits))
                break
            if opcode in (0xc0, 0xc1):
                _reg, rm, group = self._modrm(reader, rex)
                name = {0: 'rotl', 1: 'rotr',
                        4: 'shl', 5: 'shr_u', 7: 'shr_s'}.get(group)
                if name is None:
                    raise X86Error('x86 shift group %d is not modelled'
                                   % group)
                shift_bits = 8 if opcode == 0xc0 else bits
                if shift_bits == 8 and isinstance(rm, int):
                    rm = _byte_register(rm, rex)
                amount = reader.byte() % shift_bits
                if (shift_bits in (8, 16)
                        or isinstance(rm, MemoryOperand)):
                    boundary = X86Boundary(
                        'shift',
                        (start + reader.at, group, rm,
                         shift_bits, amount))
                    break
                value = locals_[rm]
                result = emit('i%d.%s' % (shift_bits, name), (
                    value, Operand('const', amount)))
                write(rm, result, shift_bits)
                scratch = (value,)
                instruction_count += 1
                boundary = X86Boundary(
                    'shift_result_flags',
                    (start + reader.at, group, rm, shift_bits, amount))
                break
            if opcode in (0xd0, 0xd1, 0xd2, 0xd3):
                _reg, rm, group = self._modrm(reader, rex)
                if group not in (0, 1, 4, 5, 7):
                    raise X86Error('x86 variable shift group %d is not modelled'
                                   % group)
                shift_bits = 8 if opcode in (0xd0, 0xd2) else bits
                if shift_bits == 8 and isinstance(rm, int):
                    rm = _byte_register(rm, rex)
                boundary = X86Boundary(
                    'shift',
                    (start + reader.at, group, rm, shift_bits,
                     1 if opcode in (0xd0, 0xd1) else None))
                break

            next_rip = start + reader.at
            if opcode == 0xc3:
                boundary = X86Boundary('return', next_rip)
            elif opcode == 0xcf:
                boundary = X86Boundary('interrupt_return', next_rip)
            elif opcode == 0xcb:
                boundary = X86Boundary('far_return', next_rip)
            elif opcode == 0xe8:
                relative = int.from_bytes(reader.take(4), 'little',
                                          signed=True)
                next_rip = start + reader.at
                boundary = X86Boundary('call', (next_rip,
                                                next_rip + relative))
            elif opcode in (0xe9, 0xeb):
                width = 4 if opcode == 0xe9 else 1
                relative = int.from_bytes(reader.take(width), 'little',
                                          signed=True)
                next_rip = start + reader.at
                boundary = X86Boundary('branch', next_rip + relative)
            elif 0x70 <= opcode <= 0x7f:
                relative = int.from_bytes(reader.take(1), 'little',
                                          signed=True)
                next_rip = start + reader.at
                boundary = X86Boundary(
                    'conditional_branch',
                    (next_rip, next_rip + relative, opcode & 15))
            elif opcode == 0xf4:
                boundary = X86Boundary('halt', next_rip)
            elif opcode in (0xe4, 0xe5):
                port = reader.byte()
                next_rip = start + reader.at
                width = 1 if opcode == 0xe4 else 4
                boundary = X86Boundary(
                    'port_read', (next_rip, port, width))
            elif opcode in (0xec, 0xed):
                width = 1 if opcode == 0xec else 4
                boundary = X86Boundary(
                    'port_read_dx', (next_rip, width))
            elif opcode in (0xe6, 0xe7):
                port = reader.byte()
                next_rip = start + reader.at
                width = 1 if opcode == 0xe6 else 4
                boundary = X86Boundary('port_write',
                                       (next_rip, port, width))
            elif opcode in (0xee, 0xef):
                width = 1 if opcode == 0xee else 4
                boundary = X86Boundary('port_write_dx',
                                       (next_rip, width))
            elif opcode == 0xcd:
                vector = reader.byte()
                boundary = X86Boundary(
                    'exception', (start + reader.at, vector, None))
            elif opcode == 0xcc:
                boundary = X86Boundary(
                    'exception', (next_rip, 3, None))
            elif opcode == 0x0f:
                second = reader.byte()
                next_rip = start + reader.at
                if second == 0x05:
                    boundary = X86Boundary('syscall', next_rip)
                elif second == 0x0b:
                    boundary = X86Boundary(
                        'exception',
                        (start + instruction_start, 6, None))
                elif second == 0x30:
                    boundary = X86Boundary('write_msr', next_rip)
                elif second == 0x31:
                    boundary = X86Boundary('clock', next_rip)
                elif second == 0x32:
                    boundary = X86Boundary('read_msr', next_rip)
                elif second == 0xa2:
                    boundary = X86Boundary('cpuid', next_rip)
                elif second == 0x00:
                    _reg, operand, group = self._modrm(reader, rex)
                    if group in (0, 1):
                        boundary = X86Boundary(
                            'store_system_segment',
                            (start + reader.at,
                             'ldtr' if group == 0 else 'tr', operand))
                    elif group in (2, 3):
                        boundary = X86Boundary(
                            'load_system_segment',
                            (start + reader.at,
                             'ldtr' if group == 2 else 'tr', operand))
                    else:
                        boundary = X86Boundary(
                            'unsupported',
                            (opcode, second, instruction_start))
                elif second == 0x01:
                    _reg, operand, group = self._modrm(reader, rex)
                    if group in (0, 1) and isinstance(operand, MemoryOperand):
                        boundary = X86Boundary(
                            'store_descriptor_table',
                            (start + reader.at,
                             'gdtr' if group == 0 else 'idtr', operand))
                    elif group in (2, 3) and isinstance(operand, MemoryOperand):
                        boundary = X86Boundary(
                            'load_descriptor_table',
                            (start + reader.at,
                             'gdtr' if group == 2 else 'idtr', operand))
                    elif group == 7 and isinstance(operand, MemoryOperand):
                        boundary = X86Boundary(
                            'invalidate_page',
                            (start + reader.at, operand))
                    elif group == 7 and operand == REGISTER_INDEX['rax']:
                        boundary = X86Boundary('swap_gs', start + reader.at)
                    else:
                        boundary = X86Boundary(
                            'unsupported',
                            (opcode, second, instruction_start))
                elif second in (0x20, 0x22):
                    control, register, _group = self._modrm(reader, rex)
                    if isinstance(register, MemoryOperand):
                        boundary = X86Boundary(
                            'unsupported',
                            (opcode, second, instruction_start))
                    else:
                        boundary = X86Boundary(
                            'control_register',
                            (start + reader.at, second, control, register))
                elif second in (0x21, 0x23):
                    debug, register, _group = self._modrm(reader, rex)
                    if isinstance(register, MemoryOperand) or debug >= 8:
                        boundary = X86Boundary(
                            'unsupported',
                            (opcode, second, instruction_start))
                    else:
                        boundary = X86Boundary(
                            'debug_register',
                            (start + reader.at, second, debug, register))
                elif second in (0xb0, 0xb1):
                    register, operand, _group = self._modrm(reader, rex)
                    exchange_bits = 8 if second == 0xb0 else bits
                    if exchange_bits == 8:
                        register = _byte_register(register, rex)
                        if isinstance(operand, int):
                            operand = _byte_register(operand, rex)
                    boundary = X86Boundary(
                        'compare_exchange',
                        (start + reader.at, register, operand,
                         exchange_bits, reader.locked))
                elif second in (0xc0, 0xc1):
                    register, operand, _group = self._modrm(reader, rex)
                    exchange_bits = 8 if second == 0xc0 else bits
                    if exchange_bits == 8:
                        register = _byte_register(register, rex)
                        if isinstance(operand, int):
                            operand = _byte_register(operand, rex)
                    boundary = X86Boundary(
                        'exchange_add',
                        (start + reader.at, register, operand,
                         exchange_bits, reader.locked))
                elif second == 0xc7:
                    _reg, operand, group = self._modrm(reader, rex)
                    if group not in (6, 7) or isinstance(
                            operand, MemoryOperand):
                        boundary = X86Boundary(
                            'unsupported',
                            (opcode, second, instruction_start))
                    else:
                        boundary = X86Boundary(
                            'random',
                            (start + reader.at, operand, bits,
                             int(group == 7)))
                elif second == 0xae:
                    _register, operand, group = self._modrm(reader, rex)
                    if group == 0 and isinstance(operand, MemoryOperand):
                        boundary = X86Boundary(
                            'save_fpu',
                            (start + reader.at, operand))
                    elif group in (5, 6, 7) and isinstance(operand, int):
                        boundary = X86Boundary(
                            'memory_fence', start + reader.at)
                    else:
                        boundary = X86Boundary(
                            'unsupported',
                            (opcode, second, instruction_start))
                elif 0xc8 <= second <= 0xcf:
                    register = (second - 0xc8) | ((rex & 1) << 3)
                    swap_bits = 64 if rex & 8 else 32
                    result = emit('i%d.bswap' % swap_bits,
                                  (locals_[register],))
                    write(register, result, swap_bits)
                    instruction_count += 1
                    continue
                elif second in (0xbc, 0xbd):
                    register, operand, _group = self._modrm(reader, rex)
                    boundary = X86Boundary(
                        'bit_scan',
                        (start + reader.at, register, operand, bits,
                         second == 0xbd))
                elif second in (0xb6, 0xb7):
                    register, operand, _group = self._modrm(reader, rex)
                    if second == 0xb6 and isinstance(operand, int):
                        operand = _byte_register(operand, rex)
                    boundary = X86Boundary(
                        'move_zero_extend',
                        (start + reader.at, register,
                         8 if second == 0xb6 else 16,
                         64 if rex & 8 else 32, operand))
                elif second in (0xbe, 0xbf):
                    register, operand, _group = self._modrm(reader, rex)
                    boundary = X86Boundary(
                        'move_sign_extend',
                        (start + reader.at, register,
                         8 if second == 0xbe else 16,
                         64 if rex & 8 else 32, operand))
                elif second == 0xaf:
                    register, operand, _group = self._modrm(reader, rex)
                    following = start + reader.at
                    if isinstance(operand, MemoryOperand):
                        boundary = X86Boundary(
                            'multiply',
                            (following, register, operand, bits))
                    else:
                        left = locals_[register]
                        right = locals_[operand]
                        result = emit(
                            'i%d.mul' % bits, (left, right))
                        write(register, result, bits)
                        scratch = (left, right)
                        instruction_count += 1
                        boundary = X86Boundary(
                            'register_multiply_flags',
                            (following, register, bits))
                elif second in (0xa4, 0xa5, 0xac, 0xad):
                    source, destination, _group = self._modrm(reader, rex)
                    immediate = (reader.byte()
                                 if second in (0xa4, 0xac) else None)
                    boundary = X86Boundary(
                        'double_shift',
                        (start + reader.at,
                         'left' if second in (0xa4, 0xa5) else 'right',
                         destination, source, bits, immediate))
                elif second in (0xa3, 0xab, 0xb3, 0xbb):
                    index, operand, _group = self._modrm(reader, rex)
                    group = {0xa3: 4, 0xab: 5,
                             0xb3: 6, 0xbb: 7}[second]
                    boundary = X86Boundary(
                        'bit_register',
                        (start + reader.at, group, operand, index, bits))
                elif second == 0xba:
                    _reg, operand, group = self._modrm(reader, rex)
                    immediate = reader.byte()
                    if group not in (4, 5, 6, 7):
                        boundary = X86Boundary(
                            'unsupported',
                            (opcode, second, group, instruction_start))
                    else:
                        boundary = X86Boundary(
                            'bit_immediate',
                            (start + reader.at, group, operand,
                             bits, immediate))
                elif 0x90 <= second <= 0x9f:
                    _reg, operand, _group = self._modrm(reader, rex)
                    high_byte = (not rex and isinstance(operand, int)
                                 and 4 <= operand <= 7)
                    boundary = X86Boundary(
                        'set_condition',
                        (start + reader.at, second & 15, operand,
                         high_byte))
                elif second == 0x1e and repeat:
                    marker = reader.byte()
                    if marker not in (0xfa, 0xfb):
                        boundary = X86Boundary(
                            'unsupported',
                            (opcode, second, marker, instruction_start))
                    else:
                        instruction_count += 1
                        continue
                elif second == 0x1f:
                    _reg, _operand, group = self._modrm(reader, rex)
                    if group != 0:
                        boundary = X86Boundary(
                            'unsupported',
                            (opcode, second, instruction_start))
                    else:
                        instruction_count += 1
                        continue
                elif second == 0x18:
                    _reg, operand, _group = self._modrm(reader, rex)
                    if not isinstance(operand, MemoryOperand):
                        boundary = X86Boundary(
                            'unsupported',
                            (opcode, second, instruction_start))
                    else:
                        instruction_count += 1
                        continue
                elif 0x80 <= second <= 0x8f:
                    relative = int.from_bytes(reader.take(4), 'little',
                                              signed=True)
                    next_rip = start + reader.at
                    boundary = X86Boundary(
                        'conditional_branch',
                        (next_rip, next_rip + relative, second & 15))
                elif 0x40 <= second <= 0x4f:
                    register, operand, _group = self._modrm(reader, rex)
                    boundary = X86Boundary(
                        'conditional_move',
                        (start + reader.at, second & 15,
                         register, operand, bits))
                else:
                    boundary = X86Boundary(
                        'unsupported', (opcode, second, instruction_start))
            elif 0x50 <= opcode <= 0x57:
                register = (opcode - 0x50) | ((rex & 1) << 3)
                boundary = X86Boundary(
                    'push', (next_rip, register))
            elif 0x58 <= opcode <= 0x5f:
                register = (opcode - 0x58) | ((rex & 1) << 3)
                boundary = X86Boundary(
                    'pop', (next_rip, register))
            elif opcode == 0x6a:
                immediate = int.from_bytes(reader.take(1), 'little',
                                           signed=True)
                boundary = X86Boundary(
                    'push_immediate', (start + reader.at, immediate))
            elif opcode == 0x68:
                immediate = int.from_bytes(reader.take(4), 'little',
                                           signed=True)
                boundary = X86Boundary(
                    'push_immediate', (start + reader.at, immediate))
            elif opcode == 0x9d:
                boundary = X86Boundary('pop_flags', next_rip)
            elif opcode == 0x9c:
                boundary = X86Boundary('push_flags', next_rip)
            elif opcode == 0xc9:
                boundary = X86Boundary(
                    'leave', (next_rip, 16 if operand_override else 64))
            elif opcode in (0xa4, 0xa5) and repeat:
                boundary = X86Boundary(
                    'repeat_move',
                    (next_rip, 1 if opcode == 0xa4
                     else (8 if rex & 8 else 4)))
            elif opcode in (0xaa, 0xab) and repeat:
                boundary = X86Boundary(
                    'repeat_store',
                    (next_rip, 1 if opcode == 0xaa
                     else (8 if rex & 8 else (2 if operand_override else 4))))
            else:
                boundary = X86Boundary(
                    'unsupported', (opcode, instruction_start))
            break

        if boundary is None:
            boundary = X86Boundary('unsupported', ('block_limit', reader.at))
        boundary_rip = start + instruction_start
        raw_depths = [0]
        for node in nodes:
            raw_depths.append(1 + max(
                (raw_depths[operand.value]
                 for operand in node.arguments if operand.kind == 'node'),
                default=0))
        raw_work = len(nodes)
        raw_span = max(raw_depths, default=0)
        plan = normalize_plan(PureSlice(
            0, 0, instruction_count, instruction_count, 0,
            tuple(nodes), DependencyWaves((0,), (), (0,)),
            (), tuple(locals_) + scratch))
        packed = pack_step(plan)
        mapped = unpack_step(packed)
        execute = self._bind_state_page(mapped, packed)
        source = bytes(code[:reader.at])
        proof_config, proof = _execution_proof(state, start, len(source))
        block = DecodedBlock(
            start, boundary_rip, source, instruction_count,
            plan, mapped, execute, len(scratch), boundary,
            proof_config, proof)
        self._remember_block(block)
        self.decoded_blocks += 1
        self.source_instructions += instruction_count
        self.frontend_raw_work += raw_work
        self.frontend_raw_span += raw_span
        self.frontend_boundary_only_slices += int(not instruction_count)
        self._frontend_boundaries[boundary.operation] = \
            self._frontend_boundaries.get(boundary.operation, 0) + 1
        self.physical_work += physical_work(plan)
        self.physical_span += plan.waves.span
        return block

    def block(self, state):
        block = self.blocks.get(state.rip)
        if block is not None:
            if self._proof_is_cached(state, block):
                self.block_proof_hits += 1
                self.block_proof_fast_hits += 1
                return block
            mismatch = _proof_mismatch(
                state, block.proof_config, block.proof)
            if mismatch is None:
                self.block_proof_hits += 1
                self._cache_block_proof(state, block)
                return block
            self.block_proof_misses += 1
            if mismatch == 'unavailable':
                self.block_proof_unavailable += 1
            elif mismatch == 'config':
                self.block_proof_config_misses += 1
            elif mismatch == 'dirty':
                self.block_proof_dirty_misses += 1
            else:
                self.block_proof_version_misses += 1
            try:
                if read_virtual(
                        state, state.rip, len(block.source),
                        'execute') == block.source:
                    config, proof = _execution_proof(
                        state, state.rip, len(block.source))
                    block = replace(
                        block, proof_config=config, proof=proof)
                    self._remember_block(block)
                    self._cache_block_proof(state, block)
                    return block
            except PageFault:
                pass
            self._discard_block(state.rip)
        block = self._decode(state)
        self._cache_block_proof(state, block)
        return block

    @staticmethod
    def _carry_flags_plan(plan):
        """Add RFLAGS as one physical frame coordinate beside the GPRs."""
        if len(plan.locals) < len(REGISTER_NAMES):
            return None
        if any(operand.kind == 'local'
               and operand.value >= len(REGISTER_NAMES)
               for node in plan.nodes for operand in node.arguments):
            return None
        registers = plan.locals[:len(REGISTER_NAMES)]
        scratch = plan.locals[len(REGISTER_NAMES):]
        return PureSlice(
            plan.function, plan.start, plan.end, plan.instructions,
            plan.stack_inputs, plan.nodes, plan.waves, plan.stack,
            tuple(registers) + (Operand('local', len(REGISTER_NAMES)),)
            + tuple(scratch))

    @staticmethod
    def _lower_flag_boundary(plan, boundary):
        """Append one register/flags instruction to an open physical cut."""
        operation, detail = boundary.operation, boundary.detail
        supported = {
            'accumulator_test', 'compare', 'flag_control', 'group_ff',
            'immediate_alu', 'operand_test', 'register_binary',
            'register_immediate_alu', 'register_immediate_result_flags',
            'register_result_flags', 'set_condition', 'memory_binary',
            'conditional_move', 'shift', 'shift_result_flags',
            'bit_immediate', 'bit_register', 'bit_scan',
            'compare_exchange', 'register_immediate_multiply_flags',
            'register_multiply_flags', 'multiply_immediate', 'unary',
        }
        if operation not in supported or len(plan.locals) < 17:
            return None
        nodes = list(plan.nodes)
        common = {(node.op, node.arguments): Operand('node', node.value)
                  for node in nodes}
        last_memory = next((Operand('node', node.value)
                            for node in reversed(nodes)
                            if node.op.startswith('memory.')), None)
        registers = list(plan.locals[:len(REGISTER_NAMES)])
        prior_flags = plan.locals[len(REGISTER_NAMES)]
        scratch = plan.locals[len(REGISTER_NAMES) + 1:]

        def emit(name, arguments):
            nonlocal last_memory
            arguments = tuple(arguments)
            if name.startswith(('i32.', 'i64.')):
                name, arguments = select_lane(name, arguments)
            memory = name.startswith('memory.')
            if memory and last_memory is not None \
                    and last_memory not in arguments:
                arguments += (last_memory,)
            key = name, arguments
            present = None if memory else common.get(key)
            if present is not None:
                return present
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, name, arguments))
            if memory:
                last_memory = result
            else:
                common[key] = result
            return result

        def read(operand, bits):
            if isinstance(operand, MemoryOperand):
                return None
            if isinstance(operand, HighByteRegister):
                value = emit('i64.shr_u', (
                    registers[operand.index], Operand('const', 8)))
            elif isinstance(operand, int):
                value = registers[operand]
            else:
                return None
            if bits < 64:
                value = emit('i64.and', (
                    value, Operand('const', (1 << bits) - 1)))
            return value

        def memory_address(operand, following):
            if (not isinstance(operand, MemoryOperand)
                    or operand.segment_msr is not None):
                return None
            pointer = Operand(
                'const', (int(operand.displacement)
                          + (int(following)
                             if operand.rip_relative else 0)) & MASK64)
            if not operand.rip_relative and operand.base is not None:
                pointer = emit('i64.add', (
                    pointer, registers[operand.base]))
            if operand.index is not None:
                index = registers[operand.index]
                if operand.scale != 1:
                    index = emit('i64.shl', (
                        index, Operand(
                            'const', operand.scale.bit_length() - 1)))
                pointer = emit('i64.add', (pointer, index))
            return pointer

        def memory_load(pointer, bits):
            width = bits // 8
            load = ('memory.i64.load' if width == 8 else
                    'memory.i64.load%d_u' % bits)
            return emit(load, (
                pointer, Operand('const', 0),
                Operand('const', memory_shape(
                    width, virtual64=True))))

        def memory_value(operand, bits, following):
            pointer = memory_address(operand, following)
            if pointer is None:
                return None, None
            value = memory_load(pointer, bits)
            return pointer, value

        def memory_store(pointer, value, bits):
            store = ('memory.i64.store' if bits == 64 else
                     'memory.i64.store%d' % bits)
            emit(store, (
                pointer, value, Operand('const', 0),
                Operand('const', memory_shape(
                    bits // 8, virtual64=True))))

        def publish(operand, value, bits):
            if isinstance(operand, MemoryOperand):
                return False
            high = isinstance(operand, HighByteRegister)
            index = operand.index if high else operand
            if not isinstance(index, int):
                return False
            if bits == 64:
                registers[index] = value
                return True
            if bits == 32:
                registers[index] = emit('i64.and', (
                    value, Operand('const', MASK32)))
                return True
            shift = 8 if high else 0
            registers[index] = emit('lane64.INSERT', (
                registers[index], value,
                Operand('const', int(bits) | (shift << 8))))
            return True

        def result_flags(name, left, right, result, bits,
                         carry_in=None, preserve_carry=False):
            del carry_in
            mode = {
                'and': 0, 'or': 0, 'xor': 0,
                'add': 1, 'adc': 2,
                'sub': 3, 'cmp': 3, 'sbb': 4,
            }[name]
            descriptor = (int(bits) | (mode << 8)
                          | (int(bool(preserve_carry)) << 11))
            return emit('lane64.X86_FLAGS', (
                prior_flags, left, right, result,
                Operand('const', descriptor)))

        def multiply_flags(left, right, low, bits):
            descriptor = int(bits) | (1 << 8)
            high = emit('lane64.MUL_HIGH', (
                left, right, Operand('const', descriptor)))
            return emit('lane64.X86_MUL_FLAGS', (
                prior_flags, low, high, Operand('const', descriptor)))

        def condition(code):
            return emit('lane64.X86_CONDITION', (
                prior_flags, Operand('const', int(code) & 15)))

        following = detail[0] if isinstance(detail, tuple) else detail
        flags = prior_flags
        if operation == 'register_result_flags':
            _following, name, destination, _source, bits = detail
            if len(scratch) < 2:
                return None
            left, right = scratch[:2]
            result = read(destination, bits)
            flags = result_flags(name, left, right, result, bits)
        elif operation == 'shift_result_flags':
            _following, group, register, bits, amount = detail
            amount = int(amount) & (int(bits) - 1)
            if not scratch:
                return None
            source = scratch[0]
            result = read(register, bits)
            if result is None or group not in (0, 1, 4, 5, 7):
                return None
            flags = emit('lane64.X86_SHIFT_FLAGS', (
                prior_flags, source, result, Operand('const', amount),
                Operand('const', int(bits) | (int(group) << 8))))
        elif operation == 'register_immediate_result_flags':
            _following, name, register, bits, immediate = detail
            if not scratch:
                return None
            left = scratch[0]
            right = Operand('const', immediate & ((1 << bits) - 1))
            result = read(register, bits)
            flags = result_flags(name, left, right, result, bits)
        elif operation == 'multiply_immediate':
            (_following, register, operand, bits, immediate) = detail
            if not isinstance(register, int):
                return None
            left = memory_value(operand, bits, following)[1]
            if left is None:
                return None
            right = Operand('const', immediate & ((1 << bits) - 1))
            result = emit('i64.mul', (left, right))
            if not publish(register, result, bits):
                return None
            flags = multiply_flags(left, right, result, bits)
        elif operation in ('register_immediate_multiply_flags',
                            'register_multiply_flags'):
            if not scratch:
                return None
            if operation == 'register_immediate_multiply_flags':
                (_following, _register, bits, immediate) = detail
                right = Operand('const', immediate & ((1 << bits) - 1))
            else:
                _following, _register, bits = detail
                if len(scratch) < 2:
                    return None
                right = scratch[1]
            left = scratch[0]
            result = read(_register, bits)
            if result is None:
                return None
            flags = multiply_flags(left, right, result, bits)
        elif operation == 'compare_exchange':
            following, source, operand, bits, _locked = detail
            accumulator = read(REGISTER_INDEX['rax'], bits)
            source_value = read(source, bits)
            pointer = None
            if isinstance(operand, MemoryOperand):
                pointer, destination = memory_value(
                    operand, bits, following)
            else:
                destination = read(operand, bits)
            if (accumulator is None or source_value is None
                    or destination is None):
                return None
            equal = emit('i64.eq', (accumulator, destination))
            difference = emit('i64.sub', (
                accumulator, destination))
            difference = emit('i64.and', (
                difference, Operand('const', (1 << bits) - 1)))
            flags = result_flags(
                'cmp', accumulator, destination, difference, bits)
            next_accumulator = emit('lane64.SELECT', (
                accumulator, destination, equal))
            if not publish(
                    REGISTER_INDEX['rax'], next_accumulator, bits):
                return None
            next_destination = emit('lane64.SELECT', (
                source_value, destination, equal))
            if pointer is not None:
                memory_store(pointer, next_destination, bits)
            elif not publish(operand, next_destination, bits):
                return None
        elif operation == 'bit_scan':
            following, destination, operand, bits, reverse = detail
            if isinstance(operand, MemoryOperand):
                value = memory_value(operand, bits, following)[1]
            else:
                value = read(operand, bits)
            if value is None or not isinstance(destination, int):
                return None
            current = registers[destination]
            if reverse:
                result = emit('i64.clz', (value,))
                result = emit('i64.sub', (
                    Operand('const', 63), result))
            else:
                result = emit('i64.ctz', (value,))
            if not publish(destination, result, bits):
                return None
            registers[destination] = emit('lane64.SELECT', (
                registers[destination], current, value))
            zero = emit('i64.eqz', (value,))
            flags = emit('i64.and', (
                prior_flags, Operand('const', MASK64 ^ RFLAGS_ZERO)))
            zero = emit('i64.shl', (
                zero, Operand('const', RFLAGS_ZERO.bit_length() - 1)))
            flags = emit('i64.or', (flags, zero))
            flags = emit('i64.or', (flags, Operand('const', 2)))
        elif operation == 'unary':
            following, group, operand, bits, _instruction = detail
            if group not in (2, 3, 4, 5):
                return None
            pointer = None
            if isinstance(operand, MemoryOperand):
                pointer, value = memory_value(operand, bits, following)
            else:
                value = read(operand, bits)
            if value is None:
                return None
            if group in (4, 5):
                accumulator = read(REGISTER_INDEX['rax'], bits)
                if accumulator is None:
                    return None
                descriptor = int(bits) | (int(group == 5) << 8)
                product = emit('i64.mul', (accumulator, value))
                high = emit('lane64.MUL_HIGH', (
                    accumulator, value, Operand('const', descriptor)))
                flags = emit('lane64.X86_MUL_FLAGS', (
                    prior_flags, product, high,
                    Operand('const', descriptor)))
                if bits == 8:
                    registers[REGISTER_INDEX['rax']] = emit(
                        'lane64.INSERT', (
                            registers[REGISTER_INDEX['rax']], product,
                            Operand('const', 16)))
                else:
                    if not publish(REGISTER_INDEX['rax'], product, bits):
                        return None
                    if not publish(REGISTER_INDEX['rdx'], high, bits):
                        return None
            elif group == 2:
                result = emit('i64.xor', (
                    value, Operand('const', (1 << bits) - 1)))
            else:
                result = emit('i64.sub', (Operand('const', 0), value))
                result = emit('i64.and', (
                    result, Operand('const', (1 << bits) - 1)))
                flags = result_flags(
                    'sub', Operand('const', 0), value, result, bits)
            if group in (2, 3):
                if pointer is not None:
                    memory_store(pointer, result, bits)
                elif not publish(operand, result, bits):
                    return None
        elif operation in ('register_binary', 'register_immediate_alu'):
            if operation == 'register_binary':
                _following, name, destination, source, bits = detail
                right = read(source, bits)
            else:
                _following, name, destination, bits, immediate = detail
                right = Operand('const', immediate & ((1 << bits) - 1))
            left = read(destination, bits)
            if left is None or right is None:
                return None
            carry_in = condition(2) \
                if name in ('adc', 'sbb') else None
            if name in ('add', 'adc'):
                result = emit('i64.add', (left, right))
                if carry_in is not None:
                    result = emit('i64.add', (result, carry_in))
            elif name in ('sub', 'sbb'):
                result = emit('i64.sub', (left, right))
                if carry_in is not None:
                    result = emit('i64.sub', (result, carry_in))
            else:
                result = emit('i64.' + name, (left, right))
            result = emit('i64.and', (
                result, Operand('const', (1 << bits) - 1)))
            if not publish(destination, result, bits):
                return None
            flags = result_flags(
                name, left, right, result, bits, carry_in)
        elif operation == 'immediate_alu':
            _following, name, operand, bits, immediate = detail
            pointer = None
            if isinstance(operand, MemoryOperand):
                pointer, left = memory_value(operand, bits, following)
            else:
                left = read(operand, bits)
            if left is None:
                return None
            right = Operand('const', immediate & ((1 << bits) - 1))
            carry_in = condition(2) \
                if name in ('adc', 'sbb') else None
            if name in ('add', 'adc'):
                result = emit('i64.add', (left, right))
                if carry_in is not None:
                    result = emit('i64.add', (result, carry_in))
            elif name in ('sub', 'cmp', 'sbb'):
                result = emit('i64.sub', (left, right))
                if carry_in is not None:
                    result = emit('i64.sub', (result, carry_in))
            else:
                result = emit('i64.' + name, (left, right))
            result = emit('i64.and', (
                result, Operand('const', (1 << bits) - 1)))
            if name != 'cmp':
                if pointer is not None:
                    memory_store(pointer, result, bits)
                elif not publish(operand, result, bits):
                    return None
            flags = result_flags(
                name, left, right, result, bits, carry_in)
        elif operation == 'compare':
            _following, opcode, register, operand, bits = detail
            register_value = (memory_value(register, bits, following)[1]
                              if isinstance(register, MemoryOperand)
                              else read(register, bits))
            operand_value = (memory_value(operand, bits, following)[1]
                             if isinstance(operand, MemoryOperand)
                             else read(operand, bits))
            if register_value is None or operand_value is None:
                return None
            if opcode in (0x38, 0x39):
                left, right, name = operand_value, register_value, 'cmp'
                result = emit('i64.sub', (left, right))
            elif opcode in (0x3a, 0x3b):
                left, right, name = register_value, operand_value, 'cmp'
                result = emit('i64.sub', (left, right))
            else:
                left, right, name = register_value, operand_value, 'and'
                result = emit('i64.and', (left, right))
            flags = result_flags(name, left, right, result, bits)
        elif operation == 'memory_binary':
            (following, name, reverse, register,
             bits, operand) = detail
            pointer, loaded = memory_value(operand, bits, following)
            register_value = read(register, bits)
            if pointer is None or register_value is None:
                return None
            left, right = ((register_value, loaded) if reverse
                           else (loaded, register_value))
            carry_in = condition(2) \
                if name in ('adc', 'sbb') else None
            if name in ('add', 'adc'):
                result = emit('i64.add', (left, right))
                if carry_in is not None:
                    result = emit('i64.add', (result, carry_in))
            elif name in ('sub', 'sbb'):
                result = emit('i64.sub', (left, right))
                if carry_in is not None:
                    result = emit('i64.sub', (result, carry_in))
            else:
                result = emit('i64.' + name, (left, right))
            result = emit('i64.and', (
                result, Operand('const', (1 << bits) - 1)))
            if reverse:
                if not publish(register, result, bits):
                    return None
            else:
                store = ('memory.i64.store' if bits == 64 else
                         'memory.i64.store%d' % bits)
                emit(store, (
                    pointer, result, Operand('const', 0),
                    Operand('const', memory_shape(
                        bits // 8, virtual64=True))))
            flags = result_flags(
                name, left, right, result, bits, carry_in)
        elif operation in ('accumulator_test', 'operand_test'):
            if operation == 'accumulator_test':
                _following, bits, immediate = detail
                left = read(REGISTER_INDEX['rax'], bits)
            else:
                _following, operand, bits, immediate = detail
                left = (memory_value(operand, bits, following)[1]
                        if isinstance(operand, MemoryOperand)
                        else read(operand, bits))
            if left is None:
                return None
            right = Operand('const', immediate & ((1 << bits) - 1))
            result = emit('i64.and', (left, right))
            flags = result_flags('and', left, right, result, bits)
        elif operation == 'conditional_move':
            _following, code, destination, source, bits = detail
            if isinstance(source, MemoryOperand):
                value = memory_value(source, bits, following)[1]
            else:
                value = read(source, bits)
            current = read(destination, bits)
            if value is None or current is None:
                return None
            selected = emit('lane64.SELECT', (
                value, current, condition(code)))
            if not publish(destination, selected, bits):
                return None
        elif operation == 'shift':
            _following, group, operand, bits, raw_amount = detail
            pointer = None
            if isinstance(operand, MemoryOperand):
                pointer, source = memory_value(operand, bits, following)
            else:
                source = read(operand, bits)
            if source is None or group not in (0, 1, 4, 5, 7):
                return None
            amount = (emit('i64.and', (
                registers[REGISTER_INDEX['rcx']],
                Operand('const', bits - 1)))
                if raw_amount is None else
                Operand('const', int(raw_amount) & (bits - 1)))
            if group in (0, 1) and bits in (32, 64):
                result = emit(
                    'i%d.%s' % (bits, 'rotl' if group == 0 else 'rotr'),
                    (source, amount))
            elif group == 0:
                complement = emit('i64.sub', (
                    Operand('const', bits), amount))
                result = emit('i64.or', (
                    emit('i64.shl', (source, amount)),
                    emit('i64.shr_u', (source, complement))))
            elif group == 1:
                complement = emit('i64.sub', (
                    Operand('const', bits), amount))
                result = emit('i64.or', (
                    emit('i64.shr_u', (source, amount)),
                    emit('i64.shl', (source, complement))))
            elif group == 4:
                result = emit('i64.shl', (source, amount))
            elif group == 5:
                result = emit('i64.shr_u', (source, amount))
            else:
                signed = (source if bits == 64 else emit(
                    'i64.extend%d_s' % bits, (source,)))
                result = emit('i64.shr_s', (signed, amount))
            result = emit('i64.and', (
                result, Operand('const', (1 << bits) - 1)))
            if pointer is not None:
                memory_store(pointer, result, bits)
            elif not publish(operand, result, bits):
                return None

            flags = emit('lane64.X86_SHIFT_FLAGS', (
                prior_flags, source, result, amount,
                Operand('const', int(bits) | (int(group) << 8))))
        elif operation in ('bit_immediate', 'bit_register'):
            if operation == 'bit_immediate':
                _following, group, operand, bits, immediate = detail
                raw_index = Operand('const', int(immediate))
            else:
                _following, group, operand, index_register, bits = detail
                if not isinstance(index_register, int):
                    return None
                raw_index = registers[index_register]
            if group not in (4, 5, 6, 7) or bits not in (16, 32, 64):
                return None
            bit_index = (Operand('const', int(immediate) & (bits - 1))
                         if operation == 'bit_immediate' else
                         emit('i64.and', (
                             raw_index, Operand('const', bits - 1))))
            pointer = None
            if isinstance(operand, MemoryOperand):
                pointer = memory_address(operand, following)
                if pointer is None:
                    return None
                if operation == 'bit_immediate':
                    byte_offset = ((int(immediate) // bits)
                                   * (bits // 8))
                    if byte_offset:
                        pointer = emit('i64.add', (
                            pointer, Operand('const', byte_offset)))
                else:
                    signed_index = (raw_index if bits == 64 else emit(
                        'i64.extend%d_s' % bits, (raw_index,)))
                    word_index = emit('i64.shr_s', (
                        signed_index,
                        Operand('const', bits.bit_length() - 1)))
                    byte_shift = (bits // 8).bit_length() - 1
                    byte_offset = (word_index if not byte_shift else emit(
                        'i64.shl', (
                            word_index, Operand('const', byte_shift))))
                    pointer = emit('i64.add', (pointer, byte_offset))
                value = memory_load(pointer, bits)
            else:
                value = read(operand, bits)
            if value is None:
                return None
            flags = emit('lane64.X86_BIT_FLAGS', (
                prior_flags, value, bit_index, Operand('const', bits)))
            if group != 4:
                selected = emit('i64.shl', (
                    Operand('const', 1), bit_index))
                if group == 5:
                    result = emit('i64.or', (value, selected))
                elif group == 6:
                    result = emit('lane64.ANDNR', (selected, value))
                else:
                    result = emit('i64.xor', (value, selected))
                if pointer is not None:
                    memory_store(pointer, result, bits)
                elif not publish(operand, result, bits):
                    return None
        elif operation == 'group_ff':
            _following, group, operand, bits = detail
            if group not in (0, 1):
                return None
            pointer = None
            if isinstance(operand, MemoryOperand):
                pointer, value = memory_value(operand, bits, following)
            else:
                value = read(operand, bits)
            if value is None:
                return None
            name = 'add' if group == 0 else 'sub'
            result = emit('i64.' + name, (
                value, Operand('const', 1)))
            result = emit('i64.and', (
                result, Operand('const', (1 << bits) - 1)))
            if pointer is not None:
                memory_store(pointer, result, bits)
            elif not publish(operand, result, bits):
                return None
            flags = result_flags(
                name, value, Operand('const', 1), result, bits,
                preserve_carry=True)
        elif operation == 'set_condition':
            _following, code, operand, high_byte = detail
            if isinstance(operand, MemoryOperand):
                pointer = memory_address(operand, following)
                if pointer is None:
                    return None
                memory_store(pointer, condition(code), 8)
            else:
                target = HighByteRegister(
                    operand - 4) if high_byte else operand
                if not publish(target, condition(code), 8):
                    return None
        else:
            _following, opcode = detail
            if opcode in (0xfa, 0xfc):
                mask = (RFLAGS_INTERRUPT if opcode == 0xfa
                        else RFLAGS_DIRECTION)
                flags = emit('i64.and', (
                    prior_flags, Operand('const', MASK64 ^ mask)))
            else:
                mask = (RFLAGS_INTERRUPT if opcode == 0xfb
                        else RFLAGS_DIRECTION)
                flags = emit('i64.or', (
                    prior_flags, Operand('const', mask)))
            flags = emit('i64.or', (flags, Operand('const', 2)))

        residual = PureSlice(
            plan.function, plan.start, plan.end + 1,
            plan.instructions + 1, plan.stack_inputs,
            tuple(nodes), plan.waves, plan.stack,
            tuple(registers) + (flags,))
        return normalize_plan(residual), int(following) & MASK64

    @staticmethod
    def _register_plan(boundary):
        """Lower one non-observing x86 register boundary to physical SSA."""
        operation, detail = boundary.operation, boundary.detail
        supported = {
            'accumulator_high_sign_extend',
            'accumulator_sign_extend',
            'lea',
            'move_sign_extend',
            'move_zero_extend',
            'register_byte_immediate',
            'register_immediate',
            'register_move',
        }
        if operation not in supported:
            return None

        locals_ = [Operand('local', index)
                   for index in range(len(REGISTER_NAMES))]
        nodes = []
        common = {}

        def emit(name, arguments):
            arguments = tuple(arguments)
            key = name, arguments
            present = common.get(key)
            if present is not None:
                return present
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, name, arguments))
            common[key] = result
            return result

        def read(register, bits):
            if isinstance(register, HighByteRegister):
                value = emit('i64.shr_u', (
                    locals_[register.index], Operand('const', 8)))
            elif isinstance(register, int):
                value = locals_[register]
            else:
                return None
            if bits < 64:
                value = emit('i64.and', (
                    value, Operand('const', (1 << bits) - 1)))
            return value

        def publish(register, value, bits):
            high_byte = isinstance(register, HighByteRegister)
            index = register.index if high_byte else register
            if not isinstance(index, int):
                return False
            if bits == 64:
                locals_[index] = value
                return True
            if bits == 32:
                locals_[index] = emit('i64.and', (
                    value, Operand('const', MASK32)))
                return True
            shift = 8 if high_byte else 0
            mask = ((1 << bits) - 1) << shift
            cleared = emit('i64.and', (
                locals_[index], Operand('const', MASK64 ^ mask)))
            inserted = emit('i64.and', (
                value, Operand('const', (1 << bits) - 1)))
            if shift:
                inserted = emit('i64.shl', (
                    inserted, Operand('const', shift)))
            locals_[index] = emit('i64.or', (cleared, inserted))
            return True

        following = detail[0] if isinstance(detail, tuple) else detail
        if operation == 'register_byte_immediate':
            _following, register, high_byte, immediate = detail
            target = HighByteRegister(register - 4) if high_byte else register
            if not publish(target, Operand('const', immediate), 8):
                return None
        elif operation == 'register_immediate':
            _following, register, bits, immediate = detail
            if not publish(register, Operand('const', immediate), bits):
                return None
        elif operation == 'register_move':
            _following, destination, source, bits = detail
            value = read(source, bits)
            if value is None or not publish(destination, value, bits):
                return None
        elif operation in ('move_zero_extend', 'move_sign_extend'):
            (_following, destination, source_bits,
             target_bits, source) = detail
            if isinstance(source, MemoryOperand):
                return None
            value = read(source, source_bits)
            if value is None:
                return None
            if operation == 'move_sign_extend' and source_bits < target_bits:
                if source_bits == 32 and target_bits == 64:
                    name = 'i64.extend_i32_s'
                else:
                    name = 'i%d.extend%d_s' % (target_bits, source_bits)
                value = emit(name, (value,))
            if not publish(destination, value, target_bits):
                return None
        elif operation == 'accumulator_sign_extend':
            _following, source_bits, target_bits = detail
            value = read(REGISTER_INDEX['rax'], source_bits)
            name = ('i64.extend_i32_s' if source_bits == 32 else
                    'i%d.extend%d_s' % (target_bits, source_bits))
            if not publish(
                    REGISTER_INDEX['rax'], emit(name, (value,)), target_bits):
                return None
        elif operation == 'accumulator_high_sign_extend':
            _following, bits = detail
            prefix = 'i64.' if bits == 64 else 'i32.'
            sign = emit(prefix + 'and', (
                emit(prefix + 'shr_u', (
                    locals_[REGISTER_INDEX['rax']],
                    Operand('const', bits - 1))),
                Operand('const', 1)))
            high = emit(prefix + 'sub', (Operand('const', 0), sign))
            if not publish(REGISTER_INDEX['rdx'], high, bits):
                return None
        else:
            _following, destination, bits, operand = detail
            if operand.segment_msr is not None:
                return None
            value = Operand(
                'const', int(operand.displacement)
                + (int(following) if operand.rip_relative else 0))
            if not operand.rip_relative and operand.base is not None:
                value = emit('i64.add', (value, locals_[operand.base]))
            if operand.index is not None:
                index = locals_[operand.index]
                if operand.scale != 1:
                    index = emit('i64.shl', (
                        index,
                        Operand('const', operand.scale.bit_length() - 1)))
                value = emit('i64.add', (value, index))
            if not publish(destination, value, bits):
                return None

        plan = normalize_plan(PureSlice(
            0, 0, 1, 1, 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (), tuple(locals_)))
        return plan, int(following) & MASK64

    @staticmethod
    def _memory_plan(boundary):
        """Lower an ordinary x86 memory instruction into shared memory SSA."""
        operation, detail = boundary.operation, boundary.detail
        supported = {'load', 'repeat_move', 'repeat_store', 'store', 'store_immediate',
                     'move_sign_extend', 'move_zero_extend'}
        if operation not in supported:
            return None

        locals_ = [Operand('local', index)
                   for index in range(len(REGISTER_NAMES) + 1)]
        nodes = []
        common = {}

        def emit(name, arguments):
            arguments = tuple(arguments)
            key = name, arguments
            previous = None if name.startswith('memory.') \
                else common.get(key)
            if previous is not None:
                return previous
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, name, arguments))
            if not name.startswith('memory.'):
                common[key] = result
            return result

        def read(register, bits):
            if isinstance(register, HighByteRegister):
                value = emit('i64.shr_u', (
                    locals_[register.index], Operand('const', 8)))
            elif isinstance(register, int):
                value = locals_[register]
            else:
                return None
            if bits < 64:
                value = emit('i64.and', (
                    value, Operand('const', (1 << bits) - 1)))
            return value

        def publish(register, value, bits):
            high = isinstance(register, HighByteRegister)
            index = register.index if high else register
            if not isinstance(index, int):
                return False
            if bits == 64:
                locals_[index] = value
                return True
            if bits == 32:
                locals_[index] = emit('i64.and', (
                    value, Operand('const', MASK32)))
                return True
            shift = 8 if high else 0
            mask = ((1 << bits) - 1) << shift
            cleared = emit('i64.and', (
                locals_[index], Operand('const', MASK64 ^ mask)))
            inserted = emit('i64.and', (
                value, Operand('const', (1 << bits) - 1)))
            if shift:
                inserted = emit('i64.shl', (
                    inserted, Operand('const', shift)))
            locals_[index] = emit('i64.or', (cleared, inserted))
            return True

        def address(operand, following):
            if (not isinstance(operand, MemoryOperand)
                    or operand.segment_msr is not None):
                return None
            value = Operand(
                'const', (int(operand.displacement)
                          + (int(following)
                             if operand.rip_relative else 0)) & MASK64)
            if not operand.rip_relative and operand.base is not None:
                value = emit('i64.add', (value, locals_[operand.base]))
            if operand.index is not None:
                index = locals_[operand.index]
                if operand.scale != 1:
                    index = emit('i64.shl', (
                        index,
                        Operand('const', operand.scale.bit_length() - 1)))
                value = emit('i64.add', (value, index))
            return value

        def load_name(width, signed=False):
            if width == 8:
                return 'memory.i64.load'
            suffix = str(width * 8) + ('_s' if signed else '_u')
            return 'memory.i64.load' + suffix

        def store_name(width):
            return ('memory.i64.store' if width == 8
                    else 'memory.i64.store%d' % (width * 8))

        following = detail[0]
        if operation in ('repeat_move', 'repeat_store'):
            _following, width = detail
            count = locals_[REGISTER_INDEX['rcx']]
            target = locals_[REGISTER_INDEX['rdi']]
            shift = int(width).bit_length() - 1
            byte_count = (count if not shift else emit('i64.shl', (
                count, Operand('const', shift))))
            previous = emit('i64.sub', (
                count, Operand('const', 1)))
            if shift:
                previous = emit('i64.shl', (
                    previous, Operand('const', shift)))
            previous = emit('select', (
                previous, Operand('const', 0), count))
            backwards_start = emit('i64.sub', (target, previous))
            direction = emit('i64.shr_u', (
                locals_[len(REGISTER_NAMES)], Operand('const', 10)))
            direction = emit('i64.and', (
                direction, Operand('const', 1)))
            start = emit('select', (
                backwards_start, target, direction))
            forward_end = emit('i64.add', (target, byte_count))
            backward_end = emit('i64.sub', (target, byte_count))
            final_target = emit('select', (
                backward_end, forward_end, direction))
            if operation == 'repeat_move':
                source = locals_[REGISTER_INDEX['rsi']]
                backwards_source = emit('i64.sub', (source, previous))
                source_start = emit('select', (
                    backwards_source, source, direction))
                forward_source_end = emit('i64.add', (source, byte_count))
                backward_source_end = emit('i64.sub', (source, byte_count))
                final_source = emit('select', (
                    backward_source_end, forward_source_end, direction))
                emit('memory.i64.copy', (
                    source_start, start, byte_count,
                    Operand('const', memory_shape(1, virtual64=True))))
                locals_[REGISTER_INDEX['rsi']] = final_source
            else:
                emit('memory.i64.repeat', (
                    start, locals_[REGISTER_INDEX['rax']], byte_count,
                    Operand('const', memory_shape(
                        width, virtual64=True))))
            locals_[REGISTER_INDEX['rcx']] = Operand('const', 0)
            locals_[REGISTER_INDEX['rdi']] = final_target
        elif operation == 'load':
            _following, destination, bits, operand = detail
            width = bits // 8
            pointer = address(operand, following)
            if pointer is None:
                return None
            value = emit(load_name(width), (
                pointer, Operand('const', 0),
                Operand('const', memory_shape(
                    width, virtual64=True))))
            if not publish(destination, value, bits):
                return None
        elif operation == 'store':
            _following, source, bits, operand = detail
            width = bits // 8
            pointer, value = address(operand, following), read(source, bits)
            if pointer is None or value is None:
                return None
            emit(store_name(width), (
                pointer, value, Operand('const', 0),
                Operand('const', memory_shape(
                    width, virtual64=True))))
        elif operation == 'store_immediate':
            _following, operand, bits, immediate = detail
            width = bits // 8
            pointer = address(operand, following)
            if pointer is None:
                return None
            emit(store_name(width), (
                pointer, Operand('const', immediate & ((1 << bits) - 1)),
                Operand('const', 0), Operand('const', memory_shape(
                    width, virtual64=True))))
        else:
            (_following, destination, source_bits,
             target_bits, operand) = detail
            if not isinstance(operand, MemoryOperand):
                return None
            width = source_bits // 8
            pointer = address(operand, following)
            if pointer is None:
                return None
            value = emit(load_name(
                width, signed=operation == 'move_sign_extend'), (
                    pointer, Operand('const', 0),
                    Operand('const', memory_shape(
                        width, virtual64=True))))
            if not publish(destination, value, target_bits):
                return None

        plan = normalize_plan(PureSlice(
            0, 0, 1, 1, 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (), tuple(locals_)))
        return plan, int(following) & MASK64

    @staticmethod
    def _read_segment_memory_plan(boundary, value_local):
        """Store a resident segment selector through the shared memory SSA."""
        if boundary.operation != 'read_segment':
            return None
        following, segment, target, bits = boundary.detail
        if (not isinstance(target, MemoryOperand)
                or target.segment_msr is not None
                or not 0 <= int(segment) < 6 or int(bits) != 16
                or int(value_local) < len(REGISTER_NAMES) + 1):
            return None
        locals_ = [Operand('local', index)
                   for index in range(int(value_local) + 1)]
        nodes = []

        def emit(operation, arguments):
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, operation, tuple(arguments)))
            return result

        address = Operand(
            'const', (int(target.displacement)
                      + (int(following) if target.rip_relative else 0))
            & MASK64)
        if not target.rip_relative and target.base is not None:
            address = emit('i64.add', (address, locals_[target.base]))
        if target.index is not None:
            index = locals_[target.index]
            if target.scale != 1:
                index = emit('i64.shl', (
                    index,
                    Operand('const', target.scale.bit_length() - 1)))
            address = emit('i64.add', (address, index))
        emit('memory.i64.store16', (
            address, locals_[int(value_local)], Operand('const', 0),
            Operand('const', memory_shape(2, virtual64=True))))
        plan = normalize_plan(PureSlice(
            0, 0, 1, 1, 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (), tuple(locals_)))
        return plan, int(following) & MASK64, int(segment), int(value_local)

    @staticmethod
    def _invalidate_plan(boundary):
        """Publish an INVLPG virtual coordinate without reading memory."""
        if boundary.operation != 'invalidate_page':
            return None
        following, operand = boundary.detail
        if (not isinstance(operand, MemoryOperand)
                or operand.segment_msr is not None):
            return None
        locals_ = [Operand('local', index)
                   for index in range(len(REGISTER_NAMES) + 1)]
        nodes = []

        def emit(operation, arguments):
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, operation, tuple(arguments)))
            return result

        address = Operand(
            'const', (int(operand.displacement)
                      + (int(following) if operand.rip_relative else 0))
            & MASK64)
        if not operand.rip_relative and operand.base is not None:
            address = emit('i64.add', (address, locals_[operand.base]))
        if operand.index is not None:
            index = locals_[operand.index]
            if operand.scale != 1:
                index = emit('i64.shl', (
                    index, Operand(
                        'const', operand.scale.bit_length() - 1)))
            address = emit('i64.add', (address, index))
        plan = normalize_plan(PureSlice(
            0, 0, 1, 1, 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (),
            tuple(locals_) + (address,)))
        return plan, int(following) & MASK64

    @staticmethod
    def _descriptor_plan(boundary):
        """Lower LGDT/LIDT address and mixed-width reads to physical SSA."""
        if boundary.operation != 'load_descriptor_table':
            return None
        following, name, operand = boundary.detail
        if (name not in ('gdtr', 'idtr')
                or not isinstance(operand, MemoryOperand)
                or operand.segment_msr is not None):
            return None
        locals_ = [Operand('local', index)
                   for index in range(len(REGISTER_NAMES) + 1)]
        nodes = []

        def emit(operation, arguments):
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, operation, tuple(arguments)))
            return result

        address = Operand(
            'const', (int(operand.displacement)
                      + (int(following) if operand.rip_relative else 0))
            & MASK64)
        if not operand.rip_relative and operand.base is not None:
            address = emit('i64.add', (address, locals_[operand.base]))
        if operand.index is not None:
            index = locals_[operand.index]
            if operand.scale != 1:
                index = emit('i64.shl', (
                    index,
                    Operand('const', operand.scale.bit_length() - 1)))
            address = emit('i64.add', (address, index))
        limit = emit('memory.i64.load16_u', (
            address, Operand('const', 0),
            Operand('const', memory_shape(2, virtual64=True))))
        base = emit('memory.i64.load', (
            address, Operand('const', 2),
            Operand('const', memory_shape(8, virtual64=True))))
        plan = normalize_plan(PureSlice(
            0, 0, 1, 1, 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (),
            tuple(locals_) + (limit, base)))
        return plan, int(following) & MASK64, name

    @staticmethod
    def _indirect_control_plan(boundary):
        """Lower indirect CALL/JMP target discovery to the shared memory SSA."""
        if boundary.operation != 'group_ff':
            return None
        following, group, operand, bits = boundary.detail
        if group not in (2, 4) or bits != 64:
            return None
        locals_ = [Operand('local', index)
                   for index in range(len(REGISTER_NAMES) + 1)]
        nodes = []

        def emit(operation, arguments):
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, operation, tuple(arguments)))
            return result

        if isinstance(operand, MemoryOperand):
            if operand.segment_msr is not None:
                return None
            address = Operand(
                'const', (int(operand.displacement)
                          + (int(following)
                             if operand.rip_relative else 0)) & MASK64)
            if not operand.rip_relative and operand.base is not None:
                address = emit('i64.add', (address, locals_[operand.base]))
            if operand.index is not None:
                index = locals_[operand.index]
                if operand.scale != 1:
                    index = emit('i64.shl', (
                        index,
                        Operand('const', operand.scale.bit_length() - 1)))
                address = emit('i64.add', (address, index))
            target = emit('memory.i64.load', (
                address, Operand('const', 0),
                Operand('const', memory_shape(8, virtual64=True))))
        elif isinstance(operand, int) and 0 <= operand < len(REGISTER_NAMES):
            target = locals_[operand]
        else:
            return None
        if group == 2:
            rsp = REGISTER_INDEX['rsp']
            pointer = emit('i64.sub', (
                locals_[rsp], Operand('const', 8)))
            emit('memory.i64.store', (
                pointer, Operand('const', int(following) & MASK64),
                Operand('const', 0),
                Operand('const', memory_shape(8, virtual64=True))))
            locals_[rsp] = pointer
        plan = normalize_plan(PureSlice(
            0, 0, 1, 1, 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (), tuple(locals_) + (target,)))
        return plan

    @staticmethod
    def _divide_plan(boundary):
        """Lower 32-bit DIV/IDIV to total SSA plus one exception predicate."""
        if boundary.operation != 'unary':
            return None
        following, group, operand, bits, _instruction = boundary.detail
        if group not in (6, 7) or bits != 32 or not isinstance(operand, int):
            return None
        locals_ = [Operand('local', index)
                   for index in range(len(REGISTER_NAMES) + 1)]
        nodes = []

        def emit(operation, arguments):
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, operation, tuple(arguments)))
            return result

        low = emit('i64.and', (
            locals_[REGISTER_INDEX['rax']], Operand('const', MASK32)))
        high = emit('i64.and', (
            locals_[REGISTER_INDEX['rdx']], Operand('const', MASK32)))
        dividend = emit('i64.or', (
            emit('i64.shl', (high, Operand('const', 32))), low))
        divisor = emit('i64.and', (
            locals_[operand], Operand('const', MASK32)))
        if group == 7:
            divisor = emit('i64.extend_i32_s', (divisor,))
        zero = emit('i64.eqz', (divisor,))
        invalid = zero
        if group == 7:
            minimum = emit('i64.eq', (
                dividend, Operand('const', 1 << 63)))
            negative_one = emit('i64.eq', (
                divisor, Operand('const', MASK64)))
            invalid = emit('i64.or', (
                zero, emit('i64.and', (minimum, negative_one))))
        safe_divisor = emit('select', (
            Operand('const', 1), divisor, invalid))
        division = 'i64.div_s' if group == 7 else 'i64.div_u'
        remainder = 'i64.rem_s' if group == 7 else 'i64.rem_u'
        quotient = emit(division, (dividend, safe_divisor))
        residual = emit(remainder, (dividend, safe_divisor))
        low_quotient = emit('i64.and', (
            quotient, Operand('const', MASK32)))
        if group == 7:
            widened = emit('i64.extend_i32_s', (low_quotient,))
            overflow = emit('i64.ne', (quotient, widened))
        else:
            overflow = emit('i64.gt_u', (
                quotient, Operand('const', MASK32)))
        error = emit('i64.or', (invalid, overflow))
        locals_[REGISTER_INDEX['rax']] = low_quotient
        locals_[REGISTER_INDEX['rdx']] = emit('i64.and', (
            residual, Operand('const', MASK32)))
        plan = normalize_plan(PureSlice(
            0, 0, 1, 1, 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (), tuple(locals_) + (error,)))
        return plan, int(following) & MASK64

    @staticmethod
    def _stack_plan(boundary, indirect_register=None):
        """Lower stack memory and its control result to shared physical SSA."""
        operation, detail = boundary.operation, boundary.detail
        supported = {
            'call', 'far_return', 'interrupt_return', 'leave', 'pop', 'pop_flags', 'push',
            'pop_operand', 'push_flags', 'push_immediate', 'return',
        }
        if operation not in supported:
            return None

        scratch_count = (3 if operation == 'interrupt_return'
                         else 2 if operation == 'far_return' else int(
                             operation == 'return'
                             or indirect_register is not None))
        locals_ = [Operand('local', index)
                   for index in range(
                       len(REGISTER_NAMES) + 1 + scratch_count)]
        nodes = []
        common = {}

        def emit(name, arguments):
            arguments = tuple(arguments)
            if name.startswith(('i32.', 'i64.')):
                name, arguments = select_lane(name, arguments)
            key = name, arguments
            previous = None if name.startswith('memory.') \
                else common.get(key)
            if previous is not None:
                return previous
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, name, arguments))
            if not name.startswith('memory.'):
                common[key] = result
            return result

        def load(pointer, width=8):
            operation = ('memory.i64.load' if width == 8
                         else 'memory.i64.load%d_u' % (width * 8))
            return emit(operation, (
                pointer, Operand('const', 0),
                Operand('const', memory_shape(width, virtual64=True))))

        def store(pointer, value, width=8):
            operation = ('memory.i64.store' if width == 8
                         else 'memory.i64.store%d' % (width * 8))
            return emit(operation, (
                pointer, value, Operand('const', 0),
                Operand('const', memory_shape(width, virtual64=True))))

        def address(operand, following):
            if (not isinstance(operand, MemoryOperand)
                    or operand.segment_msr is not None):
                return None
            pointer = Operand(
                'const', (int(operand.displacement)
                          + (int(following)
                             if operand.rip_relative else 0)) & MASK64)
            if not operand.rip_relative and operand.base is not None:
                pointer = emit('i64.add', (
                    pointer, locals_[operand.base]))
            if operand.index is not None:
                index = locals_[operand.index]
                if operand.scale != 1:
                    index = emit('i64.shl', (
                        index, Operand(
                            'const', operand.scale.bit_length() - 1)))
                pointer = emit('i64.add', (pointer, index))
            return pointer

        def publish(operand, value, bits):
            if isinstance(operand, MemoryOperand):
                return False
            high = isinstance(operand, HighByteRegister)
            index = operand.index if high else operand
            if not isinstance(index, int):
                return False
            if bits == 64:
                locals_[index] = value
            elif bits == 32:
                locals_[index] = emit('i64.and', (
                    value, Operand('const', MASK32)))
            else:
                shift = 8 if high else 0
                locals_[index] = emit('lane64.INSERT', (
                    locals_[index], value,
                    Operand('const', int(bits) | (shift << 8))))
            return True

        rsp = REGISTER_INDEX['rsp']
        pointer = locals_[rsp]
        flags = locals_[len(REGISTER_NAMES)]
        scratch = ()
        if operation == 'return':
            target = load(pointer)
            locals_[rsp] = emit('i64.add', (
                pointer, Operand('const', 8)))
            scratch = (target,)
            control = X86Boundary('dynamic_branch', None)
        elif operation == 'far_return':
            pointer = locals_[rsp]
            target = load(pointer)
            selector = load(emit('i64.add', (
                pointer, Operand('const', 8))))
            locals_[rsp] = emit('i64.add', (
                pointer, Operand('const', 16)))
            scratch = (target, selector)
            control = X86Boundary('native_far_return', None)
        elif operation == 'interrupt_return':
            pointer = locals_[rsp]
            target = load(pointer)
            selector = load(emit('i64.add', (
                pointer, Operand('const', 8))))
            flags = emit('i64.or', (load(emit('i64.add', (
                pointer, Operand('const', 16)))), Operand('const', 2)))
            locals_[rsp] = load(emit('i64.add', (
                pointer, Operand('const', 24))))
            restored_ss = load(emit('i64.add', (
                pointer, Operand('const', 32))))
            scratch = (target, selector, restored_ss)
            control = X86Boundary('native_interrupt_return', None)
        elif operation == 'leave':
            following, bits = detail
            width = int(bits) // 8
            pointer = locals_[REGISTER_INDEX['rbp']]
            value = load(pointer, width)
            if bits == 64:
                locals_[REGISTER_INDEX['rbp']] = value
            else:
                cleared = emit('i64.and', (
                    locals_[REGISTER_INDEX['rbp']],
                    Operand('const', MASK64 ^ ((1 << bits) - 1))))
                locals_[REGISTER_INDEX['rbp']] = emit('i64.or', (
                    cleared, value))
            locals_[rsp] = emit('i64.add', (
                pointer, Operand('const', width)))
            control = X86Boundary('branch', int(following) & MASK64)
        elif operation == 'call':
            following, target = detail
            pointer = emit('i64.sub', (
                pointer, Operand('const', 8)))
            store(pointer, Operand('const', int(following) & MASK64))
            locals_[rsp] = pointer
            if indirect_register is None:
                control = X86Boundary('branch', int(target) & MASK64)
            else:
                scratch = (locals_[indirect_register],)
                control = X86Boundary('dynamic_branch', None)
        elif operation in ('push', 'push_immediate', 'push_flags'):
            if operation == 'push':
                following, register = detail
                value = locals_[register]
            elif operation == 'push_immediate':
                following, immediate = detail
                value = Operand('const', int(immediate) & MASK64)
            else:
                following = detail
                value = flags
            pointer = emit('i64.sub', (
                pointer, Operand('const', 8)))
            store(pointer, value)
            locals_[rsp] = pointer
            control = X86Boundary('branch', int(following) & MASK64)
        elif operation == 'pop_operand':
            following, operand, bits = detail
            width = int(bits) // 8
            value = load(pointer, width)
            locals_[rsp] = emit('i64.add', (
                pointer, Operand('const', width)))
            if isinstance(operand, MemoryOperand):
                target = address(operand, following)
                if target is None:
                    return None
                store(target, value, width)
            elif not publish(operand, value, bits):
                return None
            control = X86Boundary('branch', int(following) & MASK64)
        else:
            value = load(pointer)
            next_pointer = emit('i64.add', (
                pointer, Operand('const', 8)))
            if operation == 'pop':
                following, register = detail
                locals_[rsp] = next_pointer
                locals_[register] = value
            else:
                following = detail
                locals_[rsp] = next_pointer
                flags = emit('i64.or', (value, Operand('const', 2)))
            control = X86Boundary('branch', int(following) & MASK64)

        plan = normalize_plan(PureSlice(
            0, 0, 1, 1, 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (),
            tuple(locals_[:len(REGISTER_NAMES)]) + (flags,) + scratch))
        return plan, control, scratch_count

    def _compose_stack_cut(self, state, block):
        """Keep stack loads/stores inside the same resident state-page ABI."""
        # Retired function recognizers remain available only as differential
        # test oracles.  Their synthetic fixtures intentionally omit real
        # stack mappings, so they must observe the original scalar boundary.
        if self.enable_function_oracles:
            return block
        indirect_register = None
        stack_boundary = block.boundary
        call_target = None
        if block.boundary.operation == 'call':
            _following, target = block.boundary.detail
            layout = self._indirect_thunk_layout(state, target)
            if layout is not None:
                register, return_thunk = layout
                if self._code_contains_recipe(
                        state, return_thunk, b'\xc3', extent=1):
                    indirect_register = register
                    call_target = state.registers[register] & MASK64
        elif block.boundary.operation == 'group_ff':
            following, group, operand, bits = block.boundary.detail
            if group == 2 and bits == 64 and isinstance(operand, int):
                indirect_register = operand
                call_target = state.registers[operand] & MASK64
                stack_boundary = X86Boundary(
                    'call', (int(following) & MASK64, call_target))
        cached = self._stack_cuts.get(block.rip)
        if (cached is not None and cached[0] is block
                and cached[1].indirect_register == indirect_register
                and (cached[1].inlined_call_target is None
                     or cached[1].inlined_call_target == call_target)):
            self.stack_cut_cache_hits += 1
            return cached[1]
        lowered = self._stack_plan(stack_boundary, indirect_register)
        if lowered is None:
            return block
        control, boundary, scratch_count = lowered
        plan = block.plan if block.state_flags \
            else self._carry_flags_plan(block.plan)
        if plan is None or block.cut_inputs:
            return block
        plan = compose_plans(plan, control)
        packed = pack_step(plan)
        mapped = unpack_step(packed)
        execute = self._bind_state_page(mapped, packed)
        composed = DecodedBlock(
            block.rip, block.boundary_rip, block.source,
            block.instructions + 1, plan, mapped, execute, scratch_count,
            boundary, block.proof_config, block.proof,
            control_block=block.control_block or block,
            state_flags=True, virtual_memory=True,
            indirect_register=indirect_register,
            inlined_call_target=call_target)
        self._stack_cuts[block.rip] = block, composed
        self.stack_cuts += 1
        self.stack_cut_cache_misses += 1
        self.stack_cut_work += physical_work(plan)
        self.stack_cut_span += plan.waves.span
        return composed

    def _compose_register_cut(self, state, block, limit=64):
        """Join one straight state path through the shared physical grammar."""
        call_target = None
        call_origin = block.control_block
        if block.inlined_call_target is not None:
            call_target = int(block.inlined_call_target) & MASK64
        elif (call_origin is not None
                and call_origin.boundary.operation == 'call'):
            _return_address, encoded_target = call_origin.boundary.detail
            if block.indirect_register is not None:
                call_target = state.registers[block.indirect_register] \
                    & MASK64
            elif block.boundary.operation == 'branch':
                call_target = int(block.boundary.detail) & MASK64
            else:
                call_target = int(encoded_target) & MASK64
        cached = self._register_cuts.get(block.rip)
        if (cached is not None and cached[0][0] is block
                and all(self.blocks.get(
                    (proved.control_block or proved).rip)
                    is (proved.control_block or proved)
                        for proved in cached[0])
                and (cached[1].tail_return is None
                     or self._code_contains_recipe(
                         state, cached[1].tail_return, b'\xc3', extent=1))):
            if cached[1].inlined_call_target == call_target:
                self.register_cut_cache_hits += 1
                return cached[1]

        plan = self._carry_flags_plan(block.plan)
        if plan is None or block.cut_inputs:
            return block
        source = block.source
        instructions = block.instructions
        proof_blocks = [block]
        current = block
        joined = 0
        terminal_boundary = None
        terminal_scratch = 0
        tail_return = None
        call_edge_used = False
        join_limit = max(1, int(limit))
        while True:
            boundary_instructions = 1
            lowered_flags = self._lower_flag_boundary(
                plan, current.boundary)
            if lowered_flags is not None:
                plan, following = lowered_flags
            else:
                lowered = self._register_plan(current.boundary)
                if lowered is None:
                    lowered = self._memory_plan(current.boundary)
                if lowered is not None:
                    control, following = lowered
                    control = self._carry_flags_plan(control)
                    if control is None:
                        break
                    plan = compose_plans(plan, control)
                else:
                    stack = (None
                             if current.boundary.operation == 'call'
                             else self._stack_plan(current.boundary))
                    if (stack is not None and not stack[2]
                            and stack[1].operation == 'branch'):
                        control, boundary, _scratch = stack
                        plan = compose_plans(plan, control)
                        following = int(boundary.detail) & MASK64
                    elif (not call_edge_used and current is block
                          and call_target is not None
                          and current.boundary.operation
                          in ('branch', 'dynamic_branch')):
                        following = call_target
                        boundary_instructions = 0
                        call_edge_used = True
                    elif stack is not None:
                        control, terminal_boundary, terminal_scratch = stack
                        plan = compose_plans(plan, control)
                        instructions += 1
                        joined += 1
                        break
                    elif (current.boundary.operation == 'branch'
                            and isinstance(current.boundary.detail, int)
                            and self._code_contains_recipe(
                                state,
                                int(current.boundary.detail) & MASK64,
                                b'\xc3', extent=1)):
                        control, terminal_boundary, terminal_scratch = \
                            self._stack_plan(X86Boundary(
                                'return', int(current.boundary.detail)
                                & MASK64))
                        plan = compose_plans(plan, control)
                        tail_return = int(current.boundary.detail) & MASK64
                        instructions += 2
                        joined += 1
                        break
                    elif (current.boundary.operation == 'branch'
                            and isinstance(
                                current.boundary.detail, int)
                            and (int(current.boundary.detail) & MASK64)
                            == current.rip + len(current.source)):
                        following = int(current.boundary.detail) & MASK64
                        boundary_instructions = int(
                            current.control_block is None)
                    else:
                        break
            linear_end = current.rip + len(current.source)
            synthetic_boundary = (
                current.control_block is not None
                and current.control_block.boundary.operation
                != current.boundary.operation)
            call_edge = current is block and call_edge_used \
                and following == call_target
            if (not call_edge
                    and ((not synthetic_boundary and linear_end != following)
                    or (synthetic_boundary and linear_end > following))):
                break
            if synthetic_boundary and linear_end < following:
                source += read_virtual(
                    state, linear_end, following - linear_end, 'execute')
            instructions += boundary_instructions
            if joined >= join_limit:
                # The current block is already resident in ``plan`` and its
                # terminal instruction has just been normalized above.  End
                # the physical page at the resulting coordinate instead of
                # publishing that instruction as a scalar boundary merely
                # because the next block would exceed the composition cap.
                terminal_boundary = X86Boundary(
                    'branch', int(following) & MASK64)
                terminal_scratch = max(
                    0, len(plan.locals) - len(REGISTER_NAMES) - 1)
                break
            next_block = self.blocks.get(following)
            if next_block is None:
                next_block = self.block(replace(
                    _freeze_state(state), rip=following))
            next_plan = self._carry_flags_plan(next_block.plan)
            if next_plan is None or next_block.cut_inputs:
                break
            plan = compose_plans(plan, next_plan)
            source += next_block.source
            instructions += next_block.instructions
            proof_blocks.append(next_block)
            current = next_block
            joined += 1

        if not joined:
            return block
        final_boundary = terminal_boundary or current.boundary
        final_scratch = (terminal_scratch if terminal_boundary is not None
                         else current.scratch_count)
        if (final_boundary.operation == 'dynamic_branch'
                and final_scratch == 1 and plan.locals
                and plan.locals[-1].kind == 'const'):
            final_boundary = X86Boundary(
                'branch', plan.locals[-1].value & MASK64)
            final_scratch = 0
            plan = _dataclass_replace(plan, locals=plan.locals[:-1])
        packed = pack_step(plan)
        mapped = unpack_step(packed)
        execute = self._bind_state_page(mapped, packed)
        if call_edge_used:
            proof_config = block.proof_config
            sparse = {}
            for proved in proof_blocks:
                if (proved.proof_config != proof_config
                        or proved.proof is None):
                    sparse = None
                    break
                for item in proved.proof:
                    sparse[item[:3]] = item
            proof = (None if sparse is None else tuple(
                sparse[key] for key in sorted(sparse)))
        else:
            proof_config, proof = _execution_proof(
                state, block.rip, len(source))
        composed = DecodedBlock(
            block.rip, current.boundary_rip, source, instructions,
            plan, mapped, execute,
            final_scratch, final_boundary, proof_config, proof,
            current.flag_cut, current.control_block or current,
            current.cut_inputs, True,
            any(node.op.startswith('memory.') for node in plan.nodes))
        composed = replace(
            composed, tail_return=tail_return,
            indirect_register=block.indirect_register,
            inlined_call_target=call_target if call_edge_used else None)
        proof_blocks = tuple(proof_blocks)
        self._register_cuts[block.rip] = proof_blocks, composed
        self.register_cuts += 1
        self.register_cut_cache_misses += 1
        self.register_cut_instructions += joined
        self.register_cut_work += physical_work(plan)
        self.register_cut_span += plan.waves.span
        return composed

    @staticmethod
    def _predicate_plan(block, condition):
        """Reopen one decoded flag producer with a terminal predicate root."""
        plan = block.plan
        if not block.state_flags:
            if len(plan.locals) < len(REGISTER_NAMES):
                return None

            def shifted(operand):
                if (operand.kind == 'local'
                        and operand.value >= len(REGISTER_NAMES)):
                    return Operand(operand.kind, operand.value + 1)
                return operand

            plan = PureSlice(
                plan.function, plan.start, plan.end, plan.instructions,
                plan.stack_inputs,
                tuple(WaveNode(
                    node.value, node.op,
                    tuple(shifted(operand) for operand in node.arguments))
                    for node in plan.nodes),
                plan.waves,
                tuple(shifted(operand) for operand in plan.stack),
                tuple(shifted(operand) for operand in
                      plan.locals[:len(REGISTER_NAMES)])
                + (Operand('local', len(REGISTER_NAMES)),)
                + tuple(shifted(operand) for operand in
                        plan.locals[len(REGISTER_NAMES):]))
        if plan is None:
            return None
        nodes = list(plan.nodes)
        common = {(node.op, node.arguments): Operand('node', node.value)
                  for node in nodes}

        def emit(operation, arguments):
            arguments = tuple(arguments)
            if not operation.startswith(('lane32.', 'lane64.', 'memory.')):
                operation, arguments = select_lane(operation, arguments)
            key = operation, tuple(arguments)
            previous = common.get(key)
            if previous is not None:
                return previous
            value = len(nodes) + 1
            operand = Operand('node', value)
            nodes.append(WaveNode(value, operation, tuple(arguments)))
            common[key] = operand
            return operand

        cut_inputs = list(block.cut_inputs)

        def value_operand(operand, bits, following):
            if isinstance(operand, MemoryOperand):
                if operand.segment_msr is not None:
                    return None
                pointer = Operand(
                    'const', int(operand.displacement)
                    + (int(following) if operand.rip_relative else 0)
                    & MASK64)
                if not operand.rip_relative and operand.base is not None:
                    pointer = emit('i64.add', (
                        pointer, plan.locals[operand.base]))
                if operand.index is not None:
                    index = plan.locals[operand.index]
                    if operand.scale != 1:
                        index = emit('i64.shl', (
                            index, Operand(
                                'const', operand.scale.bit_length() - 1)))
                    pointer = emit('i64.add', (pointer, index))
                width = int(bits) // 8
                load_operation = ('memory.i64.load' if width == 8 else
                                  'memory.i64.load%d_u' % (width * 8))
                return emit(load_operation, (
                    pointer, Operand('const', 0),
                    Operand('const', memory_shape(
                        width, virtual64=True))))
            if isinstance(operand, HighByteRegister):
                value = emit('i64.shr_u', (
                    plan.locals[operand.index], Operand('const', 8)))
            else:
                value = plan.locals[operand]
            if bits < 64:
                value = emit('i64.and', (
                    value, Operand('const', (1 << bits) - 1)))
            return value

        operation = block.boundary.operation
        detail = block.boundary.detail
        register_outputs = list(plan.locals[:len(REGISTER_NAMES)])
        name = None
        bits = None
        left = right = result = None
        if operation == 'compare':
            following, opcode, register, operand, bits = detail
            register_value = value_operand(register, bits, following)
            operand_value = value_operand(operand, bits, following)
            if register_value is None or operand_value is None:
                return None
            if opcode in (0x38, 0x39):
                left, right, name = operand_value, register_value, 'cmp'
                result = emit('i%d.sub' % bits, (left, right))
            elif opcode in (0x3a, 0x3b):
                left, right, name = register_value, operand_value, 'cmp'
                result = emit('i%d.sub' % bits, (left, right))
            else:
                left, right, name = operand_value, register_value, 'and'
                result = emit('i%d.and' % bits, (left, right))
        elif operation == 'immediate_alu':
            following, name, operand, bits, immediate = detail
            if name != 'cmp':
                return None
            left = value_operand(operand, bits, following)
            if left is None:
                return None
            right = Operand('const', immediate & ((1 << bits) - 1))
            result = emit('i%d.sub' % bits, (left, right))
        elif operation == 'accumulator_test':
            following, bits, immediate = detail
            name = 'and'
            left = value_operand(
                REGISTER_INDEX['rax'], bits, following)
            right = Operand('const', immediate & ((1 << bits) - 1))
            result = emit('i%d.and' % bits, (left, right))
        elif operation == 'operand_test':
            following, operand, bits, immediate = detail
            name = 'and'
            left = value_operand(operand, bits, following)
            if left is None:
                return None
            right = Operand('const', immediate & ((1 << bits) - 1))
            result = emit('i%d.and' % bits, (left, right))
        elif operation == 'register_result_flags':
            _following, name, destination, _source, bits = detail
            left, right = plan.locals[-2:]
            result = plan.locals[destination]
        elif operation == 'register_immediate_result_flags':
            _following, name, destination, bits, immediate = detail
            left = plan.locals[-1]
            right = Operand('const', immediate & ((1 << bits) - 1))
            result = plan.locals[destination]
        elif operation == 'memory_binary':
            following, name, reverse, register, bits, operand = detail
            if not reverse or name in ('adc', 'sbb'):
                return None
            left = value_operand(register, bits, following)
            right = value_operand(operand, bits, following)
            if left is None or right is None:
                return None
            result = emit('i%d.%s' % (bits, name), (left, right))
            if isinstance(register, HighByteRegister):
                cleared = emit('i64.and', (
                    register_outputs[register.index],
                    Operand('const', MASK64 ^ 0xff00)))
                inserted = emit('i64.shl', (
                    emit('i64.and', (result, Operand('const', 0xff))),
                    Operand('const', 8)))
                register_outputs[register.index] = emit(
                    'i64.or', (cleared, inserted))
            elif bits == 64:
                register_outputs[register] = result
            elif bits == 32:
                register_outputs[register] = emit(
                    'i64.and', (result, Operand('const', MASK32)))
            else:
                mask = (1 << bits) - 1
                cleared = emit('i64.and', (
                    register_outputs[register],
                    Operand('const', MASK64 ^ mask)))
                inserted = emit(
                    'i64.and', (result, Operand('const', mask)))
                register_outputs[register] = emit(
                    'i64.or', (cleared, inserted))
        else:
            return None

        mode = {
            'and': 0, 'or': 0, 'xor': 0,
            'add': 1, 'adc': 2,
            'sub': 3, 'cmp': 3, 'sbb': 4,
        }[name]
        descriptor = int(bits) | (mode << 8)
        flags = emit('lane64.X86_FLAGS', (
            plan.locals[len(REGISTER_NAMES)], left, right, result,
            Operand('const', descriptor)))

        if flags.kind != 'node':
            return None
        predicate = Operand('projection', projection_coordinate(
            flags.value, int(condition) & 15))
        residual = PureSlice(
            plan.function, plan.start, plan.end + 1,
            plan.instructions + 1, plan.stack_inputs,
            tuple(nodes), plan.waves, plan.stack,
            tuple(register_outputs) + (flags,)
            + tuple(Operand('local', len(REGISTER_NAMES) + 1 + index)
                    for index in range(len(cut_inputs)))
            + (predicate,))
        return normalize_plan(residual), (name, bits), tuple(cut_inputs)

    @staticmethod
    def _publish_setcc(plan, cut_input_count, operand, high_byte):
        """Publish a terminal predicate into an 8-bit register coordinate."""
        if isinstance(operand, MemoryOperand):
            return None
        nodes = list(plan.nodes)
        common = {(node.op, node.arguments): Operand('node', node.value)
                  for node in nodes}

        def emit(operation, arguments):
            arguments = tuple(arguments)
            if not operation.startswith(('lane32.', 'lane64.', 'memory.')):
                operation, arguments = select_lane(operation, arguments)
            key = operation, tuple(arguments)
            previous = common.get(key)
            if previous is not None:
                return previous
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, operation, tuple(arguments)))
            common[key] = result
            return result

        predicate = plan.locals[-1]
        if predicate.kind == 'projection':
            source, condition = decode_projection_coordinate(predicate.value)
            predicate = emit('lane64.X86_CONDITION', (
                Operand('node', source), Operand('const', condition)))
        registers = list(plan.locals[:len(REGISTER_NAMES)])
        if high_byte:
            register = int(operand) - 4
            shift = 8
        else:
            register = int(operand)
            shift = 0
        registers[register] = emit('lane64.INSERT', (
            registers[register], predicate,
            Operand('const', 8 | (shift << 8))))
        flags = plan.locals[len(REGISTER_NAMES)]
        inputs = tuple(plan.locals[
            len(REGISTER_NAMES) + 1:
            len(REGISTER_NAMES) + 1 + cut_input_count])
        residual = PureSlice(
            plan.function, plan.start, plan.end + 1,
            plan.instructions + 1, plan.stack_inputs,
            tuple(nodes), plan.waves, plan.stack,
            tuple(registers) + (flags,) + inputs + (predicate,))
        return normalize_plan(residual)

    def _compose_setcc_predicate_cut(self, state, block):
        """Close flag-producer -> SETcc -> memory ALU -> Jcc as one cut."""
        cached = self._predicate_cuts.get(block.rip)
        if (cached is not None and cached[0][0] is block
                and all(self.blocks.get(proved.rip) is proved
                        for proved in cached[0])):
            self.predicate_cut_cache_hits += 1
            return cached[1]
        detail = block.boundary.detail
        if (block.boundary.operation not in (
                'compare', 'immediate_alu', 'accumulator_test',
                'operand_test', 'register_result_flags',
                'register_immediate_result_flags')
                or not isinstance(detail, tuple) or not detail):
            return block
        setcc_rip = int(detail[0]) & MASK64
        if block.rip + len(block.source) != setcc_rip:
            return block
        setcc = self.blocks.get(setcc_rip)
        if setcc is None:
            setcc = self.block(replace(
                _freeze_state(state), rip=setcc_rip))
        if (setcc.instructions or setcc.boundary_rip != setcc.rip
                or setcc.boundary.operation != 'set_condition'):
            return block
        after_setcc, condition, operand, high_byte = setcc.boundary.detail
        first = self._predicate_plan(block, condition)
        if first is None:
            return block
        first_plan, _first_flags, first_inputs = first
        first_plan = self._publish_setcc(
            first_plan, len(first_inputs), operand, high_byte)
        if first_plan is None:
            return block

        middle = self.blocks.get(after_setcc)
        if middle is None:
            middle = self.block(replace(
                _freeze_state(state), rip=int(after_setcc) & MASK64))
        if (middle.instructions or middle.boundary_rip != middle.rip
                or middle.boundary.operation != 'memory_binary'
                or not middle.boundary.detail[2]):
            return block
        branch_rip = int(middle.boundary.detail[0]) & MASK64
        branch = self.blocks.get(branch_rip)
        if branch is None:
            branch = self.block(replace(
                _freeze_state(state), rip=branch_rip))
        if (branch.instructions or branch.boundary_rip != branch.rip
                or branch.boundary.operation != 'conditional_branch'):
            return block
        _following, _target, final_condition = branch.boundary.detail
        interim = DecodedBlock(
            block.rip, middle.rip, block.source + setcc.source,
            block.instructions + 2, first_plan, None, None, 1,
            middle.boundary, block.proof_config, block.proof,
            None, middle, first_inputs, True,
            any(node.op.startswith('memory.')
                for node in first_plan.nodes))
        final = self._predicate_plan(interim, final_condition)
        if final is None:
            return block
        plan, flag_cut, cut_inputs = final
        packed = pack_step(plan)
        mapped = unpack_step(packed)
        execute = self._bind_state_page(mapped, packed)
        source = block.source + setcc.source + middle.source + branch.source
        proof_config, proof = _execution_proof(
            state, block.rip, len(source))
        composed = DecodedBlock(
            block.rip, branch.rip, source, block.instructions + 3,
            plan, mapped, execute, 1, branch.boundary,
            proof_config, proof, flag_cut, branch, cut_inputs, True,
            any(node.op.startswith('memory.') for node in plan.nodes))
        proof_blocks = (block, setcc, middle, branch)
        self._predicate_cuts[block.rip] = proof_blocks, composed
        self.predicate_cuts += 1
        self.predicate_cut_cache_misses += 1
        self.predicate_cut_work += physical_work(plan)
        self.predicate_cut_span += plan.waves.span
        return composed

    def _compose_predicate_cut(self, state, block):
        """Compose flag production and Jcc only in the executable QM view.

        The decoded basic blocks remain intact as proof records for the loop
        and record reducers.  The executable view can therefore remove an
        internal scalar flag boundary without changing those proofs.
        """
        cached = self._predicate_cuts.get(block.rip)
        if (cached is not None and cached[0][0] is block
                and all(self.blocks.get(proved.rip) is proved
                        for proved in cached[0])):
            self.predicate_cut_cache_hits += 1
            return cached[1]

        detail = block.boundary.detail
        if (block.boundary.operation not in (
                'compare', 'immediate_alu', 'accumulator_test',
                'operand_test', 'memory_binary', 'register_result_flags',
                'register_immediate_result_flags')
                or not isinstance(detail, tuple) or not detail):
            return block
        following = int(detail[0]) & MASK64
        if block.rip + len(block.source) != following:
            return block
        control = self.blocks.get(following)
        if control is None:
            probe = replace(_freeze_state(state), rip=following)
            control = self.block(probe)
        if (control.rip != following or control.instructions
                or control.boundary_rip != following
                or control.boundary.operation != 'conditional_branch'):
            return block
        _next, _target, condition = control.boundary.detail
        built = self._predicate_plan(block, condition)
        if built is None:
            return block
        plan, flag_cut, cut_inputs = built
        packed = pack_step(plan)
        mapped = unpack_step(packed)
        execute = self._bind_state_page(mapped, packed)
        source = block.source + control.source
        proof_config, proof = _execution_proof(
            state, block.rip, len(source))
        composed = DecodedBlock(
            block.rip, control.rip, source, block.instructions + 1,
            plan, mapped, execute, 1, control.boundary,
            proof_config, proof, flag_cut, control, cut_inputs, True,
            any(node.op.startswith('memory.') for node in plan.nodes))
        self._predicate_cuts[block.rip] = (block, control), composed
        self.predicate_cuts += 1
        self.predicate_cut_cache_misses += 1
        self.predicate_cut_work += physical_work(plan)
        self.predicate_cut_span += plan.waves.span
        return composed

    def _collapse_fill_loop(self, state, branch):
        """Reduce one proven byte-fill induction loop to a direct page cut."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if cursor != branch.rip or len(loop) < 3:
            return state

        stores = []
        while loop and loop[0].boundary.operation == 'store':
            stores.append(loop.pop(0))
        if not stores or len(loop) != 2:
            return state
        update, compare = loop
        if update.boundary.operation != 'register_immediate_result_flags' \
                or compare.boundary.operation != 'compare':
            return state

        first = stores[0].boundary.detail
        _next, source, bits, operand = first
        if bits != 8 or not isinstance(operand, MemoryOperand) \
                or operand.rip_relative or operand.index is None \
                or operand.scale != 1:
            return state
        base = operand.base
        index = operand.index
        if base is None or source == index or base == index:
            return state
        displacements = []
        for store in stores:
            _next, candidate_source, candidate_bits, candidate = \
                store.boundary.detail
            if (candidate_source != source or candidate_bits != 8
                    or not isinstance(candidate, MemoryOperand)
                    or candidate.base != base or candidate.index != index
                    or candidate.scale != 1 or candidate.rip_relative):
                return state
            displacements.append(candidate.displacement)
        first_displacement = min(displacements)
        width = len(stores)
        if sorted(displacements) != list(range(
                first_displacement, first_displacement + width)):
            return state

        (_next, name, updated, update_bits,
         immediate) = update.boundary.detail
        if (name != 'add' or updated != index or immediate != width
                or update_bits not in (32, 64)):
            return state
        (_next, opcode, register, operand_register,
         compare_bits) = compare.boundary.detail
        if (opcode not in (0x39,) or register != index
                or not isinstance(operand_register, int)
                or compare_bits != update_bits):
            return state

        mask = (1 << compare_bits) - 1
        position = state.registers[index] & mask
        limit = state.registers[operand_register] & mask
        remaining = limit - position
        if remaining <= 0 or remaining % width:
            return state
        address = (state.registers[base] + position
                   + first_displacement) & MASK64
        value = _register_operand_value(state.registers, source, 8)
        state = fill_virtual(state, address, remaining, value)
        registers = _write_register(
            state.registers, index, limit, compare_bits)
        flags = _result_flags(
            state.rflags, 'cmp', limit, limit, 0, compare_bits)
        self.collapsed_fill_bytes += remaining
        self.collapsed_fill_iterations += remaining // width
        return replace(state, registers=registers, rip=following,
                       rflags=flags)

    def _collapse_repeat_store_loop(self, state, branch):
        """Reduce an invariant-pattern pointer loop to one physical repeat."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if cursor != branch.rip or len(loop) != 4:
            return state
        store, pointer_update, counter_update, compare = loop
        if (store.boundary.operation != 'store'
                or pointer_update.boundary.operation
                != 'register_immediate_result_flags'
                or counter_update.boundary.operation != 'group_ff'
                or compare.boundary.operation != 'compare'):
            return state

        _next, source, bits, operand = store.boundary.detail
        if (bits not in (8, 16, 32, 64)
                or not isinstance(operand, MemoryOperand)
                or operand.rip_relative or operand.base is None
                or operand.index is not None):
            return state
        pointer = operand.base
        width = bits // 8
        (_next, name, updated, update_bits,
         immediate) = pointer_update.boundary.detail
        if (name != 'add' or updated != pointer or immediate != width
                or update_bits != 64):
            return state
        _next, group, counter, counter_bits = counter_update.boundary.detail
        if (group != 0 or not isinstance(counter, int)
                or counter_bits not in (32, 64)):
            return state
        (_next, opcode, register, limit_register,
         compare_bits) = compare.boundary.detail
        if (opcode != 0x39 or register != counter
                or not isinstance(limit_register, int)
                or compare_bits != counter_bits):
            return state
        if len({pointer, counter, limit_register}) != 3 \
                or source in (pointer, counter, limit_register):
            return state

        mask = (1 << counter_bits) - 1
        position = state.registers[counter] & mask
        limit = state.registers[limit_register] & mask
        iterations = limit - position
        if iterations <= 0:
            return state
        byte_count = iterations * width
        address = (state.registers[pointer]
                   + operand.displacement) & MASK64
        value = _register_operand_value(state.registers, source, bits)
        pattern = int(value).to_bytes(width, 'little')
        state = repeat_virtual(state, address, byte_count, pattern)
        registers = _write_register(
            state.registers, pointer,
            state.registers[pointer] + byte_count, 64)
        registers = _write_register(
            registers, counter, limit, counter_bits)
        flags = _result_flags(
            state.rflags, 'cmp', limit, limit, 0, compare_bits)
        self.collapsed_repeat_bytes += byte_count
        self.collapsed_repeat_iterations += iterations
        return replace(state, registers=registers, rip=following,
                       rflags=flags)

    def _collapse_counted_repeat_loop(self, state, branch):
        """Collapse dec/store/lea/jne loops after their first proven turn."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if cursor != branch.rip:
            return state

        # A single store leaves the pointer LEA in the same decoded block as
        # JNE. It has already executed when this reducer sees the taken edge,
        # so normalize the remaining count from that post-iteration state.
        if len(loop) == 2:
            counter_update, store = loop
            source = branch.source
            lea = source[:-2]
            if (len(source) < 6 or source[-2] != 0x75
                    or len(lea) not in (4, 7)
                    or lea[:2] != b'\x48\x8d'):
                return state
            modrm = lea[2]
            mode = modrm >> 6
            pointer = (modrm >> 3) & 7
            base = modrm & 7
            if (mode not in (1, 2) or base == 4 or pointer != base):
                return state
            displacement = _signed_integer(
                int.from_bytes(lea[3:], 'little'), 8 if mode == 1 else 32)
            if displacement <= 0:
                return state
            if counter_update.boundary.operation != 'group_ff' \
                    or store.boundary.operation != 'store':
                return state
            _next, group, counter, counter_bits = \
                counter_update.boundary.detail
            _next, stored, bits, operand = store.boundary.detail
            width = bits // 8
            if (group != 1 or counter_bits not in (32, 64)
                    or not isinstance(counter, int)
                    or bits not in (8, 16, 32, 64)
                    or not isinstance(operand, MemoryOperand)
                    or operand.base != pointer or operand.index is not None
                    or operand.rip_relative
                    or operand.segment_msr is not None
                    or displacement != width
                    or stored in (pointer, counter)
                    or pointer == counter):
                return state
            iterations = state.registers[counter] \
                & ((1 << counter_bits) - 1)
            if not iterations:
                return state
            byte_count = iterations * width
            address = (state.registers[pointer]
                       + operand.displacement) & MASK64
            value = _register_operand_value(
                state.registers, stored, bits)
            state = repeat_virtual(
                state, address, byte_count,
                int(value).to_bytes(width, 'little'))
            registers = _write_register(
                state.registers, counter, 0, counter_bits)
            registers = _write_register(
                registers, pointer,
                state.registers[pointer] + byte_count, 64)
            flags = _result_flags(
                state.rflags, 'sub', 1, 1, 0, counter_bits,
                preserve_carry=True)
            self.collapsed_repeat_bytes += byte_count
            self.collapsed_repeat_iterations += iterations
            return replace(state, registers=registers, rip=following,
                           rflags=flags)
        if len(loop) < 3:
            return state

        counter_update, *body, pointer_update = loop
        if (counter_update.boundary.operation != 'group_ff'
                or pointer_update.boundary.operation != 'lea'):
            return state
        _next, group, counter, counter_bits = \
            counter_update.boundary.detail
        if (group != 1 or not isinstance(counter, int)
                or counter_bits not in (32, 64)):
            return state

        stores = body
        if not stores or any(
                block.boundary.operation != 'store' for block in stores):
            return state
        _next, source, bits, first_operand = stores[0].boundary.detail
        if (bits not in (8, 16, 32, 64)
                or not isinstance(first_operand, MemoryOperand)
                or first_operand.rip_relative
                or first_operand.segment_msr is not None
                or first_operand.base is None
                or first_operand.index is not None):
            return state
        pointer = first_operand.base
        if source in (pointer, counter) or pointer == counter:
            return state
        width = bits // 8
        displacements = []
        for store in stores:
            (_next, candidate_source, candidate_bits,
             candidate) = store.boundary.detail
            if (candidate_source != source or candidate_bits != bits
                    or not isinstance(candidate, MemoryOperand)
                    or candidate.base != pointer
                    or candidate.index is not None
                    or candidate.rip_relative
                    or candidate.segment_msr is not None):
                return state
            displacements.append(candidate.displacement)
        first_displacement = min(displacements)
        iteration_bytes = len(stores) * width
        if sorted(displacements) != list(range(
                first_displacement,
                first_displacement + iteration_bytes, width)):
            return state

        (_next, updated_pointer, pointer_bits,
         pointer_operand) = pointer_update.boundary.detail
        if (updated_pointer != pointer or pointer_bits != 64
                or pointer_operand.base != pointer
                or pointer_operand.index is not None
                or pointer_operand.rip_relative
                or pointer_operand.segment_msr is not None
                or pointer_operand.displacement != iteration_bytes):
            return state

        iterations = state.registers[counter] & ((1 << counter_bits) - 1)
        if not iterations:
            return state
        byte_count = iterations * iteration_bytes
        address = (state.registers[pointer]
                   + first_displacement) & MASK64
        value = _register_operand_value(state.registers, source, bits)
        pattern = int(value).to_bytes(width, 'little')
        state = repeat_virtual(state, address, byte_count, pattern)
        registers = _write_register(
            state.registers, counter, 0, counter_bits)
        registers = _write_register(
            registers, pointer,
            state.registers[pointer] + byte_count, 64)
        flags = _result_flags(
            state.rflags, 'sub', 1, 1, 0, counter_bits,
            preserve_carry=True)
        self.collapsed_repeat_bytes += byte_count
        self.collapsed_repeat_iterations += iterations
        return replace(state, registers=registers, rip=following,
                       rflags=flags)

    def _counted_repeat_cut(self, state, branch):
        """Compile a counted contiguous-store backedge to one state page."""
        cached = self._recurrence_cuts.get(branch.rip)
        if cached is not None and cached[0] is branch:
            self.recurrence_cut_cache_hits += 1
            return cached[1]

        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return None
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return None
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return None
            loop.append(block)
            cursor = end
        if cursor != branch.rip or len(loop) < 3:
            self._recurrence_cuts[branch.rip] = branch, None
            self.recurrence_cut_cache_misses += 1
            return None

        counter_update, *stores, pointer_update = loop
        if (counter_update.boundary.operation != 'group_ff'
                or pointer_update.boundary.operation != 'lea'
                or not stores
                or any(block.boundary.operation != 'store'
                       for block in stores)):
            self._recurrence_cuts[branch.rip] = branch, None
            self.recurrence_cut_cache_misses += 1
            return None
        _next, group, counter, counter_bits = \
            counter_update.boundary.detail
        _next, source, bits, first_operand = stores[0].boundary.detail
        if (group != 1 or not isinstance(counter, int)
                or counter_bits not in (32, 64)
                or bits not in (8, 16, 32, 64)
                or not isinstance(source, int)
                or not isinstance(first_operand, MemoryOperand)
                or first_operand.rip_relative
                or first_operand.segment_msr is not None
                or first_operand.base is None
                or first_operand.index is not None):
            self._recurrence_cuts[branch.rip] = branch, None
            self.recurrence_cut_cache_misses += 1
            return None
        pointer = first_operand.base
        if source in (pointer, counter) or pointer == counter:
            self._recurrence_cuts[branch.rip] = branch, None
            self.recurrence_cut_cache_misses += 1
            return None
        width = bits // 8
        displacements = []
        for store in stores:
            (_next, candidate_source, candidate_bits,
             candidate) = store.boundary.detail
            if (candidate_source != source or candidate_bits != bits
                    or not isinstance(candidate, MemoryOperand)
                    or candidate.base != pointer
                    or candidate.index is not None
                    or candidate.rip_relative
                    or candidate.segment_msr is not None):
                self._recurrence_cuts[branch.rip] = branch, None
                self.recurrence_cut_cache_misses += 1
                return None
            displacements.append(candidate.displacement)
        first_displacement = min(displacements)
        iteration_bytes = len(stores) * width
        if sorted(displacements) != list(range(
                first_displacement,
                first_displacement + iteration_bytes, width)):
            self._recurrence_cuts[branch.rip] = branch, None
            self.recurrence_cut_cache_misses += 1
            return None
        (_next, updated_pointer, pointer_bits,
         pointer_operand) = pointer_update.boundary.detail
        if (updated_pointer != pointer or pointer_bits != 64
                or pointer_operand.base != pointer
                or pointer_operand.index is not None
                or pointer_operand.rip_relative
                or pointer_operand.segment_msr is not None
                or pointer_operand.displacement != iteration_bytes):
            self._recurrence_cuts[branch.rip] = branch, None
            self.recurrence_cut_cache_misses += 1
            return None

        locals_ = [Operand('local', index)
                   for index in range(len(REGISTER_NAMES) + 1)]
        nodes = []

        def emit(operation, arguments):
            arguments = tuple(arguments)
            if operation.startswith(('i32.', 'i64.')):
                operation, arguments = select_lane(operation, arguments)
            value = len(nodes) + 1
            nodes.append(WaveNode(value, operation, arguments))
            return Operand('node', value)

        count = locals_[counter]
        if counter_bits == 32:
            count = emit('i64.and', (count, Operand('const', MASK32)))
        byte_count = emit('i64.mul', (
            count, Operand('const', iteration_bytes)))
        address = emit('i64.add', (
            locals_[pointer], Operand('const', first_displacement)))
        value = locals_[source]
        if bits < 64:
            value = emit('i64.and', (
                value, Operand('const', (1 << bits) - 1)))
        emit('memory.i64.repeat', (
            address, value, byte_count,
            Operand('const', memory_shape(width, virtual64=True))))
        locals_[pointer] = emit('i64.add', (
            locals_[pointer], byte_count))
        locals_[counter] = Operand('const', 0)
        descriptor = counter_bits | (3 << 8) | (1 << 11)
        flags = emit('lane64.X86_FLAGS', (
            locals_[len(REGISTER_NAMES)], Operand('const', 1),
            Operand('const', 1), Operand('const', 0),
            Operand('const', descriptor)))
        plan = normalize_plan(PureSlice(
            0, 0, len(loop) + 1, len(loop) + 1, 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (),
            tuple(locals_[:len(REGISTER_NAMES)]) + (flags,)))
        packed = pack_step(plan)
        mapped = unpack_step(packed)
        execute = self._bind_state_page(mapped, packed)
        cut = DecodedBlock(
            target, branch.rip,
            b''.join(block.source for block in loop) + branch.source,
            len(loop) + 1, plan, mapped, execute, 0,
            X86Boundary('branch', following),
            branch.proof_config, branch.proof,
            state_flags=True, virtual_memory=True)
        # ``instructions`` excludes each block's terminal instruction.  The
        # recurrence starts after one normally dispatched turn, so this is
        # exactly the x86 retirement carried by every residual iteration.
        source_instructions = (
            sum(block.instructions + 1 for block in loop)
            + branch.instructions + 1)
        entry = cut, counter, iteration_bytes, source_instructions
        self._recurrence_cuts[branch.rip] = branch, entry
        self.recurrence_cuts += 1
        self.recurrence_cut_cache_misses += 1
        self.recurrence_cut_work += physical_work(plan)
        self.recurrence_cut_span += plan.waves.span
        return entry

    def _collapse_copy_loop(self, state, branch):
        """Reduce a proven unrolled byte-copy loop to one direct memory cut."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if cursor != branch.rip or len(loop) < 4:
            return state

        def byte_load(block):
            operation = block.boundary.operation
            detail = block.boundary.detail
            if operation == 'load':
                _next, register, bits, operand = detail
                return (register, operand) if bits == 8 else None
            if operation == 'move_zero_extend':
                (_next, register, source_bits,
                 target_bits, operand) = detail
                if source_bits == 8 and target_bits in (32, 64):
                    return register, operand
            return None

        pairs = []
        while (len(loop) >= 2
               and byte_load(loop[0]) is not None
               and loop[1].boundary.operation == 'store'):
            pairs.append((loop.pop(0), loop.pop(0)))
        if not pairs or len(loop) != 2:
            return state
        update, compare = loop
        if update.boundary.operation != 'register_immediate_result_flags' \
                or compare.boundary.operation != 'compare':
            return state

        temporary, source_operand = byte_load(pairs[0][0])
        (_next, stored, store_bits,
         target_operand) = pairs[0][1].boundary.detail
        if (store_bits != 8 or stored != temporary
                or not isinstance(source_operand, MemoryOperand)
                or not isinstance(target_operand, MemoryOperand)):
            return state
        index = source_operand.index
        source_base = source_operand.base
        target_base = target_operand.base
        if (index is None or source_base is None or target_base is None
                or source_operand.scale != 1 or target_operand.scale != 1
                or source_operand.rip_relative
                or target_operand.rip_relative
                or len({index, source_base, target_base}) != 3):
            return state

        displacements = []
        for load, store in pairs:
            loaded, candidate_source = byte_load(load)
            (_next, candidate_stored, candidate_bits,
             candidate_target) = store.boundary.detail
            if (loaded != temporary or candidate_stored != temporary
                    or candidate_bits != 8
                    or not isinstance(candidate_source, MemoryOperand)
                    or not isinstance(candidate_target, MemoryOperand)
                    or candidate_source.base != source_base
                    or candidate_source.index != index
                    or candidate_source.scale != 1
                    or candidate_source.rip_relative
                    or candidate_target.base != target_base
                    or candidate_target.index != index
                    or candidate_target.scale != 1
                    or candidate_target.rip_relative
                    or candidate_target.displacement
                    != candidate_source.displacement):
                return state
            displacements.append(candidate_source.displacement)
        first_displacement = min(displacements)
        width = len(pairs)
        if sorted(displacements) != list(range(
                first_displacement, first_displacement + width)):
            return state

        (_next, name, updated, update_bits,
         immediate) = update.boundary.detail
        if (name != 'add' or updated != index or immediate != width
                or update_bits not in (32, 64)):
            return state
        (_next, opcode, register, limit_register,
         compare_bits) = compare.boundary.detail
        if (opcode != 0x39 or register != index
                or not isinstance(limit_register, int)
                or compare_bits not in (32, 64)
                or compare_bits > update_bits
                or limit_register in (source_base, target_base)):
            return state

        mask = (1 << compare_bits) - 1
        position = state.registers[index] & mask
        limit = state.registers[limit_register] & mask
        remaining = limit - position
        if remaining <= 0 or remaining % width:
            return state
        source = (state.registers[source_base] + position
                  + first_displacement) & MASK64
        target_address = (state.registers[target_base] + position
                          + first_displacement) & MASK64
        state = copy_forward_virtual(state, source, target_address, remaining)
        registers = _write_register(
            state.registers, index, limit, update_bits)
        flags = _result_flags(
            state.rflags, 'cmp', limit, limit, 0, compare_bits)
        self.collapsed_copy_bytes += remaining
        self.collapsed_copy_iterations += remaining // width
        return replace(state, registers=registers, rip=following,
                       rflags=flags)

    def _collapse_wide_copy_loop(self, state, branch):
        """Reduce a bounded multiword copy loop to one direct memory cut."""
        following, target, condition = branch.boundary.detail
        if condition != 3 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if cursor != branch.rip or len(loop) < 6:
            return state

        counter_update = loop.pop(0)
        if counter_update.boundary.operation \
                != 'register_immediate_result_flags':
            return state
        (_counter_next, counter_name, counter, counter_bits,
         chunk_bytes) = counter_update.boundary.detail
        if (counter_name != 'sub' or not isinstance(counter, int)
                or counter_bits not in (32, 64) or chunk_bytes <= 0):
            return state

        loads = []
        while loop and loop[0].boundary.operation == 'load':
            loads.append(loop.pop(0))
        if not loads or not loop or loop[0].boundary.operation != 'lea':
            return state
        source_update = loop.pop(0)
        stores = []
        while loop and loop[0].boundary.operation == 'store':
            stores.append(loop.pop(0))
        if (len(stores) != len(loads) or len(loop) != 1
                or loop[0].boundary.operation != 'lea'):
            return state
        target_update = loop[0]

        (_load_next, first_temporary, word_bits,
         first_source) = loads[0].boundary.detail
        if (word_bits not in (32, 64)
                or not isinstance(first_source, MemoryOperand)
                or first_source.base is None
                or first_source.index is not None
                or first_source.rip_relative
                or first_source.segment_msr is not None):
            return state
        source_pointer = first_source.base
        first_target = stores[0].boundary.detail[3]
        if not isinstance(first_target, MemoryOperand):
            return state
        target_pointer = first_target.base
        word_bytes = word_bits // 8
        temporaries = []
        displacements = []
        for load, store in zip(loads, stores):
            (_next, temporary, bits, source_operand) = \
                load.boundary.detail
            (_next, stored, store_bits, target_operand) = \
                store.boundary.detail
            if (bits != word_bits or store_bits != word_bits
                    or stored != temporary
                    or not isinstance(source_operand, MemoryOperand)
                    or not isinstance(target_operand, MemoryOperand)
                    or source_operand.base != source_pointer
                    or source_operand.index is not None
                    or source_operand.rip_relative
                    or source_operand.segment_msr is not None
                    or target_operand.base != target_pointer
                    or target_operand.index is not None
                    or target_operand.rip_relative
                    or target_operand.segment_msr is not None
                    or target_operand.displacement
                    != source_operand.displacement):
                return state
            temporaries.append(temporary)
            displacements.append(source_operand.displacement)
        if (target_pointer is None or source_pointer == target_pointer
                or len(set(temporaries)) != len(temporaries)
                or counter in temporaries
                or source_pointer in temporaries
                or target_pointer in temporaries):
            return state
        if sorted(displacements) != list(range(
                min(displacements),
                min(displacements) + len(loads) * word_bytes,
                word_bytes)):
            return state
        if len(loads) * word_bytes != chunk_bytes:
            return state

        def pointer_induction(block, register):
            _next, updated, bits, operand = block.boundary.detail
            return (updated == register and bits == 64
                    and isinstance(operand, MemoryOperand)
                    and operand.base == register and operand.index is None
                    and operand.displacement == chunk_bytes
                    and not operand.rip_relative
                    and operand.segment_msr is None)

        if (not pointer_induction(source_update, source_pointer)
                or not pointer_induction(target_update, target_pointer)):
            return state

        mask = (1 << counter_bits) - 1
        remaining = state.registers[counter] & mask
        total_iterations = remaining // chunk_bytes + 1
        iterations = min(total_iterations,
                         max(1, (1 << 20) // chunk_bytes))
        byte_count = iterations * chunk_bytes
        source_address = (state.registers[source_pointer]
                          + min(displacements)) & MASK64
        target_address = (state.registers[target_pointer]
                          + min(displacements)) & MASK64
        if (source_address != target_address
                and not (target_address + byte_count <= source_address
                         or source_address + byte_count <= target_address)):
            return state
        final_source = source_address + byte_count - chunk_bytes
        final_values = read_virtual(
            state, final_source, chunk_bytes)
        state = copy_forward_virtual(
            state, source_address, target_address, byte_count)
        registers = state.registers
        for offset, temporary in enumerate(temporaries):
            value = int.from_bytes(
                final_values[offset * word_bytes:(offset + 1) * word_bytes],
                'little')
            registers = _write_register(
                registers, temporary, value, word_bits)
        registers = _write_register(
            registers, source_pointer,
            state.registers[source_pointer] + byte_count, 64)
        registers = _write_register(
            registers, target_pointer,
            state.registers[target_pointer] + byte_count, 64)
        final_counter = (remaining - iterations * chunk_bytes) & mask
        registers = _write_register(
            registers, counter, final_counter, counter_bits)
        if iterations == total_iterations:
            prior_counter = (final_counter + chunk_bytes) & mask
            rip = following
        else:
            prior_counter = (remaining - (iterations - 1)
                             * chunk_bytes) & mask
            rip = target
        flags = _result_flags(
            state.rflags, 'sub', prior_counter, chunk_bytes,
            final_counter, counter_bits)
        self.collapsed_copy_bytes += byte_count
        self.collapsed_copy_iterations += iterations
        return replace(state, registers=registers, rip=rip,
                       rflags=flags)

    def _collapse_strided_store_loop(self, state, branch):
        """Write one invariant lane across a bounded record array."""
        following, target, condition = branch.boundary.detail
        if condition != 12 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if (cursor != branch.rip or len(loop) != 6
                or tuple(block.boundary.operation for block in loop) != (
                    'load', 'store', 'group_ff', 'move_sign_extend',
                    'register_immediate_result_flags', 'compare')):
            return state
        data_load, store, counter_update, limit_load, offset_update, compare = \
            loop
        (_data_next, data_register, data_bits,
         data_operand) = data_load.boundary.detail
        (_store_next, source, store_bits,
         store_operand) = store.boundary.detail
        (_counter_next, counter_group,
         counter, counter_bits) = counter_update.boundary.detail
        (_limit_next, limit_register, source_bits,
         limit_bits, limit_operand) = limit_load.boundary.detail
        (_offset_next, offset_name, offset_register,
         offset_bits, stride) = offset_update.boundary.detail
        (_compare_next, opcode, compared_limit,
         compared_counter, compare_bits) = compare.boundary.detail
        if (data_bits != 64 or not isinstance(data_operand, MemoryOperand)
                or data_operand.base is None or data_operand.index is not None
                or data_operand.rip_relative
                or data_operand.segment_msr is not None
                or not isinstance(store_operand, MemoryOperand)
                or store_bits not in (32, 64)
                or store_operand.base != data_register
                or store_operand.index != offset_register
                or store_operand.scale != 1
                or store_operand.rip_relative
                or store_operand.segment_msr is not None
                or counter_group != 0 or counter_bits != 64
                or source_bits != 32 or limit_bits != 64
                or not isinstance(limit_operand, MemoryOperand)
                or limit_operand.base != data_operand.base
                or limit_operand.index is not None
                or limit_operand.rip_relative
                or limit_operand.segment_msr is not None
                or offset_name != 'add' or offset_bits != 64
                or stride <= 0 or stride < store_bits // 8
                or opcode != 0x39 or compared_limit != limit_register
                or compared_counter != counter or compare_bits != 64
                or len({source, counter, offset_register}) != 3):
            return state

        position = state.registers[counter] & MASK64
        limit = load_virtual(
            state, limit_operand.address(state, limit_load.boundary.detail[0]),
            4)
        if position >= limit:
            return state
        iterations = min(limit - position, 1 << 16)
        data = load_virtual(
            state, data_operand.address(state, data_load.boundary.detail[0]),
            8)
        lane = state.registers[offset_register] & MASK64
        value = _register_operand_value(
            state.registers, source, store_bits)
        payload = int(value).to_bytes(store_bits // 8, 'little')
        for offset in range(iterations):
            state = write_virtual(
                state, data + lane + store_operand.displacement
                + offset * stride, payload)

        final_position = position + iterations
        final_lane = lane + iterations * stride
        registers = _write_register(
            state.registers, counter, final_position, 64)
        registers = _write_register(
            registers, offset_register, final_lane, 64)
        registers = _write_register(
            registers, data_register, limit, 64)
        registers = _write_register(
            registers, limit_register, limit, 64)
        flags = _result_flags(
            state.rflags, 'cmp', final_position, limit,
            (final_position - limit) & MASK64, 64)
        self.collapsed_strided_store_bytes += len(payload) * iterations
        self.collapsed_strided_store_iterations += iterations
        return replace(state, registers=registers, rflags=flags,
                       rip=following if final_position == limit else target)

    def _collapse_strided_multiply_loop(self, state, branch):
        """Map an unrolled in-place word multiply to physical record SSA."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        operations = tuple(block.boundary.operation for block in loop)
        if cursor != branch.rip or operations != (
                'load', 'load', 'multiply', 'store',
                'load', 'load', 'multiply', 'store',
                'register_immediate_result_flags', 'compare'):
            return state
        pointer0, data0, multiply0, store0, pointer1, data1, \
            multiply1, store1, update, compare = loop
        (_next, pointer, pointer_bits,
         pointer_operand) = pointer0.boundary.detail
        (_next, first_data, data_bits,
         first_operand) = data0.boundary.detail
        (_next, first_product, first_multiplier,
         multiply_bits) = multiply0.boundary.detail
        (_next, first_store, first_store_bits,
         first_target) = store0.boundary.detail
        (_next, second_pointer, second_pointer_bits,
         second_pointer_operand) = pointer1.boundary.detail
        (_next, second_data, second_bits,
         second_operand) = data1.boundary.detail
        (_next, second_product, second_multiplier,
         second_multiply_bits) = multiply1.boundary.detail
        (_next, second_store, second_store_bits,
         second_target) = store1.boundary.detail
        (_next, update_name, counter, counter_bits,
         induction) = update.boundary.detail
        (_next, opcode, compared, limit,
         compare_bits) = compare.boundary.detail

        operands = (pointer_operand, first_operand, first_multiplier,
                    first_target, second_pointer_operand, second_operand,
                    second_multiplier, second_target)
        if any(not isinstance(operand, MemoryOperand)
               for operand in operands):
            return state
        word_bytes = data_bits // 8
        if (pointer_bits != 64 or second_pointer != pointer
                or second_pointer_bits != 64
                or second_pointer_operand != pointer_operand
                or pointer_operand.base is None
                or pointer_operand.index is not None
                or pointer_operand.rip_relative
                or pointer_operand.segment_msr is not None
                or data_bits not in (32, 64)
                or second_bits != data_bits
                or multiply_bits != data_bits
                or second_multiply_bits != data_bits
                or first_store_bits != data_bits
                or second_store_bits != data_bits
                or len({first_data, second_data, first_product,
                        second_product, first_store, second_store}) != 1
                or first_operand.base != pointer
                or second_operand.base != pointer
                or first_operand.index != counter
                or second_operand.index != counter
                or first_operand.scale != word_bytes
                or second_operand.scale != word_bytes
                or first_operand.displacement != 0
                or second_operand.displacement != word_bytes
                or first_target != first_operand
                or second_target != second_operand
                or first_multiplier != second_multiplier
                or first_multiplier.base != pointer_operand.base
                or first_multiplier.index is not None
                or first_multiplier.rip_relative
                or first_multiplier.segment_msr is not None
                or update_name != 'add' or counter_bits != 64
                or induction != 2 or opcode != 0x39
                or compared != counter or not isinstance(limit, int)
                or compare_bits != 64):
            return state

        position = state.registers[counter] & MASK64
        bound = state.registers[limit] & MASK64
        remaining = bound - position
        if remaining < 2 or remaining & 1:
            return state
        iterations = min(remaining // 2, 1 << 16)
        words = iterations * 2
        try:
            array = load_virtual(
                state, pointer_operand.address(
                    state, pointer0.boundary.detail[0]), 8)
            multiplier = load_virtual(
                state, first_multiplier.address(
                    state, multiply0.boundary.detail[0]), word_bytes)
            state = multiply_virtual_records(
                state, array + position * word_bytes,
                words, word_bytes, 0, word_bytes, multiplier)
            final_word = load_virtual(
                state, array + (position + words - 1) * word_bytes,
                word_bytes)
        except (PageFault, ValueError):
            return state

        final_position = position + words
        registers = _write_register(
            state.registers, pointer, array, 64)
        registers = _write_register(
            registers, first_data, final_word, data_bits)
        registers = _write_register(
            registers, counter, final_position, 64)
        result = (bound - final_position) & MASK64
        flags = _result_flags(
            state.rflags, 'cmp', bound, final_position, result, 64)
        self.collapsed_record_multiply_words += words
        return replace(
            state, registers=registers, rflags=flags,
            rip=following if final_position == bound else target)

    def _collapse_sequential_freelist_loop(self, state, branch):
        """Project an encoded fixed-stride link chain without scalar stores."""
        following, target, condition = branch.boundary.detail
        if condition != 12 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if (cursor != branch.rip
                or tuple(block.boundary.operation for block in loop) != (
                    'load', 'lea', 'load', 'compare',
                    'conditional_branch', 'compare', 'conditional_branch',
                    'load', 'lea', 'load', 'register_result_flags',
                    'register_result_flags', 'store', 'group_ff',
                    'move_zero_extend', 'immediate_alu', 'group_ff',
                    'compare')):
            return state
        (stride_load, next_address, hook_load, hook_test, hook_branch,
         stride_test, zero_branch, offset_load, slot_address, secret_load,
         xor_next, xor_slot, store, increment, object_load, mask_object,
         decrement, compare) = loop
        (_next, stride_register, stride_bits,
         stride_operand) = stride_load.boundary.detail
        (_next, next_register, next_bits,
         next_operand) = next_address.boundary.detail
        (_next, hook_register, hook_bits,
         hook_operand) = hook_load.boundary.detail
        (_next, hook_opcode, hook_left,
         hook_right, hook_compare_bits) = hook_test.boundary.detail
        (_next, _hook_target,
         hook_condition) = hook_branch.boundary.detail
        (_next, stride_opcode, stride_left,
         stride_right, stride_compare_bits) = stride_test.boundary.detail
        (_next, _zero_target,
         zero_condition) = zero_branch.boundary.detail
        (_next, offset_register, offset_bits,
         offset_operand) = offset_load.boundary.detail
        (_next, slot_register, slot_bits,
         slot_operand) = slot_address.boundary.detail
        (_next, secret_register, secret_bits,
         secret_operand) = secret_load.boundary.detail
        (_next, xor_next_name, xor_next_target,
         xor_next_source, xor_next_bits) = xor_next.boundary.detail
        (_next, xor_slot_name, xor_slot_target,
         xor_slot_source, xor_slot_bits) = xor_slot.boundary.detail
        (_next, stored_register, store_bits,
         store_operand) = store.boundary.detail
        (_next, increment_group, counter,
         counter_bits) = increment.boundary.detail
        (_next, object_register, object_source_bits,
         object_bits, object_operand) = object_load.boundary.detail
        (_next, mask_name, masked_register,
         mask_bits, object_mask) = mask_object.boundary.detail
        (_next, decrement_group, decrement_register,
         decrement_bits) = decrement.boundary.detail
        (_next, compare_opcode, compared_limit,
         compared_counter, compare_bits) = compare.boundary.detail

        operands = (stride_operand, next_operand, hook_operand,
                    offset_operand, slot_operand, secret_operand,
                    store_operand, object_operand)
        if any(not isinstance(operand, MemoryOperand)
               for operand in operands):
            return state
        metadata = stride_operand.base
        current = next_operand.base
        if (stride_bits != 32 or metadata is None
                or stride_operand.index is not None
                or stride_operand.rip_relative
                or stride_operand.segment_msr is not None
                or next_bits != 64 or current is None
                or next_operand.index != stride_register
                or next_operand.scale != 1
                or next_operand.displacement != 0
                or next_operand.rip_relative
                or next_operand.segment_msr is not None
                or hook_bits != 64 or hook_operand.base != metadata
                or hook_operand.index is not None
                or hook_operand.rip_relative
                or hook_operand.segment_msr is not None
                or hook_opcode != 0x85 or hook_left != hook_register
                or hook_right != hook_register or hook_compare_bits != 64
                or hook_condition != 5
                or stride_opcode != 0x85
                or stride_left != stride_register
                or stride_right != stride_register
                or stride_compare_bits != 32 or zero_condition != 4
                or offset_bits != 32 or offset_operand.base != metadata
                or offset_operand.index is not None
                or offset_operand.rip_relative
                or offset_operand.segment_msr is not None
                or slot_bits != 64 or slot_operand.base != offset_register
                or slot_operand.index != current
                or slot_operand.scale != 1
                or slot_operand.displacement != 0
                or secret_bits != 64 or secret_operand.base != metadata
                or secret_operand.index is not None
                or secret_operand.rip_relative
                or secret_operand.segment_msr is not None
                or xor_next_name != 'xor'
                or xor_next_target != secret_register
                or xor_next_source != next_register
                or xor_next_bits != 64
                or xor_slot_name != 'xor'
                or xor_slot_target != secret_register
                or xor_slot_source != slot_register
                or xor_slot_bits != 64
                or stored_register != secret_register or store_bits != 64
                or store_operand.base != offset_register
                or store_operand.index != current
                or store_operand.scale != 1
                or store_operand.displacement != 0
                or increment_group != 0 or counter_bits != 32
                or object_source_bits != 16 or object_bits != 32
                or object_operand.base is None
                or object_operand.index is not None
                or object_operand.rip_relative
                or object_operand.segment_msr is not None
                or mask_name != 'and' or masked_register != object_register
                or mask_bits != 32 or object_mask != 0x7fff
                or decrement_group != 1
                or decrement_register != object_register
                or decrement_bits != 32 or offset_register != object_register
                or compare_opcode != 0x39
                or compared_limit != object_register
                or compared_counter != counter or compare_bits != 32
                or not compare.source.startswith(b'\x4d\x89\xfc')):
            return state

        try:
            stride = load_virtual(
                state, stride_operand.address(
                    state, stride_load.boundary.detail[0]), 4)
            hook = load_virtual(
                state, hook_operand.address(
                    state, hook_load.boundary.detail[0]), 8)
            offset = load_virtual(
                state, offset_operand.address(
                    state, offset_load.boundary.detail[0]), 4)
            secret = load_virtual(
                state, secret_operand.address(
                    state, secret_load.boundary.detail[0]), 8)
            objects = load_virtual(
                state, object_operand.address(
                    state, object_load.boundary.detail[0]), 2) & 0x7fff
        except PageFault:
            return state
        position = state.registers[counter] & MASK32
        limit = (objects - 1) & MASK32
        if (hook or not stride or objects < 2 or position >= limit
                or offset + 8 > stride):
            return state
        iterations = min(limit - position, 1 << 16)
        first = state.registers[current] & MASK64

        def byte_swap(value):
            return int.from_bytes(
                int(value & MASK64).to_bytes(8, 'little'), 'big')

        values = tuple(
            (secret
             ^ ((first + (index + 1) * stride) & MASK64)
             ^ byte_swap(first + index * stride + offset)) & MASK64
            for index in range(iterations))
        try:
            state = store_virtual_record_values(
                state, first, iterations, stride, offset, 8, values)
        except (PageFault, ValueError):
            return state

        final_counter = position + iterations
        last_record = (first + (iterations - 1) * stride) & MASK64
        final_current = (first + iterations * stride) & MASK64
        final_slot = byte_swap(last_record + offset)
        registers = _write_register(
            state.registers, stride_register, stride, 32)
        registers = _write_register(
            registers, next_register, final_current, 64)
        registers = _write_register(registers, hook_register, 0, 64)
        registers = _write_register(registers, slot_register, final_slot, 64)
        registers = _write_register(
            registers, secret_register, values[-1], 64)
        registers = _write_register(
            registers, counter, final_counter, 32)
        registers = _write_register(
            registers, object_register, limit, 32)
        registers = _write_register(
            registers, current, final_current, 64)
        result = (final_counter - limit) & MASK32
        flags = _result_flags(
            state.rflags, 'cmp', final_counter, limit, result, 32)
        self.collapsed_sequential_freelist_links += iterations
        return replace(
            state, registers=registers, rflags=flags,
            rip=following if final_counter >= limit else target)

    def _collapse_random_freelist_loop(self, state, branch):
        """Join selected random coordinates into one encoded link scatter."""
        following, target, condition = branch.boundary.detail
        if condition != 2 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if (cursor != branch.rip
                or tuple(block.boundary.operation for block in loop) != (
                    'load', 'load', 'group_ff', 'compare',
                    'conditional_move', 'compare', 'conditional_branch',
                    'register_result_flags', 'load', 'compare',
                    'conditional_branch', 'compare', 'conditional_branch',
                    'load', 'lea', 'load', 'register_result_flags',
                    'register_result_flags', 'store', 'group_ff',
                    'move_zero_extend', 'immediate_alu', 'compare')):
            return state
        (sequence_load, value_load, position_increment, wrap_compare,
         wrap_move, limit_compare, reject_branch, add_start, hook_load,
         hook_test, hook_branch, duplicate_compare, duplicate_branch,
         offset_load, slot_address, secret_load, xor_next, xor_slot,
         store, counter_increment, object_load, mask_object,
         compare) = loop
        (_next, sequence_register, sequence_bits,
         sequence_operand) = sequence_load.boundary.detail
        (_next, value_register, value_bits,
         value_operand) = value_load.boundary.detail
        (_next, position_group, position,
         position_bits) = position_increment.boundary.detail
        (_next, wrap_opcode, count_register,
         compared_position, wrap_bits) = wrap_compare.boundary.detail
        (_next, wrap_condition, wrap_target,
         zero_register, wrap_move_bits) = wrap_move.boundary.detail
        (_next, limit_opcode, compared_value,
         page_limit_register, limit_bits) = limit_compare.boundary.detail
        (reject_following, reject_target,
         reject_condition) = reject_branch.boundary.detail
        (_next, add_name, added_register,
         start_register, add_bits) = add_start.boundary.detail
        (_next, hook_register, hook_bits,
         hook_operand) = hook_load.boundary.detail
        (_next, hook_opcode, hook_left,
         hook_right, hook_compare_bits) = hook_test.boundary.detail
        (_next, _hook_target,
         hook_condition) = hook_branch.boundary.detail
        (_next, duplicate_opcode, next_register,
         current_register, duplicate_bits) = duplicate_compare.boundary.detail
        (_next, _duplicate_target,
         duplicate_condition) = duplicate_branch.boundary.detail
        (_next, offset_register, offset_bits,
         offset_operand) = offset_load.boundary.detail
        (_next, slot_register, slot_bits,
         slot_operand) = slot_address.boundary.detail
        (_next, secret_register, secret_bits,
         secret_operand) = secret_load.boundary.detail
        (_next, xor_next_name, xor_next_target,
         xor_next_source, xor_next_bits) = xor_next.boundary.detail
        (_next, xor_slot_name, xor_slot_target,
         xor_slot_source, xor_slot_bits) = xor_slot.boundary.detail
        (_next, stored_register, store_bits,
         store_operand) = store.boundary.detail
        (_next, counter_group, counter,
         counter_bits) = counter_increment.boundary.detail
        (_next, object_register, object_source_bits,
         object_bits, object_operand) = object_load.boundary.detail
        (_next, mask_name, masked_register,
         mask_bits, object_mask) = mask_object.boundary.detail
        (_next, compare_opcode, compared_objects,
         compared_counter, compare_bits) = compare.boundary.detail

        operands = (sequence_operand, value_operand, hook_operand,
                    offset_operand, slot_operand, secret_operand,
                    store_operand, object_operand)
        if any(not isinstance(operand, MemoryOperand)
               for operand in operands):
            return state
        metadata = sequence_operand.base
        if (sequence_bits != 64 or metadata is None
                or sequence_operand.index is not None
                or sequence_operand.rip_relative
                or sequence_operand.segment_msr is not None
                or value_bits != 32 or value_operand.base != sequence_register
                or value_operand.index != position or value_operand.scale != 4
                or value_operand.displacement != 0
                or value_operand.rip_relative
                or value_operand.segment_msr is not None
                or position_group != 0 or position_bits != 64
                or wrap_opcode != 0x39
                or compared_position != position or wrap_bits != 64
                or wrap_condition != 3 or wrap_target != position
                or wrap_move_bits != 64
                or limit_opcode != 0x39
                or compared_value != value_register or limit_bits != 32
                or reject_condition != 6
                or reject_target != value_load.rip
                or reject_following != add_start.rip
                or add_name != 'add' or added_register != value_register
                or add_bits != 64 or next_register != value_register
                or hook_bits != 64 or hook_operand.base != metadata
                or hook_operand.index is not None
                or hook_operand.rip_relative
                or hook_operand.segment_msr is not None
                or hook_opcode != 0x85 or hook_left != hook_register
                or hook_right != hook_register or hook_compare_bits != 64
                or hook_condition != 5
                or duplicate_opcode != 0x39
                or current_register == next_register or duplicate_bits != 64
                or duplicate_condition != 4
                or offset_bits != 32 or offset_operand.base != metadata
                or offset_operand.index is not None
                or offset_operand.rip_relative
                or offset_operand.segment_msr is not None
                or slot_bits != 64 or slot_operand.base != offset_register
                or slot_operand.index != current_register
                or slot_operand.scale != 1
                or slot_operand.displacement != 0
                or secret_bits != 64 or secret_operand.base != metadata
                or secret_operand.index is not None
                or secret_operand.rip_relative
                or secret_operand.segment_msr is not None
                or xor_next_name != 'xor'
                or xor_next_target != secret_register
                or xor_next_source != next_register or xor_next_bits != 64
                or xor_slot_name != 'xor'
                or xor_slot_target != secret_register
                or xor_slot_source != slot_register or xor_slot_bits != 64
                or stored_register != secret_register or store_bits != 64
                or store_operand.base != offset_register
                or store_operand.index != current_register
                or store_operand.scale != 1
                or store_operand.displacement != 0
                or counter_group != 0 or counter_bits != 64
                or object_source_bits != 16 or object_bits != 32
                or object_operand.base is None
                or object_operand.index is not None
                or object_operand.rip_relative
                or object_operand.segment_msr is not None
                or mask_name != 'and' or masked_register != object_register
                or mask_bits != 32 or object_mask != 0x7fff
                or offset_register != object_register
                or compare_opcode != 0x39
                or compared_objects != object_register
                or compared_counter != counter or compare_bits != 64
                or not compare.source.startswith(b'\x4d\x89\xfd')):
            return state

        try:
            sequence = load_virtual(
                state, sequence_operand.address(
                    state, sequence_load.boundary.detail[0]), 8)
            hook = load_virtual(
                state, hook_operand.address(
                    state, hook_load.boundary.detail[0]), 8)
            offset = load_virtual(
                state, offset_operand.address(
                    state, offset_load.boundary.detail[0]), 4)
            secret = load_virtual(
                state, secret_operand.address(
                    state, secret_load.boundary.detail[0]), 8)
            objects = load_virtual(
                state, object_operand.address(
                    state, object_load.boundary.detail[0]), 2) & 0x7fff
        except PageFault:
            return state
        count = state.registers[count_register] & MASK64
        page_limit = state.registers[page_limit_register] & MASK32
        start = state.registers[start_register] & MASK64
        current = state.registers[current_register] & MASK64
        position_value = state.registers[position] & MASK64
        counter_value = state.registers[counter] & MASK64
        if (hook or not count or objects < 2 or counter_value >= objects
                or position_value >= count or offset + 8 > page_limit
                or state.registers[zero_register] & MASK64):
            return state

        def byte_swap(value):
            return int.from_bytes(
                int(value & MASK64).to_bytes(8, 'little'), 'big')

        records = []
        values = []
        consumed = 0
        requested = min(objects - counter_value, 1 << 16)
        word_limit = min(1 << 20, max(count, requested) * requested)
        try:
            while len(records) < requested and consumed < word_limit:
                selected = load_virtual(
                    state, sequence + position_value * 4, 4)
                position_value += 1
                if position_value >= count:
                    position_value = 0
                consumed += 1
                if selected >= page_limit:
                    continue
                next_value = (start + selected) & MASK64
                if next_value == current:
                    return state
                records.append((current + offset) & MASK64)
                encoded = (secret ^ next_value
                           ^ byte_swap(current + offset)) & MASK64
                values.append(encoded)
                current = next_value
        except PageFault:
            return state
        if not records:
            return state
        try:
            state = store_virtual_values(state, records, 8, values)
        except (PageFault, ValueError):
            return state

        links = len(records)
        final_counter = counter_value + links
        last_record = records[-1]
        final_slot = byte_swap(last_record)
        registers = _write_register(
            state.registers, sequence_register, objects, 32)
        registers = _write_register(
            registers, value_register, current, 64)
        registers = _write_register(
            registers, position, position_value, 64)
        registers = _write_register(registers, hook_register, 0, 64)
        registers = _write_register(
            registers, offset_register, objects, 32)
        registers = _write_register(
            registers, slot_register, final_slot, 64)
        registers = _write_register(
            registers, secret_register, values[-1], 64)
        registers = _write_register(
            registers, counter, final_counter, 64)
        registers = _write_register(
            registers, current_register, current, 64)
        result = (final_counter - objects) & MASK64
        flags = _result_flags(
            state.rflags, 'cmp', final_counter, objects, result, 64)
        self.collapsed_random_freelist_links += links
        self.collapsed_random_freelist_words += consumed
        return replace(
            state, registers=registers, rflags=flags,
            rip=following if final_counter >= objects else target)

    def _collapse_page_bootmem_loop(self, state, branch):
        """Project a page-record run through one proved metadata call."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if (cursor != branch.rip or len(loop) != 3
                or tuple(block.boundary.operation for block in loop)
                != ('lea', 'call', 'group_ff')):
            return state
        advance, call, decrement = loop
        (_next, advanced, advance_bits,
         advance_operand) = advance.boundary.detail
        (_next, call_target) = call.boundary.detail
        (_next, group, counter, counter_bits) = decrement.boundary.detail
        if (advance_bits != 64
                or not isinstance(advance_operand, MemoryOperand)
                or advance_operand.base != REGISTER_INDEX['rsi']
                or advance_operand.index is not None
                or advance_operand.scale != 1
                or advance_operand.displacement != 64
                or advance_operand.rip_relative
                or advance_operand.segment_msr is not None
                or advanced != REGISTER_INDEX['r15']
                or call.source[:8] != bytes.fromhex(
                    '4c 89 f7 ba 01 00 00 00')
                or not self._page_bootmem_layout(state, call_target)
                or group != 1 or counter != REGISTER_INDEX['rbx']
                or counter_bits != 32
                or not decrement.source.startswith(b'\x4c\x89\xfe')):
            return state
        count = state.register('rbx') & MASK32
        if not count:
            return state
        iterations = min(count, 1 << 16)
        page = state.register('rsi') & MASK64
        info = state.register('r14') & MASK64
        if info >> 60:
            return state
        encoded = ((info << 4) | 1) & MASK64
        try:
            state = project_virtual_records(
                state, page, iterations, 64, (
                    (1, 1, 0xff, 0x40, 0),
                    (0x28, 8, 0, encoded, 0),
                    (0x34, 4, MASK32, 0, 1),
                ))
        except (PageFault, ValueError):
            return state
        remaining = count - iterations
        final_page = (page + iterations * 64) & MASK64
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], encoded, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rbx'], remaining, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rdx'], 1, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rdi'], info << 4, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rsi'], final_page, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['r15'], final_page, 64)
        before = remaining + 1
        flags = _result_flags(
            state.rflags & ~RFLAGS_CARRY, 'sub', before, 1,
            remaining, 32, preserve_carry=True)
        self.collapsed_page_bootmem_calls += iterations
        self.collapsed_page_bootmem_records += iterations
        return replace(
            state, registers=registers, rflags=flags,
            rip=following if not remaining else target)

    def _collapse_repeated_store_call_loop(self, state, branch):
        """Compose a store-only indirect call loop into one physical repeat."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if (cursor != branch.rip or len(loop) != 5
                or tuple(block.boundary.operation for block in loop) != (
                    'load', 'lea', 'group_ff',
                    'register_immediate_result_flags', 'immediate_alu')):
            return state
        base_load, address, call, update, compare = loop
        (_next, base_register, base_bits,
         base_operand) = base_load.boundary.detail
        (_next, destination, destination_bits,
         destination_operand) = address.boundary.detail
        (call_following, call_group, call_operand,
         call_bits) = call.boundary.detail
        (_next, update_name, induction,
         induction_bits, stride) = update.boundary.detail
        (_next, compare_name, compared,
         compare_bits, limit) = compare.boundary.detail
        if (base_bits != 64
                or not isinstance(base_operand, MemoryOperand)
                or base_operand.index is not None
                or base_operand.rip_relative
                or base_operand.segment_msr is not None
                or destination_bits != 64
                or not isinstance(destination_operand, MemoryOperand)
                or destination_operand.base != base_register
                or destination_operand.index != induction
                or destination_operand.scale != 1
                or destination_operand.displacement != 0
                or destination_operand.rip_relative
                or destination_operand.segment_msr is not None
                or destination != REGISTER_INDEX['rdi']
                or call_group != 2 or call_bits != 64
                or not isinstance(call_operand, MemoryOperand)
                or not call.source.startswith(b'\x4c\x89\xfe')
                or update_name != 'add' or induction_bits != 64
                or stride != 8 or compare_name != 'cmp'
                or compared != induction or compare_bits != 64
                or limit <= 0 or limit & 7):
            return state
        try:
            actual_target = load_virtual(
                state, call_operand.address(state, call_following), 8)
            if not self._store_word_layout(state, actual_target):
                return state
            base = load_virtual(
                state, base_operand.address(
                    state, base_load.boundary.detail[0]), 8)
        except PageFault:
            return state
        offset = state.registers[induction] & MASK64
        if offset >= limit or (limit - offset) & 7:
            return state
        iterations = min((limit - offset) // 8, 1 << 16)
        byte_count = iterations * 8
        stack = state.register('rsp') & MASK64
        start = (base + offset) & MASK64
        end = start + byte_count
        if start < stack and end > (stack - 24) & MASK64:
            return state
        value = state.register('r15') & MASK64
        try:
            state = repeat_virtual(
                state, start, byte_count, struct.pack('<Q', value))
        except (PageFault, ValueError):
            return state
        final_offset = offset + byte_count
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], value, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdi'],
            base + final_offset - 8, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rsi'], value, 64)
        registers = _write_register(
            registers, induction, final_offset, 64)
        result = (final_offset - limit) & MASK64
        flags = _result_flags(
            state.rflags, 'cmp', final_offset, limit, result, 64)
        self.collapsed_store_word_calls += iterations
        self.collapsed_repeated_store_calls += iterations
        return replace(
            state, registers=registers, rflags=flags,
            rip=following if final_offset == limit else target)

    def _page_reservation_layout(self, state, target):
        """Prove the fixed-stride PageReserved projection loop."""
        target = int(target) & MASK64
        cached = self._page_reservation_loops.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = bytearray(reader.read(
                target, len(_PAGE_RESERVATION_CORE)))
            vmemmap_displacement = _signed_integer(
                int.from_bytes(code[15:19], 'little'), 32)
            node_states_displacement = _signed_integer(
                int.from_bytes(code[23:27], 'little'), 32)
            node_data_base = _signed_integer(
                int.from_bytes(code[33:37], 'little'), 32) & MASK64
            code[15:19] = bytes(4)
            code[23:27] = bytes(4)
            code[33:37] = bytes(4)
            code[52:56] = bytes(4)
            if bytes(code) == _PAGE_RESERVATION_CORE:
                layout = (
                    (target + 19 + vmemmap_displacement) & MASK64,
                    (target + 27 + node_states_displacement) & MASK64,
                    node_data_base,
                    (target + 0x5f) & MASK64,
                    (target + 0x4f) & MASK64,
                )
        except PageFault:
            pass
        config, proof = reader.proof()
        self._page_reservation_loops[target] = config, proof, layout
        return layout

    def _collapse_page_reservation_projection(self, state, branch):
        """Publish one valid PFN run as a sparse record-bit projection."""
        _following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        layout = self._page_reservation_layout(state, target)
        if layout is None:
            return state
        (vmemmap_address, node_states, node_data_base,
         exit_target, validity_target) = layout
        pfn = state.register('r15')
        end = state.register('r14')
        node = state.register('r12')
        distance = end - pfn
        until_validity_check = (-pfn) & 0x1ff
        if (distance <= 0 or distance > (1 << 24)
                or not until_validity_check or node > 1023):
            return state
        records = min(distance, until_validity_check)
        try:
            vmemmap = load_virtual(state, vmemmap_address, 8)
            node_word = load_virtual(
                state, node_states + (node // 64) * 8, 8)
            online = bool(node_word & (1 << (node % 64)))
            pgdat = None
            if online:
                pgdat = load_virtual(state, node_data_base + node * 8, 8)
                deferred = load_virtual(state, pgdat + 0x21a80, 8)
                if pfn + records > deferred:
                    return state
            state = project_virtual_records(
                state, vmemmap + pfn * 64, records, 64,
                ((0, 8, MASK64, 1 << 13),))
        except (PageFault, ValueError):
            return state

        final = pfn + records
        last_record = (vmemmap + (final - 1) * 64) & MASK64
        registers = _write_register(
            state.registers, REGISTER_INDEX['r13'], last_record, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['r15'], final, 64)
        if final == end:
            if online:
                registers = _write_register(
                    registers, REGISTER_INDEX['rax'], pgdat, 64)
            flags = _result_flags(
                state.rflags, 'cmp', final, end,
                (final - end) & MASK64, 64)
            rip = exit_target
        else:
            registers = _write_register(
                registers, REGISTER_INDEX['rax'], 0, 64)
            flags = _result_flags(state.rflags, 'and', 0, 0, 0, 64)
            if (final >> 9) & 1:
                flags |= RFLAGS_CARRY
            rip = validity_target
        self.collapsed_strided_store_bytes += records * 8
        self.collapsed_strided_store_iterations += records
        return replace(state, registers=registers, rflags=flags, rip=rip)

    def _collapse_strided_record_projection(self, state, branch):
        """Join sparse word transforms over fixed-width records by page."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if (cursor != branch.rip or len(loop) != 4
                or tuple(block.boundary.operation for block in loop) != (
                    'bit_immediate', 'store_immediate',
                    'register_immediate_result_flags', 'group_ff')):
            return state

        bit, store, advance, counter_update = loop
        (_bit_next, bit_group, bit_operand, bit_bits,
         bit_index) = bit.boundary.detail
        (_store_next, store_operand, store_bits,
         store_value) = store.boundary.detail
        (_advance_next, advance_name, pointer,
         pointer_bits, stride) = advance.boundary.detail
        (_counter_next, counter_group, counter,
         counter_bits) = counter_update.boundary.detail
        operands = bit_operand, store_operand
        if (bit_group not in (5, 6)
                or bit_bits not in (16, 32, 64)
                or store_bits not in (8, 16, 32, 64)
                or any(not isinstance(operand, MemoryOperand)
                       for operand in operands)
                or bit_operand.base != pointer
                or store_operand.base != pointer
                or any(operand.index is not None
                       or operand.rip_relative
                       or operand.segment_msr is not None
                       for operand in operands)
                or advance_name != 'add' or pointer_bits != 64
                or stride <= 0 or stride > (1 << 20)
                or counter_group != 1
                or counter_bits not in (32, 64)
                or isinstance(counter, MemoryOperand)
                or pointer == counter):
            return state

        word_bytes = bit_bits // 8
        bit_offset = ((int(bit_index) // bit_bits) * word_bytes
                      + bit_operand.displacement)
        selected = 1 << (int(bit_index) % bit_bits)
        word_mask = (1 << bit_bits) - 1
        lanes = (
            (bit_offset, word_bytes,
             word_mask if bit_group == 5 else word_mask ^ selected,
             selected if bit_group == 5 else 0),
            (store_operand.displacement, store_bits // 8, 0,
             int(store_value) & ((1 << store_bits) - 1)),
        )
        count_mask = (1 << counter_bits) - 1
        remaining = state.registers[counter] & count_mask
        if not remaining or remaining > (1 << 20):
            return state
        pointer_value = state.registers[pointer] & MASK64
        try:
            state = project_virtual_records(
                state, pointer_value, remaining, stride, lanes)
        except (PageFault, ValueError):
            return state

        prior_pointer = (
            pointer_value + (remaining - 1) * stride) & MASK64
        final_pointer = (pointer_value + remaining * stride) & MASK64
        flags = _result_flags(
            state.rflags, 'add', prior_pointer, stride, final_pointer, 64)
        flags = _result_flags(
            flags, 'sub', 1, 1, 0, counter_bits,
            preserve_carry=True)
        registers = _write_register(
            state.registers, pointer, final_pointer, 64)
        registers = _write_register(registers, counter, 0, counter_bits)
        self.collapsed_strided_store_bytes += sum(
            lane[1] for lane in lanes) * remaining
        self.collapsed_strided_store_iterations += remaining
        return replace(state, registers=registers, rflags=flags,
                       rip=int(following) & MASK64)

    def _collapse_compare_loop(self, state, branch):
        """Reduce an indexed byte-string comparison to direct chunks."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if cursor != branch.rip or len(loop) != 5:
            return state
        load, compare, mismatch, update, test = loop
        if (load.boundary.operation != 'move_zero_extend'
                or compare.boundary.operation != 'compare'
                or mismatch.boundary.operation != 'conditional_branch'
                or update.boundary.operation != 'group_ff'
                or test.boundary.operation != 'compare'):
            return state

        (_next, temporary, source_bits,
         target_bits, left_operand) = load.boundary.detail
        (_next, opcode, compared,
         right_operand, compare_bits) = compare.boundary.detail
        (_next, mismatch_target,
         mismatch_condition) = mismatch.boundary.detail
        _next, group, index, index_bits = update.boundary.detail
        (_next, test_opcode, tested,
         test_operand, test_bits) = test.boundary.detail
        if (source_bits != 8 or target_bits not in (32, 64)
                or opcode != 0x3a or compared != temporary
                or compare_bits != 8
                or mismatch_condition != 5
                or group != 0 or index_bits not in (32, 64)
                or test_opcode != 0x84 or tested != temporary
                or test_operand != temporary or test_bits != 8
                or not isinstance(left_operand, MemoryOperand)
                or not isinstance(right_operand, MemoryOperand)):
            return state
        if (left_operand.rip_relative or right_operand.rip_relative
                or left_operand.segment_msr is not None
                or right_operand.segment_msr is not None
                or left_operand.base is None or right_operand.base is None
                or left_operand.index != index
                or right_operand.index != index
                or left_operand.scale != 1 or right_operand.scale != 1
                or temporary in (left_operand.base, right_operand.base,
                                  index)):
            return state

        position = state.registers[index] & ((1 << index_bits) - 1)
        scanned = 0
        while scanned < 1 << 20:
            left_address = (state.registers[left_operand.base] + position
                            + left_operand.displacement) & MASK64
            right_address = (state.registers[right_operand.base] + position
                             + right_operand.displacement) & MASK64
            count = min(256,
                        PAGE_BYTES - (left_address & (PAGE_BYTES - 1)),
                        PAGE_BYTES - (right_address & (PAGE_BYTES - 1)))
            left = read_virtual(state, left_address, count)
            right = read_virtual(state, right_address, count)
            stop = None
            for offset, (left_byte, right_byte) in enumerate(
                    zip(left, right)):
                if left_byte != right_byte or not left_byte:
                    stop = offset, left_byte, right_byte
                    break
            if stop is None:
                position += count
                scanned += count
                continue
            offset, left_byte, right_byte = stop
            position += offset
            scanned += offset + 1
            registers = _write_register(
                state.registers, temporary, left_byte, target_bits)
            if left_byte != right_byte:
                flags = _result_flags(
                    state.rflags, 'cmp', left_byte, right_byte,
                    (left_byte - right_byte) & 0xff, 8)
                rip = mismatch_target
            else:
                position += 1
                flags = _result_flags(
                    state.rflags, 'and', 0, 0, 0, 8)
                rip = following
            registers = _write_register(
                registers, index, position, index_bits)
            self.collapsed_compare_bytes += scanned
            self.collapsed_compare_iterations += scanned
            return replace(state, registers=registers, rip=rip,
                           rflags=flags)
        return state

    def _collapse_bounded_compare_loop(self, state, branch):
        """Reduce a length-bounded byte comparison to direct coordinates."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if cursor != branch.rip or len(loop) != 8:
            return state
        (load, compare, mismatch, clear_result, zero_test,
         zero_branch, limit_compare, update) = loop
        if tuple(block.boundary.operation for block in loop) != (
                'move_zero_extend', 'compare', 'conditional_branch',
                'register_result_flags', 'compare', 'conditional_branch',
                'compare', 'lea'):
            return state

        (_next, temporary, source_bits,
         target_bits, left_operand) = load.boundary.detail
        (_next, opcode, compared,
         right_operand, compare_bits) = compare.boundary.detail
        (_next, mismatch_target,
         mismatch_condition) = mismatch.boundary.detail
        (_next, clear_name, clear_left,
         clear_right, clear_bits) = clear_result.boundary.detail
        (_next, test_opcode, tested,
         test_operand, test_bits) = zero_test.boundary.detail
        (_next, zero_target, zero_condition) = zero_branch.boundary.detail
        (_next, limit_opcode, index,
         limit, limit_bits) = limit_compare.boundary.detail
        (_next, updated, update_bits, induction) = update.boundary.detail
        if (source_bits != 8 or target_bits not in (32, 64)
                or opcode != 0x3a or compared != temporary
                or compare_bits != 8 or mismatch_condition != 5
                or clear_name != 'xor' or clear_left != clear_right
                or not isinstance(clear_left, int) or clear_bits != 32
                or test_opcode != 0x84 or tested != temporary
                or test_operand != temporary or test_bits != 8
                or zero_condition != 4 or zero_target != following
                or limit_opcode != 0x39
                or not isinstance(index, int)
                or not isinstance(limit, int) or limit_bits != 64
                or updated != index or update_bits != 64
                or not isinstance(induction, MemoryOperand)
                or induction.base != index or induction.index is not None
                or induction.displacement != 1
                or induction.rip_relative
                or induction.segment_msr is not None
                or not isinstance(left_operand, MemoryOperand)
                or not isinstance(right_operand, MemoryOperand)
                or left_operand.rip_relative or right_operand.rip_relative
                or left_operand.segment_msr is not None
                or right_operand.segment_msr is not None
                or left_operand.base is None or right_operand.base is None
                or left_operand.index != index
                or right_operand.index != index
                or left_operand.scale != 1 or right_operand.scale != 1
                or temporary in (left_operand.base, right_operand.base,
                                  index, limit)):
            return state

        position = state.registers[index] & MASK64
        last = state.registers[limit] & MASK64
        if last < position or last - position >= (1 << 20):
            return state
        remaining = last - position + 1
        scanned = 0
        while scanned < remaining:
            left_address = (state.registers[left_operand.base] + position
                            + scanned + left_operand.displacement) & MASK64
            right_address = (state.registers[right_operand.base] + position
                             + scanned + right_operand.displacement) & MASK64
            count = min(256, remaining - scanned,
                        PAGE_BYTES - (left_address & (PAGE_BYTES - 1)),
                        PAGE_BYTES - (right_address & (PAGE_BYTES - 1)))
            left = read_virtual(state, left_address, count)
            right = read_virtual(state, right_address, count)
            stop = next(((offset, left_byte, right_byte)
                         for offset, (left_byte, right_byte) in enumerate(
                             zip(left, right))
                         if left_byte != right_byte or not left_byte), None)
            if stop is None:
                scanned += count
                continue
            offset, left_byte, right_byte = stop
            scanned += offset + 1
            coordinate = position + scanned - 1
            registers = _write_register(
                state.registers, temporary, left_byte, target_bits)
            if left_byte != right_byte:
                flags = _result_flags(
                    state.rflags, 'cmp', left_byte, right_byte,
                    (left_byte - right_byte) & 0xff, 8)
                rip = mismatch_target
            else:
                registers = _write_register(
                    registers, clear_left, 0, clear_bits)
                flags = _result_flags(state.rflags, 'and', 0, 0, 0, 8)
                rip = zero_target
            registers = _write_register(
                registers, index, coordinate, 64)
            self.collapsed_compare_bytes += scanned
            self.collapsed_compare_iterations += scanned
            return replace(state, registers=registers, rip=rip,
                           rflags=flags)

        final_byte = read_virtual(
            state,
            (state.registers[left_operand.base] + last
             + left_operand.displacement) & MASK64, 1)[0]
        registers = _write_register(
            state.registers, temporary, final_byte, target_bits)
        registers = _write_register(
            registers, clear_left, 0, clear_bits)
        registers = _write_register(registers, index, last + 1, 64)
        flags = _result_flags(state.rflags, 'cmp', last, last, 0, 64)
        self.collapsed_compare_bytes += remaining
        self.collapsed_compare_iterations += remaining
        return replace(state, registers=registers, rip=following,
                       rflags=flags)

    def _inactive_byte_classes(self, stops):
        stops = tuple(sorted(set(int(byte) & 0xff for byte in stops)))
        classes = self._byte_class_cache.get(stops)
        if classes is None:
            stop_set = frozenset(stops)
            classes = compile_byte_classes(
                lambda byte: byte not in stop_set)
            self._byte_class_cache[stops] = classes
        return classes

    def _collapse_zero_scan(self, state, branch):
        """Reduce an indexed NUL scan to one direct byte coordinate cut."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        compare = self.blocks.get(target)
        if compare is None or compare.boundary.operation != 'immediate_alu':
            return state
        compare_following, name, operand, bits, immediate = \
            compare.boundary.detail
        update = self.blocks.get(compare_following)
        if update is None or update.rip + len(update.source) != branch.rip \
                or update.boundary.operation != 'lea':
            return state
        _update_following, index, index_bits, induction = \
            update.boundary.detail
        if (name != 'cmp' or bits != 8 or immediate != 0
                or not isinstance(operand, MemoryOperand)
                or operand.rip_relative or operand.segment_msr is not None
                or operand.base is None or operand.index != index
                or operand.scale != 1
                or not isinstance(induction, MemoryOperand)
                or induction.base != index or induction.index is not None
                or induction.displacement != 1
                or index_bits != 64):
            return state

        address = operand.address(state, compare_following)
        classes = self._inactive_byte_classes((0,))
        stop = find_virtual(
            state, address, 1 << 20, classes.coordinates(False))
        if stop is None:
            return state
        scanned = stop + 1
        registers = _write_register(
            state.registers, index,
            state.registers[index] + scanned, 64)
        flags = _result_flags(state.rflags, 'cmp', 0, 0, 0, 8)
        self.collapsed_zero_scan_bytes += scanned
        return replace(state, registers=registers, rip=following,
                       rflags=flags)

    def _collapse_zero_word_scan(self, state, branch):
        """Project a bounded zero-word loop onto its first nonzero byte.

        The source loop observes only whether each aligned word is zero.  A
        direct byte-coordinate search therefore proves every skipped word at
        once; only the first candidate word is joined back into a scalar.
        """
        following, target, condition = branch.boundary.detail
        if condition != 4 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if cursor != branch.rip or len(loop) != 6:
            return state
        (counter_update, limit_compare, limit_branch, load,
         pointer_update, zero_test) = loop
        if tuple(block.boundary.operation for block in loop) != (
                'register_immediate_result_flags', 'compare',
                'conditional_branch', 'load',
                'register_immediate_result_flags', 'compare'):
            return state

        (_counter_next, counter_name, counter, counter_bits,
         counter_stride) = counter_update.boundary.detail
        (_compare_next, compare_opcode, limit,
         compared_counter, compare_bits) = limit_compare.boundary.detail
        (load_following, limit_target,
         limit_condition) = limit_branch.boundary.detail
        (_load_next, loaded, loaded_bits,
         source) = load.boundary.detail
        (_pointer_next, pointer_name, pointer, pointer_bits,
         pointer_stride) = pointer_update.boundary.detail
        (_test_next, test_opcode, tested,
         test_operand, test_bits) = zero_test.boundary.detail
        width = loaded_bits // 8
        if (counter_name != 'add' or counter_bits != 64
                or counter_stride != loaded_bits
                or compare_opcode != 0x39 or compared_counter != counter
                or compare_bits != counter_bits
                or not isinstance(limit, int)
                or limit_condition != 3
                or load_following != load.rip
                or loaded_bits not in (32, 64)
                or not isinstance(source, MemoryOperand)
                or source.rip_relative or source.segment_msr is not None
                or source.base != pointer or source.index is not None
                or pointer_name != 'add' or pointer_bits != 64
                or pointer_stride != width
                or test_opcode != 0x85 or tested != loaded
                or test_operand != loaded or test_bits != loaded_bits
                or len({counter, limit, loaded, pointer}) != 4):
            return state

        position = state.registers[counter] & MASK64
        stop = state.registers[limit] & MASK64
        distance = stop - position
        loadable = ((distance - 1) // counter_stride
                    if distance > counter_stride else 0)
        if not loadable:
            final_position = (position + counter_stride) & MASK64
            registers = _write_register(
                state.registers, counter, final_position, 64)
            flags = _result_flags(
                state.rflags, 'cmp', final_position, stop,
                (final_position - stop) & MASK64, 64)
            return replace(state, registers=registers,
                           rip=limit_target, rflags=flags)

        # Bound a single residual step while retaining the same loop state at
        # a chunk boundary.  This keeps adversarial guest bounds preemptible.
        chunk_words = min(loadable, (1 << 20) // width)
        address = source.address(state, load_following)
        nonzero = find_virtual(
            state, address, chunk_words * width,
            self._inactive_byte_classes((0,)).coordinates(True))
        if nonzero is not None:
            words = nonzero // width + 1
            value = load_virtual(
                state, address + (words - 1) * width, width)
            registers = _write_register(
                state.registers, counter,
                position + words * counter_stride, 64)
            registers = _write_register(
                registers, pointer,
                state.registers[pointer] + words * width, 64)
            registers = _write_register(
                registers, loaded, value, loaded_bits)
            flags = _result_flags(
                state.rflags, 'and', value, value, value, loaded_bits)
            scanned_words = words
            rip = following
        elif chunk_words < loadable:
            registers = _write_register(
                state.registers, counter,
                position + chunk_words * counter_stride, 64)
            registers = _write_register(
                registers, pointer,
                state.registers[pointer] + chunk_words * width, 64)
            registers = _write_register(
                registers, loaded, 0, loaded_bits)
            flags = _result_flags(state.rflags, 'and', 0, 0, 0,
                                  loaded_bits)
            scanned_words = chunk_words
            rip = target
        else:
            final_position = position + (loadable + 1) * counter_stride
            registers = _write_register(
                state.registers, counter, final_position, 64)
            registers = _write_register(
                registers, pointer,
                state.registers[pointer] + loadable * width, 64)
            registers = _write_register(
                registers, loaded, 0, loaded_bits)
            flags = _result_flags(
                state.rflags, 'cmp', final_position, stop,
                (final_position - stop) & MASK64, 64)
            scanned_words = loadable
            rip = limit_target
        self.collapsed_zero_word_bytes += scanned_words * width
        self.collapsed_zero_word_iterations += scanned_words
        return replace(state, registers=registers, rip=rip,
                       rflags=flags)

    def _collapse_affine_page_records(self, state, branch):
        """Batch a proved affine array of fixed-size page records.

        Ordinary iterations write a complete record whose constant fields and
        self-pointers are affine in one unit-stride index.  The sparse
        alignment path remains a normal control-flow barrier.
        """
        following, target, condition = branch.boundary.detail
        if condition != 2 or state.rip != target or target >= branch.rip:
            return state

        def predecessor(end, operation):
            candidates = [block for width in range(1, 16)
                          for block in (self.blocks.get(end - width),)
                          if block is not None
                          and block.rip + len(block.source) == end
                          and block.boundary.operation == operation]
            return candidates[0] if len(candidates) == 1 else None

        compare = predecessor(branch.rip, 'compare')
        induction = (None if compare is None else
                     predecessor(compare.rip, 'group_ff'))
        if compare is None or induction is None:
            return state
        _induction_next, group, index, index_bits = \
            induction.boundary.detail
        (_compare_next, opcode, limit,
         compared_index, compare_bits) = compare.boundary.detail
        if (group != 0 or not isinstance(index, int) or index_bits != 64
                or opcode != 0x39 or compared_index != index
                or not isinstance(limit, int) or compare_bits != 64
                or index == limit):
            return state

        head = self.blocks.get(target)
        head_branch = (None if head is None else
                       self.blocks.get(head.rip + len(head.source)))
        if (head is None or head.boundary.operation != 'compare'
                or head_branch is None
                or head_branch.boundary.operation != 'conditional_branch'):
            return state
        _head_next, head_opcode, mode, head_operand, head_bits = \
            head.boundary.detail
        _prefix_next, record_entry, prefix_condition = \
            head_branch.boundary.detail
        if (head_opcode != 0x85 or mode != head_operand or head_bits != 32
                or prefix_condition != 5 or mode in (index, limit)
                or (state.registers[mode] & MASK32) == 1):
            return state

        # Prove that the current invariant prefix reaches the store core
        # without a write, call, fault, or host-visible operation.
        probe = _freeze_state(state)
        scalar_update = None
        recent = []
        control_profile = self._control_profile
        self._control_profile = None
        try:
            for _unused in range(64):
                if probe.rip == record_entry:
                    break
                block = self.blocks.get(probe.rip)
                if block is None:
                    block = self.block(probe)
                operation = block.boundary.operation
                prior = probe
                probe, scratch = self._execute_plan(probe, block)
                if operation == 'store':
                    if scalar_update is not None or len(recent) < 2:
                        return state
                    load, increment = recent[-2:]
                    following_store, source, bits, destination = \
                        block.boundary.detail
                    if (load.boundary.operation != 'load'
                            or increment.boundary.operation != 'group_ff'
                            or bits != 64 or not isinstance(source, int)
                            or not isinstance(destination, MemoryOperand)):
                        return state
                    load_following, loaded, load_bits, source_operand = \
                        load.boundary.detail
                    (_increment_following, increment_group,
                     incremented, increment_bits) = \
                        increment.boundary.detail
                    if (loaded != source or load_bits != bits
                            or increment_group != 0
                            or incremented != source
                            or increment_bits != bits
                            or not isinstance(source_operand, MemoryOperand)):
                        return state
                    source_address = source_operand.address(
                        probe, load_following)
                    destination_address = destination.address(
                        probe, following_store)
                    old_value = load_virtual(state, source_address, 8)
                    new_value = probe.registers[source] & MASK64
                    threshold_block = self.blocks.get(following_store)
                    if threshold_block is None:
                        threshold_block = self.block(replace(
                            probe, rip=following_store))
                    threshold_detail = threshold_block.boundary.detail
                    if (source_address != destination_address
                            or new_value != (old_value + 1) & MASK64
                            or threshold_block.boundary.operation
                            != 'immediate_alu'
                            or threshold_detail[1] != 'cmp'
                            or threshold_detail[2] != source
                            or threshold_detail[3] != 64
                            or int(threshold_detail[4]) <= 0):
                        return state
                    scalar_update = (
                        destination_address, old_value,
                        int(threshold_detail[4]))
                    probe = replace(probe, rip=following_store)
                    recent.append(block)
                    continue
                allowed = {
                    'compare', 'conditional_branch', 'load', 'lea',
                    'shift_result_flags', 'operand_test', 'branch',
                    'group_ff', 'set_condition', 'register_binary',
                }
                if operation == 'immediate_alu':
                    allowed_operation = block.boundary.detail[1] == 'cmp'
                elif operation == 'memory_binary':
                    allowed_operation = bool(block.boundary.detail[2])
                else:
                    allowed_operation = operation in allowed
                if not allowed_operation:
                    return state
                probe, boundary = self._control(
                    probe, block.boundary, prior, scratch)
                if boundary is not None:
                    return state
                recent.append(block)
            else:
                return state
        finally:
            self._control_profile = control_profile
        if probe.rip != record_entry:
            return state

        base_load = self.blocks.get(record_entry)
        if base_load is None:
            base_load = self.block(probe)
        if (base_load.boundary.operation != 'load'
                or len(base_load.source) != 7):
            return state
        base_following, base_register, base_bits, base_operand = \
            base_load.boundary.detail
        if (base_bits != 64 or not isinstance(base_operand, MemoryOperand)
                or not base_operand.rip_relative):
            return state
        if not self._code_contains_recipe(
                state, base_following, _AFFINE_PAGE_RECORD_CORE,
                extent=len(_AFFINE_PAGE_RECORD_CORE)):
            return state

        variant_branch_address = base_following \
            + len(_AFFINE_PAGE_RECORD_CORE) - 2
        variant_branch = self.blocks.get(variant_branch_address)
        if variant_branch is None:
            variant_branch = self.block(replace(
                _freeze_state(state), rip=variant_branch_address))
        if (variant_branch.boundary.operation != 'conditional_branch'
                or variant_branch.boundary.detail[2] != 5):
            return state
        after_variant = variant_branch.boundary.detail[1]
        alignment = self.blocks.get(after_variant)
        if alignment is None:
            alignment = self.block(replace(
                _freeze_state(state), rip=after_variant))
        if (alignment.source != bytes.fromhex('4c 89 e0 48 c1 e0 37')
                or alignment.boundary.operation != 'shift_result_flags'):
            return state
        alignment_branch = self.blocks.get(
            alignment.rip + len(alignment.source))
        if alignment_branch is None:
            alignment_branch = self.block(replace(
                _freeze_state(state),
                rip=alignment.rip + len(alignment.source)))
        if (alignment_branch.boundary.operation != 'conditional_branch'
                or alignment_branch.boundary.detail[2] != 5
                or alignment_branch.boundary.detail[1] != induction.rip):
            return state

        start = state.registers[index] & MASK64
        stop = state.registers[limit] & MASK64
        if start >= stop:
            return state
        until_alignment = (-start) & 0x1ff
        if not until_alignment:
            return state
        count = min(stop - start, until_alignment)
        if scalar_update is not None:
            _scalar_address, scalar_value, scalar_threshold = scalar_update
            scalar_room = scalar_threshold - scalar_value - 1
            if scalar_room <= 0:
                return state
            count = min(count, scalar_room)
        base = load_virtual(
            state, base_operand.address(state, base_following), 8)
        stride = 64
        record_start = (base + start * stride) & MASK64
        invariant = state.registers[REGISTER_INDEX['rsi']] & MASK64
        payload = bytearray(count * stride)
        for offset in range(count):
            record = offset * stride
            self_pointer = (record_start + record + 8) & MASK64
            struct.pack_into('<Q', payload, record, invariant)
            struct.pack_into('<Q', payload, record + 8, self_pointer)
            struct.pack_into('<Q', payload, record + 16, self_pointer)
            struct.pack_into('<Q', payload, record + 48,
                             0x00000001ffffffff)
        state = write_virtual(state, record_start, payload)
        if scalar_update is not None:
            scalar_address, scalar_value, _scalar_threshold = scalar_update
            if record_start <= scalar_address < record_start + len(payload):
                return state
            state = write_virtual(
                state, scalar_address,
                struct.pack('<Q', scalar_value + count))

        last = start + count - 1
        end = start + count
        offset = (last << 6) & MASK64
        registers = _write_register(
            state.registers, base_register, (last << 55) & MASK64, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], offset, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdi'], base + offset, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdx'], base + offset + 8, 64)
        registers = _write_register(registers, index, end, 64)
        flags = _result_flags(
            state.rflags, 'cmp', end, stop, (end - stop) & MASK64, 64)
        self.collapsed_affine_records += count
        self.collapsed_affine_record_bytes += len(payload)
        return replace(state, registers=registers, rflags=flags,
                       rip=target if end < stop else following)

    def _relative_record_projection_layout(self, state, target):
        """Prove one relative-record range/tag/index projection loop."""
        target = int(target) & MASK64
        cached = self._relative_record_projection_loops.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout

        layout = None
        start = (target - 17) & MASK64
        extent = len(_RELATIVE_RECORD_PROJECTION_CORE)
        try:
            code = bytearray(read_virtual(
                state, start, extent, 'execute'))
            upper = _signed_integer(
                int.from_bytes(code[7:11], 'little'), 32) & MASK64
            end = _signed_integer(
                int.from_bytes(code[46:50], 'little'), 32) & MASK64
            lower = _signed_integer(
                int.from_bytes(code[82:86], 'little'), 32) & MASK64
            code[7:11] = bytes(4)
            code[46:50] = bytes(4)
            code[82:86] = bytes(4)
            if bytes(code) == _RELATIVE_RECORD_PROJECTION_CORE:
                layout = 'slot', end, lower, upper
        except PageFault:
            pass
        if layout is None:
            start = target
            extent = len(_RELATIVE_RECORD_PROJECTION_FORWARD_CORE)
            try:
                code = bytearray(read_virtual(
                    state, start, extent, 'execute'))
                lower = _signed_integer(
                    int.from_bytes(code[30:34], 'little'), 32) & MASK64
                upper = _signed_integer(
                    int.from_bytes(code[47:51], 'little'), 32) & MASK64
                end = _signed_integer(
                    int.from_bytes(code[106:110], 'little'), 32) & MASK64
                code[30:34] = bytes(4)
                code[47:51] = bytes(4)
                code[106:110] = bytes(4)
                if bytes(code) == _RELATIVE_RECORD_PROJECTION_FORWARD_CORE:
                    layout = 'coordinate', end, lower, upper
            except PageFault:
                pass
        config, proof = _execution_proof(state, start, extent)
        if proof is not None:
            self._relative_record_projection_loops[target] = (
                config, proof, layout)
        else:
            self._relative_record_projection_loops.pop(target, None)
        return layout

    def _collapse_relative_record_projection(self, state, branch):
        """Batch sorted relative records between page-fault barriers."""
        if branch.boundary.operation == 'conditional_branch':
            following, target, condition = branch.boundary.detail
            if condition != 2:
                return state
        else:
            following = (branch.rip + len(branch.source)) & MASK64
            target = branch.boundary.detail
        target = int(target) & MASK64
        if state.rip != target or target >= branch.rip:
            return state
        layout = self._relative_record_projection_layout(state, target)
        if layout is None:
            return state
        variant, end, lower, upper = layout
        start = state.register('rax')
        distance = end - start
        if (distance <= 0 or distance > (1 << 24)
                or distance & 15):
            return state
        count = distance // 16
        try:
            payload = bytearray(read_virtual(
                state, start, distance, 'read'))
            write_page = start
            while write_page < end:
                translate(state, write_page, 'write')
                write_page = ((write_page >> 12) + 1) << 12
            translate(state, end - 1, 'write')
        except PageFault:
            return state

        coordinate_start = (start if variant == 'slot'
                            else state.register('rbx'))
        previous_target = state.register(
            'rdi' if variant == 'slot' else 'rcx')
        target_updates = []
        last_target = state.register('rdx')
        last_previous_target = previous_target
        last_first = state.register('rcx')
        last_value = state.register('rsi')
        last_node_value = None
        try:
            for index in range(count):
                offset = index * 16
                slot = (coordinate_start + offset) & MASK64
                first = struct.unpack_from('<I', payload, offset)[0]
                raw = struct.unpack_from('<Q', payload, offset + 8)[0]
                first_target = (
                    slot + _signed_integer(first, 32)) & MASK64
                current_target = (
                    slot + 8 + (raw & ~3)) & MASK64

                # The scalar loop performs this otherwise-dead load before
                # publishing either write.  Retain it only as a page proof.
                load_virtual(state, current_target, 4)
                in_range = lower <= first_target < upper
                value = raw | 2 if in_range else raw & ~2
                struct.pack_into('<Q', payload, offset + 8, value)

                last_previous_target = previous_target
                node_value = None
                if current_target != previous_target:
                    node_value = load_virtual(
                        state, current_target + 8, 8)
                    translate(state, current_target + 8, 'write')
                    translate(state, current_target + 15, 'write')
                    node_value = (node_value & 3) | slot
                    target_updates.append(
                        (current_target + 8, node_value))
                previous_target = current_target
                last_target = current_target
                last_first = first_target
                last_value = value
                last_node_value = node_value
        except PageFault:
            return state

        state = write_virtual(state, start, payload)
        try:
            for address, value in target_updates:
                state = write_virtual(
                    state, address, struct.pack('<Q', value))
        except PageFault:
            return state

        last_predicate = int(lower <= last_first < upper)
        last_rcx = (last_node_value if last_node_value is not None
                    else (last_first + last_predicate) & MASK64)
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], end, 64)
        if variant == 'slot':
            registers = _write_register(
                registers, REGISTER_INDEX['rdi'], last_previous_target, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rcx'], last_rcx, 64)
        else:
            registers = _write_register(
                registers, REGISTER_INDEX['rbx'],
                coordinate_start + distance, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rcx'], last_target, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rdi'], last_predicate, 32)
            first_high = last_first & (MASK64 ^ 0xff)
            registers = _write_register(
                registers, REGISTER_INDEX['r8'],
                first_high | int(last_first >= lower), 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdx'], last_target, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rsi'], last_value, 64)
        flags = _result_flags(
            state.rflags, 'cmp', end, end, 0, 64)
        self.collapsed_relative_record_projections += 1
        self.collapsed_relative_projection_records += count
        return replace(
            state, registers=registers, rflags=flags,
            rip=int(following) & MASK64)

    def _collapse_ftrace_location_span(self, state, branch):
        """Append a proved run of trace locations as strided records."""
        target = int(branch.boundary.detail) & MASK64
        if state.rip != target or target >= branch.rip:
            return state

        def following(block):
            return block.rip + len(block.source)

        def block_at(address):
            block = self.blocks.get(address)
            if block is None:
                block = self.block(replace(
                    _freeze_state(state), rip=address))
            return block

        compare = block_at(target)
        bound_branch = block_at(following(compare))
        load = block_at(following(bound_branch))
        zero_test = block_at(following(load))
        zero_branch = block_at(following(zero_test))
        mode_test = block_at(following(zero_branch))
        mode_branch = block_at(following(mode_test))
        if tuple(block.boundary.operation for block in (
                compare, bound_branch, load, zero_test, zero_branch,
                mode_test, mode_branch)) != (
                'compare', 'conditional_branch', 'load', 'compare',
                'conditional_branch', 'compare', 'conditional_branch'):
            return state
        (_compare_next, opcode, end_register,
         pointer_register, compare_bits) = compare.boundary.detail
        (_bound_next, exit_target,
         bound_condition) = bound_branch.boundary.detail
        (_load_next, location_register,
         location_bits, location_operand) = load.boundary.detail
        (_zero_next, zero_opcode, zero_register,
         zero_operand, zero_bits) = zero_test.boundary.detail
        (_zero_following, _zero_target,
         zero_condition) = zero_branch.boundary.detail
        (_mode_next, mode_opcode, mode_register,
         mode_operand, mode_bits) = mode_test.boundary.detail
        (_mode_following, append_entry,
         mode_condition) = mode_branch.boundary.detail
        if (opcode != 0x39 or compare_bits != 64
                or not isinstance(end_register, int)
                or not isinstance(pointer_register, int)
                or bound_condition != 3
                or location_bits != 64
                or location_register in (end_register, pointer_register)
                or not isinstance(location_operand, MemoryOperand)
                or location_operand.base != pointer_register
                or location_operand.index is not None
                or location_operand.displacement != 0
                or location_operand.rip_relative
                or zero_opcode != 0x85
                or zero_register != location_register
                or zero_operand != location_register or zero_bits != 64
                or zero_condition != 4
                or mode_opcode != 0x85 or mode_register != mode_operand
                or mode_bits != 64 or mode_condition != 5):
            return state

        text_start = text_stop = None
        if not state.registers[mode_register]:
            lower = block_at(following(mode_branch))
            lower_set = block_at(following(lower))
            upper = block_at(following(lower_set))
            upper_set = block_at(following(upper))
            range_test = block_at(following(upper_set))
            range_branch = block_at(following(range_test))
            if (lower.boundary.operation != 'immediate_alu'
                    or upper.boundary.operation != 'immediate_alu'
                    or lower.boundary.detail[1] != 'cmp'
                    or upper.boundary.detail[1] != 'cmp'
                    or lower.boundary.detail[2] != location_register
                    or upper.boundary.detail[2] != location_register
                    or lower.boundary.detail[3] != 64
                    or upper.boundary.detail[3] != 64
                    or lower_set.boundary.operation != 'set_condition'
                    or upper_set.boundary.operation != 'set_condition'
                    or range_test.boundary.operation != 'compare'
                    or range_branch.boundary.operation
                    != 'conditional_branch'
                    or range_branch.boundary.detail[1] != append_entry):
                return state
            text_start = int(lower.boundary.detail[4]) & MASK64
            text_stop = int(upper.boundary.detail[4]) & MASK64
            if text_start >= text_stop:
                return state

        count_load = block_at(append_entry)
        if count_load.boundary.operation != 'load':
            return state
        _count_next, count_register, count_bits, count_operand = \
            count_load.boundary.detail
        if (count_bits != 32 or not isinstance(count_operand, MemoryOperand)
                or count_operand.base is None or count_operand.index is not None
                or count_operand.displacement != 16
                or count_operand.rip_relative):
            return state
        page_register = count_operand.base
        count_increment = block_at(following(count_load))
        count_extend = block_at(following(count_increment))
        byte_shift = block_at(following(count_extend))
        order_load = block_at(following(byte_shift))
        page_shift = block_at(following(order_load))
        capacity_compare = block_at(following(page_shift))
        capacity_branch = block_at(following(capacity_compare))
        if tuple(block.boundary.operation for block in (
                count_increment, count_extend, byte_shift, order_load,
                page_shift, capacity_compare, capacity_branch)) != (
                'lea', 'move_sign_extend', 'shift_result_flags',
                'move_zero_extend', 'shift', 'compare',
                'conditional_branch'):
            return state
        next_count = count_increment.boundary.detail[1]
        byte_count_register = count_extend.boundary.detail[1]
        order_register = order_load.boundary.detail[1]
        page_bytes_register = page_shift.boundary.detail[2]
        count_induction = count_increment.boundary.detail[3]
        order_operand = order_load.boundary.detail[4]
        if (count_increment.boundary.detail[2] != 32
                or not isinstance(count_induction, MemoryOperand)
                or count_induction.base != count_register
                or count_induction.index is not None
                or count_induction.displacement != 1
                or count_extend.boundary.detail[2:4] != (32, 64)
                or count_extend.boundary.detail[4] != next_count
                or byte_shift.boundary.detail[2] != byte_count_register
                or byte_shift.boundary.detail[3:] != (64, 4)
                or order_load.boundary.detail[2:4] != (8, 32)
                or not isinstance(order_operand, MemoryOperand)
                or order_operand.base != page_register
                or order_operand.displacement != 20
                or page_shift.source != bytes.fromhex(
                    'bf 00 10 00 00 48 d3 e7')
                or page_shift.boundary.detail[1] != 4
                or page_shift.boundary.detail[3] != 64
                or capacity_compare.boundary.detail[1] != 0x39
                or capacity_compare.boundary.detail[2]
                != page_bytes_register
                or capacity_compare.boundary.detail[3]
                != byte_count_register
                or capacity_compare.boundary.detail[4] != 64
                or capacity_branch.boundary.detail[2] != 6):
            return state
        fast_entry = capacity_branch.boundary.detail[1]
        data_load = block_at(fast_entry)
        count_store = block_at(following(data_load))
        index_extend = block_at(following(count_store))
        index_shift = block_at(following(index_extend))
        record_store = block_at(following(index_shift))
        input_update = block_at(following(record_store))
        direct_branch = block_at(following(input_update))
        if tuple(block.boundary.operation for block in (
                data_load, count_store, index_extend, index_shift,
                record_store, input_update, direct_branch)) != (
                'load', 'store', 'accumulator_sign_extend',
                'shift_result_flags', 'store',
                'register_immediate_result_flags', 'branch'):
            return state
        (_data_next, data_register, data_bits,
         data_operand) = data_load.boundary.detail
        (_store_next, stored_count, stored_count_bits,
         stored_count_operand) = count_store.boundary.detail
        (_record_next, stored_location, stored_location_bits,
         record_operand) = record_store.boundary.detail
        (_input_next, input_name, updated_input,
         input_bits, input_stride) = input_update.boundary.detail
        if (data_load.source != bytes.fromhex('4c 89 d1 48 8b 71 08')
                or data_bits != 64
                or not isinstance(data_operand, MemoryOperand)
                or data_operand.displacement != 8
                or stored_count != next_count or stored_count_bits != 32
                or not isinstance(stored_count_operand, MemoryOperand)
                or stored_count_operand.base != REGISTER_INDEX['rcx']
                or stored_count_operand.displacement != 16
                or index_extend.boundary.detail != (
                    following(index_extend), 32, 64)
                or index_shift.boundary.detail[2] != REGISTER_INDEX['rax']
                or index_shift.boundary.detail[3:] != (64, 4)
                or stored_location != location_register
                or stored_location_bits != 64
                or not isinstance(record_operand, MemoryOperand)
                or record_operand.base != data_register
                or record_operand.index != REGISTER_INDEX['rax']
                or record_operand.scale != 1
                or record_operand.displacement != 0
                or input_name != 'add'
                or updated_input != pointer_register or input_bits != 64
                or input_stride != 8
                or direct_branch.rip != branch.rip
                or direct_branch.boundary.detail != target):
            return state
        page = state.registers[page_register] & MASK64
        count = load_virtual(state, page + 16, 4)
        order = load_virtual(state, page + 20, 1)
        if order > 12:
            return state
        capacity = (4096 << order) // 16
        if count >= capacity:
            return state
        data = load_virtual(state, page + 8, 8)

        pointer = state.registers[pointer_register] & MASK64
        end = state.registers[end_register] & MASK64
        if pointer >= end or (end - pointer) % 8:
            return state
        limit = min((end - pointer) // 8, capacity - count, 4096)
        locations = []
        for offset in range(limit):
            location = load_virtual(state, pointer + offset * 8, 8)
            if not location:
                break
            if (text_start is not None
                    and not text_start <= location < text_stop):
                break
            locations.append(location)
        if not locations:
            return state

        for offset, location in enumerate(locations):
            state = write_virtual(
                state, data + (count + offset) * 16,
                struct.pack('<Q', location))
        new_count = count + len(locations)
        state = write_virtual(
            state, page + 16, struct.pack('<I', new_count))

        new_pointer = pointer + len(locations) * 8
        last_index = new_count - 1
        registers = _write_register(
            state.registers, location_register, locations[-1], 64)
        registers = _write_register(
            registers, pointer_register, new_pointer, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rax'], last_index * 16, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdx'], new_count, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rsi'], data, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], page, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdi'], 4096 << order, 64)
        if new_pointer == end:
            flags = _result_flags(
                state.rflags, 'cmp', new_pointer, end,
                (new_pointer - end) & MASK64, 64)
            rip = exit_target
        else:
            prior_pointer = new_pointer - 8
            flags = _result_flags(
                state.rflags, 'add', prior_pointer, 8,
                new_pointer & MASK64, 64)
            rip = target
        self.collapsed_ftrace_locations += len(locations)
        return replace(state, registers=registers,
                       rflags=flags, rip=rip)

    def _indirect_string_directory(self, state, start, stop):
        """Retain a proved pointer table as compact string-key records."""
        key = int(start) & MASK64, int(stop) & MASK64
        cached = self._indirect_string_directories.get(key)
        if cached is not None:
            config, proof, directory = cached
            if _proof_mismatch(state, config, proof) is None:
                self.indirect_string_cache_hits += 1
                return directory
        start, stop = key
        if stop < start or (stop - start) % 8 \
                or stop - start > (1 << 23):
            return None
        reader = _VirtualProofReader(state)
        directory = []
        try:
            for slot in range(start, stop, 8):
                metadata = reader.load(slot, 8)
                name_address = reader.load(metadata, 8) if metadata else 0
                if not name_address:
                    directory.append((metadata, 0, b''))
                    continue
                key_address = (name_address + 3) & MASK64
                name = self._proof_cstring(reader, key_address, 4096)
                if name is None:
                    return None
                directory.append((metadata, key_address, name))
        except PageFault:
            return None
        config, proof = reader.proof()
        directory = tuple(directory)
        self._indirect_string_directories[key] = \
            config, proof, directory
        self.indirect_string_cache_misses += 1
        return directory

    def _collapse_indirect_string_table_span(self, state, branch):
        """Resolve a proved indirect string table without scalar calls."""
        target = int(branch.boundary.detail) & MASK64
        if state.rip != target or target >= branch.rip:
            return state
        try:
            prefix = read_virtual(state, target - 7, 7, 'execute')
        except PageFault:
            return state
        if prefix[:3] != b'\x49\xc7\xc6':
            return state
        table_start = _signed_integer(
            int.from_bytes(prefix[3:], 'little'), 32) & MASK64

        def following(block):
            return block.rip + len(block.source)

        def block_at(address):
            block = self.blocks.get(address)
            if block is None:
                block = self.block(replace(
                    _freeze_state(state), rip=address))
            return block

        bound = block_at(target)
        bound_branch = block_at(following(bound))
        metadata_load = block_at(following(bound_branch))
        name_load = block_at(following(metadata_load))
        zero_test = block_at(following(name_load))
        zero_branch = block_at(following(zero_test))
        name_update = block_at(following(zero_branch))
        candidate = block_at(following(name_update))
        compare_call = block_at(following(candidate))
        result_test = block_at(following(compare_call))
        result_branch = block_at(following(result_test))
        if tuple(block.boundary.operation for block in (
                bound, bound_branch, metadata_load, name_load,
                zero_test, zero_branch, name_update, candidate,
                compare_call, result_test, result_branch)) != (
                'immediate_alu', 'conditional_branch', 'load', 'load',
                'compare', 'conditional_branch',
                'register_immediate_result_flags', 'lea', 'call',
                'compare', 'conditional_branch'):
            return state
        (_bound_next, bound_name, table_register,
         bound_bits, table_stop) = bound.boundary.detail
        (_exit_following, exit_target,
         exit_condition) = bound_branch.boundary.detail
        (_metadata_next, metadata_register,
         metadata_bits, metadata_operand) = metadata_load.boundary.detail
        (_name_next, name_register,
         name_bits, name_operand) = name_load.boundary.detail
        (_zero_next, zero_opcode, tested_name,
         zero_operand, zero_bits) = zero_test.boundary.detail
        (_zero_following, update_target,
         zero_condition) = zero_branch.boundary.detail
        (_name_update_next, update_name, updated_name,
         update_bits, name_displacement) = name_update.boundary.detail
        (_candidate_next, candidate_register,
         candidate_bits, candidate_operand) = candidate.boundary.detail
        call_following, compare_target = compare_call.boundary.detail
        if (bound_name != 'cmp' or bound_bits != 64
                or table_register != REGISTER_INDEX['r14']
                or exit_condition != 3
                or metadata_bits != 64
                or not isinstance(metadata_operand, MemoryOperand)
                or metadata_operand.base != table_register
                or metadata_operand.index is not None
                or name_bits != 64
                or not isinstance(name_operand, MemoryOperand)
                or name_operand.base != metadata_register
                or name_operand.index is not None
                or zero_opcode != 0x85 or tested_name != name_register
                or zero_operand != name_register or zero_bits != 64
                or zero_condition != 4
                or update_name != 'add' or updated_name != name_register
                or update_bits != 64 or name_displacement != 3
                or candidate_register != REGISTER_INDEX['rdi']
                or candidate_bits != 64
                or not isinstance(candidate_operand, MemoryOperand)
                or candidate_operand.base != REGISTER_INDEX['rsp']
                or candidate_operand.index is not None
                or candidate_operand.displacement != 3
                or not self._is_string_compare_function(
                    state, compare_target & MASK64)
                or result_test.boundary.detail[1] != 0x85
                or result_test.boundary.detail[2]
                != REGISTER_INDEX['rax']
                or result_branch.boundary.detail[2] != 4):
            return state

        update = next((block for width in range(1, 16)
                       for block in (self.blocks.get(branch.rip - width),)
                       if block is not None
                       and following(block) == branch.rip), None)
        if update is None:
            candidate_update = block_at(branch.rip - 4)
            if following(candidate_update) == branch.rip:
                update = candidate_update
        if (update is None
                or update.boundary.operation
                != 'register_immediate_result_flags'
                or update.boundary.detail[1:] != (
                    'add', table_register, 64, 8)
                or update.rip != update_target):
            return state
        table_stop = int(table_stop) & MASK64
        cursor = state.registers[table_register] & MASK64
        if (cursor < table_start or cursor >= table_stop
                or (cursor - table_start) % 8):
            return state
        directory = self._indirect_string_directory(
            state, table_start, table_stop)
        if directory is None:
            return state
        zero = find_virtual(
            state, state.register('rsp'), 512, (0,))
        if zero is None:
            return state
        symbol = read_virtual(state, state.register('rsp'), zero)
        candidates = [(3, symbol[3:])]
        if symbol.startswith(b'__x64_'):
            candidates.append((9, symbol[9:]))
        if symbol.startswith(b'__ia32_'):
            candidates.append((10, symbol[10:]))
        if symbol.startswith(b'__do_sys'):
            candidates.append((8, symbol[8:]))

        start_index = (cursor - table_start) // 8
        match = None
        scanned = 0
        for index in range(start_index, len(directory)):
            metadata, name_address, name = directory[index]
            scanned += 1
            if not name_address:
                continue
            candidate_match = next(
                ((offset, value) for offset, value in candidates
                 if value == name), None)
            if candidate_match is not None:
                match = index, metadata, name_address, candidate_match[0]
                break
        registers = state.registers
        if match is None:
            registers = _write_register(
                registers, table_register, table_stop, 64)
            flags = _result_flags(
                state.rflags, 'cmp', table_stop, table_stop, 0, 64)
            rip = exit_target
        else:
            index, metadata, name_address, symbol_offset = match
            registers = _write_register(
                registers, table_register,
                table_start + index * 8, 64)
            registers = _write_register(
                registers, metadata_register, metadata, 64)
            registers = _write_register(
                registers, name_register, name_address, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rdi'],
                state.register('rsp') + symbol_offset, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rsi'], name_address, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rax'], 0, 32)
            registers = _write_register(
                registers, REGISTER_INDEX['rcx'], 0, 32)
            flags = _result_flags(state.rflags, 'xor', 0, 0, 0, 32)
            rip = result_branch.boundary.detail[1]
        self.collapsed_indirect_string_entries += scanned
        return replace(state, registers=registers,
                       rflags=flags, rip=rip)

    def _collapse_byte_search(self, state, branch):
        """Reduce byte-or-NUL search loops to one minimized class scan."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if cursor != branch.rip or len(loop) != 5:
            return state
        test, zero_branch, load, update, compare = loop
        if (test.boundary.operation != 'compare'
                or zero_branch.boundary.operation != 'conditional_branch'
                or load.boundary.operation != 'move_zero_extend'
                or update.boundary.operation != 'group_ff'
                or compare.boundary.operation != 'compare'):
            return state
        (_test_next, test_opcode, tested,
         test_operand, test_bits) = test.boundary.detail
        (_zero_following, zero_target,
         zero_condition) = zero_branch.boundary.detail
        (_load_next, temporary, source_bits,
         target_bits, source) = load.boundary.detail
        (_update_next, group, pointer, pointer_bits) = update.boundary.detail
        (_compare_next, compare_opcode, needle,
         compared, compare_bits) = compare.boundary.detail
        if (test_opcode != 0x84 or tested != temporary
                or test_operand != temporary or test_bits != 8
                or zero_condition != 4 or source_bits != 8
                or target_bits not in (32, 64)
                or group != 0 or pointer_bits != 64
                or compare_opcode not in (0x38, 0x3a)
                or compared != temporary or compare_bits != 8
                or not isinstance(temporary, int)
                or self._register_root(needle) is None
                or not isinstance(source, MemoryOperand)
                or source.rip_relative or source.segment_msr is not None
                or source.base != pointer or source.index is not None
                or source.displacement != 1):
            return state

        needle_value = _register_operand_value(
            state.registers, needle, 8)
        classes = self._inactive_byte_classes((0, needle_value))
        address = (state.registers[pointer] + 1) & MASK64
        stop = find_virtual(
            state, address, 1 << 20, classes.coordinates(False))
        if stop is None:
            return state
        byte = read_virtual(state, address + stop, 1)[0]
        scanned = stop + 1
        registers = _write_register(
            state.registers, pointer,
            state.registers[pointer] + scanned, 64)
        registers = _write_register(
            registers, temporary, byte, target_bits)
        if byte == needle_value:
            flags = _result_flags(
                state.rflags, 'cmp', byte, needle_value, 0, 8)
            rip = following
        else:
            flags = _result_flags(state.rflags, 'and', 0, 0, 0, 8)
            rip = zero_target
        self.collapsed_search_bytes += scanned
        return replace(state, registers=registers, rip=rip,
                       rflags=flags)

    def _collapse_substring_candidates(self, state, branch):
        """Skip outer search candidates disproved by direct byte proofs."""
        _following, target, condition = branch.boundary.detail
        if condition != 3 or state.rip != target or target >= branch.rip:
            return state

        def predecessor(end, operation):
            candidates = [block for width in range(1, 16)
                          for block in (self.blocks.get(end - width),)
                          if block is not None
                          and block.rip + len(block.source) == end
                          and block.boundary.operation == operation]
            return candidates[0] if len(candidates) == 1 else None

        compare = predecessor(branch.rip, 'compare')
        if compare is None:
            return state
        pointer_update = predecessor(compare.rip, 'group_ff')
        if pointer_update is None:
            return state
        remaining_update = predecessor(pointer_update.rip, 'group_ff')
        if remaining_update is None:
            return state
        (_compare_next, opcode, length_register,
         remaining, bits) = compare.boundary.detail
        (_pointer_next, pointer_group,
         pointer, pointer_bits) = pointer_update.boundary.detail
        (_remaining_next, remaining_group,
         remaining_register, remaining_bits) = \
            remaining_update.boundary.detail
        if (opcode != 0x39 or not isinstance(length_register, int)
                or remaining != remaining_register
                or not isinstance(remaining_register, int)
                or pointer_group != 0 or remaining_group != 1
                or bits != 64 or pointer_bits != 64
                or remaining_bits != 64):
            return state

        header = self.blocks.get(target)
        if header is None or header.boundary.operation != 'immediate_alu':
            return state
        (_header_next, header_name, header_operand,
         header_bits, _header_immediate) = header.boundary.detail
        if (header_name != 'cmp' or header_operand != length_register
                or header_bits != 64):
            return state
        locals_ = header.plan.locals
        haystack_aliases = [index for index in range(len(REGISTER_NAMES))
                            if index != pointer
                            and locals_[index] == Operand('local', pointer)]
        if len(haystack_aliases) != 1:
            return state
        haystack_alias = haystack_aliases[0]

        needle_alias = None
        for load in self.blocks.values():
            if not target <= load.rip < branch.rip \
                    or load.boundary.operation != 'move_zero_extend':
                continue
            load_next, temporary, source_bits, _target_bits, source = \
                load.boundary.detail
            if (source_bits != 8 or not isinstance(source, MemoryOperand)
                    or source.base != haystack_alias):
                continue
            candidate = self.blocks.get(load_next)
            if candidate is None or candidate.boundary.operation != 'compare':
                continue
            (_next, compare_opcode, compared,
             operand, compare_bits) = candidate.boundary.detail
            if (compare_opcode != 0x3a or compared != temporary
                    or compare_bits != 8
                    or not isinstance(operand, MemoryOperand)
                    or operand.base is None):
                continue
            needle_alias = operand.base
            break
        if needle_alias is None or needle_alias >= len(locals_):
            return state
        needle_local = locals_[needle_alias]
        if needle_local.kind != 'local' \
                or not 0 <= needle_local.value < len(REGISTER_NAMES):
            return state
        needle_pointer = needle_local.value

        length = state.registers[length_register] & MASK64
        remaining_bytes = state.registers[remaining_register] & MASK64
        if (not length or remaining_bytes < length
                or remaining_bytes > 1 << 20):
            return state
        needle_bytes = read_virtual(
            state, state.registers[needle_pointer], length)
        found = find_virtual_sequence(
            state, state.registers[pointer], remaining_bytes, needle_bytes)
        candidate_count = remaining_bytes - length + 1
        skipped = found if found is not None else candidate_count - 1
        if skipped <= 0:
            return state
        registers = _write_register(
            state.registers, pointer,
            state.registers[pointer] + skipped, 64)
        registers = _write_register(
            registers, remaining_register, remaining_bytes - skipped, 64)
        self.collapsed_substring_candidates += skipped
        return replace(state, registers=registers, rip=target)

    def _collapse_strided_predicate_candidates(self, state, branch):
        """Skip fixed-stride records disproved by a validator's first byte."""
        _following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        direct = None
        try:
            code = read_virtual(state, target, 0x21, 'execute')
        except PageFault:
            try:
                code = read_virtual(state, target, 0x15, 'execute')
            except PageFault:
                return state
        if (len(code) >= 0x21
                and code[:7] == bytes.fromhex('48 83 c3 10 4c 39 f3')
                and code[7] == 0x73
                and code[9:0x0a] == b'\xba'
                and code[0x0e:0x14] == bytes.fromhex(
                    '48 89 df 48 c7 c6')
                and code[0x18] == 0xe8
                and code[0x1d:0x21] == bytes.fromhex('85 c0 75 df')):
            compare = (target + 0x1d + _signed_integer(
                int.from_bytes(code[0x19:0x1d], 'little'), 32)) & MASK64
            signature = _signed_integer(
                int.from_bytes(code[0x14:0x18], 'little'), 32) & MASK64
            length = int.from_bytes(code[0x0a:0x0e], 'little')
            try:
                first_byte = load_virtual(state, signature, 1)
            except PageFault:
                return state
            if (length and self._is_bounded_string_compare_function(
                    state, compare)):
                direct = signature, length
        if direct is None:
            code = code[:0x15]
            if (code[:0x0d] != _STRIDED_PREDICATE_LOOP
                    or code[0x11:0x15] != bytes.fromhex('85 c0 75 eb')):
                return state
            validator = (target + 0x11 + _signed_integer(
                int.from_bytes(code[0x0d:0x11], 'little'), 32)) & MASK64
            layout = self._strided_validator_layout(state, validator)
            if layout is None:
                return state
            first_byte, _signature_length = layout
        current = state.register('rbx') & MASK64
        bound = state.register('r14') & MASK64
        start = (current + 16) & MASK64
        if (start > bound or (bound - start) % 16
                or bound - start > (1 << 30)):
            return state
        count = (bound - start) // 16
        if not count:
            return state
        try:
            payload = read_virtual(state, start, bound - start)
        except PageFault:
            return state
        found = next((index for index in range(count)
                      if payload[index * 16] == first_byte), None)
        skipped = count if found is None else found
        if not skipped:
            return state
        registers = state.registers
        if found is None:
            registers = _write_register(
                registers, REGISTER_INDEX['rbx'], bound, 64)
            flags = _result_flags(
                state.rflags, 'cmp', bound, bound, 0, 64)
            exit_target = (target + 9 + _signed_integer(code[8], 8)) & MASK64
            rip = exit_target
        else:
            candidate = (start + found * 16) & MASK64
            registers = _write_register(
                registers, REGISTER_INDEX['rbx'], candidate, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rdi'], candidate, 64)
            if direct is not None:
                signature, length = direct
                registers = _write_register(
                    registers, REGISTER_INDEX['rsi'], signature, 64)
                registers = _write_register(
                    registers, REGISTER_INDEX['rdx'], length, 32)
            flags = _result_flags(
                state.rflags, 'cmp', bound, candidate,
                (bound - candidate) & MASK64, 64)
            rip = (target + (0x18 if direct is not None else 0x0c)) & MASK64
        self.collapsed_strided_predicate_candidates += skipped
        return replace(state, registers=registers, rflags=flags, rip=rip)

    def _fixed_signature_gate_layout(self, state, target):
        """Prove coordinates whose fixed byte signatures gate a validator."""
        target = int(target) & MASK64
        cached = self._fixed_signature_gate_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = reader.read(target, 0x4c)
            smbios3 = (
                code[:0x21] == bytes.fromhex(
                    '0f 1f 44 00 00 55 48 89 e5 53 '
                    'b8 5f 53 4d 33 33 07 0f b6 4f 04 '
                    '83 f1 5f 09 c1 bb 01 00 00 00 75 21')
                and code[0x42:0x48] == bytes.fromhex(
                    '89 d8 5b 5d 2e e9'))
            if smbios3:
                return_thunk = (target + 0x4c + _signed_integer(
                    int.from_bytes(code[0x48:0x4c], 'little'), 32)) & MASK64
                if reader.read(return_thunk, 1) == b'\xc3':
                    layout = ((0, b'_SM3_'),)
            else:
                code = reader.read(target, 0x11b)
                first_gate = (
                    code[:0x16] == bytes.fromhex(
                        '0f 1f 44 00 00 55 48 89 e5 '
                        '41 57 41 56 41 54 53 48 89 fb 45 31 ff')
                    and code[0x16:0x1c] == bytes.fromhex(
                        '81 3f 5f 53 4d 5f')
                    and code[0x1c:0x1e] == bytes.fromhex('0f 85')
                    and (target + 0x22 + _signed_integer(
                        int.from_bytes(code[0x1e:0x22], 'little'), 32)
                         & MASK64) == (target + 0xd6) & MASK64)
                second_gate = (
                    code[0xd6:0xef] == bytes.fromhex(
                        'b8 5f 44 4d 49 33 43 10 0f b6 4b 14 '
                        '83 f1 5f 09 c1 41 be 01 00 00 00 75 1b')
                    and code[0x10a:0x117] == bytes.fromhex(
                        '44 89 f0 5b 41 5c 41 5e 41 5f 5d 2e e9'))
                return_thunk = (target + 0x11b + _signed_integer(
                    int.from_bytes(code[0x117:0x11b], 'little'), 32)) & MASK64
                if (first_gate and second_gate
                        and reader.read(return_thunk, 1) == b'\xc3'):
                    layout = ((0, b'_SM_'), (16, b'_DMI_'))
        except PageFault:
            pass
        config, proof = reader.proof()
        self._fixed_signature_gate_functions[target] = \
            config, proof, layout
        return layout

    def _collapse_strided_copy_predicate_candidates(self, state, branch):
        """Project copy/validate records onto fixed signature coordinates."""
        following, target, condition = branch.boundary.detail
        if condition != 2 or state.rip != target or target >= branch.rip:
            return state
        try:
            code = read_virtual(state, target, 0x35, 'execute')
        except PageFault:
            return state
        if (code[:8] != bytes.fromhex(
                'ba 10 00 00 00 4c 89 f7')
                or code[8:10] != bytes.fromhex('4c 89')
                or code[11] != 0xe8
                or code[0x10:0x12] != bytes.fromhex('4c 89')
                or code[0x13] != 0xe8
                or code[0x18:0x1b] != bytes.fromhex('85 c0 74')
                or code[0x1b] not in (0x34, 0x7f)
                or code[0x1c:0x2e] != bytes.fromhex(
                    '49 8b 06 49 8b 4e 08 48 89 4c 24 08 '
                    '48 89 04 24 49 83')
                or code[0x2f:0x32] != bytes.fromhex('10 4d 39')
                or code[0x33:0x35] != bytes.fromhex('72 cb')):
            return state
        source_modrm = code[10]
        update_modrm = code[0x2e]
        argument_modrm = code[0x12]
        compare_modrm = code[0x32]
        if (source_modrm & 0xc7 != 0xc6
                or update_modrm & 0xf8 != 0xc0
                or argument_modrm & 0xc7 != 0xc7
                or compare_modrm & 0xf8 != 0xe8):
            return state
        source_register = ((source_modrm >> 3) & 7) | 8
        update_register = (update_modrm & 7) | 8
        argument_register = ((argument_modrm >> 3) & 7) | 8
        if (source_register != update_register
                or (compare_modrm & 7) | 8 != source_register):
            return state
        copy = (target + 0x10 + _signed_integer(
            int.from_bytes(code[0x0c:0x10], 'little'), 32)) & MASK64
        validator = (target + 0x18 + _signed_integer(
            int.from_bytes(code[0x14:0x18], 'little'), 32)) & MASK64
        signatures = self._fixed_signature_gate_layout(state, validator)
        if (not self._is_void_memory_copy_function(state, copy)
                or signatures is None):
            return state
        current = state.registers[source_register] & MASK64
        bound = state.register('r13') & MASK64
        stack = state.register('rsp') & MASK64
        destination = state.register('r14') & MASK64
        argument = state.registers[argument_register] & MASK64
        if (current < 16 or current >= bound or (bound - current) % 16
                or destination != stack + 16 or argument != stack):
            return state
        count = (bound - current) // 16
        try:
            payload = read_virtual(state, current - 16, bound - current + 16)
            if read_virtual(state, stack, 16) != payload[:16]:
                return state
        except PageFault:
            return state
        candidate = count
        for offset, signature in signatures:
            position = payload.find(signature, offset)
            while position >= 0 and (position - offset) % 16:
                position = payload.find(signature, position + 1)
            if position >= 0:
                candidate = min(candidate, (position - offset) // 16)
        if not candidate:
            return state
        registers = state.registers
        if candidate < count:
            previous = payload[candidate * 16:candidate * 16 + 16]
            try:
                state = write_virtual(state, stack, previous)
                state = write_virtual(state, destination, previous)
            except PageFault:
                return state
            coordinate = current + candidate * 16
            registers = _write_register(
                state.registers, source_register, coordinate, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rdx'], 16, 32)
            registers = _write_register(
                registers, REGISTER_INDEX['rsi'], coordinate - 16, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rdi'], argument, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rax'],
                int.from_bytes(previous[:8], 'little'), 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rcx'],
                int.from_bytes(previous[8:], 'little'), 64)
            rip = target
            flags = _result_flags(
                state.rflags, 'cmp', coordinate, bound,
                (coordinate - bound) & MASK64, 64)
        else:
            last = (bound - 16) & MASK64
            try:
                record = read_virtual(state, last, 16)
                state = write_virtual(state, destination, record)
                state = write_virtual(state, stack, record)
            except PageFault:
                return state
            registers = _write_register(
                state.registers, source_register, bound, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rdx'], 16, 32)
            registers = _write_register(
                registers, REGISTER_INDEX['rsi'], last, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rdi'],
                argument, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rax'],
                int.from_bytes(record[:8], 'little'), 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rcx'],
                int.from_bytes(record[8:], 'little'), 64)
            flags = _result_flags(
                state.rflags, 'cmp', bound, bound, 0, 64)
            rip = following & MASK64
        self.collapsed_strided_predicate_candidates += candidate
        return replace(state, registers=registers, rflags=flags, rip=rip)

    def _default_record_loop_layout(self, state, target):
        """Prove a direct int32 table loop with an all-ones fast path."""
        target = int(target) & MASK64
        cached = self._default_record_loops.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = reader.read(target, 0x30)
            if code[:3] == bytes.fromhex('48 8b 3d'):
                code = reader.read(target, 0x6e)
            direct = (
                code[:3] == bytes.fromhex('48 8b 3d')
                and code[7:0x15] == bytes.fromhex(
                    '48 63 f0 48 85 ff 74 06 48 8d 3c b7 eb 0b')
                and code[0x15:0x19] == bytes.fromhex('48 8b 3c f5')
                and code[0x1d:0x29] == bytes.fromhex(
                    '48 01 cf 48 63 3f 48 83 ff ff 74 3b')
                and code[0x29:0x2d] == bytes.fromhex('48 0f a3 3d')
                and code[0x31:0x36] == bytes.fromhex('72 31 48 8b 3d')
                and code[0x3a:0x48] == bytes.fromhex(
                    '48 85 ff 74 09 c7 04 b7 ff ff ff ff eb 1c')
                and code[0x48:0x4c] == bytes.fromhex('48 8b 3c f5')
                and code[0x50:0x52] == bytes.fromhex('89 97')
                and code[0x56:0x5a] == bytes.fromhex('48 8b 34 f5')
                and code[0x5e:0x68] == bytes.fromhex(
                    '89 96 c0 0d e0 83 ff c0 3b 05')
                and code[0x6c:0x6e] == bytes.fromhex('72 92'))
            if direct:
                pointer_address = (target + 7 + _signed_integer(
                    int.from_bytes(code[3:7], 'little'), 32)) & MASK64
                count_address = (target + 0x6c + _signed_integer(
                    int.from_bytes(code[0x68:0x6c], 'little'), 32)) & MASK64
                pointer = reader.load(pointer_address, 8)
                count = reader.load(count_address, 4)
                layout = 'direct', pointer, count
            else:
                code = code[:0x30]
                if (code[:0x10] != bytes.fromhex(
                        '48 8d 14 8a 48 63 12 83 fa ff 74 0a 48 0f a3 15')
                        or code[0x14:0x1b] != bytes.fromhex(
                            '73 27 83 c0 01 3b 05')
                        or code[0x1f:0x24] != bytes.fromhex(
                            '73 3e 48 8b 15')
                        or code[0x28:0x30] != bytes.fromhex(
                            '48 63 c8 48 85 d2 75 d0')):
                    raise ValueError('not a default-record candidate loop')
                count_address = (target + 0x1f + _signed_integer(
                    int.from_bytes(
                        code[0x1b:0x1f], 'little'), 32)) & MASK64
                pointer_address = (target + 0x28 + _signed_integer(
                    int.from_bytes(
                        code[0x24:0x28], 'little'), 32)) & MASK64
                count = reader.load(count_address, 4)
                pointer = reader.load(pointer_address, 8)
                layout = 'legacy', pointer, count
            if not pointer or count > (1 << 24):
                raise ValueError('default-record directory is invalid')
        except (PageFault, ValueError):
            pass
        config, proof = reader.proof()
        self._default_record_loops[target] = config, proof, layout
        return layout

    def _collapse_default_record_candidates(self, state, branch):
        """Skip untouched fixed-width records through complement coordinates."""
        following, target, condition = branch.boundary.detail
        if (condition not in (2, 5) or state.rip != target
                or target >= branch.rip):
            return state
        layout = self._default_record_loop_layout(state, target)
        if layout is None:
            return state
        mode, pointer, count = layout
        if ((mode == 'legacy' and condition != 5)
                or (mode == 'direct' and condition != 2)):
            return state
        index = state.register('rax') & MASK32
        if (mode == 'legacy'
                and (state.register('rdx') != pointer
                     or state.register('rcx') != index)):
            return state
        if index >= count:
            return state
        try:
            found = find_virtual_not(
                state, pointer + index * 4, (count - index) * 4, 0xff)
        except PageFault:
            return state
        candidate = count if found is None else index + found // 4
        skipped = candidate - index
        if not skipped:
            return state
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], candidate, 32)
        if mode == 'legacy':
            registers = _write_register(
                registers, REGISTER_INDEX['rcx'], candidate - 1, 64)
        if candidate == count:
            if mode == 'legacy':
                registers = _write_register(
                    registers, REGISTER_INDEX['rdx'], MASK64, 64)
            else:
                registers = _write_register(
                    registers, REGISTER_INDEX['rsi'], count - 1, 64)
                registers = _write_register(
                    registers, REGISTER_INDEX['rdi'],
                    pointer + (count - 1) * 4, 64)
            flags = _result_flags(
                state.rflags, 'cmp', count, count, 0, 32)
            rip = ((target + 0x5f) & MASK64
                   if mode == 'legacy' else following & MASK64)
        else:
            if mode == 'legacy':
                registers = _write_register(
                    registers, REGISTER_INDEX['rcx'], candidate, 64)
                registers = _write_register(
                    registers, REGISTER_INDEX['rdx'], pointer, 64)
            flags = state.rflags
            rip = target
        self.collapsed_default_record_candidates += skipped
        return replace(state, registers=registers, rflags=flags, rip=rip)

    def _predicate_record_loop_layout(self, state, target):
        """Prove a default-record projection from a finite predicate set."""
        target = int(target) & MASK64
        cached = self._predicate_record_loops.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = reader.read(target, 0x88)
            direct = (
                code[:3] == bytes.fromhex('48 8b 15')
                and code[7:0x1a] == bytes.fromhex(
                    '49 63 ce 48 85 d2 74 0b 83 3c 8a ff '
                    '75 5d 89 04 8a eb 25')
                and code[0x3f:0x42] == bytes.fromhex('ff c0 be')
                and code[0x46:0x49] == bytes.fromhex('48 c7 c7')
                and code[0x4d:0x51] == bytes.fromhex('48 89 c2 e8')
                and code[0x55] == 0x3d
                and code[0x5a:0x5d] == bytes.fromhex('72 16 be')
                and code[0x61:0x64] == bytes.fromhex('48 c7 c7')
                and code[0x68] == 0xe8
                and code[0x6d:0x75] == bytes.fromhex(
                    '39 d8 0f 43 c3 41 ff c6')
                and code[0x75:0x78] == bytes.fromhex('44 3b 35')
                and code[0x7c:0x7e] == bytes.fromhex('72 82'))
            if direct:
                pointer_address = (target + 7 + _signed_integer(
                    int.from_bytes(code[3:7], 'little'), 32)) & MASK64
                count_address = (target + 0x7c + _signed_integer(
                    int.from_bytes(code[0x78:0x7c], 'little'), 32)) & MASK64
                pointer = reader.load(pointer_address, 8)
                count = reader.load(count_address, 4)
                size = int.from_bytes(code[0x42:0x46], 'little')
                bitmap = _signed_integer(
                    int.from_bytes(code[0x49:0x4d], 'little'), 32) & MASK64
                next_scan = (target + 0x55 + _signed_integer(
                    int.from_bytes(code[0x51:0x55], 'little'), 32)) & MASK64
                first_scan = (target + 0x6d + _signed_integer(
                    int.from_bytes(code[0x69:0x6d], 'little'), 32)) & MASK64
                if (not pointer or count > (1 << 24)
                        or not size or size > (1 << 20)
                        or int.from_bytes(code[0x56:0x5a], 'little') != size
                        or int.from_bytes(code[0x5d:0x61], 'little') != size
                        or (_signed_integer(
                            int.from_bytes(code[0x64:0x68], 'little'), 32)
                            & MASK64) != bitmap
                        or self._bit_scan_layout(state, next_scan) != 'next'
                        or self._bit_scan_layout(state, first_scan) != 'first'):
                    raise ValueError('direct predicate directory changed')
                for scan in (next_scan, first_scan):
                    scan_proof = self._bit_scan_functions.get(scan)
                    if scan_proof is None or not reader.absorb(
                            scan_proof[0], scan_proof[1]):
                        raise ValueError('predicate scan proof changed')
                raw = reader.read(bitmap, (size + 7) // 8)
                active = tuple(
                    bit for byte_index, byte in enumerate(raw)
                    for lane in range(8)
                    for bit in (byte_index * 8 + lane,)
                    if bit < size and byte & (1 << lane))
                if not active:
                    raise ValueError('predicate directory is empty')
                layout = ('direct', pointer, count,
                          (target + 0x7e) & MASK64,
                          bitmap, size, active)
            elif (code[:0x11] != bytes.fromhex(
                    '48 63 cb 48 8d 14 8a 83 3a ff 74 78 '
                    '83 c3 01 3b 1d')
                    or code[0x15:0x17] != bytes.fromhex('0f 83')
                    or code[0x1b:0x1e] != bytes.fromhex('48 8b 15')
                    or code[0x22:0x27] != bytes.fromhex(
                        '48 85 d2 75 d9')
                    or code[0x49:0x4d] != bytes.fromhex('83 c0 01 be')
                    or code[0x51:0x54] != bytes.fromhex('48 c7 c7')
                    or code[0x58:0x5c] != bytes.fromhex('48 63 d0 e8')
                    or code[0x60] != 0x3d
                    or code[0x65:0x68] != bytes.fromhex('76 a5 be')
                    or code[0x6c:0x6f] != bytes.fromhex('48 c7 c7')
                    or code[0x73] != 0xe8
                    or code[0x78] != 0xba
                    or code[0x7d:0x88] != bytes.fromhex(
                        '39 d0 0f 47 c2 eb 88 89 02 eb c1')):
                raise ValueError('not a finite-predicate record projection')
            else:
                count_address = (target + 0x15 + _signed_integer(
                    int.from_bytes(code[0x11:0x15], 'little'), 32)) & MASK64
                exit_target = (target + 0x1b + _signed_integer(
                    int.from_bytes(code[0x17:0x1b], 'little'), 32)) & MASK64
                pointer_address = (target + 0x22 + _signed_integer(
                    int.from_bytes(code[0x1e:0x22], 'little'), 32)) & MASK64
                pointer = reader.load(pointer_address, 8)
                count = reader.load(count_address, 4)
                size = int.from_bytes(code[0x4d:0x51], 'little')
                bitmap = _signed_integer(
                    int.from_bytes(code[0x54:0x58], 'little'), 32) & MASK64
                if (not pointer or count > (1 << 24)
                        or not size or size > (1 << 20)
                        or int.from_bytes(code[0x61:0x65], 'little')
                        != size - 1
                        or int.from_bytes(code[0x68:0x6c], 'little') != size
                        or (_signed_integer(
                            int.from_bytes(code[0x6f:0x73], 'little'), 32)
                            & MASK64) != bitmap
                        or int.from_bytes(code[0x79:0x7d], 'little') != size):
                    raise ValueError(
                        'predicate directory constants disagree')
                next_scan = (target + 0x60 + _signed_integer(
                    int.from_bytes(code[0x5c:0x60], 'little'), 32)) & MASK64
                first_scan = (target + 0x78 + _signed_integer(
                    int.from_bytes(code[0x74:0x78], 'little'), 32)) & MASK64
                if (self._bit_scan_layout(state, next_scan) != 'next'
                        or self._bit_scan_layout(state, first_scan) != 'first'):
                    raise ValueError('predicate scans changed')
                for scan in (next_scan, first_scan):
                    scan_proof = self._bit_scan_functions.get(scan)
                    if scan_proof is None or not reader.absorb(
                            scan_proof[0], scan_proof[1]):
                        raise ValueError('predicate scan proof changed')
                raw = reader.read(bitmap, (size + 7) // 8)
                active = tuple(
                    bit for byte_index, byte in enumerate(raw)
                    for lane in range(8)
                    for bit in (byte_index * 8 + lane,)
                    if bit < size and byte & (1 << lane))
                if not active:
                    raise ValueError('predicate directory is empty')
                layout = ('legacy', pointer, count, exit_target,
                          bitmap, size, active)
        except (PageFault, ValueError):
            pass
        config, proof = reader.proof()
        self._predicate_record_loops[target] = config, proof, layout
        return layout

    def _collapse_predicate_record_projection(self, state, branch):
        """Materialize one sealed predicate residual as strided records."""
        _following, target, condition = branch.boundary.detail
        if (condition not in (2, 5) or state.rip != target
                or target >= branch.rip):
            return state
        layout = self._predicate_record_loop_layout(state, target)
        if layout is None:
            return state
        mode, pointer, count, exit_target, bitmap, size, active = layout
        if ((mode == 'legacy' and condition != 5)
                or (mode == 'direct' and condition != 2)):
            return state
        index = state.register('rbx' if mode == 'legacy' else 'r14') & MASK32
        current = state.register('rax') & MASK32
        if ((mode == 'legacy' and state.register('rdx') != pointer)
                or index >= count or current not in active):
            return state
        try:
            changed = find_virtual_not(
                state, pointer + index * 4, (count - index) * 4, 0xff)
        except PageFault:
            return state
        if changed is not None:
            return state
        position = active.index(current)
        cycle = active[position:] + active[:position]
        pattern = b''.join(struct.pack('<I', value) for value in cycle)
        records = count - index
        try:
            state = repeat_virtual(
                state, pointer + index * 4, records * 4, pattern)
        except PageFault:
            return state
        final = active[(position + records) % len(active)]
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], final, 32)
        registers = _write_register(
            registers, REGISTER_INDEX[
                'rbx' if mode == 'legacy' else 'r14'], count, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], count - 1, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdx'], size, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rdi'], bitmap, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rsi'], size, 32)
        flags = _result_flags(state.rflags, 'cmp', count, count, 0, 32)
        self.collapsed_predicate_record_projections += 1
        self.collapsed_predicate_projection_records += records
        return replace(state, registers=registers, rflags=flags,
                       rip=exit_target)

    @staticmethod
    def _register_root(operand):
        if isinstance(operand, HighByteRegister):
            return operand.index
        return operand if isinstance(operand, int) else None

    def _byte_dispatch_returns(self, state, start, target, load_register,
                               byte, visited, proof_reader):
        """Prove one byte reaches a loop backedge without persistent work."""
        registers = _write_register(
            state.registers, load_register, byte, 32)
        current = _X86Frame(_freeze_state(state))
        current = replace(current, registers=registers, rip=start)
        allowed = {load_register}
        for _unused in range(32):
            if current.rip == target:
                return True
            block = self.block(current)
            visited[block.rip] = block
            before = current.registers
            prior = current
            current, scratch = self._execute_plan(current, block)
            changed = {index for index, pair in enumerate(
                       zip(before, current.registers)) if pair[0] != pair[1]}
            operation = block.boundary.operation
            detail = block.boundary.detail

            if operation == 'immediate_alu':
                _following, name, operand, _bits, _immediate = detail
                root = self._register_root(operand)
                if (root is None or changed - (allowed | {root})
                        or (name != 'cmp' and root not in allowed)):
                    return False
                allowed.add(root)
            elif operation == 'register_immediate_alu':
                (_following, _name, register,
                 _bits, _immediate) = detail
                root = self._register_root(register)
                if (root not in allowed
                        or changed - (allowed | {root})):
                    return False
                allowed.add(root)
            elif operation == 'move_zero_extend':
                (_following, destination, _source_bits,
                 _target_bits, source) = detail
                if isinstance(source, MemoryOperand):
                    address_roots = tuple(
                        root for root in (source.base, source.index)
                        if root is not None)
                    if (not isinstance(destination, int)
                            or source.segment_msr is not None
                            or any(root not in allowed
                                   for root in address_roots)
                            or changed - (allowed | {destination})):
                        return False
                    try:
                        proof_reader.load(
                            source.address(prior, _following),
                            _source_bits // 8)
                    except PageFault:
                        return False
                else:
                    source_root = self._register_root(source)
                    if (not isinstance(destination, int)
                            or source_root not in allowed
                            or changed - (allowed | {destination})):
                        return False
                allowed.add(destination)
            elif operation == 'compare':
                _following, _opcode, left, right, _bits = detail
                roots = (self._register_root(left),
                         self._register_root(right))
                root_set = set(roots)
                if (None in roots or changed - (allowed | root_set)
                        or any(root not in allowed and root not in changed
                               for root in roots)):
                    return False
                allowed.update(changed & root_set)
            elif operation == 'operand_test':
                _following, operand, _bits, _immediate = detail
                root = self._register_root(operand)
                if root not in allowed or changed - allowed:
                    return False
            elif operation == 'accumulator_test':
                if (REGISTER_INDEX['rax'] not in allowed
                        or changed - allowed):
                    return False
            elif operation in ('conditional_branch', 'branch'):
                if changed - allowed:
                    return False
            else:
                return False

            current, boundary = self._control(
                current, block.boundary, prior, scratch)
            if boundary is not None:
                return False
        return False

    def _byte_dispatch_classes(self, state, start, target, load_register):
        key = start, target, load_register
        cached = self._byte_dispatch_cache.get(key)
        if cached is not None:
            classes, proof, data_config, data_proof = cached
            if all(self.blocks.get(block.rip) is block
                   and _proof_mismatch(
                       state, block.proof_config, block.proof) is None
                   for block in proof) \
                    and _proof_mismatch(
                        state, data_config, data_proof) is None:
                return classes, proof

        visited = {}
        proof_reader = _VirtualProofReader(state)
        classes = compile_byte_classes(
            lambda byte: self._byte_dispatch_returns(
                state, start, target, load_register, byte, visited,
                proof_reader))
        proof = tuple(visited[rip] for rip in sorted(visited))
        data_config, data_proof = proof_reader.proof()
        self._byte_dispatch_cache[key] = (
            classes, proof, data_config, data_proof)
        self.compiled_byte_dispatches += 1
        return classes, proof

    def _finish_byte_dispatch_residual(self, current, target, proof):
        """Join an active byte through its already-proven pure exit path."""
        proven = {block.rip: block for block in proof}
        operations = {
            'immediate_alu', 'register_immediate_alu',
            'move_zero_extend', 'compare', 'operand_test',
            'accumulator_test', 'conditional_branch', 'branch'}
        controls = 0
        for _unused in range(32):
            if current.rip == target:
                break
            block = proven.get(current.rip)
            if (block is None or self.blocks.get(block.rip) is not block
                    or block.boundary.operation not in operations):
                break
            prior = _freeze_state(current)
            try:
                current, scratch = self._execute_plan(current, block)
                current, boundary = self._control(
                    current, block.boundary, prior, scratch)
            except PageFault:
                current = _X86Frame(prior)
                break
            if boundary is not None:
                current = _X86Frame(prior)
                break
            controls += 1
        return current, controls

    def _collapse_byte_dispatch(self, state, branch):
        """Scan a proven byte-switch backedge to its next active class."""
        original = state
        base = _freeze_state(state)
        state = _X86Frame(base)
        _following, target, _condition_code = branch.boundary.detail
        if state.rip != target or target >= branch.rip:
            return original

        increment = self.block(state)
        if increment.boundary.operation != 'group_ff':
            return original
        _next, group, index, index_bits = increment.boundary.detail
        if group != 0 or not isinstance(index, int) \
                or index_bits not in (32, 64):
            return original

        prefix = [increment]
        prior = state
        after_increment, scratch = self._execute_plan(state, increment)
        after_increment, boundary = self._control(
            after_increment, increment.boundary, prior, scratch)
        if boundary is not None:
            return original
        load = self.block(after_increment)
        if load.boundary.operation == 'move_sign_extend':
            (_following, projected, projection_source_bits,
             projected_bits, source) = load.boundary.detail
            if (source != index or not isinstance(projected, int)
                    or projection_source_bits != index_bits
                    or projected_bits != 64):
                return original
            prefix.append(load)
            prior = after_increment
            after_increment, scratch = self._execute_plan(
                after_increment, load)
            after_increment, boundary = self._control(
                after_increment, load.boundary, prior, scratch)
            if boundary is not None:
                return original
            load = self.block(after_increment)
        before_load, _scratch = self._execute_plan(after_increment, load)
        if load.boundary.operation != 'move_zero_extend':
            return original
        (start, load_register, source_bits,
         target_bits, operand) = load.boundary.detail
        if (source_bits != 8 or target_bits not in (32, 64)
                or not isinstance(load_register, int)
                or not isinstance(operand, MemoryOperand)
                or operand.rip_relative or operand.segment_msr is not None):
            return original

        first_address = operand.address(before_load, start)
        mask = (1 << index_bits) - 1
        position = base.registers[index] & mask
        next_registers = _write_register(
            base.registers, index, position + 1, index_bits)
        check = _X86Frame(base)
        check = replace(check, registers=next_registers)
        for prefix_block in prefix:
            check_prior = check
            check, check_scratch = self._execute_plan(
                check, prefix_block)
            check, check_boundary = self._control(
                check, prefix_block.boundary, check_prior, check_scratch)
            if check_boundary is not None:
                return original
        check, _scratch = self._execute_plan(check, load)
        if operand.address(check, start) != (first_address + 1) & MASK64:
            return original

        classes, proof = self._byte_dispatch_classes(
            before_load, start, target, load_register)
        stop = find_virtual(
            state, first_address, 1 << 20, classes.coordinates(False))
        if stop is None or not stop:
            return original
        byte = read_virtual(state, first_address + stop, 1)[0]
        scanned = stop
        preceding = (position + scanned) & mask
        registers = _write_register(
            base.registers, index, preceding, index_bits)
        current = _X86Frame(base)
        current = replace(current, registers=registers)
        for prefix_block in prefix:
            current_prior = current
            current, current_scratch = self._execute_plan(
                current, prefix_block)
            current, current_boundary = self._control(
                current, prefix_block.boundary, current_prior,
                current_scratch)
            if current_boundary is not None:
                return original
        current, _scratch = self._execute_plan(current, load)
        registers = _write_register(
            current.registers, load_register, byte, target_bits)
        self.collapsed_dispatch_bytes += scanned
        self.collapsed_dispatch_iterations += scanned
        current = replace(current, registers=registers, rip=start)
        current, residual_controls = self._finish_byte_dispatch_residual(
            current, target, proof)
        self.collapsed_residual_controls += residual_controls
        return current

    def _collapse_byte_state_slice(self, state, branch):
        """Retain a pure byte-driven loop until its next external cut.

        Compiler-generated parsers commonly keep a small scalar state while
        advancing one byte coordinate.  Their comparison tree is pure, but a
        classifier-only reduction must re-enter it for every state-changing
        byte.  This reducer keeps that scalar state in one transient frame and
        reads the proved input span once.  Calls, returns, faults, machine
        configuration changes, and writes to the input page end the slice.
        """
        if branch.boundary.operation == 'branch':
            target = int(branch.boundary.detail) & MASK64
        else:
            _following, target, _condition = branch.boundary.detail
        if state.rip != target or target >= branch.rip:
            return state
        increment = self.blocks.get(target)
        if increment is None:
            increment = self.block(state)
        if increment.boundary.operation != 'group_ff':
            return state
        increment_following, group, index, index_bits = \
            increment.boundary.detail
        if (group != 0 or not isinstance(index, int)
                or index_bits not in (32, 64)):
            return state

        probe = _X86Frame(_freeze_state(state))
        probe.rip = increment_following
        projected = None
        projection = self.blocks.get(probe.rip)
        if projection is None:
            projection = self.block(probe)
        projection_block = None
        if projection.boundary.operation == 'move_sign_extend':
            (projection_following, projected, projection_source_bits,
             projection_bits, projection_source) = \
                projection.boundary.detail
            if (not isinstance(projected, int)
                    or projection_source != index
                    or projection_source_bits != index_bits
                    or projection_bits != 64):
                return state
            projection_block = projection
            probe.rip = projection_following

        load = self.blocks.get(probe.rip)
        if load is None:
            load = self.block(probe)
        if load.boundary.operation != 'move_zero_extend':
            return state
        (start, load_register, source_bits,
         target_bits, operand) = load.boundary.detail
        if (source_bits != 8 or target_bits not in (32, 64)
                or not isinstance(load_register, int)
                or not isinstance(operand, MemoryOperand)
                or operand.rip_relative or operand.segment_msr is not None):
            return state

        def enter(current):
            prior = current
            current, scratch = self._execute_plan(current, increment)
            current, boundary = self._control(
                current, increment.boundary, prior, scratch)
            if boundary is not None or current.rip != increment_following:
                return None, None
            if projection_block is not None:
                prior = current
                current, scratch = self._execute_plan(
                    current, projection_block)
                current, boundary = self._control(
                    current, projection_block.boundary, prior, scratch)
                if (boundary is not None
                        or current.rip != projection_following):
                    return None, None
            current, _scratch = self._execute_plan(current, load)
            address = operand.address(current, start)
            current.rip = start
            return current, address

        first = _X86Frame(_freeze_state(state))
        first, first_address = enter(first)
        if first is None:
            return state
        second = _X86Frame(_freeze_state(first))
        second.rip = target
        second, second_address = enter(second)
        if (second is None
                or second_address != (first_address + 1) & MASK64):
            return state

        page_bytes = 4096 - (first_address & 4095)
        try:
            zero = find_virtual(state, first_address, page_bytes, (0,))
            extent = page_bytes if zero is None else zero + 1
            payload = read_virtual(state, first_address, extent)
            source_page = translate(state, first_address, 'read') >> 12
        except PageFault:
            return state
        if len(payload) < 2:
            return state

        input_start = first_address
        input_end = first_address + len(payload)
        current = state if isinstance(state, _X86Frame) \
            else _X86Frame(state)
        if not isinstance(current.memory, MemoryCut):
            current.memory = MemoryCut(current.memory)
        revision = current.memory.change_revision
        prior_offset = -1
        byte_steps = 0
        controls = 0
        control_profile = self._control_profile
        self._control_profile = None
        try:
            # A bounded slice preserves scheduler preemption even for a guest
            # loop whose byte source lacks a terminator.
            while controls < (1 << 15) and byte_steps < len(payload):
                if current.rip != target:
                    break
                prior_registers = current.registers
                prior_flags = current.rflags
                current, address = enter(current)
                if current is None:
                    return state
                offset = address - input_start
                if (address < input_start or address >= input_end
                        or offset <= prior_offset):
                    current.registers = prior_registers
                    current.rflags = prior_flags
                    current.rip = target
                    break
                prior_offset = offset
                current.registers = _write_register(
                    current.registers, load_register,
                    payload[offset], target_bits)
                byte_steps += 1

                while current.rip != target and controls < (1 << 15):
                    block = self.blocks.get(current.rip)
                    if block is None:
                        block = self.block(current)
                    operation = block.boundary.operation
                    if operation in (
                            'call', 'return', 'far_return',
                            'interrupt_return', 'exception', 'halt',
                            'control_register', 'invalidate_page',
                            'load_descriptor_table',
                            'store_descriptor_table', 'segment',
                            'read_segment', 'load_system_segment',
                            'store_system_segment'):
                        break
                    if operation == 'group_ff' \
                            and block.boundary.detail[1] not in (0, 1):
                        break
                    block_rip = current.rip
                    prior = current
                    try:
                        current, scratch = self._execute_plan(current, block)
                        current, boundary = self._control(
                            current, block.boundary, prior, scratch)
                    except PageFault:
                        current.rip = block.boundary_rip
                        boundary = X86Boundary('page_fault', block_rip)
                    if boundary is not None:
                        current.rip = block.boundary_rip
                        break
                    controls += 1
                    next_revision, changed_pages = \
                        current.memory.changed_pages_since(revision)
                    changed_pages = tuple(changed_pages)
                    revision = next_revision
                    if source_page in changed_pages:
                        break
                if current.rip != target:
                    break
        finally:
            self._control_profile = control_profile

        if byte_steps:
            self.collapsed_byte_state_bytes += byte_steps
            self.collapsed_byte_state_controls += controls
            self.collapsed_byte_state_slices += 1
        return current if isinstance(state, _X86Frame) \
            else _freeze_state(current)

    def _collapse_residual_byte_run(self, state, _branch=None):
        """Skip bytes that cannot change a proven parser state.

        Some byte state machines have a residual state in which only a small
        alphabet can change control state.  Once the load and comparison
        shape is proven, direct memory coordinates can locate the next active
        byte without replaying the inactive comparison tree.  The scalar
        machine resumes at that byte, so the transition itself is unchanged.
        """
        target = int(state.rip) & MASK64
        load = self.blocks.get(target)
        if load is None:
            try:
                load = self.block(state)
            except PageFault:
                return state

        cached = self._residual_byte_recipes.get(target)
        if cached is not None and cached[0] is load:
            recipe = cached[1]
        else:
            recipe = None
            try:
                code = read_virtual(state, target, 26, 'execute')
            except PageFault:
                code = b''
            # Normalized shape:
            #   byte = *pointer
            #   if byte == '"' ...
            #   if byte == '\\' ...
            #   if byte == 0 ...
            #   if quote_state != 0: continue
            shape = (
                len(code) == 26
                and code[3:6] == bytes.fromhex('83 f8 22')
                and code[6:8] == bytes.fromhex('0f 84')
                and code[12:15] == bytes.fromhex('83 f8 5c')
                and code[15] == 0x74
                and code[17:21] == bytes.fromhex('85 c0 74 84')
                and code[21:26] == bytes.fromhex('45 85 f6 75 dd'))
            if shape and load.boundary.operation == 'move_zero_extend':
                (_following, loaded, source_bits,
                 target_bits, source) = load.boundary.detail
                if (loaded == REGISTER_INDEX['rax']
                        and source_bits == 8
                        and target_bits == 32
                        and isinstance(source, MemoryOperand)
                        and source.base is not None
                        and source.index is None
                        and source.scale == 1
                        and source.displacement == 0
                        and not source.rip_relative
                        and source.segment_msr is None):
                    recipe = source.base, REGISTER_INDEX['r14']
            self._residual_byte_recipes[target] = load, recipe

        if recipe is None:
            return state
        pointer_register, state_register = recipe
        if not state.registers[state_register] & MASK32:
            return state
        address = state.registers[pointer_register] & MASK64
        try:
            stop = find_virtual(
                state, address, 1 << 20, (0, ord('"'), ord('\\')))
        except PageFault:
            return state
        if stop is None or stop <= 0:
            return state
        registers = _write_register(
            state.registers, pointer_register, address + stop, 64)
        self.collapsed_residual_bytes += stop
        return replace(state, registers=registers)

    def _collapse_wrapped_byte_walk(self, state, _branch=None):
        """Compose a wrapped affine byte update to its final coordinates."""
        target = int(state.rip) & MASK64
        header = bytes.fromhex(
            '48 8b 45 e0 48 8b 4d f8 8b 49 3c 48 03 4d d8 '
            '48 39 c8 73 66')
        tail = bytes.fromhex(
            '48 8b 45 e0 48 83 c0 01 48 89 45 e0 eb 86')
        if (not self._code_contains_recipe(
                    state, target, header, extent=len(header))
                or not self._code_contains_recipe(
                    state, target + 0x6c, tail, extent=len(tail))):
            return state

        frame = state.register('rbp') & MASK64
        try:
            collector = load_virtual(state, frame - 8, 8)
            index = load_virtual(state, frame - 0x20, 8)
            shuffled = load_virtual(state, frame - 0x28, 8)
            memory = load_virtual(state, collector + 0x28, 8)
            location = load_virtual(state, collector + 0x30, 4)
            blocks = load_virtual(state, collector + 0x34, 4)
            block_bytes = load_virtual(state, collector + 0x38, 4)
            base_iterations = load_virtual(state, collector + 0x3c, 4)
        except PageFault:
            return state
        wrap = (blocks * block_bytes) & MASK32
        limit = (base_iterations + shuffled) & MASK64
        if (not collector or not memory or not wrap or index >= limit
                or limit - index > (1 << 20)):
            return state

        increments = {}
        last_address = memory + location
        iterations = limit - index
        step = (block_bytes - 1) & MASK32
        for _unused in range(iterations):
            coordinate = (memory + location) & MASK64
            increments[coordinate] = increments.get(coordinate, 0) + 1
            last_address = coordinate
            location = (location + step) % wrap
        try:
            state = increment_virtual_bytes(state, increments.items())
            state = write_virtual(
                state, collector + 0x30,
                struct.pack('<I', location & MASK32))
            state = write_virtual(
                state, frame - 0x20, struct.pack('<Q', limit))
            state = write_virtual(
                state, frame - 0x30,
                struct.pack('<Q', last_address & MASK64))
        except PageFault:
            return state

        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], limit, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], limit, 64)
        flags = _result_flags(state.rflags, 'cmp', limit, limit, 0, 64)
        self.collapsed_wrapped_byte_iterations += iterations
        self.collapsed_wrapped_byte_coordinates += len(increments)
        return replace(state, registers=registers, rflags=flags,
                       rip=(target + 0x7a) & MASK64)

    def _collapse_bit_partition_loop(self, state, _branch=None):
        """Fold a bounded low-bit partition loop into one SSA state cut."""
        target = int(state.rip) & MASK64
        loop = bytes.fromhex(
            '8b 45 ec 05 00 01 00 00 83 e8 01 31 d2 f7 75 ec '
            '3b 45 dc 76 2b 48 8b 45 f0 8b 4d d8 48 21 c8 '
            '48 33 45 e0 48 89 45 e0 48 8b 45 f0 8b 4d ec '
            '48 d3 e8 48 89 45 f0 8b 45 dc 83 c0 01 89 45 dc eb c0')
        if not self._code_contains_recipe(
                state, target, loop, extent=len(loop)):
            return state

        frame = state.register('rbp') & MASK64
        try:
            bits = load_virtual(state, frame - 0x14, 4)
            counter = load_virtual(state, frame - 0x24, 4)
            value = load_virtual(state, frame - 0x10, 8)
            result = load_virtual(state, frame - 0x20, 8)
            mask = load_virtual(state, frame - 0x28, 4)
        except PageFault:
            return state
        if not 0 < bits < 64:
            return state
        dividend = (bits + 0xff) & MASK32
        limit, remainder = divmod(dividend, bits)
        if counter >= limit:
            return state

        iterations = limit - counter
        for _unused in range(iterations):
            result ^= value & mask
            value >>= bits
        try:
            state = write_virtual(
                state, frame - 0x10, struct.pack('<Q', value & MASK64))
            state = write_virtual(
                state, frame - 0x20, struct.pack('<Q', result & MASK64))
            state = write_virtual(
                state, frame - 0x24, struct.pack('<I', limit & MASK32))
        except PageFault:
            return state

        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], limit, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rdx'], remainder, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], bits, 32)
        flags = _result_flags(state.rflags, 'cmp', limit, limit, 0, 32)
        self.collapsed_bit_partition_iterations += iterations
        return replace(state, registers=registers, rflags=flags,
                       rip=(target + len(loop)) & MASK64)

    @staticmethod
    def _byte_state_external_operation(block):
        """Return whether a block starts a new observable machine slice."""
        operation = block.boundary.operation
        if operation in (
                'call', 'return', 'far_return', 'interrupt_return',
                'exception', 'halt', 'control_register',
                'invalidate_page', 'load_descriptor_table',
                'store_descriptor_table', 'segment', 'read_segment',
                'load_system_segment', 'store_system_segment'):
            return True
        return (operation == 'group_ff'
                and block.boundary.detail[1] not in (0, 1))

    def _collapse_strided_invariant_byte_run(self, state, branch):
        """Reduce an equal byte lane followed by an affine loop tail.

        This is the normalized form used by interleaved records such as
        character/attribute cells.  One lane determines whether the current
        run continues; the equal path advances two scalar coordinates and is
        therefore applied in closed form.  Only the first unequal lane, or
        the final bound comparison, is joined back into scalar state.
        """
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state

        def block_at(address):
            block = self.blocks.get(address)
            if block is not None:
                return block
            probe = _X86Frame(_freeze_state(state))
            probe.rip = int(address) & MASK64
            return self.block(probe)

        load = block_at(target)
        if load.boundary.operation != 'move_zero_extend':
            return state
        (load_following, loaded, source_bits,
         loaded_bits, source) = load.boundary.detail
        if (source_bits != 8 or loaded_bits != 32
                or not isinstance(loaded, int)
                or not isinstance(source, MemoryOperand)
                or source.base is None or source.index is None
                or source.scale not in (1, 2, 4, 8)
                or source.rip_relative or source.segment_msr is not None):
            return state
        lane_index = source.index

        plan_probe = _X86Frame(_freeze_state(state))
        before_plan = plan_probe.registers
        plan_probe, _scratch = self._execute_plan(plan_probe, load)
        changed = tuple(index for index, values in enumerate(
                        zip(before_plan, plan_probe.registers))
                        if values[0] != values[1])
        if not changed:
            record_index = lane_index
        elif (len(changed) == 1
              and plan_probe.registers[changed[0]]
              == before_plan[lane_index]):
            record_index = changed[0]
        else:
            return state

        shift = block_at(load_following)
        compare = block_at(shift.boundary.detail[0]) \
            if shift.boundary.operation == 'shift_result_flags' else None
        equal_branch = block_at(compare.boundary.detail[0]) \
            if compare is not None \
            and compare.boundary.operation == 'compare' else None
        if (compare is None or equal_branch is None
                or equal_branch.boundary.operation != 'conditional_branch'):
            return state
        (shift_following, shift_group, shifted,
         shift_bits, shift_amount) = shift.boundary.detail
        (compare_following, compare_opcode, compared,
         invariant, compare_bits) = compare.boundary.detail
        (mismatch_target, equal_target,
         equal_condition) = equal_branch.boundary.detail
        if (shift_group != 4 or shifted != loaded or shift_bits != 32
                or shift_amount != 8 or shift_following != compare.rip
                or compare_opcode != 0x39 or compared != loaded
                or not isinstance(invariant, int) or compare_bits != 16
                or compare_following != equal_branch.rip
                or equal_condition != 4 or equal_target <= target):
            return state

        tail = []
        cursor = equal_target
        for _unused in range(9):
            block = block_at(cursor)
            tail.append(block)
            detail = block.boundary.detail
            if block.boundary.operation == 'conditional_branch':
                cursor = detail[0]
            elif block.boundary.operation == 'branch':
                cursor = detail
            else:
                cursor = detail[0]
        if tuple(block.boundary.operation for block in tail) != (
                'register_immediate_result_flags', 'lea', 'group_ff',
                'group_ff', 'register_immediate_result_flags', 'compare',
                'conditional_branch', 'compare', 'conditional_branch'):
            return state
        (first_update, address_update, temporary_update, index_update,
         second_update, bound_compare, bound_branch,
         index_compare, backedge) = tail
        if backedge.rip != branch.rip:
            return state

        (_next, first_name, first_pointer,
         first_bits, first_stride) = first_update.boundary.detail
        (_next, temporary, temporary_bits,
         temporary_address) = address_update.boundary.detail
        (_next, temporary_group, incremented_temporary,
         incremented_bits) = temporary_update.boundary.detail
        (_next, index_group, incremented_index,
         index_bits) = index_update.boundary.detail
        (_next, second_name, second_pointer,
         second_bits, second_stride) = second_update.boundary.detail
        (_next, bound_opcode, bound,
         compared_temporary, bound_bits) = bound_compare.boundary.detail
        (bound_following, bound_target,
         bound_condition) = bound_branch.boundary.detail
        (_next, index_opcode, compared_index,
         index_limit, limit_bits) = index_compare.boundary.detail
        (limit_following, back_target,
         back_condition) = backedge.boundary.detail
        address_roots = {temporary_address.base, temporary_address.index}
        address_roots.discard(None)
        if (first_name != 'add' or first_bits != 64
                or second_name != 'add' or second_bits != 64
                or first_stride != second_stride
                or not first_stride or abs(first_stride) > 64
                or not isinstance(first_pointer, int)
                or not isinstance(second_pointer, int)
                or not isinstance(temporary, int) or temporary_bits != 32
                or not isinstance(temporary_address, MemoryOperand)
                or temporary_address.scale != 1
                or record_index not in address_roots
                or len(address_roots) != 2
                or temporary_group != 0
                or incremented_temporary != temporary
                or incremented_bits != 32
                or index_group != 0 or incremented_index != lane_index
                or index_bits != 64
                or bound_opcode != 0x39
                or not isinstance(bound, int)
                or compared_temporary != temporary or bound_bits != 32
                or bound_condition != 3
                or index_opcode != 0x39
                or compared_index != record_index
                or not isinstance(index_limit, int) or limit_bits != 32
                or back_condition != 5 or back_target != target
                or limit_following != bound_target
                or len({loaded, invariant, lane_index, record_index,
                        first_pointer, second_pointer, temporary, bound,
                        index_limit}) != 8):
            return state

        # The index update block may contain the normalized copy from the
        # current record coordinate into the next load coordinate.
        index_probe = _X86Frame(_freeze_state(state))
        index_before = index_probe.registers
        index_probe, _scratch = self._execute_plan(
            index_probe, index_update)
        index_changed = tuple(index for index, values in enumerate(
                              zip(index_before, index_probe.registers))
                              if values[0] != values[1])
        if (index_changed != (lane_index,)
                or index_probe.registers[lane_index]
                != index_before[record_index]):
            return state

        offset_register = next(iter(address_roots - {record_index}))
        index = state.registers[lane_index] & MASK64
        invariant_value = _register_operand_value(
            state.registers, invariant, 16) & 0xffff
        bound_value = state.registers[bound] & MASK32
        index_limit_value = state.registers[index_limit] & MASK32
        offset = (state.registers[offset_register]
                  + temporary_address.displacement) & MASK64
        chunks = {}

        def byte_at(address):
            chunk_address = address & ~63
            payload = chunks.get(chunk_address)
            if payload is None:
                payload = read_virtual(
                    state, chunk_address,
                    min(64, 4096 - (chunk_address & 4095)))
                chunks[chunk_address] = payload
            return payload[address - chunk_address]

        equal = 0
        mismatch = None
        reason = 'chunk'
        temporary_value = 0
        final_record = index
        try:
            for _unused in range(1 << 14):
                current_index = (index + equal) & MASK64
                address_state = replace(
                    state, registers=_write_register(
                        state.registers, lane_index, current_index, 64))
                address = source.address(address_state, load_following)
                byte = byte_at(address)
                shifted_value = (byte << 8) & MASK32
                if (shifted_value & 0xffff) != invariant_value:
                    mismatch = shifted_value
                    final_record = current_index
                    reason = 'mismatch'
                    break
                final_record = current_index
                equal += 1
                temporary_value = (offset + final_record + 1) & MASK32
                if temporary_value >= bound_value:
                    reason = 'bound'
                    break
                if (final_record & MASK32) == index_limit_value:
                    reason = 'limit'
                    break
        except PageFault:
            return state
        if not equal and mismatch is None:
            return state

        registers = state.registers
        if equal:
            registers = _write_register(
                registers, first_pointer,
                state.registers[first_pointer] + equal * first_stride, 64)
            registers = _write_register(
                registers, second_pointer,
                state.registers[second_pointer] + equal * second_stride, 64)
        registers = _write_register(
            registers, record_index, final_record, 64)
        registers = _write_register(
            registers, lane_index,
            final_record if mismatch is not None else final_record + 1, 64)

        if mismatch is not None:
            registers = _write_register(
                registers, loaded, mismatch, loaded_bits)
            flags = _result_flags(
                state.rflags, 'cmp', invariant_value,
                mismatch & 0xffff,
                (invariant_value - mismatch) & 0xffff, 16)
            rip = mismatch_target
            observed = equal + 1
        else:
            registers = _write_register(
                registers, loaded, invariant_value, loaded_bits)
            registers = _write_register(
                registers, temporary, temporary_value, 32)
            if reason == 'bound':
                flags = _result_flags(
                    state.rflags, 'cmp', temporary_value, bound_value,
                    (temporary_value - bound_value) & MASK32, 32)
                rip = bound_target
            elif reason == 'limit':
                final32 = final_record & MASK32
                flags = _result_flags(
                    state.rflags, 'cmp', index_limit_value, final32,
                    (index_limit_value - final32) & MASK32, 32)
                rip = limit_following
            else:
                final32 = final_record & MASK32
                flags = _result_flags(
                    state.rflags, 'cmp', index_limit_value, final32,
                    (index_limit_value - final32) & MASK32, 32)
                rip = target
            observed = equal

        self.collapsed_byte_state_bytes += observed
        self.collapsed_byte_state_controls += observed * 13
        self.collapsed_byte_state_slices += 1
        self.collapsed_strided_byte_runs += 1
        return replace(state, registers=registers, rflags=flags, rip=rip)

    def _collapse_loaded_byte_state_slice(self, state, branch):
        """Retain a strided byte-load loop in one direct-coordinate slice.

        The induction expression may live in the normalized SSA plan before
        the load, so it need not be a source-level pointer increment.  Input
        bytes are fetched in small physical chunks and scalar state remains
        transient until the loop reaches a call, fault, exit, or source-page
        write.
        """
        if branch.boundary.operation == 'branch':
            target = int(branch.boundary.detail) & MASK64
        else:
            _following, target, _condition = branch.boundary.detail
        if state.rip != target or target >= branch.rip:
            return state
        load = self.blocks.get(target)
        if load is None:
            load = self.block(state)
        if load.boundary.operation != 'move_zero_extend':
            return state
        (start, load_register, source_bits,
         target_bits, operand) = load.boundary.detail
        if (source_bits != 8 or target_bits not in (32, 64)
                or not isinstance(load_register, int)
                or not isinstance(operand, MemoryOperand)
                or operand.rip_relative or operand.segment_msr is not None):
            return state

        current = state if isinstance(state, _X86Frame) \
            else _X86Frame(state)
        if not isinstance(current.memory, MemoryCut):
            current.memory = MemoryCut(current.memory)
        revision = current.memory.change_revision
        chunks = {}
        source_pages = set()
        prior_address = None
        byte_steps = 0
        controls = 0
        control_profile = self._control_profile
        self._control_profile = None
        try:
            while controls < (1 << 15) and byte_steps < (1 << 14):
                if current.rip != target:
                    break
                block_rip = current.rip
                try:
                    current, _scratch = self._execute_plan(current, load)
                    address = operand.address(current, start)
                    if prior_address is not None and address <= prior_address:
                        current.rip = block_rip
                        break
                    prior_address = address
                    chunk_address = address & ~63
                    payload = chunks.get(chunk_address)
                    if payload is None:
                        payload = read_virtual(
                            current, chunk_address,
                            min(64, 4096 - (chunk_address & 4095)))
                        chunks[chunk_address] = payload
                        source_pages.add(
                            translate(current, address, 'read') >> 12)
                    byte = payload[address - chunk_address]
                except PageFault:
                    current.rip = load.boundary_rip
                    break
                current.registers = _write_register(
                    current.registers, load_register, byte, target_bits)
                current.rip = start
                byte_steps += 1

                while current.rip != target and controls < (1 << 15):
                    block = self.blocks.get(current.rip)
                    if block is None:
                        block = self.block(current)
                    if self._byte_state_external_operation(block):
                        break
                    block_rip = current.rip
                    prior = current
                    try:
                        current, scratch = self._execute_plan(current, block)
                        current, boundary = self._control(
                            current, block.boundary, prior, scratch)
                    except PageFault:
                        current.rip = block.boundary_rip
                        boundary = X86Boundary('page_fault', block_rip)
                    if boundary is not None:
                        current.rip = block.boundary_rip
                        break
                    controls += 1
                    next_revision, changed_pages = \
                        current.memory.changed_pages_since(revision)
                    changed_pages = tuple(changed_pages)
                    revision = next_revision
                    if source_pages.intersection(changed_pages):
                        break
                if current.rip != target:
                    break
        finally:
            self._control_profile = control_profile

        if byte_steps:
            self.collapsed_byte_state_bytes += byte_steps
            self.collapsed_byte_state_controls += controls
            self.collapsed_byte_state_slices += 1
        return current if isinstance(state, _X86Frame) \
            else _freeze_state(current)

    def _state_dispatch_returns(self, state, start, target, load_register,
                                pointer, byte, visited, proof_reader,
                                dependencies):
        """Prove one byte-only SSA path returns to a one-byte backedge."""
        registers = _write_register(
            state.registers, load_register, byte, 32)
        current = _X86Frame(_freeze_state(state))
        current = replace(current, registers=registers, rip=start)
        initial_pointer = current.registers[pointer] & MASK64
        allowed = {load_register}

        def readable(root, changed):
            if root in allowed:
                return True
            if root is None or root == pointer or root in changed:
                return False
            dependencies.add(root)
            return True

        def memory_roots(operand, changed):
            roots = tuple(root for root in (operand.base, operand.index)
                          if root is not None)
            return (operand.segment_msr is None
                    and all(readable(root, changed) for root in roots))

        for _unused in range(48):
            if current.rip == target:
                return ((current.registers[pointer] & MASK64)
                        == (initial_pointer + 1) & MASK64)
            try:
                block = self.block(current)
                visited[block.rip] = block
                before = current.registers
                prior = current
                current, scratch = self._execute_plan(current, block)
            except PageFault:
                return False
            changed = {index for index, pair in enumerate(
                       zip(before, current.registers)) if pair[0] != pair[1]}
            operation = block.boundary.operation
            detail = block.boundary.detail

            if operation == 'immediate_alu':
                _following, name, operand, _bits, _immediate = detail
                root = self._register_root(operand)
                if (root is None or changed - (allowed | {root})
                        or (name != 'cmp' and not readable(root, changed))):
                    return False
                if name != 'cmp':
                    allowed.add(root)
                elif root not in allowed:
                    dependencies.add(root)
            elif operation == 'register_immediate_alu':
                (_following, _name, register,
                 _bits, _immediate) = detail
                root = self._register_root(register)
                if (not readable(root, changed)
                        or changed - (allowed | {root})):
                    return False
                allowed.add(root)
            elif operation == 'move_zero_extend':
                (following, destination, source_bits,
                 _target_bits, source) = detail
                if not isinstance(destination, int):
                    return False
                if isinstance(source, MemoryOperand):
                    if (not memory_roots(source, changed)
                            or pointer in (source.base, source.index)):
                        return False
                    try:
                        proof_reader.load(
                            source.address(prior, following),
                            source_bits // 8)
                    except PageFault:
                        return False
                else:
                    root = self._register_root(source)
                    if not readable(root, changed):
                        return False
                if changed - (allowed | {destination}):
                    return False
                allowed.add(destination)
            elif operation == 'compare':
                _following, _opcode, left, right, _bits = detail
                for operand in (left, right):
                    if isinstance(operand, MemoryOperand):
                        if (not memory_roots(operand, changed)
                                or pointer in (operand.base, operand.index)):
                            return False
                        try:
                            proof_reader.load(
                                operand.address(prior, _following),
                                max(1, _bits // 8))
                        except PageFault:
                            return False
                    elif not readable(self._register_root(operand), changed):
                        return False
                if changed - allowed:
                    return False
            elif operation == 'operand_test':
                following, operand, bits, _immediate = detail
                if isinstance(operand, MemoryOperand):
                    if (not memory_roots(operand, changed)
                            or pointer in (operand.base, operand.index)):
                        return False
                    try:
                        proof_reader.load(
                            operand.address(prior, following), bits // 8)
                    except PageFault:
                        return False
                elif not readable(self._register_root(operand), changed):
                    return False
                if changed - allowed:
                    return False
            elif operation == 'accumulator_test':
                if (not readable(REGISTER_INDEX['rax'], changed)
                        or changed - allowed):
                    return False
            elif operation == 'lea':
                _following, destination, _bits, operand = detail
                if (not isinstance(destination, int)
                        or not memory_roots(operand, changed)
                        or pointer in (operand.base, operand.index)
                        or changed - (allowed | {destination})):
                    return False
                allowed.add(destination)
            elif operation == 'register_result_flags':
                (_following, name, left, right, _bits) = detail
                left_root = self._register_root(left)
                right_root = self._register_root(right)
                if name == 'xor' and left_root == right_root:
                    if changed - (allowed | {left_root}):
                        return False
                    allowed.add(left_root)
                elif (not readable(left_root, changed)
                      or not readable(right_root, changed)
                      or changed - (allowed | {left_root})):
                    return False
                else:
                    allowed.add(left_root)
            elif operation == 'register_immediate':
                _following, register, _bits, _immediate = detail
                root = self._register_root(register)
                if changed:
                    if root not in allowed or changed - {root}:
                        return False
                else:
                    dependencies.add(root)
            elif operation == 'group_ff':
                _following, group, register, bits = detail
                if (group != 0 or register != pointer or bits != 64
                        or changed - {pointer}):
                    return False
            elif operation in ('conditional_branch', 'branch'):
                if changed - allowed:
                    return False
            else:
                return False

            current, boundary = self._control(
                current, block.boundary, prior, scratch)
            if boundary is not None:
                return False
        return False

    def _state_dispatch_classes(self, state, start, target, load_register,
                                pointer):
        """Compile a finite byte path while retaining scalar state inputs."""
        key = int(start), int(target), int(load_register), int(pointer)
        for cached in self._state_dispatch_cache.get(key, ()):
            (classes, dependencies, values, blocks,
             data_config, data_proof) = cached
            if (all(state.registers[root] == value
                    for root, value in zip(dependencies, values))
                    and all(self.blocks.get(block.rip) is block
                            and _proof_mismatch(
                                state, block.proof_config,
                                block.proof) is None
                            for block in blocks)
                    and _proof_mismatch(
                        state, data_config, data_proof) is None):
                return classes

        visited = {}
        dependencies = set()
        proof_reader = _VirtualProofReader(state)
        classes = compile_byte_classes(
            lambda byte: self._state_dispatch_returns(
                state, start, target, load_register, pointer, byte,
                visited, proof_reader, dependencies))
        dependencies = tuple(sorted(dependencies))
        values = tuple(state.registers[root] for root in dependencies)
        blocks = tuple(visited[rip] for rip in sorted(visited))
        data_config, data_proof = proof_reader.proof()
        records = self._state_dispatch_cache.setdefault(key, [])
        records.append((classes, dependencies, values, blocks,
                        data_config, data_proof))
        if len(records) > 8:
            del records[:-8]
        self.compiled_byte_dispatches += 1
        return classes

    def _collapse_header_byte_dispatch(self, state, branch):
        """Skip a pure byte-state span entered at its induction load."""
        target = int(branch.boundary.detail) & MASK64
        if state.rip != target or target >= branch.rip:
            return state
        return self._collapse_header_byte_load(state, target)

    def _collapse_header_byte_load(self, state, target):
        """Skip an inactive byte span from a proved induction load."""
        load = self.blocks.get(target)
        if load is None:
            load = self.block(state)
        if load.boundary.operation != 'move_zero_extend':
            return state
        (start, load_register, source_bits,
         target_bits, operand) = load.boundary.detail
        if (source_bits != 8 or target_bits not in (32, 64)
                or not isinstance(load_register, int)
                or not isinstance(operand, MemoryOperand)
                or operand.base is None or operand.index is not None
                or operand.rip_relative or operand.segment_msr is not None):
            return state
        pointer = operand.base
        token_state = self._collapse_token_candidate_scan(
            state, target, pointer)
        if token_state is not state:
            return token_state
        address = operand.address(state, start)
        classes = self._state_dispatch_classes(
            state, start, target, load_register, pointer)
        stop = find_virtual(
            state, address, 1 << 20, classes.coordinates(False))
        if stop is None or stop <= 1:
            return state

        registers = _write_register(
            state.registers, pointer,
            state.registers[pointer] + stop - 1, 64)
        current = _X86Frame(_freeze_state(state))
        current = replace(current, registers=registers, rip=target)
        for _unused in range(64):
            block = self.block(current)
            prior = current
            current, scratch = self._execute_plan(current, block)
            current, boundary = self._control(
                current, block.boundary, prior, scratch)
            if boundary is not None:
                return state
            if current.rip == target:
                expected = (state.registers[pointer] + stop) & MASK64
                if (current.registers[pointer] & MASK64) != expected:
                    return state
                self.collapsed_dispatch_bytes += stop - 1
                self.collapsed_dispatch_iterations += stop - 1
                return _freeze_state(current)
        return state

    def _collapse_prefixed_header_byte_dispatch(self, state, branch):
        """Normalize a scalar prefix before the byte induction load."""
        _following, target, _condition = branch.boundary.detail
        if state.rip != target or target >= branch.rip:
            return state
        current = _X86Frame(_freeze_state(state))
        prefix = self.block(current)
        if prefix.boundary.operation != 'group_ff':
            return state
        _next, group, pointer, bits = prefix.boundary.detail
        if group != 0 or not isinstance(pointer, int) or bits != 64:
            return state
        before = current.registers[pointer] & MASK64
        prior = current
        current, scratch = self._execute_plan(current, prefix)
        current, boundary = self._control(
            current, prefix.boundary, prior, scratch)
        if (boundary is not None
                or (current.registers[pointer] & MASK64)
                != (before + 1) & MASK64):
            return state
        load_state = _freeze_state(current)
        collapsed = self._collapse_header_byte_load(
            load_state, load_state.rip)
        return state if collapsed is load_state else collapsed

    def _indirect_search_index(self, state, base, count, scale,
                               array_displacement, field_displacement):
        """Index one proved pointer array by its directly addressed field."""
        key = (int(base) & MASK64, int(count), int(scale),
               int(array_displacement), int(field_displacement))
        cached = self._indirect_search_cache.get(key)
        if cached is not None:
            config, proof, positions, entries = cached
            if _proof_mismatch(state, config, proof) is None:
                self.indirect_search_cache_hits += 1
                return positions, entries
        if count < 0 or count > (1 << 16):
            return None
        reader = _VirtualProofReader(state)
        positions = {}
        entries = []
        try:
            for index in range(count):
                coordinate = (base + array_displacement
                              + index * scale) & MASK64
                entry = reader.load(coordinate, 8)
                value = reader.load(
                    (entry + field_displacement) & MASK64, 8)
                entries.append(entry)
                positions.setdefault(value, []).append(index)
        except PageFault:
            return None
        positions = {value: tuple(indexes)
                     for value, indexes in positions.items()}
        entries = tuple(entries)
        config, proof = reader.proof()
        self._indirect_search_cache[key] = (
            config, proof, positions, entries)
        self.indirect_search_cache_misses += 1
        return positions, entries

    def _normalized_field_directory(self, state, base, count,
                                    stride, field_displacement):
        """Index normalized names stored through one strided pointer field."""
        key = (int(base) & MASK64, int(count), int(stride),
               int(field_displacement))
        cached = self._normalized_field_directories.get(key)
        if cached is not None:
            config, proof, positions, entries = cached
            if _proof_mismatch(state, config, proof) is None:
                self.normalized_field_directory_hits += 1
                return positions, entries
        if count < 0 or count > (1 << 16):
            return None
        reader = _VirtualProofReader(state)
        positions = {}
        entries = []
        try:
            for index in range(count):
                record = (int(base) + index * int(stride)) & MASK64
                address = reader.load(
                    (record + int(field_displacement)) & MASK64, 8)
                name = self._proof_cstring(reader, address)
                if name is None:
                    return None
                normalized = name.replace(b'-', b'_')
                entries.append(address)
                positions.setdefault(normalized, index)
        except PageFault:
            return None
        config, proof = reader.proof()
        directory = dict(positions), tuple(entries)
        self._normalized_field_directories[key] = \
            config, proof, directory[0], directory[1]
        self.normalized_field_directory_misses += 1
        return directory

    def _collapse_normalized_field_search(self, state, branch):
        """Resolve a normalized string field in one strided directory."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        try:
            code = read_virtual(state, target, 25, 'execute')
        except PageFault:
            return state
        if (code[:8] != bytes.fromhex(
                '49 8b 34 24 48 89 df e8')
                or code[12:] != bytes.fromhex(
                '84 c0 75 46 49 83 c4 28 49 ff cf 75 e7')):
            return state

        base = state.register('r12') & MASK64
        count = state.register('r15') & MASK64
        needle_address = state.register('rbx') & MASK64
        if not count or count > (1 << 16):
            return state
        directory = self._normalized_field_directory(
            state, base, count, 0x28, 0)
        if directory is None:
            return state
        positions, entries = directory
        reader = _VirtualProofReader(state)
        try:
            needle = self._proof_cstring(reader, needle_address)
        except PageFault:
            return state
        if needle is None:
            return state
        match = positions.get(needle.replace(b'-', b'_'))
        registers = state.registers
        registers = _write_register(
            registers, REGISTER_INDEX['rdi'], needle_address, 64)
        if match is None:
            registers = _write_register(
                registers, REGISTER_INDEX['r12'], base + count * 0x28, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['r15'], 0, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rsi'], entries[-1], 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rax'], 0, 32)
            flags = _result_flags(state.rflags, 'sub', 1, 1, 0, 64)
            rip = following
            scanned = count
        else:
            record = (base + match * 0x28) & MASK64
            registers = _write_register(
                registers, REGISTER_INDEX['r12'], record, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['r15'], count - match, 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rsi'], entries[match], 64)
            registers = _write_register(
                registers, REGISTER_INDEX['rax'], 1, 32)
            flags = _result_flags(state.rflags, 'and', 1, 1, 1, 8)
            rip = (target + 0x56) & MASK64
            scanned = match + 1
        self.collapsed_normalized_field_entries += scanned
        return replace(state, registers=registers, rflags=flags, rip=rip)

    def _collapse_indirect_field_search(self, state, branch):
        """Reduce a bounded pointer-array field search to one proved index."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        loop = []
        cursor = target
        while cursor < branch.rip:
            block = self.blocks.get(cursor)
            if block is None:
                return state
            end = block.rip + len(block.source)
            if end <= cursor or end > branch.rip:
                return state
            loop.append(block)
            cursor = end
        if cursor != branch.rip or len(loop) != 7:
            return state
        (update, limit_compare, limit_branch,
         first_load, second_load, entry_load, field_compare) = loop
        if tuple(block.boundary.operation for block in loop) != (
                'group_ff', 'compare', 'conditional_branch',
                'load', 'load', 'load', 'compare'):
            return state

        (_next, group, index, index_bits) = update.boundary.detail
        (_next, limit_opcode, limit,
         compared_index, limit_bits) = limit_compare.boundary.detail
        (_next, exhausted_target,
         exhausted_condition) = limit_branch.boundary.detail
        (first_following, needle_register,
         first_bits, first_operand) = first_load.boundary.detail
        (second_following, second_register,
         second_bits, second_operand) = second_load.boundary.detail
        (_next, entry_register,
         entry_bits, array_operand) = entry_load.boundary.detail
        (_next, field_opcode, compared_needle,
         field_operand, field_bits) = field_compare.boundary.detail
        if (group != 0 or not isinstance(index, int) or index_bits != 64
                or limit_opcode != 0x39 or compared_index != index
                or not isinstance(limit, int) or limit_bits != 64
                or exhausted_condition != 13
                or first_bits != 64 or second_bits != 64
                or second_register != needle_register
                or entry_bits != 64 or field_bits != 64
                or field_opcode != 0x3b
                or compared_needle != needle_register
                or not isinstance(first_operand, MemoryOperand)
                or not isinstance(second_operand, MemoryOperand)
                or not isinstance(array_operand, MemoryOperand)
                or not isinstance(field_operand, MemoryOperand)
                or first_operand.rip_relative
                or second_operand.rip_relative
                or array_operand.rip_relative
                or field_operand.rip_relative
                or first_operand.segment_msr is not None
                or second_operand.segment_msr is not None
                or array_operand.segment_msr is not None
                or field_operand.segment_msr is not None
                or first_operand.base is None
                or first_operand.index is not None
                or second_operand.base != needle_register
                or second_operand.index is not None
                or array_operand.base is None
                or array_operand.index != index
                or array_operand.scale not in (1, 2, 4, 8)
                or field_operand.base != entry_register
                or field_operand.index is not None):
            return state

        current = state.registers[index] & MASK64
        count = state.registers[limit] & MASK64
        if current >= count or count > (1 << 16):
            return state
        try:
            first_address = first_operand.address(state, first_following)
            intermediate = load_virtual(state, first_address, 8)
            needle_state = replace(
                state, registers=_write_register(
                    state.registers, needle_register, intermediate, 64))
            needle = load_virtual(
                needle_state,
                second_operand.address(needle_state, second_following), 8)
        except PageFault:
            return state
        base = state.registers[array_operand.base] & MASK64
        indexed = self._indirect_search_index(
            state, base, count, array_operand.scale,
            array_operand.displacement, field_operand.displacement)
        if indexed is None:
            return state
        positions, entries = indexed
        start = current + 1
        candidates = positions.get(needle, ())
        low, high = 0, len(candidates)
        while low < high:
            middle = (low + high) // 2
            if candidates[middle] < start:
                low = middle + 1
            else:
                high = middle
        match = candidates[low] if low < len(candidates) else None
        registers = _write_register(
            state.registers, needle_register, needle, 64)
        if match is not None:
            registers = _write_register(registers, index, match, 64)
            registers = _write_register(
                registers, entry_register, entries[match], 64)
            flags = _result_flags(
                state.rflags, 'cmp', needle, needle, 0, 64)
            rip = following
            scanned = match - start + 1
        else:
            if start >= count:
                return state
            registers = _write_register(registers, index, count, 64)
            registers = _write_register(
                registers, entry_register, entries[count - 1], 64)
            flags = _result_flags(
                state.rflags, 'cmp', count, count, 0, 64)
            rip = exhausted_target
            scanned = count - start
        self.collapsed_indirect_search_entries += scanned
        return replace(state, registers=registers, rip=rip,
                       rflags=flags)

    def _btf_type_directory(self, state, btf):
        """Map BTF type ids to pointer and kind under one page proof."""
        btf = int(btf) & MASK64
        cached = self._btf_type_directories.get(btf)
        if cached is not None:
            config, proof, directory = cached
            if _proof_mismatch(state, config, proof) is None:
                self.btf_directory_cache_hits += 1
                return directory
        reader = _VirtualProofReader(state)
        directory = {}
        seen = set()
        current = btf
        try:
            while current:
                if current in seen or len(seen) >= 256:
                    return None
                seen.add(current)
                count = reader.load((current + 0x48) & MASK64, 4)
                start = reader.load((current + 0x98) & MASK64, 4)
                table = reader.load((current + 8) & MASK64, 8)
                if count > (1 << 20):
                    return None
                pointers = reader.read(table, count * 8)
                for offset, pointer in enumerate(
                        struct.unpack('<%dQ' % count, pointers)):
                    if not pointer:
                        directory[start + offset] = 0, None
                        continue
                    info = reader.load((pointer + 4) & MASK64, 4)
                    directory[start + offset] = pointer, (info >> 24) & 0x1f
                current = reader.load((current + 0x90) & MASK64, 8)
        except (PageFault, struct.error):
            return None
        config, proof = reader.proof()
        directory = dict(directory)
        self._btf_type_directories[btf] = config, proof, directory
        self.btf_directory_cache_misses += 1
        return directory

    def _collapse_btf_nonmodifier_span(self, state, branch):
        """Skip BTF types that cannot cross the modifier call barrier."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        signature = bytes.fromhex(
            '41 8b 87 98 00 00 00 4c 89 f9 41 39 c6 73 15')
        try:
            if read_virtual(
                    state, target, len(signature), 'execute') != signature:
                return state
        except PageFault:
            return state
        index = state.register('r14') & MASK32
        limit = state.register('r12') & MASK32
        if index >= limit:
            return state
        directory = self._btf_type_directory(state, state.register('r15'))
        if directory is None:
            return state
        modifiers = {8, 9, 10, 11, 18}
        first = directory.get(index)
        if first is None or first[1] in modifiers:
            return state
        cursor = index
        last_pointer, last_kind = first
        while cursor < limit:
            entry = directory.get(cursor)
            if entry is None or entry[1] in modifiers:
                break
            last_pointer, last_kind = entry
            cursor += 1
        if cursor == index:
            return state
        registers = _write_register(
            state.registers, REGISTER_INDEX['r14'], cursor, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rbx'], last_pointer, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rax'], last_kind or 0, 32)
        self.collapsed_btf_types += cursor - index
        if cursor < limit:
            flags = _result_flags(
                state.rflags, 'cmp', cursor, limit,
                (cursor - limit) & MASK32, 32)
            return replace(state, registers=registers, rip=target,
                           rflags=flags)
        flags = _result_flags(state.rflags, 'cmp', limit, limit, 0, 32)
        return replace(state, registers=registers, rip=following,
                       rflags=flags)

    def _btf_name_index(self, state, btf):
        """Join BTF type and string coordinates into a proved name index."""
        btf = int(btf) & MASK64
        cached = self._btf_name_indexes.get(btf)
        if cached is not None:
            config, proof, index = cached
            if _proof_mismatch(state, config, proof) is None:
                self.btf_name_index_hits += 1
                return index
        reader = _VirtualProofReader(state)
        objects = []
        seen = set()
        current = btf
        try:
            while current:
                if current in seen or len(seen) >= 256:
                    return None
                seen.add(current)
                count = reader.load((current + 0x48) & MASK64, 4)
                start = reader.load((current + 0x98) & MASK64, 4)
                table = reader.load((current + 8) & MASK64, 8)
                string_start = reader.load((current + 0x9c) & MASK64, 4)
                strings = reader.load((current + 0x20) & MASK64, 8)
                string_bytes = reader.load((current + 0x44) & MASK64, 4)
                if count > (1 << 20) or string_bytes > (1 << 30):
                    return None
                pointers = struct.unpack(
                    '<%dQ' % count, reader.read(table, count * 8))
                objects.append((current, start, pointers,
                                string_start, strings, string_bytes))
                current = reader.load((current + 0x90) & MASK64, 8)

            types = []
            for _object, start, pointers, *_strings in objects:
                for offset, pointer in enumerate(pointers):
                    if pointer:
                        types.append((start + offset, pointer))
            types.sort()
            index = {}
            for type_id, pointer in types:
                name_offset = reader.load(pointer, 4)
                info = reader.load((pointer + 4) & MASK64, 4)
                kind = (info >> 24) & 0x1f
                owner = next((item for item in objects
                              if name_offset >= item[3]), None)
                if owner is None:
                    continue
                local = name_offset - owner[3]
                if local >= owner[5]:
                    continue
                name = self._proof_cstring(
                    reader, (owner[4] + local) & MASK64,
                    owner[5] - local)
                if name is None:
                    return None
                index.setdefault((kind, name), type_id)
        except (PageFault, struct.error):
            return None
        config, proof = reader.proof()
        index = dict(index)
        self._btf_name_indexes[btf] = config, proof, index
        self.btf_name_index_misses += 1
        return index

    def _is_btf_name_function(self, state, target):
        target = int(target) & MASK64
        cached = self._btf_name_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                if self._string_compare_profile is not None and not present:
                    try:
                        cached_code = read_virtual(
                            state, target, 0x37, 'execute').hex()
                    except PageFault:
                        cached_code = None
                    key = target, cached_code
                    self._string_compare_profile[key] = (
                        self._string_compare_profile.get(key, 0) + 1)
                return present
        signature = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 50 48 89 75 d0')
        try:
            present = read_virtual(
                state, target, len(signature), 'execute') == signature
        except PageFault:
            present = False
        config, proof = _execution_proof(state, target, len(signature))
        if proof is not None:
            self._btf_name_functions[target] = config, proof, present
        return present

    def _btf_name_result(self, state, btf, name_address, kind):
        index = self._btf_name_index(state, btf)
        if index is None:
            return None
        reader = _VirtualProofReader(state)
        try:
            name = self._proof_cstring(reader, name_address)
        except PageFault:
            return None
        if name is None:
            return None
        return index.get((int(kind) & 0xff, name), -2)

    def _collapse_btf_name_call(self, state, following, target):
        """Resolve a BTF kind/name ABI call through its proved direct index."""
        if not self._is_btf_name_function(state, target):
            return None
        result = self._btf_name_result(
            state, state.register('rdi'), state.register('rsi'),
            state.register('rdx'))
        if result is None:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], result & MASK32, 32)
        self.collapsed_btf_name_searches += 1
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _collapse_btf_name_loop(self, state, branch):
        """Finish an in-flight BTF name search at its mismatch backedge."""
        _following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        signature = bytes.fromhex(
            'ff c3 44 39 e3 74 78 4c 89 f8')
        try:
            if read_virtual(
                    state, target, len(signature), 'execute') != signature:
                return state
        except PageFault:
            return state
        try:
            name_address = load_virtual(
                state, (state.register('rbp') - 0x30) & MASK64, 8)
        except PageFault:
            return state
        result = self._btf_name_result(
            state, state.register('r15'), name_address,
            state.register('r14'))
        if result is None:
            return state
        current = state.register('rbx') & MASK32
        if result >= 0 and result <= current:
            return state
        registers = _write_register(
            state.registers, REGISTER_INDEX['rbx'], result & MASK32, 32)
        self.collapsed_btf_name_searches += 1
        return replace(state, registers=registers,
                       rip=(target + 0x84) & MASK64)

    def _token_scan_layout(self, state, target, pointer):
        """Recover the operands of a compiler-shaped token candidate loop."""
        key = int(target) & MASK64, int(pointer)
        cached = self._token_scan_layouts.get(key)
        if cached is not None:
            layout, config, proof = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        if pointer != REGISTER_INDEX['rbx']:
            return None
        reader = _VirtualProofReader(state)
        try:
            code = reader.read(target, 72)
        except PageFault:
            return None
        if (code[:6] != bytes.fromhex('0f b6 03 83 f8 22')
                or code[17:20] != bytes.fromhex('85 c0 74')
                or code[43:46] != bytes.fromhex('0f b6 80')
                or code[57:60] != bytes.fromhex('48 8b 45')
                or code[61:64] != bytes.fromhex('48 8b 78')):
            return None
        exit_target = (target + 21
                       + int.from_bytes(code[20:21], 'little', signed=True)) \
            & MASK64
        ctype_base = int.from_bytes(
            code[46:50], 'little', signed=True) & MASK64
        stack_displacement = int.from_bytes(
            code[60:61], 'little', signed=True)
        eval_displacement = int.from_bytes(
            code[64:65], 'little', signed=True)
        layout = (exit_target, ctype_base, stack_displacement,
                  eval_displacement)
        config, proof = reader.proof()
        self._token_scan_layouts[key] = layout, config, proof
        return layout

    def _token_directory(self, state, address, quote, ctype_base):
        """Tokenize one proved byte string once for all later name probes."""
        key = int(address) & MASK64, int(bool(quote)), int(ctype_base) & MASK64
        cached = self._token_directory_cache.get(key)
        if cached is not None:
            config, proof, directory = cached
            if _proof_mismatch(state, config, proof) is None:
                self.token_directory_cache_hits += 1
                return directory
        reader = _VirtualProofReader(state)
        try:
            ctype = reader.read(ctype_base, 256)
            chunks = []
            for offset in range(0, 1 << 20, 256):
                chunk = reader.read(address + offset, 256)
                chunks.append(chunk)
                stop = chunk.find(b'\0')
                if stop >= 0:
                    data = b''.join(chunks)[:offset + stop + 1]
                    break
            else:
                return None
        except PageFault:
            return None

        def alpha(byte):
            return bool(ctype[byte] & 0x03)

        def alnum(byte):
            return bool(ctype[byte] & 0x07)

        tokens = set()
        position = 0
        quoted = bool(quote)
        exit_byte = 0
        while position < len(data):
            byte = data[position]
            if not byte:
                break
            if byte == 0x5c:
                if position + 1 >= len(data) or not data[position + 1]:
                    exit_byte = byte
                    break
                position += 2
                continue
            if byte == 0x22:
                quoted = not quoted
                position += 1
                continue
            if quoted:
                position += 1
                continue
            if 0x30 <= byte <= 0x39:
                position += 1
                while position < len(data) and alnum(data[position]):
                    position += 1
                if position >= len(data) or not data[position]:
                    break
                position += 1
                continue
            if alpha(byte) or byte == 0x5f:
                start = position
                position += 1
                while (position < len(data)
                       and (alnum(data[position])
                            or data[position] == 0x5f)):
                    position += 1
                tokens.add(data[start:position])
                while position < len(data) and data[position]:
                    if data[position] == 0x2e:
                        position += 1
                    elif (data[position] == 0x2d
                          and position + 1 < len(data)
                          and data[position + 1] == 0x3e):
                        position += 2
                    else:
                        position += 1
                        break
                    if position >= len(data) or not data[position]:
                        break
                    position += 1
                    while (position < len(data)
                           and (alnum(data[position])
                                or data[position] == 0x5f)):
                        position += 1
                continue
            position += 1
        directory = (frozenset(tokens),
                     (address + position) & MASK64,
                     int(quoted), exit_byte)
        config, proof = reader.proof()
        self._token_directory_cache[key] = config, proof, directory
        self.token_directory_cache_misses += 1
        return directory

    def _collapse_token_candidate_scan(self, state, target, pointer):
        """Skip a token scan when its proved directory lacks the probe."""
        layout = self._token_scan_layout(state, target, pointer)
        if layout is None:
            return state
        (exit_target, ctype_base, stack_displacement,
         eval_displacement) = layout
        frame = state.register('rbp')
        try:
            mapping = load_virtual(
                state, (frame + stack_displacement) & MASK64, 8)
            needle_address = load_virtual(
                state, (mapping + eval_displacement) & MASK64, 8)
        except PageFault:
            return state
        length = state.register('r8') & MASK64
        if not length or length > (1 << 20):
            return state
        try:
            needle = read_virtual(state, needle_address, length)
        except PageFault:
            return state
        address = state.registers[pointer] & MASK64
        directory = self._token_directory(
            state, address, state.register('r14'), ctype_base)
        if directory is None:
            return state
        tokens, end, quote, exit_byte = directory
        if needle in tokens:
            replaced = self._replace_token_candidates(
                state, address, state.register('r14'), ctype_base,
                needle, mapping)
            if replaced is None:
                return state
            state, end, quote, exit_byte, replacements = replaced
            if not replacements:
                return state
            self.collapsed_token_replacements += replacements
        registers = _write_register(
            state.registers, pointer, end, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['r14'], quote, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rax'], exit_byte, 32)
        flags = _result_flags(
            state.rflags, 'and', exit_byte, exit_byte, exit_byte, 8)
        self.collapsed_token_candidate_bytes += (end - address) & MASK64
        return replace(state, registers=registers, rflags=flags,
                       rip=exit_target)

    def _replace_token_candidates(self, state, address, quote, ctype_base,
                                  needle, mapping):
        """Apply one proved identifier replacement over a format suffix."""
        reader = _VirtualProofReader(state)
        try:
            ctype = reader.read(ctype_base, 256)
            chunks = []
            for offset in range(0, 1 << 20, 256):
                chunk = reader.read(address + offset, 256)
                chunks.append(chunk)
                stop = chunk.find(b'\0')
                if stop >= 0:
                    payload = bytearray(
                        b''.join(chunks)[:offset + stop])
                    break
            else:
                return None
            raw_value = reader.load((mapping + 16) & MASK64, 8)
        except PageFault:
            return None

        signed_value = (raw_value - (1 << 64)
                        if raw_value & (1 << 63) else raw_value)
        value = str(signed_value).encode('ascii')
        if len(value) > len(needle):
            return None

        def alpha(byte):
            return bool(ctype[byte] & 0x03)

        def alnum(byte):
            return bool(ctype[byte] & 0x07)

        position = 0
        quoted = bool(quote)
        replacements = 0
        while position < len(payload):
            byte = payload[position]
            if byte == 0x5c:
                position += 1
                if position >= len(payload):
                    break
                position += 1
                continue
            if byte == 0x22:
                quoted = not quoted
                position += 1
                continue
            if quoted:
                position += 1
                continue
            if 0x30 <= byte <= 0x39:
                position += 1
                while (position < len(payload)
                       and alnum(payload[position])):
                    position += 1
                if position >= len(payload):
                    break
                position += 1
                continue
            if alpha(byte) or byte == 0x5f:
                following = position + len(needle)
                next_byte = (payload[following]
                             if following < len(payload) else 0)
                if (payload[position:following] == needle
                        and not alnum(next_byte) and next_byte != 0x5f):
                    payload[position:following] = value
                    replacements += 1
                    position += len(value)
                    if position < len(payload):
                        position += 1
                    continue

                while (position < len(payload)
                       and (alnum(payload[position])
                            or payload[position] == 0x5f)):
                    position += 1
                exhausted = position >= len(payload)
                while not exhausted:
                    if payload[position] == 0x2e:
                        position += 1
                    elif (payload[position] == 0x2d
                          and position + 1 < len(payload)
                          and payload[position + 1] == 0x3e):
                        position += 2
                    else:
                        position += 1
                        break
                    if position >= len(payload):
                        exhausted = True
                        break
                    while (position < len(payload)
                           and (alnum(payload[position])
                                or payload[position] == 0x5f)):
                        position += 1
                    exhausted = position >= len(payload)
                if exhausted:
                    break
                continue
            position += 1

        if replacements:
            state = write_virtual(state, address, bytes(payload) + b'\0')
        return (state, (address + len(payload)) & MASK64,
                int(quoted), 0, replacements)

    def _classified_scan_classes(self, state, start, stop, register):
        """Compile a pure byte predicate prefix to its finite class row."""
        key = int(start), int(stop), int(register)
        cached = self._classified_scan_cache.get(key)
        if cached is not None:
            config, proof, classes = cached
            if _proof_mismatch(state, config, proof) is None:
                return classes
        proof_reader = _VirtualProofReader(state)
        visited = set()

        def accepted(byte):
            current = _X86Frame(_freeze_state(state))
            current.registers = _write_register(
                current.registers, register, byte, 8)
            current.rip = int(start) & MASK64
            for _unused in range(24):
                if current.rip == stop:
                    return True
                if not start <= current.rip < stop:
                    return False
                before_memory = current.memory
                before_revision = (before_memory.change_revision
                                   if isinstance(before_memory, MemoryCut)
                                   else None)
                try:
                    block = self.block(current)
                    if block.rip not in visited:
                        proof_reader.read(block.rip, len(block.source))
                        visited.add(block.rip)
                    if block.boundary.operation == 'operand_test':
                        following, operand, bits, _immediate = \
                            block.boundary.detail
                        if isinstance(operand, MemoryOperand):
                            proof_reader.load(
                                operand.address(current, following),
                                bits // 8)
                    prior = current
                    current, scratch = self._execute_plan(current, block)
                    current, boundary = self._control(
                        current, block.boundary, prior, scratch)
                except PageFault:
                    return False
                after_revision = (current.memory.change_revision
                                  if isinstance(current.memory, MemoryCut)
                                  else None)
                if (boundary is not None or current.memory is not before_memory
                        or after_revision != before_revision):
                    return False
            return False

        classes = compile_byte_classes(
            lambda byte: bool(byte) and accepted(byte))
        config, proof = proof_reader.proof()
        self._classified_scan_cache[key] = config, proof, classes
        self.compiled_classified_scans += 1
        return classes

    def _collapse_classified_byte_scan(self, state, branch):
        """Skip a bounded identifier scan using its compiled byte classes."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state

        def predecessor(end, operation):
            found = [block for width in range(1, 16)
                     for block in (self.blocks.get(end - width),)
                     if block is not None
                     and block.rip + len(block.source) == end
                     and block.boundary.operation == operation]
            return found[0] if len(found) == 1 else None

        zero_test = predecessor(branch.rip, 'compare')
        update = None if zero_test is None else predecessor(
            zero_test.rip, 'group_ff')
        limit_branch = None if update is None else predecessor(
            update.rip, 'conditional_branch')
        pointer_compare = None if limit_branch is None else predecessor(
            limit_branch.rip, 'compare')
        load = None if pointer_compare is None else predecessor(
            pointer_compare.rip, 'move_zero_extend')
        if load is None:
            return state
        (_load_next, temporary, source_bits,
         target_bits, operand) = load.boundary.detail
        (_compare_next, compare_opcode, limit,
         compared_pointer, compare_bits) = pointer_compare.boundary.detail
        (_limit_following, limit_target,
         limit_condition) = limit_branch.boundary.detail
        (_update_next, group, pointer, pointer_bits) = update.boundary.detail
        (_test_next, test_opcode, tested,
         test_operand, test_bits) = zero_test.boundary.detail
        if (source_bits != 8 or target_bits not in (32, 64)
                or not isinstance(temporary, int)
                or not isinstance(operand, MemoryOperand)
                or operand.base != pointer or operand.index is not None
                or operand.displacement != 0 or operand.rip_relative
                or operand.segment_msr is not None
                or compare_opcode != 0x39 or compared_pointer != pointer
                or not isinstance(limit, int) or compare_bits != 64
                or limit_condition != 3
                or group != 0 or pointer_bits != 64
                or test_opcode != 0x84 or tested != temporary
                or test_operand != temporary or test_bits != 8):
            return state

        classes = self._classified_scan_classes(
            state, target, load.rip, temporary)
        previous = _register_operand_value(
            state.registers, temporary, 8)
        if not classes.classify(previous):
            return state
        address = state.registers[pointer] & MASK64
        end = state.registers[limit] & MASK64
        if end <= address or end - address > (1 << 20):
            return state
        stop = find_virtual(
            state, address, end - address,
            classes.coordinates(False))
        if stop is None:
            scanned = end - address
            if not scanned:
                return state
            byte = load_virtual(state, end - 1, 1)
            registers = _write_register(
                state.registers, temporary, byte, target_bits)
            registers = _write_register(
                registers, pointer, end, 64)
            self.collapsed_classified_bytes += scanned
            return replace(state, registers=registers, rip=target)

        byte = load_virtual(state, address + stop, 1)
        scanned = stop + 1
        registers = _write_register(
            state.registers, temporary, byte, target_bits)
        registers = _write_register(
            registers, pointer, address + scanned, 64)
        self.collapsed_classified_bytes += scanned
        if byte:
            return replace(state, registers=registers, rip=target)
        flags = _result_flags(state.rflags, 'and', 0, 0, 0, 8)
        return replace(state, registers=registers, rflags=flags,
                       rip=following)

    def _length_prefix_cut(self, state, branch):
        """Lower a proved variable-length directory recurrence to state SSA."""
        following, target, condition = branch.boundary.detail
        if condition != 9 or state.rip != target:
            return None
        target_block = self.blocks.get(target)
        if (target_block is None
                or target_block.boundary.operation
                != 'register_result_flags'):
            return None

        cached = self._prefix_cuts.get(branch.rip)
        if cached is not None and cached[0] is branch:
            _branch, config, proof, cut = cached
            if _proof_mismatch(state, config, proof) is None:
                self.prefix_cut_cache_hits += 1
                return cut

        try:
            source = read_virtual(
                state, target, len(_LENGTH_PREFIX_SKIP_LOOP), 'execute')
        except PageFault:
            return None
        config, proof = _execution_proof(
            state, target, len(_LENGTH_PREFIX_SKIP_LOOP))
        if source != _LENGTH_PREFIX_SKIP_LOOP or proof is None:
            return None

        locals_ = [Operand('local', index)
                   for index in range(len(REGISTER_NAMES) + 1)]
        nodes = []

        def emit(operation, arguments):
            arguments = tuple(arguments)
            if operation.startswith(('i32.', 'i64.')):
                operation, arguments = select_lane(operation, arguments)
            value = len(nodes) + 1
            nodes.append(WaveNode(value, operation, arguments))
            return Operand('node', value)

        pointer = emit('memory.i64.prefix_end', (
            locals_[REGISTER_INDEX['rcx']],
            locals_[REGISTER_INDEX['rdx']],
            locals_[REGISTER_INDEX['rsi']],
            locals_[REGISTER_INDEX['rax']],
            Operand('const', memory_shape(1, virtual64=True))))
        count = emit('i32.add', (
            locals_[REGISTER_INDEX['rax']], Operand('const', 1)))
        flags = emit('lane64.X86_COMPARE', (
            locals_[len(REGISTER_NAMES)],
            locals_[REGISTER_INDEX['rax']],
            locals_[REGISTER_INDEX['rax']],
            Operand('const', 64 | (3 << 8))))
        locals_[REGISTER_INDEX['rcx']] = pointer
        locals_[REGISTER_INDEX['rdx']] = count
        locals_[REGISTER_INDEX['rsi']] = \
            locals_[REGISTER_INDEX['rax']]
        plan = normalize_plan(PureSlice(
            0, 0, 1, 1, 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (),
            tuple(locals_[:len(REGISTER_NAMES)]) + (flags,)))
        packed = pack_step(plan)
        mapped = unpack_step(packed)
        execute = self._bind_state_page(mapped, packed)
        cut = DecodedBlock(
            target,
            (target + len(_LENGTH_PREFIX_SKIP_LOOP)) & MASK64,
            source, 1, plan, mapped, execute, 0,
            X86Boundary(
                'branch',
                (target + len(_LENGTH_PREFIX_SKIP_LOOP)) & MASK64),
            config, proof, state_flags=True, virtual_memory=True)
        self._prefix_cuts[branch.rip] = branch, config, proof, cut
        self.prefix_cuts += 1
        self.prefix_cut_cache_misses += 1
        self.prefix_cut_work += physical_work(plan)
        self.prefix_cut_span += plan.waves.span
        return cut

    @staticmethod
    def _length_prefix_source_instructions(state, pointer, count,
                                           first_length, limit):
        """Count the exact x86 retirement represented by prefix_end.

        The cut is admitted only after proving ``_LENGTH_PREFIX_SKIP_LOOP``.
        Its outer path retires seven instructions per directory entry.  Each
        following one-byte length adds three instructions; the two-byte form
        adds six more.  Sampling performs the extra reads only when physical
        profiling is enabled.
        """
        pointer, count, limit = map(int, (pointer, count, limit))
        length = int(first_length) & MASK32
        retired = 0
        remaining = limit - count + 1
        for entry in range(remaining):
            retired += 7
            pointer = (pointer + length + 1) & MASK64
            if entry + 1 == remaining:
                break
            leading = load_virtual(state, pointer, 1)
            retired += 3
            if leading & 0x80:
                high = load_virtual(state, (pointer + 1) & MASK64, 1)
                length = (leading & 0x7f) + (high << 7) + 1
                retired += 6
            else:
                length = leading
        return retired

    def _token_stream_layout(self, state, core_start):
        """Prove one compressed-token body and recover its direct arrays."""
        core_start = int(core_start) & MASK64
        cached = self._token_stream_layouts.get(core_start)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        layout = None
        try:
            core = read_virtual(
                state, core_start, len(_TOKEN_EXPANSION_CORE), 'execute')
            shape = bytearray(core)
            expected = bytearray(_TOKEN_EXPANSION_CORE)
            shape[16:20] = expected[16:20] = b'\0' * 4
            shape[24:28] = expected[24:28] = b'\0' * 4
            if shape == expected:
                layout = (
                    _signed_integer(
                        int.from_bytes(core[16:20], 'little'), 32) & MASK64,
                    _signed_integer(
                        int.from_bytes(core[24:28], 'little'), 32) & MASK64)
        except PageFault:
            pass
        config, proof = _execution_proof(
            state, core_start, len(_TOKEN_EXPANSION_CORE))
        if proof is not None:
            self._token_stream_layouts[core_start] = config, proof, layout
        else:
            self._token_stream_layouts.pop(core_start, None)
        return layout

    def _collapse_token_expansion(self, state, branch):
        """Expand a bounded token stream directly into its output cut."""
        following, target, condition = branch.boundary.detail
        core_start = (target - 0x50) & MASK64
        if (condition != 5 or state.rip != target
                or (following + 2) & MASK64
                != (core_start + len(_TOKEN_EXPANSION_CORE)) & MASK64):
            return state
        layout = self._token_stream_layout(state, core_start)
        if layout is None:
            return state
        token_index, token_table = layout
        try:
            compressed = state.register('rcx')
            token_pointer = (state.register('r8') - 1) & MASK64
            if (not state.register('rax')
                    or load_virtual(state, token_pointer, 1)
                    != (state.register('r9') & 0xff)
                    or not state.register('r9') & 0xff):
                return state

            remaining = state.register('r10')
            output_pointer = state.register('rdx')
            tokens = state.register('rax') & MASK32
            output = bytearray()
            expanded_tokens = 0

            def expand(pointer):
                zero = find_virtual(state, pointer, 512, (0,))
                if zero is None:
                    return False, False
                count = min(zero, max(0, remaining - 1))
                output.extend(read_virtual(state, pointer, count))
                return True, count < zero

            ok, truncated = expand(token_pointer)
            if not ok:
                return state
            copied = len(output)
            remaining -= copied
            expanded_tokens += 1
            tokens -= 1
            compressed = (compressed + 1) & MASK64

            while tokens and not truncated:
                token = load_virtual(state, compressed, 1)
                token_offset = load_virtual(
                    state, (token_index + token * 2) & MASK64, 2)
                before = len(output)
                ok, truncated = expand(
                    (token_table + token_offset) & MASK64)
                if not ok:
                    return state
                remaining -= len(output) - before
                expanded_tokens += 1
                tokens -= 1
                compressed = (compressed + 1) & MASK64
        except PageFault:
            return state

        if output:
            state = write_virtual(state, output_pointer, output)
            output_pointer = (output_pointer + len(output)) & MASK64
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], 0, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], compressed, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdx'], output_pointer, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rsi'], remaining, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['r10'], remaining, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['r9'], 0, 32)
        self.collapsed_token_entries += expanded_tokens
        self.collapsed_token_bytes += len(output)
        return replace(state, registers=registers,
                       rip=(following + 2) & MASK64)

    def _collapse_token_stream_entry(self, state, branch):
        """Normalize a complete compressed symbol before its scalar loops."""
        target = int(branch.boundary.detail) & MASK64
        core_start = (target - 7) & MASK64
        if state.rip != target:
            return state
        layout = self._token_stream_layout(state, core_start)
        if layout is None:
            return state
        token_index, token_table = layout
        compressed = state.register('rcx')
        output_pointer = state.register('rdx')
        remaining = state.register('rsi')
        tokens = state.register('rax') & MASK32
        skipped_first = bool(state.register('rdi'))
        if not tokens or remaining > (1 << 20):
            return state
        output = bytearray()
        expanded_tokens = 0
        truncated = False
        try:
            while tokens and not truncated:
                token = load_virtual(state, compressed, 1)
                token_offset = load_virtual(
                    state, (token_index + token * 2) & MASK64, 2)
                token_pointer = (token_table + token_offset) & MASK64
                zero = find_virtual(state, token_pointer, 512, (0,))
                if zero is None:
                    return state
                payload = read_virtual(state, token_pointer, zero)
                for byte in payload:
                    if not skipped_first:
                        skipped_first = True
                    elif remaining <= 1:
                        truncated = True
                        break
                    else:
                        output.append(byte)
                        remaining -= 1
                expanded_tokens += 1
                tokens -= 1
                compressed = (compressed + 1) & MASK64
        except PageFault:
            return state

        if output:
            state = write_virtual(state, output_pointer, output)
            output_pointer = (output_pointer + len(output)) & MASK64
        if remaining:
            state = write_virtual(state, output_pointer, b'\0')
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], tokens, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], compressed, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdx'], output_pointer, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rsi'], remaining, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdi'], int(skipped_first), 32)
        self.collapsed_token_entries += expanded_tokens
        self.collapsed_token_bytes += len(output)
        return replace(state, registers=registers,
                       rip=(core_start + 0x75) & MASK64)

    def _collapse_return_branch(self, state, branch):
        """Compose a direct jump to a one-instruction return thunk."""
        target = int(branch.boundary.detail) & MASK64
        if (state.rip != target
                or not self._code_contains_recipe(
                    state, target, b'\xc3', extent=1)):
            return state
        pointer = state.register('rsp')
        try:
            following = load_virtual(state, pointer, 8)
        except PageFault:
            return state
        registers = _write_register(
            state.registers, REGISTER_INDEX['rsp'], pointer + 8, 64)
        self.collapsed_return_branches += 1
        self.direct_return_branches += 1
        self.direct_return_source_instructions += 1
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _byte_find_cut(self, state, branch):
        """Compile a two-sentinel byte-search loop to one persistent node."""
        target = int(branch.boundary.detail) & MASK64
        if state.rip != target or target >= branch.rip:
            return None
        cached = self._find_cuts.get(branch.rip)
        if cached is not None and cached[0] is branch:
            proof_blocks, cut = cached[1]
            if all(self.blocks.get(block.rip) is block
                   for block in proof_blocks):
                self.find_cut_cache_hits += 1
                return cut

        def block_at(rip):
            present = self.blocks.get(int(rip) & MASK64)
            if present is not None:
                return present
            return self.block(replace(
                _freeze_state(state), rip=int(rip) & MASK64))

        load = block_at(target)
        if load.boundary.operation != 'move_zero_extend':
            return None
        (after_load, destination, source_bits,
         target_bits, operand) = load.boundary.detail
        if (source_bits != 8 or target_bits not in (32, 64)
                or not isinstance(destination, int)
                or not isinstance(operand, MemoryOperand)
                or operand.base is None or operand.index is None
                or operand.scale != 1 or operand.rip_relative
                or operand.segment_msr is not None):
            return None

        test = block_at(after_load)
        if test.boundary.operation != 'compare':
            return None
        after_test, opcode, left, right, compare_bits = test.boundary.detail
        if (opcode not in (0x84, 0x85) or left != destination
                or right != destination or compare_bits != target_bits):
            return None
        zero_branch = block_at(after_test)
        if zero_branch.boundary.operation != 'conditional_branch':
            return None
        after_zero, exit_target, zero_condition = zero_branch.boundary.detail
        if zero_condition != 4:
            return None

        compare = block_at(after_zero)
        if compare.boundary.operation != 'immediate_alu':
            return None
        (after_compare, name, compared,
         second_bits, second_value) = compare.boundary.detail
        if (name != 'cmp' or compared != destination
                or second_bits != target_bits):
            return None
        second_branch = block_at(after_compare)
        if second_branch.boundary.operation != 'conditional_branch':
            return None
        after_second, second_exit, second_condition = \
            second_branch.boundary.detail
        if second_condition != 4 or second_exit != exit_target:
            return None

        increment = block_at(after_second)
        if increment.boundary.operation != 'group_ff':
            return None
        after_increment, group, counter, counter_bits = \
            increment.boundary.detail
        if (group != 0 or counter != operand.index
                or counter_bits not in (32, 64)
                or int(after_increment) & MASK64 != branch.rip):
            return None

        proof_blocks = (load, test, zero_branch, compare,
                        second_branch, increment, branch)
        if any(block.rip + len(block.source) != next_block.rip
               for block, next_block in zip(
                   proof_blocks, proof_blocks[1:])):
            return None

        locals_ = [Operand('local', index)
                   for index in range(len(REGISTER_NAMES) + 1)]
        nodes = []
        common = {}

        def emit(operation, arguments):
            arguments = tuple(arguments)
            if operation.startswith(('i32.', 'i64.')):
                operation, arguments = select_lane(operation, arguments)
            key = operation, arguments
            present = None if operation.startswith('memory.') \
                else common.get(key)
            if present is not None:
                return present
            value = len(nodes) + 1
            result = Operand('node', value)
            nodes.append(WaveNode(value, operation, arguments))
            if not operation.startswith('memory.'):
                common[key] = result
            return result

        address = emit('i64.add', (
            locals_[operand.base], locals_[operand.index]))
        if operand.displacement:
            address = emit('i64.add', (
                address, Operand('const', operand.displacement & MASK64)))
        found = emit('memory.i64.find2', (
            address, Operand('const', 0),
            Operand('const', int(second_value) & 0xff),
            Operand('const', memory_shape(1, virtual64=True))))
        distance = emit('i64.shr_u', (
            found, Operand('const', 8)))
        next_counter = emit('i64.add', (
            locals_[counter], distance))
        if counter_bits == 32:
            next_counter = emit('i64.and', (
                next_counter, Operand('const', MASK32)))
        locals_[counter] = next_counter
        byte = emit('i64.and', (found, Operand('const', 0xff)))
        locals_[destination] = (byte if target_bits == 64 else
                                emit('i64.and', (
                                    byte, Operand('const', MASK32))))
        descriptor = target_bits
        flags = emit('lane64.X86_FLAGS', (
            locals_[len(REGISTER_NAMES)], Operand('const', 0),
            Operand('const', 0), Operand('const', 0),
            Operand('const', descriptor)))
        plan = normalize_plan(PureSlice(
            0, 0, len(proof_blocks), len(proof_blocks), 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (),
            tuple(locals_[:len(REGISTER_NAMES)]) + (flags,)))
        packed = pack_step(plan)
        mapped = unpack_step(packed)
        execute = self._bind_state_page(mapped, packed)
        source = b''.join(block.source for block in proof_blocks)
        proof_config, proof = _execution_proof(
            state, target, len(source))
        cut = DecodedBlock(
            target, branch.rip, source, len(proof_blocks),
            plan, mapped, execute, 0,
            X86Boundary('branch', int(exit_target) & MASK64),
            proof_config, proof, state_flags=True, virtual_memory=True)
        self._find_cuts[branch.rip] = branch, (proof_blocks, cut)
        self.find_cuts += 1
        self.find_cut_cache_misses += 1
        self.find_cut_work += physical_work(plan)
        self.find_cut_span += plan.waves.span
        return cut

    def _collapse_byte_find(self, state, branch):
        cut = self._byte_find_cut(state, branch)
        if cut is None:
            return state
        proof_blocks = self._find_cuts[branch.rip][1][0]
        (_next, destination, _source_bits,
         _target_bits, _operand) = proof_blocks[0].boundary.detail
        (_next, _group, counter,
         counter_bits) = proof_blocks[5].boundary.detail
        before = state.registers[counter] & ((1 << counter_bits) - 1)
        prior = state
        state, scratch = self._execute_plan(state, cut)
        state, boundary = self._control(
            state, cut.boundary, prior, scratch)
        if boundary is not None:
            raise X86Error('a pure byte find published a barrier')
        after = state.registers[counter] & ((1 << counter_bits) - 1)
        distance = (after - before) & ((1 << counter_bits) - 1)
        found = _register_operand_value(
            state.registers, destination, 8)
        full_turn = sum(block.instructions + 1 for block in proof_blocks)
        final_blocks = proof_blocks[:3 if found == 0 else 5]
        self.find_cut_executions += 1
        self.find_cut_executed_work += physical_work(cut.plan)
        self.find_cut_executed_span += cut.plan.waves.span
        self.find_source_instructions += (
            distance * full_turn
            + sum(block.instructions + 1 for block in final_blocks))
        return state

    @staticmethod
    def _copy_until_state_valid(state, registers):
        source, target, index, limit, target_end = registers
        start = state.registers[index] & MASK32
        stop = state.registers[limit] & MASK32
        return (state.registers[index] == start
                and state.registers[limit] == stop
                and start < stop)

    def _copy_until_cut(self, state, branch):
        """Compile a bounded NUL-copy loop to one persistent state node."""
        if (branch.boundary.operation != 'branch'
                or not isinstance(branch.boundary.detail, int)):
            return None
        target = int(branch.boundary.detail) & MASK64
        if state.rip != target or target <= branch.rip:
            return None
        cached = self._copy_cuts.get(branch.rip)
        if cached is not None and cached[0] is branch:
            proof_blocks, cut, registers = cached[1]
            if (all(self.blocks.get(block.rip) is block
                    for block in proof_blocks)
                    and self._copy_until_state_valid(state, registers)):
                self.copy_cut_cache_hits += 1
                return cut

        def block_at(rip):
            present = self.blocks.get(int(rip) & MASK64)
            if present is not None:
                return present
            return self.block(replace(
                _freeze_state(state), rip=int(rip) & MASK64))

        address = block_at(target)
        if address.boundary.operation != 'lea':
            return None
        after_address, target_register, address_bits, target_operand = \
            address.boundary.detail
        if (address_bits != 64 or not isinstance(target_register, int)
                or not isinstance(target_operand, MemoryOperand)
                or target_operand.base is None
                or target_operand.index is None
                or target_operand.scale != 1
                or target_operand.displacement
                or target_operand.rip_relative
                or target_operand.segment_msr is not None):
            return None
        target_base, index = target_operand.base, target_operand.index

        load = block_at(after_address)
        if load.boundary.operation != 'move_zero_extend':
            return None
        (after_load, byte_register, source_bits,
         target_bits, source_operand) = load.boundary.detail
        if (source_bits != 8 or target_bits not in (32, 64)
                or not isinstance(byte_register, int)
                or not isinstance(source_operand, MemoryOperand)
                or source_operand.base is None
                or source_operand.index != index
                or source_operand.scale != 1
                or source_operand.displacement
                or source_operand.rip_relative
                or source_operand.segment_msr is not None):
            return None
        source_base = source_operand.base

        test = block_at(after_load)
        if test.boundary.operation != 'compare':
            return None
        after_test, opcode, left, right, compare_bits = test.boundary.detail
        if (opcode not in (0x84, 0x85) or left != byte_register
                or right != byte_register or compare_bits != 8):
            return None
        sentinel_branch = block_at(after_test)
        if sentinel_branch.boundary.operation != 'conditional_branch':
            return None
        after_sentinel, sentinel_exit, sentinel_condition = \
            sentinel_branch.boundary.detail
        if sentinel_condition != 4:
            return None

        capacity = block_at(after_sentinel)
        if capacity.boundary.operation != 'compare':
            return None
        after_capacity, opcode, target_end, compared_address, bits = \
            capacity.boundary.detail
        if (opcode != 0x39 or compared_address != target_register
                or not isinstance(target_end, int) or bits != 64):
            return None
        capacity_branch = block_at(after_capacity)
        if capacity_branch.boundary.operation != 'conditional_branch':
            return None
        store_rip, update_rip, capacity_condition = \
            capacity_branch.boundary.detail
        if capacity_condition != 3:
            return None

        store = block_at(store_rip)
        if store.boundary.operation != 'store':
            return None
        after_store, stored, stored_bits, store_operand = \
            store.boundary.detail
        if (stored != byte_register or stored_bits != 8
                or not isinstance(store_operand, MemoryOperand)
                or store_operand.base != target_register
                or store_operand.index is not None
                or store_operand.displacement
                or store_operand.rip_relative
                or store_operand.segment_msr is not None):
            return None
        backedge = block_at(after_store)
        if (backedge.boundary.operation != 'branch'
                or int(backedge.boundary.detail) & MASK64 != update_rip):
            return None

        update = block_at(update_rip)
        if update.boundary.operation != 'group_ff':
            return None
        after_update, group, updated, index_bits = update.boundary.detail
        if group != 0 or updated != index or index_bits != 64:
            return None
        count_compare = block_at(after_update)
        if count_compare.boundary.operation != 'compare':
            return None
        after_count, opcode, counted, limit, count_bits = \
            count_compare.boundary.detail
        if (opcode != 0x39 or counted != index
                or not isinstance(limit, int) or count_bits != 32):
            return None
        limit_branch = block_at(after_count)
        if limit_branch.boundary.operation != 'conditional_branch':
            return None
        loop_entry, limit_exit, limit_condition = \
            limit_branch.boundary.detail
        if loop_entry != target or limit_condition != 4:
            return None
        if (int(capacity_branch.boundary.detail[1]) & MASK64 != update.rip
                or int(backedge.boundary.detail) & MASK64 != update.rip
                or branch.rip + len(branch.source) != update.rip):
            return None

        sentinel_path = block_at(sentinel_exit)
        if (sentinel_path.boundary.operation != 'branch'
                or len(sentinel_path.plan.nodes) != 1):
            return None
        sentinel_value = sentinel_path.plan.locals[REGISTER_INDEX['rsi']]
        sentinel_node = sentinel_path.plan.nodes[0]
        if (sentinel_value != Operand('node', sentinel_node.value)
                or sentinel_node.op != 'lane64.AND'
                or sentinel_node.arguments != (
                    Operand('local', index), Operand('const', MASK32))):
            return None
        common_rip = int(sentinel_path.boundary.detail) & MASK64
        common = block_at(common_rip)
        if (common.boundary.operation != 'call'
                or common.plan.locals[target_base]
                != Operand('local', target_register)):
            return None

        limit_add = block_at(limit_exit)
        if limit_add.boundary.operation != 'register_result_flags':
            return None
        after_limit_add, name, destination, added, add_bits = \
            limit_add.boundary.detail
        if (name != 'add' or destination != target_base
                or added != index or add_bits != 64):
            return None
        limit_tail = block_at(after_limit_add)
        if (limit_tail.boundary.operation != 'call'
                or limit_tail.boundary.detail != common.boundary.detail
                or limit_tail.boundary_rip != common.boundary_rip
                or limit_tail.plan.locals[target_register]
                != Operand('local', target_base)):
            return None

        proof_blocks = (
            branch, update, count_compare, limit_branch, address, load,
            test, sentinel_branch, capacity, capacity_branch, store,
            backedge, sentinel_path, common, limit_add, limit_tail)
        registers = (source_base, target_base, index, limit, target_end)
        if not self._copy_until_state_valid(state, registers):
            return None

        locals_ = [Operand('local', coordinate)
                   for coordinate in range(len(REGISTER_NAMES) + 1)]
        nodes = []

        def emit(operation, arguments):
            arguments = tuple(arguments)
            if operation.startswith(('i32.', 'i64.')):
                operation, arguments = select_lane(operation, arguments)
            value = len(nodes) + 1
            nodes.append(WaveNode(value, operation, arguments))
            return Operand('node', value)

        copied = emit('memory.i64.copy_until', (
            locals_[source_base], locals_[target_base], locals_[index],
            locals_[limit], locals_[target_end], Operand('const', 0),
            Operand('const', memory_shape(1, virtual64=True))))
        final_index = emit('lane64.BEXTR', (
            copied, Operand('const', 0), Operand('const', 32)))
        final_byte = emit('lane64.BEXTR', (
            copied, Operand('const', 32), Operand('const', 8)))
        final_pointer = emit('i64.add', (
            locals_[target_base], final_index))
        prior_flags = locals_[len(REGISTER_NAMES)]
        limit_flags = emit('lane64.X86_FLAGS', (
            prior_flags, locals_[target_base], final_index, final_pointer,
            Operand('const', 64 | (1 << 8))))
        sentinel_flags = emit('lane64.X86_FLAGS', (
            prior_flags, final_byte, final_byte, final_byte,
            Operand('const', 8)))
        flags = emit('lane64.SELECT', (
            limit_flags, sentinel_flags, final_byte))
        locals_[index] = final_index
        locals_[REGISTER_INDEX['rsi']] = final_index
        locals_[byte_register] = final_byte
        locals_[target_register] = final_pointer
        locals_[target_base] = final_pointer
        plan = normalize_plan(PureSlice(
            0, 0, len(proof_blocks), len(proof_blocks), 0, tuple(nodes),
            DependencyWaves((0,), (), (0,)), (),
            tuple(locals_[:len(REGISTER_NAMES)]) + (flags,)))
        packed = pack_step(plan)
        mapped = unpack_step(packed)
        execute = self._bind_state_page(mapped, packed)
        proof_start = branch.rip
        proof_stop = common.boundary_rip
        if proof_stop <= proof_start:
            return None
        proof_config, proof = _execution_proof(
            state, proof_start, proof_stop - proof_start)
        cut = DecodedBlock(
            target, backedge.rip,
            b''.join(block.source for block in proof_blocks),
            len(proof_blocks), plan, mapped, execute, 0,
            X86Boundary('branch', common.boundary_rip),
            proof_config, proof, state_flags=True, virtual_memory=True)
        self._copy_cuts[branch.rip] = branch, (
            proof_blocks, cut, registers)
        self.copy_cuts += 1
        self.copy_cut_cache_misses += 1
        self.copy_cut_work += physical_work(plan)
        self.copy_cut_span += plan.waves.span
        return cut

    def _collapse_copy_until(self, state, branch):
        cut = self._copy_until_cut(state, branch)
        if cut is None:
            return state
        proof_blocks, _cut, registers = self._copy_cuts[branch.rip][1]
        _source_base, target_base, index, limit, target_end = registers
        start = state.registers[index] & MASK32
        stop = state.registers[limit] & MASK32
        target = state.registers[target_base] & MASK64
        target_limit = state.registers[target_end] & MASK64
        prior = state
        state, scratch = self._execute_plan(state, cut)
        state, boundary = self._control(
            state, cut.boundary, prior, scratch)
        if boundary is not None:
            raise X86Error('a pure byte copy published a barrier')
        final = state.registers[index] & MASK32
        turns = (final - start) & MASK32
        self.copy_cut_bytes += turns
        self.copy_cut_executions += 1
        self.copy_cut_executed_work += physical_work(cut.plan)
        self.copy_cut_executed_span += cut.plan.waves.span

        # Count the actual source path without replaying the copy.  The
        # residual's final index says how many non-sentinel turns retired;
        # the final byte distinguishes the sentinel and limit exits.  Writes
        # are a modular coordinate interval intersected with [0,target_end).
        head = sum(block.instructions + 1
                   for block in proof_blocks[4:8])
        capacity = sum(block.instructions + 1
                       for block in proof_blocks[8:10])
        write_path = sum(block.instructions + 1
                         for block in proof_blocks[10:12])
        update = sum(block.instructions + 1
                     for block in proof_blocks[1:4])
        coordinate = (target + start) & MASK64
        extent_end = coordinate + turns
        if extent_end <= 1 << 64:
            writes = max(0, min(extent_end, target_limit)
                         - min(coordinate, target_limit))
        else:
            writes = (max(0, target_limit - coordinate)
                      + min(extent_end - (1 << 64), target_limit))
        retired = turns * (head + capacity + update) + writes * write_path
        (_next, byte_register, _source_bits,
         _target_bits, _operand) = proof_blocks[5].boundary.detail
        final_byte = _register_operand_value(
            state.registers, byte_register, 8)
        if final < stop and final_byte == 0:
            retired += head
            retired += proof_blocks[12].instructions + 1
            retired += proof_blocks[13].instructions
        else:
            retired += proof_blocks[14].instructions + 1
            retired += proof_blocks[15].instructions
        self.copy_source_instructions += retired
        return state

    def _collapse_backward_direct_branch(self, state, branch):
        """Apply direct-coordinate reducers selected by a backward jump."""
        cached = self._backward_branch_recipes.get(branch.rip)
        if cached is not None and cached[0] is branch:
            self.backward_branch_recipe_hits += 1
            return cached[1](state, branch)
        reducers = (
            self._collapse_relative_record_projection,
            self._collapse_wrapped_byte_walk,
            self._collapse_bit_partition_loop,
            self._collapse_residual_byte_run,
            self._collapse_indirect_string_table_span,
            self._collapse_ftrace_location_span,
            self._collapse_header_byte_dispatch,
            self._collapse_byte_state_slice,
            self._collapse_loaded_byte_state_slice,
        )
        for reducer in reducers:
            before = int(state.rip) & MASK64
            state = reducer(state, branch)
            if int(state.rip) & MASK64 != before:
                self._backward_branch_recipes[branch.rip] = branch, reducer
                return state
        return state

    def _collapse_direct_branch(self, state, branch):
        """Apply a structural reducer selected by one direct branch block."""
        if (branch.boundary.operation != 'branch'
                or not isinstance(branch.boundary.detail, int)):
            return state
        state = self._collapse_byte_find(state, branch)
        if state.rip != (int(branch.boundary.detail) & MASK64):
            return state
        state = self._collapse_copy_until(state, branch)
        if state.rip != (int(branch.boundary.detail) & MASK64):
            return state
        if self._code_contains_recipe(
                state, int(branch.boundary.detail) & MASK64,
                b'\xc3', extent=1):
            return self._collapse_return_branch(state, branch)
        if not self.enable_function_oracles:
            return state
        cached = self._direct_branch_recipes.get(branch.rip)
        if cached is not None and cached[0] is branch:
            reducer = cached[1]
        else:
            if branch.source.endswith(_TOKEN_STREAM_BRANCH):
                reducer = self._collapse_token_stream_entry
            elif self._page_record_projection_layout(
                    state, branch) is not None:
                reducer = self._collapse_page_record_projection
            elif (int(branch.boundary.detail) & MASK64) < branch.rip:
                reducer = self._collapse_backward_direct_branch
            else:
                reducer = None
            self._direct_branch_recipes[branch.rip] = branch, reducer
        return state if reducer is None else reducer(state, branch)

    def _collapse_recipe(self, state, branch):
        """Select structural loop reducers once for one proven backedge.

        Runtime registers decide whether a selected reducer fires.  The
        candidate set depends only on normalized boundary operations, so a
        hot negative branch does not repeatedly walk every recognizer.  Block
        identity ties the residual recipe to the executable-page proof.
        """
        cached = self._collapse_recipes.get(branch.rip)
        _following, target, condition = branch.boundary.detail
        target_block = self.blocks.get(target)
        if (target_block is None and state.rip == target
                and target < branch.rip):
            target_block = self.block(state)
        if (cached is not None and cached[0] is branch
                and cached[1] is target_block):
            self.collapse_recipe_hits += 1
            return cached[2]

        operation = (None if target_block is None
                     else target_block.boundary.operation)
        recipes = ()
        if condition == 5:
            recipes = {
                'immediate_alu': (self._collapse_token_expansion,
                                  self._collapse_zero_scan),
                'store': (self._collapse_fill_loop,
                          self._collapse_repeat_store_loop),
                'group_ff': (self._collapse_counted_repeat_loop,
                             self._collapse_byte_dispatch,
                             self._collapse_byte_state_slice,
                             self._collapse_prefixed_header_byte_dispatch,
                             self._collapse_indirect_field_search,
                             self._collapse_btf_name_loop),
                'load': (self._collapse_normalized_field_search,
                         self._collapse_repeated_store_call_loop,
                         self._collapse_strided_multiply_loop,
                         self._collapse_btf_nonmodifier_span,
                         self._collapse_copy_loop),
                'move_zero_extend': (self._collapse_classified_byte_scan,
                                     self._collapse_residual_byte_run,
                                     self._collapse_copy_loop,
                                     self._collapse_bounded_compare_loop,
                                     self._collapse_compare_loop,
                                     self._collapse_strided_invariant_byte_run,
                                     self._collapse_loaded_byte_state_slice),
                'compare': (self._collapse_token_expansion,
                            self._collapse_byte_search,
                            self._collapse_page_reservation_projection),
                'conditional_branch': (
                    self._collapse_strided_predicate_candidates,),
                'register_immediate_result_flags': (
                    self._collapse_strided_predicate_candidates,),
                'bit_immediate': (
                    self._collapse_strided_record_projection,),
                'call': (self._collapse_random_permutation_loop,),
                'lea': (self._collapse_page_bootmem_loop,
                        self._collapse_default_record_candidates),
                'move_sign_extend': (
                    self._collapse_predicate_record_projection,),
            }.get(operation, ())
        elif condition == 3 and operation == 'immediate_alu':
            recipes = (self._collapse_substring_candidates,)
        elif condition == 3 \
                and operation == 'register_immediate_result_flags':
            recipes = (self._collapse_wide_copy_loop,)
        elif condition == 2 and operation == 'load':
            recipes = (self._collapse_random_freelist_loop,
                       self._collapse_relative_record_projection,
                       self._collapse_default_record_candidates,
                       self._collapse_predicate_record_projection)
        elif condition == 2 and operation == 'call':
            recipes = (self._collapse_strided_copy_predicate_candidates,)
        elif condition == 12 and operation == 'load':
            recipes = (self._collapse_sequential_freelist_loop,
                       self._collapse_strided_store_loop,
                       self._collapse_ftrace_record_span)
        elif condition == 4 \
                and operation == 'register_immediate_result_flags':
            recipes = (self._collapse_zero_word_scan,)
        elif condition == 2 and operation == 'compare':
            recipes = (self._collapse_affine_page_records,)
        elif operation == 'group_ff':
            recipes = (self._collapse_byte_dispatch,
                       self._collapse_byte_state_slice)

        self._collapse_recipes[branch.rip] = (
            branch, target_block, recipes)
        self.collapse_recipe_misses += 1
        self.collapse_recipe_negative += int(not recipes)
        return recipes

    def _collapse_branch(self, state, branch):
        """Apply only the residual reducers selected for this backedge."""
        count = state.registers[REGISTER_INDEX['rdx']] & MASK32
        limit = state.registers[REGISTER_INDEX['rax']] & MASK64
        length = state.registers[REGISTER_INDEX['rsi']] & MASK32
        prefix = (self._length_prefix_cut(state, branch)
                  if 1 <= count <= limit <= 0xff and length < 0x80
                  else None)
        if prefix is not None:
            if self._physical_profile is not None:
                self.prefix_source_instructions += \
                    self._length_prefix_source_instructions(
                        state, state.registers[REGISTER_INDEX['rcx']],
                        count, length, limit)
            prior = state
            state, scratch = self._execute_plan(state, prefix)
            state, boundary = self._control(
                state, prefix.boundary, prior, scratch)
            if boundary is not None:
                raise X86Error('a pure prefix recurrence published a barrier')
            self.prefix_cut_executions += 1
            self.prefix_cut_executed_work += physical_work(prefix.plan)
            self.prefix_cut_executed_span += prefix.plan.waves.span
            self.collapsed_length_prefix_entries += limit - count + 1
            return state
        recurrence = self._counted_repeat_cut(state, branch)
        if recurrence is not None:
            (cut, counter, iteration_bytes,
             source_instructions) = recurrence
            iterations = state.registers[counter] & MASK64
            prior = state
            state, scratch = self._execute_plan(state, cut)
            state, boundary = self._control(
                state, cut.boundary, prior, scratch)
            if boundary is not None:
                raise X86Error('a pure recurrence published a barrier')
            self.recurrence_cut_executions += 1
            self.recurrence_cut_executed_work += physical_work(cut.plan)
            self.recurrence_cut_executed_span += cut.plan.waves.span
            self.recurrence_source_instructions += \
                iterations * source_instructions
            self.collapsed_repeat_bytes += iterations * iteration_bytes
            self.collapsed_repeat_iterations += iterations
            return state
        if not self.enable_function_oracles:
            return state
        for reducer in self._collapse_recipe(state, branch):
            self.collapse_recipe_attempts += 1
            state = reducer(state, branch)
        return state

    @staticmethod
    def _code_contains(state, address, marker, extent=96):
        try:
            return marker in read_virtual(
                state, int(address) & MASK64, int(extent), 'execute')
        except PageFault:
            return False

    def _code_contains_recipe(self, state, address, marker, extent=96):
        """Reuse a code predicate while its direct page proof is unchanged."""
        address = int(address) & MASK64
        extent = int(extent)
        markers = marker if isinstance(marker, tuple) else (marker,)
        key = address, markers, extent
        cached = self._code_recipes.get(key)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                self.code_recipe_hits += 1
                return present
        try:
            code = read_virtual(
                state, int(address) & MASK64, int(extent), 'execute')
            present = any(candidate in code for candidate in markers)
        except PageFault:
            present = False
        config, proof = _execution_proof(state, address, extent)
        self.code_recipe_misses += 1
        self.code_recipe_negative += int(not present)
        if proof is not None:
            self._code_recipes[key] = config, proof, present
        else:
            self._code_recipes.pop(key, None)
        return present

    def _symbol_position_layout(self, state, target):
        """Recover the three direct arrays used by Linux symbol lookup."""
        target = int(target) & MASK64
        cached = self._symbol_position_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout

        layout = None
        signature_bytes = 14
        extent = signature_bytes
        try:
            signature = read_virtual(
                state, target, signature_bytes, 'execute')
            if signature != _SYMBOL_POSITION_ENTRY[:signature_bytes]:
                raise LookupError
            extent = 0xd9
            code = read_virtual(state, target, extent, 'execute')
            entry = bytearray(code[:len(_SYMBOL_POSITION_ENTRY)])
            expected_entry = bytearray(_SYMBOL_POSITION_ENTRY)
            entry[0x10:0x14] = expected_entry[0x10:0x14] = b'\0' * 4
            entry[0x1d:0x21] = expected_entry[0x1d:0x21] = b'\0' * 4
            search = bytearray(code[0x2b:0x58])
            expected_search = bytearray(_SYMBOL_POSITION_SEARCH)
            search[0x1c:0x20] = expected_search[0x1c:0x20] = b'\0' * 4
            num_syms = (target + 0x14 + _signed_integer(
                int.from_bytes(code[0x10:0x14], 'little'), 32)) & MASK64
            relative_base = (target + 0x21 + _signed_integer(
                int.from_bytes(code[0x1d:0x21], 'little'), 32)) & MASK64
            offsets = _signed_integer(
                int.from_bytes(code[0x47:0x4b], 'little'), 32) & MASK64
            second_relative = (target + 0xa7 + _signed_integer(
                int.from_bytes(code[0xa3:0xa7], 'little'), 32)) & MASK64
            second_offsets = _signed_integer(
                int.from_bytes(code[0xb5:0xb9], 'little'), 32) & MASK64
            third_offsets = _signed_integer(
                int.from_bytes(code[0xd5:0xd9], 'little'), 32) & MASK64
            if (entry == expected_entry
                    and search == expected_search
                    and code[0xa0:0xa3] == b'\x4c\x8b\x15'
                    and code[0xb1:0xb5] == b'\x46\x8b\x04\x85'
                    and code[0xd2:0xd5] == b'\x41\x8b\x9b'
                    and second_relative == relative_base
                    and second_offsets == offsets == third_offsets):
                layout = num_syms, relative_base, offsets
        except (LookupError, PageFault):
            pass

        config, proof = _execution_proof(state, target, extent)
        if proof is not None:
            self._symbol_position_functions[target] = config, proof, layout
        else:
            self._symbol_position_functions.pop(target, None)
        return layout

    def _symbol_offset_page(self, state, page_address):
        """Decode one immutable 256-byte offset page by direct coordinate."""
        page_address = int(page_address) & MASK64
        cached = self._symbol_offset_pages.get(page_address)
        if cached is not None:
            config, proof, values = cached
            if _proof_mismatch(state, config, proof) is None:
                self.symbol_offset_page_hits += 1
                return values, config, proof
        reader = _VirtualProofReader(state)
        try:
            payload = reader.read(page_address, PHYSICAL_PAGE_BYTES)
        except PageFault:
            return None
        values = struct.unpack('<%dI' % (PHYSICAL_PAGE_BYTES // 4), payload)
        config, proof = reader.proof()
        self._symbol_offset_pages[page_address] = config, proof, values
        self.symbol_offset_page_misses += 1
        return values, config, proof

    def _symbol_position_directory(self, state, layout):
        """Retain one sorted offset array in its compact physical form."""
        cached = self._symbol_position_directories.get(layout)
        if cached is not None:
            config, proof, directory = cached
            if _proof_mismatch(state, config, proof) is None:
                self.symbol_position_directory_hits += 1
                return directory
        num_address, relative_address, offsets = layout
        reader = _VirtualProofReader(state)
        try:
            count = reader.load(num_address, 4)
            relative = reader.load(relative_address, 8)
            if count < 2 or count > (1 << 28):
                return None
            payload = reader.read(offsets, count * 4)
            previous = -1
            for (value,) in struct.iter_unpack('<I', payload):
                if value < previous:
                    return None
                previous = value
        except (PageFault, struct.error):
            return None
        directory = relative, payload, count
        config, proof = reader.proof()
        self._symbol_position_directories[layout] = \
            config, proof, directory
        self.symbol_position_directory_misses += 1
        return directory

    @staticmethod
    def _symbol_position_from_directory(directory, address):
        """Answer position, size and offset from a compact sorted array."""
        relative, payload, count = directory

        def symbol(index):
            return (relative + struct.unpack_from(
                '<I', payload, int(index) * 4)[0]) & MASK64

        low, high = 0, count
        while high - low > 1:
            middle = low + (high - low) // 2
            if symbol(middle) <= address:
                low = middle
            else:
                high = middle
        start = symbol(low)
        first_low, first_high = 0, low + 1
        while first_low < first_high:
            middle = (first_low + first_high) // 2
            if symbol(middle) < start:
                first_low = middle + 1
            else:
                first_high = middle
        position = first_low
        end_low, end_high = low + 1, count
        while end_low < end_high:
            middle = (end_low + end_high) // 2
            if symbol(middle) <= start:
                end_low = middle + 1
            else:
                end_high = middle
        if end_low >= count:
            return None
        end = symbol(end_low)
        return position, end - start, (address - start) & MASK64

    @staticmethod
    def _proof_cstring(reader, address, limit=1 << 20):
        """Read a NUL-terminated value without touching the following page."""
        chunks = []
        offset = 0
        while offset < limit:
            coordinate = (int(address) + offset) & MASK64
            count = min(256, limit - offset,
                        PAGE_BYTES - (coordinate & (PAGE_BYTES - 1)))
            chunk = reader.read(coordinate, count)
            stop = chunk.find(b'\0')
            if stop >= 0:
                chunks.append(chunk[:stop])
                return b''.join(chunks)
            chunks.append(chunk)
            offset += count
        return None

    def _direct_u32_index_layout(self, state, target):
        """Recognize an ABI leaf that returns one absolute u32 table slot."""
        target = int(target) & MASK64
        cached = self._direct_index_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                self.direct_index_cache_hits += 1
                return layout
        layout = None
        try:
            code = read_virtual(state, target, 29, 'execute')
            if (code[:18] == bytes.fromhex(
                    'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 89 f8 '
                    '8b 04 85')
                    and code[22:25] == bytes.fromhex('5d 2e e9')):
                table = int.from_bytes(
                    code[18:22], 'little', signed=True) & MASK64
                layout = table, 4
        except PageFault:
            pass
        config, proof = _execution_proof(state, target, 29)
        if proof is not None:
            self._direct_index_functions[target] = config, proof, layout
        else:
            self._direct_index_functions.pop(target, None)
        self.direct_index_cache_misses += 1
        return layout

    def _collapse_direct_u32_index_call(self, state, following, target):
        """Compose a proved direct-index leaf without an ABI frame."""
        layout = self._direct_u32_index_layout(state, target)
        if layout is None:
            return None
        table, scale = layout
        index = state.register('rdi') & MASK32
        try:
            value = load_virtual(
                state, (table + index * scale) & MASK64, 4)
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], value, 32)
        self.collapsed_direct_index_calls += 1
        return replace(state, registers=registers,
                       rip=following & MASK64)

    @staticmethod
    def _keccak_f1600(lanes):
        """Apply Keccak-f[1600] directly to its 25 physical lanes."""
        rotations = (
            1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
            27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
        )
        permutation = (
            10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
            15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
        )
        constants = (
            0x0000000000000001, 0x0000000000008082,
            0x800000000000808a, 0x8000000080008000,
            0x000000000000808b, 0x0000000080000001,
            0x8000000080008081, 0x8000000000008009,
            0x000000000000008a, 0x0000000000000088,
            0x0000000080008009, 0x000000008000000a,
            0x000000008000808b, 0x800000000000008b,
            0x8000000000008089, 0x8000000000008003,
            0x8000000000008002, 0x8000000000000080,
            0x000000000000800a, 0x800000008000000a,
            0x8000000080008081, 0x8000000000008080,
            0x0000000080000001, 0x8000000080008008,
        )

        lanes = [int(value) & MASK64 for value in lanes]
        for constant in constants:
            c0 = lanes[0] ^ lanes[5] ^ lanes[10] ^ lanes[15] ^ lanes[20]
            c1 = lanes[1] ^ lanes[6] ^ lanes[11] ^ lanes[16] ^ lanes[21]
            c2 = lanes[2] ^ lanes[7] ^ lanes[12] ^ lanes[17] ^ lanes[22]
            c3 = lanes[3] ^ lanes[8] ^ lanes[13] ^ lanes[18] ^ lanes[23]
            c4 = lanes[4] ^ lanes[9] ^ lanes[14] ^ lanes[19] ^ lanes[24]
            columns = (c0, c1, c2, c3, c4)
            for x in range(5):
                following = columns[(x + 1) % 5]
                theta = (columns[(x - 1) % 5]
                         ^ (((following << 1) | (following >> 63))
                            & MASK64))
                lanes[x] ^= theta
                lanes[x + 5] ^= theta
                lanes[x + 10] ^= theta
                lanes[x + 15] ^= theta
                lanes[x + 20] ^= theta

            carried = lanes[1]
            for target, count in zip(permutation, rotations):
                displaced = lanes[target]
                lanes[target] = (
                    (carried << count) | (carried >> (64 - count))) & MASK64
                carried = displaced

            for row in range(0, 25, 5):
                a0, a1, a2, a3, a4 = lanes[row:row + 5]
                lanes[row] = (a0 ^ ((~a1 & MASK64) & a2)) & MASK64
                lanes[row + 1] = (a1 ^ ((~a2 & MASK64) & a3)) & MASK64
                lanes[row + 2] = (a2 ^ ((~a3 & MASK64) & a4)) & MASK64
                lanes[row + 3] = (a3 ^ ((~a4 & MASK64) & a0)) & MASK64
                lanes[row + 4] = (a4 ^ ((~a0 & MASK64) & a1)) & MASK64
            lanes[0] ^= constant
        return tuple(lanes)

    def _lane_permutation_layout(self, state, target):
        """Recognize a 25-lane Keccak-f[1600] ABI leaf."""
        target = int(target) & MASK64
        cached = self._lane_permutation_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        signature = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 41 57 41 56 41 55 41 54 '
            '53 48 81 ec e8 00 00 00 48 8b 37 48 8b 4f 08')
        try:
            present = read_virtual(
                state, target, len(signature), 'execute') == signature
        except PageFault:
            present = False
        config, proof = _execution_proof(state, target, len(signature))
        if proof is not None:
            self._lane_permutation_functions[target] = (
                config, proof, present)
        else:
            self._lane_permutation_functions.pop(target, None)
        return present

    @staticmethod
    def _chacha_permute(lanes, rounds):
        """Apply the ChaCha column/diagonal waves to sixteen u32 lanes."""
        lanes = [int(value) & MASK32 for value in lanes]

        def rotate(value, count):
            return ((value << count) | (value >> (32 - count))) & MASK32

        def quarter(a, b, c, d):
            lanes[a] = (lanes[a] + lanes[b]) & MASK32
            lanes[d] = rotate(lanes[d] ^ lanes[a], 16)
            lanes[c] = (lanes[c] + lanes[d]) & MASK32
            lanes[b] = rotate(lanes[b] ^ lanes[c], 12)
            lanes[a] = (lanes[a] + lanes[b]) & MASK32
            lanes[d] = rotate(lanes[d] ^ lanes[a], 8)
            lanes[c] = (lanes[c] + lanes[d]) & MASK32
            lanes[b] = rotate(lanes[b] ^ lanes[c], 7)

        for _round in range(0, int(rounds), 2):
            quarter(0, 4, 8, 12)
            quarter(1, 5, 9, 13)
            quarter(2, 6, 10, 14)
            quarter(3, 7, 11, 15)
            quarter(0, 5, 10, 15)
            quarter(1, 6, 11, 12)
            quarter(2, 7, 8, 13)
            quarter(3, 4, 9, 14)
        return tuple(lanes)

    def _chacha_permutation_layout(self, state, target):
        """Prove the current compiled sixteen-lane ChaCha ABI leaf."""
        target = int(target) & MASK64
        cached = self._chacha_permutation_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        reader = _VirtualProofReader(state)
        present = False
        try:
            code = bytearray(reader.read(target, 0x274))
            displacement = _signed_integer(
                int.from_bytes(code[-4:], 'little'), 32)
            return_thunk = (target + len(code) + displacement) & MASK64
            code[-4:] = bytes(4)
            present = (
                hashlib.sha256(code).digest() == _CHACHA_PERMUTATION_SHA256
                and reader.read(return_thunk, 1) == b'\xc3')
        except PageFault:
            pass
        config, proof = reader.proof()
        self._chacha_permutation_functions[target] = (
            config, proof, present)
        return present

    def _collapse_lane_permutation_call(self, state, following, target):
        """Execute a proved lane permutation without an ABI frame."""
        address = state.register('rdi') & MASK64
        if self._chacha_permutation_layout(state, target):
            rounds = state.register('rsi') & MASK32
            if rounds not in (12, 20):
                return None
            try:
                lanes = struct.unpack(
                    '<16I', read_virtual(state, address, 16 * 4))
                output = struct.pack(
                    '<16I', *self._chacha_permute(lanes, rounds))
                state = write_virtual(state, address, output)
            except (PageFault, struct.error):
                return None
            self.collapsed_lane_permutation_calls += 1
            self.collapsed_lane_permutation_lanes += 16
            self.collapsed_chacha_rounds += rounds
            return replace(state, rip=following & MASK64)
        if not self._lane_permutation_layout(state, target):
            return None
        try:
            lanes = struct.unpack(
                '<25Q', read_virtual(state, address, 25 * 8))
            output = struct.pack('<25Q', *self._keccak_f1600(lanes))
            state = write_virtual(state, address, output)
        except (PageFault, struct.error):
            return None
        self.collapsed_lane_permutation_calls += 1
        self.collapsed_lane_permutation_lanes += 25
        return replace(state, rip=following & MASK64)

    def _is_sponge_finalize_function(self, state, target):
        """Recognize a metadata-sized sponge finalization function."""
        target = int(target) & MASK64
        cached = self._sponge_finalize_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        entry = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 e4 f0 '
            '48 81 ec b0 00 00 00 48 89 cb 41 89 d6 '
            '48 89 34 24 49 89 ff')
        metadata = bytes.fromhex(
            '48 8b 07 48 8b 40 20 8b 48 f8 48 89 4c 24 08 '
            '44 8b 60 24 48 8d 7c 24 10 ba 90 00 00 00 31 f6')
        present = True
        config = None
        proof = ()
        for address, signature in (
                (target, entry), (target + 0x3e, metadata)):
            try:
                matches = read_virtual(
                    state, address, len(signature), 'execute') == signature
            except PageFault:
                matches = False
            current_config, current_proof = _execution_proof(
                state, address, len(signature))
            if (current_proof is None
                    or (config is not None and current_config != config)):
                proof = None
                present = False
                break
            config = current_config
            proof += current_proof
            if not matches:
                present = False
                break
        if proof is not None:
            self._sponge_finalize_functions[target] = (
                config, proof, present)
        else:
            self._sponge_finalize_functions.pop(target, None)
        return present

    def _collapse_sponge_finalize_payload(
            self, state, following, target, descriptor, payload,
            output_address):
        """Finalize one proved payload without publishing a staging block."""
        if not self._is_sponge_finalize_function(state, target):
            return None
        count = len(payload)
        try:
            transform = load_virtual(state, descriptor, 8)
            algorithm = load_virtual(state, transform + 0x20, 8)
            digest_bytes = load_virtual(state, algorithm - 8, 4)
            rate_bytes = load_virtual(state, algorithm + 0x24, 4)
            if (not 0 < digest_bytes <= 64
                    or not 0 < rate_bytes <= 144
                    or rate_bytes & 7 or count >= rate_bytes):
                return None
            lanes = list(struct.unpack(
                '<25Q', read_virtual(state, descriptor + 8, 25 * 8)))
        except (PageFault, struct.error):
            return None

        block = bytearray(rate_bytes)
        block[:count] = payload
        block[count] = 0x06
        block[-1] |= 0x80
        for index, (word,) in enumerate(struct.iter_unpack('<Q', block)):
            lanes[index] ^= word
        lanes = self._keccak_f1600(lanes)
        lane_bytes = struct.pack('<25Q', *lanes)
        try:
            state = write_virtual(state, descriptor + 8, lane_bytes)
            state = write_virtual(
                state, output_address, lane_bytes[:digest_bytes])
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], 0, 32)
        self.collapsed_sponge_finalize_calls += 1
        self.collapsed_sponge_finalize_bytes += count + digest_bytes
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _collapse_sponge_finalize_call(self, state, following, target):
        """Fuse absorb, padding, permutation and output into one SSA cut."""
        if not self._is_sponge_finalize_function(state, target):
            return None
        descriptor = state.register('rdi') & MASK64
        source = state.register('rsi') & MASK64
        count = state.register('rdx') & MASK32
        output_address = state.register('rcx') & MASK64
        try:
            payload = read_virtual(state, source, count)
        except PageFault:
            return None
        return self._collapse_sponge_finalize_payload(
            state, following, target, descriptor, payload, output_address)

    def _is_sponge_init_function(self, state, target):
        target = int(target) & MASK64
        cached = self._sponge_init_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        signature = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '48 83 c7 08 ba c8 00 00 00 31 f6')
        try:
            present = read_virtual(
                state, target, len(signature), 'execute') == signature
        except PageFault:
            present = False
        config, proof = _execution_proof(state, target, len(signature))
        if proof is not None:
            self._sponge_init_functions[target] = config, proof, present
        else:
            self._sponge_init_functions.pop(target, None)
        return present

    def _is_hash_init_wrapper(self, state, target):
        target = int(target) & MASK64
        cached = self._hash_init_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        signature = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 48 8b 0f '
            'b8 82 ff ff ff f6 41 04 01 75 27 '
            '48 8b 41 20 f6 40 23 01')
        try:
            present = read_virtual(
                state, target, len(signature), 'execute') == signature
        except PageFault:
            present = False
        config, proof = _execution_proof(state, target, len(signature))
        if proof is not None:
            self._hash_init_functions[target] = config, proof, present
        else:
            self._hash_init_functions.pop(target, None)
        return present

    def _is_sponge_update_function(self, state, target):
        target = int(target) & MASK64
        cached = self._sponge_update_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        signature = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 ec 10 '
            '89 d3 49 89 f6 49 89 ff 48 8b 07 48 8b 40 20 '
            '44 8b 68 24')
        try:
            present = read_virtual(
                state, target, len(signature), 'execute') == signature
        except PageFault:
            present = False
        config, proof = _execution_proof(state, target, len(signature))
        if proof is not None:
            self._sponge_update_functions[target] = (
                config, proof, present)
        else:
            self._sponge_update_functions.pop(target, None)
        return present

    def _collapse_sponge_absorb(
            self, state, descriptor, rate_bytes, payload):
        """Absorb complete rate blocks and return their residual suffix."""
        complete = len(payload) // rate_bytes * rate_bytes
        if not complete:
            return state, payload
        try:
            lanes = list(struct.unpack(
                '<25Q', read_virtual(state, descriptor + 8, 25 * 8)))
        except (PageFault, struct.error):
            return None
        for start in range(0, complete, rate_bytes):
            block = payload[start:start + rate_bytes]
            for index, (word,) in enumerate(
                    struct.iter_unpack('<Q', block)):
                lanes[index] ^= word
            lanes = self._keccak_f1600(lanes)
        try:
            state = write_virtual(
                state, descriptor + 8, struct.pack('<25Q', *lanes))
        except PageFault:
            return None
        self.collapsed_sponge_absorb_blocks += complete // rate_bytes
        self.collapsed_sponge_absorb_bytes += complete
        return state, payload[complete:]

    def _sponge_digest(self, payload, rate_bytes, digest_bytes):
        lanes = [0] * 25
        complete = len(payload) // rate_bytes * rate_bytes
        for start in range(0, complete, rate_bytes):
            block = payload[start:start + rate_bytes]
            for index, (word,) in enumerate(
                    struct.iter_unpack('<Q', block)):
                lanes[index] ^= word
            lanes = self._keccak_f1600(lanes)
        block = bytearray(rate_bytes)
        residual = payload[complete:]
        block[:len(residual)] = residual
        block[len(residual)] = 0x06
        block[-1] |= 0x80
        for index, (word,) in enumerate(struct.iter_unpack('<Q', block)):
            lanes[index] ^= word
        return struct.pack(
            '<25Q', *self._keccak_f1600(lanes))[:digest_bytes]

    def _is_sponge_mix_function(self, state, target):
        target = int(target) & MASK64
        cached = self._sponge_mix_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        signature = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 e4 f0 '
            '48 81 ec d0 01 00 00')
        try:
            code = read_virtual(
                state, target, 4 + len(signature), 'execute')
            present = (code[:4] in (
                bytes.fromhex('f3 0f 1e fa'),
                bytes.fromhex('0f 1f 40 d6'))
                and code[4:] == signature)
        except PageFault:
            present = False
        config, proof = _execution_proof(
            state, target, 4 + len(signature))
        if proof is not None:
            self._sponge_mix_functions[target] = config, proof, present
        else:
            self._sponge_mix_functions.pop(target, None)
        return present

    def _collapse_modular_delta_call(self, state, following, target):
        """Normalize a wrap branch to one modular subtraction."""
        target = int(target) & MASK64
        cached = self._modular_delta_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is not None:
                present = None
        else:
            present = None
        if present is None:
            signature = bytes.fromhex(
                '55 48 89 e5 48 83 ec 18 48 89 7d f8 '
                '48 89 75 f0 48 8b 45 f8 48 3b 45 f0 73 0e')
            try:
                present = read_virtual(
                    state, target, len(signature), 'execute') == signature
            except PageFault:
                present = False
            config, proof = _execution_proof(
                state, target, len(signature))
            if proof is not None:
                self._modular_delta_functions[target] = (
                    config, proof, present)
            else:
                self._modular_delta_functions.pop(target, None)
        if not present:
            return None
        result = (state.register('rsi') - state.register('rdi')) & MASK64
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], result, 64)
        self.collapsed_modular_delta_calls += 1
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _collapse_clock_store_return(self, state):
        """Compose the pure continuation after a 64-bit clock response.

        The clock remains an explicit machine event.  This reducer starts at
        the response coordinate and recognizes the independent continuation
        which joins EDX:EAX, stores it through RBX, restores two saved
        registers, and returns.  An executable-page proof keeps the recipe
        valid after alternatives or other runtime text patching.
        """
        target = int(state.rip) & MASK64
        cached = self._clock_store_returns.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is not None:
                present = None
        else:
            present = None
        if present is None:
            try:
                code = read_virtual(state, target, 23, 'execute')
                present = (
                    code[:9] == bytes.fromhex(
                        '48 c1 e2 20 48 09 c2 75 08')
                    and code[9] == 0xe8
                    and code[14:] == bytes.fromhex(
                        '48 89 c2 48 89 13 5b 5d c3'))
            except PageFault:
                present = False
            config, proof = _execution_proof(state, target, 23)
            if proof is not None:
                self._clock_store_returns[target] = config, proof, present
            else:
                self._clock_store_returns.pop(target, None)
        if not present:
            return state

        low = state.register('rax') & MASK32
        high = (state.register('rdx') & MASK32) << 32
        value = low | high
        if not value:
            return state
        pointer = state.register('rsp') & MASK64
        output = state.register('rbx') & MASK64
        if output < pointer + 24 and pointer < output + 8:
            return state
        try:
            saved_rbx = load_virtual(state, pointer, 8)
            saved_rbp = load_virtual(state, pointer + 8, 8)
            following = load_virtual(state, pointer + 16, 8)
            translate(state, output, 'write')
            translate(state, (output + 7) & MASK64, 'write')
            state = write_virtual(state, output, struct.pack('<Q', value))
        except PageFault:
            return state
        registers = list(state.registers)
        registers[REGISTER_INDEX['rdx']] = value
        registers[REGISTER_INDEX['rbx']] = saved_rbx & MASK64
        registers[REGISTER_INDEX['rbp']] = saved_rbp & MASK64
        registers[REGISTER_INDEX['rsp']] = (pointer + 24) & MASK64
        flags = _result_flags(
            state.rflags, 'or', low, high, value, 64)
        self.collapsed_clock_store_returns += 1
        return replace(state, registers=tuple(registers),
                       rip=following & MASK64, rflags=flags)

    @staticmethod
    def _relative_call_target(state, following):
        """Resolve one proved near-call ending at ``following``."""
        following = int(following) & MASK64
        code = read_virtual(state, (following - 5) & MASK64, 5, 'execute')
        if code[0] != 0xe8:
            return None
        return (following
                + int.from_bytes(code[1:], 'little', signed=True)) & MASK64

    def _collapse_entropy_recurrence(
            self, state, clock_step, clock_variation_bits):
        """Close one proved jitter measurement recurrence over virtual TSC.

        A clock response is still the input barrier.  Once its replayable
        progression is known, the surrounding generator is a bounded state
        recurrence over the collector, a wrapped byte domain and a sponge
        pool.  This summary keeps those values local until the generator's
        return cut instead of re-entering the scalar call graph per sample.
        """
        def reject(reason):
            profile = self._entropy_recurrence_profile
            if profile is not None:
                key = (str(reason), state.rip & MASK64)
                profile[key] = profile.get(key, 0) + 1
            return None

        pointer = state.register('rsp') & MASK64
        if state.register('rbp') != (pointer + 8) & MASK64:
            return reject('frame-link')
        try:
            saved_rbx = load_virtual(state, pointer, 8)
            shuffle_frame = load_virtual(state, pointer + 8, 8)
            shuffle_return = load_virtual(state, pointer + 16, 8)
            memory_frame = load_virtual(state, shuffle_frame, 8)
            memory_return = load_virtual(state, shuffle_frame + 8, 8)
            measure_frame = load_virtual(state, memory_frame, 8)
            measure_return = load_virtual(state, memory_frame + 8, 8)
            generator_frame = load_virtual(state, measure_frame, 8)
            generator_return = load_virtual(state, measure_frame + 8, 8)
            caller_frame = load_virtual(state, generator_frame, 8)
            following = load_virtual(state, generator_frame + 8, 8)
        except PageFault:
            return reject('frame-read')

        shuffle = (shuffle_return - 0x4f) & MASK64
        memory_walk = (memory_return - 0x30) & MASK64
        measure = (measure_return - 0x3e) & MASK64
        generator_candidate = (generator_return - 0x50) & MASK64
        startup_candidate = (generator_return - 0xf8) & MASK64
        generator_signature = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 48 83 ec 10 '
            '48 89 7d f8 c7 45 f4 00 00 00 00')
        startup_signature = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 48 83 ec 68')
        try:
            clock = self._relative_call_target(state, shuffle_return)
            delta = self._relative_call_target(state, measure + 0x58)
            stuck_function = self._relative_call_target(
                state, measure + 0x75)
            condition_function = self._relative_call_target(
                state, measure + 0x88)
            if clock is None:
                return reject('clock-target')
            if state.rip != (clock + 0x13) & MASK64:
                return reject('clock-return')
            memory_shuffle_target = self._relative_call_target(
                state, memory_return)
            if memory_shuffle_target != shuffle:
                return reject('memory-shuffle-edge:%x:%x' % (
                    memory_shuffle_target or 0, shuffle))
            if self._relative_call_target(state, measure_return) != memory_walk:
                return reject('measure-memory-edge')
            if self._relative_call_target(state, generator_return) != measure:
                return reject('generator-measure-edge')
            if self._relative_call_target(state, measure + 0x47) != clock:
                return reject('measure-clock-edge')
            if self._relative_call_target(
                    state, stuck_function + 0x26) != delta:
                return reject('stuck-delta-first-edge')
            if self._relative_call_target(
                    state, stuck_function + 0x3b) != delta:
                return reject('stuck-delta-second-edge')
            if (read_virtual(
                    state, generator_candidate, len(generator_signature),
                    'execute') == generator_signature):
                outer_kind = 'generator'
                outer = generator_candidate
                outer_entry = outer
                outer_signature = generator_signature
                health_function = self._relative_call_target(
                    state, outer + 0x35)
            elif (read_virtual(
                    state, startup_candidate + 4, len(startup_signature),
                    'execute') == startup_signature):
                outer_kind = 'startup'
                outer = startup_candidate
                outer_entry = outer + 4
                outer_signature = startup_signature
                health_function = None
            else:
                return reject('outer-signature:%x:%x:%s' % (
                    generator_return, startup_candidate,
                    read_virtual(
                        state, startup_candidate, len(startup_signature) + 4,
                        'execute').hex()))
            apt_function = self._relative_call_target(
                state, stuck_function + 0x66)
            rct_function = self._relative_call_target(
                state, stuck_function + 0x89)
            if (rct_function is None
                    or self._relative_call_target(
                        state, stuck_function + 0x9d) != rct_function):
                return reject('rct-edge')
            hash_function = self._relative_call_target(
                state, condition_function + 0x6f)
        except (PageFault, TypeError):
            return reject('call-graph-read')

        entry_signatures = (
            (outer_kind, outer_entry, outer_signature),
            ('memory-walk', memory_walk, bytes.fromhex(
                '0f 1f 44 00 00 55 48 89 e5 48 83 ec 30 '
                '48 89 7d f8 48 89 75 f0')),
            ('shuffle', shuffle, bytes.fromhex(
                '0f 1f 44 00 00 55 48 89 e5 48 83 ec 30')),
            ('stuck', stuck_function, bytes.fromhex(
                '0f 1f 44 00 00 55 48 89 e5 48 83 ec 28 '
                '48 89 7d f0 48 89 75 e8')),
            ('condition', condition_function, bytes.fromhex(
                '0f 1f 44 00 00 55 48 89 e5 48 83 ec 30')),
            ('apt', apt_function, bytes.fromhex(
                '0f 1f 44 00 00 55 48 89 e5 48 83 ec 10 '
                '48 89 7d f8 89 75 f4')),
            ('rct', rct_function, bytes.fromhex(
                '0f 1f 44 00 00 55 48 89 e5 48 83 ec 10 '
                '48 89 7d f8 89 75 f4')),
        )
        if health_function is not None:
            entry_signatures += (('health', health_function, bytes.fromhex(
                '0f 1f 44 00 00 55 48 89 e5 50 48 89 7d f8 31 c0')),)
        try:
            for name, address, signature in entry_signatures:
                if read_virtual(
                        state, address, len(signature), 'execute') != signature:
                    return reject('entry-signature:' + name)
            if outer_kind == 'generator':
                if (read_virtual(state, outer + 0x57, 0x28, 'execute')
                        != bytes.fromhex(
                            '8b 45 f4 83 c0 01 89 45 f4 8b 4d f0 '
                            '81 c1 00 01 00 00 48 8b 55 f8 '
                            '0f af 4a 24 39 c8 72 02 eb 02 eb b3 '
                            '48 83 c4 10 5d c3')):
                    return reject('generator-tail-signature')
            else:
                if (read_virtual(state, outer + 0xbe, 0x35, 'execute')
                        != bytes.fromhex(
                            'c7 45 c4 00 00 00 00 b8 64 04 00 00 '
                            '3b 45 c4 0f 8e a0 00 00 00 '
                            '48 c7 45 a8 00 00 00 00 '
                            '48 c7 45 a0 00 00 00 00 '
                            '48 c7 45 f0 00 00 00 00 '
                            '48 8b 7d c8 48 8d 75 f0')
                        or read_virtual(
                            state, outer + 0xf8, 0x7b, 'execute')
                        != bytes.fromhex(
                            '48 8b 45 c8 48 8b 40 08 48 89 45 a0 '
                            '48 8b 45 c8 48 8b 40 08 48 2b 45 f0 '
                            '48 89 45 a8 48 83 7d a8 00 74 07 '
                            '48 83 7d a0 00 75 0c '
                            'c7 45 bc 01 00 00 00 e9 83 00 00 00 '
                            '48 83 7d f0 00 74 0a 48 8b 45 a0 '
                            '48 3b 45 a8 75 09 c7 45 bc 02 00 00 00 '
                            'eb 69 83 7d c4 64 7d 02 eb 15 '
                            '48 8b 45 a0 48 3b 45 a8 77 09 '
                            '8b 45 c0 83 c0 01 89 45 c0 eb 00 '
                            '8b 45 c4 83 c0 01 89 45 c4 '
                            'e9 52 ff ff ff')):
                    return reject('startup-loop-signature')
            if read_virtual(
                    state, delta, 26, 'execute') != bytes.fromhex(
                        '55 48 89 e5 48 83 ec 18 48 89 7d f8 '
                        '48 89 75 f0 48 8b 45 f8 48 3b 45 f0 73 0e'):
                return reject('delta-signature')
        except PageFault:
            return reject('signature-read')

        try:
            collector = load_virtual(state, memory_frame - 8, 8)
            if (load_virtual(state, measure_frame - 0x18, 8) != collector
                    or load_virtual(
                        state, generator_frame + (
                            -8 if outer_kind == 'generator' else -0x38),
                        8) != collector
                    or state.register('rbx')
                    != (shuffle_frame - 0x10) & MASK64):
                return reject('collector-frame')
            collector_state = bytearray(
                read_virtual(state, collector, 0x60))
            descriptor = struct.unpack_from('<Q', collector_state, 0)[0]
            previous_time = struct.unpack_from(
                '<Q', collector_state, 0x08)[0]
            last_delta = struct.unpack_from(
                '<Q', collector_state, 0x10)[0]
            last_delta2 = struct.unpack_from(
                '<Q', collector_state, 0x18)[0]
            osr = struct.unpack_from('<I', collector_state, 0x24)[0]
            memory = struct.unpack_from('<Q', collector_state, 0x28)[0]
            location = struct.unpack_from('<I', collector_state, 0x30)[0]
            blocks = struct.unpack_from('<I', collector_state, 0x34)[0]
            block_bytes = struct.unpack_from('<I', collector_state, 0x38)[0]
            base_iterations = struct.unpack_from(
                '<I', collector_state, 0x3c)[0]
            rct_count = struct.unpack_from('<I', collector_state, 0x40)[0]
            apt_cutoff = struct.unpack_from('<I', collector_state, 0x44)[0]
            apt_permanent = struct.unpack_from(
                '<I', collector_state, 0x48)[0]
            apt_observations = struct.unpack_from(
                '<I', collector_state, 0x4c)[0]
            apt_count = struct.unpack_from('<I', collector_state, 0x50)[0]
            apt_base = struct.unpack_from('<I', collector_state, 0x54)[0]
            health = struct.unpack_from('<I', collector_state, 0x58)[0]
            bit_flags = collector_state[0x5c]
            if outer_kind == 'generator':
                count = load_virtual(state, generator_frame - 0x0c, 4)
                safety = load_virtual(state, generator_frame - 0x10, 4)
                startup_failures = None
            else:
                count = load_virtual(state, generator_frame - 0x3c, 4)
                safety = 0
                startup_failures = load_virtual(
                    state, generator_frame - 0x40, 4)

            transform = load_virtual(state, descriptor, 8)
            algorithm = load_virtual(state, transform + 0x20, 8)
            digest_bytes = load_virtual(state, algorithm - 8, 4)
            context_bytes = load_virtual(state, algorithm - 0x10, 4)
            rate_bytes = load_virtual(state, algorithm + 0x24, 4)
            updater = load_virtual(state, algorithm - 0x70, 8)
            finalizer = load_virtual(state, algorithm - 0x60, 8)
            if (not self._is_sponge_mix_function(state, hash_function)
                    or not self._is_sponge_update_function(state, updater)
                    or not self._is_sponge_finalize_function(
                        state, finalizer)
                    or digest_bytes != 32 or rate_bytes != 136
                    or not rate_bytes < context_bytes <= (1 << 20)):
                return reject('sponge-layout')
            lanes = list(struct.unpack(
                '<25Q', read_virtual(state, descriptor + 8, 200)))
            buffered_address = descriptor + 8 + context_bytes - 1
            buffered_bytes = load_virtual(state, buffered_address, 1)
            if buffered_bytes >= rate_bytes:
                return reject('sponge-buffer')
            buffer_address = buffered_address - rate_bytes
            pool = read_virtual(state, buffer_address, buffered_bytes)
            hash_stack = (measure_frame - 0x70) & MASK64
            scratch = ((((hash_stack - 56) & MASK64) & ~0xf)
                       - 0x1d0) & MASK64
            seed_address = (scratch + 0x20) & MASK64
            seed = read_virtual(state, seed_address, digest_bytes)
        except (PageFault, struct.error):
            return reject('collector-read')

        wrap = blocks * block_bytes
        target_count = ((256 + safety) * osr
                        if outer_kind == 'generator' else 0x464)
        if (not collector or not descriptor or not memory
                or not 0 < wrap <= (1 << 20)
                or location >= wrap or not 0 < osr <= 64
                or not count < target_count <= (1 << 14)
                or target_count - count > 4096):
            return reject('recurrence-domain')
        clock_value = dict(state.msrs).get(IA32_TIME_STAMP_COUNTER, 0)
        response_value = ((state.register('rdx') & MASK32) << 32) \
            | (state.register('rax') & MASK32)
        if not clock_value or response_value != clock_value:
            return reject('clock-state')

        total_memory_iterations = 0
        measurements = 0
        extra_clocks = 0
        absorbed_blocks = 0
        sponge_records = []
        shuffle_clock = clock_value
        startup_error = None
        startup_delta = 0
        startup_last_time = 0
        startup_output = 0
        while count < target_count and measurements < 1 << 15:
            folded = 0
            remaining = shuffle_clock
            for _unused in range((64 + 7 - 1) // 7):
                folded ^= remaining & 0x7f
                remaining >>= 7
            total_memory_iterations += base_iterations + folded + 1

            measure_clock = advance_virtual_clock(
                shuffle_clock, clock_step, clock_variation_bits)
            extra_clocks += 1
            prior_time = previous_time
            current_delta = (measure_clock - prior_time) & MASK64
            delta2 = (current_delta - last_delta) & MASK64
            delta3 = (delta2 - last_delta2) & MASK64
            previous_time = measure_clock
            last_delta = current_delta
            last_delta2 = delta2

            masked_delta = current_delta & MASK32
            if not bit_flags & 1:
                apt_base = masked_delta
                bit_flags |= 1
            else:
                if masked_delta == apt_base:
                    apt_count = (apt_count + 1) & MASK32
                    if apt_count >= apt_permanent:
                        health |= 0x20000
                    elif apt_count >= apt_cutoff:
                        health |= 2
                apt_observations = (apt_observations + 1) & MASK32
                if apt_observations >= 512:
                    apt_count = 0
                    apt_base = masked_delta
                    apt_observations = 0

            stuck = not current_delta or not delta2 or not delta3
            if stuck:
                rct_count = (rct_count + 1) & MASK32
                if rct_count >= 60 * osr:
                    rct_count = MASK32
                    health |= 0x10000
                elif rct_count >= 30 * osr:
                    rct_count = MASK32
                    health |= 1
            else:
                rct_count = 0

            additional = struct.pack(
                '<IIII', rct_count, apt_observations,
                apt_count, apt_base)
            sponge_records.append((
                additional, 0 if stuck else current_delta))
            measurements += 1
            if outer_kind == 'generator':
                if not stuck:
                    count += 1
            else:
                startup_output = current_delta
                startup_last_time = measure_clock
                startup_delta = prior_time
                if not startup_delta or not startup_last_time:
                    startup_error = 1
                elif (startup_output
                      and startup_last_time == startup_delta):
                    startup_error = 2
                elif (count >= 100
                      and startup_last_time <= startup_delta):
                    startup_failures = (startup_failures + 1) & MASK32
                if startup_error is None:
                    count += 1
                else:
                    clock_value = measure_clock
                    break
            if count >= target_count:
                clock_value = measure_clock
                break
            shuffle_clock = advance_virtual_clock(
                measure_clock, clock_step, clock_variation_bits)
            extra_clocks += 1
        if count < target_count and startup_error is None:
            return reject('recurrence-limit')

        if self.sponge_records is not None:
            mixed = self.sponge_records(
                tuple(lanes), bytes(pool), bytes(seed),
                tuple(sponge_records), 8, rate_bytes, digest_bytes)
            if (not isinstance(mixed, tuple) or len(mixed) != 2
                    or len(mixed[0]) != 25
                    or len(mixed[1]) >= rate_bytes):
                raise X86Error('sponge record kernel returned an invalid cut')
            lanes = [int(value) & MASK64 for value in mixed[0]]
            pool = bytes(mixed[1])
            absorbed_blocks = (
                (buffered_bytes + measurements * (digest_bytes + 8))
                // rate_bytes)
        else:
            for index, (additional, time_value) in enumerate(sponge_records):
                intermediary = seed if not index else bytes(digest_bytes)
                for _unused in range(8):
                    intermediary = self._sponge_digest(
                        intermediary + additional, rate_bytes, digest_bytes)
                pool += intermediary + struct.pack('<Q', time_value)
                while len(pool) >= rate_bytes:
                    block = pool[:rate_bytes]
                    pool = pool[rate_bytes:]
                    for lane, (word,) in enumerate(
                            struct.iter_unpack('<Q', block)):
                        lanes[lane] ^= word
                    lanes = list(self._keccak_f1600(lanes))
                    absorbed_blocks += 1

        step = (block_bytes - 1) % wrap
        cycle = wrap // gcd(step, wrap) if step else 1
        complete, residual = divmod(total_memory_iterations, cycle)
        increments = []
        coordinate = location
        for index in range(cycle):
            delta = complete + int(index < residual)
            if delta & 0xff:
                increments.append(
                    ((memory + coordinate) & MASK64, delta & 0xff))
            coordinate = (coordinate + step) % wrap
        final_location = (
            location + total_memory_iterations * step) % wrap

        try:
            for address, size in (
                    (collector, 0x60), (descriptor + 8, 200),
                    (buffer_address, len(pool)), (buffered_address, 1),
                    (seed_address, digest_bytes),
                    ((generator_frame - 0x60) & MASK64,
                     0x54 if outer_kind == 'startup' else 0)):
                if size:
                    translate(state, address, 'write')
                    translate(state, address + size - 1, 'write')
            state = increment_virtual_bytes(state, increments)
            struct.pack_into('<Q', collector_state, 0x08, previous_time)
            struct.pack_into('<Q', collector_state, 0x10, last_delta)
            struct.pack_into('<Q', collector_state, 0x18, last_delta2)
            struct.pack_into('<I', collector_state, 0x30, final_location)
            struct.pack_into('<I', collector_state, 0x40, rct_count)
            struct.pack_into('<I', collector_state, 0x4c, apt_observations)
            struct.pack_into('<I', collector_state, 0x50, apt_count)
            struct.pack_into('<I', collector_state, 0x54, apt_base)
            struct.pack_into('<I', collector_state, 0x58, health)
            collector_state[0x5c] = bit_flags
            state = write_virtual(state, collector, collector_state)
            state = write_virtual(
                state, descriptor + 8, struct.pack('<25Q', *lanes))
            state = write_virtual(state, buffer_address, pool)
            state = write_virtual(
                state, buffered_address, bytes((len(pool),)))
            state = fill_virtual(state, seed_address, digest_bytes, 0)
            if outer_kind == 'startup':
                state = write_virtual(
                    state, generator_frame - 0x60,
                    struct.pack('<Q', startup_last_time))
                state = write_virtual(
                    state, generator_frame - 0x58,
                    struct.pack('<Q', startup_delta))
                state = write_virtual(
                    state, generator_frame - 0x10,
                    struct.pack('<Q', startup_output))
                state = write_virtual(
                    state, generator_frame - 0x40,
                    struct.pack('<I', startup_failures))
                state = write_virtual(
                    state, generator_frame - 0x3c,
                    struct.pack('<I', count))
                if startup_error is not None:
                    state = write_virtual(
                        state, generator_frame - 0x44,
                        struct.pack('<I', startup_error))
        except (PageFault, struct.error):
            return reject('cut-write')

        registers = list(state.registers)
        registers[REGISTER_INDEX['rax']] = (
            count if outer_kind == 'generator' else target_count) & MASK32
        registers[REGISTER_INDEX['rbx']] = saved_rbx & MASK64
        if outer_kind == 'generator':
            registers[REGISTER_INDEX['rcx']] = target_count & MASK32
            registers[REGISTER_INDEX['rdx']] = collector & MASK64
            registers[REGISTER_INDEX['rdi']] = collector & MASK64
            registers[REGISTER_INDEX['rbp']] = caller_frame & MASK64
            registers[REGISTER_INDEX['rsp']] = (generator_frame + 16) & MASK64
            output_rip = following & MASK64
        else:
            registers[REGISTER_INDEX['rbp']] = generator_frame & MASK64
            registers[REGISTER_INDEX['rsp']] = (
                generator_frame - 0x68) & MASK64
            output_rip = (outer + (
                0x1b1 if startup_error is not None else 0x173)) & MASK64
        msrs = dict(state.msrs)
        msrs[IA32_TIME_STAMP_COUNTER] = clock_value
        flags = (_result_flags(
                    state.rflags, 'cmp', count, target_count,
                    (count - target_count) & MASK32, 32)
                 if outer_kind == 'generator' else
                 _result_flags(
                    state.rflags, 'cmp', target_count, count,
                    (target_count - count) & MASK32, 32))
        self.collapsed_entropy_measurements += measurements
        self.collapsed_entropy_clock_events += extra_clocks + 1
        self.collapsed_entropy_memory_iterations += total_memory_iterations
        if outer_kind == 'startup':
            self.collapsed_entropy_startup_measurements += measurements
        self.collapsed_wrapped_byte_iterations += total_memory_iterations
        self.collapsed_wrapped_byte_coordinates += len(increments)
        self.collapsed_sponge_mix_calls += measurements
        self.collapsed_sponge_mix_rounds += measurements * 8
        self.collapsed_sponge_absorb_blocks += absorbed_blocks
        self.collapsed_sponge_absorb_bytes += absorbed_blocks * rate_bytes
        return (replace(
                    state, registers=tuple(registers), rip=output_rip,
                    rflags=flags, msrs=tuple(sorted(msrs.items()))),
                extra_clocks)

    def _collapse_sponge_mix_call(self, state, following, target):
        """Compose a barrier-free repeated sponge mix into its pool cut."""
        if not self._is_sponge_mix_function(state, target):
            return None
        descriptor = state.register('rdi') & MASK64
        time_value = state.register('rsi') & MASK64
        additional_address = state.register('rdx') & MASK64
        additional_bytes = state.register('rcx') & MASK32
        rounds = state.register('r8') & MASK64
        stuck = state.register('r9') & MASK32
        if additional_bytes > (1 << 20) or rounds > 64:
            return None
        stack = state.register('rsp') & MASK64
        scratch = (((stack - 56) & MASK64) & ~0xf) - 0x1d0
        seed_address = (scratch + 0x20) & MASK64
        try:
            transform = load_virtual(state, descriptor, 8)
            algorithm = load_virtual(state, transform + 0x20, 8)
            digest_bytes = load_virtual(state, algorithm - 8, 4)
            context_bytes = load_virtual(state, algorithm - 0x10, 4)
            rate_bytes = load_virtual(state, algorithm + 0x24, 4)
            updater = load_virtual(state, algorithm - 0x70, 8)
            finalizer = load_virtual(state, algorithm - 0x60, 8)
            if (digest_bytes != 32 or rate_bytes != 136
                    or not rate_bytes < context_bytes <= (1 << 20)
                    or not self._is_sponge_update_function(state, updater)
                    or not self._is_sponge_finalize_function(
                        state, finalizer)):
                return None
            additional = read_virtual(
                state, additional_address, additional_bytes)
            intermediary = read_virtual(state, seed_address, digest_bytes)
            buffered_address = descriptor + 8 + context_bytes - 1
            buffered_bytes = load_virtual(state, buffered_address, 1)
            buffer_address = buffered_address - rate_bytes
            pool = read_virtual(state, buffer_address, buffered_bytes)
        except PageFault:
            return None

        for _unused in range(rounds):
            intermediary = self._sponge_digest(
                intermediary + additional, rate_bytes, digest_bytes)
        pool += intermediary + struct.pack(
            '<Q', 0 if stuck else time_value)
        absorbed = self._collapse_sponge_absorb(
            state, descriptor, rate_bytes, pool)
        if absorbed is None:
            return None
        state, residual = absorbed
        try:
            state = write_virtual(state, buffer_address, residual)
            state = write_virtual(
                state, buffered_address, bytes((len(residual),)))
            state = fill_virtual(state, seed_address, digest_bytes, 0)
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], 0, 32)
        self.collapsed_sponge_mix_calls += 1
        self.collapsed_sponge_mix_rounds += rounds
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _collapse_hash_init_call(self, state, following, target):
        """Initialize a proved hash context through one physical cut."""
        if not self._is_hash_init_wrapper(state, target):
            return None
        descriptor = state.register('rdi') & MASK64
        try:
            transform = load_virtual(state, descriptor, 8)
            if load_virtual(state, transform + 4, 1) & 1:
                return None
            algorithm = load_virtual(state, transform + 0x20, 8)
            flags = load_virtual(state, algorithm + 0x20, 4)
            context_bytes = load_virtual(state, algorithm - 0x10, 4)
            initializer = load_virtual(state, algorithm - 0x78, 8)
            if (not 200 <= context_bytes <= (1 << 20)
                    or not self._is_sponge_init_function(
                        state, initializer)):
                return None
            state = fill_virtual(state, descriptor + 8, 200, 0)
            if flags & 0x01000000:
                state = write_virtual(
                    state, descriptor + 8 + context_bytes - 1, b'\0')
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], 0, 32)
        self.collapsed_hash_init_calls += 1
        self.collapsed_hash_init_bytes += 200
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _is_hash_stream_wrapper(self, state, target):
        """Recognize a descriptor-driven hash finalization wrapper."""
        target = int(target) & MASK64
        cached = self._hash_stream_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        signature = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 ec 38 '
            '41 89 d5 4c 8b 3f 48 8d 5f 08 49 8b 47 20 '
            '44 8b 70 20 41 f7 c6 00 00 00 01')
        try:
            present = read_virtual(
                state, target, len(signature), 'execute') == signature
        except PageFault:
            present = False
        config, proof = _execution_proof(state, target, len(signature))
        if proof is not None:
            self._hash_stream_functions[target] = (
                config, proof, present)
        else:
            self._hash_stream_functions.pop(target, None)
        return present

    def _profile_hash_stream_miss(self, reason, coordinate=0):
        if self._hash_stream_profile is None:
            return
        key = str(reason), int(coordinate) & MASK64
        self._hash_stream_profile[key] = \
            self._hash_stream_profile.get(key, 0) + 1

    def _collapse_hash_stream_call(self, state, following, target):
        """Compose partial-block update or finalization without a frame."""
        if not self._is_hash_stream_wrapper(state, target):
            return None
        descriptor = state.register('rdi') & MASK64
        source = state.register('rsi') & MASK64
        count = state.register('rdx') & MASK32
        output_address = state.register('rcx') & MASK64
        try:
            transform = load_virtual(state, descriptor, 8)
            algorithm = load_virtual(state, transform + 0x20, 8)
            flags = load_virtual(state, algorithm + 0x20, 4)
            context_bytes = load_virtual(state, algorithm - 0x10, 4)
            rate_bytes = load_virtual(state, algorithm + 0x24, 4)
            finalizer = load_virtual(state, algorithm - 0x60, 8)
            updater = load_virtual(state, algorithm - 0x70, 8)
            if not flags & 0x01000000:
                self._profile_hash_stream_miss(
                    'streaming', finalizer)
                return None
            if (not 0 < context_bytes <= (1 << 20)
                    or not 0 < rate_bytes <= min(context_bytes, 0xff)):
                self._profile_hash_stream_miss(
                    'metadata', finalizer)
                return None
            buffered_address = descriptor + 8 + context_bytes - 1
            buffered_bytes = load_virtual(state, buffered_address, 1)
            finup_max = bool(flags & 0x04000000)
            final_nonzero = int(bool(flags & 0x02000000))
            buffer_address = buffered_address - rate_bytes
            if count > (1 << 20):
                self._profile_hash_stream_miss(
                    'input_extent', updater)
                return None
            payload = (read_virtual(
                state, buffer_address, buffered_bytes)
                + read_virtual(state, source, count))
            requires_update = (
                len(payload) >= rate_bytes + final_nonzero
                and not (output_address and finup_max
                         and not buffered_bytes))
            if requires_update:
                if (final_nonzero
                        or not self._is_sponge_update_function(
                            state, updater)):
                    self._profile_hash_stream_miss(
                        'unsupported_update', updater)
                    return None
                absorbed = self._collapse_sponge_absorb(
                    state, descriptor, rate_bytes, payload)
                if absorbed is None:
                    return None
                state, payload = absorbed
            if not output_address:
                state = write_virtual(
                    state, buffer_address, payload)
                state = write_virtual(
                    state, buffered_address,
                    bytes((len(payload),)))
                registers = _write_register(
                    state.registers, REGISTER_INDEX['rax'], 0, 32)
                self.collapsed_hash_update_calls += 1
                self.collapsed_hash_update_bytes += count
                return replace(state, registers=registers,
                               rip=following & MASK64)
        except PageFault:
            return None
        state = self._collapse_sponge_finalize_payload(
            state, following, finalizer, descriptor, payload,
            output_address)
        if state is None:
            self._profile_hash_stream_miss(
                'unsupported_finalizer', finalizer)
            return None
        try:
            state = fill_virtual(
                state, descriptor + 8, context_bytes, 0)
        except PageFault:
            return None
        self.collapsed_hash_finalize_calls += 1
        self.collapsed_hash_context_bytes += context_bytes
        return state

    def _memory_fill_core(self, state, target):
        """Resolve a direct jump wrapper to a byte-fill implementation."""
        target = int(target) & MASK64
        cached = self._memory_fill_functions.get(target)
        if cached is not None:
            config, proof, core = cached
            if _proof_mismatch(state, config, proof) is None:
                return core
        core = None
        addresses = [target]
        signature = bytes.fromhex(
            '49 89 fa 40 0f b6 ce 48 b8 01 01 01 01 01 01 01 01 '
            '48 0f af c1 41 89 f9 41 83 e1 07 75 74')
        try:
            entry = read_virtual(state, target, 16, 'execute')
            candidate = target
            if entry[:5] == bytes.fromhex('f3 0f 1e fa eb'):
                candidate = (target + 6
                             + int.from_bytes(entry[5:6], 'little',
                                              signed=True)) & MASK64
                addresses.append(candidate)
            if read_virtual(
                    state, candidate, len(signature),
                    'execute') == signature:
                core = candidate
        except PageFault:
            pass
        config = None
        proof = ()
        for address in addresses:
            extent = 16 if address == target and len(addresses) > 1 \
                else len(signature)
            current_config, current_proof = _execution_proof(
                state, address, extent)
            if (current_proof is None
                    or (config is not None and current_config != config)):
                proof = None
                break
            config = current_config
            proof += current_proof
        if proof is not None:
            self._memory_fill_functions[target] = config, proof, core
        else:
            self._memory_fill_functions.pop(target, None)
        return core

    def _collapse_memory_fill_call(self, state, following, target):
        """Compose a proved byte-fill ABI call into one physical state cut."""
        count = state.register('rdx') & MASK64
        if count > (1 << 30) or self._memory_fill_core(
                state, target) is None:
            return None
        destination = state.register('rdi') & MASK64
        value = state.register('rsi') & 0xff
        try:
            state = fill_virtual(state, destination, count, value)
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], destination, 64)
        self.collapsed_memory_fill_calls += 1
        self.collapsed_memory_fill_call_bytes += count
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _memory_copy_core(self, state, target):
        """Resolve a direct jump wrapper to the standard x86 copy core."""
        target = int(target) & MASK64
        cached = self._memory_copy_functions.get(target)
        if cached is not None:
            config, proof, core = cached
            if _proof_mismatch(state, config, proof) is None:
                return core
        core = None
        addresses = [target]
        signature_extent = 18
        try:
            entry = read_virtual(state, target, 16, 'execute')
            candidate = target
            if entry[:5] == bytes.fromhex('f3 0f 1e fa eb'):
                candidate = (target + 6
                             + int.from_bytes(entry[5:6], 'little',
                                              signed=True)) & MASK64
                addresses.append(candidate)
            signature = read_virtual(
                state, candidate, 31, 'execute')
            if signature[:18] == bytes.fromhex(
                    '48 89 f8 48 83 fa 20 72 7e 40 38 fe 7c 35 '
                    '48 83 ea 20'):
                core = candidate
            elif (signature[:4] in (
                    bytes.fromhex('f3 0f 1e fa'),
                    bytes.fromhex('0f 1f 40 d6'))
                    and signature[4:31] == bytes.fromhex(
                    '48 89 f8 48 39 fe 7d 0f 49 89 f0 49 01 d0 '
                    '49 39 f8 0f 8f b5 00 00 00 48 83 fa 20')):
                core = candidate
                signature_extent = 31
        except PageFault:
            pass
        config = None
        proof = ()
        for address in addresses:
            extent = (16 if address == target and len(addresses) > 1
                      else signature_extent)
            current_config, current_proof = _execution_proof(
                state, address, extent)
            if current_proof is None \
                    or (config is not None and current_config != config):
                proof = None
                break
            config = current_config
            proof += current_proof
        if proof is not None:
            self._memory_copy_functions[target] = config, proof, core
        else:
            self._memory_copy_functions.pop(target, None)
        return core

    def _is_void_memory_copy_function(self, state, target):
        """Prove a feature-gated copy whose ABI has no return value."""
        target = int(target) & MASK64
        cached = self._void_memory_copy_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present

        reader = _VirtualProofReader(state)
        present = False
        try:
            code = reader.read(target, 0xc0)
            current = (
                code[:9] == bytes.fromhex(
                    'f3 0f 1e fa 0f 1f 44 00 00')
                and code[9:0x20] == bytes.fromhex(
                    '55 48 89 e5 41 57 41 56 53 48 89 d3 '
                    '49 89 f7 49 89 fe bf 04 00 00 00')
                and code[0x20] == 0xe8
                and code[0x25:0x29] == bytes.fromhex('84 c0 74 20')
                and code[0x35:0x49] == bytes.fromhex(
                    '41 8a 14 0f 41 88 14 0e 48 63 c8 ff c0 '
                    '48 39 cb 77 ee eb 35')
                and code[0x62:0x71] == bytes.fromhex(
                    '48 89 d9 48 c1 e9 02 4c 89 fe 4c 89 f7 f3 a5')
                and code[0x71:0x80] == bytes.fromhex(
                    'f6 c3 02 74 02 66 a5 f6 c3 01 74 01 a4 5b 41'))
            if current:
                feature = (target + 0x25 + _signed_integer(
                    int.from_bytes(code[0x21:0x25], 'little'), 32)) & MASK64
            elif (code[:4] not in (
                    bytes.fromhex('f3 0f 1e fa'),
                    bytes.fromhex('0f 1f 40 d6'))
                    or code[4] != 0xe8
                    or code[9:33] != _VOID_COPY_ARGUMENTS
                    or _VOID_COPY_BYTE_LOOP not in code
                    or _VOID_COPY_REP not in code):
                raise ValueError('not a feature-gated memory copy')
            else:
                feature = (target + 37 + _signed_integer(
                    int.from_bytes(code[33:37], 'little'), 32)) & MASK64
            feature_code = reader.read(feature, 64)
            if current:
                if (feature_code[:10] != bytes.fromhex(
                        'f3 0f 1e fa 55 48 89 e5 8b 05')
                        or feature_code[14:32] != bytes.fromhex(
                            '83 f8 02 74 11 83 f8 01 75 18 e8 33 00 00 00 '
                            '5d 2e e9')):
                    raise ValueError('copy feature selector changed')
                feature_state = (feature + 14 + _signed_integer(
                    int.from_bytes(feature_code[10:14], 'little'), 32)) \
                    & MASK64
            else:
                if (feature_code[:5] != bytes.fromhex('f3 0f 1e fa 55')
                        or feature_code[5:7] != b'\x8b\x05'
                        or bytes.fromhex(
                            '83 f8 01 74 18 83 f8 02 74 08 31 c0 5d e9')
                        not in feature_code):
                    raise ValueError('copy feature selector changed')
                feature_state = (feature + 11 + _signed_integer(
                    int.from_bytes(feature_code[7:11], 'little'), 32)) \
                    & MASK64
            present = reader.load(feature_state, 4) == 0
        except (PageFault, ValueError):
            pass
        config, proof = reader.proof()
        self._void_memory_copy_functions[target] = config, proof, present
        return present

    def _collapse_void_memory_copy_call(self, state, following, target):
        """Copy a proved byte extent while preserving the void-call result."""
        count = state.register('rdx') & MASK64
        if (count > (1 << 30)
                or not self._is_void_memory_copy_function(state, target)):
            return None
        source = state.register('rsi') & MASK64
        destination = state.register('rdi') & MASK64
        try:
            state = copy_virtual(state, source, destination, count)
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], 0, 64)
        self.collapsed_void_memory_copy_calls += 1
        self.collapsed_void_memory_copy_bytes += count
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    def _collapse_memory_copy_call(self, state, following, target):
        """Compose a proved memcpy ABI call into one physical memory copy."""
        count = state.register('rdx') & MASK64
        if count > (1 << 30):
            return None
        if self._memory_copy_core(state, target) is None:
            return None
        source = state.register('rsi') & MASK64
        destination = state.register('rdi') & MASK64
        try:
            state = copy_virtual(state, source, destination, count)
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], destination, 64)
        self.collapsed_memory_copy_calls += 1
        self.collapsed_memory_copy_call_bytes += count
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _static_call_table_layout(self, state, target):
        """Prove the boot-time sorted relative call-site table."""
        target = int(target) & MASK64
        cached = self._static_call_table_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout

        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = reader.read(target, 0x2a2)
            current = (
                code[:5] == _STATIC_CALL_NOP5
                and code[5:0x16] == bytes.fromhex(
                    '55 48 89 e5 41 57 41 56 41 55 41 54 53 '
                    '48 83 ec 38')
                and code[0x3e:0x41] == bytes.fromhex('48 c7 c1')
                and code[0x49:0x4c] == bytes.fromhex('49 c7 c0')
                and code[0x50] == 0xe8
                and code[0xbe] == 0xe8
                and code[0x175:0x178] == bytes.fromhex('48 81 ff')
                and code[0x183:0x186] == bytes.fromhex('48 81 f9')
                and code[0x290:0x2a1] == bytes.fromhex(
                    '44 89 e8 48 83 c4 38 5b 41 5c 41 5d 41 5e 41 5f 5d'))
            if current:
                compare = _signed_integer(
                    int.from_bytes(code[0x41:0x45], 'little'), 32) & MASK64
                swap = _signed_integer(
                    int.from_bytes(code[0x4c:0x50], 'little'), 32) & MASK64
                sort = (target + 0x55 + _signed_integer(
                    int.from_bytes(code[0x51:0x55], 'little'), 32)) & MASK64
                wrapper = (target + 0xc3 + _signed_integer(
                    int.from_bytes(code[0xbf:0xc3], 'little'), 32)) & MASK64
                range_start = _signed_integer(
                    int.from_bytes(code[0x178:0x17c], 'little'), 32) & MASK64
                range_end = _signed_integer(
                    int.from_bytes(code[0x186:0x18a], 'little'), 32) & MASK64
            else:
                range_shape = bytearray(code[0x15f:0x198])
                range_start = _signed_integer(
                    int.from_bytes(range_shape[3:7], 'little'), 32) & MASK64
                range_end = _signed_integer(
                    int.from_bytes(range_shape[19:23], 'little'), 32) & MASK64
                range_shape[3:7] = b'\0' * 4
                range_shape[19:23] = b'\0' * 4
                if (code[0] != 0xe8
                        or code[5:0x32] != _STATIC_CALL_TABLE_PREFIX
                        or code[0x32:0x35] != bytes.fromhex('49 c7 c0')
                        or code[0x39:0x3c] != bytes.fromhex('48 c7 c1')
                        or code[0x40:0x4d] != bytes.fromhex(
                            '4c 89 ff 4c 89 f6 4c 29 fe 48 c1 fe 03')
                        or code[0x4d] != 0xe8
                        or code[0x52:0x75] != _STATIC_CALL_TABLE_ENTRY
                        or bytes(range_shape) != _STATIC_CALL_TABLE_RANGE
                        or code[0x198:0x1ad] != _STATIC_CALL_TABLE_PATCH
                        or code[0x1b1:0x1ce] != _STATIC_CALL_TABLE_FINISH
                        or code[0x1ce] != 0xe9
                        or code[0x1d3:0x1f0]
                        != _STATIC_CALL_TABLE_MARK_INSIDE
                        or code[0x1f0:0x204]
                        != _STATIC_CALL_TABLE_MARK_AFTER):
                    raise ValueError(
                        'not a sorted relative call-site table')

                entry = (target + 5 + _signed_integer(
                    int.from_bytes(code[1:5], 'little'), 32)) & MASK64
                entry_code = reader.read(
                    entry, len(_ENTRY_NOP_PREFIX) + 4)
                if not entry_code.startswith(_ENTRY_NOP_PREFIX):
                    raise ValueError('call-site table entry hook is active')
                entry_return = (
                    entry + len(entry_code) + _signed_integer(
                        int.from_bytes(entry_code[-4:], 'little'), 32)) \
                    & MASK64
                if reader.read(entry_return, 1) != b'\xc3':
                    raise ValueError(
                        'call-site table entry hook does not return')

                return_thunk = (target + 0x1d3 + _signed_integer(
                    int.from_bytes(code[0x1cf:0x1d3], 'little'), 32)) \
                    & MASK64
                if reader.read(return_thunk, 1) != b'\xc3':
                    raise ValueError('call-site table return path changed')

                swap = _signed_integer(
                    int.from_bytes(code[0x35:0x39], 'little'), 32) & MASK64
                compare = _signed_integer(
                    int.from_bytes(code[0x3c:0x40], 'little'), 32) & MASK64
                sort = (target + 0x52 + _signed_integer(
                    int.from_bytes(code[0x4e:0x52], 'little'), 32)) & MASK64
                wrapper = (target + 0x1b1 + _signed_integer(
                    int.from_bytes(code[0x1ad:0x1b1], 'little'), 32)) \
                    & MASK64

            if (not self._code_contains_recipe(
                    state, sort,
                    (_SORT_WRAPPER_CORE, _SORT_WRAPPER_DIRECT_CORE))
                    or self._record_sort_spec(
                        state, 8, compare, swap) != ('relative32x2', 1)):
                raise ValueError('call-site table sort changed')
            reader.read(sort, 96)
            reader.read(compare, 96)
            reader.read(swap, 96)
            return_zero = self._static_call_transform_layout(state, wrapper)
            transform_proof = self._static_call_transform_functions.get(
                wrapper)
            if (return_zero is None or transform_proof is None
                    or not reader.absorb(
                        transform_proof[0], transform_proof[1])):
                raise ValueError('call-site transformer changed')
            layout = (range_start, range_end, return_zero)
        except (PageFault, ValueError):
            pass
        config, proof = reader.proof()
        self._static_call_table_functions[target] = config, proof, layout
        return layout

    def _collapse_static_call_table(self, state, following, target):
        """Sort, link, and patch one proved relative call-site table."""
        layout = self._static_call_table_layout(state, target)
        if layout is None or state.register('rdi'):
            return None
        range_start, range_end, return_zero = layout
        start = state.register('rsi') & MASK64
        end = state.register('rdx') & MASK64
        if end < start or (end - start) & 7 or end - start > (1 << 24):
            return None
        count = (end - start) // 8
        if not count:
            registers = _write_register(
                state.registers, REGISTER_INDEX['rax'], 0, 32)
            self.collapsed_static_call_tables += 1
            return replace(state, registers=registers,
                           rip=int(following) & MASK64)

        reader = _VirtualProofReader(state)
        try:
            raw = reader.read(start, count * 8)
            records = []
            for index, (first, second) in enumerate(
                    struct.iter_unpack('<II', raw)):
                slot = (start + index * 8) & MASK64
                site = (slot + _signed_integer(first, 32)) & MASK64
                key_flags = (
                    slot + 4 + _signed_integer(second, 32)) & MASK64
                records.append((key_flags & ~3, site, key_flags))
        except (PageFault, struct.error):
            return None
        order = _radix_record_order(records, 1)

        output = bytearray()
        key_updates = []
        code_updates = []
        changed_code = 0
        prior_key = None
        for destination, source in enumerate(order):
            _sort_key, site, key_flags = records[source]
            slot = (start + destination * 8) & MASK64
            if (site >= range_start
                    and ((site + 1) & MASK64) <= range_end):
                key_flags |= 2
            key = key_flags & ~3
            try:
                if key != prior_key:
                    function = reader.load(key, 8)
                    reader.load((key + 8) & MASK64, 8)
                    key_updates.append((
                        (key + 8) & MASK64,
                        struct.pack('<Q', slot | 1)))
                    prior_key = key
                patch = self._static_call_patch(
                    state, return_zero, site, 0, function, key_flags & 1)
            except PageFault:
                return None
            if patch is None:
                return None
            address, current, payload = patch
            if current != payload:
                code_updates.append((address, payload))
                changed_code += 1
            output.extend(struct.pack(
                '<II', (site - slot) & MASK32,
                (key_flags - slot - 4) & MASK32))

        try:
            state = write_virtual(state, start, output)
            for address, payload in key_updates:
                state = write_virtual(state, address, payload)
            state = self._patch_code_batch(state, code_updates)
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], 0, 32)
        self.collapsed_record_sorts += 1
        self.collapsed_sort_records += count
        self.collapsed_sort_passes += 8
        self.collapsed_entry_nop_calls += 1
        self.collapsed_static_call_transforms += count
        self.collapsed_static_call_bytes += changed_code * 5
        self.collapsed_static_call_tables += 1
        self.collapsed_static_call_table_records += count
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    def _static_call_transform_layout(self, state, target):
        """Prove the boot-time five-byte static-call transformation."""
        target = int(target) & MASK64
        cached = self._static_call_transform_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout

        reader = _VirtualProofReader(state)
        layout = None
        try:
            wrapper = reader.read(target, 0xa0)
            current = (
                wrapper[:9] == bytes.fromhex(
                    'f3 0f 1e fa 0f 1f 44 00 00')
                and wrapper[9:0x20] == bytes.fromhex(
                    '55 48 89 e5 41 57 41 56 41 54 53 41 89 cc '
                    '48 89 d3 49 89 f7 49 89 fe')
                and wrapper[0x27] == 0xe8
                and wrapper[0x4d] == 0xe8
                and wrapper[0x86] == 0xe8
                and wrapper[0x92] == 0xe8)
            if not current and (
                    wrapper[:4] not in (
                        bytes.fromhex('f3 0f 1e fa'),
                        bytes.fromhex('0f 1f 40 d6'))
                    or wrapper[4] != 0xe8
                    or wrapper[9:23] != _STATIC_CALL_WRAPPER_ARGUMENTS
                    or _STATIC_CALL_WRAPPER_SITE not in wrapper
                    or _STATIC_CALL_WRAPPER_TYPE not in wrapper
                    or wrapper[0x86] != 0xe8):
                raise ValueError('not a static-call wrapper')
            transform = (target + 0x8b + _signed_integer(
                int.from_bytes(wrapper[0x87:0x8b], 'little'), 32)) & MASK64
            code = reader.read(transform, 0x1b1)
            current_transform = (
                code[:5] == _STATIC_CALL_NOP5
                and code[5:0x16] == bytes.fromhex(
                    '55 48 89 e5 41 57 41 56 41 55 41 54 53 '
                    '48 83 ec 10')
                and code[0x8c] == 0xe8
                and code[0xb3:0xb5] == b'\x48\x3d'
                and code[0x152] == 0xe8
                and code[0x160:0x162] == b'\x83\x3d'
                and code[0x185] == 0xe8)
            if current_transform:
                return_zero = _signed_integer(
                    int.from_bytes(code[0xb5:0xb9], 'little'), 32) & MASK64
                if reader.read(return_zero, 15) != bytes.fromhex(
                        'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 31 c0'):
                    raise ValueError('return-zero implementation changed')
                if code[0xff:0x102] != bytes.fromhex('4c 8b 3d'):
                    raise ValueError('five-byte no-op source changed')
                nop_pointer = (transform + 0x106 + _signed_integer(
                    int.from_bytes(code[0x102:0x106], 'little'), 32)) \
                    & MASK64
                nop_address = reader.load(nop_pointer, 8) & MASK64
                if reader.read(nop_address, 5) != _STATIC_CALL_NOP5:
                    raise ValueError('five-byte no-op encoding changed')
                system_state = (transform + 0x167 + _signed_integer(
                    int.from_bytes(code[0x162:0x166], 'little'), 32)) \
                    & MASK64
                if reader.load(system_state, 4):
                    raise ValueError('concurrent text patching is active')
                layout = return_zero
            else:
                if (code[0] != 0xe8
                        or code[5:27] != bytes.fromhex(
                            '55 48 89 d0 48 89 e5 41 57 41 56 41 55 41 54 '
                            '41 89 cc 53 48 89 fb')
                        or bytes.fromhex(
                            '8d 56 fe 83 fa 01 76 50 83 fe 01') not in code
                        or code[0x56] != 0xe8
                        or code[0x6b:0x6d] != b'\x48\x3d'
                        or code[0x49:0x4c] != b'\x49\xc7\xc5'
                        or code[0xd1:0xd3] != b'\x8b\x05'
                        or code[0x127:0x12a] != b'\x4c\x8b\x2d'):
                    raise ValueError('not a five-byte call transformer')

                translator = (transform + 0x5b + _signed_integer(
                    int.from_bytes(code[0x57:0x5b], 'little'), 32)) & MASK64
                translator_code = reader.read(translator, 0x93)
                if (translator_code[:4] != bytes.fromhex('f3 0f 1e fa')
                        or translator_code[9] != 0x55
                        or translator_code[10:12] != b'\x80\x3d'
                        or translator_code[16] != 0):
                    raise ValueError(
                        'call destination is not directly gated')
                translator_gate = (translator + 17 + _signed_integer(
                    int.from_bytes(translator_code[12:16], 'little'), 32)) \
                    & MASK64
                if reader.load(translator_gate, 1):
                    raise ValueError(
                        'call destination translation is active')

                system_state = (transform + 0xd7 + _signed_integer(
                    int.from_bytes(code[0xd3:0xd7], 'little'), 32)) & MASK64
                if reader.load(system_state, 4):
                    raise ValueError('concurrent text patching is active')

                zero_address = _signed_integer(
                    int.from_bytes(code[0x4c:0x50], 'little'), 32) & MASK64
                if reader.read(zero_address, 5) != _STATIC_CALL_ZERO5:
                    raise ValueError('return-zero encoding changed')
                nop_pointer = (transform + 0x12e + _signed_integer(
                    int.from_bytes(code[0x12a:0x12e], 'little'), 32)) \
                    & MASK64
                nop_address = reader.load(nop_pointer, 8) & MASK64
                if reader.read(nop_address, 5) != _STATIC_CALL_NOP5:
                    raise ValueError('five-byte no-op encoding changed')

                return_zero = _signed_integer(
                    int.from_bytes(code[0x6d:0x71], 'little'), 32) & MASK64
                layout = return_zero
        except (PageFault, ValueError):
            pass
        config, proof = reader.proof()
        self._static_call_transform_functions[target] = (
            config, proof, layout)
        return layout

    @staticmethod
    def _static_call_patch(state, return_zero, site, trampoline,
                           function, tail):
        """Derive one five-byte patch after the transformer is proved."""
        site = int(site) & MASK64
        trampoline = int(trampoline) & MASK64
        function = int(function) & MASK64
        tail = int(tail) & 0xff
        if bool(site) == bool(trampoline):
            return None
        if site:
            if tail:
                return None
            try:
                current = read_virtual(state, site, 5, 'execute')
            except PageFault:
                return None
            if (current[:1] != b'\xe8'
                    and current not in (_STATIC_CALL_NOP5,
                                        _STATIC_CALL_ZERO5,
                                        _STATIC_CALL_WARN5)):
                return None
            address = site
            if not function:
                payload = _STATIC_CALL_NOP5
            elif function == return_zero:
                payload = _STATIC_CALL_ZERO5
            else:
                displacement = function - ((site + 5) & MASK64)
                if displacement >= 1 << 63:
                    displacement -= 1 << 64
                if not -(1 << 31) <= displacement < (1 << 31):
                    return None
                payload = b'\xe8' + struct.pack('<i', displacement)
        else:
            if not function:
                return None
            try:
                current_trampoline = read_virtual(
                    state, trampoline, 8, 'execute')
            except PageFault:
                return None
            if (current_trampoline[0] not in (0xc3, 0xe9)
                    or current_trampoline[5:] != b'\x0f\xb9\xcc'):
                return None
            current = current_trampoline[:5]
            address = trampoline
            displacement = function - ((trampoline + 5) & MASK64)
            if displacement >= 1 << 63:
                displacement -= 1 << 64
            if not -(1 << 31) <= displacement < (1 << 31):
                return None
            payload = b'\xe9' + struct.pack('<i', displacement)
        return address, current, payload

    def _collapse_static_call_transform(self, state, following, target):
        """Publish one proved inline call-site encoding without wrappers."""
        return_zero = self._static_call_transform_layout(state, target)
        if return_zero is None:
            return None
        site = state.register('rdi') & MASK64
        trampoline = state.register('rsi') & MASK64
        function = state.register('rdx') & MASK64
        tail = state.register('rcx') & 0xff
        patch = self._static_call_patch(
            state, return_zero, site, trampoline, function, tail)
        if patch is None:
            return None
        address, current, payload = patch
        if current != payload:
            try:
                state = self._patch_code_batch(
                    state, ((address, payload),))
            except PageFault:
                return None
            self.collapsed_static_call_bytes += 5
        self.collapsed_static_call_transforms += 1
        return replace(state, rip=int(following) & MASK64)

    def _is_direct_text_patch_function(self, state, target):
        """Recognize a text-patch ABI guarded by write-protect handling."""
        target = int(target) & MASK64
        cached = self._text_patch_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        present = False
        try:
            code = read_virtual(state, target, 43, 'execute')
            present = (
                code[:4] in (bytes.fromhex('f3 0f 1e fa'),
                             bytes.fromhex('0f 1f 40 d6'))
                and code[4:18] == bytes.fromhex(
                    '0f 1f 44 00 00 55 48 89 e5 41 57 41 56 53')
                and code[18:22] == bytes.fromhex('48 0f ba 25')
                and code[26:39] == bytes.fromhex(
                    '34 73 22 48 89 fb 49 89 d6 49 89 f7 e8'))
        except PageFault:
            pass
        config, proof = _execution_proof(state, target, 43)
        if proof is not None:
            self._text_patch_functions[target] = config, proof, present
        else:
            self._text_patch_functions.pop(target, None)
        return present

    def _collapse_text_patch_call(self, state, following, target):
        """Join a proved executable-page patch directly to byte SSA."""
        count = state.register('rdx') & MASK64
        if not 1 <= count <= 256 \
                or not self._is_direct_text_patch_function(state, target):
            return None
        destination = state.register('rdi') & MASK64
        source = state.register('rsi') & MASK64
        try:
            read_virtual(state, destination, count, 'execute')
            payload = read_virtual(state, source, count)
            state = self._patch_code_batch(
                state, ((destination, payload),))
        except PageFault:
            return None
        self.collapsed_text_patch_calls += 1
        self.collapsed_text_patch_bytes += count
        return replace(state, rip=following & MASK64)

    def _is_seal_directory_function(self, state, target):
        """Recognize a relative-record directory that seals entry markers."""
        target = int(target) & MASK64
        cached = self._seal_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        signature = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
            '41 57 41 56 41 55 41 54 53 48 83 ec 10')
        try:
            present = read_virtual(
                state, target, len(signature), 'execute') == signature
        except PageFault:
            present = False
        config, proof = _execution_proof(state, target, len(signature))
        if proof is not None:
            self._seal_functions[target] = config, proof, present
        else:
            self._seal_functions.pop(target, None)
        return present

    def _collapse_seal_directory_call(self, state, following, target):
        """Apply a proved relative code-marker directory in one memory cut."""
        if not self._is_seal_directory_function(state, target):
            return None
        start = state.register('rdi') & MASK64
        end = state.register('rsi') & MASK64
        if end < start or (end - start) % 4 \
                or end - start > (1 << 22):
            return None
        count = (end - start) // 4
        try:
            records = read_virtual(state, start, count * 4)
            patches = []
            for index, (relative,) in enumerate(
                    struct.iter_unpack('<i', records)):
                coordinate = (start + index * 4 + relative) & MASK64
                physical = translate(state, coordinate, 'execute')
                if physical & (PAGE_BYTES - 1) > PAGE_BYTES - 4:
                    value = int.from_bytes(
                        read_virtual(state, coordinate, 4, 'execute'),
                        'little')
                    physical = None
                else:
                    memory = state.memory
                    value = (memory.load(physical, 4)
                             if isinstance(memory, MemoryCut)
                             else int.from_bytes(
                                 memory.read(physical, 4), 'little'))
                if (value != 0xd6401f0f
                        and value & 0xfeffffff != 0xfa1e0ff3):
                    return None
                patches.append((coordinate, physical))
        except (PageFault, struct.error):
            return None

        payload = bytes.fromhex('0f 1f 40 d6')
        cut = state.memory if isinstance(state.memory, MemoryCut) \
            else MemoryCut(state.memory)
        code_pages = set()
        for coordinate, physical in patches:
            if physical is None:
                patch_state = replace(state, memory=cut)
                patch_virtual(patch_state, coordinate, payload)
                code_pages.update(self._code_page_indices(
                    patch_state, coordinate, len(payload)))
            else:
                cut.write(physical, payload)
                code_pages.add(physical // PHYSICAL_PAGE_BYTES)
        if not isinstance(state.memory, MemoryCut):
            state = replace(state, memory=cut.commit())
        self._invalidate_code_pages(code_pages)
        self.collapsed_seal_records += count
        self.collapsed_seal_bytes += count * 4
        return replace(state, rip=following & MASK64)

    def _is_length_function(self, state, target):
        target = int(target) & MASK64
        cached = self._length_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        signature = bytes.fromhex(
            'f3 0f 1e fa 55 48 89 e5 48 c7 c0 ff ff ff ff '
            '80 7c 07 01 00')
        try:
            present = read_virtual(
                state, target, len(signature), 'execute') == signature
        except PageFault:
            present = False
        config, proof = _execution_proof(state, target, len(signature))
        if proof is not None:
            self._length_functions[target] = config, proof, present
        return present

    def _is_string_compare_function(self, state, target):
        """Recognize the complete compiler-shaped byte string comparator."""
        target = int(target) & MASK64
        cached = self._string_compare_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        extent = 0x37
        present = False
        try:
            code = read_virtual(state, target, extent, 'execute')
            present = (
                code[:4] in (
                    bytes.fromhex('f3 0f 1e fa'),
                    bytes.fromhex('0f 1f 40 d6'))
                and code[4:0x1d] == bytes.fromhex(
                    '55 48 89 e5 31 c0 '
                    '0f b6 0c 07 3a 0c 06 75 10 48 ff c0 '
                    '84 c9 75 f0 31 c0 5d')
                and (code[0x1d:0x1f] == b'\x2e\xe9'
                     or code[0x1d] == 0xc3)
                and code[0x23:0x31] == bytes.fromhex(
                    '0f 93 c0 0f b6 c0 8d 04 45 ff ff ff ff 5d')
                and (code[0x31:0x33] == b'\x2e\xe9'
                     or code[0x31] == 0xc3))
        except PageFault:
            code = None
        if self._string_compare_profile is not None and not present:
            key = target, (None if code is None else code.hex())
            self._string_compare_profile[key] = (
                self._string_compare_profile.get(key, 0) + 1)
        config, proof = _execution_proof(state, target, extent)
        if proof is not None:
            self._string_compare_functions[target] = \
                config, proof, present
        return present

    def _is_bounded_string_compare_function(self, state, target):
        """Prove a standard unsigned byte comparison with a length bound."""
        target = int(target) & MASK64
        cached = self._bounded_string_compare_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        reader = _VirtualProofReader(state)
        present = False
        try:
            code = reader.read(target, 0x34)
            entry = code[:4] in (
                bytes.fromhex('f3 0f 1e fa'),
                bytes.fromhex('0f 1f 40 d6'))
            first_return = (target + 0x2d + _signed_integer(
                int.from_bytes(code[0x29:0x2d], 'little'), 32)) & MASK64
            second_return = (target + 0x34 + _signed_integer(
                int.from_bytes(code[0x30:0x34], 'little'), 32)) & MASK64
            legacy = (
                entry
                and code[4:0x28] == _BOUNDED_STRING_COMPARE_BODY
                and code[0x28] == 0xe9
                and code[0x2d:0x30] == bytes.fromhex('31 c0 e9')
                and first_return == second_return
                and reader.read(first_return, 1) == b'\xc3')
            if legacy:
                present = True
            else:
                code = reader.read(target, 0x51)
                direct_returns = tuple(
                    (target + following + _signed_integer(
                        int.from_bytes(
                            code[operand:following], 'little'), 32))
                    & MASK64
                    for operand, following in (
                        (0x30, 0x34), (0x39, 0x3d), (0x4d, 0x51)))
                present = (
                    entry
                    and code[4:0x2d] == _BOUNDED_STRING_COMPARE_DIRECT
                    and code[0x2d:0x30] == bytes.fromhex('5d 2e e9')
                    and code[0x34:0x39] == bytes.fromhex(
                        '31 c0 5d 2e e9')
                    and code[0x3d:0x4d] == bytes.fromhex(
                        '0f 93 c0 0f b6 c0 8d 04 45 ff ff ff ff '
                        '5d 2e e9')
                    and direct_returns[0] == direct_returns[1]
                    and direct_returns[1] == direct_returns[2]
                    and reader.read(direct_returns[0], 1) == b'\xc3')
        except PageFault:
            pass
        config, proof = reader.proof()
        self._bounded_string_compare_functions[target] = (
            config, proof, present)
        return present

    def _collapse_bounded_string_compare_call(
            self, state, following, target):
        """Project a bounded comparison onto its first observed byte."""
        count = state.register('rdx') & MASK64
        if (count > (1 << 30)
                or not self._is_bounded_string_compare_function(
                    state, target)):
            return None
        left_address = state.register('rdi') & MASK64
        right_address = state.register('rsi') & MASK64
        reader = _VirtualProofReader(state)
        try:
            left = reader.read(left_address, count)
            right = reader.read(right_address, count)
        except PageFault:
            return None
        result = 0
        observed = count
        for index, (left_byte, right_byte) in enumerate(zip(left, right)):
            if left_byte != right_byte:
                result = MASK32 if left_byte < right_byte else 1
                observed = index + 1
                break
            if not left_byte:
                observed = index + 1
                break
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], result, 32)
        self.collapsed_bounded_compare_calls += 1
        self.collapsed_bounded_compare_bytes += observed
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    def _bit_scan_layout(self, state, target):
        """Recognize complete first/next-set-bit primitives."""
        target = int(target) & MASK64
        cached = self._bit_scan_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            entry = reader.read(target, 4)
            if entry not in (
                    bytes.fromhex('f3 0f 1e fa'),
                    bytes.fromhex('0f 1f 40 d6')):
                raise ValueError('bit scan entry changed')
            first = reader.read(target, 0x3e)
            if (first[4:0x34] == _BIT_SCAN_FIRST_BODY
                    and first[0x34] == 0xe9
                    and first[0x39] == 0xe9):
                returns = (
                    (target + 0x39 + _signed_integer(
                        int.from_bytes(first[0x35:0x39], 'little'), 32))
                     & MASK64,
                    (target + 0x3e + _signed_integer(
                        int.from_bytes(first[0x3a:0x3e], 'little'), 32))
                     & MASK64,
                )
                mode = 'first'
            else:
                direct_first = reader.read(target, 0x55)
                if (direct_first[:0x1e] == _BIT_SCAN_FIRST_DIRECT_HEAD
                        and direct_first[0x1e:0x20]
                        == bytes.fromhex('2e e9')
                        and direct_first[0x24:0x4f]
                        == _BIT_SCAN_FIRST_DIRECT_BODY
                        and direct_first[0x4f:0x51]
                        == bytes.fromhex('2e e9')):
                    returns = (
                        (target + 0x24 + _signed_integer(
                            int.from_bytes(
                                direct_first[0x20:0x24], 'little'), 32))
                         & MASK64,
                        (target + 0x55 + _signed_integer(
                            int.from_bytes(
                                direct_first[0x51:0x55], 'little'), 32))
                         & MASK64,
                    )
                    mode = 'first'
                else:
                    code = reader.read(target, 0x61)
                    if (code[4:0x41] == _BIT_SCAN_NEXT_BODY
                            and code[0x41] == 0xe9
                            and code[0x46:0x5c] == _BIT_SCAN_NEXT_RESULT
                            and code[0x5c] == 0xe9):
                        returns = (
                            (target + 0x46 + _signed_integer(
                                int.from_bytes(
                                    code[0x42:0x46], 'little'), 32))
                             & MASK64,
                            (target + 0x61 + _signed_integer(
                                int.from_bytes(
                                    code[0x5d:0x61], 'little'), 32))
                             & MASK64,
                        )
                        mode = 'next'
                    else:
                        direct_next = reader.read(target, 0x66)
                        if (direct_next[:0x60] != _BIT_SCAN_NEXT_DIRECT
                                or direct_next[0x60:0x62]
                                != bytes.fromhex('2e e9')):
                            raise ValueError('not a bit scan primitive')
                        return_target = (
                            target + 0x66 + _signed_integer(
                                int.from_bytes(
                                    direct_next[0x62:0x66], 'little'), 32)
                            ) & MASK64
                        returns = return_target, return_target
                        mode = 'next'
            if returns[0] != returns[1] \
                    or reader.read(returns[0], 1) != b'\xc3':
                raise ValueError('bit scan return path changed')
            layout = mode
        except (PageFault, ValueError):
            pass
        config, proof = reader.proof()
        self._bit_scan_functions[target] = config, proof, layout
        return layout

    def _prefix_validator_layout(self, state, target):
        """Recover prefixes whose absence proves a parser cannot mutate."""
        target = int(target) & MASK64
        cached = self._prefix_validator_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = reader.read(target, 0x55)
            if code[0] != 0xe8:
                raise ValueError('prefix validator entry changed')
            entry = (target + 5 + _signed_integer(
                int.from_bytes(code[1:5], 'little'), 32)) & MASK64
            entry_code = reader.read(entry, len(_ENTRY_NOP_PREFIX) + 4)
            if not entry_code.startswith(_ENTRY_NOP_PREFIX):
                raise ValueError('prefix validator entry hook is active')
            entry_return = (entry + len(entry_code) + _signed_integer(
                int.from_bytes(entry_code[-4:], 'little'), 32)) & MASK64
            if reader.read(entry_return, 1) != b'\xc3':
                raise ValueError('prefix validator hook does not return')

            if (code[5:0x10] == bytes.fromhex(
                    '55 31 f6 48 89 e5 41 55 41 54 53')
                    and code[0x10:0x12] == bytes.fromhex('81 3f')
                    and code[0x16:0x19] == bytes.fromhex('48 89 fb')
                    and code[0x19:0x1b] == bytes.fromhex('75 0f')
                    and code[0x2a:0x2d] == bytes.fromhex('81 7b 10')
                    and code[0x31:0x37] == bytes.fromhex(
                        '4c 8d 6b 10 74 14')
                    and code[0x37:0x46] == bytes.fromhex(
                        '41 bc 01 00 00 00 5b 44 89 e0 '
                        '41 5c 41 5d 5d')
                    and code[0x46] == 0xe9
                    and code[0x4b:0x50] == bytes.fromhex(
                        '41 80 7d 04 5f')):
                prefixes = (
                    (0, code[0x12:0x16]),
                    (16, code[0x2d:0x31] + code[0x4f:0x50]),
                )
                return_target = (target + 0x4b + _signed_integer(
                    int.from_bytes(code[0x47:0x4b], 'little'), 32)) & MASK64
            elif (code[5:0x0a] == bytes.fromhex('55 48 89 e5 53')
                    and code[0x0a:0x0c] == bytes.fromhex('81 3f')
                    and code[0x10:0x12] == bytes.fromhex('74 11')
                    and code[0x12:0x1e] == bytes.fromhex(
                        'bb 01 00 00 00 89 d8 48 8b 5d f8 c9')
                    and code[0x1e] == 0xe9
                    and code[0x23:0x27] == bytes.fromhex(
                        '80 7f 04 5f')):
                prefixes = ((0, code[0x0c:0x10] + code[0x26:0x27]),)
                return_target = (target + 0x23 + _signed_integer(
                    int.from_bytes(code[0x1f:0x23], 'little'), 32)) & MASK64
            else:
                raise ValueError('not a fixed-prefix validator')
            if reader.read(return_target, 1) != b'\xc3':
                raise ValueError('prefix validator return path changed')
            layout = prefixes
        except (PageFault, ValueError):
            pass
        config, proof = reader.proof()
        self._prefix_validator_functions[target] = config, proof, layout
        return layout

    def _collapse_prefix_validator_call(self, state, following, target):
        """Return failure after the smallest prefix residual disproves input."""
        prefixes = self._prefix_validator_layout(state, target)
        if prefixes is None:
            return None
        address = state.register('rdi') & MASK64
        observed = 0
        try:
            for offset, prefix in prefixes:
                observed += len(prefix)
                if read_virtual(state, address + offset, len(prefix)) == prefix:
                    return None
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], 1, 32)
        self.collapsed_prefix_validator_calls += 1
        self.collapsed_prefix_validator_bytes += observed
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    def _collapse_bit_scan_call(self, state, following, target):
        """Project a bitmap scan directly onto its first live word."""
        mode = self._bit_scan_layout(state, target)
        size = state.register('rsi') & MASK64
        if mode is None or size > (1 << 34):
            return None
        offset = 0 if mode == 'first' else state.register('rdx') & MASK64
        result = size
        observed = 0
        if offset < size:
            address = state.register('rdi') & MASK64
            first_byte = offset >> 3
            byte_count = (size + 7) >> 3
            try:
                byte = load_virtual(state, address + first_byte, 1)
                byte &= (0xff << (offset & 7)) & 0xff
                found_byte = first_byte if byte else None
                if found_byte is None and first_byte + 1 < byte_count:
                    found = find_virtual_not(
                        state, address + first_byte + 1,
                        byte_count - first_byte - 1, 0)
                    if found is not None:
                        found_byte = first_byte + 1 + found
                        byte = load_virtual(
                            state, address + found_byte, 1)
                if found_byte is not None:
                    candidate = (found_byte << 3) + \
                        ((byte & -byte).bit_length() - 1)
                    result = min(candidate, size)
                    observed = (found_byte >> 3) - (first_byte >> 3) + 1
                else:
                    observed = ((byte_count - 1) >> 3) \
                        - (first_byte >> 3) + 1
            except PageFault:
                return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], result, 64)
        self.collapsed_bit_scan_calls += 1
        self.collapsed_bit_scan_words += observed
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    def _strided_validator_layout(self, state, target):
        """Recover the first disproving byte of a bounded validator."""
        target = int(target) & MASK64
        cached = self._strided_validator_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = reader.read(target, 0x50)
            if (code[:4] not in (
                    bytes.fromhex('f3 0f 1e fa'),
                    bytes.fromhex('0f 1f 40 d6'))
                    or code[4] != 0xe8
                    or code[9:0x12] != _STRIDED_VALIDATOR_PREFIX
                    or code[0x16:0x1d] != _STRIDED_VALIDATOR_ARGUMENT
                    or code[0x1d] != 0xe8
                    or code[0x22:0x2d] != _STRIDED_VALIDATOR_MISMATCH
                    or code[0x46:0x4b] != _STRIDED_VALIDATOR_RETURN
                    or code[0x4b] != 0xe9):
                raise ValueError('not a bounded byte validator')
            entry = (target + 9 + _signed_integer(
                int.from_bytes(code[5:9], 'little'), 32)) & MASK64
            entry_code = reader.read(
                entry, len(_ENTRY_NOP_PREFIX) + 4)
            if not entry_code.startswith(_ENTRY_NOP_PREFIX):
                raise ValueError('validator entry hook is active')
            entry_return = (
                entry + len(entry_code) + _signed_integer(
                    int.from_bytes(entry_code[-4:], 'little'), 32)) & MASK64
            if reader.read(entry_return, 1) != b'\xc3':
                raise ValueError('validator entry hook does not return')
            return_thunk = (target + 0x50 + _signed_integer(
                int.from_bytes(code[0x4c:0x50], 'little'), 32)) & MASK64
            if reader.read(return_thunk, 1) != b'\xc3':
                raise ValueError('validator return path changed')
            compare = (target + 0x22 + _signed_integer(
                int.from_bytes(code[0x1e:0x22], 'little'), 32)) & MASK64
            if not self._is_bounded_string_compare_function(state, compare):
                raise ValueError('validator comparison changed')
            compare_proof = self._bounded_string_compare_functions.get(compare)
            if compare_proof is None or not reader.absorb(
                    compare_proof[0], compare_proof[1]):
                raise ValueError('validator comparison proof changed')
            signature = _signed_integer(
                int.from_bytes(code[0x12:0x16], 'little'), 32) & MASK64
            length = int.from_bytes(code[0x0b:0x0f], 'little')
            if not length:
                raise ValueError('validator signature is empty')
            first = reader.load(signature, 1)
            layout = first, length
        except (PageFault, ValueError):
            pass
        config, proof = reader.proof()
        self._strided_validator_functions[target] = config, proof, layout
        return layout

    def _normalized_compare_layout(self, state, target):
        """Recognize byte comparators that canonicalize '-' to '_'."""
        target = int(target) & MASK64
        cached = self._normalized_compare_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout

        layout = None
        extent = 0x58
        try:
            code = read_virtual(state, target, extent, 'execute')
            entry = code[:4] in (
                bytes.fromhex('f3 0f 1e fa'),
                bytes.fromhex('0f 1f 40 d6'))
            if (entry and code[4:0x17] == bytes.fromhex(
                    '0f 1f 44 00 00 55 48 89 e5 41 56 53 '
                    '48 89 f3 49 89 fe e8')
                    and code[0x1b:0x58] == bytes.fromhex(
                    '48 83 f8 ff 74 35 31 d2 be 5f 00 00 00 '
                    '41 0f b6 3c 16 40 80 ff 2d 0f 44 fe '
                    '44 0f b6 04 13 41 80 f8 2d 44 0f 44 c6 '
                    '44 38 c7 0f 94 c1 48 39 d0 74 0c 48 ff c2 '
                    '44 38 c7 74 d4 eb 02 b1 01')):
                layout = 'nul'
            elif (entry and code[4:0x45] == bytes.fromhex(
                    '0f 1f 44 00 00 55 48 89 e5 48 85 d2 74 3a '
                    '48 ff ca 31 c9 41 b8 5f 00 00 00 '
                    '0f b6 04 0f 3c 2d 41 0f 44 c0 '
                    '44 0f b6 0c 0e 41 80 f9 2d 45 0f 44 c8 '
                    '44 38 c8 0f 94 c0 75 09 48 39 ca '
                    '48 8d 49 01 75 d8')):
                layout = 'bounded'
        except PageFault:
            pass
        config, proof = _execution_proof(state, target, extent)
        if proof is not None:
            self._normalized_compare_functions[target] = \
                config, proof, layout
        else:
            self._normalized_compare_functions.pop(target, None)
        return layout

    def _collapse_normalized_compare_call(self, state, following, target):
        """Compare normalized byte coordinates without scalar call frames."""
        layout = self._normalized_compare_layout(state, target)
        if layout is None:
            return None
        left_address = state.register('rdi') & MASK64
        right_address = state.register('rsi') & MASK64
        count = (state.register('rdx') & MASK64
                 if layout == 'bounded' else None)
        if count is not None and count > (1 << 20):
            return None
        key = layout, left_address, right_address, count
        cached = self._normalized_compare_cache.get(key)
        result = None
        observed = 0
        if cached is not None:
            config, proof, result, observed = cached
            if _proof_mismatch(state, config, proof) is None:
                self.normalized_compare_cache_hits += 1
            else:
                result = None

        if result is None:
            reader = _VirtualProofReader(state)
            try:
                if layout == 'bounded':
                    left = reader.read(left_address, count)
                    right = reader.read(right_address, count)
                    observed = count
                else:
                    value = self._proof_cstring(reader, left_address)
                    if value is None:
                        return None
                    observed = len(value) + 1
                    left = value + b'\0'
                    right = reader.read(right_address, observed)
            except PageFault:
                return None
            result = int(left.replace(b'-', b'_')
                         == right.replace(b'-', b'_'))
            config, proof = reader.proof()
            self._normalized_compare_cache[key] = \
                config, proof, result, observed
            self.normalized_compare_cache_misses += 1

        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], result, 32)
        self.collapsed_normalized_compare_calls += 1
        self.collapsed_normalized_compare_bytes += observed
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _collapse_string_compare_call(self, state, following, target):
        """Project a string comparison call onto its first differing byte."""
        if not self._is_string_compare_function(state, target):
            return None
        left_address = state.register('rdi') & MASK64
        right_address = state.register('rsi') & MASK64
        for offset in range(1 << 20):
            left = load_virtual(state, left_address + offset, 1)
            right = load_virtual(state, right_address + offset, 1)
            if left != right:
                result = 1 if left >= right else MASK32
                flags = _result_flags(
                    state.rflags, 'cmp', left, right,
                    (left - right) & 0xff, 8)
                break
            if not left:
                result = 0
                flags = _result_flags(
                    state.rflags, 'xor', 0, 0, 0, 32)
                break
        else:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], result, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], left, 32)
        self.collapsed_compare_calls += 1
        self.collapsed_compare_bytes += offset + 1
        self.collapsed_compare_iterations += offset + 1
        return replace(state, registers=registers, rflags=flags,
                       rip=following & MASK64)

    def _interval_compare_layout(self, state, target):
        """Recognize an interval/key comparator with inert entry tracing."""
        target = int(target) & MASK64
        cached = self._interval_compare_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present

        body = bytes.fromhex(
            '55 48 8b 47 08 48 83 e0 fc 48 8d 54 07 08 '
            '48 8b 46 08 48 89 e5 48 83 e0 fc 48 8d 4c 06 08 '
            'b8 ff ff ff ff 48 39 ca 72 28 '
            'b8 01 00 00 00 48 39 d1 72 1e '
            '48 63 07 48 01 c7 48 63 06 48 01 c6 '
            'b8 ff ff ff ff 48 39 f7 72 08 '
            '31 c0 48 39 fe 0f 92 c0 5d e9')
        extent = 0x5f
        present = False
        proof_extents = [(target, extent)]
        try:
            code = read_virtual(state, target, extent, 'execute')
            if (code[:5] == b'\xf3\x0f\x1e\xfa\xe8'
                    and code[9:0x5b] == body):
                entry = (target + 9 + _signed_integer(
                    int.from_bytes(code[5:9], 'little'), 32)) & MASK64
                return_target = (target + extent + _signed_integer(
                    int.from_bytes(code[0x5b:extent], 'little'), 32)) & MASK64
                trace = read_virtual(state, entry, 19, 'execute')
                traced_return = (entry + 19 + _signed_integer(
                    int.from_bytes(trace[15:19], 'little'), 32)) & MASK64
                present = (trace[:14]
                           == b'\xf3\x0f\x1e\xfa' + b'\x90' * 10
                           and trace[14] == 0xe9
                           and traced_return == return_target
                           and read_virtual(
                               state, return_target, 1, 'execute') == b'\xc3')
                proof_extents.extend(((entry, 19), (return_target, 1)))
        except PageFault:
            present = False

        config = None
        proof = ()
        for address, count in proof_extents:
            current_config, current = _execution_proof(
                state, address, count)
            if current is None or (config is not None
                                   and current_config != config):
                proof = None
                break
            config = current_config
            proof += current
        if proof is not None:
            self._interval_compare_functions[target] = (
                config, proof, present)
        else:
            self._interval_compare_functions.pop(target, None)
        return present

    def _collapse_interval_compare_call(self, state, following, target):
        """Compare two interval records through their final direct keys."""
        if not self._interval_compare_layout(state, target):
            return None
        left = state.register('rdi') & MASK64
        right = state.register('rsi') & MASK64
        try:
            left_end = (left + 8
                        + (load_virtual(state, left + 8, 8) & ~3)) & MASK64
            right_end = (right + 8
                         + (load_virtual(state, right + 8, 8) & ~3)) & MASK64
            if left_end < right_end:
                result = MASK64
            elif right_end < left_end:
                result = 1
            else:
                left_key = (left + _signed_integer(
                    load_virtual(state, left, 4), 32)) & MASK64
                right_key = (right + _signed_integer(
                    load_virtual(state, right, 4), 32)) & MASK64
                result = (MASK64 if left_key < right_key
                          else int(right_key < left_key))
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], result, 64)
        self.collapsed_interval_compare_calls += 1
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    def _range_table_query_layout(self, state, target):
        """Prove a packed ``(start, size, class)`` overlap query."""
        target = int(target) & MASK64
        cached = self._range_table_query_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout

        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = reader.read(target, 0x77)
            current = (
                code[:9] == bytes.fromhex(
                    'f3 0f 1e fa 0f 1f 44 00 00')
                and code[9:0x10] == bytes.fromhex(
                    '55 48 89 e5 48 8b 0d')
                and code[0x14:0x53] == bytes.fromhex(
                    '44 8b 01 31 c0 45 85 c0 74 35 48 83 c1 04 eb 07 '
                    'ff c0 41 39 c0 74 2f 4c 63 c8 4f 8d 0c 89 '
                    '4e 8d 0c 89 85 d2 74 06 41 39 51 10 75 e4 '
                    '4d 8b 11 49 39 f2 73 dc 4d 03 51 08 49 39 fa '
                    '76 d3 b0 01')
                and code[0x53:0x56] == bytes.fromhex('5d 2e e9')
                and code[0x5a:0x5f] == bytes.fromhex('31 c0 5d 2e e9'))
            if current:
                layout = (target + 0x14 + _signed_integer(
                    int.from_bytes(code[0x10:0x14], 'little'), 32)) & MASK64
            elif (code[:4] not in (
                    bytes.fromhex('f3 0f 1e fa'),
                    bytes.fromhex('0f 1f 40 d6'))
                    or code[4] != 0xe8
                    or code[9:12] != bytes.fromhex('49 89 f9')
                    or code[12:15] != bytes.fromhex('48 8b 3d')
                    or code[0x13:0x48] != _RANGE_TABLE_QUERY_PREFIX
                    or code[0x48] != 0xe9
                    or code[0x4d:0x66] != _RANGE_TABLE_QUERY_TYPED
                    or code[0x66] != 0xe9
                    or code[0x6b:0x77] != _RANGE_TABLE_QUERY_SUFFIX):
                raise ValueError('not a packed range-table query')
            else:
                entry = (target + 9 + _signed_integer(
                    int.from_bytes(code[5:9], 'little'), 32)) & MASK64
                entry_code = reader.read(
                    entry, len(_ENTRY_NOP_PREFIX) + 4)
                if not entry_code.startswith(_ENTRY_NOP_PREFIX):
                    raise ValueError('range query entry hook is active')
                entry_return = (
                    entry + len(entry_code) + _signed_integer(
                        int.from_bytes(entry_code[-4:], 'little'), 32)) \
                    & MASK64
                if reader.read(entry_return, 1) != b'\xc3':
                    raise ValueError(
                        'range query entry hook does not return')

                first_return = (target + 0x4d + _signed_integer(
                    int.from_bytes(code[0x49:0x4d], 'little'), 32)) \
                    & MASK64
                second_return = (target + 0x6b + _signed_integer(
                    int.from_bytes(code[0x67:0x6b], 'little'), 32)) \
                    & MASK64
                if (first_return != second_return
                        or reader.read(first_return, 1) != b'\xc3'):
                    raise ValueError('range query return path changed')
                layout = (target + 0x13 + _signed_integer(
                    int.from_bytes(code[0x0f:0x13], 'little'), 32)) \
                    & MASK64
        except (PageFault, ValueError):
            pass
        config, proof = reader.proof()
        self._range_table_query_functions[target] = config, proof, layout
        return layout

    def _collapse_range_table_query_call(self, state, following, target):
        """Resolve one packed range lookup through its proved page directory."""
        table_pointer = self._range_table_query_layout(state, target)
        if table_pointer is None:
            return None

        key = int(target) & MASK64, table_pointer
        cached = self._range_table_directories.get(key)
        records = None
        if cached is not None:
            config, proof, records = cached
            if _proof_mismatch(state, config, proof) is None:
                self.range_table_cache_hits += 1
            else:
                records = None
        if records is None:
            reader = _VirtualProofReader(state)
            try:
                table = reader.load(table_pointer, 8)
                count = reader.load(table, 4)
                if count > (1 << 20):
                    return None
                payload = reader.read((table + 4) & MASK64, count * 20)
                records = tuple(struct.iter_unpack('<QQI', payload))
            except (PageFault, struct.error):
                return None
            config, proof = reader.proof()
            self._range_table_directories[key] = config, proof, records
            self.range_table_cache_misses += 1

        query_start = state.register('rdi') & MASK64
        query_end = state.register('rsi') & MASK64
        query_class = state.register('rdx') & MASK32
        result = 0
        examined = 0
        for record_start, record_size, record_class in records:
            examined += 1
            if query_class and record_class != query_class:
                continue
            record_end = (record_start + record_size) & MASK64
            if record_start < query_end and query_start < record_end:
                result = 1
                break
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], result, 32)
        self.collapsed_range_table_calls += 1
        self.collapsed_range_table_records += examined
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    def _range_compaction_layout(self, state, target):
        """Prove a hole compactor followed by a start-coordinate sort."""
        target = int(target) & MASK64
        cached = self._range_compaction_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present

        reader = _VirtualProofReader(state)
        present = False

        def prove_entry(address, code, displacement_offset, following):
            entry = (address + following + _signed_integer(
                int.from_bytes(
                    code[displacement_offset:displacement_offset + 4],
                    'little'), 32)) & MASK64
            entry_code = reader.read(
                entry, len(_ENTRY_NOP_PREFIX) + 4)
            if not entry_code.startswith(_ENTRY_NOP_PREFIX):
                raise ValueError('range entry hook is active')
            entry_return = (
                entry + len(entry_code) + _signed_integer(
                    int.from_bytes(entry_code[-4:], 'little'), 32)) & MASK64
            if reader.read(entry_return, 1) != b'\xc3':
                raise ValueError('range entry hook does not return')

        try:
            code = reader.read(target, 0xf1)
            current = (
                code[:0xde] == _RANGE_COMPACT_DIRECT
                and code[0xde:0xe1] == bytes.fromhex('48 c7 c1')
                and code[0xe5:0xe8] == bytes.fromhex('45 31 c0')
                and code[0xe8] == 0xe8
                and code[0xed:0xf1] == bytes.fromhex('89 d8 5b 5d'))
            if current:
                compare = _signed_integer(
                    int.from_bytes(code[0xe1:0xe5], 'little'), 32) & MASK64
                compare_code = reader.read(compare, 0x1c)
                if compare_code != _RANGE_COMPARE_DIRECT:
                    raise ValueError('range start comparator changed')
                sort = (target + 0xed + _signed_integer(
                    int.from_bytes(code[0xe9:0xed], 'little'), 32)) & MASK64
            else:
                if (code[:4] not in (
                        bytes.fromhex('f3 0f 1e fa'),
                        bytes.fromhex('0f 1f 40 d6'))
                        or code[4] != 0xe8
                        or code[9:0x22] != _RANGE_COMPACT_ENTRY
                        or code[0x22:0x8f] != _RANGE_COMPACT_CORE
                        or code[0x8f:0xbe] != _RANGE_COMPACT_COUNT
                        or code[0xbe:0xc1] != bytes.fromhex('48 c7 c1')
                        or code[0xc5:0xcd]
                        != bytes.fromhex('ba 10 00 00 00 4c 89 cf')
                        or code[0xcd] != 0xe8
                        or code[0xd2:0xd9]
                        != bytes.fromhex('89 d8 48 8b 5d f8 c9')
                        or code[0xd9] != 0xe9):
                    raise ValueError('not a fixed range compactor')
                prove_entry(target, code, 5, 9)
                return_thunk = (target + 0xde + _signed_integer(
                    int.from_bytes(code[0xda:0xde], 'little'), 32)) \
                    & MASK64
                if reader.read(return_thunk, 1) != b'\xc3':
                    raise ValueError(
                        'range compactor return path changed')

                compare = _signed_integer(
                    int.from_bytes(code[0xc1:0xc5], 'little'), 32) & MASK64
                compare_code = reader.read(compare, 0x2b)
                if (compare_code[:4] not in (
                        bytes.fromhex('f3 0f 1e fa'),
                        bytes.fromhex('0f 1f 40 d6'))
                        or compare_code[4] != 0xe8
                        or compare_code[9:0x26] != _RANGE_COMPARE_BODY
                        or compare_code[0x26] != 0xe9):
                    raise ValueError('range start comparator changed')
                prove_entry(compare, compare_code, 5, 9)
                compare_return = (compare + 0x2b + _signed_integer(
                    int.from_bytes(compare_code[0x27:0x2b], 'little'), 32)) \
                    & MASK64
                if reader.read(compare_return, 1) != b'\xc3':
                    raise ValueError('range comparator return path changed')

                sort = (target + 0xd2 + _signed_integer(
                    int.from_bytes(code[0xce:0xd2], 'little'), 32)) & MASK64
            if not self._code_contains_recipe(
                    state, sort,
                    (_SORT_WRAPPER_CORE, _SORT_WRAPPER_DIRECT_CORE)):
                raise ValueError('range sort changed')
            reader.read(sort, 96)
            present = True
        except (PageFault, ValueError):
            pass
        config, proof = reader.proof()
        self._range_compaction_functions[target] = config, proof, present
        return present

    def _collapse_range_compaction_call(self, state, following, target):
        """Compact sparse 16-byte ranges and sort the live prefix once."""
        count = state.register('rsi') & MASK32
        if count > (1 << 24) or not self._range_compaction_layout(
                state, target):
            return None
        base = state.register('rdi') & MASK64
        try:
            payload = read_virtual(state, base, count * 16)
            records = [list(record)
                       for record in struct.iter_unpack('<QQ', payload)]
        except (PageFault, struct.error):
            return None

        low = 0
        high = count - 1
        while low < high:
            while low < high and records[low][1]:
                low += 1
            while low < high and not records[high][1]:
                high -= 1
            if low == high:
                break
            records[low] = records[high]
            records[high] = [0, 0]
            low += 1
            high -= 1
        live = next((index for index, record in enumerate(records)
                     if not record[1]), count)
        order = _radix_record_order(records[:live], 1)
        normalized = [records[index] for index in order]
        normalized.extend(([0, 0] for _unused in range(count - live)))
        try:
            state = write_virtual(
                state, base,
                b''.join(struct.pack('<QQ', *record)
                         for record in normalized))
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], live, 32)
        self.collapsed_record_sorts += 1
        self.collapsed_sort_records += live
        self.collapsed_sort_passes += 8
        self.collapsed_entry_nop_calls += 1
        self.collapsed_range_compactions += 1
        self.collapsed_range_compaction_records += count
        self.collapsed_range_compaction_live_records += live
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    def _collapse_length_call(self, state, following, target):
        """Project a proved NUL-length ABI call to its terminal coordinate."""
        if not self._is_length_function(state, target):
            return None
        address = state.register('rdi') & MASK64
        cached = self._length_cache.get(address)
        if cached is not None:
            config, proof, length = cached
            if _proof_mismatch(state, config, proof) is None:
                self.length_cache_hits += 1
                registers = _write_register(
                    state.registers, REGISTER_INDEX['rax'], length, 64)
                self.collapsed_length_calls += 1
                return replace(state, registers=registers,
                               rip=following & MASK64)
        reader = _VirtualProofReader(state)
        try:
            value = self._proof_cstring(reader, address)
        except PageFault:
            return None
        if value is None:
            return None
        length = len(value)
        config, proof = reader.proof()
        self._length_cache[address] = config, proof, length
        self.length_cache_misses += 1
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], length, 64)
        self.collapsed_length_calls += 1
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _field_scan_layout(self, state, target):
        """Recognize a linked field sanitizer and recover its ctype table."""
        target = int(target) & MASK64
        cached = self._field_scan_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        extent = 0x1cf
        signature = bytes.fromhex(
            '55 48 89 e5 41 57 41 56 41 55 41 54 53 48 83 ec 30 '
            '48 89 75 b8 48 89 7d c8 f6 47 58 10')
        try:
            code = reader.read(target, extent)
            if (code[:len(signature)] == signature
                    and code[0x1c8:0x1cb] == bytes.fromhex('0f b6 89')):
                ctype_base = int.from_bytes(
                    code[0x1cb:0x1cf], 'little', signed=True) & MASK64
                layout = ctype_base
        except PageFault:
            pass
        config, proof = reader.proof()
        self._field_scan_functions[target] = config, proof, layout
        return layout

    def _field_directory(self, state, head, ctype_base):
        """Index one proved linked field list by replaceable type suffix."""
        key = int(head) & MASK64, int(ctype_base) & MASK64
        cached = self._field_directory_cache.get(key)
        if cached is not None:
            config, proof, directory = cached
            if _proof_mismatch(state, config, proof) is None:
                self.field_directory_cache_hits += 1
                return directory
        reader = _VirtualProofReader(state)
        candidates = []
        attributes = False
        count = 0
        seen = set()
        try:
            ctype = reader.read(ctype_base, 256)
            node = reader.load(head, 8)
            while node != head:
                if node in seen or count >= (1 << 16):
                    return None
                seen.add(node)
                type_address = reader.load((node + 0x18) & MASK64, 8)
                value = self._proof_cstring(reader, type_address)
                if value is None:
                    return None
                attributes |= b'__attribute__(' in value
                bracket = value.find(b'[')
                if bracket >= 0 and bracket + 1 < len(value):
                    first = value[bracket + 1]
                    if (ctype[first] & 0x03) or first == 0x5f:
                        candidates.append(value[bracket + 1:])
                node = reader.load(node, 8)
                count += 1
        except PageFault:
            return None
        directory = attributes, tuple(candidates), count
        config, proof = reader.proof()
        self._field_directory_cache[key] = config, proof, directory
        self.field_directory_cache_misses += 1
        return directory

    def _collapse_field_scan_call(self, state, following, target):
        """Return directly when a proved field list has no active mutation."""
        ctype_base = self._field_scan_layout(state, target)
        if ctype_base is None:
            return None
        call = state.register('rdi') & MASK64
        mapping = state.register('rsi') & MASK64
        reader = _VirtualProofReader(state)
        try:
            flags = reader.load((call + 0x58) & MASK64, 1)
            if flags & 0x10:
                self.collapsed_field_scans += 1
                return replace(state, rip=following & MASK64)
            event_class = reader.load((call + 0x10) & MASK64, 8)
            getter = reader.load((event_class + 0x28) & MASK64, 8)
            if getter:
                return None
            head = (event_class + 0x30) & MASK64
            directory = self._field_directory(state, head, ctype_base)
            if directory is None:
                return None
            attributes, candidates, count = directory
            if attributes:
                return None
            if mapping:
                needle_address = reader.load((mapping + 8) & MASK64, 8)
                needle = self._proof_cstring(reader, needle_address)
                if needle is None or any(
                        candidate.startswith(needle)
                        for candidate in candidates):
                    return None
        except PageFault:
            return None
        self.collapsed_field_scans += 1
        self.collapsed_field_entries += count
        return replace(state, rip=following & MASK64)

    def _is_substring_function(self, state, target):
        """Recognize a complete compiler-shaped NUL substring primitive."""
        target = int(target) & MASK64
        cached = self._substring_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        signature = bytes.fromhex(
            'f3 0f 1e fa 48 c7 c1 ff ff ff ff '
            '80 7c 0e 01 00 48 8d 49 01 75 f5 48 85 c9 74 1f')
        try:
            present = read_virtual(
                state, target, len(signature), 'execute') == signature
        except PageFault:
            present = False
        config, proof = _execution_proof(state, target, len(signature))
        if proof is not None:
            self._substring_functions[target] = config, proof, present
        return present

    def _collapse_substring_call(self, state, following, target):
        """Project an ABI substring call through a proof-backed byte cut."""
        if not self._is_substring_function(state, target):
            return None
        haystack_address = state.register('rdi') & MASK64
        needle_address = state.register('rsi') & MASK64
        key = haystack_address, needle_address
        cached = self._substring_cache.get(key)
        if cached is not None:
            config, proof, result = cached
            if _proof_mismatch(state, config, proof) is None:
                self.substring_cache_hits += 1
                registers = _write_register(
                    state.registers, REGISTER_INDEX['rax'], result, 64)
                self.collapsed_substring_calls += 1
                return replace(state, registers=registers,
                               rip=following & MASK64)
        reader = _VirtualProofReader(state)
        try:
            haystack = self._proof_cstring(reader, haystack_address)
            needle = self._proof_cstring(reader, needle_address)
        except PageFault:
            return None
        if haystack is None or needle is None:
            return None
        offset = haystack.find(needle)
        result = (haystack_address + offset) & MASK64 if offset >= 0 else 0
        config, proof = reader.proof()
        self._substring_cache[key] = config, proof, result
        self.substring_cache_misses += 1
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], result, 64)
        self.collapsed_substring_calls += 1
        return replace(state, registers=registers,
                       rip=following & MASK64)

    def _indirect_thunk_layout(self, state, target):
        """Recover the register selected by a standard x86 retpoline thunk."""
        target = int(target) & MASK64
        cached = self._indirect_thunk_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        layout = None
        extent = 6
        try:
            signature = read_virtual(state, target, extent, 'execute')
            if signature == b'\xe8\x01\0\0\0\xcc':
                extent = 15
                code = read_virtual(state, target, extent, 'execute')
                rex, opcode, modrm, sib = code[6:10]
                if (rex & 0xf8 == 0x48 and opcode == 0x89
                        and modrm & 0xc7 == 0x04 and sib == 0x24
                        and code[10] in (0xc3, 0xe9)):
                    register = ((modrm >> 3) & 7) \
                        | (((rex >> 2) & 1) << 3)
                    if code[10] == 0xc3:
                        return_thunk = target + 10
                    else:
                        return_thunk = target + 15 + _signed_integer(
                            int.from_bytes(code[11:15], 'little'), 32)
                    return_thunk &= MASK64
                    layout = register, return_thunk
        except PageFault:
            pass
        config, proof = _execution_proof(state, target, extent)
        if proof is not None:
            self._indirect_thunk_functions[target] = config, proof, layout
        else:
            self._indirect_thunk_functions.pop(target, None)
        return layout

    def _collapse_indirect_thunk_call(self, state, following, target):
        layout = self._indirect_thunk_layout(state, target)
        if layout is None:
            return None
        register, return_thunk = layout
        if not self._code_contains_recipe(
                state, return_thunk, b'\xc3', extent=1):
            return None
        actual_target = state.registers[register] & MASK64
        if actual_target != (int(target) & MASK64):
            collapsed = self._collapse_pure_call(
                state, following, actual_target)
            if collapsed is not None:
                self.collapsed_indirect_calls += 1
                return collapsed
        pointer = (state.register('rsp') - 8) & MASK64
        state = state.with_register('rsp', pointer)
        state = write_virtual(
            state, pointer, struct.pack('<Q', int(following) & MASK64))
        self.collapsed_indirect_calls += 1
        return replace(state, rip=actual_target)

    def _is_entry_nop_function(self, state, target):
        """Prove an fentry stub that only tail-returns to its caller."""
        target = int(target) & MASK64
        cached = self._entry_nop_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present

        present = False
        return_target = None
        extent = len(_ENTRY_NOP_PREFIX) + 4
        try:
            code = read_virtual(state, target, extent, 'execute')
            if code.startswith(_ENTRY_NOP_PREFIX):
                return_target = (
                    target + extent + _signed_integer(
                        int.from_bytes(code[-4:], 'little'), 32)) & MASK64
                present = read_virtual(
                    state, return_target, 1, 'execute') == b'\xc3'
        except PageFault:
            pass
        config, entry_proof = _execution_proof(state, target, extent)
        return_proof = None
        if return_target is not None:
            return_config, return_proof = _execution_proof(
                state, return_target, 1)
            if return_config != config:
                return_proof = None
        proof = (None if entry_proof is None or return_proof is None
                 else entry_proof + return_proof)
        if proof is not None:
            self._entry_nop_functions[target] = config, proof, present
        else:
            self._entry_nop_functions.pop(target, None)
        return present

    def _collapse_entry_nop_call(self, state, following, target):
        """Compose a proved instrumentation no-op into the caller cut."""
        if not self._is_entry_nop_function(state, target):
            return None
        self.collapsed_entry_nop_calls += 1
        return replace(state, rip=int(following) & MASK64)

    def _register_projection_layout(self, state, target):
        """Prove a one-edge register projection ending at a return thunk."""
        target = int(target) & MASK64
        cached = self._register_projection_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = reader.read(target, 12)
            rex, opcode, modrm = code[4:7]
            return_thunk = (target + 12 + _signed_integer(
                int.from_bytes(code[8:12], 'little'), 32)) & MASK64
            if (code[:4] in (
                    bytes.fromhex('f3 0f 1e fa'),
                    bytes.fromhex('0f 1f 40 d6'))
                    and rex & 0xf8 == 0x48
                    and opcode == 0x89 and modrm & 0xc0 == 0xc0
                    and code[7] == 0xe9
                    and reader.read(return_thunk, 1) == b'\xc3'):
                source = ((modrm >> 3) & 7) | (((rex >> 2) & 1) << 3)
                destination = (modrm & 7) | ((rex & 1) << 3)
                layout = destination, source
        except PageFault:
            pass
        config, proof = reader.proof()
        self._register_projection_functions[target] = config, proof, layout
        return layout

    def _collapse_register_projection_call(
            self, state, following, target):
        """Compose a proved register projection into the caller state."""
        layout = self._register_projection_layout(state, target)
        if layout is None:
            return None
        destination, source = layout
        registers = _write_register(
            state.registers, destination, state.registers[source], 64)
        self.collapsed_register_projection_calls += 1
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    def _machine_leaf_layout(self, state, target):
        """Prove a tail-returning leaf that only projects machine state."""
        target = int(target) & MASK64
        cached = self._machine_leaf_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = reader.read(target, 12)
            candidates = (
                (bytes.fromhex('f3 0f 1e fa 9c 58 e9'), 11,
                 'flags'),
                (bytes.fromhex('f3 0f 1e fa fa e9'), 10,
                 'irq-disable'),
                (bytes.fromhex('f3 0f 1e fa fb e9'), 10,
                 'irq-enable'),
                (bytes.fromhex('f3 0f 1e fa 0f 20 d0 e9'), 12,
                 'read-cr2'),
            )
            for prefix, extent, operation in candidates:
                if not code.startswith(prefix):
                    continue
                displacement = _signed_integer(
                    int.from_bytes(code[extent - 4:extent], 'little'), 32)
                return_thunk = (target + extent + displacement) & MASK64
                if reader.read(return_thunk, 1) == b'\xc3':
                    layout = operation
                break
        except PageFault:
            pass
        config, proof = reader.proof()
        self._machine_leaf_functions[target] = config, proof, layout
        return layout

    def _collapse_machine_leaf_call(self, state, following, target):
        """Compose a proved flags/control-register leaf into its caller."""
        operation = self._machine_leaf_layout(state, target)
        if operation is None:
            return None
        registers = state.registers
        flags = state.rflags
        if operation == 'flags':
            registers = _write_register(
                registers, REGISTER_INDEX['rax'], flags, 64)
        elif operation == 'irq-disable':
            flags &= ~RFLAGS_INTERRUPT
        elif operation == 'irq-enable':
            flags |= RFLAGS_INTERRUPT
        else:
            registers = _write_register(
                registers, REGISTER_INDEX['rax'], state.cr2, 64)
        self.collapsed_machine_leaf_calls += 1
        return replace(state, registers=registers, rflags=flags | 2,
                       rip=int(following) & MASK64)

    def _page_bootmem_layout(self, state, target):
        """Prove the sparse page-metadata initialization leaf."""
        target = int(target) & MASK64
        cached = self._page_bootmem_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        reader = _VirtualProofReader(state)
        present = False
        try:
            code = bytearray(reader.read(target, 60))
            displacement = _signed_integer(
                int.from_bytes(code[52:56], 'little'), 32)
            return_thunk = (target + 56 + displacement) & MASK64
            code[52:56] = bytes(4)
            present = (
                bytes(code) == bytes.fromhex(
                    'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 '
                    '83 fa 10 73 26 48 89 f8 48 c1 e8 3c 75 1f '
                    'f0 80 4e 01 40 48 c1 e7 04 89 d0 48 09 f8 '
                    '48 89 46 28 f0 ff 46 34 5d 2e e9 00 00 00 00 '
                    '0f 0b 0f 0b')
                and reader.read(return_thunk, 1) == b'\xc3')
        except PageFault:
            pass
        config, proof = reader.proof()
        self._page_bootmem_functions[target] = config, proof, present
        return present

    def _collapse_page_bootmem_call(self, state, following, target):
        """Initialize only the three selected page-metadata lanes."""
        if not self._page_bootmem_layout(state, target):
            return None
        info = state.register('rdi') & MASK64
        page = state.register('rsi') & MASK64
        kind = state.register('rdx') & MASK32
        if kind >= 16 or info >> 60:
            return None
        try:
            flags_byte = load_virtual(state, page + 1, 1)
            references = load_virtual(state, page + 0x34, 4)
            encoded = ((info << 4) | kind) & MASK64
            state = write_virtual_batch(state, (
                (page + 1, bytes((flags_byte | 0x40,))),
                (page + 0x28, struct.pack('<Q', encoded)),
                (page + 0x34,
                 struct.pack('<I', (references + 1) & MASK32)),
            ))
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rdi'], info << 4, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rax'], encoded, 64)
        flags = _result_flags(
            state.rflags & ~RFLAGS_CARRY, 'add', references, 1,
            (references + 1) & MASK32, 32, preserve_carry=True)
        self.collapsed_page_bootmem_calls += 1
        return replace(state, registers=registers, rflags=flags,
                       rip=int(following) & MASK64)

    def _store_word_layout(self, state, target):
        """Prove a compiler-shaped ABI leaf storing RSI through RDI."""
        target = int(target) & MASK64
        cached = self._store_word_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        reader = _VirtualProofReader(state)
        present = False
        try:
            code = bytearray(reader.read(target, 31))
            displacement = _signed_integer(
                int.from_bytes(code[27:31], 'little'), 32)
            return_thunk = (target + 31 + displacement) & MASK64
            code[27:31] = bytes(4)
            present = (
                bytes(code) == bytes.fromhex(
                    'f3 0f 1e fa 55 48 89 e5 50 48 89 75 f8 '
                    '48 8b 45 f8 48 89 07 48 83 c4 08 5d 2e e9 '
                    '00 00 00 00')
                and reader.read(return_thunk, 1) == b'\xc3')
        except PageFault:
            pass
        config, proof = reader.proof()
        self._store_word_functions[target] = config, proof, present
        return present

    def _collapse_store_word_call(self, state, following, target):
        """Store one ABI word without materializing its call frame."""
        if not self._store_word_layout(state, target):
            return None
        address = state.register('rdi') & MASK64
        value = state.register('rsi') & MASK64
        stack = state.register('rsp') & MASK64
        if (stack - 24) & MASK64 <= address < stack:
            return None
        try:
            state = write_virtual(state, address, struct.pack('<Q', value))
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], value, 64)
        before = (stack - 24) & MASK64
        result = (before + 8) & MASK64
        flags = _result_flags(
            state.rflags, 'add', before, 8, result, 64)
        self.collapsed_store_word_calls += 1
        return replace(state, registers=registers, rflags=flags,
                       rip=int(following) & MASK64)

    def _random_u32_cache_layout(self, state, target):
        """Prove the selected-coordinate fast path of a cached u32 source."""
        target = int(target) & MASK64
        cached = self._random_u32_cache_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            entry = bytearray(reader.read(
                target, len(_RANDOM_U32_CACHE_ENTRY)))
            core_address = target + len(entry)
            core = bytearray(reader.read(
                core_address, len(_RANDOM_U32_CACHE_CORE)))
            ready_address = target + 0xc5
            ready = bytearray(reader.read(
                ready_address, len(_RANDOM_U32_CACHE_READY)))

            entry_guard = (target + 30 + _signed_integer(
                int.from_bytes(entry[26:30], 'little'), 32)) & MASK64
            cpu_slot = (core_address + 23 + _signed_integer(
                int.from_bytes(core[19:23], 'little'), 32)) & MASK64
            cache_offset = _signed_integer(
                int.from_bytes(core[26:30], 'little'), 32)
            generation = (core_address + 37 + _signed_integer(
                int.from_bytes(core[33:37], 'little'), 32)) & MASK64
            index_offset = _signed_integer(
                int.from_bytes(core[39:43], 'little'), 32)
            second_cpu_slot = (core_address + 107 + _signed_integer(
                int.from_bytes(core[103:107], 'little'), 32)) & MASK64
            core_guard = (core_address + 129 + _signed_integer(
                int.from_bytes(core[125:129], 'little'), 32)) & MASK64
            return_thunk = (core_address + 153 + _signed_integer(
                int.from_bytes(core[149:153], 'little'), 32)) & MASK64
            ready_flag = (target + 0xcc + _signed_integer(
                int.from_bytes(ready[2:6], 'little'), 32)) & MASK64

            entry[26:30] = bytes(4)
            for start, end in (
                    (2, 6), (11, 15), (19, 23), (26, 30),
                    (33, 37), (39, 43), (63, 67), (103, 107),
                    (117, 121), (125, 129), (149, 153)):
                core[start:end] = bytes(end - start)
            ready[2:6] = bytes(4)
            if (bytes(entry) == _RANDOM_U32_CACHE_ENTRY
                    and bytes(core) == _RANDOM_U32_CACHE_CORE
                    and bytes(ready) == _RANDOM_U32_CACHE_READY
                    and cpu_slot == second_cpu_slot
                    and entry_guard == core_guard
                    and index_offset == cache_offset + 0x68
                    and reader.read(return_thunk, 1) == b'\xc3'):
                layout = (ready_flag, cpu_slot, cache_offset,
                          generation, index_offset)
        except PageFault:
            pass
        config, proof = reader.proof()
        self._random_u32_cache_functions[target] = config, proof, layout
        return layout

    def _random_u32_cache_window(self, state, target):
        """Return one proved resident cache window without changing state."""
        layout = self._random_u32_cache_layout(state, target)
        if layout is None:
            return None
        ready_flag, cpu_slot, cache_offset, generation_slot, \
            index_offset = layout
        try:
            if load_virtual(state, ready_flag, 4) <= 1:
                return None
            gs_base = dict(state.msrs).get(IA32_GS_BASE, 0)
            cpu_offset = load_virtual(
                state, (gs_base + cpu_slot) & MASK64, 8)
            cache = (cpu_offset + cache_offset) & MASK64
            index_slot = (cpu_offset + index_offset) & MASK64
            index = load_virtual(state, index_slot, 4)
            generation = load_virtual(state, generation_slot, 8)
            if (index > 23
                    or load_virtual(state, cache + 0x60, 8) != generation):
                return None
        except PageFault:
            return None
        return cache, index_slot, index, 24 - index

    @staticmethod
    def _publish_random_u32_cache(state, window, consumed):
        """Zero consumed words and advance the cache index atomically."""
        cache, index_slot, index, available = window
        consumed = int(consumed)
        if consumed <= 0 or consumed > available:
            raise ValueError('random cache consumption exceeds its window')
        value_slot = (cache + index * 4) & MASK64
        return write_virtual_batch(state, (
            (value_slot, bytes(consumed * 4)),
            (index_slot, struct.pack('<I', index + consumed)),
        ))

    def _collapse_random_u32_cache_call(
            self, state, following, target):
        """Consume one resident cached word without entering its refill path."""
        window = self._random_u32_cache_window(state, target)
        if window is None:
            return None
        cache, _index_slot, index, _available = window
        try:
            value = load_virtual(state, cache + index * 4, 4)
            state = self._publish_random_u32_cache(state, window, 1)
        except PageFault:
            return None

        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], value, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], value, 32)
        flags = _result_flags(state.rflags, 'cmp', 0, 0, 0, 64)
        self.collapsed_random_u32_cache_hits += 1
        return replace(state, registers=registers, rflags=flags,
                       rip=int(following) & MASK64)

    def _random_u32_below_layout(self, state, target):
        """Prove a bounded multiply/reject wrapper over cached u32 words."""
        target = int(target) & MASK64
        cached = self._random_u32_below_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = bytearray(reader.read(
                target, len(_RANDOM_U32_BELOW_CORE)))
            random_target = (target + 23 + _signed_integer(
                int.from_bytes(code[19:23], 'little'), 32)) & MASK64
            return_thunk = (target + 58 + _signed_integer(
                int.from_bytes(code[54:58], 'little'), 32)) & MASK64
            second_random = (target + 77 + _signed_integer(
                int.from_bytes(code[73:77], 'little'), 32)) & MASK64
            code[19:23] = bytes(4)
            code[54:58] = bytes(4)
            code[73:77] = bytes(4)
            if (bytes(code) == _RANDOM_U32_BELOW_CORE
                    and random_target == second_random
                    and self._random_u32_cache_layout(
                        state, random_target) is not None
                    and reader.read(return_thunk, 1) == b'\xc3'):
                layout = random_target
        except PageFault:
            pass
        config, proof = reader.proof()
        self._random_u32_below_functions[target] = config, proof, layout
        return layout

    def _collapse_random_u32_below_call(
            self, state, following, target):
        """Consume one accepted bounded value from a resident cache window."""
        random_target = self._random_u32_below_layout(state, target)
        if random_target is None:
            return None
        window = self._random_u32_cache_window(state, random_target)
        if window is None:
            return None
        cache, _index_slot, index, available = window
        ceiling = state.register('rdi') & MASK32
        try:
            result = self._bounded_random_word(
                lambda offset: load_virtual(
                    state, cache + (index + offset) * 4, 4),
                available, ceiling)
            if result is None:
                return None
            accepted, product, consumed = result
            state = self._publish_random_u32_cache(
                state, window, consumed)
        except PageFault:
            return None

        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], accepted, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'],
            accepted if not ceiling else product >> 32, 32)
        self.collapsed_random_u32_cache_hits += consumed
        self.collapsed_random_u32_below_calls += 1
        self.collapsed_random_u32_below_words += consumed
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    @staticmethod
    def _bounded_random_word(load, available, ceiling):
        """Return one Lemire-bounded word and the consumed source prefix."""
        ceiling = int(ceiling) & MASK32
        for offset in range(int(available)):
            random_word = int(load(offset)) & MASK32
            if not ceiling:
                return random_word, random_word, offset + 1
            product = random_word * ceiling
            low = product & MASK32
            if low >= ceiling:
                return product >> 32, product, offset + 1
            threshold = ((-ceiling) & MASK32) % ceiling
            if low >= threshold:
                return product >> 32, product, offset + 1
        return None

    def _random_permutation_layout(self, state, target):
        """Prove one in-place bounded-random permutation backedge."""
        target = int(target) & MASK64
        cached = self._random_permutation_loops.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        reader = _VirtualProofReader(state)
        layout = None
        try:
            code = bytearray(reader.read(
                target, len(_RANDOM_PERMUTATION_LOOP)))
            bounded = (target + 7 + _signed_integer(
                int.from_bytes(code[3:7], 'little'), 32)) & MASK64
            code[3:7] = bytes(4)
            if (bytes(code) == _RANDOM_PERMUTATION_LOOP
                    and self._random_u32_below_layout(
                        state, bounded) is not None):
                layout = bounded
        except PageFault:
            pass
        config, proof = reader.proof()
        self._random_permutation_loops[target] = config, proof, layout
        return layout

    def _collapse_random_permutation_loop(self, state, branch):
        """Join a resident random window into sparse in-place word swaps."""
        following, target, condition = branch.boundary.detail
        if condition != 5 or state.rip != target or target >= branch.rip:
            return state
        if branch.rip + len(branch.source) != following:
            return state
        bounded = self._random_permutation_layout(state, target)
        if bounded is None:
            return state
        random_target = self._random_u32_below_layout(state, bounded)
        window = self._random_u32_cache_window(state, random_target)
        if window is None:
            return state
        cache, index_slot, random_index, available = window
        array = state.register('r14')
        ceiling = state.register('rbx') & MASK32
        permutation_index = state.register('r15')
        if (ceiling < 2 or permutation_index != ceiling - 2
                or state.register('r12') != permutation_index
                or permutation_index >= (1 << 24)):
            return state

        words = {}

        def array_word(coordinate):
            if coordinate in words:
                return words[coordinate]
            return load_virtual(state, array + coordinate * 4, 4)

        consumed = 0
        iterations = 0
        last_result = 0
        last_left = 0
        last_right = 0
        try:
            while iterations <= permutation_index and consumed < available:
                current_ceiling = ceiling - iterations
                result = self._bounded_random_word(
                    lambda offset: load_virtual(
                        state, cache + (
                            random_index + consumed + offset) * 4, 4),
                    available - consumed, current_ceiling)
                if result is None:
                    break
                random_word, _product, used = result
                consumed += used
                tail = current_ceiling - 1
                tail_value = array_word(tail)
                random_value = array_word(random_word)
                words[tail] = random_value
                words[random_word] = tail_value
                iterations += 1
                last_result = random_word
                last_left = tail_value
                last_right = random_value
            if not iterations:
                return state
            writes = [
                (array + coordinate * 4, struct.pack('<I', value))
                for coordinate, value in sorted(words.items())]
            writes.extend((
                (cache + random_index * 4, bytes(consumed * 4)),
                (index_slot,
                 struct.pack('<I', random_index + consumed)),
            ))
            state = write_virtual_batch(state, writes)
        except PageFault:
            return state

        final_ceiling = ceiling - iterations
        final_index = permutation_index - iterations
        tested = permutation_index - (iterations - 1)
        registers = _write_register(
            state.registers, REGISTER_INDEX['rbx'], final_ceiling, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['r12'], final_index, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['r15'], final_index, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdi'], final_ceiling + 1, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rax'], last_result, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], last_left, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rdx'], last_right, 32)
        flags = _result_flags(
            state.rflags, 'and', tested, tested, tested, 32)
        complete = iterations == permutation_index + 1
        self.collapsed_random_u32_cache_hits += consumed
        self.collapsed_random_u32_below_calls += iterations
        self.collapsed_random_u32_below_words += consumed
        self.collapsed_random_permutation_iterations += iterations
        return replace(state, registers=registers, rflags=flags,
                       rip=int(following) & MASK64 if complete else target)

    def _is_page_record_predicate(self, state, target):
        """Prove the direct fixed-lane page-record validity predicate."""
        target = int(target) & MASK64
        cached = self._page_record_predicate_functions.get(target)
        if cached is not None:
            config, proof, present = cached
            if _proof_mismatch(state, config, proof) is None:
                return present
        reader = _VirtualProofReader(state)
        present = False
        try:
            code = bytearray(reader.read(
                target, len(_PAGE_RECORD_PREDICATE_CORE)))
            code[-4:] = bytes(4)
            present = bytes(code) == _PAGE_RECORD_PREDICATE_CORE
        except PageFault:
            pass
        config, proof = reader.proof()
        self._page_record_predicate_functions[target] = (
            config, proof, present)
        return present

    def _collapse_page_record_predicate_call(
            self, state, following, target):
        """Evaluate one page record from only its predicate coordinates."""
        if not self._is_page_record_predicate(state, target):
            return None
        record = state.register('rdi')
        try:
            mapcount = load_virtual(state, record + 0x30, 4)
            compound_mapcount = load_virtual(state, record + 0x34, 4)
            if compound_mapcount & (1 << 31):
                compound_mapcount -= 1 << 32
            aggregate = compound_mapcount & MASK64
            aggregate |= load_virtual(state, record + 0x18, 8)
            aggregate |= load_virtual(state, record + 0x38, 8)
            masked_mapping = (
                load_virtual(state, record + 0x08, 8)
                & 0xffffff800000007c)
            mapping_bad = int(masked_mapping == 0xdead000000000040)
            masked_flags = load_virtual(state, record, 8) & 0x14e123
        except PageFault:
            return None
        if (mapcount != MASK32 or aggregate or mapping_bad
                or masked_flags):
            return None

        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], 0, 32)
        registers = _write_register(
            registers, REGISTER_INDEX['rcx'], 0, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rdx'],
            0xdead000000000040, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rsi'], 0, 32)
        flags = _result_flags(state.rflags, 'xor', 0, 0, 0, 32)
        self.collapsed_page_record_predicates += 1
        return replace(state, registers=registers, rflags=flags,
                       rip=int(following) & MASK64)

    def _page_record_projection_layout(self, state, branch):
        """Prove a patched validation edge around one strided page array."""
        if branch.boundary.operation != 'branch':
            return None
        target = int(branch.boundary.detail) & MASK64
        if (state.rip != target or target != branch.rip + 0x20
                or branch.source != bytes.fromhex('eb 1e')):
            return None
        cached = self._page_record_projection_loops.get(branch.rip)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout

        reader = _VirtualProofReader(state)
        layout = None
        try:
            head = reader.read(branch.rip - 0x4a,
                               len(_PAGE_RECORD_RELEASE_HEAD))
            good = bytearray(reader.read(
                branch.rip + 2, len(_PAGE_RECORD_RELEASE_GOOD)))
            check = bytearray(reader.read(
                target, len(_PAGE_RECORD_RELEASE_CHECK)))
            exit_displacement = _signed_integer(
                int.from_bytes(good[-4:], 'little'), 32)
            predicate_displacement = _signed_integer(
                int.from_bytes(check[28:32], 'little'), 32)
            good[-4:] = bytes(4)
            check[28:32] = bytes(4)
            predicate = (target + 32 + predicate_displacement) & MASK64
            if (head == _PAGE_RECORD_RELEASE_HEAD
                    and bytes(good) == _PAGE_RECORD_RELEASE_GOOD
                    and bytes(check) == _PAGE_RECORD_RELEASE_CHECK
                    and self._is_page_record_predicate(state, predicate)):
                layout = (target + exit_displacement) & MASK64
        except PageFault:
            pass
        config, proof = reader.proof()
        self._page_record_projection_loops[branch.rip] = (
            config, proof, layout)
        return layout

    def _collapse_page_record_projection(self, state, branch):
        """Validate and update one good record run as a physical array."""
        exit_target = self._page_record_projection_layout(state, branch)
        if exit_target is None:
            return state
        frame = state.register('rbp')
        base = state.register('r13')
        try:
            mode = load_virtual(state, frame - 0x44, 1)
            current = load_virtual(state, frame - 0x40, 8)
            limit = load_virtual(state, frame - 0x58, 8)
        except PageFault:
            return state
        remaining = limit - current
        if (not mode or base != state.register('r15')
                or remaining <= 0 or remaining & 63
                or remaining > (1 << 26)):
            return state

        predicates = (
            (0x30, 4, MASK32, MASK32, True),
            (0x34, 4, MASK32, 0, True),
            (0x18, 8, MASK64, 0, True),
            (0x38, 8, MASK64, 0, True),
            (0x08, 8, 0xffffff800000007c,
             0xdead000000000040, False),
            (0, 8, 0x14e123, 0, True),
        )
        count = remaining // 64
        try:
            state, matching = project_matching_virtual_records(
                state, base + current, count, 64, predicates,
                ((0, 4, 0xffa00000, 0),))
        except (PageFault, ValueError):
            return state
        if not matching:
            return state

        next_offset = current + matching * 64
        complete = next_offset == limit
        saved_offset = limit - 64 if complete else next_offset
        try:
            state = write_virtual(
                state, frame - 0x40,
                int(saved_offset).to_bytes(8, 'little'))
        except PageFault:
            return state
        registers = _write_register(
            state.registers, REGISTER_INDEX['rcx'], next_offset, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['rax'], limit, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['r15'], base, 64)
        if complete:
            flags = _result_flags(
                state.rflags, 'cmp', limit, next_offset,
                (limit - next_offset) & MASK64, 64)
            rip = exit_target
        else:
            flags = _result_flags(
                state.rflags, 'cmp', mode, 0, mode, 8)
            rip = branch.rip
        self.collapsed_page_record_projection_iterations += matching
        self.collapsed_strided_store_bytes += matching * 4
        self.collapsed_strided_store_iterations += matching
        return replace(state, registers=registers, rflags=flags, rip=rip)

    def _collapse_symbol_position_call(self, state, following, target):
        """Project one Linux kallsyms search from its observed page cut."""
        layout = self._symbol_position_layout(state, target)
        if layout is None:
            return None
        address = state.register('rdi')
        cache_key = int(target) & MASK64, address
        cached = self._symbol_position_cache.get(cache_key)
        result = None
        if cached is not None:
            config, proof, result = cached
            if _proof_mismatch(state, config, proof) is None:
                self.symbol_lookup_cache_hits += 1
            else:
                result = None

        if result is None:
            directory = self._symbol_position_directory(state, layout)
            if directory is not None:
                result = self._symbol_position_from_directory(
                    directory, address)

        if result is None:
            reader = _VirtualProofReader(state)
            num_address, relative_address, offsets = layout
            offset_loads = 0
            try:
                count = reader.load(num_address, 4)
                relative = reader.load(relative_address, 8)
                if count < 2 or count > (1 << 28):
                    return None

                def symbol(index):
                    nonlocal offset_loads
                    coordinate = (offsets + int(index) * 4) & MASK64
                    page_address = coordinate \
                        & ~(PHYSICAL_PAGE_BYTES - 1)
                    cached_page = self._symbol_offset_page(
                        state, page_address)
                    if cached_page is None:
                        raise PageFault(coordinate)
                    values, page_config, page_proof = cached_page
                    if not reader.absorb(page_config, page_proof):
                        raise PageFault(coordinate)
                    offset_loads += 1
                    value = values[
                        (coordinate - page_address) // 4]
                    return (relative + value) & MASK64

                low, high = 0, count
                while high - low > 1:
                    middle = low + (high - low) // 2
                    if symbol(middle) <= address:
                        low = middle
                    else:
                        high = middle
                while low and symbol(low - 1) == symbol(low):
                    low -= 1
                start = symbol(low)
                end = 0
                for index in range(low + 1, count):
                    candidate = symbol(index)
                    if candidate > start:
                        end = candidate
                        break
                # The final symbol uses a section boundary selected by code
                # outside the direct offset array. Keep that rare case on the
                # ordinary state-step path rather than inventing a second ABI.
                if not end:
                    return None
                result = low, end - start, (address - start) & MASK64
            except PageFault:
                return None
            config, proof = reader.proof()
            self._symbol_position_cache[cache_key] = config, proof, result
            self.symbol_lookup_cache_misses += 1
            self.symbol_lookup_offset_loads += offset_loads

        position, symbol_size, symbol_offset = result
        size_pointer = state.register('rsi')
        offset_pointer = state.register('rdx')
        if size_pointer:
            state = write_virtual(
                state, size_pointer, struct.pack('<Q', symbol_size & MASK64))
        if offset_pointer:
            state = write_virtual(
                state, offset_pointer,
                struct.pack('<Q', symbol_offset & MASK64))
        registers = _write_register(
            state.registers, REGISTER_INDEX['rax'], position, 64)
        self.collapsed_symbol_lookups += 1
        return replace(state, registers=registers,
                       rip=int(following) & MASK64)

    def _symbol_resolution_layout(self, state, target):
        """Recover the direct arrays of a complete kernel symbol query."""
        target = int(target) & MASK64
        cached = self._symbol_resolution_functions.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        signature = bytes.fromhex(
            '0f 1f 44 00 00 55 48 89 e5 41 57 41 56 41 55 41 54 '
            '53 50 4c 89 cb 41 c6 01 00')
        extent = len(signature)
        layout = None
        try:
            code = read_virtual(state, target, extent, 'execute')
            if code != signature:
                raise LookupError
            extent = 0x1a7
            code = read_virtual(state, target, extent, 'execute')
            if (any(code[offset:offset + 3] != b'\x48\x81\xff'
                    for offset in (0x32, 0x3c, 0x4c, 0x56))
                    or code[0x90] != 0xe8
                    or code[0x9c:0x9f] != b'\x8b\x0c\x8d'
                    or code[0xe4:0xe7] != b'\x48\xc7\xc0'):
                raise LookupError
            ranges = tuple(
                _signed_integer(int.from_bytes(
                    code[offset + 3:offset + 7], 'little'), 32) & MASK64
                for offset in (0x32, 0x3c, 0x4c, 0x56))
            position_target = (target + 0x95 + _signed_integer(
                int.from_bytes(code[0x91:0x95], 'little'), 32)) & MASK64
            markers = _signed_integer(
                int.from_bytes(code[0x9f:0xa3], 'little'), 32) & MASK64
            names = _signed_integer(
                int.from_bytes(code[0xe7:0xeb], 'little'), 32) & MASK64
            tokens = self._token_stream_layout(state, target + 0x132)
            if tokens is not None:
                layout = (ranges, position_target, markers, names,
                          tokens[0], tokens[1])
        except (LookupError, PageFault):
            pass
        config, proof = _execution_proof(state, target, extent)
        if proof is not None:
            self._symbol_resolution_functions[target] = \
                config, proof, layout
        else:
            self._symbol_resolution_functions.pop(target, None)
        return layout

    def _symbol_name_pointer(self, state, start, index):
        """Project one marker-local rank to its length-prefixed coordinate."""
        start = int(start) & MASK64
        index = int(index)
        if not 0 <= index < 256:
            return None
        cached = self._symbol_name_directories.get(start)
        ends = ()
        reader = _VirtualProofReader(state)
        if cached is not None:
            config, proof, ends = cached
            if reader.absorb(config, proof):
                if index <= len(ends):
                    self.symbol_name_directory_hits += 1
                    return start if not index else ends[index - 1]
            else:
                ends = ()
        current = start if not ends else ends[-1]
        extended = list(ends)
        try:
            while len(extended) < index:
                leading = reader.load(current, 1)
                if leading & 0x80:
                    length = ((leading & 0x7f)
                              + (reader.load(current + 1, 1) << 7) + 1)
                else:
                    length = leading
                current = (current + length + 1) & MASK64
                extended.append(current)
        except PageFault:
            return None
        config, proof = reader.proof()
        self._symbol_name_directories[start] = \
            config, proof, tuple(extended)
        self.symbol_name_directory_misses += 1
        return start if not index else extended[index - 1]

    def _collapse_symbol_resolution_call(self, state, following, target):
        """Compose a kernel symbol query without intermediate scalar state."""
        layout = self._symbol_resolution_layout(state, target)
        if layout is None:
            return None
        (ranges, position_target, markers, names,
         token_index, token_table) = layout
        address = state.register('rdi') & MASK64
        if not (ranges[0] <= address < ranges[1]
                or ranges[2] <= address < ranges[3]):
            return None
        output = state.register('r9') & MASK64
        if not output:
            return None
        projected = self._collapse_symbol_position_call(
            state, state.rip, position_target)
        if projected is None:
            return None
        position = projected.register('rax') & MASK64
        reader = _VirtualProofReader(projected)
        try:
            marker = reader.load(
                (markers + (position >> 8) * 4) & MASK64, 4)
            compressed = self._symbol_name_pointer(
                projected, (names + marker) & MASK64, position & 0xff)
            if compressed is None:
                return None
            leading = reader.load(compressed, 1)
            if leading & 0x80:
                token_count = ((leading & 0x7f)
                               + (reader.load(compressed + 1, 1) << 7))
                compressed = (compressed + 2) & MASK64
            else:
                token_count = leading
                compressed = (compressed + 1) & MASK64
            if token_count > (1 << 16):
                return None
            value = bytearray()
            skipped_type = False
            for token_offset in range(token_count):
                token = reader.load(compressed + token_offset, 1)
                offset = reader.load(token_index + token * 2, 2)
                expanded = self._proof_cstring(
                    reader, (token_table + offset) & MASK64, 512)
                if expanded is None:
                    return None
                for byte in expanded:
                    if not skipped_type:
                        skipped_type = True
                    elif len(value) < 511:
                        value.append(byte)
                    else:
                        break
                if len(value) >= 511:
                    break
        except PageFault:
            return None

        modname = projected.register('rcx') & MASK64
        build_id = projected.register('r8') & MASK64
        if modname:
            projected = write_virtual(
                projected, modname, struct.pack('<Q', 0))
        if build_id:
            projected = write_virtual(
                projected, build_id, struct.pack('<Q', 0))
        projected = write_virtual(projected, output, bytes(value) + b'\0')
        registers = _write_register(
            projected.registers, REGISTER_INDEX['rax'], len(value), 64)
        self.collapsed_symbol_resolutions += 1
        return replace(projected, registers=registers,
                       rip=int(following) & MASK64)

    def _symbol_wrapper_target(self, state, target):
        """Recover the composed resolver called by a standard lookup ABI."""
        target = int(target) & MASK64
        cached = self._symbol_wrapper_functions.get(target)
        if cached is not None:
            config, proof, result = cached
            if _proof_mismatch(state, config, proof) is None:
                return result
        prefix = bytes.fromhex(
            'f3 0f 1e fa 0f 1f 44 00 00 55 48 89 e5 41 56 53 '
            '4c 89 c3 45 31 f6 45 31 c0 49 89 d9 e8')
        extent = len(prefix) + 4
        result = None
        try:
            code = read_virtual(state, target, extent, 'execute')
            shape = bytearray(code[:len(prefix)])
            expected = bytearray(prefix)
            shape[:4] = expected[:4] = b'\0' * 4
            if shape == expected:
                result = (target + extent + _signed_integer(
                    int.from_bytes(code[-4:], 'little'), 32)) & MASK64
        except PageFault:
            pass
        config, proof = _execution_proof(state, target, extent)
        if proof is not None:
            self._symbol_wrapper_functions[target] = config, proof, result
        return result

    def _collapse_symbol_wrapper_call(self, state, following, target):
        """Join a symbol ABI wrapper directly to its residual resolver."""
        resolver = self._symbol_wrapper_target(state, target)
        if resolver is None:
            return None
        output = state.register('r8') & MASK64
        registers = _write_register(
            state.registers, REGISTER_INDEX['r8'], 0, 64)
        registers = _write_register(
            registers, REGISTER_INDEX['r9'], output, 64)
        projected = self._collapse_symbol_resolution_call(
            replace(state, registers=registers), state.rip, resolver)
        if projected is None:
            return None
        result = output if projected.register('rax') else 0
        registers = _write_register(
            projected.registers, REGISTER_INDEX['rax'], result, 64)
        self.collapsed_symbol_wrappers += 1
        return replace(projected, registers=registers,
                       rip=int(following) & MASK64)

    def _ftrace_record_layout(self, state, target):
        """Recover the symbol ABI called by a fixed-stride record scan."""
        target = int(target) & MASK64
        cached = self._ftrace_record_loops.get(target)
        if cached is not None:
            config, proof, layout = cached
            if _proof_mismatch(state, config, proof) is None:
                return layout
        expected = bytearray(bytes.fromhex(
            '49 8b 5f 08 4a 8b 7c 23 f8 31 f6 48 8d 54 24 08 '
            '31 c9 4d 89 f0 e8 00 00 00 00 48 85 c0 74 08 '
            '48 83 7c 24 08 05 72 06 42 80 4c 23 03 02 '
            '49 ff c5 49 63 47 10 49 83 c4 10 49 39 c5 7c c3'))
        extent = len(expected)
        layout = None
        try:
            code = bytearray(read_virtual(
                state, target, extent, 'execute'))
            displacement = _signed_integer(
                int.from_bytes(code[22:26], 'little'), 32)
            code[22:26] = b'\0' * 4
            if code == expected:
                layout = (target + 26 + displacement) & MASK64
        except PageFault:
            pass
        config, proof = _execution_proof(state, target, extent)
        if proof is not None:
            self._ftrace_record_loops[target] = config, proof, layout
        return layout

    def _collapse_ftrace_record_span(self, state, branch):
        """Retain only the symbol-size bit observed by a record consumer."""
        following, target, condition = branch.boundary.detail
        if (condition != 12 or state.rip != target
                or following != target + 61):
            return state
        wrapper = self._ftrace_record_layout(state, target)
        if wrapper is None:
            return state
        resolver = self._symbol_wrapper_target(state, wrapper)
        layout = (None if resolver is None else
                  self._symbol_resolution_layout(state, resolver))
        if layout is None:
            return state
        ranges, position_target = layout[0], layout[1]
        position_layout = self._symbol_position_layout(
            state, position_target)
        directory = (None if position_layout is None else
                     self._symbol_position_directory(
                         state, position_layout))
        if directory is None:
            return state
        node = state.register('r15') & MASK64
        current = state.register('r13') & MASK64
        try:
            base = load_virtual(state, node + 8, 8)
            count = _signed_integer(
                load_virtual(state, node + 0x10, 4), 32)
        except PageFault:
            return state
        if current >= count or count > (1 << 24):
            return state

        patches = []
        last_address = 0
        for index in range(current, count):
            try:
                address = load_virtual(state, base + index * 16, 8)
            except PageFault:
                return state
            if not (ranges[0] <= address < ranges[1]
                    or ranges[2] <= address < ranges[3]):
                return state
            result = self._symbol_position_from_directory(
                directory, address)
            if result is None:
                return state
            _position, size, _offset = result
            if size >= 5:
                coordinate = base + index * 16 + 11
                try:
                    value = load_virtual(state, coordinate, 1) | 2
                except PageFault:
                    return state
                patches.append((coordinate, value))
            last_address = address

        for address, value in patches:
            state = write_virtual(state, address, bytes((value,)))
        registers = state.registers
        for register, value, bits in (
                ('rax', count, 64), ('rbx', base, 64),
                ('r12', state.register('r12') + (count - current) * 16, 64),
                ('r13', count, 64), ('rdi', last_address, 64),
                ('rsi', 0, 64), ('rdx', state.register('rsp') + 8, 64),
                ('rcx', 0, 64), ('r8', state.register('r14'), 64),
                ('r9', state.register('r14'), 64)):
            registers = _write_register(
                registers, REGISTER_INDEX[register], value, bits)
        flags = _result_flags(
            state.rflags, 'cmp', count, count, 0, 64)
        self.collapsed_symbol_lookups += count - current
        self.collapsed_ftrace_records += count - current
        return replace(state, registers=registers, rflags=flags,
                       rip=int(following) & MASK64)

    def _record_sort_spec(self, state, size, compare, swap):
        if (size == 8
                and self._code_contains_recipe(
                    state, compare,
                    (_STATIC_CALL_COMPARE_CORE,
                     _STATIC_CALL_COMPARE_DIRECT_CORE))
                and self._code_contains_recipe(
                    state, swap,
                    (_STATIC_CALL_SWAP_CORE,
                     _STATIC_CALL_SWAP_DIRECT_CORE))):
            return 'relative32x2', 1
        if (size == 16
                and (self._code_contains_recipe(
                         state, compare, _JUMP_LABEL_COMPARE_CORE)
                     or self._interval_compare_layout(state, compare))
                and (self._code_contains_recipe(
                         state, swap, _JUMP_LABEL_SWAP_CORE)
                     or self._code_contains_recipe(
                         state, swap, _JUMP_LABEL_SWAP_DIRECT_CORE))):
            return 'relative32x2_64', 2
        return None

    def _collapse_record_sort_call(self, state, following, target):
        """Lower a proved relative-record sort to direct-coordinate radix."""
        if not self._code_contains_recipe(
                state, target,
                (_SORT_WRAPPER_CORE, _SORT_WRAPPER_DIRECT_CORE)):
            return None
        base = state.register('rdi')
        count = state.register('rsi')
        size = state.register('rdx')
        compare = state.register('rcx')
        swap = state.register('r8')
        if count < 2 or size not in (8, 16):
            return None
        if count > (1 << 24) or count * size > len(state.memory):
            return None
        spec = self._record_sort_spec(
            state, int(size), int(compare), int(swap))
        if spec is None:
            return None
        kind, key_count = spec
        records = []
        try:
            for index in range(int(count)):
                slot = (base + index * size) & MASK64
                first = load_virtual(state, slot, 4)
                second = load_virtual(state, slot + 4, 4)
                first_target = (slot + _signed_integer(first, 32)) & MASK64
                second_target = (
                    slot + 4 + _signed_integer(second, 32)) & MASK64
                if kind == 'relative32x2':
                    records.append((second_target & ~3,
                                    first_target, second_target))
                else:
                    third = load_virtual(state, slot + 8, 8)
                    third_target = (
                        slot + 8 + _signed_integer(third, 64)) & MASK64
                    records.append((third_target & ~3, first_target,
                                    first_target, second_target,
                                    third_target))
        except PageFault:
            return None

        order = _radix_record_order(records, key_count)
        try:
            for destination, source in enumerate(order):
                slot = (base + destination * size) & MASK64
                record = records[source]
                if kind == 'relative32x2':
                    payload = struct.pack(
                        '<II', (record[1] - slot) & MASK32,
                        (record[2] - slot - 4) & MASK32)
                else:
                    payload = struct.pack(
                        '<IIQ', (record[2] - slot) & MASK32,
                        (record[3] - slot - 4) & MASK32,
                        (record[4] - slot - 8) & MASK64)
                state = write_virtual(state, slot, payload)
        except PageFault:
            return None

        self.collapsed_record_sorts += 1
        self.collapsed_sort_records += int(count)
        self.collapsed_sort_passes += int(key_count) * 8
        if isinstance(state, _X86Frame):
            state.rip = int(following) & MASK64
        else:
            state = replace(state, rip=int(following) & MASK64)
        return state

    def _collapse_return_site_call(self, state, following, target):
        """Normalize a proved relative return-site table in one page cut."""
        start = state.register('rdi')
        end = state.register('rsi')
        distance = end - start
        if (distance < 256 or distance > (1 << 24)
                or distance & 3):
            return None
        try:
            code = read_virtual(state, target, 0x300, 'execute')
        except PageFault:
            return None
        if (not code.startswith(_RETURN_SCAN_PREFIX)
                or _RETURN_SCAN_LOOP not in code
                or _RETURN_ENTRY_CORE not in code):
            return None

        jump_marker = code.find(_RETURN_FEATURE_JUMP)
        target_marker = code.find(_RETURN_TARGET_COMPARE)
        if jump_marker < 0 or target_marker < 0:
            return None
        jump = jump_marker + len(_RETURN_FEATURE_JUMP) - 1
        feature_stub = (target + jump + 5 + _signed_integer(
            int.from_bytes(code[jump + 1:jump + 5], 'little'), 32)) & MASK64
        try:
            feature_code = read_virtual(
                state, feature_stub, 7, 'execute')
        except PageFault:
            return None
        if feature_code[:2] != b'\xf6\x05':
            return None
        feature_address = (feature_stub + 7 + _signed_integer(
            int.from_bytes(feature_code[2:6], 'little'), 32)) & MASK64
        if load_virtual(state, feature_address, 1) & feature_code[6]:
            return None

        expected = _signed_integer(
            int.from_bytes(code[target_marker + 3:target_marker + 7],
                           'little'), 32) & MASK64
        patches = []
        try:
            for slot in range(start, end, 4):
                relative = load_virtual(state, slot, 4)
                site = (slot + _signed_integer(relative, 32)) & MASK64
                current = read_virtual(state, site, 15, 'execute')
                if current[0] == 0xc3:
                    continue
                opcode = 0
                while (opcode < len(current)
                       and current[opcode] in (
                           0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65,
                           0x66, 0x67, 0xf0, 0xf2, 0xf3)):
                    opcode += 1
                length = opcode + 5
                if opcode >= len(current) or current[opcode] != 0xe9:
                    return None
                destination = (site + length + _signed_integer(
                    int.from_bytes(current[opcode + 1:opcode + 5],
                                   'little'), 32)) & MASK64
                if destination != expected:
                    if opcode == 0 and current[5:8] == b'\x0f\xb9\xcc':
                        continue
                    return None
                patches.append((site, b'\xc3' + b'\xcc' * (length - 1)))
        except PageFault:
            return None

        state = self._patch_code_batch(state, patches)
        count = distance // 4
        self.collapsed_return_sites += count
        self.collapsed_return_bytes += sum(
            len(payload) for _site, payload in patches)
        if isinstance(state, _X86Frame):
            state.rip = int(following) & MASK64
        else:
            state = replace(state, rip=int(following) & MASK64)
        return state

    def _collapse_alternative_table_call(self, state, following, target):
        """Apply a proved Linux alt table as one direct-coordinate cut."""
        start = state.register('rdi')
        end = state.register('rsi')
        extent = end - start
        if (extent < _ALTERNATIVE_ENTRY.size
                or extent > (1 << 24)
                or extent % _ALTERNATIVE_ENTRY.size):
            return None
        try:
            code = read_virtual(state, target, 0x500, 'execute')
        except PageFault:
            return None
        if (not code.startswith(_ALTERNATIVE_SCAN_PREFIX)
                or _ALTERNATIVE_ENTRY_CORE not in code):
            return None

        debug = code.find(_ALTERNATIVE_DEBUG_TEST)
        capability = code.find(_ALTERNATIVE_CAPABILITY_PROBE)
        bug = code.find(_ALTERNATIVE_BUG_ADDRESS)
        nop = code.find(_ALTERNATIVE_NOP_ADDRESS, bug + 7)
        if min(debug, capability, bug, nop) < 0:
            return None
        debug_address = (target + debug + 7 + _signed_integer(
            int.from_bytes(code[debug + 2:debug + 6], 'little'), 32)) \
            & MASK64
        capability_address = (target + capability + 8 + _signed_integer(
            int.from_bytes(code[capability + 4:capability + 8], 'little'),
            32)) & MASK64
        bug_address = _signed_integer(
            int.from_bytes(code[bug + 3:bug + 7], 'little'), 32) & MASK64
        nop_address = _signed_integer(
            int.from_bytes(code[nop + 2:nop + 6], 'little'), 32) & MASK64
        try:
            if load_virtual(state, debug_address, 1) & code[debug + 6]:
                return None
            table = bytearray(read_virtual(state, start, extent))
            capabilities = read_virtual(state, capability_address, 96)
        except PageFault:
            return None

        entries = []
        for offset in range(0, extent, _ALTERNATIVE_ENTRY.size):
            instruction_offset, replacement_offset, feature_flags, \
                instruction_bytes, replacement_bytes = \
                _ALTERNATIVE_ENTRY.unpack_from(table, offset)
            feature = feature_flags & 0xffff
            flags = feature_flags >> 16
            if (feature >= len(capabilities) * 8
                    or flags & ~3
                    or replacement_bytes > instruction_bytes
                    or instruction_bytes == 0xff
                    or replacement_bytes == 0xff):
                return None
            slot = (start + offset) & MASK64
            instruction = (slot + instruction_offset) & MASK64
            replacement = (slot + 4 + replacement_offset) & MASK64
            entries.append((offset, instruction, replacement, feature,
                            flags, instruction_bytes, replacement_bytes))

        # Nested alternatives are adjacent. Linux first raises every record at
        # one site to the same original extent, so later entries compose over
        # the prior normalized bytes without a second materialization route.
        table_updates = []
        index = 0
        while index < len(entries):
            stop = index + 1
            instruction = entries[index][1]
            maximum = entries[index][5]
            while stop < len(entries) and entries[stop][1] == instruction:
                maximum = max(maximum, entries[stop][5])
                stop += 1
            for entry in range(index, stop):
                values = list(entries[entry])
                values[5] = maximum
                entries[entry] = tuple(values)
                length_offset = values[0] + 12
                if table[length_offset] != maximum:
                    table_updates.append((start + length_offset, maximum))
            index = stop

        sites = {}
        originals = {}
        try:
            for (_offset, instruction, replacement, feature, flags,
                 instruction_bytes, replacement_bytes) in entries:
                current = sites.get(instruction)
                if current is None:
                    current = read_virtual(
                        state, instruction, instruction_bytes, 'execute')
                    originals[instruction] = current
                elif len(current) < instruction_bytes:
                    return None
                present = bool(capabilities[feature >> 3]
                               & (1 << (feature & 7)))
                if present == bool(flags & 1):
                    sites[instruction] = current
                    continue
                replacement_code = read_virtual(
                    state, replacement, replacement_bytes, 'execute')
                payload = bytearray(replacement_code)
                if flags & 2:
                    if (replacement_bytes != 5
                            or instruction_bytes != 6
                            or replacement_code[:1] != b'\xe8'
                            or current[:2] != b'\xff\x15'):
                        return None
                    pointer = (instruction + 6 + _signed_integer(
                        int.from_bytes(current[2:6], 'little'), 32)) & MASK64
                    direct_target = load_virtual(state, pointer, 8) or bug_address
                    if direct_target == nop_address:
                        payload = bytearray()
                    else:
                        displacement = direct_target - (instruction + 5)
                        if not -(1 << 31) <= displacement < (1 << 31):
                            return None
                        payload = bytearray(b'\xe8' + int(displacement).to_bytes(
                            4, 'little', signed=True))
                payload.extend(b'\x90' * (instruction_bytes - len(payload)))
                if not flags & 2:
                    relocated = _relocated_alternative(
                        payload, instruction, replacement, replacement_bytes)
                    if relocated is None:
                        return None
                    payload = bytearray(relocated)
                sites[instruction] = bytes(payload)
        except PageFault:
            return None

        for address, value in table_updates:
            state = write_virtual(state, address, bytes((value,)))
        code_patches = []
        changed_bytes = 0
        for instruction, payload in sites.items():
            if originals[instruction] == payload:
                continue
            code_patches.append((instruction, payload))
            changed_bytes += len(payload)
        state = self._patch_code_batch(state, code_patches)
        self.collapsed_alternative_tables += 1
        self.collapsed_alternative_entries += len(entries)
        self.collapsed_alternative_bytes += changed_bytes
        if isinstance(state, _X86Frame):
            state.rip = int(following) & MASK64
        else:
            state = replace(state, rip=int(following) & MASK64)
        return state

    def _collapse_smp_lock_call(self, state, following, target):
        """Patch the remaining Linux SMP lock-prefix table in one cut."""
        del target
        current = state.register('r12')
        end = state.register('r15')
        text_start = state.register('r14')
        text_end = state.register('rbx')
        extent = end - current
        if (extent < 4 or extent > (1 << 24) or extent & 3
                or state.register('rcx') != 1):
            return None
        try:
            caller = read_virtual(
                state, (int(following) - 0x60) & MASK64, 0x60, 'execute')
            if _SMP_LOCK_LOOP_CORE not in caller:
                return None
            if load_virtual(state, state.register('rdx'), 1) != 0x3e:
                return None
            first_relative = load_virtual(state, current, 4)
            first = (current + _signed_integer(first_relative, 32)) & MASK64
            if first != state.register('rsi'):
                return None
        except PageFault:
            return None

        patches = []
        try:
            for slot in range(current, end, 4):
                relative = load_virtual(state, slot, 4)
                address = (slot + _signed_integer(relative, 32)) & MASK64
                if (not relative or address < text_start
                        or address >= text_end):
                    continue
                if load_virtual(state, address, 1) == 0xf0:
                    patches.append(address)
        except PageFault:
            return None
        state = self._patch_code_batch(
            state, ((address, b'\x3e') for address in patches))

        registers = list(state.registers)
        registers[REGISTER_INDEX['r12']] = (end - 4) & MASK64
        self.collapsed_smp_lock_tables += 1
        self.collapsed_smp_lock_sites += len(patches)
        if isinstance(state, _X86Frame):
            state.registers = tuple(registers)
            state.rip = int(following) & MASK64
        else:
            state = replace(state, registers=tuple(registers),
                            rip=int(following) & MASK64)
        return state

    def _collapse_pure_call(self, state, following, target):
        collapsed = self._collapse_indirect_thunk_call(
            state, following, target)
        if collapsed is not None:
            return collapsed
        if not self.enable_function_oracles:
            return None
        """Apply the shared direct/indirect ABI summary route."""
        target &= MASK64
        if self._pure_call_profile is not None:
            self._pure_call_profile[target] = (
                self._pure_call_profile.get(target, 0) + 1)
        cached = self._pure_call_recipes.get(target)
        if cached is not None:
            collapsed = cached(state, following, target)
            if collapsed is not None:
                self.pure_call_recipe_hits += 1
                return collapsed
            self._pure_call_recipes.pop(target, None)
        reducers = (
            self._collapse_entry_nop_call,
            self._collapse_register_projection_call,
            self._collapse_machine_leaf_call,
            self._collapse_page_bootmem_call,
            self._collapse_store_word_call,
            self._collapse_random_u32_below_call,
            self._collapse_random_u32_cache_call,
            self._collapse_page_record_predicate_call,
            self._collapse_range_compaction_call,
            self._collapse_range_table_query_call,
            self._collapse_interval_compare_call,
            self._collapse_direct_u32_index_call,
            self._collapse_modular_delta_call,
            self._collapse_lane_permutation_call,
            self._collapse_sponge_mix_call,
            self._collapse_hash_init_call,
            self._collapse_hash_stream_call,
            self._collapse_sponge_finalize_call,
            self._collapse_smp_lock_call,
            self._collapse_alternative_table_call,
            self._collapse_return_site_call,
            self._collapse_record_sort_call,
            self._collapse_symbol_wrapper_call,
            self._collapse_symbol_resolution_call,
            self._collapse_normalized_compare_call,
            self._collapse_prefix_validator_call,
            self._collapse_bit_scan_call,
            self._collapse_bounded_string_compare_call,
            self._collapse_string_compare_call,
            self._collapse_length_call,
            self._collapse_btf_name_call,
            self._collapse_field_scan_call,
            self._collapse_substring_call,
            self._collapse_symbol_position_call,
            self._collapse_seal_directory_call,
            self._collapse_static_call_table,
            self._collapse_static_call_transform,
            self._collapse_text_patch_call,
            self._collapse_memory_fill_call,
            self._collapse_void_memory_copy_call,
            self._collapse_memory_copy_call,
        )
        for reducer in reducers:
            if reducer == cached:
                continue
            collapsed = reducer(state, following, target)
            if collapsed is not None:
                self._pure_call_recipes[target] = reducer
                self.pure_call_recipe_misses += 1
                return collapsed
        return None

    @staticmethod
    def _execute_plan(state, block):
        if not block.instructions and not block.scratch_count:
            if isinstance(state, _X86Frame):
                state.rip = block.boundary_rip
                return state, ()
            return replace(state, rip=block.boundary_rip), ()
        transient = isinstance(state.memory, MemoryCut)
        cut = state.memory if transient else MemoryCut(state.memory)
        input_values = tuple(
            load_virtual(
                state, operand.address(state, following), bits // 8)
            for following, bits, operand in block.cut_inputs)
        inputs = (state.registers
                  + ((state.rflags,) if block.state_flags else ())
                  + input_values
                  + (0,) * block.scratch_count)
        memory = _VirtualMemoryCut(state, cut) \
            if block.virtual_memory else cut
        outputs, stack = block.execute(inputs, (), memory)
        if stack:
            raise X86Error('x86 state page published a value stack')
        registers = outputs[:len(REGISTER_NAMES)]
        flags = (outputs[len(REGISTER_NAMES)]
                 if block.state_flags else state.rflags)
        extra = len(REGISTER_NAMES) + int(block.state_flags) \
            + len(block.cut_inputs)
        scratch = outputs[
            extra:]
        if isinstance(state, _X86Frame):
            state.registers = registers
            state.rflags = flags
            state.rip = block.boundary_rip
            state.memory = cut if transient else cut.commit()
            return state, scratch
        return replace(
            state,
            registers=registers,
            rflags=flags,
            rip=block.boundary_rip,
            memory=cut if transient else cut.commit()), scratch

    def _is_stable_backedge(self, state, block, seen, boundary):
        """Prove a backward edge reached an unchanged mutable state twice."""
        if boundary is not None:
            return False
        operation = block.boundary.operation
        if operation == 'conditional_branch':
            _following, target, _condition = block.boundary.detail
        elif operation == 'branch':
            target = block.boundary.detail
        else:
            return False
        target = int(target) & MASK64
        if target > block.rip or state.rip != target:
            return False
        memory = state.memory
        revision = (memory.change_revision
                    if isinstance(memory, MemoryCut) else None)
        stamp = state.registers, state.rflags, memory, revision
        edge = block.rip, target
        if seen.get(edge) != stamp:
            seen[edge] = stamp
            return False
        self.collapsed_spin_waits += 1
        return True

    def _control(self, state, boundary, prior=None, scratch=(),
                 flag_cut=None):
        if self._control_profile is not None:
            rip = state.rip if prior is None else prior.rip
            key = int(rip) & MASK64, boundary.operation
            self._control_profile[key] = \
                self._control_profile.get(key, 0) + 1
        operation, detail = boundary.operation, boundary.detail
        if operation == 'branch':
            rip = int(detail) & MASK64
            if isinstance(state, _X86Frame):
                state.rip = rip
                return state, None
            return replace(state, rip=rip), None
        if operation == 'dynamic_branch':
            rip = int(scratch[0]) & MASK64
            if isinstance(state, _X86Frame):
                state.rip = rip
                return state, None
            return replace(state, rip=rip), None
        if operation == 'conditional_branch':
            following, target, condition = detail
            if flag_cut is None:
                flags = state.rflags
                selected = _condition(flags, condition)
            else:
                flags = state.rflags
                selected = bool(scratch[0])
            rip = int(target if selected else following) & MASK64
            if isinstance(state, _X86Frame):
                state.rip = rip
                state.rflags = flags
                return state, None
            return replace(state, rip=rip, rflags=flags), None
        if operation == 'load':
            following, register, bits, operand = detail
            address = operand.address(state, following)
            value = load_virtual(state, address, bits // 8)
            registers = _write_register_operand(
                state.registers, register, value, bits)
            if isinstance(state, _X86Frame):
                state.registers = registers
                state.rip = following
                return state, None
            return replace(state, registers=registers,
                           rip=following), None
        if operation == 'move_zero_extend':
            following, register, source_bits, target_bits, operand = detail
            value = (load_virtual(
                state, operand.address(state, following), source_bits // 8)
                if isinstance(operand, MemoryOperand)
                else _register_operand_value(
                    state.registers, operand, source_bits))
            registers = _write_register(
                state.registers, register, value, target_bits)
            if isinstance(state, _X86Frame):
                state.registers = registers
                state.rip = following
                return state, None
            return replace(state, registers=registers, rip=following), None
        if operation == 'move_sign_extend':
            following, register, source_bits, target_bits, operand = detail
            value = (load_virtual(
                state, operand.address(state, following), source_bits // 8)
                if isinstance(operand, MemoryOperand)
                else _register_operand_value(
                    state.registers, operand, source_bits))
            if value & (1 << (source_bits - 1)):
                value -= 1 << source_bits
            registers = _write_register(
                state.registers, register, value, target_bits)
            if isinstance(state, _X86Frame):
                state.registers = registers
                state.rip = following
                return state, None
            return replace(state, registers=registers, rip=following), None
        if operation == 'store':
            following, register, bits, operand = detail
            address = operand.address(state, following)
            value = _register_operand_value(state.registers, register, bits)
            state = write_virtual(
                state, address,
                int(value & ((1 << bits) - 1)).to_bytes(
                    bits // 8, 'little'))
            if isinstance(state, _X86Frame):
                state.rip = following
                return state, None
            return replace(state, rip=following), None
        if operation == 'store_immediate':
            following, operand, bits, immediate = detail
            state = write_virtual(
                state, operand.address(state, following),
                int(immediate & ((1 << bits) - 1)).to_bytes(
                    bits // 8, 'little'))
            if isinstance(state, _X86Frame):
                state.rip = following
                return state, None
            return replace(state, rip=following), None
        if operation == 'register_result_flags':
            following, name, destination, source, bits = detail
            mask = (1 << bits) - 1
            left, right = (int(value) & mask for value in scratch)
            result = state.registers[destination] & mask
            flags = _result_flags(prior.rflags, name, left, right,
                                  result, bits)
            return replace(state, rip=following, rflags=flags), None
        if operation == 'register_immediate_result_flags':
            following, name, register, bits, immediate = detail
            mask = (1 << bits) - 1
            left = int(scratch[0]) & mask
            right = immediate & mask
            result = state.registers[register] & mask
            flags = _result_flags(prior.rflags, name, left, right,
                                  result, bits)
            return replace(state, rip=following, rflags=flags), None
        if operation == 'register_multiply_flags':
            following, _register, bits = detail
            mask = (1 << bits) - 1

            def signed(value):
                value = int(value) & mask
                return value - (1 << bits) if value >> (bits - 1) else value

            product = signed(scratch[0]) * signed(scratch[1])
            truncated = signed(product)
            overflow = product != truncated
            flags = prior.rflags & ~(RFLAGS_CARRY | RFLAGS_OVERFLOW)
            if overflow:
                flags |= RFLAGS_CARRY | RFLAGS_OVERFLOW
            return replace(state, rip=following, rflags=flags | 2), None
        if operation == 'register_immediate_multiply_flags':
            following, _register, bits, immediate = detail
            mask = (1 << bits) - 1

            def signed(value):
                value = int(value) & mask
                return value - (1 << bits) if value >> (bits - 1) else value

            product = signed(scratch[0]) * signed(immediate)
            overflow = product != signed(product)
            flags = prior.rflags & ~(RFLAGS_CARRY | RFLAGS_OVERFLOW)
            if overflow:
                flags |= RFLAGS_CARRY | RFLAGS_OVERFLOW
            return replace(state, rip=following, rflags=flags | 2), None
        if operation == 'shift_result_flags':
            following, group, register, bits, amount = detail
            mask = (1 << bits) - 1
            value = int(scratch[0]) & mask
            result = state.registers[register] & mask
            if not amount:
                return replace(state, rip=following), None
            if group == 0:
                carry = result & 1
            elif group == 1:
                carry = (result >> (bits - 1)) & 1
            else:
                carry = ((value >> (bits - amount)) & 1 if group == 4
                         else (value >> (amount - 1)) & 1)
            overflow = 0
            if amount == 1 and group == 0:
                overflow = ((result >> (bits - 1)) ^ carry) & 1
            elif amount == 1 and group == 1:
                overflow = ((result >> (bits - 1))
                            ^ (result >> (bits - 2))) & 1
            elif amount == 1 and group == 4:
                overflow = ((result >> (bits - 1)) ^ carry) & 1
            elif amount == 1 and group == 5:
                overflow = (value >> (bits - 1)) & 1
            flags = (prior.rflags if group in (0, 1) else
                     _result_flags(prior.rflags, 'and', result, 0,
                                   result, bits))
            flags = ((flags | RFLAGS_CARRY) if carry
                     else (flags & ~RFLAGS_CARRY))
            flags = ((flags | RFLAGS_OVERFLOW) if overflow
                     else (flags & ~RFLAGS_OVERFLOW))
            return replace(state, rip=following, rflags=flags), None
        if operation == 'flag_control':
            following, opcode = detail
            flags = state.rflags
            if opcode == 0xfa:
                flags &= ~RFLAGS_INTERRUPT
            elif opcode == 0xfb:
                flags |= RFLAGS_INTERRUPT
            elif opcode == 0xfc:
                flags &= ~RFLAGS_DIRECTION
            else:
                flags |= RFLAGS_DIRECTION
            return replace(state, rip=following, rflags=flags | 2), None
        if operation == 'segment':
            following, segment, source = detail
            name = ('es', 'cs', 'ss', 'ds', 'fs', 'gs')[segment]
            if isinstance(source, MemoryOperand):
                value = load_virtual(
                    state, source.address(state, following), 2)
            else:
                value = state.registers[source] & 0xffff
            return replace(state, rip=following, **{name: value}), None
        if operation == 'read_segment':
            following, segment, target, bits = detail
            value = getattr(state, ('es', 'cs', 'ss', 'ds', 'fs', 'gs')[
                segment]) & 0xffff
            if isinstance(target, MemoryOperand):
                state = write_virtual(
                    state, target.address(state, following),
                    value.to_bytes(2, 'little'))
            else:
                state = replace(
                    state, registers=_write_register_operand(
                        state.registers, target, value, bits))
            return replace(state, rip=following), None
        if operation == 'register_move':
            following, destination, source, bits = detail
            value = _register_operand_value(state.registers, source, bits)
            registers = _write_register_operand(
                state.registers, destination, value, bits)
            return replace(state, registers=registers, rip=following), None
        if operation == 'register_immediate':
            following, register, bits, immediate = detail
            registers = _write_register_operand(
                state.registers, register, immediate, bits)
            return replace(state, registers=registers, rip=following), None
        if operation == 'accumulator_sign_extend':
            following, source_bits, target_bits = detail
            value = state.register('rax') & ((1 << source_bits) - 1)
            sign = 1 << (source_bits - 1)
            if value & sign:
                value -= 1 << source_bits
            registers = _write_register(
                state.registers, REGISTER_INDEX['rax'], value, target_bits)
            return replace(state, registers=registers,
                           rip=following), None
        if operation == 'accumulator_high_sign_extend':
            following, bits = detail
            sign = state.register('rax') & (1 << (bits - 1))
            value = (1 << bits) - 1 if sign else 0
            registers = _write_register(
                state.registers, REGISTER_INDEX['rdx'], value, bits)
            return replace(state, registers=registers,
                           rip=following), None
        if operation == 'register_byte_immediate':
            following, register, high_byte, immediate = detail
            if high_byte:
                register -= 4
                registers = list(state.registers)
                registers[register] = ((registers[register] & ~0xff00)
                                       | ((immediate & 0xff) << 8))
                registers = tuple(registers)
            else:
                registers = _write_register(
                    state.registers, register, immediate, 8)
            return replace(state, registers=registers, rip=following), None
        if operation == 'register_binary':
            following, name, destination, source, bits = detail
            mask = (1 << bits) - 1
            left = _register_operand_value(
                state.registers, destination, bits) & mask
            right = _register_operand_value(
                state.registers, source, bits) & mask
            carry = int(bool(state.rflags & RFLAGS_CARRY))
            result = {
                'add': left + right,
                'adc': left + right + carry,
                'sub': left - right,
                'sbb': left - right - carry,
                'and': left & right,
                'or': left | right,
                'xor': left ^ right,
            }[name] & mask
            registers = _write_register_operand(
                state.registers, destination, result, bits)
            flags = _result_flags(
                state.rflags, name, left, right, result, bits,
                carry_in=carry if name in ('adc', 'sbb') else 0)
            return replace(state, registers=registers, rip=following,
                           rflags=flags), None
        if operation == 'register_immediate_alu':
            following, name, register, bits, immediate = detail
            mask = (1 << bits) - 1
            left = _register_operand_value(
                state.registers, register, bits) & mask
            right = immediate & mask
            carry = int(bool(state.rflags & RFLAGS_CARRY))
            result = {
                'add': left + right,
                'adc': left + right + carry,
                'sub': left - right,
                'sbb': left - right - carry,
                'and': left & right,
                'or': left | right,
                'xor': left ^ right,
            }[name] & mask
            registers = _write_register_operand(
                state.registers, register, result, bits)
            flags = _result_flags(
                state.rflags, name, left, right, result, bits,
                carry_in=carry if name in ('adc', 'sbb') else 0)
            return replace(state, registers=registers, rip=following,
                           rflags=flags), None
        if operation == 'lea':
            following, register, bits, operand = detail
            value = operand.address(state, following)
            if bits == 32:
                value &= MASK32
            registers = list(state.registers)
            registers[register] = value
            return replace(state, registers=tuple(registers),
                           rip=following), None
        if operation == 'return':
            pointer = state.register('rsp')
            target = load_virtual(state, pointer, 8)
            state = state.with_register('rsp', pointer + 8)
            return replace(state, rip=target), None
        if operation == 'far_return':
            pointer = state.register('rsp')
            target = load_virtual(state, pointer, 8)
            selector = load_virtual(state, pointer + 8, 8) & 0xffff
            return replace(state, rip=target, cs=selector,
                           registers=tuple(
                               (pointer + 16) & MASK64
                               if index == REGISTER_INDEX['rsp'] else value
                               for index, value in enumerate(state.registers))), None
        if operation == 'native_far_return':
            if len(scratch) != 2:
                return state, boundary
            return replace(
                state, rip=int(scratch[0]) & MASK64,
                cs=int(scratch[1]) & 0xffff), None
        if operation == 'native_interrupt_return':
            if len(scratch) != 3:
                return state, boundary
            return replace(
                state, rip=int(scratch[0]) & MASK64,
                cs=int(scratch[1]) & 0xffff,
                ss=int(scratch[2]) & 0xffff), None
        if operation == 'interrupt_return':
            pointer = state.register('rsp')
            target = load_virtual(state, pointer, 8)
            selector = load_virtual(state, pointer + 8, 8) & 0xffff
            flags = load_virtual(state, pointer + 16, 8) | 2
            restored_stack = load_virtual(state, pointer + 24, 8)
            restored_ss = load_virtual(state, pointer + 32, 8) & 0xffff
            registers = _write_register(
                state.registers, REGISTER_INDEX['rsp'], restored_stack, 64)
            return replace(state, registers=registers, rip=target,
                           cs=selector, ss=restored_ss, rflags=flags), None
        if operation == 'exception':
            following, vector, error_code = detail
            state = replace(state, rip=int(following) & MASK64)
            return state, X86Boundary(
                'exception', (int(vector), error_code))
        if operation == 'call':
            following, target = detail
            collapsed = self._collapse_pure_call(
                state, following, target)
            if collapsed is not None:
                return collapsed, None
            pointer = (state.register('rsp') - 8) & MASK64
            state = state.with_register('rsp', pointer)
            state = write_virtual(
                state, pointer, struct.pack('<Q', following & MASK64))
            return replace(state, rip=target & MASK64), None
        if operation == 'conditional_move':
            following, condition, register, operand, bits = detail
            if not _condition(state.rflags, condition):
                return replace(state, rip=following), None
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                value = load_virtual(state, address, bits // 8)
            else:
                value = state.registers[operand]
            registers = _write_register_operand(
                state.registers, register, value, bits)
            return replace(state, registers=registers, rip=following), None
        if operation == 'push':
            following, register = detail
            value = state.registers[register] & MASK64
            pointer = (state.register('rsp') - 8) & MASK64
            state = state.with_register('rsp', pointer)
            state = write_virtual(
                state, pointer,
                struct.pack('<Q', value))
            return replace(state, rip=following), None
        if operation == 'pop':
            following, register = detail
            pointer = state.register('rsp')
            value = load_virtual(state, pointer, 8)
            registers = list(state.registers)
            registers[register] = value
            # POP first advances the architectural stack and then writes its
            # destination.  When the destination itself is RSP, that final
            # register write selects the popped stack instead of slot + 8.
            if register != REGISTER_INDEX['rsp']:
                registers[REGISTER_INDEX['rsp']] = (pointer + 8) & MASK64
            return replace(state, registers=tuple(registers),
                           rip=following), None
        if operation == 'leave':
            following, bits = detail
            width = bits // 8
            pointer = state.register('rbp')
            value = load_virtual(state, pointer, width)
            registers = _write_register(
                state.registers, REGISTER_INDEX['rbp'], value, bits)
            registers = _write_register(
                registers, REGISTER_INDEX['rsp'],
                (pointer + width) & MASK64, 64)
            return replace(state, registers=registers,
                           rip=following), None
        if operation == 'pop_operand':
            following, operand, bits = detail
            width = bits // 8
            pointer = state.register('rsp')
            value = load_virtual(state, pointer, width)
            state = state.with_register(
                'rsp', (pointer + width) & MASK64)
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                state = write_virtual(
                    state, address, value.to_bytes(width, 'little'))
            else:
                registers = _write_register_operand(
                    state.registers, operand, value, bits)
                state = replace(state, registers=registers)
            return replace(state, rip=following), None
        if operation == 'push_immediate':
            following, immediate = detail
            pointer = (state.register('rsp') - 8) & MASK64
            state = state.with_register('rsp', pointer)
            state = write_virtual(
                state, pointer, struct.pack('<Q', immediate & MASK64))
            return replace(state, rip=following), None
        if operation == 'pop_flags':
            pointer = state.register('rsp')
            flags = load_virtual(state, pointer, 8)
            state = state.with_register('rsp', pointer + 8)
            return replace(state, rip=int(detail), rflags=flags | 2), None
        if operation == 'push_flags':
            pointer = (state.register('rsp') - 8) & MASK64
            state = state.with_register('rsp', pointer)
            state = write_virtual(
                state, pointer, struct.pack('<Q', state.rflags & MASK64))
            return replace(state, rip=int(detail)), None
        if operation == 'multiply':
            following, register, operand, bits = detail
            mask = (1 << bits) - 1

            def signed(value):
                value = int(value) & mask
                return value - (1 << bits) if value >> (bits - 1) else value

            address = operand.address(state, following)
            right = load_virtual(state, address, bits // 8)
            product = signed(state.registers[register]) * signed(right)
            result = product & mask
            registers = _write_register(
                state.registers, register, result, bits)
            overflow = product != signed(result)
            flags = state.rflags & ~(RFLAGS_CARRY | RFLAGS_OVERFLOW)
            if overflow:
                flags |= RFLAGS_CARRY | RFLAGS_OVERFLOW
            return replace(state, registers=registers, rflags=flags | 2,
                           rip=following), None
        if operation == 'multiply_immediate':
            following, register, operand, bits, immediate = detail
            mask = (1 << bits) - 1

            def signed(value):
                value = int(value) & mask
                return value - (1 << bits) if value >> (bits - 1) else value

            address = operand.address(state, following)
            source = load_virtual(state, address, bits // 8)
            product = signed(source) * signed(immediate)
            result = product & mask
            registers = _write_register(
                state.registers, register, result, bits)
            overflow = product != signed(result)
            flags = state.rflags & ~(RFLAGS_CARRY | RFLAGS_OVERFLOW)
            if overflow:
                flags |= RFLAGS_CARRY | RFLAGS_OVERFLOW
            return replace(state, registers=registers, rflags=flags | 2,
                           rip=following), None
        if operation == 'set_condition':
            following, condition, operand, high_byte = detail
            value = int(_condition(state.rflags, condition))
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                state = write_virtual(state, address, bytes((value,)))
            elif high_byte:
                register = operand - 4
                registers = list(state.registers)
                registers[register] = ((registers[register] & ~0xff00)
                                       | (value << 8))
                state = replace(state, registers=tuple(registers))
            else:
                state = replace(
                    state,
                    registers=_write_register(
                        state.registers, operand, value, 8))
            return replace(state, rip=following), None
        if operation == 'immediate_alu':
            following, name, operand, bits, immediate = detail
            mask = (1 << bits) - 1
            right = immediate & mask
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                left = load_virtual(state, address, bits // 8)
            else:
                address = None
                left = _register_operand_value(
                    state.registers, operand, bits) & mask
            carry = int(bool(state.rflags & RFLAGS_CARRY))
            result = {
                'add': lambda: left + right,
                'adc': lambda: left + right + carry,
                'sub': lambda: left - right,
                'sbb': lambda: left - right - carry,
                'and': lambda: left & right,
                'or': lambda: left | right,
                'xor': lambda: left ^ right,
                'cmp': lambda: left - right,
            }[name]() & mask
            flags = _result_flags(
                state.rflags, name, left, right, result, bits,
                carry_in=carry if name in ('adc', 'sbb') else 0)
            if name == 'cmp':
                return replace(state, rip=following, rflags=flags), None
            if address is not None:
                state = write_virtual(
                    state, address, result.to_bytes(bits // 8, 'little'))
            else:
                state = replace(
                    state,
                    registers=_write_register_operand(
                        state.registers, operand, result, bits))
            return replace(state, rip=following, rflags=flags), None
        if operation == 'compare_exchange':
            following, source, operand, bits, _locked = detail
            mask = (1 << bits) - 1
            accumulator = state.register('rax') & mask
            source_value = _register_operand_value(
                state.registers, source, bits) & mask
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                destination = load_virtual(state, address, bits // 8)
            else:
                address = None
                destination = _register_operand_value(
                    state.registers, operand, bits) & mask
            result = (accumulator - destination) & mask
            flags = _result_flags(state.rflags, 'cmp', accumulator,
                                  destination, result, bits)
            if accumulator == destination:
                if address is None:
                    state = replace(
                        state,
                        registers=_write_register_operand(
                            state.registers, operand, source_value, bits))
                else:
                    state = write_virtual(
                        state, address,
                        source_value.to_bytes(bits // 8, 'little'))
            else:
                registers = _write_register(
                    state.registers, REGISTER_INDEX['rax'],
                    destination, bits)
                state = replace(state, registers=registers)
            return replace(state, rip=following, rflags=flags), None
        if operation == 'exchange_add':
            following, source, operand, bits, _locked = detail
            mask = (1 << bits) - 1
            source_value = _register_operand_value(
                state.registers, source, bits) & mask
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                destination = load_virtual(state, address, bits // 8)
            else:
                address = None
                destination = _register_operand_value(
                    state.registers, operand, bits) & mask
            result = (destination + source_value) & mask
            flags = _result_flags(state.rflags, 'add', destination,
                                  source_value, result, bits)
            registers = _write_register_operand(
                state.registers, source, destination, bits)
            state = replace(state, registers=registers)
            if address is None:
                state = replace(
                    state, registers=_write_register_operand(
                        state.registers, operand, result, bits))
            else:
                state = write_virtual(
                    state, address, result.to_bytes(bits // 8, 'little'))
            return replace(state, rip=following, rflags=flags), None
        if operation == 'compare':
            following, opcode, register, operand, bits = detail
            mask = (1 << bits) - 1
            register_value = _register_operand_value(
                state.registers, register, bits) & mask
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                operand_value = load_virtual(state, address, bits // 8)
            else:
                operand_value = _register_operand_value(
                    state.registers, operand, bits) & mask
            if opcode in (0x38, 0x39):
                left, right, name = operand_value, register_value, 'cmp'
                result = (left - right) & mask
            elif opcode in (0x3a, 0x3b):
                left, right, name = register_value, operand_value, 'cmp'
                result = (left - right) & mask
            else:
                left, right, name = register_value, operand_value, 'and'
                result = left & right
            flags = _result_flags(state.rflags, name, left, right,
                                  result, bits)
            return replace(state, rip=following, rflags=flags), None
        if operation == 'accumulator_test':
            following, bits, immediate = detail
            mask = (1 << bits) - 1
            left = state.register('rax') & mask
            right = immediate & mask
            result = left & right
            flags = _result_flags(state.rflags, 'and', left, right,
                                  result, bits)
            return replace(state, rip=following, rflags=flags), None
        if operation == 'operand_test':
            following, operand, bits, immediate = detail
            mask = (1 << bits) - 1
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                value = load_virtual(state, address, bits // 8)
            else:
                value = _register_operand_value(
                    state.registers, operand, bits) & mask
            right = immediate & mask
            result = value & right
            flags = _result_flags(state.rflags, 'and', value, right,
                                  result, bits)
            return replace(state, rip=following, rflags=flags), None
        if operation == 'memory_binary':
            following, name, reverse, register, bits, operand = detail
            mask = (1 << bits) - 1
            address = operand.address(state, following)
            memory_value = load_virtual(state, address, bits // 8)
            register_value = _register_operand_value(
                state.registers, register, bits) & mask
            left, right = ((register_value, memory_value) if reverse
                           else (memory_value, register_value))
            carry = int(bool(state.rflags & RFLAGS_CARRY))
            result = {
                'add': left + right,
                'adc': left + right + carry,
                'sub': left - right,
                'sbb': left - right - carry,
                'and': left & right,
                'or': left | right,
                'xor': left ^ right,
            }[name] & mask
            flags = _result_flags(
                state.rflags, name, left, right, result, bits,
                carry_in=carry if name in ('adc', 'sbb') else 0)
            if reverse:
                state = replace(
                    state,
                    registers=_write_register_operand(
                        state.registers, register, result, bits))
            else:
                state = write_virtual(
                    state, address, result.to_bytes(bits // 8, 'little'))
            return replace(state, rip=following, rflags=flags), None
        if operation == 'unary':
            following, group, operand, bits, instruction = detail
            mask = (1 << bits) - 1
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                value = load_virtual(state, address, bits // 8)
            else:
                address = None
                value = _register_operand_value(
                    state.registers, operand, bits) & mask
            if group == 2:
                result = value ^ mask
                flags = state.rflags
            elif group == 3:
                result = (-value) & mask
                flags = _result_flags(state.rflags, 'sub', 0, value,
                                      result, bits)
            elif group in (4, 5):
                accumulator = state.register('rax') & mask
                if group == 5:
                    sign = 1 << (bits - 1)
                    accumulator = (accumulator - (1 << bits)
                                   if accumulator & sign else accumulator)
                    multiplier = (value - (1 << bits)
                                  if value & sign else value)
                else:
                    multiplier = value
                product = accumulator * multiplier
                low = product & mask
                high = (product >> bits) & mask
                if bits == 8:
                    registers = list(state.registers)
                    registers[REGISTER_INDEX['rax']] = (
                        (registers[REGISTER_INDEX['rax']] & ~0xffff)
                        | (product & 0xffff))
                    registers = tuple(registers)
                else:
                    registers = _write_register(
                        state.registers, REGISTER_INDEX['rax'], low, bits)
                    registers = _write_register(
                        registers, REGISTER_INDEX['rdx'], high, bits)
                if group == 4:
                    overflow = high != 0
                else:
                    signed_low = low - (1 << bits) if low >> (bits - 1) else low
                    overflow = product != signed_low
                flags = state.rflags & ~(RFLAGS_CARRY | RFLAGS_OVERFLOW)
                if overflow:
                    flags |= RFLAGS_CARRY | RFLAGS_OVERFLOW
                return replace(state, registers=registers,
                               rflags=flags | 2, rip=following), None
            elif group in (6, 7):
                if bits == 8:
                    dividend = state.register('rax') & 0xffff
                else:
                    dividend = ((state.register('rdx') & mask) << bits) \
                        | (state.register('rax') & mask)
                divisor = value
                if group == 7:
                    dividend_sign = 1 << (bits * 2 - 1)
                    divisor_sign = 1 << (bits - 1)
                    if dividend & dividend_sign:
                        dividend -= 1 << (bits * 2)
                    if divisor & divisor_sign:
                        divisor -= 1 << bits
                if not divisor:
                    return replace(state, rip=instruction), X86Boundary(
                        'divide_error', instruction)
                quotient = abs(dividend) // abs(divisor)
                if (dividend < 0) != (divisor < 0):
                    quotient = -quotient
                remainder = dividend - quotient * divisor
                if group == 6:
                    valid = 0 <= quotient <= mask
                else:
                    valid = -(1 << (bits - 1)) <= quotient \
                        < (1 << (bits - 1))
                if not valid:
                    return replace(state, rip=instruction), X86Boundary(
                        'divide_error', instruction)
                if bits == 8:
                    registers = list(state.registers)
                    registers[REGISTER_INDEX['rax']] = (
                        (registers[REGISTER_INDEX['rax']] & ~0xffff)
                        | (quotient & 0xff) | ((remainder & 0xff) << 8))
                    registers = tuple(registers)
                else:
                    registers = _write_register(
                        state.registers, REGISTER_INDEX['rax'], quotient, bits)
                    registers = _write_register(
                        registers, REGISTER_INDEX['rdx'], remainder, bits)
                return replace(state, registers=registers,
                               rip=following), None
            else:
                return state, boundary
            if address is None:
                state = replace(
                    state,
                    registers=_write_register_operand(
                        state.registers, operand, result, bits))
            else:
                state = write_virtual(
                    state, address, result.to_bytes(bits // 8, 'little'))
            return replace(state, rip=following, rflags=flags), None
        if operation == 'shift':
            following, group, operand, bits, raw_amount = detail
            mask = (1 << bits) - 1
            amount = (state.register('rcx') & 0xff
                      if raw_amount is None else int(raw_amount)) & (bits - 1)
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                value = load_virtual(state, address, bits // 8)
            else:
                address = None
                value = _register_operand_value(
                    state.registers, operand, bits) & mask
            if not amount:
                return replace(state, rip=following), None
            if group == 0:
                result = ((value << amount)
                          | (value >> (bits - amount))) & mask
                carry = result & 1
                overflow = (((result >> (bits - 1)) ^ carry) & 1
                            if amount == 1 else 0)
            elif group == 1:
                result = ((value >> amount)
                          | (value << (bits - amount))) & mask
                carry = (result >> (bits - 1)) & 1
                overflow = (((result >> (bits - 1))
                             ^ (result >> (bits - 2))) & 1
                            if amount == 1 else 0)
            elif group == 4:
                result = (value << amount) & mask
                carry = (value >> (bits - amount)) & 1
                overflow = ((result >> (bits - 1)) ^ carry) if amount == 1 \
                    else 0
            elif group == 5:
                result = value >> amount
                carry = (value >> (amount - 1)) & 1
                overflow = (value >> (bits - 1)) & 1 if amount == 1 else 0
            else:
                signed = value - (1 << bits) if value & (1 << (bits - 1)) \
                    else value
                result = (signed >> amount) & mask
                carry = (value >> (amount - 1)) & 1
                overflow = 0
            flags = (state.rflags if group in (0, 1) else
                     _result_flags(state.rflags, 'and', result, 0,
                                   result, bits))
            flags = ((flags | RFLAGS_CARRY) if carry
                     else (flags & ~RFLAGS_CARRY))
            flags = ((flags | RFLAGS_OVERFLOW) if overflow
                     else (flags & ~RFLAGS_OVERFLOW))
            if address is None:
                state = replace(
                    state,
                    registers=_write_register_operand(
                        state.registers, operand, result, bits))
            else:
                state = write_virtual(
                    state, address, result.to_bytes(bits // 8, 'little'))
            return replace(state, rip=following, rflags=flags), None
        if operation == 'double_shift':
            following, direction, destination, source, bits, immediate = detail
            mask = (1 << bits) - 1
            amount = (state.register('rcx') & 0xff
                      if immediate is None else int(immediate)) & (bits - 1)
            if not amount:
                return replace(state, rip=following), None
            if isinstance(destination, MemoryOperand):
                address = destination.address(state, following)
                left = load_virtual(state, address, bits // 8) & mask
            else:
                address = None
                left = _register_operand_value(
                    state.registers, destination, bits) & mask
            right = _register_operand_value(
                state.registers, source, bits) & mask
            if direction == 'right':
                result = ((left >> amount)
                          | (right << (bits - amount))) & mask
                carry = (left >> (amount - 1)) & 1
                overflow = ((left ^ result) >> (bits - 1)) & 1
            else:
                result = ((left << amount)
                          | (right >> (bits - amount))) & mask
                carry = (left >> (bits - amount)) & 1
                overflow = ((result >> (bits - 1)) ^ carry) & 1
            flags = _result_flags(
                state.rflags, 'and', result, 0, result, bits)
            flags = ((flags | RFLAGS_CARRY) if carry
                     else (flags & ~RFLAGS_CARRY))
            if amount == 1:
                flags = ((flags | RFLAGS_OVERFLOW) if overflow
                         else (flags & ~RFLAGS_OVERFLOW))
            if address is None:
                state = replace(
                    state,
                    registers=_write_register_operand(
                        state.registers, destination, result, bits))
            else:
                state = write_virtual(
                    state, address, result.to_bytes(bits // 8, 'little'))
            return replace(state, rip=following, rflags=flags), None
        if operation == 'group_ff':
            following, group, operand, bits = detail
            mask = (1 << bits) - 1
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                value = load_virtual(state, address, bits // 8)
            else:
                address = None
                value = _register_operand_value(
                    state.registers, operand, bits) & mask
            if group in (0, 1):
                operation_name = 'add' if group == 0 else 'sub'
                result = (value + (1 if group == 0 else -1)) & mask
                flags = _result_flags(
                    state.rflags, operation_name, value, 1, result, bits,
                    preserve_carry=True)
                if address is None:
                    state = replace(
                        state,
                        registers=_write_register_operand(
                            state.registers, operand, result, bits))
                else:
                    state = write_virtual(
                        state, address, result.to_bytes(bits // 8, 'little'))
                return replace(state, rip=following, rflags=flags), None
            if group == 2:
                collapsed = self._collapse_pure_call(
                    state, following, value)
                if collapsed is not None:
                    return collapsed, None
                pointer = (state.register('rsp') - 8) & MASK64
                state = state.with_register('rsp', pointer)
                state = write_virtual(
                    state, pointer, struct.pack('<Q', following & MASK64))
                return replace(state, rip=value), None
            if group == 4:
                return replace(state, rip=value), None
            if group == 6:
                pointer = (state.register('rsp') - 8) & MASK64
                state = state.with_register('rsp', pointer)
                state = write_virtual(
                    state, pointer, struct.pack('<Q', value & MASK64))
                return replace(state, rip=following), None
            return state, boundary
        if operation == 'load_descriptor_table':
            following, name, operand = detail
            address = operand.address(state, following)
            raw = read_virtual(state, address, 10)
            limit = int.from_bytes(raw[:2], 'little')
            base = int.from_bytes(raw[2:], 'little')
            return replace(state, rip=following,
                           **{name: (base, limit)}), None
        if operation == 'store_descriptor_table':
            following, name, operand = detail
            base, limit = getattr(state, name)
            payload = struct.pack('<H', int(limit) & 0xffff) \
                + int(base & MASK64).to_bytes(8, 'little')
            state = write_virtual(
                state, operand.address(state, following), payload)
            return replace(state, rip=following), None
        if operation == 'exchange':
            following, register, operand, bits = detail
            left = _register_operand_value(
                state.registers, register, bits)
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                right = load_virtual(state, address, bits // 8)
                state = write_virtual(
                    state, address,
                    int(left).to_bytes(bits // 8, 'little'))
                registers = _write_register_operand(
                    state.registers, register, right, bits)
            else:
                right = _register_operand_value(
                    state.registers, operand, bits)
                registers = _write_register_operand(
                    state.registers, register, right, bits)
                registers = _write_register_operand(
                    registers, operand, left, bits)
            return replace(state, registers=registers, rip=following), None
        if operation in ('load_system_segment', 'store_system_segment'):
            following, name, operand = detail
            if operation == 'load_system_segment':
                if isinstance(operand, MemoryOperand):
                    value = load_virtual(
                        state, operand.address(state, following), 2)
                else:
                    value = state.registers[operand] & 0xffff
                return replace(state, rip=following,
                               **{name: value}), None
            value = getattr(state, name) & 0xffff
            if isinstance(operand, MemoryOperand):
                state = write_virtual(
                    state, operand.address(state, following),
                    value.to_bytes(2, 'little'))
            else:
                state = replace(
                    state, registers=_write_register_operand(
                        state.registers, operand, value, 16))
            return replace(state, rip=following), None
        if operation == 'invalidate_page':
            following, operand = detail
            address = operand.address(state, following)
            page = address >> 12
            for key in tuple(state.translations):
                if key[0] == page:
                    state.translations.pop(key, None)
            return replace(state, rip=following), None
        if operation == 'control_register':
            following, opcode, control, register = detail
            names = {0: 'cr0', 2: 'cr2', 3: 'cr3', 4: 'cr4', 8: 'cr8'}
            name = names.get(control)
            if name is None:
                return state, boundary
            if opcode == 0x20:
                registers = list(state.registers)
                registers[register] = getattr(state, name) & MASK64
                state = replace(state, registers=tuple(registers))
            else:
                if name in ('cr0', 'cr3', 'cr4'):
                    state.translations.clear()
                state = replace(state, **{name: state.registers[register]})
            return replace(state, rip=following), None
        if operation == 'debug_register':
            following, opcode, debug, register = detail
            if opcode == 0x21:
                registers = _write_register(
                    state.registers, register, state.debug[debug], 64)
                state = replace(state, registers=registers)
            else:
                values = list(state.debug)
                values[debug] = state.registers[register] & MASK64
                state = replace(state, debug=tuple(values))
            return replace(state, rip=following), None
        if operation in ('read_msr', 'write_msr'):
            following = int(detail)
            index = state.register('rcx') & MASK32
            values = dict(state.msrs)
            if operation == 'write_msr':
                value = ((state.register('rdx') & MASK32) << 32
                         | (state.register('rax') & MASK32))
                values[index] = value
                changes = {'efer': value} if index == 0xc0000080 else {}
                if changes:
                    state.translations.clear()
                return replace(
                    state, rip=following,
                    msrs=tuple(sorted(values.items())), **changes), None
            value = (state.efer if index == 0xc0000080
                     else values.get(index, 0))
            registers = list(state.registers)
            registers[REGISTER_INDEX['rax']] = value & MASK32
            registers[REGISTER_INDEX['rdx']] = (value >> 32) & MASK32
            return replace(state, registers=tuple(registers),
                           rip=following), None
        if operation == 'swap_gs':
            following = int(detail)
            values = dict(state.msrs)
            current = values.get(IA32_GS_BASE, 0)
            kernel = values.get(IA32_KERNEL_GS_BASE, 0)
            values[IA32_GS_BASE] = kernel
            values[IA32_KERNEL_GS_BASE] = current
            return replace(state, rip=following,
                           msrs=tuple(sorted(values.items()))), None
        if operation == 'bit_immediate':
            following, group, operand, bits, immediate = detail
            bit_index = int(immediate)
            byte_offset = (bit_index // bits) * (bits // 8)
            bit = bit_index % bits
            mask = (1 << bits) - 1
            if isinstance(operand, MemoryOperand):
                address = (operand.address(state, following)
                           + byte_offset) & MASK64
                value = load_virtual(state, address, bits // 8)
            else:
                value = state.registers[operand] & mask
            selected = 1 << bit
            carry = bool(value & selected)
            if group == 5:
                value |= selected
            elif group == 6:
                value &= ~selected
            elif group == 7:
                value ^= selected
            flags = ((state.rflags | RFLAGS_CARRY) if carry
                     else (state.rflags & ~RFLAGS_CARRY)) | 2
            if isinstance(operand, MemoryOperand):
                if group != 4:
                    state = write_virtual(
                        state, address,
                        int(value & mask).to_bytes(bits // 8, 'little'))
                return replace(state, rflags=flags, rip=following), None
            registers = _write_register(
                state.registers, operand, value, bits)
            return replace(state, registers=registers, rflags=flags,
                           rip=following), None
        if operation == 'bit_scan':
            following, register, operand, bits, reverse = detail
            mask = (1 << bits) - 1
            if isinstance(operand, MemoryOperand):
                address = operand.address(state, following)
                value = load_virtual(state, address, bits // 8)
            else:
                value = state.registers[operand] & mask
            if not value:
                return replace(
                    state, rip=following,
                    rflags=(state.rflags | RFLAGS_ZERO | 2)), None
            result = (value.bit_length() - 1 if reverse else
                      (value & -value).bit_length() - 1)
            registers = _write_register(
                state.registers, register, result, bits)
            return replace(
                state, registers=registers, rip=following,
                rflags=(state.rflags & ~RFLAGS_ZERO) | 2), None
        if operation == 'bit_register':
            following, group, operand, index_register, bits = detail
            mask = (1 << bits) - 1
            raw_index = state.registers[index_register] & mask
            if isinstance(operand, MemoryOperand):
                signed_index = (raw_index - (1 << bits)
                                if raw_index >> (bits - 1)
                                else raw_index)
                address = (operand.address(state, following)
                           + (signed_index // bits) * (bits // 8)) & MASK64
                bit = signed_index % bits
                value = load_virtual(state, address, bits // 8)
            else:
                address = None
                bit = raw_index % bits
                value = state.registers[operand] & mask
            selected = 1 << bit
            carry = bool(value & selected)
            if group == 5:
                value |= selected
            elif group == 6:
                value &= ~selected
            elif group == 7:
                value ^= selected
            flags = ((state.rflags | RFLAGS_CARRY) if carry
                     else (state.rflags & ~RFLAGS_CARRY)) | 2
            if address is not None:
                if group != 4:
                    state = write_virtual(
                        state, address,
                        int(value & mask).to_bytes(bits // 8, 'little'))
                return replace(state, rflags=flags, rip=following), None
            registers = (state.registers if group == 4 else
                         _write_register(state.registers, operand,
                                         value, bits))
            return replace(state, registers=registers, rflags=flags,
                           rip=following), None
        if operation == 'cpuid':
            leaf = state.register('rax') & MASK32
            subleaf = state.register('rcx') & MASK32
            if leaf == 0:
                values = (7, 0x756e6547, 0x6c65746e, 0x49656e69)
            elif leaf == 1:
                values = (0x000306a9, 0, CPUID_RDRAND,
                          0x07008131 | CPUID_PSE)
            elif leaf == 7 and subleaf == 0:
                values = (0, CPUID_RDSEED, 0, 0)
            elif leaf == 0x80000000:
                values = (0x80000008, 0, 0, 0)
            elif leaf == 0x80000001:
                values = (0, 0, 1, (1 << 11) | (1 << 20) | (1 << 29))
            elif leaf == 0x80000008:
                values = ((48 << 8) | 40, 0, 0, 0)
            else:
                values = (0, 0, 0, 0)
            registers = list(state.registers)
            for name, value in zip(('rax', 'rbx', 'rcx', 'rdx'), values):
                registers[REGISTER_INDEX[name]] = value & MASK32
            return replace(state, registers=tuple(registers),
                           rip=int(detail)), None
        if operation == 'fpu_init':
            # The integer machine has no live x87 data page yet.  FNINIT is
            # still an explicit state transition so that page can be added
            # without changing the decoder or the surrounding barrier ABI.
            return replace(state, rip=int(detail)), None
        if operation == 'save_fpu':
            following, operand = detail
            address = operand.address(state, following)
            state = write_virtual(state, address, _FXSAVE_RESET)
            return replace(state, rip=following), None
        if operation == 'memory_fence':
            return replace(state, rip=int(detail)), None
        if operation == 'repeat_move':
            following, width = detail
            count = state.register('rcx')
            source = state.register('rsi')
            target = state.register('rdi')
            byte_count = count * width
            if state.rflags & RFLAGS_DIRECTION:
                source_start = source - (count - 1) * width if count else source
                target_start = target - (count - 1) * width if count else target
                final_source = source - byte_count
                final_target = target - byte_count
            else:
                source_start, target_start = source, target
                final_source = source + byte_count
                final_target = target + byte_count
            if (isinstance(state.memory, MemoryCut)
                    and translate(state, source_start) == source_start
                    and translate(state, target_start, 'write') == target_start):
                state.memory.copy(source_start, target_start, byte_count)
            else:
                payload = read_virtual(state, source_start, byte_count)
                state = write_virtual(state, target_start, payload)
            registers = list(state.registers)
            registers[REGISTER_INDEX['rcx']] = 0
            registers[REGISTER_INDEX['rsi']] = final_source & MASK64
            registers[REGISTER_INDEX['rdi']] = final_target & MASK64
            return replace(state, registers=tuple(registers),
                           rip=following), None
        if operation == 'repeat_store':
            following, width = detail
            count = state.register('rcx')
            target = state.register('rdi')
            byte_count = count * width
            if state.rflags & RFLAGS_DIRECTION:
                target_start = target - (count - 1) * width if count else target
                final_target = target - byte_count
            else:
                target_start = target
                final_target = target + byte_count
            pattern = (state.register('rax')
                       & ((1 << (width * 8)) - 1)).to_bytes(width, 'little')
            if (isinstance(state.memory, MemoryCut)
                    and len(set(pattern)) == 1
                    and translate(state, target_start, 'write') == target_start):
                state.memory.fill(target_start, byte_count, pattern[0])
            else:
                state = write_virtual(state, target_start, pattern * count)
            registers = list(state.registers)
            registers[REGISTER_INDEX['rcx']] = 0
            registers[REGISTER_INDEX['rdi']] = final_target & MASK64
            return replace(state, registers=tuple(registers),
                           rip=following), None
        if operation == 'halt':
            return replace(state, rip=int(detail), halted=True), boundary
        if operation in ('port_write', 'port_write_dx'):
            if operation == 'port_write':
                following, port, width = detail
            else:
                following, width = detail
                port = state.register('rdx') & 0xffff
            value = state.register('rax') & ((1 << (width * 8)) - 1)
            return replace(state, rip=following), X86Boundary(
                'port_write', (port, width, value))
        if operation in ('port_read', 'port_read_dx'):
            if operation == 'port_read':
                following, port, width = detail
            else:
                following, width = detail
                port = state.register('rdx') & 0xffff
            return replace(state, rip=following), X86Boundary(
                'port_read', (port, width))
        if operation == 'clock':
            return state, boundary
        if operation == 'random':
            return state, boundary
        if operation == 'syscall':
            arguments = (
                state.register('rax'), state.register('rdi'),
                state.register('rsi'), state.register('rdx'),
                state.register('r10'), state.register('r8'),
                state.register('r9'), detail)
            return state, X86Boundary('syscall', arguments)
        return state, boundary

    def step(self, state, max_controls=1):
        if state.halted:
            return state, X86Boundary('halt', state.rip), WaveCost()
        try:
            block = self.block(state)
            block = self._compose_setcc_predicate_cut(state, block)
            block = self._compose_predicate_cut(state, block)
            block = self._compose_stack_cut(state, block)
            block = self._compose_register_cut(state, block)
            stacked = self._compose_stack_cut(state, block)
            block = (self._compose_register_cut(state, stacked)
                     if stacked is not block else block)
            if block.tail_return is not None:
                self.collapsed_return_branches += 1
            if block.indirect_register is not None:
                self.collapsed_indirect_calls += 1
        except PageFault as fault:
            self.last_page_fault = self._page_walk(state, fault)
            state = replace(state, cr2=fault.address)
            return state, X86Boundary('page_fault', fault), WaveCost(
                instructions=1, barriers=1)
        seen_backedges = {}
        prior = state
        try:
            state, scratch = self._execute_plan(state, block)
            if self._physical_profile is not None:
                count, work, span = self._physical_profile.get(
                    block.rip, (0, 0, 0))
                self._physical_profile[block.rip] = (
                    count + 1, work + physical_work(block.plan),
                    span + block.plan.waves.span)
                key = block.boundary.operation
                self._physical_boundary_profile[key] = \
                    self._physical_boundary_profile.get(key, 0) + 1
        except PageFault as fault:
            self.last_page_fault = self._page_walk(state, fault)
            state = replace(state, cr2=fault.address)
            return state, X86Boundary('page_fault', fault), WaveCost(
                instructions=1, barriers=1)
        controls = 1
        instructions = block.instructions
        work = physical_work(block.plan)
        span = block.plan.waves.span
        slices = int(bool(block.instructions))
        control_block = block.control_block or block
        try:
            state, boundary = self._control(
                state, block.boundary, prior, scratch, block.flag_cut)
            if (boundary is None
                    and block.boundary.operation == 'conditional_branch'):
                state = self._collapse_branch(state, control_block)
            elif boundary is None and block.boundary.operation == 'branch':
                state = self._collapse_direct_branch(state, control_block)
            if self._is_stable_backedge(
                    state, control_block, seen_backedges, boundary):
                boundary = X86Boundary('timeslice', state.rip)
            while (boundary is None
                   and instructions + controls
                   < max(1, int(max_controls))):
                following = self.blocks.get(state.rip)
                if following is None:
                    break
                following = self.block(state)
                following = self._compose_setcc_predicate_cut(
                    state, following)
                following = self._compose_predicate_cut(state, following)
                following = self._compose_stack_cut(state, following)
                following = self._compose_register_cut(state, following)
                stacked = self._compose_stack_cut(state, following)
                following = (self._compose_register_cut(state, stacked)
                             if stacked is not following else following)
                if following.tail_return is not None:
                    self.collapsed_return_branches += 1
                if following.indirect_register is not None:
                    self.collapsed_indirect_calls += 1
                control_block = following.control_block or following
                prior = state
                state, scratch = self._execute_plan(state, following)
                if self._physical_profile is not None:
                    count, work, span = self._physical_profile.get(
                        following.rip, (0, 0, 0))
                    self._physical_profile[following.rip] = (
                        count + 1, work + physical_work(following.plan),
                        span + following.plan.waves.span)
                    key = following.boundary.operation
                    self._physical_boundary_profile[key] = \
                        self._physical_boundary_profile.get(key, 0) + 1
                state, boundary = self._control(
                    state, following.boundary, prior, scratch,
                    following.flag_cut)
                controls += 1
                instructions += following.instructions
                work += physical_work(following.plan)
                span += following.plan.waves.span
                slices += int(bool(following.instructions))
                if (boundary is None
                        and following.boundary.operation
                        == 'conditional_branch'):
                    state = self._collapse_branch(state, control_block)
                elif (boundary is None
                      and following.boundary.operation == 'branch'):
                    state = self._collapse_direct_branch(
                        state, control_block)
                if self._is_stable_backedge(
                        state, control_block, seen_backedges, boundary):
                    boundary = X86Boundary('timeslice', state.rip)
        except PageFault as fault:
            self.last_page_fault = self._page_walk(state, fault)
            state = replace(state, cr2=fault.address)
            boundary = X86Boundary('page_fault', fault)
        self.threaded_controls += controls - 1
        cost = WaveCost(
            instructions=instructions + controls,
            work=work,
            span=span,
            slices=slices,
            barriers=controls)
        return state, boundary, cost

    @staticmethod
    def _page_walk(state, fault):
        entries = []
        table = state.cr3 & ADDRESS_MASK
        try:
            for shift in (39, 30, 21, 12):
                slot = (fault.address >> shift) & 0x1ff
                entry = _physical_u64(state.memory, table + slot * 8)
                entries.append((shift, table, slot, entry))
                if not entry & PRESENT or (shift in (30, 21)
                                           and entry & LARGE):
                    break
                table = entry & ADDRESS_MASK
        except PageFault:
            pass
        return (fault.address, fault.access, fault.present, tuple(entries))

    def _deliver_gate(self, state, vector, error_code=None):
        """Enter one present ring-local 64-bit interrupt gate."""
        base, limit = state.idtr
        offset = int(vector) * 16
        if not base or offset + 15 > limit:
            return None
        try:
            gate = read_virtual(state, base + offset, 16)
        except PageFault:
            return None
        attributes = gate[5]
        if not attributes & 0x80 or gate[4] & 7:
            return None
        target = (int.from_bytes(gate[0:2], 'little')
                  | (int.from_bytes(gate[6:8], 'little') << 16)
                  | (int.from_bytes(gate[8:12], 'little') << 32))
        selector = int.from_bytes(gate[2:4], 'little')
        if selector & 3 != state.cs & 3:
            return None
        pointer = state.register('rsp')
        restored_stack = pointer
        try:
            values = (state.ss, restored_stack, state.rflags,
                      state.cs, state.rip)
            if error_code is not None:
                values += (error_code,)
            for value in values:
                pointer = (pointer - 8) & MASK64
                state = write_virtual(
                    state, pointer, struct.pack('<Q', int(value) & MASK64))
        except PageFault:
            return None
        registers = _write_register(
            state.registers, REGISTER_INDEX['rsp'], pointer, 64)
        flags = state.rflags
        if attributes & 0x0f == 0x0e:
            flags &= ~RFLAGS_INTERRUPT
        return replace(state, registers=registers, rip=target,
                       cs=selector, halted=False, rflags=flags | 2)

    def _deliver_exception(self, state, vector, error_code):
        delivered = self._deliver_gate(state, vector, error_code)
        if delivered is not None:
            self.delivered_exceptions += 1
        return delivered

    def deliver_interrupt(self, state, vector):
        delivered = self._deliver_gate(state, vector)
        if delivered is not None:
            self.delivered_interrupts += 1
        return delivered

    def run(self, state, budget=1 << 20, max_blocks=None,
            clock_resolver=None):
        base_memory = state.memory
        transient = not isinstance(base_memory, MemoryCut)
        state = _X86Frame(state)
        if transient:
            state = replace(state, memory=MemoryCut(base_memory))

        def seal(current):
            return (self.publish(current) if transient
                    else _freeze_state(current))

        total = WaveCost()
        block_limit = int(budget) if max_blocks is None else int(max_blocks)
        for _unused in range(block_limit):
            if total.instructions >= int(budget):
                return seal(state), X86Boundary('timeslice', state.rip), total
            controls = (1 if max_blocks is not None else
                        min(64, int(budget) - total.instructions))
            state, boundary, cost = self.step(
                state, max_controls=max(1, controls))
            total += cost
            if (boundary is not None
                    and boundary.operation == 'page_fault'):
                fault = boundary.detail
                self.last_page_fault_rip = state.rip
                error = (int(fault.present)
                         | (2 if fault.access == 'write' else 0)
                         | (4 if state.cs & 3 else 0)
                         | (16 if fault.access == 'execute' else 0))
                delivered = self._deliver_exception(state, 14, error)
                if delivered is not None:
                    state = delivered
                    continue
            if (boundary is not None
                    and boundary.operation == 'exception'):
                vector, error_code = boundary.detail
                delivered = self._deliver_exception(
                    state, vector, error_code)
                if delivered is not None:
                    state = delivered
                    continue
            if (boundary is not None
                    and boundary.operation == 'clock'
                    and clock_resolver is not None):
                resolved = clock_resolver(state, boundary)
                if resolved is not None:
                    state, stop = resolved
                    if stop:
                        return (seal(state),
                                X86Boundary('timeslice', state.rip), total)
                    continue
            if boundary is not None:
                return seal(state), boundary, total
        return seal(state), X86Boundary('timeslice', state.rip), total

    def layout(self):
        layout = {
            'function_oracles_enabled': self.enable_function_oracles,
            'decoded_basic_blocks': self.decoded_blocks,
            'resident_basic_blocks': len(self.blocks),
            'restored_code_blocks': self.restored_code_blocks,
            'rejected_code_blocks': self.rejected_code_blocks,
            'source_instructions': self.source_instructions,
            'frontend_raw_work': self.frontend_raw_work,
            'frontend_raw_span': self.frontend_raw_span,
            'frontend_boundary_only_slices':
                self.frontend_boundary_only_slices,
            'frontend_boundaries': tuple(sorted(
                self._frontend_boundaries.items(),
                key=lambda item: (-item[1], item[0]))),
            'physical_work': self.physical_work,
            'physical_span': self.physical_span,
            'qm_removed_work':
                self.frontend_raw_work - self.physical_work,
            'qm_removed_span':
                self.frontend_raw_span - self.physical_span,
            'predicate_cuts': self.predicate_cuts,
            'resident_predicate_cuts': len(self._predicate_cuts),
            'register_cuts': self.register_cuts,
            'resident_register_cuts': len(self._register_cuts),
            'register_cut_instructions': self.register_cut_instructions,
            'register_cut_work': self.register_cut_work,
            'register_cut_span': self.register_cut_span,
            'register_cut_cache_hits': self.register_cut_cache_hits,
            'register_cut_cache_misses': self.register_cut_cache_misses,
            'predicate_cut_cache_hits': self.predicate_cut_cache_hits,
            'predicate_cut_cache_misses': self.predicate_cut_cache_misses,
            'predicate_cut_work': self.predicate_cut_work,
            'predicate_cut_span': self.predicate_cut_span,
            'recurrence_cuts': self.recurrence_cuts,
            'resident_recurrence_cuts': len(tuple(
                entry for _branch, entry in self._recurrence_cuts.values()
                if entry is not None)),
            'recurrence_cut_cache_hits': self.recurrence_cut_cache_hits,
            'recurrence_cut_cache_misses': self.recurrence_cut_cache_misses,
            'recurrence_cut_work': self.recurrence_cut_work,
            'recurrence_cut_span': self.recurrence_cut_span,
            'recurrence_cut_executions': self.recurrence_cut_executions,
            'recurrence_cut_executed_work':
                self.recurrence_cut_executed_work,
            'recurrence_cut_executed_span':
                self.recurrence_cut_executed_span,
            'recurrence_source_instructions':
                self.recurrence_source_instructions,
            'prefix_cuts': self.prefix_cuts,
            'resident_prefix_cuts': len(self._prefix_cuts),
            'prefix_cut_cache_hits': self.prefix_cut_cache_hits,
            'prefix_cut_cache_misses': self.prefix_cut_cache_misses,
            'prefix_cut_work': self.prefix_cut_work,
            'prefix_cut_span': self.prefix_cut_span,
            'prefix_cut_executions': self.prefix_cut_executions,
            'prefix_cut_executed_work': self.prefix_cut_executed_work,
            'prefix_cut_executed_span': self.prefix_cut_executed_span,
            'prefix_source_instructions':
                self.prefix_source_instructions,
            'stack_cuts': self.stack_cuts,
            'resident_stack_cuts': len(self._stack_cuts),
            'stack_cut_cache_hits': self.stack_cut_cache_hits,
            'stack_cut_cache_misses': self.stack_cut_cache_misses,
            'stack_cut_work': self.stack_cut_work,
            'stack_cut_span': self.stack_cut_span,
            'find_cuts': self.find_cuts,
            'resident_find_cuts': len(self._find_cuts),
            'find_cut_cache_hits': self.find_cut_cache_hits,
            'find_cut_cache_misses': self.find_cut_cache_misses,
            'find_cut_work': self.find_cut_work,
            'find_cut_span': self.find_cut_span,
            'find_cut_executions': self.find_cut_executions,
            'find_cut_executed_work': self.find_cut_executed_work,
            'find_cut_executed_span': self.find_cut_executed_span,
            'find_source_instructions': self.find_source_instructions,
            'copy_cuts': self.copy_cuts,
            'resident_copy_cuts': len(self._copy_cuts),
            'copy_cut_cache_hits': self.copy_cut_cache_hits,
            'copy_cut_cache_misses': self.copy_cut_cache_misses,
            'copy_cut_work': self.copy_cut_work,
            'copy_cut_span': self.copy_cut_span,
            'copy_cut_bytes': self.copy_cut_bytes,
            'copy_cut_executions': self.copy_cut_executions,
            'copy_cut_executed_work': self.copy_cut_executed_work,
            'copy_cut_executed_span': self.copy_cut_executed_span,
            'copy_source_instructions': self.copy_source_instructions,
            'direct_return_branches': self.direct_return_branches,
            'direct_return_source_instructions':
                self.direct_return_source_instructions,
            'persistent_cuts': self.persistent_cuts,
            'materialized_pages': self.materialized_pages,
            'published_pages': self.published_pages,
            'retained_cut_pages': self.retained_cut_pages,
            'forwarded_loads': self.forwarded_loads,
            'source_bytes_loaded': self.source_bytes_loaded,
            'aliased_pages': self.aliased_pages,
            'elided_pages': self.elided_pages,
            'delivered_exceptions': self.delivered_exceptions,
            'delivered_interrupts': self.delivered_interrupts,
            'last_page_fault': self.last_page_fault,
            'last_page_fault_rip': self.last_page_fault_rip,
            'collapsed_fill_bytes': self.collapsed_fill_bytes,
            'collapsed_fill_iterations': self.collapsed_fill_iterations,
            'collapsed_repeat_bytes': self.collapsed_repeat_bytes,
            'collapsed_repeat_iterations': self.collapsed_repeat_iterations,
            'collapsed_copy_bytes': self.collapsed_copy_bytes,
            'collapsed_copy_iterations': self.collapsed_copy_iterations,
            'collapsed_compare_bytes': self.collapsed_compare_bytes,
            'collapsed_compare_iterations': self.collapsed_compare_iterations,
            'collapsed_zero_scan_bytes': self.collapsed_zero_scan_bytes,
            'collapsed_zero_word_bytes': self.collapsed_zero_word_bytes,
            'collapsed_zero_word_iterations':
                self.collapsed_zero_word_iterations,
            'collapsed_affine_record_bytes':
                self.collapsed_affine_record_bytes,
            'collapsed_affine_records': self.collapsed_affine_records,
            'collapsed_relative_record_projections':
                self.collapsed_relative_record_projections,
            'collapsed_relative_projection_records':
                self.collapsed_relative_projection_records,
            'collapsed_strided_store_bytes':
                self.collapsed_strided_store_bytes,
            'collapsed_strided_store_iterations':
                self.collapsed_strided_store_iterations,
            'collapsed_record_multiply_words':
                self.collapsed_record_multiply_words,
            'collapsed_sequential_freelist_links':
                self.collapsed_sequential_freelist_links,
            'collapsed_random_freelist_links':
                self.collapsed_random_freelist_links,
            'collapsed_random_freelist_words':
                self.collapsed_random_freelist_words,
            'collapsed_search_bytes': self.collapsed_search_bytes,
            'collapsed_substring_candidates':
                self.collapsed_substring_candidates,
            'collapsed_strided_predicate_candidates':
                self.collapsed_strided_predicate_candidates,
            'collapsed_default_record_candidates':
                self.collapsed_default_record_candidates,
            'collapsed_predicate_record_projections':
                self.collapsed_predicate_record_projections,
            'collapsed_predicate_projection_records':
                self.collapsed_predicate_projection_records,
            'collapsed_dispatch_bytes': self.collapsed_dispatch_bytes,
            'collapsed_dispatch_iterations':
                self.collapsed_dispatch_iterations,
            'collapsed_byte_state_bytes':
                self.collapsed_byte_state_bytes,
            'collapsed_byte_state_controls':
                self.collapsed_byte_state_controls,
            'collapsed_byte_state_slices':
                self.collapsed_byte_state_slices,
            'collapsed_residual_bytes': self.collapsed_residual_bytes,
            'collapsed_residual_controls':
                self.collapsed_residual_controls,
            'collapsed_wrapped_byte_iterations':
                self.collapsed_wrapped_byte_iterations,
            'collapsed_wrapped_byte_coordinates':
                self.collapsed_wrapped_byte_coordinates,
            'collapsed_bit_partition_iterations':
                self.collapsed_bit_partition_iterations,
            'collapsed_strided_byte_runs':
                self.collapsed_strided_byte_runs,
            'compiled_byte_dispatches': self.compiled_byte_dispatches,
            'collapsed_indirect_search_entries':
                self.collapsed_indirect_search_entries,
            'indirect_search_cache_hits': self.indirect_search_cache_hits,
            'indirect_search_cache_misses':
                self.indirect_search_cache_misses,
            'collapsed_indirect_string_entries':
                self.collapsed_indirect_string_entries,
            'indirect_string_cache_hits': self.indirect_string_cache_hits,
            'indirect_string_cache_misses':
                self.indirect_string_cache_misses,
            'collapsed_token_candidate_bytes':
                self.collapsed_token_candidate_bytes,
            'collapsed_token_replacements':
                self.collapsed_token_replacements,
            'token_directory_cache_hits':
                self.token_directory_cache_hits,
            'token_directory_cache_misses':
                self.token_directory_cache_misses,
            'collapsed_substring_calls': self.collapsed_substring_calls,
            'substring_cache_hits': self.substring_cache_hits,
            'substring_cache_misses': self.substring_cache_misses,
            'collapsed_field_scans': self.collapsed_field_scans,
            'collapsed_field_entries': self.collapsed_field_entries,
            'field_directory_cache_hits':
                self.field_directory_cache_hits,
            'field_directory_cache_misses':
                self.field_directory_cache_misses,
            'collapsed_length_calls': self.collapsed_length_calls,
            'collapsed_compare_calls': self.collapsed_compare_calls,
            'collapsed_bounded_compare_calls':
                self.collapsed_bounded_compare_calls,
            'collapsed_bounded_compare_bytes':
                self.collapsed_bounded_compare_bytes,
            'collapsed_bit_scan_calls': self.collapsed_bit_scan_calls,
            'collapsed_bit_scan_words': self.collapsed_bit_scan_words,
            'collapsed_prefix_validator_calls':
                self.collapsed_prefix_validator_calls,
            'collapsed_prefix_validator_bytes':
                self.collapsed_prefix_validator_bytes,
            'collapsed_interval_compare_calls':
                self.collapsed_interval_compare_calls,
            'collapsed_range_table_calls':
                self.collapsed_range_table_calls,
            'collapsed_range_table_records':
                self.collapsed_range_table_records,
            'range_table_cache_hits': self.range_table_cache_hits,
            'range_table_cache_misses': self.range_table_cache_misses,
            'collapsed_range_compactions':
                self.collapsed_range_compactions,
            'collapsed_range_compaction_records':
                self.collapsed_range_compaction_records,
            'collapsed_range_compaction_live_records':
                self.collapsed_range_compaction_live_records,
            'collapsed_normalized_compare_calls':
                self.collapsed_normalized_compare_calls,
            'collapsed_normalized_compare_bytes':
                self.collapsed_normalized_compare_bytes,
            'normalized_compare_cache_hits':
                self.normalized_compare_cache_hits,
            'normalized_compare_cache_misses':
                self.normalized_compare_cache_misses,
            'collapsed_normalized_field_entries':
                self.collapsed_normalized_field_entries,
            'normalized_field_directory_hits':
                self.normalized_field_directory_hits,
            'normalized_field_directory_misses':
                self.normalized_field_directory_misses,
            'collapsed_direct_index_calls':
                self.collapsed_direct_index_calls,
            'collapsed_lane_permutation_calls':
                self.collapsed_lane_permutation_calls,
            'collapsed_lane_permutation_lanes':
                self.collapsed_lane_permutation_lanes,
            'collapsed_chacha_rounds': self.collapsed_chacha_rounds,
            'collapsed_sponge_finalize_calls':
                self.collapsed_sponge_finalize_calls,
            'collapsed_sponge_finalize_bytes':
                self.collapsed_sponge_finalize_bytes,
            'collapsed_hash_finalize_calls':
                self.collapsed_hash_finalize_calls,
            'collapsed_hash_context_bytes':
                self.collapsed_hash_context_bytes,
            'collapsed_hash_update_calls':
                self.collapsed_hash_update_calls,
            'collapsed_hash_update_bytes':
                self.collapsed_hash_update_bytes,
            'collapsed_hash_init_calls':
                self.collapsed_hash_init_calls,
            'collapsed_hash_init_bytes':
                self.collapsed_hash_init_bytes,
            'collapsed_sponge_absorb_blocks':
                self.collapsed_sponge_absorb_blocks,
            'collapsed_sponge_absorb_bytes':
                self.collapsed_sponge_absorb_bytes,
            'collapsed_sponge_mix_calls':
                self.collapsed_sponge_mix_calls,
            'collapsed_sponge_mix_rounds':
                self.collapsed_sponge_mix_rounds,
            'collapsed_modular_delta_calls':
                self.collapsed_modular_delta_calls,
            'collapsed_clock_store_returns':
                self.collapsed_clock_store_returns,
            'collapsed_entropy_measurements':
                self.collapsed_entropy_measurements,
            'collapsed_entropy_clock_events':
                self.collapsed_entropy_clock_events,
            'collapsed_entropy_memory_iterations':
                self.collapsed_entropy_memory_iterations,
            'collapsed_entropy_startup_measurements':
                self.collapsed_entropy_startup_measurements,
            'direct_index_cache_hits': self.direct_index_cache_hits,
            'direct_index_cache_misses': self.direct_index_cache_misses,
            'collapsed_memory_fill_calls':
                self.collapsed_memory_fill_calls,
            'collapsed_memory_fill_call_bytes':
                self.collapsed_memory_fill_call_bytes,
            'collapsed_memory_copy_calls':
                self.collapsed_memory_copy_calls,
            'collapsed_memory_copy_call_bytes':
                self.collapsed_memory_copy_call_bytes,
            'collapsed_void_memory_copy_calls':
                self.collapsed_void_memory_copy_calls,
            'collapsed_void_memory_copy_bytes':
                self.collapsed_void_memory_copy_bytes,
            'collapsed_text_patch_calls':
                self.collapsed_text_patch_calls,
            'collapsed_text_patch_bytes': self.collapsed_text_patch_bytes,
            'collapsed_static_call_transforms':
                self.collapsed_static_call_transforms,
            'collapsed_static_call_bytes':
                self.collapsed_static_call_bytes,
            'collapsed_static_call_tables':
                self.collapsed_static_call_tables,
            'collapsed_static_call_table_records':
                self.collapsed_static_call_table_records,
            'collapsed_seal_records': self.collapsed_seal_records,
            'collapsed_seal_bytes': self.collapsed_seal_bytes,
            'length_cache_hits': self.length_cache_hits,
            'length_cache_misses': self.length_cache_misses,
            'collapsed_btf_types': self.collapsed_btf_types,
            'btf_directory_cache_hits': self.btf_directory_cache_hits,
            'btf_directory_cache_misses': self.btf_directory_cache_misses,
            'collapsed_btf_name_searches':
                self.collapsed_btf_name_searches,
            'btf_name_index_hits': self.btf_name_index_hits,
            'btf_name_index_misses': self.btf_name_index_misses,
            'compiled_classified_scans': self.compiled_classified_scans,
            'collapsed_classified_bytes': self.collapsed_classified_bytes,
            'collapsed_record_sorts': self.collapsed_record_sorts,
            'collapsed_sort_records': self.collapsed_sort_records,
            'collapsed_sort_passes': self.collapsed_sort_passes,
            'collapsed_spin_waits': self.collapsed_spin_waits,
            'collapsed_return_branches': self.collapsed_return_branches,
            'collapsed_indirect_calls': self.collapsed_indirect_calls,
            'collapsed_return_sites': self.collapsed_return_sites,
            'collapsed_entry_nop_calls': self.collapsed_entry_nop_calls,
            'collapsed_register_projection_calls':
                self.collapsed_register_projection_calls,
            'collapsed_machine_leaf_calls':
                self.collapsed_machine_leaf_calls,
            'collapsed_page_bootmem_calls':
                self.collapsed_page_bootmem_calls,
            'collapsed_page_bootmem_records':
                self.collapsed_page_bootmem_records,
            'collapsed_store_word_calls':
                self.collapsed_store_word_calls,
            'collapsed_repeated_store_calls':
                self.collapsed_repeated_store_calls,
            'collapsed_random_u32_cache_hits':
                self.collapsed_random_u32_cache_hits,
            'collapsed_random_u32_below_calls':
                self.collapsed_random_u32_below_calls,
            'collapsed_random_u32_below_words':
                self.collapsed_random_u32_below_words,
            'collapsed_random_permutation_iterations':
                self.collapsed_random_permutation_iterations,
            'collapsed_page_record_predicates':
                self.collapsed_page_record_predicates,
            'collapsed_page_record_projection_iterations':
                self.collapsed_page_record_projection_iterations,
            'collapsed_return_bytes': self.collapsed_return_bytes,
            'collapsed_alternative_tables':
                self.collapsed_alternative_tables,
            'collapsed_alternative_entries':
                self.collapsed_alternative_entries,
            'collapsed_alternative_bytes':
                self.collapsed_alternative_bytes,
            'collapsed_smp_lock_tables': self.collapsed_smp_lock_tables,
            'collapsed_smp_lock_sites': self.collapsed_smp_lock_sites,
            'collapsed_length_prefix_entries':
                self.collapsed_length_prefix_entries,
            'collapsed_token_entries': self.collapsed_token_entries,
            'collapsed_token_bytes': self.collapsed_token_bytes,
            'collapsed_symbol_lookups': self.collapsed_symbol_lookups,
            'collapsed_symbol_resolutions':
                self.collapsed_symbol_resolutions,
            'collapsed_symbol_wrappers': self.collapsed_symbol_wrappers,
            'collapsed_ftrace_locations':
                self.collapsed_ftrace_locations,
            'collapsed_ftrace_records': self.collapsed_ftrace_records,
            'symbol_lookup_cache_hits': self.symbol_lookup_cache_hits,
            'symbol_lookup_cache_misses': self.symbol_lookup_cache_misses,
            'symbol_lookup_offset_loads': self.symbol_lookup_offset_loads,
            'symbol_offset_page_hits': self.symbol_offset_page_hits,
            'symbol_offset_page_misses': self.symbol_offset_page_misses,
            'symbol_position_directory_hits':
                self.symbol_position_directory_hits,
            'symbol_position_directory_misses':
                self.symbol_position_directory_misses,
            'symbol_name_directory_hits':
                self.symbol_name_directory_hits,
            'symbol_name_directory_misses':
                self.symbol_name_directory_misses,
            'threaded_controls': self.threaded_controls,
            'resident_state_pages': self.resident_state_pages,
            'reference_state_pages': self.reference_state_pages,
            'collapse_recipe_hits': self.collapse_recipe_hits,
            'collapse_recipe_misses': self.collapse_recipe_misses,
            'collapse_recipe_negative': self.collapse_recipe_negative,
            'collapse_recipe_attempts': self.collapse_recipe_attempts,
            'pure_call_recipe_hits': self.pure_call_recipe_hits,
            'pure_call_recipe_misses': self.pure_call_recipe_misses,
            'backward_branch_recipe_hits':
                self.backward_branch_recipe_hits,
            'code_recipe_hits': self.code_recipe_hits,
            'code_recipe_misses': self.code_recipe_misses,
            'code_recipe_negative': self.code_recipe_negative,
            'block_proof_hits': self.block_proof_hits,
            'block_proof_misses': self.block_proof_misses,
            'block_proof_unavailable': self.block_proof_unavailable,
            'block_proof_config_misses': self.block_proof_config_misses,
            'block_proof_dirty_misses': self.block_proof_dirty_misses,
            'block_proof_version_misses': self.block_proof_version_misses,
            'block_proof_fast_hits': self.block_proof_fast_hits,
            'invalidated_code_blocks': self.invalidated_code_blocks,
            'mapped_bytes': sum(len(block.mapped.data)
                                for block in self.blocks.values()),
        }
        if self._control_profile is not None:
            layout['hot_controls'] = tuple(
                (rip, operation, count)
                for (rip, operation), count in sorted(
                    self._control_profile.items(),
                    key=lambda item: (-item[1], item[0]))[:32])
            layout['hot_physical_cuts'] = tuple(
                (rip, count, work, span)
                for rip, (count, work, span) in sorted(
                    self._physical_profile.items(),
                    key=lambda item: (-item[1][1], item[0]))[:32])
            layout['physical_boundaries'] = tuple(sorted(
                self._physical_boundary_profile.items(),
                key=lambda item: (-item[1], item[0])))
            layout['hash_stream_misses'] = tuple(
                (reason, coordinate, count)
                for (reason, coordinate), count in sorted(
                    self._hash_stream_profile.items(),
                    key=lambda item: (-item[1], item[0]))[:16])
            layout['hot_call_targets'] = tuple(sorted(
                self._pure_call_profile.items(),
                key=lambda item: (-item[1], item[0]))[:24])
            layout['entropy_recurrence_misses'] = tuple(
                (reason, rip, count)
                for (reason, rip), count in sorted(
                    self._entropy_recurrence_profile.items(),
                    key=lambda item: (-item[1], item[0]))[:16])
            layout['string_compare_misses'] = tuple(
                (target, code, count)
                for (target, code), count in sorted(
                    self._string_compare_profile.items(),
                    key=lambda item: (-item[1], item[0]))[:8])
        return layout


@dataclass(frozen=True)
class X86MachineState:
    cpu: X86State
    pending: object = None
    io_ports: tuple = ()
    console_input: bytes = b''
    console_output: bytes = b''

    @property
    def stopped(self):
        return (self.cpu.halted and self.pending is None
                and not self.console_output)


class X86Machine(object):
    """Expose x86 clock and console observations through MachineEvent."""

    def __init__(self, dbt=None):
        self.dbt = X86DBT() if dbt is None else dbt
        self.affine_clock_events = 0
        self.last_cost = WaveCost()

    def start(self, cpu):
        return X86MachineState(cpu)

    @staticmethod
    def queue_console(state, payload):
        payload = bytes(payload)
        return replace(
            state, console_input=state.console_input + payload,
            cpu=replace(state.cpu, halted=False) if payload else state.cpu)

    def _answer(self, state, event):
        if state.pending is None:
            if event is not None:
                raise ValueError('x86 machine has no request to answer')
            return state
        if (event is None or event.operation != state.pending.operation
                or tuple(event.coordinate) != state.pending.coordinate):
            raise ValueError('x86 machine response does not match request')
        cpu = state.cpu
        if event.operation == 'clock':
            value = int(event.data) & MASK64
            registers = list(cpu.registers)
            registers[REGISTER_INDEX['rax']] = value & MASK32
            registers[REGISTER_INDEX['rdx']] = value >> 32
            msrs = dict(cpu.msrs)
            msrs[IA32_TIME_STAMP_COUNTER] = value
            cpu = replace(cpu, registers=tuple(registers),
                          msrs=tuple(sorted(msrs.items())),
                          rip=int(state.pending.coordinate[0]))
        elif event.operation == 'entropy':
            following, register, bits, _source = state.pending.coordinate
            if isinstance(event.data, (bytes, bytearray, memoryview)):
                value = int.from_bytes(bytes(event.data)[:bits // 8],
                                       'little')
            else:
                value = int(event.data)
            registers = _write_register(
                cpu.registers, int(register), value, int(bits))
            cleared = (RFLAGS_CARRY | RFLAGS_PARITY | RFLAGS_AUXILIARY
                       | RFLAGS_ZERO | RFLAGS_SIGN | RFLAGS_OVERFLOW)
            cpu = replace(
                cpu, registers=registers, rip=int(following),
                rflags=(cpu.rflags & ~cleared) | RFLAGS_CARRY | 2)
        elif event.operation == 'interrupt':
            vector = int(state.pending.coordinate[0])
            delivered = self.dbt.deliver_interrupt(cpu, vector)
            if delivered is None:
                raise X86Error('x86 interrupt gate %d is unavailable' % vector)
            cpu = delivered
        else:
            raise ValueError('x86 event %s is output-only' % event.operation)
        return replace(state, cpu=cpu, pending=None)

    def machine_step(self, state, event=None, budget=1 << 20,
                     max_internal=1024, clock_step=None,
                     clock_variation_bits=0):
        self.last_cost = WaveCost()
        answered_clock = (state.pending is not None
                          and event is not None
                          and event.operation == 'clock')
        if isinstance(state.cpu.memory, MemoryCut):
            if state.cpu.memory.sealed:
                state = replace(
                    state, cpu=replace(
                        state.cpu, memory=state.cpu.memory.fork()))
        else:
            state = replace(
                state, cpu=replace(
                    state.cpu, memory=MemoryCut(state.cpu.memory)))
        state = self._answer(state, event)
        if clock_step is not None and int(clock_step) <= 0:
            raise ValueError('affine clock step must be positive')
        if answered_clock:
            state = replace(
                state,
                cpu=self.dbt._collapse_clock_store_return(state.cpu))
        budget = max(1, int(budget))
        total = WaveCost()
        internal_limit = max(1, int(max_internal))
        resolved_clocks = 0

        def resolve_clock(cpu, boundary):
            nonlocal resolved_clocks
            value = advance_virtual_clock(
                dict(cpu.msrs).get(IA32_TIME_STAMP_COUNTER, 0),
                clock_step, clock_variation_bits)
            registers = list(cpu.registers)
            registers[REGISTER_INDEX['rax']] = value & MASK32
            registers[REGISTER_INDEX['rdx']] = value >> 32
            msrs = dict(cpu.msrs)
            msrs[IA32_TIME_STAMP_COUNTER] = value
            cpu = replace(
                cpu, registers=tuple(registers),
                msrs=tuple(sorted(msrs.items())),
                rip=int(boundary.detail))
            collapsed = self.dbt._collapse_entropy_recurrence(
                cpu, clock_step, clock_variation_bits)
            if collapsed is not None:
                cpu, extra_clocks = collapsed
                clock_events = int(extra_clocks) + 1
                resolved_clocks += clock_events
                self.affine_clock_events += clock_events
                return cpu, resolved_clocks >= internal_limit
            cpu = self.dbt._collapse_clock_store_return(cpu)
            resolved_clocks += 1
            self.affine_clock_events += 1
            return cpu, resolved_clocks >= internal_limit

        def publish(current):
            if isinstance(current.cpu.memory, MemoryCut):
                current = replace(
                    current, cpu=self.dbt.retain(current.cpu))
            return current

        def idle(current):
            self.last_cost = total
            if current.console_output:
                payload = current.console_output
                current = replace(current, console_output=b'')
                return publish(current), MachineEvent(
                    'console_write', data=payload, cost=total)
            return current, None

        def emit_console(current):
            self.last_cost = total
            payload = current.console_output
            current = replace(current, console_output=b'')
            return publish(current), MachineEvent(
                'console_write', data=payload, cost=total)

        for _unused in range(internal_limit):
            remaining = max(1, budget - total.instructions)
            cpu, boundary, cost = self.dbt.run(
                state.cpu, budget=remaining,
                clock_resolver=(resolve_clock
                                if clock_step is not None else None))
            total += cost
            state = replace(state, cpu=cpu, pending=None)
            if boundary.operation == 'clock':
                request = MachineEvent(
                    'clock', (int(boundary.detail),), cost=total)
                if clock_step is not None:
                    value = advance_virtual_clock(
                        dict(cpu.msrs).get(IA32_TIME_STAMP_COUNTER, 0),
                        clock_step, clock_variation_bits)
                    state = self._answer(
                        replace(state, pending=request),
                        MachineEvent('clock', request.coordinate, value))
                    state = replace(
                        state,
                        cpu=self.dbt._collapse_clock_store_return(state.cpu))
                    self.affine_clock_events += 1
                    if total.instructions >= budget:
                        return idle(state)
                    continue
                return publish(replace(state, pending=request)), request
            if boundary.operation == 'random':
                following, register, bits, source = boundary.detail
                request = MachineEvent(
                    'entropy', (int(following), int(register),
                                int(bits), int(source)), cost=total)
                return publish(replace(state, pending=request)), request
            if boundary.operation == 'port_read':
                port, width = boundary.detail
                io = dict(state.io_ports)
                line_control = io.get(0x3fb, 0)
                incoming = state.console_input
                if port == 0x3fd and width == 1:
                    value = 0x60 | int(bool(incoming))
                elif port == 0x3fa and width == 1:
                    value = 1
                elif port == 0x3fe and width == 1:
                    value = 0xb0
                elif port in (0x20, 0xa0) and width == 1:
                    value = 0
                elif port in (0x21, 0xa1) and width == 1:
                    value = io.get(port, 0xff)
                elif port == 0x42 and width == 1:
                    counter = (io.get(_PIT_COUNTER, 0xffff) - 0x100) & 0xffff
                    phase = io.get(_PIT_READ_PHASE, 0) & 1
                    value = (counter >> (phase * 8)) & 0xff
                    io[_PIT_COUNTER] = counter
                    io[_PIT_READ_PHASE] = phase ^ 1
                elif port == 0x71 and width == 1:
                    register = io.get(_CMOS_INDEX, 0) & 0x7f
                    value = io.get(
                        _CMOS_REGISTER_BASE + register,
                        _CMOS_RESET.get(register, 0))
                elif (port == 0x3f8 and width == 1
                      and not line_control & 0x80):
                    value = incoming[0] if incoming else 0
                    incoming = incoming[1:] if incoming else incoming
                else:
                    value = io.get(port, (1 << (width * 8)) - 1)
                registers = _write_register(
                    cpu.registers, REGISTER_INDEX['rax'], value, width * 8)
                state = replace(
                    state, cpu=replace(cpu, registers=registers),
                    console_input=incoming,
                    io_ports=tuple(sorted(io.items())))
                if total.instructions >= budget:
                    return idle(state)
                continue
            if boundary.operation == 'port_write':
                port, width, value = boundary.detail
                io = dict(state.io_ports)
                if port == 0xe9 and width == 1:
                    state = replace(
                        state, console_output=(
                            state.console_output + bytes((value & 0xff,))))
                elif port == 0x43 and width == 1:
                    io[port] = value & 0xff
                    if value & 0xc0 == 0x80 and value & 0x30 == 0x30:
                        io[_PIT_WRITE_PHASE] = 0
                        io[_PIT_READ_PHASE] = 0
                    state = replace(
                        state, io_ports=tuple(sorted(io.items())))
                elif port == 0x42 and width == 1:
                    if io.get(_PIT_WRITE_PHASE, 0) == 0:
                        io[_PIT_LOW_LATCH] = value & 0xff
                        io[_PIT_WRITE_PHASE] = 1
                    else:
                        io[_PIT_COUNTER] = (io.get(_PIT_LOW_LATCH, 0)
                                            | ((value & 0xff) << 8))
                        io[_PIT_WRITE_PHASE] = 0
                        io[_PIT_READ_PHASE] = 0
                    state = replace(
                        state, io_ports=tuple(sorted(io.items())))
                elif port == 0x61 and width == 1:
                    io[port] = value & 0xff
                    state = replace(
                        state, io_ports=tuple(sorted(io.items())))
                elif port in (0x20, 0xa0) and width == 1:
                    # Initialization and EOI commands affect controller
                    # sequencing, not the readable interrupt mask.
                    pass
                elif port in (0x21, 0xa1) and width == 1:
                    io[port] = value & 0xff
                    state = replace(
                        state, io_ports=tuple(sorted(io.items())))
                elif port == 0x70 and width == 1:
                    io[_CMOS_INDEX] = value & 0x7f
                    state = replace(
                        state, io_ports=tuple(sorted(io.items())))
                elif port == 0x71 and width == 1:
                    register = io.get(_CMOS_INDEX, 0) & 0x7f
                    io[_CMOS_REGISTER_BASE + register] = value & 0xff
                    state = replace(
                        state, io_ports=tuple(sorted(io.items())))
                elif 0x3f8 <= port <= 0x3ff and width == 1:
                    if port == 0x3f8 and not io.get(0x3fb, 0) & 0x80:
                        state = replace(
                            state, console_output=(
                                state.console_output
                                + bytes((value & 0xff,))))
                    else:
                        io[port] = value & 0xff
                        state = replace(
                            state, io_ports=tuple(sorted(io.items())))
                if (state.console_output
                        and (state.console_output[-1] == 10
                             or len(state.console_output) >= 256)):
                    return emit_console(state)
                if total.instructions >= budget:
                    return idle(state)
                continue
            if boundary.operation in ('halt', 'timeslice'):
                io = dict(state.io_ports)
                if (cpu.rflags & RFLAGS_INTERRUPT
                        and not io.get(0x21, 0xff) & 1):
                    request = MachineEvent('interrupt', (0x30,), cost=total)
                    return publish(replace(state, pending=request)), request
                if boundary.operation == 'halt':
                    if state.console_output:
                        return idle(state)
                    self.last_cost = total
                    return publish(state), None
                return idle(state)
            return publish(state), boundary
        return idle(state)


def machine_step(runtime, state, event=None, **options):
    return runtime.machine_step(state, event, **options)
