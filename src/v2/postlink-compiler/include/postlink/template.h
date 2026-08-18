/* The normalized SSA template, as stored in the execution region.
 *
 * A template is what remains of a STEP once project_step_template has lifted
 * the constants and frame coordinates into the parameter row.  Unlike a STEP
 * page it carries no column directory and no padding: every extent follows from
 * the header, so the stream either tiles exactly or is rejected.
 *
 *     header            52 bytes, 'STQT'
 *     wave_offsets      (span + 1) * u32
 *     lane_values       work * u32
 *     opcodes           work * u8
 *     argument_offsets  (work + 1) * u32
 *     operand_tags      operands * u8       then one u64 per node/projection
 *     stack_tags        stack_count * u8    then one u64 per node/projection
 *     local_tags        local_updates * u8  then one u64 per node/projection
 *
 * Composing two templates across a boundary that always executes is the next
 * step; parsing them is the prerequisite, and on its own it settles how wide
 * the node and projection words actually need to be.
 *
 * Freestanding: no libc.
 */

#ifndef POSTLINK_TEMPLATE_H
#define POSTLINK_TEMPLATE_H

#include <postlink/format.h>

#define PL_TEMPLATE_MAGIC "STQT"
#define PL_TEMPLATE_VERSION 1u
#define PL_TEMPLATE_HEADER_BYTES 52u

/* Operand kinds, in the order project_step_template tags them.  const, stack
 * and local leave for the parameter row; node and projection stay because they
 * are the operator graph itself. */
#define PL_OPERAND_CONST      0u
#define PL_OPERAND_STACK      1u
#define PL_OPERAND_LOCAL      2u
#define PL_OPERAND_NODE       3u
#define PL_OPERAND_PROJECTION 4u
#define PL_OPERAND_KINDS      5u

#define PL_OPERAND_STAYS(tag) \
    ((tag) == PL_OPERAND_NODE || (tag) == PL_OPERAND_PROJECTION)

/* One tag group: the tag bytes, then the words that stayed. */
typedef struct {
    pl_u32 tags;        /* offset of the tag bytes */
    pl_u32 count;       /* number of tags */
    pl_u32 words;       /* offset of the first stayed word */
    pl_u32 word_count;  /* how many stayed */
} pl_tag_group;

typedef struct {
    pl_u32 function, start, end, instructions;
    pl_u32 span, work, operands;
    pl_u32 stack_inputs, stack_count, local_extent, local_updates;

    pl_u32 wave_offsets;      /* offsets into the template bytes */
    pl_u32 lane_values;
    pl_u32 opcodes;
    pl_u32 argument_offsets;
    pl_tag_group operand, stack, local;
    pl_u32 bytes;             /* total extent, equal to what was passed in */
} pl_template;

#define PL_ERROR_TEMPLATE (-15)

/* Parse and validate one template.  The tag bytes are read to count the words
 * that stayed, so a tag above PL_OPERAND_KINDS is rejected here rather than
 * shifting every later extent. */
int pl_template_parse(const pl_u8 *bytes, pl_u32 length, pl_template *out);

/* The narrowest width that holds an unsigned word: 1, 2, 4 or 8. */
static inline pl_u32 pl_unsigned_width(pl_u64 value)
{
    if (value < 0x100ull) return 1u;
    if (value < 0x10000ull) return 2u;
    if (value < 0x100000000ull) return 4u;
    return 8u;
}


/* ------------------------------------------------------- the parameter row */

/* What project_step_template lifted out of the template, in the order the tags
 * appear: a const contributes eight bytes, a stack or local coordinate two, and
 * the local_indices tail contributes two per local update.  The extent is
 * therefore a function of the template alone, which is what makes it checkable:
 * a row whose length disagrees with its template is not the row that template
 * was written with.
 */
typedef struct {
    pl_u32 consts;        /* 8-byte words */
    pl_u32 coordinates;   /* 2-byte frame coordinates */
    pl_u32 indices;       /* the local_indices tail, 2 bytes each */
    pl_u32 bytes;         /* the extent all of that implies */
} pl_parameters;

/* Derive the row shape from a parsed template. */
int pl_parameters_shape(const pl_u8 *tmpl, const pl_template *parsed,
                        pl_parameters *out);

/* The row interleaves consts and coordinates in tag order, so these walk the
 * tags rather than indexing a packed run, and need the template to do it. */
int pl_parameters_const(const pl_u8 *tmpl, const pl_template *parsed,
                        const pl_u8 *row, pl_u32 slot, pl_u64 *value);
int pl_parameters_coordinate(const pl_u8 *tmpl, const pl_template *parsed,
                             const pl_u8 *row, pl_u32 slot, pl_u32 *value);

/* The local_indices tail sits after every interleaved word. */
int pl_parameters_index(const pl_u8 *row, const pl_parameters *shape,
                        pl_u32 slot, pl_u32 *value);

#define PL_ERROR_PARAMETERS (-16)

#endif /* POSTLINK_TEMPLATE_H */
