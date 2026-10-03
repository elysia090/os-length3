#include <vm/source.h>

static pl_u32 bucket(pl_u32 offset)
{ return (offset >> 12u) & (VM_SOURCE_WATCH_BUCKETS - 1u); }
static pl_u32 key(pl_u64 entry, pl_u32 limit)
{ return (pl_u32)(entry ^ (entry >> 8u) ^ limit) & (VM_SOURCE_WATCH_BUCKETS - 1u); }
static void discard(vm_sources *sources, pl_u32 rank)
{
    pl_u64 bit = 1ull << rank;
    if (sources->valid & bit) {
        sources->watch[bucket(sources->rows[rank].offset)] &= ~bit;
        sources->lookup[key(sources->rows[rank].row.entry,sources->rows[rank].limit)] &= ~bit;
    }
    sources->valid &= ~bit;
}
void vm_sources_open(vm_sources *sources, pl_u64 generation, pl_u32 first_slot)
{
    if (!sources) return;
    sources->valid = 0u; sources->pending = 0u;
    sources->generation = generation; sources->first_slot = first_slot;
    for (pl_u32 i = 0u; i < VM_SOURCE_WATCH_BUCKETS; ++i)
        sources->watch[i] = sources->lookup[i] = 0u;
    sources->next_rank = 0u;
}
int vm_sources_probe(vm_sources *sources, const vm_code_page *page,
    pl_u64 entry, pl_u32 limit, vm_execution_row *row)
{
    if (!sources) return -1;
    sources->pending = 0u;
    if (!page || !row || !sources->generation || page->generation != sources->generation
            || !sources->first_slot || sources->first_slot > VM_EXECUTION_MAX_ROWS - VM_SOURCE_ROWS + 1u
            || !limit || limit > 1024u || page->bytes != 4096u || (page->address & 4095u)
            || (page->offset & 4095u) || (pl_u64)page->offset + 4096u > 0x100000000ull
            || entry < page->address || entry - page->address >= 4096u
            || !(entry >> 47u == 0u || entry >> 47u == 0x1ffffu)) return -1;
    pl_u64 candidates = sources->lookup[key(entry,limit)] & sources->valid;
    while (candidates) {
        pl_u32 i = (pl_u32)__builtin_ctzll(candidates);
        const vm_source_row *candidate = sources->rows + i;
        if ((sources->valid & (1ull << i)) && candidate->row.entry == entry
                && candidate->offset == page->offset && candidate->limit == limit) {
            *row = candidate->row; return 0;
        }
        candidates &= candidates - 1u;
    }
    pl_u32 rank = sources->next_rank;
    sources->next_rank = (sources->next_rank + 1u) & (VM_SOURCE_ROWS - 1u);
    discard(sources,rank);
    sources->pending_page = *page; sources->pending_entry = entry;
    sources->pending_limit = limit; sources->pending_rank = rank; sources->pending = 1u;
    *row = (vm_execution_row){entry,0u,0u,sources->first_slot + rank,0u};
    return 1;
}
int vm_sources_publish(vm_sources *sources, pl_u32 bytes, pl_u32 instructions,
    vm_execution_row *row)
{
    if (!sources || !sources->pending) return -1;
    sources->pending = 0u;
    if (!row || !bytes || bytes > 4096u || !instructions || instructions > sources->pending_limit
            || instructions > bytes || sources->pending_page.generation != sources->generation
            || sources->pending_rank >= VM_SOURCE_ROWS
            || (sources->pending_entry & 4095u) + bytes > 4096u) return -1;
    pl_u32 rank = sources->pending_rank;
    vm_source_row *target = sources->rows + rank;
    target->row = (vm_execution_row){sources->pending_entry,bytes,instructions,sources->first_slot + rank,0u};
    target->offset = sources->pending_page.offset; target->limit = sources->pending_limit;
    sources->watch[bucket(target->offset)] |= 1ull << rank;
    sources->lookup[key(target->row.entry,target->limit)] |= 1ull << rank;
    sources->valid |= 1ull << rank;
    *row = target->row;
    return 0;
}
void vm_sources_write(void *owner, pl_u32 offset, pl_u32 bytes)
{
    vm_sources *sources = owner;
    if (!sources || !bytes) return;
    pl_u64 end = (pl_u64)offset + bytes;
    if (sources->pending && offset < (pl_u64)sources->pending_page.offset + 4096u
            && sources->pending_page.offset < end) sources->pending = 0u;
    pl_u64 first = offset >> 12u, last = (end - 1u) >> 12u, candidates = 0u;
    if (last - first >= VM_SOURCE_WATCH_BUCKETS - 1u) candidates = sources->valid;
    else for (pl_u64 page = first; page <= last; ++page)
        candidates |= sources->watch[page & (VM_SOURCE_WATCH_BUCKETS - 1u)];
    candidates &= sources->valid;
    while (candidates) {
        pl_u32 rank = (pl_u32)__builtin_ctzll(candidates);
        const vm_source_row *candidate = sources->rows + rank;
        pl_u64 begin = (pl_u64)candidate->offset + (candidate->row.entry & 4095u);
        if (offset < begin + candidate->row.source_bytes && begin < end) discard(sources,rank);
        candidates &= candidates - 1u;
    }
}
