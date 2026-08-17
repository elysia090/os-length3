#!/usr/bin/env python3
"""Write executable ELF symbol coordinates for native x86 closure seeding."""

import argparse
from pathlib import Path
import re
import struct
import subprocess


ELF_HEADER = struct.Struct('<16sHHIQQQIHHHHHH')
PROGRAM_HEADER = struct.Struct('<IIQQQQQQ')
SECTION_HEADER = struct.Struct('<IIQQQQIIQQ')
SYMBOL = struct.Struct('<IBBHQQ')
DISASSEMBLED_INSTRUCTION = re.compile(
    r'^\s*([0-9a-fA-F]+):\s+([A-Za-z][^\s]*)\s*(.*)$')
DIRECT_TARGET = re.compile(r'^\s*([0-9a-fA-F]+)(?:\s|$)')
ELFCLASS64 = 2
ELFDATA2LSB = 1
EM_X86_64 = 62
ET_EXEC = 2
SHT_SYMTAB = 2
SHT_DYNSYM = 11
SHF_EXECINSTR = 4
SHN_UNDEF = 0
PT_LOAD = 1
PF_X = 1


def executable_segments(payload):
    """Return immutable ``(virtual address, bytes)`` ELF load extents."""
    if len(payload) < ELF_HEADER.size:
        raise ValueError('ELF header is truncated')
    fields = ELF_HEADER.unpack_from(payload)
    identity = fields[0]
    if (identity[:4] != b'\x7fELF'
            or identity[4] != ELFCLASS64
            or identity[5] != ELFDATA2LSB):
        raise ValueError('only little-endian ELF64 is supported')
    (_identity, elf_type, machine, _version, _entry, program_offset,
     _section_offset, _flags, _header_size, program_entry_size,
     program_count, _section_entry_size, _section_count,
     _section_names) = fields
    if elf_type != ET_EXEC or machine != EM_X86_64:
        raise ValueError('only fixed-address x86-64 executables are supported')
    if program_entry_size != PROGRAM_HEADER.size:
        raise ValueError('ELF program header size is unsupported')
    program_end = program_offset + program_count * program_entry_size
    if program_end > len(payload):
        raise ValueError('ELF program headers are truncated')
    segments = []
    for index in range(program_count):
        (kind, flags, offset, virtual, _physical, file_bytes,
         memory_bytes, _alignment) = PROGRAM_HEADER.unpack_from(
             payload, program_offset + index * program_entry_size)
        if kind != PT_LOAD or not flags & PF_X:
            continue
        if (file_bytes > memory_bytes or offset + file_bytes > len(payload)
                or virtual + memory_bytes >= (1 << 64)):
            raise ValueError('ELF executable segment is malformed')
        segments.append((virtual, bytes(
            payload[offset:offset + file_bytes])))
    if not segments:
        raise ValueError('ELF has no executable load segment')
    return tuple(sorted(segments))


def executable_symbols(payload):
    if len(payload) < ELF_HEADER.size:
        raise ValueError('ELF header is truncated')
    fields = ELF_HEADER.unpack_from(payload)
    identity = fields[0]
    if (identity[:4] != b'\x7fELF'
            or identity[4] != ELFCLASS64
            or identity[5] != ELFDATA2LSB):
        raise ValueError('only little-endian ELF64 is supported')
    (_identity, elf_type, machine, _version, _entry, _program_offset,
     section_offset, _flags, _header_size, _program_entry_size,
     _program_count, section_entry_size, section_count,
     _section_names) = fields
    if elf_type != ET_EXEC or machine != EM_X86_64:
        raise ValueError('only fixed-address x86-64 executables are supported')
    if section_entry_size != SECTION_HEADER.size:
        raise ValueError('ELF section header size is unsupported')
    section_end = section_offset + section_count * section_entry_size
    if section_end > len(payload):
        raise ValueError('ELF section headers are truncated')
    sections = tuple(
        SECTION_HEADER.unpack_from(
            payload, section_offset + index * section_entry_size)
        for index in range(section_count))
    executable = {
        index for index, section in enumerate(sections)
        if section[2] & SHF_EXECINSTR
    }
    symbols = set()
    for section in sections:
        section_type = section[1]
        if section_type not in (SHT_SYMTAB, SHT_DYNSYM):
            continue
        offset, size, entry_size = section[4], section[5], section[9]
        if entry_size != SYMBOL.size or offset + size > len(payload):
            raise ValueError('ELF symbol table is malformed')
        for at in range(offset, offset + size, entry_size):
            _name, _info, _other, section_index, value, _size = \
                SYMBOL.unpack_from(payload, at)
            if section_index != SHN_UNDEF and section_index in executable:
                symbols.add(value)
    return tuple(sorted(symbols))


def control_entries_from_lines(lines):
    """Return direct-control targets and their architectural fallthroughs."""
    entries = set()
    pending_fallthrough = False
    for line in lines:
        match = DISASSEMBLED_INSTRUCTION.match(line)
        if match is None:
            continue
        coordinate = int(match.group(1), 16)
        if pending_fallthrough:
            entries.add(coordinate)
        mnemonic = match.group(2).lower()
        operand = match.group(3)
        is_call = mnemonic.startswith('call')
        is_jump = mnemonic.startswith('j') or mnemonic.startswith('loop')
        if is_call or is_jump:
            target = DIRECT_TARGET.match(operand)
            if target is not None:
                entries.add(int(target.group(1), 16))
        pending_fallthrough = (is_call or (is_jump
                                           and not mnemonic.startswith('jmp')))
    return tuple(sorted(entries))


def call_entries_from_lines(lines):
    """Return direct call targets and their return continuations."""
    entries = set()
    pending_return = False
    for line in lines:
        match = DISASSEMBLED_INSTRUCTION.match(line)
        if match is None:
            continue
        coordinate = int(match.group(1), 16)
        if pending_return:
            entries.add(coordinate)
        mnemonic = match.group(2).lower()
        operand = match.group(3)
        pending_return = mnemonic.startswith('call')
        if pending_return:
            target = DIRECT_TARGET.match(operand)
            if target is not None:
                entries.add(int(target.group(1), 16))
    return tuple(sorted(entries))


def disassembled_control_entries(path, objdump):
    process = subprocess.Popen(
        (str(objdump), '-d', '--no-show-raw-insn', str(path)),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding='utf-8', errors='replace')
    entries = control_entries_from_lines(process.stdout)
    returncode = process.wait()
    if returncode:
        raise RuntimeError('objdump failed for %s' % path)
    return entries


def disassembled_call_entries(path, objdump):
    process = subprocess.Popen(
        (str(objdump), '-d', '--no-show-raw-insn', str(path)),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding='utf-8', errors='replace')
    entries = call_entries_from_lines(process.stdout)
    returncode = process.wait()
    if returncode:
        raise RuntimeError('objdump failed for %s' % path)
    return entries


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('elf', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument(
        '--dense-range', action='append', default=[], metavar='START:END',
        help=('also admit every byte coordinate in one half-open executable '
              'range; repeat for independent spans'))
    parser.add_argument(
        '--dense-only', action='store_true',
        help='omit the ELF symbol coordinates and write only dense ranges')
    parser.add_argument(
        '--control-entries', action='store_true',
        help=('include direct branch targets and call/conditional '
              'fallthrough coordinates from objdump'))
    parser.add_argument(
        '--call-entries', action='store_true',
        help='include direct call targets and return continuations from objdump')
    parser.add_argument('--objdump', default='objdump')
    arguments = parser.parse_args(argv)

    symbols = executable_symbols(arguments.elf.read_bytes())
    coordinates = set() if arguments.dense_only else set(symbols)
    if arguments.control_entries:
        coordinates.update(disassembled_control_entries(
            arguments.elf, arguments.objdump))
    if arguments.call_entries:
        coordinates.update(disassembled_call_entries(
            arguments.elf, arguments.objdump))
    for item in arguments.dense_range:
        try:
            start_text, end_text = item.split(':', 1)
            start, end = int(start_text, 0), int(end_text, 0)
        except (TypeError, ValueError) as error:
            parser.error('dense range must be START:END: %s' % error)
        if not 0 <= start <= end < (1 << 64):
            parser.error('dense range is outside u64 or reversed')
        coordinates.update(range(start, end))
    coordinates = tuple(sorted(coordinates))
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        ''.join('0x%016x\n' % coordinate for coordinate in coordinates),
        encoding='utf-8', newline='\n')
    print('wrote %s (%d executable coordinates)' %
          (arguments.output, len(coordinates)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
