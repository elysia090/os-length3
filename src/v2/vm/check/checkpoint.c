#include <vm/execution.h>
#include <stdio.h>
#include <string.h>
typedef struct {vm_execution *e;machine_state *s;machine_memory_checkpoint_port port;pl_u32 calls,fetches,mode;} owner;
static machine_result fetch(void *opaque,pl_u64 address){owner *o=opaque;++o->fetches;return address==o->s->rip?0u:MACHINE_RESULT_ENTRY_MAP;}
static machine_result call(void *opaque,pl_u32 slot,pl_u64 entry,pl_u32 binding)
{
    owner *o=opaque;if(slot!=1u||entry!=o->s->rip||binding!=77u||!o->e->in_call||o->e->call_generation!=9u)return MACHINE_RESULT_ENTRY_MAP;
    ++o->calls;
    if(vm_execution_checkpoint(o->e,&o->port,MACHINE_CHECKPOINT_GET,0u,0u))return MACHINE_RESULT_ENTRY_MAP;
    if(o->calls==1u){if(o->port.cursor||o->port.frontier)return MACHINE_RESULT_ENTRY_MAP;
        if(vm_execution_checkpoint(o->e,&o->port,MACHINE_CHECKPOINT_SET,5u,0xface1234u))return MACHINE_RESULT_ENTRY_MAP;
        o->e->generation=0u; /* Payload write revokes ordinary admission. */
        return machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_RESOURCE);}
    if(o->port.cursor!=5u||o->port.frontier!=0xface1234u)return MACHINE_RESULT_ENTRY_MAP;
    machine_memory_checkpoint_port old=o->port;o->port.scalar.generation=8u;
    if(vm_execution_checkpoint(o->e,&o->port,MACHINE_CHECKPOINT_SET,6u,7u)!=MACHINE_RESULT_STALE_GENERATION)return MACHINE_RESULT_ENTRY_MAP;
    o->port=old;
    if(o->mode)return machine_result_make(MACHINE_RESULT_FAULT,14u);
    ++o->s->rip;++o->s->retired;return MACHINE_RESULT_RESOLVE_RIP;
}
int main(void)
{
    vm_execution_row row={0x400000u,1u,1u,1u,77u};pl_u32 cases=0u;
    for(pl_u32 mode=0u;mode<3u;++mode){vm_execution e;machine_state s={.rip=row.entry,.rflags=0x202u};
        owner o={.e=&e,.s=&s,.port={.scalar={.generation=9u}},.mode=mode};
        if(vm_execution_open(&e,&row,1u,9u,&s))return 1;
        machine_memory_checkpoint_port old=o.port;
        if(vm_execution_checkpoint(&e,&o.port,MACHINE_CHECKPOINT_GET,0u,0u)!=MACHINE_RESULT_ENTRY_MAP||memcmp(&o.port,&old,sizeof old))return 1;
        if(vm_execution_run(&e,&s,9u,1u,fetch,call,&o)!=machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_RESOURCE)
            ||o.calls!=1u||o.fetches!=1u||e.frontier[0]!=5u||e.frontier[1]!=0xface1234u||e.in_call||e.call_generation||!e.continuation.slot)return 1;
        if(mode==2u){vm_execution_cancel(&e);if(e.frontier[0]||e.frontier[1]||e.continuation.slot)return 1;}
        else{machine_result expected=mode?machine_result_make(MACHINE_RESULT_FAULT,14u):MACHINE_RESULT_STALE_GENERATION;
            if(vm_execution_run(&e,&s,9u,1u,fetch,call,&o)!=expected||o.calls!=2u||o.fetches!=1u||e.frontier[0]||e.frontier[1]
                ||e.continuation.slot||e.in_call||e.call_generation)return 1;}
        vm_execution_close(&e);if(e.frontier[0]||e.frontier[1])return 1;++cases;
    }
    printf("Compiled checkpoint: %u lifecycle paths, exact two-word resume without refetch; no opcode/CPU image\n",cases);return 0;
}
