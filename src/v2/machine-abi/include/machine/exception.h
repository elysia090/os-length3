/* Architectural event delivery belongs to the machine, not to a source ISA
 * interpreter. This import carries only an exception and return coordinate. */
#ifndef MACHINE_EXCEPTION_H
#define MACHINE_EXCEPTION_H
enum machine_exception_vector { MACHINE_EXCEPTION_DEBUG = 1u, MACHINE_EXCEPTION_BREAKPOINT = 3u };
#define MACHINE_SOFTWARE_DEBUG_TRAP 256u
/* Low8 is the vector. Bit8 denotes an explicit debug trap: only vector1
 * permits it. Ordinary software INT1 is vector1 WITHOUT this flag. */
static inline unsigned machine_software_valid(unsigned event)
{return !(event&~511u)&&(!(event&MACHINE_SOFTWARE_DEBUG_TRAP)||(event&255u)==MACHINE_EXCEPTION_DEBUG);}

/* software_interrupt(i32 private_port, i32 event, i64 next_rip) -> i64
 * The provider checks the guest IDT/descriptors and owns ordered frame stores
 * through residency waits. No host handler pointer or instruction bytes cross
 * the boundary. Successful delivery publishes handler RIP/CS/RSP/flags; the
 * emitted caller then retires once. Fault/wait leaves source RIP/count intact.
 * All software vectors and explicit #DB/#BP use long-mode/IST0. Only explicit #DB bypasses
 * gate DPL, uses EXT=1 on delivery errors, clears DR6.B0..3 and DR7.GD;
 * these debug effects persist even on a secondary architectural fault.
 * This is not general single-step/address-breakpoint admission. RF is zero,
 * no error code is pushed, CR2 is unchanged. Unsupported event/privilege/IST
 * contracts refuse explicitly. A secondary exception is not a successful
 * trap; double/triple-fault escalation requires its own verified admission. */

#endif
