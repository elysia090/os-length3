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
