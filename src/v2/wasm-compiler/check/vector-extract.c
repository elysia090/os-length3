#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    unsigned forms=0u,refusals=0u;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,1u,sizeof module};
    for(unsigned mmx=0u;mmx<2u;++mmx)for(unsigned dst=0u;dst<16u;++dst)for(unsigned src=0u;src<(mmx?8u:16u);++src)for(unsigned control=0u;control<256u;++control){
        unsigned n=0u;memset(page,0x90,sizeof page);if(!mmx)page[n++]=0x66u;
        unsigned rex=(dst>=8u?4u:0u)|(!mmx&&src>=8u?1u:0u);if(rex)page[n++]=(pl_u8)(0x40u|rex);
        page[n++]=0x0fu;page[n++]=0xc5u;page[n++]=(pl_u8)(0xc0u|((dst&7u)<<3u)|(src&7u));page[n++]=(pl_u8)control;
        pl_x86_instruction i;pl_x86_vector_extract law;
        if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_vector_extract_lower(&i,&law)||law.target!=dst||law.source!=src||law.mmx!=mmx||law.word!=(control&(mmx?3u:7u)))return 1;
        if(dst==9u&&src==3u){pl_u64 bytes=0u;wasm_cut_report report;
            if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes||report.source_bytes!=n||report.memory_bytes||report.flags_written)return 1;}
        for(unsigned bad=0u;bad<4u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<63u;break;case 1:changed.operands[0].bits=64u;break;case 2:changed.operands[1].kind=PL_X86_OPERAND_MEMORY;break;default:changed.operands[2].value.immediate^=1u;break;}
            pl_x86_vector_extract old,value;memset(&old,0xa5,sizeof old);value=old;
            if(pl_x86_vector_extract_lower(&changed,&value)||memcmp(&old,&value,sizeof value))return 1;
            ++refusals;
        }++forms;
    }
    printf("PEXTRW: %u coordinate constructors/%u malformed refusals; physical execution separate\n",forms,refusals);return 0;
}
