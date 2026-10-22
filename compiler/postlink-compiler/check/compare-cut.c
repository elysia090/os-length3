#define _GNU_SOURCE
#include "../src/internal/x86-selection.h"
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
                      pl_u32 code, pl_u32 expression, pl_u32 branch, pl_u64 *comparisons)
{
    static const pl_u8 prefix[] = { 0x49u, 0x89u, 0xf2u }; /* mov r10,rsi */
    pl_u8 source[64] = { 0x48u, 0x89u, 0xc8u }; /* mov rax,rcx */
    pl_u32 length = 3u;
    if (expression == 9u) {
        const pl_u8 seed[] = { 0xb8u, 1u, 0u, 0u, 0x80u };
        memcpy(source, seed, sizeof seed); length = sizeof seed;
    }
    if (expression == 10u) { source[0] = 0x4cu; source[2] = 0xd0u; } /* mov rax,r10 */
    if (expression == 2u) { source[0] = 0x31u; source[1] = 0xc0u; length = 2u; }
    pl_u64 compare_value = expression ? 64u : 4u;
    if (immediate == 2u) compare_value = bits == 64u ? 0xffffffff80000000ull
        : (1ull << (bits - 1u)) | (bits == 16u ? 1u : 0u);
    if (immediate == 3u) compare_value = UINT64_MAX >> (64u - bits);
    if (expression == 1u) {
        static const pl_u8 pure[] = {
            0x41u, 0x83u, 0xe2u, 0x42u, /* and r10d,0x42 */
            0x48u, 0xc1u, 0xe0u, 0x0cu, /* shl rax,12 */
        };
        memcpy(source + length, pure, sizeof pure);
        length += sizeof pure;
    }
    if (expression >= 4u && expression < 7u) {
        static const pl_u8 pure[] = { 0x83u, 0xe0u, 0x42u, 0x48u, 0xc1u, 0xe0u, 12u };
        memcpy(source + length, pure, sizeof pure); length += sizeof pure;
    }
    if (bits == 16u) source[length++] = 0x66u;
    source[length++] = bits == 64u ? 0x49u : 0x41u;
    if (immediate) {
        source[length++] = test ? (bits == 8u ? 0xf6u : 0xf7u)
                                : (bits == 8u ? 0x80u : 0x81u);
        source[length++] = test ? 0xc2u : 0xfau;
        pl_u32 bytes = bits == 8u ? 1u : bits == 16u ? 2u : 4u;
        for (pl_u32 i = 0u; i < bytes; ++i)
            source[length++] = (pl_u8)(compare_value >> (i * 8u));
    } else {
        source[length++] = test ? (bits == 8u ? 0x84u : 0x85u)
                                : (bits == 8u ? 0x38u : 0x39u);
        source[length++] = 0xd2u; /* r10 low word and rdx low word */
    }
    if (expression < 2u) {
        source[length++] = (pl_u8)(0x70u | code);
        source[length++] = 8u;
    } else if (expression < 4u) {
        if (expression == 3u) {
            source[length++] = 0x41u; source[length++] = 0xbau;
            for (pl_u32 i = 0u; i < 4u; ++i) source[length++] = 0u;
            source[length++] = 0x41u;
        }
        source[length++] = 0x0fu;
        source[length++] = (pl_u8)(0x90u | code);
        source[length++] = expression == 3u ? 0xc2u : 0xc0u;
    } else if (expression < 7u) {
        source[length++] = 0x4cu; source[length++] = 0x0fu;
        source[length++] = (pl_u8)(0x40u | code); source[length++] = 0xd2u;
        source[length++] = 0x4du;
        if (expression == 6u) source[length++] = 0x63u;
        else {
            source[length++] = 0x0fu;
            source[length++] = expression == 4u ? 0xbeu : 0xbfu;
        }
        source[length++] = 0xd2u; /* sign-extend selected r10b/r10w/r10d */
    } else if (expression == 7u) {
        source[length++] = 0xb8u;
        for (pl_u32 i = 0u; i < 4u; ++i) source[length++] = 0u;
        source[length++] = 0x41u; source[length++] = 0xbau;
        source[length++] = 1u; source[length++] = 0u;
        source[length++] = 0u; source[length++] = 0x80u;
    } else {
        /* The comparison consumes old r10; CMOV consumes its new publication.
         * Candidate r10 remains a full 64-bit output even for CMOV r32. */
        const pl_u8 candidate[] = { 0x49u, 0xbau, 0xbbu, 0x7du, 0x8du, 0x81u,
            0xffu, 0xffu, 0xffu, 0xffu };
        memcpy(source + length, candidate, sizeof candidate); length += sizeof candidate;
        source[length++] = expression == 11u ? 0x41u : 0x49u;
        source[length++] = 0x0fu; source[length++] = (pl_u8)(0x40u | code);
        source[length++] = 0xc2u; /* cmovcc rax,r10 */
        const pl_u8 final_compare[] = { 0x48u, 0x83u, 0xfau, 1u };
        if (branch < 2u) {
            memcpy(source + length, final_compare, sizeof final_compare); length += sizeof final_compare;
        }
        if (branch == 1u) { source[length++] = (pl_u8)(0x70u | code); source[length++] = 8u; }
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
            || work > (branch == 2u ? 4u : expression == 7u ? 3u : expression >= 4u ? 6u : expression == 1u ? 5u : expression == 3u ? 4u : 3u)
            || span > (expression >= 8u ? 3u : expression == 7u ? 2u : expression >= 4u ? 3u : expression == 1u ? 3u : 2u)) goto failed;
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
        if (expression >= 4u && expression < 7u) {
            pl_u32 width = 8u << (expression - 4u);
            pl_u64 sign = 1ull << (width - 1u);
            expected_copy = (random & 0x42u) << 12u;
            expected_input = condition(code, flags) ? right : left;
            expected_input &= (1ull << width) - 1u;
            expected_input = (expected_input ^ sign) - sign;
        }
        if (expression == 7u) { expected_copy = 0u; expected_input = 0x80000001u; }
        if (expression >= 8u) {
            expected_input = 0xffffffff818d7dbbull;
            pl_u64 seed = expression == 9u ? 0x80000001u : expression == 10u ? left : random;
            expected_copy = condition(code, flags) ? expected_input : seed;
            if (expression == 11u) expected_copy &= UINT32_MAX;
            if (branch < 2u) flags = flags_for(right, 1u, 64u, 0u);
        }
        pl_u64 mask = test ? 0x8c5u : 0x8d5u; /* TEST leaves AF undefined. */
        if (expression >= 8u && branch < 2u) mask = 0x8d5u;
        observation before = { 0 }, after = { 0 };
        original.function(&before, left, right, random);
        optimized.function(&after, left, right, random);
        if (before.copy != expected_copy || after.copy != expected_copy
                || before.input != expected_input || after.input != expected_input
                || (before.flags & mask) != flags || (after.flags & mask) != flags
                || before.taken != (expression < 2u || branch == 1u ? condition(code, flags) : 0u)
                || after.taken != (expression < 2u || branch == 1u ? condition(code, flags) : 0u)) {
            fprintf(stderr, "compare cut mismatch input=%llx/%llx\n",
                    (unsigned long long)left, (unsigned long long)right);
            goto failed;
        }
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "compare cut: RED bits=%u test=%u immediate=%u cc=%u expression=%u branch=%u "
            "status=%d work/span=%u/%u\n", bits, test, immediate, code, expression,
            branch, status, work, span);
    test_code_release(memory, 4096u);
    return 0;
}

/* The predicate is produced before the slice. Its SETcc must precede every
 * clobber in the following value tree, not only the tree's final producer. */
static int check_entry_flags(pl_u32 bits, pl_u32 code, pl_u32 group,
                              pl_u32 mode, pl_u32 accumulator,
                              pl_u32 immediate, pl_u64 *comparisons)
{
    pl_u8 prefix[] = {
        0x49u, 0x89u, 0xf0u, /* mov r8,rsi */
        0x49u, 0x89u, 0xd1u, /* mov r9,rdx */
        0x48u, 0x39u, 0xceu, /* cmp rsi,rcx */
    };
    const pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                                    | (accumulator ? 0u : 1u));
    pl_u8 source[16] = {
        0x41u, 0x0fu, (pl_u8)(0x90u + code), 0xc1u, /* SETcc r9b */
        rex, 0xc1u,
        (pl_u8)(0xc0u | (group << 3u)), 8u, /* shift value,8 */
        rex, 0x83u,
        (pl_u8)(0xc0u | (mode << 3u)), 1u, /* AND/OR/XOR value,immediate */
    };
    pl_u32 length = 12u;
    if (immediate != 1u) {
        source[9] = 0x81u;
        for (pl_u32 i = 0u; i < 4u; ++i)
            source[11u + i] = (pl_u8)(immediate >> (8u * i));
        length = 15u;
    }
    pl_u8 observe[] = {
        0x4cu, 0x89u, 0x07u,       /* mov [rdi],r8 */
        0x4cu, 0x89u, 0x4fu, 8u,  /* mov [rdi+8],r9 */
        0x9cu, 0x58u,             /* pushfq; pop rax */
        0x48u, 0x89u, 0x47u, 16u, /* mov [rdi+16],rax */
        0xc3u,
    };
    if (accumulator) {
        prefix[0] = 0x48u; /* mov rax,rsi instead of mov r8,rsi */
        observe[0] = 0x48u; /* observe RAX before POP overwrites it */
    }
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
    pl_u32 span = 0u, work = 0u, written = 0u;
    pl_u8 *output = memory + 512u + sizeof prefix;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(
        &frontend, address, address + length,
        (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status) status = pl_x86_select_candidates(
        &frontend, &selection_workspace, &block, &candidates);
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, &selected, &span, &work);
    if (status || selected.copied_source || !selected.normalized_family_present
            || work > 3u || span > 3u) goto failed;
    status = pl_x86_select_write_measured(
        &frontend, &block, &selected, output, 256u, &written);
    if (status || written != selected.output_bytes || selected.fixup_count)
        goto failed;
    memcpy(memory, prefix, sizeof prefix);
    memcpy(memory + sizeof prefix, source, length);
    memcpy(memory + sizeof prefix + length, observe, sizeof observe);
    memcpy(memory + 512u, prefix, sizeof prefix);
    memcpy(output + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory;
    optimized.object = memory + 512u;
    static const pl_u64 boundary[] = { 0u, 1u, 4u, 255u, 256u, 65535u,
        0x7fffffffu, 0x80000000u, UINT32_MAX, 1ull << 32u,
        1ull << 63u, UINT64_MAX };
    const pl_u32 count = sizeof boundary / sizeof boundary[0];
    const pl_u64 mask = UINT64_MAX >> (64u - bits);
    pl_u64 random = 0x6a09e667f3bcc909ull;
    for (pl_u32 i = 0u; i < 4096u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 left = i < count * count ? boundary[i % count] : random;
        pl_u64 right = i < count * count ? boundary[i / count] : ~random;
        pl_u64 seed = random * 17u;
        pl_u64 value = left & mask;
        pl_u64 shifted = group == 4u ? (value << 8u) & mask : value >> 8u;
        if (group == 7u && (value & (1ull << (bits - 1u))))
            shifted |= mask ^ (mask >> 8u);
        pl_u64 expected = mode == 4u ? shifted & immediate
                        : mode == 1u ? shifted | immediate : shifted ^ immediate;
        pl_u64 boolean = condition(code, flags_for(left, right, 64u, 0u));
        pl_u64 expected_seed = (seed & ~255ull) | boolean;
        pl_u64 flags = flags_for(expected, expected, bits, 1u);
        observation before = { 0 }, after = { 0 };
        original.function(&before, left, seed, right);
        optimized.function(&after, left, seed, right);
        if (before.copy != expected || after.copy != expected
                || before.input != expected_seed || after.input != expected_seed
                || (before.flags & 0x8c5u) != flags
                || (after.flags & 0x8c5u) != flags) {
            fprintf(stderr, "entry flags mismatch input=%llx/%llx "
                    "expected=%llx/%llx/%llx source=%llx/%llx/%llx "
                    "output=%llx/%llx/%llx\n",
                    (unsigned long long)left, (unsigned long long)right,
                    (unsigned long long)expected, (unsigned long long)expected_seed,
                    (unsigned long long)flags,
                    (unsigned long long)before.copy, (unsigned long long)before.input,
                    (unsigned long long)before.flags,
                    (unsigned long long)after.copy, (unsigned long long)after.input,
                    (unsigned long long)after.flags);
            goto failed;
        }
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "entry flags: RED bits=%u cc=%u shift=%u ALU=%u "
            "accumulator=%u immediate=%x "
            "status=%d work/span=%u/%u\n", bits, code, group, mode,
            accumulator, immediate, status, work, span);
    if (!status) {
        fprintf(stderr, "  generated:");
        for (pl_u32 i = 0u; i < written; ++i)
            fprintf(stderr, " %02x", output[i]);
        fputc('\n', stderr);
    }
    test_code_release(memory, 4096u);
    return 0;
}

/* A preserving extension is not an addressing-mode operand until it has
 * actually been published. Check every admitted spelling, not only the
 * selected Pareto member: another caller may select a different equal-cost
 * candidate from the same grammar. */
static int check_address_flags(pl_u32 extension, pl_u32 code,
                                pl_u64 *comparisons)
{
    static const pl_u8 extensions[][4] = {
        { 0x4cu, 0x0fu, 0xbeu, 0xc6u }, /* movsbq sil,r8 */
        { 0x4cu, 0x0fu, 0xbfu, 0xc6u }, /* movswq si,r8 */
        { 0x4cu, 0x63u, 0xc6u, 0u },    /* movslq esi,r8 */
        { 0x44u, 0x0fu, 0xb6u, 0xc6u }, /* movzbl sil,r8d */
        { 0x44u, 0x0fu, 0xb7u, 0xc6u }, /* movzwl si,r8d */
    };
    pl_u8 source[32];
    pl_u32 length = extension == 2u ? 3u : 4u;
    memcpy(source, extensions[extension], length);
    static const pl_u8 add_compare[] = {
        0x49u, 0x01u, 0xc8u, /* add rcx,r8 */
        0x39u, 0xf2u,       /* cmp esi,edx */
    };
    memcpy(source + length, add_compare, sizeof add_compare);
    length += sizeof add_compare;
    source[length++] = (pl_u8)(0x70u + code);
    source[length++] = 8u;
    static const pl_u8 observe[] = {
        0x41u, 0xb9u, 0u, 0u, 0u, 0u, 0xebu, 6u,
        0x41u, 0xb9u, 1u, 0u, 0u, 0u,
        0x4cu, 0x89u, 0x07u,       /* mov [rdi],r8 */
        0x48u, 0x89u, 0x77u, 8u,  /* mov [rdi+8],rsi */
        0x9cu, 0x58u,
        0x48u, 0x89u, 0x47u, 16u, /* mov [rdi+16],flags */
        0x4cu, 0x89u, 0x4fu, 24u, /* mov [rdi+24],r9 */
        0xc3u,
    };
    enum { CODE_BYTES = 8192 };
    pl_u8 *memory = test_code_allocate(CODE_BYTES);
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
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(
        &frontend, address, address + length,
        (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status) {
        block.relax_short_control = 1u;
        status = pl_x86_select_candidates(
            &frontend, &selection_workspace, &block, &candidates);
    }
    if (status) goto failed;
    memcpy(memory, source, length);
    memcpy(memory + length, observe, sizeof observe);
    pl_u32 generated = 0u;
    for (pl_u32 i = 0u; i < candidates.count; ++i) {
        const pl_x86_native_selection *candidate = &candidates.candidate[i];
        if (!candidate->supported) continue;
        if (!candidate->copied_source) ++generated;
        pl_u8 *output = memory + 512u + i * 256u;
        pl_u32 written = 0u;
        if (pl_x86_select_write_measured(
                &frontend, &block, candidate, output, 192u, &written)
                || written != candidate->output_bytes) goto failed;
        for (pl_u32 j = 0u; j < candidate->fixup_count; ++j)
            if (candidate->fixups[j].target != address + length + 8u
                    || pl_x86_select_bind_fixup(
                        output, written, candidate, j,
                        (pl_u64)(uintptr_t)output,
                        (pl_u64)(uintptr_t)(output + written + 8u)))
                goto failed;
        memcpy(output + written, observe, sizeof observe);
    }
    if (!generated || !test_code_publish(memory, CODE_BYTES)) goto failed;
    static const pl_u64 boundary[] = {
        0u, 1u, 255u, 256u, 32767u, 32768u, 65535u, 65536u,
        0x7fffffffu, 0x80000000u, UINT32_MAX, 1ull << 32u,
        1ull << 63u, UINT64_MAX,
    };
    const pl_u32 count = sizeof boundary / sizeof boundary[0];
    pl_u64 random = 0x6a09e667f3bcc909ull;
    for (pl_u32 sample = 0u; sample < 4096u; ++sample) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 left = sample < count * count ? boundary[sample % count] : random;
        pl_u64 right = sample < count * count ? boundary[sample / count] : ~random;
        pl_u32 width = extension < 3u ? 8u << extension
                      : extension == 3u ? 8u : 16u;
        pl_u64 value = left & (UINT64_MAX >> (64u - width));
        if (extension < 3u) {
            pl_u64 sign = 1ull << (width - 1u);
            value = (value ^ sign) - sign;
        }
        pl_u64 flags = flags_for(right, left, 32u, 0u);
        observation expected = { value + random, left, flags,
                                  condition(code, flags) };
        for (pl_u32 i = 0u; i <= candidates.count; ++i) {
            if (i && !candidates.candidate[i - 1u].supported) continue;
            union { void *object; leaf_function function; } run;
            run.object = i ? memory + 512u + (i - 1u) * 256u : memory;
            observation actual = { 0 };
            run.function(&actual, left, right, random);
            if (actual.copy != expected.copy || actual.input != expected.input
                    || (actual.flags & 0x8d5u) != expected.flags
                    || actual.taken != expected.taken) {
                fprintf(stderr, "address flags mismatch extension=%u cc=%u "
                        "candidate=%u input=%llx/%llx\n", extension, code, i,
                        (unsigned long long)left, (unsigned long long)right);
                goto failed;
            }
            ++*comparisons;
        }
    }
    test_code_release(memory, CODE_BYTES);
    return 1;
failed:
    fprintf(stderr, "address flags: RED extension=%u cc=%u status=%d\n",
            extension, code, status);
    test_code_release(memory, CODE_BYTES);
    return 0;
}

int main(void)
{
    pl_u64 comparisons = 0u;
    for (pl_u32 bits = 8u; bits <= 64u; bits *= 2u)
        for (pl_u32 test = 0u; test < 2u; ++test)
            for (pl_u32 immediate = 0u; immediate < 4u; ++immediate)
                for (pl_u32 code = 0u; code < 16u; ++code)
                    for (pl_u32 expression = 0u; expression < 12u; ++expression)
                        for (pl_u32 branch = 0u; branch <= (expression >= 8u ? 2u : 0u); ++branch)
                            if ((test || expression < 2u || expression >= 4u)
                                    && !check_case(bits, test, immediate, code, expression,
                                             branch, &comparisons)) return 1;
    pl_u64 entry_comparisons = 0u;
    static const pl_u32 groups[] = { 4u, 5u, 7u }, modes[] = { 1u, 4u, 6u };
    static const pl_u32 immediates[] = { 1u, 0x100u, 0x10000u };
    for (pl_u32 bits = 32u; bits <= 64u; bits *= 2u)
        for (pl_u32 code = 0u; code < 16u; ++code)
            for (pl_u32 group = 0u; group < 3u; ++group)
                for (pl_u32 mode = 0u; mode < 3u; ++mode)
                    for (pl_u32 accumulator = 0u; accumulator < 2u; ++accumulator)
                        for (pl_u32 immediate = 0u; immediate < 3u; ++immediate)
                            if (!check_entry_flags(bits, code, groups[group], modes[mode],
                                    accumulator, immediates[immediate],
                                    &entry_comparisons)) return 1;
    pl_u64 address_comparisons = 0u;
    for (pl_u32 extension = 0u; extension < 5u; ++extension)
        for (pl_u32 code = 0u; code < 16u; ++code)
            if (!check_address_flags(extension, code, &address_comparisons))
                return 1;
    printf("address flags: green (%llu source/all-candidates/reference "
           "comparisons; signed/unsigned extensions, all Jcc, full flags)\n",
           (unsigned long long)address_comparisons);
    printf("entry flags: green (%llu source/generated/reference comparisons; "
           "all SETcc, 32/64-bit shifts, logical value-tree preloads, "
           "low/high-byte and upper-bit masks)\n",
           (unsigned long long)entry_comparisons);
    printf("compare cut: green (%llu source/generated/reference comparisons; "
           "8/16/32/64-bit CMP/TEST, signed immediates/registers, all Jcc/SETcc/CMOV, signed and aliased publications)\n",
           (unsigned long long)comparisons);
    return 0;
}
