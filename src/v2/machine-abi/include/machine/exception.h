/* Architectural event delivery belongs to the machine, not to a source ISA
 * interpreter. This import carries only an exception and return coordinate. */
#ifndef MACHINE_EXCEPTION_H
#define MACHINE_EXCEPTION_H
enum machine_exception_vector { MACHINE_EXCEPTION_BREAKPOINT = 3u };

/* software_interrupt(i32 private_port, i32 vector, i64 next_rip) -> i64
 * The provider checks the guest IDT/descriptors and owns ordered frame stores
 * through residency waits. No host handler pointer or instruction bytes cross
 * the boundary. Successful delivery publishes handler RIP/CS/RSP/flags; the
 * emitted caller then retires once. Fault/wait leaves source RIP/count intact.
 * Current accepted event is #BP, CPL0 long-mode/IST0. RF is saved as zero,
 * no error code is pushed, CR2 is unchanged. Unsupported event/privilege/IST
 * contracts refuse explicitly. A secondary exception is not a successful
 * trap; double/triple-fault escalation requires its own verified admission. */

#endif
