#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <machine/memory.h>
#include <signal.h>
#include <setjmp.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <ucontext.h>
extern void native_stack_cut(const machine_state *,const void *);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
static pl_u8 source[4096],module[65536],alternate[65536];
static sigjmp_buf recovery;
static volatile sig_atomic_t trapped;
static pl_u64 registers[16],flags,vector,error,fault_rip,fault_address;
static void exception(int number,siginfo_t *info,void *pointer)
{
    (void)number; __asm__ volatile("cld" ::: "cc");
    const ucontext_t *context=pointer;
    static const int ranks[]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for (pl_u32 i=0u;i<16u;++i) registers[i]=(pl_u64)context->uc_mcontext.gregs[ranks[i]];
    flags=(pl_u64)context->uc_mcontext.gregs[REG_EFL]; vector=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    error=(pl_u64)context->uc_mcontext.gregs[REG_ERR]; fault_rip=(pl_u64)context->uc_mcontext.gregs[REG_RIP];
    fault_address=(pl_u64)(uintptr_t)info->si_addr; trapped=1; siglongjmp(recovery,1);
}
static void observe(const machine_state *state,const void *code)
{ trapped=0; if (!sigsetjmp(recovery,1)) native_stack_cut(state,code); }
static pl_u64 random_word(pl_u64 *seed)
{ *seed^=*seed<<13u; *seed^=*seed>>7u; *seed^=*seed<<17u; return *seed; }
static void put(pl_u8 *target,pl_u64 value)
{ for (pl_u32 i=0u;i<8u;++i) target[i]=(pl_u8)(value>>(8u*i)); }
static int save(const char *directory,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    if (!directory) return 0;
    char path[4096]; int n=snprintf(path,sizeof path,"%s/memory-divide-%u.%s",directory,form,suffix);
    if (n<1 || (size_t)n>=sizeof path) return -1;
    FILE *file=fopen(path,"wbx"); if (!file) return -1;
    int status=fwrite(data,1u,bytes,file)==bytes ? 0 : -1; if (fclose(file)) status=-1; return status;
}
static pl_u32 encoding(pl_u32 form,pl_u32 *width,pl_u32 *address32,pl_u32 *kind)
{
    *width=8u << (form%4u); *address32=form<32u ? (form%16u)/4u==1u : form>=64u;
    int signed_divide=form<32u ? form>=16u : form<48u ? form>=40u : form<64u ? form>=56u : form>=68u;
    *kind=form<32u ? (form%16u)/4u : form<48u ? 4u+(form%8u)/4u : form<64u ? 6u+(form%8u)/4u : 4u;
    pl_u32 at=0u;
    if (*address32) source[at++]=0x67u;
    if (*width==16u) source[at++]=0x66u;
    if (*width==64u || *kind==6u) source[at++]=(pl_u8)((*width==64u ? 0x48u : 0x40u)|(*kind==6u ? 1u : 0u));
    source[at++]=(pl_u8)(*width==8u ? 0xf6u : 0xf7u);
    pl_u32 selector=signed_divide ? 0x38u : 0x30u;
    if (*kind<2u) source[at++]=(pl_u8)(selector|7u);
    else if (*kind<4u) source[at++]=(pl_u8)(selector|(*kind==2u ? 0u : 2u));
    else if (*kind==4u) { source[at++]=(pl_u8)(selector|0x44u); source[at++]=0x24u; source[at++]=4u; }
    else if (*kind==5u) {
        source[at++]=(pl_u8)(selector|5u); pl_u32 displacement=4099u-(at+4u);
        for (pl_u32 i=0u;i<4u;++i) source[at++]=(pl_u8)(displacement>>(8u*i));
    } else if (*kind==6u) { source[at++]=(pl_u8)(selector|4u); source[at++]=0x24u; }
    else { source[at++]=(pl_u8)(selector|0x44u); source[at++]=0x8fu; source[at++]=7u; }
    return at;
}
static int check_frontier(const pl_x86_map *map,pl_u32 size)
{
    /* An earlier pure write retires separately, before a precise operand
     * fault. The next admission starts at the original memory instruction. */
    pl_u8 prefix[4096],emitted[4096],saved[4096];
    memset(prefix,0x90,sizeof prefix); prefix[0]=0x89u; prefix[1]=0xc0u;
    memcpy(prefix+2u,map->bytes,size); memcpy(saved,prefix,sizeof saved);
    pl_x86_map prefixed=*map; prefixed.bytes=prefix;
    pl_x86_image image={&prefixed,1u,0u,map->address};
    wasm_cut_options options={image.entry,2u,sizeof emitted};
    wasm_cut_report report; pl_u64 bytes=0u;
    if (wasm_compiler_emit_code_cut(&image,9u,&options,emitted,sizeof emitted,&bytes,&report)
            || report.source_bytes!=2u || report.source_instructions!=1u
            || report.continuation!=image.entry+2u || report.boundary!=WASM_CUT_MEMORY) return -1;
    options.entry+=2u; options.maximum_source_instructions=1u;
    if (wasm_compiler_emit_code_cut(&image,9u,&options,emitted,sizeof emitted,&bytes,&report)
            || report.source_bytes!=size || report.source_instructions!=1u
            || report.boundary!=WASM_CUT_MEMORY || memcmp(prefix,saved,sizeof saved)) return -1;
    /* Unsupported addressing/LOCK and a short output leave every result
     * byte and source byte unchanged, rather than exposing a partial module. */
    static const pl_u8 refused[][3]={{0xf0,0xf7,0x37},{0xf0,0xf7,0x3f},
        {0x64,0xf7,0x3f},{0x65,0xf7,0x3f}};
    for (pl_u32 rank=0u;rank<5u;++rank) {
        if (rank<4u) memcpy(prefix,refused[rank],3u);
        else memcpy(prefix,map->bytes,size);
        memcpy(saved,prefix,sizeof saved); options.entry=image.entry;
        memset(emitted,0xa5,sizeof emitted); memset(&report,0xa5,sizeof report); bytes=77u;
        int expected=rank<4u ? WASM_COMPILER_ERROR_GRAMMAR : WASM_COMPILER_ERROR_CAPACITY;
        if (wasm_compiler_emit_code_cut(&image,9u,&options,emitted,rank<4u ? sizeof emitted : 1u,&bytes,&report)
                !=expected || bytes!=77u || memcmp(prefix,saved,sizeof saved)) return -1;
        for (size_t i=0u;i<sizeof emitted;++i) if (emitted[i]!=0xa5u) return -1;
        for (size_t i=0u;i<sizeof report;++i) if (((const pl_u8 *)&report)[i]!=0xa5u) return -1;
    }
    return 0;
}
int main(int argc,char **argv)
{
    int observe_only=argc==3 && !strcmp(argv[2],"--observe");
    if (argc!=1 && argc!=2 && !observe_only) return 2;
    const char *directory=argc>=2 ? argv[1] : NULL;
    stack_t old_stack,stack={.ss_sp=alternate,.ss_size=sizeof alternate};
    struct sigaction old_segv,old_fpe,action={.sa_sigaction=exception,.sa_flags=SA_SIGINFO|SA_ONSTACK};
    sigemptyset(&action.sa_mask);
    if (sigaltstack(&stack,&old_stack) || sigaction(SIGSEGV,&action,&old_segv) || sigaction(SIGFPE,&action,&old_fpe)) return 1;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,8192u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    const pl_u64 addresses[]={0x23456000u,0x200023456000ull};
    pl_u8 *ram[2]={MAP_FAILED,MAP_FAILED};
    int status=1; pl_u32 observed=0u,divide_faults=0u,page_faults=0u; pl_u64 seed=0x723bcde9876fedcull;
    if (code==MAP_FAILED) goto finish;
    for (pl_u32 i=0u;i<2u;++i) {
        ram[i]=mmap((void *)(uintptr_t)addresses[i],8192u,PROT_READ|PROT_WRITE,
            MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
        if (ram[i]==MAP_FAILED) goto finish;
    }
    for (pl_u32 form=0u;form<72u;++form) {
        memset(source,0x90,sizeof source); pl_u32 width,address32,kind;
        pl_u32 size=encoding(form,&width,&address32,&kind),bytes=width/8u;
        memcpy(code,source,sizeof source); memset(code+4096,0xa5,4096u);
        code[size]=0xffu; code[size+1u]=0x25u; memset(code+size+2u,0,4u);
        put(code+size+6u,(pl_u64)(uintptr_t)native_stack_capture);
        pl_u64 records[512][40],faults[512][40];
        for (pl_u32 row=0u;row<512u;++row) {
            machine_state before={0};
            for (pl_u32 rank=0u;rank<16u;++rank) before.registers[rank]=random_word(&seed);
            before.rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u64 mask=~0ull >> (64u-width),sign=1ull << (width-1u);
            const pl_u64 boundary[]={0u,1u,2u,sign-1u,sign,sign+1u,mask-1u,mask};
            pl_u64 divisor=random_word(&seed)&mask;
            if (row<256u) {
                before.registers[0]=(before.registers[0]&~mask)|boundary[(row/8u)%8u];
                before.registers[2]=(before.registers[2]&~mask)|boundary[(row/64u)%8u];
                if (width==8u) before.registers[0]=(before.registers[0]&~0xffffull)
                    | (boundary[(row/64u)%8u]<<8u)|boundary[(row/8u)%8u];
                divisor=boundary[row%8u];
            } else if (!(row%8u)) {
                before.registers[0]=row&8u ? sign : mask;
                before.registers[2]=row&16u ? mask : 0u; divisor=row&32u ? mask : 2u;
                if (width==8u) before.registers[0]=row&8u ? 0x8000u : 0x7fffu;
            }
            pl_u32 owner=address32 ? 0u : 1u,offset=row%3u==0u ? 4093u : row%3u==1u ? 0u : 4088u;
            pl_u64 address=kind==5u ? 0x401003u : addresses[owner]+offset;
            pl_u8 *payload=kind==5u ? code+4096u : ram[owner];
            before.registers[4]=addresses[owner]+2048u;
            if (kind<2u) before.registers[7]=address;
            else if (kind<4u) before.registers[kind==2u ? 0u : 2u]=address;
            else if (kind==4u) before.registers[4]=address-4u;
            else if (kind==6u) before.registers[12]=address;
            else if (kind==7u) { before.registers[1]=row&15u; before.registers[7]=address-7u-before.registers[1]*4u; }
            if (address32 && kind!=4u) before.registers[7]|=0xdeadbeef00000000ull;
            if (address32 && kind==4u) before.registers[4]|=0x200000000000ull;
            put((pl_u8 *)(uintptr_t)address,divisor);
            pl_u8 saved[8192]; memcpy(saved,payload,kind==5u ? 4096u : 8192u);
            observe(&before,code);
            if (trapped && (vector || error || fault_rip!=0x400000u || (flags&~0x10000ull)!=before.rflags)) goto finish;
            if (!trapped && ((native_stack_result[16]^before.rflags)&~0x8d5ull)) goto finish;
            for (pl_u32 rank=0u;rank<16u;++rank) {
                pl_u64 actual=trapped ? registers[rank] : native_stack_result[rank];
                if ((trapped || (rank!=0u && (width==8u || rank!=2u))) && actual!=before.registers[rank]) goto finish;
                records[row][rank]=before.registers[rank]; records[row][17u+rank]=actual;
            }
            records[row][16]=before.rflags; records[row][33]=before.rflags;
            records[row][34]=trapped ? 0x400000u : 0x400000u+size;
            records[row][35]=address; records[row][36]=divisor;
            records[row][37]=(pl_u64)(unsigned)trapped; records[row][38]=trapped ? flags : native_stack_result[16];
            records[row][39]=trapped ? error : 0u;
            ++observed; if (trapped) ++divide_faults;
            pl_u8 *protected_page=(pl_u8 *)(uintptr_t)((address+bytes-1u)&~4095ull);
            if (mprotect(protected_page,4096u,PROT_NONE)) goto finish;
            observe(&before,code);
            if (mprotect(protected_page,4096u,PROT_READ|PROT_WRITE|(kind==5u ? PROT_EXEC : 0))) goto finish;
            if (!trapped || vector!=14u || error!=4u || fault_rip!=0x400000u
                    || (flags&~0x10000ull)!=before.rflags
                    || fault_address!=(address < (pl_u64)(uintptr_t)protected_page
                        ? (pl_u64)(uintptr_t)protected_page : address)) goto finish;
            for (pl_u32 rank=0u;rank<16u;++rank) {
                if (registers[rank]!=before.registers[rank]) goto finish;
                faults[row][rank]=before.registers[rank]; faults[row][17u+rank]=registers[rank];
            }
            faults[row][16]=before.rflags; faults[row][33]=flags; faults[row][34]=fault_rip;
            faults[row][35]=fault_address; faults[row][36]=divisor; faults[row][37]=vector; faults[row][38]=error; faults[row][39]=address;
            ++page_faults;
            if (memcmp(saved,payload,kind==5u ? 4096u : 8192u)) goto finish;
        }
        pl_x86_map map={source,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u}; wasm_cut_options options={image.entry,1u,sizeof module};
        wasm_cut_report report; pl_u64 emitted=0u;
        if (!observe_only) {
            int compiled=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
            if (compiled || report.source_bytes!=size || report.source_instructions!=1u
                    || report.boundary!=WASM_CUT_MEMORY || report.flags_written || report.memory_bytes!=bytes
                    || (report.memory_access&3u)!=MACHINE_MEMORY_READ || report.written_registers!=(width==8u ? 1u : 5u)
                    || check_frontier(&map,size)) {
                fprintf(stderr,"memory divide form %u red: compiler=%d\n",form,compiled); goto finish;
            }
        }
        char json[256]; int length=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"sourceBytes\":%u,\"instructions\":1,\"width\":%u,\"address32\":%u,\"kind\":%u,\"access\":%u,\"native\":512,\"words\":40}\n",form,size,width,address32,kind,observe_only ? 0u : report.memory_access);
        if (length<1 || (size_t)length>=sizeof json || save(directory,form,"json",json,(size_t)length)
                || save(directory,form,"source-page",source,sizeof source) || save(directory,form,"cases",records,sizeof records)
                || save(directory,form,"faults",faults,sizeof faults)
                || (!observe_only && save(directory,form,"wasm",module,(size_t)emitted))) goto finish;
    }
    status=0;
finish:
    if (code!=MAP_FAILED && munmap(code,8192u)) status=1;
    for (pl_u32 i=0u;i<2u;++i) if (ram[i]!=MAP_FAILED && munmap(ram[i],8192u)) status=1;
    if (sigaction(SIGSEGV,&old_segv,NULL) || sigaction(SIGFPE,&old_fpe,NULL) || sigaltstack(&old_stack,NULL)) status=1;
    if (!status) printf("Memory division: %u actual x86 observations / %u #DE / %u read #PF frames%s\n",observed,divide_faults,page_faults,
        observe_only ? "; lowering not tested" : "");
    return status;
}
