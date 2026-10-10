#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include "../../x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x67u,0x48u,0x64u,0x65u};unsigned forms=0u,refusals=0u,max_work=0u,max_span=0u;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,1u,sizeof module};
    for(unsigned width=4u;width<=8u;width+=4u)for(unsigned kind=0u;kind<10u;++kind){
        unsigned mask=kind>=2u,predicate=mask?kind-2u:0u,ordered=mask?0u:kind;
        for(unsigned alias=0u;alias<2u;++alias){_Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
            if(mask?pl_x86_float_predicate_plan(width*8u,predicate,alias,&arena,&pure):pl_x86_float_compare_plan(width*8u,ordered,alias,&arena,&pure))return 1;
            if(pure.node_count>max_work)max_work=pure.node_count;
            if(pure.span>max_span)max_span=pure.span;
            pl_u64 a=width==4u?0x7fc00001u:0x7ff8000000000001ull,b=1u,args[]={a,b,0x1f80u,0u,0u},result[2];
            unsigned signaling=predicate==1u||predicate==2u||predicate==5u||predicate==6u;
            pl_u64 full=width==4u?0xffffffffu:~0ull;
            if(check_scalar_projection(&pure,args,result,2u)||result[0]!=(mask?(predicate>=3u&&predicate<=6u?full:0u):0x45u)
                ||result[1]!=(mask?signaling:ordered))return 1;
            args[0]=0u;args[1]=width==4u?0x80000000u:0x8000000000000000ull;
            if(check_scalar_projection(&pure,args,result,2u)||result[0]!=(mask?(predicate==0u||predicate==2u||predicate==5u||predicate==7u?full:0u):64u)||result[1])return 1;
        }
        for(unsigned dst=0u;dst<16u;++dst)for(unsigned src=0u;src<17u;++src)for(unsigned prefix=0u;prefix<5u;++prefix){
            unsigned memory=src==16u,n=0u;memset(page,0x90,sizeof page);
            if(prefixes[prefix]&&prefixes[prefix]!=0x48u)page[n++]=prefixes[prefix];
            if(mask)page[n++]=(pl_u8)(width==8u?0xf2u:0xf3u);else if(width==8u)page[n++]=0x66u;
            unsigned rex=(prefix==2u?8u:0u)|(dst>=8u?4u:0u)|(!memory&&src>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
            page[n++]=0x0fu;page[n++]=(pl_u8)(mask?0xc2u:ordered?0x2fu:0x2eu);page[n++]=(pl_u8)((memory?0u:0xc0u)|((dst&7u)<<3u)|(memory?7u:src&7u));
            if(mask)page[n++]=(pl_u8)(predicate|(prefix<<4u));
            pl_x86_instruction i;pl_x86_float_compare law;
            if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_float_compare_lower(&i,&law)||law.bytes!=width||law.ordered!=ordered||law.target!=dst
                ||law.source_memory!=memory||(!memory&&law.source!=src)||law.alias!=(!memory&&dst==src)||law.result_mask!=mask||law.predicate!=predicate)return 1;
            pl_u64 bytes=0u;wasm_cut_report report;
            if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes||report.source_bytes!=n
                ||report.source_instructions!=1u||report.memory_bytes!=(memory?width:0u)||report.flags_written!=!mask)return 1;
            for(unsigned bad=0u;bad<16u;++bad){pl_x86_instruction changed=i;
                switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=16u;break;case 2:changed.operands[1].bits=128u;break;
                case 3:changed.visible_operand_count=1u;break;case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;
                case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;case 6:changed.flags^=PL_X86_INSTRUCTION_READS_MEMORY;break;
                case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
                case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;case 10:changed.status=PL_X86_DECODE_INVALID;break;
                case 11:changed.flow=PL_X86_FLOW_FAULT;break;case 12:changed.source_bytes=0u;break;case 13:--changed.length;break;
                case 14:++changed.fallthrough;break;default:changed.opcode=0u;break;}
                pl_x86_float_compare old,value;memset(&old,0xa5,sizeof old);value=old;
                if(pl_x86_float_compare_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
                _Alignas(8) pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
                if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
                ++refusals;
            }++forms;
        }
    }
    page[0]=0xf0u;page[1]=0x0fu;page[2]=0x2fu;page[3]=0xc0u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("COMI/CMP: %u shared forms/%u malformed laws; maximum pure work/span %u/%u; native execution separate\n",forms,refusals,max_work,max_span);return 0;
}
