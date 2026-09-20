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

/* The shifted value is consumed by an address, not published in a GPR.
 * Its original register is then overwritten while the shift flags survive.
 * Independent constants must not hide that intermediate physical lifetime. */
static int check_consumed_shift(pl_u32 bits, pl_u32 group, pl_u32 count, pl_u32 overwrite,
                                 pl_u64 *comparisons)
{
    typedef struct { pl_u64 sum, overwritten, constant, address, flags; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, const pl_u64 *);
    pl_u8 source[32]={0xb9u,36u,0u,0u,0u,0xbeu,0x34u,0x12u,0u,0u};
    pl_u32 length=10u;
    if (bits==64u) source[length++]=0x48u;
    source[length++]=0xc1u;
    source[length++]=(pl_u8)(0xc2u|(group<<3u));
    source[length++]=(pl_u8)count;
    static const pl_u8 tail[]={0x48u,0x8du,0x3cu,2u};
    memcpy(source+length,tail,sizeof tail); length+=(pl_u32)sizeof tail;
    static const pl_u8 overwrite_code[3][5]={
        {0x41u,0x8du,0x51u,9u}, {0x4cu,0x89u,0xcau}, {0xbau,0u,0u,0u,0u},
    };
    pl_u32 overwrite_bytes=overwrite==0u ? 4u:overwrite==1u ? 3u:5u;
    memcpy(source+length,overwrite_code[overwrite],overwrite_bytes); length+=overwrite_bytes;
    static const pl_u8 setup[]={0x49u,0x89u,0xfbu,
        0x48u,0x8bu,0x16u,0x48u,0x8bu,0x46u,8u,
        0x4cu,0x8bu,0x4eu,16u,0x48u,0x83u,0xf8u,0u};
    static const pl_u8 observe[]={0x49u,0x89u,0x3bu,0x49u,0x89u,0x53u,8u,
        0x49u,0x89u,0x4bu,16u,0x49u,0x89u,0x73u,24u,
        0x9cu,0x58u,0x49u,0x89u,0x43u,32u,0xc3u};
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
    pl_u32 shift=count&(bits-1u);
    pl_u64 word=bits==64u ? UINT64_MAX:UINT32_MAX;
    static const pl_u64 edge[]={0u,1u,UINT32_MAX,1ull<<32u,1ull<<63u,UINT64_MAX};
    pl_u64 random=0xc8a694a5172ec23bull;
    for (pl_u32 sample=0u; sample<2048u; ++sample) {
        random^=random<<13u; random^=random>>7u; random^=random<<17u;
        pl_u64 input[]={sample<36u ? edge[sample%6u]:random,
            sample<36u ? edge[sample/6u]:~random,random*17u};
        pl_u64 value=input[0]&word, shifted=value;
        if (shift) {
            if (group==4u) shifted=(value<<shift)&word;
            else {
                shifted=value>>shift;
                if (group==7u) shifted|=((0ull-(value>>(bits-1u)))<<(bits-shift))&word;
            }
        }
        pl_u64 flag_value=shift ? shifted:input[1];
        pl_u32 parity=0u;
        for (pl_u32 bit=0u; bit<8u; ++bit) parity^=(pl_u32)(flag_value>>bit)&1u;
        pl_u64 flags=(!flag_value ? 64u:0u)|(!parity ? 4u:0u)
            |((flag_value>>(shift ? bits-1u:63u))&1u ? 128u:0u);
        pl_u64 flag_mask=shift ? 0xc5u:0x8d5u;
        if (shift) {
            pl_u64 carry=(value>>(group==4u ? bits-shift:shift-1u))&1u;
            flags|=carry;
            if (shift==1u) {
                flag_mask|=0x800u;
                if (group==4u) flags|=(((shifted>>(bits-1u))^carry)&1u)<<11u;
                if (group==5u) flags|=(value>>(bits-1u))<<11u;
            }
        }
        for (pl_u32 i=0u; i<=candidates.count; ++i) {
            union { void *object; function call; } fn;
            fn.object=memory+i*512u;
            result actual={0}; fn.call(&actual,input);
            pl_u64 replaced=overwrite==0u ? (pl_u32)(input[2]+9u):overwrite==1u ? input[2]:0u;
            if (actual.sum!=shifted+input[1] || actual.overwritten!=replaced
                    || actual.constant!=36u || actual.address!=0x1234u
                    || (actual.flags&flag_mask)!=(flags&flag_mask)) {
                fprintf(stderr,"consumed shift: mismatch candidate=%u sample=%u sum=%llx expected=%llx flags=%llx expected=%llx\n",
                    i,sample,(unsigned long long)actual.sum,(unsigned long long)(shifted+input[1]),
                    (unsigned long long)actual.flags,(unsigned long long)flags);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || !selected.normalized_family_present || work>5u || span>2u) goto failed;
    test_code_release(memory,16384u); return 1;
failed:
    fprintf(stderr,"consumed shift: RED bits/group/count/overwrite=%u/%u/%u/%u status=%d candidates=%u\n",
        bits,group,count,overwrite,status,candidates.count);
    test_code_release(memory,16384u); return 0;
}

static int check_scaled_flag_boundary(pl_u32 bits, pl_u32 count, pl_u64 *comparisons)
{
    typedef struct {pl_u64 value,flags;} result;
    typedef void (__attribute__((sysv_abi)) *function)(result *,pl_u64);
    pl_u8 rex=bits==64u ? 0x48u:0x40u;
    pl_u8 source[]={rex,0xf7u,0xdeu,rex,0xc1u,0xe6u,(pl_u8)count};
    static const pl_u8 observe[]={0x48u,0x89u,0x37u,0x9cu,0x58u,0x48u,0x89u,0x47u,8u,0xc3u};
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
        pl_u8 *body=memory+i*512u;
        pl_u32 written=sizeof source;
        if (!i) memcpy(body,source,written);
        else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,body,256u,&written);
            if (status || candidate->fixup_count) goto failed;
        }
        memcpy(body+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x9561acf673823501ull,word=UINT64_MAX>>(64u-bits);
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input=sample<512u ? (random&~511ull)|sample:random;
        pl_u64 negated=(0ull-input)&word,value=(negated<<count)&word;
        pl_u64 carry=(negated>>(bits-count))&1u;
        pl_u64 flags=carry|(!value ? 64u:0u)|(value>>(bits-1u) ? 128u:0u);
        pl_u32 parity=0u;
        for (pl_u32 bit=0u;bit<8u;++bit) parity^=(pl_u32)(value>>bit)&1u;
        if (!parity) flags|=4u;
        if (count==1u) flags|=((value>>(bits-1u))^carry)<<11u;
        pl_u64 mask=count==1u ? 0x8c5u:0xc5u;
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;function call;} fn;
            fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input);
            if (actual.value!=value || (actual.flags&mask)!=flags) {
                fprintf(stderr,"scaled shift flags: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"scaled shift flags: RED bits/count=%u/%u status=%d\n",bits,count,status);
    test_code_release(memory,16384u);return 0;
}

/* A register shift observes only CL modulo the operand width. Zero extension
 * into ECX changes the published word, but not those count bits. The count
 * copy must precede the shift even when the value is otherwise independent. */
static int check_count_publication(pl_u32 count_bits, pl_u32 bits,
                                   pl_u32 group, pl_u32 seed_register, pl_u32 late_count,
                                   pl_u64 *comparisons)
{
    typedef struct { pl_u64 value, count, address, copy, seed, input, flags; } result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, const pl_u64 *);
    pl_u8 source[48];
    pl_u32 length=0u;
    if (count_bits<32u) {
        source[length++]=0x41u;source[length++]=0x0fu;
        source[length++]=(pl_u8)(count_bits==8u ? 0xb6u:0xb7u);
        source[length++]=0xcfu; /* movzx ecx,r15b/w */
    } else {
        source[length++]=(pl_u8)(count_bits==32u ? 0x44u:0x4cu);
        source[length++]=0x89u;source[length++]=0xf9u;
    }
    if (seed_register) {
        source[length++]=0x48u;source[length++]=0x89u;source[length++]=0xd0u;
    } else {
        source[length++]=0xb8u;source[length++]=0u;source[length++]=0x10u;
        source[length++]=0u;source[length++]=0u;
    }
    static const pl_u8 address_code[]={0x48u,0xc7u,0xc7u,0u,0xbau,0x8bu,0x81u};
    memcpy(source+length,address_code,sizeof address_code);length+=(pl_u32)sizeof address_code;
    if (bits==64u) source[length++]=0x48u;
    source[length++]=0xd3u;source[length++]=(pl_u8)(0xc0u|(group<<3u));
    if (late_count) {
        /* A final RCX with different count bits cannot stand in for the
         * earlier generation. Source-only acceptance here proves no minimum. */
        source[length++]=0x83u;source[length++]=0xf1u;source[length++]=1u;
    }
    static const pl_u8 tail[]={0x48u,0xc1u,0xe8u,20u,0x48u,0x89u,0xc6u};
    memcpy(source+length,tail,sizeof tail);length+=(pl_u32)sizeof tail;
    static const pl_u8 setup[]={0x41u,0x57u,0x49u,0x89u,0xfbu,
        0x4cu,0x8bu,0x3eu,0x48u,0x8bu,0x4eu,8u,
        0x48u,0x8bu,0x56u,16u,0x48u,0x8bu,0x46u,24u,0x48u,0x83u,0xfau,0u};
    static const pl_u8 observe[]={0x9cu,0x41u,0x5au,
        0x49u,0x89u,0x03u,0x49u,0x89u,0x4bu,8u,
        0x49u,0x89u,0x7bu,16u,0x49u,0x89u,0x73u,24u,
        0x49u,0x89u,0x53u,32u,0x4du,0x89u,0x7bu,40u,
        0x4du,0x89u,0x53u,48u,0x41u,0x5fu,0xc3u};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,length,length,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,0x1000u+length,
        (1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<(late_count ? 1u:2u)) goto failed;
    for (pl_u32 i=0u;i<=candidates.count;++i) {
        pl_u8 *body=memory+i*512u;
        pl_u32 written=length;
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
    pl_u64 random=0xf21bed50984763a1ull,word=UINT64_MAX>>(64u-bits);
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input[]={sample<256u ? (random&~255ull)|sample:random,
            ~random,random*17u,random*19u};
        pl_u64 count=input[0]&(UINT64_MAX>>(64u-count_bits));
        pl_u32 shift=(pl_u32)count&(bits-1u);
        if (late_count) count=(pl_u32)count^1u;
        pl_u64 inner=(seed_register ? input[2]:4096u)&word;
        if (shift) {
            if (group==4u) inner=(inner<<shift)&word;
            else if (group==5u) inner>>=shift;
            else inner=(inner>>shift)
                |(((0ull-(inner>>(bits-1u)))<<(bits-shift))&word);
        }
        pl_u64 value=inner>>20u;
        pl_u64 flags=((inner>>19u)&1u)|(!value ? 64u:0u);
        pl_u32 parity=0u;
        for (pl_u32 bit=0u;bit<8u;++bit) parity^=(pl_u32)(value>>bit)&1u;
        if (!parity) flags|=4u;
        for (pl_u32 i=0u;i<=candidates.count;++i) {
            union {void *object;function call;} fn;
            fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input);
            if (actual.value!=value || actual.copy!=value || actual.count!=count
                    || actual.address!=0xffffffff818bba00ull || actual.seed!=input[2]
                    || actual.input!=input[0] || (actual.flags&0xc5u)!=flags) {
                fprintf(stderr,"shift count publication: mismatch candidate=%u sample=%u value=%llx expected=%llx count=%llx expected=%llx\n",
                    i,sample,(unsigned long long)actual.value,(unsigned long long)value,
                    (unsigned long long)actual.count,(unsigned long long)count);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (!late_count && (status || !selected.normalized_family_present || work>6u || span>4u)) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"shift count publication: RED count/bits/group/seed/late=%u/%u/%u/%u/%u status=%d candidates=%u\n",
        count_bits,bits,group,seed_register,late_count,status,candidates.count);
    test_code_release(memory,16384u);return 0;
}

/* Both arms are independent. The hand-written witness uses IMUL's immediate
 * form for a copied scale, and CL's hardware mask instead of a stored AND:
 *   imul rdx,r14,scale; lea eax,[rax-1]; mov ecx,edi; mov esi,1
 *   shl rsi,cl; lea rbx,[rbx+rdx]; cmp eax,r14d
 * Seven work, two dependency levels before any terminating branch. */
static int check_shift_join(pl_u32 bits, pl_u32 scale, pl_u32 mask_live,
                            pl_u64 *comparisons)
{
    typedef struct {pl_u64 value, sum, count, scaled, shifted, input, factor, flags, mask;} result;
    typedef void (__attribute__((sysv_abi)) *function)(result *, const pl_u64 *);
    pl_u8 rex=bits==64u ? 0x48u:0x40u;
    pl_u8 source[64]={0x4cu,0x89u,0xf2u,0xbeu,1u,0u,0u,0u,0x89u,0xf9u,
        0x48u,0xc1u,0xe2u,(pl_u8)scale,0x83u,0xe8u,1u,rex,0xd3u,0xe6u,
        0x48u,1u,0xd3u};
    pl_u32 source_bytes=23u;
    pl_u8 witness[64]={0x49u,0x6bu,0xd6u,(pl_u8)(1u<<scale),0x8du,0x40u,0xffu,
        0x89u,0xf9u,0xbeu,1u,0u,0u,0u,rex,0xd3u,0xe6u,
        0x48u,0x8du,0x1cu,0x13u};
    pl_u32 witness_bytes=21u;
    if (mask_live) {
        /* The mask is not dead when another architectural output observes
         * it. Instruction coverage may remove its count edge, not its root. */
        pl_u8 mask_code[]={0x41u,0x89u,0xc8u,0x41u,0x83u,0xe0u,(pl_u8)(bits-1u)};
        memcpy(source+source_bytes,mask_code,sizeof mask_code);source_bytes+=(pl_u32)sizeof mask_code;
        mask_code[2]=0xf8u;
        memcpy(witness+witness_bytes,mask_code,sizeof mask_code);witness_bytes+=(pl_u32)sizeof mask_code;
    }
    static const pl_u8 compare[]={0x44u,0x39u,0xf0u};
    memcpy(source+source_bytes,compare,sizeof compare);source_bytes+=(pl_u32)sizeof compare;
    memcpy(witness+witness_bytes,compare,sizeof compare);witness_bytes+=(pl_u32)sizeof compare;
    static const pl_u8 setup[]={0x53u,0x41u,0x54u,0x41u,0x56u,0x49u,0x89u,0xfcu,
        0x48u,0x8bu,6u,0x48u,0x8bu,0x5eu,8u,0x4cu,0x8bu,0x76u,16u,
        0x48u,0x8bu,0x4eu,24u,0x48u,0x8bu,0x7eu,32u,0x45u,0x31u,0xc0u};
    static const pl_u8 observe[]={0x9cu,0x41u,0x5au,
        0x49u,0x89u,4u,0x24u,0x49u,0x89u,0x5cu,0x24u,8u,
        0x49u,0x89u,0x4cu,0x24u,16u,0x49u,0x89u,0x54u,0x24u,24u,
        0x49u,0x89u,0x74u,0x24u,32u,0x49u,0x89u,0x7cu,0x24u,40u,
        0x4du,0x89u,0x74u,0x24u,48u,0x4du,0x89u,0x54u,0x24u,56u,
        0x4du,0x89u,0x44u,0x24u,64u,
        0x41u,0x5eu,0x41u,0x5cu,0x5bu,0xc3u};
    pl_u8 *memory=test_code_allocate(16384u);
    if (!memory) return 0;
    pl_x86_map map={source,0x1000u,source_bytes,source_bytes,5u,1u};
    pl_x86_image image={&map,1u,0u,0x1000u};
    pl_x86_frontend frontend;
    static pl_u8 a[1048576],b[1048576],c[1048576],d[1048576];
    pl_x86_block_workspace workspace={a,b,sizeof a,64u},scratch={c,d,sizeof c,64u};
    pl_x86_block block;
    pl_x86_native_candidates candidates={0};
    int status=pl_x86_frontend_open(&image,&frontend);
    if (!status) status=pl_x86_block_lower_projected_until(&frontend,0x1000u,
        0x1000u+source_bytes,(1u<<PL_X86_LOCAL_COUNT)-1u,&workspace,&block);
    if (!status) status=pl_x86_select_candidates(&frontend,&scratch,&block,&candidates);
    if (status || candidates.count<2u) goto failed;
    for (pl_u32 i=0u;i<candidates.count+2u;++i) {
        pl_u8 *body=memory+i*512u;
        pl_u32 written=source_bytes;
        memcpy(body,setup,sizeof setup);
        if (!i) memcpy(body+sizeof setup,source,written);
        else if (i==candidates.count+1u) {
            written=witness_bytes;memcpy(body+sizeof setup,witness,written);
        } else {
            const pl_x86_native_selection *candidate=&candidates.candidate[i-1u];
            status=pl_x86_select_write_measured(&frontend,&block,candidate,
                body+sizeof setup,256u,&written);
            if (status || candidate->fixup_count) goto failed;
        }
        memcpy(body+sizeof setup+written,observe,sizeof observe);
    }
    if (!test_code_publish(memory,16384u)) goto failed;
    pl_u64 random=0x82431967cafe105bull;
    for (pl_u32 sample=0u;sample<4096u;++sample) {
        random^=random<<13u;random^=random>>7u;random^=random<<17u;
        pl_u64 input[]={random*3u,random*7u,random*11u,~random,
            sample<256u ? (random&~255ull)|sample:random};
        if (sample<256u) input[0]=(pl_u32)input[2]+(sample&3u);
        pl_u32 left=(pl_u32)input[0]-1u,right=(pl_u32)input[2],diff=left-right;
        pl_u64 flags=(left<right ? 1u:0u)|(!diff ? 64u:0u)
            |((diff>>31u) ? 128u:0u)|((left^right^diff)&16u)
            |((((left^right)&(left^diff))>>31u) ? 0x800u:0u);
        pl_u32 parity=0u;
        for (pl_u32 bit=0u;bit<8u;++bit) parity^=(diff>>bit)&1u;
        if (!parity) flags|=4u;
        pl_u64 scaled=input[2]<<scale,shifted=1ull<<(input[4]&(bits-1u));
        for (pl_u32 i=0u;i<candidates.count+2u;++i) {
            union {void *object;function call;} fn;
            fn.object=memory+i*512u;
            result actual={0};fn.call(&actual,input);
            if (actual.value!=left || actual.sum!=input[1]+scaled
                    || actual.count!=(pl_u32)input[4] || actual.scaled!=scaled
                    || actual.shifted!=shifted || actual.input!=input[4]
                    || actual.factor!=input[2] || (actual.flags&0x8d5u)!=flags
                    || actual.mask!=(mask_live ? input[4]&(bits-1u):0u)) {
                fprintf(stderr,"shift join: mismatch candidate=%u sample=%u\n",i,sample);
                goto failed;
            }
            ++*comparisons;
        }
    }
    pl_x86_native_selection selected;
    pl_u32 span=0u,work=0u;
    status=pl_x86_candidates_select_joint_minimum(&candidates,0u,0u,&selected,&span,&work);
    if (status || !selected.normalized_family_present || work>7u+2u*mask_live
            || span>2u+mask_live) goto failed;
    test_code_release(memory,16384u);return 1;
failed:
    fprintf(stderr,"shift join: RED bits/scale/mask-live=%u/%u/%u status=%d candidates=%u\n",
        bits,scale,mask_live,status,candidates.count);
    test_code_release(memory,16384u);return 0;
}

int main(void)
{
    static const pl_u32 groups[] = { 0u, 1u, 4u, 5u, 7u };
    static const pl_u32 counts[] = { 1u, 7u, 8u, 15u, 16u, 31u,
                                    32u, 33u, 49u, 63u, 64u };
    pl_u64 comparisons = 0u;
    for (pl_u32 bits=32u;bits<=64u;bits+=32u)
        for (pl_u32 scale=4u;scale<=6u;++scale)
            for (pl_u32 mask_live=0u;mask_live<2u;++mask_live)
                if (!check_shift_join(bits,scale,mask_live,&comparisons)) return 1;
    for (pl_u32 count_bits=8u;count_bits<=64u;count_bits*=2u)
        for (pl_u32 bits=32u;bits<=64u;bits+=32u)
            for (pl_u32 group=4u;group<=7u;++group)
                for (pl_u32 seed=0u;seed<2u;++seed)
                    for (pl_u32 late_count=0u;late_count<2u;++late_count)
                        if (group!=6u && !check_count_publication(
                                count_bits,bits,group,seed,late_count,&comparisons)) return 1;
    static const pl_u32 scaled_counts[]={1u,7u,12u,31u,63u};
    for (pl_u32 bits=32u;bits<=64u;bits+=32u)
        for (pl_u32 i=0u;i<sizeof scaled_counts/sizeof scaled_counts[0];++i)
            if (scaled_counts[i]<bits
                    && !check_scaled_flag_boundary(bits,scaled_counts[i],&comparisons)) return 1;
    for (pl_u32 group=0u; group<4u; ++group)
        if (!check_consumed_shift(32u,group,32u,0u,&comparisons)) return 1;
    for (pl_u32 bits=32u; bits<=64u; bits+=32u)
        for (pl_u32 g=2u; g<sizeof groups/sizeof groups[0]; ++g)
            for (pl_u32 c=0u; c<sizeof counts/sizeof counts[0]; ++c)
                for (pl_u32 overwrite=0u; overwrite<3u; ++overwrite)
                    if (!check_consumed_shift(bits,groups[g],counts[c],overwrite,&comparisons)) return 1;
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
