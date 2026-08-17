#!/usr/bin/env python3
"""Build a content-addressed x86 instruction catalog from ELF files."""

import argparse
from collections import deque
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
CATALOG_MAGIC = b'X86CAT1\0'
CATALOG_HEADER = struct.Struct('<8sI')
CATALOG_OBJECT = struct.Struct('<32sI')
CATALOG_PAGE = struct.Struct('<Q32sI')
CATALOG_OFFSET = struct.Struct('<H')


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
    process = subprocess.Popen(
        (str(objdump), '-d', '--no-show-raw-insn', str(path)),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding='utf-8', errors='replace')
    entries = set()
    tail = deque(maxlen=16)
    for line in process.stdout:
        tail.append(line.rstrip())
        match = INSTRUCTION.match(line)
        if match is not None:
            entries.add(int(match.group(1), 16))
    returncode = process.wait()
    if returncode:
        raise RuntimeError(
            'objdump failed for %s: %s'
            % (path, '\n'.join(tail)[-1000:]))
    return tuple(sorted(entries))


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


def compact_catalog(objects):
    """Pack page-local entries without materializing JSON integer objects."""
    output = bytearray(CATALOG_HEADER.pack(CATALOG_MAGIC, len(objects)))
    for item in objects:
        output.extend(CATALOG_OBJECT.pack(
            bytes.fromhex(item['identity']), len(item['pages'])))
        for page in item['pages']:
            entries = tuple(page['entries'])
            if any(not 0 <= int(offset) < PAGE_BYTES
                   for offset in entries):
                raise ValueError('instruction offset is outside page')
            output.extend(CATALOG_PAGE.pack(
                int(page['virtual_page'], 0),
                bytes.fromhex(page['sha256']), len(entries)))
            for offset in entries:
                output.extend(CATALOG_OFFSET.pack(int(offset)))
    return bytes(output)


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
    object_records = [objects[key] for key in sorted(objects)]
    catalog = {
        'schema': 'native-x86-elf-page-catalog-v1',
        'objects': object_records,
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    if arguments.output.suffix == '.bin':
        arguments.output.write_bytes(compact_catalog(object_records))
    else:
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
