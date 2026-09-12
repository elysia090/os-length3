#include <artifact/factor-codec.h>
#include <artifact/factor-index.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void)
{
    static const pl_u8 word[] =
        "ELF-A:shared-rodata-tail|archive:shared-rodata-tail|"
        "proof:shared-rodata-tail";
    enum { BYTES = sizeof(word) - 1u };
    artifact_payload payload = { word, BYTES };
    pl_u32 representative = 0u;
    pl_u64 end = BYTES;
    artifact_byte_view view = {
        &payload, 1u, &representative, &end, 1u, BYTES,
    };
    pl_u32 vector = 0u, tree = 0u;
    int status = artifact_factor_index_measure(
        BYTES, &vector, &tree);
    pl_u32 *vectors = status ? 0 : malloc(
        (size_t)vector * 4u * sizeof(*vectors));
    pl_u64 *cost = status ? 0 : malloc((size_t)tree * sizeof(*cost));
    artifact_factor_index_workspace workspace = {
        .source = vectors ? vectors + vector * 2u : 0,
        .length = vectors ? vectors + vector * 3u : 0,
        .suffix_array = vectors,
        .rank = vectors ? vectors + vector : 0,
        .vector_capacity = vector,
        .cost_tree = cost,
        .tree_capacity = tree,
    };
    artifact_factor_projection factor = { 0 };
    if (!status && (!vectors || !cost))
        status = ARTIFACT_ERROR_FACTOR_CODEC_RANGE;
    if (!status)
        status = artifact_factor_index_project(
            &view, &workspace, &factor);
    pl_u32 code_bytes = status ? 0u
        : (pl_u32)((factor.retained_bits + 7u) >> 3u);
    pl_u8 *code = status ? 0 : malloc(code_bytes);
    pl_u8 decoded[BYTES];
    artifact_factor_code_projection written = { 0 }, read = { 0 };
    if (!status && !code) status = ARTIFACT_ERROR_FACTOR_CODEC_RANGE;
    if (!status)
        status = artifact_factor_code_write(
            &view, workspace.source, workspace.length,
            workspace.vector_capacity, code, code_bytes, &written);
    artifact_factor_code_projection verified = { 0 };
    if (!status)
        status = artifact_factor_code_verify(
            code, written.payload_bytes, written.payload_bits,
            &view, &verified);
    if (!status)
        status = artifact_factor_code_read(
            code, written.payload_bytes, written.payload_bits,
            decoded, sizeof(decoded), BYTES, &read);
    if (!status && (written.payload_bits != factor.retained_bits
            || written.payload_bytes != code_bytes
            || written.tokens != factor.tokens
            || verified.tokens != written.tokens
            || read.tokens != written.tokens
            || memcmp(decoded, word, BYTES)))
        status = ARTIFACT_ERROR_FACTOR_CODEC;

    /* The decoder receives no opened word.  It must reject every spelling
     * that relies on implicit trailing data or noncanonical padding. */
    if (!status && artifact_factor_code_read(
            code, written.payload_bytes, written.payload_bits - 1u,
            decoded, sizeof(decoded), BYTES, &read)
            != ARTIFACT_ERROR_FACTOR_CODEC)
        status = ARTIFACT_ERROR_FACTOR_CODEC;
    if (!status && (written.payload_bits & 7u)) {
        code[written.payload_bytes - 1u] |= 1u;
        if (artifact_factor_code_read(
                code, written.payload_bytes, written.payload_bits,
                decoded, sizeof(decoded), BYTES, &read)
                != ARTIFACT_ERROR_FACTOR_CODEC)
            status = ARTIFACT_ERROR_FACTOR_CODEC;
        code[written.payload_bytes - 1u] &= (pl_u8)~1u;
    }

    if (status) {
        fprintf(stderr, "stored substring factor: RED (%d)\n", status);
    } else {
        printf("stored substring factor: green "
               "(%u opened bytes -> %llu bits; decoder owns no source)\n",
               (unsigned)BYTES,
               (unsigned long long)written.payload_bits);
    }
    free(code);
    free(cost);
    free(vectors);
    return status ? 1 : 0;
}
