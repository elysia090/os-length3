#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x67u,0x64u,0x65u};unsigned forms=0u,bad_forms=0u;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,1u,sizeof module};
    for(unsigned bytes=2u;bytes<=8u;bytes*=2u)for(unsigned call=0u;call<2u;++call)for(unsigned base=0u;base<16u;++base)for(unsigned prefix=0u;prefix<4u;++prefix){
        unsigned n=0u;memset(page,0x90,sizeof page);if(prefix)page[n++]=prefixes[prefix];if(bytes==2u)page[n++]=0x66u;
        unsigned rex=(bytes==8u?8u:0u)|(base>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
        page[n++]=0xffu;page[n++]=(pl_u8)((call?3u:5u)<<3u|(base&7u));
        if((base&7u)==4u)page[n++]=0x24u;
        if((base&7u)==5u){for(unsigned j=0u;j<4u;++j)page[n++]=0u;}
        pl_x86_instruction i;pl_x86_far_transfer law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_far_transfer_lower(&i,&law)||law.bytes!=bytes||law.call!=call){
            fprintf(stderr,"far law bytes=%u call=%u base=%u prefix=%u sourcebits=%u flags=%x argument=%llx flow=%u\n",bytes,call,base,prefix,i.operands[0].bits,i.flags,(unsigned long long)i.machine_argument,i.flow);return 1;}
        pl_u64 size=0u;wasm_cut_report report;int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report);
        if(status||!size||report.source_instructions!=1u||report.source_bytes!=n||report.memory_bytes!=bytes+2u||report.boundary!=WASM_CUT_CONTROL){fprintf(stderr,"far emit %u/%u/%u/%u status=%d boundary=%u\n",bytes,call,base,prefix,status,report.boundary);return 1;}
        for(unsigned bad=0u;bad<16u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=64u;break;case 2:changed.operands[0].kind=PL_X86_OPERAND_REGISTER;break;
            case 3:changed.visible_operand_count=0u;break;case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.flags&=~PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 8:changed.flags|=PL_X86_INSTRUCTION_REPEATED;break;
            case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;case 10:changed.status=PL_X86_DECODE_INVALID;break;case 11:changed.flow=PL_X86_FLOW_NEXT;break;
            case 12:changed.source_bytes=0u;break;case 13:--changed.length;break;case 14:++changed.fallthrough;break;default:changed.opcode=0u;break;}
            pl_x86_far_transfer old,value;memset(&old,0xa5,sizeof old);value=old;if(pl_x86_far_transfer_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
            _Alignas(8) pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;++bad_forms;
        }++forms;
    }
    page[0]=0xf0u;page[1]=0xffu;page[2]=0x2fu;if(check_fault_admission(&image,&options,6u))return 1;
    printf("far transfer: %u common width/call/address/prefix forms/%u malformed; transaction oracle separate\n",forms,bad_forms);return 0;
}
