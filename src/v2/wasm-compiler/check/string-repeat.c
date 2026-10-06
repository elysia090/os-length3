#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <sys/mman.h>
#include <signal.h>
#include <setjmp.h>
#include <ucontext.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
extern void native_cut(machine_state *,const void *);
static pl_u8 page[4096],module[65536];
static sigjmp_buf recovery;
static volatile pl_u64 observed[21];
static const int greg[16]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
    REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
static void fault(int number,siginfo_t *info,void *pointer)
{
    __asm__ volatile("cld" ::: "cc");(void)number;const ucontext_t *context=pointer;
    for(pl_u32 r=0u;r<16u;++r)observed[r]=(pl_u64)context->uc_mcontext.gregs[greg[r]];
    observed[16]=(pl_u64)context->uc_mcontext.gregs[REG_EFL];observed[17]=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    observed[18]=(pl_u64)context->uc_mcontext.gregs[REG_ERR];observed[19]=(pl_u64)(uintptr_t)info->si_addr;
    observed[20]=(pl_u64)context->uc_mcontext.gregs[REG_RIP];siglongjmp(recovery,1);
}
static int execute(machine_state *cpu,const void *code)
{
    if(sigsetjmp(recovery,1))return 1;
    native_cut(cpu,code);return 0;
}
static pl_u64 random_word(pl_u64 *seed)
{*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static int save(const char *directory,pl_u32 form,const char *suffix,const void *bytes,size_t count)
{
    if(!directory)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/repeat-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx");if(!file)return -1;
    int status=fwrite(bytes,1u,count,file)==count?0:-1;if(fclose(file))status=-1;return status;
}
int main(int argc,char **argv)
{
    if(argc!=1 && argc!=2 && argc!=3)return 2;
    int observe=argc==3 && !strcmp(argv[2],"--observe");if(argc==3 && !observe)return 2;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *ram=mmap((void *)(uintptr_t)0x500000u,16384,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    if(code==MAP_FAILED || ram==MAP_FAILED)return 1;
    struct sigaction action={0},previous;action.sa_sigaction=fault;action.sa_flags=SA_SIGINFO;
    sigemptyset(&action.sa_mask);if(sigaction(SIGSEGV,&action,&previous))return 1;
    pl_u64 seed=0x72657065636d7073ull;pl_u32 form=0u,successes=0u,faults=0u;int status=1;
    for(pl_u32 kind=2u;kind<=4u;++kind)for(pl_u32 width=8u;width<=64u;width*=2u)
    for(pl_u32 address32=0u;address32<2u;++address32)for(pl_u32 ne=0u;ne<2u;++ne,++form){
        memset(page,0xcc,sizeof page);pl_u32 n=0u,bytes=width/8u;
        if(address32)page[n++]=0x67u;
        if(width==16u)page[n++]=0x66u;
        page[n++]=(pl_u8)(ne?0xf2u:0xf3u);
        if(width==64u)page[n++]=0x48u;
        page[n++]=(pl_u8)((kind==2u?0xacu:kind==3u?0xa6u:0xaeu)+(width!=8u));
        page[n]=0xc3u;memcpy(code,page,sizeof page);
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
        wasm_cut_options options={map.address,8u,sizeof module};wasm_cut_report report;pl_u64 emitted=0u;
        if(!observe){
            int result=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
            if(result || report.source_instructions!=1u || report.source_bytes!=n || report.memory_bytes!=bytes){
                pl_x86_instruction decoded;pl_x86_decode_profile(&image,map.address,&decoded);
                fprintf(stderr,"REP admission form=%u status=%d kind=%u machine=%u argument=%llx flags=%x\n",
                    form,result,decoded.condition,decoded.machine_operation,decoded.machine_argument,decoded.flags);goto done;
            }
        }
        FILE *file=0;char name[4096];pl_u32 rows=0u;
        if(argc>=2){int count=snprintf(name,sizeof name,"%s/repeat-%u.cases",argv[1],form);
            if(count<1 || (size_t)count>=sizeof name || !(file=fopen(name,"wbx")))goto done;}
        for(pl_u32 direction=0u;direction<2u;++direction)
        for(pl_u32 scenario=0u;scenario<7u;++scenario)for(pl_u32 sample=0u;sample<8u;++sample){
            if(kind==2u && (scenario==1u || scenario==2u))continue;
            if(scenario==6u && bytes==1u)continue;
            machine_state cpu={0};pl_u64 record[38];
            for(pl_u32 r=0u;r<16u;++r)cpu.registers[r]=random_word(&seed);
            static const pl_u64 counts[]={0u,1u,2u,7u,255u,256u,257u,513u};cpu.registers[1]=counts[sample];
            pl_u64 src=0x502000u+(direction?4096u-bytes:0u),dst=0x500000u+(direction?4096u-bytes:0u);
            pl_u32 preceding=scenario==3u?0u:scenario==4u?2u:300u;
            if(scenario>=3u){
                pl_u64 crossing=direction?0x501fffu+(pl_u64)preceding*bytes:0x501000u-(pl_u64)preceding*bytes;
                if(scenario==6u)crossing=direction?0x502000u-(bytes-1u):0x501000u-(bytes-1u);
                if(kind==2u)src=crossing;else dst=crossing;
            }
            cpu.registers[6]=kind==4u?0x800000000000ull:src;
            cpu.registers[7]=kind==2u?0x800000000000ull:dst;
            if(address32){cpu.registers[1]|=0x1234567800000000ull;
                cpu.registers[6]|=0x7654321000000000ull;cpu.registers[7]|=0xabcdef0100000000ull;}
            cpu.rflags=0x202u|(direction?0x400u:0u)|(random_word(&seed)&0x8d5u);
            for(pl_u32 byte=0u;byte<16384u;++byte)ram[byte]=(pl_u8)(byte*37u+form*11u+sample);
            pl_u64 accumulator=cpu.registers[0];
            if(kind>=3u){
                for(pl_u32 element=0u;element<513u;++element){
                    pl_u64 from=direction?src-(pl_u64)element*bytes:src+(pl_u64)element*bytes;
                    pl_u64 to=direction?dst-(pl_u64)element*bytes:dst+(pl_u64)element*bytes;
                    if(to<0x500000u || to+bytes>0x504000u)continue;
                    pl_u8 value[8];for(pl_u32 b=0u;b<bytes;++b)value[b]=(pl_u8)(kind==4u?accumulator>>(b*8u):ram[from-0x500000u+b]);
                    int unequal=ne!=0u;
                    if((scenario==1u && !element) || (scenario==2u && element==256u))unequal=!ne;
                    if(unequal)value[0]=(pl_u8)(value[0]^1u);
                    memcpy(ram+to-0x500000u,value,bytes);
                }
            }
            for(pl_u32 r=0u;r<16u;++r)record[r]=cpu.registers[r];
            record[16]=cpu.rflags;
            if(scenario>=3u && mprotect(ram+4096,4096,PROT_NONE)){if(file)fclose(file);goto done;}
            int trapped=execute(&cpu,code);
            record[4]=cpu.registers[4];
            if(scenario>=3u && mprotect(ram+4096,4096,PROT_READ|PROT_WRITE)){if(file)fclose(file);goto done;}
            for(pl_u32 r=0u;r<16u;++r)record[17u+r]=trapped?observed[r]:cpu.registers[r];
            record[33]=trapped?observed[16]:cpu.rflags;record[34]=trapped?observed[17]:0u;
            record[35]=trapped?observed[18]:0u;record[36]=trapped?observed[19]:0u;
            record[37]=((pl_u64)scenario<<16u)|((pl_u64)direction<<8u)|sample;
            if(trapped){
                if(observed[20]!=0x400000u || observed[17]!=14u || (record[33]&~0x10000ull)!=record[16]){
                    if(file)fclose(file);
                    fprintf(stderr,"repeat fault form=%u scenario=%u sample=%u flags=%llx/%llx\n",
                        form,scenario,sample,record[33],record[16]);goto done;
                }
                ++faults;
            }else ++successes;
            if(file && (fwrite(record,sizeof record,1u,file)!=1u || fwrite(ram,16384u,1u,file)!=1u)){
                fclose(file);goto done;
            }
            ++rows;
        }
        if(file && fclose(file))goto done;
        char json[256];int count=snprintf(json,sizeof json,
            "{\"kind\":%u,\"width\":%u,\"address\":%u,\"ne\":%u,\"rows\":%u,\"sourceBytes\":%u}\n",
            kind,width,address32?32u:64u,ne,rows,n);
        const char *directory=argc>=2?argv[1]:0;
        if(count<1 || (size_t)count>=sizeof json || save(directory,form,"json",json,(size_t)count)
                || save(directory,form,"source-page",page,sizeof page)
                || (!observe && save(directory,form,"wasm",module,(size_t)emitted)))goto done;
    }
    status=0;printf("REP loads/compares: %u native success / %u fault, %u forms; entry flags and partial GPR/RAM%s\n",
        successes,faults,form,observe?"; lowering not tested":"");
done:
    if(sigaction(SIGSEGV,&previous,0) || munmap(code,4096) || munmap(ram,16384))status=1;
    return status;
}
