#include <wasm-compiler/cut.h>
#include "fault-admission.h"
#include "segment-admission.h"
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096], output[65536];
static unsigned failures;
#define EXPECT(x) do { if (!(x)) { if (failures<8u) fprintf(stderr,"system selector compiler: %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static int save(const char *directory, unsigned rank, const char *suffix, const void *data, size_t size)
{
    char path[4096]; int n=snprintf(path,sizeof path,"%s/segment-%u.%s",directory,rank,suffix);
    if (n<=0 || (size_t)n>=sizeof path) return -1;
    FILE *file=fopen(path,"wbx"); if (!file) return -1;
    int status=fwrite(data,1u,size,file)==size ? 0 : -1; if (fclose(file)) status=-1; return status;
}
int main(int argc, char **argv)
{
    if (argc!=1 && argc!=2) return 2;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,0x400000u}; wasm_cut_options options={image.entry,1u,sizeof output};
    unsigned rank=0u;
    for (unsigned task=0u;task<2u;++task) for (unsigned prefix=0u;prefix<3u;++prefix)
    for (unsigned shape=0u;shape<24u;++shape,++rank) {
        memset(page,0x90,sizeof page); unsigned at=0u, memory=shape>=16u;
        unsigned address32=shape>=20u, form=memory ? (shape-16u)%4u : shape;
        if (address32) page[at++]=0x67u;
        if (prefix==1u) page[at++]=0x66u;
        if (prefix==2u || (!memory && shape>=8u) || (memory && form==2u))
            page[at++]=(pl_u8)(0x40u|(prefix==2u ? 8u : 0u)|((!memory && shape>=8u) || (memory && form==2u) ? 1u : 0u));
        page[at++]=0x0fu; page[at++]=0x00u;
        page[at++]=(pl_u8)(((2u+task)<<3u)|(!memory ? 0xc0u|(shape&7u) : form==0u ? 7u : form==3u ? 5u : 0x44u));
        if (memory && (form==1u || form==2u)) { page[at++]=(pl_u8)(form==1u ? 0x24u : 0x8cu); page[at++]=14u; }
        if (memory && form==3u) for (unsigned i=0u;i<4u;++i) page[at++]=(pl_u8)(512u>>(8u*i));
        wasm_cut_report report; pl_u64 length=0u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&length,&report); EXPECT(!status);
        if (status) continue;
        EXPECT(report.source_instructions==1u && report.source_bytes==at && report.boundary==WASM_CUT_SYSTEM
            && report.memory_bytes==(memory ? 2u : 0u) && report.memory_access==(memory ? (form==1u ? 5u : 1u) : 0u)
            && !report.written_registers && !report.flags_written);
        if (argc==2 && !failures) {
            char json[256]; int n=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":%u,\"task\":%u,\"prefix\":%u,\"memory\":%u,\"address32\":%u,\"form\":%u}\n",at,task,prefix,memory,address32,form);
            if (n<=0 || (size_t)n>=sizeof json || save(argv[1],rank,"json",json,(size_t)n)
                || save(argv[1],rank,"wasm",output,(size_t)length) || save(argv[1],rank,"source-page",page,sizeof page)) return 1;
        }
    }
    /* LAR/LSL share the family tag, not LLDT/LTR's privileged cache writer.
     * They now use the independently checked query/SSA path. */
    const pl_u8 denied[][5]={{0x0f,0x02,0xc0,0x90,0x90},{0x0f,0x03,0xc0,0x90,0x90},
        {0xf0,0x0f,0x00,0xd8,0x90},
        {0x64,0x0f,0x00,0x1f,0x90},{0x65,0x0f,0x00,0x17,0x90}};
    for (unsigned i=0u;i<sizeof denied/sizeof denied[0];++i) {
        memset(page,0x90,sizeof page); memcpy(page,denied[i],sizeof denied[i]); memset(output,0xa5,sizeof output);
        if(i<2u){pl_u64 length=0u;wasm_cut_report report;
            EXPECT(!wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&length,&report));
            EXPECT(length>8u&&report.source_instructions==1u&&report.source_bytes==3u&&!report.memory_bytes
                &&report.flags_written&&(report.written_registers&1u)&&report.continuation==image.entry+3u);continue;}
        if(i==2u){EXPECT(!check_fault_admission(&image,&options,6u));continue;}
        if(denied[i][0]==0x64u||denied[i][0]==0x65u){
            EXPECT(!check_segment_admission(&image,&options,denied[i][0]));
            continue;
        }
        pl_u64 length=123u; wasm_cut_report report;
        EXPECT(wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&length,&report)==WASM_COMPILER_ERROR_GRAMMAR);
        EXPECT(length==123u); for (unsigned j=0u;j<sizeof output;++j) EXPECT(output[j]==0xa5u);
    }
    if (failures) { fprintf(stderr,"%u failures / %u forms\n",failures,rank); return 1; }
    puts("LLDT/LTR: 144 common C compiler entrances green (not Linux boot)"); return 0;
}
