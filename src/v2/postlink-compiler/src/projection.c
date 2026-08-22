#include <postlink/projection.h>

static const pl_u8 PROJECTION_MAGIC[PL_PROJECTION_MAGIC_BYTES] =
    PL_PROJECTION_MAGIC;

static int same_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 count)
{
    pl_u32 different = 0u;
    for (pl_u32 index = 0u; index < count; ++index)
        different |= (pl_u32)(left[index] ^ right[index]);
    return different == 0u;
}

static int nonzero_digest(const pl_u8 *digest)
{
    pl_u32 any = 0u;
    for (pl_u32 index = 0u; index < PL_EXECUTABLE_DIGEST_BYTES; ++index)
        any |= digest[index];
    return any != 0u;
}

int pl_projection_validate(const pl_projection *projection)
{
    if (!projection || !projection->source_bytes
            || !nonzero_digest(projection->source_digest)
            || !projection->function_count
            || !projection->instantiation_count
            || !projection->residual_count
            || !projection->residual_edge_count
            || !projection->entry_page_count
            || !projection->entry_tail_row_count
            || projection->entry_residual >= projection->residual_count
            || projection->function_count > 0xffffffu
            || projection->instantiation_count > 0xffffffu
            || projection->residual_count > 0xffffffu
            || projection->parameter_word_count > (1u << 24u)
            || pl_index_ref_validate(&projection->modules)
            || pl_index_ref_validate(&projection->resources)
            || pl_index_ref_validate(&projection->bindings)
            || projection->modules.leaf_row_bytes
               != PL_EXECUTABLE_MODULE_BYTES
            || projection->resources.leaf_row_bytes
               != PL_EXECUTABLE_RESOURCE_BYTES
            || projection->bindings.leaf_row_bytes
               != PL_EXECUTABLE_BINDING_BYTES)
        return PL_ERROR_PROJECTION;
    return 0;
}

int pl_projection_write(
    const pl_projection *projection,
    pl_u8 target[PL_PROJECTION_HEADER_BYTES])
{
    if (pl_projection_validate(projection) || !target)
        return PL_ERROR_PROJECTION;
    for (pl_u32 index = 0u; index < PL_PROJECTION_HEADER_BYTES; ++index)
        target[index] = 0u;
    for (pl_u32 index = 0u; index < PL_PROJECTION_MAGIC_BYTES; ++index)
        target[index] = PROJECTION_MAGIC[index];
    pl_write_u32(target + PL_PROJECTION_OFF_VERSION, PL_PROJECTION_VERSION);
    pl_write_u32(target + PL_PROJECTION_OFF_HEADER_BYTES,
                 PL_PROJECTION_HEADER_BYTES);
    pl_write_u64(target + PL_PROJECTION_OFF_SOURCE_BYTES,
                 projection->source_bytes);
    for (pl_u32 index = 0u; index < PL_EXECUTABLE_DIGEST_BYTES; ++index)
        target[PL_PROJECTION_OFF_SOURCE_DIGEST + index] =
            projection->source_digest[index];
    pl_write_u64(target + PL_PROJECTION_OFF_ENTRY_RIP,
                 projection->entry_rip);
    pl_write_u32(target + PL_PROJECTION_OFF_ENTRY_RESIDUAL,
                 projection->entry_residual);
    pl_write_u32(target + PL_PROJECTION_OFF_FUNCTION_COUNT,
                 projection->function_count);
    pl_write_u32(target + PL_PROJECTION_OFF_INSTANTIATION_COUNT,
                 projection->instantiation_count);
    pl_write_u32(target + PL_PROJECTION_OFF_PARAMETER_WORD_COUNT,
                 projection->parameter_word_count);
    pl_write_u32(target + PL_PROJECTION_OFF_RESIDUAL_COUNT,
                 projection->residual_count);
    pl_write_u32(target + PL_PROJECTION_OFF_RESIDUAL_EDGE_COUNT,
                 projection->residual_edge_count);
    pl_write_u32(target + PL_PROJECTION_OFF_ENTRY_PAGE_COUNT,
                 projection->entry_page_count);
    pl_write_u32(target + PL_PROJECTION_OFF_ENTRY_TAIL_ROW_COUNT,
                 projection->entry_tail_row_count);
    if (pl_index_ref_write(
            &projection->modules, target + PL_PROJECTION_OFF_MODULE_INDEX)
            || pl_index_ref_write(
                &projection->resources,
                target + PL_PROJECTION_OFF_RESOURCE_INDEX)
            || pl_index_ref_write(
                &projection->bindings,
                target + PL_PROJECTION_OFF_BINDING_INDEX))
        return PL_ERROR_PROJECTION;
    pl_write_u64(target + PL_PROJECTION_OFF_FILE_BYTES,
                 PL_PROJECTION_HEADER_BYTES);
    return 0;
}

int pl_projection_open(
    const pl_u8 *bytes, pl_u64 length, pl_projection *out)
{
    if (!bytes || !out || length != PL_PROJECTION_HEADER_BYTES)
        return PL_ERROR_PROJECTION_RANGE;
    if (!same_bytes(bytes, PROJECTION_MAGIC, PL_PROJECTION_MAGIC_BYTES)
            || pl_read_u32(bytes + PL_PROJECTION_OFF_VERSION)
               != PL_PROJECTION_VERSION
            || pl_read_u32(bytes + PL_PROJECTION_OFF_HEADER_BYTES)
               != PL_PROJECTION_HEADER_BYTES
            || pl_read_u64(bytes + PL_PROJECTION_OFF_FILE_BYTES)
               != PL_PROJECTION_HEADER_BYTES)
        return PL_ERROR_PROJECTION;
    for (pl_u32 index = PL_PROJECTION_OFF_FILE_BYTES + 8u;
         index < PL_PROJECTION_HEADER_BYTES; ++index)
        if (bytes[index]) return PL_ERROR_PROJECTION;
    pl_projection projection = {
        .source_bytes = pl_read_u64(
            bytes + PL_PROJECTION_OFF_SOURCE_BYTES),
        .entry_rip = pl_read_u64(bytes + PL_PROJECTION_OFF_ENTRY_RIP),
        .entry_residual = pl_read_u32(
            bytes + PL_PROJECTION_OFF_ENTRY_RESIDUAL),
        .function_count = pl_read_u32(
            bytes + PL_PROJECTION_OFF_FUNCTION_COUNT),
        .instantiation_count = pl_read_u32(
            bytes + PL_PROJECTION_OFF_INSTANTIATION_COUNT),
        .parameter_word_count = pl_read_u32(
            bytes + PL_PROJECTION_OFF_PARAMETER_WORD_COUNT),
        .residual_count = pl_read_u32(
            bytes + PL_PROJECTION_OFF_RESIDUAL_COUNT),
        .residual_edge_count = pl_read_u32(
            bytes + PL_PROJECTION_OFF_RESIDUAL_EDGE_COUNT),
        .entry_page_count = pl_read_u32(
            bytes + PL_PROJECTION_OFF_ENTRY_PAGE_COUNT),
        .entry_tail_row_count = pl_read_u32(
            bytes + PL_PROJECTION_OFF_ENTRY_TAIL_ROW_COUNT),
    };
    for (pl_u32 index = 0u; index < PL_EXECUTABLE_DIGEST_BYTES; ++index)
        projection.source_digest[index] =
            bytes[PL_PROJECTION_OFF_SOURCE_DIGEST + index];
    if (pl_index_ref_read(
            bytes + PL_PROJECTION_OFF_MODULE_INDEX, &projection.modules)
            || pl_index_ref_read(
                bytes + PL_PROJECTION_OFF_RESOURCE_INDEX,
                &projection.resources)
            || pl_index_ref_read(
                bytes + PL_PROJECTION_OFF_BINDING_INDEX,
                &projection.bindings)
            || pl_projection_validate(&projection))
        return PL_ERROR_PROJECTION;
    *out = projection;
    return 0;
}
