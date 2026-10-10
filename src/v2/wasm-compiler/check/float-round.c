#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "../../x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
#include <xmmintrin.h>
static pl_u8 scratch[131072],page[4096],module[65536];
int main(void)
{
    const pl_u64 edges[]={0u,0x8000000000000000ull,0x3fe0000000000000ull,0xbfe0000000000000ull,
        0x3ff8000000000000ull,0x4004000000000000ull,0xc004000000000000ull,0x3fdfffffffffffffull,
        0x3fe0000000000001ull,0x7ff0000000000000ull,0xfff0000000000000ull,0x7ff8123456789abcull,
        0x7ff0123456789abcull,1u,0x8000000000000001ull,0x000fffffffffffffull,0x0010000000000000ull,
        0x4330000000000000ull,0x432fffffffffffffull,0x7fefffffffffffffull};
    const pl_u32 singles[]={0u,0x80000000u,0x3f000000u,0xbf000000u,0x3fc00000u,0x40200000u,0xc0200000u,
        0x3effffffu,0x3f000001u,0x7f800000u,0xff800000u,0x7fc12345u,0x7f812345u,1u,0x80000001u,
        0x007fffffu,0x00800000u,0x4b000000u,0x4affffffu,0x7f7fffffu};
    pl_u64 seed=0xcdef187293450321ull;pl_u32 comparisons=0u,maximum=0u,span=0u;
    for(pl_u32 bits=32u;bits<=64u;bits+=32u)for(pl_u32 control=0u;control<16u;++control){
        pl_arena arena={scratch,sizeof scratch,0u};pl_plan p;
        if(pl_x86_float_round_plan(bits,control,&arena,&p))return 1;
        if(p.node_count>maximum)maximum=p.node_count;
        if(p.span>span)span=p.span;
        for(pl_u32 profile=0u;profile<8u;++profile)for(pl_u32 row=0u;row<1024u;++row){
            seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;
            pl_u64 value=row<20u?(bits==32u?singles[row]:edges[row]):bits==32u?seed&0xffffffffu:seed;
            unsigned csr=0x1f80u|((profile&3u)<<13u)|((profile&4u)?64u:0u),saved=_mm_getcsr(),observed;
            pl_u64 actual;_mm_setcsr(csr);
#define OBSERVE(NAME,I) __asm__ volatile("movq %2,%%xmm1;" NAME " $" #I ",%%xmm1,%%xmm0;movq %%xmm0,%0;stmxcsr %1" : "=r"(actual),"=m"(observed) : "r"(value) : "xmm0","xmm1","memory")
#define CASES(NAME) switch(control){case 0u:OBSERVE(NAME,0);break;case 1u:OBSERVE(NAME,1);break;case 2u:OBSERVE(NAME,2);break;case 3u:OBSERVE(NAME,3);break;case 4u:OBSERVE(NAME,4);break;case 5u:OBSERVE(NAME,5);break;case 6u:OBSERVE(NAME,6);break;case 7u:OBSERVE(NAME,7);break;case 8u:OBSERVE(NAME,8);break;case 9u:OBSERVE(NAME,9);break;case 10u:OBSERVE(NAME,10);break;case 11u:OBSERVE(NAME,11);break;case 12u:OBSERVE(NAME,12);break;case 13u:OBSERVE(NAME,13);break;case 14u:OBSERVE(NAME,14);break;default:OBSERVE(NAME,15);break;}
            if(bits==32u){CASES("roundss");actual&=0xffffffffu;}else{CASES("roundsd");}
#undef CASES
#undef OBSERVE
            _mm_setcsr(saved);const pl_u64 inputs[]={value,csr};pl_u64 output[2]={0};
            if(check_scalar_projection(&p,inputs,output,2u)||output[0]!=actual||output[1]!=(observed&63u)){
                printf("round red bits%u control%u profile%u row%u raw%llx result%llx/%llx flags%llx/%x\n",bits,control,profile,row,
                    (unsigned long long)value,(unsigned long long)output[0],(unsigned long long)actual,(unsigned long long)output[1],observed&63u);return 1;}
            ++comparisons;
        }
    }
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,1u,sizeof module};pl_u32 forms=0u,refusals=0u;
    for(pl_u32 scalar=0u;scalar<2u;++scalar)for(pl_u32 bytes=4u;bytes<=8u;bytes+=4u)
    for(pl_u32 control=0u;control<256u;++control)for(pl_u32 source=0u;source<3u;++source){
        pl_u32 n=0u;memset(page,0x90,sizeof page);page[n++]=0x66u;page[n++]=0x44u;page[n++]=0x0fu;page[n++]=0x3au;
        page[n++]=(pl_u8)(scalar?(bytes==8u?0x0bu:0x0au):(bytes==8u?0x09u:0x08u));
        if(source==1u){page[1]=0x45u;page[n++]=0xc9u;}else page[n++]=(pl_u8)(source==2u?0x0fu:0xcfu);
        page[n++]=(pl_u8)control;pl_x86_instruction i;pl_x86_float_round law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_float_round_lower(&i,&law)||law.control!=(control&15u)
            ||law.bytes!=bytes||law.lanes!=(scalar?1u:16u/bytes)||law.source_memory!=(source==2u))return 1;
        pl_u64 size=0u;wasm_cut_report report;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report)||!size
            ||report.source_bytes!=n||report.source_instructions!=1u||report.flags_written
            ||report.memory_bytes!=(source==2u?(scalar?bytes:16u):0u))return 1;
        for(pl_u32 bad=0u;bad<10u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0u:changed.machine_argument^=1ull<<63u;break;case 1u:changed.operands[0].bits=16u;break;
            case 2u:changed.operands[1].bits=16u;break;case 3u:changed.visible_operand_count=2u;break;
            case 4u:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5u:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;
            case 6u:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 7u:changed.flags^=PL_X86_INSTRUCTION_READS_MEMORY;break;
            case 8u:++changed.fallthrough;break;default:changed.opcode=0xffu;break;}
            pl_x86_float_round old,out;memset(&old,0xa5,sizeof old);out=old;
            if(pl_x86_float_round_lower(&changed,&out)||memcmp(&out,&old,sizeof out))return 1;
            pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++refusals;
        }++forms;
    }
    printf("integral IEEE rounding: %u physical results/MXCSR, %u constructors/%u unchanged refusals; work/span %u/%u\n",comparisons,forms,refusals,maximum,span);return 0;
}
