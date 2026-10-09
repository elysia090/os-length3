#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0x64u,0x65u,0xf2u,0xf3u},primary[]={0xd9u,0xd9u,0xddu,0xddu,0xdbu},group[]={2u,3u,2u,3u,7u};
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,8u,sizeof module};unsigned maximum=0u,span=0u;
    for(unsigned form=0u;form<45u;++form)for(unsigned p=0u;p<8u;++p){
        memset(page,0x90,sizeof page);unsigned length=0u,memory=form<5u;if(p)page[length++]=prefixes[p];
        unsigned reg=memory?0u:form-5u;
        page[length++]=(pl_u8)(memory?primary[form]:reg<16u?0xddu:reg<32u?0xdfu:0xd9u);
        page[length++]=(pl_u8)(memory?((pl_u32)group[form]<<3u)|7u:(reg<8u||(reg>=16u&&reg<24u)?0xd0u:0xd8u)+(reg&7u));
        pl_x86_instruction i;pl_x86_x87_float_store law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_x87_float_store_lower(&i,&law)||law.memory!=memory)return 1;
        _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(pl_x86_x87_float_store_plan(law.bytes*8u,&arena,&plan)||plan.node_count>PL_X86_X87_FLOAT_STORE_MAX_NODES)return 1;
        if(plan.node_count>maximum)maximum=plan.node_count;
        if(plan.span>span)span=plan.span;
        pl_u64 size=0u;wasm_cut_report report;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report)||!size
            ||report.source_bytes!=length||report.source_instructions!=1u||report.memory_bytes!=(memory?law.bytes:0u)
            ||report.flags_written)return 1;
        for(unsigned bad=0u;bad<14u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.machine_argument^=1ull<<26u;break;
            case 2:changed.flow=PL_X86_FLOW_FAULT;break;case 3:changed.visible_operand_count=0u;break;
            case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.flags|=PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags^=PL_X86_INSTRUCTION_WRITES_MEMORY;break;
            case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;
            case 10:changed.opcode=0x90u;break;case 11:changed.encoding=PL_X86_ENCODING_VEX;break;
            case 12:changed.source_bytes=0u;break;default:++changed.length;break;}
            pl_x86_x87_float_store value,old;memset(&old,0xa5,sizeof old);value=old;
            if(pl_x86_x87_float_store_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
            arena.used=0u;pl_x86_semantic semantic;if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
        }
    }
    page[0]=0xf0u;page[1]=0xd9u;page[2]=0x17u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("Floating stores: 360 shared memory/register/prefix forms,5040 malformed laws; maximum pure work/span %u/%u; hardware/numeric reference separate\n",maximum,span);return 0;
}
