#include "internal/layout-elf.h"

#include <support/checked.h>

static int add_u64(pl_u64 left, pl_u64 right, pl_u64 *out)
{
    return pl_checked_add_u64(left, right, out);
}

static int congruent_at_or_after(pl_u64 at, pl_u64 address,
                                 pl_u64 alignment, pl_u64 *out)
{
    if (!alignment || (alignment & (alignment - 1u)))
        return 0;
    pl_u64 have = at & (alignment - 1u);
    pl_u64 want = address & (alignment - 1u);
    pl_u64 add = want >= have ? want - have : alignment - (have - want);
    return add_u64(at, add, out);
}

#define PL_ELF_SEGMENT_PHDR 6u

typedef struct {
    pl_u64 address;
    pl_u64 file_bytes;
    pl_u64 memory_bytes;
    pl_u32 owner;
} code_cut;

typedef struct {
    pl_elf_segment segment;
    pl_u64 source_file_offset;
    pl_u64 source_file_bytes;
    pl_u32 owner;
} load_piece;

static int range_end(pl_u64 begin, pl_u64 bytes, pl_u64 *end)
{
    return add_u64(begin, bytes, end);
}

static int section_owner(const pl_elf_segment *programs, pl_u32 count,
                         const pl_elf_section *section, pl_u32 *owner)
{
    pl_u32 found = 0xffffffffu;
    for (pl_u32 index = 0u; index < count; ++index) {
        const pl_elf_segment *load = &programs[index];
        if (load->type != PL_ELF_SEGMENT_LOAD
                || section->address < load->virtual_address)
            continue;
        pl_u64 relative = section->address - load->virtual_address;
        if (relative > load->file_bytes
                || section->file_bytes > load->file_bytes - relative
                || section->file_offset != load->file_offset + relative)
            continue;
        if (found != 0xffffffffu) return 0;
        found = index;
    }
    if (found == 0xffffffffu) return 0;
    *owner = found;
    return 1;
}

static void sort_cuts(code_cut *cuts, pl_u32 count)
{
    for (pl_u32 index = 1u; index < count; ++index) {
        code_cut value = cuts[index];
        pl_u32 at = index;
        while (at && cuts[at - 1u].address > value.address) {
            cuts[at] = cuts[at - 1u];
            --at;
        }
        cuts[at] = value;
    }
}

static int retained_section_in_gap(const pl_elf_image *elf,
                                   pl_u64 begin, pl_u64 end,
                                   int *present)
{
    if (!elf || !present || end < begin) return PL_ERROR_X86_LAYOUT;
    *present = 0;
    for (pl_u32 index = 0u; index < elf->section_count; ++index) {
        pl_elf_section section;
        int status = pl_elf_section_read(elf, index, &section);
        if (status) return PL_ERROR_X86_LAYOUT;
        if (!(section.flags & PL_ELF_SECTION_ALLOC)
                || pl_elf_section_is_executable(&section)
                || !section.file_bytes)
            continue;
        pl_u64 section_end;
        if (!range_end(section.address, section.file_bytes, &section_end))
            return PL_ERROR_X86_LAYOUT;
        if (begin < section_end && section.address < end) {
            *present = 1;
            return 0;
        }
    }
    return 0;
}

static int merge_code_padding(const pl_elf_image *elf,
                              code_cut *cuts, pl_u32 *count)
{
    if (!elf || !cuts || !count || !*count) return PL_ERROR_X86_LAYOUT;
    pl_u32 written = 0u;
    for (pl_u32 index = 0u; index < *count; ++index) {
        if (!written) {
            cuts[written++] = cuts[index];
            continue;
        }
        code_cut *previous = &cuts[written - 1u];
        pl_u64 previous_end, current_end;
        if (!range_end(previous->address, previous->file_bytes,
                       &previous_end)
                || !range_end(cuts[index].address,
                              cuts[index].file_bytes, &current_end)
                || previous_end > cuts[index].address)
            return PL_ERROR_X86_LAYOUT;
        int retained = 1;
        int status = previous->owner == cuts[index].owner
                   ? retained_section_in_gap(
                        elf, previous_end, cuts[index].address, &retained)
                   : 0;
        if (status) return status;
        if (previous->owner == cuts[index].owner && !retained) {
            previous->file_bytes = current_end - previous->address;
            previous->memory_bytes = previous->file_bytes;
        } else {
            cuts[written++] = cuts[index];
        }
    }
    *count = written;
    return 0;
}

static int append_piece(load_piece *pieces, pl_u32 *count,
                        const pl_elf_segment *load, pl_u32 owner,
                        pl_u64 relative, pl_u64 file_bytes,
                        pl_u64 memory_bytes)
{
    if (!pieces || !count || !load || !memory_bytes
            || file_bytes > memory_bytes
            || *count >= PL_X86_LAYOUT_PROGRAM_LIMIT
            || relative > load->file_bytes
            || file_bytes > load->file_bytes - relative)
        return 0;
    load_piece *piece = &pieces[(*count)++];
    piece->segment = *load;
    piece->segment.file_offset = 0u;
    piece->segment.virtual_address = load->virtual_address + relative;
    piece->segment.physical_address = load->physical_address + relative;
    piece->segment.file_bytes = file_bytes;
    piece->segment.memory_bytes = memory_bytes;
    piece->source_file_offset = load->file_offset + relative;
    piece->source_file_bytes = file_bytes;
    piece->owner = owner;
    return 1;
}

static int append_program(pl_x86_runtime_elf_layout *layout,
                          const pl_elf_segment *program,
                          pl_u64 source_offset, pl_u64 source_bytes,
                          pl_u32 *index)
{
    if (!layout || !program || layout->program_count
            >= PL_X86_LAYOUT_PROGRAM_LIMIT)
        return 0;
    pl_u32 at = layout->program_count++;
    layout->programs[at] = *program;
    layout->source_file_offset[at] = source_offset;
    layout->source_file_bytes[at] = source_bytes;
    if (index) *index = at;
    return 1;
}

int pl_x86_runtime_elf_measure(const pl_u8 *input, pl_u64 input_bytes,
                               pl_u64 compact_code_bytes,
                               pl_x86_runtime_elf_layout *layout)
{
    pl_elf_image elf;
    pl_elf_segment programs[PL_X86_LAYOUT_PROGRAM_LIMIT];
    code_cut cuts[PL_X86_LAYOUT_PROGRAM_LIMIT];
    load_piece pieces[PL_X86_LAYOUT_PROGRAM_LIMIT];
    pl_u8 piece_added[PL_X86_LAYOUT_PROGRAM_LIMIT] = { 0u };
    pl_u8 load_placed[PL_X86_LAYOUT_PROGRAM_LIMIT] = { 0u };
    pl_u64 header_end;
    if (!input || !input_bytes || !compact_code_bytes || !layout)
        return PL_ERROR_X86_LAYOUT;
    int status = pl_elf_open(input, input_bytes, &elf);
    if (status || !elf.program_count
            || elf.program_count > PL_X86_LAYOUT_PROGRAM_LIMIT
            || !pl_checked_mul_u64(
                elf.program_count, PL_ELF_PROGRAM_BYTES, &header_end)
            || !add_u64(elf.program_offset, header_end, &header_end)
            || header_end > input_bytes)
        return PL_ERROR_X86_LAYOUT;
    *layout = (pl_x86_runtime_elf_layout){ 0 };
    layout->input_program_count = elf.program_count;
    layout->executable_program = 0xffffffffu;
    for (pl_u32 index = 0u; index < elf.program_count; ++index) {
        status = pl_elf_program(&elf, index, &programs[index]);
        if (status) return PL_ERROR_X86_LAYOUT;
    }

    pl_u32 cut_count = 0u;
    for (pl_u32 index = 0u; index < elf.section_count; ++index) {
        pl_elf_section section;
        status = pl_elf_section_read(&elf, index, &section);
        if (status) return PL_ERROR_X86_LAYOUT;
        if (!pl_elf_section_is_executable(&section)) continue;
        if (cut_count >= PL_X86_LAYOUT_PROGRAM_LIMIT
                || section.file_bytes != section.memory_bytes)
            return PL_ERROR_X86_LAYOUT;
        pl_u32 owner = 0u;
        if (!section_owner(programs, elf.program_count, &section, &owner))
            return PL_ERROR_X86_LAYOUT;
        cuts[cut_count++] = (code_cut){
            section.address, section.file_bytes, section.memory_bytes, owner,
        };
    }
    if (!cut_count) {
        for (pl_u32 index = 0u; index < elf.program_count; ++index) {
            if (!pl_elf_segment_is_executable(&programs[index])) continue;
            if (cut_count >= PL_X86_LAYOUT_PROGRAM_LIMIT
                    || programs[index].file_bytes
                       != programs[index].memory_bytes)
                return PL_ERROR_X86_LAYOUT;
            cuts[cut_count++] = (code_cut){
                programs[index].virtual_address,
                programs[index].file_bytes,
                programs[index].memory_bytes, index,
            };
        }
    }
    if (!cut_count) return PL_ERROR_X86_LAYOUT;
    sort_cuts(cuts, cut_count);
    status = merge_code_padding(&elf, cuts, &cut_count);
    if (status) return status;
    layout->code_address = cuts[0].address;
    layout->code_bytes = compact_code_bytes;
    pl_u32 code_owner = cuts[0].owner;

    pl_u32 piece_count = 0u;
    for (pl_u32 owner = 0u; owner < elf.program_count; ++owner) {
        const pl_elf_segment *load = &programs[owner];
        if (load->type != PL_ELF_SEGMENT_LOAD) continue;
        pl_u64 cursor = 0u;
        pl_u32 last_piece = 0xffffffffu;
        for (pl_u32 cut = 0u; cut < cut_count; ++cut) {
            if (cuts[cut].owner != owner) continue;
            if (cuts[cut].address < load->virtual_address)
                return PL_ERROR_X86_LAYOUT;
            pl_u64 relative = cuts[cut].address - load->virtual_address;
            pl_u64 cut_end;
            if (relative < cursor
                    || relative > load->file_bytes
                    || !range_end(relative, cuts[cut].file_bytes, &cut_end)
                    || cut_end > load->file_bytes)
                return PL_ERROR_X86_LAYOUT;
            if (relative > cursor) {
                if (!append_piece(
                        pieces, &piece_count, load, owner, cursor,
                        relative - cursor, relative - cursor))
                    return PL_ERROR_X86_LAYOUT;
                last_piece = piece_count - 1u;
            }
            cursor = cut_end;
        }
        if (cursor < load->file_bytes) {
            pl_u64 tail = load->file_bytes - cursor;
            if (!append_piece(
                    pieces, &piece_count, load, owner,
                    cursor, tail, tail))
                return PL_ERROR_X86_LAYOUT;
            last_piece = piece_count - 1u;
        }
        if (load->memory_bytes > load->file_bytes) {
            pl_u64 zero_bytes = load->memory_bytes - load->file_bytes;
            if (last_piece != 0xffffffffu
                    && pieces[last_piece].owner == owner
                    && pieces[last_piece].segment.virtual_address
                       + pieces[last_piece].segment.file_bytes
                       == load->virtual_address + load->file_bytes) {
                pieces[last_piece].segment.memory_bytes += zero_bytes;
            } else if (!append_piece(
                    pieces, &piece_count, load, owner, load->file_bytes,
                    0u, zero_bytes)) {
                return PL_ERROR_X86_LAYOUT;
            }
        }
    }

    pl_u64 code_end;
    if (!range_end(layout->code_address, compact_code_bytes, &code_end))
        return PL_ERROR_X86_LAYOUT;
    for (pl_u32 index = 0u; index < piece_count; ++index) {
        pl_u64 piece_end;
        if (!range_end(pieces[index].segment.virtual_address,
                       pieces[index].segment.memory_bytes, &piece_end)
                || (layout->code_address < piece_end
                    && pieces[index].segment.virtual_address < code_end))
            return PL_ERROR_X86_LAYOUT;
    }

    pl_elf_segment code = programs[code_owner];
    code.type = PL_ELF_SEGMENT_LOAD;
    code.file_offset = 0u;
    code.physical_address += layout->code_address - code.virtual_address;
    code.virtual_address = layout->code_address;
    code.file_bytes = compact_code_bytes;
    code.memory_bytes = compact_code_bytes;
    code.flags = PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE;

    /* Preserve original program-header order.  A source PT_LOAD expands into
     * its retained intervals; the compact code interval occupies the first
     * source load which owned linked code. */
    for (pl_u32 owner = 0u; owner < elf.program_count; ++owner) {
        if (programs[owner].type != PL_ELF_SEGMENT_LOAD) {
            if (!append_program(layout, &programs[owner], 0u, 0u, 0))
                return PL_ERROR_X86_LAYOUT;
            continue;
        }
        for (;;) {
            pl_u32 selected = 0xffffffffu;
            pl_u64 lowest = 0xffffffffffffffffull;
            int select_code = 0;
            if (owner == code_owner
                    && layout->executable_program == 0xffffffffu) {
                selected = 0xffffffffu;
                lowest = code.virtual_address;
                select_code = 1;
            }
            for (pl_u32 index = 0u; index < piece_count; ++index) {
                if (pieces[index].owner != owner || piece_added[index])
                    continue;
                if (pieces[index].segment.virtual_address < lowest) {
                    selected = index;
                    lowest = pieces[index].segment.virtual_address;
                    select_code = 0;
                }
            }
            if (lowest == 0xffffffffffffffffull) break;
            if (select_code) {
                pl_u32 output_index;
                if (!append_program(layout, &code, 0u, 0u, &output_index))
                    return PL_ERROR_X86_LAYOUT;
                layout->executable_program = output_index;
            } else {
                if (!append_program(
                        layout, &pieces[selected].segment,
                        pieces[selected].source_file_offset,
                        pieces[selected].source_file_bytes, 0))
                    return PL_ERROR_X86_LAYOUT;
                piece_added[selected] = 1u;
            }
        }
    }
    if (layout->executable_program == 0xffffffffu)
        return PL_ERROR_X86_LAYOUT;

    if (!pl_checked_mul_u64(
            layout->program_count, PL_ELF_PROGRAM_BYTES, &header_end)
            || !add_u64(elf.program_offset, header_end, &header_end)
            || header_end > input_bytes)
        return PL_ERROR_X86_LAYOUT;

    for (pl_u32 index = 0u; index < layout->program_count; ++index) {
        pl_elf_segment *load = &layout->programs[index];
        if (load->type != PL_ELF_SEGMENT_LOAD
                || layout->source_file_offset[index] != 0u
                || !layout->source_file_bytes[index])
            continue;
        if (load->file_bytes < header_end) load->file_bytes = header_end;
        if (load->memory_bytes < header_end) load->memory_bytes = header_end;
    }

    pl_u64 at = header_end;
    for (pl_u32 count = 0u; count < layout->program_count; ++count) {
        pl_u32 selected = 0xffffffffu;
        pl_u64 lowest = 0xffffffffffffffffull;
        for (pl_u32 index = 0u; index < layout->program_count; ++index) {
            if (load_placed[index]
                    || layout->programs[index].type != PL_ELF_SEGMENT_LOAD)
                continue;
            if (layout->programs[index].virtual_address < lowest) {
                lowest = layout->programs[index].virtual_address;
                selected = index;
            }
        }
        if (selected == 0xffffffffu) break;
        load_placed[selected] = 1u;
        pl_elf_segment *segment = &layout->programs[selected];
        pl_u64 offset;
        if (layout->source_file_offset[selected] == 0u
                && layout->source_file_bytes[selected]) {
            if (segment->file_bytes < header_end)
                return PL_ERROR_X86_LAYOUT;
            offset = 0u;
        } else if (!congruent_at_or_after(
                       at, segment->virtual_address,
                       segment->alignment, &offset)) {
            return PL_ERROR_X86_LAYOUT;
        }
        pl_u64 end;
        if (!add_u64(offset, segment->file_bytes, &end))
            return PL_ERROR_X86_LAYOUT;
        segment->file_offset = offset;
        layout->program_offset[selected] = offset;
        layout->program_file_bytes[selected] = segment->file_bytes;
        layout->program_memory_bytes[selected] = segment->memory_bytes;
        if (selected == layout->executable_program) {
            layout->code_offset = offset;
            if (layout->code_offset > end
                    || compact_code_bytes > end - layout->code_offset)
                return PL_ERROR_X86_LAYOUT;
        }
        if (end > at) at = end;
    }

    pl_u64 program_table_bytes =
        (pl_u64)layout->program_count * PL_ELF_PROGRAM_BYTES;
    for (pl_u32 index = 0u; index < layout->program_count; ++index) {
        pl_elf_segment *part = &layout->programs[index];
        if (part->type == PL_ELF_SEGMENT_LOAD) continue;
        if (part->type == PL_ELF_SEGMENT_PHDR) {
            part->file_offset = elf.program_offset;
            part->file_bytes = program_table_bytes;
            part->memory_bytes = program_table_bytes;
            layout->program_offset[index] = part->file_offset;
            layout->program_file_bytes[index] = part->file_bytes;
            layout->program_memory_bytes[index] = part->memory_bytes;
            continue;
        }
        if (!part->file_bytes) {
            /* A zero-file segment carries no source extent to rebase.  Its
             * original p_offset can lie beyond the compact output (notably a
             * PT_TLS that contains only .tbss), which makes an otherwise
             * ordinary ELF fail range validation.  Choose the unique lowest
             * offset congruent to p_vaddr; no file byte can distinguish any
             * larger representative. */
            part->file_offset = part->alignment > 1u
                ? part->virtual_address & (part->alignment - 1u)
                : 0u;
            if (part->file_offset > at) at = part->file_offset;
            layout->program_offset[index] = part->file_offset;
            layout->program_file_bytes[index] = 0u;
            layout->program_memory_bytes[index] = part->memory_bytes;
            continue;
        }
        pl_u32 owner = 0xffffffffu;
        for (pl_u32 load = 0u; load < layout->program_count; ++load) {
            if (layout->programs[load].type != PL_ELF_SEGMENT_LOAD
                    || !layout->source_file_bytes[load]
                    || part->file_offset
                       < layout->source_file_offset[load])
                continue;
            pl_u64 relative = part->file_offset
                            - layout->source_file_offset[load];
            if (relative <= layout->source_file_bytes[load]
                    && part->file_bytes
                       <= layout->source_file_bytes[load] - relative) {
                if (owner != 0xffffffffu) return PL_ERROR_X86_LAYOUT;
                owner = load;
            }
        }
        if (owner == 0xffffffffu)
            return PL_ERROR_X86_LAYOUT;
        pl_u64 relative = part->file_offset
                        - layout->source_file_offset[owner];
        if (!add_u64(layout->program_offset[owner], relative,
                     &part->file_offset))
            return PL_ERROR_X86_LAYOUT;
        layout->program_offset[index] = part->file_offset;
        layout->program_file_bytes[index] = part->file_bytes;
        layout->program_memory_bytes[index] = part->memory_bytes;
    }
    layout->output_bytes = at;
    return 0;
}

int pl_x86_runtime_elf_write(const pl_u8 *input, pl_u64 input_bytes,
                             const pl_x86_runtime_elf_layout *layout,
                             pl_u64 entry,
                             pl_u8 *output, pl_u64 output_capacity,
                             pl_u64 *output_bytes)
{
    pl_elf_image elf;
    if (!input || !layout || !output || !output_bytes
            || layout->output_bytes > output_capacity)
        return PL_ERROR_X86_LAYOUT;
    int status = pl_elf_open(input, input_bytes, &elf);
    if (status || elf.program_count != layout->input_program_count
            || layout->executable_program >= layout->program_count)
        return PL_ERROR_X86_LAYOUT;
    for (pl_u64 index = 0u; index < layout->output_bytes; ++index)
        output[index] = 0u;

    for (pl_u32 index = 0u; index < layout->program_count; ++index) {
        pl_u64 source_bytes = layout->source_file_bytes[index];
        if (!source_bytes) continue;
        pl_u64 source_offset = layout->source_file_offset[index];
        pl_u64 target_offset = layout->programs[index].file_offset;
        if (source_offset > input_bytes
                || source_bytes > input_bytes - source_offset
                || target_offset > layout->output_bytes
                || source_bytes > layout->output_bytes - target_offset
                || source_bytes > layout->programs[index].file_bytes)
            return PL_ERROR_X86_LAYOUT;
        for (pl_u64 byte = 0u; byte < source_bytes; ++byte)
            output[target_offset + byte] = input[source_offset + byte];
    }

    /* A conventional ELF header and program table always reside in a retained
     * non-executable load.  Copy them explicitly as a structural assertion,
     * then rewrite only fields changed by the new file layout. */
    pl_u64 header_end;
    if (!pl_checked_mul_u64(
            layout->program_count, PL_ELF_PROGRAM_BYTES, &header_end)
            || !add_u64(elf.program_offset, header_end, &header_end)
            || PL_ELF_HEADER_BYTES > input_bytes
            || header_end > layout->output_bytes)
        return PL_ERROR_X86_LAYOUT;
    for (pl_u64 byte = 0u; byte < PL_ELF_HEADER_BYTES; ++byte)
        output[byte] = input[byte];
    pl_write_u64(output + 24u, entry);
    pl_write_u64(output + 40u, 0u);
    pl_write_u16(output + 56u, (pl_u16)layout->program_count);
    pl_write_u16(output + 58u, 0u);
    pl_write_u16(output + 60u, 0u);
    pl_write_u16(output + 62u, 0u);

    for (pl_u32 index = 0u; index < layout->program_count; ++index) {
        pl_u8 *row = output + elf.program_offset
                   + (pl_u64)index * PL_ELF_PROGRAM_BYTES;
        const pl_elf_segment *program = &layout->programs[index];
        pl_write_u32(row, program->type);
        pl_write_u32(row + 4u, program->flags);
        pl_write_u64(row + 8u, program->file_offset);
        pl_write_u64(row + 16u, program->virtual_address);
        pl_write_u64(row + 24u, program->physical_address);
        pl_write_u64(row + 32u, program->file_bytes);
        pl_write_u64(row + 40u, program->memory_bytes);
        pl_write_u64(row + 48u, program->alignment);
    }

    pl_u64 code_end;
    if (!add_u64(layout->code_offset, layout->code_bytes, &code_end)
            || code_end > layout->output_bytes)
        return PL_ERROR_X86_LAYOUT;
    for (pl_u64 byte = layout->code_offset; byte < code_end; ++byte)
        output[byte] = 0u;
    *output_bytes = layout->output_bytes;
    return 0;
}

int pl_x86_runtime_elf_resolve_file(
    const pl_u8 *input, pl_u64 input_bytes,
    const pl_x86_runtime_elf_layout *layout,
    pl_u64 address, pl_u64 bytes, pl_u64 *file_offset)
{
    if (!input || !layout || !file_offset) return PL_ERROR_X86_LAYOUT;
    pl_elf_image elf;
    int status = pl_elf_open(input, input_bytes, &elf);
    if (status || elf.program_count != layout->input_program_count)
        return PL_ERROR_X86_LAYOUT;
    pl_u32 owner = 0xffffffffu;
    pl_u64 relative = 0u;
    for (pl_u32 index = 0u; index < layout->program_count; ++index) {
        const pl_elf_segment *segment = &layout->programs[index];
        if (segment->type != PL_ELF_SEGMENT_LOAD
                || !layout->source_file_bytes[index]
                || address < segment->virtual_address)
            continue;
        pl_u64 candidate = address - segment->virtual_address;
        if (candidate > layout->source_file_bytes[index]
                || bytes > layout->source_file_bytes[index] - candidate)
            continue;
        if (owner != 0xffffffffu) return PL_ERROR_X86_LAYOUT;
        owner = index;
        relative = candidate;
    }
    if (owner == 0xffffffffu
            || !add_u64(layout->program_offset[owner], relative,
                        file_offset)
            || *file_offset > layout->output_bytes
            || bytes > layout->output_bytes - *file_offset)
        return PL_ERROR_X86_LAYOUT;
    return 0;
}
