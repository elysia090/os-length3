/* Canonical x86-64 architectural cut shared by native and Wasm backends. */

#ifndef MACHINE_STATE_H
#define MACHINE_STATE_H

#include <support/types.h>

#define MACHINE_ABI_VERSION 1u
#define MACHINE_X86_REGISTER_COUNT 16u
#define MACHINE_X86_XMM_WORDS 32u
#define MACHINE_X86_X87_REGISTERS 8u
#define MACHINE_X86_SYSTEM_WORDS 22u
#define MACHINE_X86_MSR_WORDS 32u

enum machine_system_word {
    MACHINE_SYSTEM_CR2 = 0u, MACHINE_SYSTEM_CR8,
    MACHINE_SYSTEM_GDTR_BASE, MACHINE_SYSTEM_GDTR_LIMIT,
    MACHINE_SYSTEM_IDTR_BASE, MACHINE_SYSTEM_IDTR_LIMIT,
    MACHINE_SYSTEM_ES, MACHINE_SYSTEM_CS, MACHINE_SYSTEM_SS, MACHINE_SYSTEM_DS,
    MACHINE_SYSTEM_FS, MACHINE_SYSTEM_GS, MACHINE_SYSTEM_LDTR, MACHINE_SYSTEM_TR,
    MACHINE_SYSTEM_DR0, /* Eight debug-register slots end at word 21. */
};

typedef struct {
    pl_u64 registers[MACHINE_X86_REGISTER_COUNT];
    pl_u64 xmm[MACHINE_X86_XMM_WORDS];
    pl_u64 rip;
    pl_u64 rflags;
    pl_u64 cr0;
    pl_u64 cr3;
    pl_u64 cr4;
    pl_u64 efer;
    pl_u64 system[MACHINE_X86_SYSTEM_WORDS];
    pl_u32 msr_count;
    pl_u32 mxcsr;
    pl_u64 msr_keys[MACHINE_X86_MSR_WORDS];
    pl_u64 msr_values[MACHINE_X86_MSR_WORDS];
    pl_u64 retired;
    pl_u64 work;
    pl_u64 span;
    pl_u64 x87_significand[MACHINE_X86_X87_REGISTERS];
    pl_u16 x87_sign_exponent[MACHINE_X86_X87_REGISTERS];
    pl_u16 x87_control;
    pl_u16 x87_status;
    pl_u16 x87_tag;
    pl_u16 x87_opcode;
    pl_u64 x87_ip;
    pl_u64 x87_dp;
} machine_state;

#endif /* MACHINE_STATE_H */
