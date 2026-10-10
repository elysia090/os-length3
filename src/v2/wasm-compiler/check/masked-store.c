#include <wasm-compiler/cut.h>
#include "../src/cut-internal.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(int argc,char **argv)
{
    pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    wasm_cut_options options={map.address,1u,sizeof module};pl_u32 forms=0u,refusals=0u;
    const pl_u8 prefixes[]={0u,0x2eu,0x36u,0x3eu,0x26u,0x64u,0x65u};
    for(pl_u32 wide=0u;wide<2u;++wide)for(pl_u32 address=0u;address<2u;++address)
    for(pl_u32 prefix=0u;prefix<7u;++prefix)for(pl_u32 d=0u;d<(wide?16u:8u);++d)for(pl_u32 s=0u;s<(wide?16u:8u);++s){
        memset(page,0x90,sizeof page);pl_u32 n=0u;if(prefixes[prefix])page[n++]=prefixes[prefix];if(address)page[n++]=0x67u;
        if(wide)page[n++]=0x66u;
        if(d>=8u||s>=8u)page[n++]=(pl_u8)(0x40u|(d>=8u?4u:0u)|(s>=8u?1u:0u));
        page[n++]=0x0fu;page[n++]=0xf7u;page[n++]=(pl_u8)(0xc0u|((d&7u)<<3u)|(s&7u));
        pl_x86_instruction i;if(pl_x86_decode_profile(&image,map.address,&i)||!cut_masked_store_supported(&i))return 1;
        pl_u64 bytes=0u;wasm_cut_report report;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||!bytes||report.source_bytes!=n||report.source_instructions!=1u)return 1;
        for(pl_u32 bad=0u;bad<6u;++bad){pl_x86_instruction b=i;
            switch(bad){case 0:b.machine_argument|=1ull<<63u;break;case 1:b.operands[0].bits=32u;break;case 2:b.flags|=PL_X86_INSTRUCTION_LOCKED;break;
                case 3:b.opcode=0x90u;break;case 4:b.visible_operand_count=1u;break;default:b.address_width=16u;break;}
            if(cut_masked_store_supported(&b))return 1;
            ++refusals;}
        if(argc==2&&d==0u&&s==1u&&prefix==0u){char file[512];if(snprintf(file,sizeof file,"%s/masked-%u-%u.wasm",argv[1],wide,address)<0)return 1;
            FILE *out=fopen(file,"wbx");if(!out||fwrite(module,1u,(size_t)bytes,out)!=(size_t)bytes||fclose(out))return 1;}
        ++forms;
    }
    printf("Masked stores: %u constructors / %u malformed refusals; complete preflight, no payload read, byte stores only\n",forms,refusals);return 0;
}
