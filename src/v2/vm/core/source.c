#include <vm/source.h>
#include <stdint.h>
int vm_source_versions_open(vm_source_versions *v,pl_u32 *words,pl_u32 count,pl_u64 generation)
{
    if(!v||!words||((uintptr_t)words&3u)||!count||count>0x100000u||!generation)return -1;
    *v=(vm_source_versions){words,count,generation};for(pl_u32 n=0u;n<count;++n)words[n]=0u;return 0;
}
void vm_source_versions_touch(vm_source_versions *v,pl_u32 offset)
{pl_u32 rank=offset>>12u;if(v&&v->generation&&rank<v->count&&!v->words[rank])v->words[rank]=1u;}
int vm_source_versions_observed(const vm_source_versions *v,pl_u32 offset,pl_u32 bytes)
{
    if(!v||!v->generation)return 1; /* Unbound C callers still report every write. */
    if(!bytes)return 0;
    pl_u32 first=offset>>12u;pl_u64 last=((pl_u64)offset+bytes-1u)>>12u;
    if(first>=v->count)return 0;
    if(last>=v->count)last=v->count-1u;
    for(pl_u32 n=first;n<=last;++n)if(v->words[n])return 1;
    return 0;
}
void vm_source_versions_write(vm_source_versions *v,pl_u32 offset,pl_u32 bytes)
{
    if(!v||!v->generation||!bytes)return;
    pl_u32 first=offset>>12u;pl_u64 last=((pl_u64)offset+bytes-1u)>>12u;
    if(first>=v->count)return;
    if(last>=v->count)last=v->count-1u;
    for(pl_u32 n=first;n<=last;++n)if(v->words[n]&&v->words[n]!=~0u)++v->words[n];
}
int vm_sources_stamp(const vm_sources *s,const vm_source_versions *v,pl_u32 owners[2],pl_u32 revisions[2])
{
    if(!s||!v||!owners||!revisions||!s->pending||s->pending_pages<1u||s->pending_pages>2u
        ||!v->generation||s->generation!=v->generation)return -1;
    pl_u32 owner[2]={s->pending_page.offset,s->pending_pages==2u?s->pending_next.offset:0u},revision[2]={0u,0u};
    for(pl_u32 n=0u;n<s->pending_pages;++n){pl_u32 rank=owner[n]>>12u;
        if((owner[n]&4095u)||rank>=v->count||!v->words[rank]||v->words[rank]==~0u)return -1;
        revision[n]=v->words[rank];}
    owners[0]=owner[0];owners[1]=owner[1];revisions[0]=revision[0];revisions[1]=revision[1];return 0;
}
_Static_assert(VM_SOURCE_ROWS == 64u, "one exact rank mask and byte-sized links");

static pl_u32 bucket(pl_u32 offset)
{ return (offset >> 12u) & (VM_SOURCE_WATCH_BUCKETS - 1u); }
static pl_u32 key(pl_u64 entry)
{ return (pl_u32)(entry ^ (entry >> 8u)) & (VM_SOURCE_WATCH_BUCKETS - 1u); }
static pl_u64 coordinate(pl_u32 offset,pl_u64 entry)
{return (pl_u64)offset+(entry&4095u);}
static const vm_execution_row *project(vm_sources *s,const vm_source_row *r,pl_u64 entry)
{if(r->row.entry==entry){s->projected=0u;return &r->row;}
 s->projection=r->row;s->projection.entry=entry;s->projected=1u;return &s->projection;}
static int crosses(const vm_source_row *row)
{ return (row->row.entry & 4095u) + row->row.source_bytes > 4096u; }
static void unlink_rank(vm_sources *sources, pl_u32 rank)
{
    pl_u8 before = sources->previous[rank], after = sources->next[rank];
    if (before < VM_SOURCE_ROWS) sources->next[before] = after;
    else sources->oldest = after;
    if (after < VM_SOURCE_ROWS) sources->previous[after] = before;
    else sources->newest = before;
}
static void append_rank(vm_sources *sources, pl_u32 rank)
{
    sources->previous[rank] = sources->newest;
    sources->next[rank] = VM_SOURCE_ROWS;
    if (sources->newest < VM_SOURCE_ROWS) sources->next[sources->newest] = (pl_u8)rank;
    else sources->oldest = (pl_u8)rank;
    sources->newest = (pl_u8)rank;
}
static void demand(vm_sources *sources, pl_u32 rank)
{
    if (sources->newest != rank) {
        unlink_rank(sources,rank);
        append_rank(sources,rank);
    }
}
static void discard(vm_sources *sources, pl_u32 rank)
{
    pl_u64 bit = 1ull << rank;
    if (sources->valid & bit) {
        if (rank == sources->newest) sources->demand_limit = 0u;
        unlink_rank(sources,rank);
        sources->watch[bucket(sources->rows[rank].offset)] &= ~bit;
        if (crosses(sources->rows + rank))
            sources->watch[bucket(sources->rows[rank].next_offset)] &= ~bit;
        sources->lookup[key(coordinate(sources->rows[rank].offset,sources->rows[rank].row.entry))] &= ~bit;
        if(sources->projected&&sources->projection.slot==sources->first_slot+rank)sources->projected=0u;
    }
    sources->valid &= ~bit;
}
void vm_sources_open(vm_sources *sources, pl_u64 generation, pl_u32 first_slot)
{
    if (!sources) return;
    sources->valid = 0u; sources->pending = 0u; sources->demand_limit = 0u;
    sources->projected=0u;sources->projection=(vm_execution_row){0};
    sources->generation = generation; sources->first_slot = first_slot;
    for (pl_u32 i = 0u; i < VM_SOURCE_WATCH_BUCKETS; ++i)
        sources->watch[i] = sources->lookup[i] = 0u;
    sources->oldest = sources->newest = VM_SOURCE_ROWS;
}
static int page_valid(const vm_sources *sources, const vm_code_page *page,
    pl_u64 entry, pl_u32 limit)
{
    return sources && page && sources->generation && page->generation == sources->generation
            && sources->first_slot && sources->first_slot <= VM_EXECUTION_MAX_SLOTS - VM_SOURCE_ROWS + 1u
            && limit && limit <= 1024u && page->bytes == 4096u && !(page->address & 4095u)
            && !(page->offset & 4095u) && (pl_u64)page->offset + 4096u <= 0x100000000ull
            && entry >= page->address && entry - page->address < 4096u
            && (entry >> 47u == 0u || entry >> 47u == 0x1ffffu);
}
static pl_u32 match(const vm_sources *sources, const vm_code_page *page,
    pl_u64 entry, pl_u32 limit)
{
    pl_u64 candidates = sources->lookup[key(coordinate(page->offset,entry))] & sources->valid;
    pl_u32 selected = VM_SOURCE_ROWS;
    while (candidates) {
        pl_u32 rank = (pl_u32)__builtin_ctzll(candidates);
        const vm_source_row *candidate = sources->rows + rank;
        if ((candidate->row.entry&4095u) == (entry&4095u) && candidate->offset == page->offset
                && vm_source_budget_fits(candidate,limit)) {
            const vm_source_row *previous = selected < VM_SOURCE_ROWS
                ? sources->rows + selected : 0;
            /* Prefer the longest legal prefix; a shorter cached body must not
             * hide an already available stronger construction. Ties prefer
             * the largest attested budget, then the first rank. */
            if (!previous || candidate->row.source_instructions > previous->row.source_instructions
                    || (candidate->row.source_instructions == previous->row.source_instructions
                        && candidate->limit > previous->limit)) selected = rank;
        }
        candidates &= candidates - 1u;
    }
    return selected;
}
int vm_sources_reuse(vm_sources *sources, const vm_code_page *page,
    const vm_code_page *next, pl_u64 entry, pl_u32 limit,
    const vm_execution_row **row)
{
    if (!row || !page_valid(sources,page,entry,limit)) return -1;
    pl_u32 rank = match(sources,page,entry,limit);
    if (rank == VM_SOURCE_ROWS) return 1;
    const vm_source_row *candidate = sources->rows + rank;
    if (crosses(candidate)) {
        if (!next) { *row = &candidate->row; return 2; }
        if (page->address > ~0ull-4096u || next->address != page->address+4096u
                || !page_valid(sources,next,next->address,limit)) return -1;
        if (candidate->next_offset != next->offset) return 1;
    }
    demand(sources,rank);
    sources->demand_limit = limit;
    *row = project(sources,candidate,entry);
    return 0;
}
int vm_sources_probe(vm_sources *sources, const vm_code_page *page,
    pl_u64 entry, pl_u32 limit, vm_execution_row *row)
{
    if (!sources) return -1;
    sources->pending = 0u;
    sources->projected=0u;
    if (!row || !page_valid(sources,page,entry,limit)) return -1;
    pl_u32 hit = match(sources,page,entry,limit);
    if (hit < VM_SOURCE_ROWS) {
        const vm_source_row *candidate = sources->rows + hit;
        if (crosses(candidate)) {
            sources->pending_page = *page; sources->pending_entry = entry;
            sources->pending_limit = limit; sources->pending_rank = hit;
            sources->pending = sources->pending_pages = 1u;
            *row = *project(sources,candidate,entry); return 2;
        }
        demand(sources,hit);
        sources->demand_limit = limit;
        *row = *project(sources,candidate,entry); return 0;
    }
    /* No demand may keep an invalid row alive. Free ranks precede eviction;
     * a full owner replaces only its least recently validated demand. */
    pl_u32 rank = sources->valid == ~0ull ? sources->oldest
        : (pl_u32)__builtin_ctzll(~sources->valid);
    discard(sources,rank);
    sources->pending_page = *page; sources->pending_entry = entry;
    sources->pending_limit = limit; sources->pending_rank = rank;
    sources->pending = sources->pending_pages = 1u;
    *row = (vm_execution_row){entry,0u,0u,sources->first_slot + rank,0u};
    return 1;
}
int vm_sources_extend(vm_sources *sources, const vm_code_page *next, vm_execution_row *row)
{
    if (!sources || !sources->pending || !next || !row
            || sources->pending_rank >= VM_SOURCE_ROWS
            || sources->pending_page.address > ~0ull-4096u
            || next->address != sources->pending_page.address+4096u
            || next->generation != sources->generation || next->bytes != 4096u
            || (next->offset & 4095u) || (pl_u64)next->offset+4096u > 0x100000000ull) {
        if (sources) sources->pending = 0u;
        return -1;
    }
    pl_u32 rank = sources->pending_rank;
    const vm_source_row *candidate = sources->rows + rank;
    if ((sources->valid & (1ull << rank)) && crosses(candidate)
            && candidate->next_offset == next->offset) {
        demand(sources,rank);
        sources->demand_limit = sources->pending_limit;
        *row = *project(sources,candidate,sources->pending_entry); sources->pending = 0u; return 0;
    }
    discard(sources,rank);
    sources->pending_next = *next; sources->pending_pages = 2u;
    *row = (vm_execution_row){sources->pending_entry,0u,0u,sources->first_slot+rank,0u};
    return 1;
}
int vm_sources_publish(vm_sources *sources, pl_u32 bytes, pl_u32 instructions,
    pl_u32 operand_binding, vm_execution_row *row)
{
    if (!sources || !sources->pending) return -1;
    sources->pending = 0u;
    if (!row || !bytes || bytes > 4096u || !instructions || instructions > sources->pending_limit
            || instructions > bytes || sources->pending_page.generation != sources->generation
            || sources->pending_rank >= VM_SOURCE_ROWS) return -1;
    int crossing = (sources->pending_entry & 4095u)+bytes > 4096u;
    if (crossing && (sources->pending_pages != 2u || bytes > 15u || instructions != 1u
            || sources->pending_next.generation != sources->generation)) return -1;
    pl_u32 rank = sources->pending_rank;
    vm_source_row *target = sources->rows + rank;
    target->row = (vm_execution_row){sources->pending_entry,bytes,instructions,
        sources->first_slot + rank,operand_binding};
    target->offset = sources->pending_page.offset; target->limit = sources->pending_limit;
    target->next_offset = crossing ? sources->pending_next.offset : 0u;
    sources->watch[bucket(target->offset)] |= 1ull << rank;
    if (crossing) sources->watch[bucket(target->next_offset)] |= 1ull << rank;
    sources->lookup[key(coordinate(target->offset,target->row.entry))] |= 1ull << rank;
    sources->valid |= 1ull << rank;
    append_rank(sources,rank);
    sources->demand_limit = sources->pending_limit;
    *row = *project(sources,target,target->row.entry);
    return 0;
}
void vm_sources_write(void *owner, pl_u32 offset, pl_u32 bytes)
{
    vm_sources *sources = owner;
    if (!sources || !bytes) return;
    pl_u64 end = (pl_u64)offset + bytes;
    if (sources->pending && offset < (pl_u64)sources->pending_page.offset + 4096u
            && sources->pending_page.offset < end) sources->pending = 0u;
    if (sources->pending && sources->pending_pages == 2u
            && offset < (pl_u64)sources->pending_next.offset + 4096u
            && sources->pending_next.offset < end) sources->pending = 0u;
    pl_u64 first = offset >> 12u, last = (end - 1u) >> 12u, candidates = 0u;
    if (last - first >= VM_SOURCE_WATCH_BUCKETS - 1u) candidates = sources->valid;
    else for (pl_u64 page = first; page <= last; ++page)
        candidates |= sources->watch[page & (VM_SOURCE_WATCH_BUCKETS - 1u)];
    candidates &= sources->valid;
    while (candidates) {
        pl_u32 rank = (pl_u32)__builtin_ctzll(candidates);
        const vm_source_row *candidate = sources->rows + rank;
        pl_u64 begin = (pl_u64)candidate->offset + (candidate->row.entry & 4095u);
        pl_u32 first_bytes = 4096u-(pl_u32)(candidate->row.entry & 4095u);
        if (first_bytes > candidate->row.source_bytes) first_bytes = candidate->row.source_bytes;
        pl_u32 tail = candidate->row.source_bytes-first_bytes;
        if ((offset < begin + first_bytes && begin < end)
                || (tail && offset < (pl_u64)candidate->next_offset+tail
                    && candidate->next_offset < end)) discard(sources,rank);
        candidates &= candidates - 1u;
    }
}
