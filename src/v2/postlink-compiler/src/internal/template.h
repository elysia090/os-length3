/* The normalized SSA template, as stored in the execution region.
 *
 * A template is what remains of a STEP once project_step_template has lifted
 * the constants and frame coordinates into the parameter row.  Unlike a STEP
 * page it carries no column directory and no padding: every extent follows from
 * the header, so the stream either tiles exactly or is rejected.
 *
 *     prefix            magic, version, exact variable-header extent
 *     scalar header     ten shortest-form ULEB32 values
 *     wave sizes        width byte, then span packed unsigned values
 *     lane values       width byte, then work packed unsigned values
 *     opcodes           work bytes
 *     argument arities  width byte, then work packed unsigned values
 *     tags              all three groups, three bits each
 *     graph words       width byte, then every stayed word in tag order
 *
 * Offsets and the instruction end are prefix sums, not stored identities.
 * Groups do not restart either packed stream, so neither byte alignment nor a
 * repeated graph-word width is charged at a group boundary.  The reader
 * rejects every non-minimal width, ULEB spelling and padding bit.
 *
 * Freestanding: no libc.
 */

#ifndef POSTLINK_TEMPLATE_H
#define POSTLINK_TEMPLATE_H

#include "format.h"

#define PL_TEMPLATE_MAGIC "STQT"
#define PL_TEMPLATE_VERSION 2u
#define PL_TEMPLATE_PREFIX_BYTES 8u
#define PL_TEMPLATE_SCALARS 10u

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

/* One logical tag group inside the two shared packed streams. */
typedef struct {
    pl_u32 tag_at;      /* ordinal in the shared three-bit tag stream */
    pl_u32 count;       /* number of tags */
    pl_u32 word_at;     /* ordinal in the shared graph-word stream */
    pl_u32 word_count;  /* how many stayed */
} pl_tag_group;

typedef struct {
    pl_u32 function, start, end, instructions;
    pl_u32 span, work, operands;
    pl_u32 stack_inputs, stack_count, local_extent, local_updates;

    pl_u32 header_bytes;
    pl_u32 wave_sizes;        /* byte offsets of packed columns */
    pl_u32 wave_width;
    pl_u32 lane_values;
    pl_u32 lane_width;
    pl_u32 opcodes;
    pl_u32 argument_arities;
    pl_u32 argument_width;
    pl_u32 tags;
    pl_u32 words;
    pl_u32 word_width;
    pl_tag_group operand, stack, local;
    pl_u32 bytes;             /* total extent, equal to what was passed in */
} pl_template;

#define PL_ERROR_TEMPLATE (-15)

/* Consecutive canonical templates share one authenticated physical object.
 * A descriptor stores only its global rank.  The resource index selects the
 * page by the greatest first_rank <= rank, and the page's u16 endpoint column
 * selects the exact STQT2 word.  No per-template digest is materialized. */
#define PL_TEMPLATE_PAGE_MAGIC "PTP1"
#define PL_TEMPLATE_PAGE_VERSION 1u
#define PL_TEMPLATE_PAGE_BYTES 4096u
#define PL_TEMPLATE_PAGE_HEADER_BYTES 64u

typedef struct {
    pl_u32 first_rank;
    pl_u32 count;
    pl_u32 offsets;
    pl_u32 bytes;
} pl_template_page;

int pl_template_page_measure(const pl_u8 *const *templates,
                             const pl_u32 *template_bytes,
                             pl_u32 count, pl_u32 *bytes);
int pl_template_page_write(pl_u32 first_rank,
                           const pl_u8 *const *templates,
                           const pl_u32 *template_bytes, pl_u32 count,
                           pl_u8 *target, pl_u32 capacity, pl_u32 *written);
int pl_template_page_open(const pl_u8 *bytes, pl_u32 length,
                          pl_template_page *out);
int pl_template_page_get(const pl_u8 *bytes, const pl_template_page *page,
                         pl_u32 rank, const pl_u8 **tmpl,
                         pl_u32 *template_bytes);

/* Parse and validate one template.  The tag bytes are read to count the words
 * that stayed, so a tag above PL_OPERAND_KINDS is rejected here rather than
 * shifting every later extent. */
int pl_template_parse(const pl_u8 *bytes, pl_u32 length, pl_template *out);

/* Access one value from a parsed canonical template.  Wave and argument
 * columns store deltas; callers that need offsets form one prefix sum while
 * walking the column, rather than rescanning it for every lane. */
pl_u32 pl_template_wave_size(const pl_u8 *bytes,
                             const pl_template *parsed, pl_u32 rank);
pl_u32 pl_template_lane_value(const pl_u8 *bytes,
                              const pl_template *parsed, pl_u32 rank);
pl_u32 pl_template_argument_arity(const pl_u8 *bytes,
                                  const pl_template *parsed, pl_u32 rank);
pl_u32 pl_template_tag(const pl_u8 *bytes, const pl_template *parsed,
                       const pl_tag_group *group, pl_u32 rank);
pl_u64 pl_template_word(const pl_u8 *bytes, const pl_template *parsed,
                        const pl_tag_group *group, pl_u32 rank);

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
