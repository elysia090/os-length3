#ifndef VM_CLOCK_INTERNAL_H
#define VM_CLOCK_INTERNAL_H
#include <support/types.h>
/* Least representable ns with floor((ns-origin)*frequency/1e9) >= tick.
 * Split the quotient first: neither tick*1e9 nor origin+duration may wrap. */
static inline int vm_tick_deadline(pl_u64 tick,pl_u32 frequency,pl_u64 origin,pl_u64 *deadline)
{
    if(!deadline || !frequency || frequency>1000000000u)return 0;
    pl_u64 available=~0ull-origin;
    pl_u64 limit=available/1000000000u*frequency
        +available%1000000000u*frequency/1000000000u;
    if(tick>limit)return 0;
    pl_u64 seconds=tick/frequency, remainder=tick%frequency;
    *deadline=origin+seconds*1000000000u
        +(remainder*1000000000u+frequency-1u)/frequency;
    return 1;
}
#endif
