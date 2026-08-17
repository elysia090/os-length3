/* Canonical continuation residual codec.
 *
 * A continuation is (control, boundary, first, second, third).  The block
 * coordinate already names RIP, so static targets are stored as displacements
 * and each of the four words is stored as the shortest form that reproduces
 * it: zero, equality with an earlier word, or the narrowest signed residual.
 *
 * Exactly one encoding is legal for a given continuation.  Decoding therefore
 * re-derives the tag it would have written and rejects any row that could have
 * been written more cheaply -- an artifact cannot carry two spellings of one
 * control transfer.
 *
 * Freestanding: no libc.
 */

#include <postlink/continuation.h>

/* Project an absolute continuation onto its RIP-relative residual form. */
void pl_continuation_project(pl_u64 rip, const pl_continuation *absolute,
                             pl_continuation *relative)
{
    pl_u32 control = absolute->control;
    relative->control = control;
    relative->field[PL_FIELD_BOUNDARY] =
        absolute->field[PL_FIELD_BOUNDARY] - rip;
    relative->field[PL_FIELD_FIRST] = absolute->field[PL_FIELD_FIRST];
    relative->field[PL_FIELD_SECOND] = absolute->field[PL_FIELD_SECOND];
    relative->field[PL_FIELD_THIRD] = absolute->field[PL_FIELD_THIRD];

    if (PL_CONTROL_IS_STATIC(control)) {
        relative->field[PL_FIELD_FIRST] -= rip;
        /* A zero second target means "no target", not address zero, so it
         * stays zero and keeps the cheap tag. */
        if (relative->field[PL_FIELD_SECOND])
            relative->field[PL_FIELD_SECOND] -= rip;
    } else if (!PL_CONTROL_FIELD_IS_EXACT(control)) {
        relative->field[PL_FIELD_FIRST] -= rip;
    }
}

/* Inverse of pl_continuation_project. */
void pl_continuation_instantiate(pl_u64 rip, const pl_continuation *relative,
                                 pl_continuation *absolute)
{
    pl_u32 control = relative->control;
    absolute->control = control;
    absolute->field[PL_FIELD_BOUNDARY] =
        rip + relative->field[PL_FIELD_BOUNDARY];
    absolute->field[PL_FIELD_FIRST] = relative->field[PL_FIELD_FIRST];
    absolute->field[PL_FIELD_SECOND] = relative->field[PL_FIELD_SECOND];
    absolute->field[PL_FIELD_THIRD] = relative->field[PL_FIELD_THIRD];

    if (PL_CONTROL_IS_STATIC(control)) {
        absolute->field[PL_FIELD_FIRST] += rip;
        if (absolute->field[PL_FIELD_SECOND])
            absolute->field[PL_FIELD_SECOND] += rip;
    } else if (!PL_CONTROL_FIELD_IS_EXACT(control)) {
        absolute->field[PL_FIELD_FIRST] += rip;
    }
}

/* The one legal tag for `value` at `index`, given the words already chosen. */
static pl_u32 canonical_tag(const pl_u64 *values, pl_u32 index, pl_u64 value)
{
    if (!value) return PL_TAG_ZERO;
    if (index > 0 && value == values[0]) return PL_TAG_FIELD_0;
    if (index > 1 && value == values[1]) return PL_TAG_FIELD_1;
    return pl_signed_tag((pl_i64)value);
}

int pl_continuation_encode(const pl_continuation *relative,
                           pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (relative->control > (pl_u32)PL_CONTROL_MAX)
        return PL_ERROR_CONTROL;
    if (capacity < PL_CONTINUATION_HEADER_BYTES) return PL_ERROR_SHORT;

    pl_u32 tags = 0;
    pl_u32 cursor = PL_CONTINUATION_HEADER_BYTES;
    for (pl_u32 index = 0; index < PL_CONTINUATION_FIELDS; ++index) {
        pl_u64 value = relative->field[index];
        pl_u32 tag = canonical_tag(relative->field, index, value);
        tags |= tag << (index * PL_CONTINUATION_TAG_BITS);
        pl_u32 width = PL_TAG_WIDTH(tag);
        if (width) {
            if (capacity - cursor < width) return PL_ERROR_SHORT;
            for (pl_u32 byte = 0; byte < width; ++byte)
                target[cursor + byte] = (pl_u8)(value >> (byte * 8u));
            cursor += width;
        }
    }
    target[0] = (pl_u8)relative->control;
    pl_write_u16(target + 1, tags);
    if (written) *written = cursor;
    return 0;
}

int pl_continuation_decode(const pl_u8 *payload, pl_u32 bytes,
                           pl_continuation *relative)
{
    if (bytes < PL_CONTINUATION_HEADER_BYTES) return PL_ERROR_SHORT;
    pl_u32 control = payload[0];
    pl_u32 tags = pl_read_u16(payload + 1);
    /* Four three-bit tags occupy twelve bits; the rest must be clear. */
    if (control > (pl_u32)PL_CONTROL_MAX
            || (tags >> (PL_CONTINUATION_FIELDS * PL_CONTINUATION_TAG_BITS)))
        return PL_ERROR_CONTINUATION;

    pl_u32 cursor = PL_CONTINUATION_HEADER_BYTES;
    pl_u64 values[PL_CONTINUATION_FIELDS];
    for (pl_u32 index = 0; index < PL_CONTINUATION_FIELDS; ++index) {
        pl_u32 tag = (tags >> (index * PL_CONTINUATION_TAG_BITS)) & 7u;
        pl_u64 value;
        if (tag == PL_TAG_ZERO) {
            value = 0;
        } else if (tag == PL_TAG_FIELD_0 && index > 0) {
            value = values[0];
        } else if (tag == PL_TAG_FIELD_1 && index > 1) {
            value = values[1];
        } else {
            pl_u32 width = PL_TAG_WIDTH(tag);
            if (!width || bytes - cursor < width)
                return PL_ERROR_CONTINUATION;
            value = (pl_u64)pl_read_signed(payload + cursor, width);
            cursor += width;
        }
        if (canonical_tag(values, index, value) != tag)
            return PL_ERROR_CANONICAL;
        values[index] = value;
    }
    if (cursor != bytes) return PL_ERROR_CANONICAL;

    relative->control = control;
    for (pl_u32 index = 0; index < PL_CONTINUATION_FIELDS; ++index)
        relative->field[index] = values[index];
    return 0;
}
