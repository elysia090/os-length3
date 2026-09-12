#include <artifact/factor-index.h>

#include <stdio.h>
#include <stdlib.h>

typedef struct {
    artifact_factor_workspace exact;
    artifact_factor_index_workspace indexed;
    pl_u8 *exact_bytes;
    pl_u8 *indexed_bytes;
} workspaces;

static void release(workspaces *value)
{
    free(value->indexed.cost_tree);
    free(value->indexed.length);
    free(value->indexed.source);
    free(value->indexed.rank);
    free(value->indexed.suffix_array);
    free(value->exact.z);
    free(value->exact.length);
    free(value->exact.source);
    free(value->exact.suffix_bits);
    free(value->indexed_bytes);
    free(value->exact_bytes);
}

static int allocate(pl_u32 bytes, workspaces *out)
{
    pl_u32 suffix = 0u, choice = 0u, z = 0u;
    int status = artifact_factor_measure(bytes, &suffix, &choice, &z);
    if (status) return status;
    out->exact = (artifact_factor_workspace){
        malloc((size_t)suffix * sizeof(pl_u64)), suffix,
        malloc((size_t)choice * sizeof(pl_u32)),
        malloc((size_t)choice * sizeof(pl_u32)), choice,
        malloc((size_t)z * sizeof(pl_u32)), z,
    };
    pl_u32 vector = 0u, tree = 0u;
    status = artifact_factor_index_measure(
        bytes, &vector, &tree);
    if (status) return status;
    pl_u32 expected_blocks = (bytes + 15u) / 16u;
    if (vector != bytes + 1u
            || tree != expected_blocks)
        return ARTIFACT_ERROR_FACTOR_RANGE;
    out->indexed.length = malloc((size_t)vector * sizeof(pl_u32));
    out->indexed.suffix_array = malloc((size_t)vector * sizeof(pl_u32));
    out->indexed.rank = malloc((size_t)vector * sizeof(pl_u32));
    out->indexed.source = malloc((size_t)vector * sizeof(pl_u32));
    out->indexed.vector_capacity = vector;
    out->indexed.cost_tree = malloc((size_t)tree * sizeof(pl_u64));
    out->indexed.tree_capacity = tree;
    out->exact_bytes = malloc(bytes);
    out->indexed_bytes = malloc(bytes);
    if (!out->exact.suffix_bits || !out->exact.source
            || !out->exact.length || !out->exact.z
            || !out->indexed.length || !out->indexed.suffix_array
            || !out->indexed.rank || !out->indexed.source
            || !out->indexed.cost_tree
            || !out->exact_bytes
            || !out->indexed_bytes)
        return ARTIFACT_ERROR_FACTOR_RANGE;
    return 0;
}

static int compare_one(const pl_u8 *bytes, pl_u32 count)
{
    workspaces workspace = { 0 };
    artifact_payload payload = { bytes, count };
    pl_u32 representative = 0u;
    pl_u64 end = count;
    artifact_byte_view view = {
        &payload, 1u, &representative, &end, 1u, count,
    };
    int status = allocate(count, &workspace);
    artifact_factor_projection exact = { 0 }, indexed = { 0 };
    if (!status)
        status = artifact_factor_exact_project(
            bytes, count, &workspace.exact, &exact);
    if (!status)
        status = artifact_factor_index_project(
            &view, &workspace.indexed, &indexed);
    if (!status && (exact.retained_bits != indexed.retained_bits
            || exact.tokens != indexed.tokens
            || exact.literal_tokens != indexed.literal_tokens
            || exact.reference_tokens != indexed.reference_tokens))
        status = ARTIFACT_ERROR_FACTOR;
    for (pl_u32 at = 0u; !status && at < count;) {
        if (workspace.exact.length[at]
                != workspace.indexed.length[at]
                || (workspace.exact.length[at]
                    && workspace.exact.source[at]
                       != workspace.indexed.source[at])) {
            status = ARTIFACT_ERROR_FACTOR;
            break;
        }
        at += workspace.exact.length[at]
            ? workspace.exact.length[at] : 1u;
    }
    if (!status)
        status = artifact_factor_decode(
            bytes, count, &workspace.exact,
            workspace.exact_bytes, count);
    if (!status)
        status = artifact_factor_index_decode(
            &view, &workspace.indexed,
            workspace.indexed_bytes, count);
    for (pl_u32 index = 0u; !status && index < count; ++index)
        if (workspace.exact_bytes[index] != bytes[index]
                || workspace.indexed_bytes[index] != bytes[index])
            status = ARTIFACT_ERROR_FACTOR;
    release(&workspace);
    return status;
}

int main(void)
{
    pl_u8 bytes[4096];
    int status = 0;
    /* Exhaust every binary word through length ten.  This catches suffix-rank,
     * overlap, literal/reference tie and canonical-source counterexamples. */
    for (pl_u32 length = 1u; !status && length <= 10u; ++length)
        for (pl_u32 word = 0u; !status && word < (1u << length); ++word) {
            for (pl_u32 index = 0u; index < length; ++index)
                bytes[index] = (pl_u8)((word >> index) & 1u);
            status = compare_one(bytes, length);
            if (status)
                fprintf(stderr,
                        "factor parity counterexample: binary length=%u "
                        "word=0x%x\n", length, word);
        }
    pl_u32 random = 0x91e10da5u;
    for (pl_u32 sample = 0u; !status && sample < 512u; ++sample) {
        pl_u32 length = sample % 95u + 1u;
        for (pl_u32 index = 0u; index < length; ++index) {
            random ^= random << 13u;
            random ^= random >> 17u;
            random ^= random << 5u;
            bytes[index] = (pl_u8)random;
        }
        status = compare_one(bytes, length);
        if (status)
            fprintf(stderr,
                    "factor parity counterexample: random sample=%u "
                    "length=%u\n", sample, length);
    }
    /* Exercise the long-LCP and overlap boundaries which a short random word
     * almost never reaches.  The O(N^2) implementation remains the oracle. */
    for (pl_u32 index = 0u; !status && index < sizeof(bytes); ++index)
        bytes[index] = 0xa5u;
    if (!status) status = compare_one(bytes, sizeof(bytes));
    for (pl_u32 index = 0u; !status && index < sizeof(bytes); ++index)
        bytes[index] = (pl_u8)(index & 31u);
    if (!status) status = compare_one(bytes, sizeof(bytes));
    for (pl_u32 index = 0u; !status && index < sizeof(bytes); ++index)
        bytes[index] = (pl_u8)(index % 257u ? 0x5au : index / 257u);
    if (!status) status = compare_one(bytes, sizeof(bytes));
    if (status) {
        fprintf(stderr, "suffix-index factor oracle parity: RED (%d)\n",
                status);
        return 1;
    }
        printf("suffix-index factor oracle parity: green "
           "(2,046 exhaustive binary + 512 random + "
           "3 long structured words)\n");
    return 0;
}
