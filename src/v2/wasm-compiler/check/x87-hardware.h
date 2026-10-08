#ifndef CHECK_X87_HARDWARE_H
#define CHECK_X87_HARDWARE_H
#include "x87-observation.h"
#ifdef _WIN32
#include <windows.h>
/* Oracle only. Capture actual RAX/flags/FPU images. Other GPR invariance is
 * architectural; code under this helper may only transfer the implicit RAX. */
static inline void check_x87_hardware_full(machine_state *first,machine_state *last,const void *code,const void *input,void *before,void *after,pl_u16 *tags)
{
    _Alignas(16) pl_u8 host[512],old_env[32],new_env[32];pl_u64 old_flags,new_flags,output_ax;
    // FNSTENV observes the actual full tag, which cannot be reconstructed
    // from FXSAVE after MMX marks noncanonical payloads valid. It masks CW;
    // restore CW before the measured window, and capture AFTER before masking.
    __asm__ volatile("fxsave64 %[host]\n\tfxrstor64 %[input]\n\tfnstenv %[old_env]\n\tfldcw %[input]\n\tfxsave64 %[before]\n\t"
        "pushq %[flags]\n\tpopfq\n\tpushfq\n\tpopq %[old]\n\tmov %[ax],%%rax\n\tcall *%[code]\n\tmov %%rax,%[output_ax]\n\t"
        "pushfq\n\tpopq %[new]\n\tfxsave64 %[after]\n\tfnstenv %[new_env]\n\tfxrstor64 %[host]\n\tcld"
        :[host]"=m"(host),[before]"=m"(*(pl_u8 (*)[512])before),[after]"=m"(*(pl_u8 (*)[512])after),
         [old_env]"=m"(old_env),[new_env]"=m"(new_env),[output_ax]"=&r"(output_ax),[old]"=&r"(old_flags),[new]"=&r"(new_flags)
        :[input]"m"(*(const pl_u8 (*)[512])input),[code]"r"(code),[flags]"r"(first->rflags),[ax]"r"(first->registers[0]):"memory","cc","rax");
    first->rflags=old_flags;last->rflags=new_flags;
    last->registers[0]=output_ax;
    if(tags){tags[0]=(pl_u16)check_x87_read(old_env+8u,2u);tags[1]=(pl_u16)check_x87_read(new_env+8u,2u);}
}
static inline void check_x87_hardware(machine_state *first,machine_state *last,const void *code,const void *input,void *before,void *after)
{check_x87_hardware_full(first,last,code,input,before,after,NULL);}
#else
extern void native_fxsave(machine_state *,const void *,const void *,void *,void *);
static inline void check_x87_hardware(machine_state *first,machine_state *last,const void *code,const void *input,void *before,void *after)
{native_fxsave(last,code,input,before,after);first->registers[4u]=last->registers[4u];}
#endif
#endif
