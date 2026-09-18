/* Normalized SSA template parsing.  See include/postlink/template.h. */

#include "internal/template.h"

static pl_u32 bit_width(pl_u64 value)
{
    pl_u32 width = 0u;
    while (value) { ++width; value >>= 1u; }
    return width;
}

static pl_u64 packed_bytes(pl_u32 count, pl_u32 width)
{
    return ((pl_u64)count * width + 7u) >> 3u;
}

static pl_u64 packed_read(const pl_u8 *source, pl_u32 ordinal, pl_u32 width)
{
    if (!width) return 0u;
    pl_u64 bit_at = (pl_u64)ordinal * width;
    pl_u32 byte_at = (pl_u32)(bit_at >> 3u);
    pl_u32 source_bit = (pl_u32)(bit_at & 7u);
    pl_u32 target_bit = 0u;
    pl_u32 remaining = width;
    pl_u64 value = 0u;
    while (remaining) {
        pl_u32 available = 8u - source_bit;
        pl_u32 take = remaining < available ? remaining : available;
        pl_u32 mask = (1u << take) - 1u;
        pl_u32 part = (source[byte_at] >> source_bit) & mask;
        value |= (pl_u64)part << target_bit;
        remaining -= take;
        target_bit += take;
        ++byte_at;
        source_bit = 0u;
    }
    return value;
}

static int padding_zero(const pl_u8 *source, pl_u32 count, pl_u32 width)
{
    pl_u64 bits = (pl_u64)count * width;
    if (!bits || !(bits & 7u)) return 1;
    pl_u32 used = (pl_u32)(bits & 7u);
    return !(source[bits >> 3u] & (pl_u8)~((1u << used) - 1u));
}

static int read_uleb32(const pl_u8 *bytes, pl_u32 length, pl_u32 *cursor,
                       pl_u32 *value)
{
    pl_u64 result = 0u;
    pl_u32 count = 0u;
    for (;;) {
        if (*cursor >= length || count == 5u) return PL_ERROR_TEMPLATE;
        pl_u32 byte = bytes[(*cursor)++];
        if (count == 4u && (byte & 0x7fu) > 15u)
            return PL_ERROR_TEMPLATE;
        result |= (pl_u64)(byte & 0x7fu) << (count * 7u);
        ++count;
        if (!(byte & 0x80u)) {
            if (count > 1u && !(byte & 0x7fu)) return PL_ERROR_TEMPLATE;
            *value = (pl_u32)result;
            return 0;
        }
    }
}

static int take_packed(const pl_u8 *bytes, pl_u32 length, pl_u32 *cursor,
                       pl_u32 count, pl_u32 maximum_width,
                       pl_u32 *offset, pl_u32 *width)
{
    if (!count) { *offset = *cursor; *width = 0u; return 0; }
    if (*cursor >= length) return PL_ERROR_TEMPLATE;
    *width = bytes[(*cursor)++];
    if (*width > maximum_width) return PL_ERROR_TEMPLATE;
    pl_u64 extent_64 = packed_bytes(count, *width);
    if (extent_64 > 0xffffffffull) return PL_ERROR_TEMPLATE;
    pl_u32 extent = (pl_u32)extent_64;
    if (extent > length - *cursor) return PL_ERROR_TEMPLATE;
    *offset = *cursor;
    *cursor += extent;
    if (!padding_zero(bytes + *offset, count, *width))
        return PL_ERROR_TEMPLATE;
    return 0;
}

static pl_u32 tag_at(const pl_u8 *bytes, const pl_template *parsed,
                     pl_u32 ordinal)
{
    return (pl_u32)packed_read(bytes + parsed->tags, ordinal, 3u);
}

int pl_template_parse(const pl_u8 *bytes, pl_u32 length, pl_template *out)
{
    if (!bytes || !out || length < PL_TEMPLATE_PREFIX_BYTES)
        return PL_ERROR_TEMPLATE;
    if (bytes[0] != 'S' || bytes[1] != 'T'
            || bytes[2] != 'Q' || bytes[3] != 'T')
        return PL_ERROR_TEMPLATE;
    if (pl_read_u16(bytes + 4) != PL_TEMPLATE_VERSION)
        return PL_ERROR_TEMPLATE;
    out->header_bytes = pl_read_u16(bytes + 6);
    if (out->header_bytes < PL_TEMPLATE_PREFIX_BYTES
            || out->header_bytes > length)
        return PL_ERROR_TEMPLATE;
    pl_u32 cursor = PL_TEMPLATE_PREFIX_BYTES;
    pl_u32 *scalars[PL_TEMPLATE_SCALARS] = {
        &out->function, &out->start, &out->instructions, &out->span,
        &out->work, &out->operands, &out->stack_inputs, &out->stack_count,
        &out->local_extent, &out->local_updates,
    };
    for (pl_u32 rank = 0u; rank < PL_TEMPLATE_SCALARS; ++rank)
        if (read_uleb32(bytes, out->header_bytes, &cursor, scalars[rank]))
            return PL_ERROR_TEMPLATE;
    if (cursor != out->header_bytes
            || (pl_u64)out->start + out->instructions > 0xffffffffull)
        return PL_ERROR_TEMPLATE;
    out->end = out->start + out->instructions;

    if (take_packed(bytes, length, &cursor, out->span, 32u,
                    &out->wave_sizes, &out->wave_width)
            || take_packed(bytes, length, &cursor, out->work, 32u,
                           &out->lane_values, &out->lane_width))
        return PL_ERROR_TEMPLATE;
    if (out->work > length - cursor) return PL_ERROR_TEMPLATE;
    out->opcodes = cursor;
    cursor += out->work;
    if (take_packed(bytes, length, &cursor, out->work, 32u,
                    &out->argument_arities, &out->argument_width))
        return PL_ERROR_TEMPLATE;

    pl_u32 wave_maximum = 0u, wave_total = 0u;
    for (pl_u32 rank = 0u; rank < out->span; ++rank) {
        pl_u32 value = (pl_u32)packed_read(
            bytes + out->wave_sizes, rank, out->wave_width);
        if (value > wave_maximum) wave_maximum = value;
        if (value > 0xffffffffu - wave_total) return PL_ERROR_TEMPLATE;
        wave_total += value;
    }
    if (wave_total != out->work
            || (out->span && bit_width(wave_maximum) != out->wave_width))
        return PL_ERROR_TEMPLATE;
    pl_u32 lane_maximum = 0u;
    for (pl_u32 rank = 0u; rank < out->work; ++rank) {
        pl_u32 value = (pl_u32)packed_read(
            bytes + out->lane_values, rank, out->lane_width);
        if (!value || value > out->work) return PL_ERROR_TEMPLATE;
        if (value > lane_maximum) lane_maximum = value;
    }
    if (out->work && bit_width(lane_maximum) != out->lane_width)
        return PL_ERROR_TEMPLATE;
    pl_u32 argument_maximum = 0u, argument_total = 0u;
    for (pl_u32 rank = 0u; rank < out->work; ++rank) {
        pl_u32 value = (pl_u32)packed_read(
            bytes + out->argument_arities, rank, out->argument_width);
        if (value > argument_maximum) argument_maximum = value;
        if (value > 0xffffffffu - argument_total)
            return PL_ERROR_TEMPLATE;
        argument_total += value;
    }
    if (argument_total != out->operands
            || (out->work
                && bit_width(argument_maximum) != out->argument_width))
        return PL_ERROR_TEMPLATE;

    pl_u64 tag_count_64 = (pl_u64)out->operands + out->stack_count
                        + out->local_updates;
    if (tag_count_64 > 0xffffffffu) return PL_ERROR_TEMPLATE;
    pl_u32 tag_count = (pl_u32)tag_count_64;
    pl_u64 tag_bytes_64 = packed_bytes(tag_count, 3u);
    if (tag_bytes_64 > 0xffffffffull) return PL_ERROR_TEMPLATE;
    pl_u32 tag_bytes = (pl_u32)tag_bytes_64;
    if (tag_bytes > length - cursor) return PL_ERROR_TEMPLATE;
    out->tags = cursor;
    cursor += tag_bytes;
    if (!padding_zero(bytes + out->tags, tag_count, 3u))
        return PL_ERROR_TEMPLATE;

    out->operand.tag_at = 0u;
    out->operand.count = out->operands;
    out->stack.tag_at = out->operands;
    out->stack.count = out->stack_count;
    out->local.tag_at = out->operands + out->stack_count;
    out->local.count = out->local_updates;
    pl_tag_group *groups[3] = { &out->operand, &out->stack, &out->local };
    pl_u32 word_count = 0u;
    for (pl_u32 group_rank = 0u; group_rank < 3u; ++group_rank) {
        pl_tag_group *group = groups[group_rank];
        group->word_at = word_count;
        group->word_count = 0u;
        for (pl_u32 rank = 0u; rank < group->count; ++rank) {
            pl_u32 tag = tag_at(bytes, out, group->tag_at + rank);
            if (tag >= PL_OPERAND_KINDS) return PL_ERROR_TEMPLATE;
            if (PL_OPERAND_STAYS(tag)) ++group->word_count;
        }
        if (group->word_count > 0xffffffffu - word_count)
            return PL_ERROR_TEMPLATE;
        word_count += group->word_count;
    }
    if (take_packed(bytes, length, &cursor, word_count, 64u,
                    &out->words, &out->word_width))
        return PL_ERROR_TEMPLATE;
    pl_u64 word_maximum = 0u;
    for (pl_u32 rank = 0u; rank < word_count; ++rank) {
        pl_u64 value = packed_read(bytes + out->words, rank, out->word_width);
        if (value > word_maximum) word_maximum = value;
    }
    if (word_count && bit_width(word_maximum) != out->word_width)
        return PL_ERROR_TEMPLATE;

    /* Nothing may follow: the extents are fully determined, so a trailing byte
     * means this is not the template the writer produced. */
    if (cursor != length) return PL_ERROR_TEMPLATE;
    out->bytes = length;
    return 0;
}

/* ------------------------------------------------ canonical template page */

int pl_template_page_measure(const pl_u8 *const *templates,
                             const pl_u32 *template_bytes,
                             pl_u32 count, pl_u32 *bytes)
{
    if (!templates || !template_bytes || !count || !bytes
            || count > (PL_TEMPLATE_PAGE_BYTES
                - PL_TEMPLATE_PAGE_HEADER_BYTES) / 2u - 1u)
        return PL_ERROR_TEMPLATE;
    pl_u32 total = PL_TEMPLATE_PAGE_HEADER_BYTES + (count + 1u) * 2u;
    for (pl_u32 rank = 0u; rank < count; ++rank) {
        pl_template parsed;
        if (!templates[rank] || !template_bytes[rank]
                || pl_template_parse(
                    templates[rank], template_bytes[rank], &parsed)
                || template_bytes[rank] > PL_TEMPLATE_PAGE_BYTES - total)
            return PL_ERROR_TEMPLATE;
        total += template_bytes[rank];
    }
    *bytes = total;
    return 0;
}

int pl_template_page_write(pl_u32 first_rank,
                           const pl_u8 *const *templates,
                           const pl_u32 *template_bytes, pl_u32 count,
                           pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!target || !written || !count
            || count > 0xffffffffu - first_rank)
        return PL_ERROR_TEMPLATE;
    pl_u32 measured = 0u;
    int status = pl_template_page_measure(
        templates, template_bytes, count, &measured);
    if (status) return status;
    if (capacity < measured) return PL_ERROR_TEMPLATE;
    for (pl_u32 rank = 0u; rank < measured; ++rank) target[rank] = 0u;
    target[0] = 'P'; target[1] = 'T'; target[2] = 'P'; target[3] = '1';
    pl_write_u16(target + 4u, PL_TEMPLATE_PAGE_VERSION);
    pl_write_u16(target + 6u, PL_TEMPLATE_PAGE_HEADER_BYTES);
    pl_write_u32(target + 8u, first_rank);
    pl_write_u32(target + 12u, count);
    pl_write_u32(target + 20u, measured);
    pl_u32 offsets = PL_TEMPLATE_PAGE_HEADER_BYTES;
    pl_u32 cursor = offsets + (count + 1u) * 2u;
    pl_write_u16(target + offsets, cursor);
    for (pl_u32 rank = 0u; rank < count; ++rank) {
        for (pl_u32 index = 0u; index < template_bytes[rank]; ++index)
            target[cursor + index] = templates[rank][index];
        cursor += template_bytes[rank];
        pl_write_u16(target + offsets + (rank + 1u) * 2u, cursor);
    }
    if (cursor != measured) return PL_ERROR_TEMPLATE;
    *written = measured;
    return 0;
}

int pl_template_page_open(const pl_u8 *bytes, pl_u32 length,
                          pl_template_page *out)
{
    if (!bytes || !out || length < PL_TEMPLATE_PAGE_HEADER_BYTES + 4u
            || length > PL_TEMPLATE_PAGE_BYTES
            || bytes[0] != 'P' || bytes[1] != 'T'
            || bytes[2] != 'P' || bytes[3] != '1'
            || pl_read_u16(bytes + 4u) != PL_TEMPLATE_PAGE_VERSION
            || pl_read_u16(bytes + 6u) != PL_TEMPLATE_PAGE_HEADER_BYTES
            || pl_read_u32(bytes + 20u) != length)
        return PL_ERROR_TEMPLATE;
    pl_u32 first = pl_read_u32(bytes + 8u);
    pl_u32 count = pl_read_u32(bytes + 12u);
    if (!count || count > 0xffffffffu - first
            || count > (length - PL_TEMPLATE_PAGE_HEADER_BYTES) / 2u - 1u)
        return PL_ERROR_TEMPLATE;
    for (pl_u32 index = 16u; index < 20u; ++index)
        if (bytes[index]) return PL_ERROR_TEMPLATE;
    for (pl_u32 index = 24u; index < PL_TEMPLATE_PAGE_HEADER_BYTES; ++index)
        if (bytes[index]) return PL_ERROR_TEMPLATE;
    pl_u32 offsets = PL_TEMPLATE_PAGE_HEADER_BYTES;
    pl_u32 expected = offsets + (count + 1u) * 2u;
    if (pl_read_u16(bytes + offsets) != expected)
        return PL_ERROR_TEMPLATE;
    for (pl_u32 rank = 0u; rank < count; ++rank) {
        pl_u32 begin = pl_read_u16(bytes + offsets + rank * 2u);
        pl_u32 end = pl_read_u16(bytes + offsets + (rank + 1u) * 2u);
        pl_template parsed;
        if (begin != expected || end <= begin || end > length
                || pl_template_parse(bytes + begin, end - begin, &parsed))
            return PL_ERROR_TEMPLATE;
        expected = end;
    }
    if (expected != length) return PL_ERROR_TEMPLATE;
    *out = (pl_template_page){ first, count, offsets, length };
    return 0;
}

int pl_template_page_get(const pl_u8 *bytes, const pl_template_page *page,
                         pl_u32 rank, const pl_u8 **tmpl,
                         pl_u32 *template_bytes)
{
    if (!bytes || !page || !tmpl || !template_bytes
            || rank < page->first_rank
            || rank - page->first_rank >= page->count)
        return PL_ERROR_TEMPLATE;
    pl_u32 local = rank - page->first_rank;
    pl_u32 begin = pl_read_u16(bytes + page->offsets + local * 2u);
    pl_u32 end = pl_read_u16(bytes + page->offsets + (local + 1u) * 2u);
    if (begin >= end || end > page->bytes) return PL_ERROR_TEMPLATE;
    *tmpl = bytes + begin;
    *template_bytes = end - begin;
    return 0;
}

pl_u32 pl_template_wave_size(const pl_u8 *bytes,
                             const pl_template *parsed, pl_u32 rank)
{
    return (pl_u32)packed_read(
        bytes + parsed->wave_sizes, rank, parsed->wave_width);
}

pl_u32 pl_template_lane_value(const pl_u8 *bytes,
                              const pl_template *parsed, pl_u32 rank)
{
    return (pl_u32)packed_read(
        bytes + parsed->lane_values, rank, parsed->lane_width);
}

pl_u32 pl_template_argument_arity(const pl_u8 *bytes,
                                  const pl_template *parsed, pl_u32 rank)
{
    return (pl_u32)packed_read(
        bytes + parsed->argument_arities, rank, parsed->argument_width);
}

pl_u32 pl_template_tag(const pl_u8 *bytes, const pl_template *parsed,
                       const pl_tag_group *group, pl_u32 rank)
{
    return tag_at(bytes, parsed, group->tag_at + rank);
}

pl_u64 pl_template_word(const pl_u8 *bytes, const pl_template *parsed,
                        const pl_tag_group *group, pl_u32 rank)
{
    return packed_read(bytes + parsed->words, group->word_at + rank,
                       parsed->word_width);
}

/* ------------------------------------------------------- the parameter row */

/* Walk the tag groups in the order project_step_template wrote them and total
 * what each tag lifted out.  The consts come first in the row only in the sense
 * that they interleave with the coordinates exactly as the tags do, so the
 * accessors below re-walk the tags rather than indexing a packed run. */
int pl_parameters_shape(const pl_u8 *tmpl, const pl_template *parsed,
                        pl_parameters *out)
{
    const pl_tag_group *groups[3] = {
        &parsed->operand, &parsed->stack, &parsed->local };
    pl_u32 consts = 0;
    pl_u32 coordinates = 0;
    for (unsigned g = 0; g < 3u; ++g) {
        const pl_tag_group *group = groups[g];
        for (pl_u32 index = 0; index < group->count; ++index) {
            pl_u32 tag = pl_template_tag(tmpl, parsed, group, index);
            if (tag == PL_OPERAND_CONST) consts += 1u;
            else if (tag == PL_OPERAND_STACK || tag == PL_OPERAND_LOCAL)
                coordinates += 1u;
        }
    }
    out->consts = consts;
    out->coordinates = coordinates;
    out->indices = parsed->local_updates;
    out->bytes = consts * 8u + coordinates * 2u + parsed->local_updates * 2u;
    return 0;
}

/* The row interleaves: project_step_template walks the tags in order and emits
 * eight bytes for a const and two for a frame coordinate as it meets them, so a
 * const at tag position five can sit behind two coordinates.  Reaching a slot
 * therefore means walking the tags and accumulating widths, not indexing a
 * packed run. */
static int walk_to(const pl_u8 *tmpl, const pl_template *parsed,
                   pl_u32 want_kind, pl_u32 want_slot, pl_u32 *offset)
{
    const pl_tag_group *groups[3] = {
        &parsed->operand, &parsed->stack, &parsed->local };
    pl_u32 cursor = 0;
    pl_u32 seen = 0;
    for (unsigned g = 0; g < 3u; ++g) {
        const pl_tag_group *group = groups[g];
        for (pl_u32 index = 0; index < group->count; ++index) {
            pl_u32 tag = pl_template_tag(tmpl, parsed, group, index);
            pl_u32 width = tag == PL_OPERAND_CONST ? 8u
                         : (tag == PL_OPERAND_STACK || tag == PL_OPERAND_LOCAL)
                           ? 2u : 0u;
            if (!width) continue;
            int matches = want_kind == PL_OPERAND_CONST
                        ? tag == PL_OPERAND_CONST
                        : tag != PL_OPERAND_CONST;
            if (matches) {
                if (seen == want_slot) { *offset = cursor; return 0; }
                seen += 1u;
            }
            cursor += width;
        }
    }
    return PL_ERROR_PARAMETERS;
}

int pl_parameters_const(const pl_u8 *tmpl, const pl_template *parsed,
                        const pl_u8 *row, pl_u32 slot, pl_u64 *value)
{
    pl_u32 offset;
    int status = walk_to(tmpl, parsed, PL_OPERAND_CONST, slot, &offset);
    if (status) return status;
    *value = pl_read_u64(row + offset);
    return 0;
}

int pl_parameters_coordinate(const pl_u8 *tmpl, const pl_template *parsed,
                             const pl_u8 *row, pl_u32 slot, pl_u32 *value)
{
    pl_u32 offset;
    int status = walk_to(tmpl, parsed, PL_OPERAND_STACK, slot, &offset);
    if (status) return status;
    *value = pl_read_u16(row + offset);
    return 0;
}

/* The local_indices tail follows every interleaved word. */
int pl_parameters_index(const pl_u8 *row, const pl_parameters *shape,
                        pl_u32 slot, pl_u32 *value)
{
    if (slot >= shape->indices) return PL_ERROR_PARAMETERS;
    pl_u32 tail = shape->consts * 8u + shape->coordinates * 2u;
    *value = pl_read_u16(row + tail + slot * 2u);
    return 0;
}
