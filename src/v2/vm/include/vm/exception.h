#ifndef VM_EXCEPTION_H
#define VM_EXCEPTION_H
#include <vm/segments.h>
#include <vm/pic.h>
#include <machine/exception.h>
enum vm_event_kind { VM_EVENT_FAULT, VM_EVENT_INTERRUPT, VM_EVENT_SOFTWARE };

/* One serialized architectural event, not a CPU snapshot. Completed frame
 * stores must not be replayed after a residency wait: they can alias the IDT,
 * GDT or paging structures. The owner pins all CPU/segment state throughout.
 * There is no instruction decoder or handler address in this interface. */
typedef struct {
    pl_u64 generation, context[5], frame[6], target, stack, descriptor_address;
    machine_segment_cache code;
    pl_u32 stage, pushed, words, selector, gate_type, descriptor_access, kind;
} vm_fault_delivery;
_Static_assert(sizeof(vm_fault_delivery) == 168u, "bounded event frontier extent");

/* Deliver a pending processor fault from machine_memory_port through the
 * guest IDT. Currently CPL0 -> CPL0 long-mode interrupt/trap gates, IST=0,
 * vectors 0/6/7/10/11/12/13/14/17. CR2 is published for #PF before delivery.
 * Host page absence returns BARRIER and retains the bounded event frontier.
 * Success updates RIP/CS/RSP/flags but does not retire the faulting instruction.
 * A secondary architectural fault is exposed and releases the frontier;
 * double/triple-fault escalation, TSS/IST and privilege changes are NOT yet
 * implemented. Unsupported contracts refuse admission, never skip a fault.
 * Close/rebind must clear delivery; no guest/device writer may run while it
 * has a nonzero stage. Neither this nor residency admission is an IRQ API. */
machine_result vm_fault_enter(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments, vm_fault_delivery *delivery);

/* Pending PIC interrupt at an uninhibited instruction boundary. Acknowledge
 * is performed once before IDT delivery; residency retries use the same
 * serialized frontier. No error code is pushed, even for exception vectors.
 * Current admission remains CPL0 long-mode/IST0, with explicit refusal of
 * unsupported stack/privilege changes. Success does not retire an instruction. */
machine_result vm_interrupt_enter(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments, vm_fault_delivery *delivery, vm_pic *pic);

/* Synchronous software exception delivery, currently #BP at CPL0/IST0.
 * next_rip is the architectural return coordinate, not a handler address.
 * RF is saved as zero; no error code is pushed. Delivery failure/wait leaves
 * the source RIP/retirement unchanged; the caller retires after success.
 * Retry must use the same vector/return coordinate and serialized frontier. */
machine_result vm_software_interrupt_enter(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments, vm_fault_delivery *delivery,
    pl_u32 vector, pl_u64 next_rip);

/* IRETQ from CPL0 to equally/less privileged 64-bit code, including unconditional
 * SS:RSP restoration, target descriptor checks and outer cache invalidation.
 * CPL1..3 origins, compatibility targets and CET refuse admission. Caller must
 * remove any exception error code first, exactly as on x86. */
machine_result vm_interrupt_return(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments);
#endif
