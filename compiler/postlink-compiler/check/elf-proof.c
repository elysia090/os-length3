/* Standard-ELF writer/reader round-trip fixture.
 *
 * The cost fields below are synthetic writer-test data. This program is not a
 * semantic compiler and is never installed as the product CLI.
 */

#include "../src/internal/emit-x86.h"

#include <optimized-x86/reader.h>
#include <support/checked.h>
#include <support/sha256.h>
#include <x86/elf.h>

#include <stdio.h>
#include <stdlib.h>

static int read_file(const char *path, pl_u8 **bytes, pl_u64 *length)
{
    FILE *file = fopen(path, "rb");
    long end;
    if (!file) return 0;
    if (fseek(file, 0, SEEK_END) || (end = ftell(file)) <= 0
            || fseek(file, 0, SEEK_SET)) {
        fclose(file);
        return 0;
    }
    *bytes = malloc((size_t)end);
    if (!*bytes || fread(*bytes, 1u, (size_t)end, file) != (size_t)end) {
        free(*bytes);
        *bytes = NULL;
        fclose(file);
        return 0;
    }
    fclose(file);
    *length = (pl_u64)(unsigned long)end;
    return 1;
}

static int write_file(const char *path, const pl_u8 *bytes, pl_u64 length)
{
    FILE *file = fopen(path, "wb");
    int ok;
    if (!file) return 0;
    ok = fwrite(bytes, 1u, (size_t)length, file) == (size_t)length;
    return fclose(file) == 0 && ok;
}

int main(int argc, char **argv)
{
    pl_u8 *input = NULL;
    pl_u8 *output = NULL;
    pl_u64 input_bytes = 0u;
    pl_u64 output_bytes = 0u;
    pl_u64 code_bytes = 0u;
    pl_u8 digest[PL_SHA256_BYTES];
    pl_elf_image elf;
    pl_u64 process_entry = 0u;
    int process_entry_present = 0;
    pl_x86_elf_emission emission;
    ox_proof proof = { 0 };
    ox_image opened;
    int status;
    if (argc != 3 || !read_file(argv[1], &input, &input_bytes)) return 2;
    status = pl_elf_open(input, input_bytes, &elf);
    if (!status)
        status = pl_elf_process_entry(
            &elf, &process_entry, &process_entry_present);
    for (pl_u32 index = 0u; !status && index < elf.program_count; ++index) {
        pl_elf_segment segment;
        status = pl_elf_program(&elf, index, &segment);
        if (!status && pl_elf_segment_is_executable(&segment)
                && !pl_checked_add_u64(code_bytes, segment.memory_bytes,
                                       &code_bytes))
            status = OX_ERROR_RANGE;
    }
    if (status || !code_bytes) { free(input); return 2; }
    pl_sha256_digest(input, input_bytes, digest);
    proof.proof_version = OX_PROOF_VERSION;
    proof.machine_abi = OX_MACHINE_ABI_VERSION;
    proof.flags = OX_PROOF_REQUIRED_FLAGS;
    for (pl_u32 index = 0u; index < 4u; ++index)
        proof.source_sha256[index] = pl_read_u64(digest + index * 8u);
    proof.source_bytes = input_bytes;
    proof.entry_function = process_entry_present
                         ? 0u : OX_PROOF_NO_ENTRY_FUNCTION;
    proof.function_count = 1u;
    proof.coordinate_count = code_bytes;
    proof.direct_count = code_bytes;
    proof.input_span = 2u;
    proof.output_span = 1u;
    proof.input_work = 2u;
    proof.output_work = 1u;
    proof.minimum_span = proof.output_span;
    proof.minimum_work = proof.output_work;
    proof.pareto_complete = 1u;
    proof.input_code_bytes = code_bytes;
    proof.output_code_bytes = code_bytes;
    ox_proof rejected = proof;
    rejected.minimum_span += 1u;
    if (!pl_x86_elf_measure(input, input_bytes, &rejected, &emission)) {
        free(input);
        return 2;
    }
    rejected = proof;
    rejected.pareto_complete = 0u;
    if (!pl_x86_elf_measure(input, input_bytes, &rejected, &emission)) {
        free(input);
        return 2;
    }
    rejected = proof;
    rejected.pareto_complete = 2u;
    rejected.minimum_span = 1u;
    rejected.output_span = 2u;
    if (pl_x86_elf_measure(input, input_bytes, &rejected, &emission)) {
        free(input);
        return 2;
    }
    rejected.minimum_span = 3u;
    if (!pl_x86_elf_measure(input, input_bytes, &rejected, &emission)) {
        free(input);
        return 2;
    }
    status = pl_x86_elf_measure(input, input_bytes, &proof, &emission);
    if (status || emission.output_bytes > (pl_u64)(size_t)-1) {
        free(input);
        return 2;
    }
    output = malloc((size_t)emission.output_bytes);
    if (!output) { free(input); return 2; }
    status = pl_x86_elf_write(input, input_bytes, &proof, output,
                              emission.output_bytes, &output_bytes);
    if (!status) status = ox_image_open(output, output_bytes, &opened);
    if (!status && (opened.length != output_bytes
            || opened.entry != elf.entry
            || opened.proof.source_bytes != input_bytes
            || opened.proof.entry_function != proof.entry_function
            || opened.proof.function_count != 1u
            || opened.proof.coordinate_count != code_bytes))
        status = OX_ERROR_PROOF;
    if (!status) {
        /* EI_PAD is otherwise ignored by the reader and the native loader.
         * Changing it isolates whole-file build-id verification from ordinary
         * ELF structural validation. */
        output[9u] ^= 1u;
        if (ox_image_open(output, output_bytes, &opened)
                != OX_ERROR_BUILD_ID)
            status = OX_ERROR_BUILD_ID;
        output[9u] ^= 1u;
    }
    if (!status && !write_file(argv[2], output, output_bytes)) status = 1;
    if (!status)
        printf("standard ELF proof: green (%llu -> %llu bytes)\n",
               (unsigned long long)input_bytes,
               (unsigned long long)output_bytes);
    free(output);
    free(input);
    return status ? 1 : 0;
}
