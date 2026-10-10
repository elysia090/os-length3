#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "../../x86/check/scalar-plan.h"
#include <xmmintrin.h>
#include <stdio.h>
#include <string.h>
static pl_u8 scratch[196608],page[4096],module[65536];
int main(void)
{
    const pl_u64 edges[]={0u,0x8000000000000000ull,1u,0x000fffffffffffffull,0x0010000000000000ull,
        0x3ff0000000000000ull,0x4000000000000000ull,0x4010000000000000ull,0x7fefffffffffffffull,
        0x7ff0000000000000ull,0xfff0000000000000ull,0x7ff8123456789abcull,0x7ff0123456789abcull,
        0x3fffffffffffffffull,0x400fffffffffffffull,0xbff0000000000000ull};
    const pl_u32 singles[]={0u,0x80000000u,1u,0x007fffffu,0x00800000u,0x3f800000u,0x40000000u,0x40800000u,
        0x7f7fffffu,0x7f800000u,0xff800000u,0x7fc12345u,0x7f812345u,0x3fffffffu,0x407fffffu,0xbf800000u};
    pl_u64 seed=0x737172745f657861ull;pl_u32 count=0u,maximum=0u,span=0u;pl_u64 arena_max=0u;
    for(pl_u32 bits=32u;bits<=64u;bits+=32u){pl_arena arena={scratch,sizeof scratch,0u};pl_plan p;
        int status=pl_x86_float_sqrt_plan(bits,&arena,&p);if(status){printf("sqrt plan %u status%d arena%llu\n",bits,status,(unsigned long long)arena.used);return 1;}
        if(p.node_count>maximum)maximum=p.node_count;
        if(p.span>span)span=p.span;
        if(arena.used>arena_max)arena_max=arena.used;
        for(pl_u32 profile=0u;profile<8u;++profile)for(pl_u32 row=0u;row<16384u;++row){
            seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 raw=row<16u?(bits==32u?singles[row]:edges[row]):bits==32u?seed&0xffffffffu:seed;
            unsigned csr=0x1f80u|((profile&3u)<<13u)|((profile&4u)?64u:0u),saved=_mm_getcsr(),observed;pl_u64 actual;
            _mm_setcsr(csr);
            if(bits==32u){__asm__ volatile("movq %2,%%xmm1;sqrtss %%xmm1,%%xmm0;movq %%xmm0,%0;stmxcsr %1"
                :"=r"(actual),"=m"(observed):"r"(raw):"xmm0","xmm1","memory");actual&=0xffffffffu;}
            else __asm__ volatile("movq %2,%%xmm1;sqrtsd %%xmm1,%%xmm0;movq %%xmm0,%0;stmxcsr %1"
                :"=r"(actual),"=m"(observed):"r"(raw):"xmm0","xmm1","memory");
            _mm_setcsr(saved);const pl_u64 input[]={raw,csr};pl_u64 result[2]={0};
            if(check_scalar_projection(&p,input,result,2u)||result[0]!=actual||result[1]!=(observed&63u)){
                printf("sqrt red bits%u profile%u row%u raw%llx result%llx/%llx flags%llx/%x\n",bits,profile,row,(unsigned long long)raw,
                    (unsigned long long)result[0],(unsigned long long)actual,(unsigned long long)result[1],observed&63u);return 1;}
            ++count;
        }
    }
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,1u,sizeof module};pl_u32 forms=0u;
    for(pl_u32 bytes=4u;bytes<=8u;bytes+=4u)for(pl_u32 scalar=0u;scalar<2u;++scalar)for(pl_u32 target=0u;target<16u;++target)
    for(pl_u32 source=0u;source<17u;++source){pl_u32 memory=source==16u,n=0u;memset(page,0x90,sizeof page);
        if(scalar)page[n++]=(pl_u8)(bytes==4u?0xf3u:0xf2u);else if(bytes==8u)page[n++]=0x66u;
        pl_u32 rex=(target>=8u?4u:0u)|(!memory&&source>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
        page[n++]=0x0fu;page[n++]=0x51u;page[n++]=(pl_u8)((memory?0u:0xc0u)|((target&7u)<<3u)|(memory?7u:source&7u));
        pl_x86_instruction i;pl_x86_float_unary law;pl_u64 size=0u;wasm_cut_report report;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_float_unary_lower(&i,&law)||law.bytes!=bytes||law.operation||law.lanes!=(scalar?1u:16u/bytes))return 1;
        if(target==9u&&(source==7u||memory)){int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report);
            if(status||!size||report.source_bytes!=n||report.memory_bytes!=(memory?(scalar?bytes:16u):0u)){
                printf("sqrt cut %u/%u/%u status%d size%llu\n",bytes,scalar,source,status,(unsigned long long)size);return 1;}}
        ++forms;
    }
    printf("exact sqrt: %u physical values/MXCSR, %u constructors; work/span %u/%u arena%llu\n",count,forms,maximum,span,(unsigned long long)arena_max);return 0;
}
