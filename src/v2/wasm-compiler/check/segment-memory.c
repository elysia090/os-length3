#define _GNU_SOURCE
/* Actual FS/GS x86 observations: base addition follows address truncation.
 * Fault rows include all GPRs/flags and unchanged complete payload, not an
 * implementation of the guest instruction in the test harness. */
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <asm/prctl.h>
#include <unistd.h>
#include <signal.h>
#include <setjmp.h>
#include <ucontext.h>
extern int native_segment_cut(machine_state *,const void *,unsigned,pl_u64);
extern void native_segment_signal(int,siginfo_t *,void *);
pl_u64 native_host_fs,native_host_gs;
static sigjmp_buf recovery;
static volatile pl_u64 observed[21];
static pl_u8 page[4096],module[65536],before[8192];
static const int greg[16]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
    REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
void native_segment_fault(int signal,siginfo_t *info,void *pointer)
{
    __asm__ volatile("cld" ::: "cc");(void)signal;
    const ucontext_t *context=pointer;
    for(pl_u32 reg=0u;reg<16u;++reg)observed[reg]=(pl_u64)context->uc_mcontext.gregs[greg[reg]];
    observed[16]=(pl_u64)context->uc_mcontext.gregs[REG_EFL];
    observed[17]=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    observed[18]=(pl_u64)context->uc_mcontext.gregs[REG_ERR];
    observed[19]=(pl_u64)(uintptr_t)info->si_addr;
    observed[20]=(pl_u64)context->uc_mcontext.gregs[REG_RIP];siglongjmp(recovery,1);
}
static int execute(machine_state *state,void *code,unsigned segment,pl_u64 base)
{
    if(sigsetjmp(recovery,1))return 1;
    return native_segment_cut(state,code,segment,base) ? -1 : 0;
}
static pl_u64 random_word(pl_u64 *seed)
{*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static int save(const char *directory,unsigned form,const char *suffix,const void *bytes,size_t size)
{
    if(!directory)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/segment-%u.%s",directory,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx");if(!file)return -1;
    int result=fwrite(bytes,1u,size,file)==size?0:-1;if(fclose(file))result=-1;return result;
}
int main(int argc,char **argv)
{
    if(argc!=1&&argc!=2)return 2;
    if(syscall(SYS_arch_prctl,ARCH_GET_FS,&native_host_fs)
            ||syscall(SYS_arch_prctl,ARCH_GET_GS,&native_host_gs))return 1;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *ram=mmap((void *)(uintptr_t)0x500000u,8192u,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *high=mmap((void *)(uintptr_t)0x100500000ull,8192u,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    int result=1;if(code==MAP_FAILED||ram==MAP_FAILED||high==MAP_FAILED)goto finish;
    struct sigaction action={0},previous;action.sa_sigaction=native_segment_signal;action.sa_flags=SA_SIGINFO;
    if(sigemptyset(&action.sa_mask)||sigaction(SIGSEGV,&action,&previous))goto finish;
    pl_u64 seed=0x5e6ba5e0cafebabeull;unsigned successes=0u,faults=0u;
    for(unsigned form=0u;form<24u;++form){
        unsigned segment=form/12u,address=form/6u%2u?64u:32u,kind=form%6u,length=0u;
        memset(page,0xcc,sizeof page);page[length++]=(pl_u8)(segment?0x65u:0x64u);
        if(address==32u)page[length++]=0x67u;
        if(kind==4u)page[length++]=0xa4u;
        else {
            page[length++]=0x48u;page[length++]=(pl_u8)(kind==0u||kind==5u?0x8bu:kind==1u?0x89u:kind==2u?0x01u:0x8du);
            if(kind==5u){page[length++]=4u;page[length++]=0x25u;memset(page+length,0,4u);length+=4u;}
            else page[length++]=0x06u; /* [RSI]/[ESI], source/destination RAX */
        }
        page[length]=0xc3u;memcpy(code,page,sizeof page);
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u};wasm_cut_options options={0x400000u,1u,sizeof module};
        wasm_cut_report report;pl_u64 bytes=0u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
        if(status||report.source_instructions!=1u||report.source_bytes!=length){
            fprintf(stderr,"FS/GS form %u rejected or wrong frontier (%d)\n",form,status);goto restore;}
        char filename[4096];FILE *file=NULL;
        if(argc==2){int n=snprintf(filename,sizeof filename,"%s/segment-%u.cases",argv[1],form);
            if(n<1||(size_t)n>=sizeof filename||(file=fopen(filename,"wbx"))==NULL)goto restore;}
        unsigned rows=0u;
        for(unsigned mode=0u;mode<7u;++mode)for(unsigned row=0u;row<8u;++row){
            if(kind==3u&&mode>=3u)continue;
            if(kind==5u&&(mode==2u||mode==4u||mode==5u||mode==6u))continue;
            if(address==32u&&mode==5u)continue;
            machine_state state={0};pl_u64 record[41];
            for(pl_u32 reg=0u;reg<16u;++reg)state.registers[reg]=random_word(&seed);
            pl_u64 linear=(mode==1u?0x100500000ull:0x500000u),offset=0x200u;
            pl_u64 base=linear;pl_u8 *payload=mode==1u?high:ram;
            if(kind==4u&&mode==1u&&address==32u)payload=ram;
            if(mode==2u){base=0u;offset=linear+0x200u;}
            if(mode==3u)offset=0x1000u;
            if(mode==4u)offset=0xffdu;
            if(mode==5u){base=0x600000u;offset=0xfffffffffff00200ull;}
            if(mode==6u){base=0x7fffffff0000ull;offset=0x10000u;}
            if(kind==5u)base+=offset;
            state.registers[6]=offset|(address==32u?0x7654321000000000ull:0u);
            state.registers[7]=linear+0x600u;state.registers[1]=0u;
            state.rflags=0x202u|(random_word(&seed)&0xcd5u);
            for(pl_u32 i=0u;i<8192u;++i)payload[i]=(pl_u8)(i*37u+row*19u+form);
            if(kind==4u&&mode==1u&&address==32u)memcpy(high,payload,8192u);
            memcpy(before,payload,sizeof before);
            for(pl_u32 reg=0u;reg<16u;++reg)record[reg]=state.registers[reg];
            record[16]=state.rflags;
            if(mode>=3u&&mode<=4u&&kind!=3u&&mprotect(payload+4096u,4096u,PROT_NONE)){
                if(file)fclose(file);
                goto restore;}
            int trapped=execute(&state,code,segment,base);record[4]=state.registers[4];
            if(mode>=3u&&mode<=4u&&kind!=3u&&mprotect(payload+4096u,4096u,PROT_READ|PROT_WRITE)){
                if(file)fclose(file);
                goto restore;}
            int wanted=(mode==3u||mode==4u)&&kind!=3u;
            if(mode==6u)wanted=1;
            if(kind==4u&&mode==4u)wanted=0; /* Byte at the end of the first page. */
            if(trapped<0||!!trapped!=wanted){fprintf(stderr,"form %u mode %u row %u trap %d\n",form,mode,row,trapped);
                if(file)fclose(file);
                goto restore;}
            for(pl_u32 reg=0u;reg<16u;++reg)record[17u+reg]=trapped?observed[reg]:state.registers[reg];
            record[33]=trapped?observed[16]:state.rflags;record[34]=trapped?observed[17]:0u;
            record[35]=trapped?observed[18]:0u;record[36]=trapped?observed[19]:0u;
            record[37]=mode;record[38]=base;record[39]=linear;record[40]=(pl_u64)!!trapped;
            if(trapped){
                if(observed[20]!=0x400000u||observed[17]!=(mode==6u?13u:14u)||memcmp(payload,before,sizeof before)){
                    if(file)fclose(file);
                    goto restore;}
                for(pl_u32 reg=0u;reg<16u;++reg)if(record[reg]!=record[17u+reg]){if(file)fclose(file);goto restore;}
                ++faults;
            }else ++successes;
            if(file&&(fwrite(record,sizeof record,1u,file)!=1u||fwrite(payload,sizeof before,1u,file)!=1u)){
                fclose(file);goto restore;}
            ++rows;
        }
        if(file&&fclose(file))goto restore;
        char json[256];int n=snprintf(json,sizeof json,
            "{\"sourceBytes\":%u,\"operandBinding\":%u,\"rows\":%u,\"words\":41,\"segment\":%u,\"kind\":%u,\"address\":%u}\n",
            length,report.operand_binding,rows,segment,kind,address);
        if(n<1||(size_t)n>=sizeof json||save(argc==2?argv[1]:NULL,form,"json",json,(size_t)n)
                ||save(argc==2?argv[1]:NULL,form,"wasm",module,(size_t)bytes)
                ||save(argc==2?argv[1]:NULL,form,"source-page",page,sizeof page))goto restore;
    }
    printf("FS/GS memory: %u native success / %u full-state fault observations, 24 C emissions\n",successes,faults);result=0;
restore:
    if(sigaction(SIGSEGV,&previous,NULL))result=1;
finish:
    if(code!=MAP_FAILED&&munmap(code,4096u))result=1;
    if(ram!=MAP_FAILED&&munmap(ram,8192u))result=1;
    if(high!=MAP_FAILED&&munmap(high,8192u))result=1;
    return result;
}
