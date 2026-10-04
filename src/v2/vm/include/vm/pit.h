#ifndef VM_PIT_H
#define VM_PIT_H
#include <support/types.h>
#include <vm/pic.h>
#define VM_PIT_FREQUENCY 1193182u
typedef struct {
    pl_u64 anchor, elapsed;
    pl_u32 count, reload;
    pl_u16 latch;
    pl_u8 rw, read_high, write_high, write_low, gate;
    pl_u8 loaded, pending, count_latched, latch_high;
    pl_u8 status_latched, status, mode, restart;
} vm_pit_channel;
typedef struct { vm_pit_channel channel[3]; pl_u8 speaker, irq_level; } vm_pit;
/* Binary modes 0 and 2 (including mode-6 encoding), all three channels;
 * channel 0 OUT drives the PC PIC IRQ0. No audio backend.
 * Other modes/BCD, mode-2 divisor 1, command reads and wide I/O are refused.
 * Board reset has no programmed count, gate0/1 high, gate2 low; port61's
 * refresh/parity inputs are absent, not a read-triggered fabricated clock. */
void vm_pit_reset(vm_pit *pit);
int vm_pit_accepts(pl_u32 port, pl_u32 write, pl_u32 value);
int vm_pit_can_advance(const vm_pit *pit, pl_u64 nanoseconds);
/* O(1) per channel, independent of missed periods. Edge-triggered PIC IRR
 * coalesces intervening rising edges; final OUT also preserves level mode.
 * Repeating an accepted timestamp produces no new pulse. */
int vm_pit_advance(vm_pit *pit, pl_u64 nanoseconds, vm_pic *pic);
int vm_pit_transfer(vm_pit *pit, pl_u64 nanoseconds, vm_pic *pic, pl_u32 port,
    pl_u32 write, pl_u32 *value);
#endif
