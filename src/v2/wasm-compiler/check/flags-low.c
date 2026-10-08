#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <sys/mman.h>
#include <stdio.h>
#include <string.h>
extern void native_cut(machine_state *,const void *);
static pl_u8 page[4096],module[65536];
static machine_state records[256][2];
static pl_u64 random_word(pl_u64 *seed)
{*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static int save(const char *dir,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    if(!dir)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/flags-low-%u.%s",dir,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return 1;
    FILE *file=fopen(path,"wbx");if(!file)return 1;
    int bad=fwrite(data,1u,bytes,file)!=bytes;if(fclose(file))bad=1;return bad;
}
static void model(machine_state *cpu,pl_u8 opcode)
{
    if(opcode==0x9fu)cpu->registers[0]=(cpu->registers[0]&~0xff00ull)|(((cpu->rflags&0xd5u)|2u)<<8u);
    else if(opcode==0x9eu)cpu->rflags=(cpu->rflags&~0xd5ull)|((cpu->registers[0]>>8u)&0xd5u);
    else if(opcode==0xf5u)cpu->rflags^=1u;
    else if(opcode==0xf8u)cpu->rflags&=~1ull;
    else if(opcode==0xf9u)cpu->rflags|=1u;
    else if(opcode==0xfcu)cpu->rflags&=~0x400ull;
    else cpu->rflags|=0x400u;
}
int main(int argc,char **argv)
{
    if(argc>2)return 2;
    pl_u8 *code=mmap(0,4096,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(code==MAP_FAILED)return 1;
    const pl_u8 opcodes[]={0x9fu,0x9eu,0xf5u,0xf8u,0xf9u,0xfcu,0xfdu};
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0xf2u,0xf3u,0x64u,0x65u};
    pl_u32 form=0u;pl_u64 seed=0x666c6167736c6f77ull;int result=1;
    for(pl_u32 op=0u;op<7u;++op)for(pl_u32 prefix=0u;prefix<8u;++prefix)for(pl_u32 variant=0u;variant<3u;++variant,++form){
        memset(page,0x90,sizeof page);pl_u32 n=0u,instructions=1u;
        if(variant==1u){page[n++]=0x04u;page[n++]=0x7fu;++instructions;}
        if(prefixes[prefix])page[n++]=prefixes[prefix];
        page[n++]=opcodes[op];
        if(variant==2u){page[n++]=0x9fu;page[n++]=0xf5u;page[n++]=0x9eu;instructions+=3u;}
        memcpy(code,page,sizeof page);code[n]=0xc3u;
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        wasm_cut_options options={map.address,instructions,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
            ||report.source_bytes!=n||report.source_instructions!=instructions||report.memory_bytes)goto done;
        for(pl_u32 row=0u;row<256u;++row){machine_state *before=records[row],*after=before+1u;memset(before,0,sizeof *before);
            for(pl_u32 reg=0u;reg<16u;++reg)before->registers[reg]=random_word(&seed);
            before->registers[0]=(before->registers[0]&~0xff00ull)|((pl_u64)row<<8u);
            before->rflags=0x202u|(random_word(&seed)&0xcd5u);before->rip=map.address;before->retired=42u;
            before->cr0=0x80010011u;before->cr3=0x1000u;before->cr4=32u;before->efer=0xd00u;
            before->system[MACHINE_SYSTEM_CS]=19u;before->system[MACHINE_SYSTEM_DR0+7u]=0x400u;
            *after=*before;native_cut(after,code);before->registers[4]=after->registers[4];machine_state expected=*before;
            if(variant==1u){pl_u64 a=expected.registers[0]&255u,r=(a+127u)&255u;
                expected.registers[0]=(expected.registers[0]&~255ull)|r;
                pl_u64 parity=r;parity^=parity>>4u;parity^=parity>>2u;parity^=parity>>1u;
                expected.rflags=(expected.rflags&~0x8d5ull)|(a+127u>255u)|((~parity&1u)<<2u)
                    |((a^127u^r)&16u)|((pl_u64)(!r)<<6u)|(r&128u)|((~(a^127u)&(a^r)&128u)<<4u);}
            model(&expected,opcodes[op]);if(variant==2u){model(&expected,0x9fu);model(&expected,0xf5u);model(&expected,0x9eu);}
            if(memcmp(expected.registers,after->registers,sizeof expected.registers)||expected.rflags!=after->rflags){
                fprintf(stderr,"native low-flags differs %u/%u\n",form,row);goto done;}
            after->rip=map.address+n;after->retired+=instructions;
        }
        char json[256];int count=snprintf(json,sizeof json,"{\"stateBytes\":%u,\"native\":256,\"sourceBytes\":%u,\"instructions\":%u}\n",(unsigned)sizeof(machine_state),n,instructions);
        if(count<1||(size_t)count>=sizeof json||save(argc==2?argv[1]:0,form,"json",json,(size_t)count)
            ||save(argc==2?argv[1]:0,form,"cases",records,sizeof records)||save(argc==2?argv[1]:0,form,"source-page",page,sizeof page)
            ||save(argc==2?argv[1]:0,form,"wasm",module,(size_t)bytes))goto done;
    }
    printf("Low flags: %u forms / %u complete native observations\n",form,form*256u);result=0;
done:if(munmap(code,4096))result=1;return result;
}
