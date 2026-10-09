#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x67u,0x64u,0x65u};unsigned forms=0u,refusals=0u;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,1u,sizeof module};
    for(unsigned width=4u;width<=8u;width+=4u)for(unsigned direction=0u;direction<4u;++direction)
    for(unsigned dst=0u;dst<16u;++dst)for(unsigned src=0u;src<(direction<2u?16u:1u);++src)for(unsigned prefix=0u;prefix<4u;++prefix){
        unsigned read=direction==2u,write=direction==3u,n=0u;memset(page,0x90,sizeof page);if(prefix)page[n++]=prefixes[prefix];page[n++]=(pl_u8)(width==4u?0xf3u:0xf2u);
        unsigned reg=direction==0u||read?dst:write?dst:src,rm=direction==0u?src:direction==1u?dst:7u;
        unsigned rex=(reg>=8u?4u:0u)|(direction<2u&&rm>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
        page[n++]=0x0fu;page[n++]=(pl_u8)(direction==1u||write?0x11u:0x10u);page[n++]=(pl_u8)((direction<2u?0xc0u:0u)|((reg&7u)<<3u)|(rm&7u));
        pl_x86_instruction i;pl_x86_scalar_vector_transfer law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_scalar_vector_transfer_lower(&i,&law)||law.bytes!=width||law.source_memory!=read||law.target_memory!=write
            ||law.clear!=read||law.alias!=(direction<2u&&dst==src))return 1;
        pl_u64 bytes=0u;wasm_cut_report report;if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes
            ||report.source_bytes!=n||report.source_instructions!=1u||report.memory_bytes!=((read||write)?width:0u)||report.flags_written)return 1;
        for(unsigned bad=0u;bad<16u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=16u;break;case 2:changed.operands[1].bits=16u;break;
            case 3:changed.visible_operand_count=1u;break;case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.flags^=PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags^=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;case 10:changed.status=PL_X86_DECODE_INVALID;break;case 11:changed.flow=PL_X86_FLOW_FAULT;break;
            case 12:changed.source_bytes=0u;break;case 13:--changed.length;break;case 14:++changed.fallthrough;break;default:changed.opcode=0u;break;}
            pl_x86_scalar_vector_transfer old,value;memset(&old,0xa5,sizeof old);value=old;if(pl_x86_scalar_vector_transfer_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
            _Alignas(8) pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;++refusals;
        }++forms;
    }
    page[0]=0xf0u;page[1]=0xf3u;page[2]=0x0fu;page[3]=0x10u;page[4]=0xc0u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("MOVSS/MOVSD: %u shared forms/%u malformed laws; exact region/fault execution separate\n",forms,refusals);return 0;
}
