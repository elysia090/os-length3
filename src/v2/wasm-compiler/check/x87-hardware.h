#ifndef CHECK_X87_HARDWARE_H
#define CHECK_X87_HARDWARE_H
#include "x87-observation.h"
#ifdef _WIN32
#include <windows.h>
/* Oracle only. These operations do not write GPRs; capture actual flags and
 * complete FPU images without a waiting instruction in the observation gap. */
static inline void check_x87_hardware(machine_state *first,machine_state *last,const void *code,const void *input,void *before,void *after)
{
    _Alignas(16) pl_u8 host[512];pl_u64 old_flags,new_flags;
    __asm__ volatile("fxsave64 %[host]\n\tfxrstor64 %[input]\n\tfxsave64 %[before]\n\t"
        "pushq %[flags]\n\tpopfq\n\tpushfq\n\tpopq %[old]\n\tcall *%[code]\n\t"
        "pushfq\n\tpopq %[new]\n\tfxsave64 %[after]\n\tfxrstor64 %[host]\n\tcld"
        :[host]"=m"(host),[before]"=m"(*(pl_u8 (*)[512])before),[after]"=m"(*(pl_u8 (*)[512])after),
         [old]"=&r"(old_flags),[new]"=&r"(new_flags)
        :[input]"m"(*(const pl_u8 (*)[512])input),[code]"r"(code),[flags]"r"(first->rflags):"memory","cc");
    first->rflags=old_flags;last->rflags=new_flags;
}
#else
extern void native_fxsave(machine_state *,const void *,const void *,void *,void *);
static inline void check_x87_hardware(machine_state *first,machine_state *last,const void *code,const void *input,void *before,void *after)
{native_fxsave(last,code,input,before,after);first->registers[4u]=last->registers[4u];}
#endif
#endif
