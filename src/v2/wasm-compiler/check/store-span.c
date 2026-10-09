#include <wasm-compiler/cut.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(void)
{
    pl_u32 cases=0u;
    for(pl_u32 base=0u;base<16u;++base)for(pl_u32 value=0u;value<16u;++value)
    for(pl_u32 limit=1u;limit<=16u;++limit){memset(page,0x90,sizeof page);pl_u32 at=0u;
        for(pl_u32 n=0u;n<16u;++n){page[at++]=(pl_u8)(0x48u|(base>=8u?1u:0u)|(value>=8u?4u:0u));
            page[at++]=0x89u;page[at++]=(pl_u8)(0x40u|((value&7u)<<3u)|(base&7u));
            if((base&7u)==4u)page[at++]=0x24u;
            page[at++]=(pl_u8)(n*8u);}
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u};wasm_cut_options options={image.entry,limit,sizeof module};
        wasm_cut_report report;pl_u64 bytes;int result=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
        pl_u32 expected=base==4u||base==5u?1u:limit;
        if(result||report.source_instructions!=expected||report.written_registers||report.memory_bytes!=8u){
            fprintf(stderr,"store span %u/%u/%u: %d,%llu wanted%u mask%u memory%u\n",base,value,limit,result,
                (unsigned long long)report.source_instructions,expected,report.written_registers,report.memory_bytes);return 1;}
        ++cases;
    }
    printf("store span construction: %u GPR/base/budget cases; implicit SS remains its exact stack boundary\n",cases);return 0;
}
