#define _GNU_SOURCE
#include "../src/internal/select-x86.h"
#include "execute.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#if !defined(__x86_64__)
#error This check executes x86-64 instructions on the host CPU.
#endif

typedef struct { pl_u64 copy, input, flags, taken; } observation;
typedef void (__attribute__((sysv_abi)) *leaf_function)(
    observation *, pl_u64, pl_u64, pl_u64);

static pl_u64 flags_for(pl_u64 left, pl_u64 right, pl_u32 bits, pl_u32 test)
{
    pl_u64 mask = UINT64_MAX >> (64u - bits), sign = 1ull << (bits - 1u);
    left &= mask;
    right &= mask;
    pl_u64 result = (test ? left & right : left - right) & mask;
    pl_u32 parity = 0u;
    for (pl_u32 i = 0u; i < 8u; ++i) parity ^= (pl_u32)(result >> i) & 1u;
    pl_u64 flags = (!parity ? 4u : 0u) | (!result ? 64u : 0u)
                 | (result & sign ? 128u : 0u);
    if (!test) flags |= (left < right ? 1u : 0u)
                     | ((left ^ right ^ result) & 16u)
                     | ((left ^ right) & (left ^ result) & sign ? 2048u : 0u);
    return flags;
}

static pl_u32 condition(pl_u32 code, pl_u64 flags)
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

static int check_case(pl_u32 bits, pl_u32 test, pl_u32 immediate,
                      pl_u32 code, pl_u32 expression, pl_u64 *comparisons)
{
    static const pl_u8 prefix[] = { 0x49u, 0x89u, 0xf2u }; /* mov r10,rsi */
    pl_u8 source[32] = { 0x48u, 0x89u, 0xc8u }; /* mov rax,rcx */
    pl_u32 length = 3u;
    if (expression == 2u) { source[0] = 0x31u; source[1] = 0xc0u; length = 2u; }
    const pl_u64 compare_value = expression ? 64u : 4u;
    if (expression == 1u) {
        static const pl_u8 pure[] = {
            0x41u, 0x83u, 0xe2u, 0x42u, /* and r10d,0x42 */
            0x48u, 0xc1u, 0xe0u, 0x0cu, /* shl rax,12 */
        };
        memcpy(source + length, pure, sizeof pure);
        length += sizeof pure;
    }
    if (bits == 16u) source[length++] = 0x66u;
    source[length++] = bits == 64u ? 0x49u : 0x41u;
    if (immediate) {
        source[length++] = test ? (bits == 8u ? 0xf6u : 0xf7u)
                                : (bits == 8u ? 0x80u : 0x81u);
        source[length++] = test ? 0xc2u : 0xfau;
        pl_u32 bytes = bits == 8u ? 1u : bits == 16u ? 2u : 4u;
        for (pl_u32 i = 0u; i < bytes; ++i)
            source[length++] = i ? 0u : (pl_u8)compare_value;
    } else {
        source[length++] = test ? (bits == 8u ? 0x84u : 0x85u)
                                : (bits == 8u ? 0x38u : 0x39u);
        source[length++] = 0xd2u; /* r10 low word and rdx low word */
    }
    if (expression < 2u) {
        source[length++] = (pl_u8)(0x70u | code);
        source[length++] = 8u;
    } else {
        if (expression == 3u) {
            source[length++] = 0x41u; source[length++] = 0xbau;
            for (pl_u32 i = 0u; i < 4u; ++i) source[length++] = 0u;
            source[length++] = 0x41u;
        }
        source[length++] = 0x0fu;
        source[length++] = (pl_u8)(0x90u | code);
        source[length++] = expression == 3u ? 0xc2u : 0xc0u;
    }
    static const pl_u8 observe[] = {
        0x41u, 0xb9u, 0u, 0u, 0u, 0u, 0xebu, 0x06u,
        0x41u, 0xb9u, 1u, 0u, 0u, 0u,
        0x48u, 0x89u, 0x07u,             /* mov [rdi],rax */
        0x4cu, 0x89u, 0x57u, 0x08u,      /* mov [rdi+8],r10 */
        0x9cu, 0x59u,                   /* pushfq; pop rcx */
        0x48u, 0x89u, 0x4fu, 0x10u,
        0x4cu, 0x89u, 0x4fu, 0x18u,
        0xc3u,
    };
    pl_u8 *memory = test_code_allocate(4096u);
    if (!memory) return 0;
    pl_u64 address = (pl_u64)(uintptr_t)(memory + sizeof prefix);
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
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(
        &frontend, address, address + length,
        (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status) {
        block.relax_short_control = 1u;
        status = pl_x86_select_candidates(&frontend, &selection_workspace, &block, &candidates);
    }
    pl_u32 span = 0u, work = 0u;
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
    pl_u8 *output = memory + 512u + sizeof prefix;
    pl_u32 written = 0u;
    if (status || !selected.normalized_family_present || selected.copied_source
            || work > (expression == 1u ? 5u : expression == 3u ? 4u : 3u)
            || span > (expression == 1u ? 3u : 2u)) goto failed;
    status = pl_x86_select_write_measured(
        &frontend, &block, &selected, output, 256u, &written);
    if (status || written != selected.output_bytes) goto failed;
    for (pl_u32 i = 0u; i < selected.fixup_count; ++i) {
        if (selected.fixups[i].target != address + length + 8u) goto failed;
        if (pl_x86_select_bind_fixup(output, written, &selected, i,
                (pl_u64)(uintptr_t)output,
                (pl_u64)(uintptr_t)(output + written + 8u))) goto failed;
    }
    memcpy(memory, prefix, sizeof prefix);
    memcpy(memory + sizeof prefix, source, length);
    memcpy(memory + sizeof prefix + length, observe, sizeof observe);
    memcpy(memory + 512u, prefix, sizeof prefix);
    memcpy(output + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory;
    optimized.object = memory + 512u;
    static const pl_u64 boundary[] = {
        0u, 1u, 3u, 4u, 5u, 127u, 128u, 255u, 256u, 32767u, 32768u,
        65535u, 65536u, 0x7fffffffu, 0x80000000u, UINT32_MAX,
        1ull << 32u, 1ull << 63u, UINT64_MAX };
    const pl_u32 count = sizeof boundary / sizeof boundary[0];
    pl_u64 random = 0x6a09e667f3bcc909ull;
    for (pl_u32 i = 0u; i < 4096u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 left = i < count * count ? boundary[i % count] : random;
        pl_u64 right = i < count * count ? boundary[i / count] : ~random;
        pl_u64 expected_input = expression == 1u ? left & 0x42u : left;
        pl_u64 expected_copy = expression == 1u ? random << 12u : random;
        pl_u64 flags = flags_for(expected_input, immediate ? compare_value : right, bits, test);
        if (expression == 2u) expected_copy = condition(code, flags);
        if (expression == 3u) expected_input = condition(code, flags);
        pl_u64 mask = test ? 0x8c5u : 0x8d5u; /* TEST leaves AF undefined. */
        observation before = { 0 }, after = { 0 };
        original.function(&before, left, right, random);
        optimized.function(&after, left, right, random);
        if (before.copy != expected_copy || after.copy != expected_copy
                || before.input != expected_input || after.input != expected_input
                || (before.flags & mask) != flags || (after.flags & mask) != flags
                || before.taken != (expression < 2u ? condition(code, flags) : 0u)
                || after.taken != (expression < 2u ? condition(code, flags) : 0u)) {
            fprintf(stderr, "compare cut mismatch input=%llx/%llx\n",
                    (unsigned long long)left, (unsigned long long)right);
            goto failed;
        }
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "compare cut: RED bits=%u test=%u immediate=%u cc=%u expression=%u "
            "status=%d work/span=%u/%u\n", bits, test, immediate, code, expression,
            status, work, span);
    test_code_release(memory, 4096u);
    return 0;
}

int main(void)
{
    pl_u64 comparisons = 0u;
    for (pl_u32 bits = 8u; bits <= 64u; bits *= 2u)
        for (pl_u32 test = 0u; test < 2u; ++test)
            for (pl_u32 immediate = 0u; immediate < 2u; ++immediate)
                for (pl_u32 code = 0u; code < 16u; ++code)
                    for (pl_u32 expression = 0u; expression < (test ? 4u : 2u); ++expression)
                        if (!check_case(bits, test, immediate, code, expression,
                                         &comparisons)) return 1;
    printf("compare cut: green (%llu source/generated/reference comparisons; "
           "8/16/32/64-bit CMP/TEST, immediate/register, all Jcc/SETcc, pure/aliased publications)\n",
           (unsigned long long)comparisons);
    return 0;
}
