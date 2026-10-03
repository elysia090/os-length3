#ifndef MACHINE_MSR_H
#define MACHINE_MSR_H

/* Serialized, precise long-mode register boundary. Generated cuts import
 * machine.msr: (i32 port, i32 operation, i32 key, i64 value) -> i64 result.
 * A successful READ supplies port.value; WRITE/SWAP_GS publish only the MSR
 * or hidden cache. The generated cut owns GPRs, RIP, flags and retirement.
 * Keys are architectural ECX[31:0], not an index into an arbitrary dictionary. */
enum machine_msr_operation {
    MACHINE_MSR_READ = 0u, MACHINE_MSR_WRITE, MACHINE_MSR_SWAP_GS,
};
#define MACHINE_MSR_EFER 0xc0000080u
#define MACHINE_MSR_FS_BASE 0xc0000100u
#define MACHINE_MSR_GS_BASE 0xc0000101u
#define MACHINE_MSR_KERNEL_GS_BASE 0xc0000102u

/* EFER and active FS/GS bases already have canonical owners. Only the
 * inactive KERNEL_GS_BASE lives in state.msr_{keys,values}. Its absent row
 * denotes its architectural reset value, zero; no unknown key reads zero.
 * No duplicate row or noncanonical base may be admitted on resume. */
#endif
