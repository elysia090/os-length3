#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "../../x86/check/scalar-plan.h"
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
#include <xmmintrin.h>
static pl_u8 scratch[131072];
static pl_u8 page[4096],module[65536];
int main(void)
{
    unsigned work=0u,span=0u;
    for(pl_u32 bits=32u;bits<=64u;bits+=32u)for(pl_u32 op=0u;op<6u;++op){
        pl_arena arena={scratch,sizeof scratch,0u};pl_plan p;
        int s=pl_x86_float_arithmetic_plan(bits,op,&arena,&p);if(s){printf("plan %u/%u = %d used%llu\n",bits,op,s,(unsigned long long)arena.used);return 1;}
        if(p.node_count>work)work=p.node_count;
        if(p.span>span)span=p.span;
        pl_u64 one=bits==32u?0x3f800000u:0x3ff0000000000000ull,two=bits==32u?0x40000000u:0x4000000000000000ull;
        pl_u64 args[]={one,one,0x1f80u},out[2]={0},expected=op==0u?two:op==2u?0u:one;
        if(check_scalar_projection(&p,args,out,2u)||out[0]!=expected||out[1]){printf("value %u/%u %llx/%llx expected%llx\n",bits,op,(unsigned long long)out[0],(unsigned long long)out[1],(unsigned long long)expected);return 1;}
        const pl_u64 values[]={0u,1u,0x8000000000000000ull,0x3ff0000000000000ull,0xbff0000000000000ull,0x3ff8000000000000ull,
            0x7ff0000000000000ull,0xfff0000000000000ull,0x7ff8123456789abcull,0xfff8123456789abcull,0x7ff0123456789abcull,0xfff0123456789abcull,
            0x000fffffffffffffull,0x0010000000000000ull,0x7fefffffffffffffull,0xffefffffffffffffull};
        const pl_u32 singles[]={0u,1u,0x80000000u,0x3f800000u,0xbf800000u,0x3fc00000u,0x7f800000u,0xff800000u,
            0x7fc12345u,0xffc12345u,0x7f812345u,0xff812345u,0x007fffffu,0x00800000u,0x7f7fffffu,0xff7fffffu};
        pl_u64 seed=0x758612394abce012ull;
        for(pl_u32 profile=0u;profile<16u;++profile)for(pl_u32 row=0u;row<1024u;++row){
            seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 av=row<256u?(bits==32u?singles[row/16u]:values[row/16u]):seed;
            seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 bv=row<256u?(bits==32u?singles[row%16u]:values[row%16u]):seed;
            if(bits==32u){av&=0xffffffffu;bv&=0xffffffffu;}
            unsigned csr=0x1f80u|((profile&3u)<<13u)|((profile&4u)?64u:0u)|((profile&8u)?32768u:0u),saved=_mm_getcsr(),observed;pl_u64 actual;
            _mm_setcsr(csr);
#define OBSERVE(MNEMONIC) __asm__ volatile("movq %2,%%xmm0;movq %3,%%xmm1;" MNEMONIC " %%xmm1,%%xmm0;movq %%xmm0,%0;stmxcsr %1" : "=r"(actual),"=m"(observed) : "r"(av),"r"(bv) : "xmm0","xmm1","memory")
            if(bits==32u){switch(op){case 0:OBSERVE("addss");break;case 1:OBSERVE("mulss");break;case 2:OBSERVE("subss");break;case 3:OBSERVE("divss");break;case 4:OBSERVE("minss");break;default:OBSERVE("maxss");break;}actual&=0xffffffffu;}
            else{switch(op){case 0:OBSERVE("addsd");break;case 1:OBSERVE("mulsd");break;case 2:OBSERVE("subsd");break;case 3:OBSERVE("divsd");break;case 4:OBSERVE("minsd");break;default:OBSERVE("maxsd");break;}}
#undef OBSERVE
            _mm_setcsr(saved);args[0]=av;args[1]=bv;args[2]=csr;
            if(check_scalar_projection(&p,args,out,2u)||out[0]!=actual||out[1]!=(observed&63u)){
                printf("physical red bits%u op%u profile%u row%u A%llx B%llx result%llx/%llx flags%llx/%x\n",bits,op,profile,row,(unsigned long long)av,(unsigned long long)bv,(unsigned long long)out[0],(unsigned long long)actual,(unsigned long long)out[1],observed&63u);return 1;}
        }
    }
    unsigned forms=0u,refusals=0u;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,1u,sizeof module};
    for(unsigned width=4u;width<=8u;width+=4u)for(unsigned packed=0u;packed<2u;++packed)for(unsigned op=0u;op<(packed?4u:6u);++op)
    for(unsigned dst=0u;dst<16u;++dst)for(unsigned src=0u;src<17u;++src){
        unsigned memory=src==16u,n=0u;memset(page,0x90,sizeof page);
        if(packed){if(width==8u)page[n++]=0x66u;}else page[n++]=(pl_u8)(width==8u?0xf2u:0xf3u);
        unsigned rex=(dst>=8u?4u:0u)|(!memory&&src>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
        page[n++]=0x0fu;page[n++]=(pl_u8)(op==0u?0x58u:op==1u?0x59u:op==2u?0x5cu:op==3u?0x5eu:op==4u?0x5du:0x5fu);page[n++]=(pl_u8)((memory?0u:0xc0u)|((dst&7u)<<3u)|(memory?7u:src&7u));
        pl_x86_instruction i;pl_x86_float_arithmetic law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_float_arithmetic_lower(&i,&law)||law.bytes!=width||law.operation!=op||law.lanes!=(packed?16u/width:1u)
            ||law.target!=dst||law.source_memory!=memory||(!memory&&law.source!=src))return 1;
        if(dst==9u&&(src==7u||src==16u||src==9u)){pl_u64 bytes=0u;wasm_cut_report report;
            if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes||report.source_bytes!=n
                ||report.source_instructions!=1u||report.memory_bytes!=(memory?(packed?16u:width):0u)||report.flags_written)return 1;}
        for(unsigned bad=0u;bad<12u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=16u;break;case 2:changed.operands[1].bits=16u;break;
            case 3:changed.visible_operand_count=1u;break;case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;
            case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;case 6:changed.flags^=PL_X86_INSTRUCTION_READS_MEMORY;break;
            case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;case 10:++changed.fallthrough;break;default:changed.opcode=0u;break;}
            pl_x86_float_arithmetic old,value;memset(&old,0xa5,sizeof old);value=old;
            if(pl_x86_float_arithmetic_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
            pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++refusals;
        }++forms;
    }
    page[0]=0xf0u;page[1]=0x0fu;page[2]=0x58u;page[3]=0xc0u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("shared SSE arithmetic: 196608 physical numeric/MXCSR comparisons, %u constructors/%u refusals; maximum work/span %u/%u; full-state/fault execution separate\n",forms,refusals,work,span);return 0;
}
