/* Block admission by rank.  See include/postlink/directory.h. */

#include <postlink/directory.h>

/* The descriptor region is six contiguous sections whose extents follow from
 * the header counts alone:
 *
 *     block instances      block_count      * 20
 *     step instances       step_count       * 16
 *     template extents     template_count   *  8
 *     guard extents        guard_count      *  8
 *     continuation offsets (continuation_count + 1) * 4
 *     continuation payload continuation_bytes
 *
 * and the execution region is three contiguous runs:
 *
 *     templates    [0, template_execution_bytes)
 *     parameters   [template_execution_bytes, + parameter_execution_bytes)
 *     guards       [that, execution_bytes)
 *
 * Because both are fully determined, a region that does not tile exactly is
 * rejected here rather than producing a plausible wrong coordinate later.
 */
int pl_directory_open(const pl_u8 *descriptors, pl_u64 descriptor_bytes,
                      const pl_directory_counts *counts, pl_directory *out)
{
    if (!descriptors || !counts || !out) return PL_ERROR_DIRECTORY;

    /* Accumulate in 64 bits so a hostile count cannot wrap the total. */
    pl_u64 total = (pl_u64)counts->block_count * PL_BLOCK_INSTANCE_BYTES;
    pl_u64 instance_base = total;
    total += (pl_u64)counts->step_count * PL_STEP_INSTANCE_BYTES;
    pl_u64 template_base = total;
    total += (pl_u64)counts->template_count * PL_EXTENT_BYTES;
    pl_u64 guard_base = total;
    total += (pl_u64)counts->guard_count * PL_EXTENT_BYTES;
    pl_u64 continuation_offset_base = total;
    total += ((pl_u64)counts->continuation_count + 1u)
           * PL_CONTINUATION_OFFSET_BYTES;
    pl_u64 continuation_payload_base = total;
    total += counts->continuation_bytes;

    if (total != descriptor_bytes) return PL_ERROR_DIRECTORY;
    if (counts->block_count && !counts->continuation_count)
        return PL_ERROR_DIRECTORY;
    if ((pl_u64)counts->template_execution_bytes
            + counts->parameter_execution_bytes > counts->execution_bytes)
        return PL_ERROR_DIRECTORY;
    /* Every section base is now known to be below descriptor_bytes, so the
     * u32 narrowing below cannot lose information. */
    if (total > 0xffffffffull) return PL_ERROR_DIRECTORY;

    out->descriptors = descriptors;
    out->descriptor_bytes = descriptor_bytes;
    out->counts = *counts;
    out->instance_base = (pl_u32)instance_base;
    out->template_base = (pl_u32)template_base;
    out->guard_base = (pl_u32)guard_base;
    out->continuation_offset_base = (pl_u32)continuation_offset_base;
    out->continuation_payload_base = (pl_u32)continuation_payload_base;
    return 0;
}

int pl_directory_block(const pl_directory *directory, pl_u32 index,
                       pl_block_instance *out)
{
    if (index >= directory->counts.block_count) return PL_ERROR_RANK;
    const pl_u8 *row = directory->descriptors
                     + (pl_u64)index * PL_BLOCK_INSTANCE_BYTES;
    out->rip = pl_read_u64(row);
    out->step_rank = pl_read_u32(row + 8u);
    out->continuation_rank = pl_read_u32(row + 12u);
    out->guard_rank = pl_read_u32(row + 16u);
    return 0;
}

static pl_u64 instance_rip(const pl_directory *directory, pl_u32 index)
{
    return pl_read_u64(directory->descriptors
                       + (pl_u64)index * PL_BLOCK_INSTANCE_BYTES);
}

int pl_directory_find(const pl_directory *directory, pl_u64 rip,
                      pl_u32 *index, pl_u32 *variants)
{
    pl_u32 low = 0;
    pl_u32 high = directory->counts.block_count;
    if (!high) return PL_ERROR_ABSENT;

    /* Lower bound: rows are sorted by RIP and a coordinate may repeat, so
     * settle on the first row rather than any matching row. */
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        if (instance_rip(directory, middle) < rip) low = middle + 1u;
        else high = middle;
    }
    if (low >= directory->counts.block_count
            || instance_rip(directory, low) != rip)
        return PL_ERROR_ABSENT;

    if (index) *index = low;
    if (variants) {
        pl_u32 end = low;
        while (end < directory->counts.block_count
                && instance_rip(directory, end) == rip)
            end += 1u;
        *variants = end - low;
    }
    return 0;
}

/* Read an (offset, length) extent row and bound it against the execution
 * region.  `floor` is the first byte the section is allowed to name, which
 * keeps a template rank from resolving into the parameter run and so on. */
static int read_extent(const pl_directory *directory, pl_u32 base,
                       pl_u32 rank, pl_u32 count, pl_u32 floor,
                       pl_u32 ceiling, pl_region *region)
{
    if (!rank || rank > count) return PL_ERROR_RANK;
    const pl_u8 *row = directory->descriptors
                     + (pl_u64)base + (pl_u64)(rank - 1u) * PL_EXTENT_BYTES;
    pl_u32 offset = pl_read_u32(row);
    pl_u32 length = pl_read_u32(row + 4u);
    if (!length || offset < floor || offset > ceiling
            || length > ceiling - offset)
        return PL_ERROR_RANK;
    region->offset = offset;
    region->length = length;
    return 0;
}

int pl_directory_admit(const pl_directory *directory, pl_u32 index,
                       pl_admission *out)
{
    pl_block_instance instance;
    int status = pl_directory_block(directory, index, &instance);
    if (status) return status;

    const pl_directory_counts *counts = &directory->counts;
    pl_u32 template_end = counts->template_execution_bytes;
    pl_u32 parameter_end = template_end + counts->parameter_execution_bytes;

    /* The STEP instance row names the shared template and this block's own
     * parameter row.  Both stay where they are; only their coordinates are
     * reported. */
    if (!instance.step_rank || instance.step_rank > counts->step_count)
        return PL_ERROR_RANK;
    const pl_u8 *step_row = directory->descriptors
                          + (pl_u64)directory->instance_base
                          + (pl_u64)(instance.step_rank - 1u)
                            * PL_STEP_INSTANCE_BYTES;
    pl_u32 template_rank = pl_read_u32(step_row);
    pl_u32 parameter_offset = pl_read_u32(step_row + 4u);
    pl_u32 parameter_length = pl_read_u32(step_row + 8u);
    pl_u32 step_bytes = pl_read_u32(step_row + 12u);
    if (!step_bytes
            || parameter_offset < template_end
            || parameter_offset > parameter_end
            || parameter_length > parameter_end - parameter_offset)
        return PL_ERROR_RANK;

    status = read_extent(directory, directory->template_base, template_rank,
                         counts->template_count, 0u, template_end,
                         &out->tmpl);
    if (status) return status;
    status = read_extent(directory, directory->guard_base, instance.guard_rank,
                         counts->guard_count, parameter_end,
                         counts->execution_bytes, &out->guard);
    if (status) return status;

    /* The continuation is a variable-width row named by a prefix-offset
     * directory, so its extent comes from the pair of neighbouring offsets. */
    pl_u32 rank = instance.continuation_rank;
    if (!rank || rank > counts->continuation_count) return PL_ERROR_RANK;
    const pl_u8 *offsets = directory->descriptors
                         + directory->continuation_offset_base;
    pl_u32 start = pl_read_u32(offsets + (pl_u64)(rank - 1u) * 4u);
    pl_u32 end = pl_read_u32(offsets + (pl_u64)rank * 4u);
    if (start >= end || end > counts->continuation_bytes)
        return PL_ERROR_RANK;

    pl_continuation relative;
    status = pl_continuation_decode(
        directory->descriptors + directory->continuation_payload_base + start,
        end - start, &relative);
    if (status) return status;

    out->rip = instance.rip;
    out->parameters.offset = parameter_offset;
    out->parameters.length = parameter_length;
    out->step_bytes = step_bytes;
    out->template_rank = template_rank;
    pl_continuation_instantiate(instance.rip, &relative, &out->continuation);
    return 0;
}
