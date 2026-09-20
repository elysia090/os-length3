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

/* Flattened sums are not necessarily one flag-preserving LEA: a projected
 * low word can require MOV and ADD. Check every candidate, including one
 * rejected by the final cost gate, with both branch outcomes observable. */
static int check_projected_sum(pl_u32 bits, pl_u32 code, pl_u64 *comparisons)
{
    pl_u8 source[32];
    pl_u32 length = 0u;
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x89u; source[length++] = 0xd1u;
    const pl_u8 tail[] = {
        0xb8u,63u,0u,0u,0u, 0x4cu,0x01u,0xf9u,
        0x48u,0x29u,0xc8u, 0x4cu,0x01u,0xe9u,
        0x48u,0x83u,0xf8u,8u, (pl_u8)(0x70u | code),8u,
    };
    memcpy(source + length, tail, sizeof tail); length += sizeof tail;
    static const pl_u8 setup[] = {
        0x41u,0x55u, 0x41u,0x57u, /* preserve r13/r15 */
        0x49u,0x89u,0xcdu, 0x49u,0x89u,0xd7u, 0x48u,0x89u,0xf2u,
    };
    static const pl_u8 observe[] = {
        0x41u,0xb9u,0u,0u,0u,0u, 0xebu,6u,
        0x41u,0xb9u,1u,0u,0u,0u,
        0x48u,0x89u,0x07u, 0x48u,0x89u,0x4fu,8u,
        0x9cu,0x59u, 0x48u,0x89u,0x4fu,16u, 0x4cu,0x89u,0x4fu,24u,
        0x41u,0x5fu, 0x41u,0x5du, 0xc3u,
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
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,address,address+length,
        (1u << PL_X86_LOCAL_COUNT) - 1u,&workspace,&block);
    if (!status) status = pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count < 2u) goto failed;
    memcpy(memory,setup,sizeof setup);
    memcpy(memory+sizeof setup,source,length);
    memcpy(memory+sizeof setup+length,observe,sizeof observe);
    for (pl_u32 i = 0u; i < candidates.count; ++i) {
        pl_x86_native_selection *candidate = &candidates.candidate[i];
        pl_u8 *start = memory + (i + 1u) * 512u, *body = start + sizeof setup;
        pl_u32 written = 0u;
        memcpy(start,setup,sizeof setup);
        status = pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
        if (status) goto failed;
        for (pl_u32 j = 0u; j < candidate->fixup_count; ++j) {
            if (candidate->fixups[j].target != address + length + 8u) goto failed;
            status = pl_x86_select_bind_fixup(body,written,candidate,j,
                (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written+8u));
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    static const pl_u64 edge[] = {0u,1u,7u,8u,55u,56u,63u,64u,127u,128u,
        0x7fffffffu,0x80000000u,UINT32_MAX,1ull<<32u,1ull<<63u,UINT64_MAX};
    pl_u64 random = 0x57ac09bb4268ffeeull;
    for (pl_u32 sample = 0u; sample < 2048u; ++sample) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 index = sample < 256u ? edge[sample & 15u] : random;
        pl_u64 base = sample < 256u ? edge[sample >> 4u] : ~random * 17u;
        pl_u64 extra = sample & 1u ? UINT64_MAX : random * 7u;
        pl_u64 parent = base + (bits == 32u ? (pl_u32)index : index);
        pl_u64 value = 63u - parent, joined = parent + extra;
        pl_u64 flags = flags_for(value,8u,64u,0u);
        for (pl_u32 i = 0u; i <= candidates.count; ++i) {
            union { void *object; leaf_function function; } fn;
            fn.object = memory + i * 512u;
            observation actual = {0};
            fn.function(&actual,index,base,extra);
            if (actual.copy != value || actual.input != joined
                    || (actual.flags & 0x8d5u) != flags
                    || actual.taken != condition(code,flags)) {
                fprintf(stderr,"projected sum: mismatch candidate=%u input=%llx/%llx/%llx "
                    "flags=%llx expected=%llx taken=%llu expected=%u values=%llx/%llx expected=%llx/%llx\n",i,
                    (unsigned long long)index,(unsigned long long)base,(unsigned long long)extra,
                    (unsigned long long)(actual.flags & 0x8d5u),(unsigned long long)flags,
                    (unsigned long long)actual.taken,condition(code,flags),
                    (unsigned long long)actual.copy,(unsigned long long)actual.input,
                    (unsigned long long)value,(unsigned long long)joined);
                if (i) {
                    pl_u8 bytes[256];pl_u32 written=0u;
                    if (!pl_x86_select_write_measured(&frontend,&block,&candidates.candidate[i-1u],
                            bytes,sizeof bytes,&written)) {
                        for (pl_u32 at=0u;at<written;++at) fprintf(stderr,"%02x ",bytes[at]);
                        fputc('\n',stderr);
                    }
                }
                goto failed;
            }
            ++*comparisons;
        }
    }
    test_code_release(memory,16384u);
    return 1;
failed:
    fprintf(stderr,"projected sum: RED bits/cc=%u/%u status=%d\n",bits,code,status);
    test_code_release(memory,16384u);
    return 0;
}

/* With no spare owner the dense candidate must decline instead of clobbering
 * a live arm. With one spare owner it must emit and execute the seeded form;
 * testing both prevents candidate rejection from hiding a broken alias rule. */
static int check_seeded_compare_lifetime(pl_u32 shift, pl_u32 code, pl_u32 spare,
                                         pl_u64 *comparisons)
{
    typedef struct { pl_u64 first, second, sum, flags, taken, spare; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, const pl_u64 *);
    const pl_u8 instructions[] = {
        0x48u,0xc1u,0xe0u,(pl_u8)shift, 0x48u,0x89u,0xc1u,
        0x48u,0x29u,0xd1u, 0x48u,0x83u,0xc2u,1u, 0x48u,0x83u,0xe9u,1u,
        0x48u,0x89u,0xf1u, 0x48u,0x0fu,0x48u,0xc2u,
        0x48u,0xc1u,0xe1u,(pl_u8)shift, 0x48u,0x83u,0xc1u,63u,
        0x4au,0x8du,0x14u,1u, 0x49u,0x39u,0xd1u, 0x49u,0x0fu,0x48u,0xcau,
        0x48u,0x39u,0xc1u, (pl_u8)(0x70u | code),8u,
    };
    pl_u8 source[sizeof instructions + 5u];
    pl_u32 length = sizeof instructions - 5u;
    memcpy(source,instructions,length);
    if (spare) {
        source[length++] = 0xbbu; /* mov ebx,0 makes one disposable owner */
        for (pl_u32 i = 0u; i < 4u; ++i) source[length++] = 0u;
    }
    memcpy(source+length,instructions+sizeof instructions-5u,5u); length += 5u;
    static const pl_u8 setup[] = {
        0x53u, /* preserve rbx */
        0x49u,0x89u,0xf3u, /* r11 = inputs */
        0x49u,0x8bu,0x03u, 0x49u,0x8bu,0x53u,8u,
        0x4du,0x8bu,0x43u,24u, 0x4du,0x8bu,0x4bu,32u,
        0x4du,0x8bu,0x53u,40u, 0x49u,0x8bu,0x73u,16u,
    };
    static const pl_u8 observe[] = {
        0x41u,0xbbu,0u,0u,0u,0u, 0xebu,6u,
        0x41u,0xbbu,1u,0u,0u,0u,
        0x48u,0x89u,0x07u, 0x48u,0x89u,0x4fu,8u, 0x48u,0x89u,0x57u,16u,
        0x9cu,0x59u, 0x48u,0x89u,0x4fu,24u, 0x4cu,0x89u,0x5fu,32u,
        0x48u,0x89u,0x5fu,40u,0x5bu,0xc3u,
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
    int status = pl_x86_frontend_open(&image,&frontend);
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,address,address+length,
        (1u << PL_X86_LOCAL_COUNT) - 1u,&workspace,&block);
    if (!status) status = pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count < 1u + spare) goto failed;
    memcpy(memory,setup,sizeof setup);
    memcpy(memory+sizeof setup,source,length);
    memcpy(memory+sizeof setup+length,observe,sizeof observe);
    for (pl_u32 i = 0u; i < candidates.count; ++i) {
        pl_x86_native_selection *candidate = &candidates.candidate[i];
        pl_u8 *start = memory + (i + 1u) * 512u, *body = start + sizeof setup;
        pl_u32 written = 0u;
        memcpy(start,setup,sizeof setup);
        status = pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
        if (status) goto failed;
        for (pl_u32 j = 0u; j < candidate->fixup_count; ++j) {
            if (candidate->fixups[j].target != address + length + 8u) goto failed;
            status = pl_x86_select_bind_fixup(body,written,candidate,j,
                (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written+8u));
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    static const pl_u64 edge[] = {0u,1u,7u,8u,63u,64u,UINT32_MAX,1ull<<32u,
        (1ull<<63u)-1u,1ull<<63u,UINT64_MAX};
    pl_u64 random = 0x8cf17a362de905bbull;
    for (pl_u32 sample = 0u; sample < 2048u; ++sample) {
        pl_u64 input[6];
        for (pl_u32 j = 0u; j < 6u; ++j) {
            random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
            input[j] = sample < 121u ? edge[(sample / (j & 1u ? 11u : 1u) + j) % 11u] : random;
        }
        pl_u64 shifted = input[0] << shift;
        pl_u64 first = (shifted - input[1] - 1u) >> 63u ? input[1] + 1u : shifted;
        pl_u64 second = (input[2] << shift) + 63u, sum = second + input[3];
        if ((input[4] - sum) >> 63u) second = input[5];
        pl_u64 flags = flags_for(second,first,64u,0u);
        for (pl_u32 i = 0u; i <= candidates.count; ++i) {
            union { void *object; function call; } fn;
            fn.object = memory + i * 512u;
            result actual = {0};
            fn.call(&actual,input);
            if (actual.first != first || actual.second != second || actual.sum != sum
                    || (spare && actual.spare)
                    || (actual.flags & 0x8d5u) != flags || actual.taken != condition(code,flags)) {
                fprintf(stderr,"seeded compare: mismatch candidate=%u sample=%u first=%llx expected=%llx\n",
                    i,sample,(unsigned long long)actual.first,(unsigned long long)first);
                goto failed;
            }
            ++*comparisons;
        }
    }
    test_code_release(memory,16384u);
    return 1;
failed:
    fprintf(stderr,"seeded compare: RED shift/cc/spare=%u/%u/%u status=%d candidates=%u\n",
        shift,code,spare,status,candidates.count);
    test_code_release(memory,16384u);
    return 0;
}

/* Count-zero shifts preserve earlier flags, but the following AND always
 * publishes fresh flags. CMOV must consume that publication, never flags
 * left by a separately seeded (and possibly zero-count) shift. */
static int check_shift_mask_select(pl_u32 bits, pl_u32 code, pl_u64 *comparisons)
{
    typedef struct { pl_u64 value, selected, flags; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, const pl_u64 *);
    pl_u8 source[20];
    pl_u32 length=0u;
    if (bits==64u) source[length++]=0x48u;
    source[length++]=0x89u; source[length++]=0xd3u;
    if (bits==64u) source[length++]=0x48u;
    source[length++]=0xd3u; source[length++]=0xe3u;
    if (bits==64u) source[length++]=0x48u;
    source[length++]=0x81u; source[length++]=0xe3u;
    source[length++]=0xbfu; source[length++]=0xefu;
    source[length++]=0xffu; source[length++]=0xffu;
    source[length++]=0x48u; source[length++]=0x0fu;
    source[length++]=(pl_u8)(0x40u|code); source[length++]=0xf8u;
    static const pl_u8 setup[]={
        0x53u,0x49u,0x89u,0xfbu, /* preserve rbx; r11=output */
        0x48u,0x8bu,0x16u, 0x48u,0x8bu,0x4eu,8u,
        0x48u,0x8bu,0x46u,16u, 0x48u,0x8bu,0x7eu,24u,
    };
    static const pl_u8 observe[]={
        0x49u,0x89u,0x1bu, 0x49u,0x89u,0x7bu,8u,
        0x9cu,0x58u,0x49u,0x89u,0x43u,16u, 0x5bu,0xc3u,
    };
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_u64 address=(pl_u64)(uintptr_t)(memory+sizeof setup);
    pl_x86_map map={source,address,length,length,5u,1u};
    pl_x86_image image={&map,1u,0u,address};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,address,address+length,
        (1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    memcpy(memory,setup,sizeof setup);
    memcpy(memory+sizeof setup,source,length);
    memcpy(memory+sizeof setup+length,observe,sizeof observe);
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
    static const pl_u64 edge[]={0u,1u,64u,4096u,UINT32_MAX,1ull<<32u,1ull<<63u,UINT64_MAX};
    pl_u64 random=0x40e16c397baf582dull;
    for (pl_u32 sample=0u; sample<8192u; ++sample) {
        random^=random<<13u; random^=random>>7u; random^=random<<17u;
        pl_u64 input[]={sample<2048u ? edge[sample/256u]:random,
            sample&255u,random,~random};
        pl_u64 mask=bits==64u ? UINT64_MAX:UINT32_MAX;
        pl_u64 value=((input[0]<<(input[1]&(bits-1u)))&mask)&0xffffffffffffefbfull;
        pl_u64 flags=flags_for(value,value,bits,1u);
        pl_u64 selected=input[condition(code,flags) ? 2u:3u];
        for (pl_u32 i=0u; i<=candidates.count; ++i) {
            union { void *object; function call; } fn;
            fn.object=memory+i*512u;
            result actual={0}; fn.call(&actual,input);
            if (actual.value!=value || actual.selected!=selected
                    || (actual.flags&0x8c5u)!=(flags&0x8c5u)) {
                fprintf(stderr,"shift mask select: mismatch candidate=%u input=%llx count=%llu\n",
                    i,(unsigned long long)input[0],(unsigned long long)input[1]);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || selected.copied_source || !selected.normalized_family_present
            || work>4u || span>4u) goto failed;
    test_code_release(memory,16384u); return 1;
failed:
    fprintf(stderr,"shift mask select: RED bits/cc=%u/%u status=%d\n",bits,code,status);
    test_code_release(memory,16384u); return 0;
}

/* Two input bits move to adjacent lanes and join a second input whose byte
 * field is cleared. The joined value can be preloaded before its last OR,
 * but remains live while the second output and final CMP are published. */
static int check_bit_lane_merge(pl_u32 position, pl_u64 *comparisons)
{
    typedef struct { pl_u64 joined, masked, flags; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, pl_u64, pl_u64);
    pl_u32 high=1u<<(position+1u), low=1u<<position;
    pl_u8 source[]={0x89u,0xc8u,0x01u,0xc9u,0xd0u,0xe8u,
        0x81u,0xe1u,(pl_u8)high,0u,0u,0u,
        0x83u,0xe0u,(pl_u8)low,0x09u,0xc8u,
        0x89u,0xd1u,0x80u,0xe1u,(pl_u8)~(high|low),0x09u,0xc8u,0x39u,0xd0u};
    static const pl_u8 setup[]={0x48u,0x89u,0xf1u}; /* rcx=first input */
    static const pl_u8 observe[]={0x48u,0x89u,0x07u,0x48u,0x89u,0x4fu,8u,
        0x9cu,0x58u,0x48u,0x89u,0x47u,16u,0xc3u};
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
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,address,address+sizeof source,
        (1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
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
    pl_u64 random=0x810cc273db943e6full;
    for (pl_u32 sample=0u; sample<4096u; ++sample) {
        random^=random<<13u; random^=random>>7u; random^=random<<17u;
        pl_u64 input=sample<1024u ? sample:random;
        pl_u64 base=sample<1024u ? ~((pl_u64)sample<<position):random*17u;
        pl_u64 masked=(pl_u32)base&~(high|low);
        pl_u64 joined=((input<<1u)&high)|((input>>1u)&low)|masked;
        pl_u64 flags=flags_for(joined,base,32u,0u);
        for (pl_u32 i=0u; i<=candidates.count; ++i) {
            union { void *object; function call; } fn;
            fn.object=memory+i*512u;
            result actual={0}; fn.call(&actual,input,base);
            if (actual.joined!=joined || actual.masked!=masked
                    || (actual.flags&0x8d5u)!=flags) {
                fprintf(stderr,"bit lane merge: mismatch candidate=%u input=%llx/%llx joined=%llx expected=%llx\n",
                    i,(unsigned long long)input,(unsigned long long)base,
                    (unsigned long long)actual.joined,(unsigned long long)joined);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || !selected.normalized_family_present || work>9u || span>5u) goto failed;
    test_code_release(memory,16384u); return 1;
failed:
    fprintf(stderr,"bit lane merge: RED position=%u status=%d\n",position,status);
    test_code_release(memory,16384u); return 0;
}

/* Backward demand separates the two masks, but the other two outputs still
 * share x&31. Schedule the old-input branch first, then keep that shared mask
 * in RSI until both consumers finish. The hand-written six-instruction
 * witness reaches span three without changing the final ADD flags. */
static int check_masked_fanout(pl_u32 mask_bits, pl_u32 shift,
                                 pl_u32 live_flags, pl_u64 *comparisons)
{
    typedef struct { pl_u64 value, scaled, quotient, flags; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, pl_u64);
    pl_u32 input_mask=(1u<<mask_bits)-1u;
    pl_u32 scaled_mask=((1u<<(mask_bits-1u))-1u)<<shift;
    pl_u8 source[]={0x83u,0xe6u,31u,0x8du,0x14u,0xb5u,0u,0u,0u,0u,
        0x48u,0xc1u,0xeeu,4u,0x89u,0xd0u,0x83u,0xe0u,60u,0x48u,0x83u,0xc0u,3u};
    static const pl_u8 observe[]={0x48u,0x89u,0x07u,0x48u,0x89u,0x57u,8u,
        0x48u,0x89u,0x77u,16u,0x9cu,0x58u,0x48u,0x89u,0x47u,24u,0xc3u};
    pl_u8 witness[]={
        0x6bu,0xc6u,4u,                 /* imul eax,esi,4 */
        0x83u,0xe0u,60u,                /* and eax,60 */
        0x83u,0xe6u,31u,                /* and esi,31 */
        0x8du,0x14u,0xb5u,0u,0u,0u,0u, /* lea edx,[rsi*4] */
        0x48u,0xc1u,0xeeu,4u,           /* shr rsi,4 */
        0x48u,0x83u,0xc0u,3u,           /* add rax,3 */
    };
    source[2]=(pl_u8)input_mask;
    source[5]=(pl_u8)(0x35u|(shift<<6u));
    source[13]=(pl_u8)(mask_bits-1u);
    source[18]=(pl_u8)scaled_mask;
    witness[2]=(pl_u8)(1u<<shift);
    witness[5]=(pl_u8)scaled_mask;
    witness[8]=(pl_u8)input_mask;
    witness[11]=source[5];
    witness[19]=source[13];
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
    pl_u32 mask=(1u<<PL_X86_LOCAL_COUNT)-1u;
    if (!live_flags) mask&=~(1u<<PL_X86_RFLAGS_LOCAL);
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,address,address+sizeof source,
        mask,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    memcpy(memory,source,sizeof source);
    memcpy(memory+sizeof source,observe,sizeof observe);
    memcpy(memory+12000u,witness,sizeof witness);
    memcpy(memory+12000u+sizeof witness,observe,sizeof observe);
    for (pl_u32 i=0u; i<candidates.count; ++i) {
        pl_u8 *body=memory+(i+1u)*512u;
        pl_u32 written=0u;
        status=pl_x86_select_write_measured(&frontend,&block,&candidates.candidate[i],body,256u,&written);
        if (status || candidates.candidate[i].fixup_count) goto failed;
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x345acb261dfe9401ull;
    for (pl_u32 sample=0u; sample<4096u; ++sample) {
        random^=random<<13u; random^=random>>7u; random^=random<<17u;
        pl_u64 input=sample<512u ? ((random&~255ull)|(sample&255u)):random;
        pl_u64 scaled=(input&input_mask)<<shift;
        pl_u64 quotient=(input&input_mask)>>(mask_bits-1u);
        pl_u64 addend=scaled&scaled_mask, value=addend+3u;
        pl_u32 parity=0u;
        for (pl_u32 bit=0u; bit<8u; ++bit) parity^=(pl_u32)(value>>bit)&1u;
        pl_u64 flags=(!parity ? 4u:0u)|((addend^3u^value)&16u);
        /* Bounded positive sum: CF/OF/SF/ZF are zero. */
        for (pl_u32 i=0u; i<=candidates.count+1u; ++i) {
            union { void *object; function call; } fn;
            fn.object=i==candidates.count+1u ? memory+12000u:memory+i*512u;
            result actual={0}; fn.call(&actual,input);
            if (actual.value!=value || actual.scaled!=scaled || actual.quotient!=quotient
                    || (live_flags && (actual.flags&0x8d5u)!=flags)) {
                fprintf(stderr,"masked fanout: mismatch candidate=%u input=%llx\n",i,(unsigned long long)input);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || span>3u || work>6u) goto failed;
    test_code_release(memory,16384u); return 1;
failed:
    fprintf(stderr,"masked fanout: RED mask-bits=%u shift=%u live-flags=%u status=%d\n",
        mask_bits,shift,live_flags,status);
    test_code_release(memory,16384u); return 0;
}

/* Both masked publications must exist before CMP reads either architectural
 * coordinate. An alias copied after CMP can create a falsely shorter span. */
static int check_shared_mask_branch(pl_u32 bits, pl_u32 shift, pl_u32 code,
                                     pl_u64 *comparisons)
{
    pl_u8 rex=bits==64u ? 0x48u:0x40u;
    pl_u8 source[]={rex,0xc1,0xe9,(pl_u8)shift,rex,0x89,0xc8,
        rex,0x83,0xe1,3,rex,0x83,0xe0,3,
        bits==64u ? 0x4cu:0x44u,0x39,0xc1,(pl_u8)(0x70u|code),8};
    static const pl_u8 setup[]={0x49,0x89,0xd0,0x48,0x89,0xf1};
    static const pl_u8 observe[]={
        0x41,0xb9,0,0,0,0,0xeb,6,0x41,0xb9,1,0,0,0,
        0x48,0x89,0x07,0x48,0x89,0x4f,8,0x9c,0x59,0x48,0x89,0x4f,16,
        0x4c,0x89,0x4f,24,0xc3,
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
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,address,
        address+sizeof source,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    memcpy(memory,setup,sizeof setup);memcpy(memory+sizeof setup,source,sizeof source);
    memcpy(memory+sizeof setup+sizeof source,observe,sizeof observe);
    for (pl_u32 i=0u;i<candidates.count;++i) {
        pl_x86_native_selection *candidate=&candidates.candidate[i];
        pl_u8 *start=memory+(i+1u)*512u,*body=start+sizeof setup;
        pl_u32 written=0u;
        memcpy(start,setup,sizeof setup);
        status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
        if (status) goto failed;
        for (pl_u32 j=0u;j<candidate->fixup_count;++j) {
            if (candidate->fixups[j].target!=address+sizeof source+8u) goto failed;
            status=pl_x86_select_bind_fixup(body,written,candidate,j,
                (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written+8u));
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x9c38954ade673f01ull;
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 index=sample<256u ? (pl_u64)sample<<shift:random;
        pl_u64 right=sample<256u ? sample%9u:random*17u;
        pl_u64 value=((index&(UINT64_MAX>>(64u-bits)))>>shift)&3u;
        pl_u64 flags=flags_for(value,right,bits,0u);
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;leaf_function function;} fn;
            fn.object=memory+i*512u;
            observation actual={0};fn.function(&actual,index,right,0u);
            if (actual.copy!=value || actual.input!=value || (actual.flags&0x8d5u)!=flags
                    || actual.taken!=condition(code,flags)) {
                fprintf(stderr,"shared mask branch: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || selected.copied_source || work>5u || span>4u) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"shared mask branch: RED bits/shift/cc=%u/%u/%u status=%d\n",
        bits,shift,code,status);
    test_code_release(memory,16384u);return 0;
}

/* A value resident in two final registers needs one publication copy, not a
 * copy to its nominated owner followed by a copy back to the still-live alias. */
static int check_resident_fanout_branch(pl_u32 shift, pl_u32 code,
                                         pl_u64 *comparisons)
{
    typedef struct { pl_u64 first, second, difference, flags, taken; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *,pl_u64,pl_u64,pl_u64);
    pl_u32 mask=(1u<<shift)-1u;
    pl_u8 source[]={0x89,0xc6,0x4c,0x89,0xc1,0x83,0xe0,(pl_u8)mask,
        0xc1,0xee,(pl_u8)shift,0x48,0x29,0xf1,0x89,0xc6,0x4c,0x39,0xd1,
        (pl_u8)(0x70u|code),8};
    static const pl_u8 setup[]={0x48,0x89,0xf0,0x49,0x89,0xd0,0x49,0x89,0xca};
    static const pl_u8 observe[]={
        0x41,0xb9,0,0,0,0,0xeb,6,0x41,0xb9,1,0,0,0,
        0x48,0x89,0x07,0x48,0x89,0x77,8,0x48,0x89,0x4f,16,
        0x9c,0x58,0x48,0x89,0x47,24,0x4c,0x89,0x4f,32,0xc3,
    };
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,sizeof source,sizeof source,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+sizeof source,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    for (pl_u32 i=0u;i<=candidates.count;++i) {
        pl_u8 *start=memory+i*512u,*body=start+sizeof setup;
        pl_u32 written=sizeof source;
        memcpy(start,setup,sizeof setup);
        if (!i) memcpy(body,source,sizeof source);
        else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            for (pl_u32 j=0u;!status && j<candidate->fixup_count;++j) {
                if (candidate->fixups[j].target!=0x1000u+sizeof source+8u) goto failed;
                status=pl_x86_select_bind_fixup(body,written,candidate,j,
                    (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written+8u));
            }
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x674583af3ed93102ull;
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input=sample<512u ? (random&~511ull)|sample:random;
        pl_u64 base=sample%5u ? random*17u:0u;
        pl_u64 difference=base-((pl_u32)input>>shift);
        pl_u64 right=sample%4u ? difference+sample%3u-1u:random*31u;
        pl_u64 flags=flags_for(difference,right,64u,0u);
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;function call;} fn;
            fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input,base,right);
            if (actual.first!=(input&mask) || actual.second!=actual.first
                    || actual.difference!=difference || (actual.flags&0x8d5u)!=flags
                    || actual.taken!=condition(code,flags)) {
                fprintf(stderr,"resident fanout: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || work>8u || span>4u) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"resident fanout: RED shift/cc=%u/%u status=%d\n",shift,code,status);
    test_code_release(memory,16384u);return 0;
}

static int check_overlay_bias(pl_u32 word_bits, pl_u32 field_bits, pl_u32 fixed,
                               pl_u32 bias, pl_u32 code, pl_u64 *comparisons)
{
    pl_u8 source[32];
    pl_u32 length = 0u;
    if (word_bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x89u; source[length++] = 0xf0u; /* mov r/eax,r/esi */
    if (word_bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x0du;            /* or r/eax,imm32 */
    for (pl_u32 byte = 0u; byte < 4u; ++byte)
        source[length++] = (pl_u8)(fixed >> (byte*8u));
    source[length++] = 0x0fu;
    source[length++] = field_bits == 8u ? 0xb6u : 0xb7u;
    source[length++] = 0xc0u;             /* movzx eax,al/ax */
    if (word_bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x05u;
    for (pl_u32 byte = 0u; byte < 4u; ++byte)
        source[length++] = (pl_u8)(bias >> (byte*8u));
    if (word_bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x83u; source[length++] = 0xf8u; source[length++] = 25u;
    source[length++] = (pl_u8)(0x70u | code); source[length++] = 8u;
    static const pl_u8 observe[] = {
        0x41u,0xb9u,0u,0u,0u,0u,0xebu,6u,0x41u,0xb9u,1u,0u,0u,0u,
        0x48u,0x89u,0x07u,0x48u,0x89u,0x77u,8u,
        0x9cu,0x59u,0x48u,0x89u,0x4fu,16u,0x4cu,0x89u,0x4fu,24u,0xc3u,
    };
    pl_u8 *memory = test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map = {source,0x1000u,length,length,5u,1u};
    pl_x86_image image = {&map,1u,0u,0x1000u};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace = {a,b,sizeof a,64u}, scratch = {c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates = {0};
    pl_x86_native_selection selected = {0};
    pl_u32 span = 0u, work = 0u;
    int status = pl_x86_frontend_open(&image,&frontend);
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+length,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status = pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status) goto failed;
    for (pl_u32 i = 0u; i <= candidates.count; ++i) {
        pl_u8 *body = memory+i*512u;
        pl_u32 written = length;
        if (!i) memcpy(body,source,length);
        else {
            const pl_x86_native_selection *candidate = &candidates.candidate[i-1u];
            status = pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            for (pl_u32 j = 0u; !status && j < candidate->fixup_count; ++j) {
                if (candidate->fixups[j].target != 0x1000u+length+8u) goto failed;
                status = pl_x86_select_bind_fixup(body,written,candidate,j,
                    (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written+8u));
            }
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random = 0x7698f824bcea12d3ull;
    pl_u32 mask = (1u << field_bits)-1u;
    for (pl_u32 sample = 0u; sample < 4096u; ++sample) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 input = sample < 256u ? (random & ~255ull) | sample : random;
        pl_u64 narrowed = ((input | fixed) & mask);
        pl_u64 value = word_bits == 64u ? narrowed+(pl_u64)(pl_i64)(pl_i32)bias
                                       : (pl_u32)(narrowed+bias);
        pl_u64 flags = flags_for(value,25u,word_bits,0u);
        for (pl_u32 i = 0u; i <= candidates.count; ++i) {
            union {void *object; leaf_function function;} fn;
            fn.object = memory+i*512u;
            observation actual = {0}; fn.function(&actual,input,0u,0u);
            if (actual.copy != value || actual.input != input
                    || (actual.flags & 0x8d5u) != flags
                    || actual.taken != condition(code,flags)) {
                fprintf(stderr,"overlay bias branch: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    status = pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || selected.copied_source || !selected.normalized_family_present || work > 5u)
        goto failed;
    test_code_release(memory,16384u); return 1;
failed:
    fprintf(stderr,"overlay bias branch: RED word/field/fixed/bias/cc=%u/%u/%x/%x/%u status=%d work/span=%u/%u\n",
        word_bits,field_bits,fixed,bias,code,status,work,span);
    test_code_release(memory,16384u); return 0;
}

/* A partial-word publication and a bit extraction have independent demand:
 * eax = ecx & (0xffff0000 | (1 << shift)); r11d = (ecx >> shift) & 1.
 * A low-32 mask is a complete result-width proof, even when bit 31 is set.
 * The handwritten witness keeps TEST's original high-byte flags and Jcc. */
static int check_narrow_mask_branch(pl_u32 shift, pl_u32 code, pl_u64 *comparisons)
{
    typedef struct { pl_u64 masked, bit, input, flags, taken; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *,pl_u64);
    pl_u32 bit=1u<<shift, mask=0xffff0000u|bit;
    pl_u8 source[]={0x89,0xc8,0x66,0x25,(pl_u8)bit,(pl_u8)(bit>>8u),
        0x41,0x89,0xc3,0x66,0x41,0xc1,0xeb,(pl_u8)shift,
        0x41,0x83,0xe3,1,0xf6,0xc5,4,(pl_u8)(0x70u|code),8};
    pl_u8 witness[]={0x89,0xc8,0x25,(pl_u8)mask,(pl_u8)(mask>>8u),0xff,0xff,
        0x41,0x89,0xcb,0x41,0xc1,0xeb,(pl_u8)shift,
        0x41,0x83,0xe3,1,0xf6,0xc5,4,(pl_u8)(0x70u|code),8};
    static const pl_u8 setup[]={0x48,0x89,0xf1};
    static const pl_u8 observe[]={
        0x41,0xb9,0,0,0,0,0xeb,6,0x41,0xb9,1,0,0,0,
        0x48,0x89,0x07,0x4c,0x89,0x5f,8,0x48,0x89,0x4f,16,
        0x9c,0x58,0x48,0x89,0x47,24,0x4c,0x89,0x4f,32,0xc3,
    };
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,sizeof source,sizeof source,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+sizeof source,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    for (pl_u32 i=0u;i<=candidates.count+1u;++i) {
        pl_u8 *body=memory+i*512u+sizeof setup;pl_u32 written=sizeof source;
        memcpy(body-sizeof setup,setup,sizeof setup);
        if (!i) memcpy(body,source,sizeof source);
        else if (i==candidates.count+1u) {
            memcpy(body,witness,sizeof witness);written=sizeof witness;
        } else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            for (pl_u32 j=0u;!status && j<candidate->fixup_count;++j) {
                if (candidate->fixups[j].target!=0x1000u+sizeof source+8u) goto failed;
                status=pl_x86_select_bind_fixup(body,written,candidate,j,
                    (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written+8u));
            }
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0xe84329a053762df1ull;
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input=sample<512u ? (random&~0xffffull)|((pl_u64)sample<<7u):random;
        pl_u64 flags=flags_for(input>>8u,4u,8u,1u);
        for (pl_u32 i=0u;i<=candidates.count+1u;++i) {
            union {void *object;function call;} fn;fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input);
            if (actual.masked!=(input&mask) || actual.bit!=((input>>shift)&1u)
                    || actual.input!=input || (actual.flags&0x8c5u)!=flags
                    || actual.taken!=condition(code,flags)) {
                fprintf(stderr,"narrow mask branch: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || work>7u || span>4u) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"narrow mask branch: RED shift/cc=%u/%u status=%d\n",shift,code,status);
    test_code_release(memory,16384u);return 0;
}

/* Result-width reduction does not reduce the flag producer's width. For
 * 0x80000000, AND r64 has SF=0 but AND r32 has SF=1. Wide masks also test the
 * negative side of the zero-extension proof, including sign-extended masks. */
static int check_mask_flag_width(pl_u32 bits, pl_u64 mask, pl_u32 code,
                                  pl_u64 *comparisons)
{
    pl_u8 source[]={0x49,0xba,0,0,0,0,0,0,0,0,0x48,0x89,0xf0,
        bits==64u ? 0x4cu:0x44u,0x21,0xd0,(pl_u8)(0x70u|code),8};
    for (pl_u32 byte=0u;byte<8u;++byte) source[2u+byte]=(pl_u8)(mask>>(byte*8u));
    static const pl_u8 observe[]={
        0x41,0xb9,0,0,0,0,0xeb,6,0x41,0xb9,1,0,0,0,
        0x48,0x89,0x07,0x4c,0x89,0x57,8,0x9c,0x58,0x48,0x89,0x47,16,
        0x4c,0x89,0x4f,24,0xc3,
    };
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,sizeof source,sizeof source,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+sizeof source,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    for (pl_u32 i=0u;i<=candidates.count;++i) {
        pl_u8 *body=memory+i*512u;pl_u32 written=sizeof source;
        if (!i) memcpy(body,source,sizeof source);
        else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            for (pl_u32 j=0u;!status && j<candidate->fixup_count;++j) {
                if (candidate->fixups[j].target!=0x1000u+sizeof source+8u) goto failed;
                status=pl_x86_select_bind_fixup(body,written,candidate,j,
                    (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written+8u));
            }
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x341cb9a08e6275dfull;
    static const pl_u64 boundary[]={0u,1u,0x7fffffffu,0x80000000u,0xffffffffu,
        0x100000000ull,0x8000000000000000ull,UINT64_MAX};
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input=sample<8u ? boundary[sample]:random;
        pl_u64 value=input&mask&(UINT64_MAX>>(64u-bits));
        pl_u64 flags=flags_for(input,mask,bits,1u);
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;leaf_function function;} fn;fn.object=memory+i*512u;
            observation actual={0};fn.function(&actual,input,0u,0u);
            if (actual.copy!=value || actual.input!=mask || (actual.flags&0x8c5u)!=flags
                    || actual.taken!=condition(code,flags)) {
                fprintf(stderr,"mask flag width: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"mask flag width: RED bits/mask/cc=%u/%llx/%u status=%d\n",
        bits,(unsigned long long)mask,code,status);
    test_code_release(memory,16384u);return 0;
}

/* A low-byte/word copy observes the sum, not another execution of its flag
 * producer in a register that already consumed an entry generation. */
static int check_sum_narrow(pl_u32 difference_bits, pl_u32 field_bits,
                             pl_u32 live_flags, pl_u64 *comparisons)
{
    pl_u8 source[]={difference_bits==64u ? 0x48u:0x40u,0x89,0xca,
        difference_bits==64u ? 0x48u:0x40u,0x29,0xf2,0x01,0xc2,
        0x0f,field_bits==16u ? 0xb7u:0xb6u,0xc2};
    static const pl_u8 setup[]={0x48,0x89,0xf0,0x48,0x89,0xce,0x48,0x89,0xd1};
    static const pl_u8 observe[]={0x48,0x89,0x07,0x48,0x89,0x57,8,
        0x9c,0x58,0x48,0x89,0x47,16,0xc3};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,sizeof source,sizeof source,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;pl_x86_native_candidates candidates={0};
    pl_u32 live=(1u<<PL_X86_LOCAL_COUNT)-1u;
    if (!live_flags) live&=~(1u<<PL_X86_RFLAGS_LOCAL);
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+sizeof source,live,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    for (pl_u32 i=0u;i<=candidates.count;++i) {
        pl_u8 *body=memory+i*512u+sizeof setup;pl_u32 written=sizeof source;
        memcpy(body-sizeof setup,setup,sizeof setup);
        if (!i) memcpy(body,source,sizeof source);
        else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            if (status || candidate->fixup_count) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x82945016a3bcde7full;
    static const pl_u64 boundary[]={0u,1u,0x7fffffffu,0x80000000u,0xffffffffu,
        0x100000000ull,0x8000000000000000ull,UINT64_MAX};
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 add=sample<512u ? boundary[sample%8u]:random;
        pl_u64 left=sample<512u ? boundary[(sample/8u)%8u]:random*17u;
        pl_u64 right=sample<512u ? boundary[sample/64u]:random^0xab54fa95803e71c2ull;
        pl_u64 a32=(pl_u32)(left-right),b32=(pl_u32)add,value=(pl_u32)(a32+b32);
        pl_u64 flags=flags_for(value,UINT32_MAX,32u,1u)
            | (a32+b32>UINT32_MAX ? 1u:0u) | ((a32^b32^value)&16u)
            | ((~(a32^b32)&(a32^value)&0x80000000u) ? 2048u:0u);
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;leaf_function function;} fn;fn.object=memory+i*512u;
            observation actual={0};fn.function(&actual,add,left,right);
            if (actual.copy!=(value&((1u<<field_bits)-1u)) || actual.input!=value
                    || (live_flags && (actual.flags&0x8d5u)!=flags)) {
                fprintf(stderr,"sum narrow: mismatch candidate=%u sample=%u value=%llx/%llx flags=%llx/%llx\n",
                    i,sample,(unsigned long long)actual.copy,(unsigned long long)value,
                    (unsigned long long)(actual.flags&0x8d5u),(unsigned long long)flags);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || work>4u || span>4u) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"sum narrow: RED difference/field/flags=%u/%u/%u status=%d\n",
        difference_bits,field_bits,live_flags,status);
    test_code_release(memory,16384u);return 0;
}

/* v=x&2^k and b=(x>>k)&1 observe the same Boolean class. The logical
 * producer already sets ZF; clearing the full Boolean destination followed
 * by SETNZ (or SETZ for 1-b) needs no second TEST or shifted copy of x.
 * The separate witness also covers an old Boolean destination used by x. */
static int check_mask_boolean(pl_u32 position, pl_u32 inverse, pl_u32 aliases,
                               pl_u32 fanout, pl_u32 code, pl_u64 *comparisons)
{
    typedef struct { pl_u64 masked, boolean, input, flags, taken, alias; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *,pl_u64,pl_u64);
    pl_u32 mask=1u<<position;
    pl_u8 source[40]={0x48,0xf7,0xd0,aliases ? 0x4cu:0x48u,0x21,aliases ? 0xe0u:0xd0u,
        0x25,(pl_u8)mask,(pl_u8)(mask>>8u),(pl_u8)(mask>>16u),(pl_u8)(mask>>24u),
        0x49,0x89,0xc4,0x49,0xc1,0xec,(pl_u8)position,0x41,0x83,0xe4,1};
    pl_u32 length=22u;
    if (inverse) {const pl_u8 flip[]={0x41,0x83,0xf4,1};memcpy(source+length,flip,4u);length+=4u;}
    const pl_u8 copy[]={0x45,0x89,0xe3};
    if (fanout) {memcpy(source+length,copy,sizeof copy);length+=sizeof copy;}
    const pl_u8 tail[]={0x48,0x85,0xc0,(pl_u8)(0x70u|code),8};
    memcpy(source+length,tail,sizeof tail);length+=sizeof tail;
    pl_u8 witness[40];pl_u32 witness_bytes=0u;
    if (!aliases) {const pl_u8 zero[]={0x45,0x31,0xe4};memcpy(witness,zero,3u);witness_bytes=3u;}
    memcpy(witness+witness_bytes,source,11u);witness_bytes+=11u;
    if (aliases) {const pl_u8 zero[]={0x41,0xbc,0,0,0,0};memcpy(witness+witness_bytes,zero,6u);witness_bytes+=6u;}
    const pl_u8 finish[]={0x41,0x0f,inverse ? 0x94u:0x95u,0xc4};
    memcpy(witness+witness_bytes,finish,sizeof finish);witness_bytes+=sizeof finish;
    if (fanout) {memcpy(witness+witness_bytes,copy,sizeof copy);witness_bytes+=sizeof copy;}
    /* Bit 31 distinguishes 32-bit AND's SF from the original 64-bit TEST.
     * Outside the flag-equivalence proof, the witness must retain TEST. */
    if (position==31u) {const pl_u8 test[]={0x48,0x85,0xc0};memcpy(witness+witness_bytes,test,3u);witness_bytes+=3u;}
    witness[witness_bytes++]=(pl_u8)(0x70u|code);witness[witness_bytes++]=8u;
    static const pl_u8 setup[]={0x41,0x54,0x49,0x89,0xd4,0x48,0x89,0xf0,0x49,0x89,0xd3};
    static const pl_u8 observe[]={
        0x41,0xb9,0,0,0,0,0xeb,6,0x41,0xb9,1,0,0,0,
        0x48,0x89,0x07,0x4c,0x89,0x67,8,0x48,0x89,0x57,16,
        0x9c,0x58,0x48,0x89,0x47,24,0x4c,0x89,0x4f,32,
        0x4c,0x89,0x5f,40,0x41,0x5c,0xc3};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,length,length,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+length,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    for (pl_u32 i=0u;i<=candidates.count+1u;++i) {
        pl_u8 *body=memory+i*512u+sizeof setup;pl_u32 written=length;
        memcpy(body-sizeof setup,setup,sizeof setup);
        if (!i) memcpy(body,source,length);
        else if (i==candidates.count+1u) {memcpy(body,witness,witness_bytes);written=witness_bytes;}
        else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            for (pl_u32 j=0u;!status && j<candidate->fixup_count;++j) {
                if (candidate->fixups[j].target!=0x1000u+length+8u) goto failed;
                status=pl_x86_select_bind_fixup(body,written,candidate,j,
                    (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written+8u));
            }
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0xbd80efa61c273954ull;
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input=sample<256u ? (random&~(pl_u64)mask)|((pl_u64)(sample&1u)<<position):random;
        pl_u64 right=sample<256u ? (~random&~(pl_u64)mask)|((pl_u64)((sample>>1u)&1u)<<position):random*17u;
        pl_u64 value=(~input&right)&mask,boolean=(value>>position)^inverse;
        pl_u64 flags=flags_for(value,value,64u,1u);
        for (pl_u32 i=0u;i<=candidates.count+1u;++i) {
            union {void *object;function call;} fn;fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input,right);
            if (actual.masked!=value || actual.boolean!=boolean || actual.input!=right
                    || (actual.flags&0x8c5u)!=flags || actual.taken!=condition(code,flags)
                    || actual.alias!=(fanout ? boolean:right)) {
                fprintf(stderr,"mask Boolean: mismatch candidate=%u sample=%u\n",i,sample);goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (position<31u && (status || selected.copied_source || work>6u+fanout || span>5u)) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"mask Boolean: RED bit/inverse/alias/fanout/cc=%u/%u/%u/%u/%u status=%d\n",
        position,inverse,aliases,fanout,code,status);
    test_code_release(memory,16384u);return 0;
}

/* An overwritten AND/SUB result leaves only a TEST/CMP observation. The
 * independently encoded witness removes the write, not its defined flags.
 * A copied result is the negative boundary: its value must remain live. */
static int check_dead_alu_result(pl_u32 bits, pl_u32 test, pl_u32 immediate,
                                 pl_u32 keep, pl_u32 code, pl_u64 *comparisons)
{
    typedef struct { pl_u64 chosen, alternative, overwritten, saved, flags; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *,pl_u64,pl_u64);
    const pl_u8 prefix[]={0x48,0x89,0xf1,0x49,0x89,0xf0,0x48,0x83,0xe1,0xbf,
        0x49,0x81,0xc8,0,1,0,0,0x48,0x81,0xc9,0,1,0x80,0};
    pl_u8 source[64],witness[64];pl_u32 length=sizeof prefix;
    memcpy(source,prefix,sizeof prefix);
    if (bits==16u) source[length++]=0x66u;
    if (bits==8u || bits==64u) source[length++]=bits==8u ? 0x40u:0x48u;
    pl_u32 operation=length;
    source[length++]=bits==8u ? 0x80u:0x81u;source[length++]=test ? 0xe6u:0xeeu;
    pl_u32 immediate_bytes=bits<32u ? bits/8u:4u;
    for (pl_u32 i=0u;i<immediate_bytes;++i) source[length++]=(pl_u8)(immediate>>(8u*i));
    if (keep) {const pl_u8 save[]={0x49,0x89,0xf1};memcpy(source+length,save,sizeof save);length+=sizeof save;}
    const pl_u8 tail[]={0xbe,0x83,0xff,0xff,0xff,0x49,0x0f,(pl_u8)(0x40u|code),0xc8};
    memcpy(source+length,tail,sizeof tail);length+=sizeof tail;
    memcpy(witness,source,length);
    if (!keep) {
        witness[operation]=test ? (bits==8u ? 0xf6u:0xf7u):(bits==8u ? 0x80u:0x81u);
        witness[operation+1u]=test ? 0xc6u:0xfeu;
    }
    const pl_u8 setup[]={0x49,0x89,0xd1};
    const pl_u8 observe[]={0x48,0x89,0x0f,0x4c,0x89,0x47,8,0x48,0x89,0x77,16,
        0x4c,0x89,0x4f,24,0x9c,0x58,0x48,0x89,0x47,32,0xc3};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,length,length,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+length,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || !candidates.count) goto failed;
    pl_u32 generated=0u;
    for (pl_u32 i=0u;i<=candidates.count+1u;++i) {
        pl_u8 *body=memory+i*512u+sizeof setup;pl_u32 written=length;
        memcpy(body-sizeof setup,setup,sizeof setup);
        if (!i) memcpy(body,source,length);
        else if (i==candidates.count+1u) memcpy(body,witness,length);
        else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            generated+=!candidate->copied_source;
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            if (status || candidate->fixup_count) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    const pl_u64 boundary[]={0u,1u,63u,64u,65u,255u,256u,0x7fffffffull,
        0x80000000ull,0xffffffffull,0x100000000ull,0x7fffffffffffffffull,
        0x8000000000000000ull,UINT64_MAX};
    pl_u64 random=0x413edab57169f28cull;
    pl_u64 right=bits==64u ? (pl_u64)(pl_i64)(pl_i32)immediate:immediate;
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input=sample<sizeof boundary/sizeof boundary[0] ? boundary[sample]:random;
        pl_u64 flags=flags_for(input,right,bits,test);
        pl_u64 value=(test ? input&right:input-right)&(UINT64_MAX>>(64u-bits));
        if (bits<32u) value|=input&~((1ull<<bits)-1u);
        pl_u64 chosen=condition(code,flags) ? input|256u:(input&~64ull)|0x800100u;
        for (pl_u32 i=0u;i<=candidates.count+1u;++i) {
            union {void *object;function call;} fn;fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input,~input);
            if (actual.chosen!=chosen || actual.alternative!=(input|256u)
                    || actual.overwritten!=0xffffff83u || actual.saved!=(keep ? value:~input)
                    || (actual.flags&(test ? 0x8c5u:0x8d5u))!=flags) {
                fprintf(stderr,"dead ALU result: mismatch candidate=%u sample=%u chosen=%llx/%llx saved=%llx/%llx flags=%llx/%llx\n",
                    i,sample,(unsigned long long)actual.chosen,(unsigned long long)chosen,
                    (unsigned long long)actual.saved,(unsigned long long)(keep ? value:~input),
                    (unsigned long long)(actual.flags&(test ? 0x8c5u:0x8d5u)),(unsigned long long)flags);
                goto failed;
            }
            ++*comparisons;
        }
    }
    if (!keep && bits>=32u && !generated) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"dead ALU result: RED width/test/imm/keep/cc=%u/%u/%x/%u/%u status=%d candidates=%u\n",
        bits,test,immediate,keep,code,status,candidates.count);
    test_code_release(memory,16384u);return 0;
}

/* A subtraction cannot destroy its distinct right operand before reading it.
 * Two shared differences expose that constraint to register allocation, with
 * all entry/output generations, final flags and both branch arms observed. */
static int check_difference_fanout(pl_u32 bits, pl_u32 first_shift,
                                   pl_u32 second_shift, pl_u32 code,
                                   pl_u64 *comparisons)
{
    typedef struct {pl_u64 half,quarter,difference,other,input,flags,taken;} result;
    typedef void (__attribute__((sysv_abi)) *function)(result *,const pl_u64 *);
    pl_u8 source[64];pl_u32 length=0u;
#define FANOUT_OP(rex_,op_,mod_) do { \
    if (bits==64u || (rex_)!=0x48u) source[length++]=(pl_u8)((rex_)-(bits==32u ? 8u:0u)); \
    source[length++]=(op_);source[length++]=(mod_); \
} while (0)
    FANOUT_OP(0x48u,0x29u,0xc3u); /* sub rbx,rax */
    FANOUT_OP(0x4cu,0x89u,0xe2u); /* mov rdx,r12 */
    FANOUT_OP(0x48u,0x89u,0xd8u); /* mov rax,rbx */
    FANOUT_OP(0x48u,0x29u,0xcau); /* sub rdx,rcx */
    FANOUT_OP(0x48u,0xc1u,0xebu);source[length++]=(pl_u8)second_shift;
    FANOUT_OP(0x48u,0xc1u,0xe8u);source[length++]=(pl_u8)first_shift;
    FANOUT_OP(0x48u,0xc1u,0xeau);source[length++]=(pl_u8)first_shift;
    FANOUT_OP(0x48u,0x89u,0xc1u); /* mov rcx,rax */
    FANOUT_OP(0x48u,0x29u,0xd1u); /* sub rcx,rdx */
    FANOUT_OP(0x48u,0x39u,0xd9u); /* cmp rcx,rbx */
#undef FANOUT_OP
    source[length++]=(pl_u8)(0x70u|code);source[length++]=8u;
    const pl_u8 setup[]={0x53,0x41,0x54,0x48,0x8b,0x06,0x48,0x8b,0x5e,8,
        0x48,0x8b,0x4e,16,0x4c,0x8b,0x66,24};
    const pl_u8 observe[]={0x41,0xb8,0,0,0,0,0xeb,6,0x41,0xb8,1,0,0,0,
        0x48,0x89,0x07,0x48,0x89,0x5f,8,0x48,0x89,0x4f,16,0x48,0x89,0x57,24,
        0x4c,0x89,0x67,32,0x9c,0x58,0x48,0x89,0x47,40,0x4c,0x89,0x47,48,0x41,0x5c,0x5b,0xc3};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,length,length,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+length,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || !candidates.count) goto failed;
    pl_u32 generated=0u;
    for (pl_u32 i=0u;i<=candidates.count;++i) {
        pl_u8 *body=memory+i*512u+sizeof setup;pl_u32 written=length;
        memcpy(body-sizeof setup,setup,sizeof setup);
        if (!i) memcpy(body,source,length);
        else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            generated+=!candidate->copied_source;
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            for (pl_u32 j=0u;!status && j<candidate->fixup_count;++j) {
                if (candidate->fixups[j].target!=0x1000u+length+8u) goto failed;
                status=pl_x86_select_bind_fixup(body,written,candidate,j,
                    (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written+8u));
            }
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    const pl_u64 edge[]={0u,1u,15u,16u,0x7fffffffu,0x80000000u,UINT32_MAX,UINT64_MAX};
    pl_u64 random=0x315ff06154c231e0ull,mask=UINT64_MAX>>(64u-bits);
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input[]={sample<512u ? edge[sample%8u]:random,
            sample<512u ? edge[(sample/8u)%8u]:random*17u,
            sample<512u ? edge[sample/64u]:~random,random*31u};
        pl_u64 left=(input[1]-input[0])&mask,right=(input[3]-input[2])&mask;
        pl_u64 half=left>>first_shift,quarter=left>>second_shift,other=right>>first_shift;
        pl_u64 difference=(half-other)&mask,flags=flags_for(difference,quarter,bits,0u);
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;function call;} fn;fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input);
            if (actual.half!=half || actual.quarter!=quarter || actual.difference!=difference
                    || actual.other!=other || actual.input!=input[3]
                    || (actual.flags&0x8d5u)!=flags || actual.taken!=condition(code,flags)) {
                fprintf(stderr,"difference fanout: mismatch candidate=%u sample=%u\n",i,sample);goto failed;
            }
            ++*comparisons;
        }
    }
    if (!generated) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"difference fanout: RED width/shifts/cc=%u/%u/%u/%u status=%d candidates=%u\n",
        bits,first_shift,second_shift,code,status,candidates.count);
    test_code_release(memory,16384u);return 0;
}

/* A spill precedes the pending instruction. Its destination must not hold
 * that instruction's still-unread right operand, even at the last use. */
static int check_spill_read_cut(pl_u32 shift, pl_u64 *comparisons)
{
    typedef struct {pl_u64 difference,copy,input,base,flags;} result;
    typedef void (__attribute__((sysv_abi)) *function)(result *,pl_u64,pl_u64);
    const pl_u8 source[]={0x89,0xda,0x4c,0x89,0xc8,0xc1,0xea,(pl_u8)shift,
        0x48,0x29,0xd0,0x89,0xda};
    const pl_u8 setup[]={0x53,0x48,0x89,0xf3,0x49,0x89,0xd1};
    const pl_u8 observe[]={0x48,0x89,0x07,0x48,0x89,0x57,8,0x48,0x89,0x5f,16,
        0x4c,0x89,0x4f,24,0x9c,0x58,0x48,0x89,0x47,32,0x5b,0xc3};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,sizeof source,sizeof source,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+sizeof source,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    for (pl_u32 i=0u;i<=candidates.count;++i) {
        pl_u8 *body=memory+i*512u+sizeof setup;pl_u32 written=sizeof source;
        memcpy(body-sizeof setup,setup,sizeof setup);
        if (!i) memcpy(body,source,sizeof source);
        else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            if (status || candidate->fixup_count) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x519e31a895464dc7ull;
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input=sample<256u ? (random&~0xffffffffull)|sample:random;
        pl_u64 right=(pl_u32)input>>(shift&31u),base=sample%3u ? ~random:right;
        pl_u64 flags=flags_for(base,right,64u,0u);
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;function call;} fn;fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input,base);
            if (actual.difference!=base-right || actual.copy!=(pl_u32)input
                    || actual.input!=input || actual.base!=base || (actual.flags&0x8d5u)!=flags) {
                fprintf(stderr,"spill read cut: mismatch candidate=%u sample=%u\n",i,sample);goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || work>5u || span>3u || !selected.normalized_family_present) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"spill read cut: RED shift=%u status=%d candidates=%u\n",shift,status,candidates.count);
    test_code_release(memory,16384u);return 0;
}

/* Narrow destructive operations split their result and flags in SSA. When
 * the destination is replaced, the flag cut still observes its entry byte.
 * Observe copied results as well so a live partial write cannot disappear. */
static int check_dead_byte_result(pl_u32 high, pl_u32 test, pl_u32 immediate,
                                  pl_u32 keep, pl_u32 code, pl_u64 *comparisons)
{
    typedef struct {pl_u64 a,b,c,d,saved,flags,taken;} result;
    typedef void (__attribute__((sysv_abi)) *function)(result *,pl_u64,pl_u64,pl_u64,pl_u64,pl_u64);
    pl_u8 source[40]={0x80,(pl_u8)((test ? 0xe2u:0xeau)+high*4u),(pl_u8)immediate};
    pl_u32 length=3u;
    if (keep) {const pl_u8 save[]={0x49,0x89,0xd2};memcpy(source+length,save,sizeof save);length+=sizeof save;}
    const pl_u8 tail[]={0x4c,0x89,0xf1,0x4c,0x89,0xea,0x4c,0x89,0xe6,0x48,0x89,0xdf,
        (pl_u8)(0x70u|code),8};
    memcpy(source+length,tail,sizeof tail);length+=sizeof tail;
    pl_u8 witness[40];memcpy(witness,source,length);
    if (!keep) {witness[0]=test ? 0xf6u:0x80u;witness[1]=(pl_u8)((test ? 0xc2u:0xfau)+high*4u);}
    const pl_u8 setup[]={0x53,0x41,0x54,0x41,0x55,0x41,0x56,0x49,0x89,0xfb,
        0x49,0x89,0xd5,0x49,0x89,0xce,0x4d,0x89,0xc4,0x4c,0x89,0xcb,
        0x48,0x89,0xf2,0x49,0x89,0xf2};
    const pl_u8 observe[]={0x41,0xb8,0,0,0,0,0xeb,6,0x41,0xb8,1,0,0,0,
        0x49,0x89,0x0b,0x49,0x89,0x53,8,0x49,0x89,0x73,16,0x49,0x89,0x7b,24,
        0x4d,0x89,0x53,32,0x9c,0x58,0x49,0x89,0x43,40,0x4d,0x89,0x43,48,
        0x41,0x5e,0x41,0x5d,0x41,0x5c,0x5b,0xc3};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,length,length,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+length,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || !candidates.count) goto failed;
    pl_u32 generated=0u;
    for (pl_u32 i=0u;i<=candidates.count+1u;++i) {
        pl_u8 *body=memory+i*512u+sizeof setup;pl_u32 written=length;
        memcpy(body-sizeof setup,setup,sizeof setup);
        if (!i) memcpy(body,source,length);
        else if (i==candidates.count+1u) memcpy(body,witness,length);
        else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            generated+=!candidate->copied_source;
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            for (pl_u32 j=0u;!status && j<candidate->fixup_count;++j) {
                if (candidate->fixups[j].target!=0x1000u+length+8u) goto failed;
                status=pl_x86_select_bind_fixup(body,written,candidate,j,
                    (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written+8u));
            }
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x46213db41794c578ull;
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input=sample<256u ? (random&~(255ull<<(8u*high)))|((pl_u64)sample<<(8u*high)):random;
        pl_u64 byte=(input>>(8u*high))&255u,flags=flags_for(byte,immediate,8u,test);
        pl_u64 changed=(test ? byte&immediate:byte-immediate)&255u;
        pl_u64 saved=keep ? (input&~(255ull<<(8u*high)))|(changed<<(8u*high)):input;
        for (pl_u32 i=0u;i<=candidates.count+1u;++i) {
            union {void *object;function call;} fn;fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input,random*3u,random*7u,~random,random*11u);
            if (actual.a!=random*7u || actual.b!=random*3u || actual.c!=~random
                    || actual.d!=random*11u || actual.saved!=saved
                    || (actual.flags&(test ? 0x8c5u:0x8d5u))!=flags
                    || actual.taken!=condition(code,flags)) {
                fprintf(stderr,"dead byte result: mismatch candidate=%u sample=%u\n",i,sample);goto failed;
            }
            ++*comparisons;
        }
    }
    if (!keep && !generated) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"dead byte result: RED high/test/imm/keep/cc=%u/%u/%x/%u/%u status=%d candidates=%u\n",
        high,test,immediate,keep,code,status,candidates.count);
    test_code_release(memory,16384u);return 0;
}

int main(void)
{
    pl_u64 comparisons = 0u;
    const pl_u32 byte_masks[]={1u,0u,0x80u,0xffu};
    for (pl_u32 high=0u;high<2u;++high)
        for (pl_u32 test=0u;test<2u;++test)
            for (pl_u32 i=0u;i<4u;++i)
                for (pl_u32 keep=0u;keep<2u;++keep)
                    for (pl_u32 code=0u;code<16u;++code)
                        if (!check_dead_byte_result(high,test,byte_masks[i],keep,code,&comparisons)) return 1;
    for (pl_u32 shift=1u;shift<32u;++shift)
        if (!check_spill_read_cut(shift,&comparisons)) return 1;
    const pl_u32 first_shifts[]={1u,7u,31u},second_shifts[]={4u,13u,31u};
    for (pl_u32 bits=32u;bits<=64u;bits+=32u)
        for (pl_u32 a=0u;a<3u;++a)
            for (pl_u32 b=0u;b<3u;++b)
                for (pl_u32 code=0u;code<16u;++code)
                    if (!check_difference_fanout(bits,first_shifts[a],second_shifts[b],code,&comparisons)) return 1;
    const pl_u32 dead_immediates[]={64u,0u,1u,0x7fffffffu,0x80000000u,0xffffffffu};
    for (pl_u32 bits=8u;bits<=64u;bits*=2u)
        for (pl_u32 test=0u;test<2u;++test)
            for (pl_u32 i=0u;i<sizeof dead_immediates/sizeof dead_immediates[0];++i)
                for (pl_u32 keep=0u;keep<2u;++keep)
                    for (pl_u32 code=0u;code<16u;++code)
                        if (!check_dead_alu_result(bits,test,dead_immediates[i],keep,code,&comparisons)) return 1;
    const pl_u32 positions[]={1u,7u,8u,15u,23u,30u,31u};
    for (pl_u32 p=0u;p<sizeof positions/sizeof positions[0];++p)
        for (pl_u32 inverse=0u;inverse<2u;++inverse)
            for (pl_u32 alias=0u;alias<2u;++alias)
                for (pl_u32 fanout=0u;fanout<2u;++fanout)
                    for (pl_u32 code=0u;code<16u;++code)
                        if (!check_mask_boolean(positions[p],inverse,alias,fanout,code,&comparisons)) return 1;
    for (pl_u32 bits=32u;bits<=64u;bits+=32u)
        for (pl_u32 field=8u;field<=16u;field+=8u)
            for (pl_u32 flags=0u;flags<2u;++flags)
                if (!check_sum_narrow(bits,field,flags,&comparisons)) return 1;
    const pl_u64 masks[]={0x7fffffffu,0x80000000u,0xffff0100u,0xffffffffu,
        0x100000001ull,0xffffffff80000000ull};
    for (pl_u32 bits=32u;bits<=64u;bits+=32u)
        for (pl_u32 i=0u;i<sizeof masks/sizeof masks[0];++i)
            for (pl_u32 code=0u;code<16u;++code)
                if (!check_mask_flag_width(bits,masks[i],code,&comparisons)) return 1;
    for (pl_u32 shift=1u;shift<16u;++shift)
        for (pl_u32 code=0u;code<16u;++code)
            if (!check_narrow_mask_branch(shift,code,&comparisons)) return 1;
    const pl_u32 overlays[][2] = {{32u,0xffffff9fu},{0x155u,0x7fffffffu},
        {0x180u,0xffffff80u},{0x4321u,0xfffffff0u}};
    for (pl_u32 word = 32u; word <= 64u; word += 32u)
        for (pl_u32 bits = 8u; bits <= 16u; bits *= 2u)
            for (pl_u32 i = 0u; i < sizeof overlays/sizeof overlays[0]; ++i)
                for (pl_u32 code = 0u; code < 16u; ++code) {
                    pl_u32 bias = word == 64u && i == 1u ? 0x7fffu : overlays[i][1];
                    if (!check_overlay_bias(word,bits,overlays[i][0],bias,code,&comparisons))
                        return 1;
                }
    for (pl_u32 bits=32u;bits<=64u;bits+=32u)
        for (pl_u32 shift=1u;shift<=15u;shift+=14u)
            for (pl_u32 code=0u;code<16u;++code)
                if (!check_shared_mask_branch(bits,shift,code,&comparisons)) return 1;
    for (pl_u32 mask_bits=2u; mask_bits<=5u; ++mask_bits)
        for (pl_u32 shift=1u; shift<=2u; ++shift)
            for (pl_u32 flags=0u; flags<2u; ++flags)
                if (!check_masked_fanout(mask_bits,shift,flags,&comparisons)) return 1;
    for (pl_u32 shift=1u;shift<=7u;shift+=2u)
        for (pl_u32 code=0u;code<16u;++code)
            if (!check_resident_fanout_branch(shift,code,&comparisons)) return 1;
    for (pl_u32 position=0u; position<7u; ++position)
        if (!check_bit_lane_merge(position,&comparisons)) return 1;
    for (pl_u32 bits=32u; bits<=64u; bits+=32u)
        for (pl_u32 code=0u; code<16u; ++code)
            if (!check_shift_mask_select(bits,code,&comparisons)) return 1;
    static const pl_u32 shifts[] = {1u,6u,31u,63u};
    for (pl_u32 i = 0u; i < sizeof shifts / sizeof shifts[0]; ++i)
        for (pl_u32 code = 0u; code < 16u; ++code)
            for (pl_u32 spare = 0u; spare < 2u; ++spare)
                if (!check_seeded_compare_lifetime(shifts[i],code,spare,&comparisons)) return 1;
    for (pl_u32 bits = 32u; bits <= 64u; bits += 32u)
        for (pl_u32 code = 0u; code < 16u; ++code)
            if (!check_projected_sum(bits,code,&comparisons)) return 1;
    for (pl_u32 bits = 8u; bits <= 64u; bits *= 2u)
        for (pl_u32 test = 0u; test < 2u; ++test)
            for (pl_u32 immediate = 0u; immediate < 4u; ++immediate)
                for (pl_u32 code = 0u; code < 16u; ++code)
                    for (pl_u32 expression = 0u; expression < 12u; ++expression)
                        for (pl_u32 branch = 0u; branch <= (expression >= 8u ? 2u : 0u); ++branch)
                            if ((test || expression < 2u || expression >= 4u)
                                    && !check_case(bits, test, immediate, code, expression,
                                             branch, &comparisons)) return 1;
    printf("compare cut: green (%llu source/generated/reference comparisons; "
           "8/16/32/64-bit CMP/TEST, signed immediates/registers, all Jcc/SETcc/CMOV, signed and aliased publications)\n",
           (unsigned long long)comparisons);
    return 0;
}
