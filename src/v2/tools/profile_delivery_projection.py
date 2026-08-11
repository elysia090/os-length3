#!/usr/bin/env python3
"""Measure deterministic physical projections over real delivery pages.

The profiler does not invent a semantic compression format.  It compares
reversible byte-coordinate forms: implicit fill, maximal runs, mode patches,
within-page quotient blocks, byte-column transposes, and affine predecessor
residuals. Ciphertext row totals include the AES-GCM tag and the separate
16-byte keyed stored-row authenticator. Deflate is retained as the
browser-native baseline.
"""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import sys
import zlib


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _uleb_bytes(value):
    value = int(value)
    count = 1
    while value >= 128:
        value >>= 7
        count += 1
    return count


def _deflate_size(raw):
    stream = zlib.compressobj(9, zlib.DEFLATED)
    return len(stream.compress(raw) + stream.flush())


def _mode_patch_size(raw):
    counts = Counter(raw)
    base = min(counts, key=lambda value: (-counts[value], value))
    coordinates = [index for index, value in enumerate(raw)
                   if value != base]
    size = 3 + _uleb_bytes(len(coordinates))
    previous = -1
    for coordinate in coordinates:
        size += _uleb_bytes(coordinate - previous - 1) + 1
        previous = coordinate
    return size, len(coordinates)


def _run_size(raw):
    if not raw:
        return 2, 0
    lengths = []
    previous = raw[0]
    length = 1
    for value in raw[1:]:
        if value == previous:
            length += 1
        else:
            lengths.append(length)
            previous = value
            length = 1
    lengths.append(length)
    return (2 + _uleb_bytes(len(lengths))
            + sum(_uleb_bytes(length) + 1 for length in lengths),
            len(lengths))


def _block_quotient_size(raw, block_bytes):
    blocks = [raw[offset:offset + block_bytes]
              for offset in range(0, len(raw), block_bytes)]
    zero = bytes(block_bytes)
    ranks = []
    unique = []
    by_digest = defaultdict(list)
    for block in blocks:
        if block == zero:
            ranks.append(0)
            continue
        digest = hashlib.sha256(block).digest()
        rank = 0
        for candidate in by_digest[digest]:
            if unique[candidate - 1] == block:
                rank = candidate
                break
        if not rank:
            rank = len(unique) + 1
            unique.append(block)
            by_digest[digest].append(rank)
        ranks.append(rank)
    width = 1 if len(unique) < 256 else 2 if len(unique) < 65536 else 4
    dense = 8 + width * len(ranks) + block_bytes * len(unique)
    sparse = 8 + _uleb_bytes(sum(bool(rank) for rank in ranks))
    previous = -1
    for coordinate, rank in enumerate(ranks):
        if rank:
            sparse += (_uleb_bytes(coordinate - previous - 1)
                       + _uleb_bytes(rank))
            previous = coordinate
    sparse += block_bytes * len(unique)
    return min(dense, sparse), len(unique), len(blocks)


def _xor_lag(raw, lag):
    output = bytearray(raw)
    for index in range(lag, len(output)):
        output[index] ^= raw[index - lag]
    return bytes(output)


def _subtract_lag(raw, lag):
    output = bytearray(raw)
    for index in range(lag, len(output)):
        output[index] = (raw[index] - raw[index - lag]) & 255
    return bytes(output)


def page_candidates(raw):
    """Return exact wire-size candidates and their minimum touched span."""
    raw = bytes(raw)
    size = len(raw)
    candidates = {
        'raw': (1 + size, 1, size),
        'deflate': (1 + _deflate_size(raw), size, size),
    }
    if raw and raw == bytes((raw[0],)) * size:
        candidates['fill'] = (2, 1, 1)
    patch_bytes, patches = _mode_patch_size(raw)
    candidates['mode-patch'] = (patch_bytes, patches + 1, patch_bytes)
    run_bytes, runs = _run_size(raw)
    candidates['runs'] = (run_bytes, runs, run_bytes)
    for block_bytes in (64, 256, 1024):
        if size % block_bytes:
            continue
        encoded, unique, blocks = _block_quotient_size(raw, block_bytes)
        candidates['block-quotient-%d' % block_bytes] = (
            encoded, unique, block_bytes)
    for stride in (2, 4, 8, 16):
        if size % stride:
            continue
        columns = b''.join(raw[column::stride]
                           for column in range(stride))
        candidates['byte-columns-%d+deflate' % stride] = (
            2 + _deflate_size(columns), size, size)
    for lag in (1, 2, 4, 8, 16, 32):
        if lag >= size:
            continue
        candidates['xor-lag-%d+deflate' % lag] = (
            2 + _deflate_size(_xor_lag(raw, lag)), size, size)
        candidates['sub-lag-%d+deflate' % lag] = (
            2 + _deflate_size(_subtract_lag(raw, lag)), size, size)
    return candidates


def ciphertext_row_classes(encoded_sizes, quantum, data_shards=8,
                           parity_shards=2):
    """Exact storage cost of compress->class->AEAD->RS physical rows.

    The authenticated plaintext frame carries format, raw/encoded extents and
    the canonical page digest (41 bytes). AES-GCM contributes a 16-byte tag.
    Reed-Solomon is applied afterwards to equal ciphertext row extents, so a
    parity row has exactly the same extent as a data row in its size class.
    """
    quantum = int(quantum)
    classes = Counter()
    padding = 0
    for encoded in encoded_sizes:
        framed = 41 + int(encoded)
        capacity = ((framed + quantum - 1) // quantum) * quantum
        classes[capacity] += 1
        padding += capacity - framed
    strict_parity_rows = sum(
        ((count + data_shards - 1) // data_shards) * parity_shards
        for count in classes.values())
    strict_data_bytes = sum(count * (capacity + 16)
                            for capacity, count in classes.items())
    strict_parity_bytes = sum(
        ((count + data_shards - 1) // data_shards) * parity_shards
        * (capacity + 16)
        for capacity, count in classes.items())
    strict_rows = len(encoded_sizes) + strict_parity_rows
    strict_stored = (strict_data_bytes + strict_parity_bytes
                     + 16 * strict_rows)

    from kernel.pagefabric import build_ciphertext_row_directory
    framed_extents = tuple(41 + int(encoded) for encoded in encoded_sizes)
    directory = build_ciphertext_row_directory(
        framed_extents, quantum, data_shards, parity_shards,
        tag_bytes=16, authenticator_bytes=16)
    grouped_padding = sum(
        directory.coordinate(rank)[0] - extent
        for rank, extent in enumerate(framed_extents, 1))
    data_bytes = sum(
        directory.coordinate(rank)[0] + 16
        for rank in range(1, directory.rank_count + 1))
    parity_bytes = sum(
        parity_shards * (capacity + 16)
        for capacity in directory.group_capacities)
    parity_rows = directory.group_count * parity_shards
    rows = directory.rank_count + parity_rows
    return {
        'quantum_bytes': quantum,
        'size_classes': len(classes),
        'data_rows': len(encoded_sizes),
        'parity_rows': parity_rows,
        'erasure_groups': directory.group_count,
        'padding_bytes': grouped_padding,
        'ciphertext_bytes': data_bytes,
        'parity_bytes': parity_bytes,
        'row_authenticator_bytes': 16 * rows,
        'stored_bytes': directory.stored_bytes,
        'strict_class_padding_bytes': padding,
        'strict_class_parity_rows': strict_parity_rows,
        'strict_class_stored_bytes': strict_stored,
        'grouping_bytes_saved': strict_stored - directory.stored_bytes,
    }


def open_payload(path):
    path = Path(path)
    data = path.read_bytes()
    if path.suffix != '.pages':
        return data
    from kernel.pagefabric import PageFabric, load_bundle
    manifest, store = load_bundle(memoryview(data))
    payload = PageFabric(manifest, (store,)).read(0, manifest.length)
    if hashlib.sha256(payload).digest() != manifest.object_digest:
        raise ValueError('reconstructed bundle object has the wrong identity')
    return payload


def profile(payload, page_bytes, limit=None):
    payload = bytes(payload)
    page_bytes = int(page_bytes)
    pages = []
    for offset in range(0, len(payload), page_bytes):
        page = payload[offset:offset + page_bytes]
        page += bytes(page_bytes - len(page))
        pages.append(page)
    zero = bytes(page_bytes)
    unique = []
    ranks = {}
    duplicates = 0
    for page in pages:
        if page == zero:
            continue
        identity = hashlib.sha256(page).digest()
        matched = next((candidate for candidate in ranks.get(identity, ())
                        if unique[candidate] == page), None)
        if matched is None:
            ranks.setdefault(identity, []).append(len(unique))
            unique.append(page)
        else:
            duplicates += 1
    if limit is None or int(limit) >= len(unique):
        selected = unique
    else:
        count = int(limit)
        if count <= 0:
            raise ValueError('profile page limit must be positive')
        selected = [unique[index * (len(unique) - 1) // (count - 1)]
                    for index in range(count)] if count > 1 else [unique[0]]
    totals = Counter()
    winners = Counter()
    touch_winners = Counter()
    pareto = Counter()
    encoded_sizes = []
    for page in selected:
        candidates = page_candidates(page)
        for name, (encoded, _work, _touch) in candidates.items():
            totals[name] += encoded
        winner = min(candidates,
                     key=lambda name: (candidates[name][0],
                                       candidates[name][1],
                                       candidates[name][2], name))
        winners[winner] += 1
        encoded_sizes.append(candidates[winner][0])
        minimum = candidates[winner][0]
        near = {name: cost for name, cost in candidates.items()
                if cost[0] <= minimum + max(32, minimum // 32)}
        touch = min(near,
                    key=lambda name: (near[name][2], near[name][1],
                                      near[name][0], name))
        touch_winners[touch] += 1
        for name, cost in candidates.items():
            dominated = any(
                other != name
                and all(left <= right for left, right in zip(other_cost, cost))
                and any(left < right for left, right in zip(other_cost, cost))
                for other, other_cost in candidates.items())
            if not dominated:
                pareto[name] += 1
    baseline = totals['deflate']
    best = sum(min(page_candidates(page).values())[0]
               for page in selected)
    return {
        'canonical_bytes': len(payload),
        'page_bytes': page_bytes,
        'logical_pages': len(pages),
        'zero_pages': sum(page == zero for page in pages),
        'duplicate_nonzero_pages': duplicates,
        'unique_nonzero_pages': len(unique),
        'profiled_unique_pages': len(selected),
        'deflate_payload_bytes': baseline,
        'minimum_candidate_bytes': best,
        'bytes_below_deflate': baseline - best,
        'winner_pages': dict(sorted(winners.items())),
        'near_minimum_touch_pages': dict(sorted(touch_winners.items())),
        'pareto_pages': dict(sorted(pareto.items())),
        'candidate_bytes': dict(sorted(totals.items())),
        'ciphertext_row_classes': [
            ciphertext_row_classes(encoded_sizes, quantum)
            for quantum in (64, 128, 256, 512, 1024)
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifacts', nargs='+')
    parser.add_argument('--page-bytes', type=int, nargs='+',
                        default=(4096, 16384, 65536))
    parser.add_argument('--limit', type=int,
                        help='profile N evenly spaced unique pages')
    args = parser.parse_args(argv)
    reports = {}
    for name in args.artifacts:
        payload = open_payload(name)
        reports[name] = [profile(payload, size, args.limit)
                         for size in args.page_bytes]
    print(json.dumps(reports, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
