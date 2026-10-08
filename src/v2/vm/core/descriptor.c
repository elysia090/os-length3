#include "memory-internal.h"
#include "segments-internal.h"
#include <stddef.h>
static int canonical(pl_u64 address)
{return address>>47u==0u||address>>47u==0x1ffffu;}
static machine_result fault(pl_u8 *port,const machine_state *state,pl_u32 error)
{
    vm_memory_store(port+offsetof(machine_memory_port,fault_address),state->rip,8u);
    vm_memory_store(port+offsetof(machine_memory_port,fault_vector),13u,4u);
    vm_memory_store(port+offsetof(machine_memory_port,fault_error),error,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,13u);
}
machine_result vm_descriptor_read(vm_memory *memory,pl_u32 port,const machine_state *state,
    const machine_segments *segments,pl_u32 selector,pl_u32 external,pl_u64 *address,pl_u64 *value)
{
    pl_u32 error=(selector&0xfffcu)|external,index=selector&0xfff8u;pl_u8 *bytes=memory->bytes+port;
    if(!(selector&0xfffcu))return fault(bytes,state,external);
    pl_u64 base=state->system[MACHINE_SYSTEM_GDTR_BASE],limit=state->system[MACHINE_SYSTEM_GDTR_LIMIT];
    if(limit>65535u)return MACHINE_RESULT_ENTRY_MAP;
    if(selector&4u){const machine_segment_cache *ldt=segments->cache+MACHINE_SEGMENT_LDTR;
        if((ldt->attributes&MACHINE_SEGMENT_UNUSABLE)||(ldt->attributes&0x9fu)!=0x82u)return fault(bytes,state,error);
        base=ldt->base;limit=ldt->limit;}
    if((pl_u64)index+7u>limit||base>~0ull-index-7u||!canonical(base+index)||!canonical(base+index+7u))return fault(bytes,state,error);
    *address=base+index;vm_mmu_context context={state->cr0,state->cr3,state->cr4,state->efer,0u};
    machine_result result=vm_mmu_access(memory,port,&context,*address,8u,MACHINE_MEMORY_READ,0u);
    if(!result)*value=vm_memory_load(bytes+offsetof(machine_memory_port,value),8u);
    return result;
}
machine_result vm_descriptor_accessed(vm_memory *memory,pl_u32 port,const machine_state *state,pl_u64 address,pl_u32 access)
{
    if(access&1u)return 0u;
    vm_mmu_context context={state->cr0,state->cr3,state->cr4,state->efer,0u};
    return vm_mmu_access(memory,port,&context,address+5u,1u,MACHINE_MEMORY_WRITE,access|1u);
}
void vm_segments_outer(machine_state *state,machine_segments *segments,pl_u32 cpl)
{
    if(!cpl)return;
    for(pl_u32 rank=0u;rank<=MACHINE_SEGMENT_GS;++rank){if(rank==MACHINE_SEGMENT_CS||rank==MACHINE_SEGMENT_SS)continue;
        machine_segment_cache *cache=segments->cache+rank;
        if(!(cache->attributes&MACHINE_SEGMENT_UNUSABLE)&&((cache->attributes>>5u)&3u)<cpl&&(cache->attributes&12u)!=12u){
            state->system[MACHINE_SYSTEM_ES+rank]=0u;cache->attributes=(cache->attributes&~128u)|MACHINE_SEGMENT_UNUSABLE;}}
}
