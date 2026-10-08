#ifndef VM_IO_H
#define VM_IO_H
#include <vm/clock.h>
#include <vm/pit.h>
#include <vm/pic.h>
#include <vm/rtc.h>
#include <vm/uart.h>
#include <vm/console.h>
#include <vm/registers.h>
/* PC diagnostic output latch at port 80h: write-only byte, synchronous bus
 * completion. No invented per-access time increment or console transport. */
typedef struct { pl_u8 byte, valid; } vm_post;
typedef struct {pl_u64 generation,rip;pl_u32 port,coordinate,transfer,valid;} vm_io_admission;
machine_result vm_io_check(vm_io_admission *admission,vm_memory *physical,pl_u32 port,
    const machine_state *state,const machine_segments *segments,pl_u32 coordinate,pl_u32 transfer);
machine_result vm_io_checked_transfer(vm_io_admission *admission,vm_memory *physical,pl_u32 port,
    const machine_state *state,const machine_segments *segments,
    vm_clock *clock,vm_pit *pit,vm_pic *pic,vm_rtc *rtc,vm_uart *uart,vm_console *console,vm_post *post,
    pl_u32 coordinate,pl_u32 transfer,pl_u64 value);
/* The fixed platform has one UART at 3F8h-3FFh and no 8237 ISA DMA clients.
 * 1/2/4-byte transfers wholly inside absent COM2-4 (2E8h-2EFh, 2F8h-2FFh,
 * 3E8h-3EFh), and byte DMA page ports 81h-83h, 87h, 89h-8Bh, 8Fh float high;
 * writes are discarded. No width is decomposed into separate device effects.
 * This is device absence, not an implemented device or a generic
 * unassigned-port policy. x86 I/O permission checks still precede the bus.
 * Other widths/unknown ports refuse without architectural retirement. */
machine_result vm_io_transfer(vm_memory *physical, pl_u32 port,
    const machine_state *state, const machine_segments *segments,
    vm_clock *clock, vm_pit *pit, vm_pic *pic, vm_rtc *rtc, vm_uart *uart, vm_console *console, vm_post *post,
    pl_u32 coordinate, pl_u32 transfer, pl_u64 value);
/* Fixed 1 GHz virtual TSC = explicit sampled nanoseconds. No host CPU CPUID
 * or RDTSC dependency; CR4.TSD is checked before requesting an event. */
machine_result vm_time_read(vm_memory *physical, pl_u32 port,
    const machine_state *state, const machine_segments *segments, vm_clock *clock, const vm_console *console);
#endif
