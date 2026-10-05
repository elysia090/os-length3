#define _GNU_SOURCE
/* Actual user-mode XCHG observations. The native harness cannot exchange
 * its live RSP; those encodings are checked for admission separately. */
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
extern void native_cut(machine_state *,const void *);
static pl_u8 page[4096],module[65536];
static pl_u64 random_word(pl_u64 *seed)
{*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static int save(const char *directory,unsigned form,const char *suffix,const void *data,size_t bytes)
{
    if(!directory)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/exchange-%u.%s",directory,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx");if(!file)return -1;
    int status=fwrite(data,1u,bytes,file)==bytes?0:-1;if(fclose(file))status=-1;return status;
}
static unsigned encode(pl_u8 *code,unsigned width,unsigned a,unsigned b,unsigned legacy,unsigned short_form)
{
    unsigned n=0u;
    if(width==16u)code[n++]=0x66u;
    unsigned rex=(width==64u?8u:0u)|(a>=8u?1u:0u)|(!short_form&&b>=8u?4u:0u);
    if(rex||(width==8u&&!legacy))code[n++]=(pl_u8)(0x40u|rex);
    if(short_form)code[n++]=(pl_u8)(0x90u|(a&7u));
    else {code[n++]=(pl_u8)(width==8u?0x86u:0x87u);code[n++]=(pl_u8)(0xc0u|((b&7u)<<3u)|(a&7u));}
    return n;
}
int main(int argc,char **argv)
{
    if(argc!=1&&argc!=2)return 2;
    const char *directory=argc==2?argv[1]:NULL;
    pl_u8 *code=mmap(NULL,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(code==MAP_FAILED)return 1;
    const unsigned pairs[][2]={{0,3},{1,2},{6,7},{8,15},{9,10},{11,12},{13,14},{0,0},{8,8},{5,2}};
    const unsigned high[][2]={{0,4},{4,7},{0,0},{4,4},{5,2},{6,3},{3,7}};
    unsigned forms=0u,observations=0u;pl_u64 seed=0x78636867616c6961ull;int result=1;
    for(unsigned family=0u;family<3u;++family)
    for(unsigned w=family==1u?1u:0u;w<(family==2u?1u:4u);++w)
    for(unsigned pair=0u;pair<(family==0u?10u:family==1u?16u:7u);++pair)
    for(unsigned variant=0u;variant<(family==1u?1u:3u);++variant){
        if(family==1u&&pair==4u)continue;
        unsigned width=8u<<w,a=family==0u?pairs[pair][0]:family==1u?pair:high[pair][0];
        unsigned b=family==0u?pairs[pair][1]:family==1u?0u:high[pair][1],n=0u;
        memset(page,0x90,sizeof page);
        /* The exchange must read current SSA, not reload either entry value. */
        if(variant==1u){page[n++]=0x49u;page[n++]=0x89u;page[n++]=0xcau;} /* MOV R10,RCX */
        n+=encode(page+n,width,a,b,family==2u,family==1u);
        if(variant==2u)n+=encode(page+n,width,a,b,family==2u,0u);
        if(variant==1u){page[n++]=0x4du;page[n++]=0x89u;page[n++]=0xd3u;} /* MOV R11,R10 */
        unsigned instructions=variant==1u?3u:variant==2u?2u:1u;
        memcpy(code,page,sizeof page);code[n]=0xc3u;
        pl_u64 records[64][34];
        for(unsigned row=0u;row<64u;++row){
            machine_state before={0},actual;
            for(unsigned reg=0u;reg<16u;++reg)before.registers[reg]=random_word(&seed);
            before.rflags=0x202u|(random_word(&seed)&0xcd5u);
            actual=before;native_cut(&actual,code);
            before.registers[4]=actual.registers[4];
            if(actual.rflags!=before.rflags)goto finish;
            for(unsigned reg=0u;reg<16u;++reg){records[row][reg]=before.registers[reg];records[row][17u+reg]=actual.registers[reg];}
            records[row][16]=before.rflags;records[row][33]=actual.rflags;++observations;
        }
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u};wasm_cut_options options={image.entry,instructions,sizeof module};
        wasm_cut_report report;pl_u64 bytes=0u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
        if(status||report.source_instructions!=instructions||report.source_bytes!=n||report.flags_written||report.memory_bytes){
            fprintf(stderr,"exchange form %u red: compiler=%d, instructions=%llu/%u\n",forms,status,
                status?0ull:(unsigned long long)report.source_instructions,instructions);goto finish;
        }
        char json[256];int length=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"sourceBytes\":%u,\"instructions\":%u,\"native\":64,\"words\":34}\n",n,instructions);
        if(length<1||(size_t)length>=sizeof json||save(directory,forms,"json",json,(size_t)length)
                ||save(directory,forms,"source-page",page,sizeof page)||save(directory,forms,"cases",records,sizeof records)
                ||save(directory,forms,"wasm",module,(size_t)bytes))goto finish;
        ++forms;
    }
    /* Includes the live-RSP encodings that must not be run by native_cut. */
    for(unsigned width=8u;width<=64u;width*=2u)
    for(unsigned a=0u;a<16u;++a)for(unsigned b=0u;b<16u;++b){
        memset(page,0x90,sizeof page);unsigned n=encode(page,width,a,b,0u,0u);
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u};wasm_cut_options options={image.entry,1u,sizeof module};
        wasm_cut_report report;pl_u64 bytes=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
                ||report.source_bytes!=n||report.flags_written||report.memory_bytes)goto finish;
    }
    /* Memory XCHG is already an implicitly locked transaction, never a
     * pure register substitution, with or without an explicit LOCK prefix. */
    for(unsigned segment=0u;segment<3u;++segment)for(unsigned locked=0u;locked<2u;++locked){
        unsigned n=0u;memset(page,0x90,sizeof page);
        if(locked)page[n++]=0xf0u;
        if(segment)page[n++]=(pl_u8)(0x63u+segment);
        page[n++]=0x48u;page[n++]=0x87u;page[n++]=0x03u;
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u};wasm_cut_options options={image.entry,1u,sizeof module};
        wasm_cut_report report;pl_u64 bytes=0u;
        unsigned role=segment==1u?64u:segment==2u?128u:0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
                ||report.source_bytes!=n||report.memory_bytes!=8u||report.memory_access!=(role|3u)
                ||report.boundary!=WASM_CUT_MEMORY||report.flags_written)goto finish;
    }
    if(forms!=186u)goto finish;
    result=0;
finish:
    if(munmap(code,4096u))result=1;
    if(!result)printf("Register exchange: %u native GPR/flags observations, %u emissions, 1024 all-register admissions\n",observations,forms);
    return result;
}
