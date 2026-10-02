#define _GNU_SOURCE
#include "../src/internal/x86-selection.h"
#include "execute.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#if !defined(__x86_64__)
#error This check executes x86-64 instructions on the host CPU.
#endif

typedef struct { pl_u64 value, candidate, flags; } observation;
typedef void (__attribute__((sysv_abi)) *leaf_function)(
    observation *, pl_u64, pl_u64);

static int condition(pl_u32 code, pl_u64 flags)
{
    int c = !!(flags & 1u), p = !!(flags & 4u), z = !!(flags & 64u);
    int s = !!(flags & 128u), o = !!(flags & 2048u);
    int positive;
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
    return positive ^ (int)(code & 1u);
}

static int check_case(pl_u32 code, pl_u32 bits, pl_u32 published,
                      pl_u32 relative, pl_u32 rebase, pl_u64 *comparisons)
{
    /* First consume the entry flags in RSI; only the six arithmetic bits
     * vary. The generated body must preserve them all. RDI names the result
     * buffer and RDX contains the old candidate. No callee-saved GPR changes. */
    static const pl_u8 prefix[] = { 0x56u, 0x9du }; /* push rsi; popfq */
    static const pl_u8 observe[] = {
        0x48u, 0x89u, 0x07u,             /* mov [rdi],rax */
        0x48u, 0x89u, 0x57u, 0x08u,      /* mov [rdi+8],rdx */
        0x9cu, 0x59u,                   /* pushfq; pop rcx */
        0x48u, 0x89u, 0x4fu, 0x10u,      /* mov [rdi+16],rcx */
        0xc3u,
    };
    pl_u8 source[32];
    pl_u32 length = 0u;
    if (published) {
        source[length++] = 0xbau;        /* mov edx,condition code */
        source[length++] = (pl_u8)code;
        for (pl_u32 i = 0u; i < 3u; ++i) source[length++] = 0u;
    }
    if (relative) {
        const pl_u8 address[] = { 0x48u, 0x8du, 0x05u, 0x26u, 0xe7u, 4u, 0u };
        memcpy(source + length, address, sizeof address);
        length += sizeof address;
    } else {
        source[length++] = 0xb8u;        /* mov eax,77 */
        source[length++] = 77u;
        for (pl_u32 i = 0u; i < 3u; ++i) source[length++] = 0u;
    }
    pl_u32 address_end = length;
    if (bits == 64u) source[length++] = 0x48u;
    source[length++] = 0x0fu;
    source[length++] = (pl_u8)(0x40u | code); /* cmovcc rax,rdx */
    source[length++] = 0xc2u;
    if (!published) {
        source[length++] = 0xbau;
        source[length++] = (pl_u8)code;
        for (pl_u32 i = 0u; i < 3u; ++i) source[length++] = 0u;
    }

    pl_u8 *memory = test_code_allocate(4096u);
    if (!memory) return 0;
    pl_u64 source_address = (pl_u64)(uintptr_t)(memory + sizeof prefix);
    pl_x86_map map = { source, source_address, length, length,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u };
    pl_x86_image image = { &map, 1u, 0u, source_address };
    pl_x86_frontend frontend;
    static pl_u8 first[1024u * 1024u], second[1024u * 1024u];
    static pl_u8 select_first[1024u * 1024u], select_second[1024u * 1024u];
    pl_x86_block_workspace workspace = { first, second, sizeof first, 64u };
    pl_x86_block_workspace selection_workspace = {
        select_first, select_second, sizeof select_first, 64u };
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
    const pl_x86_native_selection *selected = NULL;
    if (!status)
        for (pl_u32 i = 0u; i < candidates.count; ++i)
            if (candidates.candidate[i].supported
                    && !candidates.candidate[i].copied_source) {
                selected = &candidates.candidate[i];
                break;
            }
    pl_u32 written = 0u;
    pl_u8 *output = memory + 512u + sizeof prefix;
    if (selected)
        status = pl_x86_select_write_measured(
            &frontend, &block, selected, output, 256u, &written);
    if (status || !selected || written != selected->output_bytes
            || selected->output_work > 3u || selected->output_span > 2u) {
        fprintf(stderr, "condition code: missing bounded generated body "
                "(status=%d cc=%u bits=%u published=%u relative=%u rebase=%u)\n",
                status, code, bits, published, relative, rebase);
        if (!status)
            fprintf(stderr, "candidates=%u rejection=%x/%x selected=%u/%u/%u\n",
                    candidates.count, candidates.diagnostic.blocking_work,
                    candidates.diagnostic.blocking_opcode,
                    selected ? selected->output_work : 0u,
                    selected ? selected->output_span : 0u,
                    selected ? selected->output_bytes : 0u);
        for (pl_u32 n = 0u; !status && n < block.plan.node_count; ++n) {
            const pl_node *node = &block.plan.nodes[n];
            fprintf(stderr, "node %u opcode %u:", n + 1u, node->opcode);
            for (pl_u32 a = 0u; a < node->argument_count; ++a) {
                pl_operand operand = block.plan.arguments[node->argument_at + a];
                fprintf(stderr, " %u:%llx", (unsigned)operand.kind,
                        (unsigned long long)operand.value);
            }
            fputc('\n', stderr);
        }
        test_code_release(memory, 4096u);
        return 0;
    }
    /* Move the linked target independently of the emitted body. A truncated
     * address is still a relocatable binding, not its old low-word literal. */
    pl_u32 target_delta = rebase ? 0x10037u : 0u;
    if (relative && !selected->fixup_count) {
        test_code_release(memory, 4096u);
        return 0;
    }
    for (pl_u32 i = 0u; i < selected->fixup_count; ++i)
        if (pl_x86_select_bind_fixup(
                output, written, selected, i, (pl_u64)(uintptr_t)output,
                selected->fixups[i].target + target_delta)) {
            test_code_release(memory, 4096u);
            return 0;
        }
    memcpy(memory, prefix, sizeof prefix);
    memcpy(memory + sizeof prefix, source, length);
    if (relative)
        for (pl_u32 byte = 0u; byte < 4u; ++byte)
            memory[sizeof prefix + address_end - 4u + byte] =
                (pl_u8)((0x4e726u + target_delta) >> (8u * byte));
    memcpy(memory + sizeof prefix + length, observe, sizeof observe);
    memcpy(memory + 512u, prefix, sizeof prefix);
    memcpy(output + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) {
        test_code_release(memory, 4096u);
        return 0;
    }
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory;
    optimized.object = memory + 512u;
    const pl_u64 flag_mask = 0x8d5u;
    static const pl_u64 boundary[] = {
        0u, 1u, UINT32_MAX, 1ull << 32u, 1ull << 63u, UINT64_MAX };
    pl_u64 random = 0x6a09e667f3bcc909ull;
    int equal = 1;
    for (pl_u32 f = 0u; f < 64u && equal; ++f) {
        pl_u64 flags = 0x202u | (f & 1u) | ((f & 2u) << 1u)
                     | ((f & 4u) << 2u) | ((f & 8u) << 3u)
                     | ((f & 16u) << 3u) | ((f & 32u) << 6u);
        for (pl_u32 i = 0u; i < 70u; ++i) {
            random ^= random << 13u;
            random ^= random >> 7u;
            random ^= random << 17u;
            pl_u64 input = i < sizeof boundary / sizeof boundary[0]
                         ? boundary[i] : random;
            pl_u64 seed = relative
                ? source_address + address_end + 0x4e726u + target_delta : 77u;
            pl_u64 expected = condition(code, flags) ? (published ? code : input) : seed;
            if (bits == 32u) expected &= UINT32_MAX;
            observation before = { 0 }, after = { 0 };
            original.function(&before, flags, input);
            optimized.function(&after, flags, input);
            if (before.value != expected || after.value != expected
                    || before.candidate != code || after.candidate != code
                    || (before.flags & flag_mask) != (flags & flag_mask)
                    || (after.flags & flag_mask) != (flags & flag_mask)) {
                fprintf(stderr, "condition code: mismatch cc=%u bits=%u "
                        "published=%u relative=%u flags=%llx input=%llx\n",
                        code, bits, published, relative,
                        (unsigned long long)flags, (unsigned long long)input);
                equal = 0;
                break;
            }
            ++*comparisons;
        }
    }
    test_code_release(memory, 4096u);
    return equal;
}

static int check_high_byte(pl_u32 owner, pl_u32 code, pl_u32 lifetime,
                            pl_u32 mask, pl_u64 *comparisons)
{
    /* The wrapper preserves RBX. The body alone is normalized; the observer
     * reads the selected value, the byte owner's full register, and RFLAGS. */
    pl_u8 prefix[] = { 0x53u, 0x48u, 0x89u, (pl_u8)(0xf0u | owner),
        0x41u, 0xb8u, 77u, 0u, 0u, 0u };
    pl_u8 source[32];
    pl_u32 length = 0u;
    source[length++] = 0xf6u;
    source[length++] = (pl_u8)(0xc4u | owner);
    source[length++] = (pl_u8)mask;
    pl_u32 destination = lifetime == 2u ? owner : 8u;
    if (lifetime) {
        source[length++] = 0x41u; source[length++] = 0xb9u;
        source[length++] = 99u;
        for (pl_u32 i = 0u; i < 3u; ++i) source[length++] = 0u;
        if (destination >= 8u) source[length++] = 0x41u;
        source[length++] = (pl_u8)(0xb8u | (destination & 7u));
        source[length++] = 77u;
        for (pl_u32 i = 0u; i < 3u; ++i) source[length++] = 0u;
        source[length++] = (pl_u8)(0x49u | (destination >= 8u ? 4u : 0u));
        source[length++] = 0x0fu; source[length++] = (pl_u8)(0x40u | code);
        source[length++] = (pl_u8)(0xc1u | ((destination & 7u) << 3u));
        if (lifetime == 2u) {
            source[length++] = 0x49u; source[length++] = 0x89u;
            source[length++] = (pl_u8)(0xc0u | (owner << 3u));
        }
    }
    pl_u8 observe[] = { 0x4cu, 0x89u, 0x07u, 0x48u, 0x89u,
        (pl_u8)(0x47u | (owner << 3u)), 8u,
        0x9cu, 0x41u, 0x5au, 0x4cu, 0x89u, 0x57u, 16u, 0x5bu, 0xc3u };
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
    int status = pl_x86_frontend_open(&image, &frontend);
    if (!status) status = pl_x86_block_lower_projected_until(&frontend,
        address, address + length, (1u << PL_X86_LOCAL_COUNT) - 1u, &workspace, &block);
    if (!status && block.end != address + length) status = PL_ERROR_BLOCK;
    if (!status) block.construction_fields = 1u;
    if (!status) status = pl_x86_select_candidates(&frontend, &selection_workspace,
        &block, &candidates);
    if (!status) status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, &selected, &span, &work);
    if (status || selected.copied_source || !selected.normalized_family_present
            || work > (lifetime ? 3u + lifetime : 1u)) goto failed;
    if (!status) status = pl_x86_select_write_measured(&frontend, &block, &selected,
        memory + 512u + sizeof prefix, 256u, &written);
    if (status || selected.fixup_count || written != selected.output_bytes) goto failed;
    memcpy(memory, prefix, sizeof prefix);
    memcpy(memory + sizeof prefix, source, length);
    memcpy(memory + sizeof prefix + length, observe, sizeof observe);
    memcpy(memory + 512u, prefix, sizeof prefix);
    memcpy(memory + 512u + sizeof prefix + written, observe, sizeof observe);
    if (!test_code_publish(memory, 4096u)) goto failed;
    union { void *object; leaf_function function; } original, optimized;
    original.object = memory; optimized.object = memory + 512u;
    for (pl_u32 byte = 0u; byte < 256u; ++byte) {
        pl_u64 input = 0x9abc5678000000e7ull | ((pl_u64)byte << 8u);
        pl_u32 result = byte & mask, parity = 0u;
        for (pl_u32 bit = 0u; bit < 8u; ++bit) parity ^= (result >> bit) & 1u;
        pl_u64 flags = (!result ? 64u : 0u) | (!parity ? 4u : 0u) | (result & 128u);
        pl_u64 value = lifetime && condition(code, flags) ? 99u : 77u;
        pl_u64 full_owner = lifetime == 2u ? value : input;
        observation before = { 0 }, after = { 0 };
        original.function(&before, input, 0u); optimized.function(&after, input, 0u);
        if (before.value != value || after.value != value
                || before.candidate != full_owner || after.candidate != full_owner
                || (before.flags & 0x8c5u) != flags || (after.flags & 0x8c5u) != flags)
            goto failed;
        ++*comparisons;
    }
    test_code_release(memory, 4096u);
    return 1;
failed:
    fprintf(stderr, "high-byte condition: RED owner=%u cc=%u lifetime=%u mask=%u "
        "status=%d work/span=%u/%u normalized=%u comparisons=%llu\n",
        owner, code, lifetime, mask, status, work, span, selected.normalized_family_present,
        (unsigned long long)*comparisons);
    for (pl_u32 n = 0u; !status && n < block.plan.node_count; ++n) {
        const pl_node *node = &block.plan.nodes[n];
        fprintf(stderr, " node %u opcode %u:", n + 1u, node->opcode);
        for (pl_u32 a = 0u; a < node->argument_count; ++a) {
            pl_operand value = block.plan.arguments[node->argument_at + a];
            fprintf(stderr, " %u:%llu", value.kind, (unsigned long long)value.value);
        }
        fputc('\n', stderr);
    }
    test_code_release(memory, 4096u);
    return 0;
}

int main(void)
{
    pl_u64 comparisons = 0u;
    for (pl_u32 code = 0u; code < 16u; ++code)
        for (pl_u32 bits = 32u; bits <= 64u; bits += 32u)
            for (pl_u32 published = 0u; published < 2u; ++published)
                for (pl_u32 relative = 0u; relative < 2u; ++relative)
                    for (pl_u32 rebase = 0u; rebase <= relative; ++rebase)
                        if (!check_case(code, bits, published, relative, rebase, &comparisons))
                            return 1;
    static const pl_u32 masks[] = { 0u, 1u, 3u, 0x55u, 0x80u, 0xffu };
    for (pl_u32 owner = 0u; owner < 4u; ++owner)
        for (pl_u32 code = 0u; code < 16u; ++code)
            for (pl_u32 lifetime = 0u; lifetime < 3u; ++lifetime)
                for (pl_u32 m = 0u; m < sizeof masks / sizeof masks[0]; ++m)
                    if (!check_high_byte(owner, code, lifetime, masks[m], &comparisons)) return 1;
    printf("condition code: green (%llu source/generated/reference comparisons; "
           "16 conditions, high bytes, entry/published generations, values and flags)\n",
           (unsigned long long)comparisons);
    return 0;
}
