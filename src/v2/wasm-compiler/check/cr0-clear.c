#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0xf2u,0xf3u,0x64u,0x65u};unsigned controls=0u;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,1u,sizeof module};
    for(unsigned p=0u;p<8u;++p){unsigned n=0u;memset(page,0x90,sizeof page);if(p)page[n++]=prefixes[p];page[n++]=0x0fu;page[n++]=6u;
        pl_x86_instruction i;if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_cr0_clear_supported(&i)){
            fprintf(stderr,"CLTS prefix=%u flow=%u flags=%x argument=%llx\n",p,i.flow,i.flags,(unsigned long long)i.machine_argument);return 1;}
        pl_u64 bytes=0u;wasm_cut_report report;if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes
            ||report.source_bytes!=n||report.source_instructions!=1u||report.memory_bytes||report.read_registers||report.written_registers||report.flags_written)return 1;
        for(unsigned bad=0u;bad<16u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.visible_operand_count=1u;break;case 2:changed.opcode=0u;break;
            case 3:changed.flags&=~PL_X86_INSTRUCTION_PRIVILEGED;break;case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_READS_MEMORY;break;
            case 6:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 7:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 8:changed.flags|=PL_X86_INSTRUCTION_REPEATED;break;
            case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;case 10:changed.status=PL_X86_DECODE_INVALID;break;case 11:changed.flow=PL_X86_FLOW_JUMP;break;
            case 12:changed.source_bytes=0u;break;case 13:--changed.length;break;case 14:++changed.fallthrough;break;default:changed.encoding=PL_X86_ENCODING_VEX;break;}
            if(pl_x86_cr0_clear_supported(&changed))return 1;
            _Alignas(8) pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;++controls;
        }
    }
    page[0]=0xf0u;page[1]=0x0fu;page[2]=6u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("CLTS: 8 shared prefix forms/%u malformed controls; control/privilege execution separate\n",controls);return 0;
}
