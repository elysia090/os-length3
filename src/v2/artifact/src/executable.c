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

int artifact_executable_project(
    const artifact_executable_population *population,
    const artifact_executable_workspace *workspace,
    artifact_executable_projection *out)
{
    if (!population || !workspace || !out || !population->images
            || !population->states || !population->image
            || !population->state_offset || !population->emitted
            || !population->emitted_file_offset
            || !workspace->fragment || !workspace->image_fragment_offset
            || !workspace->state_fragment || !workspace->reconstruction
            || population->images > 0xffffffffu / 2u
            || population->states
               > 0xffffffffu - population->images * 2u
            || workspace->fragment_capacity
               < population->states + population->images * 2u
            || workspace->image_fragment_capacity < population->images + 1u
            || workspace->state_fragment_capacity < population->states
            || population->state_offset[0] != 0u
            || population->state_offset[population->images]
               != population->states)
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
            workspace->state_fragment[state] = ARTIFACT_NO_FRAGMENT;
            if (population->emitted_file_offset[state] != cursor
                    || span->length > whole->length - cursor
                    || (span->length && !span->bytes)
                    || (span->length && memcmp(
                        whole->bytes + cursor, span->bytes,
                        span->length)))
                return ARTIFACT_ERROR_EXECUTABLE;
            if (span->length) {
                workspace->state_fragment[state] = fragments;
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
    int status = artifact_payload_project(
        workspace->fragment, fragments, &workspace->payload, &payload);
    if (status) return status;

    for (pl_u32 image = 0u; image < population->images; ++image) {
        const artifact_cell *whole = &population->image[image];
        if (workspace->reconstruction_capacity < whole->length)
            return ARTIFACT_ERROR_EXECUTABLE_RANGE;
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
            memcpy(workspace->reconstruction + written,
                   part->bytes, part->length);
            written += part->length;
        }
        if (written != whole->length || memcmp(
                workspace->reconstruction, whole->bytes, whole->length))
            return ARTIFACT_ERROR_EXECUTABLE;
        if (!add_u64(&result.reconstructed_bytes, written))
            return ARTIFACT_ERROR_EXECUTABLE_RANGE;
    }
    result.fragment = payload;
    result.fragment_occurrences = fragments;
    *out = result;
    return 0;
}
