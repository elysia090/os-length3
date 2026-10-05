#ifndef VM_SEGMENTS_H
#define VM_SEGMENTS_H
#include <vm/mmu.h>
#include <machine/state.h>
#include <machine/segments.h>

/* Normalize a compiled effective offset at the pinned long-mode boundary.
 * Only FS/GS have nonzero bases; their visible null/unusable selectors do
 * not discard MSR-owned hidden bases. Strip that role before raw MMU access.
 * Invalid roles/profile/cache return -1 without changing either output.
 * Address-size truncation belongs to the compiler, before this 64-bit add.
 * Ordinary linear MMU callers and implicit system accesses need no segment. */
int vm_segment_address(const machine_segments *segments, pl_u64 *address, pl_u32 *access);

/* Serialized, pinned long-mode owner. State/context/port are disjoint private
 * reservations, not guest RAM. ES/SS/DS/FS/GS MOV and privileged LDTR/TR
 * loads use the same owner. LTR updates the whole GDT record before publishing
 * TR; LLDT never sets a code/data Accessed bit. No hardware task switch.
 * CS, compatibility mode and exception/TSS use are separate gates.
 * The fixed Intel projection clears a null data selector's base; this is an
 * explicit profile behavior, not a portable Intel/AMD equivalence claim. */
machine_result vm_segment_load(vm_memory *physical, pl_u32 port_offset,
                                machine_state *state, machine_segments *segments,
                                pl_u32 rank, pl_u32 selector);
#endif
