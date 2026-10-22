#include <artifact/factor.h>

#include <stdio.h>
#include <stdlib.h>

int main(void)
{
    static const pl_u8 word[] =
        "same-rodata/same-rodata/archive-member/archive-member";
    enum { BYTES = sizeof(word) - 1u };
    pl_u32 suffix_capacity = 0u, choice_capacity = 0u, z_capacity = 0u;
    int status = artifact_factor_measure(
        BYTES, &suffix_capacity, &choice_capacity, &z_capacity);
    pl_u64 *suffix = status ? 0 : malloc(
        (size_t)suffix_capacity * sizeof(*suffix));
    pl_u32 *choice = status ? 0 : malloc(
        (size_t)choice_capacity * 2u * sizeof(*choice));
    pl_u32 *z = status ? 0 : malloc((size_t)z_capacity * sizeof(*z));
    pl_u8 decoded[BYTES];
    if (!status && (!suffix || !choice || !z))
        status = ARTIFACT_ERROR_FACTOR_RANGE;
    artifact_factor_workspace workspace = {
        suffix, suffix_capacity, choice,
        choice ? choice + choice_capacity : 0,
        choice_capacity, z, z_capacity,
    };
    artifact_factor_projection projection = { 0 };
    if (!status)
        status = artifact_factor_exact_project(
            word, BYTES, &workspace, &projection);
    if (!status)
        status = artifact_factor_decode(
            word, BYTES, &workspace, decoded, sizeof(decoded));
    if (!status && (!projection.reference_tokens
            || projection.referenced_bytes < 20u
            || projection.retained_bits >= projection.opened_literal_bits
            || projection.unresolved_bit_gap))
        status = ARTIFACT_ERROR_FACTOR;
    if (status) {
        fprintf(stderr, "artifact exact substring factor: RED (%d)\n", status);
        free(z);
        free(choice);
        free(suffix);
        return 1;
    }
    printf("artifact exact substring factor: green "
           "(%u bytes, %llu -> %llu bits, gap=0)\n",
           BYTES, (unsigned long long)projection.opened_literal_bits,
           (unsigned long long)projection.retained_bits);
    free(z);
    free(choice);
    free(suffix);
    return 0;
}
