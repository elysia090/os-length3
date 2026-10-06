#ifndef VM_RTC_H
#define VM_RTC_H
#include <support/types.h>
#define VM_RTC_MAX_SECONDS 253402300799ull
typedef struct {
    pl_u64 now, seconds, oscillator_origin;
    pl_u32 fraction;
    pl_u8 bytes[128], index, nmi_mask, seeded, used, weekday_shift;
} vm_rtc;
/* PC 32768 Hz oscillator, UTC Gregorian calendar and century32/37 alias.
 * Host seeds UTC once before first I/O, then supplies monotonic nanoseconds.
 * DST, other oscillator sources and invalid calendar inputs are refused.
 * SQW is an unconnected pin; IRQ level is exposed, not injected into a CPU. */
void vm_rtc_reset(vm_rtc *rtc);
int vm_rtc_seed(vm_rtc *rtc, pl_u64 seconds);
int vm_rtc_can_advance(const vm_rtc *rtc, pl_u64 nanoseconds);
int vm_rtc_advance(vm_rtc *rtc, pl_u64 nanoseconds);
int vm_rtc_accepts(const vm_rtc *rtc, pl_u32 port, pl_u32 write, pl_u32 value);
int vm_rtc_transfer(vm_rtc *rtc, pl_u64 nanoseconds, pl_u32 port,
    pl_u32 write, pl_u32 *value);
int vm_rtc_irq(const vm_rtc *rtc);
/* Earliest enabled IRQ8 assertion; no calendar/tick history is materialized. */
int vm_rtc_next_irq(const vm_rtc *rtc, pl_u64 *nanoseconds);
#endif
