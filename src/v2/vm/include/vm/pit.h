#ifndef VM_PIT_H
#define VM_PIT_H
#include <support/types.h>
#define VM_PIT_FREQUENCY 1193182u
typedef struct {
    pl_u64 anchor, elapsed;
    pl_u32 count, reload;
    pl_u16 latch;
    pl_u8 rw, read_high, write_high, write_low, gate;
    pl_u8 loaded, pending, paused, count_latched, latch_high;
    pl_u8 status_latched, status;
} vm_pit_channel;
typedef struct { vm_pit_channel channel[3]; pl_u8 speaker; } vm_pit;
/* Binary mode 0, all three channels; no interrupt routing or audio backend.
 * Other modes/BCD, command-register reads and wider transfers are refused.
 * Board reset has no programmed count, gate0/1 high, gate2 low; port61's
 * refresh/parity inputs are absent, not a read-triggered fabricated clock. */
void vm_pit_reset(vm_pit *pit);
int vm_pit_accepts(pl_u32 port, pl_u32 write, pl_u32 value);
int vm_pit_transfer(vm_pit *pit, pl_u64 nanoseconds, pl_u32 port,
    pl_u32 write, pl_u32 *value);
#endif
