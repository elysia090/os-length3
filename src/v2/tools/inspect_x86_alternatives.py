"""Summarize Linux alternative-instruction records from an x86 checkpoint."""

import argparse
from collections import Counter
from pathlib import Path
import struct

from kernel.x86 import MASK64, load_bzimage_kernel, read_virtual
from kernel.x86snapshot import load_x86_machine_state


ENTRY = struct.Struct('<iiIBB')
NOPS = tuple(sorted((
    bytes.fromhex('90'), bytes.fromhex('66 90'),
    bytes.fromhex('0f 1f 00'), bytes.fromhex('0f 1f 40 00'),
    bytes.fromhex('0f 1f 44 00 00'),
    bytes.fromhex('66 0f 1f 44 00 00'),
    bytes.fromhex('0f 1f 80 00 00 00 00'),
    bytes.fromhex('0f 1f 84 00 00 00 00 00'),
    bytes.fromhex('66 0f 1f 84 00 00 00 00 00'),
    bytes.fromhex('2e 0f 1f 84 00 00 00 00 00'),
    bytes.fromhex('66 2e 0f 1f 84 00 00 00 00 00'),
), key=len, reverse=True))


def integer(value):
    return int(value, 0)


def replacement_shape(payload):
    if not payload:
        return 'empty'
    if len(payload) == 5 and payload[0] in (0xe8, 0xe9):
        return 'relative32'
    if len(payload) == 6 and payload[:3] == b'\x0f\x00\x2d':
        return 'rip-modrm32'
    if (len(payload) == 12 and payload[:3] == b'\x48\x8d\x3d'
            and payload[7] == 0xe8):
        return 'rip-lea-call'
    if (len(payload) == 43 and payload[:7] ==
            b'\x49\xc7\xc4\x10\x00\x00\x00'
            and payload[31:35] == b'\x65\x48\xc7\x05'):
        return 'nested-test'
    if payload in (b'\x0f\xae\xe8', b'\x0f\xae\xe8\x0f\x31'):
        return 'fence'
    return 'plain'


def canonical_nops(payload):
    output = bytearray()
    at = 0
    while at < len(payload):
        nop = next((candidate for candidate in NOPS
                    if payload.startswith(candidate, at)), None)
        if nop is None:
            output.append(payload[at])
            at += 1
        else:
            output.extend(b'\x90' * len(nop))
            at += len(nop)
    return bytes(output)


def same_site_semantics(site, left, right):
    if canonical_nops(left) == canonical_nops(right):
        return True

    def jump_target(payload):
        if payload[:1] == b'\xeb' and len(payload) >= 2:
            return site + 2 + int.from_bytes(
                payload[1:2], 'little', signed=True)
        if payload[:1] == b'\xe9' and len(payload) >= 5:
            return site + 5 + int.from_bytes(
                payload[1:5], 'little', signed=True)
        return None

    left_target = jump_target(left)
    right_target = jump_target(right)
    if left_target is not None and left_target == right_target:
        return True
    if (left_target == site + len(left)
            and set(left[2:]) <= {0xcc}
            and set(canonical_nops(right)) <= {0x90}):
        return True
    if (right_target == site + len(right)
            and set(right[2:]) <= {0xcc}
            and set(canonical_nops(left)) <= {0x90}):
        return True
    return False


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('bzimage', type=Path)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('start', type=integer)
    parser.add_argument('end', type=integer)
    parser.add_argument('capabilities', type=integer)
    parser.add_argument('--memory-mib', type=int, default=128)
    parser.add_argument('--top', type=int, default=40)
    parser.add_argument('--flags', type=integer)
    parser.add_argument('--replace', type=integer)
    parser.add_argument('--compare', type=Path)
    arguments = parser.parse_args(argv)

    image = arguments.bzimage.read_bytes()
    boot = load_bzimage_kernel(
        image, memory_bytes=arguments.memory_mib << 20)
    cpu = load_x86_machine_state(
        arguments.checkpoint.read_bytes(), boot.state.memory).cpu
    comparison = (None if arguments.compare is None else
                  load_x86_machine_state(
                      arguments.compare.read_bytes(), boot.state.memory).cpu)
    extent = arguments.end - arguments.start
    if extent < 0 or extent % ENTRY.size:
        raise ValueError('alternative table extent is not entry aligned')
    table = read_virtual(cpu, arguments.start, extent)
    capabilities = read_virtual(cpu, arguments.capabilities, 96)
    replacements = Counter()
    lengths = Counter()
    decisions = Counter()
    direct_targets = Counter()
    active_shapes = Counter()
    sites = {}
    for offset in range(0, extent, ENTRY.size):
        instr_offset, repl_offset, ft_flags, instrlen, replacementlen = \
            ENTRY.unpack_from(table, offset)
        slot = (arguments.start + offset) & MASK64
        cpuid = ft_flags & 0xffff
        flags = ft_flags >> 16
        present = bool(capabilities[cpuid >> 3] & (1 << (cpuid & 7)))
        replace = present != bool(flags & 1)
        replacement = read_virtual(
            cpu, (slot + 4 + repl_offset) & MASK64, replacementlen)
        site = (slot + instr_offset) & MASK64
        sites[site] = max(sites.get(site, 0), instrlen)
        if flags & 2:
            original = read_virtual(
                cpu, (slot + instr_offset) & MASK64, instrlen)
            if (instrlen == 6 and replacementlen == 5
                    and original[:2] == b'\xff\x15'
                    and replacement[:1] == b'\xe8'):
                pointer = ((slot + instr_offset + 6
                            + int.from_bytes(original[2:6], 'little',
                                             signed=True)) & MASK64)
                direct_targets[read_virtual(
                    cpu, pointer, 8).hex()] += 1
            else:
                direct_targets['invalid'] += 1
        replacements[(replace, flags, replacement.hex())] += 1
        if replace and not flags & 2:
            active_shapes[(flags, replacement_shape(replacement))] += 1
        lengths[(instrlen, replacementlen)] += 1
        decisions[(replace, flags)] += 1
    print('entries=%d' % (extent // ENTRY.size))
    print('decisions=%r' % decisions)
    print('lengths=%r' % lengths)
    print('direct_targets=%r' % direct_targets)
    print('active_shapes=%r' % active_shapes)
    if comparison is not None:
        mismatches = []
        for site, length in sites.items():
            left = read_virtual(cpu, site, length, 'execute')
            right = read_virtual(comparison, site, length, 'execute')
            if left != right:
                mismatches.append((site, left.hex(), right.hex()))
        print('site_mismatches=%d' % len(mismatches))
        semantic = [item for item in mismatches
                    if not same_site_semantics(
                        item[0], bytes.fromhex(item[1]),
                        bytes.fromhex(item[2]))]
        print('semantic_mismatches=%d' % len(semantic))
        for site, left, right in mismatches[:50]:
            print('0x%x left=%s right=%s' % (site, left, right))
        for site, left, right in semantic[:50]:
            print('semantic 0x%x left=%s right=%s' % (site, left, right))
    selected = ((key, count) for key, count in replacements.most_common()
                if (arguments.flags is None or key[1] == arguments.flags)
                and (arguments.replace is None
                     or key[0] == bool(arguments.replace)))
    for key, count in list(selected)[:max(0, arguments.top)]:
        print('%6d replace=%d flags=%x bytes=%s' % (
            count, key[0], key[1], key[2]))


if __name__ == '__main__':
    main()
