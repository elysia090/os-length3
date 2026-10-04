#ifndef VM_IO_H
#define VM_IO_H
#include <vm/clock.h>
#include <vm/pit.h>
#include <vm/pic.h>
#include <vm/rtc.h>
#include <vm/uart.h>
#include <vm/console.h>
#include <vm/registers.h>
machine_result vm_io_transfer(vm_memory *physical, pl_u32 port,
    const machine_state *state, const machine_segments *segments,
    vm_clock *clock, vm_pit *pit, vm_pic *pic, vm_rtc *rtc, vm_uart *uart, vm_console *console,
    pl_u32 coordinate, pl_u32 transfer, pl_u64 value);
/* Fixed 1 GHz virtual TSC = explicit sampled nanoseconds. No host CPU CPUID
 * or RDTSC dependency; CR4.TSD is checked before requesting an event. */
machine_result vm_time_read(vm_memory *physical, pl_u32 port,
    const machine_state *state, const machine_segments *segments, vm_clock *clock, const vm_console *console);
#endif
