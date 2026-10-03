#include <wasm-compiler/cut.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096], output[65536];
static unsigned failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"io compiler: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static int save(const char *directory, unsigned rank, const char *suffix, const void *data, size_t size)
{
    char path[4096]; int n=snprintf(path,sizeof path,"%s/io-%u.%s",directory,rank,suffix);
    if (n<=0 || (size_t)n>=sizeof path) return -1;
    FILE *file=fopen(path,"wbx"); if (!file) return -1;
    int status=fwrite(data,1u,size,file)==size ? 0 : -1;
    if (fclose(file)) status=-1;
    return status;
}
int main(int argc, char **argv)
{
    if (argc!=1 && argc!=2) return 2;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,0x400000u}; wasm_cut_options options={image.entry,1024u,sizeof output};
    unsigned rank=0u;
    for (unsigned address32=0u;address32<2u;++address32)
    for (unsigned form=0u;form<13u;++form,++rank) {
        memset(page,0x90,sizeof page); unsigned at=0u;
        unsigned width=form==12u ? 0u : (form%3u==0u ? 1u : form%3u==1u ? 2u : 4u);
        unsigned write=form<12u ? form/6u : 0u, dynamic=form<12u ? (form/3u)%2u : 0u;
        if (address32) page[at++]=0x67u;
        if (width==2u) page[at++]=0x66u;
        if (form==12u) { page[at++]=0x0fu; page[at++]=0x31u; }
        else {
            page[at++]=(pl_u8)((dynamic ? 0xecu : 0xe4u) | (write ? 2u : 0u) | (width==1u ? 0u : 1u));
            if (!dynamic) page[at++]=0x61u;
        }
        wasm_cut_report report; pl_u64 length=0u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&length,&report);
        EXPECT(!status);
        if (status) continue;
        EXPECT(report.source_instructions==1u && report.source_bytes==at && report.boundary==WASM_CUT_SYSTEM
            && !report.memory_bytes && !report.memory_access && !report.flags_written);
        EXPECT(report.written_registers==(form==12u ? 5u : write ? 0u : 1u));
        EXPECT(report.read_registers==(form==12u ? 0u : (write ? 1u : width<4u ? 1u : 0u) | (dynamic ? 4u : 0u)));
        if (argc==2 && !failures) {
            char json[256]; int n=snprintf(json,sizeof json,
                "{\"entry\":\"4194304\",\"sourceBytes\":%u,\"width\":%u,\"write\":%u,\"dynamic\":%u,\"time\":%u}\n",
                at,width,write,dynamic,form==12u);
            if (n<=0 || (size_t)n>=sizeof json || save(argv[1],rank,"json",json,(size_t)n)
                    || save(argv[1],rank,"wasm",output,(size_t)length) || save(argv[1],rank,"source-page",page,sizeof page)) return 1;
        }
    }
    const pl_u8 refused[][4]={{0x0fu,0x01u,0xf9u,0x90u},{0x0fu,0x33u,0x90u,0x90u},
        {0x6cu,0x90u,0x90u,0x90u},{0x6eu,0x90u,0x90u,0x90u},{0xf3u,0x6cu,0x90u,0x90u}};
    for (unsigned i=0u;i<sizeof refused/sizeof refused[0];++i) {
        memset(page,0x90,sizeof page); memcpy(page,refused[i],sizeof refused[i]); memset(output,0xa5,sizeof output);
        pl_u64 length=0u; wasm_cut_report report;
        EXPECT(wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&length,&report)==WASM_COMPILER_ERROR_GRAMMAR);
        for (unsigned j=0u;j<sizeof output;++j) EXPECT(output[j]==0xa5u);
    }
    if (!failures) puts("Scalar IO and RDTSC: 26 C entrance forms green (not Linux boot)");
    return failures ? 1 : 0;
}
