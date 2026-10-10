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
    for(unsigned width=4u;width<=8u;width+=4u)for(unsigned direction=0u;direction<6u;++direction)
    for(unsigned dst=0u;dst<16u;++dst)for(unsigned src=0u;src<(direction<2u||direction>=4u?16u:1u);++src)for(unsigned prefix=0u;prefix<4u;++prefix){
        unsigned half=direction>=4u;if(half&&width!=8u)continue;
        unsigned read=direction==2u,write=direction==3u,n=0u;memset(page,0x90,sizeof page);if(prefix)page[n++]=prefixes[prefix];
        if(!half)page[n++]=(pl_u8)(width==4u?0xf3u:0xf2u);
        unsigned reg=half||direction==0u||read?dst:write?dst:src,rm=half||direction==0u?src:direction==1u?dst:7u;
        unsigned rex=(reg>=8u?4u:0u)|((half||direction<2u)&&rm>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
        page[n++]=0x0fu;page[n++]=(pl_u8)(half?(direction==4u?0x12u:0x16u):direction==1u||write?0x11u:0x10u);page[n++]=(pl_u8)((half||direction<2u?0xc0u:0u)|((reg&7u)<<3u)|(rm&7u));
        pl_x86_instruction i;pl_x86_scalar_vector_transfer law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_scalar_vector_transfer_lower(&i,&law)||law.bytes!=width||law.source_memory!=read||law.target_memory!=write
            ||law.clear!=read||law.alias!=(direction<2u&&dst==src)||law.source_offset!=(direction==4u?8u:0u)||law.target_offset!=(direction==5u?8u:0u))return 1;
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
    for(unsigned family=0u;family<4u;++family)for(unsigned dst=0u;dst<16u;++dst)for(unsigned src=0u;src<(family?16u:8u);++src)
    for(unsigned wide=0u;wide<2u;++wide){unsigned n=0u;memset(page,0x90,sizeof page);
        if(family==1u||family==3u)page[n++]=0x66u;
        page[n++]=(pl_u8)(0x40u|(wide?8u:0u)|(dst>=8u?4u:0u)|(src>=8u?1u:0u));
        page[n++]=0x0fu;page[n++]=(pl_u8)(family<2u?0xd7u:0x50u);page[n++]=(pl_u8)(0xc0u|((dst&7u)<<3u)|(src&7u));
        pl_x86_instruction i;pl_x86_vector_signmask law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_vector_signmask_lower(&i,&law)||law.source!=src||law.target!=dst
            ||law.mmx!=(family==0u)||law.bytes!=(family<2u?1u:family==2u?4u:8u)){
            printf("mask law red family%u dst%u src%u wide%u machine%u arg%llx bits%u/%u regbits%u/%u flags%x\n",family,dst,src,wide,i.machine_operation,(unsigned long long)i.machine_argument,i.operands[0].bits,i.operands[1].bits,i.operands[0].value.reg.bits,i.operands[1].value.reg.bits,i.flags);return 1;}
        pl_u64 bytes=0u;wasm_cut_report report;
        int made=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
        if(made||!bytes||report.source_bytes!=n||report.flags_written){printf("mask emission red family%u dst%u src%u wide%u status%d\n",family,dst,src,wide,made);return 1;}
        for(unsigned bit=0u;bit<64u;++bit){pl_x86_instruction changed=i;changed.machine_argument^=1ull<<bit;pl_x86_vector_signmask old,value;
            memset(&old,0xa5,sizeof old);value=old;
            /* PS and PD have identical operand shapes/opcodes. This bit is
             * a valid semantic lane width, not a malformed descriptor. */
            if(family>=2u&&bit==32u){if(!pl_x86_vector_signmask_lower(&changed,&value)||value.bytes!=(family==2u?8u:4u))return 1;continue;}
            if(pl_x86_vector_signmask_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
            ++refusals;}
        ++forms;
    }
    page[0]=0xf0u;page[1]=0xf3u;page[2]=0x0fu;page[3]=0x10u;page[4]=0xc0u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("Scalar/half/mask transfer: %u shared forms/%u malformed laws; exact region/fault execution separate\n",forms,refusals);return 0;
}
