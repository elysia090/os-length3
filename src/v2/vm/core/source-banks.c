#include <vm/source-banks.h>
_Static_assert(VM_SOURCE_BANKS==128u,"four exact candidate words");
void vm_source_banks_open(vm_source_banks *o,pl_u64 generation,pl_u32 first_slot)
{
    o->active=0u;o->revoked=o->cancelled=0u;
    for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b)vm_sources_open(o->banks+b,generation,first_slot+b*VM_SOURCE_ROWS);
    for(pl_u32 g=0u;g<VM_SOURCE_GROUPS;++g)for(pl_u32 i=0u;i<VM_SOURCE_WATCH_BUCKETS;++i)o->watch[g][i]=0u;
    for(pl_u32 i=0u;i<VM_SOURCE_PAGE_WORDS;++i)o->pages[i]=0u;
    o->publications=0u;
}
vm_sources *vm_source_banks_select(vm_source_banks *o,pl_u64 entry,pl_u32 physical_offset)
{
    entry=(pl_u64)physical_offset+(entry&4095u);
    o->active=(pl_u32)(entry^(entry>>7u)^(entry>>17u))&(VM_SOURCE_BANKS-1u);
    return o->banks+o->active;
}
int vm_source_banks_empty(const vm_source_banks *o)
{
    for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b)if(o->banks[b].valid||o->banks[b].pending)return 0;
    return 1;
}
static void mark_page(vm_source_banks *o,pl_u32 bank,pl_u32 offset)
{
    pl_u32 page=offset>>12u;
    o->pages[page>>6u]|=1ull<<(page&63u);
    o->watch[bank/32u][page&255u]|=1u<<(bank&31u);
}
static void mark_row(vm_source_banks *o,pl_u32 bank,const vm_source_row *row)
{
    mark_page(o,bank,row->offset);
    if((row->row.entry&4095u)+row->row.source_bytes>4096u)mark_page(o,bank,row->next_offset);
}
void vm_source_banks_published(vm_source_banks *o)
{
    const vm_sources *s=o->banks+o->active;pl_u32 rank=s->newest;
    if(rank>=VM_SOURCE_ROWS||!(s->valid&(1ull<<rank)))return;
    if(++o->publications<VM_SOURCE_CAPACITY){mark_row(o,o->active,s->rows+rank);return;}
    /* Rebuild derived candidates from the sole live rows, without another
     * payload, coordinate directory, generation, or allocation. Amortized
     * bounded work also prevents dead pages accumulating over an owner life. */
    for(pl_u32 i=0u;i<VM_SOURCE_PAGE_WORDS;++i)o->pages[i]=0u;
    for(pl_u32 g=0u;g<VM_SOURCE_GROUPS;++g)for(pl_u32 i=0u;i<VM_SOURCE_WATCH_BUCKETS;++i)o->watch[g][i]=0u;
    for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b){pl_u64 valid=o->banks[b].valid;
        while(valid){pl_u32 r=(pl_u32)__builtin_ctzll(valid);valid&=valid-1u;mark_row(o,b,o->banks[b].rows+r);}}
    o->publications=0u;
}
static int watched_pages(const vm_source_banks *o,pl_u64 first,pl_u64 last)
{
    const pl_u64 maximum=(pl_u64)VM_SOURCE_PAGE_WORDS*64u-1u;
    if(last>maximum)last=maximum;
    /* Very large writes keep the former all-bank path, rather than scanning
     * an arbitrary extent before that already bounded row frontier. */
    if(last-first>=VM_SOURCE_CAPACITY)return 1;
    pl_u32 lo=(pl_u32)(first>>6u),hi=(pl_u32)(last>>6u);
    pl_u64 left=~0ull<<(first&63u),right=~0ull>>(63u-(last&63u));
    if(lo==hi)return (o->pages[lo]&left&right)!=0u;
    if((o->pages[lo]&left)||(o->pages[hi]&right))return 1;
    for(pl_u32 i=lo+1u;i<hi;++i)if(o->pages[i])return 1;
    return 0;
}
void vm_source_banks_write(void *pointer,pl_u32 offset,pl_u32 bytes)
{
    vm_source_banks *o=pointer;if(!o||!bytes)return;
    pl_u64 first=offset>>12u,last=((pl_u64)offset+bytes-1u)>>12u;
    if(!o->banks[o->active].pending&&!watched_pages(o,first,last))return;
    pl_u32 candidates[VM_SOURCE_GROUPS]={0};
    for(pl_u32 g=0u;g<VM_SOURCE_GROUPS;++g){
        if(last-first>=VM_SOURCE_WATCH_BUCKETS-1u)candidates[g]=~0u;
        else for(pl_u64 p=first;p<=last;++p)candidates[g]|=o->watch[g][p&255u];
    }
    /* Only one serialized cold reservation can exist. It has not yet entered
     * the published watcher, and must still be cancelled before mutation. */
    if(o->banks[o->active].pending)candidates[o->active/32u]|=1u<<(o->active&31u);
    for(pl_u32 g=0u;g<VM_SOURCE_GROUPS;++g)while(candidates[g]){pl_u32 bit=(pl_u32)__builtin_ctz(candidates[g]),b=g*32u+bit;candidates[g]&=candidates[g]-1u;
        pl_u64 valid=o->banks[b].valid;pl_u32 pending=o->banks[b].pending;
        vm_sources_write(o->banks+b,offset,bytes);
        o->revoked+=(pl_u64)__builtin_popcountll(valid&~o->banks[b].valid);
        o->cancelled+=(pl_u64)(pending&&!o->banks[b].pending);
        if(last-first<VM_SOURCE_WATCH_BUCKETS-1u)for(pl_u64 p=first;p<=last;++p)
            if(!o->banks[b].watch[p&255u])o->watch[g][p&255u]&=~(1u<<bit);
    }
}
