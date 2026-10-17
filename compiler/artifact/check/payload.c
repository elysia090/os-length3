#include <artifact/factor-index.h>
#include <artifact/payload.h>

#include <stdio.h>
#include <stdlib.h>

#define PAYLOAD(text) { (const pl_u8 *)(text), \
                        (pl_u32)(sizeof(text) - 1u) }

static int equal_payload(const artifact_payload *left,
                         const artifact_payload *right)
{
    if (left->length != right->length) return 0;
    for (pl_u32 index = 0u; index < left->length; ++index)
        if (left->bytes[index] != right->bytes[index]) return 0;
    return 1;
}

int main(void)
{
    static const pl_u8 zero_payload[] = { 0u };
    static const artifact_payload payloads[] = {
        PAYLOAD("ELF-A:shared-rodata-tail"),
        PAYLOAD("ELF-A:shared-rodata-tail"),
        PAYLOAD("ELF-B:shared-rodata-tail"),
        PAYLOAD("shared-rodata"),
        { 0, 0u },
        { zero_payload, 1u },
    };
    enum { COUNT = sizeof(payloads) / sizeof(payloads[0]) };
    pl_u32 digest_bytes = 0u, index_capacity = 0u;
    int status = artifact_share_measure(
        COUNT, &digest_bytes, &index_capacity);
    pl_u8 *digest = status ? 0 : malloc(digest_bytes);
    pl_u32 *index = status ? 0 : malloc(
        (size_t)index_capacity * 4u * sizeof(*index));
    artifact_complete_observation *observation = status ? 0 : malloc(
        (size_t)COUNT * sizeof(*observation));
    artifact_payload_workspace workspace = {
        observation, COUNT,
        { digest, digest_bytes, index,
          index ? index + index_capacity : 0,
          index ? index + index_capacity * 2u : 0,
          index ? index + index_capacity * 3u : 0,
          index_capacity },
    };
    artifact_payload_projection projection = { 0 };
    if (!status && (!digest || !index || !observation))
        status = ARTIFACT_ERROR_PAYLOAD_RANGE;
    if (!status)
        status = artifact_payload_project(
            payloads, COUNT, &workspace, &projection);
    pl_u64 *end = status ? 0 : malloc(
        (size_t)projection.classes * sizeof(*end));
    artifact_byte_view view = { 0 };
    if (!status && !end)
        status = ARTIFACT_ERROR_PAYLOAD_RANGE;
    if (!status)
        status = artifact_payload_view(
            payloads, COUNT, &workspace, &projection,
            end, projection.classes, &view);
    for (pl_u32 occurrence = 0u; !status && occurrence < COUNT;
            ++occurrence) {
        pl_u32 rank = workspace.share.rank[occurrence];
        if (rank >= projection.classes) {
            status = ARTIFACT_ERROR_PAYLOAD;
            break;
        }
        pl_u32 representative = workspace.share.representative[rank];
        if (!equal_payload(
                &payloads[occurrence], &payloads[representative]))
            status = ARTIFACT_ERROR_PAYLOAD;
    }

    /* One virtual Byte* view lets an ELF rodata factor and an archive-member
     * factor compete without first concatenating either payload. */
    artifact_factor_projection factor = { 0 };
    pl_u32 vector_capacity = 0u, tree_capacity = 0u;
    if (!status && (view.bytes > 0xffffffffu
            || artifact_factor_index_measure(
                (pl_u32)view.bytes, &vector_capacity, &tree_capacity)))
        status = ARTIFACT_ERROR_PAYLOAD_RANGE;
    pl_u32 *vector = status ? 0 : malloc(
        (size_t)vector_capacity * 4u * sizeof(*vector));
    pl_u64 *tree = status ? 0 : malloc(
        (size_t)tree_capacity * sizeof(*tree));
    artifact_factor_index_workspace factor_workspace = {
        .source = vector ? vector + vector_capacity * 2u : 0,
        .length = vector ? vector + vector_capacity * 3u : 0,
        .suffix_array = vector,
        .rank = vector ? vector + vector_capacity : 0,
        .vector_capacity = vector_capacity,
        .cost_tree = tree,
        .tree_capacity = tree_capacity,
    };
    if (!status && (!vector || !tree))
        status = ARTIFACT_ERROR_PAYLOAD_RANGE;
    if (!status)
        status = artifact_factor_index_project(
            &view, &factor_workspace, &factor);
    if (!status && (projection.classes != 5u
            || workspace.share.rank[0] != workspace.share.rank[1]
            || projection.duplicate_bytes_eliminated != payloads[0].length
            || view.bytes != projection.unique_bytes
            || !factor.reference_tokens || !factor.referenced_bytes
            || factor.unresolved_bit_gap))
        status = ARTIFACT_ERROR_PAYLOAD;

    if (status) {
        fprintf(stderr, "global immutable payload: RED (%d)\n", status);
    } else {
        printf("global immutable payload: green "
               "(%u extents -> %u exact owners, %llu duplicate bytes "
               "deleted, %llu bytes covered by exact factors)\n",
               (unsigned)COUNT, projection.classes,
               (unsigned long long)projection.duplicate_bytes_eliminated,
               (unsigned long long)factor.referenced_bytes);
    }
    free(tree);
    free(vector);
    free(end);
    free(observation);
    free(index);
    free(digest);
    return status ? 1 : 0;
}
