#define _GNU_SOURCE
#include "../src/internal/select-x86.h"
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

/* Partial SETcc shares the entry flag word with ordinary parallel copies and
 * constants. It must replace only the low byte, not zero-extend the boolean
 * over the surviving upper 56 bits. Exercise the direct-jump cut as well. */
static int check_partial_set_frame(pl_u32 code, pl_u32 destination,
                                    pl_u64 *comparisons)
{
    typedef struct { pl_u64 lane, copy, moved, constant, flags; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, const pl_u64 *);
    pl_u8 source[24]={0x4cu,0x89u,0xf1u,0x49u,0x89u,0xfeu,
        0x49u,0xbcu,0x21u,0u,0u,0u,0u,0u,0u,4u};
    pl_u32 length=16u;
    if (destination>=8u) source[length++]=0x41u;
    source[length++]=0x0fu; source[length++]=(pl_u8)(0x90u|code);
    source[length++]=(pl_u8)(0xc0u|(destination&7u));
    source[length++]=0xebu; source[length++]=0u;
    static const pl_u8 setup[]={
        0x41u,0x54u,0x41u,0x56u,0x41u,0x57u,0x49u,0x89u,0xfbu,
        0x48u,0x8bu,0x16u,0x49u,0x89u,0xd0u,0x49u,0x89u,0xd7u,
        0x4cu,0x8bu,0x76u,8u,0x48u,0x8bu,0x7eu,16u,
        0x48u,0x8bu,0x46u,24u,0x48u,0x83u,0xf8u,0u,
    };
    pl_u8 observe[]={
        destination>=8u ? 0x4du:0x49u,0x89u,(pl_u8)(0x03u|((destination&7u)<<3u)),
        0x49u,0x89u,0x4bu,8u,0x4du,0x89u,0x73u,16u,
        0x4du,0x89u,0x63u,24u,0x9cu,0x58u,0x49u,0x89u,0x43u,32u,
        0x41u,0x5fu,0x41u,0x5eu,0x41u,0x5cu,0xc3u,
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
        pl_x86_native_selection *candidate=&candidates.candidate[i];
        pl_u8 *body=memory+(i+1u)*512u+sizeof setup;
        pl_u32 written=0u;
        memcpy(body-sizeof setup,setup,sizeof setup);
        status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
        if (status) goto failed;
        for (pl_u32 j=0u; j<candidate->fixup_count; ++j) {
            if (candidate->fixups[j].target!=address+length) goto failed;
            status=pl_x86_select_bind_fixup(body,written,candidate,j,
                (pl_u64)(uintptr_t)body,(pl_u64)(uintptr_t)(body+written));
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0xb3102ec64fa9875dull;
    for (pl_u32 sample=0u; sample<2048u; ++sample) {
        random^=random<<13u; random^=random>>7u; random^=random<<17u;
        pl_u64 input[]={random,~random,random*17u,sample&3u ? random:0u};
        pl_u32 parity=0u;
        for (pl_u32 bit=0u; bit<8u; ++bit) parity^=(pl_u32)(input[3]>>bit)&1u;
        pl_u64 flags=(!input[3] ? 64u:0u)|(!parity ? 4u:0u)|(input[3]>>63u ? 128u:0u);
        pl_u64 lane=(input[0]&~255ull)|(pl_u32)condition(code,flags);
        for (pl_u32 i=0u; i<=candidates.count; ++i) {
            union { void *object; function call; } fn;
            fn.object=memory+i*512u;
            result actual={0}; fn.call(&actual,input);
            if (actual.lane!=lane || actual.copy!=input[1] || actual.moved!=input[2]
                    || actual.constant!=0x0400000000000021ull
                    || (actual.flags&0x8d5u)!=flags) goto failed;
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || selected.copied_source || !selected.normalized_family_present
            || work>5u || span>2u) goto failed;
    test_code_release(memory,16384u); return 1;
failed:
    fprintf(stderr,"partial SET frame: RED cc/destination=%u/%u status=%d candidates=%u comparisons=%llu diagnostic=%x\n",
        code,destination,status,candidates.count,(unsigned long long)*comparisons,
        candidates.diagnostic.blocking_work);
    test_code_release(memory,16384u); return 0;
}

/* The TEST consumes old RDX, an address occupies RDX only until CMOV, and
 * final RDX is the unrelated entry RAX. These are three different lifetimes,
 * not a dependency cycle or three materialized copies of one coordinate.
 * The stack adjustment is in the same cut; its flags must not escape TEST. */
static int check_transient_address(pl_u32 code, pl_u32 bits, pl_u32 compare,
                                    pl_u64 *comparisons)
{
    pl_u8 source[32]={0x48u,0x83u,0xecu,8u};
    pl_u32 length=4u;
    source[length++]=bits==64u ? 0x48u:0x40u;
    source[length++]=compare ? 0x83u:0x85u;
    source[length++]=compare ? 0xfau:0xd2u;
    if (compare) source[length++]=0x7fu;
    source[length++]=0x48u;source[length++]=0x8du;source[length++]=0x15u;
    pl_u32 field=length,address_end=length+4u;
    for (pl_u32 byte=0u;byte<4u;++byte)
        source[length++]=(pl_u8)((0x400u-address_end)>>(byte*8u));
    source[length++]=0x48u;source[length++]=0x0fu;
    source[length++]=(pl_u8)(0x40u|code);source[length++]=0xf2u;
    source[length++]=0x48u;source[length++]=0x89u;source[length++]=0xc2u;
    static const pl_u8 setup[]={0x48u,0x89u,0xc8u,0x49u,0x89u,0xe0u};
    static const pl_u8 observe[]={
        0x48u,0x89u,0x37u,0x48u,0x89u,0x57u,8u,
        0x9cu,0x59u,0x48u,0x89u,0x4fu,16u,
        0x48u,0x89u,0xe0u,0x4cu,0x29u,0xc0u,0x48u,0x89u,0x47u,24u,
        0x48u,0x8du,0x64u,0x24u,8u,0xc3u,
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
    pl_u32 span=0u,work=0u;
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+length,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status) goto failed;
    for (pl_u32 i=0u;i<=candidates.count;++i) {
        pl_u8 *entry=memory+i*512u,*body=entry+sizeof setup;
        pl_u32 written=length;
        memcpy(entry,setup,sizeof setup);
        if (!i) {
            memcpy(body,source,length);
            pl_u32 displacement=12000u-(pl_u32)sizeof setup-address_end;
            for (pl_u32 byte=0u;byte<4u;++byte)
                body[field+byte]=(pl_u8)(displacement>>(byte*8u));
        } else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            for (pl_u32 j=0u;!status && j<candidate->fixup_count;++j) {
                if (candidate->fixups[j].target!=0x1400u) goto failed;
                status=pl_x86_select_bind_fixup(body,written,candidate,j,
                    (pl_u64)(uintptr_t)body,address+12000u);
            }
            if (status) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    typedef void (__attribute__((sysv_abi)) *function)(pl_u64 *,pl_u64,pl_u64,pl_u64);
    static const pl_u64 edge[]={0u,1u,0x7fu,0x80u,0x7fffffffu,0x80000000u,UINT32_MAX,
        1ull<<32u,1ull<<63u,UINT64_MAX};
    pl_u64 random=0x537b0a68c947129full,mask=UINT64_MAX>>(64u-bits);
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input=sample<sizeof edge/sizeof edge[0] ? edge[sample]:random;
        pl_u64 tested=input&mask,current=~random,next=random*17u;
        pl_u64 result=compare ? (tested-127u)&mask:tested;
        pl_u32 parity=0u;
        for (pl_u32 bit=0u;bit<8u;++bit) parity^=(pl_u32)(result>>bit)&1u;
        pl_u64 flags=(!result ? 64u:0u)|(!parity ? 4u:0u)
            |(result>>(bits-1u) ? 128u:0u);
        if (compare) flags|=(tested<127u ? 1u:0u)|((tested^127u^result)&16u)
            |(((tested^127u)&(tested^result))>>(bits-1u) ? 2048u:0u);
        pl_u64 expected[]={condition(code,flags) ? address+12000u:current,next,flags,UINT64_MAX-7u};
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;function call;} fn;
            fn.object=memory+i*512u;
            pl_u64 actual[4]={0};fn.call(actual,current,input,next);
            actual[2]&=compare ? 0x8d5u:0x8c5u; /* TEST leaves AF undefined. */
            if (memcmp(actual,expected,sizeof expected)) {
                fprintf(stderr,"transient address: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || !selected.normalized_family_present || work>5u) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"transient address: RED cc/bits/compare=%u/%u/%u status=%d candidates=%u work/span=%u/%u\n",
        code,bits,compare,status,candidates.count,work,span);
    test_code_release(memory,16384u);return 0;
}

int main(void)
{
    pl_u64 comparisons = 0u;
    static const pl_u32 transient_codes[]={4u,5u,8u,9u,10u,11u};
    for (pl_u32 i=0u;i<sizeof transient_codes/sizeof transient_codes[0];++i)
        for (pl_u32 bits=32u;bits<=64u;bits+=32u)
            if (!check_transient_address(transient_codes[i],bits,0u,&comparisons)) return 1;
    for (pl_u32 code=0u;code<16u;++code)
        for (pl_u32 bits=32u;bits<=64u;bits+=32u)
            if (!check_transient_address(code,bits,1u,&comparisons)) return 1;
    static const pl_u32 set_destinations[]={2u,8u,15u};
    for (pl_u32 code=0u; code<16u; ++code)
        for (pl_u32 i=0u; i<sizeof set_destinations/sizeof set_destinations[0]; ++i)
            if (!check_partial_set_frame(code,set_destinations[i],&comparisons)) return 1;
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
