#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <machine/state.h>
#include <sys/mman.h>
#include <stdio.h>
#include <string.h>

extern void native_cut(machine_state *,const void *);
static pl_u8 page[4096],module[65536];
static machine_state records[128][2];
static pl_u64 random_word(pl_u64 *seed)
{*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static int save(const char *directory,pl_u32 form,const char *suffix,const void *bytes,size_t count)
{
    if(!directory)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/count-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx");if(!file)return -1;
    int status=fwrite(bytes,1u,count,file)==count?0:-1;
    if(fclose(file))status=-1;
    return status;
}
int main(int argc,char **argv)
{
    if(argc!=1 && argc!=2)return 2;
    pl_u8 *code=mmap(0,4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(code==MAP_FAILED)return 3;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address};pl_u64 seed=0x982fa257bca1u;
    pl_u32 form=0u;int status=1;
    for(pl_u32 address32=0u;address32<2u;++address32)
    for(pl_u32 operand16=0u;operand16<2u;++operand16)
    for(pl_u32 rex=0u;rex<2u;++rex)
    for(pl_u32 kind=0u;kind<4u;++kind)
    for(pl_u32 back=0u;back<2u;++back,++form){
        memset(page,0x90,sizeof page);pl_u32 n=0u;
        if(address32)page[n++]=0x67u;
        if(operand16)page[n++]=0x66u;
        if(rex)page[n++]=0x48u;
        page[n++]=(pl_u8)(0xe0u+kind);page[n++]=(pl_u8)(back?0xc0u:0x40u);
        pl_x86_instruction decoded;pl_x86_count_branch law;
        if(pl_x86_decode_profile(&image,map.address,&decoded) || !pl_x86_count_branch_lower(&decoded,&law)
                || law.bits!=(address32?32u:64u) || law.decrement!=(kind<3u))goto done;
        wasm_cut_options options={map.address,8u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
                || report.source_instructions!=1u || report.source_bytes!=n || report.boundary!=WASM_CUT_CONTROL
                || report.read_registers!=2u || report.written_registers!=(kind<3u?2u:0u)
                || report.flags_written)goto done;
        if(mprotect(code,4096,PROT_READ|PROT_WRITE))goto done;
        memset(code,0x90,4096);memcpy(code+512,page,n);
        pl_u32 fall=512u+n,target=back?fall-64u:fall+64u;
        const pl_u8 first[]={0xb8,1,0,0,0,0xc3},last[]={0xb8,2,0,0,0,0xc3};
        memcpy(code+fall,first,sizeof first);memcpy(code+target,last,sizeof last);
        if(mprotect(code,4096,PROT_READ|PROT_EXEC))goto done;
        for(pl_u32 row=0u;row<128u;++row){
            machine_state *before=&records[row][0],*after=&records[row][1];memset(before,0,sizeof *before);
            for(pl_u32 r=0u;r<16u;++r)before->registers[r]=random_word(&seed);
            static const pl_u64 edge[]={0u,1u,2u,0xffffffffu,0x100000000ull,0x100000001ull,~0ull,0x8000000000000000ull};
            before->registers[1]=row<sizeof edge/sizeof edge[0]?edge[row]:random_word(&seed);
            before->rflags=0x202u|(random_word(&seed)&0xcd5u);before->rip=map.address;before->retired=41u;
            *after=*before;native_cut(after,code+512);
            pl_u64 selected=after->registers[0];if(selected!=1u && selected!=2u)goto done;
            /* Only the test marker and harness stack are projected away.
             * Native LOOP/J*CXZ RCX and all defined flags remain the oracle. */
            after->registers[0]=before->registers[0];after->registers[4]=before->registers[4];
            after->rip=selected==2u?decoded.target:decoded.fallthrough;after->retired=42u;
            pl_u64 next=kind<3u?before->registers[1]-1u:before->registers[1];
            if(address32)next&=0xffffffffu;
            int taken=kind==3u?!next:next && (kind==2u || ((before->rflags&0x40u)!=0u)==(kind==1u));
            if(after->rip!=(taken?decoded.target:decoded.fallthrough)
                    || after->registers[1]!=(kind<3u?next:before->registers[1])
                    || after->rflags!=before->rflags)goto done;
        }
        const char *directory=argc==2?argv[1]:0;
        if(save(directory,form,"source-page",page,sizeof page) || save(directory,form,"wasm",module,(size_t)bytes)
                || save(directory,form,"cases",records,sizeof records))goto done;
    }
    status=0;printf("Counter branches: 64 forms / 8192 native count/ZF/width/target/full-GPR/flag observations; target fault separate\n");
done:
    if(munmap(code,4096))status=1;
    if(status)fprintf(stderr,"counter branch red: form %u\n",form);
    return status;
}
