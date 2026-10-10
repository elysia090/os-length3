#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    const pl_u8 opcodes[]={0xef,0xdb,0xeb,0xdf,0xfc,0xfd,0xfe,0xd4,0x74,0x75,0x76,0xf8,0xf9,0xfa,0xfb,
        0x64,0x65,0x66,0xec,0xed,0xdc,0xdd,0xe8,0xe9,0xd8,0xd9,0xda,0xea,0xde,0xee,0xe0,0xe3,0xd5,
        0xf5,0xe4,0xe5,0xf4,0x67,0x6b,0x63,0xf6,0x0b};
    const pl_u8 standard[]={0x38,0x39,0x3a,0x3b,0x3c,0x3d,0x3e,0x3f,0x29,0x37,0x40,0x28,0x2b,0x1c,0x1d,0x1e};
    const pl_u8 horizontal[]={1u,2u,3u,5u,6u,7u,4u,8u,9u,10u};
    pl_u32 forms=0u,refusals=0u;
    for(pl_u32 wide=0u;wide<2u;++wide)for(pl_u32 family=0u;family<68u;++family)
    for(pl_u32 dst=0u;dst<(wide?16u:8u);++dst)for(pl_u32 src=0u;src<(wide?17u:9u);++src){
        if(!wide&&family>=42u&&family<55u)continue;
        pl_u32 memory=src==(wide?16u:8u),n=0u;memset(page,0x90,sizeof page);if(wide)page[n++]=0x66u;
        if(dst>=8u||(!memory&&src>=8u))page[n++]=(pl_u8)(0x40u|(dst>=8u?4u:0u)|(!memory&&src>=8u?1u:0u));
        page[n++]=0x0fu;if(family>=41u)page[n++]=0x38u;page[n++]=family<42u?opcodes[family]:family<58u?standard[family-42u]:horizontal[family-58u];page[n++]=(pl_u8)((memory?0u:0xc0u)|((dst&7u)<<3u)|(memory?0u:src&7u));
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_x86_instruction i;pl_x86_vector_binary law;if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_vector_binary_lower(&i,&law)
            ||law.register_bytes!=(wide?16u:8u)||law.source_memory!=memory)return 1;
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
            ||report.source_bytes!=n||report.source_instructions!=1u||report.memory_bytes!=(memory?(wide?16u:8u):0u)||report.flags_written){
            fprintf(stderr,"packed entrance differs wide=%u family=%u dst=%u src=%u\n",wide,family,dst,src);return 1;}
        for(pl_u32 bad=0u;bad<8u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument|=1ull<<63u;break;case 1:changed.operands[0].bits=32u;break;
            case 2:changed.operands[0].value.reg.index=32u;break;case 3:changed.visible_operand_count=1u;break;
            case 4:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 5:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 6:changed.flow=PL_X86_FLOW_RETURN;break;default:changed.status=PL_X86_DECODE_INVALID;break;}
            pl_x86_vector_binary out,old;memset(&old,0xa5,sizeof old);out=old;
            if(pl_x86_vector_binary_lower(&changed,&out)||memcmp(&out,&old,sizeof out))return 1;
            ++refusals;
        }
        ++forms;
    }
    printf("Packed binary: %u MMX/XMM common/native forms, %u unchanged malformed refusals\n",forms,refusals);return 0;
}
