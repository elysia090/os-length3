#include "internal/metadata.h"

#include <support/checked.h>

#define R_X86_64_JUMP_SLOT 7u

#define ELF_DYNAMIC_NULL  0u
#define ELF_DYNAMIC_INIT 12u
#define ELF_DYNAMIC_FINI 13u

#define DW_EH_PE_ABSPTR   0x00u
#define DW_EH_PE_UDATA2   0x02u
#define DW_EH_PE_UDATA4   0x03u
#define DW_EH_PE_UDATA8   0x04u
#define DW_EH_PE_SDATA2   0x0au
#define DW_EH_PE_SDATA4   0x0bu
#define DW_EH_PE_SDATA8   0x0cu
#define DW_EH_PE_PCREL    0x10u
#define DW_EH_PE_DATAREL  0x30u
#define DW_EH_PE_INDIRECT 0x80u
#define DW_EH_PE_OMIT     0xffu

static pl_u64 read_width(const pl_u8 *source, pl_u32 bytes)
{
    pl_u64 value = 0u;
    for (pl_u32 index = 0u; index < bytes; ++index)
        value |= (pl_u64)source[index] << (index * 8u);
    return value;
}

static void write_width(pl_u8 *target, pl_u64 value, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        target[index] = (pl_u8)(value >> (index * 8u));
}

static pl_u32 encoding_width(pl_u8 encoding)
{
    switch (encoding & 0x0fu) {
    case DW_EH_PE_ABSPTR:
    case DW_EH_PE_UDATA8:
    case DW_EH_PE_SDATA8:
        return 8u;
    case DW_EH_PE_UDATA2:
    case DW_EH_PE_SDATA2:
        return 2u;
    case DW_EH_PE_UDATA4:
    case DW_EH_PE_SDATA4:
        return 4u;
    default:
        return 0u;
    }
}

static int encoding_signed(pl_u8 encoding)
{
    pl_u8 format = encoding & 0x0fu;
    return format == DW_EH_PE_SDATA2 || format == DW_EH_PE_SDATA4
        || format == DW_EH_PE_SDATA8;
}

static int encoding_base(pl_u8 encoding, pl_u64 field_address,
                         pl_u64 data_address, pl_u64 *base)
{
    if (encoding & DW_EH_PE_INDIRECT) return 0;
    switch (encoding & 0x70u) {
    case 0u:
        *base = 0u;
        return 1;
    case DW_EH_PE_PCREL:
        *base = field_address;
        return 1;
    case DW_EH_PE_DATAREL:
        *base = data_address;
        return 1;
    default:
        return 0;
    }
}

static int add_signed(pl_u64 base, pl_u64 bits, pl_u64 *value)
{
    pl_i64 delta = (pl_i64)bits;
    if (delta >= 0)
        return pl_checked_add_u64(base, (pl_u64)delta, value);
    pl_u64 magnitude = 0u - (pl_u64)delta;
    if (base < magnitude) return 0;
    *value = base - magnitude;
    return 1;
}

static int decode(const pl_u8 *source, pl_u8 encoding,
                  pl_u64 field_address, pl_u64 data_address,
                  pl_u64 *value)
{
    pl_u32 width = encoding_width(encoding);
    pl_u64 base;
    if (!width || !encoding_base(
            encoding, field_address, data_address, &base))
        return 0;
    pl_u64 raw = read_width(source, width);
    if (encoding_signed(encoding) && width < 8u
            && (raw & (1ull << (width * 8u - 1u))))
        raw |= 0xffffffffffffffffull << (width * 8u);
    return add_signed(base, raw, value);
}

static int signed_fits(pl_i64 value, pl_u32 bits)
{
    if (bits == 64u) return 1;
    pl_i64 minimum = -(1ll << (bits - 1u));
    pl_i64 maximum = (1ll << (bits - 1u)) - 1ll;
    return value >= minimum && value <= maximum;
}

static int encode(const pl_x86_metadata_pointer *pointer,
                  pl_u64 target, pl_u8 *output)
{
    pl_u32 width = encoding_width(pointer->encoding);
    pl_u64 base;
    if (!width || !encoding_base(
            pointer->encoding, pointer->field_address,
            pointer->data_address, &base))
        return 0;
    pl_u64 bits;
    if (target >= base) {
        pl_u64 delta = target - base;
        if (encoding_signed(pointer->encoding)) {
            if (delta > 0x7fffffffffffffffull
                    || !signed_fits((pl_i64)delta, width * 8u))
                return 0;
        } else if (width < 8u && delta >= (1ull << (width * 8u))) {
            return 0;
        }
        bits = delta;
    } else {
        if (!encoding_signed(pointer->encoding)) return 0;
        pl_u64 delta = base - target;
        if (delta > 0x8000000000000000ull) return 0;
        pl_i64 signed_delta = delta == 0x8000000000000000ull
                            ? (pl_i64)0x8000000000000000ull
                            : -(pl_i64)delta;
        if (!signed_fits(signed_delta, width * 8u)) return 0;
        bits = (pl_u64)signed_delta;
    }
    write_width(output, bits, width);
    return 1;
}

static int input_file_at(const pl_elf_image *elf, pl_u64 address,
                         pl_u64 bytes, pl_u64 *file)
{
    pl_u32 owner = 0xffffffffu;
    for (pl_u32 index = 0u; index < elf->program_count; ++index) {
        pl_elf_segment segment;
        if (pl_elf_program(elf, index, &segment)) return 0;
        if (segment.type != PL_ELF_SEGMENT_LOAD
                || address < segment.virtual_address)
            continue;
        pl_u64 relative = address - segment.virtual_address;
        if (relative > segment.file_bytes
                || bytes > segment.file_bytes - relative)
            continue;
        if (owner != 0xffffffffu
                || !pl_checked_add_u64(segment.file_offset, relative, file))
            return 0;
        owner = index;
    }
    return owner != 0xffffffffu;
}

static int visit(pl_x86_metadata_visitor visitor, void *context,
                 pl_x86_metadata_report *report,
                 pl_x86_metadata_kind kind, pl_u64 field,
                 pl_u64 target, pl_u64 data, pl_u8 encoding,
                 pl_u64 record, pl_u64 record_data,
                 pl_u64 extent, pl_u8 record_encoding)
{
    pl_x86_metadata_pointer pointer = {
        field, target, data, record, record_data, extent,
        encoding, record_encoding, (pl_u8)kind
    };
    int status = visitor(context, &pointer);
    if (status) return status;
    if (kind == PL_X86_METADATA_DYNAMIC) ++report->dynamic_pointers;
    else if (kind == PL_X86_METADATA_LAZY_BINDING)
        ++report->lazy_binding_pointers;
    else if (kind == PL_X86_METADATA_UNWIND) ++report->unwind_pointers;
    return 0;
}

static int walk_dynamic(const pl_elf_image *elf,
                        pl_x86_metadata_visitor visitor, void *context,
                        pl_x86_metadata_report *report)
{
    for (pl_u32 index = 0u; index < elf->program_count; ++index) {
        pl_elf_segment segment;
        int status = pl_elf_program(elf, index, &segment);
        if (status) return PL_ERROR_X86_METADATA;
        if (segment.type != PL_ELF_SEGMENT_DYNAMIC) continue;
        if (segment.file_bytes % PL_ELF_DYNAMIC_BYTES)
            return PL_ERROR_X86_METADATA;
        for (pl_u64 row = 0u;
                row < segment.file_bytes; row += PL_ELF_DYNAMIC_BYTES) {
            const pl_u8 *source = elf->bytes + segment.file_offset + row;
            pl_u64 tag = pl_read_u64(source);
            if (tag == ELF_DYNAMIC_NULL) break;
            if (tag != ELF_DYNAMIC_INIT && tag != ELF_DYNAMIC_FINI)
                continue;
            pl_u64 target = pl_read_u64(source + 8u);
            if (!target) continue;
            status = visit(
                visitor, context, report, PL_X86_METADATA_DYNAMIC,
                segment.virtual_address + row + 8u,
                target, 0u, DW_EH_PE_ABSPTR,
                0u, 0u, 0u, 0u);
            if (status) return status;
        }
    }
    return 0;
}

static int walk_lazy(const pl_elf_image *elf,
                     pl_x86_metadata_visitor visitor, void *context,
                     pl_x86_metadata_report *report)
{
    for (pl_u32 section_index = 0u;
            section_index < elf->section_count; ++section_index) {
        pl_elf_section section;
        int status = pl_elf_section_read(elf, section_index, &section);
        if (status) return PL_ERROR_X86_METADATA;
        if (section.type != PL_ELF_SECTION_RELA
                || !(section.flags & PL_ELF_SECTION_ALLOC))
            continue;
        if (section.entry_bytes != PL_ELF_RELOCATION_BYTES
                || section.file_bytes % section.entry_bytes)
            return PL_ERROR_X86_METADATA;
        pl_u64 count = section.file_bytes / section.entry_bytes;
        for (pl_u64 row = 0u; row < count; ++row) {
            pl_elf_relocation relocation;
            status = pl_elf_relocation_read(
                elf, section_index, row, &relocation);
            if (status) return PL_ERROR_X86_METADATA;
            if (relocation.type != R_X86_64_JUMP_SLOT) continue;
            pl_u64 file;
            if (!input_file_at(elf, relocation.offset, 8u, &file))
                return PL_ERROR_X86_METADATA;
            pl_u64 target = pl_read_u64(elf->bytes + file);
            if (!target) continue;
            status = visit(
                visitor, context, report, PL_X86_METADATA_LAZY_BINDING,
                relocation.offset, target, 0u, DW_EH_PE_ABSPTR,
                0u, 0u, 0u, 0u);
            if (status) return status;
        }
    }
    return 0;
}

static int walk_unwind(const pl_elf_image *elf,
                       pl_x86_metadata_visitor visitor, void *context,
                       pl_x86_metadata_report *report)
{
    for (pl_u32 index = 0u; index < elf->program_count; ++index) {
        pl_elf_segment segment;
        int status = pl_elf_program(elf, index, &segment);
        if (status) return PL_ERROR_X86_METADATA;
        if (segment.type != PL_ELF_SEGMENT_GNU_EH_FRAME) continue;
        if (segment.file_bytes < 4u) return PL_ERROR_X86_METADATA;
        const pl_u8 *header = elf->bytes + segment.file_offset;
        if (header[0] != 1u || header[1] == DW_EH_PE_OMIT
                || header[2] == DW_EH_PE_OMIT
                || header[3] == DW_EH_PE_OMIT)
            return PL_ERROR_X86_METADATA;
        pl_u8 frame_encoding = header[1];
        pl_u8 count_encoding = header[2];
        pl_u8 table_encoding = header[3];
        pl_u32 frame_width = encoding_width(frame_encoding);
        pl_u32 count_width = encoding_width(count_encoding);
        pl_u32 table_width = encoding_width(table_encoding);
        if (!frame_width || !count_width || !table_width
                || (count_encoding & 0xf0u)
                || encoding_signed(count_encoding))
            return PL_ERROR_X86_METADATA;
        pl_u64 offset = 4u;
        if (frame_width > segment.file_bytes - offset)
            return PL_ERROR_X86_METADATA;
        pl_u64 frame_address;
        if (!decode(
                header + offset, frame_encoding,
                segment.virtual_address + offset,
                segment.virtual_address, &frame_address)
                || !frame_address)
            return PL_ERROR_X86_METADATA;
        if (report->unwind_frame_address
                && report->unwind_frame_address != frame_address)
            return PL_ERROR_X86_METADATA;
        report->unwind_frame_address = frame_address;
        offset += frame_width;
        if (count_width > segment.file_bytes - offset)
            return PL_ERROR_X86_METADATA;
        pl_u64 rows = read_width(header + offset, count_width);
        offset += count_width;
        if (table_width > (segment.file_bytes - offset) / 2u
                || rows > (segment.file_bytes - offset)
                         / ((pl_u64)table_width * 2u))
            return PL_ERROR_X86_METADATA;
        pl_u64 previous = 0u;
        for (pl_u64 row = 0u; row < rows; ++row) {
            pl_u64 field = segment.virtual_address + offset;
            pl_u64 target;
            if (!decode(header + offset, table_encoding, field,
                        segment.virtual_address, &target)
                    || (row && target <= previous))
                return PL_ERROR_X86_METADATA;
            previous = target;
            offset += table_width;
            pl_u64 fde;
            if (!decode(
                    header + offset, table_encoding,
                    segment.virtual_address + offset,
                    segment.virtual_address, &fde) || !fde)
                return PL_ERROR_X86_METADATA;
            offset += table_width;
            pl_u64 fde_file;
            pl_u32 record_width = encoding_width(frame_encoding);
            if (!record_width || !input_file_at(
                    elf, fde, 8u + 2u * record_width, &fde_file))
                return PL_ERROR_X86_METADATA;
            pl_u32 record_bytes = pl_read_u32(elf->bytes + fde_file);
            if (!record_bytes || record_bytes == 0xffffffffu
                    || record_bytes < 4u + 2u * record_width)
                return PL_ERROR_X86_METADATA;
            pl_u64 total_record_bytes;
            pl_u64 complete_file;
            if (!pl_checked_add_u64(
                    4u, record_bytes, &total_record_bytes)
                    || !input_file_at(
                        elf, fde, total_record_bytes, &complete_file)
                    || complete_file != fde_file)
                return PL_ERROR_X86_METADATA;
            pl_u64 record_target;
            if (!decode(
                    elf->bytes + fde_file + 8u, frame_encoding,
                    fde + 8u, frame_address, &record_target)
                    || record_target != target)
                return PL_ERROR_X86_METADATA;
            pl_u8 range_encoding = frame_encoding & 0x0fu;
            pl_u64 extent;
            if (!decode(
                    elf->bytes + fde_file + 8u + record_width,
                    range_encoding, fde + 8u + record_width,
                    0u, &extent) || !extent)
                return PL_ERROR_X86_METADATA;
            status = visit(
                visitor, context, report, PL_X86_METADATA_UNWIND,
                field, target, segment.virtual_address, table_encoding,
                fde, frame_address, extent, frame_encoding);
            if (status) return status;
        }
    }
    return 0;
}

int pl_x86_metadata_walk(
    const pl_elf_image *elf, pl_x86_metadata_visitor visitor,
    void *context, pl_x86_metadata_report *report)
{
    if (!elf || !visitor || !report) return PL_ERROR_X86_METADATA;
    *report = (pl_x86_metadata_report){ 0 };
    int status = walk_dynamic(elf, visitor, context, report);
    if (!status) status = walk_lazy(elf, visitor, context, report);
    if (!status) status = walk_unwind(elf, visitor, context, report);
    return status;
}

pl_u32 pl_x86_metadata_width(const pl_x86_metadata_pointer *pointer)
{
    return pointer ? encoding_width(pointer->encoding) : 0u;
}

int pl_x86_metadata_encode(const pl_x86_metadata_pointer *pointer,
                           pl_u64 target, pl_u8 *output)
{
    return pointer && output && encode(pointer, target, output)
         ? 0 : PL_ERROR_X86_METADATA;
}
