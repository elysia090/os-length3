#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    unsigned forms=0u,refusals=0u;
    pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,1u,sizeof module};
    const pl_u8 from[]={1,1,1,2,2,4},to[]={2,4,8,4,8,8};
    for(unsigned sign=0u;sign<2u;++sign)for(unsigned shape=0u;shape<6u;++shape)
    for(unsigned d=0u;d<16u;++d)for(unsigned s=0u;s<17u;++s){
        unsigned memory=s==16u,n=0u;memset(page,0x90,sizeof page);page[n++]=0x66u;
        if(d>=8u||(!memory&&s>=8u))page[n++]=(pl_u8)(0x40u|(d>=8u?4u:0u)|(!memory&&s>=8u?1u:0u));
        page[n++]=0x0fu;page[n++]=0x38u;page[n++]=(pl_u8)(0x20u+shape+(sign?0u:16u));
        page[n++]=(pl_u8)((memory?0u:0xc0u)|((d&7u)<<3u)|(memory?0u:s&7u));
        pl_x86_instruction i;pl_x86_vector_widen law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_vector_widen_lower(&i,&law)
            ||law.source_lane_bytes!=from[shape]||law.target_lane_bytes!=to[shape]||law.signed_lanes!=sign
            ||law.source_bytes!=16u/to[shape]*from[shape]||law.source_memory!=memory)return 1;
        pl_u64 bytes=0u;wasm_cut_report report;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes
            ||report.source_bytes!=n||report.source_instructions!=1u||report.memory_bytes!=(memory?law.source_bytes:0u)||report.flags_written)return 1;
        for(unsigned bad=0u;bad<9u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument|=1ull<<63u;break;case 1:changed.machine_argument^=1ull<<48u;break;
            case 2:changed.operands[0].bits=64u;break;case 3:changed.operands[1].bits=128u;break;case 4:changed.operands[0].value.reg.index=32u;break;
            case 5:changed.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;case 6:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 7:changed.opcode=0x90u;break;default:changed.visible_operand_count=1u;break;}
            pl_x86_vector_widen old,value;memset(&old,0xa5,sizeof old);value=old;
            if(pl_x86_vector_widen_lower(&changed,&value)||memcmp(&value,&old,sizeof old))return 1;
            ++refusals;
        }++forms;
    }
    printf("Packed widening: %u forms/%u malformed refusals, exact2/4/8-byte source extent; physical execution separate\n",forms,refusals);return 0;
}
