#ifndef MACHINE_SYSTEM_H
#define MACHINE_SYSTEM_H
#include <machine/state.h>
/* Precise 64-bit privilege transfer using the architectural MSR bank.
 * machine.system_transfer: (i32 port, i32 operation, i64 next_rip) -> i64.
 * CALL64 saves next_rip/flags in RCX/R11. RETURN64 uses RCX/R11 and requires
 * next_rip=0. No syscall number, guest opcode, handler or host service enters
 * this ABI. The accepted guest kernel remains the syscall authority.
 * Success publishes CPU/cache state; the compiled caller retires once. */
enum machine_system_operation { MACHINE_SYSTEM_CALL64, MACHINE_SYSTEM_RETURN64 };
#endif
