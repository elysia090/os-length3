#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include "../../x86/check/scalar-plan.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
static int failed(unsigned line){fprintf(stderr,"FLDCW line=%u\n",line);return 1;}
int main(void)
{
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0x64u,0x65u,0xf2u,0xf3u};
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,1u,sizeof module};unsigned maximum=0u,span=0u,forms=0u;
    for(unsigned base=0u;base<16u;++base)for(unsigned p=0u;p<8u;++p){unsigned length=0u;memset(page,0x90,sizeof page);
        if(p)page[length++]=prefixes[p];
        if(base>=8u)page[length++]=0x41u;
        page[length++]=0xd9u;page[length++]=(pl_u8)(0x28u|(base&7u));if((base&7u)==4u)page[length++]=0x24u;
        if((base&7u)==5u)for(unsigned n=0u;n<4u;++n)page[length++]=0u;
        pl_x86_instruction i;if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_x87_control_load_supported(&i))return failed(__LINE__);
        pl_u64 size=0u;wasm_cut_report report;if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report)
            ||!size||report.source_bytes!=length||report.source_instructions!=1u||report.memory_bytes!=2u||report.flags_written)return failed(__LINE__);
        for(unsigned bad=0u;bad<12u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=32u;break;
            case 2:changed.flow=PL_X86_FLOW_JUMP;break;case 3:changed.visible_operand_count=3u;break;
            case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.flags&=~PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;
            case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;
            case 10:changed.opcode=0x90u;break;default:++changed.length;break;}
            if(pl_x86_x87_control_load_supported(&changed))return failed(__LINE__);
            _Alignas(8) pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return failed(__LINE__);
        }++forms;
    }
    _Alignas(8) pl_u8 scratch[16384];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
    if(pl_x86_x87_control_load_plan(&arena,&plan))return failed(__LINE__);
    maximum=plan.node_count;span=plan.span;
    if(span>6u)return failed(__LINE__);
    for(pl_u32 raw=0u;raw<65536u;++raw)for(pl_u32 pending=0u;pending<64u;++pending){pl_u64 sw=0xc700u|pending,cw=(raw&0x1f3fu)|0x40u;
        pl_u64 input[]={raw,sw},out[2];if(check_scalar_projection(&plan,input,out,2u)||out[0]!=cw
            ||out[1]!=((sw&0x7f7fu)|((sw&~cw&63u)?0x8080u:0u)))return failed(__LINE__);}
    page[0]=0xf0u;page[1]=0xd9u;page[2]=0x28u;if(check_fault_admission(&image,&options,6u))return failed(__LINE__);
    printf("FLDCW: %u shared forms/%u malformed,4194304 complete CW/pending combinations; graph work/span %u/%u; physical oracle separate\n",forms,forms*12u,maximum,span);return 0;
}
