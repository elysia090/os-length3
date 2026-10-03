#define _GNU_SOURCE
#include <machine/state.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <signal.h>
#include <setjmp.h>
#include <ucontext.h>
#include <stdint.h>
extern void native_cut(machine_state *, void (*)(void));
#define DECLARE(width,address) extern void native_repeat_##width##_##address(void)
DECLARE(8,32); DECLARE(16,32); DECLARE(32,32); DECLARE(64,32);
DECLARE(8,64); DECLARE(16,64); DECLARE(32,64); DECLARE(64,64);
#define DECLARE_STOS(width,address) extern void native_stos_##width##_##address(void)
DECLARE_STOS(8,32); DECLARE_STOS(16,32); DECLARE_STOS(32,32); DECLARE_STOS(64,32);
DECLARE_STOS(8,64); DECLARE_STOS(16,64); DECLARE_STOS(32,64); DECLARE_STOS(64,64);
static void (*const functions[2][4])(void) = {
    {native_repeat_8_32,native_repeat_16_32,native_repeat_32_32,native_repeat_64_32},
    {native_repeat_8_64,native_repeat_16_64,native_repeat_32_64,native_repeat_64_64}
};
static void (*const store_functions[2][4])(void) = {
    {native_stos_8_32,native_stos_16_32,native_stos_32_32,native_stos_64_32},
    {native_stos_8_64,native_stos_16_64,native_stos_32_64,native_stos_64_64}
};
static sigjmp_buf recovery;
static volatile pl_u64 fault_words[9];
static void on_fault(int signal, siginfo_t *info, void *pointer)
{
    __asm__ volatile("cld" ::: "cc");
    (void)signal;
    const ucontext_t *context = pointer;
    fault_words[0] = (pl_u64)context->uc_mcontext.gregs[REG_RCX];
    fault_words[1] = (pl_u64)context->uc_mcontext.gregs[REG_RSI];
    fault_words[2] = (pl_u64)context->uc_mcontext.gregs[REG_RDI];
    fault_words[3] = (pl_u64)context->uc_mcontext.gregs[REG_EFL];
    fault_words[4] = (pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    fault_words[5] = (pl_u64)context->uc_mcontext.gregs[REG_ERR];
    fault_words[6] = (pl_u64)(uintptr_t)info->si_addr;
    fault_words[7] = (pl_u64)context->uc_mcontext.gregs[REG_RIP];
    fault_words[8] = (pl_u64)context->uc_mcontext.gregs[REG_RAX];
    siglongjmp(recovery,1);
}
static int capture_fault(machine_state *state, void (*function)(void))
{
    if (!sigsetjmp(recovery,1)) { native_cut(state,function); return 1; }
    return fault_words[7] != (pl_u64)(uintptr_t)function;
}
static int faults(pl_u8 *ram, const char *path, int store)
{
    struct sigaction action = {0}, previous;
    action.sa_sigaction = on_fault; action.sa_flags = SA_SIGINFO;
    if (sigemptyset(&action.sa_mask) || sigaction(SIGSEGV,&action,&previous)) return 1;
    FILE *file = fopen(path,"wbx");
    if (!file) { sigaction(SIGSEGV,&previous,0); return 1; }
    int status = 0;
    for (pl_u32 address_rank = 0u; address_rank < 2u; ++address_rank)
    for (pl_u32 width_rank = 0u; width_rank < 4u; ++width_rank)
    for (pl_u32 operation = store ? 1u : 0u; operation < 2u; ++operation)
    for (pl_u32 direction = 0u; direction < (store ? 2u : 1u); ++direction)
    for (pl_u32 failure = 0u; failure < 3u; ++failure) {
        pl_u64 size = 1ull << width_rank;
        if (failure == 2u && size == 1u) continue;
        for (pl_u32 i = 0u; i < 16384u; ++i) ram[i] = (pl_u8)(i * 37u + (8u << width_rank));
        pl_u64 crossing = 0x501000u - (failure == 0u ? 0u : failure == 1u ? 2u * size : size - 1u);
        if (direction) crossing = failure == 0u ? 0x502000u - size
            : failure == 1u ? 0x502000u + size : 0x502000u - (size - 1u);
        machine_state state = {0};
        state.registers[1] = 4u; state.registers[6] = store ? 0x8000000000502000ull : operation ? 0x502000u : crossing;
        state.registers[7] = operation ? crossing : 0x502000u;
        state.rflags = 0x202u | (direction ? 0x400u : 0u);
        state.registers[0] = 0x0123456789abcdefull;
        if (!address_rank) {
            state.registers[1] |= 0x1234567800000000ull;
            state.registers[6] |= 0x8765432100000000ull;
            state.registers[7] |= 0xabcdef0100000000ull;
        }
        pl_u64 record[16] = {8u << width_rank,address_rank ? 64u : 32u,store ? direction : operation,failure,
            state.registers[1],state.registers[6],state.registers[7],0u,0u,0u,0u,0u,0u,0u,state.registers[0],0u};
        if (mprotect(ram + 4096u,4096u,PROT_NONE)) { status = 1; goto done; }
        if (capture_fault(&state,(store ? store_functions : functions)[address_rank][width_rank])) status = 1;
        for (pl_u32 i = 0u; i < 7u; ++i) record[i + 7u] = fault_words[i];
        record[15] = fault_words[8];
        if (mprotect(ram + 4096u,4096u,PROT_READ | PROT_WRITE)) { status = 1; goto done; }
        if (fwrite(record,store ? sizeof record : 14u * sizeof record[0],1u,file) != 1u
                || fwrite(ram,16384u,1u,file) != 1u) { status = 1; goto done; }
    }
done:
    if (fclose(file)) status = 1;
    if (sigaction(SIGSEGV,&previous,0)) status = 1;
    return status;
}
static int records(pl_u8 *ram, const char *path, int store)
{
    const pl_u64 counts[] = {0u,1u,7u,255u,256u,257u,513u};
    FILE *file = fopen(path,"wbx");
    if (!file) return 1;
    int status = 0;
    for (pl_u32 address_rank = 0u; address_rank < 2u; ++address_rank)
    for (pl_u32 width_rank = 0u; width_rank < 4u; ++width_rank)
    for (pl_u32 sample = 0u; sample < sizeof counts / sizeof counts[0]; ++sample)
    for (pl_u32 direction = 0u; direction < 2u; ++direction)
    for (pl_u32 overlap = 0u; overlap < 3u; ++overlap) {
        pl_u64 bytes = 1ull << width_rank, address = address_rank ? 64u : 32u;
        machine_state state = {0};
        state.registers[0] = 0x0123456789abcdefull ^ ((pl_u64)sample << 40u) ^ (pl_u64)direction;
        for (pl_u32 i = 0u; i < 16384u; ++i) ram[i] = (pl_u8)(i * 37u + sample * 17u + (8u << width_rank));
        pl_u64 src = 0x500000u + (direction ? 4608u : 512u);
        pl_u64 dst = overlap ? src + (overlap == 1u ? bytes : 0u - bytes)
                             : 0x500000u + (direction ? 12288u : 8192u);
        state.registers[1] = counts[sample]; state.registers[6] = store ? 0x8000000000000000ull ^ src : src;
        state.registers[7] = dst;
        if (address == 32u) {
            state.registers[1] |= 0x1234567800000000ull;
            state.registers[6] |= 0x8765432100000000ull;
            state.registers[7] |= 0xabcdef0100000000ull;
        }
        state.rflags = 0x202u | (direction ? 0x400u : 0u);
        pl_u64 record[16] = {8u << width_rank,address,counts[sample],direction,overlap,sample,
            state.registers[1],state.registers[6],state.registers[7],0u,0u,0u,
            state.registers[0],0u,state.rflags,0u};
        native_cut(&state,(store ? store_functions : functions)[address_rank][width_rank]);
        record[9] = state.registers[1]; record[10] = state.registers[6]; record[11] = state.registers[7];
        record[13] = state.registers[0]; record[15] = state.rflags;
        if (state.rflags != (0x202u | (direction ? 0x400u : 0u))
                || (store && record[12] != record[13])
                || fwrite(record,store ? sizeof record : 12u * sizeof record[0],1u,file) != 1u
                || fwrite(ram,16384u,1u,file) != 1u) status = 1;
    }
    if (fclose(file)) status = 1;
    return status;
}
int main(int argc, char **argv)
{
    if (argc != 3 && argc != 5) return 2;
    pl_u8 *ram = mmap((void *)0x500000u,16384u,PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,-1,0);
    if (ram == MAP_FAILED) { perror("repeat mmap"); return 1; }
    int status = records(ram,argv[1],0) || faults(ram,argv[2],0);
    if (argc == 5 && (records(ram,argv[3],1) || faults(ram,argv[4],1))) status = 1;
    if (munmap(ram,16384u)) status = 1;
    if (!status) puts("REP MOVS native x86: 336 CPU/RAM + 44 first/partial-fault receipts (not browser exception delivery/Linux boot)");
    if (!status && argc == 5) puts("REP STOS native x86: 336 CPU/RAM + 44 forward/backward partial-fault receipts (not exception delivery/Linux boot)");
    return status;
}
