#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0x64u,0x65u,0xf2u,0xf3u};
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,8u,sizeof module};
    for(unsigned form=0u;form<8u;++form){
        memset(page,0x90,sizeof page);unsigned length=0u;if(form)page[length++]=prefixes[form];page[length++]=0x9bu;
        /* A following FNINIT must not be fused across the waiting cut. */
        page[length]=0xdbu;page[length+1u]=0xe3u;
        pl_x86_instruction i;if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_x87_wait_supported(&i))return 1;
        pl_u64 size=0u;wasm_cut_report r;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&r)||!size
            ||r.source_instructions!=1u||r.source_bytes!=length||r.continuation!=map.address+length
            ||r.boundary!=WASM_CUT_SYSTEM||r.memory_bytes||r.read_registers||r.written_registers||r.flags_written)return 1;
        for(unsigned bad=0u;bad<12u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument=1u;break;case 1:changed.opcode=0xd9u;break;
                case 2:changed.flow=PL_X86_FLOW_SYSTEM;break;case 3:changed.visible_operand_count=1u;break;
                case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
                case 6:changed.flags|=PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;
                case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;
                case 10:changed.source_bytes=0u;break;default:++changed.length;break;}
            if(pl_x86_x87_wait_supported(&changed))return 1;
        }
    }
    page[0]=0xf0u;page[1]=0x9bu;if(check_fault_admission(&image,&options,6u))return 1;
    puts("FWAIT: 8 forms/96 malformed descriptors; precise cut separates subsequent FNINIT; MP/TS/EM and #MF/FERR runtime checks separate");return 0;
}
