/* Bounded little-endian ELF64 input.  See include/postlink/elf.h. */

#include <postlink/elf.h>

static int extent_fits(pl_u64 offset, pl_u64 bytes, pl_u64 limit)
{
    return offset <= limit && bytes <= limit - offset;
}

int pl_elf_open(const pl_u8 *bytes, pl_u64 length, pl_elf_image *out)
{
    if (!bytes || !out || length < PL_ELF_HEADER_BYTES)
        return PL_ERROR_ELF;
    if (bytes[0] != 0x7fu || bytes[1] != 'E' || bytes[2] != 'L'
            || bytes[3] != 'F' || bytes[4] != 2u || bytes[5] != 1u
            || bytes[6] != 1u)
        return PL_ERROR_ELF;
    pl_u32 type = pl_read_u16(bytes + 16u);
    pl_u32 machine = pl_read_u16(bytes + 18u);
    pl_u32 version = pl_read_u32(bytes + 20u);
    pl_u32 header_bytes = pl_read_u16(bytes + 52u);
    pl_u32 program_bytes = pl_read_u16(bytes + 54u);
    pl_u32 program_count = pl_read_u16(bytes + 56u);
    pl_u32 section_bytes = pl_read_u16(bytes + 58u);
    pl_u32 section_count = pl_read_u16(bytes + 60u);
    pl_u32 section_name_index = pl_read_u16(bytes + 62u);
    pl_u64 program_offset = pl_read_u64(bytes + 32u);
    pl_u64 section_offset = pl_read_u64(bytes + 40u);
    if ((type != PL_ELF_TYPE_EXEC && type != PL_ELF_TYPE_DYN)
            || machine != PL_ELF_MACHINE_X86_64 || version != 1u
            || header_bytes != PL_ELF_HEADER_BYTES
            || program_bytes != PL_ELF_PROGRAM_BYTES
            || program_count == 0xffffu)
        return PL_ERROR_ELF;
    if (program_count
            && (!program_offset
                || (pl_u64)program_count
                    > (~0ull - program_offset) / PL_ELF_PROGRAM_BYTES
                || !extent_fits(
                    program_offset,
                    (pl_u64)program_count * PL_ELF_PROGRAM_BYTES, length)))
        return PL_ERROR_ELF_RANGE;
    if (!section_offset) {
        if (section_count || section_name_index) return PL_ERROR_ELF;
        section_bytes = 0u;
    } else {
        if (section_bytes != PL_ELF_SECTION_BYTES
                || !extent_fits(
                    section_offset, PL_ELF_SECTION_BYTES, length))
            return PL_ERROR_ELF_RANGE;
        /* ELF64 extended numbering stores the real values in section zero. */
        if (!section_count) {
            pl_u64 extended = pl_read_u64(bytes + section_offset + 32u);
            if (extended > 0xffffffffu) return PL_ERROR_ELF_RANGE;
            section_count = (pl_u32)extended;
        }
        if (section_name_index == 0xffffu)
            section_name_index = pl_read_u32(bytes + section_offset + 40u);
        if (!section_count
                || (pl_u64)section_count
                    > (~0ull - section_offset) / PL_ELF_SECTION_BYTES
                || !extent_fits(
                    section_offset,
                    (pl_u64)section_count * PL_ELF_SECTION_BYTES, length)
                || (section_name_index && section_name_index >= section_count))
            return PL_ERROR_ELF_RANGE;
    }
    out->bytes = bytes;
    out->length = length;
    out->entry = pl_read_u64(bytes + 24u);
    out->program_offset = program_offset;
    out->section_offset = section_offset;
    out->type = type;
    out->program_count = program_count;
    out->section_count = section_count;
    out->section_name_index = section_name_index;
    return 0;
}

int pl_elf_program(const pl_elf_image *image, pl_u32 index,
                   pl_elf_segment *out)
{
    if (!image || !out || index >= image->program_count)
        return PL_ERROR_ELF;
    pl_u64 offset = image->program_offset
                  + (pl_u64)index * PL_ELF_PROGRAM_BYTES;
    if (!extent_fits(offset, PL_ELF_PROGRAM_BYTES, image->length))
        return PL_ERROR_ELF_RANGE;
    const pl_u8 *row = image->bytes + offset;
    out->type = pl_read_u32(row);
    out->flags = pl_read_u32(row + 4u);
    out->file_offset = pl_read_u64(row + 8u);
    out->virtual_address = pl_read_u64(row + 16u);
    out->physical_address = pl_read_u64(row + 24u);
    out->file_bytes = pl_read_u64(row + 32u);
    out->memory_bytes = pl_read_u64(row + 40u);
    out->alignment = pl_read_u64(row + 48u);
    if (out->file_bytes > out->memory_bytes
            || !extent_fits(
                out->file_offset, out->file_bytes, image->length)
            || out->virtual_address > ~0ull - out->memory_bytes
            || out->physical_address > ~0ull - out->memory_bytes)
        return PL_ERROR_ELF_RANGE;
    if (out->alignment > 1u) {
        if (out->alignment & (out->alignment - 1u))
            return PL_ERROR_ELF;
        pl_u64 mask = out->alignment - 1u;
        if ((out->virtual_address & mask) != (out->file_offset & mask))
            return PL_ERROR_ELF;
    }
    return 0;
}

int pl_elf_segment_is_executable(const pl_elf_segment *segment)
{
    return segment && segment->type == PL_ELF_SEGMENT_LOAD
        && (segment->flags & PL_ELF_FLAG_EXECUTE) != 0u
        && segment->memory_bytes != 0u;
}

int pl_elf_section_read(const pl_elf_image *image, pl_u32 index,
                        pl_elf_section *out)
{
    if (!image || !out || index >= image->section_count
            || !image->section_offset)
        return PL_ERROR_ELF;
    pl_u64 offset = image->section_offset
                  + (pl_u64)index * PL_ELF_SECTION_BYTES;
    if (!extent_fits(offset, PL_ELF_SECTION_BYTES, image->length))
        return PL_ERROR_ELF_RANGE;
    const pl_u8 *row = image->bytes + offset;
    out->name_offset = pl_read_u32(row);
    out->type = pl_read_u32(row + 4u);
    out->flags = pl_read_u64(row + 8u);
    out->address = pl_read_u64(row + 16u);
    out->file_offset = pl_read_u64(row + 24u);
    out->memory_bytes = pl_read_u64(row + 32u);
    out->file_bytes = out->type == PL_ELF_SECTION_NOBITS
                    ? 0u : out->memory_bytes;
    out->link = pl_read_u32(row + 40u);
    out->info = pl_read_u32(row + 44u);
    out->alignment = pl_read_u64(row + 48u);
    out->entry_bytes = pl_read_u64(row + 56u);
    if ((out->file_bytes
            && !extent_fits(
                out->file_offset, out->file_bytes, image->length))
            || out->address > ~0ull - out->memory_bytes)
        return PL_ERROR_ELF_RANGE;
    if (out->alignment > 1u
            && (out->alignment & (out->alignment - 1u)))
        return PL_ERROR_ELF;
    return 0;
}

int pl_elf_section_is_executable(const pl_elf_section *section)
{
    return section && section->memory_bytes
        && (section->flags & (PL_ELF_SECTION_ALLOC
                            | PL_ELF_SECTION_EXECUTE))
            == (PL_ELF_SECTION_ALLOC | PL_ELF_SECTION_EXECUTE);
}
