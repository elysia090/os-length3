#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(int argc,char **argv)
{
    if(argc>2)return 2;
    const pl_u8 prefixes[]={0u,0x48u,0x67u,0x64u,0x65u,0x66u,0xf2u,0xf3u};
    const pl_u32 levels[]={0u,1u,2u,3u,15u,22u,31u,32u,63u,127u,214u,255u},allocations[]={0u,1u,16u,4095u,4096u,0x8949u,65535u};pl_u32 forms=0u;
    for(pl_u32 p=0u;p<8u;++p)for(pl_u32 l=0u;l<12u;++l)for(pl_u32 a=0u;a<7u;++a){
        memset(page,0x90,sizeof page);pl_u32 n=0u;if(prefixes[p])page[n++]=prefixes[p];page[n++]=0xc8u;
        page[n++]=(pl_u8)allocations[a];page[n++]=(pl_u8)(allocations[a]>>8u);page[n++]=(pl_u8)levels[l];
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||report.source_bytes!=n
            ||report.source_instructions!=1u||report.flags_written||report.written_registers!=48u||report.read_registers!=48u
            ||report.memory_bytes!=(prefixes[p]==0x66u?2u:8u))return 1;
        if(argc==2){char key[33],path[4096];for(pl_u32 k=0u;k<n;++k)snprintf(key+k*2u,3u,"%02x",page[k]);
            int length=snprintf(path,sizeof path,"%s/%s.wasm",argv[1],key);if(length<1||(size_t)length>=sizeof path)return 2;
            FILE *file=fopen(path,"wbx");if(!file)return 2;int bad=fwrite(module,1u,(size_t)bytes,file)!=(size_t)bytes;if(fclose(file))bad=1;if(bad)return 2;}
        memset(module,0xa5,sizeof module);memset(&report,0xa5,sizeof report);wasm_cut_report old=report;bytes=77u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,1u,&bytes,&report)!=WASM_COMPILER_ERROR_CAPACITY
            ||bytes!=77u||memcmp(&old,&report,sizeof old))return 1;
        for(pl_u32 k=0u;k<sizeof module;++k)if(module[k]!=0xa5u)return 1;
        ++forms;
    }
    printf("ENTER constructor: %u native/shared forms, 16/64 widths, masked nesting, untouched capacity failures\n",forms);return 0;
}
