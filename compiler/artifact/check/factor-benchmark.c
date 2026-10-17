#include <artifact/factor-index.h>

#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static pl_u32 random_word(pl_u32 *state)
{
    pl_u32 value = *state;
    value ^= value << 13u;
    value ^= value >> 17u;
    value ^= value << 5u;
    *state = value;
    return value;
}

int main(int argc, char **argv)
{
    unsigned long requested = argc > 1 ? strtoul(argv[1], 0, 10) : 8u;
    unsigned long requested_spans = argc > 2
        ? strtoul(argv[2], 0, 10) : 1u;
    if (!requested || requested > 1024u) return 2;
    pl_u64 extent64 = (pl_u64)requested * 1024u * 1024u;
    if (extent64 > 0xffffffffu || !requested_spans
            || requested_spans > extent64
            || requested_spans > 0xffffffffu)
        return 2;
    pl_u32 extent = (pl_u32)extent64;
    pl_u32 spans = (pl_u32)requested_spans;
    pl_u8 *word = malloc((size_t)extent);
    artifact_payload *payload = malloc((size_t)spans * sizeof(*payload));
    pl_u32 *representative = malloc(
        (size_t)spans * sizeof(*representative));
    pl_u64 *view_end = malloc((size_t)spans * sizeof(*view_end));
    if (!word || !payload || !representative || !view_end) return 2;
    pl_u32 random = 0x9e3779b9u;
    for (pl_u32 at = 0u; at < extent; ++at) {
        if (at >= 65536u && (at & 4095u) < 3072u)
            word[at] = word[at - 65536u];
        else
            word[at] = (pl_u8)random_word(&random);
    }

    pl_u32 vector = 0u, tree = 0u;
    int status = artifact_factor_index_measure(
        extent, &vector, &tree);
    pl_u32 *vectors = status ? 0 : malloc(
        (size_t)vector * 4u * sizeof(*vectors));
    pl_u64 *cost = status ? 0 : malloc((size_t)tree * sizeof(*cost));
    if (status || !vectors || !cost) return 2;
    artifact_factor_index_workspace workspace = {
        .source = vectors + vector * 2u,
        .length = vectors + vector * 3u,
        .suffix_array = vectors,
        .rank = vectors + vector,
        .vector_capacity = vector,
        .cost_tree = cost,
        .tree_capacity = tree,
    };
    artifact_factor_projection projection = { 0 };
    for (pl_u32 span = 0u; span < spans; ++span) {
        pl_u32 first = (pl_u32)((pl_u64)extent * span / spans);
        pl_u32 last = (pl_u32)((pl_u64)extent * (span + 1u) / spans);
        payload[span] = (artifact_payload){ word + first, last - first };
        representative[span] = span;
        view_end[span] = last;
    }
    artifact_byte_view view = {
        payload, spans, representative, view_end, spans, extent,
    };
    clock_t begin = clock();
    status = artifact_factor_index_project(
        &view, &workspace, &projection);
    clock_t end = clock();
    double seconds = end >= begin
        ? (double)(end - begin) / (double)CLOCKS_PER_SEC : 0.0;
    if (status) {
        fprintf(stderr, "factor benchmark: RED (%d)\n", status);
        return 1;
    }
    pl_u64 workspace_bytes = (pl_u64)vector * 16u
                           + (pl_u64)tree * 8u;
    if (workspace_bytes > (pl_u64)extent * 17u + 32u)
        return 1;
    printf("factor benchmark: %u bytes/%u spans -> %llu bits, "
           "%.6f CPU seconds, %llu workspace bytes (<17N)\n",
           extent, spans, (unsigned long long)projection.retained_bits, seconds,
           (unsigned long long)workspace_bytes);
    free(cost);
    free(vectors);
    free(view_end);
    free(representative);
    free(payload);
    free(word);
    return 0;
}
