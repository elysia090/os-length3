#define _GNU_SOURCE
#include "../src/internal/select-x86.h"
#include "execute.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct { pl_u64 value, shifted, entry, flags; } observation;
typedef void (__attribute__((sysv_abi)) *leaf_function)(observation *, pl_u64, pl_u64);

static pl_u64 binary(pl_u64 a, pl_u64 b, pl_u32 mode, pl_u64 mask)
{
    switch (mode) {
    case 0u: return a & b;
    case 1u: return (a + b) & mask;
    case 3u: return (a - b) & mask;
    case 5u: return a | b;
    default: return a ^ b;
    }
}

static int check_case(pl_u32 bits, pl_u32 mode, pl_u32 group,
                      pl_u32 depth, pl_u32 keep_entry, pl_u64 *comparisons)
{
    pl_u8 source[192];
    pl_u32 length = 0u;
    if (keep_entry) {
        source[length++] = 0x49u; source[length++] = 0x89u;
        source[length++] = 0xd0u; /* mov r8,rdx: entry generation stays observable */
    }
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0xc1u; source[length++] = 0xeau; source[length++] = 2u;
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x09u; source[length++] = 0xd6u; /* or rsi,rdx */
    for (pl_u32 i = 0u; i < depth; ++i) {
        if (bits == 64u) source[length++] = 0x48u;
        source[length++] = 0x89u; source[length++] = 0xf2u; /* mov rdx,rsi */
        if (bits == 64u) source[length++] = 0x48u;
        source[length++] = 0xc1u;
        source[length++] = (pl_u8)(0xc2u | (group << 3u));
        source[length++] = (pl_u8)(2u << i);
        if (bits == 64u) source[length++] = 0x48u;
        source[length++] = mode == 0u ? 0x21u : mode == 1u ? 0x01u
                         : mode == 3u ? 0x29u : mode == 5u ? 0x09u : 0x31u;
        source[length++] = 0xd6u;
    }
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x83u; source[length++] = 0xc6u; source[length++] = 1u;
    static const pl_u8 observe[] = {
        0x48u, 0x89u, 0x37u, 0x48u, 0x89u, 0x57u, 8u,
        0x4cu, 0x89u, 0x47u, 16u, 0x9cu, 0x59u,
        0x48u, 0x89u, 0x4fu, 24u, 0xc3u,
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
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,
        address, address + length, (1u << PL_X86_LOCAL_COUNT) - 1u,
        &workspace, &block);
    if (!status && block.end != address + length) status = PL_ERROR_BLOCK;
    if (!status) status = pl_x86_select_candidates(
        &frontend, &selection_workspace, &block, &candidates);
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, &selected, &span, &work);
    if (status || selected.copied_source || !selected.normalized_family_present
            || work > 3u + 3u * depth + keep_entry) goto failed;
    status = pl_x86_select_write_measured(&frontend, &block, &selected,
        memory + 512u, 256u, &written);
    if (status || written != selected.output_bytes || selected.fixup_count) goto failed;
    memcpy(memory, source, length);
    memcpy(memory + length, observe, sizeof observe);
    memcpy(memory + 512u + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory; optimized.object = memory + 512u;
    static const pl_u64 edge[] = { 0u, 1u, 2u, 3u, 127u, 128u, 255u, 256u,
        65535u, 65536u, 0x7fffffffu, 0x80000000u, UINT32_MAX,
        1ull << 32u, 1ull << 63u, UINT64_MAX };
    pl_u64 random = 0x6a09e667f3bcc909ull, mask = UINT64_MAX >> (64u - bits);
    for (pl_u32 i = 0u; i < 4096u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 left = i < 256u ? edge[i % 16u] : random;
        pl_u64 right = i < 256u ? edge[i / 16u] : random * 17u;
        pl_u64 value = (left & mask) | ((right & mask) >> 2u), shifted = 0u;
        for (pl_u32 j = 0u; j < depth; ++j) {
            pl_u32 count = 2u << j;
            shifted = group == 4u ? (value << count) & mask : value >> count;
            if (group == 7u && (value & (1ull << (bits - 1u))))
                shifted |= mask ^ (mask >> count);
            value = binary(value, shifted, mode, mask);
        }
        pl_u64 expected = (value + 1u) & mask;
        pl_u32 parity = 0u;
        for (pl_u32 j = 0u; j < 8u; ++j) parity ^= (pl_u32)(expected >> j) & 1u;
        pl_u64 sign = 1ull << (bits - 1u);
        pl_u64 flags = (value == mask ? 1u : 0u) | (!parity ? 4u : 0u)
            | ((value ^ expected ^ 1u) & 16u) | (!expected ? 64u : 0u)
            | (expected & sign ? 128u : 0u)
            | ((~value & (value ^ expected) & sign) ? 2048u : 0u);
        observation before = { 0 }, after = { 0 };
        original.function(&before, left, right);
        optimized.function(&after, left, right);
        if (before.value != expected || after.value != expected
                || before.shifted != shifted || after.shifted != shifted
                || (keep_entry && (before.entry != right || after.entry != right))
                || (before.flags & 0x8d5u) != flags
                || (after.flags & 0x8d5u) != flags) {
            fprintf(stderr, "  input=%llx/%llx expected=%llx/%llx/%llx "
                "source=%llx/%llx/%llx output=%llx/%llx/%llx\n",
                (unsigned long long)left, (unsigned long long)right,
                (unsigned long long)expected, (unsigned long long)shifted,
                (unsigned long long)flags, (unsigned long long)before.value,
                (unsigned long long)before.shifted, (unsigned long long)before.flags,
                (unsigned long long)after.value, (unsigned long long)after.shifted,
                (unsigned long long)after.flags);
            goto failed;
        }
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    if (!status) fprintf(stderr, "  rejection=%x/%x projected=%llx stage=%x\n",
        candidates.diagnostic.blocking_work, candidates.diagnostic.blocking_opcode,
        (unsigned long long)candidates.diagnostic.projected_instruction_mask,
        candidates.diagnostic_stage);
    if (!status && !selected.normalized_family_present) {
        for (pl_u32 i = 0u; i < block.plan.local_count; ++i)
            fprintf(stderr, "  local %u = %u:%llu\n", i,
                block.plan.locals[i].kind, (unsigned long long)block.plan.locals[i].value);
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
    if (!status) for (pl_u32 i = 0u; i < candidates.count; ++i) {
        const pl_x86_native_selection *candidate = &candidates.candidate[i];
        fprintf(stderr, "  candidate %u work/span=%u/%u bytes=%u source=%u\n", i,
            candidate->output_instructions, candidate->output_span,
            candidate->output_bytes, candidate->copied_source);
        pl_u8 code[256]; pl_u32 count = 0u;
        if (!pl_x86_select_write_measured(&frontend, &block, candidate,
                                          code, sizeof code, &count)) {
            for (pl_u32 j = 0u; j < count; ++j) fprintf(stderr, "%02x ", code[j]);
            fputc('\n', stderr);
        }
    }
    fprintf(stderr, "shared expression: RED bits=%u mode=%u group=%u depth=%u "
        "entry=%u status=%d work/span=%u/%u source/normalized=%u/%u "
        "bytes=%u comparisons=%llu\n", bits, mode, group, depth, keep_entry,
        status, work, span, selected.copied_source, selected.normalized_family_present,
        written, (unsigned long long)*comparisons);
    test_code_release(memory, 4096u);
    return 0;
}

static int check_summary(pl_u32 bits, pl_u32 mode, pl_u32 alias, pl_u64 *comparisons)
{
    pl_u8 source[32];
    pl_u32 length = 0u;
    if (mode == 5u) {
        source[length++] = alias ? 0xb8u : 0xbau;
        source[length++] = 1u; source[length++] = 0u;
        source[length++] = 0u; source[length++] = 0u;
        if (!alias) {
            if (bits == 64u) source[length++] = 0x48u;
            source[length++] = 0x89u; source[length++] = 0xf0u;
        }
        if (bits == 64u) source[length++] = 0x48u;
        source[length++] = 0x85u; source[length++] = alias ? 0xf6u : 0xc0u;
        if (bits == 64u) source[length++] = 0x48u;
        source[length++] = 0x0fu; source[length++] = alias ? 0x45u : 0x44u;
        source[length++] = alias ? 0xc6u : 0xc2u;
        source[length++] = 0x31u; source[length++] = 0xd2u;
    } else {
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x89u; source[length++] = 0xf0u; /* mov rax,rsi */
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0xf7u; source[length++] = 0xd8u; /* neg rax */
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x0fu; source[length++] = 0x48u; source[length++] = 0xc6u;
    if (mode >= 2u) source[length++] = 0xf3u;
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x0fu;
    source[length++] = mode == 4u ? 0xb8u : mode == 1u || mode == 2u ? 0xbcu : 0xbdu;
    source[length++] = alias ? 0xc0u : 0xd0u;
    }
    static const pl_u8 observe[] = {
        0x48u, 0x89u, 0x07u, 0x48u, 0x89u, 0x57u, 8u,
        0x48u, 0x89u, 0x77u, 16u, 0x9cu, 0x59u,
        0x48u, 0x89u, 0x4fu, 24u, 0xc3u,
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
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,
        address, address + length, (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status && block.end != address + length) status = PL_ERROR_BLOCK;
    /* Require expression generation even where field ownership forbids
     * selecting a subsequence of source instructions. */
    if (!status) block.construction_fields = 1u;
    if (!status) status = pl_x86_select_candidates(&frontend, &selection_workspace,
                                                   &block, &candidates);
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, &selected, &span, &work);
    if (status || selected.copied_source || !selected.normalized_family_present
            || work > 4u) goto failed;
    status = pl_x86_select_write_measured(&frontend, &block, &selected,
        memory + 512u, 256u, &written);
    if (status || selected.fixup_count || written != selected.output_bytes) goto failed;
    memcpy(memory, source, length); memcpy(memory + length, observe, sizeof observe);
    memcpy(memory + 512u + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory; optimized.object = memory + 512u;
    pl_u64 mask = UINT64_MAX >> (64u - bits), random = 0x6a09e667f3bcc909ull;
    for (pl_u32 i = 0u; i < 4096u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 input = i < 64u ? 1ull << i : i == 64u ? 0u
                     : i < 129u ? (0u - (1ull << (i - 65u))) : random;
        if (mode == 5u) {
            pl_u64 expected = input & mask;
            if (!expected) expected = 1u;
            observation before = { 0 }, after = { 0 };
            original.function(&before, input, 0x123456789abcdef0ull);
            optimized.function(&after, input, 0x123456789abcdef0ull);
            if (before.value != expected || after.value != expected
                    || before.shifted || after.shifted
                    || before.entry != input || after.entry != input
                    || (before.flags & 0x8d5u) != 0x44u
                    || (after.flags & 0x8d5u) != 0x44u) goto failed;
            ++*comparisons;
            continue;
        }
        pl_u64 value = input & mask;
        if (value & (1ull << (bits - 1u))) value = (0u - value) & mask;
        pl_u64 result = 0u;
        if (mode == 0u) {
            for (pl_u32 bit = 0u; bit < bits; ++bit)
                if (value >> bit) result = bit;
        } else if (mode == 1u || mode == 2u) {
            while (result < bits && !((value >> result) & 1u)) ++result;
        } else if (mode == 3u) {
            while (result < bits && !((value >> (bits - 1u - result)) & 1u)) ++result;
        } else for (pl_u32 bit = 0u; bit < bits; ++bit) result += (value >> bit) & 1u;
        pl_u64 flag_mask = mode < 2u ? 64u : mode == 4u ? 0x8d5u : 65u;
        pl_u64 flags = mode < 2u || mode == 4u ? (!value ? 64u : 0u)
                     : (!value ? 1u : 0u) | (!result ? 64u : 0u);
        observation before = { 0 }, after = { 0 };
        original.function(&before, input, 0x123456789abcdef0ull);
        optimized.function(&after, input, 0x123456789abcdef0ull);
        /* BSR/BSF leave the destination undefined for a zero input. Only
         * their defined ZF is compared there; this is not a zero-result law. */
        int defined = mode >= 2u || value != 0u;
        if ((!alias && (before.value != value || after.value != value))
                || (alias && defined && (before.value != result || after.value != result))
                || (!alias && defined && (before.shifted != result || after.shifted != result))
                || (alias && (before.shifted != 0x123456789abcdef0ull
                            || after.shifted != 0x123456789abcdef0ull))
                || before.entry != input || after.entry != input
                || (before.flags & flag_mask) != flags || (after.flags & flag_mask) != flags)
            goto failed;
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "bit summary: RED bits=%u mode=%u alias=%u status=%d "
        "work/span=%u/%u source/normalized=%u/%u comparisons=%llu\n",
        bits, mode, alias, status, work, span, selected.copied_source,
        selected.normalized_family_present, (unsigned long long)*comparisons);
    test_code_release(memory, 4096u);
    return 0;
}

static int check_scaled(pl_u32 shift_bits, pl_u32 bits, pl_u32 count,
                         pl_i64 factor, pl_u64 *comparisons)
{
    pl_u8 source[32];
    pl_u32 length = 0u;
    if (shift_bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x89u; source[length++] = 0xf0u;
    if (shift_bits == 64u) source[length++] = 0x48u;
    source[length++] = 0xc1u; source[length++] = 0xe8u; source[length++] = (pl_u8)count;
    if (bits == 64u) source[length++] = 0x48u;
    pl_u32 narrow = factor >= -128 && factor <= 127;
    source[length++] = narrow ? 0x6bu : 0x69u;
    source[length++] = 0xc0u;
    for (pl_u32 i = 0u; i < (narrow ? 1u : 4u); ++i)
        source[length++] = (pl_u8)((pl_u64)factor >> (8u * i));
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x01u; source[length++] = 0xc2u;
    static const pl_u8 observe[] = {
        0x48u, 0x89u, 0x07u, 0x48u, 0x89u, 0x57u, 8u,
        0x48u, 0x89u, 0x77u, 16u, 0x9cu, 0x59u,
        0x48u, 0x89u, 0x4fu, 24u, 0xc3u,
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
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,
        address, address + length, (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status && block.end != address + length) status = PL_ERROR_BLOCK;
    if (!status) block.construction_fields = 1u;
    if (!status) status = pl_x86_select_candidates(&frontend, &selection_workspace,
                                                   &block, &candidates);
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, &selected, &span, &work);
    pl_u32 work_limit = !(count & (shift_bits - 1u)) && (shift_bits == 64u || bits == 32u)
                      ? 2u : 4u;
    if (status || selected.copied_source || !selected.normalized_family_present
            || work > work_limit) goto failed;
    status = pl_x86_select_write_measured(&frontend, &block, &selected,
        memory + 512u, 256u, &written);
    if (status || selected.fixup_count || written != selected.output_bytes) goto failed;
    memcpy(memory, source, length); memcpy(memory + length, observe, sizeof observe);
    memcpy(memory + 512u + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory; optimized.object = memory + 512u;
    static const pl_u64 edge[] = { 0u, 1u, 2u, 3u, 127u, 128u, 255u, 256u,
        65535u, 65536u, 0x7fffffffu, 0x80000000u, UINT32_MAX,
        1ull << 32u, 1ull << 63u, UINT64_MAX };
    pl_u64 mask = UINT64_MAX >> (64u - bits), random = 0x6a09e667f3bcc909ull;
    pl_u64 source_mask = UINT64_MAX >> (64u - shift_bits);
    for (pl_u32 i = 0u; i < 1024u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 input = i < 256u ? edge[i % 16u] : random;
        pl_u64 addend = i < 256u ? edge[i / 16u] : random * 17u;
        pl_u64 product = (((input & source_mask) >> (count & (shift_bits - 1u)))
            * (pl_u64)factor) & mask;
        pl_u64 left = addend & mask, sum = (left + product) & mask;
        pl_u32 parity = 0u;
        for (pl_u32 bit = 0u; bit < 8u; ++bit) parity ^= (pl_u32)(sum >> bit) & 1u;
        pl_u64 sign = 1ull << (bits - 1u);
        pl_u64 flags = (sum < left ? 1u : 0u) | (!parity ? 4u : 0u)
            | ((left ^ product ^ sum) & 16u) | (!sum ? 64u : 0u)
            | (sum & sign ? 128u : 0u)
            | ((~(left ^ product) & (left ^ sum) & sign) ? 2048u : 0u);
        observation before = { 0 }, after = { 0 };
        original.function(&before, input, addend);
        optimized.function(&after, input, addend);
        if (before.value != product || after.value != product
                || before.shifted != sum || after.shifted != sum
                || before.entry != input || after.entry != input
                || (before.flags & 0x8d5u) != flags || (after.flags & 0x8d5u) != flags)
            goto failed;
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "scaled word: RED shift=%u bits=%u count=%u factor=%lld status=%d "
        "work/span=%u/%u source/normalized=%u/%u comparisons=%llu\n",
        shift_bits, bits, count, (long long)factor, status, work, span,
        selected.copied_source, selected.normalized_family_present,
        (unsigned long long)*comparisons);
    test_code_release(memory, 4096u);
    return 0;
}

static int check_conditional_bit_join(pl_u64 *comparisons)
{
    static const pl_u8 source[] = {
        0x89u, 0xf0u, 0x25u, 0xc3u, 0xffu, 0x77u, 0u,
        0x48u, 0x89u, 0xc2u, 0x80u, 0xceu, 0x10u,
        0x81u, 0xe6u, 0u, 0u, 0x10u, 0u, 0x48u, 0x0fu, 0x45u, 0xc2u,
        0x89u, 0xcau, 0x83u, 0xcau, 2u, 0xf6u, 0xc4u, 2u, 0x48u, 0x89u, 0xc6u,
    };
    static const pl_u8 prefix[] = { 0x48u, 0x89u, 0xd1u };
    static const pl_u8 observe[] = {
        0x48u, 0x89u, 0x07u, 0x48u, 0x89u, 0x57u, 8u,
        0x48u, 0x89u, 0x77u, 16u, 0x9cu, 0x59u,
        0x48u, 0x89u, 0x4fu, 24u, 0xc3u,
    };
    pl_u8 *memory = test_code_allocate(4096u);
    if (!memory) return 0;
    pl_u64 address = (pl_u64)(uintptr_t)(memory + sizeof prefix);
    pl_x86_map map = { source, address, sizeof source, sizeof source,
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
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,
        address, address + sizeof source, (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status && block.end != address + sizeof source) status = PL_ERROR_BLOCK;
    if (!status) block.construction_fields = 1u;
    if (!status) status = pl_x86_select_candidates(&frontend, &selection_workspace, &block, &candidates);
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, &selected, &span, &work);
    if (status || selected.copied_source || !selected.normalized_family_present
            || work > 9u || span > 4u) goto failed;
    status = pl_x86_select_write_measured(&frontend, &block, &selected,
        memory + 512u + sizeof prefix, 256u, &written);
    if (status || selected.fixup_count || written != selected.output_bytes) goto failed;
    memcpy(memory, prefix, sizeof prefix); memcpy(memory + sizeof prefix, source, sizeof source);
    memcpy(memory + sizeof prefix + sizeof source, observe, sizeof observe);
    memcpy(memory + 512u, prefix, sizeof prefix);
    memcpy(memory + 512u + sizeof prefix + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory; optimized.object = memory + 512u;
    pl_u64 random = 0x243f6a8885a308d3ull;
    for (pl_u32 i = 0u; i < 4096u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 input = i < 128u ? (i < 64u ? 1ull << i : ~(1ull << (i - 64u))) : random;
        pl_u64 side = random * 17u;
        pl_u64 value = (input & 0x77ffc3u) | ((input & 0x100000u) ? 0x1000u : 0u);
        pl_u64 flags = value & 0x200u ? 0u : 0x44u;
        observation before = { 0 }, after = { 0 };
        original.function(&before, input, side); optimized.function(&after, input, side);
        if (before.value != value || after.value != value
                || before.entry != value || after.entry != value
                || before.shifted != ((side & UINT32_MAX) | 2u)
                || after.shifted != ((side & UINT32_MAX) | 2u)
                || (before.flags & 0x8c5u) != flags || (after.flags & 0x8c5u) != flags) goto failed;
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "conditional bit join: RED status=%d work/span=%u/%u comparisons=%llu\n",
        status, work, span, (unsigned long long)*comparisons);
    test_code_release(memory, 4096u);
    return 0;
}

static int check_bit_projection(pl_u32 bits, pl_u32 from, pl_u32 to,
                                  pl_u32 inverse, pl_u64 *comparisons, pl_u32 *frontiers)
{
    pl_u64 input_mask = 1ull << from, output_mask = 1ull << to;
    pl_u8 source[32];
    pl_u32 length = 0u;
    source[length++] = 0x49u; source[length++] = 0xb9u; /* movabs r9,input bit */
    for (pl_u32 i = 0u; i < 8u; ++i) source[length++] = (pl_u8)(input_mask >> (8u * i));
    source[length++] = 0x31u; source[length++] = 0xc0u;
    source[length++] = 0x49u; source[length++] = 0xb8u; /* movabs r8,output bit */
    for (pl_u32 i = 0u; i < 8u; ++i) source[length++] = (pl_u8)(output_mask >> (8u * i));
    if (bits == 16u) source[length++] = 0x66u;
    source[length++] = bits == 64u ? 0x4cu : 0x44u;
    source[length++] = bits == 8u ? 0x84u : 0x85u;
    source[length++] = 0xceu; /* TEST reads the selected low lane. */
    source[length++] = 0x49u; source[length++] = 0x0fu;
    source[length++] = inverse ? 0x44u : 0x45u; source[length++] = 0xc0u;
    source[length++] = 0x31u; source[length++] = 0xd2u; /* independent final flags */
    static const pl_u8 observe[] = {
        0x48u, 0x89u, 0x07u, 0x4cu, 0x89u, 0x47u, 8u,
        0x4cu, 0x89u, 0x4fu, 16u, 0x9cu, 0x59u,
        0x48u, 0x89u, 0x4fu, 24u, 0xc3u,
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
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,
        address, address + length, (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status && block.end != address + length) status = PL_ERROR_BLOCK;
    if (!status) block.construction_fields = 1u;
    for (pl_u32 n = 0u; !status && n < block.plan.node_count; ++n)
        if (block.plan.nodes[n].opcode == PL_OPCODE_LANE32_SELECT
                || block.plan.nodes[n].opcode == PL_OPCODE_LANE64_SELECT)
            status = PL_ERROR_BLOCK;
    if (!status) status = pl_x86_select_candidates(&frontend, &selection_workspace, &block, &candidates);
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, &selected, &span, &work);
    if (status && status != PL_ERROR_X86_PARETO) goto failed;
    /* Execute the normalized spelling even when the linked-source spelling
     * wins. Keep that optimization gap red, but finish the whole semantic
     * matrix so a cost failure cannot hide a later wrong-result case. */
    pl_u32 generated = candidates.count;
    for (pl_u32 i = 0u; i < candidates.count; ++i) {
        const pl_x86_native_selection *candidate = &candidates.candidate[i];
        if (candidate->copied_source || !candidate->normalized_family_present) continue;
        if (generated == candidates.count
                || candidate->output_work < candidates.candidate[generated].output_work
                || (candidate->output_work == candidates.candidate[generated].output_work
                    && candidate->output_span < candidates.candidate[generated].output_span)) generated = i;
    }
    if (generated == candidates.count) goto failed;
    selected = candidates.candidate[generated];
    if (status || selected.output_work > work || selected.output_span > span
            || selected.output_work > 6u) {
        if (!*frontiers) fprintf(stderr, "bit projection: first optimization RED "
            "bits=%u from/to=%u/%u inverse=%u generated work/span=%u/%u minima=%u/%u\n",
            bits, from, to, inverse, selected.output_work, selected.output_span, work, span);
        ++*frontiers;
    }
    status = 0;
    status = pl_x86_select_write_measured(&frontend, &block, &selected,
        memory + 512u, 256u, &written);
    if (status || selected.fixup_count || written != selected.output_bytes) goto failed;
    memcpy(memory, source, length); memcpy(memory + length, observe, sizeof observe);
    memcpy(memory + 512u + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory; optimized.object = memory + 512u;
    pl_u64 random = 0x243f6a8885a308d3ull;
    for (pl_u32 i = 0u; i < 256u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 input = i < 128u ? (i < 64u ? 1ull << i : ~(1ull << (i - 64u))) : random;
        pl_u64 value = (!!(input & input_mask) != inverse) ? output_mask : 0u;
        observation before = { 0 }, after = { 0 };
        original.function(&before, input, 0u); optimized.function(&after, input, 0u);
        if (before.value != value || after.value != value
                || before.shifted != output_mask || after.shifted != output_mask
                || before.entry != input_mask || after.entry != input_mask
                || (before.flags & 0x8c5u) != 0x44u || (after.flags & 0x8c5u) != 0x44u) goto failed;
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "bit projection: RED bits=%u from/to=%u/%u inverse=%u status=%d "
        "work/span=%u/%u source/normalized=%u/%u comparisons=%llu\n", bits, from, to, inverse, status,
        work, span, selected.copied_source, selected.normalized_family_present, (unsigned long long)*comparisons);
    for (pl_u32 i = 0u; !status && i < candidates.count; ++i)
        fprintf(stderr, " candidate %u work/span/bytes=%u/%u/%u source=%u\n", i,
            candidates.candidate[i].output_work, candidates.candidate[i].output_span,
            candidates.candidate[i].output_bytes, candidates.candidate[i].copied_source);
    test_code_release(memory, 4096u);
    return 0;
}

int main(void)
{
    static const pl_u32 mode[] = { 0u, 1u, 3u, 5u, 6u };
    static const pl_u32 group[] = { 4u, 5u, 7u };
    pl_u64 comparisons = 0u;
    for (pl_u32 bits = 32u; bits <= 64u; bits += 32u)
        for (pl_u32 m = 0u; m < 5u; ++m)
            for (pl_u32 g = 0u; g < 3u; ++g)
                for (pl_u32 depth = 1u; depth <= 4u; ++depth)
                    for (pl_u32 keep = 0u; keep < 2u; ++keep)
                        if (!check_case(bits, mode[m], group[g], depth, keep,
                                        &comparisons)) return 1;
    for (pl_u32 bits = 32u; bits <= 64u; bits += 32u)
        for (pl_u32 operation = 0u; operation < 6u; ++operation) {
            if ((operation == 2u && !__builtin_cpu_supports("bmi"))
                    || (operation == 3u && !__builtin_cpu_supports("lzcnt"))
                    || (operation == 4u && !__builtin_cpu_supports("popcnt"))) {
                printf("bit summary: execution skipped for unavailable CPU operation %u\n", operation);
                continue;
            }
            for (pl_u32 alias = 0u; alias < 2u; ++alias)
                if (!check_summary(bits, operation, alias, &comparisons)) return 1;
        }
    static const pl_i64 factors[] = { 0, 1, -1, 2, 3, 5, 112, 127, 128, -128,
                                      -129, 255, 2147483647LL, -2147483648LL };
    static const pl_u32 counts[] = { 0u, 1u, 5u, 31u, 32u, 63u };
    for (pl_u32 shift_bits = 32u; shift_bits <= 64u; shift_bits += 32u)
        for (pl_u32 bits = 32u; bits <= 64u; bits += 32u)
            for (pl_u32 i = 0u; i < sizeof factors / sizeof factors[0]; ++i)
                for (pl_u32 j = 0u; j < sizeof counts / sizeof counts[0]; ++j)
                    if (!check_scaled(shift_bits, bits, counts[j], factors[i], &comparisons)) return 1;
    static const pl_u32 positions[] = { 0u, 7u, 8u, 12u, 20u, 31u, 32u, 63u };
    if (!check_conditional_bit_join(&comparisons)) return 1;
    pl_u32 projection_frontiers = 0u;
    for (pl_u32 bits = 8u; bits <= 64u; bits *= 2u)
        for (pl_u32 from = 0u; from < sizeof positions / sizeof positions[0]; ++from)
            for (pl_u32 to = 0u; positions[from] < bits && to < sizeof positions / sizeof positions[0]; ++to)
                for (pl_u32 inverse = 0u; inverse < 2u; ++inverse)
                    if (!check_bit_projection(bits, positions[from], positions[to], inverse,
                            &comparisons, &projection_frontiers)) return 1;
    if (projection_frontiers) {
        fprintf(stderr, "shared expression: semantics green (%llu comparisons), "
            "optimization RED (%u bit-projection frontiers)\n",
            (unsigned long long)comparisons, projection_frontiers);
        return 1;
    }
    printf("shared expression: green (%llu source/generated/reference comparisons; "
        "32/64-bit shared shifts/products, bit summaries, nonzero guards, flags and entry lifetimes)\n",
        (unsigned long long)comparisons);
    return 0;
}
