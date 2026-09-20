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

/* A wide literal is a produced register value when it cannot be encoded as
 * an x86 immediate. Every candidate must read that generation, not the entry
 * contents of its eventual owner. Exercise candidates before choosing costs:
 * a stale owner can otherwise masquerade as a shorter dependency path. */
static int check_mask_publication(pl_u64 mask, pl_u64 *comparisons)
{
    typedef struct { pl_u64 joined, low, mask, copied, flags; } mask_observation;
    typedef void (__attribute__((sysv_abi)) *mask_function)(
        mask_observation *, pl_u64, pl_u64, pl_u64);
    pl_u8 source[] = {
        0x4cu, 0x89u, 0xc2u,             /* mov rdx,r8 */
        0x48u, 0xb9u, 0,0,0,0,0,0,0,0, /* movabs rcx,mask */
        0x49u, 0x21u, 0xcau,             /* and r10,rcx */
        0x49u, 0x09u, 0xc2u,             /* or r10,rax */
        0x44u, 0x89u, 0xd6u,             /* mov esi,r10d */
    };
    for (pl_u32 i = 0u; i < 8u; ++i) source[5u + i] = (pl_u8)(mask >> (8u * i));
    static const pl_u8 setup[] = {
        0x49u, 0x89u, 0xf2u, /* r10 = base */
        0x48u, 0x89u, 0xd0u, /* rax = side */
        0x49u, 0x89u, 0xf0u, /* r8 = independent copy */
    };
    static const pl_u8 observe[] = {
        0x4cu,0x89u,0x17u, 0x48u,0x89u,0x77u,8u,
        0x48u,0x89u,0x4fu,16u, 0x48u,0x89u,0x57u,24u,
        0x9cu,0x58u, 0x48u,0x89u,0x47u,32u, 0xc3u,
    };
    pl_u8 *memory = test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address = (pl_u64)(uintptr_t)(memory + sizeof setup);
    pl_x86_map map = {source, address, sizeof source, sizeof source, 5u, 1u};
    pl_x86_image image = {&map, 1u, 0u, address};
    pl_x86_frontend frontend;
    static pl_u8 first[1048576], second[1048576], a[1048576], b[1048576];
    pl_x86_block_workspace workspace = {first, second, sizeof first, 64u};
    pl_x86_block_workspace scratch = {a, b, sizeof a, 64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates = {0};
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,
        address, address + sizeof source, (1u << PL_X86_LOCAL_COUNT) - 1u,
        &workspace, &block);
    if (!status) status = pl_x86_select_candidates(&frontend, &scratch, &block, &candidates);
    if (status || candidates.count < 2u) goto failed;
    memcpy(memory, setup, sizeof setup);
    memcpy(memory + sizeof setup, source, sizeof source);
    memcpy(memory + sizeof setup + sizeof source, observe, sizeof observe);
    for (pl_u32 i = 0u; i < candidates.count; ++i) {
        pl_u8 *body = memory + (i + 1u) * 512u;
        pl_u32 written = 0u;
        memcpy(body, setup, sizeof setup);
        status = pl_x86_select_write_measured(&frontend, &block, &candidates.candidate[i],
            body + sizeof setup, 256u, &written);
        if (status || candidates.candidate[i].fixup_count) goto failed;
        memcpy(body + sizeof setup + written, observe, sizeof observe);
    }
    if (!test_code_publish(memory, 16384u)) goto failed;
    pl_u64 random = 0xb13c4567aa55aa55ull;
    for (pl_u32 sample = 0u; sample < 2048u; ++sample) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 base = sample < 128u ? 1ull << (sample & 63u) : random;
        pl_u64 side = sample < 64u ? 0u : sample < 128u ? UINT64_MAX : random * 17u;
        pl_u64 entry_owner = sample & 1u ? ~mask : 0u;
        pl_u64 joined = (base & mask) | side;
        pl_u32 parity = 0u;
        for (pl_u32 bit = 0u; bit < 8u; ++bit) parity ^= (pl_u32)(joined >> bit) & 1u;
        pl_u64 flags = (!parity ? 4u : 0u) | (!joined ? 64u : 0u)
                     | ((joined >> 63u) ? 128u : 0u);
        for (pl_u32 i = 0u; i <= candidates.count; ++i) {
            union { void *object; mask_function function; } fn;
            fn.object = memory + i * 512u;
            mask_observation actual = {0};
            fn.function(&actual, base, side, entry_owner);
            if (actual.joined != joined || actual.low != (pl_u32)joined
                    || actual.mask != mask || actual.copied != base
                    || (actual.flags & 0x8c5u) != flags) {
                fprintf(stderr, "mask publication: RED candidate=%u mask=%llx base=%llx "
                    "side=%llx entry-owner=%llx joined=%llx expected=%llx\n", i,
                    (unsigned long long)mask, (unsigned long long)base,
                    (unsigned long long)side, (unsigned long long)entry_owner,
                    (unsigned long long)actual.joined, (unsigned long long)joined);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span = 0u, work = 0u;
    status = pl_x86_candidates_select_joint_minimum(&candidates, 0u, 0u,
        &selected, &span, &work);
    if (status || span > 3u || work > 5u || selected.copied_source
            || !selected.normalized_family_present) goto failed;
    test_code_release(memory, 16384u);
    return 1;
failed:
    fprintf(stderr, "mask publication: status=%d\n", status);
    test_code_release(memory, 16384u);
    return 0;
}

static int check_narrow_shift_publication(pl_u32 bits, pl_u32 count,
                                          pl_u32 mask, pl_u32 left,
                                          pl_u64 *comparisons)
{
    pl_u8 source[32] = {0x81u, 0xe6u}; /* and esi,mask; mov eax,esi */
    for (pl_u32 i = 0u; i < 4u; ++i) source[2u + i] = (pl_u8)(mask >> (8u * i));
    pl_u32 length = 6u;
    source[length++] = 0x89u; source[length++] = 0xf0u;
    if (bits == 16u) source[length++] = 0x66u;
    source[length++] = bits == 8u ? 0xc0u : 0xc1u;
    source[length++] = left ? 0xe0u : 0xe8u; source[length++] = (pl_u8)count;
    source[length++] = 0x25u; /* and eax,0x80010001 */
    for (pl_u32 i = 0u; i < 4u; ++i) source[length++] = (pl_u8)(0x80010001u >> (8u * i));
    static const pl_u8 observe[] = {
        0x48u,0x89u,0x07u, 0x48u,0x89u,0x77u,8u,
        0x9cu,0x58u, 0x48u,0x89u,0x47u,24u, 0xc3u,
    };
    pl_u8 *memory = test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address = (pl_u64)(uintptr_t)memory;
    pl_x86_map map = {source, address, length, length, 5u, 1u};
    pl_x86_image image = {&map, 1u, 0u, address};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576], b[1048576], c[1048576], d[1048576];
    pl_x86_block_workspace workspace = {a,b,sizeof a,64u}, scratch = {c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates = {0};
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(&frontend, address,
        address + length, (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status) status = pl_x86_select_candidates(&frontend, &scratch, &block, &candidates);
    if (status || candidates.count < 2u) goto failed;
    memcpy(memory, source, length);
    memcpy(memory + length, observe, sizeof observe);
    for (pl_u32 i = 0u; i < candidates.count; ++i) {
        pl_u8 *body = memory + (i + 1u) * 512u;
        pl_u32 written = 0u;
        status = pl_x86_select_write_measured(&frontend, &block, &candidates.candidate[i],
            body, 256u, &written);
        if (status || candidates.candidate[i].fixup_count) goto failed;
        memcpy(body + written, observe, sizeof observe);
    }
    if (!test_code_publish(memory, 16384u)) goto failed;
    pl_u64 random = 0x1234beef7890aaaaull;
    pl_u32 lane_mask = (1u << bits) - 1u;
    for (pl_u32 sample = 0u; sample < 1024u; ++sample) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 input = sample < 64u ? 1ull << sample : random;
        pl_u32 base = (pl_u32)input & mask;
        pl_u32 shifted = left ? ((base & lane_mask) << (count & 31u)) & lane_mask
                              : (base & lane_mask) >> (count & 31u);
        pl_u32 value = ((base & ~lane_mask) | shifted) & 0x80010001u;
        pl_u64 flags = (!(value & 1u) ? 4u : 0u) | (!value ? 64u : 0u)
                     | (value >> 31u ? 128u : 0u);
        for (pl_u32 i = 0u; i <= candidates.count; ++i) {
            union { void *object; leaf_function function; } fn;
            fn.object = memory + i * 512u;
            observation actual = {0};
            fn.function(&actual, input, 0u);
            if (actual.value != value || actual.shifted != base
                    || (actual.flags & 0x8c5u) != flags) {
                fprintf(stderr, "narrow shift: mismatch candidate=%u input=%llx "
                    "value=%llx expected=%x\n", i, (unsigned long long)input,
                    (unsigned long long)actual.value, value);
                goto failed;
            }
            ++*comparisons;
        }
    }
    test_code_release(memory, 16384u);
    return 1;
failed:
    fprintf(stderr, "narrow shift: RED bits/count/mask/left=%u/%u/%x/%u status=%d\n",
        bits, count, mask, left, status);
    test_code_release(memory, 16384u);
    return 0;
}

/* A signed lane used inside a shifted expression has a direct MOVSX spelling.
 * Keep both products and the original low word observable so that eliminating
 * an output or reusing the wrong register generation cannot improve the cost. */
static int check_signed_seed(pl_u32 bits, pl_u32 count, pl_u32 live_flags,
                              pl_u64 *comparisons)
{
    typedef struct { pl_u64 shifted, low, difference_product, product, flags; } signed_observation;
    __extension__ typedef __int128 signed_wide;
    typedef void (__attribute__((sysv_abi)) *signed_function)(
        signed_observation *, pl_u64, pl_u64, pl_u64, pl_u64);
    pl_u8 source[32];
    pl_u32 length = 0u;
    source[length++] = 0x48u;
    if (bits == 32u) source[length++] = 0x63u;
    else {
        source[length++] = 0x0fu;
        source[length++] = bits == 8u ? 0xbeu : 0xbfu;
    }
    source[length++] = 0xc3u; /* movsx rax,bl/bx/ebx */
    const pl_u8 tail[] = {
        0x48u,0x29u,0xfeu,              /* sub rsi,rdi */
        0x48u,0xc1u,0xe0u,(pl_u8)count, /* shl rax,count */
        0x89u,0xd9u,                    /* mov ecx,ebx */
        0x4du,0x89u,0xc2u,              /* mov r10,r8 */
        0x49u,0x0fu,0xafu,0xf0u,        /* imul rsi,r8 */
        0x4cu,0x0fu,0xafu,0xd7u,        /* imul r10,rdi */
    };
    memcpy(source + length, tail, sizeof tail);
    length += sizeof tail;
    static const pl_u8 setup[] = {
        0x53u, 0x49u,0x89u,0xfbu, /* preserve rbx; r11 = observation */
        0x48u,0x89u,0xf3u, 0x48u,0x89u,0xd6u, 0x48u,0x89u,0xcfu,
    };
    static const pl_u8 observe[] = {
        0x49u,0x89u,0x03u, 0x49u,0x89u,0x4bu,8u,
        0x49u,0x89u,0x73u,16u, 0x4du,0x89u,0x53u,24u,
        0x9cu,0x58u, 0x49u,0x89u,0x43u,32u, 0x5bu,0xc3u,
    };
    pl_u8 *memory = test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address = (pl_u64)(uintptr_t)(memory + sizeof setup);
    pl_x86_map map = {source,address,length,length,5u,1u};
    pl_x86_image image = {&map,1u,0u,address};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576], b[1048576], c[1048576], d[1048576];
    pl_x86_block_workspace workspace = {a,b,sizeof a,64u}, scratch = {c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates = {0};
    pl_u32 live = (1u << PL_X86_GPR_COUNT) - 1u;
    if (live_flags) live |= 1u << PL_X86_RFLAGS_LOCAL;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,
        address, address + length, live, &workspace, &block);
    if (!status) status = pl_x86_select_candidates(&frontend, &scratch, &block, &candidates);
    if (status || candidates.count < 2u) goto failed;
    memcpy(memory, setup, sizeof setup);
    memcpy(memory + sizeof setup, source, length);
    memcpy(memory + sizeof setup + length, observe, sizeof observe);
    for (pl_u32 i = 0u; i < candidates.count; ++i) {
        pl_u8 *body = memory + (i + 1u) * 512u;
        pl_u32 written = 0u;
        memcpy(body, setup, sizeof setup);
        status = pl_x86_select_write_measured(&frontend, &block, &candidates.candidate[i],
            body + sizeof setup, 256u, &written);
        if (status || candidates.candidate[i].fixup_count) goto failed;
        memcpy(body + sizeof setup + written, observe, sizeof observe);
    }
    if (!test_code_publish(memory, 16384u)) goto failed;
    static const pl_u64 edges[] = {0u,1u,127u,128u,255u,32767u,32768u,65535u,
        0x7fffffffu,0x80000000u,UINT32_MAX,1ull << 32u,1ull << 63u,UINT64_MAX};
    pl_u64 random = 0x13579bdf2468ace0ull;
    for (pl_u32 sample = 0u; sample < 4096u; ++sample) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 index = sample < 196u ? edges[sample % 14u] : random;
        pl_u64 left = random * 17u;
        pl_u64 right = sample < 196u ? edges[sample / 14u] : random * 7u;
        pl_u64 factor = sample < 196u ? edges[sample % 14u] : ~random;
        pl_u64 mask = (1ull << bits) - 1u;
        pl_u64 extended = index & mask;
        if (extended & (1ull << (bits - 1u))) extended |= ~mask;
        signed_wide product = (signed_wide)(pl_i64)right * (signed_wide)(pl_i64)factor;
        pl_u64 flags = product != (signed_wide)(pl_i64)(pl_u64)product ? 0x801u : 0u;
        for (pl_u32 i = 0u; i <= candidates.count; ++i) {
            union { void *object; signed_function function; } fn;
            fn.object = memory + i * 512u;
            signed_observation actual = {0};
            fn.function(&actual, index, left, right, factor);
            if (actual.shifted != (extended << count) || actual.low != (pl_u32)index
                    || actual.difference_product != (left - right) * factor
                    || actual.product != right * factor
                    || (live_flags && (actual.flags & 0x801u) != flags)) {
                fprintf(stderr, "signed seed: mismatch candidate=%u input=%llx/%llx/%llx/%llx\n",
                    i, (unsigned long long)index, (unsigned long long)left,
                    (unsigned long long)right, (unsigned long long)factor);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span = 0u, work = 0u;
    status = pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || work > 7u || span > (live_flags ? 3u : 2u)
            || selected.copied_source || !selected.normalized_family_present) goto failed;
    test_code_release(memory, 16384u);
    return 1;
failed:
    fprintf(stderr, "signed seed: RED bits/count/flags=%u/%u/%u status=%d\n",
        bits,count,live_flags,status);
    for (pl_u32 i = 0u; i < candidates.count; ++i)
        fprintf(stderr, " candidate %u work/span/bytes=%u/%u/%u source=%u\n",i,
            candidates.candidate[i].output_work,candidates.candidate[i].output_span,
            candidates.candidate[i].output_bytes,candidates.candidate[i].copied_source);
    test_code_release(memory, 16384u);
    return 0;
}

/* Re-associating a three-term sum around a published two-term sum must use
 * the same generation in the scheduler and emitter. Observe the input owner
 * copied away before overwrite, all low-word copies, and final ADD flags. */
static int check_reassociated_publication(pl_u32 count, pl_i32 displacement,
                                           pl_u64 *comparisons)
{
    typedef struct { pl_u64 sum, address, low, copied, word, entry, flags; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, const pl_u64 *);
    pl_u8 source[] = {
        0x49u,0x89u,0xdeu, 0x41u,0x89u,0xd5u, /* r14=rbx; r13d=edx */
        0x48u,0xc1u,0xe0u,(pl_u8)count, 0x49u,0x89u,0xccu,
        0x44u,0x89u,0xc5u, 0x48u,0x01u,0xf0u, /* ebp=r8d; add rax,rsi */
        0x48u,0x8du,0x5cu,1u,(pl_u8)displacement,
    };
    static const pl_u8 setup[] = {
        0x53u,0x55u,0x41u,0x54u,0x41u,0x55u,0x41u,0x56u,
        0x49u,0x89u,0xf3u, /* r11 = inputs */
        0x49u,0x8bu,0x03u, 0x49u,0x8bu,0x4bu,8u,
        0x49u,0x8bu,0x53u,16u, 0x49u,0x8bu,0x5bu,24u,
        0x4du,0x8bu,0x43u,32u, 0x49u,0x8bu,0x73u,40u,
    };
    static const pl_u8 observe[] = {
        0x48u,0x89u,0x07u, 0x48u,0x89u,0x5fu,8u, 0x48u,0x89u,0x6fu,16u,
        0x4cu,0x89u,0x67u,24u, 0x4cu,0x89u,0x6fu,32u, 0x4cu,0x89u,0x77u,40u,
        0x9cu,0x58u,0x48u,0x89u,0x47u,48u,
        0x41u,0x5eu,0x41u,0x5du,0x41u,0x5cu,0x5du,0x5bu,0xc3u,
    };
    pl_u8 *memory = test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address = (pl_u64)(uintptr_t)(memory + sizeof setup);
    pl_x86_map map = {source,address,sizeof source,sizeof source,5u,1u};
    pl_x86_image image = {&map,1u,0u,address};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace = {a,b,sizeof a,64u}, scratch = {c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates = {0};
    int status = pl_x86_frontend_open(&image,&frontend);
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,address,address+sizeof source,
        (1u << PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status = pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count < 2u) goto failed;
    memcpy(memory,setup,sizeof setup);
    memcpy(memory+sizeof setup,source,sizeof source);
    memcpy(memory+sizeof setup+sizeof source,observe,sizeof observe);
    for (pl_u32 i=0u; i<candidates.count; ++i) {
        pl_u8 *body = memory+(i+1u)*512u;
        pl_u32 written=0u;
        memcpy(body,setup,sizeof setup);
        status = pl_x86_select_write_measured(&frontend,&block,&candidates.candidate[i],
            body+sizeof setup,256u,&written);
        if (status || candidates.candidate[i].fixup_count) goto failed;
        memcpy(body+sizeof setup+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    static const pl_u64 edge[] = {0u,1u,15u,16u,UINT32_MAX,1ull<<32u,
        (1ull<<63u)-1u,1ull<<63u,UINT64_MAX};
    pl_u64 random=0xacd57b193fe40628ull;
    for (pl_u32 sample=0u; sample<2048u; ++sample) {
        pl_u64 input[6];
        for (pl_u32 j=0u; j<6u; ++j) {
            random ^= random<<13u; random ^= random>>7u; random ^= random<<17u;
            input[j] = sample<81u ? edge[(sample/(j&1u ? 9u : 1u)+j)%9u] : random;
        }
        pl_u64 shifted=input[0]<<count, sum=shifted+input[5];
        pl_u32 parity=0u;
        for (pl_u32 bit=0u; bit<8u; ++bit) parity ^= (pl_u32)(sum>>bit)&1u;
        pl_u64 flags=(sum<shifted ? 1u:0u) | (!parity ? 4u:0u)
            | ((shifted^input[5]^sum)&16u) | (!sum ? 64u:0u)
            | (sum>>63u ? 128u:0u)
            | ((~(shifted^input[5])&(shifted^sum))>>63u ? 2048u:0u);
        for (pl_u32 i=0u; i<=candidates.count; ++i) {
            union { void *object; function call; } fn;
            fn.object=memory+i*512u;
            result actual={0}; fn.call(&actual,input);
            if (actual.sum!=sum || actual.address!=input[1]+sum+(pl_u64)(pl_i64)displacement
                    || actual.low!=(pl_u32)input[4] || actual.copied!=input[1]
                    || actual.word!=(pl_u32)input[2] || actual.entry!=input[3]
                    || (actual.flags&0x8d5u)!=flags) {
                fprintf(stderr,"reassociated publication: mismatch candidate=%u sample=%u address=%llx expected=%llx\n",
                    i,sample,(unsigned long long)actual.address,
                    (unsigned long long)(input[1]+sum+(pl_u64)(pl_i64)displacement));
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || selected.copied_source || !selected.normalized_family_present
            || work>7u || span>3u) goto failed;
    test_code_release(memory,16384u); return 1;
failed:
    fprintf(stderr,"reassociated publication: RED count/offset=%u/%d status=%d\n",count,displacement,status);
    test_code_release(memory,16384u); return 0;
}

/* A ternary sum may outlive one of its inputs, whose final value is zero.
 * The last ADD owns the flags; neither sum seeding nor the zero publication
 * may read the overwritten input or replace those flags. */
static int check_ternary_seed(pl_u32 bits, pl_u32 live_flags, pl_u32 order,
                               pl_u64 *comparisons)
{
    typedef struct { pl_u64 sum, zero, flags; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, const pl_u64 *);
    pl_u8 source[] = {
        bits==64u ? 0x48u:0x40u,0x01u,order ? 0xcbu:0xc3u,
        bits==64u ? 0x4cu:0x44u,0x01u,0xfbu,
        0x45u,0x31u,0xffu,
        bits==64u ? 0x48u:0x40u,0x01u,order ? 0xc3u:0xcbu,
    };
    static const pl_u8 setup[]={
        0x53u,0x41u,0x57u, /* preserve rbx,r15 */
        0x48u,0x8bu,0x06u, 0x48u,0x8bu,0x4eu,8u,
        0x48u,0x8bu,0x5eu,16u, 0x4cu,0x8bu,0x7eu,24u,
    };
    static const pl_u8 observe[]={
        0x48u,0x89u,0x1fu, 0x4cu,0x89u,0x7fu,8u,
        0x9cu,0x58u,0x48u,0x89u,0x47u,16u,
        0x41u,0x5fu,0x5bu,0xc3u,
    };
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address=(pl_u64)(uintptr_t)(memory+sizeof setup);
    pl_x86_map map={source,address,sizeof source,sizeof source,5u,1u};
    pl_x86_image image={&map,1u,0u,address};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates={0};
    pl_u32 mask=(1u<<PL_X86_LOCAL_COUNT)-1u;
    if (!live_flags) mask &= ~(1u<<PL_X86_RFLAGS_LOCAL);
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,address,
        address+sizeof source,mask,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    memcpy(memory,setup,sizeof setup);
    memcpy(memory+sizeof setup,source,sizeof source);
    memcpy(memory+sizeof setup+sizeof source,observe,sizeof observe);
    for (pl_u32 i=0u; i<candidates.count; ++i) {
        pl_u8 *body=memory+(i+1u)*512u;
        pl_u32 written=0u;
        memcpy(body,setup,sizeof setup);
        status=pl_x86_select_write_measured(&frontend,&block,&candidates.candidate[i],
            body+sizeof setup,256u,&written);
        if (status || candidates.candidate[i].fixup_count) goto failed;
        memcpy(body+sizeof setup+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x581b0a3de4c9f672ull;
    pl_u64 width_mask=bits==64u ? UINT64_MAX:UINT32_MAX;
    static const pl_u64 edge[]={0u,1u,15u,16u,UINT32_MAX,1ull<<32u,
        (1ull<<63u)-1u,1ull<<63u,UINT64_MAX};
    for (pl_u32 sample=0u; sample<8192u; ++sample) {
        pl_u64 input[4];
        for (pl_u32 j=0u; j<4u; ++j) {
            random^=random<<13u; random^=random>>7u; random^=random<<17u;
            input[j]=sample<81u ? edge[(sample/(j&1u ? 9u:1u)+j)%9u]:random;
        }
        pl_u64 left=(input[2]+input[order ? 1u:0u]+input[3])&width_mask;
        pl_u64 right=input[order ? 0u:1u]&width_mask;
        pl_u64 sum=(left+right)&width_mask;
        pl_u32 parity=0u;
        for (pl_u32 bit=0u; bit<8u; ++bit) parity^=(pl_u32)(sum>>bit)&1u;
        pl_u64 flags=(sum<left ? 1u:0u)|(!parity ? 4u:0u)
            |((left^right^sum)&16u)|(!sum ? 64u:0u)
            |(sum>>(bits-1u) ? 128u:0u)
            |((~(left^right)&(left^sum))>>(bits-1u)&1u ? 2048u:0u);
        for (pl_u32 i=0u; i<=candidates.count; ++i) {
            union { void *object; function call; } fn;
            fn.object=memory+i*512u;
            result actual={0}; fn.call(&actual,input);
            if (actual.sum!=sum || actual.zero
                    || (live_flags && (actual.flags&0x8d5u)!=flags)) {
                fprintf(stderr,"ternary seed: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || !selected.normalized_family_present || work>4u || span>3u) goto failed;
    test_code_release(memory,16384u); return 1;
failed:
    fprintf(stderr,"ternary seed: RED bits/flags/order=%u/%u/%u status=%d\n",
        bits,live_flags,order,status);
    test_code_release(memory,16384u); return 0;
}

/* The half/remainder identity does not assume that the bias is a sign bit.
 * Exercise arbitrary modular biases, signed/unsigned halves, and overflow. */
static int check_half_remainder(pl_u32 bits, pl_u32 arithmetic, pl_u64 *comparisons)
{
    pl_u8 rex=bits==64u ? 0x48u:0x40u;
    pl_u8 source[]={rex,0x01,0xd6,rex,0x89,0xf0,rex,0xd1,arithmetic ? 0xf8u:0xe8u,
        rex,0x83,0xe6,1,rex,0x29,0xd6,rex,0x01,0xc6};
    static const pl_u8 observe[]={0x48,0x89,0x37,0x48,0x89,0x47,8,0x48,0x89,0x57,16,0xc3};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address=(pl_u64)(uintptr_t)memory;
    pl_x86_map map={source,address,sizeof source,sizeof source,5u,1u};
    pl_x86_image image={&map,1u,0u,address};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates={0};
    pl_u32 mask=((1u<<PL_X86_LOCAL_COUNT)-1u)&~(1u<<PL_X86_RFLAGS_LOCAL);
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,address,
        address+sizeof source,mask,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status) goto failed;
    memcpy(memory,source,sizeof source);memcpy(memory+sizeof source,observe,sizeof observe);
    for (pl_u32 i=0u;i<candidates.count;++i) {
        pl_u32 written=0u;pl_u8 *body=memory+(i+1u)*512u;
        status=pl_x86_select_write_measured(&frontend,&block,&candidates.candidate[i],body,256u,&written);
        if (status || candidates.candidate[i].fixup_count) goto failed;
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x1843ba29d3075cefull,word=UINT64_MAX>>(64u-bits),sign=1ull<<(bits-1u);
    static const pl_u64 edge[]={0u,1u,2u,UINT32_MAX,0x80000000u,1ull<<32u,
        (1ull<<63u)-1u,1ull<<63u,UINT64_MAX};
    for (pl_u32 sample=0u;sample<16384u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 left=sample<81u ? edge[sample%9u]:random;
        pl_u64 right=sample<81u ? edge[sample/9u]:random*17u;
        pl_u64 u=(left+right)&word,q=(u>>1u)|(arithmetic ? u&sign:0u);
        pl_u64 expected=(((u&1u)-right)+q)&word;
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;leaf_function function;} fn;
            fn.object=memory+i*512u;
            observation actual={0};fn.function(&actual,left,right);
            if (actual.value!=expected || actual.shifted!=q || actual.entry!=right) goto failed;
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || selected.copied_source || work>3u || span>3u) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"half remainder: RED bits/arithmetic=%u/%u status=%d candidates=%u\n",
        bits,arithmetic,status,candidates.count);
    test_code_release(memory,16384u);return 0;
}

/* Signed division by two with shared remainder/address publications.
 * q=n/2, r=n%2; r+q=n-q and -(-q)=q. All addresses wrap modulo 2^64.
 * The same final sum is published in RCX and RSI, not recomputed per owner. */
static int check_signed_half_frame(pl_u32 live_flags, pl_u64 *comparisons)
{
    typedef struct {pl_u64 reg[9],flags;} result;
    typedef void (__attribute__((sysv_abi)) *function)(result *,const pl_u64 *);
    static const pl_u8 source[]={
        0x44,0x89,0xf0,0x44,0x89,0xf2,0x49,0x63,0xfe,0xc1,0xe8,0x1f,0xc1,0xea,0x1f,
        0x48,0x01,0xf7,0x44,0x01,0xf0,0x45,0x8d,0x3c,0x16,0x41,0x83,0xe6,1,0xd1,0xf8,
        0x41,0x83,0xe7,1,0xf7,0xd8,0x41,0x29,0xd7,0x41,0x89,0xc0,0x4c,0x63,0xc8,
        0x41,0x29,0xc7,0x4c,0x89,0xe0,0x41,0xf7,0xd8,0x48,0x29,0xf0,0x4d,0x63,0xff,
        0x4d,0x63,0xc0,0x48,0x8d,0x54,0x18,1,0x4a,0x8d,0x0c,6,0x4c,0x01,0xca,0x48,0x89,0xce,
    };
    static const pl_u8 setup[]={
        0x53,0x41,0x54,0x41,0x56,0x41,0x57, /* preserve callee-saved GPRs */
        0x49,0x89,0xfa,0x49,0x89,0xf3, /* r10=result, r11=input */
        0x49,0x8b,0x1b,0x49,0x8b,0x73,8,0x4d,0x8b,0x63,16,0x4d,0x8b,0x73,24,
    };
    static const pl_u8 observe[]={
        0x49,0x89,0x02,0x49,0x89,0x4a,8,0x49,0x89,0x52,16,0x49,0x89,0x72,24,
        0x49,0x89,0x7a,32,0x4d,0x89,0x42,40,0x4d,0x89,0x4a,48,
        0x4d,0x89,0x72,56,0x4d,0x89,0x7a,64,0x9c,0x58,0x49,0x89,0x42,72,
        0x41,0x5f,0x41,0x5e,0x41,0x5c,0x5b,0xc3,
    };
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address=(pl_u64)(uintptr_t)(memory+sizeof setup);
    pl_x86_map map={source,address,sizeof source,sizeof source,5u,1u};
    pl_x86_image image={&map,1u,0u,address};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,128u},scratch={c,d,sizeof c,128u};
    pl_x86_block block;
    pl_x86_native_candidates candidates={0};
    pl_u32 mask=(1u<<PL_X86_LOCAL_COUNT)-1u, normalized=0u, work=UINT32_MAX;
    if (!live_flags) mask &= ~(1u<<PL_X86_RFLAGS_LOCAL);
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,address,
        address+sizeof source,mask,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status) goto failed;
    memcpy(memory,setup,sizeof setup);
    memcpy(memory+sizeof setup,source,sizeof source);
    memcpy(memory+sizeof setup+sizeof source,observe,sizeof observe);
    for (pl_u32 i=0u; i<candidates.count; ++i) {
        pl_u8 *body=memory+(i+1u)*512u;
        pl_u32 written=0u;
        memcpy(body,setup,sizeof setup);
        status=pl_x86_select_write_measured(&frontend,&block,&candidates.candidate[i],
            body+sizeof setup,384u,&written);
        if (status || candidates.candidate[i].fixup_count) goto failed;
        memcpy(body+sizeof setup+written,observe,sizeof observe);
        normalized |= candidates.candidate[i].normalized_family_present
                   && !candidates.candidate[i].copied_source;
        if (!candidates.candidate[i].copied_source
                && candidates.candidate[i].output_work<work)
            work=candidates.candidate[i].output_work;
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    static const pl_u64 edge[]={0u,1u,2u,3u,0x7fffffffu,0x80000000u,
        0xfffffffeu,UINT32_MAX,1ull<<32u,1ull<<63u,UINT64_MAX};
    pl_u64 random=0xb42571968cef01daull;
    for (pl_u32 sample=0u; sample<16384u; ++sample) {
        pl_u64 input[4];
        for (pl_u32 j=0u; j<4u; ++j) {
            random^=random<<13u;random^=random>>7u;random^=random<<17u;
            input[j]=sample<121u ? edge[(sample/(j&1u ? 11u:1u)+j)%11u]:random;
        }
        pl_i64 n=(pl_i64)(input[3]&UINT32_MAX);
        if (n>INT32_MAX) n-=1ll<<32u;
        pl_i64 q=n/2,r=n%2;
        pl_u64 left=input[2]-input[1]+input[0]+1u,right=(pl_u64)-q,sum=left+right;
        result expected={{input[2]-input[1],input[1]+(pl_u64)q,sum,input[1]+(pl_u64)q,
            input[1]+(pl_u64)n,(pl_u64)q,right,input[3]&1u,(pl_u64)(r+q)},0u};
        pl_u32 parity=0u;
        for (pl_u32 bit=0u;bit<8u;++bit) parity^=(pl_u32)(sum>>bit)&1u;
        expected.flags=(sum<left ? 1u:0u)|(!parity ? 4u:0u)
            |((left^right^sum)&16u)|(!sum ? 64u:0u)|(sum>>63u ? 128u:0u)
            |((~(left^right)&(left^sum))>>63u ? 2048u:0u);
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;function call;} fn;
            fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input);
            if (memcmp(actual.reg,expected.reg,sizeof expected.reg)
                    || (live_flags && (actual.flags&0x8d5u)!=expected.flags)) {
                fprintf(stderr,"signed half: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || !normalized || selected.copied_source || work>24u || span>7u
            || selected.output_bytes>75u) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"signed half: RED flags=%u status=%d candidates=%u normalized=%u work=%u\n",
        live_flags,status,candidates.count,normalized,work);
    test_code_release(memory,16384u);return 0;
}

/* In Z/(2^bits), -(-x), (x+y)-y and (x-y)+y all publish x.
 * A 32-bit publication still clears the high word. The final ADD owns flags;
 * retaining NEG/SUB flags or replacing the low-word identity with a 64-bit
 * identity would therefore be observably wrong. */
static int check_modular_cancellation(pl_u32 bits, pl_u32 mode,
                                       pl_u32 live_flags, pl_u64 *comparisons)
{
    pl_u8 rex = bits == 64u ? 0x48u : 0x40u;
    pl_u8 source[] = {rex,0xf7u,0xdeu,rex,0xf7u,0xdeu,rex,0x83u,0xc6u,1u};
    if (mode) {
        source[1] = mode == 1u ? 0x01u : 0x29u;
        source[4] = mode == 1u ? 0x29u : 0x01u;
        source[2] = source[5] = 0xd6u;
    }
    static const pl_u8 observe[] = {
        0x48u,0x89u,0x37u,0x48u,0x89u,0x57u,8u,
        0x9cu,0x58u,0x48u,0x89u,0x47u,24u,0xc3u,
    };
    pl_u8 *memory = test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address = (pl_u64)(uintptr_t)memory;
    pl_x86_map map = {source,address,sizeof source,sizeof source,5u,1u};
    pl_x86_image image = {&map,1u,0u,address};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace = {a,b,sizeof a,64u}, scratch = {c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates = {0};
    pl_x86_native_selection selected = {0};
    pl_u32 mask = (1u << PL_X86_LOCAL_COUNT)-1u, span=0u,work=0u;
    if (!live_flags) mask &= ~(1u << PL_X86_RFLAGS_LOCAL);
    int status = pl_x86_frontend_open(&image,&frontend);
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,address,
        address+sizeof source,mask,&workspace,&block);
    if (!status) status = pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status) goto failed;
    memcpy(memory,source,sizeof source);
    memcpy(memory+sizeof source,observe,sizeof observe);
    for (pl_u32 i=0u; i<candidates.count; ++i) {
        pl_u8 *body = memory+(i+1u)*512u;
        pl_u32 written=0u;
        status = pl_x86_select_write_measured(&frontend,&block,&candidates.candidate[i],
            body,256u,&written);
        if (status || candidates.candidate[i].fixup_count) goto failed;
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    static const pl_u64 edge[] = {0u,1u,15u,16u,0x7fffffffu,0x80000000u,
        UINT32_MAX,1ull<<32u,(1ull<<63u)-1u,1ull<<63u,UINT64_MAX};
    pl_u64 random=0x4927bea8105cdc63ull, word=UINT64_MAX>>(64u-bits);
    for (pl_u32 sample=0u; sample<8192u; ++sample) {
        random^=random<<13u; random^=random>>7u; random^=random<<17u;
        pl_u64 left=sample<121u ? edge[sample%11u] : random;
        pl_u64 right=sample<121u ? edge[sample/11u] : random*17u;
        pl_u64 value=left&word, expected=(value+1u)&word;
        pl_u32 parity=0u;
        for (pl_u32 bit=0u; bit<8u; ++bit) parity^=(pl_u32)(expected>>bit)&1u;
        pl_u64 sign=1ull<<(bits-1u);
        pl_u64 flags=(value==word ? 1u:0u)|(!parity ? 4u:0u)
            |((value^expected^1u)&16u)|(!expected ? 64u:0u)
            |(expected&sign ? 128u:0u)|((~value&(value^expected)&sign) ? 2048u:0u);
        for (pl_u32 i=0u; i<=candidates.count; ++i) {
            union { void *object; leaf_function function; } fn;
            fn.object=memory+i*512u;
            observation actual={0}; fn.function(&actual,left,right);
            if (actual.value!=expected || actual.shifted!=right
                    || (live_flags && (actual.flags&0x8d5u)!=flags)) {
                fprintf(stderr,"modular cancellation: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || selected.copied_source || work>2u || span>2u) goto failed;
    test_code_release(memory,16384u); return 1;
failed:
    fprintf(stderr,"modular cancellation: RED bits/mode/flags=%u/%u/%u status=%d "
        "candidates=%u work/span=%u/%u source=%u\n",bits,mode,live_flags,status,
        candidates.count,work,span,selected.copied_source);
    test_code_release(memory,16384u); return 0;
}

/* A linked address and an equal integer literal cease to be equal after
 * relocation. Copy provenance, including a killed copy, must survive value
 * normalization; pointer copies must remain 64-bit above the 4-GiB boundary.
 * Execute every candidate at a new code address and independently relocate
 * both targets, not merely the candidate selected by its cost. */
static int check_relocated_publications(pl_u32 variant, pl_u32 live_flags,
                                        pl_u64 *comparisons)
{
    pl_u8 source[64] = {
        0x4cu,0x8du,0x0du,0x19u,0x01u,0u,0u, /* lea r9,[rip] -> 0x1120 */
        0x49u,0x89u,0xf0u,                    /* mov r8,rsi */
        0x31u,0xffu,0x31u,0xc0u,              /* xor edi,edi; xor eax,eax */
        0x4cu,0x89u,0xc9u,                    /* mov rcx,r9 */
    };
    pl_u32 length=17u;
    if (variant>=3u) {
        source[7]=0x4cu;source[8]=0x89u;source[9]=0xc9u;
        length=10u;
    }
    int literal_copy=variant==1u || variant==3u;
    if (variant) {
        source[length++]=literal_copy ? 0xb9u : 0x41u;
        if (!literal_copy) source[length++]=0xb9u;
        source[length++]=0x20u; source[length++]=0x11u;
        source[length++]=0u; source[length++]=0u;
    }
    pl_u32 second_field=length;
    if (variant<3u) {
        source[length++]=0x48u; source[length++]=0x8du; source[length++]=0x15u;
        second_field=length;
        pl_u32 displacement=0x1230u-(0x1000u+length+4u);
        for (pl_u32 byte=0u;byte<4u;++byte)
            source[length++]=(pl_u8)(displacement>>(byte*8u));
    }
    static const pl_u8 prefix[]={0x49u,0x89u,0xfau}; /* preserve observation pointer */
    static const pl_u8 observe[]={
        0x49u,0x89u,0x02u,0x49u,0x89u,0x4au,8u,  /* rax,rcx */
        0x49u,0x89u,0x52u,16u,0x49u,0x89u,0x7au,24u, /* rdx,rdi */
        0x4du,0x89u,0x42u,32u,0x4du,0x89u,0x4au,40u, /* r8,r9 */
        0x9cu,0x58u,0x49u,0x89u,0x42u,48u,0xc3u,
    };
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address=(pl_u64)(uintptr_t)memory;
    pl_x86_map map={source,0x1000u,length,length,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates={0};
    pl_x86_native_selection selected={0};
    pl_u32 mask=(1u<<PL_X86_LOCAL_COUNT)-1u,span=0u,work=0u;
    if (!live_flags) mask &= ~(1u<<PL_X86_RFLAGS_LOCAL);
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+length,mask,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status) goto failed;
    for (pl_u32 i=0u;i<=candidates.count;++i) {
        pl_u8 *entry=memory+i*512u,*body=entry+sizeof prefix;
        pl_u32 written=length;
        memcpy(entry,prefix,sizeof prefix);
        if (!i) {
            memcpy(body,source,length);
            const pl_u32 fields[]={3u,second_field};
            const pl_u32 targets[]={12000u,13000u};
            for (pl_u32 j=0u;j<(variant<3u ? 2u:1u);++j) {
                pl_u32 disp=targets[j]-(pl_u32)sizeof prefix-fields[j]-4u;
                for (pl_u32 byte=0u;byte<4u;++byte)
                    body[fields[j]+byte]=(pl_u8)(disp>>(byte*8u));
            }
        } else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            for (pl_u32 j=0u;!status && j<candidate->fixup_count;++j) {
                pl_u64 target=candidate->fixups[j].target;
                if (target!=0x1120u && target!=0x1230u) goto failed;
                target=address+(target==0x1120u ? 12000u:13000u);
                status=pl_x86_select_bind_fixup(body,written,candidate,j,
                    (pl_u64)(uintptr_t)body,target);
            }
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    typedef void (__attribute__((sysv_abi)) *address_function)(pl_u64 *,pl_u64);
    for (pl_u32 sample=0u;sample<32u;++sample) {
        pl_u64 input=0x8070605040302010ull*sample;
        pl_u64 expected[]={0u,literal_copy ? 0x1120u:address+12000u,
            address+13000u,0u,input,variant && !literal_copy ? 0x1120u:address+12000u,0x44u};
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;address_function function;} fn;
            fn.object=memory+i*512u;
            pl_u64 actual[7]={0};fn.function(actual,input);
            actual[6] &= 0x8c5u; /* AF is undefined after XOR. */
            for (pl_u32 j=0u;j<(live_flags ? 7u:6u);++j) {
                if (variant>=3u && j!=1u && j!=5u) continue;
                if (actual[j]!=expected[j]) {
                    fprintf(stderr,"relocated publications: candidate=%u output=%u "
                        "expected=%llx actual=%llx\n",i,j,
                        (unsigned long long)expected[j],(unsigned long long)actual[j]);
                    if (i) {
                        const pl_x86_native_selection *bad=&candidates.candidate[i-1u];
                        fprintf(stderr,"  source/zero/frame=%u/%u/%u bytes=%u\n",
                            bad->copied_source,bad->direct_zero_flag_frame,bad->direct_frame,bad->output_bytes);
                        for (pl_u32 k=0u;k<bad->output_bytes;++k)
                            fprintf(stderr,"%02x ",memory[i*512u+sizeof prefix+k]);
                        fputc('\n',stderr);
                    }
                    goto failed;
                }
            }
            ++*comparisons;
        }
    }
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || (live_flags && selected.copied_source)
            || !selected.normalized_family_present) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"relocated publications: RED variant/flags=%u/%u status=%d "
        "candidates=%u work/span=%u/%u source=%u\n",variant,live_flags,status,
        candidates.count,work,span,selected.copied_source);
    test_code_release(memory,16384u);return 0;
}

/* Parallel publication: (a,b) -> (b,a+1,b). A final copy whose previous
 * coordinate is dead can preserve b while the arithmetic still reads a.
 * Choosing the first architectural output as owner invents a copy cycle.
 * The unrelated relocated address is part of this same ordinary SSA cut.
 * Selected 32-bit spelling: 4 work / 16 bytes, source 5 / 20:
 *     mov r12, rbx
 *     lea ebx, [rax+1]
 *     mov rax, r12
 *     lea r14, [rip+target]
 * The selector's copy-renaming span is 1, not a measured CPU cycle count. */
static int check_entry_fanout(pl_u32 bits, pl_u64 *comparisons)
{
    pl_u8 source[]={0x4cu,0x8du,0x35u,0x19u,1u,0u,0u,
        0x44u,0x8du,0x60u,1u,0x48u,0x89u,0xd8u,
        0x44u,0x89u,0xe3u,0x49u,0x89u,0xc4u};
    if (bits==64u) source[7]=source[14]=0x4cu;
    static const pl_u8 prefix[]={
        0x53u,0x41u,0x54u,0x41u,0x56u, /* save rbx,r12,r14 */
        0x49u,0x89u,0xfau,0x48u,0x89u,0xf0u,0x48u,0x89u,0xd3u,
        0x31u,0xc9u,
    };
    static const pl_u8 observe[]={
        0x49u,0x89u,0x02u,0x49u,0x89u,0x5au,8u,
        0x4du,0x89u,0x62u,16u,0x4du,0x89u,0x72u,24u,
        0x9cu,0x58u,0x49u,0x89u,0x42u,32u,
        0x41u,0x5eu,0x41u,0x5cu,0x5bu,0xc3u,
    };
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address=(pl_u64)(uintptr_t)memory;
    pl_x86_map map={source,0x1000u,sizeof source,sizeof source,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates={0};
    pl_x86_native_selection selected={0};
    pl_u32 span=0u,work=0u;
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+sizeof source,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status) goto failed;
    for (pl_u32 i=0u;i<=candidates.count;++i) {
        pl_u8 *entry=memory+i*512u,*body=entry+sizeof prefix;
        pl_u32 written=sizeof source;
        memcpy(entry,prefix,sizeof prefix);
        if (!i) {
            memcpy(body,source,sizeof source);
            pl_u32 disp=12000u-(pl_u32)sizeof prefix-7u;
            for (pl_u32 byte=0u;byte<4u;++byte)
                body[3u+byte]=(pl_u8)(disp>>(byte*8u));
        } else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            for (pl_u32 j=0u;!status && j<candidate->fixup_count;++j) {
                if (candidate->fixups[j].target!=0x1120u) goto failed;
                status=pl_x86_select_bind_fixup(body,written,candidate,j,
                    (pl_u64)(uintptr_t)body,address+12000u);
            }
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    typedef void (__attribute__((sysv_abi)) *fanout_function)(pl_u64 *,pl_u64,pl_u64);
    static const pl_u64 edge[]={0u,1u,0x7fffffffu,0x80000000u,UINT32_MAX,
        1ull<<32u,1ull<<63u,UINT64_MAX};
    pl_u64 random=0x66c4b8a291ea522bull;
    for (pl_u32 sample=0u;sample<8192u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 left=sample<64u ? edge[sample%8u]:random;
        pl_u64 right=sample<64u ? edge[sample/8u]:random*17u;
        pl_u64 expected[]={right,(left+1u)&(UINT64_MAX>>(64u-bits)),right,
            address+12000u,0x44u};
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;fanout_function function;} fn;
            fn.object=memory+i*512u;
            pl_u64 actual[5]={0};fn.function(actual,left,right);
            actual[4]&=0x8c5u;
            if (memcmp(actual,expected,sizeof expected)) {
                fprintf(stderr,"entry fanout: mismatch candidate=%u sample=%u\n",i,sample);
                for (pl_u32 j=0u;j<5u;++j)
                    fprintf(stderr,"  output%u expected=%llx actual=%llx\n",j,
                        (unsigned long long)expected[j],(unsigned long long)actual[j]);
                if (i) {
                    const pl_x86_native_selection *bad=&candidates.candidate[i-1u];
                    fprintf(stderr,"  alu/live/transient/affine/shared=%u/%u/%u/%u/%u\n",
                        bad->direct_alu_frame,bad->direct_live_frame,bad->direct_transient_owner_frame,
                        bad->direct_affine_frame,bad->direct_shared_dag_frame);
                    for (pl_u32 j=0u;j<candidates.candidate[i-1u].output_bytes;++j)
                        fprintf(stderr,"%02x ",memory[i*512u+sizeof prefix+j]);
                }
                fputc('\n',stderr);
                goto failed;
            }
            ++*comparisons;
        }
    }
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || selected.copied_source || !selected.normalized_family_present || work>4u)
        goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"entry fanout: RED bits=%u status=%d candidates=%u work/span=%u/%u source=%u\n",
        bits,status,candidates.count,work,span,selected.copied_source);
    test_code_release(memory,16384u);return 0;
}

/* The scaled signed input is shared with a publication. Its two syntactic
 * scaling operations must not become two dependencies before the final ADD. */
static int check_scaled_signed_fanout(pl_u32 inner, pl_u32 outer,
                                       pl_u32 live_flags, pl_u64 *comparisons)
{
    typedef struct {pl_u64 signed_input,sum,scaled,other,flags;} result;
    typedef void (__attribute__((sysv_abi)) *function)(result *,pl_u64,pl_u64,pl_u64,pl_u64,pl_u64);
    pl_u32 factor=(1u+(1u<<inner))<<outer;
    pl_u8 source[]={0x48,0x98,0x4c,0x89,0xd1,0x4c,0x89,0xc6,
        0x48,0x8d,0x14,(pl_u8)(inner<<6u),0x48,0xc1,0xe1,5,
        0x48,0xc1,0xe6,5,0x48,0xc1,0xe2,(pl_u8)outer,0x4c,0x01,0xd9,0x4c,0x01,0xca};
    pl_u8 witness[]={0x48,0x98,0x48,0x69,0xd0,(pl_u8)factor,(pl_u8)(factor>>8u),0,0,
        0x49,0x6b,0xca,32,0x49,0x6b,0xf0,32,0x4c,0x01,0xd9,0x4c,0x01,0xca};
    static const pl_u8 setup[]={0x4d,0x89,0xcb,0x49,0x89,0xd1,0x49,0x89,0xca,0x48,0x89,0xf0};
    static const pl_u8 observe[]={0x48,0x89,0x07,0x48,0x89,0x4f,8,
        0x48,0x89,0x57,16,0x48,0x89,0x77,24,0x9c,0x58,0x48,0x89,0x47,32,0xc3};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,sizeof source,sizeof source,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates={0};
    pl_u32 live=(1u<<PL_X86_LOCAL_COUNT)-1u;
    if (!live_flags) live&=~(1u<<PL_X86_RFLAGS_LOCAL);
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+sizeof source,live,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    for (pl_u32 i=0u;i<=candidates.count+1u;++i) {
        pl_u8 *start=memory+i*512u,*body=start+sizeof setup;
        pl_u32 written=sizeof source;
        memcpy(start,setup,sizeof setup);
        if (!i) memcpy(body,source,sizeof source);
        else if (i==candidates.count+1u) {
            written=sizeof witness;memcpy(body,witness,written);
        } else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            if (status || candidate->fixup_count) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x657394a364752b01ull;
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input=sample<512u ? ((random&~0xffffffffull)|((pl_u32)(sample-256u))):random;
        pl_u64 signed_input=(pl_u64)(pl_i64)(pl_i32)input;
        pl_u64 base=sample%3u ? random*17u:0u,axis=random*31u,other=~random,offset=random*23u;
        pl_u64 product=signed_input*factor,scaled=product+base;
        pl_u64 flags=(scaled<product ? 1u:0u)|((product^base^scaled)&16u)
            |(!scaled ? 64u:0u)|(scaled>>63u ? 128u:0u)
            |((~(product^base)&(product^scaled))>>63u ? 2048u:0u);
        pl_u32 parity=0u;
        for (pl_u32 bit=0u;bit<8u;++bit) parity^=(pl_u32)(scaled>>bit)&1u;
        if (!parity) flags|=4u;
        for (pl_u32 i=0u;i<=candidates.count+1u;++i) {
            union {void *object;function call;} fn;
            fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input,base,axis,other,offset);
            if (actual.signed_input!=signed_input || actual.sum!=(axis<<5u)+offset
                    || actual.scaled!=scaled || actual.other!=(other<<5u)
                    || (live_flags && (actual.flags&0x8d5u)!=flags)) {
                fprintf(stderr,"scaled signed fanout: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || work>6u || span>3u) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"scaled signed fanout: RED inner/outer/flags=%u/%u/%u status=%d\n",
        inner,outer,live_flags,status);
    test_code_release(memory,16384u);return 0;
}

/* A 32-bit destination projects the whole address sum, not each input's
 * architectural lifetime. The other publications still consume the entry
 * RSI and RDX generations before either coordinate changes. */
static int check_projected_address(pl_u32 bits, pl_u32 scale, pl_i32 displacement,
                                   pl_u64 *comparisons)
{
    typedef struct {pl_u64 sum, copy, replacement, address, zero, constant, input, flags;} result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, const pl_u64 *);
    pl_u8 source[64];pl_u32 length=0u;
    if (bits!=32u) source[length++]=0x48u;
    source[length++]=0x8du;source[length++]=0x4cu;
    source[length++]=(pl_u8)((scale<<6u)|0x16u);
    source[length++]=(pl_u8)displacement;
    if (bits<32u) {
        source[length++]=0x0fu;source[length++]=(pl_u8)(bits==8u ? 0xb6u:0xb7u);
        source[length++]=0xc9u;
    }
    static const pl_u8 tail[]={0x41u,0xb9u,0xffu,0xffu,0x0fu,0u,0x89u,0xf2u,
        0x45u,0x31u,0xc0u,0x4cu,0x89u,0xf6u,0x48u,0xc7u,0xc7u,0x18u,0xf4u,0x8bu,0x81u};
    memcpy(source+length,tail,sizeof tail);length+=(pl_u32)sizeof tail;
    static const pl_u8 setup[]={0x41u,0x56u,0x49u,0x89u,0xfbu,
        0x4cu,0x8bu,0x76u,16u,0x48u,0x8bu,0x56u,8u,0x4cu,0x8bu,0x46u,24u,
        0x48u,0x8bu,0x36u,0x49u,0x83u,0xf8u,0u};
    static const pl_u8 observe[]={0x49u,0x89u,0x0bu,0x49u,0x89u,0x53u,8u,
        0x49u,0x89u,0x73u,16u,0x49u,0x89u,0x7bu,24u,
        0x4du,0x89u,0x43u,32u,0x4du,0x89u,0x4bu,40u,
        0x4du,0x89u,0x73u,48u,0x9cu,0x58u,0x49u,0x89u,0x43u,56u,
        0x41u,0x5eu,0xc3u};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,length,length,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,0x1000u+length,
        (1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || !candidates.count) goto failed;
    for (pl_u32 i=0u;i<=candidates.count;++i) {
        pl_u8 *body=memory+i*512u;pl_u32 written=length;
        memcpy(body,setup,sizeof setup);
        if (!i) memcpy(body+sizeof setup,source,length);
        else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,
                body+sizeof setup,256u,&written);
            if (status || candidate->fixup_count) goto failed;
        }
        memcpy(body+sizeof setup+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    static const pl_u64 edge[]={0u,1u,0xffu,0x100u,0xffffu,0x10000u,0x7fffffffu,
        0x80000000u,UINT32_MAX,1ull<<32u,1ull<<63u,UINT64_MAX};
    pl_u64 random=0x4023fedc9be675a1ull,mask=UINT64_MAX>>(64u-bits);
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input[]={sample<144u ? edge[sample%12u]:random,
            sample<144u ? edge[sample/12u]:random*17u,~random,random*19u};
        pl_u64 sum=(input[0]+(input[1]<<scale)+(pl_u64)(pl_i64)displacement)&mask;
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;function call;} fn;fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input);
            if (actual.sum!=sum || actual.copy!=(pl_u32)input[0]
                    || actual.replacement!=input[2] || actual.address!=0xffffffff818bf418ull
                    || actual.zero || actual.constant!=0xfffffu || actual.input!=input[2]
                    || (actual.flags&0x8c5u)!=0x44u) {
                fprintf(stderr,"projected address: mismatch candidate=%u sample=%u sum=%llx expected=%llx\n",
                    i,sample,(unsigned long long)actual.sum,(unsigned long long)sum);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    /* Byte/word projections are negative width boundaries, not permission to
     * replace MOVZX by a 32-bit destination or claim an unattained minimum. */
    if (bits>=32u && (status || !selected.normalized_family_present || work>6u || span>1u)) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"projected address: RED bits/scale/displacement=%u/%u/%d status=%d candidates=%u\n",
        bits,scale,displacement,status,candidates.count);
    test_code_release(memory,16384u);return 0;
}

int main(void)
{
    static const pl_u32 mode[] = { 0u, 1u, 3u, 5u, 6u };
    static const pl_u32 group[] = { 4u, 5u, 7u };
    pl_u64 comparisons = 0u;
    static const pl_u32 projected_widths[]={32u,64u,8u,16u};
    static const pl_i32 projected_displacements[]={-128,-1,0,1,127};
    for (pl_u32 w=0u;w<sizeof projected_widths/sizeof projected_widths[0];++w)
        for (pl_u32 scale=0u;scale<=3u;++scale)
            for (pl_u32 d=0u;d<sizeof projected_displacements/sizeof projected_displacements[0];++d)
                if (!check_projected_address(projected_widths[w],scale,
                        projected_displacements[d],&comparisons)) return 1;
    for (pl_u32 inner=1u;inner<=3u;++inner)
        for (pl_u32 outer=1u;outer<=4u;++outer)
            for (pl_u32 flags=0u;flags<2u;++flags)
                if (!check_scaled_signed_fanout(inner,outer,flags,&comparisons)) return 1;
    for (pl_u32 bits=32u;bits<=64u;bits+=32u)
        if (!check_entry_fanout(bits,&comparisons)) return 1;
    for (pl_u32 variant=0u;variant<5u;++variant)
        for (pl_u32 flags=0u;flags<(variant<3u ? 2u:1u);++flags)
            if (!check_relocated_publications(variant,flags,&comparisons)) return 1;
    for (pl_u32 bits=32u;bits<=64u;bits+=32u)
        for (pl_u32 arithmetic=0u;arithmetic<2u;++arithmetic)
            if (!check_half_remainder(bits,arithmetic,&comparisons)) return 1;
    for (pl_u32 flags=0u;flags<2u;++flags)
        if (!check_signed_half_frame(flags,&comparisons)) return 1;
    for (pl_u32 bits=32u; bits<=64u; bits+=32u)
        for (pl_u32 mode_index=0u; mode_index<3u; ++mode_index)
            for (pl_u32 flags=0u; flags<2u; ++flags)
                if (!check_modular_cancellation(bits,mode_index,flags,&comparisons)) return 1;
    for (pl_u32 bits=32u; bits<=64u; bits+=32u)
        for (pl_u32 flags=0u; flags<2u; ++flags)
            for (pl_u32 order=0u; order<2u; ++order)
                if (!check_ternary_seed(bits,flags,order,&comparisons)) return 1;
    static const pl_u32 shared_counts[]={1u,2u,3u,4u,6u,31u,63u};
    for (pl_u32 i=0u; i<sizeof shared_counts/sizeof shared_counts[0]; ++i)
        for (pl_i32 displacement=-17; displacement<=17; displacement+=17)
            if (!check_reassociated_publication(shared_counts[i],displacement,&comparisons)) return 1;
    static const pl_u32 signed_counts[] = {1u,7u,31u,63u};
    for (pl_u32 bits = 8u; bits <= 32u; bits *= 2u)
        for (pl_u32 i = 0u; i < sizeof signed_counts / sizeof signed_counts[0]; ++i)
            for (pl_u32 flags = 0u; flags < 2u; ++flags)
                if (!check_signed_seed(bits,signed_counts[i],flags,&comparisons)) return 1;
    static const pl_u64 masks[] = {0xffffffff00000000ull, 0x100000000ull,
        0xaaaaaaaa00000000ull, 0x7fffffff00000000ull};
    for (pl_u32 i = 0u; i < sizeof masks / sizeof masks[0]; ++i)
        if (!check_mask_publication(masks[i], &comparisons)) return 1;
    static const pl_u32 narrow_counts[] = {0u,1u,5u,7u,8u,15u,16u,31u,32u,33u,255u};
    for (pl_u32 bits = 8u; bits <= 16u; bits *= 2u)
        for (pl_u32 i = 0u; i < sizeof narrow_counts / sizeof narrow_counts[0]; ++i)
            for (pl_u32 wide = 0u; wide < 2u; ++wide)
                for (pl_u32 left = 0u; left < 2u; ++left)
                    if (!check_narrow_shift_publication(bits, narrow_counts[i],
                            wide ? 0x80010020u : 0x20u, left, &comparisons)) return 1;
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
