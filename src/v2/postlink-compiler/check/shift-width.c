#define _GNU_SOURCE

#include "../src/internal/select-x86.h"
#include "execute.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#if !defined(__x86_64__)
#error This check executes x86-64 instructions on the host CPU.
#endif

/* The fixture's argument is in RDI on both hosts. The compiler supplies the
 * Windows-to-SysV call adaptation; the selected instruction body is unchanged. */
typedef pl_u64 (__attribute__((sysv_abi)) *leaf_function)(pl_u64);

static pl_u64 reference(pl_u64 input, pl_u32 bits,
                        pl_u32 group, pl_u32 count)
{
    pl_u64 mask = bits == 64u ? UINT64_MAX : UINT32_MAX;
    pl_u64 value = input & mask;
    count &= bits - 1u;
    if (count) {
        switch (group) {
        case 0u: value = (value << count) | (value >> (bits - count)); break;
        case 1u: value = (value >> count) | (value << (bits - count)); break;
        case 4u: value <<= count; break;
        case 5u: value >>= count; break;
        case 7u:
            value = (value >> count)
                  | ((0ull - (value >> (bits - 1u))) << (bits - count));
            break;
        default: return UINT64_MAX;
        }
    }
    value &= 127u;
    pl_u32 parity = 0u;
    for (pl_u32 bit = 0u; bit < 8u; ++bit)
        parity ^= (pl_u32)(value >> bit) & 1u;
    pl_u64 flags = (value == 0u ? 64u : 0u) | (parity == 0u ? 4u : 0u);
    return value | (flags << 32u);
}

static int check_case(pl_u32 bits, pl_u32 group, pl_u32 count, pl_u32 narrow_input,
                      pl_u64 *comparisons)
{
    pl_u8 source[16];
    pl_u32 length = 0u;
    if (!narrow_input) source[length++] = 0x48u;
    source[length++] = 0x89u; /* mov rax,rdi or mov eax,edi */
    source[length++] = 0xf8u;
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0xc1u;
    source[length++] = (pl_u8)(0xc0u | (group << 3u));
    source[length++] = (pl_u8)count;
    if (bits == 32u) source[length++] = 0x48u;
    source[length++] = 0x83u; /* and at the opposite width */
    source[length++] = 0xe0u;
    source[length++] = 0x7fu;

    pl_x86_map map = {
        source, 0x1000u, length, length,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    pl_x86_frontend frontend;
    static pl_u8 first[1024u * 1024u], second[1024u * 1024u];
    static pl_u8 select_first[1024u * 1024u], select_second[1024u * 1024u];
    pl_x86_block_workspace workspace = { first, second, sizeof first, 64u };
    pl_x86_block_workspace selection_workspace = {
        select_first, select_second, sizeof select_first, 64u,
    };
    pl_x86_block block;
    pl_x86_native_candidates candidates;
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status)
        status = pl_x86_block_lower_projected_until(
            &frontend, image.entry, image.entry + length,
            (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status)
        status = pl_x86_select_candidates(
            &frontend, &selection_workspace, &block, &candidates);
    if (status) {
        fprintf(stderr, "shift width: construction status=%d\n", status);
        return 0;
    }

    /* Execute an actually generated candidate, even if an equal source
     * spelling wins the final byte/rank tie. Source execution alone cannot
     * test the new production. */
    const pl_x86_native_selection *selected = NULL;
    for (pl_u32 i = 0u; i < candidates.count; ++i)
        if (candidates.candidate[i].supported
                && !candidates.candidate[i].copied_source) {
            selected = &candidates.candidate[i];
            break;
        }
    if (!selected) {
        fprintf(stderr, "shift width: no generated candidate (%u candidates, "
                "rejection=%x/%x)\n", candidates.count,
                candidates.diagnostic.blocking_work,
                candidates.diagnostic.blocking_opcode);
        return 0;
    }

    /* Return the low result and only CF/PF/ZF/SF/OF from the final AND.
     * AF is undefined and must not participate in a differential verdict. */
    static const pl_u8 observe[] = {
        0x9cu, 0x5au,                         /* pushfq; pop rdx */
        0x81u, 0xe2u, 0xc5u, 0x08u, 0u, 0u, /* and edx,0x8c5 */
        0x48u, 0xc1u, 0xe2u, 0x20u,         /* shl rdx,32 */
        0x48u, 0x09u, 0xd0u, 0xc3u,         /* or rax,rdx; ret */
    };
    pl_u8 *memory = test_code_allocate(4096u);
    if (!memory) return 0;
    pl_u32 written = 0u;
    status = pl_x86_select_write_measured(
        &frontend, &block, selected, memory + 256u, 256u,
        &written);
    if (status || written != selected->output_bytes) {
        test_code_release(memory, 4096u);
        return 0;
    }
    memcpy(memory, source, length);
    memcpy(memory + length, observe, sizeof observe);
    memcpy(memory + 256u + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) {
        test_code_release(memory, 4096u);
        return 0;
    }
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory;
    optimized.object = memory + 256u;
    static const pl_u64 boundary[] = {
        0u, 1u, 127u, 128u, UINT32_MAX, 1ull << 32u,
        1ull << 49u, 1ull << 63u, UINT64_MAX,
        0xaaaaaaaaaaaaaaaaull, 0x5555555555555555ull,
    };
    pl_u64 random = 0x6a09e667f3bcc909ull;
    int equal = 1;
    for (pl_u32 i = 0u; i < 512u + sizeof boundary / sizeof boundary[0]; ++i) {
        random ^= random << 13u;
        random ^= random >> 7u;
        random ^= random << 17u;
        pl_u64 input = i < sizeof boundary / sizeof boundary[0]
                     ? boundary[i] : random;
        pl_u64 expected = reference(input, bits, group, count);
        if (original.function(input) != expected
                || optimized.function(input) != expected) {
            fprintf(stderr, "shift width: mismatch input=%llx\n",
                    (unsigned long long)input);
            equal = 0;
            break;
        }
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return equal;
}

int main(void)
{
    static const pl_u32 groups[] = { 0u, 1u, 4u, 5u, 7u };
    static const pl_u32 counts[] = { 1u, 7u, 8u, 15u, 16u, 31u,
                                    32u, 33u, 49u, 63u, 64u };
    pl_u64 comparisons = 0u;
    for (pl_u32 bits = 32u; bits <= 64u; bits += 32u)
        for (pl_u32 g = 0u; g < sizeof groups / sizeof groups[0]; ++g)
            for (pl_u32 c = 0u; c < sizeof counts / sizeof counts[0]; ++c)
                for (pl_u32 narrow = 0u; narrow <= (bits == 32u ? 1u : 0u);
                        ++narrow) {
                    if (!check_case(bits, groups[g], counts[c], narrow,
                                    &comparisons)) {
                        fprintf(stderr,
                                "shift width: RED (bits=%u group=%u count=%u "
                                "narrow-input=%u)\n",
                                bits, groups[g], counts[c], narrow);
                        return 1;
                    }
                }
    printf("shift width: green (%llu source/generated/reference comparisons; "
           "value and defined flags agree)\n", (unsigned long long)comparisons);
    return 0;
}
