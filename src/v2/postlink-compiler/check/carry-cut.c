#define _GNU_SOURCE
#include "../src/internal/select-x86.h"
#include "execute.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct { pl_u64 value, zero, flags; } observation;
typedef void (__attribute__((sysv_abi)) *leaf_function)(
    observation *, pl_u64, pl_u64, pl_u64);

static int check_case(pl_u32 bits, pl_u32 compare_bits, pl_u32 subtract,
                      pl_u32 inverse, pl_u64 *comparisons)
{
    pl_u8 source[32] = { 0x48u, 0x89u, 0xc8u }; /* mov rax,rcx */
    pl_u32 length = 3u;
    if (compare_bits == 16u) source[length++] = 0x66u;
    if (compare_bits == 64u) source[length++] = 0x48u;
    if (compare_bits == 8u) source[length++] = 0x40u; /* SIL, not DH */
    source[length++] = compare_bits == 8u ? 0x38u : 0x39u;
    source[length++] = 0xd6u; /* cmp rsi,rdx */
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x83u;
    source[length++] = subtract == inverse ? 0xd0u : 0xd8u; /* adc/sbb rax */
    source[length++] = inverse ? 0xffu : 0u;
    source[length++] = 0x45u;
    source[length++] = 0x31u;
    source[length++] = 0xc0u; /* xor r8d,r8d publishes independent final flags */
    static const pl_u8 observe[] = {
        0x48u, 0x89u, 0x07u,
        0x4cu, 0x89u, 0x47u, 8u,
        0x9cu, 0x59u,
        0x48u, 0x89u, 0x4fu, 16u, 0xc3u,
    };
    pl_u8 *memory = test_code_allocate(4096u);
    if (!memory) return 0;
    pl_u64 address = (pl_u64)(uintptr_t)memory;
    pl_x86_map map = { source, address, length, length,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u };
    pl_x86_image image = { &map, 1u, 0u, address };
    pl_x86_frontend frontend;
    static pl_u8 first[1024u * 1024u], second[1024u * 1024u];
    static pl_u8 select_first[1024u * 1024u], select_second[1024u * 1024u];
    pl_x86_block_workspace workspace = { first, second, sizeof first, 64u };
    pl_x86_block_workspace selection_workspace = {
        select_first, select_second, sizeof select_first, 64u };
    pl_x86_block block;
    pl_x86_native_candidates candidates;
    pl_x86_native_selection selected = { 0 };
    pl_u32 span = 0u, work = 0u, written = 0u;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(
        &frontend, address, address + length,
        (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status) status = pl_x86_select_candidates(
        &frontend, &selection_workspace, &block, &candidates);
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, &selected, &span, &work);
    if (status || !selected.normalized_family_present || selected.copied_source
            || work > 4u) goto failed;
    status = pl_x86_select_write_measured(
        &frontend, &block, &selected, memory + 512u, 256u, &written);
    if (status || written != selected.output_bytes || selected.fixup_count) goto failed;
    memcpy(memory, source, length);
    memcpy(memory + length, observe, sizeof observe);
    memcpy(memory + 512u + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory;
    optimized.object = memory + 512u;
    static const pl_u64 boundary[] = {
        0u, 1u, 127u, 128u, 255u, 256u, 32767u, 32768u, 65535u,
        65536u, 0x7fffffffu, 0x80000000u, UINT32_MAX,
        1ull << 32u, 1ull << 63u, UINT64_MAX };
    pl_u64 random = 0x6a09e667f3bcc909ull;
    for (pl_u32 i = 0u; i < 4096u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 left = i < 256u ? boundary[i % 16u] : random;
        pl_u64 right = i < 256u ? boundary[i / 16u] : ~random;
        pl_u64 accumulator = i < 256u ? boundary[(i + 5u) % 16u] : random * 17u;
        pl_u64 mask = UINT64_MAX >> (64u - compare_bits);
        pl_u64 carry = (pl_u64)((left & mask) < (right & mask)) ^ inverse;
        pl_u64 expected = subtract ? accumulator - carry : accumulator + carry;
        if (bits == 32u) expected &= UINT32_MAX;
        observation before = { 0 }, after = { 0 };
        original.function(&before, left, right, accumulator);
        optimized.function(&after, left, right, accumulator);
        if (before.value != expected || after.value != expected
                || before.zero || after.zero
                || (before.flags & 0x8c5u) != 0x44u
                || (after.flags & 0x8c5u) != 0x44u) {
            fprintf(stderr, "  input=%llx/%llx accumulator=%llx expected=%llx "
                    "source=%llx flags=%llx output=%llx flags=%llx\n",
                    (unsigned long long)left, (unsigned long long)right,
                    (unsigned long long)accumulator, (unsigned long long)expected,
                    (unsigned long long)before.value, (unsigned long long)before.flags,
                    (unsigned long long)after.value, (unsigned long long)after.flags);
            for (pl_u32 j = 0u; j < written; ++j) fprintf(stderr, "%02x ", memory[512u + j]);
            fputc('\n', stderr);
            goto failed;
        }
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    if (!status && !selected.normalized_family_present) {
        fprintf(stderr, "  rejection=%x/%x projected=%llx stage=%x\n",
                candidates.diagnostic.blocking_work, candidates.diagnostic.blocking_opcode,
                (unsigned long long)candidates.diagnostic.projected_instruction_mask,
                candidates.diagnostic_stage);
        for (pl_u32 i = 0u; i < block.plan.node_count; ++i) {
            const pl_node *node = &block.plan.nodes[i];
            fprintf(stderr, "  node %u opcode=%u", i + 1u, node->opcode);
            for (pl_u32 j = 0u; j < node->argument_count; ++j) {
                pl_operand operand = block.plan.arguments[node->argument_at + j];
                fprintf(stderr, " %u:%llu", operand.kind, (unsigned long long)operand.value);
            }
            fputc('\n', stderr);
        }
    }
    fprintf(stderr, "carry cut: RED bits=%u compare=%u subtract=%u inverse=%u "
            "status=%d work/span=%u/%u source/normalized=%u/%u bytes=%u comparisons=%llu\n",
            bits, compare_bits, subtract, inverse, status, work, span,
            selected.copied_source, selected.normalized_family_present, written,
            (unsigned long long)*comparisons);
    test_code_release(memory, 4096u);
    return 0;
}

int main(void)
{
    pl_u64 comparisons = 0u;
    for (pl_u32 bits = 32u; bits <= 64u; bits *= 2u)
        for (pl_u32 compare = 8u; compare <= 64u; compare *= 2u)
            for (pl_u32 subtract = 0u; subtract < 2u; ++subtract)
                for (pl_u32 inverse = 0u; inverse < 2u; ++inverse)
                    if (!check_case(bits, compare, subtract, inverse, &comparisons)) return 1;
    printf("carry cut: green (%llu source/generated/reference comparisons; "
           "add/subtract CF and !CF, mixed widths, independent final flags)\n",
           (unsigned long long)comparisons);
    return 0;
}
