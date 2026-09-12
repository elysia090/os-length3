#define _GNU_SOURCE
#include "../src/internal/select-x86.h"
#include "execute.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#if !defined(__x86_64__)
#error This check executes x86-64 instructions on the host CPU.
#endif

typedef struct { pl_u64 value, product, flags, taken; } observation;
typedef void (__attribute__((sysv_abi)) *leaf_function)(
    observation *, pl_u64, pl_u64, pl_u64);

static pl_u64 compare_flags(pl_u64 left, pl_u64 right)
{
    pl_u64 difference = left - right;
    pl_u32 parity = 0u;
    for (pl_u32 bit = 0u; bit < 8u; ++bit) parity ^= (pl_u32)(difference >> bit) & 1u;
    return (left < right ? 1u : 0u) | (!parity ? 4u : 0u)
         | ((left ^ right ^ difference) & 16u) | (!difference ? 64u : 0u)
         | ((difference >> 56u) & 128u)
         | ((((left ^ right) & (left ^ difference)) >> 52u) & 2048u);
}

static int check_case(pl_u32 family, pl_u64 *comparisons)
{
    /* SysV arguments: observation, input, radix, previous value. */
    static const pl_u8 prefix[] = {
        0x48u, 0x89u, 0xf0u, /* mov rax,rsi */
        0x48u, 0x89u, 0xd6u, /* mov rsi,rdx */
        0x48u, 0x89u, 0xcau, /* mov rdx,rcx */
    };
    static const pl_u8 accumulation[] = {
        0x48u, 0x89u, 0xd1u, 0x83u, 0xe8u, 0x30u,
        0x48u, 0x0fu, 0xafu, 0xceu, 0x48u, 0x98u,
        0x48u, 0x01u, 0xc8u,
    }; /* rcx=previous*radix; rax=sign_extend32(input-48)+rcx */
    pl_u8 source[32];
    pl_u32 length = 0u;
    if (!family) {
        memcpy(source, accumulation, sizeof accumulation);
        length = sizeof accumulation;
    } else {
        if (family == 2u) source[length++] = 0x48u;
        source[length++] = 0x0fu;
        source[length++] = 0xafu;
        source[length++] = 0xc6u; /* imul eax,esi or imul rax,rsi */
    }
    const pl_u8 compare_branch[] = { 0x48u, 0x39u, 0xf0u, 0x72u, 0x08u };
    memcpy(source + length, compare_branch, sizeof compare_branch);
    length += sizeof compare_branch;
    static const pl_u8 observe[] = {
        0x41u, 0xb9u, 0u, 0u, 0u, 0u, /* mov r9d,0 */
        0xebu, 0x06u,
        0x41u, 0xb9u, 1u, 0u, 0u, 0u, /* mov r9d,1 */
        0x48u, 0x89u, 0x07u,
        0x48u, 0x89u, 0x4fu, 0x08u,
        0x9cu, 0x41u, 0x5au,           /* pushfq; pop r10 */
        0x4cu, 0x89u, 0x57u, 0x10u,
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
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(
        &frontend, address, address + length,
        (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status) {
        block.relax_short_control = 1u;
        status = pl_x86_select_candidates(&frontend, &selection_workspace, &block, &candidates);
    }
    const pl_x86_native_selection *selected = NULL;
    if (!status)
        for (pl_u32 i = 0u; i < candidates.count; ++i)
            if (candidates.candidate[i].supported && !candidates.candidate[i].copied_source) {
                selected = &candidates.candidate[i];
                break;
            }
    pl_u8 *output = memory + 512u + sizeof prefix;
    pl_u32 written = 0u;
    if (selected) status = pl_x86_select_write_measured(
        &frontend, &block, selected, output, 256u, &written);
    if (status || !selected || written != selected->output_bytes) goto failed;
    for (pl_u32 i = 0u; i < selected->fixup_count; ++i)
        if (pl_x86_select_bind_fixup(output, written, selected, i,
                (pl_u64)(uintptr_t)output, selected->fixups[i].target)) goto failed;
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
        0u, 1u, 47u, 48u, 49u, 0x7fffffff, 0x80000000,
        0x80000030u, UINT32_MAX, 1ull << 32u, 1ull << 63u, UINT64_MAX };
    pl_u64 random = 0x6a09e667f3bcc909ull;
    for (pl_u32 i = 0u; i < 4096u; ++i) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u64 input = i < 144u ? boundary[i % 12u] : random;
        pl_u64 radix = i < 144u ? boundary[i / 12u] : random * 0x9e3779b97f4a7c15ull;
        pl_u64 previous = (random << 32u) ^ (random >> 32u);
        pl_u64 low = ((pl_u64)(pl_u32)input - 48u) & UINT32_MAX;
        pl_u64 widened = low | ((0ull - (low >> 31u)) & ~((pl_u64)UINT32_MAX));
        pl_u64 expected = family ? input * radix : previous * radix + widened;
        if (family == 1u) expected &= UINT32_MAX;
        pl_u64 product = family ? previous : previous * radix;
        pl_u64 flags = compare_flags(expected, radix);
        observation before = { 0 }, after = { 0 };
        original.function(&before, input, radix, previous);
        optimized.function(&after, input, radix, previous);
        if (before.value != expected || after.value != expected
                || before.product != product || after.product != product
                || (before.flags & 0x8d5u) != flags || (after.flags & 0x8d5u) != flags
                || before.taken != (expected < radix) || after.taken != (expected < radix)) {
            fprintf(stderr, "arithmetic cut mismatch family=%u input=%llx radix=%llx\n",
                    family, (unsigned long long)input, (unsigned long long)radix);
            goto failed;
        }
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "arithmetic cut: RED family=%u status=%d\n", family, status);
    test_code_release(memory, 4096u);
    return 0;
}

int main(void)
{
    pl_u64 comparisons = 0u;
    for (pl_u32 family = 0u; family < 3u; ++family)
        if (!check_case(family, &comparisons)) return 1;
    printf("arithmetic cut: green (%llu source/generated/reference comparisons; "
           "multiply, signed widening, final flags and both branch outcomes)\n",
           (unsigned long long)comparisons);
    return 0;
}
