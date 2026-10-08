/* Uniform compiled function type for bounded execution tables. */
#ifndef MACHINE_ENTRY_H
#define MACHINE_ENTRY_H
#include <machine/result.h>
/* Version 4 distinguishes explicit debug traps from ordinary INT 1. The
 * function type is unchanged, but old software-event modules are not valid. */
#define MACHINE_ENTRY_ABI_VERSION 4u
/* Binding is the exact C-admitted row entry, latched across an in-flight
 * instruction. It is not read from a mutable source or guessed from state. */
/* The cold compiler's signed displacement bit pattern is also passed by
 * value. Neither binding is recovered from mutable guest instruction bytes. */
typedef machine_result (*machine_entry)(pl_u32 state, pl_u32 port, pl_u64 entry,
    pl_u32 operand_binding);
#endif
