"""Rebuildable physical-page delivery with quotient and erasure layers.

This module is deliberately below a guest VFS.  Its coordinate is an object
generation and a physical page number; path names and inode caches remain in
Linux.  A fabric is a disposable delivery projection of one authenticated
object, never a second semantic artifact or a local codebook.

The four layers are:

* the authenticated canonical object identity;
* a dense logical-page to unique-page quotient directory;
* systematic Reed-Solomon shards that may live in unrelated stores; and
* a direct resident unique-page array, above which the machine keeps COW pages.

Hashing is used while constructing the quotient and while admitting bytes from
untrusted storage.  A hot page lookup is two integer operations and an array
read; identical logical pages share one resident bytes object.
"""

from dataclasses import dataclass
from collections.abc import MutableMapping
import hashlib
import hmac
import json
from pathlib import Path
import struct
import zlib


class PageFabricError(ValueError):
    """A physical projection or one of its supplied shards is invalid."""


MANIFEST_MAGIC = b'PGF1'
MANIFEST_VERSION = 1
_MANIFEST_HEADER = struct.Struct('<4sHH32sQQIIHH32sI')
BUNDLE_MAGIC = b'PGB1'
BUNDLE_VERSION = 4
_BUNDLE_HEADER = struct.Struct('<4sHHIII')
_BUNDLE_RECORD = struct.Struct('<IHII32s')
_BUNDLE_PROOF = struct.Struct('<BI32s')
CIPHERTEXT_FRAME_VERSION = 1
STORAGE_PROTOCOL_VERSION = 1
STORAGE_ALGORITHM_AES_256_GCM = 1
_CIPHERTEXT_FRAME = struct.Struct('<BII32s')
ROW_AAD_DOMAIN = b'physical ciphertext row v1\0'
ROW_LOCATOR_DOMAIN = b'opaque physical row locator v1\0'
ROW_AUTH_DOMAIN = b'authenticated stored row v1\0'
_ROW_AAD = struct.Struct('<II32s32sQIHIIIBII')
_CIPHERTEXT_DIRECTORY_MAGIC = b'CTD1'
_CIPHERTEXT_DIRECTORY_HEADER = struct.Struct('<4sHH32s32sQQIIIIII')
_CIPHERTEXT_RANK_RECORD = struct.Struct('<IHBBI')
_CIPHERTEXT_GROUP = struct.Struct('<HHIII')
_CIPHERTEXT_GEOMETRY = struct.Struct('<HHII')
_U64_MAX = (1 << 64) - 1


def _sha256(payload):
    return hashlib.sha256(payload).digest()


def encode_ciphertext_frame(codec, canonical_extent, digest, encoded):
    """Encode the one plaintext frame accepted after an AEAD open."""
    codec, canonical_extent = int(codec), int(canonical_extent)
    digest, encoded = bytes(digest), bytes(encoded)
    if codec < 0 or codec > 255:
        raise ValueError('ciphertext frame codec is invalid')
    if canonical_extent <= 0 or canonical_extent > 0xFFFFFFFF:
        raise ValueError('ciphertext frame canonical extent is invalid')
    if len(encoded) > 0xFFFFFFFF or len(digest) != 32:
        raise ValueError('ciphertext frame payload identity is invalid')
    return _CIPHERTEXT_FRAME.pack(
        codec, canonical_extent, len(encoded), digest) + encoded


def decode_ciphertext_frame(padded):
    """Parse authenticated plaintext and reject non-canonical padding."""
    padded = bytes(padded)
    if len(padded) < _CIPHERTEXT_FRAME.size:
        raise PageFabricError('ciphertext frame is truncated')
    codec, canonical_extent, encoded_extent, digest = \
        _CIPHERTEXT_FRAME.unpack_from(padded)
    end = _CIPHERTEXT_FRAME.size + encoded_extent
    if (not canonical_extent or end > len(padded)
            or any(padded[end:])):
        raise PageFabricError('ciphertext frame extent or padding is invalid')
    return codec, canonical_extent, bytes(digest), padded[
        _CIPHERTEXT_FRAME.size:end]


def encode_ciphertext_row_aad(object_salt, object_digest, generation, group,
                              slot, row_class, capacity, codec,
                              canonical_extent, encoded_extent,
                              algorithm=STORAGE_ALGORITHM_AES_256_GCM):
    """Canonical associated data binding a data row to one physical cut."""
    object_salt, object_digest = bytes(object_salt), bytes(object_digest)
    values = tuple(int(value) for value in (
        generation, group, slot, row_class, capacity, algorithm, codec,
        canonical_extent, encoded_extent))
    if (len(object_salt) != 32 or len(object_digest) != 32 or values[0] < 0
            or values[0] > _U64_MAX
            or values[1] < 0 or values[1] > 0xFFFFFFFF
            or values[2] < 0 or values[2] > 0xFFFF
            or values[3] < 0 or values[3] > 0xFFFFFFFF
            or values[4] <= 0 or values[4] > 0xFFFFFFFF
            or values[5] != STORAGE_ALGORITHM_AES_256_GCM
            or values[6] < 0 or values[6] > 0xFF
            or values[7] <= 0 or values[7] > 0xFFFFFFFF
            or values[8] < 0 or values[8] > 0xFFFFFFFF):
        raise ValueError('ciphertext row associated-data coordinate is invalid')
    generation, group, slot, row_class, capacity, algorithm, codec, \
        canonical_extent, encoded_extent = values
    return ROW_AAD_DOMAIN + _ROW_AAD.pack(
        STORAGE_PROTOCOL_VERSION, algorithm, object_salt, object_digest,
        generation, group, slot, row_class, capacity,
        CIPHERTEXT_FRAME_VERSION, codec, canonical_extent, encoded_extent)


def opaque_row_locator(index_key, volume_id, object_salt, object_digest,
                       generation, group, slot):
    """Hide plaintext object identities from storage lookup coordinates."""
    index_key, volume_id, object_salt, object_digest = (
        bytes(index_key), bytes(volume_id), bytes(object_salt),
        bytes(object_digest))
    generation, group, slot = int(generation), int(group), int(slot)
    if (len(index_key) < 32 or len(volume_id) != 16 or len(object_salt) != 32
            or len(object_digest) != 32):
        raise ValueError('opaque row locator key or volume is invalid')
    if (generation < 0 or generation > _U64_MAX
            or group < 0 or group > 0xFFFFFFFF
            or slot < 0 or slot > 0xFFFF):
        raise ValueError('opaque row locator coordinate is invalid')
    coordinate = (ROW_LOCATOR_DOMAIN + volume_id + object_salt + object_digest
                  + struct.pack('<QIH', generation, group, slot))
    return hmac.new(index_key, coordinate, hashlib.sha256).digest()


def stored_row_authenticator(auth_key, locator, row):
    """Return the 128-bit keyed pre-reconstruction row authenticator."""
    auth_key, locator, row = bytes(auth_key), bytes(locator), bytes(row)
    if len(auth_key) < 32 or len(locator) != 32:
        raise ValueError('stored row authenticator key or locator is invalid')
    return hmac.new(
        auth_key, ROW_AUTH_DOMAIN + locator + row,
        hashlib.sha256).digest()[:16]


def _gf_mul(left, right):
    value = 0
    left, right = int(left), int(right)
    while right:
        if right & 1:
            value ^= left
        right >>= 1
        left <<= 1
        if left & 0x100:
            left ^= 0x11d
    return value


def _gf_pow(value, exponent):
    result = 1
    while exponent:
        if exponent & 1:
            result = _gf_mul(result, value)
        value = _gf_mul(value, value)
        exponent >>= 1
    return result


def _matrix_multiply(left, right):
    columns = len(right[0])
    return [[
        _xor_products(left[row], [right[index][column]
                                  for index in range(len(right))])
        for column in range(columns)
    ] for row in range(len(left))]


def _xor_products(left, right):
    value = 0
    for first, second in zip(left, right):
        value ^= _gf_mul(first, second)
    return value


def _matrix_inverse(matrix):
    size = len(matrix)
    work = [list(values) + [int(row == column)
                            for column in range(size)]
            for row, values in enumerate(matrix)]
    for column in range(size):
        pivot = next((row for row in range(column, size)
                      if work[row][column]), None)
        if pivot is None:
            raise PageFabricError('erasure matrix is singular')
        work[column], work[pivot] = work[pivot], work[column]
        inverse = _gf_pow(work[column][column], 254)
        work[column] = [_gf_mul(value, inverse)
                        for value in work[column]]
        for row in range(size):
            if row == column:
                continue
            scale = work[row][column]
            if scale:
                work[row] = [value ^ _gf_mul(scale, pivot_value)
                             for value, pivot_value in
                             zip(work[row], work[column])]
    return [row[size:] for row in work]


def _generator(data_shards, parity_shards):
    count = data_shards + parity_shards
    if data_shards <= 0 or parity_shards <= 0 or count > 255:
        raise ValueError('erasure geometry needs 1..254 total shards')
    vandermonde = [[_gf_pow(row + 1, column)
                    for column in range(data_shards)]
                   for row in range(count)]
    return tuple(tuple(row) for row in _matrix_multiply(
        vandermonde, _matrix_inverse(vandermonde[:data_shards])))


@dataclass(frozen=True)
class ErasureRecoveryDirectory:
    """Direct recovery coefficients for one small systematic RS geometry.

    A mask names the authenticated shards that survived. Construction maps
    every mask containing exactly ``data_shards`` bits to a compact ordinal;
    the hot lookup is one indexed load followed by one fixed-stride slice.
    Matrix inversion is therefore absent from page recovery.
    """

    data_shards: int
    parity_shards: int
    ordinal_by_mask: tuple
    coefficients: bytes
    generator: bytes

    def __post_init__(self):
        data, parity = int(self.data_shards), int(self.parity_shards)
        total = data + parity
        if data <= 0 or parity <= 0 or total > 16:
            raise ValueError('direct erasure geometry needs 2..16 total shards')
        if len(self.ordinal_by_mask) != 1 << total:
            raise ValueError('erasure mask directory has the wrong extent')
        valid = [mask for mask in range(1 << total)
                 if mask.bit_count() == data]
        if [self.ordinal_by_mask[mask] for mask in valid] != list(range(len(valid))):
            raise ValueError('erasure mask ordinals are not canonical')
        if any(self.ordinal_by_mask[mask] != -1
               for mask in range(1 << total) if mask.bit_count() != data):
            raise ValueError('invalid erasure masks must not name coefficients')
        if len(self.coefficients) != len(valid) * data * data:
            raise ValueError('erasure coefficient directory has the wrong extent')
        expected_generator = bytes(
            value for row in _generator(data, parity) for value in row)
        if bytes(self.generator) != expected_generator:
            raise ValueError('erasure generator is not canonical')

    def for_target(self, available_mask, target):
        available_mask, target = int(available_mask), int(target)
        if (available_mask < 0
                or available_mask >= len(self.ordinal_by_mask)
                or target < 0 or target >= self.data_shards):
            raise IndexError('erasure recovery coordinate is outside the directory')
        ordinal = self.ordinal_by_mask[available_mask]
        if ordinal < 0:
            raise ValueError('recovery needs exactly data_shards available rows')
        start = (ordinal * self.data_shards + target) * self.data_shards
        return self.coefficients[start:start + self.data_shards]


def build_erasure_recovery_directory(data_shards=8, parity_shards=2):
    """Materialize every matrix inverse for a bounded delivery geometry."""
    data, parity = int(data_shards), int(parity_shards)
    total = data + parity
    if data <= 0 or parity <= 0 or total > 16:
        raise ValueError('direct erasure geometry needs 2..16 total shards')
    generator = _generator(data, parity)
    ordinal_by_mask = [-1] * (1 << total)
    coefficients = bytearray()
    ordinal = 0
    for mask in range(1 << total):
        if mask.bit_count() != data:
            continue
        slots = [slot for slot in range(total) if mask & (1 << slot)]
        inverse = _matrix_inverse([generator[slot] for slot in slots])
        ordinal_by_mask[mask] = ordinal
        for target in range(data):
            coefficients.extend(inverse[target])
        ordinal += 1
    return ErasureRecoveryDirectory(
        data, parity, tuple(ordinal_by_mask), bytes(coefficients),
        bytes(value for row in generator for value in row))


@dataclass(frozen=True)
class CiphertextRankRecord:
    group: int
    slot: int
    codec: int
    encoded_extent: int


@dataclass(frozen=True)
class CiphertextGroup:
    data_shards: int
    parity_shards: int
    row_class: int
    capacity: int
    locators: tuple


@dataclass(frozen=True)
class CiphertextDirectory:
    """Authenticated plaintext of one encrypted direct-page directory."""

    object_salt: bytes
    object_digest: bytes
    generation: int
    length: int
    page_bytes: int
    quantum: int
    ranks: tuple
    rows: tuple
    groups: tuple
    geometries: tuple
    algorithm: int = STORAGE_ALGORITHM_AES_256_GCM

    def __post_init__(self):
        salt, digest = bytes(self.object_salt), bytes(self.object_digest)
        generation, length = int(self.generation), int(self.length)
        page_bytes, quantum = int(self.page_bytes), int(self.quantum)
        if (len(salt) != 32 or len(digest) != 32
                or generation < 0 or generation > _U64_MAX
                or length < 0 or length > _U64_MAX
                or page_bytes <= 0 or page_bytes > 0xFFFFFFFF
                or quantum <= 0 or quantum > 0xFFFFFFFF
                or quantum & (quantum - 1)
                or int(self.algorithm) != STORAGE_ALGORITHM_AES_256_GCM):
            raise ValueError('ciphertext directory identity is invalid')
        if len(self.ranks) != ((length + page_bytes - 1) // page_bytes):
            raise ValueError('ciphertext logical page extent is invalid')
        rank_count = len(self.rows)
        ranks = tuple(int(rank) for rank in self.ranks)
        if (any(rank < 0 or rank > rank_count for rank in ranks)
                or set(ranks) - {0} != set(range(1, rank_count + 1))):
            raise ValueError('ciphertext logical ranks are not a quotient')

        expected_coordinates = set()
        previous_capacity = 0
        geometries = set()
        for group_index, group in enumerate(self.groups):
            if not isinstance(group, CiphertextGroup):
                raise TypeError('ciphertext group has the wrong type')
            data, parity = int(group.data_shards), int(group.parity_shards)
            row_class, capacity = int(group.row_class), int(group.capacity)
            if (data <= 0 or parity <= 0 or data + parity > 16
                    or row_class <= 0 or capacity != row_class * quantum
                    or capacity < previous_capacity
                    or len(group.locators) != data + parity
                    or any(len(bytes(locator)) != 32
                           for locator in group.locators)):
                raise ValueError('ciphertext group is not canonical')
            previous_capacity = capacity
            expected_coordinates.update(
                (group_index, slot) for slot in range(data))
            geometries.add((data, parity))
        if sum(group.data_shards for group in self.groups) != rank_count:
            raise ValueError('ciphertext group data extent is invalid')

        seen = set()
        for row in self.rows:
            if not isinstance(row, CiphertextRankRecord):
                raise TypeError('ciphertext rank record has the wrong type')
            group, slot = int(row.group), int(row.slot)
            if group < 0 or group >= len(self.groups):
                raise ValueError('ciphertext rank group is invalid')
            group_record = self.groups[group]
            if (slot < 0 or slot >= group_record.data_shards
                    or int(row.codec) < 0 or int(row.codec) > 1
                    or int(row.encoded_extent) < 0
                    or int(row.encoded_extent) + _CIPHERTEXT_FRAME.size
                    > group_record.capacity):
                raise ValueError('ciphertext rank record is invalid')
            seen.add((group, slot))
        if seen != expected_coordinates or len(seen) != rank_count:
            raise ValueError('ciphertext rank coordinates are not a bijection')

        geometry_keys = tuple(
            (geometry.data_shards, geometry.parity_shards)
            for geometry in self.geometries)
        if (geometry_keys != tuple(sorted(geometries))
                or any(not isinstance(geometry, ErasureRecoveryDirectory)
                       for geometry in self.geometries)):
            raise ValueError('ciphertext recovery geometries are not canonical')


def dump_ciphertext_directory(directory):
    """Encode the unique fixed-width plaintext later sealed as metadata."""
    if not isinstance(directory, CiphertextDirectory):
        raise TypeError('expected a CiphertextDirectory')
    output = bytearray(_CIPHERTEXT_DIRECTORY_HEADER.pack(
        _CIPHERTEXT_DIRECTORY_MAGIC, STORAGE_PROTOCOL_VERSION,
        directory.algorithm, directory.object_salt, directory.object_digest,
        directory.generation, directory.length, directory.page_bytes,
        directory.quantum, len(directory.ranks), len(directory.rows),
        len(directory.groups), len(directory.geometries)))
    for rank in directory.ranks:
        output += struct.pack('<I', rank)
    for row in directory.rows:
        output += _CIPHERTEXT_RANK_RECORD.pack(
            row.group, row.slot, row.codec, 0, row.encoded_extent)
    for group in directory.groups:
        output += _CIPHERTEXT_GROUP.pack(
            group.data_shards, group.parity_shards, group.row_class,
            group.capacity, len(group.locators))
        output += b''.join(bytes(locator) for locator in group.locators)
    for geometry in directory.geometries:
        output += _CIPHERTEXT_GEOMETRY.pack(
            geometry.data_shards, geometry.parity_shards,
            len(geometry.ordinal_by_mask), len(geometry.coefficients))
        output += geometry.generator
        output += struct.pack(
            '<%dh' % len(geometry.ordinal_by_mask),
            *geometry.ordinal_by_mask)
        output += geometry.coefficients
    return bytes(output)


def load_ciphertext_directory(payload):
    """Decode exact authenticated metadata and reject trailing spellings."""
    payload = bytes(payload)
    if len(payload) < _CIPHERTEXT_DIRECTORY_HEADER.size:
        raise PageFabricError('ciphertext directory is truncated')
    (magic, version, algorithm, salt, digest, generation, length,
     page_bytes, quantum, logical_count, rank_count, group_count,
     geometry_count) = _CIPHERTEXT_DIRECTORY_HEADER.unpack_from(payload)
    if (magic != _CIPHERTEXT_DIRECTORY_MAGIC
            or version != STORAGE_PROTOCOL_VERSION):
        raise PageFabricError('ciphertext directory format is invalid')
    at = _CIPHERTEXT_DIRECTORY_HEADER.size

    def take(size):
        nonlocal at
        end = at + int(size)
        if end < at or end > len(payload):
            raise PageFabricError('ciphertext directory is truncated')
        value = payload[at:end]
        at = end
        return value

    ranks = struct.unpack('<%dI' % logical_count, take(logical_count * 4)) \
        if logical_count else ()
    rows = []
    for _ in range(rank_count):
        group, slot, codec, reserved, encoded_extent = \
            _CIPHERTEXT_RANK_RECORD.unpack(take(
                _CIPHERTEXT_RANK_RECORD.size))
        if reserved:
            raise PageFabricError('ciphertext rank reserved field is nonzero')
        rows.append(CiphertextRankRecord(
            group, slot, codec, encoded_extent))
    groups = []
    for _ in range(group_count):
        data, parity, row_class, capacity, locator_count = \
            _CIPHERTEXT_GROUP.unpack(take(_CIPHERTEXT_GROUP.size))
        locators = tuple(take(32) for _ in range(locator_count))
        groups.append(CiphertextGroup(
            data, parity, row_class, capacity, locators))
    geometries = []
    for _ in range(geometry_count):
        data, parity, mask_count, coefficient_count = \
            _CIPHERTEXT_GEOMETRY.unpack(take(_CIPHERTEXT_GEOMETRY.size))
        generator = take((data + parity) * data)
        ordinals = struct.unpack(
            '<%dh' % mask_count, take(mask_count * 2)) \
            if mask_count else ()
        coefficients = take(coefficient_count)
        geometries.append(ErasureRecoveryDirectory(
            data, parity, ordinals, coefficients, generator))
    if at != len(payload):
        raise PageFabricError('ciphertext directory has trailing bytes')
    try:
        return CiphertextDirectory(
            salt, digest, generation, length, page_bytes, quantum,
            ranks, tuple(rows), tuple(groups), tuple(geometries), algorithm)
    except (TypeError, ValueError) as error:
        raise PageFabricError(str(error)) from error


_MULTIPLIERS = {}


def _multiplier(coefficient):
    table = _MULTIPLIERS.get(coefficient)
    if table is None:
        table = bytes(_gf_mul(coefficient, value) for value in range(256))
        _MULTIPLIERS[coefficient] = table
    return table


def _combine(coefficients, shards, size):
    output = bytearray(size)
    for coefficient, shard in zip(coefficients, shards):
        if not coefficient:
            continue
        if coefficient == 1:
            for index, value in enumerate(shard):
                output[index] ^= value
        else:
            table = _multiplier(coefficient)
            for index, value in enumerate(shard):
                output[index] ^= table[value]
    return bytes(output)


def _encode_payload(raw):
    # The zlib wrapper is intentional: browsers can decode the exact wire
    # payload with DecompressionStream('deflate') without a second codec.
    stream = zlib.compressobj(9, zlib.DEFLATED)
    compressed = stream.compress(raw) + stream.flush()
    if len(compressed) < len(raw):
        return b'\x01' + compressed
    return b'\x00' + raw


def _decode_payload(payload, size):
    payload = bytes(payload)
    if not payload:
        raise PageFabricError('empty physical shard')
    if payload[0] == 0:
        raw = payload[1:]
    elif payload[0] == 1:
        try:
            raw = zlib.decompress(payload[1:])
        except zlib.error as error:
            raise PageFabricError('compressed physical shard is invalid') \
                from error
    else:
        raise PageFabricError('physical shard codec is unknown')
    if len(raw) != size:
        raise PageFabricError('physical shard has the wrong extent')
    return raw


def _uleb(value):
    value = int(value)
    if value < 0:
        raise ValueError('unsigned coordinate cannot be negative')
    output = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        output.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(output)


def _read_uleb(data, offset):
    start = offset
    value = 0
    shift = 0
    while offset < len(data) and shift <= 63:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            if bytes(data[start:offset]) != _uleb(value):
                raise PageFabricError('page directory integer is not canonical')
            return value, offset
        shift += 7
    raise PageFabricError('page directory integer is truncated')


def _leaf_digest(raw):
    return _sha256(b'\x00' + raw)


def _parent_digest(left, right):
    return _sha256(b'\x01' + left + right)


def _merkle_records(raw_shards):
    """Return one root and an inclusion path for every physical shard."""
    count = len(raw_shards)
    if not count:
        return _sha256(b'empty-page-fabric'), ()
    width = 1 << (count - 1).bit_length()
    empty = _leaf_digest(b'')
    levels = [tuple([_leaf_digest(raw) for raw in raw_shards]
                    + [empty] * (width - count))]
    while len(levels[-1]) > 1:
        previous = levels[-1]
        levels.append(tuple(
            _parent_digest(previous[index], previous[index + 1])
            for index in range(0, len(previous), 2)))
    proofs = []
    for position in range(count):
        cursor = position
        proof = []
        for level in levels[:-1]:
            proof.append(level[cursor ^ 1])
            cursor >>= 1
        proofs.append(tuple(proof))
    return levels[-1][0], tuple(proofs)


def _verify_merkle(raw, position, count, proof, root):
    if count <= 0 or position < 0 or position >= count:
        return False
    expected = (count - 1).bit_length()
    if len(proof) != expected or any(len(item) != 32 for item in proof):
        return False
    digest = _leaf_digest(raw)
    cursor = position
    for sibling in proof:
        digest = (_parent_digest(sibling, digest) if cursor & 1
                  else _parent_digest(digest, sibling))
        cursor >>= 1
    return digest == root


@dataclass(frozen=True)
class CiphertextRowDirectory:
    """Optimal erasure grouping and direct canonical-rank coordinates.

    Construction is cold. Admission reads ``group_of_rank`` and
    ``slot_of_rank`` directly; storage never supplies or interprets either
    coordinate. Ranks are one-based so zero remains the implicit canonical
    zero page.
    """

    quantum: int
    data_shards: int
    parity_shards: int
    group_offsets: tuple
    group_capacities: tuple
    group_of_rank: tuple
    slot_of_rank: tuple
    rank_at_position: tuple
    stored_bytes: int

    def __post_init__(self):
        quantum = int(self.quantum)
        data_shards, parity_shards = (int(self.data_shards),
                                      int(self.parity_shards))
        if quantum <= 0 or quantum & (quantum - 1):
            raise ValueError('ciphertext row quantum must be a power of two')
        if (data_shards <= 0 or parity_shards <= 0
                or data_shards + parity_shards > 255):
            raise ValueError('ciphertext row data extent is invalid')
        groups = len(self.group_capacities)
        if len(self.group_offsets) != groups + 1:
            raise ValueError('ciphertext row group extent is invalid')
        ranks = len(self.group_of_rank) - 1
        if (ranks < 0 or len(self.slot_of_rank) != ranks + 1
                or len(self.rank_at_position) != ranks):
            raise ValueError('ciphertext row rank extent is invalid')
        if (self.group_offsets[0] != 0
                or self.group_offsets[-1] != ranks
                or any(left >= right for left, right in zip(
                    self.group_offsets, self.group_offsets[1:]))
                or any(end - start > data_shards for start, end in zip(
                    self.group_offsets, self.group_offsets[1:]))):
            raise ValueError('ciphertext row group prefix is not canonical')
        if (any(int(value) <= 0 or int(value) % quantum
                for value in self.group_capacities)
                or any(left > right for left, right in zip(
                    self.group_capacities, self.group_capacities[1:]))):
            raise ValueError('ciphertext row capacities are not canonical')
        if tuple(sorted(self.rank_at_position)) != tuple(range(1, ranks + 1)):
            raise ValueError('ciphertext row directory is not a rank bijection')
        for position, rank in enumerate(self.rank_at_position):
            group = int(self.group_of_rank[rank])
            slot = int(self.slot_of_rank[rank])
            if (group < 0 or group >= groups or slot < 0
                    or position != self.group_offsets[group] + slot):
                raise ValueError('ciphertext row inverse coordinate is invalid')
        if int(self.stored_bytes) < 0:
            raise ValueError('ciphertext stored extent is invalid')

    @property
    def rank_count(self):
        return len(self.group_of_rank) - 1

    @property
    def group_count(self):
        return len(self.group_capacities)

    def coordinate(self, rank):
        """Return ``(capacity, group, slot)`` without a hash or search."""
        rank = int(rank)
        if rank <= 0 or rank > self.rank_count:
            raise IndexError('ciphertext row rank is outside the directory')
        group = self.group_of_rank[rank]
        return self.group_capacities[group], group, self.slot_of_rank[rank]


def build_ciphertext_row_directory(extents, quantum=64, data_shards=8,
                                   parity_shards=2, tag_bytes=16,
                                   authenticator_bytes=16,
                                   group_header_bytes=0):
    """Find the minimum-byte stable grouping of framed plaintext rows.

    Rows are rounded to ``quantum``, stably ordered by capacity, and divided
    into groups of at most ``data_shards``. For a group containing ``m`` data
    rows at capacity ``c``, exact stored cost is

        (m + parity_shards)
            * (c + tag_bytes + authenticator_bytes) + group header.

    An exchange of crossed rows never increases either group maximum, so some
    optimum is consecutive in the capacity order. The bounded recurrence
    below is therefore necessary and sufficient, not a heuristic. Its result
    is materialized once as direct rank arrays; no min-plus work is paid while
    fetching a page.
    """
    quantum, data_shards, parity_shards = (
        int(quantum), int(data_shards), int(parity_shards))
    tag_bytes, authenticator_bytes, group_header_bytes = (
        int(tag_bytes), int(authenticator_bytes), int(group_header_bytes))
    if quantum <= 0 or quantum & (quantum - 1):
        raise ValueError('ciphertext row quantum must be a power of two')
    if (data_shards <= 0 or parity_shards <= 0
            or data_shards + parity_shards > 255):
        raise ValueError('ciphertext row data extent is invalid')
    if (tag_bytes <= 0 or authenticator_bytes <= 0
            or group_header_bytes < 0):
        raise ValueError('ciphertext row overhead is invalid')
    extents = tuple(int(value) for value in extents)
    if any(value <= 0 for value in extents):
        raise ValueError('ciphertext row extent must be positive')
    shift = quantum.bit_length() - 1
    capacity_by_rank = tuple(
        ((value + quantum - 1) >> shift) * quantum for value in extents)
    order = tuple(sorted(range(1, len(extents) + 1),
                         key=lambda rank: (capacity_by_rank[rank - 1], rank)))
    capacities = tuple(capacity_by_rank[rank - 1] for rank in order)

    # best[j] is (stored bytes, group count, negative last-group width,
    # predecessor). The latter fields make equal-cost output canonical.
    best = [(0, 0, 0, -1)] + [None] * len(order)
    row_overhead = tag_bytes + authenticator_bytes
    for end in range(1, len(order) + 1):
        candidates = []
        for start in range(max(0, end - data_shards), end):
            count = end - start
            cost = (best[start][0]
                    + (count + parity_shards)
                    * (capacities[end - 1] + row_overhead)
                    + group_header_bytes)
            candidates.append((cost, best[start][1] + 1, -count, start))
        best[end] = min(candidates)

    boundaries = [len(order)]
    cursor = len(order)
    while cursor:
        cursor = best[cursor][3]
        boundaries.append(cursor)
    boundaries.reverse()
    group_offsets = tuple(boundaries)
    group_capacities = tuple(
        capacities[end - 1] for end in group_offsets[1:])
    group_of_rank = [-1] * (len(order) + 1)
    slot_of_rank = [-1] * (len(order) + 1)
    for group, (start, end) in enumerate(zip(
            group_offsets, group_offsets[1:])):
        for slot, position in enumerate(range(start, end)):
            rank = order[position]
            group_of_rank[rank] = group
            slot_of_rank[rank] = slot

    return CiphertextRowDirectory(
        quantum, data_shards, parity_shards, group_offsets,
        group_capacities, tuple(group_of_rank), tuple(slot_of_rank), order,
        best[-1][0])


@dataclass(frozen=True)
class PageFabricManifest:
    """Small authenticated directory for a rebuildable page projection."""

    object_digest: bytes
    generation: int
    length: int
    page_size: int
    page_ranks: tuple
    unique_pages: int
    data_shards: int
    parity_shards: int
    shard_root: bytes

    def __post_init__(self):
        if len(self.object_digest) != 32:
            raise ValueError('object identity must be a SHA-256 digest')
        if self.generation < 0 or self.length < 0 or self.page_size <= 0:
            raise ValueError('page projection coordinates are invalid')
        pages = (self.length + self.page_size - 1) // self.page_size
        if len(self.page_ranks) != pages:
            raise ValueError('page quotient directory has the wrong extent')
        ranks = int(self.unique_pages)
        if ranks < 0:
            raise ValueError('unique-page extent is invalid')
        if any(rank < 0 or rank > ranks for rank in self.page_ranks):
            raise ValueError('page quotient rank is outside the directory')
        seen = set()
        next_rank = 1
        for rank in self.page_ranks:
            if rank and rank not in seen:
                if rank != next_rank:
                    raise ValueError(
                        'unique pages are not ranked by first coordinate')
                seen.add(rank)
                next_rank += 1
        if len(seen) != ranks:
            raise ValueError('page quotient directory has unused ranks')
        _generator(self.data_shards, self.parity_shards)
        if len(self.shard_root) != 32:
            raise ValueError('physical shard root is invalid')

    @property
    def page_count(self):
        return len(self.page_ranks)

    @property
    def rank_count(self):
        return self.unique_pages

    @property
    def group_count(self):
        return ((self.unique_pages + self.data_shards - 1)
                // self.data_shards)

    @property
    def shard_count(self):
        return self.group_count * (self.data_shards + self.parity_shards)

    def shard_key(self, group, slot):
        return (self.object_digest, self.generation, int(group), int(slot))

    def shard_position(self, group, slot):
        group, slot = int(group), int(slot)
        if group < 0 or group >= self.group_count:
            raise IndexError('erasure group is outside the projection')
        if slot < 0 or slot >= self.data_shards + self.parity_shards:
            raise IndexError('shard slot is outside the erasure group')
        return group * (self.data_shards + self.parity_shards) + slot


def dump_manifest(manifest):
    """Gap-code the sparse quotient directory for range-first delivery."""
    if not isinstance(manifest, PageFabricManifest):
        raise TypeError('page manifest encoder needs a PageFabricManifest')
    if manifest.unique_pages > 0xFFFFFFFF:
        raise ValueError('page manifest has too many unique pages')
    nonzero = [(page, rank) for page, rank in
               enumerate(manifest.page_ranks) if rank]
    body = bytearray()
    previous = -1
    for page, rank in nonzero:
        body += _uleb(page - previous - 1)
        body += _uleb(rank)
        previous = page
    header = _MANIFEST_HEADER.pack(
        MANIFEST_MAGIC, MANIFEST_VERSION, _MANIFEST_HEADER.size,
        manifest.object_digest, manifest.generation, manifest.length,
        manifest.page_size, manifest.unique_pages,
        manifest.data_shards, manifest.parity_shards,
        manifest.shard_root, len(nonzero))
    return header + body


def load_manifest(blob):
    """Open a canonical sparse wire directory into its direct rank array."""
    data = blob if isinstance(blob, memoryview) else memoryview(blob)
    if len(data) < _MANIFEST_HEADER.size:
        raise PageFabricError('page manifest header is truncated')
    (magic, version, header_bytes, object_digest, generation, length,
     page_size, unique_pages, data_shards, parity_shards, shard_root,
     nonzero) = _MANIFEST_HEADER.unpack_from(data)
    if (magic != MANIFEST_MAGIC or version != MANIFEST_VERSION
            or header_bytes != _MANIFEST_HEADER.size):
        raise PageFabricError('page manifest format is unknown')
    if not page_size:
        raise PageFabricError('page manifest page size is invalid')
    page_count = (length + page_size - 1) // page_size
    ranks = [0] * page_count
    cursor = header_bytes
    previous = -1
    for _unused in range(nonzero):
        gap, cursor = _read_uleb(data, cursor)
        rank, cursor = _read_uleb(data, cursor)
        page = previous + gap + 1
        if page >= page_count or not rank or rank > unique_pages:
            raise PageFabricError('page manifest coordinate is invalid')
        ranks[page] = rank
        previous = page
    if cursor != len(data):
        raise PageFabricError('page manifest has trailing bytes')
    try:
        return PageFabricManifest(
            bytes(object_digest), generation, length, page_size,
            tuple(ranks), unique_pages, data_shards, parity_shards,
            bytes(shard_root))
    except ValueError as error:
        raise PageFabricError(str(error)) from error


@dataclass(frozen=True)
class ShardRecord:
    """Range payload plus a proof against the manifest's single root."""

    payload: bytes
    proof: tuple
    digest: bytes = None


@dataclass(frozen=True)
class DirectShardRecord:
    """Payload authenticated by the content-addressed bundle directory."""

    payload: bytes
    digest: bytes


class MemoryShardStore(object):
    """A replaceable storage tier; stored bytes are never trusted."""

    def __init__(self, records=None):
        self.records = {} if records is None else dict(records)

    def get(self, key):
        return self.records.get(key)

    def put(self, key, payload):
        self.records[key] = payload

    @property
    def stored_bytes(self):
        return sum((len(record.payload) + 32 * len(record.proof))
                   if isinstance(record, ShardRecord)
                   else len(record.payload)
                   if isinstance(record, DirectShardRecord) else len(record)
                   for record in self.records.values())


class _MappedRecords(MutableMapping):
    """Compatibility view whose values stay mapped until explicitly read."""

    def __init__(self, store):
        self.store = store

    def __getitem__(self, key):
        record = self.store.get(key)
        if record is None:
            raise KeyError(key)
        return record

    def __setitem__(self, key, value):
        self.store._deleted.discard(key)
        self.store._overrides[key] = value

    def __delitem__(self, key):
        if key not in self:
            raise KeyError(key)
        self.store._overrides.pop(key, None)
        self.store._deleted.add(key)

    def __iter__(self):
        yield from (key for key in self.store._entries
                    if key not in self.store._deleted)
        yield from (key for key in self.store._overrides
                    if key not in self.store._entries)

    def __len__(self):
        return (sum(key not in self.store._deleted
                    for key in self.store._entries)
                + sum(key not in self.store._entries
                      for key in self.store._overrides))


class MappedShardStore(object):
    """Read one payload range and direct digest at the touched coordinate.

    Opening a bundle retains one view of its wire bytes.  It does not copy all
    compressed payloads.  ``records`` is intentionally a mapping view for
    tooling and tests; iterating its values is an explicit request to
    materialize them.
    """

    def __init__(self, data, entries):
        self._data = data if isinstance(data, memoryview) else memoryview(data)
        self._entries = dict(entries)
        self._overrides = {}
        self._deleted = set()
        self.records = _MappedRecords(self)
        self.materialized_records = 0

    def get(self, key):
        if key in self._deleted:
            return None
        if key in self._overrides:
            return self._overrides[key]
        entry = self._entries.get(key)
        if entry is None:
            return None
        payload_start, payload_end, digest = entry
        self.materialized_records += 1
        return DirectShardRecord(
            self._data[payload_start:payload_end], digest)

    def put(self, key, payload):
        self.records[key] = payload

    @property
    def stored_bytes(self):
        return len(self._data) + sum(
            (len(record.payload) + 32 * len(record.proof))
            if isinstance(record, ShardRecord) else len(record.payload)
            if isinstance(record, DirectShardRecord) else len(record)
            for record in self._overrides.values())


class RangeShardStore(object):
    """Fetch one encoded shard range from an untrusted backing provider."""

    def __init__(self, prefix, entries, payload_base, reader):
        if not callable(reader):
            raise TypeError('range shard store needs a range reader')
        self._data = prefix if isinstance(prefix, memoryview) \
            else memoryview(prefix)
        self._entries = dict(entries)
        self._payload_base = int(payload_base)
        self._reader = reader
        self._overrides = {}
        self._deleted = set()
        self.records = _MappedRecords(self)
        self.materialized_records = 0
        self.range_requests = 0
        self.fetched_bytes = 0

    def get(self, key):
        if key in self._deleted:
            return None
        if key in self._overrides:
            return self._overrides[key]
        entry = self._entries.get(key)
        if entry is None:
            return None
        offset, size, digest = entry
        self.range_requests += 1
        payload = self._reader(self._payload_base + offset, size)
        if payload is None:
            return None
        payload = payload if isinstance(payload, memoryview) \
            else memoryview(payload)
        self.fetched_bytes += len(payload)
        self.materialized_records += 1
        return DirectShardRecord(payload, digest)

    def put(self, key, payload):
        self.records[key] = payload

    @property
    def stored_bytes(self):
        return len(self._data)


def bundle_prefix_size(header):
    """Return the one metadata range needed before any shard request."""
    data = header if isinstance(header, memoryview) else memoryview(header)
    if len(data) < _BUNDLE_HEADER.size:
        raise PageFabricError('page bundle header is truncated')
    magic, version, header_bytes, manifest_bytes, count, proof_nodes = \
        _BUNDLE_HEADER.unpack_from(data)
    if (magic != BUNDLE_MAGIC or version != BUNDLE_VERSION
            or header_bytes != _BUNDLE_HEADER.size):
        raise PageFabricError('page bundle format is unknown')
    return (header_bytes + manifest_bytes + count * _BUNDLE_RECORD.size
            + proof_nodes * _BUNDLE_PROOF.size)


def _load_bundle_directory(prefix):
    data = prefix if isinstance(prefix, memoryview) else memoryview(prefix)
    required = bundle_prefix_size(data)
    if len(data) < required:
        raise PageFabricError('page bundle directory is truncated')
    magic, version, header_bytes, manifest_bytes, count, proof_nodes = \
        _BUNDLE_HEADER.unpack_from(data)
    cursor = header_bytes
    manifest_end = cursor + manifest_bytes
    manifest = load_manifest(data[cursor:manifest_end])
    cursor = manifest_end
    if proof_nodes:
        raise PageFabricError('direct bundle has a redundant proof directory')
    pending = []
    previous = -1
    previous_payload_end = 0
    for _unused in range(count):
        group, slot, payload_offset, payload_bytes, digest = \
            _BUNDLE_RECORD.unpack_from(data, cursor)
        cursor += _BUNDLE_RECORD.size
        try:
            position = manifest.shard_position(group, slot)
        except IndexError as error:
            raise PageFabricError(str(error)) from error
        if (position <= previous or not payload_bytes
                or payload_offset != previous_payload_end):
            raise PageFabricError('page bundle record is not canonical')
        previous = position
        previous_payload_end = payload_offset + payload_bytes
        pending.append((manifest.shard_key(group, slot),
                        payload_offset, payload_bytes, position,
                        bytes(digest)))
    if cursor != required:
        raise PageFabricError('page bundle directory extent is invalid')
    return manifest, pending, required, previous_payload_end


def load_range_bundle(prefix, reader, expected_prefix_digest=None):
    """Open an authenticated prefix and fetch only touched payload ranges."""
    data = prefix if isinstance(prefix, memoryview) else memoryview(prefix)
    required = bundle_prefix_size(data)
    if len(data) != required:
        raise PageFabricError('range bundle prefix has the wrong extent')
    if expected_prefix_digest is not None:
        expected = (bytes.fromhex(expected_prefix_digest)
                    if isinstance(expected_prefix_digest, str)
                    else bytes(expected_prefix_digest))
        if len(expected) != 32 or _sha256(data) != expected:
            raise PageFabricError('range bundle prefix digest is invalid')
    manifest, pending, payload_base, _payload_bytes = \
        _load_bundle_directory(data)
    entries = {key: (offset, size, digest)
               for key, offset, size, _position, digest in pending}
    return manifest, RangeShardStore(
        data, entries, payload_base, reader)


def dump_bundle(manifest, store, shards='all'):
    """Pack selected shards behind one range-first fixed directory.

    Metadata and direct raw-page digests form one prefix. Compressed payloads are
    contiguous after it, so a remote provider needs one prefix request and one
    direct range request for each touched shard; no preceding payload is read.
    """
    if shards not in ('all', 'data', 'parity'):
        raise ValueError('bundle shards must be all, data, or parity')
    manifest_wire = dump_manifest(manifest)
    records = []
    proof_nodes = 0
    for key, record in sorted(store.records.items(),
                              key=lambda item: item[0][2:]):
        object_digest, generation, group, slot = key
        if object_digest != manifest.object_digest \
                or generation != manifest.generation:
            continue
        is_parity = slot >= manifest.data_shards
        if (shards == 'data' and is_parity) \
                or (shards == 'parity' and not is_parity):
            continue
        if not isinstance(record, (ShardRecord, DirectShardRecord)):
            raise PageFabricError('bundle contains a malformed shard record')
        position = manifest.shard_position(group, slot)
        digest = getattr(record, 'digest', None)
        if digest is None:
            digest = _leaf_digest(_decode_payload(
                record.payload, manifest.page_size))
        digest = bytes(digest)
        if len(digest) != 32:
            raise PageFabricError('bundle shard digest has the wrong extent')
        records.append((position, group, slot, record, digest))
    records.sort()

    output = bytearray(_BUNDLE_HEADER.pack(
        BUNDLE_MAGIC, BUNDLE_VERSION, _BUNDLE_HEADER.size,
        len(manifest_wire), len(records), proof_nodes))
    output += manifest_wire
    payload_offset = 0
    for _position, group, slot, record, digest in records:
        output += _BUNDLE_RECORD.pack(
            group, slot, payload_offset, len(record.payload), digest)
        payload_offset += len(record.payload)
    for _position, _group, _slot, record, _digest in records:
        output += record.payload
    return bytes(output)


def load_bundle(blob):
    """Map a shard bundle without decoding, decompressing, or trusting it."""
    data = blob if isinstance(blob, memoryview) else memoryview(blob)
    (manifest, pending, payload_base,
     previous_payload_end) = _load_bundle_directory(data)
    payload_end = payload_base + previous_payload_end
    if payload_end > len(data):
        raise PageFabricError('page bundle payload is truncated')
    if payload_end != len(data):
        raise PageFabricError('page bundle has trailing bytes')
    entries = {
        key: (payload_base + offset,
              payload_base + offset + size, digest)
        for key, offset, size, _position, digest in pending
    }
    return manifest, MappedShardStore(data, entries)


def _finish_projection(object_digest, length, page_size, ranks, unique,
                       data_shards, parity_shards, generation):
    generator = _generator(int(data_shards), int(parity_shards))
    zero = bytes(page_size)
    pending = []
    raw_shards = []
    for group, start in enumerate(range(0, len(unique), data_shards)):
        data = unique[start:start + data_shards]
        data += [zero] * (data_shards - len(data))
        for slot, raw in enumerate(data):
            if start + slot < len(unique):
                pending.append(((object_digest, int(generation), group, slot),
                                _encode_payload(raw)))
            else:
                pending.append(None)
            raw_shards.append(raw)
        for parity, coefficients in enumerate(generator[data_shards:]):
            raw = _combine(coefficients, data, page_size)
            slot = data_shards + parity
            pending.append(((object_digest, int(generation), group, slot),
                            _encode_payload(raw)))
            raw_shards.append(raw)

    root, proofs = _merkle_records(raw_shards)
    store = MemoryShardStore()
    for position, record in enumerate(pending):
        if record is not None:
            key, encoded = record
            store.put(key, ShardRecord(
                encoded, proofs[position], _leaf_digest(raw_shards[position])))

    manifest = PageFabricManifest(
        object_digest, int(generation), int(length), page_size,
        tuple(ranks), len(unique), int(data_shards), int(parity_shards), root)
    return manifest, store


def project(payload, page_size=4096, data_shards=8, parity_shards=2,
            generation=0):
    """Build a quotient directory and systematic erasure-shard store.

    The input remains the canonical object.  The returned structures are a
    deterministic delivery cache and may be discarded or rebuilt at any time.
    """
    payload = bytes(payload)
    page_size = int(page_size)
    if page_size <= 0:
        raise ValueError('physical page size must be positive')
    zero = bytes(page_size)
    ranks = []
    unique = []
    buckets = {}
    for offset in range(0, len(payload), page_size):
        page = payload[offset:offset + page_size]
        page += bytes(page_size - len(page))
        if page == zero:
            ranks.append(0)
            continue
        digest = _sha256(page)
        rank = 0
        for candidate in buckets.get(digest, ()):
            if unique[candidate - 1] == page:
                rank = candidate
                break
        if not rank:
            rank = len(unique) + 1
            unique.append(page)
            buckets.setdefault(digest, []).append(rank)
        ranks.append(rank)
    return _finish_projection(
        _sha256(payload), len(payload), page_size, ranks, unique,
        data_shards, parity_shards, generation)


def project_sparse(length, page_size, records, data_shards=8,
                   parity_shards=2, generation=0, object_digest=None):
    """Project coordinate-ordered nonzero pages without materializing zeros."""
    length, page_size = int(length), int(page_size)
    if length < 0 or page_size <= 0:
        raise ValueError('sparse projection geometry is invalid')
    page_count = (length + page_size - 1) // page_size
    ranks = [0] * page_count
    unique = []
    buckets = {}
    pages = {}
    previous = -1
    zero = bytes(page_size)
    for coordinate, payload in records:
        coordinate = int(coordinate)
        payload = bytes(payload)
        if coordinate <= previous or coordinate >= page_count:
            raise ValueError('sparse pages are not coordinate ordered')
        if len(payload) != page_size:
            raise ValueError('sparse page has the wrong extent')
        if payload == zero:
            raise ValueError('sparse projection contains a redundant zero page')
        previous = coordinate
        pages[coordinate] = payload
        digest = _sha256(payload)
        rank = 0
        for candidate in buckets.get(digest, ()):
            if unique[candidate - 1] == payload:
                rank = candidate
                break
        if not rank:
            rank = len(unique) + 1
            unique.append(payload)
            buckets.setdefault(digest, []).append(rank)
        ranks[coordinate] = rank

    if object_digest is None:
        digest = hashlib.sha256()
        for coordinate in range(page_count):
            page = pages.get(coordinate, zero)
            count = min(page_size, length - coordinate * page_size)
            digest.update(page[:count])
        object_digest = digest.digest()
    else:
        object_digest = bytes(object_digest)
        if len(object_digest) != 32:
            raise ValueError('sparse object identity must be a SHA-256 digest')
    return _finish_projection(
        object_digest, length, page_size, ranks, unique,
        data_shards, parity_shards, generation)


class SubpageBacking(object):
    """Expose one fabric page as smaller direct pages without copying it."""

    def __init__(self, fabric, page_size):
        self.fabric = fabric
        self.page_size = int(page_size)
        if self.page_size <= 0 or fabric.page_size % self.page_size:
            raise ValueError('subpage size does not divide the fabric page')
        self.length = fabric.length
        self.memory_bytes = self.length
        self._per_fabric_page = fabric.page_size // self.page_size
        # Rank, not logical coordinate, owns the views.  Quotient-equal spans
        # therefore share one array and no hash is present in the hot lookup.
        self._views = [None] * (fabric.manifest.rank_count + 1)
        self._zero = memoryview(bytes(self.page_size))

    def proof_token(self, page, offset=0, count=None):
        page, offset = int(page), int(offset)
        count = self.page_size if count is None else int(count)
        if (page < 0 or page * self.page_size >= self.length
                or offset < 0 or count < 0
                or offset + count > self.page_size):
            raise IndexError('subpage proof coordinate is outside the object')
        return self, page

    def page(self, page):
        page = int(page)
        offset = page * self.page_size
        if page < 0 or offset >= self.length:
            raise IndexError('subpage coordinate is outside the object')
        fabric_page, within = divmod(offset, self.fabric.page_size)
        rank = self.fabric.manifest.page_ranks[fabric_page]
        if not rank:
            return self._zero
        views = self._views[rank]
        if views is None:
            views = self._views[rank] = [None] * self._per_fabric_page
        slot = within // self.page_size
        selected = views[slot]
        if selected is None:
            # Hold a view of the verified span instead of copying one scalar
            # page on every load.  The whole view array is disposable.
            selected = memoryview(self.fabric.page(fabric_page))[
                within:within + self.page_size]
            views[slot] = selected
        return selected

    def find(self, page, offset, count, values):
        """Find bytes directly in a mapped view without creating ``bytes``."""
        raw = self.page(page)
        wanted = set(values)
        for coordinate in range(int(offset), int(offset) + int(count)):
            if raw[coordinate] in wanted:
                return coordinate
        return None

    def find_not(self, page, offset, count, value):
        """Find a complement coordinate in the same direct mapped view."""
        raw = self.page(page)
        value = int(value)
        for coordinate in range(int(offset), int(offset) + int(count)):
            if raw[coordinate] != value:
                return coordinate
        return None

    @property
    def resident_pages(self):
        return sum(sum(view is not None for view in views)
                   for views in self._views[1:] if views is not None)

    def release_resident(self):
        """Drop scalar views and their verified spans as one physical cut."""
        released = self.resident_pages
        self._views = [None] * len(self._views)
        self.fabric.release_resident()
        return released

    def layout(self):
        layout = self.fabric.layout()
        layout.update({
            'kind': 'four-layer-subpage-backing',
            'subpage_bytes': self.page_size,
            'resident_spans': self.fabric.resident_pages,
            'resident_subpages': self.resident_pages,
        })
        return layout


class PageFabric(object):
    """Direct quotient lookup over independently verified storage tiers."""

    def __init__(self, manifest, stores):
        if not isinstance(manifest, PageFabricManifest):
            raise TypeError('page fabric needs a PageFabricManifest')
        self.manifest = manifest
        self.stores = tuple(stores)
        if not self.stores:
            raise ValueError('page fabric needs at least one storage tier')
        self._generator = _generator(
            manifest.data_shards, manifest.parity_shards)
        # Rank zero is the implicit all-zero page.
        self._resident = [None] * (manifest.rank_count + 1)
        self.fetched_shards = 0
        self.rejected_shards = 0
        self.recovered_pages = 0

    @property
    def length(self):
        return self.manifest.length

    @property
    def page_size(self):
        return self.manifest.page_size

    @property
    def resident_pages(self):
        return sum(page is not None for page in self._resident[1:])

    def _fetch(self, group, slot):
        key = self.manifest.shard_key(group, slot)
        position = self.manifest.shard_position(group, slot)
        for store in self.stores:
            record = store.get(key)
            if record is None:
                continue
            self.fetched_shards += 1
            if not isinstance(record, (ShardRecord, DirectShardRecord)):
                self.rejected_shards += 1
                continue
            try:
                raw = _decode_payload(record.payload, self.page_size)
            except PageFabricError:
                self.rejected_shards += 1
                continue
            valid = (_leaf_digest(raw) == record.digest
                     if isinstance(record, DirectShardRecord)
                     else _verify_merkle(
                         raw, position, self.manifest.shard_count,
                         record.proof, self.manifest.shard_root))
            if valid:
                return raw
            self.rejected_shards += 1
        return None

    def _recover(self, group, target, unavailable=()):
        indexes, shards = [], []
        for slot in range(self.manifest.data_shards +
                          self.manifest.parity_shards):
            if slot in unavailable:
                continue
            rank = group * self.manifest.data_shards + slot + 1
            if slot < self.manifest.data_shards \
                    and rank > self.manifest.rank_count:
                raw = bytes(self.page_size)
            else:
                raw = self._fetch(group, slot)
            if raw is not None:
                indexes.append(slot)
                shards.append(raw)
                if len(shards) == self.manifest.data_shards:
                    break
        if len(shards) < self.manifest.data_shards:
            raise PageFabricError('not enough valid shards to recover page')
        inverse = _matrix_inverse([
            self._generator[index] for index in indexes])
        raw = _combine(inverse[target], shards, self.page_size)
        # Any k independently authenticated rows uniquely determine every data
        # row.  A missing target therefore needs no second per-page digest.
        self.recovered_pages += 1
        return raw

    def page(self, page):
        page = int(page)
        if page < 0 or page >= self.manifest.page_count:
            raise IndexError('page coordinate is outside the object')
        rank = self.manifest.page_ranks[page]
        if rank == 0:
            return bytes(self.page_size)
        resident = self._resident[rank]
        if resident is not None:
            return resident
        group, target = divmod(rank - 1, self.manifest.data_shards)
        raw = self._fetch(group, target)
        if raw is None:
            # Do not perform the already failed provider lookup a second time.
            raw = self._recover(group, target, (target,))
        self._resident[rank] = raw
        return raw

    def read(self, offset, length):
        offset, length = int(offset), int(length)
        if offset < 0 or length < 0 or offset + length > self.length:
            raise ValueError('physical read is outside the object')
        output = bytearray()
        while length:
            page, within = divmod(offset, self.page_size)
            count = min(length, self.page_size - within)
            output.extend(self.page(page)[within:within + count])
            offset += count
            length -= count
        return bytes(output)

    def release_resident(self):
        """Drop the whole verified cut; manifest and storage remain sufficient."""
        released = self.resident_pages
        self._resident = [None] * len(self._resident)
        return released

    def layout(self):
        logical = self.manifest.page_count
        mapped_materializations = sum(
            getattr(store, 'materialized_records', 0)
            for store in self.stores)
        return {
            'kind': 'four-layer-page-fabric',
            'canonical_bytes': self.length,
            'logical_pages': logical,
            'unique_pages': self.manifest.rank_count,
            'quotient_pages_saved': logical - self.manifest.rank_count,
            'erasure_data_shards': self.manifest.data_shards,
            'erasure_parity_shards': self.manifest.parity_shards,
            'erasure_groups': self.manifest.group_count,
            'manifest_bytes': len(dump_manifest(self.manifest)),
            'resident_unique_pages': self.resident_pages,
            'fetched_shards': self.fetched_shards,
            'rejected_shards': self.rejected_shards,
            'recovered_pages': self.recovered_pages,
            'mapped_records_materialized': mapped_materializations,
        }


# ------------------------------------- content-addressed artifact delivery ---

ARTIFACT_SCHEMA = 1
DEFAULT_ARTIFACT_PAGE_BYTES = 1 << 16
DEFAULT_ARTIFACT_DATA_SHARDS = 8
DEFAULT_ARTIFACT_PARITY_SHARDS = 2


def _artifact_sha256(payload):
    return hashlib.sha256(payload).hexdigest()


def artifact_delivery_bytes(
        payload, page_bytes=DEFAULT_ARTIFACT_PAGE_BYTES,
        data_shards=DEFAULT_ARTIFACT_DATA_SHARDS,
        parity_shards=DEFAULT_ARTIFACT_PARITY_SHARDS,
        included_shards='data'):
    """Return one disposable page bundle and its storage-neutral metadata."""
    payload = bytes(payload)
    manifest, store = project(
        payload, page_size=int(page_bytes),
        data_shards=int(data_shards),
        parity_shards=int(parity_shards))
    wire = dump_bundle(manifest, store, included_shards)
    prefix_bytes = bundle_prefix_size(wire)
    metadata = {
        'bytes': len(wire),
        'sha256': _artifact_sha256(wire),
        'prefix_bytes': prefix_bytes,
        'prefix_sha256': _artifact_sha256(wire[:prefix_bytes]),
        'page_bytes': manifest.page_size,
        'logical_pages': manifest.page_count,
        'unique_pages': manifest.rank_count,
        'data_shards': manifest.data_shards,
        'parity_shards': manifest.parity_shards,
        'included_shards': included_shards,
        'manifest_bytes': len(dump_manifest(manifest)),
    }
    return wire, metadata


def write_artifact_delivery(
        payload, output, page_bytes=DEFAULT_ARTIFACT_PAGE_BYTES,
        data_shards=DEFAULT_ARTIFACT_DATA_SHARDS,
        parity_shards=DEFAULT_ARTIFACT_PARITY_SHARDS,
        included_shards='data', include_manifest_bytes=False):
    """Write a range-readable bundle without making it part of identity."""
    output = Path(output)
    wire, metadata = artifact_delivery_bytes(
        payload, page_bytes=page_bytes, data_shards=data_shards,
        parity_shards=parity_shards, included_shards=included_shards)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(wire)
    result = dict(metadata)
    result['file'] = output.name
    if not include_manifest_bytes:
        result.pop('manifest_bytes')
    return result


def _read_artifact_index(path, identity):
    if not path.exists():
        return {
            'schema': ARTIFACT_SCHEMA,
            'identity': identity,
            'deliveries': {},
        }
    try:
        current = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError('artifact delivery index is invalid') from error
    if (current.get('schema') != ARTIFACT_SCHEMA
            or current.get('identity') != identity
            or not isinstance(current.get('deliveries'), dict)):
        raise ValueError('artifact delivery index names another object')
    return current


def _artifact_locator(name):
    name = str(name)
    if (not name or name in ('.', '..')
            or any(not (character.isascii()
                        and (character.isalnum() or character in '._-'))
                   for character in name)):
        raise ValueError('artifact locator must be one portable path segment')
    return name


def write_artifact(
        payload, artifact_root, name,
        page_bytes=DEFAULT_ARTIFACT_PAGE_BYTES,
        data_shards=DEFAULT_ARTIFACT_DATA_SHARDS,
        parity_shards=DEFAULT_ARTIFACT_PARITY_SHARDS,
        included_shards='data'):
    """Add a delivery below ``artifact_root/<locator>``.

    No canonical copy is written. Another page or erasure geometry appends a
    projection below the same object identity. The locator is deliberately not
    derived from identity; a catalog binds a human role to canonical bytes.
    """
    payload = bytes(payload)
    identity = {
        'algorithm': 'sha256',
        'digest': _artifact_sha256(payload),
        'bytes': len(payload),
    }
    object_root = Path(artifact_root) / _artifact_locator(name)
    index_path = object_root / 'index.json'
    index = _read_artifact_index(index_path, identity)
    wire, metadata = artifact_delivery_bytes(
        payload, page_bytes=page_bytes, data_shards=data_shards,
        parity_shards=parity_shards, included_shards=included_shards)
    delivery_digest = metadata['sha256']
    relative = Path('delivery') / (delivery_digest + '.pages')
    output = object_root / relative
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        if _artifact_sha256(output.read_bytes()) != delivery_digest:
            raise ValueError('artifact delivery path contains other bytes')
    else:
        output.write_bytes(wire)

    descriptor = dict(metadata)
    descriptor.update({
        'format': 'page-fabric-v1',
        'file': relative.as_posix(),
    })
    index['deliveries'][delivery_digest] = descriptor
    # Preference is a mutable delivery policy, not part of content identity.
    index['preferred'] = delivery_digest
    index['deliveries'] = dict(sorted(index['deliveries'].items()))
    index_path.write_text(
        json.dumps(index, indent=2, sort_keys=True) + '\n',
        encoding='utf-8', newline='\n')
    return index


def open_artifact(index, artifact_root, name, delivery_digest=None):
    """Open a local projection and check its claimed canonical coordinate."""
    if not isinstance(index, dict) \
            or index.get('schema') != ARTIFACT_SCHEMA:
        raise ValueError('artifact index has an unknown schema')
    identity = index.get('identity')
    deliveries = index.get('deliveries')
    if not isinstance(identity, dict) or not isinstance(deliveries, dict):
        raise ValueError('artifact index is incomplete')
    selected = delivery_digest or index.get('preferred')
    descriptor = deliveries.get(selected)
    if not isinstance(descriptor, dict):
        raise ValueError('artifact delivery is unavailable')
    expected_file = 'delivery/%s.pages' % selected
    if descriptor.get('file') != expected_file:
        raise ValueError('artifact delivery path is invalid')
    path = (Path(artifact_root) / _artifact_locator(name)
            / Path(expected_file))
    wire = path.read_bytes()
    if len(wire) != descriptor['bytes'] \
            or _artifact_sha256(wire) != selected:
        raise ValueError('artifact delivery bytes are invalid')
    prefix_bytes = int(descriptor['prefix_bytes'])
    if prefix_bytes < 0 or prefix_bytes > len(wire):
        raise ValueError('artifact delivery prefix extent is invalid')
    if _artifact_sha256(wire[:prefix_bytes]) \
            != descriptor['prefix_sha256']:
        raise ValueError('artifact delivery prefix is invalid')
    manifest, store = load_bundle(memoryview(wire))
    if (manifest.object_digest.hex() != identity['digest']
            or manifest.length != int(identity['bytes'])):
        raise ValueError('artifact delivery reconstructs another object')
    return manifest, store
