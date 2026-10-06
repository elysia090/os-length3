#define _GNU_SOURCE
/* Native MOV-to-segment observations. The source word is read before selector
 * validation; neither a failed read nor a bad selector publishes the target.
 * The assembly envelope restores the host TLS base before any C/libc call. */
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <x86/semantics.h>
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
#include "native-selectors.h"
extern int native_segment_cut(machine_state *,const void *,unsigned,pl_u64);
extern void native_segment_signal(int,siginfo_t *,void *);
pl_u64 native_host_fs,native_host_gs;
static sigjmp_buf recovery;
static volatile pl_u64 observed[21];
static const int greg[16]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
    REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
static pl_u8 page[4096],module[65536];
static _Alignas(8) pl_u8 scratch[65536];
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
static int execute(machine_state *state,void *code)
{
    if(sigsetjmp(recovery,1))return 1;
    return native_segment_cut(state,code,0u,native_host_fs)?-1:0;
}
static int save(const char *directory,pl_u32 id,const char *suffix,const void *bytes,size_t size)
{
    if(!directory)return 0;
    char name[4096];int n=snprintf(name,sizeof name,"%s/load-%u.%s",directory,id,suffix);
    if(n<1 || (size_t)n>=sizeof name)return 1;
    FILE *file=fopen(name,"wbx");if(!file)return 1;
    int error=fwrite(bytes,1u,size,file)!=size;if(fclose(file))error=1;return error;
}
int main(int argc,char **argv)
{
    if(argc>2)return 2;
    pl_u64 host[6];native_selectors(host);
    if(host[4] || host[5] || syscall(SYS_arch_prctl,ARCH_GET_FS,&native_host_fs)
            || syscall(SYS_arch_prctl,ARCH_GET_GS,&native_host_gs) || native_host_gs){
        fputs("native selector envelope requires null host FS/GS and GS base\n",stderr);return 1;
    }
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *ram=mmap((void *)(uintptr_t)0x500000u,8192u,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    if(code==MAP_FAILED || ram==MAP_FAILED)return 1;
    struct sigaction action={0},previous,previous_bus;action.sa_sigaction=native_segment_signal;action.sa_flags=SA_SIGINFO;
    if(sigemptyset(&action.sa_mask)||sigaction(SIGSEGV,&action,&previous)
            ||sigaction(SIGBUS,&action,&previous_bus))return 1;
    pl_u32 id=0u,successes=0u,faults=0u;int result=1;
    for(pl_u32 rank=0u;rank<6u;++rank){
        if(rank==1u)continue;
        for(pl_u32 address=32u;address<=64u;address+=32u)for(pl_u32 prefix=0u;prefix<3u;++prefix)
        for(pl_u32 form=0u;form<5u;++form)for(pl_u32 mode=0u;mode<6u;++mode){
            if(form==3u && mode>=3u)continue; /* Fixed RIP-relative source; separate MMU fault models cover rebinding. */
            if(address==32u && mode==5u)continue; /* Address truncation makes this canonical. */
            memset(page,0xcc,sizeof page);pl_u32 n=0u;
            if(address==32u)page[n++]=0x67u;
            if(prefix==1u)page[n++]=0x66u;
            if(prefix==2u || form==4u)page[n++]=(pl_u8)(0x40u|(prefix==2u?8u:0u)|(form==4u?1u:0u));
            page[n++]=0x8eu;
            page[n++]=(pl_u8)((rank<<3u)|(form==0u?7u:form==1u?0x45u:form==2u?0x44u:form==3u?5u:4u));
            if(form==1u)page[n++]=0u;
            if(form==2u){page[n++]=0x8fu;page[n++]=7u;}
            if(form==3u){pl_u32 displacement=512u-(n+4u);for(pl_u32 b=0u;b<4u;++b)page[n++]=(pl_u8)(displacement>>(b*8u));}
            if(form==4u)page[n++]=0x24u;
            page[n]=0xc3u;
            /* Even an invalid target selector cannot outrank a source #PF/#SS/#GP. */
            pl_u64 selector=mode>=2u?0xfffbu:rank==2u?host[2]:mode==1u && rank<4u?host[2]:0u;
            pl_u64 linear=form==3u?0x400200u:mode==3u?0x501000u:mode==4u?0x500fffu:mode==5u?0x800000000000ull:0x500200u;
            memset(ram,0xa5,8192u);page[512]=(pl_u8)selector;page[513]=(pl_u8)(selector>>8u);memcpy(code,page,sizeof page);
            if(form!=3u && mode!=5u){pl_u32 at=(pl_u32)(linear-0x500000u);ram[at]=(pl_u8)selector;ram[at+1u]=(pl_u8)(selector>>8u);}
            pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
            wasm_cut_options options={map.address,1u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
            int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
            if(status || report.source_instructions!=1u || report.source_bytes!=n || report.memory_bytes!=2u
                    || report.flags_written || report.written_registers){
                fprintf(stderr,"segment load red rank=%u address=%u prefix=%u form=%u status=%d\n",rank,address,prefix,form,status);goto done;
            }
            pl_x86_instruction instruction;
            pl_arena arena={scratch,sizeof scratch,0u};pl_x86_semantic semantic;
            if(pl_x86_decode_profile(&image,map.address,&instruction)
                    || !pl_x86_segment_move_supported(&instruction)
                    || pl_x86_lower(&instruction,&arena,&semantic)
                    || semantic.machine_operation!=PL_X86_MACHINE_WRITE_SEGMENT
                    || semantic.machine_argument!=instruction.machine_argument)goto done;
            for(pl_u32 mutation=0u;mutation<13u;++mutation){
                pl_x86_instruction invalid=instruction;
                switch(mutation){
                case 0u: invalid.machine_argument^=1u;break;
                case 1u: invalid.operands[0].value.reg.index=1u;break;
                case 2u: invalid.operands[1].bits=32u;break;
                case 3u: invalid.address_width=16u;break;
                case 4u: invalid.operands[1].value.memory.scale=3u;break;
                case 5u: invalid.flags&=~(pl_u32)PL_X86_INSTRUCTION_READS_MEMORY;break;
                case 6u: invalid.flags|=PL_X86_INSTRUCTION_WRITES_MEMORY;break;
                case 7u: invalid.flags|=PL_X86_INSTRUCTION_PRIVILEGED;break;
                case 8u: invalid.operands[1].kind=PL_X86_OPERAND_IMMEDIATE;break;
                case 9u: invalid.visible_operand_count=1u;break;
                case 10u: invalid.flags&=~(pl_u32)PL_X86_INSTRUCTION_PRECISE_CUT;break;
                case 11u: invalid.flags&=~(pl_u32)PL_X86_INSTRUCTION_BARRIER;break;
                default: invalid.operands[1].value.memory.index.class_id=PL_X86_REGISTER_SEGMENT;break;
                }
                pl_arena_reset(&arena);
                if(pl_x86_segment_move_supported(&invalid)
                        || pl_x86_lower(&invalid,&arena,&semantic)!=PL_ERROR_X86_SEMANTIC || arena.used)goto done;
            }
            machine_state state={0};pl_u64 record[42];
            for(pl_u32 r=0u;r<16u;++r)state.registers[r]=0x1234567890000000ull+(pl_u64)r*1777u+mode;
            pl_u64 pointer=linear;if(address==32u)pointer|=0x7654321000000000ull;
            if(form==0u)state.registers[7]=pointer;
            if(form==1u)state.registers[5]=pointer;
            if(form==2u){state.registers[7]=pointer-19u;state.registers[1]=3u;}
            if(form==4u)state.registers[12]=pointer;
            state.rflags=0x202u|((id*17u)&0x8d5u);
            for(pl_u32 r=0u;r<16u;++r)record[r]=state.registers[r];
            record[16]=state.rflags;
            if((mode==3u || mode==4u) && mprotect(ram+4096u,4096u,PROT_NONE))goto done;
            int trapped=execute(&state,code);record[4]=state.registers[4];
            if((mode==3u || mode==4u) && mprotect(ram+4096u,4096u,PROT_READ|PROT_WRITE))goto done;
            if(trapped<0 || !!trapped!=(mode>=2u)){
                fprintf(stderr,"native segment rank=%u form=%u mode=%u trap=%d\n",rank,form,mode,trapped);goto done;
            }
            for(pl_u32 r=0u;r<16u;++r)record[17u+r]=trapped?observed[r]:state.registers[r];
            record[33]=trapped?observed[16]:state.rflags;record[34]=trapped?observed[17]:0u;
            record[35]=trapped?observed[18]:0u;record[36]=trapped?observed[19]:0u;
            record[37]=linear;record[38]=selector;record[39]=mode;record[40]=host[rank];
            pl_u64 after[6];native_selectors(after);record[41]=after[rank];
            for(pl_u32 r=0u;r<16u;++r)if(record[r]!=record[17u+r])goto done;
            if((record[33]&~0x10000ull)!=record[16])goto done;
            if(trapped){
                pl_u32 vector=mode==2u?13u:mode==5u?(form==1u?12u:13u):14u;
                if(observed[20]!=0x400000u || observed[17]!=vector
                        || observed[18]!=(mode==2u?0xfff8u:mode==3u||mode==4u?4u:0u)
                        || after[rank]!=host[rank]){
                    fprintf(stderr,"native selector fault rank=%u form=%u mode=%u vector=%llu error=%llu\n",
                        rank,form,mode,(unsigned long long)observed[17],(unsigned long long)observed[18]);goto done;
                }
                ++faults;
            }else {if(after[rank]!=selector)goto done;++successes;}
            /* Restore visible data selectors before the next independently seeded observation. */
            pl_u16 es=(pl_u16)host[0],ds=(pl_u16)host[3];
            __asm__ volatile("mov %0,%%es; mov %1,%%ds" :: "r"(es),"r"(ds));
            char json[320];int size=snprintf(json,sizeof json,
                "{\"sourceBytes\":%u,\"operandBinding\":%u,\"rank\":%u,\"address\":%u,\"form\":%u,\"mode\":%u,\"memoryAccess\":%u,\"words\":42}\n",
                n,report.operand_binding,rank,address,form,mode,report.memory_access);
            if(size<1 || (size_t)size>=sizeof json || save(argc==2?argv[1]:NULL,id,"json",json,(size_t)size)
                    ||save(argc==2?argv[1]:NULL,id,"wasm",module,(size_t)bytes)
                    ||save(argc==2?argv[1]:NULL,id,"source-page",page,sizeof page)
                    ||save(argc==2?argv[1]:NULL,id,"cases",record,sizeof record))goto done;
            ++id;
        }
    }
    printf("MOV-to-segment memory: %u native successes / %u full-state faults, %u C emissions\n",successes,faults,id);result=0;
done:
    if(sigaction(SIGSEGV,&previous,NULL) || sigaction(SIGBUS,&previous_bus,NULL)
            || munmap(code,4096u) || munmap(ram,8192u))result=1;
    return result;
}
