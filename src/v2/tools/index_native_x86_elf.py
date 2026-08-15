#!/usr/bin/env python3
"""Build a content-addressed x86 instruction catalog from ELF files."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess


ELF_HEADER = struct.Struct('<16sHHIQQQIHHHHHH')
PROGRAM_HEADER = struct.Struct('<IIQQQQQQ')
PAGE_BYTES = 4096
PT_LOAD = 1
PF_X = 1
INSTRUCTION = re.compile(r'^\s*([0-9a-fA-F]+):\s+\S')


def _align_up(value, alignment=PAGE_BYTES):
    return (int(value) + alignment - 1) & -alignment


def executable_pages(payload):
    """Return the file-backed page image for each executable PT_LOAD page."""
    if len(payload) < ELF_HEADER.size:
        raise ValueError('ELF header is truncated')
    fields = ELF_HEADER.unpack_from(payload)
    (ident, _kind, machine, _version, _entry, program_offset,
     _section_offset, _flags, header_bytes, program_bytes, program_count,
     _section_bytes, _section_count, _strings) = fields
    if (ident[:6] != b'\x7fELF\x02\x01' or machine != 62
            or header_bytes != ELF_HEADER.size
            or program_bytes != PROGRAM_HEADER.size):
        raise ValueError('ELF is not x86-64 little-endian')
    if program_offset + program_count * program_bytes > len(payload):
        raise ValueError('ELF program table is truncated')
    pages = {}
    for index in range(program_count):
        values = PROGRAM_HEADER.unpack_from(
            payload, program_offset + index * program_bytes)
        (kind, flags, offset, virtual, _physical, file_bytes,
         memory_bytes, alignment) = values
        if kind != PT_LOAD or not flags & PF_X or not memory_bytes:
            continue
        if (file_bytes > memory_bytes or offset + file_bytes > len(payload)
                or (alignment and virtual % alignment != offset % alignment)):
            raise ValueError('executable PT_LOAD segment is invalid')
        virtual_page = virtual & -PAGE_BYTES
        file_page = offset & -PAGE_BYTES
        for page in range(
                virtual_page, _align_up(virtual + memory_bytes), PAGE_BYTES):
            source = file_page + page - virtual_page
            image = bytearray(payload[source:source + PAGE_BYTES])
            image.extend(b'\0' * (PAGE_BYTES - len(image)))
            zero_from = virtual + file_bytes
            if memory_bytes > file_bytes and page < zero_from < page + PAGE_BYTES:
                image[zero_from - page:] = b'\0' * (page + PAGE_BYTES - zero_from)
            elif page >= zero_from:
                image[:] = b'\0' * PAGE_BYTES
            prior = pages.get(page)
            if prior is not None and prior != bytes(image):
                raise ValueError('overlapping executable segments disagree')
            pages[page] = bytes(image)
    if not pages:
        raise ValueError('ELF has no executable PT_LOAD pages')
    return pages


def disassembled_entries(path, objdump):
    completed = subprocess.run(
        (str(objdump), '-d', '--no-show-raw-insn', str(path)),
        capture_output=True, text=True, encoding='utf-8', errors='replace',
        check=False)
    if completed.returncode:
        raise RuntimeError(
            'objdump failed for %s: %s'
            % (path, completed.stderr.strip()[-1000:]))
    return tuple(sorted(set(
        int(match.group(1), 16)
        for line in completed.stdout.splitlines()
        if (match := INSTRUCTION.match(line)) is not None)))


def index_elf(path, objdump):
    payload = Path(path).read_bytes()
    pages = executable_pages(payload)
    entries = disassembled_entries(path, objdump)
    offsets = {page: [] for page in pages}
    for coordinate in entries:
        page = coordinate & -PAGE_BYTES
        if page in offsets:
            offsets[page].append(coordinate - page)
    records = []
    for page, image in sorted(pages.items()):
        if not offsets[page]:
            continue
        records.append({
            'virtual_page': hex(page),
            'sha256': hashlib.sha256(image).hexdigest(),
            'entries': offsets[page],
        })
    if not records:
        raise ValueError('objdump found no executable instruction entries')
    return {
        'identity': hashlib.sha256(payload).hexdigest(),
        'name': Path(path).name,
        'pages': records,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('elf', type=Path, nargs='+')
    parser.add_argument('--objdump', default='objdump')
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args(argv)
    objects = {}
    for path in arguments.elf:
        record = index_elf(path, arguments.objdump)
        objects.setdefault(record['identity'], record)
    catalog = {
        'schema': 'native-x86-elf-page-catalog-v1',
        'objects': [objects[key] for key in sorted(objects)],
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(catalog, indent=2, sort_keys=True) + '\n',
        encoding='utf-8', newline='\n')
    print(json.dumps({
        'objects': len(objects),
        'pages': sum(len(item['pages']) for item in objects.values()),
        'coordinates': sum(
            len(page['entries']) for item in objects.values()
            for page in item['pages']),
        'output': str(arguments.output),
    }, sort_keys=True))


if __name__ == '__main__':
    main()
