#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(int argc,char **argv)
{
    if(argc>2)return 2;
    pl_u32 forms=0u,refusals=0u;
    const pl_u8 repeats[]={0u,0xf2u,0xf3u};
    for(pl_u32 rex=0u;rex<2u;++rex)for(pl_u32 addr=0u;addr<2u;++addr)for(pl_u32 rep=0u;rep<3u;++rep)for(pl_u32 write=0u;write<2u;++write)for(pl_u32 w=0u;w<3u;++w){
        pl_u32 bytes=w==0u?1u:w==1u?2u:4u,n=0u;memset(page,0x90,sizeof page);
        if(repeats[rep])page[n++]=repeats[rep];
        if(addr)page[n++]=0x67u;
        if(bytes==2u)page[n++]=0x66u;
        if(rex)page[n++]=0x4du;
        page[n++]=(pl_u8)((write?0x6eu:0x6cu)|(bytes==1u?0u:1u));
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        pl_u32 effective_bytes=rex&&bytes==2u?4u:bytes;
        pl_x86_instruction i;pl_x86_string_io law;if(pl_x86_decode_profile(&image,map.address,&i)||!pl_x86_string_io_lower(&i,&law)
            ||law.bytes!=effective_bytes||law.write!=write||law.repeated!=(rep!=0u)||law.address_bits!=(addr?32u:64u))return 1;
        wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 count=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&count,&report)||report.source_bytes!=n
            ||report.source_instructions!=1u||report.flags_written||report.memory_bytes!=effective_bytes)return 1;
        if(argc==2){char key[33],path[4096];for(pl_u32 k=0u;k<n;++k)snprintf(key+k*2u,3u,"%02x",page[k]);
            int length=snprintf(path,sizeof path,"%s/%s.wasm",argv[1],key);if(length<1||(size_t)length>=sizeof path)return 2;
            FILE *file=fopen(path,"wbx");if(!file)return 2;int bad=fwrite(module,1u,(size_t)count,file)!=(size_t)count;if(fclose(file))bad=1;if(bad)return 2;}
        for(pl_u32 bad=0u;bad<8u;++bad){pl_x86_instruction changed=i;
            switch(bad){case 0:changed.machine_argument^=1ull<<60u;break;case 1:changed.flags|=PL_X86_INSTRUCTION_LOCKED;break;
            case 2:changed.machine_argument^=1ull<<9u;break;case 3:changed.flags^=PL_X86_INSTRUCTION_REPEATED;break;
            case 4:changed.address_width=16u;break;case 5:changed.machine_argument^=1ull<<8u;break;
            case 6:changed.status=PL_X86_DECODE_INVALID;break;default:changed.machine_argument=(changed.machine_argument&~255ull)|8u;break;}
            pl_x86_string_io out,old;memset(&old,0xa5,sizeof old);out=old;
            if(pl_x86_string_io_lower(&changed,&out)||memcmp(&old,&out,sizeof old))return 1;
            pl_u8 scratch[8192];pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_lower(&changed,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC)return 1;
            ++refusals;}
        ++forms;
    }
    printf("String I/O: %u native/shared constructions, %u malformed refusals; no ISA callback\n",forms,refusals);return 0;
}
