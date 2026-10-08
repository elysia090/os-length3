#ifndef VM_EXCEPTION_H
#define VM_EXCEPTION_H
#include <vm/segments.h>
#include <vm/pic.h>
#include <machine/exception.h>
enum vm_event_kind { VM_EVENT_FAULT, VM_EVENT_INTERRUPT, VM_EVENT_SOFTWARE, VM_EVENT_DEBUG_TRAP };

/* One serialized architectural event, not a CPU snapshot. Completed frame
 * stores must not be replayed after a residency wait: they can alias the IDT,
 * GDT or paging structures. The owner pins all CPU/segment state throughout.
 * There is no instruction decoder or handler address in this interface. */
typedef struct {
    pl_u64 generation, context[5], frame[6], target, stack, descriptor_address;
    machine_segment_cache code;
    pl_u32 stage, pushed, words, selector, gate_type, descriptor_access, kind, vector;
} vm_fault_delivery;
_Static_assert(sizeof(vm_fault_delivery) == 168u, "bounded event frontier extent");

/* Deliver a pending processor fault from machine_memory_port through the
 * guest IDT. Currently long-mode interrupt/trap gates to non-conforming CPL0
 * code, IST=0; outer origins use a valid busy 64-bit TSS.RSP0,
 * vectors 0/1/6/7/10/11/12/13/14/16/17/19. Only error-code faults push a sixth
 * slot; #MF/#XM do not. CR2 is published for #PF before delivery.
 * Host page absence returns BARRIER and retains the bounded event frontier.
 * Success updates RIP/CS/RSP/flags but does not retire the faulting instruction.
 * A secondary architectural fault is exposed and releases the frontier;
 * double/triple-fault escalation, IST, conforming outer transitions and invalid
 * TSS exception semantics are NOT yet implemented. Unsupported contracts
 * refuse admission, never skip a fault.
 * Close/rebind must clear delivery; no guest/device writer may run while it
 * has a nonzero stage. Neither this nor residency admission is an IRQ API. */
machine_result vm_fault_enter(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments, vm_fault_delivery *delivery);

/* Pending PIC interrupt at an uninhibited instruction boundary. Acknowledge
 * is performed once before IDT delivery; residency retries use the same
 * serialized frontier. No error code is pushed, even for exception vectors.
 * Current admission is long-mode/IST0 to CPL0; valid TSS.RSP0 owns an inner
 * stack switch. Unsupported stack profiles explicitly refuse admission.
 * Success does not retire an instruction. */
machine_result vm_interrupt_enter(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments, vm_fault_delivery *delivery, vm_pic *pic);

/* Software INT (every vector) and explicit #BP/#DB to CPL0/IST0. The event
 * word is defined in machine/exception.h; ordinary INT 1 is not a debug trap.
 * Explicit #DB bypasses gate DPL and
 * uses EXT=1 for secondary errors. Outer origins use TSS.RSP0.
 * next_rip is the architectural return coordinate, not a handler address.
 * #DB clears DR6.B0..3/GD once before delivery, including failed delivery.
 * RF is saved as zero; no error code is pushed. Delivery failure/wait leaves
 * the source RIP/retirement unchanged; the caller retires after success.
 * Retry must use the same vector/return coordinate and serialized frontier. */
machine_result vm_software_interrupt_enter(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments, vm_fault_delivery *delivery,
    pl_u32 event, pl_u64 next_rip);

/* 16/32/64-bit IRET to equally/less privileged 64-bit code, including unconditional
 * SS:RSP restoration, target descriptor checks and outer cache invalidation.
 * Return word is defined in machine/control.h. Compatibility/CET remain gaps. Caller must
 * remove any exception error code first, exactly as on x86. */
machine_result vm_interrupt_return(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments,pl_u32 return_word);
#endif
