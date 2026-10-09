#include <vm/source-banks.h>
_Static_assert(VM_SOURCE_BANKS==32u,"bank candidate word");
void vm_source_banks_open(vm_source_banks *o,pl_u64 generation,pl_u32 first_slot)
{
    o->active=0u;o->revoked=o->cancelled=0u;
    for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b)vm_sources_open(o->banks+b,generation,first_slot+b*VM_SOURCE_ROWS);
    for(pl_u32 i=0u;i<VM_SOURCE_WATCH_BUCKETS;++i)o->watch[i]=0u;
}
vm_sources *vm_source_banks_select(vm_source_banks *o,pl_u64 entry)
{
    o->active=(pl_u32)(entry^(entry>>7u)^(entry>>17u))&(VM_SOURCE_BANKS-1u);
    return o->banks+o->active;
}
int vm_source_banks_empty(const vm_source_banks *o)
{
    for(pl_u32 b=0u;b<VM_SOURCE_BANKS;++b)if(o->banks[b].valid||o->banks[b].pending)return 0;
    return 1;
}
void vm_source_banks_published(vm_source_banks *o)
{
    const vm_sources *s=o->banks+o->active;
    pl_u32 rank=s->newest;
    if(rank>=VM_SOURCE_ROWS)return;
    const vm_source_row *row=s->rows+rank;
    o->watch[(row->offset>>12u)&255u]|=1u<<o->active;
    if((row->row.entry&4095u)+row->row.source_bytes>4096u)o->watch[(row->next_offset>>12u)&255u]|=1u<<o->active;
}
void vm_source_banks_write(void *pointer,pl_u32 offset,pl_u32 bytes)
{
    vm_source_banks *o=pointer;if(!o||!bytes)return;
    pl_u64 first=offset>>12u,last=((pl_u64)offset+bytes-1u)>>12u;
    pl_u32 candidates=0u;
    if(last-first>=VM_SOURCE_WATCH_BUCKETS-1u)candidates=~0u;
    else for(pl_u64 p=first;p<=last;++p)candidates|=o->watch[p&255u];
    /* Only one serialized cold reservation can exist. It has not yet entered
     * the published watcher, and must still be cancelled before mutation. */
    if(o->banks[o->active].pending)candidates|=1u<<o->active;
    while(candidates){pl_u32 b=(pl_u32)__builtin_ctz(candidates);candidates&=candidates-1u;
        pl_u64 valid=o->banks[b].valid;pl_u32 pending=o->banks[b].pending;
        vm_sources_write(o->banks+b,offset,bytes);
        o->revoked+=(pl_u64)__builtin_popcountll(valid&~o->banks[b].valid);
        o->cancelled+=(pl_u64)(pending&&!o->banks[b].pending);
        if(last-first<VM_SOURCE_WATCH_BUCKETS-1u)for(pl_u64 p=first;p<=last;++p)
            if(!o->banks[b].watch[p&255u])o->watch[p&255u]&=~(1u<<b);
    }
}
