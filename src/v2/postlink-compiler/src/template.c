/* Normalized SSA template parsing.  See include/postlink/template.h. */

#include <postlink/template.h>

/* Advance `cursor` by `count * width`, refusing to leave the extent. */
static int take(pl_u32 *cursor, pl_u32 length, pl_u64 count, pl_u32 width,
                pl_u32 *offset)
{
    pl_u64 span = count * (pl_u64)width;
    if (span > length - *cursor) return PL_ERROR_TEMPLATE;
    if (offset) *offset = *cursor;
    *cursor = (pl_u32)(*cursor + span);
    return 0;
}

/* Read one tag group: the tag bytes, then a word for each tag that stays. */
static int take_group(const pl_u8 *bytes, pl_u32 *cursor, pl_u32 length,
                      pl_u32 count, pl_tag_group *group)
{
    group->count = count;
    if (take(cursor, length, count, 1u, &group->tags)) return PL_ERROR_TEMPLATE;

    pl_u32 stayed = 0;
    for (pl_u32 index = 0; index < count; ++index) {
        pl_u32 tag = bytes[group->tags + index];
        if (tag >= PL_OPERAND_KINDS) return PL_ERROR_TEMPLATE;
        if (PL_OPERAND_STAYS(tag)) stayed += 1u;
    }
    group->word_count = stayed;
    return take(cursor, length, stayed, 8u, &group->words);
}

int pl_template_parse(const pl_u8 *bytes, pl_u32 length, pl_template *out)
{
    if (length < PL_TEMPLATE_HEADER_BYTES) return PL_ERROR_TEMPLATE;
    if (bytes[0] != 'S' || bytes[1] != 'T'
            || bytes[2] != 'Q' || bytes[3] != 'T')
        return PL_ERROR_TEMPLATE;
    if (pl_read_u16(bytes + 4) != PL_TEMPLATE_VERSION
            || pl_read_u16(bytes + 6) != PL_TEMPLATE_HEADER_BYTES)
        return PL_ERROR_TEMPLATE;

    out->function     = pl_read_u32(bytes + 8);
    out->start        = pl_read_u32(bytes + 12);
    out->end          = pl_read_u32(bytes + 16);
    out->instructions = pl_read_u32(bytes + 20);
    out->span         = pl_read_u32(bytes + 24);
    out->work         = pl_read_u32(bytes + 28);
    out->operands     = pl_read_u32(bytes + 32);
    out->stack_inputs = pl_read_u32(bytes + 36);
    out->stack_count  = pl_read_u32(bytes + 40);
    out->local_extent = pl_read_u32(bytes + 44);
    out->local_updates = pl_read_u32(bytes + 48);

    /* The same consistency the Python reader insists on, so a template that
     * would decode into a different instruction region is refused here. */
    if (out->end < out->start
            || out->instructions != out->end - out->start)
        return PL_ERROR_TEMPLATE;

    pl_u32 cursor = PL_TEMPLATE_HEADER_BYTES;
    if (take(&cursor, length, (pl_u64)out->span + 1u, 4u, &out->wave_offsets)
            || take(&cursor, length, out->work, 4u, &out->lane_values)
            || take(&cursor, length, out->work, 1u, &out->opcodes)
            || take(&cursor, length, (pl_u64)out->work + 1u, 4u,
                    &out->argument_offsets))
        return PL_ERROR_TEMPLATE;

    if (take_group(bytes, &cursor, length, out->operands, &out->operand)
            || take_group(bytes, &cursor, length, out->stack_count,
                          &out->stack)
            || take_group(bytes, &cursor, length, out->local_updates,
                          &out->local))
        return PL_ERROR_TEMPLATE;

    /* Nothing may follow: the extents are fully determined, so a trailing byte
     * means this is not the template the writer produced. */
    if (cursor != length) return PL_ERROR_TEMPLATE;
    out->bytes = length;
    return 0;
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
            pl_u32 tag = tmpl[group->tags + index];
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
            pl_u32 tag = tmpl[group->tags + index];
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
