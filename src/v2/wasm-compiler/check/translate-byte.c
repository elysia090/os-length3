#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[4096];
int main(void)
{
    const pl_u8 prefixes[]={0u,0x66u,0x48u,0x41u,0xf2u,0xf3u,0x64u,0x65u};pl_u32 forms=0u,refusals=0u;
    for(pl_u32 address=0u;address<2u;++address)for(pl_u32 prefix=0u;prefix<8u;++prefix){
        memset(page,0x90,sizeof page);pl_u32 n=0u;if(prefixes[prefix])page[n++]=prefixes[prefix];
        if(address)page[n++]=0x67u;
        page[n++]=0xd7u;
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_translate_byte_memory(&i))return 1;
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
            ||report.source_bytes!=n||report.memory_bytes!=1u||report.source_instructions!=1u||report.flags_written)return 1;
        for(pl_u32 bad=0u;bad<12u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument=1u;break;case 1:changed.operands[0].bits=16u;break;
            case 2:changed.operands[0].value.memory.base.index=11u;break;case 3:changed.operands[1].value.reg.flags=PL_X86_REGISTER_HIGH8;break;
            case 4:changed.operands[0].value.memory.displacement=1;break;case 5:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 6:changed.flags&=~PL_X86_INSTRUCTION_READS_MEMORY;break;case 7:changed.flags&=~PL_X86_INSTRUCTION_MAY_TRAP;break;
            case 8:changed.visible_operand_count=1u;break;case 9:changed.status=PL_X86_DECODE_INVALID;break;
            case 10:changed.operands[0].value.memory.segment.index=6u;break;default:changed.operand_count=1u;break;}
            if(pl_x86_translate_byte_memory(&changed))return 1;
            pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++refusals;
        }
        ++forms;
    }
    printf("XLAT: %u implicit-address/prefix forms, %u common malformed refusals\n",forms,refusals);return 0;
}
