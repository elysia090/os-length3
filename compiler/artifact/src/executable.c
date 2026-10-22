#include <artifact/executable.h>

#include <string.h>

static int add_u64(pl_u64 *value, pl_u64 addend)
{
    if (*value > 0xffffffffffffffffull - addend) return 0;
    *value += addend;
    return 1;
}

static int append_fragment(
    const artifact_executable_workspace *workspace,
    pl_u32 *count, const pl_u8 *bytes, pl_u32 length)
{
    if (!length) return 1;
    if (!bytes || *count >= workspace->fragment_capacity) return 0;
    workspace->fragment[*count] = (artifact_payload){ bytes, length };
    ++*count;
    return 1;
}

int artifact_executable_measure(
    const artifact_executable_population *population, pl_u32 *fragments)
{
    if (!population || !fragments || !population->images
            || !population->states || !population->image
            || !population->state_offset || !population->emitted
            || !population->emitted_file_offset
            || population->state_offset[0] != 0u
            || population->state_offset[population->images]
               != population->states)
        return ARTIFACT_ERROR_EXECUTABLE_RANGE;
    pl_u64 count = 0u;
    for (pl_u32 image = 0u; image < population->images; ++image) {
        const artifact_cell *whole = &population->image[image];
        pl_u32 first = population->state_offset[image];
        pl_u32 end = population->state_offset[image + 1u];
        if (!whole->bytes || !whole->length || first >= end
                || end > population->states)
            return ARTIFACT_ERROR_EXECUTABLE;
        pl_u64 cursor = population->emitted_file_offset[first];
        if (cursor > whole->length) return ARTIFACT_ERROR_EXECUTABLE;
        count += cursor != 0u;
        for (pl_u32 state = first; state < end; ++state) {
            const artifact_cell *span = &population->emitted[state];
            if (population->emitted_file_offset[state] != cursor
                    || span->length > whole->length - cursor
                    || (span->length && !span->bytes))
                return ARTIFACT_ERROR_EXECUTABLE;
            count += span->length != 0u;
            cursor += span->length;
        }
        count += cursor != whole->length;
    }
    if (!count || count > 0xffffffffu) return ARTIFACT_ERROR_EXECUTABLE_RANGE;
    *fragments = (pl_u32)count;
    return 0;
}

int artifact_executable_project(
    const artifact_executable_population *population,
    const artifact_executable_workspace *workspace,
    artifact_executable_projection *out)
{
    pl_u32 required = 0u;
    int status = artifact_executable_measure(population, &required);
    if (status) return status;
    if (!workspace || !out || !workspace->fragment
            || !workspace->image_fragment_offset
            || workspace->fragment_capacity < required
            || population->images == 0xffffffffu
            || workspace->image_fragment_capacity < population->images + 1u)
        return ARTIFACT_ERROR_EXECUTABLE_RANGE;

    artifact_executable_projection result = {
        .images = population->images,
        .states = population->states,
        .generated_file_coordinates = population->states,
    };
    pl_u32 fragments = 0u;
    for (pl_u32 image = 0u; image < population->images; ++image) {
        const artifact_cell *whole = &population->image[image];
        pl_u32 first_state = population->state_offset[image];
        pl_u32 end_state = population->state_offset[image + 1u];
        if (!whole->bytes || !whole->length || first_state >= end_state
                || end_state > population->states)
            return ARTIFACT_ERROR_EXECUTABLE;
        if (!add_u64(&result.opened_image_bytes, whole->length))
            return ARTIFACT_ERROR_EXECUTABLE_RANGE;
        workspace->image_fragment_offset[image] = fragments;
        pl_u64 cursor = population->emitted_file_offset[first_state];
        if (cursor > whole->length || cursor > 0xffffffffu
                || !append_fragment(
                    workspace, &fragments, whole->bytes, (pl_u32)cursor))
            return ARTIFACT_ERROR_EXECUTABLE;
        if (!add_u64(&result.gap_bytes, cursor))
            return ARTIFACT_ERROR_EXECUTABLE_RANGE;

        for (pl_u32 state = first_state; state < end_state; ++state) {
            const artifact_cell *span = &population->emitted[state];
            if (population->emitted_file_offset[state] != cursor
                    || span->length > whole->length - cursor
                    || (span->length && !span->bytes)
                    || (span->length && memcmp(
                        whole->bytes + cursor, span->bytes,
                        span->length)))
                return ARTIFACT_ERROR_EXECUTABLE;
            if (span->length) {
                if (!append_fragment(
                        workspace, &fragments,
                        span->bytes, span->length))
                    return ARTIFACT_ERROR_EXECUTABLE_RANGE;
                ++result.nonempty_emitted_states;
                if (!add_u64(&result.emitted_bytes, span->length))
                    return ARTIFACT_ERROR_EXECUTABLE_RANGE;
            }
            cursor += span->length;
        }
        if (cursor > whole->length
                || whole->length - cursor > 0xffffffffu
                || !append_fragment(
                    workspace, &fragments, whole->bytes + cursor,
                    (pl_u32)(whole->length - cursor)))
            return ARTIFACT_ERROR_EXECUTABLE;
        if (!add_u64(&result.gap_bytes, whole->length - cursor))
            return ARTIFACT_ERROR_EXECUTABLE_RANGE;
        workspace->image_fragment_offset[image + 1u] = fragments;
    }
    if (!fragments) return ARTIFACT_ERROR_EXECUTABLE;

    artifact_payload_projection payload = { 0 };
    status = artifact_payload_project(
        workspace->fragment, fragments, &workspace->payload, &payload);
    if (status) return status;

    for (pl_u32 image = 0u; image < population->images; ++image) {
        const artifact_cell *whole = &population->image[image];
        pl_u64 written = 0u;
        for (pl_u32 occurrence = workspace->image_fragment_offset[image];
                occurrence < workspace->image_fragment_offset[image + 1u];
                ++occurrence) {
            pl_u32 rank = workspace->payload.share.rank[occurrence];
            if (rank >= payload.classes) return ARTIFACT_ERROR_EXECUTABLE;
            pl_u32 representative =
                workspace->payload.share.representative[rank];
            if (representative >= fragments)
                return ARTIFACT_ERROR_EXECUTABLE;
            const artifact_payload *part =
                &workspace->fragment[representative];
            if (part->length > whole->length - written)
                return ARTIFACT_ERROR_EXECUTABLE;
            if (memcmp(whole->bytes + written, part->bytes, part->length))
                return ARTIFACT_ERROR_EXECUTABLE;
            written += part->length;
        }
        if (written != whole->length)
            return ARTIFACT_ERROR_EXECUTABLE;
        if (!add_u64(&result.reconstructed_bytes, written))
            return ARTIFACT_ERROR_EXECUTABLE_RANGE;
    }
    result.fragment = payload;
    result.fragment_occurrences = fragments;
    *out = result;
    return 0;
}
