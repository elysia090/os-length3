#include "internal/relocate-elf.h"
#include "internal/metadata.h"
#include "internal/table.h"

#include <support/checked.h>

#define R_X86_64_NONE       0u
#define R_X86_64_64         1u
#define R_X86_64_PC32       2u
#define R_X86_64_PLT32      4u
#define R_X86_64_RELATIVE   8u
#define R_X86_64_GOTPCREL   9u
#define R_X86_64_32        10u
#define R_X86_64_32S       11u
#define R_X86_64_16        12u
#define R_X86_64_PC16      13u
#define R_X86_64_8         14u
#define R_X86_64_PC8       15u
#define R_X86_64_PC64      24u
#define R_X86_64_IRELATIVE 37u
#define R_X86_64_GOTPCRELX 41u
#define R_X86_64_REX_GOTPCRELX 42u
#define ELF_SYMBOL_GNU_IFUNC 10u

static pl_u64 add_modular(pl_u64 base, pl_u64 addend_bits,
                          pl_u64 correction)
{
    return base + addend_bits + correction;
}

static int executable_symbol(const pl_elf_image *elf,
                             const pl_elf_symbol *symbol)
{
    if (!symbol->section_index
            || symbol->section_index >= elf->section_count)
        return 0;
    pl_elf_section section;
    if (pl_elf_section_read(elf, symbol->section_index, &section)) return -1;
    return pl_elf_section_is_executable(&section)
        && symbol->value >= section.address
        && symbol->value - section.address < section.memory_bytes;
}

/* A construction relocation may name an admitted instruction entry or an
 * exact retained byte inside its source block.  Only the latter needs field
 * projection; synthesized instruction interiors have no source coordinate
 * and correctly remain unresolved. */
static int project_code_address(const pl_x86_native_layout *native,
                                pl_u64 source, pl_u64 *output)
{
    if (!pl_x86_native_resolve(native, source, output)) return 1;
    int retained = 0;
    return !pl_x86_native_project_field(
                native, source, 1u, output, &retained)
        && retained;
}

static int output_file_at(const pl_u8 *input, pl_u64 input_bytes,
                          const pl_x86_runtime_elf_layout *runtime,
                          const pl_x86_native_layout *native,
                          int code, pl_u64 source_address, pl_u64 bytes,
                          pl_u64 *output_address, pl_u64 *file_offset,
                          int *retained,
                          pl_x86_native_projection *projection)
{
    if (!retained || !bytes || bytes > 0xffffffffu)
        return PL_ERROR_X86_RELOCATE;
    *retained = 1;
    if (code) {
        int status = pl_x86_native_project_field_diagnostic(
            native, source_address, (pl_u32)bytes,
            output_address, retained, projection);
        if (status || !*retained) return status;
        if (*output_address < runtime->code_address)
            return PL_ERROR_X86_RELOCATE;
        pl_u64 relative = *output_address - runtime->code_address;
        if (relative > runtime->program_file_bytes[
                           runtime->executable_program]
                || bytes > runtime->program_file_bytes[
                               runtime->executable_program] - relative
                || !pl_checked_add_u64(runtime->code_offset, relative,
                                       file_offset))
            return PL_ERROR_X86_RELOCATE;
        return 0;
    }
    *output_address = source_address;
    return pl_x86_runtime_elf_resolve_file(
        input, input_bytes, runtime, source_address, bytes, file_offset)
         ? PL_ERROR_X86_RELOCATE : 0;
}

static int signed_fits(pl_i64 value, pl_u32 bits)
{
    if (bits == 64u) return 1;
    pl_i64 minimum = -(1ll << (bits - 1u));
    pl_i64 maximum = (1ll << (bits - 1u)) - 1ll;
    return value >= minimum && value <= maximum;
}

static int unsigned_fits(pl_u64 value, pl_u32 bits)
{
    return bits == 64u || value < (1ull << bits);
}

static void write_width(pl_u8 *target, pl_u64 value, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        target[index] = (pl_u8)(value >> (index * 8u));
}

static int write_absolute(pl_u8 *target, pl_u64 value,
                          pl_u32 bits, int signed_value)
{
    if ((signed_value && !signed_fits((pl_i64)value, bits))
            || (!signed_value && !unsigned_fits(value, bits)))
        return 0;
    write_width(target, value, bits / 8u);
    return 1;
}

static int write_relative(pl_u8 *target, pl_u64 destination,
                          pl_u64 base, pl_u32 bits)
{
    pl_i64 value;
    if (destination >= base) {
        pl_u64 delta = destination - base;
        if (delta > 0x7fffffffffffffffull) return 0;
        value = (pl_i64)delta;
    } else {
        pl_u64 delta = base - destination;
        if (delta > 0x8000000000000000ull) return 0;
        value = delta == 0x8000000000000000ull
              ? (pl_i64)0x8000000000000000ull : -(pl_i64)delta;
    }
    if (!signed_fits(value, bits)) return 0;
    write_width(target, (pl_u64)value, bits / 8u);
    return 1;
}

static int code_relative_type(pl_u32 type)
{
    return type == R_X86_64_PC32 || type == R_X86_64_PLT32
        || type == R_X86_64_GOTPCREL
        || type == R_X86_64_GOTPCRELX
        || type == R_X86_64_REX_GOTPCRELX;
}

static int pc_relative_type(pl_u32 type)
{
    return code_relative_type(type)
        || type == R_X86_64_PC16 || type == R_X86_64_PC8
        || type == R_X86_64_PC64;
}

static pl_u32 relocation_width(pl_u32 type)
{
    if (type == R_X86_64_64 || type == R_X86_64_PC64) return 8u;
    if (type == R_X86_64_16 || type == R_X86_64_PC16) return 2u;
    if (type == R_X86_64_8 || type == R_X86_64_PC8) return 1u;
    return 4u;
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

static pl_u64 linked_relative_destination(pl_u64 place,
                                          const pl_u8 *field,
                                          pl_u32 width)
{
    pl_u64 delta = width == 1u
                 ? (pl_u64)(pl_i64)(pl_i8)field[0]
                 : width == 2u
                 ? (pl_u64)(pl_i64)(pl_i16)pl_read_u16(field)
                 : width == 4u
                 ? (pl_u64)(pl_i64)(pl_i32)pl_read_u32(field)
                 : pl_read_u64(field);
    return place + delta;
}

static void unresolved(pl_x86_relocation_report *report,
                       const pl_elf_relocation *relocation,
                       pl_u32 stage)
{
    if (!report->unresolved_records) {
        report->first_unresolved_type = relocation->type;
        report->first_unresolved_offset = relocation->offset;
        report->first_unresolved_stage = stage;
    }
    ++report->unresolved_records;
}

static int rewrite_dynamic_symbols(
    const pl_u8 *input, pl_u64 input_bytes, const pl_elf_image *elf,
    const pl_x86_runtime_elf_layout *runtime,
    const pl_x86_native_layout *native,
    pl_u8 *output, pl_u64 output_bytes,
    pl_x86_relocation_report *report)
{
    for (pl_u32 section_index = 0u;
            section_index < elf->section_count; ++section_index) {
        pl_elf_section section;
        int status = pl_elf_section_read(elf, section_index, &section);
        if (status) return PL_ERROR_X86_RELOCATE;
        if (section.type != PL_ELF_SECTION_DYNSYM
                || !(section.flags & PL_ELF_SECTION_ALLOC))
            continue;
        if (section.entry_bytes != PL_ELF_SYMBOL_BYTES
                || section.file_bytes % section.entry_bytes)
            return PL_ERROR_X86_RELOCATE;
        pl_u64 count = section.file_bytes / section.entry_bytes;
        for (pl_u64 index = 0u; index < count; ++index) {
            pl_elf_symbol symbol;
            status = pl_elf_symbol_read(
                elf, section_index, (pl_u32)index, &symbol);
            if (status) return PL_ERROR_X86_RELOCATE;
            if (symbol.type != PL_ELF_SYMBOL_FUNCTION
                    && symbol.type != ELF_SYMBOL_GNU_IFUNC)
                continue;
            pl_u64 target;
            if (pl_x86_native_resolve(native, symbol.value, &target))
                continue;
            pl_u64 row_address;
            if (!pl_checked_add_u64(
                    section.address,
                    index * section.entry_bytes + 8u, &row_address))
                return PL_ERROR_X86_RELOCATE;
            pl_u64 file;
            status = pl_x86_runtime_elf_resolve_file(
                input, input_bytes, runtime, row_address, 8u, &file);
            if (status || file > output_bytes || 8u > output_bytes - file)
                return PL_ERROR_X86_RELOCATE;
            pl_write_u64(output + file, target);
            ++report->dynamic_symbols;
        }
    }
    return 0;
}

typedef struct {
    const pl_u8 *input;
    pl_u64 input_bytes;
    const pl_x86_runtime_elf_layout *runtime;
    const pl_x86_native_layout *native;
    pl_u8 *output;
    pl_u64 output_bytes;
    pl_x86_relocation_report *report;
} metadata_rewrite;

static int rewrite_metadata_pointer(
    void *opaque, const pl_x86_metadata_pointer *pointer)
{
    metadata_rewrite *rewrite = opaque;
    rewrite->report->metadata_failure_field = pointer->field_address;
    rewrite->report->metadata_failure_target = pointer->target_address;
    rewrite->report->metadata_failure_kind = pointer->kind;
    rewrite->report->metadata_failure_stage = 1u;
    pl_u32 width = pl_x86_metadata_width(pointer);
    if (!width) return PL_ERROR_X86_RELOCATE;
    rewrite->report->metadata_failure_stage = 2u;
    pl_u64 target;
    if (pl_x86_native_resolve(
            rewrite->native, pointer->target_address, &target))
        return PL_ERROR_X86_RELOCATE;
    rewrite->report->metadata_failure_stage = 3u;
    pl_u64 file;
    if (pl_x86_runtime_elf_resolve_file(
            rewrite->input, rewrite->input_bytes, rewrite->runtime,
            pointer->field_address, width, &file)
            || file > rewrite->output_bytes
            || width > rewrite->output_bytes - file)
        return PL_ERROR_X86_RELOCATE;
    rewrite->report->metadata_failure_stage = 4u;
    if (pl_x86_metadata_encode(
            pointer, target, rewrite->output + file))
        return PL_ERROR_X86_RELOCATE;
    if (pointer->kind == PL_X86_METADATA_DYNAMIC)
        ++rewrite->report->dynamic_code_pointers;
    else if (pointer->kind == PL_X86_METADATA_LAZY_BINDING)
        ++rewrite->report->lazy_binding_code_pointers;
    else if (pointer->kind == PL_X86_METADATA_UNWIND) {
        rewrite->report->metadata_failure_stage = 5u;
        pl_x86_metadata_pointer record = *pointer;
        record.field_address = pointer->record_address + 8u;
        record.data_address = pointer->record_data_address;
        record.encoding = pointer->record_encoding;
        pl_u32 record_width = pl_x86_metadata_width(&record);
        pl_u64 record_file;
        if (!record_width
                || pl_x86_runtime_elf_resolve_file(
                    rewrite->input, rewrite->input_bytes, rewrite->runtime,
                    record.field_address, record_width, &record_file)
                || record_file > rewrite->output_bytes
                || record_width > rewrite->output_bytes - record_file
                || pl_x86_metadata_encode(
                    &record, target, rewrite->output + record_file))
            return PL_ERROR_X86_RELOCATE;
        rewrite->report->metadata_failure_stage = 6u;
        pl_u64 source_end;
        pl_u64 output_end;
        if (!pl_checked_add_u64(
                pointer->target_address, pointer->source_extent, &source_end)
                || pl_x86_native_project_boundary(
                    rewrite->native, source_end, &output_end)
                || output_end <= target)
            return PL_ERROR_X86_RELOCATE;
        rewrite->report->metadata_failure_stage = 7u;
        record.field_address += record_width;
        record.data_address = 0u;
        record.encoding &= 0x0fu;
        pl_u32 range_width = pl_x86_metadata_width(&record);
        pl_u64 range_file;
        if (!range_width
                || pl_x86_runtime_elf_resolve_file(
                    rewrite->input, rewrite->input_bytes, rewrite->runtime,
                    record.field_address, range_width, &range_file)
                || range_file > rewrite->output_bytes
                || range_width > rewrite->output_bytes - range_file
                || pl_x86_metadata_encode(
                    &record, output_end - target,
                    rewrite->output + range_file))
            return PL_ERROR_X86_RELOCATE;
        ++rewrite->report->unwind_rows;
        ++rewrite->report->unwind_ranges;
    }
    else
        return PL_ERROR_X86_RELOCATE;
    rewrite->report->metadata_failure_field = 0u;
    rewrite->report->metadata_failure_target = 0u;
    rewrite->report->metadata_failure_kind = 0u;
    rewrite->report->metadata_failure_stage = 0u;
    return 0;
}

int pl_x86_relocate_elf(
    const pl_u8 *input, pl_u64 input_bytes,
    const pl_x86_runtime_elf_layout *runtime,
    const pl_x86_native_layout *native,
    const pl_x86_table *tables, pl_u32 table_count,
    pl_u8 *output, pl_u64 output_bytes,
    pl_x86_relocation_report *report)
{
    pl_elf_image elf;
    if (!input || !runtime || !native || !output || !report
            || (table_count && !tables))
        return PL_ERROR_X86_RELOCATE;
    int status = pl_elf_open(input, input_bytes, &elf);
    if (status) return PL_ERROR_X86_RELOCATE;
    *report = (pl_x86_relocation_report){ 0 };
    /* Construction-relocation coverage for pointer arrays.  A `.init_array`/
     * `.fini_array`/`.preinit_array` slot holds a function address; if the
     * image carries no relocation section for that array (a link without
     * `--emit-relocs`), the slot cannot be projected when code moves and would
     * be emitted stale.  Refuse only that shape: a self-contained image with
     * empty or absent pointer arrays (the relocation-free product fixture)
     * still passes because there is nothing to rewrite. */
    for (pl_u32 section_index = 0u;
            section_index < elf.section_count; ++section_index) {
        pl_elf_section section;
        if (pl_elf_section_read(&elf, section_index, &section))
            return PL_ERROR_X86_RELOCATE;
        if (section.type != PL_ELF_SECTION_INIT_ARRAY
                && section.type != PL_ELF_SECTION_FINI_ARRAY
                && section.type != PL_ELF_SECTION_PREINIT_ARRAY)
            continue;
        int covered = 0;
        for (pl_u32 other = 0u;
                other < elf.section_count && !covered; ++other) {
            pl_elf_section candidate;
            if (pl_elf_section_read(&elf, other, &candidate))
                return PL_ERROR_X86_RELOCATE;
            if (candidate.type == PL_ELF_SECTION_RELA
                    && candidate.info == section_index)
                covered = 1;
        }
        if (covered) continue;
        if (section.entry_bytes != 8u || section.file_bytes % 8u)
            return PL_ERROR_X86_RELOCATE;
        pl_u64 count = section.file_bytes / 8u;
        for (pl_u64 row = 0u; row < count; ++row) {
            pl_u64 at = section.file_offset + row * 8u;
            if (at > elf.length || 8u > elf.length - at)
                return PL_ERROR_X86_RELOCATE;
            const pl_u8 *bytes = elf.bytes + at;
            pl_u64 value = 0u;
            for (pl_u32 byte = 0u; byte < 8u; ++byte)
                value |= (pl_u64)bytes[byte] << (8u * byte);
            if (value) return PL_ERROR_X86_RELOCATE;
        }
    }
    metadata_rewrite metadata = {
        input, input_bytes, runtime, native,
        output, output_bytes, report
    };
    pl_x86_metadata_report metadata_report;
    status = pl_x86_metadata_walk(
        &elf, rewrite_metadata_pointer, &metadata, &metadata_report);
    if (status) return status;
    status = rewrite_dynamic_symbols(
        input, input_bytes, &elf, runtime, native,
        output, output_bytes, report);
    if (status) return status;

    for (pl_u32 section_index = 0u;
            section_index < elf.section_count; ++section_index) {
        pl_elf_section section;
        status = pl_elf_section_read(&elf, section_index, &section);
        if (status) return PL_ERROR_X86_RELOCATE;
        if (section.type != PL_ELF_SECTION_RELA) continue;
        if (section.entry_bytes != PL_ELF_RELOCATION_BYTES
                || section.file_bytes % section.entry_bytes)
            return PL_ERROR_X86_RELOCATE;
        pl_elf_section target_section = { 0 };
        int code_place = 0;
        int allocated_place = 0;
        if (section.info) {
            status = pl_elf_section_read(
                &elf, section.info, &target_section);
            if (status) return PL_ERROR_X86_RELOCATE;
            code_place = pl_elf_section_is_executable(&target_section);
            allocated_place = !!(target_section.flags
                                  & PL_ELF_SECTION_ALLOC);
        }
        /* A RELA section without a symbol-table link cannot name a symbol;
         * static images keep symbol-free IRELATIVE rows in `.rela.plt`
         * (`sh_link == 0`).  Those rows are resolved from their addend by the
         * RELATIVE/IRELATIVE path below and must not be read as a symbol. */
        int has_symbols = 0;
        if (section.link < elf.section_count) {
            pl_elf_section symbols;
            status = pl_elf_section_read(&elf, section.link, &symbols);
            if (status) return PL_ERROR_X86_RELOCATE;
            has_symbols = symbols.type == PL_ELF_SECTION_SYMTAB
                       || symbols.type == PL_ELF_SECTION_DYNSYM;
        }
        pl_u64 count = section.file_bytes / section.entry_bytes;
        pl_x86_table_cursor table = { 0 };
        for (pl_u64 index = 0u; index < count; ++index) {
            pl_elf_relocation relocation;
            pl_elf_symbol symbol = { 0 };
            if (has_symbols) {
                status = pl_elf_relocation_read(
                    &elf, section_index, index, &relocation);
                if (!status)
                    status = pl_elf_symbol_read(
                        &elf, relocation.symbol_table_section,
                        relocation.symbol_index, &symbol);
            } else {
                status = pl_elf_relocation_read_symbol_free(
                    &elf, section_index, index, &relocation);
            }
            if (status) return PL_ERROR_X86_RELOCATE;
            ++report->records;

            int symbol_code = executable_symbol(&elf, &symbol);
            if (symbol_code < 0) return PL_ERROR_X86_RELOCATE;
            int table_row = 0;
            pl_u64 table_base = 0u;
            pl_u64 table_target = 0u;
            status = pl_x86_table_row(
                &elf, &relocation, &symbol, &target_section,
                tables, table_count, &table,
                &table_row, &table_base, &table_target);
            if (status) return PL_ERROR_X86_RELOCATE;
            pl_u32 width = relocation_width(relocation.type);
            pl_u64 candidate = symbol.value;
            pl_u64 correction = code_place
                             && (relocation.type == R_X86_64_PC32
                                 || relocation.type == R_X86_64_PLT32)
                              ? 4u : 0u;
            if (symbol_code)
                candidate = add_modular(
                    symbol.value, relocation.addend_bits, correction);
            /* Allocated bytes are the final linked program, while static
             * relocation rows are only construction history.  A post-link
             * table sorter may reorder the resolved fields without also
             * reordering its now-stale RELA section (Linux __ex_table does
             * exactly this).  For a linked PC-relative field, the byte-level
             * normal form is already complete:
             *
             *     target = place + sign_extend(linked_field)
             *
             * Project that target and never reconstruct the old symbolic
             * expression.  This also makes saved and executed coordinates
             * share one authority. */
            if (allocated_place && !code_place
                    && pc_relative_type(relocation.type)) {
                pl_u64 input_file = 0u;
                if (!input_file_at(
                        &elf, relocation.offset, width, &input_file)
                        || input_file > input_bytes
                        || width > input_bytes - input_file)
                    return PL_ERROR_X86_RELOCATE;
                candidate = linked_relative_destination(
                    relocation.offset, input + input_file, width);
            }
            pl_u64 moved_target = 0u;
            int target_moved = symbol_code
                && project_code_address(native, candidate, &moved_target);
            if (symbol_code && !target_moved) {
                pl_u64 moved_symbol = 0u;
                if (project_code_address(
                        native, symbol.value, &moved_symbol)) {
                    moved_target = add_modular(
                        moved_symbol, relocation.addend_bits, correction);
                    target_moved = 1;
                }
            }

            if (section.flags & PL_ELF_SECTION_ALLOC) {
                if ((relocation.type == R_X86_64_RELATIVE
                            || relocation.type == R_X86_64_IRELATIVE)
                        && !pl_x86_native_resolve(
                            native, relocation.addend_bits, &moved_target)) {
                    pl_u64 addend_address;
                    if (!pl_checked_add_u64(
                            section.address,
                            index * section.entry_bytes + 16u,
                            &addend_address))
                        return PL_ERROR_X86_RELOCATE;
                    pl_u64 file;
                    status = pl_x86_runtime_elf_resolve_file(
                        input, input_bytes, runtime,
                        addend_address, 8u, &file);
                    if (status || file > output_bytes
                            || 8u > output_bytes - file)
                        return PL_ERROR_X86_RELOCATE;
                    pl_write_u64(output + file, moved_target);
                    ++report->dynamic_addends;
                } else {
                    ++report->unchanged_records;
                }
                continue;
            }

            /* A linked RELA record against debug/comment/construction data
             * uses a section-relative r_offset.  That target section is not
             * part of any runtime PT_LOAD and is deliberately absent from the
             * optimized ELF, so treating the offset as a virtual address
             * would corrupt low runtime bytes (including the ELF header). */
            if (section.info && !allocated_place) {
                ++report->unchanged_records;
                continue;
            }

            if (table_row) {
                pl_u64 place;
                pl_u64 file;
                int retained = 1;
                pl_u64 moved_table_target;
                status = output_file_at(
                    input, input_bytes, runtime, native, 0,
                    relocation.offset, 4u, &place, &file, &retained, 0);
                if (status || !retained || file > output_bytes
                        || 4u > output_bytes - file
                        || pl_x86_native_resolve(
                            native, table_target, &moved_table_target)
                        || !write_relative(
                            output + file, moved_table_target,
                            table_base, 32u)) {
                    unresolved(report, &relocation, 2u);
                    continue;
                }
                ++report->runtime_fields;
                ++report->rewritten_fields;
                continue;
            }

            pl_u64 place;
            pl_u64 file;
            int retained = 1;
            pl_x86_native_projection projection = { 0 };
            status = output_file_at(
                input, input_bytes, runtime, native, code_place,
                relocation.offset, width, &place, &file, &retained,
                &projection);
            if (!status && code_place && !retained) {
                /* The entire source instruction is outside the closed native
                 * population.  Its construction field has no output byte,
                 * independent of the relocation's arithmetic width. */
                ++report->eliminated_code_fields;
                ++report->rewritten_fields;
                continue;
            }
            if (status || !retained || file > output_bytes
                    || width > output_bytes - file) {
                if (status && !report->unresolved_records) {
                    report->projection_source = projection.source_address;
                    report->projection_source_end = projection.source_end;
                    report->projection_block_start = projection.block_start;
                    report->projection_block_end = projection.block_end;
                    report->projection_omitted_end = projection.omitted_end;
                }
                unresolved(report, &relocation,
                           status ? 300u + (pl_u32)(-status)
                                  : !retained ? 32u : 33u);
                continue;
            }
            if (projection.reason
                    == PL_X86_NATIVE_PROJECTION_SYNTHETIC_FIELD
                    && projection.synthetic_kind
                       == PL_X86_NATIVE_FIXUP_ABSOLUTE) {
                pl_u64 projected = 0u;
                moved_target = project_code_address(
                    native, projection.synthetic_target, &projected)
                             ? projected : projection.synthetic_target;
                target_moved = 1;
            }
            if (code_place) ++report->code_fields;
            else ++report->runtime_fields;

            int source_identity_field = code_place
                && projection.reason
                   == PL_X86_NATIVE_PROJECTION_SOURCE_IDENTITY;
            if (code_place && code_relative_type(relocation.type)
                    && !source_identity_field) {
                /* Native selection has already rebound the decoded semantic
                 * target.  Reaching the exact retained field is the matching
                 * construction-record proof. */
                ++report->rewritten_fields;
                continue;
            }
            if (!target_moved
                    && !(source_identity_field
                         && pc_relative_type(relocation.type)
                         && !symbol_code)) {
                ++report->unchanged_records;
                continue;
            }

            int written = 0;
            pl_u64 relative_destination = moved_target;
            if (source_identity_field
                    && pc_relative_type(relocation.type)) {
                if (symbol_code) {
                    if (!target_moved || moved_target < correction) {
                        unresolved(report, &relocation, 5u);
                        continue;
                    }
                    relative_destination = moved_target - correction;
                } else {
                    relative_destination = add_modular(
                        symbol.value, relocation.addend_bits, 0u);
                }
            }
            switch (relocation.type) {
            case R_X86_64_64:
                written = write_absolute(output + file, moved_target, 64u, 0);
                break;
            case R_X86_64_32:
                written = write_absolute(output + file, moved_target, 32u, 0);
                break;
            case R_X86_64_32S:
                written = write_absolute(output + file, moved_target, 32u, 1);
                break;
            case R_X86_64_16:
                written = write_absolute(output + file, moved_target, 16u, 0);
                break;
            case R_X86_64_8:
                written = write_absolute(output + file, moved_target, 8u, 0);
                break;
            case R_X86_64_PC32:
            case R_X86_64_PLT32:
                /* ELF PC-relative records use S + A - P.  An x86
                 * instruction adds its displacement to the following RIP,
                 * but those executable fields were rebound by native
                 * selection above and never reach this generic path. */
                written = write_relative(
                    output + file, relative_destination, place, 32u);
                break;
            case R_X86_64_PC16:
                written = write_relative(
                    output + file, relative_destination, place, 16u);
                break;
            case R_X86_64_PC8:
                written = write_relative(
                    output + file, relative_destination, place, 8u);
                break;
            case R_X86_64_PC64:
                written = write_relative(
                    output + file, relative_destination, place, 64u);
                break;
            case R_X86_64_NONE:
                written = 1;
                break;
            default:
                break;
            }
            if (!written) unresolved(report, &relocation, 4u);
            else ++report->rewritten_fields;
        }
    }
    return report->unresolved_records ? PL_ERROR_X86_RELOCATE : 0;
}
