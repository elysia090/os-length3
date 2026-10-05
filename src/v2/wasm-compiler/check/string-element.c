#define _GNU_SOURCE
/* One actual x86 string element, without REP. Native success/fault receipts
 * include all GPRs, flags and every payload byte; no guest semantics callback. */
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <signal.h>
#include <setjmp.h>
#include <ucontext.h>
extern void native_cut(machine_state *,const void *);
static pl_u8 page[4096],module[65536],before[16384];
static sigjmp_buf recovery;
static volatile pl_u64 observed[21];
static const int greg[16]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
    REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
static void fault(int signal,siginfo_t *info,void *pointer)
{
    __asm__ volatile("cld" ::: "cc");(void)signal;
    const ucontext_t *context=pointer;
    for(pl_u32 reg=0u;reg<16u;++reg)observed[reg]=(pl_u64)context->uc_mcontext.gregs[greg[reg]];
    observed[16]=(pl_u64)context->uc_mcontext.gregs[REG_EFL];
    observed[17]=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    observed[18]=(pl_u64)context->uc_mcontext.gregs[REG_ERR];
    observed[19]=(pl_u64)(uintptr_t)info->si_addr;
    observed[20]=(pl_u64)context->uc_mcontext.gregs[REG_RIP];
    siglongjmp(recovery,1);
}
static int execute(machine_state *state,void *code)
{
    if(sigsetjmp(recovery,1))return 1;
    native_cut(state,code);return 0;
}
static pl_u64 random_word(pl_u64 *seed)
{*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static int save(const char *directory,unsigned form,const char *suffix,const void *bytes,size_t size)
{
    if(!directory)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/string-%u.%s",directory,form,suffix);
    if(n<1||(size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx");if(!file)return -1;
    int status=fwrite(bytes,1u,size,file)==size?0:-1;if(fclose(file))status=-1;return status;
}
int main(int argc,char **argv)
{
    if(argc!=1&&argc!=2)return 2;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *ram=mmap((void *)(uintptr_t)0x500000u,16384u,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    int result=1;if(code==MAP_FAILED||ram==MAP_FAILED)goto finish;
    struct sigaction action={0},previous;action.sa_sigaction=fault;action.sa_flags=SA_SIGINFO;
    if(sigemptyset(&action.sa_mask)||sigaction(SIGSEGV,&action,&previous))goto finish;
    pl_u64 seed=0x519e1e00cafebabeull;unsigned successes=0u,faults=0u;
    for(unsigned form=0u;form<16u;++form){
        pl_u32 store=form/8u,address=(form/4u%2u)?64u:32u,width=8u<<(form%4u),size=width/8u;
        pl_u32 length=0u;memset(page,0xcc,sizeof page);
        if(address==32u)page[length++]=0x67u;
        if(width==16u)page[length++]=0x66u;
        if(width==64u)page[length++]=0x48u;
        page[length++]=(pl_u8)((store?0xaau:0xa4u)+(width!=8u));page[length]=0xc3u;
        memcpy(code,page,sizeof page);
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u};wasm_cut_options options={0x400000u,8u,sizeof module};
        wasm_cut_report report;pl_u64 bytes=0u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
        if(status ||report.source_instructions!=1u||report.source_bytes!=length||report.memory_bytes!=size
                ||report.read_registers!=(store?0x81u:0xc0u)||report.written_registers!=(store?0x80u:0xc0u)
                ||report.memory_access!=(store?2u:3u)||report.flags_written||report.operand_binding){
            fprintf(stderr,"string element form %u rejected or wrong frontier (%d)\n",form,status);goto restore;
        }
        char filename[4096];FILE *file=NULL;
        if(argc==2){int n=snprintf(filename,sizeof filename,"%s/string-%u.cases",argv[1],form);
            if(n<1||(size_t)n>=sizeof filename||(file=fopen(filename,"wbx"))==NULL)goto restore;}
        unsigned rows=0u;
        for(unsigned mode=0u;mode<8u;++mode)for(unsigned row=0u;row<16u;++row){
            if((store&&(mode==1u||mode==3u||mode==5u||mode==6u))
                ||(size==1u&&(mode==3u||mode==4u))||(address==32u&&mode>=6u))continue;
            machine_state state={0};pl_u64 record[38];
            for(pl_u32 reg=0u;reg<16u;++reg)state.registers[reg]=random_word(&seed);
            state.registers[1]=row%3u==0u?0u:row%3u==1u?1u:0xfeedfaceffffffffull;
            pl_u64 src=0x500200u+(row%2u?size:0u),dst=row%4u==0u?src:row%4u==1u?src+1u:0x502200u;
            if(mode==1u||mode==5u)src=0x501000u;
            if(mode==2u||mode==5u)dst=0x501000u;
            if(mode==3u)src=0x501000u-(size-1u);
            if(mode==4u)dst=0x501000u-(size-1u);
            if(mode==6u)src=0x800000000000ull;
            if(mode==7u)dst=0x800000000000ull;
            state.registers[6]=store?0x800000000000ull:src;state.registers[7]=dst;
            if(address==32u){state.registers[6]|=0x7654321000000000ull;state.registers[7]|=0xabcdef0100000000ull;}
            state.rflags=0x202u|(random_word(&seed)&0xcd5u);
            for(pl_u32 i=0u;i<16384u;++i)ram[i]=(pl_u8)(i*37u+row*19u+form);
            memcpy(before,ram,sizeof before);
            for(pl_u32 reg=0u;reg<16u;++reg)record[reg]=state.registers[reg];
            record[16]=state.rflags;
            if(mode&&mode<6u&&mprotect(ram+4096u,4096u,PROT_NONE)){if(file)fclose(file);goto restore;}
            int trapped=execute(&state,code);
            /* The native trampoline replaces RSP with its genuine host stack;
             * it is unchanged by the string instruction, including on fault. */
            record[4]=state.registers[4];
            if(mode&&mode<6u&&mprotect(ram+4096u,4096u,PROT_READ|PROT_WRITE)){if(file)fclose(file);goto restore;}
            for(pl_u32 reg=0u;reg<16u;++reg)record[17u+reg]=trapped?observed[reg]:state.registers[reg];
            record[33]=trapped?observed[16]:state.rflags;record[34]=trapped?observed[17]:0u;
            record[35]=trapped?observed[18]:0u;record[36]=trapped?observed[19]:0u;record[37]=mode;
            if((mode!=0u)!=!!trapped){if(file)fclose(file);goto restore;}
            if(trapped){
                if(observed[20]!=0x400000u){if(file)fclose(file);goto restore;}
                for(pl_u32 reg=0u;reg<16u;++reg)if(record[17u+reg]!=record[reg]){if(file)fclose(file);goto restore;}
                if((record[33]&~0x10000ull)!=record[16]||memcmp(ram,before,sizeof before)){
                    if(file)fclose(file);
                    goto restore;
                }
                ++faults;
            }else ++successes;
            if(file&&(fwrite(record,sizeof record,1u,file)!=1u||fwrite(ram,16384u,1u,file)!=1u)){
                fclose(file);goto restore;}
            ++rows;
        }
        if(file&&fclose(file))goto restore;
        char json[256];int n=snprintf(json,sizeof json,
            "{\"entry\":4194304,\"sourceBytes\":%u,\"operandBinding\":0,\"rows\":%u,\"words\":38,\"store\":%u,\"width\":%u,\"address\":%u}\n",
            length,rows,store,width,address);
        if(n<1||(size_t)n>=sizeof json||save(argc==2?argv[1]:NULL,form,"json",json,(size_t)n)
                ||save(argc==2?argv[1]:NULL,form,"wasm",module,(size_t)bytes)
                ||save(argc==2?argv[1]:NULL,form,"source-page",page,sizeof page))goto restore;
    }
    /* In long mode, DS/SS override bytes do not turn the implicit RSI
     * source into a stack reference. Observe that separately, rather than
     * inferring the vector from the spelling of a legacy prefix. */
    pl_u64 segment_records[4][38];
    for(unsigned form=0u;form<4u;++form){
        pl_u32 length=0u;memset(page,0xcc,sizeof page);page[length++]=form&1u?0x3eu:0x36u;
        if(form&2u)page[length++]=0xf3u;
        page[length++]=0xa4u;page[length]=0xc3u;memcpy(code,page,sizeof page);
        machine_state state={0};state.registers[1]=1u;state.registers[6]=0x800000000000ull;
        state.registers[7]=0x502200u;state.rflags=0x202u;
        if(!execute(&state,code)||observed[20]!=0x400000u||observed[17]!=13u||observed[18])goto restore;
        for(pl_u32 reg=0u;reg<16u;++reg){
            if(observed[reg]!=state.registers[reg])goto restore;
            segment_records[form][reg]=state.registers[reg];segment_records[form][17u+reg]=observed[reg];
        }
        if((observed[16]&~0x10000ull)!=state.rflags)goto restore;
        segment_records[form][16]=state.rflags;segment_records[form][33]=observed[16];
        segment_records[form][34]=observed[17];segment_records[form][35]=observed[18];
        segment_records[form][36]=observed[19];segment_records[form][37]=form;
    }
    if(save(argc==2?argv[1]:NULL,16u,"cases",segment_records,sizeof segment_records))goto restore;
    printf("String element: %u native success and %u unchanged CPU/RAM fault receipts, 16 C emissions, 4 ignored-prefix #GP observations\n",successes,faults);result=0;
restore:
    if(sigaction(SIGSEGV,&previous,NULL))result=1;
finish:
    if(code!=MAP_FAILED&&munmap(code,4096u))result=1;
    if(ram!=MAP_FAILED&&munmap(ram,16384u))result=1;
    return result;
}
