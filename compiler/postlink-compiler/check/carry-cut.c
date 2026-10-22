#define _GNU_SOURCE
#include "../src/internal/x86-selection.h"
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

static pl_u64 word_operation(pl_u64 left, pl_u64 right, pl_u32 bits,
                              pl_u32 mode, pl_u64 *flags)
{
    pl_u64 mask = UINT64_MAX >> (64u - bits), sign = 1ull << (bits - 1u);
    left &= mask; right &= mask;
    pl_u64 value = mode == 0u ? left + right : mode == 1u ? left - right
                 : mode == 2u ? left & right : mode == 3u ? left | right : left ^ right;
    value &= mask;
    pl_u32 parity = 0u;
    for (pl_u32 i = 0u; i < 8u; ++i) parity ^= (pl_u32)(value >> i) & 1u;
    *flags = (!parity ? 4u : 0u) | (!value ? 64u : 0u) | (value & sign ? 128u : 0u);
    if (mode < 2u) {
        *flags |= (left ^ right ^ value) & 16u;
        *flags |= (mode ? left < right : value < left) ? 1u : 0u;
        *flags |= ((mode ? left ^ right : ~(left ^ right))
                    & (left ^ value) & sign) ? 2048u : 0u;
    }
    return value;
}

static pl_u32 observed_condition(pl_u32 code, pl_u64 flags)
{
    pl_u32 c = !!(flags & 1u), p = !!(flags & 4u), z = !!(flags & 64u);
    pl_u32 s = !!(flags & 128u), o = !!(flags & 2048u), positive;
    switch (code >> 1u) {
    case 0u: positive = o; break;
    case 1u: positive = c; break;
    case 2u: positive = z; break;
    case 3u: positive = c || z; break;
    case 4u: positive = s; break;
    case 5u: positive = p; break;
    case 6u: positive = s != o; break;
    default: positive = z || (s != o); break;
    }
    return positive ^ (code & 1u);
}

typedef struct { pl_u64 value, condition, flags, taken; } group_observation;
typedef void (__attribute__((sysv_abi)) *group_function)(
    group_observation *, pl_u64, pl_u64, pl_u64);

static int check_group(pl_u32 bits, pl_u32 mode, pl_u32 code, pl_u32 aliases,
                       pl_u32 result_branch,
                       pl_u64 *comparisons)
{
    /* The Boolean either has its own GPR or replaces the old left input.
     * Its zero initialization must not destroy that input before the ALU. */
    pl_u8 source[32] = { 0x48u, 0x89u, 0xf0u }; /* mov rax,rsi */
    pl_u32 length = 3u;
    if (result_branch) {
        source[length++] = 0x49u; source[length++] = 0x89u; source[length++] = 0xc0u;
    } else {
        if (!aliases) source[length++] = 0x45u;
        source[length++] = 0x31u; source[length++] = aliases ? 0xf6u : 0xc0u;
    }
    static const pl_u8 operation[] = { 0x01u, 0x29u, 0x21u, 0x09u, 0x31u };
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = mode == 5u ? 0xf7u : operation[mode];
    source[length++] = mode == 5u ? 0xd8u : 0xd0u;
    if (result_branch >= 3u) {
        if (bits == 64u) source[length++] = 0x48u;
        source[length++] = 0x0fu; source[length++] = (pl_u8)(0x40u | code);
        source[length++] = 0xc2u; /* cmovcc rax,rdx, observing the ALU's flags */
    }
    if (!result_branch) {
        source[length++] = aliases ? 0x40u : 0x41u;
        source[length++] = 0x0fu; source[length++] = (pl_u8)(0x90u | code);
        source[length++] = aliases ? 0xc6u : 0xc0u;
        source[length++] = 0x84u; source[length++] = 0xc9u; /* test cl,cl */
    }
    if (result_branch != 4u) {
        source[length++] = (pl_u8)(0x70u | (result_branch ? code : 4u)); source[length++] = 8u;
    }
    pl_u8 observe[] = {
        0x41u, 0xbbu, 0u, 0u, 0u, 0u, 0xebu, 6u,
        0x41u, 0xbbu, 1u, 0u, 0u, 0u,
        0x48u, 0x89u, 0x07u,
        0x4cu, 0x89u, 0x47u, 8u,
        0x9cu, 0x41u, 0x5au, 0x4cu, 0x89u, 0x57u, 16u,
        0x4cu, 0x89u, 0x5fu, 24u, 0xc3u,
    };
    if (aliases) { observe[17] = 0x48u; observe[19] = 0x77u; }
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
    pl_x86_block_workspace select_workspace = {
        select_first, select_second, sizeof select_first, 64u };
    pl_x86_block block;
    pl_x86_native_candidates candidates;
    pl_x86_native_selection selected = { 0 };
    pl_u32 span = 0u, work = 0u, written = 0u;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(
        &frontend, address, address + length,
        (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status) {
        block.relax_short_control = (pl_u8)(result_branch != 2u);
        status = pl_x86_select_candidates(&frontend, &select_workspace, &block, &candidates);
    }
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, &selected, &span, &work);
    if (!status && selected.copied_source)
        for (pl_u32 i = 0u; i < candidates.count; ++i) {
            const pl_x86_native_selection *candidate = &candidates.candidate[i];
            if (candidate->supported && !candidate->copied_source
                    && candidate->output_work == work && candidate->output_span == span) {
                selected = *candidate;
                break;
            }
        }
    if (status || !selected.normalized_family_present || selected.copied_source
            || work > (result_branch >= 3u ? 5u : result_branch ? 4u : 6u) || span > 4u) goto failed;
    status = pl_x86_select_write_measured(&frontend, &block, &selected,
        memory + 512u, 256u, &written);
    if (status || written != selected.output_bytes
            || selected.fixup_count != (result_branch == 4u ? 0u : 1u)) goto failed;
    if (selected.fixup_count && (selected.fixups[0].target != address + length + 8u
            || pl_x86_select_bind_fixup(memory + 512u, written, &selected, 0u,
                address + 512u, address + 512u + written + 8u))) goto failed;
    memcpy(memory, source, length);
    memcpy(memory + length, observe, sizeof observe);
    memcpy(memory + 512u + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; group_function function; } original, optimized;
    original.object = memory; optimized.object = memory + 512u;
    static const pl_u64 boundary[] = {
        0u, 1u, 127u, 128u, 255u, 256u, 32767u, 32768u, 65535u,
        65536u, 0x7fffffffu, 0x80000000u, UINT32_MAX, 1ull << 32u, 1ull << 63u, UINT64_MAX };
    pl_u64 random = 0x6a09e667f3bcc909ull;
    for (pl_u32 i = 0u; i < 4096u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 left = i < 256u ? boundary[i % 16u] : random;
        pl_u64 right = i < 256u ? boundary[i / 16u] : random * 17u;
        pl_u64 flags = 0u, final = 0u, toggle = i;
        pl_u64 expected = mode == 5u ? word_operation(0u, left, bits, 1u, &flags)
            : word_operation(left, right, bits, mode, &flags);
        if (result_branch >= 3u && observed_condition(code, flags))
            expected = right & (UINT64_MAX >> (64u - bits));
        (void)word_operation(toggle, toggle, 8u, 2u, &final);
        pl_u64 expected_condition = result_branch ? left : observed_condition(code, flags);
        pl_u64 flags_mask = result_branch && (mode < 2u || mode == 5u) ? 0x8d5u : 0x8c5u;
        pl_u64 taken = result_branch ? observed_condition(code, flags) : !(toggle & 255u);
        if (result_branch == 4u) taken = 0u;
        if (result_branch) final = flags;
        group_observation before = { 0 }, after = { 0 };
        original.function(&before, left, right, toggle);
        optimized.function(&after, left, right, toggle);
        if (before.value != expected || after.value != expected
                || before.condition != expected_condition || after.condition != expected_condition
                || (before.flags & flags_mask) != final || (after.flags & flags_mask) != final
                || before.taken != taken || after.taken != taken) {
            fprintf(stderr, " group input=%llx/%llx value=%llx/%llx expected=%llx condition=%llu/%llu expected=%u\n",
                (unsigned long long)left, (unsigned long long)right,
                (unsigned long long)before.value, (unsigned long long)after.value,
                (unsigned long long)expected,
                (unsigned long long)before.condition, (unsigned long long)after.condition,
                observed_condition(code, flags));
            goto failed;
        }
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "flag result group: RED bits=%u mode=%u condition=%u alias=%u branch=%u status=%d work/span=%u/%u source/normalized=%u/%u comparisons=%llu\n",
        bits, mode, code, aliases, result_branch, status, work, span, selected.copied_source,
        selected.normalized_family_present, (unsigned long long)*comparisons);
    test_code_release(memory, 4096u);
    return 0;
}

static int check_mask(pl_u32 bits, pl_u32 compare_bits, pl_u32 inverse,
                      pl_u32 mask, pl_u64 *comparisons)
{
    /* A condition-derived full mask is narrowed before a wide subtraction.
     * The independent conditional publication and exact fanout must survive
     * without recomputing the comparison or losing its entry inputs. */
    pl_u8 source[64] = {
        0x48u, 0x85u, 0xc9u,                   /* test rcx,rcx */
        0x41u, 0xb9u, 0x78u, 0x56u, 0x34u, 0x12u,
        0x4cu, 0x0fu, 0x45u, 0xc9u,           /* cmovne r9,rcx */
    };
    pl_u32 length = 13u;
    if (compare_bits == 16u) source[length++] = 0x66u;
    if (compare_bits == 64u) source[length++] = 0x48u;
    if (compare_bits == 8u) source[length++] = 0x40u;
    source[length++] = compare_bits == 8u ? 0x38u : 0x39u;
    source[length++] = 0xd6u;                  /* cmp rsi,rdx */
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x19u; source[length++] = 0xc0u; /* sbb rax,rax */
    if (inverse) {
        if (bits == 64u) source[length++] = 0x48u;
        source[length++] = 0xf7u; source[length++] = 0xd0u;
    }
    source[length++] = 0x25u;                  /* and eax,mask */
    for (pl_u32 i = 0u; i < 4u; ++i) source[length++] = (pl_u8)(mask >> (i * 8u));
    static const pl_u8 tail[] = {
        0x48u, 0x2du, 0xfeu, 0x35u, 0x65u, 4u, /* sub rax,0x46535fe */
        0x49u, 0x89u, 0xc0u,                    /* mov r8,rax */
    };
    memcpy(source + length, tail, sizeof tail); length += sizeof tail;
    static const pl_u8 observe[] = {
        0x48u, 0x89u, 0x07u, 0x4cu, 0x89u, 0x47u, 8u,
        0x4cu, 0x89u, 0x4fu, 16u,
        0x9cu, 0x41u, 0x5au, 0x4cu, 0x89u, 0x57u, 24u, 0xc3u,
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
    pl_x86_block_workspace select_workspace = {
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
        &frontend, &select_workspace, &block, &candidates);
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, &selected, &span, &work);
    if (!status && selected.copied_source)
        for (pl_u32 i = 0u; i < candidates.count; ++i) {
            const pl_x86_native_selection *candidate = &candidates.candidate[i];
            if (candidate->supported && !candidate->copied_source
                    && candidate->output_work == work && candidate->output_span == span) {
                selected = *candidate;
                break;
            }
        }
    if (status || !selected.normalized_family_present || selected.copied_source
            || work > 9u) goto failed;
    status = pl_x86_select_write_measured(&frontend, &block, &selected,
        memory + 512u, 256u, &written);
    if (status || written != selected.output_bytes || selected.fixup_count) goto failed;
    memcpy(memory, source, length);
    memcpy(memory + length, observe, sizeof observe);
    memcpy(memory + 512u + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; group_function function; } original, optimized;
    original.object = memory; optimized.object = memory + 512u;
    static const pl_u64 boundary[] = {
        0u, 1u, 127u, 128u, 255u, 256u, 32767u, 32768u, 65535u,
        65536u, 0x7fffffffu, 0x80000000u, UINT32_MAX, 1ull << 32u, 1ull << 63u, UINT64_MAX };
    pl_u64 random = 0x6a09e667f3bcc909ull;
    for (pl_u32 i = 0u; i < 4096u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 left = i < 256u ? boundary[i % 16u] : random;
        pl_u64 right = i < 256u ? boundary[i / 16u] : random * 17u;
        pl_u64 width = UINT64_MAX >> (64u - compare_bits);
        pl_u64 predicate = ((left & width) < (right & width)) ^ inverse;
        pl_u64 narrow = (pl_u32)(0ull - predicate) & mask, flags = 0u;
        pl_u64 expected = word_operation(narrow, 0x46535feu, 64u, 1u, &flags);
        pl_u64 choice = i & 1u ? random : 0u;
        group_observation before = { 0 }, after = { 0 };
        original.function(&before, left, right, choice);
        optimized.function(&after, left, right, choice);
        if (before.value != expected || after.value != expected
                || before.condition != expected || after.condition != expected
                || before.flags != (choice ? choice : 0x12345678u)
                || after.flags != before.flags
                || (before.taken & 0x8d5u) != flags || (after.taken & 0x8d5u) != flags) {
            fprintf(stderr, " mask input=%llx/%llx result=%llx/%llx expected=%llx flags=%llx/%llx expected=%llx\n",
                (unsigned long long)left, (unsigned long long)right,
                (unsigned long long)before.value, (unsigned long long)after.value,
                (unsigned long long)expected, (unsigned long long)before.taken,
                (unsigned long long)after.taken, (unsigned long long)flags);
            goto failed;
        }
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "carry mask: RED bits=%u compare=%u inverse=%u mask=%x status=%d work/span=%u/%u source/normalized=%u/%u comparisons=%llu\n",
        bits, compare_bits, inverse, mask, status, work, span, selected.copied_source,
        selected.normalized_family_present, (unsigned long long)*comparisons);
    if (!status) {
        for (pl_u32 i = 0u; i < block.plan.node_count; ++i) {
            const pl_node *node = &block.plan.nodes[i];
            fprintf(stderr, " node%u op%u", i + 1u, node->opcode);
            for (pl_u32 j = 0u; j < node->argument_count; ++j) {
                pl_operand argument = block.plan.arguments[node->argument_at + j];
                fprintf(stderr, " %u:%llx", argument.kind, (unsigned long long)argument.value);
            }
            fputc('\n', stderr);
        }
        fprintf(stderr, " code:");
        for (pl_u32 i = 0u; i < written; ++i) fprintf(stderr, " %02x", memory[512u + i]);
        fputc('\n', stderr);
    }
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
    for (pl_u32 bits = 32u; bits <= 64u; bits *= 2u)
        for (pl_u32 mode = 0u; mode < 5u; ++mode)
            for (pl_u32 code = 0u; code < 16u; ++code)
                for (pl_u32 alias = 0u; alias < 2u; ++alias)
                    if (!check_group(bits, mode, code, alias, 0u, &comparisons)) return 1;
    for (pl_u32 bits = 32u; bits <= 64u; bits *= 2u)
        for (pl_u32 mode = 0u; mode < 5u; ++mode)
            for (pl_u32 code = 0u; code < 16u; ++code)
                for (pl_u32 branch = 1u; branch <= 2u; ++branch)
                    if (!check_group(bits, mode, code, 0u, branch, &comparisons)) return 1;
    static const pl_u32 masks[] = { 0x4653601u, 0x7fffffffu, 0x80000000u, 0xaaaaaaaau, UINT32_MAX };
    for (pl_u32 bits = 32u; bits <= 64u; bits *= 2u)
        for (pl_u32 mode = 0u; mode < 6u; ++mode)
            for (pl_u32 code = 0u; code < 16u; ++code)
                for (pl_u32 branch = 3u; branch <= 4u; ++branch)
                    if (!check_group(bits, mode, code, 0u, branch, &comparisons)) return 1;
    for (pl_u32 bits = 32u; bits <= 64u; bits *= 2u)
        for (pl_u32 compare = 8u; compare <= 64u; compare *= 2u)
            for (pl_u32 inverse = 0u; inverse < 2u; ++inverse)
                for (pl_u32 i = 0u; i < sizeof masks / sizeof masks[0]; ++i)
                    if (!check_mask(bits, compare, inverse, masks[i], &comparisons)) return 1;
    printf("carry cut: green (%llu source/generated/reference comparisons; "
           "CF/!CF arithmetic/masks, shared ALU/SETcc, aliased inputs, independent final flags/branch)\n",
           (unsigned long long)comparisons);
    return 0;
}
