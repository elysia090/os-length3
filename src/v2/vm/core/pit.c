#include <vm/pit.h>
static pl_u64 ticks(pl_u64 ns)
{
    /* Split before multiplying: even UINT64_MAX nanoseconds cannot overflow. */
    return ns / 1000000000u * VM_PIT_FREQUENCY
         + ns % 1000000000u * VM_PIT_FREQUENCY / 1000000000u;
}
static void advance(vm_pit_channel *c, pl_u64 tick)
{
    pl_u64 delta = tick - c->anchor;
    if (c->pending && delta) {
        c->count = c->reload; c->elapsed = 0u; c->pending = 0u; c->loaded = 1u;
        --delta; /* The loading pulse does not decrement the counter. */
    }
    if (c->loaded && c->gate && !c->paused) c->elapsed += delta;
    c->anchor = tick;
}
static pl_u16 count(const vm_pit_channel *c)
{ return (pl_u16)(c->count - (pl_u32)(c->elapsed & 65535u)); }
static pl_u32 out(const vm_pit_channel *c)
{ return c->loaded && !c->paused && !c->pending && c->elapsed >= c->count; }
static void latch(vm_pit_channel *c)
{
    if (!c->count_latched) {
        c->latch = count(c); c->count_latched = c->rw; c->latch_high = 0u;
    }
}
void vm_pit_reset(vm_pit *pit)
{
    *pit = (vm_pit){0};
    for (pl_u32 i = 0u; i < 3u; ++i) { pit->channel[i].rw = 3u; pit->channel[i].gate = (pl_u8)(i != 2u); }
}
int vm_pit_accepts(pl_u32 port, pl_u32 write, pl_u32 value)
{
    if (port == 0x61u || (port >= 0x40u && port <= 0x42u)) return 1;
    if (port != 0x43u || !write) return 0;
    if (value >> 6u == 3u) return !(value & 1u);
    return !(value & 0x30u) || !(value & 15u); /* latch, or binary mode 0 */
}
int vm_pit_transfer(vm_pit *pit, pl_u64 ns, pl_u32 port, pl_u32 write, pl_u32 *value)
{
    if (!pit || !value || write > 1u || *value > 255u || !vm_pit_accepts(port,write,*value)) return -1;
    pl_u64 tick = ticks(ns);
    for (pl_u32 i = 0u; i < 3u; ++i) {
        if (tick < pit->channel[i].anchor) return -1;
    }
    for (pl_u32 i = 0u; i < 3u; ++i) advance(&pit->channel[i],tick);
    if (port == 0x61u) {
        if (write) {
            pit->speaker = (pl_u8)(*value & 2u); pit->channel[2].gate = (pl_u8)(*value & 1u);
        } else *value = pit->channel[2].gate | pit->speaker | (out(&pit->channel[2]) << 5u);
        return 0;
    }
    if (port == 0x43u) {
        pl_u32 rank = *value >> 6u, rw = (*value >> 4u) & 3u;
        if (rank == 3u) {
            for (pl_u32 i = 0u; i < 3u; ++i) if (*value & (2u << i)) {
                vm_pit_channel *c = &pit->channel[i];
                if (!(*value & 0x20u)) latch(c);
                if (!(*value & 0x10u) && !c->status_latched) {
                    c->status = (pl_u8)((out(c) << 7u) | ((!c->loaded || c->pending) ? 64u : 0u) | ((pl_u32)c->rw << 4u));
                    c->status_latched = 1u;
                }
            }
        } else if (!rw) latch(&pit->channel[rank]);
        else {
            vm_pit_channel *c = &pit->channel[rank]; pl_u8 gate = c->gate;
            *c = (vm_pit_channel){0}; c->rw = (pl_u8)rw; c->gate = gate; c->anchor = tick;
        }
        return 0;
    }
    vm_pit_channel *c = &pit->channel[port - 0x40u];
    if (write) {
        if (c->rw == 3u && !c->write_high) {
            c->write_low = (pl_u8)*value; c->write_high = 1u; c->paused = 1u;
        } else {
            pl_u32 reload = c->rw == 1u ? *value : c->rw == 2u ? *value << 8u : c->write_low | (*value << 8u);
            c->reload = reload ? reload : 65536u; c->pending = 1u; c->paused = 0u; c->write_high = 0u;
        }
    } else if (c->status_latched) { *value = c->status; c->status_latched = 0u; }
    else {
        pl_u32 rw = c->count_latched ? c->count_latched : c->rw;
        pl_u32 high = c->count_latched ? c->latch_high : c->read_high;
        pl_u16 current = c->count_latched ? c->latch : count(c);
        *value = rw == 2u || high ? current >> 8u : current & 255u;
        if (c->count_latched) {
            if (rw != 3u || high) c->count_latched = 0u;
            else c->latch_high = 1u;
        } else if (rw == 3u) c->read_high ^= 1u;
    }
    return 0;
}
