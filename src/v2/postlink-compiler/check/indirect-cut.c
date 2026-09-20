#define _GNU_SOURCE
#include "../src/internal/select-x86.h"
#include "execute.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* A dynamic terminal consumes an SSA result, just like an ordinary published
 * register. Its presence must not disable normalization of the pure body.
 * Both native continuations record values and flags before restoring the ABI. */
static int check_jump(pl_u32 owner, pl_u32 flags_live,
                      pl_u32 address_copy, pl_u32 dead_prefix,
                      pl_u64 *comparisons)
{
    static const pl_u8 setup[] = {
        0x55u, 0x41u, 0x55u,             /* push rbp; push r13 */
        0x48u, 0x8bu, 0x06u,             /* mov rax,[rsi] */
        0x48u, 0x8bu, 0x56u, 8u,         /* mov rdx,[rsi+8] */
        0x4cu, 0x8bu, 0x46u, 16u,        /* mov r8,[rsi+16] */
        0x48u, 0x8bu, 0x6eu, 24u,        /* mov rbp,[rsi+24] */
        0x4cu, 0x8bu, 0x6eu, 32u,        /* mov r13,[rsi+32] */
    };
    pl_u8 source[32];
    pl_u32 length = 0u, address_field = 0u, address_end = 0u;
    if (dead_prefix) source[length++] = 0x90u;
    if (address_copy) {
        source[length++] = 0x4cu; source[length++] = 0x8du;
        source[length++] = 0x2du;        /* lea r13,[rip+target] */
        address_field = length;
        address_end = length + 4u;
        for (pl_u32 byte = 0u; byte < 4u; ++byte)
            source[length++] = (pl_u8)((0x800u-address_end) >> (byte*8u));
    } else {
        source[length++] = 0x49u; source[length++] = 0x89u;
        source[length++] = 0xf5u;        /* mov r13,rsi */
    }
    source[length++] = 0x44u; source[length++] = 0x89u;
    source[length++] = 0xc5u;            /* mov ebp,r8d */
    source[length++] = (pl_u8)(0x48u | (owner >= 8u ? 1u : 0u));
    source[length++] = 0x01u;            /* add target,rdx */
    source[length++] = (pl_u8)(0xd0u | (owner & 7u));
    if (owner >= 8u) source[length++] = 0x41u;
    source[length++] = 0xffu;            /* jmp target */
    source[length++] = (pl_u8)(0xe0u | (owner & 7u));
    pl_u8 *memory = test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map = {source,0x1000u,length,length,5u,1u};
    pl_x86_image image = {&map,1u,0u,0x1000u};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace = {a,b,sizeof a,64u};
    pl_x86_block_workspace scratch = {c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates = {0};
    pl_x86_native_selection selected = {0};
    pl_u32 span = 0u, work = 0u;
    pl_u32 live = (1u << PL_X86_LOCAL_COUNT) - 1u;
    if (!flags_live) live &= ~(1u << PL_X86_RFLAGS_LOCAL);
    int status = pl_x86_frontend_open(&image,&frontend);
    if (!status) status = pl_x86_block_lower_projected_until(
        &frontend,0x1000u,0x1000u+length,live,&workspace,&block);
    if (!status) status = pl_x86_select_candidates(
        &frontend,&scratch,&block,&candidates);
    if (status) goto failed;
    for (pl_u32 i = 0u; i <= candidates.count; ++i) {
        pl_u8 *entry = memory+i*512u;
        memcpy(entry,setup,sizeof setup);
        pl_u32 at = sizeof setup;
        entry[at++] = (pl_u8)(0x48u | (owner >= 8u ? 1u : 0u));
        entry[at++] = 0x89u;
        entry[at++] = (pl_u8)(0xc0u | (owner & 7u)); /* mov target,rax */
        if (!i) {
            memcpy(entry+at,source,length);
            if (address_copy) {
                pl_u32 displacement = 12500u-at-address_end;
                for (pl_u32 byte = 0u; byte < 4u; ++byte)
                    entry[at+address_field+byte] = (pl_u8)(displacement >> (byte*8u));
            }
        }
        else {
            pl_u32 written = 0u;
            const pl_x86_native_selection *candidate = &candidates.candidate[i-1u];
            status = pl_x86_select_write_measured(
                &frontend,&block,candidate,entry+at,256u,&written);
            if (status || written != candidate->output_bytes) goto failed;
            for (pl_u32 field = 0u; field < candidate->fixup_count; ++field) {
                if (!address_copy || candidate->fixups[field].target != 0x1800u)
                    goto failed;
                status = pl_x86_select_bind_fixup(entry+at,written,candidate,
                    field,(pl_u64)(uintptr_t)(entry+at),
                    (pl_u64)(uintptr_t)(memory+12500u));
                if (status) goto failed;
            }
        }
    }
    for (pl_u32 arm = 0u; arm < 2u; ++arm) {
        pl_u8 *tail = memory+12000u+arm*128u;
        pl_u8 observe[] = {
            0x48u,0x89u,0x07u,          /* mov [rdi],target */
            0x4cu,0x89u,0x6fu,8u,      /* mov [rdi+8],r13 */
            0x48u,0x89u,0x6fu,16u,     /* mov [rdi+16],rbp */
            0x9cu,0x59u,0x48u,0x89u,0x4fu,24u,
            0x48u,0xc7u,0x47u,32u,0u,0u,0u,0u,
            0x41u,0x5du,0x5du,0xc3u,
        };
        observe[0] = (pl_u8)(0x48u | (owner >= 8u ? 4u : 0u));
        observe[2] = (pl_u8)(0x07u | ((owner & 7u) << 3u));
        observe[21] = (pl_u8)arm;
        memcpy(tail,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    typedef void (__attribute__((sysv_abi)) *function)(pl_u64 *,const pl_u64 *);
    const pl_u64 edges[] = {0u,1u,127u,128u,UINT32_MAX,1ull<<32u,
        (1ull<<63u)-1u,1ull<<63u,UINT64_MAX};
    pl_u64 random = 0x594f016abc7283deull;
    for (pl_u32 sample = 0u; sample < 4096u; ++sample) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        pl_u32 arm = sample & 1u;
        pl_u64 target = (pl_u64)(uintptr_t)(memory+12000u+arm*128u);
        pl_u64 delta = sample < sizeof edges/sizeof edges[0] ? edges[sample] : random;
        pl_u64 base = target-delta;
        pl_u64 input[] = {base,delta,~random,random,random*17u};
        pl_u32 parity = 0u;
        for (pl_u32 bit = 0u; bit < 8u; ++bit) parity ^= (pl_u32)(target>>bit)&1u;
        pl_u64 flags = (target < base ? 1u : 0u) | (!parity ? 4u : 0u)
            | ((base^delta^target)&16u) | (!target ? 64u : 0u)
            | (target>>63u ? 128u : 0u)
            | ((~(base^delta)&(base^target))>>63u ? 2048u : 0u);
        pl_u64 copied = address_copy ? (pl_u64)(uintptr_t)(memory+12500u)
                                     : (pl_u64)(uintptr_t)input;
        pl_u64 expected[] = {target,copied,(pl_u32)input[2],
            flags_live ? flags : 0u,arm};
        for (pl_u32 i = 0u; i <= candidates.count; ++i) {
            union {void *object; function call;} fn;
            fn.object = memory+i*512u;
            pl_u64 actual[5] = {0};
            fn.call(actual,input);
            actual[3] &= flags_live ? 0x8d5u : 0u;
            if (memcmp(actual,expected,sizeof expected)) {
                fprintf(stderr,"indirect cut: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    status = pl_x86_candidates_select_joint_minimum(
        &candidates,0u,0u,&selected,&span,&work);
    int factored = 0;
    for (pl_u32 i = 0u; i < candidates.count; ++i)
        factored |= candidates.candidate[i].indirect_tail_owner != 0u;
    if (status || !factored || !selected.normalized_family_present || work > 4u)
        goto failed;
    test_code_release(memory,16384u);
    return 1;
failed:
    fprintf(stderr,"indirect cut: RED owner=%u flags=%u address=%u prefix=%u status=%d candidates=%u work/span=%u/%u\n",
        owner,flags_live,address_copy,dead_prefix,status,candidates.count,work,span);
    test_code_release(memory,16384u);
    return 0;
}

int main(void)
{
    const pl_u32 owners[] = {0u,1u,9u,10u,11u};
    pl_u64 comparisons = 0u;
    for (pl_u32 i = 0u; i < sizeof owners/sizeof owners[0]; ++i)
        for (pl_u32 flags = 0u; flags < 2u; ++flags)
            for (pl_u32 address = 0u; address < 2u; ++address)
                for (pl_u32 prefix = 0u; prefix < 2u; ++prefix)
                    if (!check_jump(owners[i],flags,address,prefix,&comparisons))
                        return 1;
    printf("indirect cut: green (%llu source/generated/reference comparisons)\n",
        (unsigned long long)comparisons);
    return 0;
}
