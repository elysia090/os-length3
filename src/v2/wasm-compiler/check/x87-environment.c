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
    wasm_cut_options options={map.address,1u,sizeof module};unsigned forms=0u,bad_forms=0u;
    for(unsigned op=0u;op<4u;++op)for(unsigned narrow=0u;narrow<2u;++narrow)for(unsigned base=0u;base<16u;++base)for(unsigned p=0u;p<8u;++p){
        unsigned restore=op&1u,full=op>=2u,env=narrow||p==1u?14u:28u,extent=env+(full?80u:0u),length=0u;
        memset(page,0x90,sizeof page);if(p)page[length++]=prefixes[p];if(narrow&&p!=1u)page[length++]=0x66u;
        if(base>=8u)page[length++]=0x41u;
        page[length++]=(pl_u8)(full?0xddu:0xd9u);page[length++]=(pl_u8)((restore?4u:6u)<<3u|(base&7u));
        if((base&7u)==4u)page[length++]=0x24u;
        if((base&7u)==5u)for(unsigned n=0u;n<4u;++n)page[length++]=0u;
        pl_x86_instruction i;pl_x86_x87_environment law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_x87_environment_lower(&i,&law)||law.bytes!=extent||law.environment_bytes!=env||law.restore!=restore||law.registers!=full)return 1;
        pl_u64 size=0u;wasm_cut_report report;if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&size,&report)
            ||!size||report.source_bytes!=length||report.source_instructions!=1u||report.memory_bytes!=extent||report.flags_written)return 1;
        for(unsigned bad=0u;bad<14u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=128u;break;
            case 2:changed.flow=PL_X86_FLOW_JUMP;break;case 3:changed.visible_operand_count=3u;break;
            case 4:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;case 5:changed.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
            case 6:changed.flags&=~(pl_u32)(restore?PL_X86_INSTRUCTION_READS_MEMORY:PL_X86_INSTRUCTION_WRITES_MEMORY);break;
            case 7:changed.flags|=restore?PL_X86_INSTRUCTION_WRITES_MEMORY:PL_X86_INSTRUCTION_READS_MEMORY;break;
            case 8:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;case 9:changed.flags|=PL_X86_INSTRUCTION_TRAP_AFTER;break;
            case 10:changed.opcode=0x90u;break;case 11:changed.encoding=PL_X86_ENCODING_VEX;break;case 12:changed.source_bytes=0u;break;default:++changed.length;break;}
            pl_x86_x87_environment old,value;memset(&old,0xa5,sizeof old);value=old;
            if(pl_x86_x87_environment_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
            _Alignas(8) pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++bad_forms;
        }++forms;
    }
    page[0]=0xf0u;page[1]=0xd9u;page[2]=0x30u;if(check_fault_admission(&image,&options,6u))return 1;
    printf("x87 environment: %u common width/address/prefix forms/%u malformed controls; extent borrowing/sparse stores; physical oracle separate\n",forms,bad_forms);return 0;
}
