#include <wasm-compiler/cut.h>
#include "fault-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],output[65536];
static unsigned failures;
#define EXPECT(x) do {if(!(x)){fprintf(stderr,"system cut: line %u\n",(unsigned)__LINE__);++failures;}} while(0)
static int save(const char *directory,unsigned rank,const char *suffix,const void *bytes,size_t size)
{
    if(!directory)return 0;
    char name[4096];
    int n=snprintf(name,sizeof name,"%s/system-%u.%s",directory,rank,suffix);
    if(n<=0||(size_t)n>=sizeof name)return -1;
    FILE *file=fopen(name,"wbx");if(!file)return -1;
    int result=fwrite(bytes,1u,size,file)==size?0:-1;if(fclose(file))result=-1;return result;
}
int main(int argc,char **argv)
{
    if(argc!=1&&argc!=2)return 2;
    pl_x86_map map={page,0x100000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,8u,sizeof output};
    static const pl_u8 forms[][3]={{0x0fu,0x05u},{0x48u,0x0fu,0x07u}};
    for(unsigned rank=0u;rank<2u;++rank){
        memset(page,0x90,sizeof page);memcpy(page,forms[rank],rank+2u);
        pl_u64 emitted=0u;wasm_cut_report report;
        EXPECT(!wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&emitted,&report));
        EXPECT(report.source_instructions==1u && report.source_bytes==rank+2u
            && report.continuation==map.address+rank+2u && report.boundary==WASM_CUT_CONTROL
            && !report.memory_bytes && report.flags_written
            && report.read_registers==(rank?0x802u:0u) && report.written_registers==(rank?0u:0x802u));
        if(save(argc==2?argv[1]:NULL,rank,"wasm",output,(size_t)emitted)
                || save(argc==2?argv[1]:NULL,rank,"source-page",page,sizeof page))return 1;
    }
    memset(page,0x90,sizeof page);page[1]=0x0fu;page[2]=0x05u;
    pl_u64 emitted=0u;wasm_cut_report report;
    EXPECT(!wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&emitted,&report));
    EXPECT(report.source_instructions==1u && report.source_bytes==1u);
    static const pl_u8 refused[][4]={{0x0fu,0x07u},{0x0fu,0x34u},{0x0fu,0x35u},{0xf0u,0x0fu,0x05u},{0xf0u,0x48u,0x0fu,0x07u}};
    for(unsigned rank=0u;rank<5u;++rank){
        memset(page,0x90,sizeof page);memcpy(page,refused[rank],sizeof refused[rank]);memset(output,0xa5,sizeof output);
        if(rank>=3u){EXPECT(!check_fault_admission(&image,&options,6u));continue;}
        memset(&report,0xa5,sizeof report);wasm_cut_report before=report;emitted=77u;
        EXPECT(wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&emitted,&report)==WASM_COMPILER_ERROR_GRAMMAR);
        EXPECT(emitted==77u && !memcmp(&before,&report,sizeof report));
        for(unsigned i=0u;i<sizeof output;++i)EXPECT(output[i]==0xa5u);
    }
    if(failures)return 1;
    puts("SYSCALL/SYSRETQ: two common C transfers, cut separation, two #UD and three immutable grammar refusals");return 0;
}
